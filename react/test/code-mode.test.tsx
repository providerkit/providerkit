// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { defineTool } from "@providerkit/core";
import {
  defineAgent,
  type AgentEvent,
  type AgentHost,
  type RunSnapshot,
} from "@providerkit/agents";
import { codeMode } from "@providerkit/agents/code-mode";
import { createQuickJsDriver } from "@providerkit/agents/code-mode/quickjs";
import { scriptedProvider } from "@providerkit/agents/evals";
import { createAgentProjector, type AgentProjectorOptions } from "../src/agents.ts";
import { createAgUiReader, createAgUiWriter } from "../src/ag-ui.ts";
import {
  emptyChatView,
  parseChatEvent,
  reduceChat,
  type DisplayPart,
  type ToolPart,
} from "../src/protocol.ts";
import { Message } from "../src/ui/message.tsx";

const driver = createQuickJsDriver();
const base = { id: "program-test", version: "1", instructions: "Private instructions" };
const options = { runId: "root", messageId: "reply", agentId: base.id };
const host = { beforeTool() {}, authorizeResume() {} } satisfies AgentHost;
function read(run: (input: Record<string, unknown>) => Promise<unknown>) {
  return defineTool({
    name: "read",
    description: "Read",
    inputSchema: { type: "object" },
    isReadOnly: true,
    run,
  });
}
function outer(snapshot: RunSnapshot) {
  const model = snapshot.models[0];
  if (model?.status !== "completed" || !model.tools[0]) throw new Error("Missing program");
  return model.tools[0];
}
function sorted(parts: readonly DisplayPart[]) {
  return [...parts].sort((a, b) => a.id.localeCompare(b.id));
}
function replay(events: AgentEvent[], settings: AgentProjectorOptions = options) {
  const projector = createAgentProjector(settings);
  const display = events.flatMap((event, seq) => projector.event(event, { seq }));
  for (const event of display)
    expect(parseChatEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
  return { projector, display, view: display.reduce(reduceChat, emptyChatView()) };
}

it("nests real guest calls without exposing source, logs, arguments or results", async () => {
  const input: Record<string, unknown> = JSON.parse(
    '{"text":"\\\\u0061","__proto__":{"private":"PRIVATE_INPUT"}}',
  );
  const effect = vi.fn(
    async (_input: Record<string, unknown>) => "PRIVATE_RESULT" + "é".repeat(1500),
  );
  const mode = codeMode({ tools: [read(effect)], driver });
  const code = `const input = JSON.parse(${JSON.stringify(JSON.stringify(input))});\nconsole.log("PRIVATE_LOG"); return await tools.read(input);`;
  const agent = defineAgent({
    ...base,
    tools: [mode],
    provider: scriptedProvider([
      { toolCalls: [{ name: mode.name, arguments: { code } }] },
      "Public answer",
    ]),
  });
  const events: AgentEvent[] = [];
  const outcome = await agent.run("Private prompt", {
    runId: options.runId,
    host,
    onEvent(event) {
      events.push(event);
    },
  });
  expect(outcome.status).toBe("completed");
  expect(effect.mock.calls[0]?.[0]).toEqual(input);
  expect(Object.hasOwn(effect.mock.calls[0]?.[0] ?? {}, "__proto__")).toBe(true);
  const execution = outer(outcome.snapshot);
  const call = execution.calls?.[0];
  expect(call?.status).toBe("completed");
  if (call?.status !== "completed") throw new Error("Missing receipt");
  expect(new TextEncoder().encode(call.result.content).byteLength).toBeLessThanOrEqual(1024);
  expect(call.result).not.toHaveProperty("output");
  expect(call.result).not.toHaveProperty("images");
  expect(call.result).not.toHaveProperty("final");
  if (execution.status !== "completed" || !execution.result.ok)
    throw new Error("Missing durable program result");
  expect(JSON.parse(execution.result.content).result).toBe("PRIVATE_RESULT" + "é".repeat(1500));
  const { projector, display, view } = replay(events);
  expect(sorted(view.messages[0]!.parts)).toEqual(
    sorted(projector.snapshot(outcome.snapshot).parts),
  );
  expect(view.messages[0]?.parts).toContainEqual(
    expect.objectContaining({
      type: "tool",
      id: call.id,
      parentOperationId: execution.id,
      state: "done",
    }),
  );
  expect(view.messages[0]?.parts.some((part) => part.type === "agent")).toBe(false);
  const serialized = JSON.stringify(display);
  for (const privateText of [
    "PRIVATE_LOG",
    "PRIVATE_INPUT",
    "PRIVATE_RESULT",
    "const input",
    "__proto__",
  ])
    expect(serialized).not.toContain(privateText);
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<Message message={view.messages[0]!} />);
  const rows = container.querySelectorAll('[data-part="tool"]');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.querySelector("[data-parent-operation-id]")).toBe(rows[1]);

  const seen: unknown[] = [];
  const selected = createAgentProjector({
    ...options,
    tool(activity) {
      if (activity.parentOperationId) seen.push(JSON.parse(activity.call.arguments));
      return { summary: activity.result?.ok ? "Read finished" : undefined };
    },
  });
  selected.snapshot(outcome.snapshot);
  expect(seen).toContainEqual(input);
});

it.each(["approve", "deny", "unanswered"] as const)(
  "closes an inner %s approval and keeps it non-actionable",
  async (decision) => {
    const effect = vi.fn(async (input: Record<string, unknown>) => input);
    const mode = codeMode({ tools: [read(effect)], driver });
    const agent = defineAgent({
      ...base,
      tools: [mode],
      provider: scriptedProvider([
        {
          toolCalls: [
            {
              name: mode.name,
              arguments: {
                code: "try { return await tools.read({n: 1}); } catch { return null; }",
              },
            },
          ],
        },
        "Public answer",
      ]),
    });
    const events: AgentEvent[] = [];
    const outcome = await agent.run("Go", {
      runId: options.runId,
      host: {
        ...host,
        needsApproval: (request) => Boolean(request.parentOperationId),
        prepareRequest: (draft) => ({
          scope: {
            actorId: "test",
            resource: { id: "test", version: "1" },
            expiresAt: Date.now() + 60_000,
          },
          ask: { ...draft.ask, type: "approval", editable: true },
        }),
        answerNow: () =>
          decision === "approve"
            ? { type: "approve", arguments: { n: 2 } }
            : decision === "deny"
              ? { type: "deny" }
              : undefined,
      },
      onEvent(event) {
        events.push(event);
      },
    });
    const { projector, view } = replay(events);
    expect(sorted(view.messages[0]!.parts)).toEqual(
      sorted(projector.snapshot(outcome.snapshot).parts),
    );
    expect(view.messages[0]?.parts.find((part) => part.type === "approval")).toMatchObject({
      state: decision === "approve" ? "approved" : decision === "deny" ? "denied" : "stopped",
      canAnswer: false,
    });
    if (decision === "approve") expect(effect.mock.calls[0]?.[0]).toEqual({ n: 2 });
    else expect(effect).not.toHaveBeenCalled();
    expect(outer(outcome.snapshot).calls?.[0]?.arguments).toEqual({ n: 1 });
  },
);

it.each(["outer", "inner"] as const)(
  "preserves a decided %s approval across an older pending checkpoint",
  async (position) => {
    const mode = codeMode({ tools: [read(async () => "ok")], driver });
    const events: AgentEvent[] = [];
    let pending: RunSnapshot | undefined;
    const requestOf = (snapshot: RunSnapshot) => {
      const tool = outerIfPresent(snapshot);
      return (position === "inner" ? tool?.calls?.[0] : tool)?.asks?.[0];
    };
    const outcome = await defineAgent({
      ...base,
      tools: [mode],
      provider: scriptedProvider([
        { toolCalls: [{ name: mode.name, arguments: { code: "return await tools.read({});" } }] },
        "done",
      ]),
    }).run("Go", {
      runId: options.runId,
      onEvent: (event) => {
        events.push(event);
      },
      host: {
        ...host,
        needsApproval: (request) =>
          position === "inner"
            ? Boolean(request.parentOperationId)
            : request.call.name === mode.name,
        prepareRequest: () => ({
          scope: {
            actorId: "test",
            resource: { id: "test", version: "1" },
            expiresAt: Date.now() + 60_000,
          },
        }),
        answerNow: () => ({ type: "approve" }),
        checkpoint(snapshot) {
          if (snapshot.kind !== "agent") return;
          const record = requestOf(snapshot);
          if (record && !record.decision && !record.closed) pending = structuredClone(snapshot);
        },
      },
    });
    expect(outcome.status).toBe("completed");
    if (!pending) throw new Error("Missing pending request checkpoint");
    const projector = createAgentProjector(options);
    let view = emptyChatView();
    const decision = events.findIndex((event) => event.type === "decision");
    expect(decision).toBeGreaterThan(-1);
    for (const event of events.slice(0, decision + 1))
      for (const item of projector.event(event)) view = reduceChat(view, item);
    const saved = projector.snapshot(pending);
    expect(saved.parts.find((part) => part.type === "approval")).toMatchObject({
      state: "approved",
    });
    view = reduceChat(view, {
      v: 1,
      type: "snapshot",
      messages: [saved],
      run: projector.run(pending),
    });
    for (const event of events.slice(decision + 1))
      for (const item of projector.event(event)) view = reduceChat(view, item);
    expect(view.messages[0]?.parts.find((part) => part.type === "approval")).toMatchObject({
      state: "approved",
    });
    const expired = structuredClone(pending);
    const record = requestOf(expired);
    if (!record) throw new Error("Missing request");
    record.closed = "expired";
    expect(
      projector.snapshot(expired).parts.find((part) => part.type === "approval"),
    ).toMatchObject({ state: "expired" });
    const replaced = structuredClone(pending);
    const replacement = requestOf(replaced);
    if (!replacement) throw new Error("Missing replacement");
    replacement.request.scope.resource.version = "2";
    expect(
      projector.snapshot(replaced).parts.find((part) => part.type === "approval"),
    ).toMatchObject({ state: "pending" });
  },
);

it("stops active inner calls when the program is aborted", async () => {
  const stop = new AbortController();
  const mode = codeMode({
    tools: [
      read(async () => {
        stop.abort();
        return "PRIVATE_ABORT_RESULT";
      }),
    ],
    driver,
  });
  const agent = defineAgent({
    ...base,
    tools: [mode],
    provider: scriptedProvider([
      { toolCalls: [{ name: mode.name, arguments: { code: "return await tools.read({});" } }] },
    ]),
  });
  const events: AgentEvent[] = [];
  const outcome = await agent.run("Go", {
    runId: options.runId,
    host,
    signal: stop.signal,
    onEvent(event) {
      events.push(event);
    },
  });
  expect(outcome.status).toBe("cancelled");
  const { projector, view, display } = replay(events);
  expect(sorted(view.messages[0]!.parts)).toEqual(
    sorted(projector.snapshot(outcome.snapshot).parts),
  );
  expect(
    view.messages[0]?.parts
      .filter((part) => part.type === "tool")
      .every((part) => part.state === "failed"),
  ).toBe(true);
  expect(JSON.stringify(display)).not.toContain("PRIVATE_ABORT_RESULT");
});

it("keeps retries operation-local and restores the pending retry without a receipt", async () => {
  let attempt = 0;
  const mode = codeMode({
    tools: [
      read(async () => {
        if (++attempt === 1) throw new Error("PRIVATE_FAILURE");
        return "ok";
      }),
    ],
    driver,
  });
  const agent = defineAgent({
    ...base,
    tools: [mode],
    toolRetries: { identity: "reads", tools: { read: { maxAttempts: 2, replay: "read-only" } } },
    provider: scriptedProvider([
      { toolCalls: [{ name: mode.name, arguments: { code: "return await tools.read({});" } }] },
      "Public answer",
    ]),
  });
  let pending: RunSnapshot | undefined;
  const events: AgentEvent[] = [];
  const outcome = await agent.run("Go", {
    runId: options.runId,
    host: {
      ...host,
      checkpoint(snapshot) {
        if (snapshot.kind === "agent" && outerIfPresent(snapshot)?.calls?.[0]?.status === "pending")
          pending = structuredClone(snapshot);
      },
    },
    onEvent(event) {
      events.push(event);
    },
  });
  const { projector, view } = replay(events);
  expect(sorted(view.messages[0]!.parts)).toEqual(
    sorted(projector.snapshot(outcome.snapshot).parts),
  );
  const inner = outer(outcome.snapshot).calls![0]!;
  expect(view.messages[0]?.parts.find((part) => part.id === inner.id)).toMatchObject({
    state: "done",
    attempt: 2,
  });
  expect(view.messages[0]?.parts.find((part) => part.type === "text")).toMatchObject({
    text: "Public answer",
  });
  const restart = events.findIndex(
    (event) => event.type === "operation_restart" && event.operationId === inner.id,
  );
  expect(restart).toBeGreaterThan(-1);
  if (!pending) throw new Error("Missing pending checkpoint");
  const restored = createAgentProjector(options);
  const message = restored.snapshot(pending);
  let current = reduceChat(emptyChatView(), {
    v: 1,
    type: "snapshot",
    messages: [message],
    run: restored.run(pending),
  });
  for (const event of events.slice(restart))
    for (const display of restored.event(event)) current = reduceChat(current, display);
  expect(sorted(current.messages[0]!.parts)).toEqual(sorted(view.messages[0]!.parts));
  const old = events.find(
    (event) => event.type === "tool_result" && event.request.operationId === inner.id,
  );
  expect(old && restored.event(old)).toEqual([]);
  const live = createAgentProjector(options);
  let latest = emptyChatView();
  for (const event of events) {
    for (const display of live.event(event)) latest = reduceChat(latest, display);
    if (
      event.type === "tool_start" &&
      event.request.operationId === inner.id &&
      event.request.attemptId === inner.attemptId
    ) {
      latest = reduceChat(latest, {
        v: 1,
        type: "snapshot",
        messages: [live.snapshot(pending)],
        run: live.run(pending),
      });
    }
  }
  expect(sorted(latest.messages[0]!.parts)).toEqual(sorted(view.messages[0]!.parts));
});

function outerIfPresent(snapshot: RunSnapshot) {
  const model = snapshot.models[0];
  return model?.status === "completed" ? model.tools[0] : undefined;
}

it.each(["pending", "running"] as const)(
  "restores %s calls under a restarted program",
  async (status) => {
    const mode = codeMode({ tools: [read(async () => 4)], driver });
    const recovery = { identity: "reads", maxAttempts: 2, readOnlyTools: [mode.name] };
    const make = (code: boolean) =>
      defineAgent({
        ...base,
        tools: [mode],
        recovery,
        provider: scriptedProvider([
          ...(code
            ? [
                {
                  toolCalls: [
                    { name: mode.name, arguments: { code: "return await tools.read({});" } },
                  ],
                },
              ]
            : []),
          "Public answer",
        ]),
      });
    const initial = await make(true).run("Go", { runId: options.runId, host });
    const checkpoint = structuredClone(initial.snapshot);
    const model = checkpoint.models[0];
    const completed = outer(checkpoint);
    const call = completed.calls?.[0];
    if (
      model?.status !== "completed" ||
      completed.status !== "completed" ||
      call?.status !== "completed"
    )
      throw new Error("Missing completed program");
    const { result: _result, bytes: _bytes, ...inner } = call;
    model.tools[0] = {
      id: completed.id,
      attemptId: completed.attemptId,
      status: "running",
      interrupted: [],
      retries: [],
      calls: [{ ...inner, status, started: status === "running" }],
    };
    checkpoint.models = [model];
    checkpoint.state = { status: "running" };
    const projector = createAgentProjector(options);
    let view = reduceChat(emptyChatView(), {
      v: 1,
      type: "snapshot",
      messages: [projector.snapshot(checkpoint)],
      run: projector.run(checkpoint),
    });
    const outcome = await make(false).resume(checkpoint, {
      host,
      onEvent(event) {
        for (const display of projector.event(event)) view = reduceChat(view, display);
        if (event.type === "operation_restart" && event.operationId === completed.id) {
          expect(view.messages[0]?.parts.find((part) => part.id === inner.id)).toMatchObject({
            state: "failed",
          });
          expect(
            projector.event({
              type: "tool_start",
              request: {
                agentId: base.id,
                version: base.version,
                runId: checkpoint.runId,
                operationId: inner.id,
                parentOperationId: completed.id,
                attemptId: inner.attemptId,
                call: {
                  id: inner.id,
                  name: inner.name,
                  arguments: JSON.stringify(inner.arguments),
                },
                arguments: inner.arguments,
              },
            }),
          ).toEqual([]);
        }
      },
    });
    expect(outcome.status).toBe("completed");
    expect(sorted(view.messages[0]!.parts)).toEqual(
      sorted(createAgentProjector(options).snapshot(outcome.snapshot).parts),
    );
    const program = outer(outcome.snapshot);
    expect(program.calls).toHaveLength(2);
    expect(new Set(program.calls?.map((call) => call.id)).size).toBe(2);
    expect(view.messages[0]?.parts.find((part) => part.id === program.id)).toMatchObject({
      attempt: 2,
      state: "done",
    });
  },
);

it("preserves program parents in owned AG-UI and warns about native flattening", () => {
  const binding = { threadId: "thread", agUiRunId: "wire", runId: "root", segment: "segment" };
  const writer = createAgUiWriter({ binding });
  const reader = createAgUiReader({ binding });
  const parts: ToolPart[] = [
    { type: "tool", id: "outer", label: "Program", state: "running" },
    {
      type: "tool",
      id: "inner",
      parentOperationId: "outer",
      label: "Read",
      state: "done",
      attempt: 2,
    },
  ];
  const written = writer.write({
    v: 1,
    type: "snapshot",
    messages: [{ id: "reply", role: "assistant", parts, state: "live" }],
    run: { id: "root", status: "running" },
  });
  expect(written.issues).toContainEqual(expect.objectContaining({ code: "unsupported" }));
  const events = written.events.flatMap((event) => reader.read(event).events);
  const view = events.reduce(reduceChat, emptyChatView());
  expect(view.messages[0]?.parts).toEqual(parts);
  expect(written.events.some((event) => event.type === "SUBAGENT_STARTED")).toBe(false);
});

it("does not loop or cross owners for malformed parents and refuses stale reparenting", () => {
  const parts: ToolPart[] = [
    { type: "tool", id: "a", parentOperationId: "b", label: "A", state: "running" },
    { type: "tool", id: "b", parentOperationId: "a", label: "B", state: "running" },
    {
      type: "tool",
      id: "c",
      parentOperationId: "a",
      agentId: "other",
      label: "C",
      state: "running",
    },
  ];
  const message = { id: "reply", role: "assistant", parts, state: "live" } as const;
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<Message message={message} />);
  expect(container.querySelectorAll('[data-part="tool"]')).toHaveLength(3);
  expect(container.querySelector('[data-tool-id="a"] [data-tool-id="c"]')).toBeNull();
  const view = reduceChat(emptyChatView(), { v: 1, type: "message", message });
  expect(
    reduceChat(view, {
      v: 1,
      type: "part",
      messageId: "reply",
      part: { ...parts[0]!, parentOperationId: "c", attempt: 2 },
    }),
  ).toBe(view);
  expect(
    parseChatEvent({
      v: 1,
      type: "part",
      messageId: "reply",
      part: { ...parts[0], parentOperationId: "a" },
    }),
  ).toBeNull();
});
