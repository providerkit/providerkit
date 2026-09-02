import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors.ts";
import { STREAM_IDLE_MS, streamWatch, watchChunks } from "../src/watchdog.ts";

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
