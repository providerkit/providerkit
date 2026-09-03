// A rotating pool of API keys for one provider.
//
// Rate limits are scoped per project or per account, so several keys multiply
// throughput. Free-tier keys go first, round-robin, and the paid key last —
// free quota burns before money. A key that answers 429 is benched for the
// delay the provider named (Retry-After, or Gemini's RetryInfo; else a minute,
// and an hour when the body says the balance or the daily window is gone), a
// denied key for 12 h (durable, but key-specific — one dead key must not take
// the pool down with it), an overload only briefly, because a sibling project's
// key routes to a different backend.
//
// With ONE key there is nothing to rotate to, so NOTHING is evicted and the
// error propagates untouched: a transient 503 must not switch a single-key
// deployment off for a minute, where the caller's own retry is the whole
// recovery there is.
import { isTransient, ProviderError } from "./errors.ts";
import type { ErrorKind } from "./errors.ts";
import type {
  ChatMessage,
  Provider,
  ProviderChunk,
  StreamOptions,
  ToolDefinition,
} from "./types.ts";

/** A per-minute throttle: the window it names is the next one. */
const RATE_COOLDOWN_MS = 60_000;
/** A balance or a daily window — minutes will not bring it back. */
const QUOTA_COOLDOWN_MS = 60 * 60_000;
const AUTH_COOLDOWN_MS = 12 * 60 * 60_000;
/** The vendor's bad time, not the key's — benched only long enough for the
 *  next call to land somewhere else. */
const TRANSIENT_COOLDOWN_MS = 60_000;
const MIN_EVICTION_MS = 1_000;
const MAX_EVICTION_MS = 12 * 60 * 60_000;

export type KeyTier = "free" | "paid";

interface PoolKey {
  apiKey: string;
  tier: KeyTier;
  /** Epoch ms until which the key is out; 0 = available. */
  evictedUntil: number;
}

export interface KeyPoolOptions {
  /** Free-tier keys, walked round-robin before the paid one. */
  keys: readonly string[];
  paidKey?: string | null;
  /** Fires whenever a key is benched — the pool's only report, in place of a
   *  logger a zero-dependency package has no business owning. */
  onEvict?: (info: { tier: KeyTier; kind: ErrorKind; forMs: number }) => void;
  /** Injected in tests, so an expiry can be exercised without waiting out a
   *  12-hour cooldown. */
  now?: () => number;
}

/** No key can serve right now. `retryAtMs` = when the soonest one is back. */
export class NoAvailableKeyError extends Error {
  readonly retryAtMs: number;

  constructor(label: string, retryAtMs: number) {
    super(`No ${label} API key available (all rate-limited or denied)`);
    this.name = "NoAvailableKeyError";
    this.retryAtMs = retryAtMs;
  }
}

export class KeyPool {
  private readonly label: string;
  private readonly free: PoolKey[];
  private readonly paid: PoolKey | null;
  private readonly onEvict: KeyPoolOptions["onEvict"];
  private readonly now: () => number;
  private cursor = 0;

  constructor(label: string, opts: KeyPoolOptions) {
    this.label = label;
    // A blank slot in the caller's config is not a key — an absent env var
    // reads as "" and would otherwise be dialled once per rotation.
    this.free = opts.keys
      .filter(Boolean)
      .map((apiKey): PoolKey => ({ apiKey, tier: "free", evictedUntil: 0 }));
    this.paid = opts.paidKey ? { apiKey: opts.paidKey, tier: "paid", evictedUntil: 0 } : null;
    this.onEvict = opts.onEvict;
    this.now = opts.now ?? Date.now;
    if (this.free.length === 0 && !this.paid) {
      throw new Error(`KeyPool(${this.label}) needs at least one key`);
    }
  }

  get size(): number {
    return this.free.length + (this.paid ? 1 : 0);
  }

  /**
   * Run `fn` with the next available key, rotating on key-specific and
   * transient failures. Everything else (a bad request, a content block) throws
   * straight through — it would fail identically on every key, and spending the
   * pool on it only turns one bad request into an outage.
   */
  async with<T>(fn: (apiKey: string, tier: KeyTier) => Promise<T>): Promise<T> {
    const candidates = this.candidates(this.now());
    if (candidates.length === 0) throw new NoAvailableKeyError(this.label, this.nextAvailableAt());

    let last: unknown;
    for (const key of candidates) {
      try {
        return await fn(key.apiKey, key.tier);
      } catch (err) {
        last = err;
        // The single-key rule: with nothing to rotate to, benching the only key
        // answers NoAvailableKeyError to every call for the next minute — for a
        // failure the caller's own retry would have absorbed.
        const cooldown = this.size > 1 ? cooldownFor(err) : null;
        if (cooldown === null) throw err;
        key.evictedUntil = this.now() + cooldown.forMs;
        this.onEvict?.({ tier: key.tier, kind: cooldown.kind, forMs: cooldown.forMs });
      }
    }

    // Every candidate was evicted during this call.
    if (this.candidates(this.now()).length === 0)
      throw new NoAvailableKeyError(this.label, this.nextAvailableAt());
    throw last;
  }

  /** Free keys round-robin from a moving cursor, then the paid key. */
  private candidates(now: number): PoolKey[] {
    const out: PoolKey[] = [];
    const n = this.free.length;
    for (let i = 0; i < n; i++) {
      const key = this.free[(this.cursor + i) % n]!;
      if (key.evictedUntil <= now) out.push(key);
    }
    if (n > 0) this.cursor = (this.cursor + 1) % n;
    if (this.paid && this.paid.evictedUntil <= now) out.push(this.paid);
    return out;
  }

  private nextAvailableAt(): number {
    const all = this.paid ? [...this.free, this.paid] : this.free;
    return Math.min(...all.map((key) => key.evictedUntil));
  }
}

/**
 * How long to bench a key for this failure, or null when the failure is not the
 * key's fault — nothing is gained by rotating, and benching would spend the
 * pool on a request that fails the same way everywhere.
 */
function cooldownFor(err: unknown): { kind: ErrorKind; forMs: number } | null {
  if (!(err instanceof ProviderError)) return null;
  const clamp = (ms: number) => Math.min(Math.max(ms, MIN_EVICTION_MS), MAX_EVICTION_MS);
  switch (err.kind) {
    // The three kinds that are about THIS key.
    case "rate":
      return { kind: err.kind, forMs: clamp(err.retryAfterMs ?? RATE_COOLDOWN_MS) };
    case "quota":
      return { kind: err.kind, forMs: clamp(err.retryAfterMs ?? QUOTA_COOLDOWN_MS) };
    case "auth":
      // 12 h, not forever: a key is also refused while a billing account is
      // reinstated, and a pool that drops keys permanently ends up empty.
      return { kind: err.kind, forMs: AUTH_COOLDOWN_MS };
    default:
      // Not the key's fault, but a sibling key is a different project on a
      // different backend, so one more call is the cheapest way to find out —
      // which is what an overload or a stalled request is worth. `network` is
      // excluded deliberately: the socket died on our side and dies identically
      // on every key, so benching for it would answer NoAvailableKeyError to
      // what is really "no internet".
      return isTransient(err.kind) && err.kind !== "network"
        ? { kind: err.kind, forMs: TRANSIENT_COOLDOWN_MS }
        : null;
  }
}

/**
 * Give any provider a rotating pool of keys.
 *
 * The subtlety is the seam's shape. `createStream` is an async generator, so
 * CALLING it performs no I/O: the POST — and the 429 that should rotate the key
 * — happens on the first `next()`, long after a `pool.with` wrapped around the
 * call itself would have returned, with nothing left to rotate. So the first
 * chunk is pulled INSIDE the pool and only the rest of the stream is consumed
 * outside it.
 *
 * That line is also the honest one. Past the first chunk the answer is
 * committed to one key, exactly as a retry is committed past its first chunk
 * (retry.ts, rule 2): a mid-stream 429 evicts nothing and rotates nothing,
 * because there is no way to resume a half-rendered answer on another key.
 */
export function withKeyPool(pool: KeyPool, factory: (apiKey: string) => Provider): Provider {
  // The identity every key shares. Building an adapter performs no I/O — it
  // closes over its config and nothing else — so a throwaway instance is the
  // cheapest way to read `id` and `model` without holding a key outside the
  // pool.
  const identity = factory("");

  return {
    id: identity.id,
    model: identity.model,

    async *createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      const opened = await pool.with(async (apiKey) => {
        // One AbortController per attempt, chained to the caller's own signal
        // (retry.ts's rule). Finalizing a generator is not cancellation:
        // `return()` unwinds the adapter down to `streamSse`'s finalizer, which
        // only releases the reader's lock — the response body stays live and
        // the request is never aborted. Without this controller an abandoned
        // attempt keeps the provider generating the rest of the answer, holding
        // a connection and a concurrency slot on the very key the pool is
        // rotating away from.
        const controller = new AbortController();
        const onAbort = () => controller.abort(opts.signal?.reason);
        if (opts.signal?.aborted) onAbort();
        else opts.signal?.addEventListener("abort", onAbort, { once: true });

        const stream = factory(apiKey).createStream(messages, tools, {
          ...opts,
          signal: controller.signal,
        });
        const iterator = stream[Symbol.asyncIterator]();
        const release = async () => {
          opts.signal?.removeEventListener("abort", onAbort);
          await close(iterator);
          controller.abort();
        };

        try {
          return { iterator, first: await iterator.next(), release };
        } catch (err) {
          // The request failed under the pool, which is about to try the next
          // key: release this attempt before a second one opens against the
          // same rate limit.
          await release();
          throw err;
        }
      });

      const { iterator, first, release } = opened;
      try {
        if (first.done) return;
        yield first.value;
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        // A consumer that breaks out of its loop never reaches the end of ours,
        // and an attempt left unfinalized and un-aborted streams for the whole
        // rest of the answer into a body nobody reads.
        await release();
      }
    },
  };
}

/** Finalize an abandoned stream. `return()` can reject on its own (an aborted
 *  body), and that must never replace the failure being handled. */
async function close(iterator: AsyncIterator<ProviderChunk>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // The request is being abandoned either way.
  }
}
