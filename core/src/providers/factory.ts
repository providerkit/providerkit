// The one-line switch: resolve a preset id into a wired provider.
//
// Consumers used to write their own switch over providers — the same
// dispatch, re-derived per codebase, each quietly accumulating dialect
// knowledge (which gateway takes Bearer, which needs the thinking marker).
// The presets table + this factory is that dispatch, said once: a caller
// names an id and hands over a credential, and the header style, endpoint
// and adapter come from the table.
//
// `effort` passes through to the adapter unchanged — the per-endpoint
// thinking dialects (Z.ai's explicit disabled marker, OpenRouter's floors)
// are the adapters' knowledge, and this factory must not re-derive them.
import { ProviderError } from "../errors.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createOpenAIProvider } from "./openai.ts";
import { createResponsesProvider } from "./responses.ts";
import {
  PRESET_IDS,
  PROVIDER_PRESETS,
  type PresetAuth,
  type PresetShape,
  type ProviderPreset,
  type ProviderPresetId,
} from "../presets.ts";
import type {
  ChatMessage,
  Effort,
  Provider,
  ProviderChunk,
  ServiceTier,
  StreamOptions,
  ToolDefinition,
} from "../types.ts";
import { withConfiguredFallbacks, type ProviderFallbackConfig } from "../fallback.ts";

export interface PresetProviderConfig extends ProviderFallbackConfig {
  /** The credential: an API key for `key`/`bearer` presets, an ACCESS TOKEN
   *  for `oauth` ones. `@providerkit/core/auth` signs in and renews it. */
  apiKey: string;
  /** Which model to run. Absent = the preset's `defaultModel`; a preset
   *  without either throws rather than sending a request nobody chose. */
  model?: string;
  /** A model chain on this one endpoint and key: the first answers, the rest
   *  take over in order when it fails (quota, rate, outage). Wins over `model`
   *  and the preset's `rotation`; `fallbacks` still run after the chain. */
  models?: readonly string[];
  /** Replaces the preset's API root. For a vendor that gives each account its
   *  own host (Copilot: `credential.baseUrl` from the sign-in). */
  baseUrl?: string;
  effort?: Effort;
  /** Output ceiling. The Anthropic shape requires one; adapters default it. */
  maxTokens?: number;
  /** Per-request headers (request ids, `ChatGPT-Account-Id`) on top of the
   *  preset's static protocol headers. */
  headers?: Record<string, string>;
  /**
   * The session id for a call without `StreamOptions.sessionId`, on a preset
   * that sends one (`opencode-go`, `opencode-zen`, `chatgpt`). Absent, the provider mints its
   * own when it is built. Pass one when you build the provider per attempt
   * (`withKeyPool`, `withToken`): each build would mint a new id, and a gateway
   * that pins a session to one upstream host then treats every call as a new
   * session, re-routes it and misses its prompt cache. Every model in a chain
   * sends the same one. A preset without a session header has nowhere to put
   * it and ignores it.
   */
  instanceSessionId?: string;
  /** Google Antigravity (Cloud Code Assist) project id for the request envelope. */
  projectId?: string;
  /**
   * App attribution for OpenRouter's rankings. The site URL rides as
   * `HTTP-Referer`, the app name as `X-Title`. Public, not secret. Sent on
   * the OpenAI-compatible and Anthropic shapes (OpenRouter reads them for app
   * attribution); the Gemini and Responses shapes ignore them. An explicit
   * entry in `headers` always wins.
   */
  siteUrl?: string;
  /**
   * App name for OpenRouter's rankings, sent as `X-Title`. See `siteUrl`.
   */
  siteName?: string;
  /** OpenRouter-only: preferred upstream hosts, in order. OpenRouter's cache
   *  lives on the upstream host's account and default routing hops hosts
   *  between rounds. Pinning keeps a conversation's rounds (and their cache)
   *  on one host. Empty/absent = default routing. */
  providerOrder?: string[];
  /** OpenRouter-only: `provider.data_collection`. `"deny"` keeps the request
   *  on hosts that don't train on the prompt. Not zero retention: that is
   *  OpenRouter's separate `zdr`. Absent = the account's own setting. Never
   *  sent to another host. */
  dataCollection?: "allow" | "deny";
  /** Default `service_tier` for every call on the OpenAI and Responses shapes;
   *  `StreamOptions.serviceTier` wins. Anthropic and Gemini presets refuse it. */
  serviceTier?: ServiceTier;
  fetchImpl?: typeof fetch;
}

/** What one adapter for one model takes: a `PresetProviderConfig` without the
 *  chain (`models`) and without the layers that go around an adapter. */
export type PresetAdapterConfig = Omit<
  PresetProviderConfig,
  "models" | keyof ProviderFallbackConfig
>;

export function createPresetProvider(id: ProviderPresetId, config: PresetProviderConfig): Provider {
  const preset = presetFor(id);
  const chain = config.models?.length ? config.models : config.model ? undefined : preset.rotation;
  if (chain && chain.length > 1) {
    const { models: _models, fallbacks = [], ...single } = config;
    return createPresetProvider(id, {
      ...single,
      model: chain[0],
      fallbacks: [
        ...chain.slice(1).map((model) => ({ ...single, preset: id, model })),
        ...fallbacks,
      ],
    });
  }
  const { models: _models, ...single } = config;
  return withConfiguredFallbacks(
    presetAdapter(id, { ...single, model: chain?.[0] ?? config.model }),
    config,
  );
}

/**
 * The bare adapter for one preset and one model: the wire that serves the
 * model, its auth style and the preset's quirks, and nothing around them. No
 * fallbacks, no watchdog, no `models` chain. A registry builds one per
 * (connection, model) and puts those layers around all of them once; calling
 * `createPresetProvider` per model would nest a second pool and a second
 * watchdog inside its own.
 *
 * The adapter's `id` is the preset id, because the OpenAI shape reads its
 * effort dialect from it (`opencode-go`, `openrouter`, `deepseek`).
 */
export function presetAdapter(id: ProviderPresetId, config: PresetAdapterConfig): Provider {
  const preset = presetFor(id);
  const model = config.model ?? preset.defaultModel;
  if (!model) {
    throw new Error(`[providerkit] Preset "${id}" has no defaultModel. Pass a model.`);
  }
  const wire = wireFor(preset, model);
  if (config.serviceTier && (wire.shape === "anthropic" || wire.shape === "gemini")) {
    throw new Error(
      `[providerkit] Preset "${id}" speaks the ${wire.shape} shape, which has no service tier. ` +
        "Remove serviceTier.",
    );
  }
  let provider = buildWireAdapter(id, preset, wire, model, config, config.fetchImpl);
  if (id === "opencode-zen") {
    provider = wrapOpenCodeZen(provider, preset, wire, config, model);
  }

  // Here rather than in `createPresetProvider`: the wire is resolved here, and
  // the bare adapter is exported, so it must refuse on its own a per-call model
  // it would post to the wrong endpoint. That 404 reads as an unknown model,
  // and a pool benches the model for an hour.
  return preset.routes ? refuseOtherWires(provider, preset, wire) : provider;
}

function buildWireAdapter(
  id: ProviderPresetId,
  preset: ProviderPreset,
  wire: Wire,
  model: string,
  config: PresetAdapterConfig,
  fetchImpl: typeof fetch | undefined,
): Provider {
  const headers = { ...preset.headers, ...config.headers };
  const baseUrl = config.baseUrl ?? wire.baseUrl;
  const maxTokens = config.maxTokens ?? preset.maxTokens;
  // Every adapter builds its own pool and watchdog from these. The type leaves
  // them out, but a wider object (a whole `PresetProviderConfig` in a variable)
  // can still carry them, and the adapter would nest a second pool and a
  // second watchdog inside the caller's. Cleared, it stays bare.
  const baseConfig = {
    ...config,
    fallbacks: undefined,
    fallbackOptions: undefined,
    watchdog: undefined,
  };

  switch (wire.shape) {
    case "anthropic":
      // `key` rides Anthropic's native x-api-key; coding plans and OAuth
      // tokens read Bearer (measured across the family's coding endpoints).
      return createAnthropicProvider({
        ...baseConfig,
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        maxTokens,
        baseUrl,
        id,
        headers,
        bearer: wire.auth !== "key",
        ...(preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
        // The endpoint's thinking dialect rides the table (zai: silence means
        // the model default, which is ON — "none" must be said out loud).
        ...(preset.explicitNone ? { explicitNone: true } : {}),
        fetchImpl,
      });
    case "openai":
      return createOpenAIProvider({
        ...baseConfig,
        id,
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        maxTokens,
        baseUrl,
        ...(wire.path ? { path: wire.path } : {}),
        headers,
        ...(config.providerOrder ? { providerOrder: config.providerOrder } : {}),
        ...(config.dataCollection ? { dataCollection: config.dataCollection } : {}),
        ...(preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
        ...(preset.initiatorHeader ? { initiatorHeader: true } : {}),
        ...(preset.noSampling ? { noSampling: true } : {}),
        fetchImpl,
      });
    case "responses":
      return createResponsesProvider({
        ...baseConfig,
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        maxTokens,
        baseUrl,
        ...(wire.path ? { path: wire.path } : {}),
        id,
        headers,
        ...(preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
        ...(preset.imageLimits ? { imageLimits: preset.imageLimits } : {}),
        ...(preset.replayReasoning ? { replayReasoning: true } : {}),
        fetchImpl,
      });
    case "gemini":
      return createGeminiProvider({
        ...baseConfig,
        apiKey: config.apiKey,
        model,
        effort: config.effort,
        maxTokens,
        baseUrl,
        ...(wire.path ? { path: wire.path } : {}),
        bearer: wire.auth !== "key",
        ...(config.projectId ? { projectId: config.projectId } : {}),
        ...(preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
        id,
        headers,
        fetchImpl,
      });
  }
}

/**
 * The User-Agent OpenCode Zen's free tier accepts. Exported for hosts that cannot set
 * the header on `fetch` (Chromium ignores it) and stamp it another way.
 */
export const OPENCODE_CLI_USER_AGENT = "opencode/latest/2.0.32/cli";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Whether an OpenCode Zen model id belongs to the free shelf (`big-pickle` or `*-free`). */
export function isZenFreeModel(model: string): boolean {
  return model === "big-pickle" || model.endsWith("-free");
}

/**
 * Deterministically turns any conversation session id into OpenCode's
 * `ses_<12 hex><14 base62>` identifier shape (`packages/schema/src/session-id.ts`),
 * matching cc-proxy's `forge_opencode_session_id`.
 */
export async function forgeOpenCodeSessionId(sessionId?: string): Promise<string> {
  if (sessionId && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(sessionId)) {
    return sessionId;
  }
  const seed = sessionId && sessionId.length > 0 ? sessionId : crypto.randomUUID();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  let hexPart = "";
  for (let i = 0; i < 6; i++) {
    hexPart += digest[i]!.toString(16).padStart(2, "0");
  }
  let tail = "";
  for (let i = 6; i < 20; i++) {
    tail += BASE62[digest[i]! % 62];
  }
  return `ses_${hexPart}${tail}`;
}

/**
 * OpenCode Zen's free tier answers only a streamed call whose tools include
 * OpenCode's own `read` (`cc-proxy/src/providers/opencode/mod.rs`). A call with
 * `Read` sends it as `read` and gets `Read` back; a call with neither gets a
 * decoy `read` the model is told not to call (and `toolChoice: "none"` when the
 * caller passed no tools).
 */
function offerOpenCodeRead(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts: StreamOptions,
): {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  opts: StreamOptions;
  renamedRead: boolean;
} {
  if (tools.some((t) => t.name === "read")) {
    return { messages, tools, opts, renamedRead: false };
  }
  const hasClaudeRead = tools.some((t) => t.name === "Read");
  if (!hasClaudeRead) {
    const decoy: ToolDefinition = {
      name: "read",
      description: "Not available in this conversation. Never call it.",
      inputSchema: { type: "object", properties: {} },
    };
    return {
      messages,
      tools: [...tools, decoy],
      opts: tools.length === 0 ? { ...opts, toolChoice: "none" } : opts,
      renamedRead: false,
    };
  }
  const nextTools = tools.map((t) => (t.name === "Read" ? { ...t, name: "read" } : t));
  const nextMessages: ChatMessage[] = messages.map((msg) => {
    if (msg.role === "assistant" && msg.toolCalls?.some((c) => c.name === "Read")) {
      return {
        ...msg,
        toolCalls: msg.toolCalls.map((c) => (c.name === "Read" ? { ...c, name: "read" } : c)),
      };
    }
    if (msg.role === "tool" && msg.name === "Read") {
      return { ...msg, name: "read" };
    }
    return msg;
  });
  const nextOpts =
    opts.toolChoice && typeof opts.toolChoice === "object" && opts.toolChoice.name === "Read"
      ? { ...opts, toolChoice: { type: "tool" as const, name: "read" } }
      : opts;
  return { messages: nextMessages, tools: nextTools, opts: nextOpts, renamedRead: true };
}

function wrapOpenCodeZen(
  baseProvider: Provider,
  preset: ProviderPreset,
  wire: Wire,
  config: PresetAdapterConfig,
  defaultModel: string,
): Provider {
  const instanceSessionId = config.instanceSessionId ?? crypto.randomUUID();
  const baseFetch = config.fetchImpl ?? fetch;
  const callerUa = config.headers?.["user-agent"] ?? config.headers?.["User-Agent"];

  return {
    ...baseProvider,
    async *createStream(messages, tools, opts = {}) {
      const activeModel = opts.model ?? defaultModel;
      const free = isZenFreeModel(activeModel);
      const ses = await forgeOpenCodeSessionId(opts.sessionId ?? instanceSessionId);
      const prepared = free
        ? offerOpenCodeRead(messages, tools, opts)
        : { messages, tools, opts, renamedRead: false };

      const runAttempt = async function* (anonymous: boolean): AsyncIterable<ProviderChunk> {
        const fetchImpl: typeof fetch = (input, init) => {
          const merged = new Headers(init?.headers);
          if (!callerUa) merged.set("user-agent", OPENCODE_CLI_USER_AGENT);
          merged.set("x-opencode-session", ses);
          merged.set("x-opencode-session-id", ses);
          merged.set("x-session-affinity", ses);
          merged.set("x-session-id", ses);
          merged.set("x-opencode-project", "global");
          merged.set("x-opencode-client", "cli");
          if (anonymous) {
            merged.delete("authorization");
            merged.delete("x-api-key");
            merged.delete("x-goog-api-key");
          }
          const headerRecord: Record<string, string> = {};
          merged.forEach((v, k) => {
            headerRecord[k] = v;
          });
          return baseFetch(input, { ...init, headers: headerRecord });
        };

        const bound = buildWireAdapter(
          "opencode-zen",
          preset,
          wire,
          defaultModel,
          config,
          fetchImpl,
        );
        for await (const chunk of bound.createStream(prepared.messages, prepared.tools, {
          ...prepared.opts,
          sessionId: ses,
        })) {
          if (
            prepared.renamedRead &&
            chunk.type === "delta" &&
            chunk.toolCalls?.some((c) => c.name === "read")
          ) {
            yield {
              ...chunk,
              toolCalls: chunk.toolCalls.map((c) =>
                c.name === "read" ? { ...c, name: "Read" } : c,
              ),
            };
          } else {
            yield chunk;
          }
        }
      };

      const startAnonymous = free && !config.apiKey;
      let emitted = false;
      try {
        for await (const chunk of runAttempt(startAnonymous)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (err) {
        // Free models accept a valid key (using the account's own free quota),
        // and refuse a stale key with 401. Retry anonymously when that happens.
        if (
          free &&
          !startAnonymous &&
          !emitted &&
          err instanceof ProviderError &&
          err.status === 401
        ) {
          yield* runAttempt(true);
          return;
        }
        throw err;
      }
    },
  };
}

/** The table is closed (`satisfies`), but a caller may hold an id as a plain
 *  string. Validate rather than index into undefined. */
function presetFor(id: ProviderPresetId): ProviderPreset {
  if (!(id in PROVIDER_PRESETS)) {
    throw new Error(
      `[providerkit] Unknown provider preset "${id}". Valid ids: ${PRESET_IDS.join(", ")}`,
    );
  }
  return PROVIDER_PRESETS[id];
}

/** The endpoint a model is served from: its route when the preset has one for
 *  it, else the preset's own. */
function wireFor(preset: ProviderPreset, model: string): Wire {
  const route = preset.routes?.find((r) => r.prefixes.some((prefix) => model.startsWith(prefix)));
  return route
    ? { ...route, auth: route.auth ?? preset.auth }
    : { shape: preset.shape, baseUrl: preset.baseUrl, path: preset.path, auth: preset.auth };
}

interface Wire {
  shape: PresetShape;
  baseUrl: string;
  path?: string;
  auth: PresetAuth;
}

const sameWire = (a: Wire, b: Wire) =>
  a.shape === b.shape && a.baseUrl === b.baseUrl && a.path === b.path;

/**
 * A per-call `model` that lives on another wire than the one this provider was
 * built for would be posted to an endpoint that doesn't serve it, and the 404
 * would read as an unknown model. Refuse it before any request goes out. To use
 * a model on another wire, build a provider for it (a `models` chain does).
 */
function refuseOtherWires(provider: Provider, preset: ProviderPreset, bound: Wire): Provider {
  return {
    ...provider,
    async *createStream(messages, tools, opts) {
      if (opts?.model && !sameWire(wireFor(preset, opts.model), bound)) {
        throw new ProviderError(
          provider.id,
          "invalid",
          `${provider.id}: ${opts.model} is served on a different endpoint than ${provider.model}. ` +
            `Build a provider for ${opts.model}, or put both in a models chain.`,
        );
      }
      yield* provider.createStream(messages, tools, opts);
    },
  };
}
