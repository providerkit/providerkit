import { describe, expect, it, vi } from "vitest";
import {
  backoffMs,
  sleep,
  streamWithBackupModels,
  withBackupModels,
  withRetry,
  withStreamRetry,
} from "../src/retry.ts";

/** An SDK-shaped error the classifier can read. */
const apiError = (status: number, body: unknown = {}, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`${status} status code`), { status, error: body, ...extra });

const overload = () => apiError(503, { message: "server error" });
const badKey = () => apiError(401, { message: "invalid api key" });

/** Never actually waits; records what the delay would have been. */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    fn: async (ms: number) => {
      delays.push(ms);
    },
  };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("backoffMs", () => {
  it("stays within the full-jitter envelope and respects the cap", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const ceiling = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i++) {
        const ms = backoffMs(attempt);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("is jittered, not a fixed ladder — the whole point", () => {
    const seen = new Set(Array.from({ length: 200 }, () => backoffMs(6)));
    expect(seen.size).toBeGreaterThan(50);
  });
});

describe("withRetry", () => {
  it("retries a transient failure and returns the eventual success", async () => {
    const nap = fakeSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (++calls < 3) throw overload();
        return "ok";
      },
      { sleep: nap.fn },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(nap.delays).toHaveLength(2);
  });

  it("does NOT retry a deterministic failure — every attempt lands the same", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw badKey();
        },
        { sleep: fakeSleep().fn },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("gives up at maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw overload();
        },
        { maxAttempts: 4, sleep: fakeSleep().fn },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(4);
  });

  it("honours the provider's own Retry-After over its backoff", async () => {
    const nap = fakeSleep();
    let calls = 0;
    await withRetry(
      async () => {
        if (++calls < 2) throw apiError(429, { retryDelay: "7s" });
        return "ok";
      },
      { sleep: nap.fn },
    );
    expect(nap.delays).toEqual([7_000]);
  });

  it("caps an absurd Retry-After at maxDelayMs", async () => {
    const nap = fakeSleep();
    let calls = 0;
    await withRetry(
      async () => {
        if (++calls < 2) throw apiError(429, { retryDelay: "9000s" });
        return "ok";
      },
      { maxDelayMs: 30_000, sleep: nap.fn },
    );
    expect(nap.delays).toEqual([30_000]);
  });

  it("a caller Stop ends it immediately, however transient the error looks", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          controller.abort(new Error("stopped"));
          throw overload();
        },
        { signal: controller.signal, sleep: fakeSleep().fn },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("reports each retry to onRetry", async () => {
    const seen: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        if (++calls < 3) throw overload();
        return "ok";
      },
      { sleep: fakeSleep().fn, onRetry: ({ attempt }) => seen.push(attempt) },
    );
    expect(seen).toEqual([1, 2]);
  });
});

describe("withStreamRetry — the commitment rule", () => {
  it("retries a failure that happens BEFORE the first chunk", async () => {
    const nap = fakeSleep();
    let attempts = 0;
    const chunks = await collect(
      withStreamRetry(
        async function* () {
          if (++attempts < 3) throw overload();
          yield "a";
          yield "b";
        },
        { sleep: nap.fn },
      ),
    );
    expect(chunks).toEqual(["a", "b"]);
    expect(attempts).toBe(3);
  });

  it("does NOT retry once a chunk has reached the consumer", async () => {
    // The rule that keeps a retry from replaying tokens already rendered.
    let attempts = 0;
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of withStreamRetry(
          async function* () {
            attempts++;
            yield "partial";
            throw overload();
          },
          { sleep: fakeSleep().fn },
        )) {
          seen.push(chunk);
        }
      })(),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(seen).toEqual(["partial"]);
  });

  it("cancels an abandoned attempt so a retry cannot stack a second stream", async () => {
    const signals: AbortSignal[] = [];
    let attempts = 0;
    await collect(
      withStreamRetry(
        async function* (signal) {
          signals.push(signal);
          if (++attempts < 2) throw overload();
          yield "ok";
        },
        { sleep: fakeSleep().fn },
      ),
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true); // the abandoned one
  });

  it("aborts the upstream when the consumer breaks out early", async () => {
    let captured: AbortSignal | undefined;
    const stream = withStreamRetry(async function* (signal) {
      captured = signal;
      yield "a";
      yield "b";
    });
    for await (const _chunk of stream) break;
    expect(captured?.aborted).toBe(true);
  });
});

describe("backup models", () => {
  it("walks to the next model on an overload", async () => {
    const tried: string[] = [];
    const result = await withBackupModels(
      async (model) => {
        tried.push(model);
        if (model !== "backup-2") throw overload();
        return model;
      },
      { models: ["primary", "backup-1", "backup-2"] },
    );
    expect(result).toBe("backup-2");
    expect(tried).toEqual(["primary", "backup-1", "backup-2"]);
  });

  it("stops the walk on a deterministic failure — every backup would agree", async () => {
    const tried: string[] = [];
    await expect(
      withBackupModels(
        async (model) => {
          tried.push(model);
          throw badKey();
        },
        { models: ["primary", "backup-1", "backup-2"] },
      ),
    ).rejects.toThrow();
    expect(tried).toEqual(["primary"]);
  });

  it("reports the fallbacks it takes", async () => {
    const fellBackTo: string[] = [];
    await withBackupModels(
      async (model) => {
        if (model === "primary") throw overload();
        return model;
      },
      {
        models: ["primary", "backup-1"],
        onFallback: ({ model }) => fellBackTo.push(model),
      },
    );
    expect(fellBackTo).toEqual(["backup-1"]);
  });

  it("rejects an empty model list rather than silently doing nothing", async () => {
    await expect(withBackupModels(async () => "x", { models: [] })).rejects.toThrow(
      /must include a primary model/,
    );
  });
});

describe("streamWithBackupModels", () => {
  it("walks when the primary fails before emitting", async () => {
    const chunks = await collect(
      streamWithBackupModels(
        async function* (model) {
          if (model === "primary") throw overload();
          yield model;
        },
        { models: ["primary", "backup-1"] },
      ),
    );
    expect(chunks).toEqual(["backup-1"]);
  });

  it("does NOT walk after emitting — no answer restarted in another model's voice", async () => {
    // A backup walk past the first chunk replays the answer from the top, on
    // top of text the caller already rendered.
    const tried: string[] = [];
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of streamWithBackupModels(
          async function* (model) {
            tried.push(model);
            yield `${model}:partial`;
            throw overload();
          },
          { models: ["primary", "backup-1"] },
        )) {
          seen.push(chunk);
        }
      })(),
    ).rejects.toThrow();
    expect(tried).toEqual(["primary"]);
    expect(seen).toEqual(["primary:partial"]);
  });
});

describe("sleep", () => {
  it("wakes early and rejects when the caller aborts mid-wait", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error("stopped");
      const pending = sleep(60_000, controller.signal);
      const assertion = expect(pending).rejects.toBe(reason);
      controller.abort(reason);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately when handed an already-aborted signal", async () => {
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);
    await expect(sleep(1_000, controller.signal)).rejects.toBe(reason);
  });
});
