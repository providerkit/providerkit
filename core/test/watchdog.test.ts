import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors.ts";
import {
  STREAM_IDLE_MS,
  STREAM_PROGRESS_MS,
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
  it("aborts once a started stream goes quiet for the whole idle window", () => {
    const watch = streamWatch({ provider: "openai" });
    watch.sawActivity(); // the headers arrived
    expect(watch.signal.aborted).toBe(false);
    vi.advanceTimersByTime(STREAM_IDLE_MS);
    expect(watch.signal.aborted).toBe(true);
    expect(watch.signal.reason).toBeInstanceOf(ProviderError);
    expect((watch.signal.reason as ProviderError).kind).toBe("timeout");
    watch.dispose();
  });

  it("gives a response that has not started the progress window, not the idle one", () => {
    // The ChatGPT backend withholds its headers until the model's first output
    // — minutes, on a large high-effort turn. Healthy the whole time.
    const watch = streamWatch({ provider: "chatgpt" });
    vi.advanceTimersByTime(STREAM_IDLE_MS * 2);
    expect(watch.signal.aborted).toBe(false);
    vi.advanceTimersByTime(STREAM_PROGRESS_MS - STREAM_IDLE_MS * 2);
    expect(watch.signal.aborted).toBe(true);
    expect((watch.signal.reason as ProviderError).kind).toBe("timeout");
    watch.dispose();
  });

  it("never runs the progress clock shorter than a longer idle clock", () => {
    // An outer watch raised to 30 minutes so a model chain can rotate inside
    // it must not be cut at five by a default the caller never set.
    const watch = streamWatch({ idleMs: 30 * 60_000 });
    vi.advanceTimersByTime(STREAM_PROGRESS_MS * 2);
    expect(watch.signal.aborted).toBe(false);
    vi.advanceTimersByTime(30 * 60_000 - STREAM_PROGRESS_MS * 2);
    expect(watch.signal.aborted).toBe(true);
    watch.dispose();

    // A progress clock the caller DID set is theirs.
    const explicit = streamWatch({ idleMs: 30 * 60_000, progressMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(explicit.signal.aborted).toBe(true);
    explicit.dispose();
  });

  it("lives on keep-alives, but not forever", () => {
    // A keep-alive is proof the socket is up — and a stream that sends nothing
    // else is still going nowhere. The idle clock never trips; progress does.
    const watch = streamWatch({ idleMs: 1_000, progressMs: 10_000 });
    for (let i = 0; i < 11; i++) {
      vi.advanceTimersByTime(900);
      watch.sawActivity();
    }
    expect(watch.signal.aborted).toBe(false); // 9.9s of keep-alives
    vi.advanceTimersByTime(100);
    expect(watch.signal.aborted).toBe(true);
    expect(String((watch.signal.reason as ProviderError).message)).toContain("without a chunk");
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
    watch.sawActivity();
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
    watch.sawActivity();
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

  it("counts a tool call as an answer", async () => {
    await expect(
      collect(
        requireContent("claude", frames({ type: "delta", toolCalls: [{ index: 0, name: "f" }] })),
      ),
    ).resolves.toHaveLength(1);
  });

  // Production, 2026-10-01: a review capped at 2,048 tokens on a high-effort
  // model thought for all 2,048, answered "", and passed as a success 22 times.
  it("streams reasoning live but rejects a turn whose cap ran out on it", async () => {
    const seen: ProviderChunk[] = [];
    const error = await (async () => {
      for await (const chunk of requireContent(
        "go",
        frames(
          { type: "delta", reasoning: "weighing every citation…" },
          {
            type: "usage",
            usage: {
              inputTokens: 16_328,
              cachedInputTokens: 0,
              outputTokens: 2_048,
              reasoningTokens: 2_048,
            },
          },
          { type: "finish", finishReason: "length" },
        ),
      )) {
        seen.push(chunk);
      }
    })().catch((err: unknown) => err);

    expect(seen[0]).toEqual({ type: "delta", reasoning: "weighing every citation…" });
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("invalid");
    expect((error as ProviderError).message).toMatch(
      /2048 of 2048 output tokens went to reasoning/,
    );
  });

  // The caller's cap is the cause, so the same cap must not be retried — the
  // old `overload` here retried it, then walked every backup model into it.
  it("does not retry an empty turn that hit the cap", async () => {
    vi.useRealTimers();
    let attempt = 0;
    await expect(
      collect(
        withStreamRetry<ProviderChunk>(
          () => {
            attempt += 1;
            return requireContent(
              "claude",
              frames({ type: "usage" }, { type: "finish", finishReason: "length" }),
            );
          },
          { sleep: async () => undefined },
        ),
      ),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(attempt).toBe(1);
  });

  it("rejects a turn that only thought and stopped", async () => {
    await expect(
      collect(
        requireContent(
          "claude",
          frames({ type: "delta", reasoning: "hmm" }, { type: "finish", finishReason: "stop" }),
        ),
      ),
    ).rejects.toMatchObject({ kind: "overload" });
  });

  // After a tool result, a turn that thought and stopped chose the tool as its
  // reply — the exception the guard already makes for an empty stop.
  it("passes a turn that thought after a tool result and chose to stop", async () => {
    await expect(
      collect(
        requireContent(
          "claude",
          frames({ type: "delta", reasoning: "done" }, { type: "finish", finishReason: "stop" }),
          { afterToolResult: true },
        ),
      ),
    ).resolves.toHaveLength(2);
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
    watch.sawActivity();
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
        opts.onActivity?.(); // the headers, as every adapter reports them
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
  const drain = async (provider: Provider, messages: ChatMessage[] = []) => {
    const out: ProviderChunk[] = [];
    for await (const chunk of provider.createStream(messages, [])) out.push(chunk);
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

  it("accepts an empty stop right after a tool result — the reply WAS the tool", async () => {
    // A bot whose send_message tool is the answer ends every turn this way.
    // Retried, cc-proxy measured one such bot failing ~68% of real turns.
    const afterTool: ChatMessage[] = [
      { role: "user", content: "say hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "send_message", arguments: '{"text":"hi"}' }],
      },
      { role: "tool", toolCallId: "c1", name: "send_message", content: "sent" },
    ];
    const stopped = withWatchdog(stub([{ type: "finish", finishReason: "stop" }]));
    expect(await drain(stopped, afterTool)).toEqual([{ type: "finish", finishReason: "stop" }]);

    // Thinking that ate the whole budget is still the failure, tool or not —
    // and it is the caller's cap, so it is not retried into the same one.
    const cut = withWatchdog(stub([{ type: "finish", finishReason: "length" }]));
    await expect(drain(cut, afterTool)).rejects.toMatchObject({ kind: "invalid" });

    // And an empty stop after a USER turn is still nothing said to anyone.
    const userTail = withWatchdog(stub([{ type: "finish", finishReason: "stop" }]));
    await expect(drain(userTail, [{ role: "user", content: "hi" }])).rejects.toMatchObject({
      kind: "overload",
    });
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
