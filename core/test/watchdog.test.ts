import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors.ts";
import {
  STREAM_IDLE_MS,
  requireContent,
  streamWatch,
  watchChunks,
  withWatchdog,
} from "../src/watchdog.ts";
import { withStreamRetry } from "../src/retry.ts";
import { classify, isTransient } from "../src/errors.ts";
import type { ChatMessage, Provider, ProviderChunk, StreamOptions } from "../src/types.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("streamWatch", () => {
  it("aborts once the stream goes quiet for the whole window", () => {
    const watch = streamWatch({ provider: "openai" });
    expect(watch.signal.aborted).toBe(false);
    vi.advanceTimersByTime(STREAM_IDLE_MS);
    expect(watch.signal.aborted).toBe(true);
    expect(watch.signal.reason).toBeInstanceOf(ProviderError);
    expect((watch.signal.reason as ProviderError).kind).toBe("timeout");
    watch.dispose();
  });

  it("a byte re-arms the deadline — a slow but live stream never trips it", () => {
    const watch = streamWatch({ idleMs: 1_000 });
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(900);
      watch.sawByte();
    }
    expect(watch.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(watch.signal.aborted).toBe(true);
    watch.dispose();
  });

  it("records TTFT on the first byte only", () => {
    const watch = streamWatch({ idleMs: 10_000 });
    expect(watch.firstChunkMs()).toBeNull();
    vi.advanceTimersByTime(250);
    watch.sawByte();
    vi.advanceTimersByTime(500);
    watch.sawByte();
    expect(watch.firstChunkMs()).toBe(250);
    watch.dispose();
  });

  it("classifies its OWN deadline as a timeout", () => {
    const watch = streamWatch({ provider: "gemini", idleMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    const classified = watch.classify(new Error("aborted"));
    expect(classified).toBeInstanceOf(ProviderError);
    expect((classified as ProviderError).kind).toBe("timeout");
    watch.dispose();
  });

  it("leaves a caller's Stop alone — the distinction the whole design exists for", () => {
    const controller = new AbortController();
    const watch = streamWatch({ signal: controller.signal, idleMs: 1_000 });
    const stop = new Error("user pressed stop");
    controller.abort(stop);
    expect(watch.classify(stop)).toBe(stop);
    watch.dispose();
  });

  it("bridges a signal that was ALREADY aborted — the race no listener catches", () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped before we started"));
    const watch = streamWatch({ signal: controller.signal });
    expect(watch.signal.aborted).toBe(true);
    watch.dispose();
  });

  it("stops arming after dispose", () => {
    const watch = streamWatch({ idleMs: 1_000 });
    watch.dispose();
    watch.sawByte();
    vi.advanceTimersByTime(10_000);
    expect(watch.signal.aborted).toBe(false);
  });
});

describe("watchChunks", () => {
  async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  }

  it("passes chunks through and disposes at the end", async () => {
    const watch = streamWatch({ idleMs: 1_000 });
    const chunks = await collect(
      watchChunks(
        watch,
        (async function* () {
          yield 1;
          yield 2;
        })(),
      ),
    );
    expect(chunks).toEqual([1, 2]);
    vi.advanceTimersByTime(10_000);
    expect(watch.signal.aborted).toBe(false); // disposed, so never fires
  });

  it("re-classifies a failure through the watch", async () => {
    const watch = streamWatch({ provider: "anthropic", idleMs: 1_000 });
    vi.advanceTimersByTime(1_000); // the deadline fires
    const failing = watchChunks(
      watch,
      (async function* () {
        throw new Error("aborted");
        yield 1;
      })(),
    );
    await expect(collect(failing)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("disposes even when the consumer breaks out early", async () => {
    const watch = streamWatch({ idleMs: 1_000 });
    for await (const _chunk of watchChunks(
      watch,
      (async function* () {
        yield 1;
        yield 2;
      })(),
    )) {
      break;
    }
    vi.advanceTimersByTime(10_000);
    expect(watch.signal.aborted).toBe(false);
  });
});

describe("requireContent", () => {
  async function* frames(...chunks: ProviderChunk[]) {
    for (const chunk of chunks) yield chunk;
  }
  const collect = async (stream: AsyncIterable<ProviderChunk>) => {
    const out: ProviderChunk[] = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  };

  it("passes a turn that said something through untouched", async () => {
    const out = await collect(
      requireContent("claude", frames({ type: "delta", content: "hi" }, { type: "finish" })),
    );
    expect(out).toHaveLength(2);
  });

  it("counts reasoning and tool calls as content", async () => {
    await expect(
      collect(requireContent("claude", frames({ type: "delta", reasoning: "hmm" }))),
    ).resolves.toHaveLength(1);
    await expect(
      collect(
        requireContent("claude", frames({ type: "delta", toolCalls: [{ index: 0, name: "f" }] })),
      ),
    ).resolves.toHaveLength(1);
  });

  // The failure this exists for: stop_reason end_turn, zero content blocks. It
  // used to resolve as a successful empty answer, so nothing retried.
  it("rejects a turn that completed having said nothing", async () => {
    await expect(
      collect(requireContent("claude", frames({ type: "usage" }, { type: "finish" }))),
    ).rejects.toThrow(ProviderError);
  });

  it("holds the empty frames back so the retry rule can still fire", async () => {
    vi.useRealTimers();
    let attempt = 0;
    const out = await collect(
      withStreamRetry<ProviderChunk>(
        () => {
          attempt += 1;
          return requireContent(
            "claude",
            attempt === 1
              ? frames({ type: "usage" }, { type: "finish" })
              : frames({ type: "delta", content: "second time lucky" }),
          );
        },
        { sleep: async () => undefined },
      ),
    );
    expect(attempt).toBe(2);
    // Nothing from the empty attempt reached the consumer, so the retry was
    // legal: rule 2 only holds while nothing has been emitted.
    expect(out).toEqual([{ type: "delta", content: "second time lucky" }]);
  });
});

// Invariant 2 says the watchdog's timeout is ours, is transient, and is always
// safe to retry. It was none of those to the retry layer: `classify` re-derived
// the already-classified error from a status it never had, landed on "unknown",
// and a wedged stream failed for good at the 60s mark instead of trying again.
describe("an error this package classified stays classified", () => {
  it("keeps the watchdog's own timeout retryable", () => {
    const watch = streamWatch({ provider: "claude", idleMs: STREAM_IDLE_MS });
    vi.advanceTimersByTime(STREAM_IDLE_MS);
    const err = watch.classify(new Error("aborted"));
    watch.dispose();

    expect(err).toBeInstanceOf(ProviderError);
    expect(classify(err)).toBe("timeout");
    expect(isTransient(classify(err))).toBe(true);
  });

  it("does not re-derive any kind it was given", () => {
    for (const kind of ["timeout", "overload", "quota", "entitlement", "context"] as const) {
      expect(classify(new ProviderError("p", kind, "no status, no body"))).toBe(kind);
    }
  });
});

describe("withWatchdog", () => {
  /** A provider recording the options it was handed, streaming what it is told. */
  function stub(chunks: ProviderChunk[], hold = 0): Provider & { seen: StreamOptions[] } {
    const seen: StreamOptions[] = [];
    return {
      id: "stub",
      model: "m",
      seen,
      async *createStream(_m: ChatMessage[], _t, opts: StreamOptions = {}) {
        seen.push(opts);
        for (const chunk of chunks) {
          // A real request dies when its signal aborts. A stub that ignores it
          // would pass whether or not the wrapper wired the signal at all.
          if (hold) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, hold);
              opts.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(opts.signal?.reason as Error);
              });
            });
          }
          yield chunk;
        }
      },
    };
  }
  const drain = async (provider: Provider) => {
    const out: ProviderChunk[] = [];
    for await (const chunk of provider.createStream([], [])) out.push(chunk);
    return out;
  };

  it("hands the provider the WATCH's signal, never the caller's", async () => {
    const caller = new AbortController();
    const inner = stub([{ type: "delta", content: "hi" }]);
    const guarded = withWatchdog(inner);

    for await (const _ of guarded.createStream([], [], { signal: caller.signal })) break;

    // The trap this wrapper exists to close: given the caller's signal, the
    // provider's request is one the watchdog cannot cancel.
    expect(inner.seen[0]?.signal).toBeDefined();
    expect(inner.seen[0]?.signal).not.toBe(caller.signal);
  });

  it("times out a stream that goes quiet, as our own transient failure", async () => {
    const guarded = withWatchdog(stub([{ type: "delta", content: "a" }], STREAM_IDLE_MS * 2));
    // Handler attached before the clock runs: an unwatched rejection between
    // the two statements is an unhandled rejection, not a test failure.
    const done = expect(drain(guarded)).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS);
    await done;
  });

  it("rejects a turn that completed having said nothing", async () => {
    const guarded = withWatchdog(stub([{ type: "finish", finishReason: "stop" }]));
    await expect(drain(guarded)).rejects.toMatchObject({ kind: "overload" });
  });

  it("leaves the empty turn alone when the caller opts out", async () => {
    const guarded = withWatchdog(stub([{ type: "finish", finishReason: "stop" }]), {
      requireContent: false,
    });
    expect(await drain(guarded)).toHaveLength(1);
  });

  it("reports TTFT on the first byte of any kind, not the first shown", async () => {
    const ttft: number[] = [];
    const guarded = withWatchdog(
      // A usage frame first: held back by requireContent, but it is still the
      // moment the wait a person feels actually ended.
      stub([{ type: "usage" }, { type: "delta", content: "hi" }]),
      { onFirstChunk: (ms) => ttft.push(ms) },
    );
    await drain(guarded);
    expect(ttft).toHaveLength(1);
  });

  it("arms nothing until the stream is actually read", async () => {
    const guarded = withWatchdog(stub([{ type: "delta", content: "hi" }]));
    const stream = guarded.createStream([], []);
    vi.advanceTimersByTime(STREAM_IDLE_MS * 2);
    // Built long before it was read, and still fine — the deadline belongs to
    // the reading, not to the building.
    const out: ProviderChunk[] = [];
    for await (const chunk of stream) out.push(chunk);
    expect(out).toEqual([{ type: "delta", content: "hi" }]);
  });
});
