import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROOT_CONTEXT,
  context as otelContext,
  SpanKind,
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
import { withProviderTracing } from "@providerkit/core/otel";
import { defineAgent } from "../src/run.ts";
import { defineWorkflow } from "../src/workflow.ts";
import { codeMode } from "../src/code.ts";
import { defineRemoteAgent, type RemoteAgentOptions } from "../src/a2a/remote.ts";
import {
  decodeA2AAgentCard,
  decodeA2ARpcRequest,
  encodeA2AResult,
  type A2ARequest,
  type A2ATask,
} from "../src/a2a/wire.ts";
import { defineHandoff } from "../src/handoff.ts";
import { questionTool } from "../src/request.ts";
import { createAgentTracing, type AgentTracing } from "../src/otel.ts";
import type { LifecycleContext, RunOptions, RunSnapshot, ToolRequest } from "../src/types.ts";
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
  clients() {
    return this.spans.filter((span) => span.options.kind === SpanKind.CLIENT);
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
    model: "offline-model",
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
const remoteTask: A2ATask = {
  kind: "task",
  id: "private-task",
  contextId: "private-context-id",
  status: { state: "completed" },
  artifacts: [
    { artifactId: "private-artifact", parts: [{ kind: "text", text: "private-result" }] },
  ],
};
function remoteFixture(
  reply: (request: A2ARequest) => A2ATask | Promise<A2ATask>,
  extra: Pick<RemoteAgentOptions, "inputRequired"> = {},
) {
  const endpoint = "https://private-peer.test/a2a";
  const calls: A2ARequest[] = [];
  const dialect = { version: "1.0", binding: "JSONRPC" } as const;
  const remote = defineRemoteAgent({
    ...dialect,
    id: "remote-worker",
    agentVersion: "2",
    card: decodeA2AAgentCard(
      {
        name: "private-peer-name",
        description: "private-card-description",
        version: "1",
        capabilities: {},
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [],
        supportedInterfaces: [
          { url: endpoint, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
      },
      "1.0",
    ),
    policy: { allow: (url) => url.origin === new URL(endpoint).origin },
    async fetch(input, init) {
      const rpc = decodeA2ARpcRequest(await new Request(input, init).json(), "1.0");
      const request = rpc.request;
      if (
        request.method !== "SendMessage" &&
        request.method !== "GetTask" &&
        request.method !== "CancelTask"
      )
        throw new Error("Unexpected remote request");
      calls.push(request);
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: encodeA2AResult({ method: request.method, result: await reply(request) }, dialect),
      });
    },
    ...extra,
  });
  return { remote, calls };
}
const waitingTask: A2ATask = {
  ...remoteTask,
  artifacts: [],
  status: {
    state: "input_required",
    message: {
      kind: "message",
      messageId: "private-question-id",
      role: "agent",
      parts: [{ kind: "text", text: "private-question" }],
    },
  },
};
const requestHost = {
  authorizeResume() {},
  beforeTool() {},
  beforeStep() {},
  prepareRequest: () => ({
    scope: {
      actorId: "private-actor",
      resource: { id: "private-resource", version: "1" },
      expiresAt: Date.now() + 60_000,
    },
  }),
};
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
    expect(tracer.clients()).toHaveLength(tracer.of("model").length);
    for (const client of tracer.clients()) {
      expect(
        tracer.of("model").some((model) => model.identity.spanId === client.parent?.spanId),
      ).toBe(true);
      expect(client.status.code).toBe(SpanStatusCode.UNSET);
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
      expect(tracer.of("model")[0]?.status.code).toBe(SpanStatusCode.UNSET);
      expect(tracer.clients()[0]?.ends).toBe(1);
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
    expect(tracer.clients()[0]?.attributes).toMatchObject({
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
      SpanStatusCode.UNSET,
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

  it("keeps Core's guarded zero, absent and partial usage without duplicate SDK usage fields", async () => {
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
    const rich = { ...usage, cacheWriteTokens: 2, reasoningTokens: 1, reportedCostUsd: 0 };
    const failure = new Error("private-vendor-message");
    const guarded = await defineAgent({
      ...base,
      provider: {
        id: "offline",
        model: "offline",
        async *createStream() {
          yield { type: "usage", usage: rich };
          throw failure;
        },
      },
      guardrails: { identity: "allow", modelOutput: () => ({ allow: true }) },
    }).run("Read", tracing.options());
    expect(guarded.status).toBe("failed");
    const clients = tracer.clients();
    expect(clients).toHaveLength(4);
    expect(clients[0]?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(clients[1]?.attributes["gen_ai.usage.input_tokens"]).toBe(0);
    expect(clients[2]?.attributes["gen_ai.usage.input_tokens"]).toBe(0);
    expect(clients[3]?.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 5,
      "gen_ai.usage.output_tokens": 3,
      "gen_ai.usage.cache_read.input_tokens": 1,
      "gen_ai.usage.cache_write.input_tokens": 2,
      "gen_ai.usage.reasoning.output_tokens": 1,
      "providerkit.usage.reported_cost_usd": 0,
      "providerkit.stream.outcome": "error",
    });
    for (const model of tracer.of("model")) {
      expect(model.options.kind).toBe(SpanKind.INTERNAL);
      expect(Object.keys(model.attributes).some((key) => key.startsWith("gen_ai."))).toBe(false);
      expect(
        Object.keys(model.attributes).some((key) => key.startsWith("providerkit.usage.")),
      ).toBe(false);
    }
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
    expect(JSON.stringify(tracer.spans)).not.toContain("cache_creation");
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

  it.each([false, true])(
    "isolates concurrent roots on one already-traced provider (execution context: %s)",
    async (scoped) => {
      const original = new RecordingTracer();
      const { tracer, tracing } = setup();
      const both = Promise.withResolvers<void>();
      let calls = 0;
      const scopes: (SpanContext | undefined)[] = [];
      if (scoped)
        vi.spyOn(otelContext, "with").mockImplementation((scope, callback, thisArg, ...args) => {
          scopes.push(trace.getSpanContext(scope));
          return callback.apply(thisArg, args);
        });
      const provider: Provider = {
        id: "offline",
        model: "shared",
        async *createStream() {
          if (++calls === 2) both.resolve();
          await both.promise;
          yield* text();
        },
      };
      const wrapped = withProviderTracing(provider, { tracer: original });
      const bind = vi.fn((selected: Provider) =>
        withProviderTracing(selected, { tracer: original }),
      );
      const active = vi.spyOn(otelContext, "active");
      const a = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: "a".repeat(32),
        spanId: "a".repeat(16),
        traceFlags: 1,
      });
      const b = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: "b".repeat(32),
        spanId: "b".repeat(16),
        traceFlags: 1,
      });
      const agent = defineAgent({ ...base, provider: wrapped });
      active.mockReturnValue(a);
      const optionsA = tracing.options({ runId: "root-a", bindModelProvider: bind });
      active.mockReturnValue(b);
      const optionsB = tracing.options({ runId: "root-b", bindModelProvider: bind });
      active.mockReturnValue(ROOT_CONTEXT);
      const results = await Promise.all([
        agent.run("private-a", optionsA),
        agent.run("private-b", optionsB),
      ]);
      expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
      expect(calls).toBe(2);
      expect(bind).toHaveBeenCalledTimes(2);
      expect(original.spans).toHaveLength(0);
      expect(tracer.clients()).toHaveLength(2);
      for (const [runId, expected] of [
        ["root-a", a],
        ["root-b", b],
      ] as const) {
        const run = required(
          tracer.of("run").find((span) => span.attributes["providerkit.run.id"] === runId),
        );
        const model = required(
          tracer.of("model").find((span) => span.parent?.spanId === run.identity.spanId),
        );
        const client = required(
          tracer.clients().find((span) => span.parent?.spanId === model.identity.spanId),
        );
        expect(run.parent).toEqual(trace.getSpanContext(expected));
        expect(client.identity.traceId).toBe(run.identity.traceId);
        if (scoped) expect(scopes).toContainEqual(client.identity);
      }
      expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    },
  );

  it("binds compaction below guards with the same operation identities and no duplicate usage", async () => {
    const { tracer, tracing } = setup();
    const bound = vi.fn((provider: Provider) => provider);
    const result = await defineAgent({
      ...base,
      provider: fake([text()]),
      compaction: {
        identity: "summary",
        contextWindow: 1_000,
        keepTokens: 5,
        summarize: {
          provider: fake([text("private-summary", zero)]),
          instructions: "private-summary-prompt",
          maxTokens: 40,
        },
      },
      guardrails: { identity: "allow", modelOutput: () => ({ allow: true }) },
    }).run(
      {
        messages: [
          { role: "user", content: "private-old-question ".repeat(30) },
          { role: "assistant", content: "private-old-answer ".repeat(30) },
          { role: "user", content: "private-new-question" },
        ],
      },
      tracing.options({ bindModelProvider: bound }),
    );
    expect(result.status).toBe("completed");
    expect(bound).toHaveBeenCalledTimes(2);
    expect(tracer.of("model").map((span) => span.attributes["providerkit.model.purpose"])).toEqual([
      "compaction",
      "turn",
    ]);
    expect(tracer.clients()).toHaveLength(2);
    expect(tracer.clients()[0]?.attributes["gen_ai.usage.input_tokens"]).toBe(0);
    for (const receipt of result.receipts.filter((receipt) => receipt.kind === "model")) {
      const model = required(
        tracer
          .of("model")
          .find((span) => span.attributes["providerkit.operation.id"] === receipt.id),
      );
      expect(model.attributes["providerkit.operation.attempt.id"]).toBe(receipt.attemptId);
      expect(
        tracer.clients().filter((span) => span.parent?.spanId === model.identity.spanId),
      ).toHaveLength(1);
    }
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
  });

  it("parents concurrent children, nested workflows and remote jobs under real step attempts", async () => {
    const { tracer, tracing } = setup();
    const { remote, calls } = remoteFixture(() => remoteTask);
    const specialist = defineAgent({ ...base, id: "specialist", provider: fake([text()]) });
    const nested = defineWorkflow({
      id: "nested",
      version: "2",
      input: { schema: { type: "object" }, validate: () => null },
      agents: [remote],
      async run(_, ctx) {
        return (await ctx.agent("peer", remote, { input: "private-input" })).status;
      },
    });
    let attempts = 0;
    const workflow = defineWorkflow({
      id: "flow",
      version: "3",
      input: { schema: { type: "object" }, validate: () => null },
      agents: [specialist],
      workflows: [nested],
      async run(_, ctx) {
        await ctx.step(
          "effect",
          () => {
            if (++attempts === 1) throw new Error("private-step-error");
            return "private-step-result";
          },
          { retry: { maxAttempts: 2, replay: "read-only", baseDelayMs: 0 } },
        );
        const children = await Promise.all([
          ctx.agent("local", specialist, "private-local"),
          ctx.workflow("nested", nested, null),
        ]);
        return children.map((child) => child.status);
      },
    });
    const result = await workflow.run(null, tracing.options({ host: requestHost }));
    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(calls).toHaveLength(1);
    const root = required(
      tracer.of("run").find((span) => span.attributes["providerkit.run.id"] === result.runId),
    );
    expect(root.attributes).toMatchObject({
      "providerkit.node.kind": "workflow",
      "providerkit.node.id": "flow",
    });
    const effects = tracer
      .of("step")
      .filter((span) => span.attributes["providerkit.step.kind"] === "step");
    expect(effects.map((span) => span.attributes["providerkit.operation.attempt.id"])).toEqual(
      result.snapshot.steps[0]?.attempts.map((attempt) => attempt.attemptId),
    );
    expect(
      effects.every((span) => span.attributes["providerkit.run.attempt.id"] === result.attemptId),
    ).toBe(true);
    expect(effects.map((span) => span.status.code)).toEqual([
      SpanStatusCode.ERROR,
      SpanStatusCode.UNSET,
    ]);
    for (const relation of tracer.of("child")) {
      const parentStep = tracer
        .of("step")
        .find((span) => span.identity.spanId === relation.parent?.spanId);
      expect(parentStep).toBeDefined();
      expect(
        tracer.of("run").filter((span) => span.parent?.spanId === relation.identity.spanId),
      ).toHaveLength(1);
    }
    const peer = required(
      tracer.of("run").find((span) => span.attributes["providerkit.node.kind"] === "remote"),
    );
    expect(peer.attributes).toMatchObject({
      "providerkit.node.id": remote.id,
      "providerkit.billing": "unknown",
      "providerkit.remote.state": "completed",
    });
    expect(tracer.clients()).toHaveLength(1);
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
  });

  it("keeps parent-continuation completion separate from the remote task's state", async () => {
    const { tracer, tracing } = setup();
    let sends = 0;
    const { remote } = remoteFixture(() => (++sends === 1 ? waitingTask : remoteTask), {
      inputRequired: "parent",
    });
    const workflow = defineWorkflow({
      id: "parent",
      version: "1",
      input: { schema: { type: "object" }, validate: () => null },
      agents: [remote],
      async run(_, ctx) {
        const first = await ctx.agent("first", remote, { input: "private-task" });
        if (first.status !== "completed" || typeof first.output === "string")
          throw new Error("Missing parent handle");
        return (
          await ctx.agent("second", remote, {
            input: "private-answer",
            continue: first.output.handle,
          })
        ).status;
      },
    });
    expect((await workflow.run(null, tracing.options({ host: requestHost }))).status).toBe(
      "completed",
    );
    const peers = tracer
      .of("run")
      .filter((span) => span.attributes["providerkit.node.kind"] === "remote");
    expect(peers).toHaveLength(2);
    expect(peers.map((span) => span.attributes["providerkit.remote.state"])).toEqual([
      "input_required",
      "completed",
    ]);
    expect(
      peers.every(
        (span) =>
          span.attributes["providerkit.outcome"] === "completed" &&
          span.attributes["providerkit.billing"] === "unknown",
      ),
    ).toBe(true);
    expect(tracer.clients()).toHaveLength(0);
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
  });

  it("opens new remote and workflow attempts after suspension without tracing cached terminal nodes", async () => {
    const { tracer, tracing } = setup();
    let sends = 0;
    const { remote, calls } = remoteFixture(() => (++sends === 1 ? waitingTask : remoteTask));
    const workflow = defineWorkflow({
      id: "waiting",
      version: "1",
      input: { schema: { type: "object" }, validate: () => null },
      agents: [remote],
      async run(_, ctx) {
        return (await ctx.agent("peer", remote, { input: "private-task" })).status;
      },
    });
    const waiting = await workflow.run(null, tracing.options({ host: requestHost }));
    expect(waiting.status).toBe("suspended");
    if (waiting.status !== "suspended") throw new Error("Missing request");
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    const finished = await workflow.resume(
      waiting.snapshot,
      tracing.options({
        answers: { [required(waiting.requests[0]).id]: "private-proof" },
        host: {
          ...requestHost,
          resolveRequest: () => ({ type: "answer" as const, answer: { text: "private-answer" } }),
        },
      }),
    );
    expect(finished.status).toBe("completed");
    expect(tracer.of("run")).toHaveLength(4);
    for (const kind of ["workflow", "remote"]) {
      const runs = tracer
        .of("run")
        .filter((span) => span.attributes["providerkit.node.kind"] === kind);
      expect(runs[0]?.attributes["providerkit.run.id"]).toBe(
        runs[1]?.attributes["providerkit.run.id"],
      );
      expect(runs[0]?.attributes["providerkit.run.attempt.id"]).not.toBe(
        runs[1]?.attributes["providerkit.run.attempt.id"],
      );
    }
    const count = tracer.spans.length;
    await workflow.resume(finished.snapshot, tracing.options({ host: requestHost }));
    expect(tracer.spans).toHaveLength(count);
    expect(calls.filter((call) => call.method === "SendMessage")).toHaveLength(2);
    expect(tracer.clients()).toHaveLength(0);
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
  });

  it("ends a remote observation on abort without sending cancellation or recording a local model call", async () => {
    const { tracer, tracing } = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<A2ATask>();
    const controller = new AbortController();
    const { remote, calls } = remoteFixture((request) => {
      if (request.method === "SendMessage")
        return { ...remoteTask, artifacts: [], status: { state: "working" } };
      entered.resolve();
      return release.promise;
    });
    const pending = remote.run(
      "private-prompt",
      tracing.options({ signal: controller.signal, host: requestHost }),
    );
    await entered.promise;
    controller.abort(new Error("private-abort"));
    const result = await pending;
    release.resolve(remoteTask);
    expect(result.status).toBe("cancelled");
    expect(tracer.of("run")[0]?.attributes).toMatchObject({
      "providerkit.outcome": "aborted",
      "providerkit.billing": "unknown",
    });
    expect(tracer.of("run")[0]?.status.code).toBe(SpanStatusCode.UNSET);
    expect(calls.map((call) => call.method)).toEqual(["SendMessage", "GetTask"]);
    expect(tracer.clients()).toHaveLength(0);
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
  });

  it("parents code inner calls and their retries to the outer program operation", async () => {
    const { tracer, tracing } = setup();
    let attempts = 0;
    const mode = codeMode({
      tools: [
        defineTool({
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          isReadOnly: true,
          run: async () => {
            if (++attempts === 1) throw new Error("private-inner-error");
            return "private-inner-result";
          },
        }),
      ],
      driver: {
        async run(job) {
          await job.call("read", '{"value":"private-arguments"}');
          return { ok: true, envelope: '{"ok":true,"value":"private-result"}' };
        },
      },
    });
    const result = await defineAgent({
      ...base,
      tools: [mode],
      provider: fake([call(mode.name, { code: "private-code" }), text()]),
      toolRetries: {
        identity: "read-retry",
        tools: { read: { maxAttempts: 2, replay: "read-only" } },
      },
    }).run("Read", tracing.options({ host: requestHost }));
    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
    const [outer, ...inner] = tracer.of("tool");
    expect(inner).toHaveLength(2);
    expect(inner.every((span) => span.parent?.spanId === outer?.identity.spanId)).toBe(true);
    expect(inner[0]?.attributes["providerkit.operation.id"]).toBe(
      inner[1]?.attributes["providerkit.operation.id"],
    );
    expect(inner[0]?.attributes["providerkit.operation.attempt.id"]).not.toBe(
      inner[1]?.attributes["providerkit.operation.attempt.id"],
    );
    expect(inner.map((span) => span.status.code)).toEqual([
      SpanStatusCode.ERROR,
      SpanStatusCode.UNSET,
    ]);
    expect(
      inner.every(
        (span) =>
          span.attributes["providerkit.operation.parent.id"] ===
          outer?.attributes["providerkit.operation.id"],
      ),
    ).toBe(true);
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
  });

  it("composes callbacks and a failing binding once, including repeated options composition", async () => {
    const { tracer, tracing } = setup();
    const provider = fake([text()]);
    const dispatch = vi.spyOn(provider, "createStream");
    const events = vi.fn();
    const lifecycle = vi.fn();
    const bind = vi.fn(() => {
      throw new Error("private-binding-error");
    });
    const options = tracing.options(
      tracing.options({ onEvent: events, onLifecycle: lifecycle, bindModelProvider: bind }),
    );
    const result = await defineAgent({ ...base, provider }).run("Read", options);
    expect(result.status).toBe("completed");
    expect(bind).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(lifecycle.mock.calls.map(([event]) => event.type)).toEqual([
      "run_start",
      "model_start",
      "model_end",
      "run_end",
    ]);
    expect(events.mock.calls.filter(([event]) => event.type === "state")).toHaveLength(1);
    expect(tracer.clients()).toHaveLength(1);
  });

  it.each(["before", "after", "twice"])(
    "never replays dispatch when the context manager fails %s its callback",
    async (mode) => {
      const { tracer, tracing } = setup();
      vi.spyOn(otelContext, "with").mockImplementation((_scope, callback, thisArg, ...args) => {
        if (mode === "before") throw new Error("private-context-failure");
        callback.apply(thisArg, args);
        if (mode === "twice") callback.apply(thisArg, args);
        throw new Error("private-context-failure");
      });
      const provider = fake([text()]);
      const dispatch = vi.spyOn(provider, "createStream");
      expect((await defineAgent({ ...base, provider }).run("Read", tracing.options())).status).toBe(
        "completed",
      );
      expect(dispatch).toHaveBeenCalledOnce();
      expect(tracer.clients()).toHaveLength(1);
      expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    },
  );

  it("reserves operation and relationship identities before synchronous tracer reentry", async () => {
    const { tracer, tracing } = setup();
    const ctx = context();
    await tracing.onLifecycle({ type: "run_start" }, ctx);
    const child = {
      type: "child" as const,
      kind: "agent" as const,
      parentRunId: ctx.runId,
      operationId: "tool",
      runId: "child",
      key: "child",
      agentId: "reader",
      version: "1",
    };
    tracer.onStart = (span) => {
      if (span.attributes["providerkit.span.kind"] === "model")
        void tracing.onLifecycle(modelStart(), ctx);
      if (span.attributes["providerkit.span.kind"] === "child") void tracing.onEvent(child);
    };
    await tracing.onLifecycle(modelStart(), ctx);
    await tracing.onEvent(child);
    expect(tracer.of("model")).toHaveLength(1);
    expect(tracer.of("child")).toHaveLength(1);
    await tracing.onEvent({
      type: "state",
      runId: "child",
      attemptId: "not-started",
      state: { status: "failed", error: { code: "gate", message: "private-refusal" } },
    });
    expect(tracer.of("child")[0]?.attributes["providerkit.outcome"]).toBe("failed");
    expect(tracer.of("run")).toHaveLength(1);
    tracing.close();
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
  });

  it("does not re-parent a child when capacity evicts its parent before admission", async () => {
    const { tracer, tracing } = setup({ maxRuns: 1 });
    await tracing.onLifecycle({ type: "run_start" }, context("parent"));
    await tracing.onEvent({
      type: "child",
      kind: "agent",
      parentRunId: "parent",
      operationId: "tool",
      runId: "child",
      key: "child",
      agentId: "reader",
      version: "1",
    });
    await tracing.onLifecycle({ type: "run_start" }, context("child"));
    expect(tracer.of("run")).toHaveLength(1);
    expect(tracer.of("run")[0]?.attributes["providerkit.observation.end"]).toBe("capacity");
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
  });

  it.each(["closed", "expired", "capacity"])(
    "closes only Agents observations on %s and preserves Core iteration and error identity",
    async (reason) => {
      vi.useFakeTimers();
      const { tracer, tracing } = setup({ maxRuns: 1, maxRunMs: 20 });
      const ctx = context();
      const failure = { secret: "private-provider-error" };
      let reads = 0;
      let returns = 0;
      const provider: Provider = {
        id: "offline",
        model: "offline",
        async *createStream() {
          try {
            reads++;
            yield { type: "usage", usage };
            reads++;
            throw failure;
          } finally {
            returns++;
          }
        },
      };
      await tracing.onLifecycle({ type: "run_start" }, ctx);
      await tracing.onLifecycle(modelStart(), ctx);
      const bound = tracing.bindModelProvider(provider, {
        run: ctx,
        operationId: "model",
        operationAttemptId: ctx.attemptId,
        purpose: "turn",
      });
      const stream = bound.createStream([], [], { signal: ctx.signal })[Symbol.asyncIterator]();
      expect(tracer.clients()).toHaveLength(0);
      expect(reads).toBe(0);
      await stream.next();
      if (reason === "closed") tracing.close();
      else if (reason === "expired") await vi.advanceTimersByTimeAsync(20);
      else await tracing.onLifecycle({ type: "run_start" }, context("next"));
      expect(tracer.of("run")[0]?.attributes["providerkit.observation.end"]).toBe(reason);
      expect(tracer.of("run")[0]?.ends).toBe(1);
      expect(tracer.of("model")[0]?.ends).toBe(1);
      expect(tracer.clients()[0]?.ends).toBe(0);
      expect(reads).toBe(1);
      expect(returns).toBe(0);
      await expect(stream.next()).rejects.toBe(failure);
      expect(reads).toBe(2);
      expect(returns).toBe(1);
      expect(tracer.clients()[0]?.attributes).toMatchObject({
        "gen_ai.usage.input_tokens": 5,
        "providerkit.stream.outcome": "error",
      });
      tracing.close();
      expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
      expect(JSON.stringify(tracer.spans)).not.toContain("private-");
    },
  );

  it("review regression: recomposition preserves current authority and all non-tracing options", async () => {
    const { tracer, tracing } = setup();
    const allow = vi.fn();
    const deny = vi.fn(() => {
      throw new Error("private-current-refusal");
    });
    const write = vi.fn(async () => "private-written");
    const lifecycle = vi.fn();
    const events = vi.fn();
    const bind = vi.fn((provider: Provider) => provider);
    const original: RunOptions = {
      runId: "old-run",
      host: { beforeTool: allow },
      context: { policy: "old" },
      signal: new AbortController().signal,
      enabledTools: ["write"],
      modelSettings: { temperature: 1 },
      onLifecycle: lifecycle,
      onEvent: events,
      bindModelProvider: bind,
    };
    const composed = tracing.options(original);
    composed.runId = "current-run";
    composed.host = { beforeTool: deny };
    composed.context = { policy: "current" };
    composed.signal = new AbortController().signal;
    composed.enabledTools = ["write"];
    composed.modelSettings = { temperature: 0 };
    const recomposed = tracing.options(tracing.options(composed));
    const result = await defineAgent({
      ...base,
      provider: fake([call("write"), text()]),
      tools: [
        defineTool({
          name: "write",
          description: "Write",
          inputSchema: { type: "object" },
          run: write,
        }),
      ],
    }).run("Write", recomposed);
    expect(deny).toHaveBeenCalledOnce();
    expect(allow).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.runId).toBe("current-run");
    expect(recomposed.host).toBe(composed.host);
    expect(recomposed.context).toBe(composed.context);
    expect(recomposed.signal).toBe(composed.signal);
    expect(recomposed.modelSettings).toBe(composed.modelSettings);
    expect(recomposed.enabledTools).toBe(composed.enabledTools);
    expect(bind).toHaveBeenCalledOnce();
    expect(lifecycle.mock.calls.filter(([event]) => event.type === "run_start")).toHaveLength(1);
    expect(lifecycle.mock.calls.filter(([event]) => event.type === "tool_start")).toHaveLength(1);
    expect(events.mock.calls.filter(([event]) => event.type === "state")).toHaveLength(1);
    expect(tracer.of("run")[0]?.attributes["providerkit.run.id"]).toBe("current-run");
  });

  it("review regression: closes an abandoned code call before the next model turn", async () => {
    const { tracer, tracing } = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    let innerContext: LifecycleContext | undefined;
    let innerRequest: ToolRequest | undefined;
    const mode = codeMode({
      tools: [
        defineTool({
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          isReadOnly: true,
          async run() {
            entered.resolve();
            return release.promise;
          },
        }),
      ],
      driver: {
        async run(job) {
          void job.call("read", "{}");
          await entered.promise;
          return { ok: true, envelope: '{"ok":true,"value":"private-finished-program"}' };
        },
      },
    });
    let modelCalls = 0;
    let atNextModel: { ends: number; outcome: unknown } | undefined;
    const agent = defineAgent({
      ...base,
      tools: [mode],
      onLifecycle(event, ctx) {
        if (event.type === "tool_start" && event.request.parentOperationId) {
          innerContext = ctx;
          innerRequest = event.request;
        }
      },
      provider: {
        id: "offline",
        model: "offline",
        async *createStream() {
          if (++modelCalls === 1) yield* call(mode.name, { code: "private-program" });
          else {
            const inner = required(
              tracer
                .of("tool")
                .find((span) => span.attributes["providerkit.operation.parent.id"] !== undefined),
            );
            atNextModel = { ends: inner.ends, outcome: inner.attributes["providerkit.outcome"] };
            yield* text();
          }
        },
      },
    });
    const result = await agent.run("Read", tracing.options({ host: requestHost }));
    release.resolve("private-late-result");
    expect(result.status).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(atNextModel).toEqual({ ends: 1, outcome: "aborted" });
    expect(required(innerContext).signal.aborted).toBe(true);
    const request = required(innerRequest);
    const inner = required(
      tracer
        .of("tool")
        .find((span) => span.attributes["providerkit.operation.id"] === request.operationId),
    );
    const outer = required(
      tracer
        .of("tool")
        .find((span) => span.attributes["providerkit.operation.id"] === request.parentOperationId),
    );
    expect(inner.attributes["providerkit.operation.attempt.id"]).toBe(request.attemptId);
    expect(inner.parent?.spanId).toBe(outer.identity.spanId);
    expect(inner.status.code).toBe(SpanStatusCode.UNSET);
    expect(result.receipts).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        id: request.operationId,
        attemptId: request.attemptId,
        result: expect.objectContaining({ ok: false, kind: "aborted" }),
      }),
    );
    expect(tracer.spans.every((span) => span.ends === 1)).toBe(true);
    expect(JSON.stringify(tracer.spans)).not.toContain("private-");
  });

  it.each(["returned", "aborted", "closed"] as const)(
    "releases the operation signal listener on %s without cancelling work",
    async (outcome) => {
      const { tracer, tracing } = setup();
      const ctx = context();
      await tracing.onLifecycle({ type: "run_start" }, ctx);
      const operation = new AbortController();
      const callContext = { ...ctx, signal: operation.signal };
      const add = vi.spyOn(operation.signal, "addEventListener");
      const remove = vi.spyOn(operation.signal, "removeEventListener");
      const call = request(ctx, "effect-attempt");
      await tracing.onLifecycle({ type: "tool_start", request: call }, callContext);
      expect(add).toHaveBeenCalledOnce();
      const listener = required(add.mock.calls[0])[1];
      if (outcome === "returned")
        await tracing.onLifecycle(
          { type: "tool_end", request: call, result: { ok: true, content: "private-output" } },
          callContext,
        );
      else if (outcome === "aborted") operation.abort(new Error("private-abort"));
      else tracing.close();
      expect(remove).toHaveBeenCalledExactlyOnceWith("abort", listener);
      expect(operation.signal.aborted).toBe(outcome === "aborted");
      expect(ctx.signal.aborted).toBe(false);
      const span = required(tracer.of("tool")[0]);
      expect(span.ends).toBe(1);
      expect(span.attributes["providerkit.operation.attempt.id"]).toBe("effect-attempt");
      expect(span.attributes["providerkit.run.attempt.id"]).toBe(ctx.attemptId);
      expect(span.attributes["providerkit.outcome"]).toBe(
        outcome === "closed" ? "incomplete" : outcome,
      );
      if (outcome !== "closed") expect(tracer.of("run")[0]?.ends).toBe(0);
      tracing.close();
      expect(remove).toHaveBeenCalledOnce();
      expect(span.ends).toBe(1);
    },
  );

  it.each(["returned", "error"] as const)(
    "review regression: preserves a reentrant %s event before span creation returns",
    async (outcome) => {
      const { tracer, tracing } = setup();
      const ctx = context();
      await tracing.onLifecycle({ type: "run_start" }, ctx);
      tracer.onStart = (span) => {
        if (span.attributes["providerkit.span.kind"] === "model")
          void tracing.onLifecycle(
            outcome === "returned"
              ? { type: "model_end", operationId: "model", attemptId: ctx.attemptId, turn: turn() }
              : { type: "model_error", operationId: "model", attemptId: ctx.attemptId },
            ctx,
          );
      };
      await tracing.onLifecycle(modelStart(), ctx);
      const model = required(tracer.of("model")[0]);
      expect(model.ends).toBe(1);
      expect(model.attributes["providerkit.outcome"]).toBe(outcome);
      expect(model.status.code).toBe(
        outcome === "returned" ? SpanStatusCode.UNSET : SpanStatusCode.ERROR,
      );
      await tracing.onLifecycle(
        { type: "model_error", operationId: "model", attemptId: ctx.attemptId },
        ctx,
      );
      tracing.close();
      expect(model.ends).toBe(1);
      expect(model.attributes["providerkit.outcome"]).toBe(outcome);
      expect(JSON.stringify(tracer.spans)).not.toContain("private-");
    },
  );

  it("rejects invalid bounds and skips oversized identity keys without truncation collisions", async () => {
    expect(() => createAgentTracing({ maxRuns: 0 })).toThrow("maxRuns");
    expect(() => createAgentTracing({ maxSpansPerRun: Infinity })).toThrow("maxSpansPerRun");
    expect(() => createAgentTracing({ maxRunMs: 0 })).toThrow("maxRunMs");
    const { tracer, tracing } = setup();
    await tracing.onLifecycle({ type: "run_start" }, context("x".repeat(513)));
    expect(tracer.spans).toHaveLength(0);
  });
});
