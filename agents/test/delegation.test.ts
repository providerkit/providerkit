import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  defineTool,
  type ChatMessage,
  type Provider,
  type ProviderChunk,
  type ToolCall,
  type ToolContext,
} from "@providerkit/core";
import {
  defineAgent,
  defineDelegation,
  RESULT_TOOL_NAME,
  type Agent,
  type AgentHost,
  type ChildEnvelope,
  type DelegationContext,
  type RunOutcome,
  type RunSnapshot,
} from "../src/index.ts";

const usage = { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 1 };
const base = { version: "1", instructions: "Complete this task." };
const authorizeResume = () => {};

function text(content: string): ProviderChunk[] {
  return [
    { type: "delta", content },
    { type: "usage", usage },
    { type: "finish", finishReason: "stop" },
  ];
}
function calls(...tools: ToolCall[]): ProviderChunk[] {
  return [
    { type: "delta", toolCalls: tools.map((tool, index) => ({ ...tool, index })) },
    { type: "usage", usage },
    { type: "finish", finishReason: "tool_calls" },
  ];
}
function call(name: string, input?: string, id = `wire-${name}`): ToolCall {
  return { name, id, arguments: JSON.stringify(input === undefined ? {} : { input }) };
}
function wire(
  turns: ProviderChunk[][],
  before?: (index: number, signal?: AbortSignal) => Promise<void>,
) {
  const histories: ChatMessage[][] = [];
  const provider: Provider = {
    id: "fake",
    model: "fake",
    async *createStream(history, _tools, options) {
      const index = histories.length;
      histories.push(structuredClone(history));
      await before?.(index, options?.signal);
      const chunks = turns[index];
      if (!chunks) throw new Error("Unexpected model request");
      yield* chunks;
    },
  };
  return { provider, histories };
}
function ordinary(name: string, run: (context: ToolContext) => Promise<string>, approval = false) {
  return defineTool({
    name,
    description: name,
    inputSchema: { type: "object" },
    isConcurrencySafe: true,
    needsApproval: approval,
    run: (_args, context) => run(context),
    summarize: (result) => result,
  });
}
function coordinator(
  specialists: readonly Agent<unknown>[],
  run: (context: DelegationContext) => Promise<unknown>,
) {
  return defineDelegation({
    name: "coordinate",
    description: "Ask the specialists.",
    inputSchema: { type: "object" },
    validate: () => undefined,
    specialists,
    run: (_input, context) => run(context),
  });
}
function firstChild(snapshot: RunSnapshot): RunSnapshot {
  const child = snapshot.delegations[0]?.children[0]?.snapshot;
  if (!child) throw new Error("Missing child checkpoint");
  return child;
}
function checkpoint(snapshot: RunSnapshot | undefined): RunSnapshot {
  if (!snapshot) throw new Error("Missing checkpoint");
  return JSON.parse(JSON.stringify(snapshot));
}
function scope() {
  return {
    actorId: "actor",
    resource: { id: "record", version: "4" },
    expiresAt: Date.now() + 10_000,
  };
}
function approvalFixture(treeLimits = {}) {
  const effect = vi.fn(async (context: ToolContext) => {
    expect(context.callId).toBe("exact-leaf-call");
    expect(context.runId).not.toBe("spoofed");
    return "written";
  });
  const leafWire = wire([calls(call("write", undefined, "exact-leaf-call")), text("Leaf done")]);
  const leaf = defineAgent({
    ...base,
    id: "leaf",
    provider: leafWire.provider,
    tools: [ordinary("write", effect, true)],
  });
  const middleWire = wire([calls(call("leaf", "private leaf input")), text("Middle done")]);
  const middle = defineAgent({
    ...base,
    id: "middle",
    provider: middleWire.provider,
    tools: [leaf.asTool({ name: "leaf", description: "Ask the leaf." })],
  });
  const rootWire = wire([calls(call("middle", "private middle input")), text("Root done")]);
  const root = defineAgent({
    ...base,
    id: "root",
    provider: rootWire.provider,
    tools: [middle.asTool({ name: "middle", description: "Ask the middle." })],
    treeLimits,
  });
  return { root, effect, rootWire, middleWire, leafWire };
}

afterEach(() => vi.useRealTimers());

describe("specialist delegation", () => {
  it("finishes nested children with one slot, isolated histories and exact local/tree usage", async () => {
    const fixture = approvalFixture({ maxParallel: 1, modelCalls: 6 });
    const host = {
      authorizeResume,
      approvalContext: scope,
      resolveApproval: () => "approved" as const,
      beforeTool() {},
    };
    const suspended = await fixture.root.run("root-only secret", { host });
    expect(suspended.status).toBe("suspended");
    if (suspended.status !== "suspended") throw new Error(suspended.status);
    expect(suspended.path).toHaveLength(2);
    const result = await fixture.root.resume(suspended.snapshot, {
      host,
      decision: "ticket",
      approvalPath: suspended.path,
    });
    expect(result).toMatchObject({ status: "completed", output: "Root done" });
    expect(result.usage).toMatchObject({ inputTokens: 14, outputTokens: 6 });
    expect(result.treeUsage).toMatchObject({
      inputTokens: 42,
      outputTokens: 18,
      cachedInputTokens: 12,
      reasoningTokens: 6,
    });
    expect(firstChild(result.snapshot).input).toBe("private middle input");
    expect(fixture.middleWire.histories[0]).toEqual([
      { role: "system", content: base.instructions },
      { role: "user", content: "private middle input" },
    ]);
    expect(fixture.leafWire.histories[0]).toEqual([
      { role: "system", content: base.instructions },
      { role: "user", content: "private leaf input" },
    ]);
    expect(result.receipts.filter((receipt) => receipt.kind === "delegation")).toHaveLength(1);
    const restored = await fixture.root.resume(result.snapshot, { host });
    expect(restored.treeUsage).toEqual(result.treeUsage);
    expect(fixture.leafWire.histories).toHaveLength(2);
  });

  it("overlaps two children within the cap, orders typed joins and reuses overlapping joins", async () => {
    const release = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    function childWire(name: string, chunks: ProviderChunk[]) {
      const provider: Provider = {
        id: name,
        model: name,
        async *createStream() {
          active++;
          peak = Math.max(peak, active);
          order.push(`${name}:start`);
          try {
            if (name === "first") await release.promise;
            yield* chunks;
          } finally {
            active--;
            order.push(`${name}:end`);
          }
        },
      };
      return provider;
    }
    const first = defineAgent({ ...base, id: "first", provider: childWire("first", text("one")) });
    const second = defineAgent({
      ...base,
      id: "second",
      provider: childWire(
        "second",
        calls({ name: RESULT_TOOL_NAME, id: "typed", arguments: '{"count":2}' }),
      ),
      output: {
        schema: { type: "object" },
        validate(value) {
          if (
            typeof value !== "object" ||
            value === null ||
            !("count" in value) ||
            typeof value.count !== "number"
          )
            throw new Error("Expected count");
          return { count: value.count };
        },
      },
    });
    const third = defineAgent({
      ...base,
      id: "third",
      provider: childWire("third", text("three")),
    });
    const parentWire = wire([calls(call("coordinate")), text("All done")]);
    let outputs: unknown[] = [];
    const parent = defineAgent({
      ...base,
      id: "root",
      provider: parentWire.provider,
      treeLimits: { maxParallel: 2 },
      tools: [
        coordinator([first, second, third], async (context) => {
          expect(Object.isFrozen(context)).toBe(true);
          const a = context.child("a", first, "first input");
          const b = context.child("b", second, "second input");
          const c = context.child("c", third, "third input");
          const joined = context.join([a, b, c]);
          const [results, again] = await Promise.all([joined, a.join()]);
          expectTypeOf(results).toEqualTypeOf<
            readonly [RunOutcome<string>, RunOutcome<{ count: number }>, RunOutcome<string>]
          >();
          expect(results[0]).toEqual(again);
          outputs = results.map((result) =>
            result.status === "completed" ? result.output : result.status,
          );
          return outputs;
        }),
      ],
    });
    const result = await parent.run("delegate", {
      onEvent(event) {
        if (event.type === "state" && event.runId.endsWith("/child/b")) release.resolve();
      },
    });
    expect(result.status).toBe("completed");
    expect(peak).toBe(2);
    expect(order.indexOf("second:end")).toBeLessThan(order.indexOf("first:end"));
    expect(outputs).toEqual(["one", { count: 2 }, "three"]);
    expect(result.treeUsage.inputTokens).toBe(35);
    expect(result.snapshot.delegations[0]?.children.map((child) => child.key)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("treats delegation as a barrier between host-approved ordinary tool batches", async () => {
    const order: string[] = [];
    const childWire = wire([text("child result")], async () => {
      order.push("child");
    });
    const child = defineAgent({ ...base, id: "child", provider: childWire.provider });
    const parentWire = wire([
      calls(call("before"), call("child", "task"), call("after")),
      text("done"),
    ]);
    const parent = defineAgent({
      ...base,
      id: "root",
      provider: parentWire.provider,
      tools: [
        ordinary("before", async () => {
          order.push("before");
          return "before";
        }),
        child.asTool({ name: "child", description: "Ask the child." }),
        ordinary("after", async () => {
          order.push("after");
          return "after";
        }),
      ],
    });
    const result = await parent.run("work", { host: { canRunConcurrently: () => true } });
    expect(result.status).toBe("completed");
    expect(order).toEqual(["before", "child", "after"]);
    expect(
      result.history
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["wire-before", "wire-child", "wire-after"]);
  });

  it.each(["approved", "denied", "expired", "revoked"] as const)(
    "routes %s approval only to the exact leaf and rechecks access",
    async (answer) => {
      vi.useFakeTimers();
      const fixture = approvalFixture();
      const authorized: string[] = [];
      const resolved: string[] = [];
      const host = {
        authorizeResume(snapshot: RunSnapshot) {
          authorized.push(snapshot.runId);
          expect(Object.isFrozen(snapshot)).toBe(true);
        },
        approvalContext: scope,
        resolveApproval(
          approval: Parameters<NonNullable<AgentHost["resolveApproval"]>>[0],
          decision: unknown,
        ) {
          expect(Object.isFrozen(approval.request.call)).toBe(true);
          expect(approval.request.call.id).toBe("exact-leaf-call");
          expect(decision).toEqual({ ticket: "signed" });
          resolved.push(approval.request.runId);
          return answer === "denied" ? ("denied" as const) : ("approved" as const);
        },
        beforeTool(
          request: Parameters<NonNullable<AgentHost["beforeTool"]>>[0],
          approval?: Parameters<NonNullable<AgentHost["beforeTool"]>>[1],
        ) {
          if (request.call.name !== "write") {
            expect(approval).toBeUndefined();
            return;
          }
          expect(approval?.request.operationId).toBe(request.operationId);
          if (answer === "revoked") throw new Error("Access revoked");
        },
      };
      const pending = await fixture.root.run("work", { host });
      if (pending.status !== "suspended") throw new Error(pending.status);
      expect(pending.approval.request.runId).toBe(pending.path.at(-1)?.runId);
      if (answer === "expired") await vi.advanceTimersByTimeAsync(10_001);
      const result = await fixture.root.resume(checkpoint(pending.snapshot), {
        host,
        decision: { ticket: "signed" },
        approvalPath: pending.path,
        context: {
          runId: "spoofed",
          operationId: "spoofed",
          callId: "spoofed",
          signal: AbortSignal.abort(),
        },
      });
      expect(authorized).toEqual([pending.runId, pending.path[0]?.runId, pending.path[1]?.runId]);
      expect(resolved).toHaveLength(answer === "expired" ? 0 : 1);
      expect(fixture.effect).toHaveBeenCalledTimes(answer === "approved" ? 1 : 0);
      expect(result.status).toBe(
        answer === "approved" || answer === "denied" ? "completed" : "failed",
      );
      if (answer === "denied")
        expect(fixture.leafWire.histories[1]?.at(-1)).toMatchObject({
          toolCallId: "exact-leaf-call",
          content: expect.stringContaining("denied"),
        });
    },
  );

  it("refuses wrong paths and child authority before consuming any evidence", async () => {
    const { root, effect } = approvalFixture();
    const pending = await root.run("work", { host: { approvalContext: scope } });
    if (pending.status !== "suspended") throw new Error(pending.status);
    const resolveApproval = vi.fn(() => "approved" as const);
    const authorize = vi.fn();
    const host = { authorizeResume: authorize, resolveApproval, beforeTool() {} };
    for (const approvalPath of [
      undefined,
      [],
      [{ ...pending.path[0], operationId: "wrong", key: "result", runId: "wrong" }],
    ]) {
      await expect(
        root.resume(pending.snapshot, { host, decision: true, approvalPath }),
      ).rejects.toThrow("decision path");
    }
    const corrupted = checkpoint(pending.snapshot);
    if (corrupted.state.status !== "suspended") throw new Error("Expected suspension");
    corrupted.state.path[0] = { operationId: "wrong", key: "result", runId: "wrong" };
    await expect(root.resume(corrupted, { host })).rejects.toThrow("approval path");
    expect(authorize).not.toHaveBeenCalled();
    await expect(
      root.resume(pending.snapshot, {
        decision: true,
        approvalPath: pending.path,
        host: {
          ...host,
          authorizeResume(snapshot) {
            if (snapshot.runId !== pending.runId)
              throw new Error("Child is not owned by this actor");
          },
        },
      }),
    ).rejects.toThrow("Child is not owned");
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it("settles ignored children, retains concurrent suspensions and exposes one in admission order", async () => {
    const aEffect = vi.fn(async () => "a written");
    const bEffect = vi.fn(async () => "b written");
    const aWire = wire([calls(call("write-a")), text("a")]);
    const bWire = wire([calls(call("write-b")), text("b")]);
    const a = defineAgent({
      ...base,
      id: "a",
      provider: aWire.provider,
      tools: [ordinary("write-a", aEffect, true)],
    });
    const b = defineAgent({
      ...base,
      id: "b",
      provider: bWire.provider,
      tools: [ordinary("write-b", bEffect, true)],
    });
    const rootWire = wire([calls(call("coordinate")), text("done")]);
    const root = defineAgent({
      ...base,
      id: "root",
      provider: rootWire.provider,
      tools: [
        coordinator([a, b], async (context) => {
          context.child("first", a, "a");
          context.child("second", b, "b");
          return "I ignored all the children";
        }),
      ],
    });
    const resolutions: string[] = [];
    const host = {
      authorizeResume,
      approvalContext: scope,
      beforeTool() {},
      resolveApproval(approval: Parameters<NonNullable<AgentHost["resolveApproval"]>>[0]) {
        resolutions.push(approval.request.call.id);
        return "approved" as const;
      },
    };
    const first = await root.run("work", { host });
    if (first.status !== "suspended") throw new Error(first.status);
    expect(first.path[0]?.key).toBe("first");
    expect(
      first.snapshot.delegations[0]?.children.map((child) => child.snapshot.state.status),
    ).toEqual(["suspended", "suspended"]);
    expect(rootWire.histories).toHaveLength(1);
    const second = await root.resume(first.snapshot, {
      host,
      decision: "first ticket",
      approvalPath: first.path,
    });
    if (second.status !== "suspended") throw new Error(second.status);
    expect(second.path[0]?.key).toBe("second");
    expect(resolutions).toEqual(["wire-write-a"]);
    expect(aEffect).toHaveBeenCalledTimes(1);
    expect(bEffect).not.toHaveBeenCalled();
    const done = await root.resume(second.snapshot, {
      host,
      decision: "second ticket",
      approvalPath: second.path,
    });
    expect(done.status).toBe("completed");
    expect(resolutions).toEqual(["wire-write-a", "wire-write-b"]);
    expect(aWire.histories).toHaveLength(2);
    expect(done.treeUsage.inputTokens).toBe(42);
  });

  it("keeps a joined child's approval separate from its live journal", async () => {
    const effect = vi.fn(async () => "written");
    const childWire = wire([calls(call("write")), text("child done")]);
    const child = defineAgent({
      ...base,
      id: "child",
      provider: childWire.provider,
      tools: [ordinary("write", effect, true)],
    });
    const rootWire = wire([calls(call("coordinate")), text("done")]);
    const root = defineAgent({
      ...base,
      id: "root",
      provider: rootWire.provider,
      tools: [
        coordinator([child], async (context) => {
          const result = await context.child("child", child, "task").join();
          if (result.status === "suspended") {
            result.approval.scope.actorId = "edited outcome";
            result.path.push({ operationId: "edited", key: "edited", runId: "edited" });
          }
          return result.status;
        }),
      ],
    });
    const host = {
      authorizeResume,
      approvalContext: scope,
      resolveApproval: () => "approved" as const,
      beforeTool() {},
    };
    const pending = await root.run("work", { host });
    if (pending.status !== "suspended") throw new Error(pending.status);
    expect(pending.approval.scope.actorId).toBe("actor");
    expect(pending.path).toHaveLength(1);
    const done = await root.resume(checkpoint(pending.snapshot), {
      host,
      decision: "ticket",
      approvalPath: pending.path,
    });
    expect(done.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("reuses completed child effects after parent interruption and validates the saved typed result", async () => {
    const effect = vi.fn(async () => "written once");
    const leafWire = wire([
      calls(call("write")),
      calls({ name: RESULT_TOOL_NAME, id: "result", arguments: '{"count":1}' }),
    ]);
    const validate = vi.fn((value: unknown) => {
      if (typeof value !== "object" || value === null || !("count" in value) || value.count !== 1)
        throw new Error("Expected count 1");
      return { count: value.count };
    });
    const leaf = defineAgent({
      ...base,
      id: "leaf",
      provider: leafWire.provider,
      tools: [ordinary("write", effect)],
      output: { schema: { type: "object" }, validate },
    });
    const rootWire = wire([calls(call("leaf", "do it")), text("done")]);
    const root = defineAgent({
      ...base,
      id: "root",
      provider: rootWire.provider,
      tools: [
        leaf.asTool({
          name: "leaf",
          description: "Ask the leaf.",
          summarize: (value) => `Count ${value.count}`,
        }),
      ],
    });
    let durable: RunSnapshot | undefined;
    const failed = await root.run("work", {
      host: {
        checkpoint(snapshot) {
          durable = structuredClone(snapshot);
          if (snapshot.delegations[0]?.children[0]?.snapshot.state.status === "completed")
            throw new Error("Worker stopped after saving the child");
        },
      },
    });
    expect(failed).toMatchObject({ status: "failed", error: { code: "checkpoint_failed" } });
    const saved = checkpoint(durable);
    expect(saved.models.at(-1)?.status).toBe("completed");
    const completedCalls = validate.mock.calls.length;
    const result = await root.resume(saved, { host: { authorizeResume } });
    expect(result).toMatchObject({ status: "completed", output: "done" });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(leafWire.histories).toHaveLength(2);
    expect(validate.mock.calls.length).toBeGreaterThan(completedCalls);
    expect(result.treeUsage.inputTokens).toBe(28);
    expect(rootWire.histories[1]?.at(-1)).toMatchObject({ role: "tool", content: "Count 1" });
    const bad = checkpoint(result.snapshot);
    firstChild(bad).state = { status: "completed", candidate: { count: 999 } };
    await expect(root.resume(bad, { host: { authorizeResume } })).rejects.toThrow("recorded turn");
  });

  it.each(["model", "tool"] as const)(
    "does not replay an interrupted child %s effect",
    async (kind) => {
      const effect = vi.fn(async () => "written");
      const childWire = wire([kind === "model" ? text("done") : calls(call("write"))]);
      const child = defineAgent({
        ...base,
        id: "child",
        provider: childWire.provider,
        tools: [ordinary("write", effect)],
      });
      const rootWire = wire([calls(call("child", "task"))]);
      const root = defineAgent({
        ...base,
        id: "root",
        provider: rootWire.provider,
        tools: [child.asTool({ name: "child", description: "Ask the child." })],
      });
      let durable: RunSnapshot | undefined;
      await root.run("work", {
        host: {
          checkpoint(snapshot) {
            const last = snapshot.delegations[0]?.children[0]?.snapshot.models.at(-1);
            if (
              last?.status === "completed" &&
              (kind === "model" || last.tools[0]?.status === "completed")
            )
              throw new Error("Storage unavailable");
            durable = structuredClone(snapshot);
          },
        },
      });
      const result = await root.resume(checkpoint(durable), { host: { authorizeResume } });
      expect(result).toMatchObject({ status: "failed", error: { code: "interrupted_operation" } });
      expect(childWire.histories).toHaveLength(1);
      expect(effect).toHaveBeenCalledTimes(kind === "tool" ? 1 : 0);
      expect(rootWire.histories).toHaveLength(1);
    },
  );

  it.each(["input", "agent", "version"] as const)(
    "rejects a reused child key with changed %s",
    async (change) => {
      const wireA = wire([text("a")]);
      const wireB = wire([text("b")]);
      const first = defineAgent({ ...base, id: "first", provider: wireA.provider });
      const other = defineAgent({ ...base, id: "other", provider: wireB.provider });
      let replay = false;
      const rootWire = wire([calls(call("coordinate"))]);
      const root = defineAgent({
        ...base,
        id: "root",
        provider: rootWire.provider,
        tools: [
          coordinator([first, other], async (context) => {
            const result = await context
              .child(
                "key",
                replay && change === "agent" ? other : first,
                replay && change === "input" ? "changed" : "original",
              )
              .join();
            return result.status;
          }),
        ],
      });
      let durable: RunSnapshot | undefined;
      await root.run("work", {
        host: {
          checkpoint(snapshot) {
            durable = structuredClone(snapshot);
            if (snapshot.delegations[0]?.children[0]?.snapshot.state.status === "completed")
              throw new Error("Stopped after child");
          },
        },
      });
      replay = true;
      const saved = checkpoint(durable);
      if (change === "version") {
        firstChild(saved).version = "other";
        await expect(root.resume(saved, { host: { authorizeResume } })).rejects.toThrow(
          "registered specialist version",
        );
      } else {
        const result = await root.resume(saved, { host: { authorizeResume } });
        expect(result).toMatchObject({ status: "failed", error: { code: "child_key_conflict" } });
      }
      expect(wireA.histories).toHaveLength(1);
      expect(wireB.histories).toHaveLength(0);
    },
  );

  it.each(["maxChildren", "modelCalls"] as const)(
    "reserves the shared %s budget before racing children start",
    async (limit) => {
      const childWire = wire([text("a"), text("b"), text("c")]);
      const child = defineAgent({ ...base, id: "child", provider: childWire.provider });
      const rootWire = wire([calls(call("coordinate"))]);
      const root = defineAgent({
        ...base,
        id: "root",
        provider: rootWire.provider,
        treeLimits: { [limit]: 2, maxParallel: 2 },
        tools: [
          coordinator([child], async (context) => {
            const a = context.child("a", child, "a");
            const b = context.child("b", child, "b");
            const c = context.child("c", child, "c");
            return (await context.join([a, b, c])).map((result) => result.status);
          }),
        ],
      });
      const result = await root.run("work");
      expect(result).toMatchObject({ status: "limited", limit });
      expect(result.snapshot.delegations[0]?.children).toHaveLength(
        limit === "maxChildren" ? 2 : 3,
      );
      expect(childWire.histories).toHaveLength(limit === "maxChildren" ? 2 : 1);
      expect(rootWire.histories).toHaveLength(1);
      expect(result.treeUsage.inputTokens).toBe(limit === "maxChildren" ? 21 : 14);
    },
  );

  it("refuses depth before admission and keeps the tree model reservation across resume", async () => {
    const depth = approvalFixture({ maxDepth: 1 });
    const result = await depth.root.run("work");
    expect(result).toMatchObject({ status: "limited", limit: "maxDepth" });
    expect(depth.leafWire.histories).toHaveLength(0);
    expect(firstChild(result.snapshot).delegations[0]?.children).toEqual([]);
    const budget = approvalFixture({ modelCalls: 3 });
    const host = {
      authorizeResume,
      approvalContext: scope,
      beforeTool() {},
      resolveApproval: () => "approved" as const,
    };
    const suspended = await budget.root.run("work", { host });
    if (suspended.status !== "suspended") throw new Error(suspended.status);
    const resumed = await budget.root.resume(suspended.snapshot, {
      host,
      decision: "ticket",
      approvalPath: suspended.path,
    });
    expect(resumed).toMatchObject({ status: "limited", limit: "modelCalls" });
    expect(budget.leafWire.histories).toHaveLength(1);
    expect(resumed.treeUsage.inputTokens).toBe(21);
  });

  it("does not reset the tree deadline while suspended", async () => {
    vi.useFakeTimers();
    const fixture = approvalFixture({ elapsedMs: 100 });
    const resolveApproval = vi.fn(() => "approved" as const);
    const host = { authorizeResume, approvalContext: scope, beforeTool() {}, resolveApproval };
    const pending = await fixture.root.run("work", { host });
    if (pending.status !== "suspended") throw new Error(pending.status);
    await vi.advanceTimersByTimeAsync(101);
    const result = await fixture.root.resume(pending.snapshot, {
      host,
      decision: "ticket",
      approvalPath: pending.path,
    });
    expect(result).toMatchObject({ status: "limited", limit: "treeElapsedMs" });
    expect(result.snapshot.tree).toEqual(pending.snapshot.tree);
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(fixture.effect).not.toHaveBeenCalled();
  });

  it("cancels active and queued children before the root returns, even when providers ignore abort", async () => {
    const started = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const blocked = wire([text("late"), text("late")], async (_index, signal) => {
      if (!signal) throw new Error("Missing signal");
      signals.push(signal);
      if (signals.length === 2) started.resolve();
      await new Promise<void>(() => {});
    });
    const child = defineAgent({ ...base, id: "child", provider: blocked.provider });
    const rootWire = wire([calls(call("coordinate"))]);
    const root = defineAgent({
      ...base,
      id: "root",
      provider: rootWire.provider,
      treeLimits: { maxParallel: 2 },
      tools: [
        coordinator([child], async (context) =>
          context.join([
            context.child("a", child, "a"),
            context.child("b", child, "b"),
            context.child("c", child, "c"),
          ]),
        ),
      ],
    });
    const controller = new AbortController();
    const work = root.run("work", { signal: controller.signal });
    await started.promise;
    controller.abort("stop");
    const result = await work;
    expect(result.status).toBe("cancelled");
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(
      result.snapshot.delegations[0]?.children.map((child) => child.snapshot.state.status),
    ).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("does not treat cached host suspensions as completion and refuses unsupported host resume", async () => {
    const effect = vi.fn(async () => "written");
    const childWire = wire([calls(call("write")), text("child done")]);
    const child = defineAgent({
      ...base,
      id: "child",
      provider: childWire.provider,
      tools: [ordinary("write", effect, true)],
    });
    const rootWire = wire([calls(call("child", "task")), text("done")]);
    const root = defineAgent({
      ...base,
      id: "root",
      provider: rootWire.provider,
      tools: [child.asTool({ name: "child", description: "Ask the child." })],
    });
    let cached: ChildEnvelope | undefined;
    let supportsResume = false;
    const host = {
      authorizeResume,
      approvalContext: scope,
      beforeTool() {},
      resolveApproval: () => "approved" as const,
      async child(
        request: Parameters<NonNullable<AgentHost["child"]>>[0],
        execute: Parameters<NonNullable<AgentHost["child"]>>[1],
      ) {
        expect(Object.isFrozen(request.snapshot)).toBe(true);
        if (cached && !supportsResume) return cached;
        if (cached) expect(request.reference).toBe("segment-1");
        cached = { ...(await execute()), reference: cached ? "segment-2" : "segment-1" };
        return cached;
      },
    };
    const pending = await root.run("work", { host });
    if (pending.status !== "suspended") throw new Error(pending.status);
    expect(rootWire.histories).toHaveLength(1);
    const stillPending = await root.resume(pending.snapshot, { host });
    expect(stillPending.status).toBe("suspended");
    const refused = await root.resume(stillPending.snapshot, {
      host,
      decision: "ticket",
      approvalPath: pending.path,
    });
    expect(refused).toMatchObject({ status: "failed", error: { code: "host_resume_unsupported" } });
    expect(effect).not.toHaveBeenCalled();
    supportsResume = true;
    // The fake authorizer permits this earlier checkpoint. A real host must reconcile
    // and authorize it, not accept a caller's stale snapshot by default.
    const done = await root.resume(pending.snapshot, {
      host,
      decision: "ticket",
      approvalPath: pending.path,
    });
    expect(done.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(1);
    expect(done.treeUsage.inputTokens).toBe(28);
    expect(done.snapshot.delegations[0]?.children[0]?.reference).toBe("segment-2");
  });

  it("serializes root checkpoints and saves child/model/tool reservations before effects", async () => {
    let durable: RunSnapshot | undefined;
    let writing = 0;
    let peakWrites = 0;
    const effect = vi.fn(async (context: ToolContext) => {
      const child = durable?.delegations[0]?.children.find(
        (entry) => entry.snapshot.runId === context.runId,
      )?.snapshot;
      const last = child?.models.at(-1);
      expect(last?.status === "completed" ? last.tools[0]?.status : undefined).toBe("running");
      return "saved";
    });
    const provider: Provider = {
      id: "child",
      model: "child",
      async *createStream(history, _tools, options) {
        const saved = durable?.delegations[0]?.children.find(
          (entry) => entry.snapshot.runId === options?.sessionId,
        )?.snapshot;
        expect(saved?.models.at(-1)?.status).toBe("running");
        yield* history.length === 2 ? calls(call("write")) : text("done");
      },
    };
    const child = defineAgent({
      ...base,
      id: "child",
      provider,
      tools: [ordinary("write", effect)],
    });
    const rootWire = wire([calls(call("coordinate")), text("done")], async () => {
      expect(durable?.models.at(-1)?.status).toBe("running");
    });
    const root = defineAgent({
      ...base,
      id: "root",
      provider: rootWire.provider,
      tools: [
        coordinator([child], async (context) =>
          context.join([context.child("a", child, "a"), context.child("b", child, "b")]),
        ),
      ],
    });
    const result = await root.run("work", {
      host: {
        async checkpoint(snapshot) {
          writing++;
          peakWrites = Math.max(peakWrites, writing);
          await Promise.resolve();
          durable = structuredClone(snapshot);
          writing--;
        },
      },
    });
    expect(result.status).toBe("completed");
    expect(peakWrites).toBe(1);
    expect(effect).toHaveBeenCalledTimes(2);
    expect(durable).toEqual(result.snapshot);
  });

  it("does not let a host cache erase receipts produced by its execute callback", async () => {
    const effect = vi.fn(async () => "written");
    const childWire = wire([calls(call("write")), text("child done")]);
    const child = defineAgent({
      ...base,
      id: "child",
      provider: childWire.provider,
      tools: [ordinary("write", effect, true)],
    });
    const rootWire = wire([calls(call("child", "task"))]);
    const root = defineAgent({
      ...base,
      id: "root",
      provider: rootWire.provider,
      tools: [child.asTool({ name: "child", description: "Ask the child." })],
    });
    let cached: ChildEnvelope | undefined;
    const host = {
      authorizeResume,
      approvalContext: scope,
      beforeTool() {},
      resolveApproval: () => "approved" as const,
      async child(
        _request: Parameters<NonNullable<AgentHost["child"]>>[0],
        execute: Parameters<NonNullable<AgentHost["child"]>>[1],
      ) {
        const fresh = await execute();
        cached ??= fresh;
        return cached;
      },
    };
    const pending = await root.run("work", { host });
    if (pending.status !== "suspended") throw new Error(pending.status);
    const result = await root.resume(pending.snapshot, {
      host,
      decision: "ticket",
      approvalPath: pending.path,
    });
    expect(result).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("dropped saved model receipts") },
    });
    expect(firstChild(result.snapshot).state.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(1);
    expect(result.treeUsage.inputTokens).toBe(21);
  });

  it("validates trusted callback boundaries and closes retained coordination contexts", async () => {
    const childWire = wire([text("child")]);
    const child = defineAgent({ ...base, id: "child", provider: childWire.provider });
    const stranger = defineAgent({ ...base, id: "stranger", provider: childWire.provider });
    const rootWire = wire([calls(call("coordinate")), text("done")]);
    let retained: DelegationContext | undefined;
    const root = defineAgent({
      ...base,
      id: "root",
      provider: rootWire.provider,
      tools: [
        coordinator([child], async (context) => {
          retained = context;
          expect(() => context.child("stranger", stranger, "task")).toThrow("failed");
          await expect(
            context.join([
              {
                key: "fake",
                runId: "fake",
                join: async () => {
                  throw new Error("must not call");
                },
              },
            ]),
          ).rejects.toThrow("only handles");
          return (await context.child("child", child, "task").join()).status;
        }),
      ],
    });
    expect((await root.run("work")).status).toBe("completed");
    expect(() => retained?.child("late", child, "task")).toThrow("delegation has ended");
    expect(childWire.histories).toHaveLength(1);
    const malformedWire = wire([calls(call("child", "task"))]);
    const malformed = defineAgent({
      ...base,
      id: "malformed",
      provider: malformedWire.provider,
      tools: [child.asTool({ name: "child", description: "Ask the child." })],
    });
    const result = await malformed.run("work", {
      host: {
        async child(request) {
          return { snapshot: { ...request.snapshot, runId: "wrong-run" } };
        },
      },
    });
    expect(result.status).toBe("failed");
    expect(childWire.histories).toHaveLength(1);
  });
});
