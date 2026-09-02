// Retrying, and knowing when not to.
//
// Three rules do most of the work here, and each was learned separately:
//
//  1. Retry only what a retry can fix. A deterministic failure (bad key,
//     invalid request, exhausted balance) hits identically on every attempt,
//     so retrying it just spends the budget to arrive at the same answer later.
//
//  2. For a STREAM, retry only while nothing has been emitted. Once a chunk
//     has reached the consumer the stream is committed: a retry would replay
//     tokens the caller already rendered. A mid-output drop is the caller's
//     problem to handle (or a job-level restart's), never a silent re-run.
//
//  3. Honour the provider's own number. When it says `Retry-After: 30`, a
//     one-second backoff is three wasted attempts before the same wait.
import { classify, isBackupEligible, isTransient, parseRetryAfterMs } from "./errors.ts";

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Aborts the wait as well as the work, so Stop lands promptly. */
  signal?: AbortSignal;
  /** Decide retryability. Default: transient kinds only. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (info: { error: unknown; attempt: number; delayMs: number }) => void;
  /** Injected in tests so a suite never really waits. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Full-jitter exponential backoff: a random delay in
 * `[0, min(cap, base · 2^(attempt-1))]`.
 *
 * The jitter is the point, not the exponent. Without it, every client that
 * failed against the same overloaded upstream retries in the same instant and
 * rebuilds the thundering herd that caused the failure.
 */
export function backoffMs(
  attempt: number,
  base = DEFAULT_BASE_DELAY_MS,
  cap = DEFAULT_MAX_DELAY_MS,
): number {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

/** A sleep that wakes early when the caller aborts, and rejects with the
 *  abort reason rather than resolving into work nobody wants any more. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The delay before the next attempt: the provider's own figure when it gave
 *  one, capped, else full-jitter backoff. */
function delayFor(err: unknown, attempt: number, opts: RetryOptions): number {
  const asked = parseRetryAfterMs(err);
  const cap = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (asked !== undefined) return Math.min(asked, cap);
  return backoffMs(attempt, opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS, cap);
}

const defaultShouldRetry = (err: unknown): boolean => isTransient(classify(err));

/**
 * Run `fn`, retrying transient failures with backoff. For one-shot calls —
 * a title, a summary, a compaction pass.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const nap = opts.sleep ?? sleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      // A caller's Stop is never a transient failure, whatever it looks like.
      if (opts.signal?.aborted) throw err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) throw err;
      const delayMs = delayFor(err, attempt, opts);
      opts.onRetry?.({ error: err, attempt, delayMs });
      await nap(delayMs, opts.signal);
    }
  }
  throw lastError;
}

/**
 * The streaming twin — with the rule that makes it safe: a retry happens only
 * while NOTHING has been yielded yet.
 *
 * `factory` is re-invoked per attempt and gets a fresh signal, so an abandoned
 * attempt's upstream request is cancelled rather than left racing the retry.
 * Once the first chunk is out, the stream is committed and any later failure
 * propagates untouched.
 */
export async function* withStreamRetry<T>(
  factory: (signal: AbortSignal, attempt: number) => AsyncIterable<T>,
  opts: RetryOptions = {},
): AsyncGenerator<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const nap = opts.sleep ?? sleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason;

    // One controller per attempt: abandoning an attempt must cancel its
    // upstream call, or a retry stacks a second live stream against the same
    // rate limit.
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

    let emitted = false;
    try {
      for await (const chunk of factory(controller.signal, attempt)) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) throw err;
      // Rule 2: past the first chunk there is no going back.
      if (emitted || attempt >= maxAttempts || !shouldRetry(err, attempt)) throw err;
      const delayMs = delayFor(err, attempt, opts);
      opts.onRetry?.({ error: err, attempt, delayMs });
      await nap(delayMs, opts.signal);
    } finally {
      opts.signal?.removeEventListener("abort", onOuterAbort);
      // Abandoning mid-iteration (the consumer broke out, or we are retrying)
      // must not leave the upstream request running.
      if (!controller.signal.aborted) controller.abort();
    }
  }
  throw lastError;
}

export interface BackupModelOptions {
  /** Tried in order: `[primary, ...backups]`. The first success wins. */
  models: string[];
  /**
   * Whether a failure may fall through to the remaining models. Default:
   * overload and rate limits only — those are per-model-endpoint, and nothing
   * else on the list is. An auth failure or an invalid request would land
   * identically on every backup.
   */
  shouldTryNext?: (err: unknown) => boolean;
  onModelFailed?: (info: {
    model: string;
    error: unknown;
    position: number;
    total: number;
  }) => void;
  onFallback?: (info: { model: string; position: number; total: number }) => void;
}

const defaultShouldTryNext = (err: unknown): boolean => isBackupEligible(classify(err));

function requireModels(models: string[]): void {
  if (models.length === 0) throw new Error("providerkit: `models` must include a primary model");
}

/** Walk `[primary, ...backups]` until one succeeds. Rethrows the last error. */
export async function withBackupModels<T>(
  attempt: (model: string) => Promise<T>,
  opts: BackupModelOptions,
): Promise<T> {
  requireModels(opts.models);
  const shouldTryNext = opts.shouldTryNext ?? defaultShouldTryNext;
  const total = opts.models.length;

  let lastError: unknown;
  for (const [index, model] of opts.models.entries()) {
    if (index > 0) opts.onFallback?.({ model, position: index + 1, total });
    try {
      return await attempt(model);
    } catch (err) {
      lastError = err;
      opts.onModelFailed?.({ model, error: err, position: index + 1, total });
      if (!shouldTryNext(err)) break;
    }
  }
  throw lastError;
}

/**
 * The streaming twin — carrying the same commitment rule as `withStreamRetry`.
 *
 * This is the correction worth naming: walking to a backup model AFTER chunks
 * have already reached the consumer replays the answer from the top, in a
 * different model's voice, on top of text the caller has already rendered. So
 * a stream that fails past its first chunk ends the walk, exactly as it ends a
 * retry.
 */
export async function* streamWithBackupModels<T>(
  attempt: (model: string) => AsyncIterable<T>,
  opts: BackupModelOptions,
): AsyncGenerator<T> {
  requireModels(opts.models);
  const shouldTryNext = opts.shouldTryNext ?? defaultShouldTryNext;
  const total = opts.models.length;

  let lastError: unknown;
  for (const [index, model] of opts.models.entries()) {
    if (index > 0) opts.onFallback?.({ model, position: index + 1, total });
    let emitted = false;
    try {
      for await (const chunk of attempt(model)) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (err) {
      lastError = err;
      opts.onModelFailed?.({ model, error: err, position: index + 1, total });
      if (emitted || !shouldTryNext(err)) break;
    }
  }
  throw lastError;
}
