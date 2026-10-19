// Providers and credentials, set up once per app.
//
// Every app on this package wrote the same block: build each provider from
// env, wrap it in a watchdog, chain a few into a fallback pool, keep that pool
// alive so its cooldowns survive, and cache it somewhere. The OpenCode Go
// chain alone was copied seven times. Where an app put the watchdog or the
// error envelope together by hand, it got it wrong (AGENTS.md, "A bump is an
// audit too"). A registry names each connection once, and `get` hands back
// the composition already assembled.
//
// The layers, outside in: the view (per-call effort and `maxTokens`), the
// fallback pool when there is more than one candidate, then per candidate the
// gate, the watchdog and the adapter.
//
// ponytail: one registry per process. Per-tenant keys would need one registry
// per tenant, and no app needs that yet.
import { ProviderError, type ErrorKind } from "./errors.ts";
import { withFallbackProviders, type Cooldown, type FallbackOptions } from "./fallback.ts";
import { createGate, withGate, type Gate } from "./gate.ts";
import { KeyPool, withKeyPool, type KeyPoolOptions, type KeyTier } from "./key-pool.ts";
import { PROVIDER_PRESETS, type ProviderPreset, type ProviderPresetId } from "./presets.ts";
import { presetAdapter, type PresetAdapterConfig } from "./providers/factory.ts";
import type { RateLimitWindow } from "./rate-limit.ts";
import type { Effort, Provider, ProviderChunk } from "./types.ts";
import { withWatchdog, type WatchdogOptions } from "./watchdog.ts";
// A value import from the `auth/` subpath, and a cheap one: with-token.ts
// imports only errors.ts at runtime and the sign-in flows as types, so the
// main entry gains these few lines and none of oauth, device or flows.
import { withToken } from "./auth/with-token.ts";
import type { TokenSource } from "./auth/token-source.ts";

/** How a connection signs its calls: exactly one of the three. */
export type ConnectionCredential =
  | { apiKey: string; keys?: never; token?: never }
  /** Several keys for one account, rotated by one `KeyPool` per connection. */
  | { keys: KeyPoolOptions; apiKey?: never; token?: never }
  /** A signed-in user's token (`@providerkit/core/auth`), renewed on a 401. */
  | { token: TokenSource; apiKey?: never; keys?: never };

export type ConnectionConfig = Omit<PresetAdapterConfig, "apiKey" | "instanceSessionId"> &
  ConnectionCredential & {
    preset: ProviderPresetId;
    /** The models a bare ref (`"go"`) runs, in order. Absent: `model`, then the
     *  preset's `rotation`, then its `defaultModel`. */
    models?: readonly string[];
    /** At most this many calls at once on this connection, in every chain and
     *  view that uses it. The rest wait in line. Absent: no limit. */
    maxConcurrent?: number;
    /** Replaces the registry's `watchdog` for this connection; `false` turns
     *  it off. */
    watchdog?: WatchdogOptions | false;
  };

type PoolCooldownInfo = Parameters<NonNullable<FallbackOptions<Provider>["onCooldown"]>>[0];

/** What a chain's pool reports when it benches a candidate, plus the
 *  candidate's ref (`"go/glm-5.3"`). The candidate's own `id` is its preset
 *  id, which two connections on one preset share. */
export type RegistryCooldownInfo = PoolCooldownInfo & { ref: string };

export interface RegistryOptions {
  connections: Record<string, ConnectionConfig>;
  /** Named lists of refs, tried in order: `"conn/model"`, or a bare `"conn"`
   *  for its models. A chain can't name another chain. */
  chains?: Record<string, readonly string[]>;
  /** Every candidate's watchdog. On by default with the package's clocks;
   *  `false` turns it off. A connection's own `watchdog` replaces it. */
  watchdog?: WatchdogOptions | false;
  /** One set for every chain, because every chain shares one cooldown store:
   *  a bench set by one is honoured by the others. */
  fallback?: Omit<FallbackOptions<Provider>, "cooldowns" | "onCooldown"> & {
    onCooldown?: (info: RegistryCooldownInfo) => void;
  };
}

export interface ViewOptions {
  /** Every call's effort, unless the call names its own. */
  effort?: Effort;
  /** Every call's output ceiling, unless the call names its own. */
  maxTokens?: number;
}

export interface CandidateStatus {
  ref: string;
  /** When its bench ends; 0 when it has none. A time already past means its
   *  next call is the probe that lifts the bench. */
  retryAtMs: number;
  probing: boolean;
  kind?: ErrorKind;
  window?: RateLimitWindow;
}

export interface ConnectionStatus {
  gate?: { max: number; held: number; waiting: number };
  keys?: Array<{ tier: KeyTier; evictedUntil: number }>;
  /** The candidates built so far: one is built the first time a ref needs it. */
  candidates: CandidateStatus[];
}

export interface Registry {
  /**
   * A provider for a chain name, a `"conn/model"` ref or a bare `"conn"`.
   * Keep it as long as you like: it looks its chain up on every call, so
   * `update` reaches it. Throws on a name it doesn't know.
   */
  get(ref: string, opts?: ViewOptions): Provider;
  /** Add a connection, or replace one. An equal config changes nothing, so
   *  calling this on every request is cheap. */
  update(name: string, config: ConnectionConfig): void;
  /** Delete a connection. A chain that names it fails on its next call. */
  remove(name: string): void;
  status(): Record<string, ConnectionStatus>;
}

interface Connection {
  config: ConnectionConfig;
  gate?: Gate;
  /** ponytail: one pool per connection, so an evicted key is benched for
   *  every model on it. Right for a denied key or a spent balance; too broad
   *  where a vendor counts rate limits per model (Gemini does). The upgrade
   *  is one pool per candidate. */
  keyPool?: KeyPool;
  /** Built on first use, by model. */
  candidates: Map<string, Provider>;
}

interface Member {
  name: string;
  model: string;
}

export function createRegistry(options: RegistryOptions): Registry {
  const connections = new Map<string, Connection>();
  const chainRefs = new Map(Object.entries(options.chains ?? {}));
  /** Built chains by ref, with the connections each one uses. */
  const built = new Map<string, { provider: Provider; uses: Set<string> }>();
  // One store for every chain, so a candidate benched in one is benched in
  // all. Weak, so a candidate dropped by `update` takes its bench with it.
  const cooldowns = new WeakMap<Provider, Cooldown>();
  const refOf = new WeakMap<Provider, string>();
  const { onCooldown, ...fallback } = options.fallback ?? {};
  const poolOptions: FallbackOptions<Provider> = {
    ...fallback,
    cooldowns,
    ...(onCooldown
      ? {
          onCooldown: (info) =>
            onCooldown({ ...info, ref: refOf.get(info.candidate) ?? info.candidate.id }),
        }
      : {}),
  };

  for (const [name, refs] of chainRefs) {
    if (!name || name.includes("/")) {
      throw new Error(`[providerkit] Chain name "${name}" can't be empty or contain "/".`);
    }
    if (refs.length === 0) throw new Error(`[providerkit] Chain "${name}" lists no refs.`);
  }
  // `open` refuses a connection named like a chain.
  for (const [name, config] of Object.entries(options.connections)) {
    connections.set(name, open(name, config));
  }
  // Checked once every connection exists, so a chain may name any of them.
  for (const name of chainRefs.keys()) members(name);

  function open(name: string, config: ConnectionConfig, current?: Connection): Connection {
    if (!name || name.includes("/")) {
      throw new Error(`[providerkit] Connection name "${name}" can't be empty or contain "/".`);
    }
    if (chainRefs.has(name)) {
      throw new Error(
        `[providerkit] "${name}" names both a chain and a connection. Rename one of them.`,
      );
    }
    if (!(config.preset in PROVIDER_PRESETS)) {
      throw new Error(
        `[providerkit] Connection "${name}" names an unknown preset "${config.preset}".`,
      );
    }
    const credentials = [config.apiKey, config.keys, config.token].filter((c) => c !== undefined);
    if (credentials.length !== 1) {
      throw new Error(
        `[providerkit] Connection "${name}" needs exactly one of apiKey, keys or token. ` +
          `It has ${credentials.length}.`,
      );
    }
    return {
      config,
      gate: gateFor(config, current),
      keyPool: config.keys ? new KeyPool(name, config.keys) : undefined,
      candidates: new Map(),
    };
  }

  /** The (connection, model) pairs a ref names, in order, duplicates dropped. */
  function members(ref: string): Member[] {
    const inChain = chainRefs.get(ref);
    const out = new Map<string, Member>();
    for (const member of inChain ?? [ref]) {
      const slash = member.indexOf("/");
      const name = slash < 0 ? member : member.slice(0, slash);
      if (inChain && chainRefs.has(member)) {
        throw new Error(
          `[providerkit] Chain "${ref}" names chain "${member}". List its refs instead.`,
        );
      }
      const connection = connections.get(name);
      if (!connection) {
        throw new Error(
          inChain
            ? `[providerkit] Chain "${ref}" names connection "${name}", which doesn't exist.`
            : `[providerkit] "${ref}" is not a chain or a connection. ` +
                `Known: ${[...chainRefs.keys(), ...connections.keys()].join(", ")}.`,
        );
      }
      const models = slash < 0 ? modelsOf(name, connection.config) : [member.slice(slash + 1)];
      for (const model of models) {
        if (!model) throw new Error(`[providerkit] "${member}" has an empty model after "/".`);
        const key = `${name}/${model}`;
        if (!out.has(key)) out.set(key, { name, model });
      }
    }
    return [...out.values()];
  }

  /** Get the provider for a ref, building it on first use. */
  function resolve(ref: string): Provider {
    const cached = built.get(ref);
    if (cached) return cached.provider;
    const list = members(ref);
    const candidates = list.map(({ name, model }) => candidate(name, model));
    // A single candidate gets no pool. A pool of one benches the only option:
    // a 503 a retry would absorb in a second becomes 30 s of instant
    // NoAvailableProviderError, and the real kind hides behind `rate`. KeyPool
    // refuses to bench its last key for the same reason.
    const provider =
      candidates.length === 1 ? candidates[0]! : withFallbackProviders(candidates, poolOptions);
    built.set(ref, { provider, uses: new Set(list.map(({ name }) => name)) });
    return provider;
  }

  function candidate(name: string, model: string): Provider {
    const connection = connections.get(name)!;
    const cached = connection.candidates.get(model);
    if (cached) return cached;
    const { config, keyPool } = connection;
    const {
      preset,
      apiKey: _apiKey,
      keys: _keys,
      token: _token,
      models: _models,
      maxConcurrent: _maxConcurrent,
      watchdog: _watchdog,
      headers,
      ...rest
    } = config;
    // One session id per candidate, kept by every adapter a key pool or a
    // token builds for it. A new id per attempt made a sticky gateway treat
    // every call as a new session and miss its prompt cache.
    const base = { ...rest, model, instanceSessionId: crypto.randomUUID() };
    let provider: Provider;
    if (config.token) {
      // The credential's host and headers win: Copilot gives each plan its
      // own host, and the Codex backend refuses a call without its account id.
      provider = withToken(config.token, (auth) =>
        presetAdapter(preset, { ...base, ...auth, headers: { ...headers, ...auth.headers } }),
      );
    } else if (config.keys) {
      // `open` builds the pool whenever `keys` is set.
      provider = withKeyPool(keyPool!, (key) =>
        presetAdapter(preset, { ...base, headers, apiKey: key }),
      );
    } else {
      provider = presetAdapter(preset, { ...base, headers, apiKey: config.apiKey });
    }
    // On unless turned off, where `createPresetProvider` adds one only when
    // asked. Handing apps the whole composition is the point of a registry:
    // two apps that wired the watchdog themselves left keep-alives uncounted,
    // so the idle clock would cut a long tool call at 60 s (AGENTS.md, "A bump
    // is an audit too").
    const watchdog = config.watchdog === undefined ? options.watchdog : config.watchdog;
    if (watchdog !== false) provider = withWatchdog(provider, watchdog);
    // Outside the watchdog, so a call waiting for a slot spends no deadline.
    if (connection.gate) provider = withGate(provider, connection.gate);
    connection.candidates.set(model, provider);
    refOf.set(provider, `${name}/${model}`);
    return provider;
  }

  /** Drop every built chain that uses this connection. */
  function forget(name: string): void {
    for (const [ref, entry] of built) if (entry.uses.has(name)) built.delete(ref);
  }

  function view(ref: string, viewOpts: ViewOptions): Provider {
    return {
      get id() {
        return resolve(ref).id;
      },
      get model() {
        return resolve(ref).model;
      },
      createStream(messages, tools, opts = {}) {
        async function* viewed(): AsyncGenerator<ProviderChunk> {
          // A pool applies a per-call model to its primary only, and a single
          // candidate would post it to a connection picked for another model.
          if (opts.model) {
            throw new ProviderError(
              ref,
              "invalid",
              `${ref}: a registry provider can't take a per-call model. ` +
                `Ask the registry for it instead: get("conn/${opts.model}").`,
            );
          }
          // Looked up per call, so `update` reaches a provider taken at boot.
          const provider = resolve(ref);
          for await (const chunk of provider.createStream(messages, tools, {
            ...opts,
            effort: opts.effort ?? viewOpts.effort,
            maxTokens: opts.maxTokens ?? viewOpts.maxTokens,
          })) {
            // A pool names the endpoint that answered; a single candidate is
            // the endpoint, so its chunks get the same field.
            yield chunk.source
              ? chunk
              : { ...chunk, source: { provider: provider.id, model: provider.model } };
          }
        }
        return viewed();
      },
    };
  }

  return {
    get(ref, opts = {}) {
      members(ref);
      return view(ref, opts);
    },

    update(name, config) {
      const current = connections.get(name);
      if (current && sameValue(current.config, config)) return;
      connections.set(name, open(name, config, current));
      forget(name);
    },

    remove(name) {
      connections.delete(name);
      forget(name);
    },

    status() {
      const out: Record<string, ConnectionStatus> = {};
      for (const [name, { gate, keyPool, candidates }] of connections) {
        out[name] = {
          ...(gate ? { gate: { max: gate.max, held: gate.held, waiting: gate.waiting } } : {}),
          ...(keyPool ? { keys: keyPool.status() } : {}),
          candidates: [...candidates].map(([model, provider]) => {
            const { probe, ...bench } = cooldowns.get(provider) ?? { retryAtMs: 0 };
            return { ref: `${name}/${model}`, ...bench, probing: probe !== undefined };
          }),
        };
      }
      return out;
    },
  };
}

function gateFor(config: ConnectionConfig, current: Connection | undefined): Gate | undefined {
  if (config.maxConcurrent === undefined) return undefined;
  // Calls in flight hold slots on the current gate. A fresh one with the same
  // limit would let `max` more through beside them.
  if (current?.gate && current.config.maxConcurrent === config.maxConcurrent) return current.gate;
  return createGate(config.maxConcurrent);
}

/** A bare connection's models: `models`, then `model`, then the preset's
 *  rotation, then its default. The order `createPresetProvider` uses. */
function modelsOf(name: string, config: ConnectionConfig): readonly string[] {
  const preset: ProviderPreset = PROVIDER_PRESETS[config.preset];
  if (config.models?.length) return config.models;
  if (config.model) return [config.model];
  if (preset.rotation?.length) return preset.rotation;
  if (preset.defaultModel) return [preset.defaultModel];
  throw new Error(
    `[providerkit] Connection "${name}" names no model, and preset "${config.preset}" has no ` +
      "default. Set model or models.",
  );
}

/**
 * Equality for configs: plain objects and arrays by their contents, functions
 * and every other object by identity. A key set to `undefined` equals a key
 * left out. So an app that re-reads its config on every request rebuilds
 * nothing, as long as it hands back the same `TokenSource`, `fetchImpl` and
 * `onEvict` each time: a new one is a change, even when it does the same.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => sameValue(value, b[i]))
    );
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!sameValue(a[key], b[key])) return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
