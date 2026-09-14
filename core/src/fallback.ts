import { classify, parseRetryAfterMs, ProviderError, type ErrorKind } from "./errors.ts";
import type { RateLimitWindow } from "./rate-limit.ts";
import type { ProviderPresetId } from "./presets.ts";
import type { Provider, ProviderChunk } from "./types.ts";
import { createPresetProvider, type PresetProviderConfig } from "./providers/factory.ts";

/** Retry intervals when the server supplies no deadline, not estimates of when
 *  it will recover. A server deadline always wins over these defaults. */
export const DEFAULT_FALLBACK_COOLDOWNS: Readonly<Partial<Record<ErrorKind, number>>> =
  Object.freeze({
    rate: 60_000,
    quota: 3_600_000,
    timeout: 30_000,
    network: 30_000,
    overload: 30_000,
    auth: 3_600_000,
    entitlement: 3_600_000,
    model: 3_600_000,
  });

export interface FallbackOptions<T> {
  /** Per-kind intervals in ms; null stops fallback for that kind. Adding a kind
   *  opts it into fallback. Cancellation is never overridable. */
  cooldownMs?: Partial<Record<ErrorKind, number | null>>;
  onCooldown?: (info: {
    candidate: T;
    error: unknown;
    kind: ErrorKind;
    retryAtMs: number;
    window?: RateLimitWindow;
  }) => void;
  /** Inject a clock for deterministic tests. */
  now?: () => number;
}

/**
 * A fallback named by PRESET id rather than hand-built: the endpoint, auth
 * style, effort dialect and every measured quirk come from the presets table,
 * so a consumer writes neither a baseUrl nor a model-spelling rule. A
 * hand-built `Provider` is still accepted wherever a spec is.
 */
export interface FallbackSpec extends PresetProviderConfig {
  preset: ProviderPresetId;
}

export type FallbackCandidate = Provider | FallbackSpec;

function resolveFallback(candidate: FallbackCandidate): Provider {
  if (typeof candidate === "object" && candidate !== null && "createStream" in candidate) {
    return candidate;
  }
  const { preset, ...config } = candidate;
  return createPresetProvider(preset, config);
}

/** Standard options that any provider config can accept to configure fallbacks inline. */
export interface ProviderFallbackConfig {
  /** Secondary and tertiary providers to try if this provider fails/exhausts:
   *  hand-built `Provider`s, preset-id `FallbackSpec`s, or both. */
  fallbacks?: readonly FallbackCandidate[];
  /** Custom cooldown or telemetry options for the fallback pool. */
  fallbackOptions?: FallbackOptions<Provider>;
}

/**
 * Wrap a primary provider with its fallbacks if any are specified.
 * Returns the primary provider untouched when fallbacks is empty or omitted.
 */
export function withConfiguredFallbacks(
  primary: Provider,
  config?: ProviderFallbackConfig,
): Provider {
  if (!config?.fallbacks || config.fallbacks.length === 0) return primary;
  return withFallbackProviders(
    [primary, ...config.fallbacks.map(resolveFallback)],
    config.fallbackOptions,
  );
}

interface Cooldown {
  retryAtMs: number;
  kind: ErrorKind;
  window?: RateLimitWindow;
  probing: boolean;
}

/** The whole chain is unavailable. Fail promptly instead of holding a request
 *  open for hours. `retryAtMs` names its next opportunity, not a sleep to cap. */
export class NoAvailableProviderError extends ProviderError {
  readonly retryAtMs: number;

  constructor(retryAtMs: number, now: number) {
    super(
      "fallback",
      "rate",
      "All configured providers are unavailable. Retry after the cooldown.",
      {
        resetAtMs: retryAtMs,
        retryAfterMs: Math.max(0, retryAtMs - now),
      },
    );
    this.name = "NoAvailableProviderError";
    this.retryAtMs = retryAtMs;
  }
}

/** Ordered candidates with cooldowns shared across calls. Keep one pool alive
 *  per credential set: rebuilding it per request forgets a weekly lockout.
 *  State is in-memory and process-local; `status` and `reset` expose it without
 *  a background timer, vendor SDK, database or global singleton. */
export class FallbackPool<T> {
  private readonly candidates: readonly T[];
  private readonly cooldowns = new Map<T, Cooldown>();
  private readonly now: () => number;

  constructor(
    candidates: readonly T[],
    private readonly options: FallbackOptions<T> = {},
  ) {
    if (candidates.length === 0)
      throw new Error("providerkit: supply a primary before its backups");
    if (new Set(candidates).size !== candidates.length) {
      throw new Error("providerkit: each fallback candidate must appear only once");
    }
    for (const value of Object.values(options.cooldownMs ?? {})) {
      if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(
          "providerkit: fallback cooldowns must be finite, non-negative milliseconds",
        );
      }
    }
    this.candidates = [...candidates];
    this.now = options.now ?? Date.now;
  }

  /** Clear a cooldown after replacing a key or fixing configuration. Omit the
   *  candidate to clear all. Does not interrupt calls already in flight. */
  reset(...selection: [] | [T]): void {
    if (selection.length === 0) this.cooldowns.clear();
    else this.cooldowns.delete(selection[0]);
  }

  status(): Array<{
    candidate: T;
    retryAtMs: number;
    probing: boolean;
    kind?: ErrorKind;
    window?: RateLimitWindow;
  }> {
    return this.candidates.map((candidate) => ({
      candidate,
      retryAtMs: 0,
      probing: false,
      ...this.cooldowns.get(candidate),
    }));
  }

  /** Buffered calls only: do not wrap an agent turn that has run side effects. */
  async with<R>(
    attempt: (candidate: T, signal: AbortSignal) => Promise<R>,
    signal?: AbortSignal,
  ): Promise<R> {
    for await (const result of this.stream(async function* (candidate, inner) {
      yield await attempt(candidate, inner);
    }, signal))
      return result;
    throw new Error("providerkit: fallback attempt ended without a result");
  }

  /** Only a pre-output failure can switch provider. A later failure still
   *  cools the endpoint for FUTURE calls but never restarts the current answer. */
  async *stream<R>(
    attempt: (candidate: T, signal: AbortSignal) => AsyncIterable<R>,
    signal?: AbortSignal,
  ): AsyncGenerator<R> {
    signal?.throwIfAborted();
    let hasFailed = false;
    let lastError: unknown;
    for (const candidate of this.candidates) {
      signal?.throwIfAborted();
      const previous = this.cooldowns.get(candidate);
      if (previous && (previous.retryAtMs > this.now() || previous.probing)) continue;
      // One recovery probe after expiry. Healthy endpoints still allow normal
      // concurrency; only a known failed endpoint gets a single probe.
      if (previous) previous.probing = true;
      const controller = new AbortController();
      const inner = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let emitted = false;
      let attemptFailed = false;
      const startedWithCooldown = previous !== undefined;
      try {
        for await (const chunk of attempt(candidate, inner)) {
          inner.throwIfAborted();
          emitted = true;
          // Only a call that was admitted as a recovery probe (started while on cooldown)
          // is authorized to clear that cooldown upon succeeding.
          if (startedWithCooldown && this.cooldowns.get(candidate) === previous) {
            this.cooldowns.delete(candidate);
          }
          yield chunk;
        }
        inner.throwIfAborted();
        if (startedWithCooldown && this.cooldowns.get(candidate) === previous) {
          this.cooldowns.delete(candidate);
        }
        return;
      } catch (error) {
        signal?.throwIfAborted();
        const kind = classify(error);
        if (kind === "aborted") throw error;
        const configured = this.options.cooldownMs?.[kind];
        const interval = configured === undefined ? DEFAULT_FALLBACK_COOLDOWNS[kind] : configured;
        if (interval === undefined || interval === null) throw error;
        const now = this.now();
        const after = parseRetryAfterMs(error);
        const reset = error instanceof ProviderError ? error.resetAtMs : undefined;
        const hints = [reset, after === undefined ? undefined : now + after].filter(
          (value): value is number => value !== undefined && Number.isFinite(value),
        );
        const retryAtMs = Math.max(
          now,
          ...(hints.length ? hints : [now + interval]),
          this.cooldowns.get(candidate)?.retryAtMs ?? 0,
        );
        const window = error instanceof ProviderError ? error.window : undefined;
        this.cooldowns.set(candidate, { retryAtMs, kind, window, probing: false });
        this.options.onCooldown?.({ candidate, error, kind, retryAtMs, window });
        attemptFailed = true;
        hasFailed = true;
        lastError = error;
        if (emitted) throw error;
      } finally {
        controller.abort();
        const current = this.cooldowns.get(candidate);
        if (current && current.probing && !attemptFailed) {
          current.probing = false;
        }
      }
    }
    if (hasFailed) throw lastError;
    // If all expired candidates are already being probed, the next opportunity
    // is now. Other callers need not wait for those probes or start duplicates.
    const retryAtMs = Math.min(
      ...this.status().map((entry) => Math.max(this.now(), entry.retryAtMs)),
    );
    throw new NoAvailableProviderError(retryAtMs, this.now());
  }
}

export interface FallbackProvider extends Provider {
  readonly fallbacks: FallbackPool<Provider>;
}

/** Compose bound provider/model pairs. Identity names the configured primary;
 *  chunk.source names the endpoint that answered. Per-call model overrides
 *  apply ONLY to the primary because model ids are endpoint-specific.
 *  Keep this provider alive across calls so its cooldowns survive. */
export function withFallbackProviders(
  providers: readonly Provider[],
  options: FallbackOptions<Provider> = {},
): FallbackProvider {
  const fallbacks = new FallbackPool(providers, options);
  const primary = providers[0]!;
  return {
    id: primary.id,
    model: primary.model,
    fallbacks,
    createStream(messages, tools, opts = {}) {
      return fallbacks.stream(async function* (provider, signal): AsyncGenerator<ProviderChunk> {
        const { model: override, ...rest } = opts;
        const model = provider === primary ? (override ?? provider.model) : provider.model;
        for await (const chunk of provider.createStream(messages, tools, {
          ...rest,
          model,
          signal,
        })) {
          yield { ...chunk, source: chunk.source ?? { provider: provider.id, model } };
        }
      }, opts.signal);
    },
  };
}
