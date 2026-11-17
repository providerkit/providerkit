import { describe, expect, it } from "vitest";
import {
  checkResponse,
  emptyChatView,
  parseChatEvent,
  parseRequestAnswers,
  reduceChat,
  type ChatEvent,
  type QuestionPart,
  type TextPart,
} from "../src/protocol.ts";

const question: QuestionPart = {
  type: "question",
  id: "ask",
  toolId: "operation",
  title: "Pick one",
  state: "pending",
  choices: [{ id: "a", label: "A" }],
};
const part = (part: QuestionPart | TextPart): ChatEvent => ({
  v: 1,
  type: "part",
  messageId: "reply",
  part,
});
const initial: ChatEvent = {
  v: 1,
  type: "message",
  message: { id: "reply", role: "assistant", state: "live", parts: [] },
};

describe("request wire guards", () => {
  it("copies only named display fields and refuses malformed choice lists", () => {
    const value = {
      ...question,
      path: "private-route",
      scope: "private-scope",
      arguments: "private-args",
      decision: "private-answer",
      receipt: "private-receipt",
    };
    expect(parseChatEvent(part(value))).toEqual(part(question));
    for (const choices of [
      [{ id: "a", label: 42 }],
      [
        { id: "a", label: "A" },
        { id: "a", label: "Again" },
      ],
      "not an array",
    ])
      expect(parseChatEvent({ ...part(question), part: { ...question, choices } })).toBeNull();
  });

  it("accepts every typed answer shape but rejects duplicate ids and injected routes", () => {
    const responses = [
      { type: "approve" },
      { type: "deny", message: "No" },
      { type: "answer", answer: { choices: ["a"] } },
      { type: "result", value: { count: 1 } },
      { type: "cancel" },
      { type: "stop" },
    ];
    for (const response of responses)
      expect(parseRequestAnswers([{ requestId: "ask", response }])).toEqual([
        { requestId: "ask", response },
      ]);
    expect(
      parseRequestAnswers([{ requestId: "ask", response: { type: "cancel", data: {} } }]),
    ).toBeNull();
    expect(
      parseRequestAnswers([{ requestId: "ask", response: { type: "approve" }, path: [] }]),
    ).toBeNull();
    expect(
      parseRequestAnswers([
        { requestId: "ask", response: { type: "approve" } },
        { requestId: "ask", response: { type: "deny" } },
      ]),
    ).toBeNull();
    expect(checkResponse(question, { type: "answer", answer: { choices: ["a", "a"] } })?.code).toBe(
      "invalid_answer",
    );
  });

  it("never reopens a closed question and treats a snapshot's requests as authoritative", () => {
    let view = [initial, part(question), part({ ...question, state: "answered" })].reduce(
      reduceChat,
      emptyChatView(),
    );
    expect(reduceChat(view, part(question))).toBe(view);
    view = reduceChat(view, {
      v: 1,
      type: "snapshot",
      messages: [{ ...initial.message, parts: [question] }],
      run: { status: "waiting" },
    });
    view = reduceChat(view, {
      v: 1,
      type: "snapshot",
      messages: [{ ...initial.message, parts: [] }],
      run: { status: "waiting" },
    });
    expect(view.messages[0]?.parts).toEqual([]);
  });
});

describe("attempt-aware text", () => {
  it("replaces only the restarted operation and refuses old deltas and terminal rewrites", () => {
    const first: TextPart = { type: "text", id: "model", text: "Old", settled: true };
    const other: TextPart = {
      type: "text",
      id: "specialist",
      agentId: "child",
      text: "Keep",
      settled: true,
    };
    let view = [
      initial,
      part(other),
      part(first),
      part({ ...first, text: "New", settled: false, attempt: 2 }),
    ].reduce(reduceChat, emptyChatView());
    view = reduceChat(view, {
      v: 1,
      type: "text",
      messageId: "reply",
      partId: "model",
      delta: " wrong",
    });
    view = reduceChat(view, part({ ...first, text: "Old final" }));
    view = reduceChat(view, {
      v: 1,
      type: "text",
      messageId: "reply",
      partId: "model",
      delta: " text",
      attempt: 2,
    });
    expect(view.messages[0]?.parts).toEqual([
      other,
      { ...first, text: "New text", settled: false, attempt: 2 },
    ]);
    view = reduceChat(view, { ...initial, message: { ...initial.message, state: "settled" } });
    const ended = view;
    view = reduceChat(view, part({ ...first, text: "Late", settled: false, attempt: 3 }));
    expect(view).toBe(ended);
  });

  it("does not keep an older attempt merely because its text is longer", () => {
    const text: TextPart = {
      type: "text",
      id: "model",
      text: "Same prefix plus old text",
      settled: false,
    };
    const view = [initial, part(text)].reduce(reduceChat, emptyChatView());
    const next = reduceChat(view, {
      v: 1,
      type: "snapshot",
      messages: [{ ...initial.message, parts: [{ ...text, text: "Same prefix", attempt: 2 }] }],
      run: { status: "running" },
    });
    expect(next.messages[0]?.parts[0]).toMatchObject({ text: "Same prefix", attempt: 2 });
    expect(
      parseChatEvent({
        v: 1,
        type: "text",
        messageId: "reply",
        partId: "model",
        delta: "!",
        attempt: 0,
      }),
    ).toBeNull();
  });
});
