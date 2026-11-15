import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  defineTool,
  type ChatMessage,
  type Provider,
  type ProviderChunk,
  type ToolCall,
  type ToolContext,
} from "@providerkit/core";
import { defineAgent, RESULT_TOOL_NAME, type AgentHost, type RunSnapshot } from "../src/index.ts";

const base = { id: "test-agent", version: "1", instructions: "Complete the requested task." };
const usage = { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 1 };

function text(content: string): ProviderChunk[] {
  return [
    { type: "delta", content },
    { type: "finish", finishReason: "stop" },
    { type: "usage", usage },
  ];
}

function calls(...tools: ToolCall[]): ProviderChunk[] {
  return [
    { type: "delta", toolCalls: tools.map((tool, index) => ({ ...tool, index })) },
    { type: "finish", finishReason: "tool_calls" },
    { type: "usage", usage },
  ];
}

function call(name: string, args = "{}", id = `wire-${name}`): ToolCall {
  return { name, arguments: args, id };
}

function fake(turns: ProviderChunk[][]) {
  const histories: ChatMessage[][] = [];
  let reads = 0;
  let requests = 0;
  const provider: Provider = {
    id: "fake",
    model: "fake-model",
    createStream(history) {
      histories.push(structuredClone(history));
      const chunks = turns[requests++];
      if (!chunks) throw new Error("Unexpected model request");
      return {
        async *[Symbol.asyncIterator]() {
          reads++;
          for (const chunk of chunks) yield chunk;
        },
      };
    },
  };
  return {
    provider,
    histories,
    get reads() {
      return reads;
    },
    get requests() {
      return requests;
    },
  };
}

function tool(
  name: string,
  run: (context: ToolContext) => Promise<string>,
  flags: { safe?: boolean; approval?: boolean } = {},
) {
  return defineTool({
    name,
    description: name,
    inputSchema: { type: "object" },
    isConcurrencySafe: flags.safe,
    needsApproval: flags.approval,
    run: async (_args, context) => run(context),
    summarize: (value) => value,
  });
}

function saved(value: RunSnapshot | undefined): RunSnapshot {
  if (!value) throw new Error("Expected a checkpoint");
  return value;
}

const authorizeResume = () => {};

afterEach(() => vi.useRealTimers());

describe("portable agent lifecycle", () => {
  it("returns text, reads each chunk once, and isolates best-effort observers", async () => {
    const wire = fake([text("Hello")]);
    const events: string[] = [];
    const checkpoints: RunSnapshot[] = [];
    const agent = defineAgent({ ...base, provider: wire.provider });
    const result = await agent.run("Say hello", {
      onEvent(event) {
        events.push(event.type);
        expect(Object.isFrozen(event)).toBe(true);
        if (event.type === "model_chunk") {
          expect(Object.isFrozen(event.chunk)).toBe(true);
          expect(() => {
            event.chunk.content = "changed";
          }).toThrow();
        }
        return Promise.reject(new Error("Observer disconnected"));
      },
      host: {
        checkpoint(snapshot) {
          expect(Object.isFrozen(snapshot.models)).toBe(true);
          checkpoints.push(structuredClone(snapshot));
        },
      },
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(result.status);
    expectTypeOf(result.output).toEqualTypeOf<string>();
    expect(result.output).toBe("Hello");
    expect(wire.reads).toBe(1);
    expect(events).toEqual(["model_chunk", "model_chunk", "model_chunk", "state"]);
    expect(result.usage).toMatchObject(usage);
    expect(checkpoints[0]?.models[0]?.status).toBe("running");
    expect(checkpoints.at(-1)?.state.status).toBe("completed");
    const restored = await agent.resume(JSON.parse(JSON.stringify(result.snapshot)), {
      host: { authorizeResume },
    });
    expect(restored.status).toBe("completed");
    expect(wire.requests).toBe(1);
    expect(restored.receipts).toEqual(result.receipts);
    expect(restored.usage).toEqual(result.usage);
    expect(restored.attemptId).not.toBe(result.attemptId);
  });

  it("validates a terminal result and feeds invalid submissions back as tool results", async () => {
    const wire = fake([
      calls(call(RESULT_TOOL_NAME, '{"count":"wrong"}', "bad")),
      calls(call(RESULT_TOOL_NAME, '{"count":2}', "good")),
    ]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      output: {
        schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        validate(value) {
          if (
            typeof value !== "object" ||
            value === null ||
            !("count" in value) ||
            typeof value.count !== "number"
          )
            throw new Error("count must be a number");
          return { count: value.count };
        },
      },
    });
    const result = await agent.run("Count to two");
    if (result.status !== "completed") throw new Error(result.status);
    expectTypeOf(result.output).toEqualTypeOf<{ count: number }>();
    expect(result.output).toEqual({ count: 2 });
    expect(wire.histories[1]?.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "bad",
      content: expect.stringContaining("count must be a number"),
    });
    expect(result.history.at(-1)).toMatchObject({ role: "tool", toolCallId: "good" });
    const restored = await agent.resume(result.snapshot, { host: { authorizeResume } });
    expect(restored).toMatchObject({ status: "completed", output: { count: 2 } });
    expect(wire.requests).toBe(2);
  });

  it.each([
    { chunks: text(""), status: "failed" },
    {
      chunks: [
        { type: "delta", reasoning: "Thinking" },
        { type: "finish", finishReason: "stop" },
      ],
      status: "failed",
    },
    {
      chunks: [
        { type: "delta", content: "Cut short" },
        { type: "finish", finishReason: "length" },
      ],
      status: "limited",
    },
    { chunks: [{ type: "delta", content: "No finish" }], status: "failed" },
    { chunks: [{ type: "finish", finishReason: "content_filter" }], status: "failed" },
  ] satisfies { chunks: ProviderChunk[]; status: string }[])(
    "does not accept an incomplete answer ($status)",
    async ({ chunks, status }) => {
      const wire = fake([chunks]);
      const result = await defineAgent({ ...base, provider: wire.provider }).run("Answer");
      expect(result.status).toBe(status);
      expect(wire.requests).toBe(1);
    },
  );

  it("does not execute truncated tool calls or accept a mixed terminal turn", async () => {
    const run = vi.fn(async () => "done");
    const wire = fake([
      [...calls(call("write", '{"value":"cut')), { type: "finish", finishReason: "length" }],
    ]);
    expect(
      (
        await defineAgent({ ...base, provider: wire.provider, tools: [tool("write", run)] }).run(
          "Write",
        )
      ).status,
    ).toBe("limited");
    expect(run).not.toHaveBeenCalled();
    const typed = fake([
      calls(call(RESULT_TOOL_NAME, '{"value":"cut')),
      calls(call(RESULT_TOOL_NAME), call("read")),
      calls(call(RESULT_TOOL_NAME)),
    ]);
    const result = await defineAgent({
      ...base,
      provider: typed.provider,
      tools: [tool("read", run)],
      output: { schema: { type: "object" }, validate: () => 42 },
    }).run("Answer");
    expect(result).toMatchObject({ status: "completed", output: 42 });
    expect(typed.histories[1]?.at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringContaining("complete JSON object"),
    });
    expect(typed.histories[2]?.filter((message) => message.role === "tool")).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects a successful receipt whose tool arguments were corrupted", async () => {
    const wire = fake([calls(call(RESULT_TOOL_NAME))]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      output: { schema: { type: "object" }, validate: () => 42 },
    });
    const result = await agent.run("Answer");
    const corrupted = structuredClone(result.snapshot);
    const model = corrupted.models[0];
    const submission =
      model?.status === "completed" ? model.turn.message.toolCalls?.[0] : undefined;
    if (!submission) throw new Error("Expected a submission");
    submission.arguments = '{"unfinished":';
    const authorize = vi.fn();
    await expect(agent.resume(corrupted, { host: { authorizeResume: authorize } })).rejects.toThrow(
      "complete arguments",
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(wire.requests).toBe(1);
  });

  it("restores reasoning metadata and completed tool results without repeating work", async () => {
    const reasoningDetails = [{ type: "reasoning.encrypted", data: "opaque" }];
    const reasoningItems = { provider: "chatgpt", items: [{ encrypted_content: "opaque-item" }] };
    const exactCall = {
      ...call("read", '{"key":"value"}', "exact-wire-id"),
      thoughtSignature: "gemini-signature",
    };
    const wire = fake([
      [
        { type: "delta", reasoning: "Thinking", reasoningDetails, reasoningItems },
        ...calls(exactCall),
      ],
      text("Finished"),
    ]);
    const run = vi.fn(async () => "saved result");
    let checkpoint: RunSnapshot | undefined;
    const agent = defineAgent({ ...base, provider: wire.provider, tools: [tool("read", run)] });
    const interrupted = await agent.run("Read", {
      host: {
        checkpoint(snapshot) {
          checkpoint = structuredClone(snapshot);
          const last = snapshot.models.at(-1);
          if (last?.status === "completed" && last.tools[0]?.status === "completed")
            throw new Error("Worker stopped after storing receipt");
        },
      },
    });
    expect(interrupted.status).toBe("failed");
    expect(wire.requests).toBe(1);
    const restored = await agent.resume(JSON.parse(JSON.stringify(saved(checkpoint))), {
      host: { authorizeResume },
    });
    expect(restored.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(wire.histories[1]?.[2]).toEqual({
      role: "assistant",
      content: "",
      reasoning: "Thinking",
      reasoningDetails,
      reasoningItems,
      toolCalls: [exactCall],
    });
    expect(wire.histories[1]?.[3]).toEqual({
      role: "tool",
      toolCallId: exactCall.id,
      name: "read",
      content: "saved result",
    });
    expect(restored.usage.inputTokens).toBe(14);
    expect(restored.receipts.filter((receipt) => receipt.kind === "tool")).toHaveLength(1);
    expect(restored.receipts[1]?.id).toBe(interrupted.receipts[1]?.id);
  });

  it("batches only safe host-approved tools, respects barriers and orders results by the model", async () => {
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const release = Promise.withResolvers<void>();
    const names = ["a", "b", "c", "write", "d"];
    const tools = names.map((name) =>
      tool(
        name,
        async () => {
          active++;
          peak = Math.max(peak, active);
          order.push(`${name}:start`);
          if (name === "a") await release.promise;
          else await Promise.resolve();
          if (name === "write") expect(active).toBe(1);
          active--;
          order.push(`${name}:end`);
          if (name === "b") release.resolve();
          return name;
        },
        { safe: name !== "write" },
      ),
    );
    const wire = fake([calls(...names.map((name) => call(name))), text("Done")]);
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      tools,
      limits: { parallelTools: 2 },
    }).run("Read and write", {
      host: { canRunConcurrently: () => true },
    });
    expect(result.status).toBe("completed");
    expect(peak).toBe(2);
    expect(order.indexOf("b:end")).toBeLessThan(order.indexOf("a:end"));
    expect(order.indexOf("write:start")).toBeGreaterThan(order.indexOf("c:end"));
    expect(order.indexOf("d:start")).toBeGreaterThan(order.indexOf("write:end"));
    expect(
      result.history.filter((message) => message.role === "tool").map((message) => message.content),
    ).toEqual(names);
  });

  it.each([
    [false, true],
    [true, false],
    [true, undefined],
  ])("serializes tools without both concurrency permissions (%s, %s)", async (safe, permitted) => {
    let active = 0;
    let peak = 0;
    const run = async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return "done";
    };
    const wire = fake([calls(call("a"), call("b")), text("Done")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("a", run, { safe }), tool("b", run, { safe })],
    });
    await agent.run("Read", {
      host: permitted === undefined ? {} : { canRunConcurrently: () => permitted },
    });
    expect(peak).toBe(1);
  });

  it("stops on caller abort before the first call and during a tool invocation", async () => {
    const controller = new AbortController();
    const later = vi.fn(async () => "must not run");
    const wire = fake([calls(call("first"), call("later"))]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [
        tool("first", async () => {
          controller.abort("stop");
          await Promise.resolve();
          return "done";
        }),
        tool("later", later),
      ],
    });
    const result = await agent.run("Work", { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(later).not.toHaveBeenCalled();
    expect(wire.requests).toBe(1);
    expect(result.history).toHaveLength(2);
    const cancelled = await agent.run("Work", { signal: controller.signal });
    expect(cancelled.status).toBe("cancelled");
    expect(wire.requests).toBe(1);
  });

  it("applies wall time even when a provider ignores cancellation", async () => {
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    const provider: Provider = {
      id: "blocked",
      model: "blocked",
      async *createStream(_history, _tools, options) {
        observed = options?.signal;
        await new Promise<void>(() => {});
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const pending = defineAgent({ ...base, provider, limits: { elapsedMs: 10 } }).run("Wait");
    await vi.advanceTimersByTimeAsync(11);
    const result = await pending;
    expect(result).toMatchObject({ status: "limited", limit: "elapsedMs" });
    expect(observed?.aborted).toBe(true);
    expect(result.snapshot.models[0]?.status).toBe("running");
  });

  it.each(["turns", "toolCalls"] as const)("admits no work past the %s limit", async (limit) => {
    const run = vi.fn(async () => "done");
    const wire = fake([
      calls(
        call("read", "{}", "first"),
        ...(limit === "toolCalls" ? [call("read", "{}", "second")] : []),
      ),
    ]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("read", run, { safe: true })],
      limits: { [limit]: 1 },
    });
    expect(await agent.run("Read", { host: { canRunConcurrently: () => true } })).toMatchObject({
      status: "limited",
      limit,
    });
    expect(wire.requests).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("suspends exact calls and accepts only host-authenticated, single-use decisions", async () => {
    const write = vi.fn(async (context: ToolContext) => {
      expect(context.callId).toBe("wire-exact");
      return "written";
    });
    const wire = fake([
      calls(call("write", '{"nested":{"key":"value"}}', "wire-exact")),
      text("Written"),
    ]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("write", write, { approval: true })],
    });
    let authoritative: RunSnapshot | undefined;
    let consumed = false;
    const recheck = vi.fn();
    const host: AgentHost & { authorizeResume: NonNullable<AgentHost["authorizeResume"]> } = {
      checkpoint(snapshot) {
        authoritative = structuredClone(snapshot);
      },
      authorizeResume(snapshot) {
        expect(Object.isFrozen(snapshot.state)).toBe(true);
        if (JSON.stringify(snapshot) !== JSON.stringify(authoritative))
          throw new Error("Stale or unauthorized snapshot");
      },
      approvalContext(request) {
        expect(Object.isFrozen(request.arguments.nested)).toBe(true);
        return {
          actorId: "actor",
          resource: { id: "record", version: "4" },
          expiresAt: Date.now() + 60_000,
        };
      },
      resolveApproval(approval, decision) {
        expect(Object.isFrozen(approval.scope.resource)).toBe(true);
        expect(approval.request.call.id).toBe("wire-exact");
        if (decision !== "signed-ticket") return "pending";
        if (consumed) throw new Error("Decision already consumed");
        consumed = true;
        return "approved";
      },
      beforeTool(request, approval) {
        recheck(request.operationId);
        expect(approval?.scope.resource.version).toBe("4");
        expect(Object.isFrozen(request.call)).toBe(true);
      },
    };
    const suspended = await agent.run("Write", { host });
    expect(suspended.status).toBe("suspended");
    expect(write).not.toHaveBeenCalled();
    const corrupted = structuredClone(suspended.snapshot);
    const model = corrupted.models[0];
    const pendingCall =
      model?.status === "completed" ? model.turn.message.toolCalls?.[0] : undefined;
    if (!pendingCall || corrupted.state.status !== "suspended")
      throw new Error("Expected a pending approval");
    pendingCall.arguments = '{"nested":';
    corrupted.state.approval.request.call.arguments = pendingCall.arguments;
    corrupted.state.approval.request.arguments = {};
    const unauthorized = vi.fn();
    await expect(
      agent.resume(corrupted, { host: { authorizeResume: unauthorized } }),
    ).rejects.toThrow("approval does not match");
    expect(unauthorized).not.toHaveBeenCalled();
    const pending = await agent.resume(JSON.parse(JSON.stringify(suspended.snapshot)), {
      host,
      decision: true,
    });
    expect(pending.status).toBe("suspended");
    expect(write).not.toHaveBeenCalled();
    const result = await agent.resume(pending.snapshot, { host, decision: "signed-ticket" });
    expect(result.status).toBe("completed");
    expect(consumed).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledWith(`${suspended.runId}/model/1/tool/1`);
    await expect(
      agent.resume(pending.snapshot, { host, decision: "signed-ticket" }),
    ).rejects.toThrow("Stale");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["denied", "completed"],
    ["revoked", "failed"],
    ["expired", "failed"],
    ["expired at tool start", "failed"],
    ["elapsed", "limited"],
  ] as const)("does not invoke a write when approval is %s", async (reason, expectedStatus) => {
    vi.useFakeTimers();
    const write = vi.fn(async () => "written");
    const wire = fake([calls(call("write")), text("No action taken")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("write", write, { approval: true })],
      limits: { elapsedMs: 100 },
    });
    const resolveApproval = vi.fn(() =>
      reason === "denied" ? ("denied" as const) : ("approved" as const),
    );
    const host = {
      authorizeResume,
      resolveApproval,
      approvalContext: () => ({
        actorId: "actor",
        resource: { id: "record", version: "1" },
        expiresAt: Date.now() + 5,
      }),
      beforeTool() {
        if (reason === "revoked") throw new Error("Access revoked");
      },
    };
    const suspended = await agent.run("Write", { host });
    if (reason === "expired" || reason === "elapsed")
      await vi.advanceTimersByTimeAsync(reason === "expired" ? 6 : 101);
    const result = await agent.resume(suspended.snapshot, {
      host,
      decision: "ticket",
      onEvent(event) {
        if (reason === "expired at tool start" && event.type === "tool_start")
          vi.setSystemTime(Date.now() + 6);
      },
    });
    expect(result.status).toBe(expectedStatus);
    expect(write).not.toHaveBeenCalled();
    if (reason === "expired" || reason === "elapsed")
      expect(resolveApproval).not.toHaveBeenCalled();
    if (reason === "denied")
      expect(result.history[3]).toMatchObject({
        role: "tool",
        content: expect.stringContaining("denied"),
      });
  });

  it.each(["model", "tool"] as const)(
    "refuses an interrupted %s operation instead of replaying it",
    async (kind) => {
      const effect = vi.fn(async () => "effect happened");
      const wire = fake([kind === "model" ? text("Done") : calls(call("write"))]);
      const agent = defineAgent({
        ...base,
        provider: wire.provider,
        tools: [tool("write", effect)],
      });
      let durable: RunSnapshot | undefined;
      const failed = await agent.run("Work", {
        host: {
          checkpoint(snapshot) {
            const last = snapshot.models.at(-1);
            if (
              last?.status === "completed" &&
              (kind === "model" || last.tools[0]?.status === "completed")
            )
              throw new Error("Storage unavailable");
            durable = structuredClone(snapshot);
          },
        },
      });
      expect(failed).toMatchObject({ status: "failed", error: { code: "checkpoint_failed" } });
      const restored = await agent.resume(saved(durable), { host: { authorizeResume } });
      expect(restored).toMatchObject({
        status: "failed",
        error: { code: "interrupted_operation" },
      });
      expect(wire.requests).toBe(1);
      expect(effect).toHaveBeenCalledTimes(kind === "model" ? 0 : 1);
      expect(restored.receipts.some((receipt) => receipt.status === "running")).toBe(true);
    },
  );

  it.each(["model", "tool"] as const)(
    "does not begin a %s effect when its checkpoint fails",
    async (kind) => {
      const effect = vi.fn(async () => "written");
      const wire = fake([calls(call("write"))]);
      const agent = defineAgent({
        ...base,
        provider: wire.provider,
        tools: [tool("write", effect)],
      });
      const result = await agent.run("Work", {
        host: {
          checkpoint(snapshot) {
            const last = snapshot.models.at(-1);
            if (
              kind === "model" ||
              (last?.status === "completed" && last.tools[0]?.status === "running")
            )
              throw new Error("Cannot save");
          },
        },
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "checkpoint_failed" } });
      expect(wire.requests).toBe(kind === "model" ? 0 : 1);
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("rejects wrong definitions, corrupt journals and unauthorized resumes before work", async () => {
    const wire = fake([text("Done")]);
    const agent = defineAgent({ ...base, provider: wire.provider });
    const result = await agent.run("Work");
    const corruptions: RunSnapshot[] = [
      { ...result.snapshot, version: "other" },
      { ...result.snapshot, agentId: "other" },
      { ...result.snapshot, state: { status: "completed", candidate: "forged" } },
      { ...result.snapshot, limits: { ...result.snapshot.limits, turns: 100 } },
      {
        ...result.snapshot,
        models: result.snapshot.models.map((model) => ({ ...model, id: "wrong-operation" })),
      },
      {
        ...result.snapshot,
        models: result.snapshot.models.map((model) => ({
          ...model,
          usage: { ...usage, inputTokens: Number.NaN },
        })),
      },
    ];
    const authorize = vi.fn();
    for (const corrupted of corruptions)
      await expect(
        agent.resume(corrupted, { host: { authorizeResume: authorize } }),
      ).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled();
    await expect(
      agent.resume(result.snapshot, {
        host: {
          authorizeResume() {
            throw new Error("Not authorized");
          },
        },
      }),
    ).rejects.toThrow("Not authorized");
    expect(wire.requests).toBe(1);
  });
});
