import { describe, expect, it } from "vitest";
import type { Provider, ProviderChunk } from "@providerkit/core";
import { defineAgent, type AgentEvent } from "@providerkit/agents";
import { createAgUiWriter } from "../src/ag-ui.ts";
import { createAgentProjector, type AgentProjectorOptions } from "../src/agents.ts";
import {
  emptyChatView,
  parseChatEvent,
  reduceChat,
  type ChatEvent,
  type ChatView,
  type DisplayMessage,
  type DisplayPart,
  type ThinkingPart,
} from "../src/protocol.ts";

const usage = { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 };
const WORDS = ["private-", "chain-of-thought"];

/** Streams each turn in order, or fails where a turn is an error. */
function provider(turns: (ProviderChunk[] | Error)[]): Provider {
  let index = 0;
  return {
    id: "offline",
    model: "thinking-test",
    async *createStream() {
      const next = turns[index++];
      if (next === undefined) throw new Error("Unexpected model request");
      if (next instanceof Error) throw next;
      yield* next;
    },
  };
}

const thinkThenAnswer: ProviderChunk[] = [
  ...WORDS.map((reasoning): ProviderChunk => ({ type: "delta", reasoning })),
  { type: "delta", content: "The " },
  { type: "delta", content: "answer." },
  { type: "usage", usage },
  { type: "finish", finishReason: "stop" },
];

async function record(turns: (ProviderChunk[] | Error)[] = [thinkThenAnswer]) {
  const events: AgentEvent[] = [];
  const agent = defineAgent({
    id: "writer",
    version: "1",
    instructions: "Offline fixture.",
    provider: provider(turns),
  });
  const outcome = await agent.run("Question", {
    runId: "root",
    onEvent: (event) => {
      events.push(event);
    },
  });
  return { events, outcome };
}

/** The times a host's log gave each event: the model starts thinking at 1,000 and starts its
 * answer 2.1 seconds later. */
function clock(events: readonly AgentEvent[]): (index: number) => number {
  const first = events.findIndex((event) => event.type === "model_chunk" && event.chunk.reasoning);
  const answer = events.findIndex((event) => event.type === "model_chunk" && event.chunk.content);
  return (index) =>
    index < answer ? 1_000 + Math.max(0, index - first) * 100 : 3_100 + (index - answer) * 100;
}

function project(
  events: readonly AgentEvent[],
  options: Partial<AgentProjectorOptions> = {},
  times: ((index: number) => number) | null = clock(events),
) {
  const projector = createAgentProjector({ messageId: "reply", runId: "root", ...options });
  const sent = events.flatMap((event, index) =>
    projector.event(event, {
      segment: "s1",
      seq: index + 1,
      ...(times && { at: times(index) }),
    }),
  );
  return { projector, sent };
}

function view(events: readonly ChatEvent[]): ChatView {
  return events.reduce(reduceChat, emptyChatView());
}

function reply(state: ChatView): DisplayMessage | undefined {
  return state.messages.find((message) => message.id === "reply");
}

function thinkingRows(events: readonly ChatEvent[]): ThinkingPart[] {
  return events.flatMap((event) =>
    event.type === "part" && event.part.type === "thinking" ? [event.part] : [],
  );
}

describe("thinking rows", () => {
  it("records only the time the model thought before its answer began", async () => {
    const { events } = await record();
    const { sent } = project(events);
    const rows = thinkingRows(sent);
    expect(rows[0]).toEqual({
      type: "thinking",
      id: "root/model/1/thinking",
      settled: false,
      startedAt: 1_000,
    });
    expect(rows.at(-1)).toEqual({
      type: "thinking",
      id: "root/model/1/thinking",
      settled: true,
      startedAt: 1_000,
      durationMs: 2_100,
    });
    const parts = reply(view(sent))?.parts ?? [];
    expect(parts.map((part) => part.type)).toEqual(["thinking", "text"]);
    // What the model thought never crosses by default, in any event.
    expect(JSON.stringify(sent)).not.toContain(WORDS[1]);
  });

  it("says only that the model thought when the log has no times", async () => {
    const { events } = await record();
    const { sent } = project(events, {}, null);
    expect(thinkingRows(sent).at(-1)).toEqual({
      type: "thinking",
      id: "root/model/1/thinking",
      settled: true,
    });
  });

  it("draws the same row from a replay of the log and from the snapshot read after it", async () => {
    const { events, outcome } = await record();
    const live = project(events);
    const replay = project(events);
    expect(replay.sent).toEqual(live.sent);
    const saved = replay.projector.snapshot(outcome.snapshot);
    expect(saved.parts[0]).toEqual(thinkingRows(live.sent).at(-1));
    // A projector that never saw the log knows the model thought, and not for how long.
    const fresh = createAgentProjector({ messageId: "reply", runId: "root" });
    expect(fresh.snapshot(outcome.snapshot).parts[0]).toEqual({
      type: "thinking",
      id: "root/model/1/thinking",
      settled: true,
    });
  });

  it("sends the words only when the host opts in, and only where the text shows", async () => {
    const { events, outcome } = await record();
    const { sent, projector } = project(events, { reasoning: () => true });
    expect(thinkingRows(sent)[0]).toMatchObject({ text: WORDS[0], settled: false });
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "text", partId: "root/model/1/thinking", delta: WORDS[1] }),
    );
    expect(reply(view(sent))?.parts[0]).toMatchObject({
      type: "thinking",
      text: WORDS.join(""),
      durationMs: 2_100,
    });
    expect(projector.snapshot(outcome.snapshot).parts[0]).toMatchObject({ text: WORDS.join("") });
    const hidden = project(events, { reasoning: () => true, text: () => false });
    expect(thinkingRows(hidden.sent)).toEqual([]);
    expect(hidden.projector.snapshot(outcome.snapshot).parts).toEqual([]);
  });

  it("keeps no length for thinking that a failure cut short", async () => {
    // How long a broken turn thought is not information: the stretch did not end, the turn did.
    const broken: ProviderChunk[] = [{ type: "delta", reasoning: WORDS[0] }];
    const { events, outcome } = await record([[...broken], new Error("The model went away.")]);
    expect(outcome.status).toBe("failed");
    const { sent, projector } = project(events, {}, (index) => 1_000 + index * 100);
    const last = thinkingRows(sent).at(-1);
    expect(last).toMatchObject({ settled: true, startedAt: expect.any(Number) });
    expect(last?.durationMs).toBeUndefined();
    expect(
      projector.snapshot(outcome.snapshot).parts.find((part) => part.type === "thinking"),
    ).toEqual(last);
  });

  it("keeps no length for thinking that a gap in the log hid the end of", async () => {
    const { events } = await record();
    const answer = events.findIndex((event) => event.type === "model_chunk" && event.chunk.content);
    const times = clock(events);
    const projector = createAgentProjector({ messageId: "reply", runId: "root" });
    const before = events
      .slice(0, answer)
      .flatMap((event, index) => projector.event(event, { seq: index + 1, at: times(index) }));
    const marker = projector.gap({ seq: answer + 1 });
    expect(thinkingRows([...before, ...marker]).at(-1)).toEqual({
      type: "thinking",
      id: "root/model/1/thinking",
      settled: true,
      startedAt: 1_000,
    });
  });

  it("reports that native AG-UI events cannot carry a thinking row", () => {
    const writer = createAgUiWriter({
      binding: { threadId: "conversation", runId: "root", segment: "s1", agUiRunId: "native" },
    });
    const part: DisplayPart = { type: "thinking", id: "t", settled: true, durationMs: 400 };
    const written = writer.write({
      v: 1,
      type: "snapshot",
      messages: [{ id: "reply", role: "assistant", state: "live", parts: [part] }],
      run: { id: "root", status: "running" },
    });
    expect(written.issues).toContainEqual(
      expect.objectContaining({
        code: "unsupported",
        message: expect.stringContaining("thinking"),
      }),
    );
  });
});

describe("the thinking part on the wire", () => {
  const live: ThinkingPart = { type: "thinking", id: "t", settled: false, startedAt: 5, text: "" };
  const message = (...parts: DisplayPart[]): ChatEvent => ({
    v: 1,
    type: "message",
    message: { id: "reply", role: "assistant", state: "live", parts },
  });
  const delta = (text: string, attempt?: number): ChatEvent => ({
    v: 1,
    type: "text",
    messageId: "reply",
    partId: "t",
    delta: text,
    ...(attempt !== undefined && { attempt }),
  });

  it("reads the fields it knows and refuses a malformed one", () => {
    const full = { ...live, durationMs: 40, attempt: 2, agentId: "specialist" };
    expect(parseChatEvent({ v: 1, type: "part", messageId: "reply", part: full })).toEqual({
      v: 1,
      type: "part",
      messageId: "reply",
      part: full,
    });
    for (const broken of [
      { type: "thinking", id: "t" },
      { ...live, durationMs: -1 },
      { ...live, startedAt: "noon" },
      { ...live, text: 5 },
      { ...live, attempt: 0 },
    ])
      expect(parseChatEvent({ v: 1, type: "part", messageId: "reply", part: broken })).toBeNull();
  });

  it("takes words from a delta only when it came with words, and only while it is live", () => {
    let state = reduceChat(emptyChatView(), message(live));
    state = reduceChat(state, delta("first "));
    expect(reply(state)?.parts[0]).toMatchObject({ text: "first " });
    const quiet = reduceChat(
      emptyChatView(),
      message({ type: "thinking", id: "t", settled: false }),
    );
    expect(reduceChat(quiet, delta("words the host left out"))).toBe(quiet);
    const done = reduceChat(state, {
      v: 1,
      type: "part",
      messageId: "reply",
      part: { ...live, text: "first ", settled: true, durationMs: 900 },
    });
    expect(reduceChat(done, delta("late"))).toBe(done);
  });

  it("stays settled when a snapshot read during the stretch arrives", () => {
    const ended: ThinkingPart = { ...live, settled: true, durationMs: 900 };
    const state = reduceChat(emptyChatView(), message(ended));
    const read = reduceChat(state, {
      v: 1,
      type: "snapshot",
      messages: [{ id: "reply", role: "assistant", state: "live", parts: [live] }],
      run: { id: "root", status: "running" },
    });
    expect(reply(read)?.parts[0]).toBe(reply(state)?.parts[0]);
  });

  it("follows its call's attempts: a newer one replaces it, an older one cannot", () => {
    const first: ThinkingPart = { ...live, settled: true, durationMs: 900 };
    const second: ThinkingPart = {
      type: "thinking",
      id: "t",
      settled: false,
      attempt: 2,
      text: "",
    };
    let state = reduceChat(emptyChatView(), message(first));
    state = reduceChat(state, { v: 1, type: "part", messageId: "reply", part: second });
    expect(reply(state)?.parts[0]).toEqual(second);
    expect(reduceChat(state, { v: 1, type: "part", messageId: "reply", part: first })).toBe(state);
    expect(reduceChat(state, delta("old attempt"))).toBe(state);
    expect(reply(reduceChat(state, delta("new attempt", 2)))?.parts[0]).toMatchObject({
      text: "new attempt",
    });
  });
});
