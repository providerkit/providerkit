import { describe, expect, it } from "vitest";
import { defineTool, type Provider, type ProviderChunk, type ToolCall } from "@providerkit/core";
import {
  defineAgent,
  type AgentEvent,
  type AgentHost,
  type RunSnapshot,
  type TreeNode,
} from "@providerkit/agents";
import {
  createAgentProjector,
  followRun,
  type FollowRunOptions,
  type RunRecord,
} from "../src/agents.ts";
import {
  emptyChatView,
  reduceChat,
  type ChatEvent,
  type ChatView,
  type DisplayMessage,
} from "../src/protocol.ts";

const usage = { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 };
const question: DisplayMessage = {
  id: "question",
  role: "user",
  state: "settled",
  parts: [{ type: "text", id: "question/text", text: "What is next?", settled: true }],
};
const conversation = (reply: DisplayMessage) => [question, reply];
const projector = { messageId: "reply", runId: "root" };

function provider(turns: ProviderChunk[][]): Provider {
  let index = 0;
  return {
    id: "offline",
    model: "follow-test",
    async *createStream() {
      const next = turns[index++];
      if (!next) throw new Error("Unexpected model request");
      yield* next;
    },
  };
}

function answer(text: string[], reasoning?: string, calls: ToolCall[] = []): ProviderChunk[] {
  return [
    ...(reasoning ? [{ type: "delta" as const, reasoning }] : []),
    ...text.map((content) => ({ type: "delta" as const, content })),
    ...(calls.length
      ? [{ type: "delta" as const, toolCalls: calls.map((call, index) => ({ ...call, index })) }]
      : []),
    { type: "usage", usage },
    { type: "finish", finishReason: calls.length ? "tool_calls" : "stop" },
  ];
}

/** A row's log as the host stored it: one record per event, a second apart, and the closing
 * record the host writes when the row ends. */
function row(events: readonly (AgentEvent | { gap: true })[]): RunRecord[] {
  const records: RunRecord[] = events.map((event, index) => ({
    seq: index + 1,
    ...("gap" in event
      ? { type: "agent.gap", data: { dropped: 1, unconfirmed: 0 } }
      : { type: "agent", data: event }),
    at: new Date(1_000 * (index + 1)),
  }));
  records.push({ seq: records.length + 1, type: "end", data: { status: "succeeded" } });
  return records;
}

async function* stream(records: readonly RunRecord[]): AsyncGenerator<RunRecord> {
  yield* records;
}

async function follow(
  rows: readonly (readonly RunRecord[])[],
  options: Partial<FollowRunOptions> & Pick<FollowRunOptions, "read">,
): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of followRun({
    projector,
    conversation,
    segments: rows.map((records, index) => ({ id: `row-${index + 1}`, records: stream(records) })),
    ...options,
  }))
    out.push(event);
  return out;
}

function view(events: readonly ChatEvent[], from: ChatView = emptyChatView()): ChatView {
  return events.reduce(reduceChat, from);
}

/** Everything up to and including the event numbered `seq` in `segment`. */
function upTo(events: readonly ChatEvent[], segment: string, seq: number): ChatEvent[] {
  const end = events.findIndex((event) => event.segment === segment && event.seq === seq);
  if (end < 0) throw new Error(`No event numbered ${seq} in ${segment}.`);
  return events.slice(0, end + 1);
}

async function thinkAndAnswer() {
  const events: AgentEvent[] = [];
  const saves: RunSnapshot[] = [];
  const agent = defineAgent({
    id: "writer",
    version: "1",
    instructions: "Offline fixture.",
    provider: provider([answer(["Here is ", "the plan."], "private-reasoning")]),
  });
  const outcome = await agent.run("What is next?", {
    runId: "root",
    onEvent: (event) => {
      events.push(event);
    },
    host: {
      checkpoint: (snapshot) => {
        if (snapshot.kind === "agent") saves.push(structuredClone(snapshot));
      },
    },
  });
  return { events, saves, outcome };
}

describe("followRun", () => {
  it("gives a new viewer the conversation, the run as it streamed, then the saved run", async () => {
    const { events, outcome } = await thinkAndAnswer();
    const records = row(events);
    const sent = await follow([records], { read: async () => outcome.snapshot });
    expect(sent[0]).toEqual({
      v: 1,
      type: "snapshot",
      segment: "row-1",
      seq: 0,
      messages: [question, { id: "reply", role: "assistant", parts: [], state: "live" }],
      run: { id: "root", status: "running", messageId: "reply" },
    });
    expect(sent.at(-1)).toMatchObject({
      type: "snapshot",
      segment: "row-1",
      seq: records.at(-1)?.seq,
      run: { status: "completed" },
    });
    // The same reply a projector draws from the same events, times and save.
    const live = createAgentProjector(projector);
    events.forEach((event, index) =>
      live.event(event, { segment: "row-1", seq: index + 1, at: 1_000 * (index + 1) }),
    );
    const final = view(sent);
    expect(final.messages).toEqual([question, live.snapshot(outcome.snapshot)]);
    // The log's own times reach the thinking row, and its words do not.
    const recordedAt = (kind: "reasoning" | "content") =>
      1_000 *
      (events.findIndex((event) => event.type === "model_chunk" && Boolean(event.chunk[kind])) + 1);
    expect(final.messages[1]?.parts[0]).toMatchObject({
      type: "thinking",
      settled: true,
      durationMs: recordedAt("content") - recordedAt("reasoning"),
    });
    expect(JSON.stringify(sent)).not.toContain("private-reasoning");
  });

  it("resumes after the viewer's cursor, without the opening or anything it already has", async () => {
    const { events, outcome } = await thinkAndAnswer();
    const records = row(events);
    const read = async () => outcome.snapshot;
    const everything = await follow([records], { read });
    // A viewer can only hold a position the stream numbered.
    const numbered = everything.flatMap((event) => (event.seq ? [event.seq] : []));
    const cut = numbered[Math.floor(numbered.length / 2)]!;
    const before = upTo(everything, "row-1", cut);
    const rest = await follow([records], { read, cursor: { segment: "row-1", seq: cut } });
    expect(rest.some((event) => event.seq !== undefined && event.seq <= cut)).toBe(false);
    expect(view(rest, view(before))).toEqual(view(everything));
  });

  it("rebuilds from the saved run after a gap in the log", async () => {
    const { events, saves, outcome } = await thinkAndAnswer();
    const firstText = events.findIndex(
      (event) => event.type === "model_chunk" && Boolean(event.chunk.content),
    );
    const running = saves.find((save) => save.models.some((model) => model.status === "running"));
    if (!running || firstText < 0) throw new Error("The run must stream text and save mid-call.");
    // The log kept the first piece of text, then lost the next one.
    const records = row([
      ...events.slice(0, firstText + 1),
      { gap: true },
      ...events.slice(firstText + 2),
    ]);
    const reads: TreeNode[] = [running, outcome.snapshot];
    const sent = await follow([records], {
      read: async () => {
        const next = reads.shift();
        if (!next) throw new Error("Read more often than expected.");
        return next;
      },
    });
    const gap = records.find((record) => record.type === "agent.gap")!;
    const marker = sent.findIndex(
      (event) => event.type === "part" && event.part.type === "text" && event.part.incomplete,
    );
    expect(marker).toBeGreaterThan(0);
    expect(sent[marker + 1]).toMatchObject({ type: "snapshot", segment: "row-1", seq: gap.seq });
    expect(reads).toEqual([]);
    const text = view(sent).messages[1]?.parts.find((part) => part.type === "text");
    expect(text).toMatchObject({ text: "Here is the plan.", settled: true });
  });

  it("still answers a viewer already past the end, unnumbered", async () => {
    const { events, outcome } = await thinkAndAnswer();
    const records = row(events);
    const sent = await follow([records], {
      read: async () => outcome.snapshot,
      cursor: { segment: "row-1", seq: records.at(-1)!.seq },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "snapshot", run: { status: "completed" } });
    expect(sent[0]?.seq).toBeUndefined();
  });

  it("follows the row an approval continued the run in", async () => {
    const file = defineTool({
      name: "file",
      description: "File the note.",
      inputSchema: { type: "object" },
      needsApproval: true,
      run: async () => "Filed",
    });
    const agent = defineAgent({
      id: "clerk",
      version: "1",
      instructions: "Offline fixture.",
      provider: provider([
        answer(["Filing it."], undefined, [{ id: "call-1", name: "file", arguments: "{}" }]),
        answer(["Done."]),
      ]),
      tools: [file],
    });
    const host = {
      authorizeResume() {},
      prepareRequest: () => ({
        scope: {
          actorId: "person-1",
          resource: { id: "thread-1", version: "1" },
          expiresAt: Date.now() + 60_000,
        },
      }),
      resolveRequest: () => ({ type: "approve" as const }),
      beforeTool() {},
    } satisfies AgentHost;
    const firstEvents: AgentEvent[] = [];
    const waiting = await agent.run("File the note.", {
      runId: "root",
      host,
      onEvent: (event) => {
        firstEvents.push(event);
      },
    });
    if (waiting.status !== "suspended") throw new Error("The run must wait for the approval.");
    const nextEvents: AgentEvent[] = [];
    const done = await agent.resume(waiting.snapshot, {
      host,
      answers: { [waiting.requests[0]!.id]: "yes" },
      onEvent: (event) => {
        nextEvents.push(event);
      },
    });
    expect(done.status).toBe("completed");
    const rows = [row(firstEvents), row(nextEvents)];
    const read = async () => done.snapshot;
    const everything = await follow(rows, { read });
    const cut = rows[0]!.at(-2)!.seq;
    const rest = await follow(rows, { read, cursor: { segment: "row-1", seq: cut } });
    expect(rest.some((event) => event.segment === "row-1" && (event.seq ?? 0) <= cut)).toBe(false);
    expect(rest.at(-1)).toMatchObject({ type: "snapshot", segment: "row-2" });
    expect(view(rest, view(upTo(everything, "row-1", cut)))).toEqual(view(everything));
    expect(view(everything).run).toMatchObject({ status: "completed" });
  });

  it("refuses rows without ids", async () => {
    const run = followRun({
      projector,
      conversation,
      segments: [],
      read: async () => {
        throw new Error("Never read.");
      },
    });
    await expect(run.next()).rejects.toThrow(TypeError);
  });
});
