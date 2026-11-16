import { evidenceFor } from "./fixtures/requests.ts";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  defineTool,
  type ChatMessage,
  type Provider,
  type ProviderChunk,
  type StreamOptions,
  type ToolDefinition,
  type ToolSpec,
} from "@providerkit/core";
import {
  defineAgent,
  RESULT_TOOL_NAME,
  type AgentHost,
  type ModelSettings,
  type RunContext,
  type RunSnapshot,
} from "../src/index.ts";

const base = { id: "definition", version: "1", instructions: "Answer the question." };
const usage = { inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 };
const authorizeResume = () => {};
const approval: AgentHost = {
  prepareRequest: () => ({
    scope: {
      actorId: "actor",
      resource: { id: "record", version: "1" },
      expiresAt: Date.now() + 60_000,
    },
  }),
  beforeTool: () => {},
  resolveRequest: () => ({ type: "approve" }),
};

function text(content = "Done"): ProviderChunk[] {
  return [
    { type: "delta", content },
    { type: "finish", finishReason: "stop" },
    { type: "usage", usage },
  ];
}

function calls(...names: string[]): ProviderChunk[] {
  return [
    {
      type: "delta",
      toolCalls: names.map((name, index) => ({
        index,
        id: `wire-${index}`,
        name,
        arguments: "{}",
      })),
    },
    { type: "finish", finishReason: "tool_calls" },
    { type: "usage", usage },
  ];
}

function fake(turns: ProviderChunk[][]) {
  const requests: { messages: ChatMessage[]; tools: ToolDefinition[]; options: StreamOptions }[] =
    [];
  const provider: Provider = {
    id: "fake",
    model: "default-model",
    async *createStream(messages, tools, options = {}) {
      const chunks = turns[requests.length];
      requests.push({
        messages: structuredClone(messages),
        tools: structuredClone(tools),
        options,
      });
      if (!chunks) throw new Error("Unexpected model request");
      options.onActivity?.();
      options.onRateLimit?.({ utilization: 0.5, window: "5h", resetAtMs: 100 });
      yield* chunks;
    },
  };
  return { provider, requests };
}

function tool(name: string, spec: Partial<Omit<ToolSpec<unknown, unknown>, "name">> = {}) {
  return defineTool({
    name,
    description: name,
    inputSchema: { type: "object" },
    run: async () => name,
    summarize: (value) => String(value),
    ...spec,
  });
}

function saved(snapshot: RunSnapshot | undefined): RunSnapshot {
  if (!snapshot) throw new Error("Expected a saved snapshot");
  return snapshot;
}

function objectResult(value: unknown): { count: number } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("count" in value) ||
    typeof value.count !== "number"
  )
    throw new Error("count must be a number");
  return { count: value.count };
}

const output = { schema: { type: "object" as const }, validate: objectResult };

describe("model settings", () => {
  it("uses core's settings type and applies run over agent over provider defaults on every call", async () => {
    expectTypeOf<ModelSettings>().toEqualTypeOf<
      Omit<StreamOptions, "signal" | "sessionId" | "json">
    >();
    const wire = fake([calls("read"), text()]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("read")],
      modelSettings: { maxTokens: 500, temperature: 0.4, effort: "high", stopSequences: ["END"] },
    });
    const result = await agent.run("Read", {
      runId: "one-run",
      modelSettings: {
        maxTokens: 50,
        effort: "none",
        temperature: 0,
        parallelToolCalls: false,
        model: "chosen-model",
      },
    });
    expect(result.status).toBe("completed");
    expect(result.snapshot.definition.modelSettings).toEqual({
      maxTokens: 50,
      effort: "none",
      temperature: 0,
      parallelToolCalls: false,
      model: "chosen-model",
      stopSequences: ["END"],
    });
    expect(wire.requests).toHaveLength(2);
    for (const { options } of wire.requests) {
      expect({ maxAttempts: 3, ...options }).toMatchObject({
        maxAttempts: 3,
        maxTokens: 50,
        temperature: 0,
        effort: "none",
        stopSequences: ["END"],
        parallelToolCalls: false,
        model: "chosen-model",
        sessionId: "one-run",
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.json).toBeUndefined();
    }
  });

  it("copies mutable settings and treats undefined as inherit, not erase", async () => {
    const wire = fake([text()]);
    const stops = ["END"];
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      modelSettings: { maxTokens: 100, stopSequences: stops },
    });
    stops[0] = "MUTATED";
    await agent.run("Answer", { modelSettings: { maxTokens: undefined } });
    expect(wire.requests[0]?.options).toMatchObject({ maxTokens: 100, stopSequences: ["END"] });
  });

  it("keeps observer callbacks live and outside the JSON snapshot", async () => {
    const wire = fake([text()]);
    const agentActivity = vi.fn();
    const runActivity = vi.fn();
    const rateLimit = vi.fn();
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      modelSettings: { onActivity: agentActivity, onRateLimit: rateLimit },
    });
    const result = await agent.run("Answer", { modelSettings: { onActivity: runActivity } });
    expect(runActivity).toHaveBeenCalledOnce();
    expect(agentActivity).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledOnce();
    expect(result.snapshot.definition.modelSettings).toEqual({});
    await expect(
      agent.resume(JSON.parse(JSON.stringify(result.snapshot)), { host: { authorizeResume } }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it.each([
    { maxTokens: 0 },
    { maxTokens: Infinity },
    { maxAttempts: -1 },
    { effort: "unsupported" },
    { toolChoice: { name: "read", extra: true } },
    { topP: 2 },
    { stopSequences: [1] },
    { signal: new AbortController().signal },
    { sessionId: "other" },
    { json: {} },
    { unknown: 1 },
  ])("refuses invalid or loop-owned settings before work (%j)", async (modelSettings) => {
    const wire = fake([text()]);
    const agent = defineAgent({ ...base, provider: wire.provider });
    // Runtime rejection is also required for JavaScript callers, not just typed hosts.
    await expect(Reflect.apply(agent.run, agent, ["Answer", { modelSettings }])).rejects.toThrow(
      "modelSettings",
    );
    expect(wire.requests).toHaveLength(0);
  });

  it("uses saved settings on resume and refuses new overrides", async () => {
    const wire = fake([calls("write"), text()]);
    const write = tool("write", { needsApproval: true });
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [write],
      modelSettings: { maxTokens: 100 },
    });
    const pending = await agent.run("Write", { modelSettings: { maxTokens: 25 }, host: approval });
    expect(pending.status).toBe("suspended");
    const rebuilt = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [write],
      modelSettings: { maxTokens: 900 },
    });
    await expect(
      rebuilt.resume(pending.snapshot, {
        host: { ...approval, authorizeResume },
        answers: evidenceFor(pending.snapshot, "ticket"),
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(wire.requests[1]?.options.maxTokens).toBe(25);
    await expect(
      rebuilt.resume(pending.snapshot, { host: { authorizeResume }, ...{ modelSettings: {} } }),
    ).rejects.toThrow("when a run starts");
  });
});

describe("tool choice and turn limit", () => {
  it.each(["required", { name: "read" }] as const)(
    "resets a forced choice after tool use (%j)",
    async (toolChoice) => {
      const wire = fake([calls("read"), text()]);
      await defineAgent({
        ...base,
        provider: wire.provider,
        tools: [tool("read")],
        modelSettings: { toolChoice },
      }).run("Read");
      expect(wire.requests.map((request) => request.options.toolChoice)).toEqual([
        toolChoice,
        "auto",
      ]);
    },
  );

  it("resets after an invalid tool call, and after approval resume, without resetting none", async () => {
    const failed = fake([calls("made_up"), text()]);
    await defineAgent({
      ...base,
      provider: failed.provider,
      tools: [tool("read")],
      modelSettings: { toolChoice: "required" },
    }).run("Read");
    expect(failed.requests[1]?.options.toolChoice).toBe("auto");
    const wire = fake([calls("write"), text()]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("write", { needsApproval: true })],
      modelSettings: { toolChoice: { name: "write" } },
    });
    const pending = await agent.run("Write", { host: approval });
    await agent.resume(pending.snapshot, {
      host: { ...approval, authorizeResume },
      answers: evidenceFor(pending.snapshot, "ticket"),
    });
    expect(wire.requests[1]?.options.toolChoice).toBe("auto");
    const run = vi.fn(async () => "must not run");
    const none = fake([calls("read"), text()]);
    const result = await defineAgent({
      ...base,
      provider: none.provider,
      tools: [tool("read", { run })],
      modelSettings: { toolChoice: "none" },
    }).run("Answer");
    expect(result.status).toBe("completed");
    expect(none.requests.map((request) => request.options.toolChoice)).toEqual(["none", "none"]);
    expect(run).not.toHaveBeenCalled();
  });

  it("makes exactly one tool-free final call and counts its usage", async () => {
    const wire = fake([calls("read"), text("Answer from the last call")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("read")],
      limits: { turns: 1 },
      modelSettings: { toolChoice: "required", maxTokens: 50 },
    });
    const result = await agent.run("Read");
    expect(result).toMatchObject({
      status: "completed",
      output: "Answer from the last call",
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    expect(wire.requests[1]?.tools).toEqual([]);
    expect(wire.requests[1]?.options).toMatchObject({ toolChoice: "none", maxTokens: 50 });
    await expect(
      agent.resume(result.snapshot, { host: { authorizeResume } }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(wire.requests).toHaveLength(2);
  });

  it("does not execute a tool returned on the final call, and restores that limited result", async () => {
    const run = vi.fn(async () => "read");
    const wire = fake([calls("read"), calls("read")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("read", { run })],
      limits: { turns: 1 },
    });
    const result = await agent.run("Read");
    expect(result).toMatchObject({ status: "limited", limit: "turns" });
    expect(run).toHaveBeenCalledOnce();
    await expect(
      agent.resume(result.snapshot, { host: { authorizeResume } }),
    ).resolves.toMatchObject({ status: "limited", limit: "turns" });
    expect(wire.requests).toHaveLength(2);
  });

  it("never buys the final call past a tree budget, or without the checked-result tool", async () => {
    const wire = fake([calls("read")]);
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("read")],
      limits: { turns: 1 },
      treeLimits: { modelCalls: 1 },
    }).run("Read");
    expect(result).toMatchObject({ status: "limited", limit: "modelCalls" });
    expect(wire.requests).toHaveLength(1);
    const checked = fake([calls("read")]);
    expect(
      await defineAgent({
        ...base,
        provider: checked.provider,
        tools: [tool("read")],
        output,
        limits: { turns: 1 },
      }).run("Read"),
    ).toMatchObject({ status: "limited", limit: "turns" });
    expect(checked.requests).toHaveLength(1);
  });
});

describe("definition resolved once", () => {
  it("resolves from the prepared conversation and host context, then freezes the result", async () => {
    const wire = fake([calls("read"), text()]);
    const service = new Map([["locale", "en"]]);
    const instructions = vi.fn(async (run: RunContext) => {
      expect(run).toMatchObject({
        agentId: "definition",
        version: "1",
        runId: "dynamic",
        input: "New turn",
      });
      expect(run.history).toEqual([{ role: "user", content: "Prepared" }]);
      expect(Object.isFrozen(run.history)).toBe(true);
      expect(run.context.service).toBe(service);
      expect(run.signal).toBeInstanceOf(AbortSignal);
      return `Reply in ${service.get("locale")}.`;
    });
    const enabledTools = vi.fn(async (run: RunContext) => {
      expect(run.context.service).toBe(service);
      return ["read"];
    });
    const agent = defineAgent({
      ...base,
      instructions,
      provider: wire.provider,
      tools: [tool("read"), tool("write")],
      enabledTools,
    });
    const result = await agent.run(
      {
        messages: [
          { role: "user", content: "Earlier" },
          { role: "user", content: "New turn" },
        ],
      },
      {
        runId: "dynamic",
        context: { service },
        prepareHistory: () => [{ role: "user", content: "Prepared" }],
      },
    );
    expect(result.status).toBe("completed");
    expect(instructions).toHaveBeenCalledOnce();
    expect(enabledTools).toHaveBeenCalledOnce();
    expect(result.snapshot.definition).toMatchObject({
      instructions: "Reply in en.",
      enabledTools: ["read"],
    });
    expect(wire.requests.every((request) => request.messages[0]?.content === "Reply in en.")).toBe(
      true,
    );
    expect(
      wire.requests.every((request) => request.tools.map((tool) => tool.name).join() === "read"),
    ).toBe(true);
  });

  it("never calls definition functions again on resume, even when the host context changes", async () => {
    const wire = fake([calls("write"), text()]);
    const write = tool("write", { needsApproval: true });
    const instructions = vi.fn((run: RunContext) => `Reply in ${run.context.locale}.`);
    const enabledTools = vi.fn(() => ["write"]);
    const agent = defineAgent({
      ...base,
      instructions,
      enabledTools,
      provider: wire.provider,
      tools: [write],
    });
    const pending = await agent.run("Write", { host: approval, context: { locale: "en" } });
    const rebuilt = defineAgent({
      ...base,
      instructions: () => {
        throw new Error("must not run");
      },
      enabledTools: () => {
        throw new Error("must not run");
      },
      provider: wire.provider,
      tools: [write],
    });
    const result = await rebuilt.resume(JSON.parse(JSON.stringify(pending.snapshot)), {
      context: { locale: "es" },
      host: { ...approval, authorizeResume },
      answers: evidenceFor(pending.snapshot, "ticket"),
    });
    expect(result.status).toBe("completed");
    expect(wire.requests[1]?.messages[0]).toEqual({ role: "system", content: "Reply in en." });
    expect(instructions).toHaveBeenCalledOnce();
    expect(enabledTools).toHaveBeenCalledOnce();
  });

  it("hides and refuses disabled tools, including delegations and approval-required tools", async () => {
    const run = vi.fn(async () => "must not run");
    const childWire = fake([text()]);
    const child = defineAgent({ ...base, id: "child", provider: childWire.provider });
    const wire = fake([calls("write", "review", "read"), text()]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [
        tool("write", { run, needsApproval: true }),
        child.asTool({ name: "review", description: "Review" }),
        tool("read"),
      ],
      enabledTools: ["read"],
    });
    const prepareRequest = vi.fn(approval.prepareRequest);
    const result = await agent.run("Read", {
      host: { prepareRequest, canRunConcurrently: () => true },
    });
    expect(result.status).toBe("completed");
    expect(wire.requests[0]?.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(result.receipts.filter((receipt) => receipt.kind === "tool")).toMatchObject([
      { result: { ok: false, kind: "disabled_tool" } },
      { result: { ok: false, kind: "disabled_tool" } },
      { result: { ok: true } },
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(prepareRequest).not.toHaveBeenCalled();
    expect(childWire.requests).toHaveLength(0);
    await expect(
      agent.resume(result.snapshot, { host: { authorizeResume } }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("narrows agent tools, preserves definition order, and keeps submit_result", async () => {
    const wire = fake([calls(RESULT_TOOL_NAME)]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      output: { schema: { type: "object" }, validate: () => 42 },
      tools: [tool("read"), tool("write"), tool("lookup")],
      enabledTools: ["lookup", "read"],
    });
    const result = await agent.run("Answer", { enabledTools: ["lookup", "read"] });
    expect(result).toMatchObject({ status: "completed", output: 42 });
    expect(wire.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read",
      "lookup",
      RESULT_TOOL_NAME,
    ]);
    await expect(agent.run("Answer", { enabledTools: ["write"] })).rejects.toThrow(
      "not enable a disabled tool",
    );
    await expect(agent.run("Answer", { enabledTools: ["missing"] })).rejects.toThrow(
      "registered tool",
    );
    await expect(agent.run("Answer", { enabledTools: ["read", "read"] })).rejects.toThrow(
      "unique tool names",
    );
    await expect(
      agent.run("Answer", { enabledTools: [], modelSettings: { toolChoice: { name: "read" } } }),
    ).rejects.toThrow("enabled tool");
    await expect(agent.run("Answer", { modelSettings: { toolChoice: "none" } })).rejects.toThrow(
      "disables submit_result",
    );
  });

  it("records an empty tool set and refuses required with no tools", async () => {
    const wire = fake([text()]);
    const agent = defineAgent({ ...base, provider: wire.provider, tools: [tool("read")] });
    const result = await agent.run("Answer", { enabledTools: [] });
    expect(wire.requests[0]?.tools).toEqual([]);
    expect(result.snapshot.definition.enabledTools).toEqual([]);
    await expect(
      agent.run("Answer", { enabledTools: [], modelSettings: { toolChoice: "required" } }),
    ).rejects.toThrow("required needs at least one");
    await expect(
      agent.resume(result.snapshot, { host: { authorizeResume }, ...{ enabledTools: [] } }),
    ).rejects.toThrow("when a run starts");
  });

  it("fails invalid definition callbacks before a checkpoint or provider call", async () => {
    const wire = fake([text()]);
    const checkpoint = vi.fn();
    const badInstructions = defineAgent({
      ...base,
      provider: wire.provider,
      instructions: async () => {
        throw new Error("No instructions");
      },
    });
    await expect(badInstructions.run("Answer", { host: { checkpoint } })).rejects.toThrow(
      "No instructions",
    );
    const badTools = defineAgent({
      ...base,
      provider: wire.provider,
      enabledTools: async () => ["missing"],
    });
    await expect(badTools.run("Answer", { host: { checkpoint } })).rejects.toThrow(
      "registered tool",
    );
    expect(checkpoint).not.toHaveBeenCalled();
    expect(wire.requests).toHaveLength(0);
  });

  it("does not let a host cache change a child's recorded definition", async () => {
    const childWire = fake([text("Child done")]);
    const child = defineAgent({ ...base, id: "child", provider: childWire.provider });
    const wire = fake([
      [
        {
          type: "delta",
          toolCalls: [
            { index: 0, id: "child-call", name: "review", arguments: '{"input":"Review"}' },
          ],
        },
        { type: "finish", finishReason: "tool_calls" },
      ],
    ]);
    const parent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [child.asTool({ name: "review", description: "Review" })],
    });
    const result = await parent.run("Review", {
      host: {
        async child(_request, execute) {
          const envelope = await execute();
          envelope.snapshot.definition.instructions = "Other instructions.";
          return envelope;
        },
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("different child") },
    });
    expect(wire.requests).toHaveLength(1);
  });

  it("resolves children once and does not inherit the parent's run overrides", async () => {
    const childWire = fake([calls("write"), text("Child done")]);
    const instructions = vi.fn((run: RunContext) => `Child locale: ${run.context.locale}`);
    const enabledTools = vi.fn(() => ["write"]);
    const child = defineAgent({
      ...base,
      id: "child",
      instructions,
      enabledTools,
      provider: childWire.provider,
      tools: [tool("write", { needsApproval: true })],
      modelSettings: { maxTokens: 80 },
    });
    const wire = fake([
      [
        {
          type: "delta",
          toolCalls: [
            { index: 0, id: "child-call", name: "review", arguments: '{"input":"Review"}' },
          ],
        },
        { type: "finish", finishReason: "tool_calls" },
      ],
      text(),
    ]);
    const parent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [child.asTool({ name: "review", description: "Review" })],
    });
    const pending = await parent.run("Review", {
      host: approval,
      context: { locale: "en" },
      modelSettings: { maxTokens: 20 },
      enabledTools: ["review"],
    });
    expect(pending.status).toBe("suspended");
    const result = await parent.resume(pending.snapshot, {
      host: { ...approval, authorizeResume },
      context: { locale: "es" },
      answers: evidenceFor(pending.snapshot, "ticket"),
    });
    expect(result.status).toBe("completed");
    expect(instructions).toHaveBeenCalledOnce();
    expect(enabledTools).toHaveBeenCalledOnce();
    expect(childWire.requests.map((request) => request.options.maxTokens)).toEqual([80, 80]);
    expect(childWire.requests[1]?.messages[0]?.content).toBe("Child locale: en");
  });
});

describe("ending on a tool result", () => {
  it("uses the stopping tool's summary and never asks the model to rewrite it", async () => {
    const run = vi.fn(async () => ({ count: 2 }));
    const wire = fake([calls("lookup")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("lookup", { run, summarize: () => "Two matches" })],
      stopAtTools: ["lookup"],
    });
    const result = await agent.run("Find matches");
    expect(result).toMatchObject({ status: "completed", output: "Two matches" });
    expect(wire.requests).toHaveLength(1);
    await expect(
      agent.resume(result.snapshot, { host: { authorizeResume } }),
    ).resolves.toMatchObject({ status: "completed", output: "Two matches" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("validates and journals a stopping tool's raw output, not its summary or transformed value", async () => {
    const run = vi.fn(async () => ({ count: 2 }));
    const wire = fake([calls("lookup")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("lookup", { run, summarize: () => "Two matches" })],
      stopAtTools: ["lookup"],
      output: { ...output, validate: (value) => ({ doubled: objectResult(value).count * 2 }) },
    });
    const result = await agent.run("Find matches");
    if (result.status !== "completed") throw new Error(result.status);
    expectTypeOf(result.output).toEqualTypeOf<{ doubled: number }>();
    expect(result.output).toEqual({ doubled: 4 });
    expect(result.snapshot.state).toEqual({ status: "completed", candidate: { count: 2 } });
    await expect(
      agent.resume(result.snapshot, { host: { authorizeResume } }),
    ).resolves.toMatchObject({ output: { doubled: 4 } });
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([undefined, NaN, new Date(0), () => "not JSON"])(
    "rejects an unsavable stopping candidate (%s) and restores its completed receipt",
    async (candidate) => {
      const run = vi.fn(async () => candidate);
      const wire = fake([calls("write")]);
      const agent = defineAgent({
        ...base,
        provider: wire.provider,
        tools: [tool("write", { run, summarize: () => "Written" })],
        stopAtTools: ["write"],
        output: { schema: { type: "object" }, validate: () => ({ done: true }) },
        limits: { turns: 1 },
      });
      let durable: RunSnapshot | undefined;
      const result = await agent.run("Write once", {
        host: {
          checkpoint(snapshot) {
            if (snapshot.state.status === "running") durable = structuredClone(snapshot);
          },
        },
      });
      expect(result).toMatchObject({ status: "limited", limit: "turns" });
      expect(result.snapshot.models[0]).toMatchObject({
        tools: [{ status: "completed", result: { ok: false, kind: "invalid_output" } }],
      });
      await expect(
        agent.resume(JSON.parse(JSON.stringify(saved(durable))), { host: { authorizeResume } }),
      ).resolves.toMatchObject({ status: "limited", limit: "turns" });
      expect(run).toHaveBeenCalledOnce();
      expect(wire.requests).toHaveLength(1);
    },
  );

  it("lets a host terminal tool finish without submit_result, and requires it alone", async () => {
    const run = vi.fn(async () => ({ count: 3 }));
    const wire = fake([calls("finish", "read"), calls("finish")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("finish", { run, isTerminal: true }), tool("read")],
      output,
    });
    const result = await agent.run("Count");
    expect(result).toMatchObject({ status: "completed", output: { count: 3 } });
    expect(result.snapshot.definition.stopAtTools).toEqual(["finish"]);
    expect(run).toHaveBeenCalledOnce();
    expect(wire.requests[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("Call finish alone"),
      }),
    );
  });

  it("sends a failed or invalid stopping result back to the model, not out as success", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("lookup failed"))
      .mockResolvedValueOnce({ count: "wrong" })
      .mockResolvedValueOnce({ count: 2 });
    const wire = fake([calls("lookup"), calls("lookup"), calls("lookup")]);
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("lookup", { run })],
      stopAtTools: ["lookup"],
      output,
    }).run("Count");
    expect(result).toMatchObject({ status: "completed", output: { count: 2 } });
    expect(wire.requests[1]?.messages.at(-1)?.content).toContain("lookup failed");
    expect(wire.requests[2]?.messages.at(-1)?.content).toContain("count must be a number");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("settles every call in the batch and selects the first stopping tool in model order", async () => {
    const order: string[] = [];
    const release = Promise.withResolvers<void>();
    const wire = fake([calls("first", "second", "other")]);
    const tools = ["first", "second", "other"].map((name) =>
      tool(name, {
        isConcurrencySafe: true,
        run: async () => {
          if (name === "first") await release.promise;
          if (name === "second") release.resolve();
          order.push(name);
          return name;
        },
      }),
    );
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      tools,
      stopAtTools: ["second", "first"],
    }).run("Read", { host: { canRunConcurrently: () => true } });
    expect(result).toMatchObject({ status: "completed", output: "first" });
    expect(order).toHaveLength(3);
    expect(order.indexOf("second")).toBeLessThan(order.indexOf("first"));
    expect(result.history.filter((message) => message.role === "tool")).toHaveLength(3);
  });

  it("recovers after saving a final tool result but before saving the completed run", async () => {
    const run = vi.fn(async () => "Receipt");
    const wire = fake([calls("finish")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("finish", { run })],
      stopAtTools: ["finish"],
    });
    let durable: RunSnapshot | undefined;
    await agent.run("Finish", {
      host: {
        checkpoint(snapshot) {
          if (snapshot.state.status !== "running") throw new Error("Worker stopped");
          durable = structuredClone(snapshot);
        },
      },
    });
    expect(saved(durable).models[0]).toMatchObject({
      tools: [{ status: "completed", result: { final: { candidate: "Receipt" } } }],
    });
    await expect(
      agent.resume(saved(durable), { host: { authorizeResume } }),
    ).resolves.toMatchObject({ status: "completed", output: "Receipt" });
    expect(wire.requests).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects an output candidate that disagrees with the stopping tool's receipt", async () => {
    const wire = fake([calls("finish")]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("finish")],
      stopAtTools: ["finish"],
    });
    const result = await agent.run("Finish");
    const authorize = vi.fn();
    await expect(
      agent.resume(
        { ...result.snapshot, state: { status: "completed", candidate: "forged" } },
        { host: { authorizeResume: authorize } },
      ),
    ).rejects.toThrow("recorded turn");
    expect(authorize).not.toHaveBeenCalled();
    expect(() =>
      defineAgent({ ...base, provider: wire.provider, stopAtTools: ["missing"] }),
    ).toThrow("ordinary tools");
  });
});
