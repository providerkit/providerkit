/// <reference types="bun" />
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defineAgent,
  defineDelegation,
  defineHandoff,
  type AgentEvent,
  type AgentHost,
  type ResultSchema,
  type TreeNode,
} from "@providerkit/agents";
import { defineWorkflow, StepFailedError } from "@providerkit/agents/workflow";
import { ProviderError, type Provider, type ToolCall } from "@providerkit/core";
import { createAgentProjector, type AgentProjectorOptions } from "../src/agents.ts";
import { createAgUiWriter } from "../src/ag-ui.ts";
import {
  emptyChatView,
  parseChatEvent,
  reduceChat,
  type ChatEvent,
  type DisplayPart,
  type ToolPart,
} from "../src/protocol.ts";
import { createChatClient } from "../src/client.ts";
import { Message } from "../src/ui/message.tsx";
import { RunStatusDisplay } from "../src/ui/status.tsx";
import { DemoRun } from "../examples/chat/runtime.ts";
import { workflowAgent } from "../examples/chat/workflow.ts";
import type { DemoStats } from "../examples/chat/shared.ts";

const input: ResultSchema<{ text: string }> = {
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  validate: (value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("text" in value) ||
      typeof value.text !== "string"
    )
      throw new Error("Expected text");
    return { text: value.text };
  },
};
const host = {
  prepareRequest: (draft) => ({
    scope: {
      actorId: "viewer",
      resource: { id: "thread", version: "1" },
      expiresAt: Date.now() + 60_000,
    },
    ...(draft.ask.type === "approval" && { ask: { ...draft.ask, editable: true } }),
  }),
  authorizeResume() {},
  beforeStep() {},
  resolveRequest: (request) =>
    request.ask.type === "question"
      ? { type: "answer", answer: { text: "Chosen" } }
      : { type: "approve", arguments: { count: 1 } },
} satisfies AgentHost;
function provider(turns: (string | ToolCall[])[]): Provider {
  let index = 0;
  return {
    id: "script",
    model: "script",
    async *createStream() {
      const turn = turns[index++];
      if (turn === undefined) throw new Error("Unexpected provider call");
      if (typeof turn === "string") yield { type: "delta", content: turn };
      else yield { type: "delta", toolCalls: turn.map((call, index) => ({ ...call, index })) };
      yield { type: "finish", finishReason: typeof turn === "string" ? "stop" : "tool_calls" };
    },
  };
}
function call(name: string, arguments_ = "{}"): ToolCall {
  return { id: `call-${name}`, name, arguments: arguments_ };
}
function replay(events: AgentEvent[], options: AgentProjectorOptions) {
  const projector = createAgentProjector(options);
  const display = events.flatMap((event, seq) => projector.event(event, { seq }));
  for (const event of display)
    expect(parseChatEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
  return { projector, display, view: display.reduce(reduceChat, emptyChatView()) };
}
function sorted(parts: readonly DisplayPart[]) {
  return [...parts].sort((a, b) => a.id.localeCompare(b.id));
}
afterEach(() => vi.useRealTimers());

it("projects agent -> workflow -> agent trees without leaking step payloads or changing the owner", async () => {
  const leaf = defineAgent({
    id: "reader",
    version: "1",
    instructions: "Private",
    provider: provider(["PRIVATE_CHILD_TEXT"]),
  });
  const workflow = defineWorkflow({
    id: "review",
    version: "1",
    input,
    agents: [leaf],
    async run(value, ctx) {
      await ctx.step(
        "private-key",
        ({ report }) => {
          report("PRIVATE_PROGRESS");
          return "PRIVATE_RESULT";
        },
        { input: value },
      );
      await ctx.agent("read", leaf, value.text);
      try {
        await ctx.step("fail", () => {
          throw new Error("PRIVATE_ERROR");
        });
      } catch {
        /* This workflow continues after this local failure. */
      }
      return "PRIVATE_OUTPUT";
    },
  });
  const tool = defineDelegation({
    name: "review",
    description: "Review the example",
    inputSchema: { type: "object" },
    validate: () => undefined,
    specialists: [workflow],
    run: async (_value, ctx) =>
      (await ctx.child("review", workflow, { text: "PRIVATE_INPUT" }).join()).status,
  });
  const root = defineAgent({
    id: "guide",
    version: "1",
    instructions: "Private",
    tools: [tool],
    provider: provider([
      [call(tool.name, JSON.stringify({ input: "PRIVATE_INPUT" }))],
      "Public answer",
    ]),
  });
  const events: AgentEvent[] = [];
  const outcome = await root.run("PRIVATE_INPUT", {
    runId: "root",
    host,
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(outcome.status).toBe("completed");
  const options = { runId: "root", messageId: "reply", agentId: root.id };
  const { projector, display, view } = replay(events, options);
  expect(sorted(view.messages[0]!.parts)).toEqual(
    sorted(projector.snapshot(outcome.snapshot).parts),
  );
  expect(createAgentProjector(options).run(outcome.snapshot)).toEqual(view.run);
  const rows = view.messages[0]!.parts;
  const workflowRow = rows.find((part) => part.type === "agent" && part.kind === "workflow");
  expect(workflowRow).toMatchObject({ workflowId: "review", state: "completed" });
  expect(workflowRow).not.toHaveProperty("agentId");
  expect(rows).toContainEqual(
    expect.objectContaining({ type: "agent", agentId: "reader", parentId: workflowRow?.id }),
  );
  expect(rows.filter((part) => part.type === "tool" && part.kind === "step")).toHaveLength(3);
  // Opaque operation ids can contain fixed step keys. Labels and payloads must not copy them.
  expect(
    rows.flatMap((part) => (part.type === "tool" && part.kind === "step" ? [part.label] : [])),
  ).toEqual(["Step", "Step", "Step"]);
  expect(JSON.stringify([display, projector.snapshot(outcome.snapshot)])).not.toMatch(
    /PRIVATE_(INPUT|RESULT|PROGRESS|ERROR|OUTPUT|CHILD_TEXT)/,
  );
  const approved = createAgentProjector({
    ...options,
    labels: { workflow: { review: "Review plan" }, step: { "private-key": "Check the plan" } },
    step: (step) => ({
      summary: step.status === "completed" ? "Checked" : "Checking",
      ...(step.result === "PRIVATE_RESULT" && { detail: "One check passed" }),
    }),
  });
  expect(approved.snapshot(outcome.snapshot).parts).toContainEqual(
    expect.objectContaining({ label: "Check the plan", detail: "One check passed" }),
  );
});

it("links step questions and edited approvals without inventing a ToolRequest or browser action", async () => {
  const effect = vi.fn();
  const flow = defineWorkflow({
    id: "questions",
    version: "1",
    input,
    async run(_value, ctx) {
      await ctx.ask(
        { key: "question", message: "PRIVATE_QUESTION", freeText: true },
        (answer) => answer.text,
      );
      await ctx.step(
        "approval",
        ({ input }) => {
          effect(input);
          return "PRIVATE_RESULT";
        },
        {
          input: { count: 2 },
          needsApproval: true,
          validateInput: (value) => {
            if (
              typeof value !== "object" ||
              value === null ||
              !("count" in value) ||
              value.count !== 1
            )
              throw new Error("One only");
            return { count: value.count };
          },
        },
      );
      return "Done";
    },
  });
  const events: AgentEvent[] = [];
  const onEvent = (event: AgentEvent) => {
    events.push(event);
  };
  const waiting = await flow.run({ text: "PRIVATE_INPUT" }, { runId: "root", host, onEvent });
  if (waiting.status !== "suspended") throw new Error(waiting.status);
  expect(waiting.requests[0]?.step).toBeDefined();
  expect(waiting.requests[0]?.call).toBeUndefined();
  const options: AgentProjectorOptions = { runId: "root", messageId: "reply", workflowId: flow.id };
  expect(createAgentProjector(options).run(waiting.snapshot)).toMatchObject({
    waitingFor: "response",
    owner: undefined,
  });
  const hidden = createAgentProjector(options).snapshot(waiting.snapshot);
  expect(hidden.parts).toContainEqual(
    expect.objectContaining({ type: "question", canAnswer: false }),
  );
  expect(JSON.stringify(hidden)).not.toContain("PRIVATE_");
  const approval = await flow.resume(waiting.snapshot, {
    host,
    answers: { [waiting.requests[0]!.id]: "host-evidence" },
    onEvent,
  });
  if (approval.status !== "suspended") throw new Error(approval.status);
  const request = approval.requests[0]!;
  const show = createAgentProjector({
    ...options,
    request: ({ request }) =>
      request.ask.type === "approval"
        ? {
            title: "Check one item?",
            edit: {
              schema: {
                type: "object",
                properties: { count: { type: "integer", minimum: 1, maximum: 1 } },
              },
              value: { count: 1 },
            },
          }
        : { title: "What should be checked?", freeText: true },
  });
  const saved = show.snapshot(approval.snapshot);
  expect(saved.parts).toContainEqual(
    expect.objectContaining({
      type: "approval",
      toolId: request.step?.operationId,
      edit: { schema: expect.any(Object), value: { count: 1 } },
    }),
  );
  const done = await flow.resume(approval.snapshot, {
    host,
    answers: { [request.id]: "host-evidence" },
    onEvent,
  });
  expect(done.status).toBe("completed");
  expect(effect).toHaveBeenCalledExactlyOnceWith({ count: 1 });
  const { projector, view } = replay(events, options);
  expect(sorted(view.messages[0]!.parts)).toEqual(sorted(projector.snapshot(done.snapshot).parts));
  const handler = vi.fn(() => ({ unsafe: true }));
  const client = createAgentProjector({
    ...options,
    clientTools: { approval: handler },
    request: () => ({ canAnswer: true }),
  });
  const fakeClient = {
    ...request,
    ask: { type: "client" as const, resultSchema: { type: "object" as const } },
  };
  const row = client
    .event({ type: "request", request: fakeClient })
    .find((event) => event.type === "part" && event.part.type === "client-tool");
  expect(row).toMatchObject({ part: { canAnswer: false } });
  expect(row && "part" in row ? row.part : undefined).not.toHaveProperty("name");
  expect(handler).not.toHaveBeenCalled();
  if (row?.type !== "part") throw new Error("Expected a display-only client request");
  const execute = vi.fn();
  const browser = createChatClient({
    transport: { respond: async () => {} },
    initialMessages: [{ id: "reply", role: "assistant", state: "live", parts: [row.part] }],
    clientTools: { approval: { safety: "read-only", run: execute } },
  });
  const detach = browser.attach();
  expect((await browser.startClientTool(request.id)).ok).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  detach();
});

it("settles a denied step after restoring its pre-execution approval snapshot", async () => {
  const effect = vi.fn(() => "Done");
  const flow = defineWorkflow({
    id: "denied-step",
    version: "1",
    input,
    async run(_value, ctx) {
      try {
        await ctx.step("approval", effect, { needsApproval: true });
      } catch (error) {
        if (!(error instanceof StepFailedError)) throw error;
      }
      await ctx.sleep("pause", 5000);
      return "Done";
    },
  });
  const waiting = await flow.run({ text: "Private" }, { runId: "root", host });
  if (waiting.status !== "suspended") throw new Error(waiting.status);
  const step = waiting.snapshot.steps[0]!;
  expect(step.attempts).toEqual([]);
  const options = { runId: "root", messageId: "reply", workflowId: flow.id };
  const projector = createAgentProjector(options);
  let view = reduceChat(emptyChatView(), {
    v: 1,
    type: "snapshot",
    messages: [projector.snapshot(waiting.snapshot)],
    run: projector.run(waiting.snapshot),
  });
  const events: AgentEvent[] = [];
  const continued = await flow.resume(waiting.snapshot, {
    host: { ...host, resolveRequest: () => ({ type: "deny" }) },
    answers: { [waiting.requests[0]!.id]: "host-evidence" },
    onEvent: (event) => {
      events.push(event);
      view = projector.event(event).reduce(reduceChat, view);
    },
  });
  expect(continued.status).toBe("suspended");
  expect(continued.snapshot.attemptId).not.toBe(waiting.snapshot.attemptId);
  expect(continued.snapshot.steps[0]).toMatchObject({ status: "failed", attempts: [] });
  expect(events.some((event) => event.type === "step_start" && event.operationId === step.id)).toBe(
    false,
  );
  expect(effect).not.toHaveBeenCalled();
  expect(view.messages[0]!.parts).toContainEqual(
    expect.objectContaining({ id: step.id, kind: "step", state: "failed", attempt: 1 }),
  );
  expect(view.run).toMatchObject({ status: "waiting", waitingFor: "continuation" });
  expect(view.messages[0]).toEqual(createAgentProjector(options).snapshot(continued.snapshot));
});

it("keeps hidden workflow steps out of native approval and child tool references", async () => {
  const child = defineAgent({
    id: "checker",
    version: "1",
    instructions: "Check the plan",
    provider: provider(["Checked"]),
  });
  const flow = defineWorkflow({
    id: "hidden-steps",
    version: "1",
    input,
    agents: [child],
    async run(value, ctx) {
      await ctx.agent("check", child, value.text);
      return ctx.step("approval", () => "Done", { needsApproval: true });
    },
  });
  const waiting = await flow.run({ text: "Private" }, { runId: "root", host });
  if (waiting.status !== "suspended") throw new Error(waiting.status);
  const projector = createAgentProjector({
    runId: "root",
    messageId: "reply",
    step: () => null,
  });
  const message = projector.snapshot(waiting.snapshot);
  expect(message.parts.some((part) => part.type === "tool")).toBe(false);
  const writer = createAgUiWriter({
    binding: { threadId: "thread", runId: "root", segment: "first", agUiRunId: "execution" },
  });
  const mapped = writer.write({
    v: 1,
    type: "snapshot",
    messages: [message],
    run: projector.run(waiting.snapshot),
  });
  expect(mapped.issues).toEqual([]);
  const native = mapped.events.find((event) => event.type === "RUN_FINISHED");
  expect(native).toMatchObject({
    outcome: {
      type: "interrupt",
      interrupts: [{ id: waiting.requests[0]!.id, reason: "input" }],
    },
  });
  expect(JSON.stringify(native)).not.toContain("toolCallId");
  const started = mapped.events.find((event) => event.type === "SUBAGENT_STARTED");
  expect(started).toMatchObject({
    subagentRunId: waiting.snapshot.steps[0]!.children[0]!.snapshot.runId,
  });
  expect(started).not.toHaveProperty("parentToolCallId");
  expect(mapped.events.some((event) => event.type.startsWith("TOOL_CALL"))).toBe(false);
});

it("shows a saved sleep with no human requests and keeps the host's wake time informational", async () => {
  vi.useFakeTimers();
  const flow = defineWorkflow({
    id: "sleeper",
    version: "1",
    input,
    async run(_value, ctx) {
      await ctx.sleep("pause", 5000);
      return "Done";
    },
  });
  const events: AgentEvent[] = [];
  const outcome = await flow.run(
    { text: "PRIVATE" },
    {
      runId: "root",
      host,
      onEvent: (event) => {
        events.push(event);
      },
    },
  );
  if (outcome.status !== "suspended") throw new Error(outcome.status);
  expect(outcome.requests).toEqual([]);
  const { projector, view } = replay(events, {
    runId: "root",
    messageId: "reply",
    workflowId: flow.id,
  });
  expect(view.run).toMatchObject({ status: "waiting", waitingFor: "continuation" });
  expect(view.run.wakeAt).toBeUndefined();
  const info = createAgentProjector({ runId: "root", messageId: "reply" }).run(outcome.snapshot);
  expect(info).toMatchObject({ wakeAt: outcome.wakeAt, waitingFor: "continuation" });
  expect(view.messages[0]).toEqual(projector.snapshot(outcome.snapshot));
  const html = renderToStaticMarkup(
    <>
      <Message message={view.messages[0]!} />
      <RunStatusDisplay run={info} labels={{ waitingUntil: () => "Scheduled for later." }} />
    </>,
  );
  expect(html).toContain("Waiting to continue");
  expect(html).toContain("Scheduled for later.");
  expect(html).not.toMatch(/your answer|response|Approve/);
  const timers = vi.getTimerCount();
  await vi.advanceTimersByTimeAsync(6000);
  expect(vi.getTimerCount()).toBe(timers);
  expect(info.status).toBe("waiting");
  const done = await flow.resume(outcome.snapshot, { host, answers: {} });
  expect(done.status).toBe("completed");
});

it("uses real effect attempts for retries, ignores late progress and keeps model epochs independent", async () => {
  vi.useFakeTimers();
  const flow = defineWorkflow({
    id: "retry",
    version: "1",
    input,
    async run(_value, ctx) {
      return ctx.step(
        "read",
        ({ attempt, report }) => {
          report(`PRIVATE_PROGRESS_${attempt}`);
          if (attempt === 1) throw new Error("PRIVATE_ERROR");
          return "Done";
        },
        { retry: { maxAttempts: 2, replay: "read-only", baseDelayMs: 5000, retryOn: () => true } },
      );
    },
  });
  const events: AgentEvent[] = [];
  const onEvent = (event: AgentEvent) => {
    events.push(event);
  };
  const waiting = await flow.run({ text: "PRIVATE" }, { runId: "root", host, onEvent });
  if (waiting.status !== "suspended") throw new Error(waiting.status);
  expect(
    createAgentProjector({ runId: "root", messageId: "reply" }).run(waiting.snapshot),
  ).toMatchObject({ waitingFor: "continuation", wakeAt: waiting.wakeAt });
  await vi.advanceTimersByTimeAsync(6000);
  const done = await flow.resume(waiting.snapshot, { host, answers: {}, onEvent });
  expect(done.status).toBe("completed");
  const options = { runId: "root", messageId: "reply", workflowId: flow.id };
  const second = events.findIndex((event) => event.type === "step_start" && event.attempt === 2);
  expect(second).toBeGreaterThan(0);
  const { projector, view: started } = replay(events.slice(0, second + 1), options);
  const oldProgress = events.find((event) => event.type === "step_progress")!;
  const oldStart = events.find((event) => event.type === "step_start")!;
  const oldResult = events.find((event) => event.type === "step_result")!;
  expect(projector.snapshot(waiting.snapshot).parts[0]).toMatchObject({
    attempt: 2,
    state: "running",
  });
  expect(projector.event(oldProgress)).toEqual([]);
  expect(projector.event(oldStart)).toEqual([]);
  expect(projector.event(oldResult)).toEqual([]);
  const result = events
    .slice(second + 1)
    .flatMap((event) => projector.event(event))
    .reduce(reduceChat, started);
  expect(result.messages[0]!.parts[0]).toMatchObject({ kind: "step", attempt: 2, state: "done" });
  expect(result.messages[0]).toEqual(projector.snapshot(done.snapshot));
  const prior: ChatEvent = {
    v: 1,
    type: "part",
    messageId: "reply",
    part: {
      type: "tool",
      kind: "step",
      id: result.messages[0]!.parts[0]!.id,
      attempt: 1,
      state: "failed",
      label: "Step",
    },
  };
  expect(reduceChat(result, prior)).toBe(result);
  // A step's effect attempt is not a run attempt. A sibling child can still finish on its epoch.
  const p = createAgentProjector({
    runId: "workflow",
    workflowId: "workflow",
    messageId: "reply",
    text: () => true,
  });
  const child: AgentEvent = {
    type: "child",
    kind: "agent",
    parentRunId: "workflow",
    operationId: "child-operation",
    key: "child",
    runId: "child",
    agentId: "writer",
    version: "1",
  };
  p.event(child);
  p.event({
    type: "model_chunk",
    runId: "child",
    operationId: "model",
    attemptId: "model-epoch",
    chunk: { type: "delta", content: "Answer" },
  });
  p.event({
    type: "step_start",
    kind: "step",
    runId: "workflow",
    operationId: "step",
    key: "step",
    attemptId: "effect-attempt",
    attempt: 1,
  });
  expect(
    p.event({
      type: "state",
      runId: "child",
      attemptId: "model-epoch",
      state: { status: "completed", candidate: "Answer" },
    }),
  ).toContainEqual(
    expect.objectContaining({
      type: "part",
      part: expect.objectContaining({ id: "child", state: "completed" }),
    }),
  );
});

it("keeps child retries as distinct rows without inventing effect attempts", async () => {
  let calls = 0;
  const child = defineAgent({
    id: "reader",
    version: "1",
    instructions: "Read",
    provider: {
      id: "offline",
      model: "retry-child",
      async *createStream() {
        if (++calls === 1) throw new ProviderError("offline", "network", "PRIVATE_CHILD_FAILURE");
        yield { type: "delta", content: "PRIVATE_CHILD_REPLY" };
        yield { type: "finish", finishReason: "stop" };
      },
    },
  });
  const workflow = defineWorkflow({
    id: "retry-child",
    version: "1",
    input,
    agents: [child],
    async run(value, ctx) {
      return (
        await ctx.agent("read", child, value.text, {
          retry: { maxAttempts: 2, replay: "read-only" },
        })
      ).status;
    },
  });
  const events: AgentEvent[] = [];
  const outcome = await workflow.run(
    { text: "PRIVATE_INPUT" },
    {
      runId: "root",
      host,
      onEvent: (event) => {
        events.push(event);
      },
    },
  );
  expect(outcome.status, JSON.stringify(outcome.snapshot.state)).toBe("completed");
  expect(calls).toBe(2);
  const { projector, view } = replay(events, {
    runId: "root",
    workflowId: workflow.id,
    messageId: "reply",
  });
  expect(view.messages[0]).toEqual(projector.snapshot(outcome.snapshot));
  const children = view.messages[0]!.parts.filter((part) => part.type === "agent");
  expect(children.map((child) => child.state)).toEqual(["failed", "completed"]);
  expect(view.messages[0]!.parts[0]).toMatchObject({ kind: "step", state: "done", attempt: 1 });
  expect(JSON.stringify(view)).not.toContain("PRIVATE_");
});

it("keeps handoff text and owner separate from workflow specialists, including after a progress gap", async () => {
  const leaf = defineAgent({
    id: "leaf",
    version: "1",
    instructions: "Private",
    provider: provider(["PRIVATE_LEAF"]),
  });
  const flow = defineWorkflow({
    id: "review",
    version: "1",
    input,
    agents: [leaf],
    async run(value, ctx) {
      await ctx.agent("leaf", leaf, value.text);
      return "Checked";
    },
  });
  const tool = defineDelegation({
    name: "review",
    description: "Review",
    inputSchema: { type: "object" },
    validate: () => undefined,
    specialists: [flow],
    run: async (_value, ctx) =>
      (await ctx.child("review", flow, { text: "Private" }).join()).status,
  });
  const target = defineAgent({
    id: "owner",
    version: "1",
    instructions: "Private",
    tools: [tool],
    provider: provider([
      [call(tool.name, JSON.stringify({ input: "Private" }))],
      "The public reply",
    ]),
  });
  const transfer = defineHandoff({ name: "transfer", description: "Transfer", to: target });
  const root = defineAgent({
    id: "root-agent",
    version: "1",
    instructions: "Private",
    tools: [transfer],
    provider: provider([[call(transfer.name)]]),
  });
  const events: AgentEvent[] = [];
  const snapshots: TreeNode[] = [];
  const done = await root.run("Private", {
    runId: "root",
    onEvent: (event) => {
      events.push(event);
    },
    host: {
      ...host,
      checkpoint: (snapshot) => {
        snapshots.push(snapshot);
      },
    },
  });
  expect(done.status).toBe("completed");
  const options = { runId: "root", messageId: "reply", agentId: root.id };
  const { projector, view } = replay(events, options);
  expect(view.run.owner?.agentId).toBe("owner");
  expect(createAgentProjector(options).run(done.snapshot).owner).toEqual(view.run.owner);
  expect(JSON.stringify(view)).not.toContain("PRIVATE_LEAF");
  expect(sorted(view.messages[0]!.parts)).toEqual(sorted(projector.snapshot(done.snapshot).parts));
  const gap = createAgentProjector(options);
  gap.gap();
  const incomplete = events
    .flatMap((event) => gap.event(event))
    .reduce(reduceChat, emptyChatView());
  expect(JSON.stringify(incomplete)).not.toContain("The public reply");
  const final: ChatEvent = {
    v: 1,
    type: "snapshot",
    messages: [gap.snapshot(done.snapshot)],
    run: gap.run(done.snapshot),
  };
  expect(JSON.stringify(reduceChat(incomplete, final))).toContain("The public reply");
  const live = snapshots.find(
    (node) =>
      node.state.status === "running" &&
      createAgentProjector(options)
        .snapshot(node)
        .parts.some((part) => part.type === "agent"),
  );
  expect(live).toBeDefined();
  const stopped = { ...live!, state: { status: "cancelled" as const } };
  expect(
    createAgentProjector(options)
      .snapshot(stopped)
      .parts.every(
        (part) =>
          (part.type !== "agent" && part.type !== "tool") ||
          (part.state !== "running" && part.state !== "waiting"),
      ),
  ).toBe(true);
});

it("runs the offline workflow example through questions, edited input and a host-claimed wake", async () => {
  vi.useFakeTimers();
  const stats: DemoStats = {
    runs: 0,
    modelCalls: 0,
    toolCalls: 0,
    decisions: 0,
    observers: 0,
    events: 0,
    continuations: 0,
    clientEffects: 0,
    clientCompletions: 0,
    reservations: 0,
    gaps: 0,
  };
  let view = emptyChatView();
  const work = new DemoRun(
    "viewer",
    "thread",
    workflowAgent(stats, 1),
    stats,
    (event) => {
      view = reduceChat(view, event);
    },
    (run) => {
      if (run.snapshot)
        view = reduceChat(view, {
          v: 1,
          type: "snapshot",
          messages: [run.projector.snapshot(run.snapshot)],
          run: run.projector.run(run.snapshot),
        });
    },
    () => {},
  );
  work.start();
  await work.done;
  expect(view.run).toMatchObject({ status: "waiting", waitingFor: "response" });
  const question = view.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "question" && part.state === "pending");
  expect(question).toBeDefined();
  await work.respond({
    answers: [
      { requestId: question!.id, response: { type: "answer", answer: { choices: ["morning"] } } },
    ],
  });
  expect(view.run.status, JSON.stringify(work.snapshot?.state)).toBe("waiting");
  const approval = view.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "approval" && part.state === "pending");
  expect(approval).toMatchObject({ edit: { value: { label: "Reading room visit" } } });
  const approving = work.respond({
    answers: [
      {
        requestId: approval!.id,
        response: { type: "approve", arguments: { label: "Edited visit plan" } },
      },
    ],
  });
  await vi.advanceTimersByTimeAsync(20);
  await approving;
  expect(
    work.projector.snapshot(work.snapshot!).parts.find((part) => part.type === "approval"),
  ).toMatchObject({ state: "approved", edit: { value: { label: "Edited visit plan" } } });
  expect(view.run).toMatchObject({
    status: "waiting",
    waitingFor: "continuation",
    wakeAt: expect.any(Number),
  });
  expect(
    view.messages
      .flatMap((message) => message.parts)
      .some(
        (part) =>
          (part.type === "question" || part.type === "approval") && part.state === "pending",
      ),
  ).toBe(false);
  await expect(work.continueScheduled()).rejects.toMatchObject({ code: "too_early" });
  const calls = stats.toolCalls;
  await vi.advanceTimersByTimeAsync(5000);
  expect(view.run.status).toBe("waiting");
  await work.continueScheduled();
  expect(view.run.status).toBe("completed");
  expect(stats.toolCalls).toBe(calls);
  expect(stats.clientEffects).toBe(0);
  expect(JSON.stringify(view)).not.toContain("INTERNAL_ONLY");
});

it("validates workflow identities and attempts and preserves settled rows across saved progress", () => {
  const workflow = {
    type: "agent",
    kind: "workflow",
    workflowId: "review",
    id: "workflow",
    label: "Review",
    state: "waiting",
  };
  const event = (part: unknown) => ({ v: 1, type: "part", messageId: "reply", part });
  expect(parseChatEvent(event(workflow))).toEqual(event(workflow));
  expect(parseChatEvent(event({ ...workflow, agentId: "fake-agent" }))).toBeNull();
  expect(parseChatEvent(event({ ...workflow, workflowId: undefined }))).toBeNull();
  expect(parseChatEvent(event({ ...workflow, kind: "delegation" }))).toBeNull();
  const step: ToolPart = {
    type: "tool",
    kind: "step",
    id: "step",
    label: "Step",
    state: "done",
    attempt: 2,
  };
  for (const attempt of [0, -1, 1.5, "2"])
    expect(parseChatEvent(event({ ...step, attempt }))).toBeNull();
  const saved: ChatEvent = {
    v: 1,
    type: "snapshot",
    messages: [{ id: "reply", role: "assistant", state: "live", parts: [step] }],
    run: { id: "root", status: "running" },
  };
  const view = reduceChat(emptyChatView(), saved);
  expect(
    reduceChat(view, {
      ...saved,
      messages: [{ ...saved.messages[0]!, parts: [{ ...step, state: "running" }] }],
    }),
  ).toBe(view);
  expect(
    reduceChat(view, {
      v: 1,
      type: "part",
      messageId: "reply",
      part: { ...step, attempt: 1, state: "failed" },
    }),
  ).toBe(view);
  const next = reduceChat(view, {
    v: 1,
    type: "part",
    messageId: "reply",
    part: { ...step, attempt: 3, state: "running" },
  });
  expect(next.messages[0]!.parts[0]).toMatchObject({ attempt: 3, state: "running" });
  const html = renderToStaticMarkup(
    <Message
      message={{
        id: "reply",
        role: "assistant",
        state: "live",
        parts: [
          {
            type: "agent",
            kind: "workflow",
            workflowId: "review",
            id: "workflow",
            label: "Fallback",
            state: "waiting",
          },
          { ...step, agentId: "workflow", state: "waiting" },
        ],
      }}
      specialistLabels={{ review: "Review the plan" }}
    />,
  );
  expect(html).toContain("Review the plan");
  expect(html).toContain('data-kind="step"');
  expect(html).not.toContain("your answer");
});
