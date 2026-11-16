import { afterEach, describe, expect, it, vi } from "vitest";
import { defineTool, ProviderError, type Provider, type ProviderChunk } from "@providerkit/core";
import {
  defineAgent,
  type Agent,
  type AgentEvent,
  type AgentHost,
  type RunLimits,
  type RunSnapshot,
} from "../src/index.ts";
import { AGENT_RUNTIME } from "../src/delegation.ts";
import { checkChildProgress } from "../src/snapshot.ts";

const base = { id: "worker", version: "1", instructions: "Answer the request." };
const usage = { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 };
const recovery = { identity: "inference-v1", inferenceOnly: true, maxAttempts: 3 };
const authorizeResume = () => {};
const text = (content = "done"): ProviderChunk[] => [
  { type: "delta", content },
  { type: "usage", usage },
  { type: "finish", finishReason: "stop" },
];
const calls = (...names: string[]): ProviderChunk[] => [
  {
    type: "delta",
    toolCalls: names.map((name, index) => ({ index, id: `call-${index}`, name, arguments: "{}" })),
  },
  { type: "usage", usage },
  { type: "finish", finishReason: "tool_calls" },
];
function wire(turns: ProviderChunk[][]) {
  const sent = vi.fn();
  const provider: Provider = {
    id: "fake",
    model: "fake",
    async *createStream(messages, tools, settings) {
      const chunks = turns[sent.mock.calls.length];
      sent(structuredClone(messages), structuredClone(tools), settings);
      if (!chunks) throw new Error("Unexpected model request");
      yield* chunks;
    },
  };
  return { provider, sent };
}
function saved(snapshot: RunSnapshot | undefined): RunSnapshot {
  if (!snapshot) throw new Error("Missing checkpoint");
  return structuredClone(snapshot);
}
/** Simulates a process lost after a usage checkpoint, before the turn result is saved. */
function crashModel(
  select: (snapshot: RunSnapshot) => RunSnapshot | undefined = (snapshot) => snapshot,
  ignoreAttemptId?: string,
) {
  let durable: RunSnapshot | undefined;
  const host: AgentHost & { authorizeResume: typeof authorizeResume } = {
    authorizeResume,
    checkpoint(snapshot) {
      const node = select(snapshot);
      const model = node?.models.at(-1);
      if (model?.status === "completed") throw new Error("Lost worker");
      durable = saved(snapshot);
      if (
        model &&
        model.attemptId !== ignoreAttemptId &&
        model.attemptId === node?.attemptId &&
        model.usage.inputTokens > 0
      )
        throw new Error("Lost worker");
    },
  };
  return { host, snapshot: () => saved(durable) };
}
function parentFor(child: Agent<unknown>, treeLimits = {}) {
  const model = wire([
    [
      {
        type: "finish",
        finishReason: "tool_calls",
        toolCalls: [{ index: 0, id: "child", name: "child", arguments: '{"input":"Review"}' }],
      },
    ],
    text("Parent answer"),
  ]);
  return {
    ...model,
    agent: defineAgent({
      ...base,
      id: "parent",
      provider: model.provider,
      tools: [child.asTool({ name: "child", description: "Review the work." })],
      treeLimits,
    }),
  };
}
afterEach(() => vi.useRealTimers());

describe("specialist-local failures", () => {
  it.each(["provider", "empty", "outputTokens"] as const)(
    "returns a failed tool result for a local %s failure and keeps its usage",
    async (failure) => {
      const provider: Provider = {
        id: "fake",
        model: "fake",
        async *createStream() {
          yield { type: "usage", usage };
          if (failure === "provider") throw new ProviderError("fake", "network", "Lost reply");
          yield { type: "finish", finishReason: failure === "empty" ? "stop" : "length" };
        },
      };
      const child = defineAgent({ ...base, provider });
      const parentWire = wire([
        [
          {
            type: "finish",
            finishReason: "tool_calls",
            toolCalls: [{ index: 0, id: "child", name: "child", arguments: '{"input":"Review"}' }],
          },
        ],
        text("Answer from other results"),
      ]);
      const parent = defineAgent({
        ...base,
        id: "parent",
        provider: parentWire.provider,
        tools: [child.asTool({ name: "child", description: "Review the work." })],
      });
      const result = await parent.run("Work");
      expect(result).toMatchObject({ status: "completed", output: "Answer from other results" });
      expect(result.receipts.find((r) => r.kind === "delegation")).toMatchObject({
        result: { ok: false, kind: "failed" },
      });
      expect(result.treeUsage.inputTokens).toBe(14);
      const again = await parent.resume(result.snapshot, { host: { authorizeResume } });
      expect(again.treeUsage).toEqual(result.treeUsage);
      expect(parentWire.sent).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["turns", "toolCalls", "elapsedMs"] as const)(
    "keeps the specialist's %s limit local",
    async (limit) => {
      const tool = defineTool({
        name: "read",
        description: "Read",
        inputSchema: { type: "object" },
        run: async () => "read",
      });
      const limits: Partial<RunLimits> = { [limit]: 1 };
      const model = wire([calls("read", "read"), calls("read")]);
      const provider: Provider =
        limit !== "elapsedMs"
          ? model.provider
          : {
              id: "wait",
              model: "fake",
              async *createStream() {
                await new Promise<void>(() => {});
                yield* text();
              },
            };
      const parent = parentFor(defineAgent({ ...base, provider, tools: [tool], limits }));
      if (limit === "elapsedMs") vi.useFakeTimers();
      const work = parent.agent.run("Work");
      if (limit === "elapsedMs") await vi.advanceTimersByTimeAsync(2);
      const result = await work;
      expect(result).toMatchObject({ status: "completed", output: "Parent answer" });
      expect(result.snapshot.delegations[0]?.children[0]?.snapshot.state).toEqual({
        status: "limited",
        limit,
      });
    },
  );

  it.each(["modelCalls", "maxChildren", "maxDepth", "treeElapsedMs"] as const)(
    "does not soften the tree's %s limit",
    async (limit) => {
      const model = wire([text()]);
      const child = defineAgent({ ...base, provider: model.provider });
      const parent = parentFor(
        child,
        limit === "treeElapsedMs" ? { elapsedMs: 1 } : { [limit]: limit === "modelCalls" ? 1 : 0 },
      );
      if (limit === "treeElapsedMs") vi.useFakeTimers();
      const result = await parent.agent.run(
        "Work",
        limit === "treeElapsedMs"
          ? {
              host: {
                checkpoint() {
                  vi.advanceTimersByTime(2);
                },
              },
            }
          : {},
      );
      expect(result).toMatchObject({ status: "limited", limit });
      expect(parent.sent).toHaveBeenCalledTimes(limit === "treeElapsedMs" ? 0 : 1);
      expect(model.sent).not.toHaveBeenCalled();
    },
  );

  it.each([
    "host-error",
    "host-envelope",
    "invalid-usage",
    "unclassified-error",
    "cancel",
  ] as const)("does not soften %s", async (kind) => {
    const model: Provider = {
      id: "fake",
      model: "fake",
      async *createStream() {
        if (kind === "cancel") throw new ProviderError("fake", "aborted", "Stopped");
        if (kind === "unclassified-error") throw new Error("Programming bug");
        if (kind === "invalid-usage") {
          yield { type: "usage", usage: { ...usage, inputTokens: -1 } };
          return;
        }
        yield* calls("read");
      },
    };
    const child = defineAgent({
      ...base,
      provider: model,
      tools: [
        defineTool({
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          run: async () => "read",
        }),
      ],
    });
    const parent = parentFor(child);
    const host: AgentHost =
      kind === "host-error"
        ? {
            beforeTool(request) {
              if (request.call.name === "read")
                throw new ProviderError("fake", "network", "Host contract broke");
            },
          }
        : kind === "host-envelope"
          ? {
              async child(request) {
                return { snapshot: { ...request.snapshot, runId: "forged" } };
              },
            }
          : {};
    const result = await parent.agent.run("Work", { host });
    expect(result.status).toBe(kind === "cancel" ? "cancelled" : "failed");
    expect(parent.sent).toHaveBeenCalledTimes(1);
    expect(result.receipts.find((r) => r.kind === "delegation")?.status).toBe("running");
  });
});

describe("guarded interrupted-operation recovery", () => {
  it("does not call absent usage a reported bill", async () => {
    const agent = defineAgent({
      ...base,
      provider: wire([[{ type: "finish", content: "done", finishReason: "stop" }]]).provider,
    });
    const result = await agent.run("Work");
    expect(result.status).toBe("completed");
    expect(result.receipts[0]).toMatchObject({ status: "completed", billing: "unknown" });
  });
  it("restarts only the interrupted model attempt, retaining measured usage and identity", async () => {
    const model = wire([text("partial"), text("replacement")]);
    const config = { ...base, provider: model.provider, recovery };
    const agent = defineAgent(config);
    const crash = crashModel();
    await agent.run("Work", { host: crash.host });
    const before = crash.snapshot();
    const events: AgentEvent[] = [];
    const result = await agent.resume(before, {
      host: { authorizeResume },
      onEvent: (e) => {
        events.push(e);
      },
    });
    expect(result).toMatchObject({ status: "completed", output: "replacement" });
    expect(result.snapshot.models).toHaveLength(1);
    expect(result.snapshot.models[0]?.id).toBe(before.models[0]?.id);
    expect(result.snapshot.models[0]?.attemptId).not.toBe(before.models[0]?.attemptId);
    expect(result.usage.inputTokens).toBe(14);
    expect(result.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: before.models[0]?.id,
          attemptId: before.models[0]?.attemptId,
          status: "interrupted",
          billing: "unknown",
          usage,
        }),
      ]),
    );
    expect(events[0]).toMatchObject({
      type: "operation_restart",
      operationId: before.models[0]?.id,
      previousAttemptId: before.models[0]?.attemptId,
    });
    expect(model.sent.mock.calls[0]?.[0]).toEqual(model.sent.mock.calls[1]?.[0]);
  });

  it("replays an explicitly allowed read-only tool, not its completed sibling", async () => {
    const first = vi.fn(async () => "kept");
    const read = vi.fn(async () => "read");
    const tools = [
      defineTool({
        name: "first",
        description: "First",
        inputSchema: { type: "object" },
        run: first,
      }),
      defineTool({
        name: "read",
        description: "Read",
        inputSchema: { type: "object" },
        isReadOnly: true,
        run: read,
      }),
    ];
    const model = wire([calls("first", "read"), text()]);
    const config = {
      ...base,
      provider: model.provider,
      tools,
      recovery: { ...recovery, readOnlyTools: ["read"] },
    };
    const agent = defineAgent(config);
    let durable: RunSnapshot | undefined;
    await agent.run("Work", {
      host: {
        checkpoint(snapshot) {
          const last = snapshot.models[0];
          if (last?.status === "completed" && last.tools[1]?.status === "completed")
            throw new Error("Lost result save");
          durable = saved(snapshot);
        },
      },
    });
    const result = await agent.resume(saved(durable), {
      host: { authorizeResume, beforeTool() {} },
    });
    expect(result.status).toBe("completed");
    expect(first).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(model.sent).toHaveBeenCalledTimes(2);
  });

  it.each(["attempts", "tree"] as const)(
    "bounds repeated crashes by the %s budget and never forgets usage",
    async (bound) => {
      const model = wire([text("first"), text("second"), text("third")]);
      const agent = defineAgent({
        ...base,
        provider: model.provider,
        recovery: { ...recovery, maxAttempts: bound === "attempts" ? 2 : 5 },
        treeLimits: { modelCalls: bound === "tree" ? 2 : 10 },
      });
      const first = crashModel();
      await agent.run("Work", { host: first.host });
      const second = crashModel();
      await agent.resume(first.snapshot(), { host: second.host });
      const stopped = await agent.resume(second.snapshot(), { host: { authorizeResume } });
      expect(stopped).toMatchObject(
        bound === "attempts"
          ? { status: "failed", error: { code: "recovery_exhausted" } }
          : { status: "limited", limit: "modelCalls" },
      );
      expect(model.sent).toHaveBeenCalledTimes(2);
      expect(stopped.usage.inputTokens).toBe(14);
      expect(stopped.treeUsage).toEqual(stopped.usage);
      expect(stopped.snapshot.models).toHaveLength(1);
      expect(stopped.receipts).toHaveLength(2);
      expect(stopped.receipts.every((r) => r.kind === "model" && r.billing === "unknown")).toBe(
        true,
      );
      const restored = await agent.resume(stopped.snapshot, { host: { authorizeResume } });
      expect(restored.receipts).toEqual(stopped.receipts);
      expect(restored.usage).toEqual(stopped.usage);
      expect(model.sent).toHaveBeenCalledTimes(2);
    },
  );

  it("counts specialist replay admissions against the same root budget", async () => {
    const model = wire([text(), text(), text()]);
    const child = defineAgent({
      ...base,
      provider: model.provider,
      recovery: { ...recovery, maxAttempts: 5 },
    });
    const parent = parentFor(child, { modelCalls: 3 });
    const select = (snapshot: RunSnapshot) => snapshot.delegations[0]?.children[0]?.snapshot;
    const first = crashModel(select);
    await parent.agent.run("Work", { host: first.host });
    const second = crashModel(select, select(first.snapshot())?.attemptId);
    await parent.agent.resume(first.snapshot(), { host: second.host });
    const stopped = await parent.agent.resume(second.snapshot(), { host: { authorizeResume } });
    expect(stopped).toMatchObject({ status: "limited", limit: "modelCalls" });
    expect(parent.sent).toHaveBeenCalledOnce();
    expect(model.sent).toHaveBeenCalledTimes(2);
    expect(stopped.treeUsage.inputTokens).toBe(14);
  });

  it.each(["attempts", "toolCalls"] as const)(
    "bounds repeated read-only replay by %s",
    async (bound) => {
      const read = vi.fn(async () => "read");
      const model = wire([calls("read"), text()]);
      const agent = defineAgent({
        ...base,
        provider: model.provider,
        recovery: {
          ...recovery,
          readOnlyTools: ["read"],
          maxAttempts: bound === "attempts" ? 2 : 5,
        },
        limits: { toolCalls: bound === "toolCalls" ? 2 : 10 },
        tools: [
          defineTool({
            name: "read",
            description: "Read",
            inputSchema: { type: "object" },
            isReadOnly: true,
            run: read,
          }),
        ],
      });
      let durable: RunSnapshot | undefined;
      const host = {
        authorizeResume,
        beforeTool() {},
        checkpoint(snapshot: RunSnapshot) {
          const last = snapshot.models[0];
          if (last?.status === "completed" && last.tools[0]?.status === "completed")
            throw new Error("Lost result");
          durable = saved(snapshot);
        },
      };
      await agent.run("Work", { host });
      await agent.resume(saved(durable), { host });
      const stopped = await agent.resume(saved(durable), {
        host: { authorizeResume, beforeTool() {} },
      });
      expect(stopped).toMatchObject(
        bound === "attempts"
          ? { status: "failed", error: { code: "recovery_exhausted" } }
          : { status: "limited", limit: "toolCalls" },
      );
      expect(read).toHaveBeenCalledTimes(2);
      expect(model.sent).toHaveBeenCalledOnce();
      expect(stopped.receipts.filter((receipt) => receipt.kind === "tool")).toHaveLength(2);
    },
  );

  it.each(["unset", "hosted"] as const)(
    "refuses %s model effects, even with no streamed tool calls",
    async (profile) => {
      let external = 0;
      const model: Provider = {
        id: "fake",
        model: "fake",
        async *createStream() {
          external++;
          yield* text();
        },
      };
      const config = {
        ...base,
        provider: model,
        ...(profile === "hosted" ? { recovery: { ...recovery, inferenceOnly: false } } : {}),
      };
      const agent = defineAgent(config);
      const crash = crashModel();
      await agent.run("Work", { host: crash.host });
      const result = await agent.resume(crash.snapshot(), { host: { authorizeResume } });
      expect(result).toMatchObject({ status: "failed", error: { code: "interrupted_operation" } });
      expect(external).toBe(1);
    },
  );

  it.each(["web_search", "code_execution"] as const)(
    "refuses replay with explicit %s settings even on an inference-only profile",
    async (hostedType) => {
      const model = wire([text("first"), text("must not replay")]);
      const agent = defineAgent({
        ...base,
        provider: model.provider,
        recovery,
        modelSettings: { hostedTools: [{ type: hostedType }] },
      });
      const crash = crashModel();
      await agent.run("Work", { host: crash.host });
      const result = await agent.resume(crash.snapshot(), { host: { authorizeResume } });
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "interrupted_operation" },
      });
      expect(model.sent).toHaveBeenCalledOnce();
    },
  );

  it("rejects saved replay attempts for explicitly configured hosted tools", async () => {
    const model = wire([text()]);
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      recovery,
      modelSettings: { hostedTools: [{ type: "code_execution" }] },
    });
    const crash = crashModel();
    await agent.run("Work", { host: crash.host });
    const forged = crash.snapshot();
    const operation = forged.models[0];
    if (!operation) throw new Error("Missing model checkpoint");
    operation.interrupted.push({ attemptId: "earlier-model-attempt", usage });
    expect(() => agent[AGENT_RUNTIME].restore(forged)).toThrow("recovery policy");
  });

  it.each(["deadline", "cancel"] as const)(
    "does not reset or bypass %s on replay",
    async (stop) => {
      vi.useFakeTimers();
      const model = wire([text(), text()]);
      const agent = defineAgent({
        ...base,
        provider: model.provider,
        recovery,
        limits: { elapsedMs: 10 },
      });
      const crash = crashModel();
      await agent.run("Work", { host: crash.host });
      if (stop === "deadline") await vi.advanceTimersByTimeAsync(11);
      const result = await agent.resume(crash.snapshot(), {
        host: { authorizeResume },
        ...(stop === "cancel" ? { signal: AbortSignal.abort() } : {}),
      });
      expect(result).toMatchObject(
        stop === "deadline" ? { status: "limited", limit: "elapsedMs" } : { status: "cancelled" },
      );
      expect(model.sent).toHaveBeenCalledTimes(1);
      expect(result.snapshot.startedAt).toBe(crash.snapshot().startedAt);
    },
  );

  it.each(["identity", "provider", "settings", "tool-schema"] as const)(
    "checks %s and preserves the resolved request on replay",
    async (change) => {
      const instructions = vi.fn(() => "Resolved once.");
      const enabledTools = vi.fn(() => ["read"]);
      const tool = (description: string) =>
        defineTool({
          name: "read",
          description,
          inputSchema: { type: "object" },
          run: async () => "read",
        });
      const model = wire([text(), text()]);
      const original = {
        ...base,
        instructions,
        enabledTools,
        provider: model.provider,
        recovery,
        tools: [tool("Original")],
        modelSettings: { maxTokens: 100 },
      };
      const agent = defineAgent(original);
      const crash = crashModel();
      await agent.run("Work", { modelSettings: { maxTokens: 20 }, host: crash.host });
      const rebuilt = defineAgent({
        ...original,
        recovery: change === "identity" ? { ...recovery, identity: "other-profile" } : recovery,
        provider: change === "provider" ? { ...model.provider, model: "other" } : model.provider,
        modelSettings: { maxTokens: 999 },
        tools: [tool(change === "tool-schema" ? "Changed" : "Original")],
      });
      if (change === "identity" || change === "provider") {
        await expect(
          rebuilt.resume(crash.snapshot(), { host: { authorizeResume } }),
        ).rejects.toThrow("recovery policy or provider");
        expect(model.sent).toHaveBeenCalledTimes(1);
      } else {
        const result = await rebuilt.resume(crash.snapshot(), { host: { authorizeResume } });
        if (change === "tool-schema")
          expect(result).toMatchObject({
            status: "failed",
            error: { code: "recovery_definition_changed" },
          });
        else {
          expect(result.status).toBe("completed");
          expect(model.sent.mock.calls[1]?.[2]?.maxTokens).toBe(20);
          expect(model.sent.mock.calls[1]?.[0]).toEqual(model.sent.mock.calls[0]?.[0]);
        }
      }
      expect(instructions).toHaveBeenCalledOnce();
      expect(enabledTools).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "write",
    "unlisted-read",
    "no-host-check",
    "approved",
    "changed-tool",
    "tool-budget",
  ] as const)("refuses a %s tool replay", async (kind) => {
    const effect = vi.fn(async () => "read");
    const isReadOnly = kind !== "write";
    const tool = (description: string) =>
      defineTool({
        name: "read",
        description,
        inputSchema: { type: "object" },
        isReadOnly,
        needsApproval: kind === "approved",
        run: effect,
      });
    const requested = calls("read");
    if (kind === "write")
      requested[0] = {
        type: "delta",
        toolCalls: [
          { index: 0, id: "call-0", name: "read", arguments: '{"idempotencyKey":"not-proof"}' },
        ],
      };
    const model = wire([requested, text()]);
    const config = {
      ...base,
      provider: model.provider,
      tools: [tool("Original")],
      recovery: {
        ...recovery,
        readOnlyTools: kind === "unlisted-read" || kind === "write" ? [] : ["read"],
      },
      limits: { toolCalls: kind === "tool-budget" ? 1 : 10 },
    };
    const agent = defineAgent(config);
    let durable: RunSnapshot | undefined;
    const host: AgentHost & { authorizeResume: typeof authorizeResume } = {
      authorizeResume,
      beforeTool() {},
      prepareRequest: () => ({
        scope: {
          actorId: "actor",
          resource: { id: "record", version: "1" },
          expiresAt: Date.now() + 10_000,
        },
      }),
      answerNow: () => ({ type: "approve" }),
      checkpoint(snapshot) {
        const last = snapshot.models[0];
        if (last?.status === "completed" && last.tools[0]?.status === "completed")
          throw new Error("Lost result");
        durable = saved(snapshot);
      },
    };
    await agent.run("Work", { host });
    expect(effect).toHaveBeenCalledOnce();
    const rebuilt =
      kind === "changed-tool" ? defineAgent({ ...config, tools: [tool("Changed")] }) : agent;
    const result = await rebuilt.resume(saved(durable), {
      host: {
        ...host,
        checkpoint: undefined,
        beforeTool: kind === "no-host-check" ? undefined : host.beforeTool,
      },
    });
    expect(result).toMatchObject(
      kind === "tool-budget"
        ? { status: "limited", limit: "toolCalls" }
        : {
            status: "failed",
            error: {
              code:
                kind === "changed-tool" ? "recovery_definition_changed" : "interrupted_operation",
            },
          },
    );
    expect(effect).toHaveBeenCalledOnce();
    if (kind === "approved") {
      const receipt = saved(durable).models[0];
      if (receipt?.status !== "completed") throw new Error("Missing tool");
      const id = receipt.tools[0]?.asks?.[0]?.request.id;
      if (!id) throw new Error("Missing approval");
      await expect(
        agent.resume(saved(durable), { host, answers: { [id]: "old evidence" } }),
      ).rejects.toThrow("already-decided");
    }
  });

  it("rejects write opt-in and invalid recovery budgets before saving", () => {
    const model = wire([text()]);
    const write = defineTool({
      name: "write",
      description: "Write",
      inputSchema: { type: "object" },
      run: async () => "written",
    });
    expect(() =>
      defineAgent({
        ...base,
        provider: model.provider,
        tools: [write],
        recovery: { ...recovery, readOnlyTools: ["write"] },
      }),
    ).toThrow("isReadOnly");
    for (const maxAttempts of [0, -1, 1.5, Infinity])
      expect(() =>
        defineAgent({ ...base, provider: model.provider, recovery: { ...recovery, maxAttempts } }),
      ).toThrow("maxAttempts");
  });

  it("rejects a host envelope that erases an interrupted attempt", async () => {
    const model = wire([text(), text()]);
    const agent = defineAgent({ ...base, provider: model.provider, recovery });
    const crash = crashModel();
    await agent.run("Work", { host: crash.host });
    const before = crash.snapshot();
    const result = await agent.resume(before, { host: { authorizeResume } });
    const forged = saved(result.snapshot);
    const current = forged.models[0];
    if (!current) throw new Error("Missing model");
    current.interrupted = [];
    expect(() => checkChildProgress(before, forged)).toThrow("without retaining");
    const duplicated = saved(result.snapshot);
    const duplicate = duplicated.models[0];
    if (!duplicate) throw new Error("Missing model");
    duplicate.interrupted[0] = { attemptId: duplicate.attemptId, usage };
    expect(() => agent[AGENT_RUNTIME].restore(duplicated)).toThrow("Invalid agent snapshot");
  });
});
