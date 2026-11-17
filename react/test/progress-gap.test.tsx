import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { defineAgent, questionTool, type AgentEvent, type RunSnapshot } from "@providerkit/agents";
import { defineTool, type Provider } from "@providerkit/core";
import { createAgentProjector } from "../src/agents.ts";
import {
  emptyChatView,
  parseChatEvent,
  reduceChat,
  type ChatEvent,
  type ChatView,
  type DisplayMessage,
} from "../src/protocol.ts";
import { Message } from "../src/ui/message.tsx";

async function record() {
  const events: AgentEvent[] = [];
  const saves: RunSnapshot[] = [];
  const provider: Provider = {
    id: "offline",
    model: "gap-test",
    async *createStream() {
      yield { type: "delta", content: "A correct " };
      yield { type: "delta", content: "complete " };
      yield { type: "delta", content: "answer." };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const agent = defineAgent({
    id: "writer",
    version: "1",
    instructions: "Offline fixture.",
    provider,
  });
  const outcome = await agent.run("Example", {
    runId: "root",
    onEvent: (event) => {
      events.push(event);
    },
    host: {
      checkpoint: (snapshot) => {
        if (snapshot.kind !== "agent") throw new Error("Expected the agent fixture's checkpoint");
        saves.push(snapshot);
      },
    },
  });
  const running = saves.find((snapshot) =>
    snapshot.models.some((model) => model.status === "running"),
  );
  const first = events.findIndex((event) => event.type === "model_chunk" && event.chunk.content);
  if (!running || first < 0)
    throw new Error("The SDK fixture must record a running model and chunks.");
  return { events, running, finished: outcome.snapshot, first };
}
function projector() {
  return createAgentProjector({ runId: "root", messageId: "reply" });
}
function apply(view: ChatView, events: readonly ChatEvent[]) {
  return events.reduce(reduceChat, view);
}
function opening(
  p: ReturnType<typeof projector>,
  snapshot: RunSnapshot,
  messages: readonly DisplayMessage[] = [],
): ChatEvent {
  return {
    v: 1,
    type: "snapshot",
    messages: [...messages, p.snapshot(snapshot)],
    run: p.run(snapshot),
  };
}
function texts(view: ChatView) {
  return (
    view.messages
      .find((message) => message.id === "reply")
      ?.parts.filter((part) => part.type === "text") ?? []
  );
}

it("marks a retained prefix incomplete, suppresses later deltas and recovers only from the journal", async () => {
  const { events, running, finished, first } = await record();
  const p = projector();
  let view = emptyChatView();
  for (const [index, event] of events.slice(0, first + 1).entries())
    view = apply(view, p.event(event, { seq: index, segment: "physical" }));
  expect(texts(view)[0]?.text).toBe("A correct ");
  const marker = p.gap({ seq: first + 1, segment: "physical" });
  view = apply(view, marker);
  expect(apply(view, marker)).toBe(view);
  expect(texts(view)[0]).toMatchObject({ text: "A correct ", incomplete: true });
  view = reduceChat(view, opening(p, running));
  for (const [index, event] of events.slice(first + 1).entries())
    view = apply(view, p.event(event, { seq: first + 2 + index, segment: "physical" }));
  expect(texts(view)[0]).toMatchObject({ text: "A correct ", incomplete: true });
  expect(texts(view)[0]?.attempt).toBeUndefined();
  expect(view.cursor?.segment).toBe("physical");
  view = reduceChat(view, opening(p, finished));
  expect(texts(view)[0]).toMatchObject({ text: "A correct complete answer.", settled: true });
  expect(texts(view)[0]?.incomplete).toBeUndefined();
});

it("settles a tool-only turn after a gap while its question waits", async () => {
  const ready = defineTool({
    name: "prepare",
    description: "Prepare the offline sample.",
    inputSchema: { type: "object" },
    validate: () => undefined,
    isReadOnly: true,
    run: async () => "Ready",
  });
  const question = questionTool();
  const provider: Provider = {
    id: "offline",
    model: "gap-then-question",
    async *createStream(messages) {
      const prepared = messages.some((message) => message.role === "tool");
      if (!prepared) {
        yield { type: "delta", content: "A correct " };
        yield { type: "delta", content: "complete answer." };
      }
      yield {
        type: "delta",
        toolCalls: [
          {
            index: 0,
            id: prepared ? "question" : "prepare",
            name: prepared ? question.name : ready.name,
            arguments: prepared
              ? JSON.stringify({ message: "What happens next?", freeText: true })
              : "{}",
          },
        ],
      };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const agent = defineAgent({
    id: "writer",
    version: "1",
    instructions: "Offline fixture.",
    provider,
    tools: [ready, question],
  });
  const p = projector();
  let view = emptyChatView();
  let sawPlaceholder = false;
  const outcome = await agent.run("Example", {
    runId: "root",
    onEvent: (event) => {
      if (event.type === "model_chunk" && event.chunk.content === "complete answer.") {
        view = apply(view, p.gap());
        return; // Omit progress only, not the completed model's checkpoint.
      }
      view = apply(view, p.event(event));
    },
    host: {
      checkpoint: (snapshot) => {
        if (snapshot.kind !== "agent") throw new Error("Expected the agent fixture's checkpoint");
        view = reduceChat(view, opening(p, snapshot));
        if (snapshot.models.length === 2 && snapshot.models[1]?.status === "running")
          sawPlaceholder = texts(view).some(
            (part) => part.id === snapshot.models[1]?.id && !part.settled && part.incomplete,
          );
      },
      prepareRequest: () => ({
        scope: {
          actorId: "person",
          resource: { id: "conversation", version: "1" },
          expiresAt: Date.now() + 60_000,
        },
      }),
    },
  });
  expect(sawPlaceholder).toBe(true);
  expect(outcome.status).toBe("suspended");
  expect(outcome.snapshot.models.map((model) => model.status)).toEqual(["completed", "completed"]);
  expect(view.run.status).toBe("waiting");
  expect(view.messages[0]?.parts).toContainEqual(
    expect.objectContaining({ type: "question", state: "pending" }),
  );
  expect(texts(view)).toEqual([
    {
      type: "text",
      id: outcome.snapshot.models[0]!.id,
      text: "A correct complete answer.",
      settled: true,
    },
    { type: "text", id: outcome.snapshot.models[1]!.id, text: "", settled: true },
  ]);
  expect(renderToStaticMarkup(<Message message={view.messages[0]!} />)).not.toContain(
    'data-part="incomplete-text"',
  );
  const restored = projector();
  restored.gap();
  expect(reduceChat(view, opening(restored, outcome.snapshot))).toBe(view);
});

it("a fresh projector's running snapshot marks an existing prefix even with no complete saved text", async () => {
  const { events, running, finished, first } = await record();
  const p = projector();
  let view = apply(
    emptyChatView(),
    events.slice(0, first + 1).flatMap((event) => p.event(event)),
  );
  const settled: DisplayMessage = {
    id: "earlier",
    role: "assistant",
    state: "settled",
    parts: [{ type: "text", id: "saved", text: "Earlier work", settled: true }],
  };
  const draft: DisplayMessage = {
    id: "draft",
    clientId: "unsent",
    role: "user",
    state: "sending",
    parts: [{ type: "text", id: "typed", text: "Do not lose this", settled: true }],
  };
  view = reduceChat(view, { v: 1, type: "message", message: settled });
  view = reduceChat(view, { v: 1, type: "message", message: draft });
  const fresh = projector();
  fresh.gap(); // agent.resync is a host RunEvent too, not an AgentEvent cast
  const projected = fresh.snapshot(running);
  expect(projected.parts).toContainEqual(expect.objectContaining({ text: "", incomplete: true }));
  view = reduceChat(view, opening(fresh, running, [settled]));
  expect(texts(view)[0]).toMatchObject({ text: "A correct ", incomplete: true });
  const partId = texts(view)[0]!.id;
  view = reduceChat(view, {
    v: 1,
    type: "text",
    messageId: "reply",
    partId,
    delta: "false suffix",
  });
  view = reduceChat(view, {
    v: 1,
    type: "part",
    messageId: "reply",
    part: { type: "text", id: partId, text: "false full answer", settled: true },
  });
  expect(texts(view)[0]?.text).toBe("A correct ");
  view = reduceChat(view, opening(fresh, finished, [settled]));
  expect(texts(view)[0]?.text).toBe("A correct complete answer.");
  expect(view.messages.find((message) => message.id === "earlier")).toBe(settled);
  expect(view.messages.find((message) => message.id === "draft")).toBe(draft);
});

it("keeps a genuine restarted attempt separate from missing and replayed earlier progress", async () => {
  const { events, running, finished, first } = await record();
  const p = projector();
  let view = apply(
    emptyChatView(),
    events.slice(0, first + 1).flatMap((event) => p.event(event)),
  );
  view = apply(view, p.gap());
  const next = structuredClone(running);
  const model = next.models[0]!;
  const previousAttemptId = model.attemptId;
  model.interrupted.push({ attemptId: previousAttemptId, usage: model.usage });
  model.attemptId = "new-attempt";
  next.attemptId = "new-attempt";
  view = reduceChat(view, opening(p, next));
  expect(texts(view)[0]).toMatchObject({ text: "", attempt: 2, incomplete: true });
  view = apply(
    view,
    p.event({
      type: "operation_restart",
      kind: "model",
      runId: "root",
      operationId: model.id,
      previousAttemptId,
      attemptId: "new-attempt",
    }),
  );
  view = apply(view, p.event(events[first]!));
  expect(texts(view)[0]?.text).toBe("");
  const complete = structuredClone(finished);
  complete.attemptId = "new-attempt";
  complete.models[0]!.attemptId = "new-attempt";
  complete.models[0]!.interrupted = model.interrupted;
  view = reduceChat(view, opening(p, complete));
  view = reduceChat(view, {
    v: 1,
    type: "text",
    messageId: "reply",
    partId: model.id,
    attempt: 1,
    delta: "old",
  });
  expect(texts(view)[0]).toMatchObject({ text: "A correct complete answer.", attempt: 2 });
  expect(texts(view)[0]?.incomplete).toBeUndefined();
});

it("never marks checkpointed text missing, and retains an incomplete prefix when a run stops", async () => {
  const { events, running, finished, first } = await record();
  const complete = projector();
  let saved = reduceChat(emptyChatView(), opening(complete, finished));
  saved = apply(saved, complete.gap());
  expect(texts(saved)[0]?.incomplete).toBeUndefined();
  const p = projector();
  let view = apply(
    emptyChatView(),
    events.slice(0, first + 1).flatMap((event) => p.event(event)),
  );
  view = apply(view, p.gap());
  const stopped = { ...running, state: { status: "cancelled" as const } };
  view = reduceChat(view, opening(p, stopped));
  expect(view.run.status).toBe("stopped");
  expect(texts(view)[0]).toMatchObject({ text: "A correct ", incomplete: true });
});

it("validates the missing-text flag and keeps its notice with custom text rendering", () => {
  const message: DisplayMessage = {
    id: "reply",
    role: "assistant",
    state: "live",
    parts: [{ type: "text", id: "text", text: "Prefix", settled: false, incomplete: true }],
  };
  expect(parseChatEvent({ v: 1, type: "message", message })).toEqual({
    v: 1,
    type: "message",
    message,
  });
  expect(
    parseChatEvent({
      v: 1,
      type: "part",
      messageId: "reply",
      part: { ...message.parts[0], incomplete: "yes" },
    }),
  ).toBeNull();
  const html = renderToStaticMarkup(
    <Message
      message={message}
      renderText={(part) => <strong>{part.text}</strong>}
      labels={{ incompleteText: "Missing words. Check updates." }}
    />,
  );
  expect(html).toContain("<strong>Prefix</strong>");
  expect(html).toContain('data-part="incomplete-text"');
  expect(html).toContain("Missing words. Check updates.");
});
