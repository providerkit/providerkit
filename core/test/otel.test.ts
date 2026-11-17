/// <reference types="node" />
// Host APIs are used only by tests, never by src.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  context,
  createContextKey,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Span,
  type SpanOptions,
  type SpanStatus,
  type Tracer,
} from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectTurn,
  createGate,
  createRegistry,
  ProviderError,
  withGate,
  withWatchdog,
} from "../src/index.ts";
import type {
  ChatMessage,
  Provider,
  ProviderChunk,
  StreamOptions,
  TokenUsage,
} from "../src/index.ts";
import { withProviderTracing } from "../src/otel.ts";

class RecordingSpan implements Span {
  attributes: Attributes;
  events: unknown[] = [];
  status: SpanStatus = { code: SpanStatusCode.UNSET };
  endCount = 0;
  constructor(
    readonly name: string,
    readonly options: SpanOptions,
    readonly parent: Context,
  ) {
    this.attributes = { ...options.attributes };
  }
  spanContext() {
    return { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 };
  }
  setAttribute(key: string, value: AttributeValue) {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(attributes: Attributes) {
    Object.assign(this.attributes, attributes);
    return this;
  }
  setStatus(status: SpanStatus) {
    this.status = status;
    return this;
  }
  addEvent(...args: unknown[]) {
    this.events.push(args);
    return this;
  }
  addLink(...args: unknown[]) {
    this.events.push(args);
    return this;
  }
  addLinks(...args: unknown[]) {
    this.events.push(args);
    return this;
  }
  updateName() {
    return this;
  }
  recordException(error: unknown) {
    this.events.push(error);
  }
  isRecording() {
    return true;
  }
  end() {
    this.endCount++;
  }
}

class RecordingTracer implements Tracer {
  spans: RecordingSpan[] = [];
  startSpan(name: string, options: SpanOptions = {}, parent = ROOT_CONTEXT) {
    const span = new RecordingSpan(name, options, parent);
    this.spans.push(span);
    return span;
  }
  startActiveSpan(): never {
    throw new Error("Use explicit startSpan, not startActiveSpan.");
  }
}

const delta: ProviderChunk = { type: "delta", content: "hello" };
const finish: ProviderChunk = { type: "finish", finishReason: "stop" };
const counts: TokenUsage = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 };
function fakeProvider(chunks: ProviderChunk[] = [delta, finish], error?: unknown): Provider {
  return {
    id: "gemini",
    model: "requested",
    createStream: vi.fn(async function* () {
      yield* chunks;
      if (error !== undefined) throw error;
    }),
  };
}
function fromIterator(iterator: AsyncIterator<ProviderChunk, unknown, unknown>): Provider {
  return {
    id: "custom",
    model: "model",
    createStream: vi.fn(() => ({ [Symbol.asyncIterator]: () => iterator })),
  };
}
function read(provider: Provider, opts?: StreamOptions) {
  return provider.createStream([], [], opts)[Symbol.asyncIterator]();
}
function recorded(tracer: RecordingTracer, index = 0) {
  return tracer.spans[index]!;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("withProviderTracing", () => {
  it("does no work for an unread stream, then preserves chunks, results and backpressure", async () => {
    const tracer = new RecordingTracer();
    const result: IteratorResult<ProviderChunk> = { done: false, value: delta };
    const last: IteratorResult<ProviderChunk> = { done: true, value: "terminal value" };
    const next = vi.fn().mockResolvedValueOnce(result).mockResolvedValueOnce(last);
    const provider = fromIterator({ next });
    const stream = withProviderTracing(provider, { tracer }).createStream([], []);
    const iterator = stream[Symbol.asyncIterator]();
    expect(provider.createStream).not.toHaveBeenCalled();
    expect(tracer.spans).toHaveLength(0);
    expect(await iterator.next()).toBe(result);
    expect(result.value).toBe(delta);
    expect(next).toHaveBeenCalledTimes(1);
    expect(provider.createStream).toHaveBeenCalledTimes(1);
    expect(recorded(tracer).endCount).toBe(0);
    expect(await iterator.next()).toBe(last);
    expect(recorded(tracer).endCount).toBe(1);
    expect(recorded(tracer).status.code).toBe(SpanStatusCode.UNSET);
    expect(recorded(tracer).options.kind).toBe(SpanKind.CLIENT);
  });

  it("captures a separate parent per call, not at setup or the delayed first read", async () => {
    const tracer = new RecordingTracer();
    const key = createContextKey("test-parent");
    const first = ROOT_CONTEXT.setValue(key, 1);
    const second = ROOT_CONTEXT.setValue(key, 2);
    const active = vi.spyOn(context, "active").mockReturnValue(ROOT_CONTEXT);
    const provider = withProviderTracing(fakeProvider(), { tracer });
    active.mockReturnValue(first);
    const a = read(provider);
    active.mockReturnValue(second);
    const b = read(provider);
    active.mockReturnValue(ROOT_CONTEXT);
    await b.next();
    await a.next();
    expect(recorded(tracer, 0).parent).toBe(second);
    expect(recorded(tracer, 1).parent).toBe(first);
    await a.return?.();
    expect(recorded(tracer, 0).endCount).toBe(0);
    expect(recorded(tracer, 1).endCount).toBe(1);
    await b.return?.();
  });

  it("keeps live registry getters after update", async () => {
    const tracer = new RecordingTracer();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const registry = createRegistry({
      connections: { chat: { preset: "google", apiKey: "secret", model: "before", fetchImpl } },
    });
    const view = registry.get("chat");
    const provider = withProviderTracing(view, { tracer });
    registry.update("chat", { preset: "google", apiKey: "secret", model: "after", fetchImpl });
    expect(provider.id).toBe(view.id);
    expect(provider.model).toBe("after");
    await collectTurn(provider.createStream([], []));
    expect(recorded(tracer).name).toBe("chat after");
    expect(recorded(tracer).attributes["gen_ai.provider.name"]).toBe("gcp.gemini");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps requested identity separate from selected source and waits past finish for usage", async () => {
    const tracer = new RecordingTracer();
    const firstUsage = { ...counts, reasoningTokens: 2, cacheWriteTokens: 1, reportedCostUsd: 5 };
    const finalUsage = { ...counts, inputTokens: 20, outputTokens: 8, reportedCostUsd: 0 };
    const chunks: ProviderChunk[] = [
      { ...delta, source: { provider: "openrouter", model: "configured-alias" } },
      { type: "usage", usage: firstUsage },
      finish,
      { type: "usage", usage: finalUsage },
    ];
    const provider = withProviderTracing(fakeProvider(chunks), { tracer, providerName: "gateway" });
    const iterator = read(provider, { model: "override" });
    for (const chunk of chunks) {
      expect((await iterator.next()).value).toBe(chunk);
      expect(recorded(tracer).endCount).toBe(0);
    }
    await iterator.next();
    expect(recorded(tracer).attributes).toMatchObject({
      "gen_ai.request.model": "override",
      "gen_ai.provider.name": "gateway",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.stream": true,
      "providerkit.response.provider": "openrouter",
      "providerkit.response.model": "configured-alias",
      "gen_ai.usage.input_tokens": 20,
      "gen_ai.usage.output_tokens": 8,
      "gen_ai.usage.cache_read.input_tokens": 3,
      "providerkit.usage.reported_cost_usd": 0,
      "gen_ai.response.finish_reasons": ["stop"],
      "providerkit.stream.outcome": "completed",
    });
    expect(recorded(tracer).attributes).not.toHaveProperty("gen_ai.response.model");
    expect(recorded(tracer).attributes).not.toHaveProperty("gen_ai.usage.reasoning.output_tokens");
    expect(recorded(tracer).attributes).not.toHaveProperty("gen_ai.usage.cache_write.input_tokens");
    expect(provider.model).toBe("requested");
  });

  it.each([
    [undefined, {}],
    [
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      {
        "gen_ai.usage.input_tokens": 0,
        "gen_ai.usage.output_tokens": 0,
        "gen_ai.usage.cache_read.input_tokens": 0,
      },
    ],
    [
      { ...counts, cacheWriteTokens: 2, reasoningTokens: 1 },
      {
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 4,
        "gen_ai.usage.cache_read.input_tokens": 3,
        "gen_ai.usage.cache_write.input_tokens": 2,
        "gen_ai.usage.reasoning.output_tokens": 1,
      },
    ],
    [{ inputTokens: NaN, outputTokens: -1, cachedInputTokens: Infinity, reportedCostUsd: -1 }, {}],
  ] satisfies [TokenUsage | undefined, Attributes][])(
    "keeps absent, zero and invalid counts distinct: %j",
    async (usage, expected) => {
      const tracer = new RecordingTracer();
      await collectTurn(
        withProviderTracing(fakeProvider([{ type: "usage", usage }]), { tracer }).createStream(
          [],
          [],
        ),
      );
      const attributes = Object.fromEntries(
        Object.entries(recorded(tracer).attributes).filter(([key]) => key.includes("usage.")),
      );
      expect(attributes).toEqual(expected);
    },
  );

  it("keeps partial usage and classified errors without retaining private content", async () => {
    const tracer = new RecordingTracer();
    const secret = "private-prompt-key-session-url-body";
    const error = new ProviderError("secret-error-provider", "quota", secret, {
      status: 429,
      body: secret,
      code: secret,
      cause: new Error(secret),
      retryAfterMs: 200,
      window: "weekly",
    });
    const chunks: ProviderChunk[] = [
      {
        type: "delta",
        content: secret,
        reasoning: secret,
        toolCalls: [{ index: 0, arguments: secret, name: secret, id: secret }],
        hostedItems: { provider: secret, items: [{ secret }] },
        reasoningItems: { provider: secret, items: [secret] },
      },
      { type: "usage", usage: counts },
    ];
    const provider = withProviderTracing(fakeProvider(chunks, error), { tracer });
    const messages: ChatMessage[] = [{ role: "user", content: secret }];
    await expect(
      collectTurn(
        provider.createStream(
          messages,
          [{ name: secret, description: secret, inputSchema: { type: "object" } }],
          { sessionId: secret },
        ),
      ),
    ).rejects.toBe(error);
    const span = recorded(tracer);
    expect(span.attributes).toMatchObject({
      "error.type": "quota",
      "http.response.status_code": 429,
      "providerkit.rate_limit.retry_after_ms": 200,
      "providerkit.rate_limit.window": "weekly",
      "gen_ai.usage.input_tokens": 10,
      "providerkit.stream.outcome": "error",
    });
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(
      JSON.stringify({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      }),
    ).not.toContain(secret);
    expect(span.events).toEqual([]);
    expect(span.endCount).toBe(1);
  });

  it("only exports known error and finish enums", async () => {
    const tracer = new RecordingTracer();
    const error = new ProviderError("custom", "unknown", "secret");
    Object.defineProperty(error, "kind", { value: "private-kind" });
    const chunk: ProviderChunk = { type: "finish" };
    Object.defineProperty(chunk, "finishReason", { value: "private-finish" });
    await expect(
      collectTurn(
        withProviderTracing(fakeProvider([chunk], error), { tracer }).createStream([], []),
      ),
    ).rejects.toBe(error);
    expect(recorded(tracer).attributes["error.type"]).toBe("unknown");
    expect(JSON.stringify(recorded(tracer).attributes)).not.toContain("private-");
  });

  it("forwards all next/return/throw arguments and done:false cleanup results", async () => {
    const tracer = new RecordingTracer();
    const results: IteratorResult<ProviderChunk, unknown>[] = [
      { value: delta, done: false },
      { value: { type: "usage", usage: counts }, done: false },
      { value: finish, done: false },
      { value: "finished", done: true },
    ];
    const source = {
      next: vi.fn().mockResolvedValueOnce(results[0]).mockResolvedValueOnce(results[3]),
      return: vi.fn().mockResolvedValue(results[1]),
      throw: vi.fn().mockResolvedValue(results[2]),
    };
    const iterator = read(withProviderTracing(fromIterator(source), { tracer }));
    expect(await iterator.next("input")).toBe(results[0]);
    const returned = Promise.resolve("return-value");
    expect(await iterator.return?.(returned)).toBe(results[1]);
    const thrown = { reason: "injected" };
    expect(await iterator.throw?.(thrown)).toBe(results[2]);
    expect(recorded(tracer).endCount).toBe(0);
    expect(await iterator.next()).toBe(results[3]);
    expect(source.next.mock.calls).toEqual([["input"], []]);
    expect(source.return.mock.calls).toEqual([[returned]]);
    expect(source.throw.mock.calls).toEqual([[thrown]]);
    expect(source.next.mock.contexts).toEqual([source, source]);
    expect(source.return.mock.contexts).toEqual([source]);
    expect(recorded(tracer).endCount).toBe(1);
    expect(recorded(tracer).attributes["gen_ai.usage.input_tokens"]).toBe(10);
  });

  it.each(["done", "yielded", "rejected"] as const)(
    "matches yield* cleanup when throw is missing (%s)",
    async (cleanup) => {
      const injected = new Error("injected failure");
      const cleanupFailure = new Error("cleanup failure");
      for (const traced of [false, true]) {
        const tracer = new RecordingTracer();
        const source = {
          next: vi.fn().mockResolvedValue({ done: false, value: delta }),
          return: vi.fn(async () => {
            await Promise.resolve();
            if (cleanup === "rejected") throw cleanupFailure;
            return { done: cleanup === "done", value: delta };
          }),
        };
        const provider = fromIterator(source);
        const selected = traced ? withProviderTracing(provider, { tracer }) : provider;
        const stream = selected.createStream([], []);
        async function* delegate() {
          yield* stream;
        }
        const iterator = delegate();
        if (traced) expect(provider.createStream).not.toHaveBeenCalled();
        expect(source.next).not.toHaveBeenCalled();
        expect(tracer.spans).toHaveLength(0);
        expect((await iterator.next()).value).toBe(delta);
        const failure = expect(iterator.throw(injected)).rejects;
        if (cleanup === "rejected") await failure.toBe(cleanupFailure);
        else await failure.toBeInstanceOf(TypeError);
        expect(source.return.mock.calls).toEqual([[]]);
        expect(source.return.mock.contexts).toEqual([source]);
        expect(source.next).toHaveBeenCalledTimes(1);
        expect(provider.createStream).toHaveBeenCalledTimes(1);
        expect((await iterator.next()).done).toBe(true);
        expect(source.return).toHaveBeenCalledTimes(1);
        if (traced) expect(recorded(tracer).endCount).toBe(1);
      }
    },
  );

  it.each(["return", "throw"] as const)(
    "ends on %s termination and keeps its exact rejection",
    async (method) => {
      const tracer = new RecordingTracer();
      const failure = { secret: "unchanged" };
      const source = {
        next: vi.fn().mockResolvedValue({ done: false, value: delta }),
        [method]: vi.fn().mockRejectedValue(failure),
      };
      const iterator = read(withProviderTracing(fromIterator(source), { tracer }));
      await iterator.next();
      await expect(iterator[method]?.(failure)).rejects.toBe(failure);
      expect(recorded(tracer).endCount).toBe(1);
      await iterator[method]?.().catch(() => {});
      expect(recorded(tracer).endCount).toBe(1);
    },
  );

  it("does not start a span for return before a read or restart one after completion", async () => {
    const tracer = new RecordingTracer();
    const provider = withProviderTracing(fakeProvider(), { tracer });
    const unread = read(provider);
    await unread.return?.("bye");
    await unread.next();
    expect(tracer.spans).toHaveLength(0);
    const iterator = read(provider);
    await iterator.next();
    await iterator.return?.();
    await iterator.next();
    expect(tracer.spans).toHaveLength(1);
    expect(recorded(tracer).endCount).toBe(1);
    expect(recorded(tracer).attributes["providerkit.stream.outcome"]).toBe("closed");
  });

  it.each([false, true])(
    "observes caller abort without pulling or closing (already aborted: %s)",
    async (alreadyAborted) => {
      const tracer = new RecordingTracer();
      const controller = new AbortController();
      const reason = { private: "caller stop" };
      if (alreadyAborted) controller.abort(reason);
      const source = {
        next: vi.fn().mockResolvedValue({ value: { type: "usage", usage: counts }, done: false }),
        return: vi.fn(),
      };
      const provider = fromIterator(source);
      const iterator = read(withProviderTracing(provider, { tracer }), {
        signal: controller.signal,
      });
      expect(tracer.spans).toHaveLength(0);
      await iterator.next();
      controller.abort(reason);
      expect(source.next).toHaveBeenCalledTimes(1);
      expect(source.return).not.toHaveBeenCalled();
      expect(provider.createStream).toHaveBeenCalledWith(
        [],
        [],
        expect.objectContaining({ signal: controller.signal }),
      );
      expect(recorded(tracer).endCount).toBe(1);
      expect(recorded(tracer).attributes["providerkit.stream.outcome"]).toBe("cancelled");
      expect(recorded(tracer).status.code).toBe(SpanStatusCode.UNSET);
      expect(recorded(tracer).attributes["gen_ai.usage.input_tokens"]).toBe(
        alreadyAborted ? undefined : 10,
      );
      await iterator.next();
      expect(recorded(tracer).endCount).toBe(1);
    },
  );

  it("composes outside a gate and watchdog without changing abort or timeout", async () => {
    vi.useFakeTimers();
    const tracer = new RecordingTracer();
    const gate = createGate(1);
    const source: Provider = {
      ...fakeProvider(),
      async *createStream(_messages, _tools, opts) {
        yield delta;
        opts?.signal?.throwIfAborted();
        yield finish;
      },
    };
    const provider = withProviderTracing(
      withGate(withWatchdog(source, { idleMs: 10, progressMs: 20, requireContent: false }), gate),
      { tracer },
    );
    const controller = new AbortController();
    const held = read(provider, { signal: controller.signal });
    await held.next();
    const queued = read(provider);
    const pending = queued.next();
    expect(gate.waiting).toBe(1);
    controller.abort();
    await pending;
    expect(recorded(tracer, 0).attributes["providerkit.stream.outcome"]).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(25);
    // The watchdog cannot be observed while the consumer holds a chunk.
    expect(recorded(tracer, 1).endCount).toBe(0);
    await expect(queued.next()).rejects.toMatchObject({ kind: "timeout" });
    expect(recorded(tracer, 1).attributes["error.type"]).toBe("timeout");
    expect(gate.held).toBe(0);
    await held.return?.();
  });

  it("does not invent an end for a stream the consumer abandons", async () => {
    vi.useFakeTimers();
    const tracer = new RecordingTracer();
    const iterator = read(withProviderTracing(fakeProvider(), { tracer }));
    await iterator.next();
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(recorded(tracer).endCount).toBe(0);
    await iterator.return?.();
  });

  it("composes activity/rate callbacks, records private boundary timing, and preserves all options", async () => {
    const tracer = new RecordingTracer();
    const onActivity = vi.fn();
    const onRateLimit = vi.fn();
    const reading = { utilization: 0.7, resetAtMs: 1000, window: "5h" as const };
    const provider: Provider = {
      id: "openrouter",
      model: "claude-alias",
      async *createStream(_messages, _tools, opts) {
        expect(opts).toMatchObject({
          onActivity: expect.any(Function),
          onRateLimit: expect.any(Function),
          sessionId: "private",
          maxAttempts: 1,
        });
        opts?.onActivity?.();
        opts?.onActivity?.();
        opts?.onRateLimit?.(reading);
        yield delta;
      },
    };
    await collectTurn(
      withProviderTracing(provider, { tracer }).createStream([], [], {
        onActivity,
        onRateLimit,
        sessionId: "private",
        maxAttempts: 1,
      }),
    );
    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(onRateLimit).toHaveBeenCalledExactlyOnceWith(reading);
    expect(recorded(tracer).attributes).toMatchObject({
      "providerkit.stream.first_activity_seconds": expect.any(Number),
      "providerkit.stream.first_chunk_seconds": expect.any(Number),
      "providerkit.rate_limit.utilization": 0.7,
      "providerkit.rate_limit.window": "5h",
      "gen_ai.provider.name": "openrouter",
    });
    expect(recorded(tracer).attributes).not.toHaveProperty("gen_ai.response.time_to_first_chunk");
  });

  it.each(["onActivity", "onRateLimit"] as const)(
    "does not swallow an existing %s exception",
    async (callback) => {
      const failure = new Error("caller callback");
      const provider: Provider = {
        id: "custom",
        model: "model",
        createStream(_messages, _tools, opts) {
          opts?.onActivity?.();
          opts?.onRateLimit?.({ utilization: 0, resetAtMs: 0 });
          return fakeProvider().createStream([], []);
        },
      };
      await expect(
        read(withProviderTracing(provider, { tracer: new RecordingTracer() }), {
          [callback]: () => {
            throw failure;
          },
        }).next(),
      ).rejects.toBe(failure);
    },
  );

  it.each(["before", "after", "twice"])(
    "never replays an operation when context.with fails %s its callback",
    async (mode) => {
      const tracer = new RecordingTracer();
      vi.spyOn(context, "with").mockImplementation((_scope, callback, thisArg, ...args) => {
        if (mode === "before") throw new Error("context failure");
        callback.apply(thisArg, args);
        if (mode === "twice") callback.apply(thisArg, args);
        throw new Error("context failure");
      });
      const failure = { exact: "provider failure" };
      const source = {
        next: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: delta })
          .mockRejectedValue(failure),
      };
      const provider = fromIterator(source);
      const iterator = read(withProviderTracing(provider, { tracer }));
      expect((await iterator.next()).value).toBe(delta);
      await expect(iterator.next()).rejects.toBe(failure);
      expect(source.next).toHaveBeenCalledTimes(2);
      expect(provider.createStream).toHaveBeenCalledTimes(1);
      expect(recorded(tracer).endCount).toBe(1);
    },
  );

  it.each(["provider", "instrumentation"] as const)(
    "handles a context manager's derived promise when %s rejects",
    async (failureSource) => {
      const tracer = new RecordingTracer();
      const providerFailure = new Error("provider failure");
      const instrumentationFailure = new Error("instrumentation failure");
      const result: IteratorResult<ProviderChunk> = { done: false, value: delta };
      const source = {
        next: vi.fn(async () => {
          if (failureSource === "provider") throw providerFailure;
          return result;
        }),
      };
      const cleanup = vi.fn(() => {
        if (failureSource === "instrumentation") throw instrumentationFailure;
      });
      vi.spyOn(context, "with").mockImplementation((_scope, callback, thisArg, ...args) =>
        Promise.resolve(callback.apply(thisArg, args)).finally(cleanup),
      );
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const provider = fromIterator(source);
        const iterator = read(withProviderTracing(provider, { tracer }));
        if (failureSource === "provider")
          await expect(iterator.next()).rejects.toBe(providerFailure);
        else expect(await iterator.next()).toBe(result);
        // Let Node report any rejection on the manager's separate promise.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(source.next).toHaveBeenCalledTimes(1);
        expect(provider.createStream).toHaveBeenCalledTimes(1);
        expect(recorded(tracer).endCount).toBe(failureSource === "provider" ? 1 : 0);
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    },
  );

  it("preserves synchronous dispatch errors even if context.with catches them", async () => {
    vi.spyOn(context, "with").mockImplementation((_scope, callback, thisArg, ...args) => {
      try {
        callback.apply(thisArg, args);
      } catch {
        /* faulty manager suppresses it */
      }
      throw new Error("different context error");
    });
    const error = { exact: "dispatch failure" };
    const provider: Provider = {
      id: "custom",
      model: "model",
      createStream: vi.fn(() => {
        throw error;
      }),
    };
    const iterator = read(withProviderTracing(provider, { tracer: new RecordingTracer() }));
    await expect(iterator.next()).rejects.toBe(error);
    await expect(iterator.next()).rejects.toBe(error);
    expect(provider.createStream).toHaveBeenCalledTimes(1);
  });

  it.each([
    "active",
    "getTracer",
    "setSpan",
    "startSpan",
    "setAttribute",
    "setAttributes",
    "setStatus",
    "end",
  ] as const)("ignores throwing instrumentation: %s", async (method) => {
    const tracer = new RecordingTracer();
    const broken = () => {
      throw new Error("instrumentation failure");
    };
    if (method === "active") vi.spyOn(context, method).mockImplementation(broken);
    else if (method === "getTracer" || method === "setSpan")
      vi.spyOn(trace, method).mockImplementation(broken);
    else if (method === "startSpan") vi.spyOn(tracer, method).mockImplementation(broken);
    else vi.spyOn(RecordingSpan.prototype, method).mockImplementation(broken);
    const failure = new ProviderError("custom", "timeout", "private");
    const provider = fakeProvider([delta, { type: "usage", usage: counts }], failure);
    const iterator = read(withProviderTracing(provider, method === "getTracer" ? {} : { tracer }));
    expect((await iterator.next()).value).toBe(delta);
    await iterator.next();
    await expect(iterator.next()).rejects.toBe(failure);
    expect(provider.createStream).toHaveBeenCalledTimes(1);
  });

  it("ignores throwing metadata getters", async () => {
    const tracer = new RecordingTracer();
    const chunk: ProviderChunk = { type: "usage" };
    Object.defineProperty(chunk, "usage", {
      get() {
        throw new Error("bad metadata");
      },
    });
    const provider = fakeProvider([chunk]);
    Object.defineProperty(provider, "model", {
      get() {
        throw new Error("bad model getter");
      },
    });
    const iterator = read(withProviderTracing(provider, { tracer }));
    expect((await iterator.next()).value).toBe(chunk);
    expect((await iterator.next()).done).toBe(true);
    expect(recorded(tracer).endCount).toBe(1);
  });

  it("rebinds owned final wrappers without duplicates, including overlapping explicit parents", async () => {
    const original = new RecordingTracer();
    const rebound = new RecordingTracer();
    const provider = fakeProvider();
    const startup = withProviderTracing(withProviderTracing(provider, { tracer: original }), {
      tracer: original,
    });
    const key = createContextKey("run");
    const parentA = ROOT_CONTEXT.setValue(key, "a");
    const parentB = ROOT_CONTEXT.setValue(key, "b");
    const a = read(withProviderTracing(startup, { tracer: rebound, parentContext: parentA }));
    const b = read(withProviderTracing(startup, { tracer: rebound, parentContext: parentB }));
    const scopes: Context[] = [];
    vi.spyOn(context, "with").mockImplementation((scope, callback, thisArg, ...args) => {
      scopes.push(scope);
      return callback.apply(thisArg, args);
    });
    await a.next();
    await b.next();
    await b.return?.();
    await a.return?.();
    expect(original.spans).toHaveLength(0);
    expect(rebound.spans).toHaveLength(2);
    expect(recorded(rebound, 0).parent).toBe(parentA);
    expect(recorded(rebound, 1).parent).toBe(parentB);
    expect(scopes.map((scope) => trace.getSpan(scope))).toEqual([
      recorded(rebound, 0),
      recorded(rebound, 1),
      recorded(rebound, 1),
      recorded(rebound, 0),
    ]);
    expect(provider.createStream).toHaveBeenCalledTimes(2);
  });

  it("works with the API alone and no registered SDK or context manager", async () => {
    expect(
      (await collectTurn(withProviderTracing(fakeProvider()).createStream([], []))).message.content,
    ).toBe("hello");
  });

  it("keeps ordinary imports telemetry-free and opts in on browser and Node without an exporter", () => {
    const cache = join(homedir(), ".cache", "providerkit", "core-otel");
    mkdirSync(cache, { recursive: true });
    const directory = mkdtempSync(join(cache, "boundary-"));
    try {
      const fixture = fileURLToPath(new URL("./fixtures/chat-consumer.ts", import.meta.url));
      execFileSync(
        "bun",
        [
          "build",
          "--minify",
          "--target=browser",
          "--sourcemap=external",
          fixture,
          `--outdir=${directory}`,
        ],
        { stdio: "pipe" },
      );
      const output = join(directory, "chat-consumer.js");
      const map: { sources: string[] } = JSON.parse(readFileSync(`${output}.map`, "utf8"));
      expect(map.sources.filter((source) => /\/otel\.ts$|@opentelemetry/.test(source))).toEqual([]);
      // Paired Bun 1.4.4 baseline at fc0a1d3. Zero telemetry growth, not a size allowance.
      expect(statSync(output).size).toBe(84_369);
      const opted = join(directory, "opted.ts");
      const otel = fileURLToPath(new URL("../src/otel.ts", import.meta.url));
      writeFileSync(
        opted,
        `import { withProviderTracing } from ${JSON.stringify(otel)};
const provider = withProviderTracing({ id: "custom", model: "model", async *createStream() { yield { type: "delta", content: "ok" }; } });
for await (const chunk of provider.createStream([], [])) { if (chunk.content !== "ok") throw new Error("changed chunk"); }
`,
      );
      for (const target of ["browser", "node"]) {
        const outfile = join(directory, target, "opted.js");
        execFileSync(
          "bun",
          [
            "build",
            "--minify",
            `--target=${target}`,
            "--sourcemap=external",
            opted,
            `--outdir=${join(directory, target)}`,
          ],
          { stdio: "pipe" },
        );
        const optedMap: { sources: string[] } = JSON.parse(readFileSync(`${outfile}.map`, "utf8"));
        expect(optedMap.sources.some((source) => source.endsWith("/otel.ts"))).toBe(true);
        expect(optedMap.sources.some((source) => source.includes("@opentelemetry"))).toBe(true);
        expect(optedMap.sources.join("\n")).not.toMatch(
          /context-async-hooks|sdk-trace|exporter|node:/,
        );
        expect(readFileSync(outfile, "utf8")).not.toMatch(/\bimport\s*\(/);
        execFileSync("node", [outfile], { stdio: "pipe" });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
