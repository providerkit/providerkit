import { describe, expect, it, vi } from "vitest";
import {
  FallbackPool,
  NoAvailableProviderError,
  withConfiguredFallbacks,
  withFallbackProviders,
} from "../src/fallback.ts";
import { ProviderError, parseRetryAfterMs, streamError } from "../src/errors.ts";
import { drainStream, type Provider, type ProviderChunk } from "../src/types.ts";
import { postJson } from "../src/transport.ts";

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
          retryAfterMs: 60_000, resetAtMs: NOW + 3 * DAY, window: "weekly",
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
    const call = vi.fn(async (id: string) => { throw failure("rate", id === "b" ? 10_000 : DAY); });
    await expect(pool.with(call)).rejects.toBeInstanceOf(ProviderError);
    await expect(pool.with(call)).rejects.toMatchObject({ retryAtMs: NOW + 10_000 });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["rate", 60_000], ["quota", 3_600_000], ["overload", 30_000],
    ["network", 30_000], ["timeout", 30_000], ["auth", 3_600_000],
    ["entitlement", 3_600_000], ["model", 3_600_000],
  ] as const)("cools %s for %i ms when the endpoint gives no deadline", async (kind, wait) => {
    const pool = new FallbackPool(["a", "b"], { now: () => NOW });
    await pool.with(async (id) => { if (id === "a") throw failure(kind); return id; });
    expect(pool.status()[0]?.retryAtMs).toBe(NOW + wait);
  });

  it.each(["invalid", "context", "content", "unknown", "aborted"] as const)("does not switch on %s", async (kind) => {
    const pool = new FallbackPool(["a", "b"]);
    const call = vi.fn(async () => { throw failure(kind); });
    await expect(pool.with(call)).rejects.toMatchObject({ kind });
    expect(call).toHaveBeenCalledTimes(1);
    expect(pool.status().every((entry) => entry.retryAtMs === 0)).toBe(true);
  });

  it("allows shorter defaults and disabling fallback, but never shortens a server deadline", async () => {
    const pool = new FallbackPool(["a", "b"], { now: () => NOW, cooldownMs: { rate: 5, auth: null } });
    await pool.with(async (id) => { if (id === "a") throw failure("rate", DAY); return id; });
    expect(pool.status()[0]?.retryAtMs).toBe(NOW + DAY);
    pool.reset("a");
    const call = vi.fn(async () => { throw failure("auth"); });
    await expect(pool.with(call)).rejects.toMatchObject({ kind: "auth" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("lets only one request probe a recovered primary while other requests use the backup", async () => {
    let now = NOW;
    const pool = new FallbackPool(["a", "b"], { now: () => now });
    await pool.with(async (id) => { if (id === "a") throw failure("rate", 100); return id; });
    now += 100;
    const recovery = Promise.withResolvers<string>();
    const call = vi.fn((id: string) => id === "a" ? recovery.promise : Promise.resolve(id));
    const probing = pool.with(call);
    expect(await pool.with(call)).toBe("b");
    expect(call.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    recovery.resolve("a");
    expect(await probing).toBe("a");
    expect(await pool.with(async (id) => id)).toBe("a");
  });

  it("does not erase a newer cooldown when an older in-flight request succeeds", async () => {
    const pool = new FallbackPool(["a", "b"], { now: () => NOW });
    const old = Promise.withResolvers<string>();
    const pending = pool.with(() => old.promise);
    await pool.with(async (id) => { if (id === "a") throw failure("quota", DAY); return id; });
    old.resolve("a");
    await pending;
    expect(await pool.with(async (id) => id)).toBe("b");
  });

  it("cools a mid-stream failure for future calls without replaying this answer", async () => {
    const pool = new FallbackPool(["a", "b"], { now: () => NOW });
    const seen: string[] = [];
    await expect((async () => {
      for await (const value of pool.stream(async function* (id) {
        yield `${id}:partial`;
        throw failure("rate", DAY);
      })) seen.push(value);
    })()).rejects.toMatchObject({ kind: "rate" });
    expect(seen).toEqual(["a:partial"]);
    expect(await pool.with(async (id) => id)).toBe("b");
  });

  it("never cools or switches on caller cancellation, even with a rate-shaped reason", async () => {
    const pool = new FallbackPool(["a", "b"]);
    const controller = new AbortController();
    const reason = failure("rate");
    const call = vi.fn(async () => { controller.abort(reason); throw reason; });
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
    })) break;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("rejects empty, duplicate and invalid cooldown configuration", () => {
    expect(() => new FallbackPool([])).toThrow(/primary/);
    expect(() => new FallbackPool(["a", "a"])).toThrow(/once/);
    expect(() => new FallbackPool(["a"], { cooldownMs: { rate: -1 } })).toThrow(/non-negative/);
  });
});

describe("provider composition", () => {
  it("forwards cancellation, keeps each endpoint's model and reports the actual source", async () => {
    const seen: string[] = [];
    let signal: AbortSignal | undefined;
    const primary: Provider = { id: "zai", model: "glm", async *createStream(_messages, _tools, opts) {
      seen.push(opts?.model ?? "");
      yield* [];
      throw failure("quota", DAY);
    } };
    const backup: Provider = { id: "openrouter", model: "z-ai/glm", async *createStream(_messages, _tools, opts) {
      signal = opts?.signal;
      seen.push(opts?.model ?? "");
      yield { type: "delta", content: "answer" };
    } };
    const provider = withFallbackProviders([primary, backup]);
    const result = await drainStream(provider.createStream([], [], { model: "primary-override" }), provider.model);
    expect(result).toMatchObject({ text: "answer", model: "z-ai/glm", provider: "openrouter" });
    expect(seen).toEqual(["primary-override", "z-ai/glm"]);
    expect(signal?.aborted).toBe(true);
    const chunks: ProviderChunk[] = await collect(provider.createStream([], []));
    expect(chunks[0]?.source).toEqual({ provider: "openrouter", model: "z-ai/glm" });
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
});

describe("reset hints survive the wire", () => {
  it("keeps the weekly reset beside a short Retry-After", async () => {
    const resetAtMs = Date.now() + 3 * DAY;
    const fetchImpl: typeof fetch = async () => new Response("weekly usage limit reached", {
      status: 429,
      headers: {
        "retry-after": "60",
        "anthropic-ratelimit-unified-7d-utilization": "100",
        "anthropic-ratelimit-unified-7d-reset": String(Math.ceil(resetAtMs / 1000)),
      },
    });
    const err = await postJson({ url: "https://example.com", provider: "plan", body: {}, fetchImpl }).catch((error: unknown) => error);
    expect(err).toMatchObject({ kind: "quota", retryAfterMs: 60_000, window: "weekly" });
    expect(err).toBeInstanceOf(ProviderError);
    if (!(err instanceof ProviderError)) throw new Error("missing provider error");
    expect(err.resetAtMs).toBeGreaterThanOrEqual(resetAtMs);
    expect(parseRetryAfterMs(err)).toBe(60_000);
  });

  it("keeps a body-only usage reset inside a 200 stream", () => {
    const err = streamError("chatgpt", { type: "usage_limit_reached", resets_in_seconds: 3 * DAY / 1000 });
    expect(err.retryAfterMs).toBe(3 * DAY);
    expect(err.window).toBe("weekly");
    expect(err.resetAtMs).toBeGreaterThanOrEqual(Date.now() + 3 * DAY - 100);
  });

  it("an all-cooled error still carries retry metadata for the caller", () => {
    expect(parseRetryAfterMs(new NoAvailableProviderError(NOW + DAY, NOW))).toBe(DAY);
  });
});
