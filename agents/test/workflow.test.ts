import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Provider } from "@providerkit/core";
import { defineAgent } from "../src/run.ts";
import { AGENT_RUNTIME, defineDelegation } from "../src/delegation.ts";
import { checkReplay, defineWorkflow, StepFailedError } from "../src/workflow.ts";
import { isRecord } from "../src/snapshot.ts";
import type { AgentHost, Answer, Decision, TreeNode } from "../src/types.ts";
import type { WorkflowSnapshot } from "../src/workflow-types.ts";

const input = {
  schema: { type: "object" as const },
  validate(value: unknown) {
    if (!isRecord(value) || typeof value.value !== "number")
      throw new TypeError("Pass a number in value.");
    return { value: value.value };
  },
};
const base = { id: "flow", version: "1", input };
function authority() {
  const decisions = new Map<string, Decision>();
  const saved: TreeNode[] = [];
  const host = {
    authorizeResume: vi.fn(() => {}),
    beforeStep: vi.fn(() => {}),
    beforeTool: vi.fn(() => {}),
    checkpoint: vi.fn((node: TreeNode) => {
      saved.push(structuredClone(node));
    }),
    prepareRequest: vi.fn(() => ({
      scope: {
        actorId: "alice",
        resource: { id: "record", version: "1" },
        expiresAt: Date.now() + 60_000,
      },
    })),
    resolveRequest: vi.fn((_request, evidence: unknown) => {
      const decision = typeof evidence === "string" ? decisions.get(evidence) : undefined;
      if (!decision) throw new Error("Unauthenticated evidence");
      return decision;
    }),
  } satisfies AgentHost;
  return { host, saved, decisions };
}
const textAnswer = (answer: Answer) => {
  if (!answer.text) throw new TypeError("Provide text.");
  return answer.text;
};
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
function fake() {
  let calls = 0;
  const provider: Provider = {
    id: "offline",
    model: "fake",
    async *createStream() {
      calls++;
      yield {
        type: "delta",
        content: "draft",
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0 },
      };
    },
  };
  return { provider, calls: () => calls };
}
afterEach(() => vi.useRealTimers());

describe("ordinary function workflows", () => {
  it("reuses JSON results and validates replay without effects or mutation", async () => {
    const { host } = authority();
    const effect = vi.fn(() => ({ n: 3, absent: undefined }));
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        const result = await ctx.step("read", effect);
        expect(Object.hasOwn(result, "absent")).toBe(false);
        result.n++;
        return result.n;
      },
    });
    const result = await flow.run({ value: 1 }, { host });
    expect(result).toMatchObject({ status: "completed", output: 4 });
    expect(result.snapshot.steps[0]?.result).toEqual({ n: 3 });
    const stored = json(result.snapshot);
    expect(await checkReplay(flow, stored)).toEqual({ ok: true });
    expect(await flow.resume(stored, { host })).toMatchObject({ status: "completed", output: 4 });
    expect(effect).toHaveBeenCalledOnce();
    expect(stored).toEqual(json(result.snapshot));
    if (result.status === "completed") expectTypeOf(result.output).toEqualTypeOf<number>();
  });

  it("refuses old shapes and changed versions or configuration", async () => {
    const { host } = authority();
    const flow = defineWorkflow({
      ...base,
      async run(value) {
        return value.value;
      },
    });
    const done = await flow.run({ value: 1 }, { host });
    const changed = defineWorkflow({
      ...base,
      version: "2",
      async run(value) {
        return value.value;
      },
    });
    await expect(changed.resume(done.snapshot, { host })).rejects.toThrow(/version/);
    await expect(flow.resume({ ...done.snapshot, kind: undefined }, { host })).rejects.toThrow(
      /snapshot/,
    );
    await expect(flow.run({ value: "bad" } as never, { host })).rejects.toThrow(/number/);
  });

  it("detects synchronous duplicate keys before any dispatch", async () => {
    const { host } = authority();
    const effect = vi.fn(() => 1);
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        await Promise.all([ctx.step("same", effect), ctx.step("same", effect)]);
        return null;
      },
    });
    expect(await flow.run({ value: 1 }, { host })).toMatchObject({
      status: "failed",
      error: { code: "duplicate_step_key" },
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(["input", "kind", "skip"] as const)(
    "refuses replay drift in %s before new effects",
    async (change) => {
      const { host } = authority();
      let changed = false;
      const effect = vi.fn(() => 1);
      const flow = defineWorkflow({
        ...base,
        async run(_, ctx) {
          if (!(changed && change === "skip")) {
            if (changed && change === "kind") await ctx.sleep("first", 1);
            else await ctx.step("first", effect, { input: changed && change === "input" ? 2 : 1 });
          }
          if (changed) await ctx.step("new", effect);
          await ctx.ask({ key: "question", message: "Continue?" }, textAnswer);
          return null;
        },
      });
      const waiting = await flow.run({ value: 1 }, { host });
      expect(waiting.status).toBe("suspended");
      changed = true;
      const resumed = await flow.resume(waiting.snapshot, { host });
      expect(resumed.status).toBe("failed");
      if (resumed.status === "failed") expect(resumed.error.code).toMatch(/nondeterministic/);
      expect(effect).toHaveBeenCalledOnce();
    },
  );

  it("matches parallel questions across restarts and preserves completed siblings", async () => {
    const { host, decisions } = authority();
    const effect = vi.fn(() => "kept");
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        const [kept, a, b] = await Promise.all([
          ctx.step("effect", effect),
          ctx.ask({ key: "a", message: "A?" }, textAnswer),
          ctx.ask({ key: "b", message: "B?" }, textAnswer),
        ]);
        return `${kept}:${a}:${b}`;
      },
    });
    const first = await flow.run({ value: 1 }, { host });
    expect(first.status).toBe("suspended");
    if (first.status !== "suspended") throw new Error(JSON.stringify(first));
    expect(first.requests).toHaveLength(2);
    const a = first.requests.find((request) => request.step?.key === "a");
    if (!a) throw new Error("Missing question");
    decisions.set("signed-a", { type: "answer", answer: { text: "one" } });
    const second = await flow.resume(json(first.snapshot), {
      host,
      answers: { [a.id]: "signed-a" },
    });
    expect(second.status).toBe("suspended");
    if (second.status !== "suspended") throw new Error(JSON.stringify(second));
    expect(second.requests).toHaveLength(1);
    decisions.set("signed-b", { type: "answer", answer: { text: "two" } });
    const b = second.requests[0];
    if (!b) throw new Error("Missing second question");
    const done = await flow.resume(json(second.snapshot), {
      host,
      answers: { [b.id]: "signed-b" },
    });
    expect(done).toMatchObject({ status: "completed", output: "kept:one:two" });
    expect(effect).toHaveBeenCalledOnce();
    expect(host.beforeStep).toHaveBeenCalled();
  });

  it("authorizes the validated approval edit while retaining the original request", async () => {
    const { host, decisions } = authority();
    const beforeStep = vi.fn<NonNullable<AgentHost["beforeStep"]>>((step) => {
      if (!isRecord(step.input) || typeof step.input.value !== "number" || step.input.value > 1)
        throw new Error("Only one item is allowed.");
    });
    const policy = { ...host, beforeStep };
    host.prepareRequest.mockImplementation(() => ({
      scope: {
        actorId: "alice",
        resource: { id: "record", version: "1" },
        expiresAt: Date.now() + 60_000,
      },
      ask: { type: "approval", editable: true },
    }));
    const effect = vi.fn(({ input }: { input: { value: number } }) => input.value);
    const flow = defineWorkflow({
      ...base,
      async run(value, ctx) {
        return ctx.step("write", effect, {
          input: value,
          needsApproval: true,
          validateInput: input.validate,
        });
      },
    });
    const waiting = await flow.run({ value: 2 }, { host: policy });
    if (waiting.status !== "suspended" || !waiting.requests[0])
      throw new Error(JSON.stringify(waiting));
    const original = json(waiting.requests[0]);
    decisions.set("signed", { type: "approve", arguments: { value: 1 } });
    const done = await flow.resume(waiting.snapshot, {
      host: policy,
      answers: { [original.id]: "signed" },
    });
    expect(done).toMatchObject({ status: "completed", output: 1 });
    expect(effect).toHaveBeenCalledOnce();
    expect(beforeStep).toHaveBeenCalledTimes(2);
    for (const [step, decided] of beforeStep.mock.calls) {
      expect(step.input).toEqual({ value: 1 });
      expect(decided).toEqual({
        request: original,
        decision: { type: "approve", arguments: { value: 1 } },
      });
    }
    expect(done.snapshot.steps[0]).toMatchObject({
      definition: { input: { value: 2 } },
      asks: [{ request: original, decision: { type: "approve", arguments: { value: 1 } } }],
    });
  });

  it("requires current host ownership even without approval", async () => {
    const effect = vi.fn(() => 1);
    const flow = defineWorkflow({ ...base, run: (_, ctx) => ctx.step("write", effect) });
    expect(await flow.run({ value: 1 })).toMatchObject({
      status: "failed",
      error: { code: "request_host_missing" },
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it("keeps failed steps as data for deterministic fallback", async () => {
    const { host } = authority();
    const effect = vi.fn(() => {
      throw new Error("offline");
    });
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        try {
          return await ctx.step("read", effect);
        } catch (error) {
          if (!(error instanceof StepFailedError)) throw error;
          return "fallback";
        }
      },
    });
    const done = await flow.run({ value: 1 }, { host });
    expect(done).toMatchObject({ status: "completed", output: "fallback" });
    expect(await checkReplay(flow, done.snapshot)).toEqual({ ok: true });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("settles parallel and ignored steps before returning or suspending", async () => {
    const { host } = authority();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        void ctx.step("slow", async () => {
          entered.resolve();
          await release.promise;
          return 7;
        });
        return ctx.ask({ key: "question", message: "Name?" }, textAnswer);
      },
    });
    let settled = false;
    const running = flow.run({ value: 1 }, { host }).then((result) => {
      settled = true;
      return result;
    });
    await entered.promise;
    expect(settled).toBe(false);
    release.resolve();
    const waiting = await running;
    expect(waiting.status).toBe("suspended");
    expect(waiting.snapshot.steps.find((step) => step.key === "slow")).toMatchObject({
      status: "completed",
      result: 7,
    });
  });

  it("saves the running marker and fails closed for interrupted writes", async () => {
    const { host, saved } = authority();
    const effect = vi.fn(() => {
      expect(saved.at(-1)).toMatchObject({
        steps: [{ status: "running", attempts: [{ status: "running" }] }],
      });
      return 4;
    });
    const flow = defineWorkflow({ ...base, run: (_, ctx) => ctx.step("write", effect) });
    await flow.run({ value: 1 }, { host });
    const interrupted = saved.find(
      (node) => node.kind === "workflow" && node.steps[0]?.status === "running",
    );
    expect(await flow.resume(interrupted, { host })).toMatchObject({
      status: "failed",
      error: { code: "interrupted_operation" },
    });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("retries explicit read-only work with separate attempt receipts", async () => {
    const { host } = authority();
    let calls = 0;
    const flow = defineWorkflow({
      ...base,
      run: (_, ctx) =>
        ctx.step(
          "read",
          () => {
            if (++calls === 1) throw new Error("Unavailable");
            return 8;
          },
          { retry: { maxAttempts: 2, replay: "read-only", baseDelayMs: 0 } },
        ),
    });
    const done = await flow.run({ value: 1 }, { host });
    expect(done).toMatchObject({ status: "completed", output: 8 });
    expect(done.snapshot.steps[0]?.attempts.map((attempt) => attempt.status)).toEqual([
      "failed",
      "completed",
    ]);
  });

  it("requires actual reconciliation before retrying a failed write", async () => {
    const { host } = authority();
    const effect = vi.fn(() => {
      throw new Error("Lost reply");
    });
    const flow = defineWorkflow({
      ...base,
      run: (_, ctx) =>
        ctx.step("write", effect, {
          retry: { maxAttempts: 2, replay: "reconcile", baseDelayMs: 0 },
        }),
    });
    expect(await flow.run({ value: 1 }, { host })).toMatchObject({
      status: "failed",
      error: { code: "step_retry_unsafe" },
    });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("durably sleeps and resumes only after the recorded wake", async () => {
    const { host } = authority();
    vi.useFakeTimers({ toFake: ["Date"] });
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        await ctx.sleep("wait", 1_000);
        return 5;
      },
    });
    const waiting = await flow.run({ value: 1 }, { host });
    if (waiting.status !== "suspended" || !waiting.wakeAt) throw new Error(JSON.stringify(waiting));
    expect(await flow.resume(waiting.snapshot, { host })).toMatchObject({
      status: "suspended",
      wakeAt: waiting.wakeAt,
    });
    vi.setSystemTime(waiting.wakeAt);
    expect(await flow.resume(waiting.snapshot, { host })).toMatchObject({
      status: "completed",
      output: 5,
    });
  });

  it("does not convert cancellation or tree limits into sleep or retries", async () => {
    const { host } = authority();
    const controller = new AbortController();
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        await ctx.step(
          "cancel",
          () => {
            controller.abort();
            return 1;
          },
          { retry: { maxAttempts: 2, replay: "read-only" } },
        );
        return null;
      },
    });
    expect(await flow.run({ value: 1 }, { host, signal: controller.signal })).toMatchObject({
      status: "cancelled",
    });
    const tooLong = defineWorkflow({
      ...base,
      treeLimits: { elapsedMs: 10 },
      async run(_, ctx) {
        await ctx.sleep("wait", 100);
        return null;
      },
    });
    expect(await tooLong.run({ value: 1 }, { host })).toMatchObject({
      status: "limited",
      limit: "treeElapsedMs",
    });
    const loop = defineWorkflow({
      ...base,
      limits: { steps: 2 },
      async run(_, ctx) {
        for (let i = 0; i < 3; i++) await ctx.step(`step-${i}`, () => i);
        return null;
      },
    });
    expect(await loop.run({ value: 1 }, { host })).toMatchObject({
      status: "limited",
      limit: "steps",
    });
  });

  it("nests workflow and agent children under one tree and single agent slot", async () => {
    const { host } = authority();
    const wire = fake();
    const writer = defineAgent({
      id: "writer",
      version: "1",
      instructions: "Write",
      provider: wire.provider,
    });
    const inner = defineWorkflow({
      ...base,
      id: "inner",
      agents: [writer],
      async run(_, ctx) {
        const result = await ctx.agent("draft", writer, "Write");
        if (result.status !== "completed") throw new Error("No answer");
        return { draft: result.output };
      },
    });
    const flow = defineWorkflow({
      ...base,
      workflows: [inner],
      treeLimits: { maxParallel: 1 },
      async run(value, ctx) {
        const result = await ctx.workflow("inner", inner, value);
        if (result.status !== "completed") throw new Error("No answer");
        expectTypeOf(result.output).toEqualTypeOf<{ draft: string }>();
        return result.output;
      },
    });
    const done = await flow.run({ value: 1 }, { host });
    expect(done).toMatchObject({
      status: "completed",
      output: { draft: "draft" },
      treeUsage: { inputTokens: 2, outputTokens: 1 },
    });
    expect(wire.calls()).toBe(1);
    expect(await checkReplay(flow, done.snapshot)).toEqual({ ok: true });
    expect(wire.calls()).toBe(1);
  });

  it("uses workflows as typed agent specialists and lifts their wake", async () => {
    const { host } = authority();
    const flow = defineWorkflow({
      ...base,
      async run(value, ctx) {
        await ctx.sleep("wait", 500);
        return value.value * 2;
      },
    });
    const tool = flow.asTool({ name: "flow", description: "Run the workflow" });
    const parent = defineAgent({
      id: "parent",
      version: "1",
      instructions: "Delegate",
      tools: [tool],
      provider: {
        id: "offline",
        model: "fake",
        async *createStream(history) {
          yield history.at(-1)?.role === "tool"
            ? { type: "delta", content: "done", finishReason: "stop" }
            : {
                type: "delta",
                finishReason: "tool_calls",
                toolCalls: [{ index: 0, id: "call", name: "flow", arguments: '{"value":2}' }],
              };
        },
      },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    const waiting = await parent.run("Do work", { host });
    if (waiting.status !== "suspended" || !waiting.wakeAt) throw new Error(JSON.stringify(waiting));
    expect(waiting.snapshot.delegations[0]?.children[0]?.snapshot.kind).toBe("workflow");
    vi.setSystemTime(waiting.wakeAt);
    expect(await parent.resume(json(waiting.snapshot), { host })).toMatchObject({
      status: "completed",
      output: "done",
    });
  });

  it("preserves host-child integrity and refuses changed input on replay", async () => {
    const { host } = authority();
    const wire = fake();
    const writer = defineAgent({
      id: "writer",
      version: "1",
      instructions: "Write",
      provider: wire.provider,
    });
    const flow = defineWorkflow({
      ...base,
      agents: [writer],
      async run(_, ctx) {
        return (await ctx.agent("writer", writer, "Write")).status;
      },
    });
    const result = await flow.run(
      { value: 1 },
      {
        host: {
          ...host,
          async child(_request, execute) {
            const result = await execute();
            result.snapshot.input = "changed";
            return result;
          },
        },
      },
    );
    expect(result.status).toBe("failed");
    expect(wire.calls()).toBe(1);
  });

  it("retains whole-child retry attempts and charges each child admission", async () => {
    const { host, saved } = authority();
    let reads = 0;
    const reader = defineWorkflow({
      ...base,
      id: "reader",
      run: (_, ctx) =>
        ctx.step("read", () => {
          if (++reads === 1) throw new Error("Read unavailable");
          return 6;
        }),
    });
    const flow = defineWorkflow({
      ...base,
      workflows: [reader],
      treeLimits: { maxChildren: 2 },
      async run(value, ctx) {
        const result = await ctx.workflow("reader", reader, value, {
          retry: { maxAttempts: 2, replay: "read-only" },
        });
        if (result.status !== "completed") throw new Error("No answer");
        return result.output;
      },
    });
    const done = await flow.run({ value: 1 }, { host });
    expect(done).toMatchObject({ status: "completed", output: 6 });
    expect(done.snapshot.steps[0]?.children.map((child) => child.snapshot.state.status)).toEqual([
      "failed",
      "completed",
    ]);
    for (const node of saved) expect(() => flow[AGENT_RUNTIME].restore(json(node))).not.toThrow();
    expect(await checkReplay(flow, done.snapshot)).toEqual({ ok: true });
    expect(reads).toBe(2);
  });

  it("workflow-as-tool returns a known local failure as tool feedback", async () => {
    const { host } = authority();
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        return ctx.step("read", () => {
          throw new Error("Read failed");
        });
      },
    });
    const agent = defineAgent({
      id: "owner",
      version: "1",
      instructions: "Delegate",
      tools: [flow.asTool({ name: "flow", description: "Run workflow" })],
      provider: {
        id: "fake",
        model: "fake",
        async *createStream(history) {
          yield history.at(-1)?.role === "tool"
            ? { type: "delta", content: "fallback", finishReason: "stop" }
            : {
                type: "delta",
                finishReason: "tool_calls",
                toolCalls: [{ index: 0, id: "call", name: "flow", arguments: '{"value":1}' }],
              };
        },
      },
    });
    expect(await agent.run("Work", { host })).toMatchObject({
      status: "completed",
      output: "fallback",
    });
  });

  it("replays old completed journals after their execution deadline", async () => {
    const { host } = authority();
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        return ctx.step("read", () => 1);
      },
    });
    const done = await flow.run({ value: 1 }, { host });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(done.snapshot.startedAt + 400_000);
    expect(await checkReplay(flow, done.snapshot)).toEqual({ ok: true });
  });

  it("records invalid results as failed without retrying them", async () => {
    const { host } = authority();
    const effect = vi.fn(() => new Date());
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        try {
          await ctx.step("read", effect, {
            retry: { maxAttempts: 2, replay: "read-only", baseDelayMs: 0 },
          });
        } catch (error) {
          if (!(error instanceof StepFailedError)) throw error;
          return "invalid";
        }
        return "unexpected";
      },
    });
    const done = await flow.run({ value: 1 }, { host });
    expect(done).toMatchObject({ status: "completed", output: "invalid" });
    expect(done.snapshot.steps[0]?.status).toBe("failed");
    expect(effect).toHaveBeenCalledOnce();
  });

  it("retains retrying checkpoints and does not repeat reconciliation", async () => {
    const { host, saved } = authority();
    let calls = 0;
    const reconcile = vi.fn(() => ({
      outcome: "not_run" as const,
      receipt: "host-fenced-attempt",
    }));
    const flow = defineWorkflow({
      ...base,
      run: (_, ctx) =>
        ctx.step(
          "write",
          () => {
            if (++calls === 1) throw new Error("Not dispatched");
            return 2;
          },
          { retry: { maxAttempts: 2, replay: "reconcile", baseDelayMs: 0 } },
        ),
    });
    const done = await flow.run({ value: 1 }, { host: { ...host, reconcileStep: reconcile } });
    expect(done).toMatchObject({ status: "completed", output: 2 });
    for (const node of saved) expect(() => flow[AGENT_RUNTIME].restore(json(node))).not.toThrow();
    const ready = saved.find(
      (node): node is WorkflowSnapshot =>
        node.kind === "workflow" &&
        node.steps[0]?.status === "retrying" &&
        !!node.steps[0].attempts[0]?.reconciliation,
    );
    if (!ready) throw new Error("Missing reconciled receipt");
    expect(await flow.resume(ready, { host: { ...host, reconcileStep: reconcile } })).toMatchObject(
      { status: "completed" },
    );
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("renews expired approval before dispatch and retains the unused reservation", async () => {
    const { host, decisions } = authority();
    vi.useFakeTimers({ toFake: ["Date"] });
    const effect = vi.fn(() => 1);
    const flow = defineWorkflow({
      ...base,
      run: (_, ctx) => ctx.step("write", effect, { needsApproval: true }),
    });
    const waiting = await flow.run({ value: 1 }, { host });
    if (waiting.status !== "suspended" || !waiting.requests[0]) throw new Error("Missing approval");
    decisions.set("approved", { type: "approve" });
    let expired = false;
    const expires = waiting.requests[0].scope.expiresAt;
    const expiringHost = {
      ...host,
      checkpoint(node: TreeNode) {
        if (!expired && node.kind === "workflow" && node.steps[0]?.status === "running") {
          expired = true;
          vi.setSystemTime(expires + 1);
        }
      },
    };
    const renewed = await flow.resume(waiting.snapshot, {
      host: expiringHost,
      answers: { [waiting.requests[0].id]: "approved" },
    });
    expect(renewed.status).toBe("suspended");
    expect(effect).not.toHaveBeenCalled();
    if (renewed.status !== "suspended" || !renewed.requests[0])
      throw new Error(JSON.stringify(renewed));
    expect(renewed.snapshot.steps[0]?.attempts[0]?.status).toBe("not_run");
    expect(
      await flow.resume(json(renewed.snapshot), {
        host,
        answers: { [renewed.requests[0].id]: "approved" },
      }),
    ).toMatchObject({ status: "completed", output: 1 });
  });

  it("resumes workflow questions through typed delegation without granting child tools", async () => {
    const { host, decisions } = authority();
    const flow = defineWorkflow({
      ...base,
      run: (_, ctx) => ctx.ask({ key: "name", message: "Name?" }, textAnswer),
    });
    const delegate = defineDelegation({
      name: "coordinate",
      description: "Coordinate",
      inputSchema: { type: "object" },
      validate: () => ({ value: 1 }),
      specialists: [flow],
      async run(value, ctx) {
        const [result] = await ctx.join([ctx.child("flow", flow, value)]);
        if (result.status === "completed") expectTypeOf(result.output).toEqualTypeOf<string>();
        return "answered";
      },
    });
    const agent = defineAgent({
      id: "owner",
      version: "1",
      instructions: "Delegate",
      tools: [delegate],
      provider: {
        id: "fake",
        model: "fake",
        async *createStream(history) {
          yield history.at(-1)?.role === "tool"
            ? { type: "delta", content: "done", finishReason: "stop" }
            : {
                type: "delta",
                finishReason: "tool_calls",
                toolCalls: [{ index: 0, id: "call", name: "coordinate", arguments: "{}" }],
              };
        },
      },
    });
    const waiting = await agent.run("Ask", { host });
    if (waiting.status !== "suspended" || !waiting.requests[0])
      throw new Error(JSON.stringify(waiting));
    expect(waiting.requests[0].step?.workflowId).toBe("flow");
    expect(waiting.requests[0].path).toHaveLength(1);
    decisions.set("signed", { type: "answer", answer: { text: "Ana" } });
    expect(
      await agent.resume(json(waiting.snapshot), {
        host,
        answers: { [waiting.requests[0].id]: "signed" },
      }),
    ).toMatchObject({ status: "completed", output: "done" });
  });

  it("never turns request-host failures into local specialist feedback", async () => {
    const { host } = authority();
    const flow = defineWorkflow({
      ...base,
      run: (_, ctx) => ctx.ask({ key: "name", message: "Name?" }, textAnswer),
    });
    const parent = defineWorkflow({
      ...base,
      id: "parent",
      workflows: [flow],
      async run(value, ctx) {
        await ctx.workflow("child", flow, value);
        return "must not complete";
      },
    });
    const result = await parent.run(
      { value: 1 },
      {
        host: {
          ...host,
          prepareRequest() {
            throw new Error("Authority store unavailable");
          },
        },
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "workflow_operation_failed" },
    });
  });

  it("preserves child guards and shares model-call limits", async () => {
    const { host } = authority();
    const wire = fake();
    const guarded = defineAgent({
      id: "guarded",
      version: "1",
      instructions: "Read",
      provider: wire.provider,
      guardrails: { identity: "deny-output", modelOutput: () => ({ allow: false }) },
    });
    const denied = defineWorkflow({
      ...base,
      agents: [guarded],
      async run(_, ctx) {
        await ctx.agent("guarded", guarded, "Read");
        return "must not complete";
      },
    });
    expect(await denied.run({ value: 1 }, { host })).toMatchObject({
      status: "failed",
      error: { code: "guard_rejected" },
    });
    const reader = defineAgent({
      id: "reader",
      version: "1",
      instructions: "Read",
      provider: wire.provider,
    });
    const limited = defineWorkflow({
      ...base,
      agents: [reader],
      treeLimits: { modelCalls: 1 },
      async run(_, ctx) {
        await ctx.agent("one", reader, "Read");
        await ctx.agent("two", reader, "Read");
        return "must not complete";
      },
    });
    const result = await limited.run({ value: 1 }, { host });
    expect(result).toMatchObject({
      status: "limited",
      limit: "modelCalls",
      treeUsage: { inputTokens: 2, outputTokens: 1 },
    });
    expect(wire.calls()).toBe(2);
  });

  it("replays dependent parallel branches before admitting their next effects", async () => {
    const { host, decisions } = authority();
    const calls: string[] = [];
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        await Promise.all(
          [0, 1].map(async (index) => {
            await ctx.step(`read-${index}`, () => {
              calls.push(`read-${index}`);
              return index;
            });
            await ctx.ask({ key: `ask-${index}`, message: `Answer ${index}?` }, textAnswer);
            await ctx.step(`write-${index}`, () => {
              calls.push(`write-${index}`);
              return index;
            });
          }),
        );
        return "done";
      },
    });
    const first = await flow.run({ value: 1 }, { host });
    if (first.status !== "suspended") throw new Error(JSON.stringify(first));
    decisions.set("signed", { type: "answer", answer: { text: "yes" } });
    expect(
      await flow.resume(json(first.snapshot), {
        host,
        answers: Object.fromEntries(first.requests.map((request) => [request.id, "signed"])),
      }),
    ).toMatchObject({ status: "completed", output: "done" });
    expect(calls.toSorted()).toEqual(["read-0", "read-1", "write-0", "write-1"]);
  });

  it("resumes an unfinished child beside a longer completed parallel branch", async () => {
    const { host, saved } = authority();
    const wire = fake();
    const writer = defineAgent({
      id: "writer",
      version: "1",
      instructions: "Write",
      provider: wire.provider,
    });
    const first = vi.fn(() => 1);
    const second = vi.fn(({ input }: { input: number }) => input + 1);
    const finish = vi.fn(() => "done");
    const flow = defineWorkflow({
      ...base,
      agents: [writer],
      async run(_, ctx) {
        const [draft, count] = await Promise.all([
          ctx.agent("draft", writer, "Write"),
          (async () => {
            const count = await ctx.step("first", first);
            return ctx.step("second", second, { input: count });
          })(),
        ]);
        if (draft.status !== "completed") throw new Error("No draft");
        return ctx.step("finish", finish, { input: { draft: draft.output, count } });
      },
    });
    const branchSaved = Promise.withResolvers<void>();
    const interrupted = await flow.run(
      { value: 1 },
      {
        host: {
          ...host,
          checkpoint(node) {
            host.checkpoint(node);
            if (
              node.kind === "workflow" &&
              node.steps.find((step) => step.key === "second")?.status === "completed"
            )
              branchSaved.resolve();
          },
          async child() {
            await branchSaved.promise;
            throw new Error("Worker interrupted before child dispatch");
          },
        },
      },
    );
    expect(interrupted).toMatchObject({ status: "failed", error: { code: "child_host_failed" } });
    expect(wire.calls()).toBe(0);
    const checkpoint = saved.find(
      (node): node is WorkflowSnapshot =>
        node.kind === "workflow" &&
        node.steps.find((step) => step.key === "draft")?.status === "running" &&
        node.steps.find((step) => step.key === "second")?.status === "completed",
    );
    if (!checkpoint) throw new Error("Missing parallel checkpoint");
    expect(await checkReplay(flow, checkpoint)).toEqual({ ok: true });
    expect(await flow.resume(json(checkpoint), { host })).toMatchObject({
      status: "completed",
      output: "done",
    });
    expect(wire.calls()).toBe(1);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("freezes step and child inputs at synchronous admission", async () => {
    const { host } = authority();
    const child = defineWorkflow({
      ...base,
      id: "child",
      async run(value) {
        return value.value;
      },
    });
    const flow = defineWorkflow({
      ...base,
      workflows: [child],
      async run(_, ctx) {
        const value = { value: 1 };
        const effect = ctx.step("read", ({ input }) => input.value, { input: value });
        const nested = ctx.workflow("child", child, value);
        value.value = 2;
        const result = await nested;
        return [await effect, result.status === "completed" ? result.output : null];
      },
    });
    const done = await flow.run({ value: 1 }, { host });
    expect(done).toMatchObject({ status: "completed", output: [1, 1] });
    expect(await checkReplay(flow, done.snapshot)).toEqual({ ok: true });
  });

  it("refuses a completed question that differs from its saved answer", async () => {
    const { host, decisions } = authority();
    const flow = defineWorkflow({
      ...base,
      run: (_, ctx) => ctx.ask({ key: "name", message: "Name?" }, textAnswer),
    });
    const waiting = await flow.run({ value: 1 }, { host });
    if (waiting.status !== "suspended" || !waiting.requests[0]) throw new Error("Missing question");
    decisions.set("signed", { type: "answer", answer: { text: "Ana" } });
    const done = await flow.resume(waiting.snapshot, {
      host,
      answers: { [waiting.requests[0].id]: "signed" },
    });
    const changed = json(done.snapshot);
    if (!changed.steps[0]) throw new Error("Missing step");
    changed.steps[0].result = { text: "Different answer" };
    await expect(flow.resume(changed, { host })).rejects.toThrow(/saved answer/);
  });

  it("rechecks ownership after step-start observers run", async () => {
    const { host } = authority();
    let allowed = true;
    const effect = vi.fn(() => 1);
    const flow = defineWorkflow({ ...base, run: (_, ctx) => ctx.step("write", effect) });
    expect(
      await flow.run(
        { value: 1 },
        {
          host: {
            ...host,
            beforeStep() {
              if (!allowed) throw new Error("Access revoked");
            },
          },
          onEvent(event) {
            if (event.type === "step_start") allowed = false;
          },
        },
      ),
    ).toMatchObject({ status: "failed", error: { code: "step_authorization_failed" } });
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(["checkpoint", "child observer"] as const)(
    "rechecks child ownership after the %s revokes access",
    async (boundary) => {
      const { host } = authority();
      const wire = fake();
      const writer = defineAgent({
        id: "writer",
        version: "1",
        instructions: "Write",
        provider: wire.provider,
      });
      const flow = defineWorkflow({
        ...base,
        agents: [writer],
        async run(_, ctx) {
          return (await ctx.agent("draft", writer, "Write")).status;
        },
      });
      let allowed = true;
      const beforeStep = vi.fn(() => {
        if (!allowed) throw new Error("Access revoked");
      });
      const result = await flow.run(
        { value: 1 },
        {
          host: {
            ...host,
            beforeStep,
            checkpoint(node) {
              host.checkpoint(node);
              if (
                boundary === "checkpoint" &&
                node.kind === "workflow" &&
                node.steps[0]?.children.length
              )
                allowed = false;
            },
          },
          onEvent(event) {
            if (boundary === "child observer" && event.type === "child") allowed = false;
          },
        },
      );
      expect(allowed).toBe(false);
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "step_authorization_failed" },
      });
      expect(beforeStep).toHaveBeenCalledTimes(2);
      expect(result.snapshot.steps[0]?.children[0]?.snapshot).toMatchObject({ models: [] });
      expect(wire.calls()).toBe(0);
    },
  );

  it("checks completed branch outputs and all recorded keys", async () => {
    const { host } = authority();
    let branch = true;
    const flow = defineWorkflow({
      ...base,
      async run(_, ctx) {
        if (branch) await ctx.step("read", () => 1);
        return branch ? 1 : 2;
      },
    });
    const done = await flow.run({ value: 1 }, { host });
    branch = false;
    expect(await checkReplay(flow, done.snapshot)).toMatchObject({
      ok: false,
      error: { code: "nondeterministic_workflow" },
    });
  });
});
