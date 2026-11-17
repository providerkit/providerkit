import { describe, expect, it } from "vitest";
import {
  createAgUiReader,
  createAgUiWriter,
  readResumeEntry,
  toResumeEntry,
  toProviderkitResumeEntry,
  type AgUiBinding,
  type AgUiEvent,
  type AgUiReaderOptions,
} from "../src/ag-ui.ts";
import {
  emptyChatView,
  reduceChat,
  type ChatEvent,
  type DisplayPart,
  type RequestPart,
  type RequestResponse,
} from "../src/protocol.ts";

const binding: AgUiBinding = {
  threadId: "conversation",
  runId: "logical",
  segment: "segment-2",
  agUiRunId: "execution-9",
};
const start = { type: "RUN_STARTED", threadId: binding.threadId, runId: binding.agUiRunId };
const finish = {
  type: "RUN_FINISHED",
  threadId: binding.threadId,
  runId: binding.agUiRunId,
  outcome: { type: "success" },
};
const numbered = (events: ChatEvent[]) =>
  events.map((event, seq) => ({ ...event, segment: binding.segment, seq }));
const message: ChatEvent = {
  v: 1,
  type: "message",
  message: { id: "message", role: "assistant", parts: [], state: "live" },
};
const run: ChatEvent = {
  v: 1,
  type: "run",
  run: { id: binding.runId, status: "running", messageId: "message" },
};
const part = (value: DisplayPart): ChatEvent => ({
  v: 1,
  type: "part",
  messageId: "message",
  part: value,
});
const text = (value: string, settled = false, attempt?: number): ChatEvent =>
  part({ type: "text", id: "text", text: value, settled, ...(attempt && { attempt }) });
const done: ChatEvent = { v: 1, type: "run", run: { id: binding.runId, status: "completed" } };
const approval: RequestPart = {
  type: "approval",
  id: "request",
  title: "Publish the page?",
  toolId: "tool",
  state: "pending",
  canAnswer: true,
};

function native(options: Omit<AgUiReaderOptions, "binding"> = {}) {
  const reader = createAgUiReader({ binding, ...options });
  let view = emptyChatView();
  const read = (event: unknown, seq?: number) => {
    const result = reader.read(
      event,
      seq === undefined ? undefined : { seq, segment: binding.segment },
    );
    view = result.events.reduce(reduceChat, view);
    return result;
  };
  read(start, 0);
  return { reader, read, view: () => view };
}

function roundTrip(events: ChatEvent[], expectedIssues: string[] = []) {
  const issues: string[] = [];
  const writer = createAgUiWriter({ binding });
  const reader = createAgUiReader({ binding });
  const wire: AgUiEvent[] = [];
  let view = emptyChatView();
  for (const event of events) {
    const written = writer.write(event);
    issues.push(...written.issues.map((item) => item.code));
    wire.push(...written.events);
    for (const value of written.events) {
      const read = reader.read(value);
      expect(read.issues).toEqual([]);
      view = read.events.reduce(reduceChat, view);
    }
  }
  expect(issues).toEqual(expectedIssues);
  return { writer, reader, wire, view };
}

describe("AG-UI mapping", () => {
  it("round-trips workflow rows, retry attempts and wake times without native tool or fake agent calls", () => {
    const row: DisplayPart = {
      type: "tool",
      kind: "step",
      id: "operation",
      attempt: 1,
      label: "Check plan",
      state: "running",
      agentId: "workflow",
    };
    const workflow: DisplayPart = {
      type: "agent",
      kind: "workflow",
      workflowId: "review",
      id: "workflow",
      label: "Review",
      state: "running",
    };
    const events = numbered([
      run,
      message,
      part(workflow),
      part(row),
      part({ ...row, attempt: 2 }),
      part({ ...row, attempt: 2, state: "waiting" }),
      part({ ...workflow, state: "waiting" }),
      {
        v: 1,
        type: "run",
        run: { id: binding.runId, status: "waiting", waitingFor: "continuation", wakeAt: 2000 },
      },
    ]);
    const result = roundTrip(events, [
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
    ]);
    expect(result.view).toEqual(events.reduce(reduceChat, emptyChatView()));
    expect(
      result.wire.filter(
        (event) => event.type.startsWith("TOOL_CALL") || event.type.startsWith("SUBAGENT"),
      ),
    ).toEqual([]);
    expect(result.wire.filter((event) => event.type === "STEP_STARTED")).toHaveLength(2);
    expect(result.wire.filter((event) => event.type === "STEP_FINISHED")).toHaveLength(1);
    expect(result.wire.find((event) => event.type === "RUN_FINISHED")).toMatchObject({
      outcome: { type: "interrupt", interrupts: [] },
    });
    const nativeOnly = createAgUiReader({ binding });
    let view = emptyChatView();
    for (const event of result.wire) {
      if (event.type === "CUSTOM") continue;
      const { metadata: _metadata, ...plain } = event;
      const mapped = nativeOnly.read(plain);
      expect(mapped.issues.filter((issue) => issue.code !== "unsupported")).toEqual([]);
      view = mapped.events.reduce(reduceChat, view);
    }
    expect(view.run).toMatchObject({ status: "waiting", waitingFor: "continuation" });
    expect(view.run.wakeAt).toBeUndefined();
    expect(
      view.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool")
        .map((part) => part.state),
    ).toEqual(["done", "waiting"]);
    expect(nativeOnly.end().issues).toEqual([]);
  });

  it("keeps step-origin approvals out of native tool-call routing", () => {
    const writer = createAgUiWriter({ binding });
    const mapped = writer.write({
      v: 1,
      type: "snapshot",
      messages: [
        {
          id: "reply",
          role: "assistant",
          state: "live",
          parts: [
            {
              type: "tool",
              kind: "step",
              id: "operation",
              label: "Check",
              state: "waiting",
              attempt: 1,
            },
            {
              type: "approval",
              id: "request",
              toolId: "operation",
              title: "Check one item?",
              state: "pending",
            },
          ],
        },
      ],
      run: { id: binding.runId, status: "waiting", waitingFor: "response" },
    });
    expect(mapped.events.filter((event) => event.type.startsWith("TOOL_CALL"))).toEqual([]);
    const native = mapped.events.find((event) => event.type === "RUN_FINISHED");
    expect(native).toMatchObject({
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "request", reason: "input", message: "Check one item?" }],
      },
    });
    expect(JSON.stringify(native)).not.toContain("toolCallId");
  });
  it("keeps native approval and child links when their model tool row exists", () => {
    const events = numbered([
      run,
      message,
      part({ type: "tool", id: "tool", name: "lookup", label: "Find a page", state: "waiting" }),
      part(approval),
      part({
        type: "agent",
        id: "child",
        agentId: "reader",
        toolId: "tool",
        label: "Reader",
        state: "running",
      }),
      { v: 1, type: "run", run: { id: binding.runId, status: "waiting" } },
    ]);
    const result = roundTrip(events);
    const tool = result.wire.find((event) => event.type === "TOOL_CALL_START");
    if (tool?.type !== "TOOL_CALL_START") throw new Error("Expected a native model tool call");
    expect(result.wire.find((event) => event.type === "SUBAGENT_STARTED")).toMatchObject({
      parentToolCallId: tool.toolCallId,
    });
    expect(result.wire.find((event) => event.type === "RUN_FINISHED")).toMatchObject({
      outcome: {
        type: "interrupt",
        interrupts: [{ id: approval.id, reason: "tool_call", toolCallId: tool.toolCallId }],
      },
    });
    expect(result.view).toEqual(events.reduce(reduceChat, emptyChatView()));
  });

  it("emits native text/tool/run events and exactly round-trips display ids and cursors", () => {
    const events = numbered([
      run,
      message,
      text("Hello"),
      { v: 1, type: "text", messageId: "message", partId: "text", delta: " there" },
      text("Hello there", true),
      part({ type: "tool", id: "tool", name: "lookup", label: "Find a page", state: "running" }),
      part({
        type: "tool",
        id: "tool",
        name: "lookup",
        label: "Find a page",
        state: "done",
        summary: "Found one page",
      }),
      {
        v: 1,
        type: "message",
        message: { id: "message", role: "assistant", state: "settled", parts: [] },
      },
      done,
    ]);
    const result = roundTrip(events);
    expect(result.view).toEqual(events.reduce(reduceChat, emptyChatView()));
    expect(result.wire[0]).toMatchObject({ type: "RUN_STARTED", runId: binding.agUiRunId });
    const kinds = result.wire.map((event) => event.type);
    for (const type of [
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ])
      expect(kinds).toContain(type);
    expect(kinds).not.toContain("TOOL_CALL_ARGS");
    expect(result.writer.end().issues).toEqual([]);
    expect(result.reader.end().issues).toEqual([]);
    const tool = result.wire.find((event) => event.type === "TOOL_CALL_START");
    expect(tool?.type).toBe("TOOL_CALL_START");
    if (tool?.type === "TOOL_CALL_START")
      expect(
        result.wire.some(
          (event) =>
            event.type === "TEXT_MESSAGE_START" && event.messageId === tool.parentMessageId,
        ),
      ).toBe(true);
  });

  it("maps native frames to display data, deduplicates host cursors and hides raw payloads", () => {
    const fixture = native();
    expect(
      fixture.read({ type: "TEXT_MESSAGE_START", messageId: "native", role: "assistant" }, 1)
        .issues,
    ).toEqual([]);
    fixture.read({ type: "TEXT_MESSAGE_CONTENT", messageId: "native", delta: "Answer" }, 2);
    expect(
      fixture.read({ type: "TEXT_MESSAGE_CONTENT", messageId: "native", delta: "Answer" }, 2)
        .events,
    ).toEqual([]);
    fixture.read({ type: "TEXT_MESSAGE_END", messageId: "native" }, 3);
    fixture.read(
      {
        type: "TOOL_CALL_START",
        toolCallId: "call",
        toolCallName: "lookup",
        parentMessageId: "native",
      },
      4,
    );
    expect(
      fixture.read({ type: "TOOL_CALL_ARGS", toolCallId: "call", delta: "private-arguments" }, 5)
        .issues[0]?.code,
    ).toBe("hidden");
    fixture.read({ type: "TOOL_CALL_END", toolCallId: "call" }, 6);
    fixture.read(
      {
        type: "TOOL_CALL_RESULT",
        toolCallId: "call",
        messageId: "result",
        content: "private-result",
      },
      7,
    );
    fixture.read(
      { type: "REASONING_MESSAGE_CONTENT", messageId: "thought", delta: "private-reasoning" },
      8,
    );
    fixture.read({ type: "RAW", event: { token: "private-token" } }, 9);
    fixture.read({ type: "STATE_SNAPSHOT", snapshot: { secret: "private-state" } }, 10);
    expect(fixture.read(finish, 11).issues).toEqual([]);
    expect(JSON.stringify(fixture.view())).not.toContain("private-");
    expect(fixture.view().messages[0]?.parts[0]).toMatchObject({ text: "Answer", settled: true });
    expect(fixture.view().messages[0]?.parts[1]).toMatchObject({ state: "done" });
    expect(fixture.view().run.id).toBe(binding.runId);
    expect(fixture.view().cursor).toEqual({ segment: binding.segment, seq: 11 });
  });

  it("keeps requests, delivery receipts, handoff ownership and progress gaps in display extensions", () => {
    const events = numbered([
      run,
      message,
      part({
        type: "agent",
        id: "child/no/parsed/ancestry",
        agentId: "billing",
        parentId: "root-child",
        kind: "handoff",
        toolId: "handoff-call",
        state: "running",
        label: "Billing",
      }),
      {
        v: 1,
        type: "run",
        run: {
          id: binding.runId,
          status: "running",
          owner: { runId: "child/no/parsed/ancestry", agentId: "billing", label: "Billing" },
        },
      },
      part(approval),
      part({
        type: "question",
        id: "question",
        state: "pending",
        title: "Which page?",
        choices: [{ id: "short", label: "Short page" }],
        canAnswer: true,
      }),
      part({
        type: "client-tool",
        id: "device",
        state: "pending",
        title: "Read the selection",
        name: "selection",
        canAnswer: false,
      }),
      {
        v: 1,
        type: "input",
        input: {
          id: "steer",
          rootRunId: binding.runId,
          status: "queued",
          text: "Use the short one",
        },
      },
      {
        v: 1,
        type: "input",
        input: {
          id: "steer",
          rootRunId: binding.runId,
          runId: "child/no/parsed/ancestry",
          status: "consumed",
        },
      },
      part({
        type: "text",
        id: "partial",
        text: "Prefix",
        settled: false,
        incomplete: true,
        agentId: "child/no/parsed/ancestry",
        attempt: 2,
      }),
      {
        v: 1,
        type: "run",
        run: {
          id: binding.runId,
          status: "waiting",
          owner: { runId: "child/no/parsed/ancestry", agentId: "billing", label: "Billing" },
        },
      },
    ]);
    const result = roundTrip(events);
    expect(result.view).toEqual(events.reduce(reduceChat, emptyChatView()));
    const terminal = result.wire.find((event) => event.type === "RUN_FINISHED");
    expect(terminal).toMatchObject({
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "request" }, { id: "question" }, { id: "device" }],
      },
    });
    expect(result.wire).toContainEqual(
      expect.objectContaining({
        type: "SUBAGENT_STARTED",
        subagentRunId: "child/no/parsed/ancestry",
      }),
    );
    expect(JSON.stringify(result.wire)).not.toContain("pendingToolCallIds");
  });

  it("replaces attempts through native snapshots and preserves settled, incomplete and stale-delta rules", () => {
    const events = numbered([
      run,
      message,
      text("Old partial"),
      text("New", false, 2),
      { v: 1, type: "text", messageId: "message", partId: "text", delta: " stale", attempt: 1 },
      part({ type: "text", id: "text", text: "New", settled: false, attempt: 2, incomplete: true }),
      { v: 1, type: "text", messageId: "message", partId: "text", delta: " unknown", attempt: 2 },
      {
        v: 1,
        type: "snapshot",
        messages: [
          {
            id: "message",
            role: "assistant",
            state: "settled",
            parts: [
              { type: "text", id: "text", text: "New full answer", settled: true, attempt: 2 },
            ],
          },
        ],
        run: { id: binding.runId, status: "completed" },
      },
      text("late replay"),
    ]);
    const result = roundTrip(events);
    expect(result.view).toEqual(events.reduce(reduceChat, emptyChatView()));
    expect(
      result.wire.filter((event) => event.type === "MESSAGES_SNAPSHOT").length,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(result.view)).not.toContain("unknown");
    expect(JSON.stringify(result.view)).not.toContain("late replay");
    expect(result.writer.write(events[3]).events).toEqual([]);
    for (const event of result.wire) expect(result.reader.read(event).issues).toEqual([]);
  });

  it("hydrates snapshots and accepts settled corrections without reopening a native run", () => {
    const snapshot: ChatEvent = {
      v: 1,
      type: "snapshot",
      messages: [
        {
          id: "m",
          clientId: "client",
          role: "user",
          state: "settled",
          parts: [
            { type: "text", id: "t", text: "Hello", settled: true },
            { type: "attachment", id: "file", name: "Notes", mediaType: "text/plain" },
          ],
        },
      ],
      run: { id: binding.runId, status: "completed" },
    };
    const correction: ChatEvent = {
      v: 1,
      type: "snapshot",
      messages: [
        {
          id: "m",
          clientId: "client",
          role: "user",
          state: "settled",
          parts: [{ type: "text", id: "t", text: "Corrected", settled: true }],
        },
      ],
      run: { id: binding.runId, status: "completed" },
    };
    const result = roundTrip(numbered([snapshot, correction]));
    expect(result.wire.filter((event) => event.type === "RUN_STARTED")).toHaveLength(1);
    expect(result.wire.filter((event) => event.type === "RUN_FINISHED")).toHaveLength(1);
    expect(result.wire.filter((event) => event.type === "MESSAGES_SNAPSHOT")).toHaveLength(2);
    expect(result.view.messages[0]?.parts[0]).toMatchObject({ text: "Corrected" });
  });

  it("refuses stale namespaces, mismatched cursors and incomplete display frame groups", () => {
    const writer = createAgUiWriter({ binding });
    const first = writer.write({ ...run, seq: 0, segment: binding.segment }).events;
    const foreign = createAgUiReader({ binding: { ...binding, agUiRunId: "other" } });
    expect(foreign.read(first[0]).issues[0]?.code).toBe("namespace");
    const forged = createAgUiReader({ binding });
    expect(forged.read({ ...first[0], runId: "foreign-execution" }).issues[0]?.code).toBe(
      "namespace",
    );
    const broken = createAgUiReader({ binding });
    expect(broken.read(first.at(-1)).issues[0]?.code).toBe("framing");
    expect(broken.read(first[0]).events).toEqual([]);
    expect(broken.end().issues[0]?.code).toBe("incomplete");
    const duplicate = createAgUiReader({ binding });
    duplicate.read(first[0]);
    expect(duplicate.read(first[0]).issues[0]?.code).toBe("incomplete");
    const mismatch = createAgUiReader({ binding });
    mismatch.read(first[0]);
    expect(mismatch.read(first.at(-1), { seq: 4, segment: binding.segment }).issues[0]?.code).toBe(
      "namespace",
    );
    const nativeScope = native();
    expect(nativeScope.read({ ...finish, runId: binding.runId }).issues[0]?.code).toBe("namespace");
  });

  it("handles native chunk boundaries and steps without inventing successful stream endings", () => {
    const fixture = native();
    fixture.read({ type: "TEXT_MESSAGE_CHUNK", messageId: "chunk", delta: "One" });
    fixture.read({ type: "TEXT_MESSAGE_CHUNK", delta: " two" });
    fixture.read({ type: "STEP_STARTED", stepName: "Lookup" });
    fixture.read({ type: "STEP_FINISHED", stepName: "Lookup" });
    fixture.read({
      type: "TOOL_CALL_CHUNK",
      toolCallId: "tool",
      toolCallName: "lookup",
      delta: "secret",
    });
    fixture.read({
      type: "TOOL_CALL_RESULT",
      messageId: "result",
      toolCallId: "tool",
      content: "secret",
    });
    expect(fixture.read(finish).issues).toEqual([]);
    expect(fixture.view().messages[0]?.parts[0]).toMatchObject({ text: "One two", settled: true });
    const stepPart = fixture
      .view()
      .messages.flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.kind === "step");
    expect(stepPart).toMatchObject({
      kind: "step",
      label: "Lookup",
      state: "done",
    });
    const writer = createAgUiWriter({ binding });
    const mapped = writer.write({
      v: 1,
      type: "snapshot",
      messages: fixture.view().messages,
      run: fixture.view().run,
    });
    expect(mapped.events.map((event) => event.type)).toContain("STEP_STARTED");
    expect(mapped.events.map((event) => event.type)).toContain("STEP_FINISHED");
    expect(
      roundTrip(
        [{ v: 1, type: "snapshot", messages: fixture.view().messages, run: fixture.view().run }],
        ["unsupported"],
      ).view.messages,
    ).toEqual(fixture.view().messages);
    const unfinished = native();
    unfinished.read({ type: "TEXT_MESSAGE_START", messageId: "open" });
    expect(unfinished.read(finish).issues[0]?.code).toBe("incomplete");
    expect(unfinished.reader.end().events).toEqual([]);
    expect(unfinished.view().run.status).toBe("running");
  });

  it("keeps implicit chunks in their own root or child lane", () => {
    const fixture = native();
    fixture.read({ type: "TEXT_MESSAGE_CHUNK", messageId: "root-text", delta: "Public" });
    fixture.read({ type: "SUBAGENT_STARTED", subagentRunId: "child", name: "Helper" });
    const before = fixture.view();
    expect(
      fixture.read({
        type: "TEXT_MESSAGE_CHUNK",
        subagentRunId: "child",
        delta: "private-child",
      }).issues[0]?.code,
    ).toBe("framing");
    expect(fixture.view()).toBe(before);
    fixture.read({
      type: "TEXT_MESSAGE_CHUNK",
      messageId: "child-text",
      subagentRunId: "child",
      delta: "private-child",
    });
    for (const event of [
      { type: "TEXT_MESSAGE_CHUNK", messageId: "root-text", subagentRunId: "child" },
      { type: "TEXT_MESSAGE_CHUNK", messageId: "child-text" },
    ])
      expect(fixture.read({ ...event, delta: "private-wrong-owner" }).issues[0]?.code).toBe(
        "framing",
      );
    fixture.read({ type: "TEXT_MESSAGE_CHUNK", delta: " answer" });
    fixture.read({ type: "TEXT_MESSAGE_CHUNK", subagentRunId: "child", delta: "private-more" });
    expect(fixture.read(finish).issues).toEqual([]);
    expect(fixture.view().messages[0]?.parts[0]).toMatchObject({
      text: "Public answer",
      settled: true,
    });
    expect(JSON.stringify(fixture.view())).not.toContain("private-");

    const tools = native();
    tools.read({ type: "TOOL_CALL_CHUNK", toolCallId: "root-call", toolCallName: "lookup" });
    tools.read({ type: "SUBAGENT_STARTED", subagentRunId: "child", name: "Helper" });
    expect(
      tools.read({ type: "TOOL_CALL_CHUNK", subagentRunId: "child", delta: "private-args" })
        .issues[0]?.code,
    ).toBe("framing");
    tools.read({
      type: "TOOL_CALL_CHUNK",
      toolCallId: "child-call",
      toolCallName: "lookup",
      subagentRunId: "child",
    });
    expect(tools.read({ type: "TOOL_CALL_CHUNK", delta: "private-args" }).issues[0]?.code).toBe(
      "hidden",
    );
    for (const [toolCallId, subagentRunId] of [
      ["root-call", undefined],
      ["child-call", "child"],
    ]) {
      tools.read({
        type: "TOOL_CALL_RESULT",
        toolCallId,
        subagentRunId,
        messageId: `${toolCallId}-result`,
        content: "private-result",
      });
    }
    expect(
      tools
        .view()
        .messages.flatMap((message) => message.parts)
        .filter((part) => part.type === "tool"),
    ).toMatchObject([
      { id: "root-call", state: "done" },
      { id: "child-call", state: "done" },
    ]);
  });

  it("refuses duplicate, end-before-start and post-end frames without changing held text", () => {
    const fixture = native();
    expect(fixture.read({ type: "TEXT_MESSAGE_END", messageId: "missing" }).issues[0]?.code).toBe(
      "framing",
    );
    fixture.read({ type: "TEXT_MESSAGE_START", messageId: "known" });
    expect(fixture.read({ type: "TEXT_MESSAGE_START", messageId: "known" }).events).toEqual([]);
    fixture.read({ type: "TEXT_MESSAGE_CONTENT", messageId: "known", delta: "Kept" });
    fixture.read({ type: "TEXT_MESSAGE_END", messageId: "known" });
    expect(
      fixture.read({ type: "TEXT_MESSAGE_CONTENT", messageId: "known", delta: "late" }).issues[0]
        ?.code,
    ).toBe("framing");
    expect(
      fixture.read({
        type: "TOOL_CALL_RESULT",
        messageId: "r",
        toolCallId: "unknown",
        content: "private",
      }).issues[0]?.code,
    ).toBe("framing");
    expect(fixture.read({ type: "NEW_EVENT", message: "private" }).issues[0]?.code).toBe(
      "unsupported",
    );
    expect(
      fixture.read({ type: "TEXT_MESSAGE_CONTENT", messageId: "known", delta: 4 }).events,
    ).toEqual([]);
    expect(fixture.view().messages[0]?.parts[0]).toMatchObject({ text: "Kept" });
  });

  it("projects native snapshot tool results and hides system, reasoning and arbitrary app state", () => {
    const fixture = native({ tool: () => ({ summary: "Safe result" }) });
    const result = fixture.read({
      type: "MESSAGES_SNAPSHOT",
      messages: [
        { id: "system", role: "system", content: "private-system" },
        { id: "reasoning", role: "reasoning", content: "private-reasoning" },
        {
          id: "assistant",
          role: "assistant",
          content: "Public",
          toolCalls: [
            {
              id: "tool",
              type: "function",
              function: { name: "lookup", arguments: "private-args" },
            },
          ],
        },
        { id: "result", role: "tool", toolCallId: "tool", content: "private-result", error: true },
      ],
    });
    expect(
      result.issues.every((issue) => issue.code === "hidden" || issue.code === "unsupported"),
    ).toBe(true);
    expect(fixture.view().messages).toHaveLength(1);
    expect(fixture.view().messages[0]?.parts[1]).toMatchObject({
      state: "failed",
      summary: "Safe result",
    });
    expect(JSON.stringify(fixture.view())).not.toContain("private-");
    const failure = native();
    failure.read({
      type: "RUN_ERROR",
      message: "private-vendor-error",
      code: "private-secret-code",
    });
    expect(JSON.stringify(failure.view())).not.toContain("private-");
  });

  it.each(["user", "assistant"])("keeps hidden root %s text hidden in snapshots", (role) => {
    const fixture = native({ text: () => false });
    fixture.read({ type: "TEXT_MESSAGE_START", messageId: "private", role });
    fixture.read({ type: "TEXT_MESSAGE_CONTENT", messageId: "private", delta: "private-root" });
    fixture.read({ type: "TEXT_MESSAGE_END", messageId: "private" });
    expect(fixture.view().messages).toEqual([]);
    const result = fixture.read({
      type: "MESSAGES_SNAPSHOT",
      messages: [
        { id: "private", role, content: "private-root" },
        { id: "child-text", role, content: "private-child", subagentRunId: "child" },
      ],
    });
    expect(result.issues.some((issue) => issue.code === "hidden")).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain("private-root");
    expect(fixture.view().messages).toEqual([]);
  });

  it.each(["empty", "parent", "call"])(
    "accepts a live tool result after a snapshot with %s content",
    (contents) => {
      const fixture = native({ tool: () => ({ summary: "Safe result" }) });
      fixture.read({ type: "TEXT_MESSAGE_START", messageId: "parent" });
      fixture.read({ type: "TEXT_MESSAGE_END", messageId: "parent" });
      fixture.read({
        type: "TOOL_CALL_START",
        toolCallId: "call",
        toolCallName: "lookup",
        parentMessageId: "parent",
      });
      fixture.read({ type: "TOOL_CALL_END", toolCallId: "call" });
      fixture.read({
        type: "MESSAGES_SNAPSHOT",
        messages:
          contents === "empty"
            ? []
            : [
                {
                  id: "parent",
                  role: "assistant",
                  toolCalls:
                    contents === "call"
                      ? [
                          {
                            id: "call",
                            type: "function",
                            function: { name: "lookup", arguments: "{}" },
                          },
                        ]
                      : [],
                },
              ],
      });
      const result = {
        type: "TOOL_CALL_RESULT",
        toolCallId: "call",
        messageId: "result",
        content: "private-result",
      };
      expect(fixture.read(result).issues).toEqual([]);
      expect(fixture.view().messages[0]?.parts.filter((part) => part.type === "tool")).toEqual([
        {
          type: "tool",
          id: "call",
          name: "lookup",
          label: "lookup",
          state: "done",
          summary: "Safe result",
        },
      ]);
      expect(fixture.read(result).issues[0]?.code).toBe("framing");
    },
  );

  it("keeps an omitted tool's argument frame open until its end arrives", () => {
    const fixture = native();
    fixture.read({ type: "TOOL_CALL_START", toolCallId: "call", toolCallName: "lookup" });
    fixture.read({ type: "MESSAGES_SNAPSHOT", messages: [] });
    const result = {
      type: "TOOL_CALL_RESULT",
      toolCallId: "call",
      messageId: "result",
      content: "private-result",
    };
    expect(fixture.read(result).issues[0]?.code).toBe("framing");
    expect(fixture.read({ type: "TOOL_CALL_END", toolCallId: "call" }).issues).toEqual([]);
    expect(fixture.read(result).issues[0]?.code).toBe("hidden");
    expect(fixture.view().messages[0]?.parts[0]).toMatchObject({ id: "call", state: "done" });
  });

  it("uses safe state projection and atomic patches, refusing unsafe paths and unsupported operations", () => {
    const fixture = native({
      state: (snapshot) => [{ type: "data", id: "public-count", kind: "count", data: snapshot }],
    });
    fixture.read({ type: "STATE_SNAPSHOT", snapshot: { count: 1, names: ["one"] } });
    fixture.read({
      type: "STATE_DELTA",
      delta: [
        { op: "test", path: "/count", value: 1 },
        { op: "replace", path: "/count", value: 2 },
        { op: "add", path: "/names/-", value: "two" },
      ],
    });
    const stable = fixture.view();
    for (const delta of [
      [
        { op: "replace", path: "/count", value: 3 },
        { op: "test", path: "/count", value: 7 },
      ],
      [{ op: "add", path: "/__proto__/polluted", value: true }],
      [{ op: "add", path: "/constructor/prototype/polluted", value: true }],
      [{ op: "replace", path: "/bad~2path", value: true }],
      [{ op: "move", from: "/count", path: "/moved" }],
    ]) {
      expect(fixture.read({ type: "STATE_DELTA", delta }).issues[0]?.code).toBe("unsupported");
      expect(fixture.view()).toBe(stable);
    }
    const activity = native({
      project: () => {
        throw new Error("must not receive unsafe paths");
      },
    });
    expect(
      activity.read({
        type: "ACTIVITY_DELTA",
        messageId: "activity",
        activityType: "card",
        patch: [{ op: "add", path: "/__proto__/polluted", value: true }],
      }).issues[0]?.code,
    ).toBe("unsupported");
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("tests JSON structurally at the root, object members and array elements", () => {
    const fixture = native({
      state: (snapshot) => [{ type: "data", id: "card", kind: "card", data: snapshot }],
    });
    const snapshot = {
      count: 1,
      object: { a: 1, b: [{ c: true, d: null }] },
      array: [{ a: 1, b: 2 }],
      ordered: [1, 2],
    };
    fixture.read({ type: "STATE_SNAPSHOT", snapshot });
    expect(
      fixture.read({
        type: "STATE_DELTA",
        delta: [
          {
            op: "test",
            path: "",
            value: {
              ordered: [1, 2],
              array: [{ b: 2, a: 1 }],
              object: { b: [{ d: null, c: true }], a: 1 },
              count: 1,
            },
          },
          { op: "test", path: "/object", value: { b: [{ d: null, c: true }], a: 1 } },
          { op: "test", path: "/array/0", value: { b: 2, a: 1 } },
          { op: "replace", path: "/count", value: 2 },
        ],
      }).issues,
    ).toEqual([]);
    expect(fixture.view().messages[0]?.parts[0]).toMatchObject({ data: { ...snapshot, count: 2 } });
    const before = fixture.view();
    for (const test of [
      { op: "test", path: "/ordered", value: [2, 1] },
      { op: "test", path: "/ordered", value: [1, "2"] },
      { op: "test", path: "/array/0", value: { a: 1, b: 3 } },
      { op: "test", path: "/array/0", value: { a: 1 } },
      { op: "test", path: "/object", value: [] },
    ]) {
      expect(
        fixture.read({
          type: "STATE_DELTA",
          delta: [{ op: "replace", path: "/count", value: 3 }, test],
        }).issues[0]?.code,
      ).toBe("unsupported");
      expect(fixture.view()).toBe(before);
    }
  });

  it("hides opaque display fields by default and refuses functions or credential-bearing projections", () => {
    const writer = createAgUiWriter({ binding });
    writer.write(run);
    writer.write(message);
    const hidden = writer.write(
      part({
        type: "tool",
        id: "tool",
        label: "Lookup",
        state: "done",
        data: { secret: "private-data" },
      }),
    );
    expect(hidden.issues[0]?.code).toBe("hidden");
    expect(JSON.stringify(hidden.events)).not.toContain("private-data");
    const data = writer.write(
      part({ type: "data", id: "card", kind: "app", data: { secret: "private-app" } }),
    );
    expect(data.events).toEqual([]);
    const functions = writer.write(
      part({
        type: "client-tool",
        id: "device",
        title: "Run",
        state: "pending",
        input: { claim() {} },
      }),
    );
    expect(functions.events).toEqual([]);
    const projected = createAgUiWriter({ binding, projectPart: (value) => value });
    projected.write(run);
    projected.write(message);
    expect(
      projected
        .write(part({ type: "data", id: "safe", kind: "card", data: { label: "Public" } }))
        .events.some((event) => event.type === "ACTIVITY_SNAPSHOT"),
    ).toBe(true);
    const refused = projected.write(
      part({ type: "data", id: "unsafe", kind: "card", data: { token: "secret" } }),
    );
    expect(refused.events).toEqual([]);
    expect(refused.issues[0]?.code).toBe("invalid");
    expect(
      writer.write({ type: "model_chunk", runId: "sdk", chunk: { reasoning: "private" } }).events,
    ).toEqual([]);
  });

  it("maps native interrupts as display-only until the host supplies a safe request projection", () => {
    const fixture = native();
    fixture.read({
      ...finish,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "opaque-request",
            reason: "tool_call",
            message: "private args",
            metadata: { kind: "approval", token: "private-token" },
          },
        ],
      },
    });
    const request = fixture.view().messages.flatMap((item) => item.parts)[0];
    expect(request).toMatchObject({
      id: "opaque-request",
      type: "approval",
      state: "pending",
      canAnswer: false,
    });
    expect(JSON.stringify(fixture.view())).not.toContain("private");
    const selected = native({
      request: (request) => ({
        type: "question",
        id: request.id,
        state: "pending",
        title: "Which page?",
        choices: [{ id: "short", label: "Short" }],
        canAnswer: true,
      }),
    });
    selected.read({
      ...finish,
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "question", reason: "input", message: "private" }],
      },
    });
    expect(selected.view().messages[0]?.parts[0]).toMatchObject({
      title: "Which page?",
      canAnswer: true,
    });
    const pending = native();
    expect(
      pending.read({ ...finish, outcome: { type: "success", pendingToolCallIds: ["tool"] } })
        .issues[0]?.code,
    ).toBe("unsupported");
    expect(pending.view().run.status).toBe("waiting");
    expect(pending.view().messages).toEqual([]);
  });

  it("round-trips answers as untrusted evidence and refuses stale bindings, wrong requests and malformed approvals", () => {
    const question: RequestPart = {
      type: "question",
      id: "q",
      state: "pending",
      title: "Which?",
      choices: [{ id: "short", label: "Short" }],
      canAnswer: true,
    };
    const device: RequestPart = {
      type: "client-tool",
      id: "device",
      state: "pending",
      title: "Count",
      canAnswer: true,
    };
    const cases: [RequestPart, RequestResponse][] = [
      [approval, { type: "approve" }],
      [approval, { type: "deny", message: "Not yet" }],
      [question, { type: "answer", answer: { choices: ["short"] } }],
      [device, { type: "result", value: { count: 3 } }],
      [question, { type: "cancel" }],
      [question, { type: "stop" }],
    ];
    for (const [request, response] of cases) {
      const context = { request, binding };
      const entry = toProviderkitResumeEntry(response, context);
      expect(readResumeEntry(entry, context)).toEqual({ requestId: request.id, response });
      expect(
        readResumeEntry(entry, { ...context, binding: { ...binding, segment: "stale" } }),
      ).toBeNull();
      expect(
        readResumeEntry(entry, { ...context, request: { ...request, id: "other" } }),
      ).toBeNull();
      expect(request.state).toBe("pending");
    }
    const context = { request: approval, binding };
    expect(
      readResumeEntry(
        { interruptId: "request", status: "resolved", payload: { approved: true } },
        context,
      ),
    ).toEqual({ requestId: "request", response: { type: "approve" } });
    for (const approved of ["true", 1, null])
      expect(
        readResumeEntry(
          { interruptId: "request", status: "resolved", payload: { approved } },
          context,
        ),
      ).toBeNull();
    expect(
      toResumeEntry({ type: "approve" }, { request: { ...approval, state: "expired" }, binding }),
    ).toBeNull();
    expect(
      toResumeEntry(
        { type: "answer", answer: { choices: ["invented"] } },
        { request: question, binding },
      ),
    ).toBeNull();
    expect(
      toResumeEntry({ type: "result", value: { token: "private" } }, { request: device, binding }),
    ).toBeNull();
  });

  it("answers imported approvals with native approved, reason and editedArgs fields", () => {
    const fixture = native({
      request: (interrupt) => ({
        ...approval,
        id: interrupt.id,
        edit: { schema: { type: "object" }, value: { title: "Draft" } },
      }),
    });
    fixture.read({
      ...finish,
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "request", reason: "tool_call", metadata: { kind: "approval" } }],
      },
    });
    const request = fixture.view().messages[0]?.parts[0];
    if (request?.type !== "approval") throw new Error("Expected the imported approval.");
    const context = { request, binding };
    const cases: [RequestResponse, unknown][] = [
      [{ type: "approve" }, { approved: true }],
      [{ type: "deny" }, { approved: false }],
      [
        { type: "deny", message: "Not yet" },
        { approved: false, reason: "Not yet" },
      ],
      [
        { type: "approve", arguments: { title: "Ready" } },
        { approved: true, editedArgs: { title: "Ready" } },
      ],
    ];
    for (const [response, payload] of cases) {
      const entry = toResumeEntry(response, context);
      expect(entry).toEqual({ interruptId: "request", status: "resolved", payload });
      expect(readResumeEntry(entry, context)).toEqual({ requestId: "request", response });
      expect(
        readResumeEntry(entry, { ...context, request: { ...request, id: "other" } }),
      ).toBeNull();
    }
    const cancelled = toResumeEntry({ type: "cancel" }, context);
    expect(cancelled).toEqual({ interruptId: "request", status: "cancelled" });
    expect(readResumeEntry(cancelled, context)?.response).toEqual({ type: "cancel" });
    for (const payload of [
      { approved: true, editedArgs: "not an object" },
      { approved: false, editedArgs: { title: "Not a denial" } },
      { approved: true, reason: "Cannot represent an approval reason" },
    ])
      expect(
        readResumeEntry({ interruptId: "request", status: "resolved", payload }, context),
      ).toBeNull();
    expect(
      readResumeEntry(
        {
          interruptId: "request",
          status: "resolved",
          payload: { approved: true, editedArgs: { title: "Edit is not allowed" } },
        },
        { request: approval, binding },
      ),
    ).toBeNull();
  });

  it("requires the explicit providerkit encoder for answers native approvals cannot represent", () => {
    const cases: [RequestPart, RequestResponse][] = [
      [
        { ...approval, approveForm: {} },
        { type: "approve", data: { label: "Public" } },
      ],
      [
        { ...approval, denyForm: {} },
        { type: "deny", data: { reason: "Not yet" } },
      ],
      [
        { type: "question", id: "q", title: "Which?", state: "pending" },
        { type: "answer", answer: { text: "Short" } },
      ],
      [
        { type: "client-tool", id: "c", title: "Count", state: "pending" },
        { type: "result", value: { count: 3 } },
      ],
      [approval, { type: "stop" }],
    ];
    for (const [request, response] of cases) {
      const context = { request, binding };
      expect(toResumeEntry(response, context)).toBeNull();
      const entry = toProviderkitResumeEntry(response, context);
      expect(readResumeEntry(entry, context)).toEqual({ requestId: request.id, response });
    }
  });

  it("keeps hidden-event cursors and reports failed partial output without exposing the vendor error", () => {
    const fixture = native();
    fixture.read({ type: "TEXT_MESSAGE_START", messageId: "answer" }, 1);
    fixture.read({ type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "Prefix" }, 2);
    fixture.read({ type: "REASONING_START", messageId: "thinking" }, 3);
    expect(fixture.view().cursor?.seq).toBe(3);
    expect(fixture.read({ type: "REASONING_START", messageId: "thinking" }, 3).events).toEqual([]);
    const result = fixture.read({ type: "RUN_ERROR", message: "private vendor text" }, 4);
    expect(result.issues[0]?.code).toBe("incomplete");
    expect(fixture.view().run.status).toBe("failed");
    expect(fixture.view().messages[0]?.parts[0]).toMatchObject({
      text: "Prefix",
      settled: false,
      incomplete: true,
    });
    expect(JSON.stringify(fixture.view())).not.toContain("private");
    expect(fixture.reader.end().issues).toEqual([]);
  });

  it("rejects child content aimed at a root frame and bounds opaque JSON even after safe projection", () => {
    const fixture = native();
    fixture.read({ type: "TEXT_MESSAGE_START", messageId: "root-text" });
    fixture.read({ type: "SUBAGENT_STARTED", subagentRunId: "child", name: "Helper" });
    expect(
      fixture.read({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "root-text",
        delta: "private-child",
        subagentRunId: "child",
      }).issues[0]?.code,
    ).toBe("framing");
    expect(JSON.stringify(fixture.view())).not.toContain("private-child");
    expect(
      fixture.read({ type: "STATE_SNAPSHOT", snapshot: new Array(100_000_000) }).issues[0]?.code,
    ).toBe("limit");
    const writer = createAgUiWriter({ binding, projectPart: (value) => value });
    writer.write(run);
    writer.write(message);
    const raw = writer.write(
      part({
        type: "data",
        id: "raw",
        kind: "card",
        data: { format: 3, runId: "sdk", turns: [], context: [] },
      }),
    );
    expect(raw.events).toEqual([]);
    expect(raw.issues[0]?.code).toBe("invalid");
    const unknown = writer.write({
      v: 1,
      type: "message",
      message: {
        id: "new",
        role: "assistant",
        state: "live",
        parts: [{ type: "new-part", id: "unknown" }],
      },
    });
    expect(unknown.issues[0]?.code).toBe("unsupported");
  });

  it("bounds frame identities and input size without retaining arguments", () => {
    const fixture = native({ limits: { maxItems: 2, maxChars: 1024 } });
    fixture.read({ type: "TEXT_MESSAGE_START", messageId: "one" });
    const refused = fixture.read({ type: "TEXT_MESSAGE_START", messageId: "two" });
    expect(refused.events).toEqual([]);
    expect(refused.issues.some((item) => item.code === "limit")).toBe(true);
    expect(
      fixture.read({ type: "TEXT_MESSAGE_CONTENT", messageId: "one", delta: "x".repeat(1025) })
        .issues[0]?.code,
    ).toBe("limit");
    expect(fixture.view().messages).toHaveLength(1);
    expect(fixture.reader.end().issues[0]?.code).toBe("incomplete");
  });
});
