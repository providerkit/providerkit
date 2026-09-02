// The stream-idle watchdog.
//
// A provider that stops sending bytes is indistinguishable from a long prefill
// — except that it never ends, and every SDK's default is to wait forever. A
// queued route or a wedged prefill upstream hangs the caller indefinitely, and
// the symptom is the worst kind: nothing. No error, no log, no timeout.
//
// So the seam gives itself a deadline. Any byte of any kind re-arms it
// (reasoning models emit thinking deltas continuously, so silence really is
// silence). When it fires, the watchdog aborts ITS OWN controller and the
// caller's signal is only bridged in — which is what keeps a person's Stop
// distinguishable from our timeout. One is their cancel and is never retried;
// the other is ours, is transient, and fires while nothing has streamed yet,
// so the retry is always safe.
import { ProviderError } from "./errors.ts";

/** No byte at all for this long and the stream is considered wedged. */
export const STREAM_IDLE_MS = 60_000;

export interface StreamWatch {
  /** Hand this to the provider in place of the caller's signal. */
  readonly signal: AbortSignal;
  /** A byte arrived: re-arm the deadline, and mark TTFT if it was the first. */
  sawByte(): void;
  /**
   * Milliseconds from the call opening to its first byte of any kind — the
   * wait a person actually experiences, and the number a prompt-cache pin
   * exists to shrink. Null until something arrives.
   */
  firstChunkMs(): number | null;
  /**
   * Re-issue a provider failure as the idle timeout when — and only when — it
   * was our deadline that aborted. A caller's Stop passes through untouched.
   */
  classify(err: unknown): unknown;
  /** Clear the deadline timer. Safe to call more than once. */
  dispose(): void;
}

export interface StreamWatchOptions {
  provider?: string;
  idleMs?: number;
  signal?: AbortSignal;
}

export function streamWatch(opts: StreamWatchOptions = {}): StreamWatch {
  const provider = opts.provider ?? "provider";
  const idleMs = opts.idleMs ?? STREAM_IDLE_MS;
  const callerSignal = opts.signal;
  const started = Date.now();
  const timeout = new AbortController();

  let firstChunk: number | null = null;
  let idle = false;
  let disposed = false;

  // The bridge is structural rather than an event listener: AbortSignal.any
  // aborts synchronously when an input is ALREADY aborted, which is the race
  // no listener can catch (the event fired before we subscribed).
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;

  const idleError = (cause?: unknown) =>
    new ProviderError(provider, "timeout", `stream went ${idleMs / 1000}s without a byte`, {
      cause,
    });

  function arm(): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      idle = true;
      timeout.abort(idleError());
    }, idleMs);
    // An orphaned watch — its consumer gone, dispose never called — must not
    // hold a Node event loop open for a full deadline.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  let timer = arm();

  return {
    signal,
    sawByte() {
      firstChunk ??= Date.now() - started;
      clearTimeout(timer);
      if (!disposed && !signal.aborted) timer = arm();
    },
    firstChunkMs: () => firstChunk,
    classify(err: unknown) {
      // Our deadline, not theirs — and not the caller's Stop.
      if (idle && !(callerSignal?.aborted ?? false)) return idleError(err);
      return err;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Wrap a stream so every chunk re-arms `watch`, and a failure is re-classified
 * through it. Disposes on any exit — completion, throw, or the consumer
 * breaking out of the loop.
 */
export async function* watchChunks<T>(
  watch: StreamWatch,
  chunks: AsyncIterable<T>,
): AsyncGenerator<T> {
  try {
    for await (const chunk of chunks) {
      watch.sawByte();
      yield chunk;
    }
  } catch (err) {
    throw watch.classify(err);
  } finally {
    watch.dispose();
  }
}
