import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
  type AttributeValue,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type Tracer,
} from "@opentelemetry/api";
import {
  defineTool,
  type Provider,
  type ProviderChunk,
  type TokenUsage,
  type Turn,
} from "@providerkit/core";
import { defineAgent } from "../src/run.ts";
import { defineHandoff } from "../src/handoff.ts";
import { questionTool } from "../src/request.ts";
import { createAgentTracing, type AgentTracing } from "../src/otel.ts";
import type { LifecycleContext, RunSnapshot, ToolRequest } from "../src/types.ts";
import { assertAgent } from "./fixtures/assertions.ts";

// A public-API fake, not a second OTel SDK or exporter dependency.
class RecordedSpan implements Span {
  attributes: Attributes;
  status: SpanStatus = { code: SpanStatusCode.UNSET };
  ends = 0;
  exceptions = 0;
  events = 0;
  constructor(
    readonly name: string,
    readonly identity: SpanContext,
    readonly parent: SpanContext | undefined,
    readonly options: SpanOptions,
    private readonly failure?: "attributes" | "status" | "end",
  ) {
    this.attributes = { ...options.attributes };
  }
  spanContext() {
    return this.identity;
  }
  setAttribute(key: string, value: AttributeValue) {
    return this.setAttributes({ [key]: value });
  }
  setAttributes(attributes: Attributes) {
    if (this.failure === "attributes") throw new Error("private-exporter-key");
    Object.assign(this.attributes, attributes);
    return this;
  }
  setStatus(status: SpanStatus) {
    if (this.failure === "status") throw new Error("private-exporter-key");
    this.status = status;
    return this;
  }
  addEvent() {
    this.events++;
    return this;
  }
  addLink() {
    return this;
  }
  addLinks() {
    return this;
  }
  updateName() {
    return this;
  }
  isRecording() {
    return this.ends === 0;
  }
  recordException() {
    this.exceptions++;
  }
  end() {
    this.ends++;
    if (this.failure === "end") throw new Error("private-exporter-key");
  }
}
class RecordingTracer implements Tracer {
  readonly spans: RecordedSpan[] = [];
  onStart?: (span: RecordedSpan) => void;
  constructor(private readonly failure?: "start" | "attributes" | "status" | "end") {}
  startSpan(name: string, options: SpanOptions = {}, context = ROOT_CONTEXT): Span {
    if (this.failure === "start") throw new Error("private-exporter-key");
    const parent = trace.getSpanContext(context);
    const span = new RecordedSpan(
      name,
      {
        traceId: parent?.traceId ?? "1".repeat(32),
        spanId: (this.spans.length + 1).toString(16).padStart(16, "0"),
        traceFlags: TraceFlags.SAMPLED,
      },
      parent,
      options,
      this.failure,
    );
    this.spans.push(span);
    this.onStart?.(span);
    return span;
  }
  startActiveSpan(): never {
    throw new Error("Observer cannot activate execution context");
  }
  of(kind: string) {
    return this.spans.filter((span) => span.attributes["providerkit.span.kind"] === kind);
  }
}

const usage: TokenUsage = {
  inputTokens: 5,
  outputTokens: 3,
  cachedInputTokens: 1,
  reportedCostUsd: 0.002,
};
const zero: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
const base = { id: "reader", version: "1", instructions: "private-instructions" };
function text(content = "private-output", reported: TokenUsage | null = usage): ProviderChunk[] {
  return [
    { type: "delta", content, reasoning: "private-reasoning" },
    ...(reported ? [{ type: "usage" as const, usage: reported }] : []),
    { type: "finish", finishReason: "stop" },
  ];
}
function call(name: string, args: Record<string, unknown> = {}): ProviderChunk[] {
  return [
    { type: "delta", toolCalls: [{ index: 0, id: "call", name, arguments: JSON.stringify(args) }] },
    { type: "finish", finishReason: "tool_calls" },
  ];
}
function fake(turns: ProviderChunk[][]): Provider {
  let index = 0;
  return {
    id: "offline",
    model: "private-model",
    async *createStream() {
      const next = turns[index++];
      if (!next) throw new Error("Unexpected model call");
      yield* next;
    },
  };
}
function context(
  runId = "run",
  attemptId = "attempt",
  signal = new AbortController().signal,
): LifecycleContext {
  return {
    agentId: "reader",
    version: "1",
    runId,
    attemptId,
    signal,
    context: { credential: "private-context" },
  };
}
function request(
  ctx: LifecycleContext,
  attemptId = ctx.attemptId,
  operationId = "tool",
): ToolRequest {
  return {
    agentId: ctx.agentId,
    version: ctx.version,
    runId: ctx.runId,
    attemptId,
    operationId,
    call: { id: "call", name: "private-tool", arguments: '{"value":"private-arguments"}' },
    arguments: { value: "private-arguments" },
  };
}
function turn(reported: TokenUsage = usage): Turn {
  return {
    message: { role: "assistant", content: "private-output", reasoning: "private-reasoning" },
    usage: reported,
    finishReason: "stop",
  };
}
function modelStart(operationId = "model", attemptId = "attempt") {
  return {
    type: "model_start" as const,
    operationId,
    attemptId,
    input: { messages: [], tools: [], settings: {} },
  };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a recorded value");
  return value;
}
const observers: AgentTracing[] = [];
function setup(options: Parameters<typeof createAgentTracing>[0] = {}) {
  const tracer = options.tracer instanceof RecordingTracer ? options.tracer : new RecordingTracer();
  const tracing = createAgentTracing({ tracer, ...options });
  observers.push(tracing);
  return { tracer, tracing };
}
afterEach(() => {
  for (const observer of observers.splice(0)) observer.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OpenTelemetry observer", () => {
  it("parents actual run, model, tool, specialist and handoff spans explicitly without wrapping Agents", async () => {
    const external: SpanContext = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: TraceFlags.SAMPLED,
    };
    const { tracer, tracing } = setup({
      parentContext: trace.setSpanContext(ROOT_CONTEXT, external),
    });
    const specialist = defineAgent({ ...base, id: "specialist", provider: fake([text()]) });
    const target = defineAgent({ ...base, id: "target", provider: fake([text()]) });
    const agent = defineAgent({
      ...base,
      provider: fake([
        call("review", { input: "private-child-input" }),
        call("transfer", { note: "private-handoff-note" }),
      ]),
      tools: [
        specialist.asTool({ name: "review", description: "Review" }),
        defineHandoff({ name: "transfer", description: "Transfer", to: target }),
      ],
    });
    const outcome = await agent.run("private-prompt", tracing.options());
    expect(outcome.status).toBe("completed");
    const runs = tracer.of("run");
    expect(runs).toHaveLength(3);
    expect(runs[0]?.parent).toEqual(external);
    expect(tracer.of("child")).toHaveLength(1);
    expect(tracer.of("handoff")).toHaveLength(1);
    for (const kind of ["child", "handoff"]) {
      const relation = required(tracer.of(kind)[0]);
      const parentTool = required(
        tracer.spans.find((span) => span.identity.spanId === relation.parent?.spanId),
      );
      expect(parentTool.attributes["providerkit.span.kind"]).toBe("tool");
      const child = required(runs.find((span) => span.parent?.spanId === relation.identity.spanId));
      expect(child.attributes["providerkit.run.id"]).toBe(
        relation.attributes["providerkit.child.run.id"],
      );
    }
    for (const model of tracer.of("model")) {
      expect(runs.some((run) => run.identity.spanId === model.parent?.spanId)).toBe(true);
      expect(model.attributes["providerkit.outcome"]).toBe("returned");
    }
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    expect(tracer.spans.every((span) => span.identity.traceId === external.traceId)).toBe(true);
  });

  it("composes observers, preserves host authority and captures the actual context API", async () => {
    const external = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "c".repeat(32),
      spanId: "d".repeat(16),
      traceFlags: 1,
    });
    const active = vi
      .spyOn((await import("@opentelemetry/api")).context, "active")
      .mockReturnValue(external);
    const { tracer, tracing } = setup();
    const lifecycle = vi.fn(async () => {
      throw new Error("private-observer");
    });
    const events = vi.fn(() => {
      throw new Error("private-observer");
    });
    const beforeTool = vi.fn(() => {
      throw new Error("private-host-refusal");
    });
    const effect = vi.fn(async () => "private-result");
    const host = { beforeTool };
    const options = tracing.options({ host, onLifecycle: lifecycle, onEvent: events });
    expect(options.host).toBe(host);
    active.mockReturnValue(ROOT_CONTEXT);
    const agent = defineAgent({
      ...base,
      provider: fake([call("write")]),
      tools: [
        defineTool({
          name: "write",
          description: "Write",
          inputSchema: { type: "object" },
          run: effect,
        }),
      ],
    });
    const result = await agent.run("private-prompt", options);
    expect(result.status).toBe("failed");
    expect(effect).not.toHaveBeenCalled();
    expect(beforeTool).toHaveBeenCalled();
    expect(lifecycle).toHaveBeenCalled();
    expect(events).toHaveBeenCalled();
    expect(tracer.of("run")[0]?.parent).toEqual(trace.getSpanContext(external));
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
  });

  it("ends model spans on return before a guard rejects the content", async () => {
    const { tracer, tracing } = setup();
    const guard = vi.fn(() => {
      expect(tracer.of("model")[0]?.ends).toBe(1);
      expect(tracer.of("model")[0]?.status.code).toBe(SpanStatusCode.OK);
      return { allow: false };
    });
    const result = await defineAgent({
      ...base,
      provider: fake([text()]),
      guardrails: { identity: "reject", modelOutput: guard },
    }).run("private-prompt", tracing.options());
    expect(result.status).toBe("failed");
    expect(guard).toHaveBeenCalledOnce();
    expect(tracer.of("run")[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(tracer.of("model")[0]?.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 5,
      "gen_ai.usage.output_tokens": 3,
      "providerkit.usage.reported_cost_usd": 0.002,
    });
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
  });

  it("keeps a tool retry's operation attempt separate from its run and siblings", async () => {
    const { tracer, tracing } = setup();
    let calls = 0;
    const read = defineTool({
      name: "read",
      description: "Read",
      inputSchema: { type: "object" },
      isReadOnly: true,
      run: async () => {
        if (++calls === 1) throw new Error("private-failure");
        return "private-result";
      },
    });
    const result = await defineAgent({
      ...base,
      provider: fake([call("read"), text()]),
      tools: [read],
      toolRetries: {
        identity: "retry-read",
        tools: { read: { maxAttempts: 2, replay: "read-only" } },
      },
    }).run("Read", tracing.options({ host: { beforeTool() {} } }));
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    expect(tracer.of("run")).toHaveLength(1);
    const tools = tracer.of("tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]?.attributes["providerkit.operation.id"]).toBe(
      tools[1]?.attributes["providerkit.operation.id"],
    );
    expect(tools[0]?.attributes["providerkit.operation.attempt.id"]).not.toBe(
      tools[1]?.attributes["providerkit.operation.attempt.id"],
    );
    for (const span of [...tools, ...tracer.of("model")]) {
      expect(span.attributes["providerkit.run.attempt.id"]).toBe(result.attemptId);
      expect(span.parent?.spanId).toBe(tracer.of("run")[0]?.identity.spanId);
    }
    expect(tools.map((span) => span.status.code)).toEqual([
      SpanStatusCode.ERROR,
      SpanStatusCode.OK,
    ]);
  });

  it("gives recovered inference a new run/operation attempt and never traces cached completion", async () => {
    const { tracer, tracing } = setup();
    let saved: RunSnapshot | undefined;
    const agent = defineAgent({
      ...base,
      provider: fake([text(), text()]),
      recovery: { identity: "inference", maxAttempts: 2, inferenceOnly: true },
    });
    const first = await agent.run(
      "Read",
      tracing.options({
        host: {
          checkpoint(snapshot) {
            assertAgent(snapshot);
            if (snapshot.models[0]?.status === "running") saved = structuredClone(snapshot);
          },
        },
      }),
    );
    const resumed = await agent.resume(
      required(saved),
      tracing.options({ host: { authorizeResume() {} } }),
    );
    expect(resumed.status).toBe("completed");
    expect(tracer.of("run")).toHaveLength(2);
    const models = tracer.of("model");
    expect(models).toHaveLength(2);
    expect(models[0]?.attributes["providerkit.operation.id"]).toBe(
      models[1]?.attributes["providerkit.operation.id"],
    );
    expect(first.attemptId).not.toBe(resumed.attemptId);
    expect(models.map((span) => span.attributes["providerkit.operation.attempt.id"])).toEqual([
      first.attemptId,
      resumed.attemptId,
    ]);
    const count = tracer.spans.length;
    await agent.resume(resumed.snapshot, tracing.options({ host: { authorizeResume() {} } }));
    expect(tracer.spans).toHaveLength(count);
  });

  it("closes a suspended tool observation and opens a new attempt on resume", async () => {
    const { tracer, tracing } = setup();
    const agent = defineAgent({
      ...base,
      provider: fake([call("ask", { message: "private-question" }), text()]),
      tools: [questionTool({ name: "ask" })],
    });
    const host = {
      prepareRequest: () => ({
        scope: {
          actorId: "private-actor",
          resource: { id: "private-resource", version: "1" },
          expiresAt: Date.now() + 60_000,
        },
      }),
    };
    const waiting = await agent.run("Read", tracing.options({ host }));
    expect(waiting.status).toBe("suspended");
    if (waiting.status !== "suspended") throw new Error("Expected a question");
    expect(tracer.of("tool")[0]?.attributes["providerkit.outcome"]).toBe("incomplete");
    expect(tracer.of("run")[0]?.attributes["providerkit.outcome"]).toBe("suspended");
    const resumed = await agent.resume(
      waiting.snapshot,
      tracing.options({
        answers: { [required(waiting.requests[0]).id]: "proof" },
        host: {
          ...host,
          authorizeResume() {},
          beforeTool() {},
          resolveRequest: () => ({ type: "answer" as const, answer: { text: "private-answer" } }),
        },
      }),
    );
    expect(resumed.status).toBe("completed");
    expect(tracer.of("run")).toHaveLength(2);
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
  });

  it("closes on abort even when the SDK skips end hooks and removes signal listeners", async () => {
    const { tracer, tracing } = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const abort = new AbortController();
    let remove: ReturnType<typeof vi.spyOn> | undefined;
    const agent = defineAgent({
      ...base,
      provider: {
        id: "fake",
        model: "offline",
        async *createStream() {
          entered.resolve();
          await release.promise;
          yield* text();
        },
      },
    });
    const result = agent.run(
      "Read",
      tracing.options({
        signal: abort.signal,
        onLifecycle(event, ctx) {
          if (event.type === "run_start") remove = vi.spyOn(ctx.signal, "removeEventListener");
        },
      }),
    );
    await entered.promise;
    abort.abort(new Error("private-abort-reason"));
    expect((await result).status).toBe("cancelled");
    expect(tracer.of("run")[0]?.attributes["providerkit.outcome"]).toBe("aborted");
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    release.resolve();
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
  });

  it("records only observed usage, including reported zeros and partial failed usage", async () => {
    const { tracer, tracing } = setup();
    for (const [guarded, reported] of [
      [false, null],
      [false, zero],
      [true, zero],
    ] as const) {
      await defineAgent({
        ...base,
        provider: fake([text("Answer", reported)]),
        ...(guarded
          ? { guardrails: { identity: "allow", modelOutput: () => ({ allow: true }) } }
          : {}),
      }).run("Read", tracing.options());
    }
    const models = tracer.of("model");
    expect(models[0]?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(models[1]?.attributes["gen_ai.usage.input_tokens"]).toBe(0);
    expect(models[2]?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    const ctx = context();
    await tracing.onLifecycle({ type: "run_start" }, ctx);
    await tracing.onLifecycle(modelStart(), ctx);
    await tracing.onEvent({
      type: "model_chunk",
      runId: ctx.runId,
      attemptId: ctx.attemptId,
      operationId: "model",
      chunk: { type: "usage", usage },
    });
    await tracing.onLifecycle(
      { type: "model_error", operationId: "model", attemptId: ctx.attemptId },
      ctx,
    );
    await tracing.onLifecycle(
      {
        type: "run_end",
        state: { status: "failed", error: { code: "private-code", message: "private-message" } },
      },
      ctx,
    );
    expect(tracer.of("model").at(-1)?.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 5,
      "providerkit.usage.complete": false,
    });
  });

  it("deduplicates boundaries, closes missing ends as incomplete and never fabricates missing starts", async () => {
    const { tracer, tracing } = setup();
    const ctx = context();
    await tracing.onLifecycle(
      { type: "model_end", operationId: "missing", attemptId: ctx.attemptId, turn: turn() },
      ctx,
    );
    expect(tracer.spans).toHaveLength(0);
    await tracing.onLifecycle({ type: "run_start" }, ctx);
    await tracing.onLifecycle({ type: "run_start" }, ctx);
    await tracing.onLifecycle(modelStart(), ctx);
    await tracing.onLifecycle(modelStart(), ctx);
    await tracing.onLifecycle({ type: "tool_start", request: request(ctx) }, ctx);
    await tracing.onLifecycle(
      { type: "tool_end", request: request(ctx), result: { ok: true, content: "private-result" } },
      ctx,
    );
    await tracing.onLifecycle({ type: "tool_error", request: request(ctx) }, ctx);
    await tracing.onLifecycle({ type: "tool_start", request: request(ctx) }, ctx);
    await tracing.onEvent({
      type: "child",
      kind: "agent",
      parentRunId: ctx.runId,
      operationId: "tool",
      runId: "missing-child",
      key: "private-key",
      agentId: "child",
      version: "1",
    });
    await tracing.onEvent({
      type: "state",
      runId: ctx.runId,
      attemptId: ctx.attemptId,
      state: { status: "completed", candidate: "private-candidate" },
    });
    await tracing.onLifecycle(
      { type: "run_end", state: { status: "completed", candidate: null } },
      ctx,
    );
    await tracing.onLifecycle({ type: "run_start" }, ctx);
    expect(tracer.of("run")).toHaveLength(1);
    expect(tracer.of("tool")).toHaveLength(1);
    expect(tracer.of("model")[0]?.attributes["providerkit.outcome"]).toBe("incomplete");
    expect(tracer.of("model")[0]?.status.code).toBe(SpanStatusCode.UNSET);
    expect(tracer.of("child")[0]?.attributes["providerkit.outcome"]).toBe("incomplete");
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
  });

  it("bounds missing ends, stored operation identities and pending child relationships", async () => {
    vi.useFakeTimers();
    const { tracer, tracing } = setup({ maxRuns: 1, maxSpansPerRun: 2, maxRunMs: 20 });
    const first = context("first");
    const remove = vi.spyOn(first.signal, "removeEventListener");
    await tracing.onLifecycle({ type: "run_start" }, first);
    await tracing.onLifecycle(modelStart(), first);
    await tracing.onLifecycle(
      { type: "model_end", operationId: "model", attemptId: first.attemptId, turn: turn() },
      first,
    );
    for (let index = 0; index < 4; index++) {
      await tracing.onEvent({
        type: "child",
        kind: "agent",
        parentRunId: first.runId,
        operationId: "tool",
        runId: `child-${index}`,
        key: "key",
        agentId: "child",
        version: "1",
      });
    }
    expect(tracer.of("child")).toHaveLength(1);
    const second = context("second");
    await tracing.onLifecycle({ type: "run_start" }, second);
    expect(tracer.of("run")[0]?.attributes["providerkit.observation.end"]).toBe("capacity");
    expect(remove).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(tracer.of("run")[1]?.attributes["providerkit.observation.end"]).toBe("expired");
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    tracing.close();
    await tracing.onLifecycle({ type: "run_start" }, context("ignored"));
    expect(tracer.of("run")).toHaveLength(2);
  });

  it("closes descendants and detached relationships on explicit shutdown", async () => {
    const { tracer, tracing } = setup();
    const parent = context("parent");
    const child = context("child");
    await tracing.onLifecycle({ type: "run_start" }, parent);
    await tracing.onEvent({
      type: "child",
      kind: "agent",
      parentRunId: "parent",
      operationId: "tool",
      runId: "child",
      key: "key",
      agentId: "reader",
      version: "1",
    });
    await tracing.onLifecycle({ type: "run_start" }, child);
    await tracing.onLifecycle(modelStart(), child);
    tracing.close();
    tracing.close();
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    expect(tracer.spans.every((span) => span.status.code === SpanStatusCode.UNSET)).toBe(true);
  });

  it.each(["run", "model", "tool", "child", "handoff"] as const)(
    "closes a %s span created during synchronous tracing shutdown without stopping the agent",
    async (kind) => {
      vi.useFakeTimers();
      const { tracer, tracing } = setup();
      tracer.onStart = (span) => {
        if (span.attributes["providerkit.span.kind"] === kind) tracing.close();
      };
      const specialist = defineAgent({ ...base, id: "specialist", provider: fake([text()]) });
      const target = defineAgent({ ...base, id: "target", provider: fake([text()]) });
      const result = await defineAgent({
        ...base,
        provider: fake([call("review", { input: "private-child-input" }), call("transfer")]),
        tools: [
          specialist.asTool({ name: "review", description: "Review" }),
          defineHandoff({ name: "transfer", description: "Transfer", to: target }),
        ],
      }).run("private-prompt", tracing.options());
      expect(result.status).toBe("completed");
      expect(tracer.of(kind)).toHaveLength(1);
      expect(tracer.of(kind)[0]?.attributes["providerkit.outcome"]).toBe("incomplete");
      expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(JSON.stringify(tracer.spans)).not.toContain("private-");
      const count = tracer.spans.length;
      tracing.close();
      tracing.close();
      await tracing.onLifecycle({ type: "run_start" }, context("ignored"));
      expect(tracer.spans).toHaveLength(count);
      expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    },
  );

  it.each(["model", "child", "run"] as const)(
    "closes a new %s span when its owning run ends during startSpan",
    async (kind) => {
      vi.useFakeTimers();
      const { tracer, tracing } = setup();
      const parent = context("parent");
      const child = {
        type: "child" as const,
        kind: "agent" as const,
        parentRunId: parent.runId,
        operationId: "tool",
        runId: "child",
        key: "key",
        agentId: "reader",
        version: "1",
      };
      await tracing.onLifecycle({ type: "run_start" }, parent);
      if (kind === "run") await tracing.onEvent(child);
      tracer.onStart = (span) => {
        if (span.attributes["providerkit.span.kind"] === kind)
          void tracing.onLifecycle(
            { type: "run_end", state: { status: "completed", candidate: null } },
            parent,
          );
      };
      if (kind === "model") await tracing.onLifecycle(modelStart(), parent);
      else if (kind === "child") await tracing.onEvent(child);
      else await tracing.onLifecycle({ type: "run_start" }, context(child.runId));
      expect(tracer.of(kind).at(-1)?.attributes["providerkit.outcome"]).toBe("incomplete");
      expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      tracer.onStart = undefined;
      await tracing.onLifecycle({ type: "run_start" }, context("later"));
      expect(tracer.of("run").at(-1)?.ends).toBe(0);
      tracing.close();
      expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["start", "attributes", "status", "end"] as const)(
    "ignores %s exporter failures and still releases every span",
    async (failure) => {
      vi.useFakeTimers();
      const tracer = new RecordingTracer(failure);
      const { tracing } = setup({ tracer });
      const warn = vi.spyOn(console, "warn");
      const error = vi.spyOn(console, "error");
      const result = await defineAgent({ ...base, provider: fake([text()]) }).run(
        "Read",
        tracing.options(),
      );
      expect(result.status).toBe("completed");
      expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("limits explicit host attributes and ignores enricher failures without disclosing raw payloads", async () => {
    const infos: unknown[] = [];
    const { tracer, tracing } = setup({
      attributes(info) {
        infos.push(info);
        expect(Object.isFrozen(info)).toBe(true);
        if (info.kind === "model") throw new Error("private-enricher-message");
        return {
          label: "x".repeat(300),
          count: 3,
          enabled: true,
          invalid: NaN,
          ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, "safe"])),
        };
      },
    });
    await defineAgent({ ...base, provider: fake([text()]) }).run(
      "private-prompt",
      tracing.options({ context: { secret: "private-context" } }),
    );
    const attributes = required(tracer.of("run")[0]).attributes;
    expect(attributes["providerkit.host.label"]).toBe("x".repeat(256));
    expect(attributes["providerkit.host.invalid"]).toBeUndefined();
    expect(
      Object.keys(attributes).filter((key) => key.startsWith("providerkit.host.")).length,
    ).toBeLessThanOrEqual(32);
    expect(JSON.stringify(infos)).not.toContain("private-");
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
    expect(tracer.spans.every((span) => span.exceptions === 0 && span.events === 0)).toBe(true);
  });

  it("rejects invalid bounds and skips oversized identity keys without truncation collisions", async () => {
    expect(() => createAgentTracing({ maxRuns: 0 })).toThrow("maxRuns");
    expect(() => createAgentTracing({ maxSpansPerRun: Infinity })).toThrow("maxSpansPerRun");
    expect(() => createAgentTracing({ maxRunMs: 0 })).toThrow("maxRunMs");
    const { tracer, tracing } = setup();
    await tracing.onLifecycle({ type: "run_start" }, context("x".repeat(513)));
    expect(tracer.spans).toHaveLength(0);
  });
});
