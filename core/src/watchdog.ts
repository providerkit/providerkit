// The two ways a stream fails without failing: it goes silent, or it ends
// having said nothing at all.
//
// The stream watchdog.
//
// A provider that stops sending bytes is indistinguishable from a long prefill
// — except that it never ends, and every SDK's default is to wait forever. A
// queued route or a wedged prefill upstream hangs the caller indefinitely, and
// the symptom is the worst kind: nothing. No error, no log, no timeout.
//
// So the seam gives itself two deadlines, because "silent" means two things:
//
// - IDLE: no byte at all, keep-alives included, for a minute after the
//   response started. A dead socket. Any read re-arms it — a keep-alive is
//   proof of life no chunk can carry (cc-proxy pings every 15s while it
//   buffers a long tool call, and the old chunk-only clock killed those turns).
// - PROGRESS: no chunk for five minutes, counted from the POST. A stream that
//   is alive and going nowhere — a route parked behind keep-alives — and the
//   wait for the response to START, which is the one some backends take
//   minutes over: the ChatGPT backend withholds its headers until the model's
//   first output, so a high-effort turn on a large prompt sends nothing at all
//   for minutes and is healthy the whole time (cc-proxy defaults that wait to
//   300s, measured). On a one-minute clock it was aborted and retried from
//   scratch, which re-ran the reasoning into the same deadline.
//
// When either fires, the watchdog aborts ITS OWN controller and the caller's
// signal is only bridged in — which is what keeps a person's Stop
// distinguishable from our timeout. One is their cancel and is never retried;
// the other is ours, is transient, and fires while nothing has streamed yet,
// so the retry is always safe.
import { ProviderError } from "./errors.ts";
import type {
  ChatMessage,
  Provider,
  ProviderChunk,
  StreamOptions,
  ToolDefinition,
} from "./types.ts";

/** No byte at all for this long, once the response has started, and the
 *  stream is dead. */
export const STREAM_IDLE_MS = 60_000;

/** No chunk for this long — the wait for the response to start included —
 *  and the stream is going nowhere, keep-alives or not. */
export const STREAM_PROGRESS_MS = 300_000;

export interface StreamWatch {
  /** Hand this to the provider in place of the caller's signal. */
  readonly signal: AbortSignal;
  /** A chunk arrived: re-arm both deadlines, and mark TTFT if it was the first. */
  sawByte(): void;
  /** The response showed life without a chunk — its headers, a keep-alive, a
   *  partial frame. Starts or re-arms the idle deadline only. */
  sawActivity(): void;
  /**
   * Milliseconds from the call opening to its first chunk of any kind — the
   * wait a person actually experiences, and the number a prompt-cache pin
   * exists to shrink. Null until something arrives.
   */
  firstChunkMs(): number | null;
  /**
   * Re-issue a provider failure as the timeout when — and only when — it was
   * one of our deadlines that aborted. A caller's Stop passes through untouched.
   */
  classify(err: unknown): unknown;
  /** Clear the deadline timers. Safe to call more than once. */
  dispose(): void;
}

export interface StreamWatchOptions {
  provider?: string;
  idleMs?: number;
  progressMs?: number;
  signal?: AbortSignal;
}

export function streamWatch(opts: StreamWatchOptions = {}): StreamWatch {
  const provider = opts.provider ?? "provider";
  const idleMs = opts.idleMs ?? STREAM_IDLE_MS;
  // Never shorter than the idle clock unless the caller says so. Progress is
  // the PATIENT clock; a caller who raised `idleMs` past five minutes (to
  // keep an outer watch from cutting a model chain's own rotation) was still
  // cut at five, by a clock they never set (@falai/agent, on 0.16.0).
  const progressMs = opts.progressMs ?? Math.max(STREAM_PROGRESS_MS, idleMs);
  const callerSignal = opts.signal;
  const started = Date.now();
  const timeout = new AbortController();

  let firstChunk: number | null = null;
  let fired: ProviderError | null = null;
  let disposed = false;

  // The bridge is structural rather than an event listener: AbortSignal.any
  // aborts synchronously when an input is ALREADY aborted, which is the race
  // no listener can catch (the event fired before we subscribed). It is also
  // the package's runtime floor — see `engines` — rather than a polyfilled
  // nicety: every runtime this package targets has had it for years.
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;

  function deadline(ms: number, what: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      fired = new ProviderError(provider, "timeout", `stream went ${ms / 1000}s without ${what}`);
      timeout.abort(fired);
    }, ms);
    // An orphaned watch — its consumer gone, dispose never called — must not
    // hold a Node event loop open for a full deadline.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  // The idle clock waits for the response to start; until then only the
  // progress clock runs (see the header comment).
  let idle: ReturnType<typeof setTimeout> | undefined;
  let progress = deadline(progressMs, "a chunk");
  const live = () => !disposed && !signal.aborted;

  function sawActivity() {
    clearTimeout(idle);
    if (live()) idle = deadline(idleMs, "a byte");
  }

  return {
    signal,
    sawByte() {
      firstChunk ??= Date.now() - started;
      sawActivity();
      clearTimeout(progress);
      if (live()) progress = deadline(progressMs, "a chunk");
    },
    sawActivity,
    firstChunkMs: () => firstChunk,
    classify(err: unknown) {
      // Our deadline, not theirs — and not the caller's Stop.
      if (fired && !(callerSignal?.aborted ?? false)) {
        return new ProviderError(fired.provider, "timeout", fired.message, { cause: err });
      }
      return err;
    },
    dispose() {
      disposed = true;
      clearTimeout(idle);
      clearTimeout(progress);
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

/**
 * Reject a turn that completed but produced nothing usable.
 *
 * A stream that ends with no text, no reasoning and no tool call is a failure
 * wearing a success's clothes: `stop_reason: end_turn` with zero content
 * blocks, which the vendors emit under load and after a thinking block eats
 * the whole `max_tokens`. Nothing throws, so nothing retries — the caller
 * simply shows a person an empty answer, and the only trace is a bill.
 *
 * Classified `overload` because that is both true and useful: it is theirs and
 * temporary, so it is transient (the same model, retried, usually answers) and
 * backup-eligible (a model that keeps doing it should be walked away from).
 * The throw lands before any chunk is yielded downstream, so the retry rule
 * that matters — retry only while nothing was emitted — still holds.
 */
export async function* requireContent<T extends ProviderChunk>(
  provider: string,
  chunks: AsyncIterable<T>,
  opts: { afterToolResult?: boolean } = {},
): AsyncGenerator<T> {
  const held: T[] = [];
  let usable = false;
  let finish: ProviderChunk["finishReason"];

  for await (const chunk of chunks) {
    if (chunk.type === "finish") finish = chunk.finishReason;
    if (!usable) {
      usable = Boolean(chunk.content || chunk.reasoning || chunk.toolCalls?.length);
      // Held rather than forwarded: once a chunk is out, the stream is
      // committed and the retry this guard exists to trigger can no longer
      // fire. Nothing content-bearing has arrived yet, so there is nothing to
      // hold back but the empty frames.
      if (!usable) {
        held.push(chunk);
        continue;
      }
      yield* held;
      held.length = 0;
    }
    yield chunk;
  }

  if (usable) return;
  // The one empty turn that is an answer: the model read a tool result and
  // chose to stop. An agent whose reply IS a tool (a chat bot's send_message)
  // ends every turn this way — retried, cc-proxy measured one such bot
  // failing ~68% of real turns (11 retries, ~3 minutes, then an error). A
  // `length` stop or no finish at all is still the failure this guard is for.
  if (opts.afterToolResult && finish === "stop") {
    yield* held;
    return;
  }
  throw new ProviderError(provider, "overload", `${provider}: completed with no content`);
}

export interface WatchdogOptions {
  /** No byte this long after the response starts and the stream is dead.
   *  Defaults to `STREAM_IDLE_MS`. */
  idleMs?: number;
  /** No chunk this long, from the POST on, and the stream is going nowhere.
   *  Defaults to `STREAM_PROGRESS_MS`, or to `idleMs` when that is longer. */
  progressMs?: number;
  /**
   * Reject a turn that ends having said nothing, as `requireContent` does. On
   * by default: an empty completion is a failure in every loop, and the one
   * shaped like a success is the one nobody catches.
   */
  requireContent?: boolean;
  /** Time to first byte for this call, reported once the byte arrives. */
  onFirstChunk?: (ms: number) => void;
}

/**
 * A provider with both silent failures already handled.
 *
 * Every consumer of this package wrote the same three lines around every
 * `createStream` — build a watch, hand the provider the WATCH's signal, wrap
 * the chunks — and the middle one is the trap. Pass the caller's signal
 * instead and everything still compiles, still streams, still passes the
 * tests: the watchdog simply never aborts anything, because the request it was
 * meant to cancel was never told about it. The failure has no symptom until
 * production, where it is the exact hang the watchdog was added to end.
 *
 * So the composition belongs here rather than in a docs snippet each app
 * copies. The result is still a `Provider`, so it composes unchanged with
 * `withStreamRetry` and `streamWithBackupModels` — and both of the failures it
 * catches are transient, which is what makes wrapping it in a retry correct.
 */
export function withWatchdog(provider: Provider, opts: WatchdogOptions = {}): Provider {
  return {
    ...provider,
    createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      streamOpts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      // Armed on first read, not here: a stream built now and iterated later
      // must not spend its deadline sitting in a variable.
      async function* watched(): AsyncGenerator<ProviderChunk> {
        // The deadlines and signal all default inside streamWatch.
        const watch = streamWatch({
          provider: provider.id,
          idleMs: opts.idleMs,
          progressMs: opts.progressMs,
          signal: streamOpts.signal,
        });
        const callerActivity = streamOpts.onActivity;
        const source = provider.createStream(messages, tools, {
          ...streamOpts,
          signal: watch.signal,
          onActivity: () => {
            watch.sawActivity();
            callerActivity?.();
          },
        });
        let reported = false;
        for await (const chunk of watchChunks(watch, source)) {
          // Before `requireContent` holds anything back — TTFT is the first
          // chunk of any kind, not the first one worth showing.
          if (!reported) {
            reported = true;
            opts.onFirstChunk?.(watch.firstChunkMs() ?? 0);
          }
          yield chunk;
        }
      }

      return opts.requireContent === false
        ? watched()
        : requireContent(provider.id, watched(), {
            afterToolResult: messages.at(-1)?.role === "tool",
          });
    },
  };
}
