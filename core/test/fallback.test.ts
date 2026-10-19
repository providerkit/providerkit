import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FallbackPool,
  NoAvailableProviderError,
  type Cooldown,
  withConfiguredFallbacks,
  withFallbackProviders,
} from "../src/fallback.ts";
import { ProviderError, parseRetryAfterMs, streamError } from "../src/errors.ts";
import { drainStream } from "../src/turn.ts";
import type { Provider, ProviderChunk } from "../src/types.ts";
import { postJson } from "../src/transport.ts";
import { STREAM_PROGRESS_MS } from "../src/watchdog.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const failure = (kind: ConstructorParameters<typeof ProviderError>[1], retryAfterMs?: number) =>
  new ProviderError("primary", kind, kind, { retryAfterMs });
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("fallback cooldowns", () => {
  it("skips an exhausted plan across calls and returns to it after its weekly reset", async () => {
    let now = NOW;
    const pool = new FallbackPool(["plan", "gateway", "direct"], { now: () => now });
    const call = vi.fn(async (id: string) => {
      if (id === "plan" && now < NOW + 3 * DAY) {
        throw new ProviderError(id, "quota", "weekly limit", {
          retryAfterMs: 60_000,
          resetAtMs: NOW + 3 * DAY,
          window: "weekly",
        });
      }
      return id;
    });
    expect(await pool.with(call)).toBe("gateway");
    now += DAY;
    expect(await pool.with(call)).toBe("gateway");
    expect(call.mock.calls.map(([id]) => id)).toEqual(["plan", "gateway", "gateway"]);
    expect(pool.status()[0]).toMatchObject({ retryAtMs: NOW + 3 * DAY, window: "weekly" });
    now = NOW + 3 * DAY;
    expect(await pool.with(call)).toBe("plan");
    expect(pool.status()[0]?.retryAtMs).toBe(0);
  });

  it("walks three endpoints, skips all cooled candidates and reports the earliest retry", async () => {
    const pool = new FallbackPool(["a", "b", "c"], { now: () => NOW });
    const call = vi.fn(async (id: string) => {
      throw failure("rate", id === "b" ? 10_000 : DAY);
    });
    await expect(pool.with(call)).rejects.toBeInstanceOf(ProviderError);
    await expect(pool.with(call)).rejects.toMatchObject({ retryAtMs: NOW + 10_000 });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["rate", 60_000],
    ["quota", 3_600_000],
    ["overload", 30_000],
    ["network", 30_000],
    ["timeout", 30_000],
    ["auth", 3_600_000],
    ["entitlement", 3_600_000],
    ["model", 3_600_000],
  ] as const)("cools %s for %i ms when the endpoint gives no deadline", async (kind, wait) => {
    const pool = new FallbackPool(["a", "b"], { now: () => NOW });
    await pool.with(async (id) => {
      if (id === "a") throw failure(kind);
      return id;
    });
    expect(pool.status()[0]?.retryAtMs).toBe(NOW + wait);
  });

  it.each(["invalid", "context", "content", "unknown", "aborted"] as const)(
    "does not switch on %s",
    async (kind) => {
      const pool = new FallbackPool(["a", "b"]);
      const call = vi.fn(async () => {
        throw failure(kind);
      });
      await expect(pool.with(call)).rejects.toMatchObject({ kind });
      expect(call).toHaveBeenCalledTimes(1);
      expect(pool.status().every((entry) => entry.retryAtMs === 0)).toBe(true);
    },
  );

  it("allows shorter defaults and disabling fallback, but never shortens a server deadline", async () => {
    const pool = new FallbackPool(["a", "b"], {
      now: () => NOW,
      cooldownMs: { rate: 5, auth: null },
    });
    await pool.with(async (id) => {
      if (id === "a") throw failure("rate", DAY);
      return id;
    });
    expect(pool.status()[0]?.retryAtMs).toBe(NOW + DAY);
    pool.reset("a");
    const call = vi.fn(async () => {
      throw failure("auth");
    });
    await expect(pool.with(call)).rejects.toMatchObject({ kind: "auth" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("lets only one request probe a recovered primary while other requests use the backup", async () => {
    let now = NOW;
    const pool = new FallbackPool(["a", "b"], { now: () => now });
    await pool.with(async (id) => {
      if (id === "a") throw failure("rate", 100);
      return id;
    });
    now += 100;
    const recovery = Promise.withResolvers<string>();
    const call = vi.fn((id: string) => (id === "a" ? recovery.promise : Promise.resolve(id)));
    const probing = pool.with(call);
    expect(await pool.with(call)).toBe("b");
    expect(call.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    recovery.resolve("a");
    expect(await probing).toBe("a");
    expect(await pool.with(async (id) => id)).toBe("a");
  });

  it("replaces a probe that never answers, and the stale one cannot free its successor", async () => {
    let now = NOW;
    const pool = new FallbackPool(["a", "b"], { now: () => now });
    await pool.with(async (id) => {
      if (id === "a") throw failure("rate", 100);
      return id;
    });
    now += 100;
    const calls: string[] = [];
    const answer = async (id: string) => {
      calls.push(id);
      return id;
    };
    const stop = new AbortController();
    const hung = pool.with((id, signal) => {
      calls.push(id);
      return new Promise<string>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    }, stop.signal);
    expect(await pool.with(answer)).toBe("b");

    // Past the progress clock the hung probe is presumed dead and replaced.
    now += STREAM_PROGRESS_MS;
    const recovery = Promise.withResolvers<string>();
    const replacement = pool.with((id) => {
      calls.push(id);
      return recovery.promise;
    });
    // The stale probe ending late must not release the probe that replaced it.
    stop.abort(new Error("stopped"));
    await expect(hung).rejects.toThrow("stopped");
    expect(await pool.with(answer)).toBe("b");

    recovery.resolve("a");
    expect(await replacement).toBe("a");
    expect(calls).toEqual(["a", "b", "a", "b"]);
    expect(pool.status()[0]).toMatchObject({ retryAtMs: 0, probing: false });
  });

  it("does not erase a newer cooldown when an older in-flight request succeeds", async () => {
    const pool = new FallbackPool(["a", "b"], { now: () => NOW });
    const old = Promise.withResolvers<string>();
    const pending = pool.with(() => old.promise);
    await pool.with(async (id) => {
      if (id === "a") throw failure("quota", DAY);
      return id;
    });
    old.resolve("a");
    await pending;
    expect(await pool.with(async (id) => id)).toBe("b");
  });

  // One stray 401 used to bench a busy primary for an hour, even after a call
  // that was already running on it answered. A throttle stays benched: a call
  // that started before it proves nothing about the window.
  it.each([
    ["auth", "a"],
    ["rate", "b"],
  ] as const)(
    "a long call that answers after a sibling's %s failure sends the next call to %s",
    async (kind, next) => {
      const pool = new FallbackPool(["a", "b"], { now: () => NOW });
      const long = Promise.withResolvers<string>();
      const pending = pool.with(() => long.promise);
      expect(
        await pool.with(async (id) => {
          if (id === "a") throw failure(kind);
          return id;
        }),
      ).toBe("b");
      long.resolve("a");
      expect(await pending).toBe("a");
      expect(await pool.with(async (id) => id)).toBe(next);
    },
  );

  it("cools a mid-stream failure for future calls without replaying this answer", async () => {
    const pool = new FallbackPool(["a", "b"], { now: () => NOW });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const value of pool.stream(async function* (id) {
          yield `${id}:partial`;
          throw failure("rate", DAY);
        }))
          seen.push(value);
      })(),
    ).rejects.toMatchObject({ kind: "rate" });
    expect(seen).toEqual(["a:partial"]);
    expect(await pool.with(async (id) => id)).toBe("b");
  });

  it("never cools or switches on caller cancellation, even with a rate-shaped reason", async () => {
    const pool = new FallbackPool(["a", "b"]);
    const controller = new AbortController();
    const reason = failure("rate");
    const call = vi.fn(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(pool.with(call, controller.signal)).rejects.toBe(reason);
    expect(call).toHaveBeenCalledTimes(1);
    expect(pool.status().every((entry) => entry.retryAtMs === 0)).toBe(true);
  });

  it("aborts abandoned attempts before opening another endpoint and on consumer exit", async () => {
    const pool = new FallbackPool(["a", "b"]);
    const signals: AbortSignal[] = [];
    for await (const _chunk of pool.stream(async function* (id, signal) {
      if (signals[0]) expect(signals[0].aborted).toBe(true);
      signals.push(signal);
      if (id === "a") throw failure("overload");
      yield id;
      yield id;
    }))
      break;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("rejects empty, duplicate and invalid cooldown configuration", () => {
    expect(() => new FallbackPool([])).toThrow(/primary/);
    expect(() => new FallbackPool(["a", "a"])).toThrow(/once/);
    expect(() => new FallbackPool(["a"], { cooldownMs: { rate: -1 } })).toThrow(/non-negative/);
    expect(() => new FallbackPool(["a"], { probeStaleMs: Infinity })).toThrow(/probeStaleMs/);
  });
});

describe("a cooldown store shared by several pools", () => {
  it("benches a candidate in every chain that holds it, and reset() clears only its own", async () => {
    const store = new Map<string, Cooldown>();
    const left = new FallbackPool(["shared", "left"], { cooldowns: store, now: () => NOW });
    const right = new FallbackPool(["shared", "right"], { cooldowns: store, now: () => NOW });

    expect(
      await left.with(async (id) => {
        if (id === "shared") throw failure("quota", DAY);
        return id;
      }),
    ).toBe("left");
    // The lockout the left chain learned costs the right chain no call at all.
    const call = vi.fn(async (id: string) => id);
    expect(await right.with(call)).toBe("right");
    expect(call.mock.calls.map(([id]) => id)).toEqual(["right"]);

    await expect(
      right.with(async () => {
        throw failure("rate", DAY);
      }),
    ).rejects.toMatchObject({ kind: "rate" });
    left.reset();
    expect(right.status().map((entry) => entry.retryAtMs)).toEqual([0, NOW + DAY]);
  });
});

describe("callers that find only a probe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A one-candidate chain whose cooldown has just run out. */
  async function recovered(): Promise<FallbackPool<string>> {
    vi.useFakeTimers({ now: NOW });
    const pool = new FallbackPool(["only"], { now: () => Date.now() });
    await expect(
      pool.with(async () => {
        throw failure("rate", 1_000);
      }),
    ).rejects.toMatchObject({ kind: "rate" });
    await vi.advanceTimersByTimeAsync(1_000);
    return pool;
  }

  it("wait for it: 70 calls after a cooldown make one probe, and all 70 answer", async () => {
    // Every caller but the probe used to fail at once with a 0 ms retry, which
    // `withRetry` spent in one burst. cc-proxy measured it at 70 concurrent.
    const pool = await recovered();
    let calls = 0;
    const answers = Promise.allSettled(
      Array.from({ length: 70 }, () =>
        pool.with(async (id) => {
          if (++calls === 1) await new Promise((resolve) => setTimeout(resolve, 5_000));
          return id;
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const results = await answers;
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : r.reason))).toEqual(
      Array(70).fill("only"),
    );
    expect(calls).toBe(70);
    // Seventy waits ended by the probe, and not one of their timers left behind.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a waiter takes over a probe that never answers once it goes stale", async () => {
    const pool = await recovered();
    const calls: string[] = [];
    void pool.with((id) => {
      calls.push(id);
      return new Promise<string>(() => {});
    });
    await vi.advanceTimersByTimeAsync(100_000);
    const waiter = pool.with(async (id) => {
      calls.push(id);
      return id;
    });
    // It wakes when the probe goes stale, not a full probeStaleMs after it began to wait.
    await vi.advanceTimersByTimeAsync(STREAM_PROGRESS_MS - 100_000 - 1);
    expect(calls).toEqual(["only"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiter).toBe("only");
    expect(calls).toEqual(["only", "only"]);
  });

  it("a waiter's Stop rejects at once with its reason and leaves no timer", async () => {
    const pool = await recovered();
    const probe = Promise.withResolvers<string>();
    const probing = pool.with(() => probe.promise);
    const stop = new AbortController();
    const waiting = pool.with(async (id) => id, stop.signal);
    const reason = new Error("stopped");
    stop.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    probe.resolve("only");
    expect(await probing).toBe("only");
  });
});

describe("provider composition", () => {
  it("forwards cancellation, keeps each endpoint's model and reports the actual source", async () => {
    const seen: string[] = [];
    let signal: AbortSignal | undefined;
    const primary: Provider = {
      id: "zai",
      model: "glm",
      async *createStream(_messages, _tools, opts) {
        seen.push(opts?.model ?? "");
        yield* [];
        throw failure("quota", DAY);
      },
    };
    const backup: Provider = {
      id: "openrouter",
      model: "z-ai/glm",
      async *createStream(_messages, _tools, opts) {
        signal = opts?.signal;
        seen.push(opts?.model ?? "");
        yield { type: "delta", content: "answer" };
      },
    };
    const provider = withFallbackProviders([primary, backup]);
    const result = await drainStream(
      provider.createStream([], [], { model: "primary-override" }),
      provider.model,
    );
    expect(result).toMatchObject({ text: "answer", model: "z-ai/glm", provider: "openrouter" });
    expect(seen).toEqual(["primary-override", "z-ai/glm"]);
    expect(signal?.aborted).toBe(true);
    const chunks: ProviderChunk[] = await collect(provider.createStream([], []));
    expect(chunks[0]?.source).toEqual({ provider: "openrouter", model: "z-ai/glm" });
  });

  it("applies one inherited watchdog to each configured fallback candidate", async () => {
    vi.useFakeTimers();
    try {
      const primary: Provider = {
        id: "primary",
        model: "a",
        async *createStream() {
          yield* [];
          throw failure("overload");
        },
      };
      const backup: Provider = {
        id: "backup",
        model: "b",
        async *createStream(_messages, _tools, opts) {
          yield* [];
          await new Promise<void>((_resolve, reject) => {
            const signal = opts?.signal;
            if (!signal) throw new Error("expected a watchdog signal");
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      };
      const cooled: Array<{ candidate: Provider; kind: string }> = [];
      const provider = withConfiguredFallbacks(primary, {
        fallbacks: [backup],
        // Never answers at all, so it is the progress clock that catches it:
        // the idle one only starts once a response does.
        watchdog: { progressMs: 10 },
        fallbackOptions: {
          onCooldown: ({ candidate, kind }) => cooled.push({ candidate, kind }),
        },
      });

      const pending = drainStream(provider.createStream([], []), provider.model);
      const failed = expect(pending).rejects.toMatchObject({ kind: "timeout" });
      await vi.advanceTimersByTimeAsync(10);
      await failed;

      expect(cooled).toEqual([
        { candidate: expect.objectContaining({ id: "primary", model: "a" }), kind: "overload" },
        { candidate: expect.objectContaining({ id: "backup", model: "b" }), kind: "timeout" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports fallbacks directly on provider config (the easy option)", async () => {
    const backup: Provider = {
      id: "openrouter",
      model: "z-ai/glm-5.3-flash",
      async *createStream() {
        yield { type: "delta", content: "fallback-answer" };
      },
    };

    // Configuring fallbacks directly inside createZaiCodingProvider
    const fetchFailing: typeof fetch = async () => new Response("overloaded", { status: 503 });
    const { createZaiCodingProvider } = await import("../src/providers/zai.ts");
    const provider = createZaiCodingProvider({
      apiKey: "test-zai-key",
      model: "glm-5.3-flash",
      fetchImpl: fetchFailing,
      fallbacks: [backup],
    });

    const completion = await drainStream(provider.createStream([], []), provider.model);
    expect(completion.text).toBe("fallback-answer");
    expect(completion.model).toBe("z-ai/glm-5.3-flash");
    expect(completion.provider).toBe("openrouter");
  });

  it("resolves preset-id fallback specs — no baseUrl, no quirks at the call site", async () => {
    // The failing primary: a stub that answers 429 with a reset, like a spent
    // coding plan. The fallback is DECLARED, not built: preset id + key + model.
    const failing: Provider = {
      id: "zai",
      model: "glm-5.3-flash",
      async *createStream() {
        yield* [];
        throw new ProviderError("zai", "quota", "weekly limit", {
          retryAfterMs: 60_000,
          resetAtMs: Date.now() + 3 * DAY,
          window: "weekly",
        });
      },
    };

    // A scripted SSE body in the OpenAI chat-completions shape — what the
    // deepseek preset's adapter consumes once resolved from the table.
    const sse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const fetchImpl: typeof fetch = async () => sse;

    const provider = withConfiguredFallbacks(failing, {
      fallbacks: [{ preset: "deepseek", apiKey: "k", model: "deepseek-v4.1-flash", fetchImpl }],
    });

    const completion = await drainStream(provider.createStream([], []), provider.model);
    expect(completion.text).toBe("ok");
    expect(completion.provider).toBe("deepseek");
    expect(completion.model).toBe("deepseek-v4.1-flash");
  });

  it("benches a backup that refuses its model id, rather than calling it every time", async () => {
    // A real outage: the primary throttled, and the backup was set up with an
    // id its API does not serve. While that 400 read as `invalid` it had no
    // cooldown, so every call walked past the throttled primary and sent the
    // backup the same request again.
    const throttled: Provider = {
      id: "zai",
      model: "glm-5.3-flash",
      async *createStream() {
        yield* [];
        throw new ProviderError("zai", "rate", "slow down");
      },
    };
    let backupCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      backupCalls++;
      return new Response(
        JSON.stringify({
          error: {
            message:
              "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash.",
            type: "invalid_request_error",
            param: null,
            code: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    };
    const provider = withConfiguredFallbacks(throttled, {
      fallbacks: [{ preset: "deepseek", apiKey: "k", model: "deepseek-v4.1-flash", fetchImpl }],
    });

    await expect(drainStream(provider.createStream([], []), provider.model)).rejects.toMatchObject({
      provider: "deepseek",
      kind: "model",
    });
    await expect(drainStream(provider.createStream([], []), provider.model)).rejects.toBeInstanceOf(
      NoAvailableProviderError,
    );
    expect(backupCalls).toBe(1);
  });
});

describe("reset hints survive the wire", () => {
  it("keeps the weekly reset beside a short Retry-After", async () => {
    const resetAtMs = Date.now() + 3 * DAY;
    const fetchImpl: typeof fetch = async () =>
      new Response("weekly usage limit reached", {
        status: 429,
        headers: {
          "retry-after": "60",
          "anthropic-ratelimit-unified-7d-utilization": "100",
          "anthropic-ratelimit-unified-7d-reset": String(Math.ceil(resetAtMs / 1000)),
        },
      });
    const err = await postJson({
      url: "https://example.com",
      provider: "plan",
      body: {},
      fetchImpl,
    }).catch((error: unknown) => error);
    expect(err).toMatchObject({ kind: "quota", retryAfterMs: 60_000, window: "weekly" });
    expect(err).toBeInstanceOf(ProviderError);
    if (!(err instanceof ProviderError)) throw new Error("missing provider error");
    expect(err.resetAtMs).toBeGreaterThanOrEqual(resetAtMs);
    expect(parseRetryAfterMs(err)).toBe(60_000);
  });

  it("keeps a body-only usage reset inside a 200 stream", () => {
    const err = streamError("chatgpt", {
      type: "usage_limit_reached",
      resets_in_seconds: (3 * DAY) / 1000,
    });
    expect(err.retryAfterMs).toBe(3 * DAY);
    expect(err.window).toBe("weekly");
    expect(err.resetAtMs).toBeGreaterThanOrEqual(Date.now() + 3 * DAY - 100);
  });

  it("an all-cooled error still carries retry metadata for the caller", () => {
    expect(parseRetryAfterMs(new NoAvailableProviderError(NOW + DAY, NOW))).toBe(DAY);
  });
});
