import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineTool,
  type ChatMessage,
  type Provider,
  type ProviderChunk,
  type ToolCall,
} from "@providerkit/core";
import {
  defineAgent,
  defineClientTool,
  questionTool,
  type Decision,
  defineDelegation,
  type Agent,
  type AgentEvent,
  type AgentHost,
  type RunSnapshot,
  type PendingRequest,
} from "@providerkit/agents";
import {
  createAgentProjector,
  type AgentProjector,
  type AgentProjectorOptions,
} from "../src/agents.ts";
import {
  emptyChatView,
  parseChatEvent,
  reduceChat,
  type ChatEvent,
  type ChatView,
  type DisplayMessage,
  type DisplayPart,
  type RunStatus,
} from "../src/protocol.ts";

const usage = { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 };

/** One model turn as a provider streams it: reasoning, the text in pieces, the calls, then usage
 * and the finish. Text in pieces is what makes a projector send deltas. */
function turn(
  shape: { reasoning?: string; text?: string[]; calls?: ToolCall[] } = {},
): ProviderChunk[] {
  const { reasoning, text = [], calls = [] } = shape;
  const chunks: ProviderChunk[] = [];
  if (reasoning) chunks.push({ type: "delta", reasoning });
  for (const content of text) chunks.push({ type: "delta", content });
  if (calls.length)
    chunks.push({ type: "delta", toolCalls: calls.map((call, index) => ({ ...call, index })) });
  chunks.push({ type: "usage", usage });
  chunks.push({ type: "finish", finishReason: calls.length ? "tool_calls" : "stop" });
  return chunks;
}

function call(name: string, args: Record<string, unknown> = {}, id = `call-${name}`): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

/** Answers each request with the next turn, or throws the error given in its place. Keeps what
 * it was sent, so a test can show a private value really was in play. */
function fake(turns: (ProviderChunk[] | Error)[], sent: ChatMessage[][] = []): Provider {
  let index = 0;
  return {
    id: "fake",
    model: "fake",
    async *createStream(history) {
      const next = turns[index++];
      sent.push(structuredClone(history));
      if (next === undefined) throw new Error("Unexpected model request");
      if (next instanceof Error) throw next;
      yield* next;
    },
  };
}

function tool(
  name: string,
  run: () => Promise<string>,
  flags: { approval?: boolean; parallel?: boolean } = {},
) {
  return defineTool({
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    needsApproval: flags.approval,
    isConcurrencySafe: flags.parallel,
    run: () => run(),
    summarize: (output: string) => output,
  });
}

/** Collects events the way a host's `onEvent` sees them, and lets a test wait for one. */
function record() {
  const events: AgentEvent[] = [];
  const waiters: { match: (event: AgentEvent) => boolean; resolve: () => void }[] = [];
  return {
    events,
    onEvent(event: AgentEvent) {
      events.push(event);
      for (const waiter of [...waiters])
        if (waiter.match(event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
    },
    until(match: (event: AgentEvent) => boolean): Promise<void> {
      if (events.some(match)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

function approvals(
  answer: "approved" | "denied" = "approved",
  scope = { actorId: "person-1", resource: { id: "thread-1", version: "1" } },
) {
  return {
    authorizeResume() {},
    prepareRequest: () => ({ scope: { ...scope, expiresAt: Date.now() + 60_000 } }),
    resolveRequest: () => ({ type: answer === "approved" ? "approve" : "deny" }),
    beforeTool() {},
  } satisfies AgentHost;
}

/** Evidence stays keyed by the request, never a browser-supplied child route. */
function evidenceFor(snapshot: RunSnapshot, evidence: unknown): Record<string, unknown> {
  for (const model of snapshot.models) {
    if (model.status !== "completed") continue;
    for (const tool of model.tools)
      for (const record of tool.asks ?? [])
        if (tool.status !== "completed" && !record.closed && !record.decision)
          return { [record.request.id]: evidence };
  }
  for (const delegation of snapshot.delegations)
    for (const child of delegation.children) {
      const found = evidenceFor(child.snapshot, evidence);
      if (Object.keys(found).length) return found;
    }
  return {};
}

/** Every event goes through JSON and the client's parser, as it would over a socket. */
function overWire(events: ChatEvent[]): ChatEvent[] {
  return events.map((event) => {
    const parsed = parseChatEvent(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
    if (!parsed) throw new Error("The client refused a projected event");
    return parsed;
  });
}

/** Projects a log the way a host numbers it: one sequence number per agent event, counted from
 * `from` when the log is sent in pieces. */
function project(
  projector: AgentProjector,
  events: readonly AgentEvent[],
  segment = "s1",
  from = 0,
): ChatEvent[] {
  return events.flatMap((event, index) =>
    overWire(projector.event(event, { seq: from + index, segment })),
  );
}

function play(events: readonly ChatEvent[], view: ChatView = emptyChatView()): ChatView {
  return events.reduce(reduceChat, view);
}

function opening(projector: AgentProjector, saved: RunSnapshot): ChatEvent[] {
  return overWire([
    { v: 1, type: "snapshot", messages: [projector.snapshot(saved)], run: projector.run(saved) },
  ]);
}

/** Runs `agent` with a host that saves in memory, and pairs each save with how many events had
 * been sent when it was written: what a host sees when it reads its log head, then its save. */
async function withSaves(agent: Agent<string>, input: string, host: AgentHost = {}) {
  const seen = record();
  const saves: { snapshot: RunSnapshot; after: number }[] = [];
  const outcome = await agent.run(input, {
    onEvent: seen.onEvent,
    host: {
      ...host,
      checkpoint(snapshot) {
        saves.push({ snapshot, after: seen.events.length });
      },
    },
  });
  return { events: seen.events, saves, outcome };
}

/** Each agent's rows in order, keyed by the row they sit under. Live rows come in the order
 * things happened, so two specialists working at once interleave, and no saved run records that
 * order. What must match is every row, and each agent's own order. */
function rows(message: DisplayMessage | undefined): Record<string, DisplayPart[]> {
  const groups: Record<string, DisplayPart[]> = {};
  for (const part of message?.parts ?? []) (groups[ownerOf(part)] ??= []).push(part);
  return groups;
}

/** The row a part sits under: the specialist it belongs to, or the root. */
function ownerOf(part: DisplayPart): string {
  switch (part.type) {
    case "text":
    case "approval":
    case "question":
    case "client-tool":
    case "tool":
      return part.agentId ?? "root";
    case "agent":
      return part.parentId ?? "root";
    default:
      return "root";
  }
}

/** The rows as a person reads them, with a specialist's rows named after its own row. */
function sketch(message: DisplayMessage | undefined): string[] {
  const parts = message?.parts ?? [];
  const names = new Map(
    parts.flatMap((part) => (part.type === "agent" ? [[part.id, part.label]] : [])),
  );
  const by = (word: string, id: string | undefined) => (id ? ` ${word} ${names.get(id)}` : "");
  return parts.map((part) => {
    switch (part.type) {
      case "text":
        return `text "${part.text}"${part.settled ? "" : " streaming"}${by("by", part.agentId)}`;
      case "tool":
        return `tool ${part.label} ${part.state}${by("by", part.agentId)}`;
      case "agent":
        return `agent ${part.label} ${part.state}${by("under", part.parentId)}`;
      case "approval":
        return `approval ${part.title} ${part.state}`;
      case "data":
        return `data ${part.kind}`;
      default:
        return part.type;
    }
  });
}

function settled(part: DisplayPart): boolean {
  switch (part.type) {
    case "text":
      return part.settled;
    case "tool":
      return part.state !== "running" && part.state !== "waiting";
    case "agent":
      return part.state !== "running" && part.state !== "waiting";
    case "approval":
    case "question":
    case "client-tool":
      return part.state !== "pending";
    default:
      return true;
  }
}

/** How far a run or a specialist has come inside one segment. Going from waiting back to
 * running is an approval continuing, and that always starts a new segment. */
function stage(status: RunStatus): number {
  if (status === "idle") return 0;
  if (status === "running") return 1;
  return status === "waiting" ? 2 : 3;
}

/** Nothing a person saw goes back: no row leaves, a settled row stays settled, a text only
 * grows, and inside one segment neither the run nor a specialist returns to an earlier stage. */
function expectForward(before: ChatView, after: ChatView): void {
  const sameSegment = before.cursor?.segment === after.cursor?.segment;
  if (sameSegment)
    expect(stage(after.run.status), `run went back to ${after.run.status}`).toBeGreaterThanOrEqual(
      stage(before.run.status),
    );
  const later = new Map(
    after.messages.flatMap((message) => message.parts.map((part) => [part.id, part])),
  );
  for (const message of before.messages)
    for (const part of message.parts) {
      const next = later.get(part.id);
      expect(next, `row ${part.id} left`).toBeDefined();
      if (!next) continue;
      if (settled(part)) expect(settled(next), `row ${part.id} reopened`).toBe(true);
      if (part.type === "text" && next.type === "text")
        expect(next.text.startsWith(part.text), `text ${part.id} went back`).toBe(true);
      if (sameSegment && part.type === "agent" && next.type === "agent")
        expect(stage(next.state), `specialist ${part.id} went back`).toBeGreaterThanOrEqual(
          stage(part.state),
        );
    }
}

/** What a host sends a client that opens when the run had written `at`: the log up to that
 * save, the save, then the rest of the log, all through the one projector that host keeps for
 * the connection. Checks every step with `expectForward` and returns the last view. */
function openAt(
  options: AgentProjectorOptions,
  events: readonly AgentEvent[],
  at: { snapshot: RunSnapshot; after: number },
): ChatView {
  const host = createAgentProjector(options);
  const sent = [
    ...project(host, events.slice(0, at.after)),
    ...opening(host, at.snapshot),
    ...project(host, events.slice(at.after), "s1", at.after),
  ];
  let view = emptyChatView();
  for (const event of sent) {
    const next = reduceChat(view, event);
    expectForward(view, next);
    view = next;
  }
  return view;
}

/** A lead that searches, then consults a researcher (with a tool of its own) and a writer. */
function team(together: boolean) {
  const researcher = defineAgent({
    id: "researcher",
    version: "1",
    instructions: "Find facts.",
    provider: fake([
      turn({ calls: [call("lookup", { topic: "tides" })] }),
      turn({ text: ["The moon ", "pulls the sea."] }),
    ]),
    tools: [tool("lookup", async () => "high tide at six")],
  });
  const writer = defineAgent({
    id: "writer",
    version: "1",
    instructions: "Write.",
    provider: fake([turn({ text: ["A short ", "draft."] })]),
  });
  const consult = defineDelegation({
    name: "consult",
    description: "Ask the specialists.",
    inputSchema: { type: "object" },
    validate: () => undefined,
    specialists: [researcher, writer],
    async run(_input, context) {
      const research = () => context.child("research", researcher, "Find why tides happen.");
      const write = () => context.child("write", writer, "Draft a note about tides.");
      if (together) return (await context.join([research(), write()])).map((r) => r.status);
      const [first] = await context.join([research()]);
      const [second] = await context.join([write()]);
      return [first.status, second.status];
    },
  });
  return defineAgent({
    id: "lead",
    version: "1",
    instructions: "Answer with help.",
    provider: fake([
      turn({
        text: ["Let me ", "check."],
        calls: [call("search", { q: "tides" }), call("consult")],
      }),
      turn({ text: ["Tides follow ", "the moon."] }),
    ]),
    tools: [tool("search", async () => "two pages"), consult],
  });
}

afterEach(() => vi.useRealTimers());

describe("request journals and attempts", () => {
  it("projects sibling questions, partial answers and closed receipts from real SDK runs", async () => {
    const makeChild = (id: string) =>
      defineAgent({
        id,
        version: "1",
        instructions: "Ask.",
        provider: fake([
          turn({
            calls: [
              call("ask_question", {
                message: `Question ${id}`,
                choices: [{ id: "one", label: "One" }],
              }),
            ],
          }),
          turn({ text: ["Private child answer"] }),
        ]),
        tools: [questionTool()],
      });
    const a = makeChild("a");
    const b = makeChild("b");
    const root = defineAgent({
      id: "root",
      version: "1",
      instructions: "Ask both.",
      provider: fake([turn({ calls: [call("consult")] }), turn({ text: ["Done"] })]),
      tools: [
        defineDelegation({
          name: "consult",
          description: "Ask both.",
          inputSchema: { type: "object" },
          validate: () => undefined,
          specialists: [a, b],
          run: async (_input, context) =>
            (
              await context.join([context.child("a", a, "Ask."), context.child("b", b, "Ask.")])
            ).map((item) => item.status),
        }),
      ],
    });
    let decision: Decision = {
      type: "answer",
      answer: { choices: ["missing"] },
      receipt: "private-receipt",
    };
    const host = { ...approvals(), resolveRequest: () => decision };
    const first = record();
    const pending = await root.run("Ask both", { host, onEvent: first.onEvent });
    if (pending.status !== "suspended") throw new Error(pending.status);
    expect(pending.requests).toHaveLength(2);
    const projector = createAgentProjector({
      messageId: "reply",
      runId: pending.runId,
      request: ({ request }) =>
        request.ask.type === "question"
          ? { title: request.ask.message, choices: request.ask.choices }
          : undefined,
    });
    const live = play(project(projector, first.events));
    const pendingDisplay = projector.snapshot(pending.snapshot);
    expect(rows(live.messages[0])).toEqual(rows(pendingDisplay));
    expect(pendingDisplay.parts.filter((part) => part.type === "question")).toHaveLength(2);
    const [one, two] = pending.requests;
    if (!one || !two) throw new Error("Missing sibling requests");
    const invalid = await root.resume(pending.snapshot, { host, answers: { [one.id]: "claim" } });
    if (invalid.status !== "suspended") throw new Error(invalid.status);
    expect(invalid.requests.find((request) => request.id === one.id)?.problem?.code).toBe(
      "invalid_answer",
    );
    decision = { type: "answer", answer: { choices: ["one"] }, receipt: "private-receipt" };
    const partial = await root.resume(invalid.snapshot, { host, answers: { [one.id]: "claim" } });
    if (partial.status !== "suspended") throw new Error(partial.status);
    expect(partial.requests.map((request) => request.id)).toEqual([two.id]);
    const restored = createAgentProjector({ messageId: "reply", runId: pending.runId }).snapshot(
      partial.snapshot,
    );
    expect(
      restored.parts.filter((part) => part.type === "question").map((part) => part.state),
    ).toEqual(["answered", "pending"]);
    const done = await root.resume(partial.snapshot, { host, answers: { [two.id]: "claim" } });
    expect(done.status).toBe("completed");
    const wire = JSON.stringify(
      createAgentProjector({ messageId: "reply", runId: pending.runId }).snapshot(done.snapshot),
    );
    expect(wire).not.toContain("private-receipt");
    expect(wire).not.toContain("Question a");
    expect(wire).not.toContain("Private child answer");
  });

  it("closes every request when a Stop decision ends a waiting tree", async () => {
    const effect = vi.fn(async () => "not called");
    const agent = defineAgent({
      id: "root",
      version: "1",
      instructions: "Ask",
      provider: fake([turn({ calls: [call("first"), call("second")] })]),
      tools: [
        tool("first", effect, { approval: true }),
        tool("second", effect, { approval: true }),
      ],
    });
    const host = { ...approvals(), resolveRequest: (): Decision => ({ type: "stop" }) };
    const seen = record();
    const waiting = await agent.run("Ask", { host, onEvent: seen.onEvent });
    if (waiting.status !== "suspended") throw new Error(waiting.status);
    expect(waiting.requests).toHaveLength(2);
    const stopped = await agent.resume(waiting.snapshot, {
      host,
      answers: evidenceFor(waiting.snapshot, "claim"),
      onEvent: seen.onEvent,
    });
    expect(stopped.status).toBe("cancelled");
    const projector = createAgentProjector({ messageId: "reply", runId: waiting.runId });
    const live = play(project(projector, seen.events));
    const saved = projector.snapshot(stopped.snapshot);
    expect(live.messages[0]).toEqual(saved);
    expect(
      saved.parts.filter((part) => part.type === "approval").map((part) => part.state),
    ).toEqual(["stopped", "stopped"]);
    expect(effect).not.toHaveBeenCalled();
  });

  it("keeps distinct coordinator questions open and reconstructs an invalid form replacement", async () => {
    const schema = {
      type: "object" as const,
      properties: { note: { type: "string" } },
      required: ["note"],
    };
    const agent = defineAgent({
      id: "coordinator",
      version: "1",
      instructions: "Ask",
      provider: fake([turn({ calls: [call("collect")] }), turn({ text: ["Done"] })]),
      tools: [
        defineDelegation({
          name: "collect",
          description: "Collect two answers",
          inputSchema: { type: "object" },
          validate: () => undefined,
          specialists: [],
          run: async (_input, context) =>
            Promise.allSettled([
              context.ask({ key: "first", message: "First form", schema }, (answer) => {
                if (
                  !answer.data ||
                  typeof answer.data !== "object" ||
                  !("note" in answer.data) ||
                  answer.data.note !== "private-form-answer"
                )
                  throw new Error("private-form-problem");
                return answer.data;
              }),
              context.ask({ key: "second", message: "Second question" }, (answer) => answer.text),
            ]),
        }),
      ],
    });
    let decision: Decision = { type: "answer", answer: { data: { note: "wrong" } } };
    const host = {
      ...approvals(),
      resolveRequest: (request: PendingRequest): Decision =>
        request.ask.type === "question" && request.ask.key === "second"
          ? { type: "answer", answer: { text: "Second answer" } }
          : decision,
    };
    const seen = record();
    const waiting = await agent.run("Ask", { host, onEvent: seen.onEvent });
    if (waiting.status !== "suspended") throw new Error(waiting.status);
    expect(waiting.requests).toHaveLength(2);
    const projector = createAgentProjector({ messageId: "reply", runId: waiting.runId });
    const live = play(project(projector, seen.events));
    expect(
      live.messages[0]?.parts.filter(
        (part) => part.type === "question" && part.state === "pending",
      ),
    ).toHaveLength(2);
    const invalid = await agent.resume(waiting.snapshot, {
      host,
      answers: Object.fromEntries(waiting.requests.map((request) => [request.id, "claim"])),
    });
    if (invalid.status !== "suspended") throw new Error(invalid.status);
    const saved = projector.snapshot(invalid.snapshot);
    expect(
      saved.parts.filter((part) => part.type === "question").map((part) => part.state),
    ).toEqual(["invalid", "answered", "pending"]);
    expect(JSON.stringify(saved)).not.toContain("private-form-problem");
    decision = {
      type: "answer",
      answer: { data: { note: "private-form-answer" } },
      receipt: "private-form-receipt",
    };
    const first = invalid.requests.find(
      (request) => request.ask.type === "question" && request.ask.key === "first",
    )!;
    const answered = await agent.resume(invalid.snapshot, {
      host,
      answers: { [first.id]: "claim" },
    });
    expect(answered.status).toBe("completed");
    const wire = JSON.stringify(projector.snapshot(answered.snapshot));
    expect(wire).not.toContain("private-form-answer");
    expect(wire).not.toContain("private-form-receipt");
  });

  it("projects only approved effective client input, never original args or decision receipts", async () => {
    const clientTool = defineClientTool({
      name: "inspect",
      description: "Read a sample.",
      needsApproval: true,
      inputSchema: { type: "object" },
      validate: (value) => value,
      result: { schema: { type: "object" }, validate: (value) => value },
    });
    const agent = defineAgent({
      id: "reader",
      version: "1",
      instructions: "Read.",
      tools: [clientTool],
      provider: fake([
        turn({ calls: [call("inspect", { text: "private-original" })] }),
        turn({ text: ["Done"] }),
      ]),
    });
    let decision: Decision = {
      type: "approve",
      arguments: { text: "approved-input" },
      data: { note: "private-decision-data" },
      receipt: "private-receipt",
    };
    const host = {
      ...approvals(),
      prepareRequest: () => ({
        scope: {
          actorId: "private-actor",
          resource: { id: "private-resource", version: "private-version" },
          expiresAt: Date.now() + 60_000,
        },
        ask: {
          type: "approval" as const,
          editable: true,
          approveSchema: { type: "object" as const },
        },
      }),
      resolveRequest: () => decision,
    };
    // The host changes approval presentation only, not the subsequent client request.
    const prepare = host.prepareRequest;
    const policy: AgentHost & { authorizeResume(): void } = {
      ...host,
      prepareRequest: (request) =>
        request.ask.type === "approval" ? prepare() : { scope: prepare().scope },
    };
    const log = record();
    const approval = await agent.run("Read", { host: policy, onEvent: log.onEvent });
    if (approval.status !== "suspended") throw new Error(approval.status);
    const waiting = await agent.resume(approval.snapshot, {
      host: policy,
      answers: evidenceFor(approval.snapshot, "claim"),
      onEvent: log.onEvent,
    });
    if (waiting.status !== "suspended") throw new Error(waiting.status);
    expect(waiting.requests[0]?.ask.type).toBe("client");
    expect(waiting.requests[0]?.call.arguments).toEqual({ text: "approved-input" });
    expect(waiting.requests[0]?.call.call.arguments).toContain("private-original");
    const exposed = createAgentProjector({
      messageId: "reply",
      runId: waiting.runId,
      clientTools: { inspect: (args) => ({ text: args.text }) },
    });
    expect(
      exposed.snapshot(waiting.snapshot).parts.find((part) => part.type === "client-tool"),
    ).toMatchObject({ name: "inspect", input: { text: "approved-input" }, canAnswer: true });
    decision = {
      type: "result",
      value: { text: "private-client-result" },
      receipt: "private-result-receipt",
    };
    const done = await agent.resume(waiting.snapshot, {
      host: policy,
      answers: evidenceFor(waiting.snapshot, "claim"),
      onEvent: log.onEvent,
    });
    expect(done.status).toBe("completed");
    const safe = createAgentProjector({ messageId: "reply", runId: done.runId });
    const wire = JSON.stringify([...project(safe, log.events), safe.snapshot(done.snapshot)]);
    for (const secret of [
      "private-original",
      "private-actor",
      "private-resource",
      "private-version",
      "private-decision-data",
      "private-receipt",
      "private-client-result",
      "private-result-receipt",
      "approved-input",
    ])
      expect(wire).not.toContain(secret);
  });

  it.each([true, false])(
    "replaces model attempts with restart event present=%s and rejects old progress",
    (restart) => {
      const projector = createAgentProjector({ messageId: "reply", runId: "run" });
      const chunk = (attemptId: string, content: string): AgentEvent => ({
        type: "model_chunk",
        runId: "run",
        operationId: "model",
        attemptId,
        chunk: { type: "delta", content },
      });
      let view = play(project(projector, [chunk("old", "Discard this")]));
      if (restart)
        view = play(
          project(
            projector,
            [
              {
                type: "operation_restart",
                kind: "model",
                runId: "run",
                operationId: "model",
                previousAttemptId: "old",
                attemptId: "new",
              },
            ],
            "second",
          ),
          view,
        );
      view = play(
        project(
          projector,
          [
            chunk("new", "New"),
            chunk("old", "Wrong"),
            {
              type: "state",
              runId: "run",
              attemptId: "old",
              state: { status: "completed", candidate: "wrong" },
            },
            chunk("new", " answer"),
          ],
          "third",
        ),
        view,
      );
      expect(view.messages[0]?.parts).toEqual([
        { type: "text", id: "model", text: "New answer", settled: false, attempt: 2 },
      ]);
      view = play(
        project(
          projector,
          [
            {
              type: "state",
              runId: "run",
              attemptId: "new",
              state: { status: "completed", candidate: "answer" },
            },
          ],
          "final",
        ),
        view,
      );
      expect(projector.event(chunk("old", "Wrong"))).toEqual([]);
      expect(projector.event(chunk("new", "Also wrong"))).toEqual([]);
      expect(view.run.status).toBe("completed");
    },
  );

  it("uses saved attempt receipts when a fresh observer missed the restart", async () => {
    const seen = record();
    const outcome = await defineAgent({
      id: "reader",
      version: "1",
      instructions: "Read",
      provider: fake([turn({ text: ["Saved"] })]),
    }).run("Read", { runId: "run", onEvent: seen.onEvent });
    const saved = structuredClone(outcome.snapshot);
    const model = saved.models[0]!;
    model.interrupted = [{ attemptId: "old", usage }];
    saved.state = { status: "running" };
    saved.models[0] = {
      id: model.id,
      attemptId: saved.attemptId,
      interrupted: model.interrupted,
      status: "running",
      usage,
      billing: "unknown",
    };
    const projector = createAgentProjector({ messageId: "reply", runId: "run" });
    let view = play(opening(projector, saved));
    expect(
      projector.event({
        type: "model_chunk",
        runId: "run",
        operationId: model.id,
        attemptId: "old",
        chunk: { type: "delta", content: "Wrong" },
      }),
    ).toEqual([]);
    view = play(
      project(projector, [
        {
          type: "model_chunk",
          runId: "run",
          operationId: model.id,
          attemptId: saved.attemptId,
          chunk: { type: "delta", content: "Fresh" },
        },
      ]),
      view,
    );
    expect(view.messages[0]?.parts[0]).toMatchObject({ text: "Fresh", attempt: 2 });
  });
});

describe("createAgentProjector", () => {
  it.each([
    ["one after the other", false],
    ["at the same time", true],
  ])(
    "draws the same message live and from the saved run when specialists work %s",
    async (_mode, together) => {
      const seen = record();
      const outcome = await team(together).run("Why do tides happen?", { onEvent: seen.onEvent });
      expect(outcome.status).toBe("completed");
      const projector = createAgentProjector({
        messageId: "answer",
        runId: outcome.runId,
        labels: { agent: { researcher: "Researcher" } },
      });
      const view = play(project(projector, seen.events));
      const saved = projector.snapshot(outcome.snapshot);
      for (const message of [saved, view.messages[0]]) {
        expect(
          message?.parts.flatMap((part) => (part.type === "agent" ? [part.agentId] : [])),
        ).toEqual(["researcher", "writer"]);
      }

      expect(sketch(saved)).toEqual([
        'text "Let me check."',
        "tool search done",
        "tool consult done",
        "agent Researcher completed",
        "tool lookup done by Researcher",
        "agent writer completed",
        'text "Tides follow the moon."',
      ]);
      // Rows carry the SDK's own operation ids, which is what lets the two sides meet.
      const models = outcome.receipts.filter((receipt) => receipt.kind === "model");
      expect(saved.parts[0]?.id).toBe(models[0]?.id);
      expect(view.messages).toHaveLength(1);
      const [live] = view.messages;
      expect(live?.parts.every(settled)).toBe(true);
      expect(rows(live)).toEqual(rows(saved));
      expect({ ...live, parts: [] }).toEqual({ ...saved, parts: [] });
      if (!together) expect(live).toEqual(saved);
      expect(view.run).toEqual(projector.run(outcome.snapshot));
      expect(view.run).toEqual({ id: outcome.runId, status: "completed", messageId: "answer" });

      // A text row closes when its turn ends, not when the run does: the first tool call closes
      // the lead's first words, while the run itself is still going.
      const firstCall = seen.events.findIndex((event) => event.type === "tool_start");
      const early = play(
        project(
          createAgentProjector({ messageId: "answer", runId: outcome.runId }),
          seen.events.slice(0, firstCall + 1),
        ),
      );
      expect(sketch(early.messages[0])).toEqual(['text "Let me check."', "tool search running"]);
      expect(early.run.status).toBe("running");
    },
  );

  it("closes a specialist's running call when that specialist ends, while the lead goes on", async () => {
    vi.useFakeTimers();
    const slow = defineAgent({
      id: "slow",
      version: "1",
      instructions: "Wait.",
      provider: fake([turn({ calls: [call("wait")] })]),
      limits: { elapsedMs: 20 },
      tools: [
        defineTool({
          name: "wait",
          description: "Wait for a signal.",
          inputSchema: { type: "object" },
          run: (_input, context) =>
            new Promise<string>((_resolve, reject) =>
              context.signal?.addEventListener("abort", () => reject(new Error("stopped")), {
                once: true,
              }),
            ),
        }),
      ],
    });
    const seen = record();
    const work = defineAgent({
      id: "lead",
      version: "1",
      instructions: "Ask, then answer anyway.",
      provider: fake([turn({ calls: [call("consult")] }), turn({ text: ["It ran out of time."] })]),
      tools: [
        defineDelegation({
          name: "consult",
          description: "Ask the slow specialist.",
          inputSchema: { type: "object" },
          validate: () => undefined,
          specialists: [slow],
          // Reports the specialist's ending instead of failing, so the lead keeps working.
          run: async (_input, context) =>
            (await context.join([context.child("slow", slow, "Wait.")]))[0].status,
        }),
      ],
    }).run("Ask the slow one.", { onEvent: seen.onEvent });
    // The specialist's time limit is its only clock, so moving it past 20 ms is what ends it.
    await seen.until((event) => event.type === "tool_start" && event.request.call.name === "wait");
    await vi.advanceTimersByTimeAsync(25);
    const outcome = await work;
    expect(outcome.status).toBe("completed");
    const options = { messageId: "answer", runId: outcome.runId };
    const projector = createAgentProjector(options);
    const ended = seen.events.findIndex(
      (event) => event.type === "state" && event.state.status === "limited",
    );
    const midway = play(project(createAgentProjector(options), seen.events.slice(0, ended + 1)));
    expect(sketch(midway.messages[0])).toEqual([
      "tool consult running",
      "agent slow limited",
      "tool wait failed by slow",
    ]);
    const view = play(project(projector, seen.events));
    expect(view.messages[0]).toEqual(projector.snapshot(outcome.snapshot));
  });

  it("files a specialist that another specialist started under that one", async () => {
    const leaf = defineAgent({
      id: "leaf",
      version: "1",
      instructions: "Look it up.",
      provider: fake([turn({ calls: [call("lookup")] }), turn({ text: ["Leaf done."] })]),
      tools: [tool("lookup", async () => "found")],
    });
    const middle = defineAgent({
      id: "middle",
      version: "1",
      instructions: "Ask the leaf.",
      provider: fake([
        turn({ calls: [call("ask_leaf", { input: "Look it up." })] }),
        turn({ text: ["Middle done."] }),
      ]),
      tools: [leaf.asTool({ name: "ask_leaf", description: "Ask the leaf." })],
    });
    const seen = record();
    const outcome = await defineAgent({
      id: "lead",
      version: "1",
      instructions: "Ask the middle.",
      provider: fake([
        turn({ calls: [call("ask_middle", { input: "Find it." })] }),
        turn({ text: ["Done."] }),
      ]),
      tools: [middle.asTool({ name: "ask_middle", description: "Ask the middle." })],
    }).run("Find it.", { onEvent: seen.onEvent });
    expect(outcome.status).toBe("completed");
    const projector = createAgentProjector({ messageId: "answer", runId: outcome.runId });
    const view = play(project(projector, seen.events));
    expect(sketch(view.messages[0])).toEqual([
      "tool ask_middle done",
      "agent middle completed",
      "tool ask_leaf done by middle",
      "agent leaf completed under middle",
      "tool lookup done by leaf",
      'text "Done."',
    ]);
    expect(view.messages[0]).toEqual(projector.snapshot(outcome.snapshot));
  });

  it("opens a client at any save, while specialists work at once, without doubling or going back", async () => {
    const { events, saves, outcome } = await withSaves(team(true), "Why do tides happen?");
    expect(outcome.status).toBe("completed");
    const options = { messageId: "answer", runId: outcome.runId };
    const projector = createAgentProjector(options);
    const final = projector.snapshot(outcome.snapshot);
    expect(saves.length).toBeGreaterThan(5);
    // Every save the run made, the empty first one to the last, is a moment a client could have
    // opened at. Each is sent after the log up to it, as a host with no cursor to resume from
    // sends it, and the rest of the log follows.
    for (const at of [...saves, { snapshot: outcome.snapshot, after: events.length }]) {
      const view = openAt(options, events, at);
      expect(rows(view.messages[0])).toEqual(rows(final));
      expect(view.messages[0]?.state).toBe("settled");
      expect(view.run).toEqual(projector.run(outcome.snapshot));
    }
  });

  it("opens a client on a run that waits for a decision without showing it running again", async () => {
    const clerk = defineAgent({
      id: "clerk",
      version: "1",
      instructions: "File reports.",
      provider: fake([turn({ text: ["Filing ", "it."], calls: [call("file")] })]),
      tools: [tool("file", async () => "filed", { approval: true })],
    });
    const lead = defineAgent({
      id: "lead",
      version: "1",
      instructions: "Delegate.",
      provider: fake([
        turn({
          text: ["Asking the ", "clerk."],
          calls: [call("ask_clerk", { input: "File the report." })],
        }),
      ]),
      tools: [clerk.asTool({ name: "ask_clerk", description: "Ask the clerk." })],
    });
    const { events, saves, outcome } = await withSaves(lead, "File the report.", approvals());
    expect(outcome.status).toBe("suspended");
    const options = { messageId: "answer", runId: outcome.runId };
    const saved = createAgentProjector(options).snapshot(outcome.snapshot);
    expect(sketch(saved)).toEqual([
      'text "Asking the clerk."',
      "tool ask_clerk running",
      "agent clerk waiting",
      "approval file pending",
    ]);
    for (const at of [...saves, { snapshot: outcome.snapshot, after: events.length }]) {
      const view = openAt(options, events, at);
      expect(view.messages[0]).toEqual(saved);
      expect(view.run).toEqual({ id: outcome.runId, status: "waiting", messageId: "answer" });
    }
  });

  it("never sends what a run keeps private, under the default options", async () => {
    const secret = {
      instructions: "secret-lead-instructions",
      childInstructions: "secret-helper-instructions",
      input: "secret-run-input",
      argument: "secret-tool-argument",
      childInput: "secret-helper-input",
      result: "secret-tool-result",
      toolError: "secret-tool-error",
      madeUpTool: "secret-made-up-tool",
      reasoning: "secret-reasoning",
      childText: "secret-helper-text",
      failure: "secret-failure-message",
      actor: "secret-approval-actor",
      resource: "secret-approval-resource",
      version: "secret-resource-version",
      output: "secret-checked-output",
    };
    const prompts: ChatMessage[][] = [];

    // One run that uses tools, a specialist and reasoning, and then fails.
    const helper = defineAgent({
      id: "helper",
      version: "1",
      instructions: secret.childInstructions,
      provider: fake(
        [
          // A tool the helper does not have, so its name is whatever the model wrote.
          turn({ calls: [call(secret.madeUpTool)] }),
          turn({ reasoning: secret.reasoning, text: [secret.childText] }),
        ],
        prompts,
      ),
    });
    const lead = defineAgent({
      id: "lead",
      version: "1",
      instructions: secret.instructions,
      provider: fake(
        [
          turn({
            reasoning: secret.reasoning,
            text: ["Working on it."],
            calls: [
              call("search", { query: secret.argument }),
              call("broken"),
              call("ask_helper", { input: secret.childInput }),
            ],
          }),
          new Error(secret.failure),
        ],
        prompts,
      ),
      tools: [
        tool("search", async () => secret.result),
        tool("broken", async () => {
          throw new Error(secret.toolError);
        }),
        helper.asTool({ name: "ask_helper", description: "Ask the helper." }),
      ],
    });
    const failing = record();
    const failed = await lead.run(secret.input, { onEvent: failing.onEvent });
    expect(failed.status).toBe("failed");

    // One run that waits on an approval and answers through an output contract.
    const clerk = defineAgent({
      id: "clerk",
      version: "1",
      instructions: secret.instructions,
      provider: fake([
        turn({ calls: [call("file", { note: secret.argument })] }),
        turn({ calls: [call("submit_result", { answer: secret.output })] }),
      ]),
      tools: [tool("file", async () => secret.result, { approval: true })],
      output: { schema: { type: "object" }, validate: (value) => value },
    });
    const host = approvals("approved", {
      actorId: secret.actor,
      resource: { id: secret.resource, version: secret.version },
    });
    const asking = record();
    const pending = await clerk.run(secret.input, { host, onEvent: asking.onEvent });
    expect(pending.status).toBe("suspended");
    const continuing = record();
    const done = await clerk.resume(pending.snapshot, {
      host,
      answers: evidenceFor(pending.snapshot, "yes"),
      onEvent: continuing.onEvent,
    });
    expect(done.status).toBe("completed");

    // The values really were in what the SDK handed over, so their absence below means something.
    const raw = JSON.stringify([
      failing.events,
      failed,
      asking.events,
      continuing.events,
      done,
      prompts,
    ]);
    for (const value of Object.values(secret)) expect(raw).toContain(value);

    const failedView = createAgentProjector({ messageId: "first", runId: failed.runId });
    const clerkView = createAgentProjector({ messageId: "second", runId: pending.runId });
    const sent = [
      ...project(failedView, failing.events),
      failedView.snapshot(failed.snapshot),
      failedView.run(failed.snapshot),
      ...project(clerkView, asking.events, "s1"),
      clerkView.snapshot(pending.snapshot),
      clerkView.run(pending.snapshot),
      ...project(clerkView, continuing.events, "s2"),
      clerkView.snapshot(done.snapshot),
      clerkView.run(done.snapshot),
    ];
    const text = JSON.stringify(sent);
    for (const value of Object.values(secret)) expect(text).not.toContain(value);

    // What is meant to cross still does.
    expect(sketch(failedView.snapshot(failed.snapshot))).toEqual([
      'text "Working on it."',
      "tool search done",
      "tool broken failed",
      "tool ask_helper done",
      "agent helper completed",
      "tool Unknown tool failed by helper",
    ]);
    expect(failedView.run(failed.snapshot).error).toEqual({
      code: "execution_failed",
      message: "The agent stopped because of an error.",
    });
    expect(sketch(clerkView.snapshot(pending.snapshot))).toEqual(["approval file pending"]);
    // The checked result is a tool call too, and it is never a row.
    expect(sketch(clerkView.snapshot(done.snapshot))).toEqual([
      "approval file approved",
      "tool file done",
    ]);
    expect(text).not.toContain("submit_result");
  });

  it("files nothing under a specialist whose child event was lost", async () => {
    const seen = record();
    const outcome = await team(false).run("Why do tides happen?", { onEvent: seen.onEvent });
    const projector = createAgentProjector({
      messageId: "answer",
      runId: outcome.runId,
      text: () => true,
    });
    const view = play(
      project(
        projector,
        seen.events.filter((event) => event.type !== "child"),
      ),
    );
    // Even with every run's text allowed, the unnamed specialists are not taken for the root.
    expect(sketch(view.messages[0])).toEqual([
      'text "Let me check."',
      "tool search done",
      "tool consult done",
      'text "Tides follow the moon."',
    ]);
    // The saved run still knows them, so the next snapshot draws them.
    expect(sketch(projector.snapshot(outcome.snapshot))).toContain("agent researcher completed");
  });

  it("draws only its own run from a log read from the middle, never a specialist in its place", async () => {
    const helper = defineAgent({
      id: "helper",
      version: "1",
      instructions: "Help.",
      provider: fake([turn({ text: ["Private helper ", "notes."] })]),
    });
    const seen = record();
    const outcome = await defineAgent({
      id: "lead",
      version: "1",
      instructions: "Ask the helper.",
      provider: fake([
        turn({ calls: [call("ask_helper", { input: "Help." })] }),
        turn({ text: ["Root answer."] }),
      ]),
      tools: [helper.asTool({ name: "ask_helper", description: "Ask the helper." })],
    }).run("Ask.", { onEvent: seen.onEvent });
    expect(outcome.status).toBe("completed");
    // A host that feeds a fresh projector only what is above a client's cursor, here right
    // after the helper was named, or a log whose first entries were lost.
    const from = seen.events.findIndex((event) => event.type === "child") + 1;
    const sent = project(
      createAgentProjector({ messageId: "answer", runId: outcome.runId }),
      seen.events.slice(from),
      "s1",
      from,
    );
    expect(JSON.stringify(sent)).not.toContain("Private helper");
    expect(sent.flatMap((event) => (event.type === "run" ? [event.run] : []))).toEqual([
      { id: outcome.runId, status: "running", messageId: "answer" },
      { id: outcome.runId, status: "completed", messageId: "answer" },
    ]);
    expect(sketch(play(sent).messages[0])).toEqual(["tool ask_helper done", 'text "Root answer."']);
  });

  it("shows what the host's tool callback returns, and leaves out a call it hides", async () => {
    const seen = record();
    const outcome = await defineAgent({
      id: "lead",
      version: "1",
      instructions: "Look things up.",
      provider: fake([
        turn({ calls: [call("search", { query: "tides" }), call("audit", { user: "u-1" })] }),
        turn({ text: ["Done."] }),
      ]),
      tools: [tool("search", async () => "2 pages"), tool("audit", async () => "logged")],
    }).run("Look it up.", { onEvent: seen.onEvent });
    const projector = createAgentProjector({
      messageId: "answer",
      runId: outcome.runId,
      labels: { tool: { search: "Search the docs" } },
      tool({ call, result }) {
        if (call.name === "audit") return null;
        // The host decides the query is fine for this viewer to see. The default would not.
        const query = String(JSON.parse(call.arguments).query);
        return result
          ? { summary: `Found ${result.content}`, data: { query } }
          : { summary: `Searching for ${query}` };
      },
    });
    const live = project(projector, seen.events);
    const view = play(live);
    const ids = (callId: string) =>
      outcome.receipts.find((receipt) => receipt.kind === "tool" && receipt.callId === callId)?.id;
    const hidden = ids("call-audit");
    expect(hidden).toBeTruthy();
    expect(JSON.stringify(live)).not.toContain(`"${hidden}"`);
    expect(JSON.stringify(live)).not.toContain("audit");
    expect(live).toContainEqual(
      expect.objectContaining({
        type: "part",
        part: expect.objectContaining({ state: "running", summary: "Searching for tides" }),
      }),
    );
    expect(view.messages[0]?.parts).toEqual([
      {
        type: "tool",
        id: ids("call-search"),
        name: "search",
        label: "Search the docs",
        state: "done",
        summary: "Found 2 pages",
        data: { query: "tides" },
      },
      {
        type: "text",
        id: outcome.receipts.filter((receipt) => receipt.kind === "model")[1]?.id,
        text: "Done.",
        settled: true,
      },
    ]);
    expect(projector.snapshot(outcome.snapshot)).toEqual(view.messages[0]);
  });

  it("draws a call that ended before it started, for an unknown tool or broken arguments", async () => {
    const seen = record();
    const outcome = await defineAgent({
      id: "lead",
      version: "1",
      instructions: "Search.",
      provider: fake([
        turn({
          calls: [call("ghost"), { id: "call-cut", name: "search", arguments: '{"query": "ti' }],
        }),
        turn({ text: ["Sorry."] }),
      ]),
      tools: [tool("search", async () => "pages")],
    }).run("Search for tides.", { onEvent: seen.onEvent });
    expect(seen.events.some((event) => event.type === "tool_start")).toBe(false);
    const projector = createAgentProjector({ messageId: "answer", runId: outcome.runId });
    const live = project(projector, seen.events);
    const view = play(live);
    expect(sketch(view.messages[0])).toEqual([
      "tool Unknown tool failed",
      "tool search failed",
      'text "Sorry."',
    ]);
    // The model made that name up, so it can hold anything, and it never leaves by default.
    expect(view.messages[0]?.parts[0]).not.toHaveProperty("name");
    expect(JSON.stringify(live)).not.toContain("ghost");
    expect(view.messages[0]).toEqual(projector.snapshot(outcome.snapshot));
    // A host that wants the name shown says so through its callback.
    const named = createAgentProjector({
      messageId: "answer",
      runId: outcome.runId,
      tool: ({ call, result }) =>
        result && !result.ok && result.kind === "unknown_tool"
          ? { label: `No tool named ${call.name}` }
          : undefined,
    });
    expect(sketch(named.snapshot(outcome.snapshot))[0]).toBe("tool No tool named ghost failed");
  });

  it("decides whether to hide a call before it has a result", async () => {
    const seen = record();
    const outcome = await defineAgent({
      id: "lead",
      version: "1",
      instructions: "Search.",
      provider: fake([turn({ calls: [call("broken")] }), turn({ text: ["It broke."] })]),
      tools: [
        tool("broken", async () => {
          throw new Error("down");
        }),
      ],
    }).run("Search.", { onEvent: seen.onEvent });
    // This callback would hide failures. A failure is only known at the end, when the row is
    // already on screen, so the row stays, and it does not spin forever either.
    const projector = createAgentProjector({
      messageId: "answer",
      runId: outcome.runId,
      tool: ({ result }) => (result && !result.ok ? null : undefined),
    });
    const view = play(project(projector, seen.events));
    expect(sketch(view.messages[0])).toEqual(["tool broken failed", 'text "It broke."']);
    expect(view.messages[0]).toEqual(projector.snapshot(outcome.snapshot));
  });

  it.each(["approved", "denied"] as const)(
    "waits on an approval, then continues in a new segment once it is %s",
    async (answer) => {
      const send = vi.fn(async () => "sent");
      const assistant = defineAgent({
        id: "assistant",
        version: "1",
        instructions: "Help the team.",
        provider: fake([
          turn({ calls: [call("send", { to: "team" })] }),
          turn({ text: [answer === "approved" ? "Sent." : "Not sent."] }),
        ]),
        tools: [tool("send", send, { approval: true })],
      });
      const host = approvals(answer);
      const first = record();
      const pending = await assistant.run("Tell the team.", { host, onEvent: first.onEvent });
      if (pending.status !== "suspended") throw new Error(pending.status);
      const options = {
        messageId: "answer",
        runId: pending.runId,
        labels: { tool: { send: "Send the update" } },
      };
      const waiting = play(project(createAgentProjector(options), first.events, "s1"));
      const request = pending.requests[0]!;
      const { operationId } = request.call;
      expect(waiting.run).toEqual({ id: pending.runId, status: "waiting", messageId: "answer" });
      expect(waiting.messages).toEqual([
        {
          id: "answer",
          role: "assistant",
          state: "live",
          parts: [
            {
              type: "approval",
              id: request.id,
              toolId: operationId,
              title: "Send the update",
              state: "pending",
              expiresAt: pending.requests[0]!.scope.expiresAt,
            },
          ],
        },
      ]);
      const projector = createAgentProjector(options);
      expect(projector.snapshot(pending.snapshot)).toEqual(waiting.messages[0]);
      expect(projector.run(pending.snapshot)).toEqual(waiting.run);

      // A decision is its own request on the host, so it gets a fresh projector and a new
      // segment, and the request's row still resolves: the call keeps the request's id.
      const second = record();
      const done = await assistant.resume(pending.snapshot, {
        host,
        answers: evidenceFor(pending.snapshot, "ok"),
        onEvent: second.onEvent,
      });
      expect(done.status).toBe("completed");
      // A continuation needs the retained log or an authoritative snapshot to identify decisions.
      const view = play(project(projector, second.events, "s2"), waiting);
      expect(sketch(view.messages[0])).toEqual(
        answer === "approved"
          ? ["approval Send the update approved", "tool Send the update done", 'text "Sent."']
          : ["approval Send the update denied", "tool Send the update failed", 'text "Not sent."'],
      );
      expect(view.messages[0]?.parts[0]?.id).toBe(request.id);
      expect(view.messages[0]).toEqual(projector.snapshot(done.snapshot));
      expect(view.run).toEqual(projector.run(done.snapshot));
      expect(send).toHaveBeenCalledTimes(answer === "approved" ? 1 : 0);
    },
  );

  it("closes a request that has an id of its own once its call runs", async () => {
    const assistant = defineAgent({
      id: "assistant",
      version: "1",
      instructions: "Help the team.",
      provider: fake([turn({ calls: [call("send", { to: "team" })] }), turn({ text: ["Sent."] })]),
      tools: [tool("send", async () => "sent", { approval: true })],
    });
    const host = approvals();
    const first = record();
    const pending = await assistant.run("Tell the team.", { host, onEvent: first.onEvent });
    if (pending.status !== "suspended") throw new Error(pending.status);
    const projector = createAgentProjector({
      messageId: "answer",
      runId: pending.runId,
      request: () => ({ title: "Send the update?" }),
    });
    const waiting = play(project(projector, first.events, "s1"));
    expect(waiting.messages[0]?.parts).toEqual([
      {
        type: "approval",
        id: pending.requests[0]!.id,
        toolId: pending.requests[0]!.call.operationId,
        title: "Send the update?",
        state: "pending",
        expiresAt: pending.requests[0]!.scope.expiresAt,
      },
    ]);
    const second = record();
    await assistant.resume(pending.snapshot, {
      host,
      answers: evidenceFor(pending.snapshot, "ok"),
      onEvent: second.onEvent,
    });
    // One projector for the whole run, so it knows the request and closes it.
    const view = play(project(projector, second.events, "s2"), waiting);
    expect(sketch(view.messages[0])).toEqual([
      "approval Send the update? approved",
      "tool send done",
      'text "Sent."',
    ]);
  });

  it("reconstructs an expired request and its replacement without running the call", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => "sent");
    const assistant = defineAgent({
      id: "assistant",
      version: "1",
      instructions: "Help the team.",
      provider: fake([turn({ calls: [call("send")] }), turn({ text: ["Sent."] })]),
      tools: [tool("send", send, { approval: true })],
    });
    const host = {
      ...approvals(),
      prepareRequest: () => ({
        scope: {
          actorId: "person-1",
          resource: { id: "thread-1", version: "1" },
          expiresAt: Date.now() + 20,
        },
      }),
    };
    const first = record();
    const pending = await assistant.run("Tell the team.", { host, onEvent: first.onEvent });
    if (pending.status !== "suspended") throw new Error(pending.status);
    const options = { messageId: "answer", runId: pending.runId };
    const projector = createAgentProjector(options);
    const waiting = play(project(projector, first.events, "s1"));
    await vi.advanceTimersByTimeAsync(30);
    const second = record();
    const failed = await assistant.resume(pending.snapshot, {
      host,
      answers: evidenceFor(pending.snapshot, "ok"),
      onEvent: second.onEvent,
    });
    expect(failed.status).toBe("suspended");
    expect(send).not.toHaveBeenCalled();
    const view = play(project(projector, second.events, "s2"), waiting);
    expect(sketch(view.messages[0])).toEqual(["approval send stale", "approval send pending"]);
    expect(view.run.status).toBe("waiting");
    // Only the saved journal knows why the old request closed. It retains both records.
    const saved = play(opening(projector, failed.snapshot), view);
    expect(sketch(saved.messages[0])).toEqual(["approval send expired", "approval send pending"]);
    expect(saved.messages[0]?.parts[0]?.id).toBe(pending.requests[0]!.id);
    const late = play(project(projector, first.events, "s1"), saved);
    expect(late.messages[0]).toEqual(saved.messages[0]);
  });

  it.each([
    ["the lead runs out of time for the whole tree", "lead"],
    ["the specialist above it runs out of its own time while the lead goes on", "middle"],
  ] as const)("stops a specialist left waiting when %s, live and saved", async (_case, cut) => {
    vi.useFakeTimers();
    const filed = vi.fn(async () => "filed");
    const clerk = defineAgent({
      id: "clerk",
      version: "1",
      instructions: "File reports.",
      provider: fake([turn({ calls: [call("file")] }), turn({ text: ["Filed."] })]),
      tools: [tool("file", filed, { approval: true })],
    });
    const askClerk = clerk.asTool({ name: "ask_clerk", description: "Ask the clerk." });
    const middle = defineAgent({
      id: "middle",
      version: "1",
      instructions: "Ask the clerk.",
      provider: fake([turn({ calls: [call("ask_clerk", { input: "File it." })] })]),
      tools: [askClerk],
      limits: { elapsedMs: 20 },
    });
    const consult = defineDelegation({
      name: "consult",
      description: "Ask the middle.",
      inputSchema: { type: "object" },
      validate: () => undefined,
      specialists: [middle],
      // Reports how the middle ended instead of failing, so the lead goes on.
      run: async (_input, context) =>
        (await context.join([context.child("middle", middle, "File it.")]))[0].status,
    });
    const lead = defineAgent({
      id: "lead",
      version: "1",
      instructions: "Delegate.",
      provider: fake([
        turn({
          calls: [cut === "lead" ? call("ask_clerk", { input: "File it." }) : call("consult")],
        }),
        turn({ text: ["Done."] }),
      ]),
      tools: [cut === "lead" ? askClerk : consult],
      ...(cut === "lead" ? { treeLimits: { elapsedMs: 20 } } : {}),
    });
    const host = approvals();
    const first = record();
    const pending = await lead.run("File the report.", { host, onEvent: first.onEvent });
    if (pending.status !== "suspended") throw new Error(pending.status);
    // The decision comes after the time ran out, so the run never gets back to the clerk.
    await vi.advanceTimersByTimeAsync(25);
    const second = record();
    const done = await lead.resume(pending.snapshot, {
      host,
      answers: evidenceFor(pending.snapshot, "ok"),
      onEvent: second.onEvent,
    });
    expect(done.status).toBe(cut === "lead" ? "limited" : "completed");
    expect(filed).not.toHaveBeenCalled();

    const projector = createAgentProjector({
      messageId: "answer",
      runId: pending.runId,
      labels: { agent: { clerk: "Clerk" } },
    });
    const saved = createAgentProjector({
      messageId: "answer",
      runId: pending.runId,
      labels: { agent: { clerk: "Clerk" } },
    }).snapshot(done.snapshot);
    expect(sketch(saved)).toEqual(
      cut === "lead"
        ? ["tool ask_clerk failed", "agent Clerk stopped", "approval file stopped"]
        : [
            "tool consult done",
            "agent middle limited",
            "tool ask_clerk failed by middle",
            "agent Clerk stopped under middle",
            "approval file approved",
            'text "Done."',
          ],
    );
    // One projector for the whole run, as a host keeps it, also closes the request, which the
    // saved run no longer has. Everything else matches.
    const live = play([
      ...project(projector, first.events, "s1"),
      ...project(projector, second.events, "s2"),
    ]);
    expect(live.messages[0]?.parts.every(settled)).toBe(true);
    expect(sketch(live.messages[0])).toContain(
      cut === "lead" ? "approval file stopped" : "approval file approved",
    );
    expect(live.messages[0]?.parts).toEqual(saved.parts);
    expect(play(opening(projector, done.snapshot), live).messages[0]).toEqual(saved);
  });

  it("keeps two calls of one tool apart while they run at the same time", async () => {
    const gates = { a: Promise.withResolvers<void>(), b: Promise.withResolvers<void>() };
    const fetchPage = defineTool({
      name: "fetch",
      description: "Fetch a page.",
      inputSchema: { type: "object" },
      isConcurrencySafe: true,
      validate(raw) {
        const page = typeof raw === "object" && raw !== null && "page" in raw ? raw.page : null;
        if (page !== "a" && page !== "b") throw new Error("Ask for page a or b.");
        return page;
      },
      async run(page) {
        await gates[page].promise;
        return `page ${page}`;
      },
      summarize: (output: string) => output,
    });
    const seen = record();
    const work = defineAgent({
      id: "lead",
      version: "1",
      instructions: "Read pages.",
      provider: fake([
        turn({
          calls: [call("fetch", { page: "a" }, "call-a"), call("fetch", { page: "b" }, "call-b")],
        }),
        turn({ text: ["Both pages read."] }),
      ]),
      tools: [fetchPage],
    }).run("Read both pages.", { host: { canRunConcurrently: () => true }, onEvent: seen.onEvent });
    const is = (type: string, callId: string) => (event: AgentEvent) =>
      (event.type === "tool_start" || event.type === "tool_result") &&
      event.type === type &&
      event.request.call.id === callId;
    await seen.until(is("tool_start", "call-a"));
    await seen.until(is("tool_start", "call-b"));
    gates.b.resolve();
    await seen.until(is("tool_result", "call-b"));
    gates.a.resolve();
    const outcome = await work;
    expect(outcome.status).toBe("completed");
    expect(
      seen.events.flatMap((event) =>
        event.type === "tool_start" || event.type === "tool_result"
          ? [`${event.type} ${event.request.call.id}`]
          : [],
      ),
    ).toEqual([
      "tool_start call-a",
      "tool_start call-b",
      "tool_result call-b",
      "tool_result call-a",
    ]);

    const projector = createAgentProjector({
      messageId: "answer",
      runId: outcome.runId,
      tool: ({ result }) => (result?.ok ? { summary: result.content } : undefined),
    });
    const events = project(projector, seen.events);
    const id = (callId: string) =>
      outcome.receipts.find((receipt) => receipt.kind === "tool" && receipt.callId === callId)?.id;
    // Right after the second call finished, the first one is still running.
    const firstResult = seen.events.findIndex(is("tool_result", "call-b"));
    const midway = play(
      project(
        createAgentProjector({ messageId: "answer", runId: outcome.runId }),
        seen.events.slice(0, firstResult + 1),
      ),
    );
    expect(
      midway.messages[0]?.parts.map((part) => [part.id, part.type === "tool" && part.state]),
    ).toEqual([
      [id("call-a"), "running"],
      [id("call-b"), "done"],
    ]);
    const view = play(events);
    expect(view.messages[0]?.parts.slice(0, 2)).toEqual([
      {
        type: "tool",
        id: id("call-a"),
        name: "fetch",
        label: "fetch",
        state: "done",
        summary: "page a",
      },
      {
        type: "tool",
        id: id("call-b"),
        name: "fetch",
        label: "fetch",
        state: "done",
        summary: "page b",
      },
    ]);
    expect(view.messages[0]).toEqual(projector.snapshot(outcome.snapshot));
  });

  it("keeps one row for a specialist that is named again when it resumes", async () => {
    const filed = vi.fn(async () => "filed");
    const clerk = defineAgent({
      id: "clerk",
      version: "1",
      instructions: "File reports.",
      provider: fake([turn({ calls: [call("file")] }), turn({ text: ["Filed."] })]),
      tools: [tool("file", filed, { approval: true })],
    });
    const lead = defineAgent({
      id: "lead",
      version: "1",
      instructions: "Delegate.",
      provider: fake([
        turn({ calls: [call("ask_clerk", { input: "File the report." })] }),
        turn({ text: ["The clerk filed it."] }),
      ]),
      tools: [clerk.asTool({ name: "ask_clerk", description: "Ask the clerk." })],
    });
    const host = approvals();
    const first = record();
    const pending = await lead.run("File the report.", { host, onEvent: first.onEvent });
    if (pending.status !== "suspended") throw new Error(pending.status);
    const second = record();
    const done = await lead.resume(pending.snapshot, {
      host,
      answers: evidenceFor(pending.snapshot, "ok"),
      onEvent: second.onEvent,
    });
    expect(done.status).toBe("completed");
    expect(filed).toHaveBeenCalledTimes(1);
    const children = [...first.events, ...second.events].filter((event) => event.type === "child");
    expect(children).toHaveLength(2);
    expect(children[1]).toEqual(children[0]);

    const projector = createAgentProjector({
      messageId: "answer",
      runId: pending.runId,
      labels: { agent: { clerk: "Clerk" } },
    });
    let view = emptyChatView();
    const states: string[] = [];
    for (const event of [
      ...project(projector, first.events, "s1"),
      ...project(projector, second.events, "s2"),
    ]) {
      view = reduceChat(view, event);
      const specialists = view.messages[0]?.parts.filter((part) => part.type === "agent") ?? [];
      expect(specialists.length).toBeLessThanOrEqual(1);
      const state = specialists[0]?.state;
      if (state && states.at(-1) !== state) states.push(state);
    }
    expect(states).toEqual(["running", "waiting", "running", "completed"]);
    expect(sketch(view.messages[0])).toEqual([
      "tool ask_clerk done",
      "agent Clerk completed",
      "approval file approved",
      "tool file done by Clerk",
      'text "The clerk filed it."',
    ]);
    expect(view.messages[0]).toEqual(projector.snapshot(done.snapshot));

    // The same event twice in a row is still one row.
    const named = children[0];
    if (!named) throw new Error("Missing child event");
    const again = createAgentProjector({ messageId: "answer", runId: pending.runId });
    const twice = play([...overWire(again.event(named)), ...overWire(again.event(named))]);
    expect(sketch(twice.messages[0])).toEqual(["agent clerk running"]);
  });

  it("shows a specialist's text only when the host opts it in, filed under that specialist", async () => {
    const seen = record();
    const outcome = await team(false).run("Why do tides happen?", { onEvent: seen.onEvent });
    const projector = createAgentProjector({
      messageId: "answer",
      runId: outcome.runId,
      text: (source) => source.root || source.agentId === "writer",
    });
    const view = play(project(projector, seen.events));
    expect(sketch(view.messages[0])).toContain('text "A short draft." by writer');
    expect(JSON.stringify(view)).not.toContain("pulls the sea");
    expect(view.messages[0]).toEqual(projector.snapshot(outcome.snapshot));
  });

  it("draws a checked result through the host's output callback, after the run's rows", async () => {
    const seen = record();
    const outcome = await defineAgent({
      id: "grader",
      version: "1",
      instructions: "Grade.",
      provider: fake([
        turn({ text: ["Grading."], calls: [call("submit_result", { grade: "B" })] }),
      ]),
      output: {
        schema: { type: "object" },
        validate(value) {
          if (typeof value !== "object" || value === null || !("grade" in value))
            throw new Error("Give a grade.");
          return { grade: String(value.grade) };
        },
      },
    }).run("Grade this essay.", { onEvent: seen.onEvent });
    expect(outcome.status).toBe("completed");
    // An app card in reading order: the client draws it from a renderer keyed by `kind`.
    const projector = createAgentProjector({
      messageId: "answer",
      runId: outcome.runId,
      output: (candidate) => [{ type: "data", id: "grade", kind: "grade", data: candidate }],
    });
    const view = play(project(projector, seen.events));
    expect(sketch(view.messages[0])).toEqual(['text "Grading."', "data grade"]);
    expect(view.messages[0]?.parts[1]).toEqual({
      type: "data",
      id: "grade",
      kind: "grade",
      data: { grade: "B" },
    });
    expect(view.messages[0]).toEqual(projector.snapshot(outcome.snapshot));
  });

  it.each(["failed", "limited", "stopped"] as const)(
    "ends a %s run the same way live and saved, with nothing left running",
    async (ending) => {
      const controller = new AbortController();
      const lead = defineAgent({
        id: "lead",
        version: "1",
        instructions: "Search.",
        provider: fake([
          turn({ text: ["Checking."], calls: [call("search")] }),
          ending === "failed" ? new Error("provider down") : turn({ text: ["Done."] }),
        ]),
        tools: [tool("search", async () => "pages")],
        // Local turn exhaustion allows a final answer; the tree budget is a hard stop.
        ...(ending === "limited" ? { treeLimits: { modelCalls: 1 } } : {}),
      });
      const seen = record();
      const outcome = await lead.run("Search for tides.", {
        signal: controller.signal,
        onEvent(event) {
          seen.onEvent(event);
          if (ending === "stopped" && event.type === "tool_start") controller.abort();
        },
      });
      expect(outcome.status).toBe(ending === "stopped" ? "cancelled" : ending);
      const projector = createAgentProjector({ messageId: "answer", runId: outcome.runId });
      const view = play(project(projector, seen.events));
      expect(view.messages[0]).toEqual(projector.snapshot(outcome.snapshot));
      expect(view.run).toEqual(projector.run(outcome.snapshot));
      expect(view.messages[0]?.parts.every(settled)).toBe(true);
      expect(sketch(view.messages[0])).toEqual([
        'text "Checking."',
        ending === "stopped" ? "tool search failed" : "tool search done",
      ]);
      expect(view.messages[0]?.state).toBe(ending === "failed" ? "failed" : "stopped");
      const errors = {
        failed: { code: "execution_failed", message: "The agent stopped because of an error." },
        limited: { code: "modelCalls", message: "The agent stopped because it reached a limit." },
        stopped: undefined,
      };
      expect(view.run.error).toEqual(errors[ending]);
      const custom = createAgentProjector({
        messageId: "answer",
        runId: outcome.runId,
        error: (state) => ({
          code: state.status,
          message: "Try again in a minute.",
          retryable: true,
        }),
      });
      if (ending !== "stopped")
        expect(custom.run(outcome.snapshot).error).toEqual({
          code: ending,
          message: "Try again in a minute.",
          retryable: true,
        });
    },
  );

  it("numbers only the last event of each batch and refuses what a client would drop", async () => {
    const seen = record();
    const outcome = await defineAgent({
      id: "lead",
      version: "1",
      instructions: "Greet.",
      provider: fake([turn({ text: ["Hi ", "there."] })]),
    }).run("Say hi.", { onEvent: seen.onEvent });
    const projector = createAgentProjector({ messageId: "answer", runId: outcome.runId });
    const [firstChunk, secondChunk] = seen.events.filter(
      (event): event is Extract<AgentEvent, { type: "model_chunk" }> =>
        event.type === "model_chunk" && Boolean(event.chunk.content),
    );
    if (!firstChunk || !secondChunk) throw new Error("Missing text chunks");
    expect(
      projector
        .event(firstChunk, { seq: 4, segment: "s1" })
        .map((event) => [event.type, event.seq, event.segment]),
    ).toEqual([
      ["message", undefined, undefined],
      ["run", undefined, undefined],
      ["part", 4, "s1"],
    ]);
    // A later chunk is one delta, numbered, and nothing else.
    expect(projector.event(secondChunk, { seq: 5 })).toEqual([
      {
        v: 1,
        type: "text",
        messageId: "answer",
        partId: firstChunk.operationId,
        delta: "there.",
        seq: 5,
      },
    ]);
    // A newer SDK's event type, read back from a JSON run log, is skipped and breaks nothing.
    const future: AgentEvent = JSON.parse('{"type":"handoff","runId":"elsewhere"}');
    expect(projector.event(future, { seq: 6 })).toEqual([]);
    for (const seq of [-1, 1.5, Number.NaN])
      expect(() => projector.event(secondChunk, { seq })).toThrow(TypeError);
    expect(() => projector.event(secondChunk, { seq: 6, segment: "" })).toThrow(TypeError);
    expect(() => createAgentProjector({ messageId: "", runId: outcome.runId })).toThrow(TypeError);
    expect(() => createAgentProjector({ messageId: "answer", runId: "" })).toThrow(TypeError);
  });
});
