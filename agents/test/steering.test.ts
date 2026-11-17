import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAgent } from "./fixtures/assertions.ts";
import { defineTool, type ChatMessage, type Provider, type ProviderChunk } from "@providerkit/core";
import {
  createMemoryInbox,
  createMemorySession,
  defineAgent,
  defineHandoff,
  questionTool,
  INPUT_LIMITS,
  InputConflictError,
  type AgentEvent,
  type AgentHost,
  type InputInbox,
  type RunSnapshot,
} from "../src/index.ts";
import { AGENT_RUNTIME } from "../src/delegation.ts";
import { checkChildProgress } from "../src/snapshot.ts";
import { evidenceFor } from "./fixtures/requests.ts";

const base = { id: "writer", version: "1", instructions: "Answer the request." };
const runId = "conversation-run";
const signal = () => new AbortController().signal;
const authorizeResume = () => {};
const text = (content = "done"): ProviderChunk[] => [
  { type: "delta", content },
  { type: "usage", usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 } },
  { type: "finish", finishReason: "stop" },
];
const calls = (...names: string[]): ProviderChunk[] => [
  {
    type: "finish",
    finishReason: "tool_calls",
    toolCalls: names.map((name, index) => ({ index, id: `call-${index}`, name, arguments: "{}" })),
  },
];
function wire(
  turns: ProviderChunk[][],
  before?: (position: number, history: ChatMessage[]) => void | Promise<void>,
) {
  const sent: ChatMessage[][] = [];
  const provider: Provider = {
    id: "fake",
    model: "fake",
    async *createStream(history) {
      const position = sent.length;
      sent.push(structuredClone(history));
      await before?.(position, history);
      const chunks = turns[position];
      if (!chunks) throw new Error("Unexpected paid call");
      yield* chunks;
    },
  };
  return { sent, provider };
}
function tool(name = "read", run = async () => "read") {
  return defineTool({ name, description: "Read a record.", inputSchema: { type: "object" }, run });
}
function saved(value: RunSnapshot | undefined): RunSnapshot {
  if (!value) throw new Error("Missing saved checkpoint");
  return structuredClone(value);
}
const userText = (history: ChatMessage[]) =>
  history.filter((m) => m.role === "user").map((m) => m.content);
afterEach(() => vi.useRealTimers());

describe("host input inbox", () => {
  it("normalizes, copies and deduplicates content and rejects id conflicts", () => {
    const inbox = createMemoryInbox(runId);
    const input = {
      id: "note",
      content: [
        { type: "text" as const, text: "" },
        { type: "text" as const, text: "Short answer" },
      ],
    };
    expect(inbox.enqueue(input).status).toBe("queued");
    input.content[1]!.text = "changed caller";
    const same = { id: "note", content: [{ type: "text" as const, text: "Short answer" }] };
    expect(inbox.enqueue(same).content).toEqual(same.content);
    expect(() => inbox.enqueue({ id: "note", content: "Different" })).toThrow(InputConflictError);
    const list = inbox.list();
    list[0]!.content = "mutated reader";
    expect(inbox.list()).toHaveLength(1);
    expect(inbox.list()[0]?.content).toEqual(same.content);
  });

  it("bounds pending input, retained count and UTF-8 bytes", () => {
    const inbox = createMemoryInbox(runId);
    for (let index = 0; index < INPUT_LIMITS.count; index++) {
      const id = `note-${index}`;
      inbox.enqueue({ id, content: "short" });
      inbox.acknowledge(
        [
          {
            id,
            rootRunId: runId,
            runId,
            status: "accepted",
            beforeModel: 0,
            modelId: `${runId}/model/1`,
          },
        ],
        { signal: signal() },
      );
    }
    expect(() => inbox.enqueue({ id: "overflow", content: "no" })).toThrow("full");
    // A duplicate is allowed even when full, and retains its delivery state.
    expect(inbox.enqueue({ id: "note-0", content: "short" }).status).toBe("accepted");
    const waiting = createMemoryInbox(runId);
    for (let index = 0; index < INPUT_LIMITS.pending; index++)
      waiting.enqueue({ id: String(index), content: "pending" });
    expect(() => waiting.enqueue({ id: "overflow", content: "no" })).toThrow("full");
    const bytes = createMemoryInbox(runId);
    expect(() =>
      bytes.enqueue({ id: "large", content: "é".repeat(INPUT_LIMITS.bytes / 2) }),
    ).toThrow("full");
    expect(bytes.list()).toEqual([]);
  });

  it("keeps delivery monotonic and scoped, and refuses changed receipt positions", () => {
    const inbox = createMemoryInbox(runId);
    inbox.enqueue({ id: "one", content: "one" });
    const receipt = {
      id: "one",
      rootRunId: runId,
      runId,
      beforeModel: 0,
      modelId: `${runId}/model/1`,
      status: "accepted" as const,
    };
    expect(() =>
      inbox.acknowledge([receipt, { ...receipt, beforeModel: 1, modelId: `${runId}/model/2` }], {
        signal: signal(),
      }),
    ).toThrow(InputConflictError);
    expect(inbox.list()[0]?.status).toBe("queued");
    inbox.acknowledge([receipt, receipt], { signal: signal() });
    inbox.acknowledge([{ ...receipt, status: "consumed", attemptId: "attempt" }], {
      signal: signal(),
    });
    inbox.acknowledge([receipt], { signal: signal() });
    expect(inbox.list()[0]?.status).toBe("consumed");
    expect(() =>
      inbox.acknowledge([{ ...receipt, beforeModel: 1, modelId: `${runId}/model/2` }], {
        signal: signal(),
      }),
    ).toThrow(InputConflictError);
    expect(() =>
      inbox.poll({
        rootRunId: "other",
        runId,
        agent: base,
        limit: { count: 1, bytes: 100 },
        signal: signal(),
      }),
    ).toThrow("another run");
  });

  it.each([
    "",
    { messages: [{ role: "user", content: "not a replacement" }] },
    { type: "approve" },
    [{ type: "image", mimeType: "image/svg+xml", data: "YQ==" }],
    [{ type: "file", mimeType: "application/pdf", data: "not base64" }],
  ])("refuses invalid content %j", (content) => {
    const inbox = createMemoryInbox(runId);
    // Deliberate untyped boundary, as in an HTTP JSON body.
    expect(() => Reflect.apply(inbox.enqueue, inbox, [{ id: "bad", content }])).toThrow(TypeError);
    expect(inbox.list()).toEqual([]);
  });
});

describe("safe-boundary steering", () => {
  it("journals before acknowledgement and consumption, without exposing input in events", async () => {
    const inbox = createMemoryInbox(runId);
    inbox.enqueue({ id: "one", content: "private extra context" });
    const events: AgentEvent[] = [];
    const states: string[] = [];
    let durable: RunSnapshot | undefined;
    const model = wire([text()], () => {
      expect(durable?.inputs).toEqual([
        { id: "one", content: "private extra context", beforeModel: 0 },
      ]);
      expect(inbox.list()[0]?.status).toBe("accepted");
    });
    const agent = defineAgent({ ...base, provider: model.provider });
    const result = await agent.run("First", {
      runId,
      onEvent: (event) => {
        events.push(event);
      },
      host: {
        checkpoint(snapshot) {
          assertAgent(snapshot);
          durable = saved(snapshot);
        },
        inbox: {
          ...inbox,
          acknowledge(receipts, options) {
            const receipt = receipts[0];
            expect(durable?.inputs[0]?.id).toBe(receipt?.id);
            if (receipt?.status === "consumed")
              expect(durable?.models[0]?.status).toBe("completed");
            states.push(receipt?.status ?? "missing");
            inbox.acknowledge(receipts, options);
          },
        },
      },
    });
    expect(result.status).toBe("completed");
    expect(states).toEqual(["accepted", "consumed"]);
    expect(result.inputs).toMatchObject([
      { id: "one", rootRunId: runId, runId, beforeModel: 0, status: "consumed" },
    ]);
    expect(events.filter((e) => e.type === "input").map((e) => e.receipt.status)).toEqual([
      "accepted",
      "consumed",
    ]);
    expect(JSON.stringify(events.filter((e) => e.type === "input"))).not.toContain(
      "private extra context",
    );
    expect(userText(model.sent[0]!)).toEqual(["First", "private extra context"]);
  });

  it.each(["model", "tool"] as const)(
    "waits for the executing %s and all tool results, without replay",
    async (boundary) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const inbox = createMemoryInbox(runId);
      const instructions = vi.fn(() => base.instructions);
      const effects: string[] = [];
      const read = tool("read", async () => {
        effects.push("read");
        if (boundary === "tool") {
          entered.resolve();
          await release.promise;
        }
        return "record";
      });
      const other = tool("other", async () => {
        effects.push("other");
        return "other";
      });
      const model = wire([calls("read", "other"), text()], async (position) => {
        if (boundary === "model" && position === 0) {
          entered.resolve();
          await release.promise;
        }
      });
      const thread = createMemorySession();
      const agent = defineAgent({
        ...base,
        instructions,
        provider: model.provider,
        tools: [read, other],
      });
      const work = agent.run("First", { runId, session: thread, host: { inbox } });
      await entered.promise;
      inbox.enqueue({ id: "steer", content: "Use short sentences" });
      expect(inbox.list()[0]?.status).toBe("queued");
      expect(model.sent).toHaveLength(1);
      release.resolve();
      const result = await work;
      expect(result.status).toBe("completed");
      expect(effects).toEqual(["read", "other"]);
      expect(model.sent).toHaveLength(2);
      expect(userText(model.sent[0]!)).toEqual(["First"]);
      expect(model.sent[1]?.slice(-4).map((m) => m.role)).toEqual([
        "assistant",
        "tool",
        "tool",
        "user",
      ]);
      expect(result.snapshot.inputs).toEqual([
        { id: "steer", content: "Use short sentences", beforeModel: 1 },
      ]);
      const again = await agent.resume(result.snapshot, {
        host: { inbox, authorizeResume },
        session: thread,
      });
      expect(again.history).toEqual(result.history);
      expect(again.newMessages).toEqual(result.newMessages);
      expect((await thread.load({ signal: signal() })).messages).toEqual(result.newMessages);
      expect(result.newMessages.filter((m) => m.role === "user")).toHaveLength(2);
      expect(instructions).toHaveBeenCalledOnce();
      expect(model.sent).toHaveLength(2);
    },
  );

  it.each(["model", "final-save", "terminal-event"] as const)(
    "retains late input at %s without starting another paid call",
    async (point) => {
      const inbox = createMemoryInbox(runId);
      const enqueue = () => inbox.enqueue({ id: "late", content: "Another question" });
      const model = wire([text()], () => {
        if (point === "model") enqueue();
      });
      const agent = defineAgent({ ...base, provider: model.provider });
      const result = await agent.run("First", {
        runId,
        host: {
          inbox,
          checkpoint(snapshot) {
            assertAgent(snapshot);
            if (point === "final-save" && snapshot.state.status === "completed") enqueue();
          },
        },
        onEvent(event) {
          if (point === "terminal-event" && event.type === "state") enqueue();
        },
      });
      expect(result.status).toBe("completed");
      expect(result.inputs).toEqual([]);
      expect(inbox.list()).toMatchObject([{ id: "late", status: "queued" }]);
      await agent.resume(result.snapshot, { host: { inbox, authorizeResume } });
      expect(model.sent).toHaveLength(1);
      expect(inbox.list()[0]?.status).toBe("queued");
    },
  );

  it.each(["approval", "question"] as const)(
    "does not treat steering as a %s answer or Stop",
    async (kind) => {
      const inbox = createMemoryInbox(runId);
      const effect = vi.fn(async () => "written");
      const first: ProviderChunk[] =
        kind === "approval"
          ? calls("write")
          : [
              {
                type: "finish",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    index: 0,
                    id: "question",
                    name: "ask_question",
                    arguments: '{"message":"Which record?","freeText":true}',
                  },
                ],
              },
            ];
      const model = wire([first, text()]);
      const agent = defineAgent({
        ...base,
        provider: model.provider,
        tools:
          kind === "approval"
            ? [
                defineTool({
                  name: "write",
                  description: "Write",
                  inputSchema: { type: "object" },
                  needsApproval: true,
                  run: effect,
                }),
              ]
            : [questionTool()],
      });
      const resolveRequest = vi.fn<NonNullable<AgentHost["resolveRequest"]>>(
        (_request, evidence) => {
          expect(evidence).toBe("explicit evidence");
          return kind === "approval"
            ? { type: "approve" }
            : { type: "answer", answer: { text: "record 1" } };
        },
      );
      const poll = vi.fn(inbox.poll);
      const host = {
        inbox: { ...inbox, poll },
        authorizeResume,
        beforeTool() {},
        resolveRequest,
        prepareRequest: () => ({
          scope: {
            actorId: "actor",
            resource: { id: "record", version: "1" },
            expiresAt: Date.now() + 60_000,
          },
        }),
      };
      const waiting = await agent.run("First", { runId, host });
      expect(waiting.status).toBe("suspended");
      inbox.enqueue({ id: "words", content: "approve deny stop and answer record 2" });
      const still = await agent.resume(waiting.snapshot, { host });
      expect(still.status).toBe("suspended");
      expect(resolveRequest).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
      expect(poll).toHaveBeenCalledOnce();
      expect(inbox.list()[0]?.status).toBe("queued");
      const done = await agent.resume(still.snapshot, {
        host,
        answers: evidenceFor(still.snapshot, "explicit evidence"),
      });
      expect(done.status).toBe("completed");
      expect(resolveRequest).toHaveBeenCalledOnce();
      expect(effect).toHaveBeenCalledTimes(kind === "approval" ? 1 : 0);
      expect(done.inputs[0]?.status).toBe("consumed");
      expect(model.sent).toHaveLength(2);
    },
  );
});

describe("input checkpoint boundaries", () => {
  it("leaves a failed poll queued and does not retry it or leak host error text", async () => {
    const inbox = createMemoryInbox(runId);
    inbox.enqueue({ id: "note", content: "Keep me" });
    const model = wire([text()]);
    const poll = vi.fn(() => {
      throw new Error("Bearer inbox-key");
    });
    const result = await defineAgent({ ...base, provider: model.provider }).run("First", {
      runId,
      host: { inbox: { ...inbox, poll } },
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "input_poll_failed" } });
    expect(result.inputs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("inbox-key");
    expect(inbox.list()[0]?.status).toBe("queued");
    expect(model.sent).toEqual([]);
    expect(poll).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "checks duplicate ids within one offered batch (changed: %s)",
    async (changed) => {
      const model = wire([text()]);
      const acknowledge = vi.fn();
      const result = await defineAgent({ ...base, provider: model.provider }).run("First", {
        runId,
        host: {
          inbox: {
            acknowledge,
            poll: () => [
              { id: "note", content: "Original" },
              { id: "note", content: changed ? "Changed" : "Original" },
            ],
          },
        },
      });
      expect(result.status).toBe(changed ? "failed" : "completed");
      expect(result.inputs).toHaveLength(changed ? 0 : 1);
      expect(model.sent).toHaveLength(changed ? 0 : 1);
      if (changed) expect(acknowledge).not.toHaveBeenCalled();
    },
  );

  it.each(["before-save", "after-save", "after-ack", "after-model"] as const)(
    "recovers %s without losing or duplicating input",
    async (point) => {
      const inbox = createMemoryInbox(runId);
      inbox.enqueue({ id: "note", content: "Keep this exact text" });
      const model = wire([text()]);
      const agent = defineAgent({ ...base, provider: model.provider });
      let durable = await agent[AGENT_RUNTIME].open("First", {}, runId);
      let lost = false;
      const ack = vi.fn(inbox.acknowledge);
      await agent.resume(durable, {
        host: {
          authorizeResume,
          inbox: { ...inbox, acknowledge: ack },
          checkpoint(snapshot) {
            assertAgent(snapshot);
            if (lost) throw new Error("Worker gone");
            const at =
              point === "before-save" || point === "after-save"
                ? snapshot.inputs.length > 0 && snapshot.models.length === 0
                : point === "after-ack"
                  ? snapshot.models[0]?.status === "running"
                  : snapshot.models[0]?.status === "completed";
            if (at) {
              lost = true;
              if (point === "after-save" || point === "after-model") durable = saved(snapshot);
              throw new Error("Worker gone");
            }
            durable = saved(snapshot);
          },
        },
      });
      expect(lost).toBe(true);
      expect(ack).toHaveBeenCalledTimes(point === "after-ack" || point === "after-model" ? 1 : 0);
      expect(inbox.list()[0]?.status).toBe(
        point === "after-ack" || point === "after-model" ? "accepted" : "queued",
      );
      const completed = await agent.resume(durable, { host: { authorizeResume, inbox } });
      expect(completed.status).toBe("completed");
      expect(completed.snapshot.inputs).toEqual([
        { id: "note", content: "Keep this exact text", beforeModel: 0 },
      ]);
      expect(userText(model.sent[0]!)).toEqual(["First", "Keep this exact text"]);
      expect(model.sent).toHaveLength(1);
      expect(inbox.list()[0]?.status).toBe("consumed");
      expect(completed.newMessages.filter((m) => m.role === "user")).toHaveLength(2);
    },
  );

  it("does not reread saved content when acknowledgement was lost", async () => {
    const inbox = createMemoryInbox(runId);
    inbox.enqueue({ id: "note", content: "Original" });
    const model = wire([text()]);
    const agent = defineAgent({ ...base, provider: model.provider });
    let durable: RunSnapshot | undefined;
    await agent.run("First", {
      runId,
      host: {
        inbox,
        checkpoint(snapshot) {
          assertAgent(snapshot);
          durable = saved(snapshot);
          throw new Error("Saved, reply lost");
        },
      },
    });
    const order: string[] = [];
    const done = await agent.resume(saved(durable), {
      host: {
        authorizeResume,
        inbox: {
          acknowledge(receipts, options) {
            order.push("ack");
            inbox.acknowledge(receipts, options);
          },
          poll(request) {
            order.push("poll");
            return inbox.poll(request);
          },
        },
      },
    });
    expect(order.slice(0, 2)).toEqual(["ack", "poll"]);
    expect(done.status).toBe("completed");
    expect(userText(model.sent[0]!)).toEqual(["First", "Original"]);
  });

  it.each([false, true])(
    "deduplicates host redelivery and rejects changed content: %s",
    async (changed) => {
      const inbox = createMemoryInbox(runId);
      const model = wire([calls("read"), text()]);
      const agent = defineAgent({ ...base, provider: model.provider, tools: [tool()] });
      let polls = 0;
      const result = await agent.run("First", {
        runId,
        host: {
          inbox: {
            ...inbox,
            poll: () => [{ id: "note", content: ++polls > 1 && changed ? "Changed" : "Original" }],
            acknowledge() {},
          },
        },
      });
      expect(result.status).toBe(changed ? "failed" : "completed");
      if (changed) expect(result).toMatchObject({ error: { code: "input_conflict" } });
      expect(result.snapshot.inputs).toEqual([{ id: "note", content: "Original", beforeModel: 0 }]);
      expect(model.sent).toHaveLength(changed ? 1 : 2);
    },
  );

  it("keeps accepted input unconsumed on a failed acknowledgement and never leaks host errors", async () => {
    const inbox = createMemoryInbox(runId);
    inbox.enqueue({ id: "note", content: "Original" });
    const model = wire([text()]);
    const agent = defineAgent({ ...base, provider: model.provider });
    const result = await agent.run("First", {
      runId,
      host: {
        inbox: {
          ...inbox,
          acknowledge(receipts, options) {
            inbox.acknowledge(receipts, options);
            throw new Error("Bearer secret-host-token");
          },
        },
      },
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "input_acknowledge_failed" } });
    expect(JSON.stringify(result)).not.toContain("secret-host-token");
    expect(result.inputs[0]?.status).toBe("accepted");
    expect(inbox.list()[0]?.status).toBe("accepted");
    expect(model.sent).toEqual([]);
  });

  it.each([false, true])(
    "does not poll or change admitted model input during recovery (safe: %s)",
    async (safe) => {
      const inbox = createMemoryInbox(runId);
      inbox.enqueue({ id: "first", content: "Original" });
      const model = wire([text("interrupted"), text("replacement")]);
      const agent = defineAgent({
        ...base,
        provider: model.provider,
        ...(safe
          ? { recovery: { identity: "inference", maxAttempts: 2, inferenceOnly: true } }
          : {}),
      });
      let durable: RunSnapshot | undefined;
      await agent.run("First", {
        runId,
        host: {
          inbox,
          checkpoint(snapshot) {
            assertAgent(snapshot);
            if (snapshot.models[0]?.status === "completed") throw new Error("Worker gone");
            durable = saved(snapshot);
          },
        },
      });
      inbox.enqueue({ id: "late", content: "Do not inject into replay" });
      const poll = vi.fn(inbox.poll);
      const done = await agent.resume(saved(durable), {
        host: { authorizeResume, inbox: { ...inbox, poll } },
      });
      expect(done.status).toBe(safe ? "completed" : "failed");
      expect(poll).not.toHaveBeenCalled();
      expect(model.sent).toHaveLength(safe ? 2 : 1);
      if (safe) expect(model.sent[1]).toEqual(model.sent[0]);
      expect(inbox.list()[1]?.status).toBe("queued");
      expect(done.inputs[0]?.status).toBe(safe ? "consumed" : "accepted");
    },
  );
});

describe("routing and limits", () => {
  it("retains messages arriving during a stopping tool rather than buying another model call", async () => {
    const inbox = createMemoryInbox(runId);
    const model = wire([calls("read")]);
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      stopAtTools: ["read"],
      tools: [
        tool("read", async () => {
          inbox.enqueue({ id: "late", content: "Another question" });
          return "The tool has the answer";
        }),
      ],
    });
    const result = await agent.run("First", { runId, host: { inbox } });
    expect(result.status).toBe("completed");
    expect(result.inputs).toEqual([]);
    expect(inbox.list()[0]?.status).toBe("queued");
    expect(model.sent).toHaveLength(1);
  });

  it("bounds accepted input across model turns and leaves the rest in host storage", async () => {
    const model = wire([calls("read"), calls("read"), calls("read"), calls("read"), text()]);
    const agent = defineAgent({ ...base, provider: model.provider, tools: [tool()] });
    let queued = 129;
    let polled = 0;
    const result = await agent.run("First", {
      runId,
      host: {
        inbox: {
          poll({ limit }) {
            const batch = Array.from({ length: Math.min(queued, limit.count) }, () => ({
              id: String(++polled),
              content: "Note",
            }));
            return batch;
          },
          acknowledge(receipts) {
            queued = 129 - new Set(receipts.map((r) => r.id)).size;
          },
        },
      },
    });
    expect(result.status).toBe("completed");
    expect(result.inputs).toHaveLength(INPUT_LIMITS.count);
    expect(queued).toBe(1);
    expect(polled).toBe(INPUT_LIMITS.count);
    expect(model.sent).toHaveLength(5);
  });

  it("routes to the active handoff owner, not delegated specialists, and appends once", async () => {
    const inbox = createMemoryInbox(runId);
    const childWire = wire([text("review")], () => {
      inbox.enqueue({ id: "late", content: "Private parent input" });
    });
    const child = defineAgent({ ...base, id: "reviewer", provider: childWire.provider });
    const targetWire = wire([
      [
        {
          type: "finish",
          finishReason: "tool_calls",
          toolCalls: [
            { index: 0, id: "specialist", name: "review", arguments: '{"input":"Review only"}' },
          ],
        },
      ],
      text("target answer"),
    ]);
    const target = defineAgent({
      ...base,
      id: "target",
      provider: targetWire.provider,
      tools: [child.asTool({ name: "review", description: "Review" })],
    });
    const sourceWire = wire([calls("transfer")], () => {
      inbox.enqueue({ id: "transfer", content: "Use billing context" });
    });
    const source = defineAgent({
      ...base,
      provider: sourceWire.provider,
      tools: [defineHandoff({ name: "transfer", description: "Transfer", to: target })],
    });
    inbox.enqueue({ id: "early", content: "Early input" });
    const poll = vi.fn(inbox.poll);
    const session = createMemorySession();
    const result = await source.run("First", {
      runId,
      session,
      host: { inbox: { ...inbox, poll } },
    });
    expect(result).toMatchObject({
      status: "completed",
      output: "target answer",
      activeAgent: { id: "target" },
    });
    expect(poll.mock.calls.map(([scope]) => scope.agent.id)).toEqual([
      "writer",
      "target",
      "target",
    ]);
    expect(childWire.sent[0] && userText(childWire.sent[0])).toEqual(["Review only"]);
    expect(userText(targetWire.sent[0]!)).toContain("Use billing context");
    expect(userText(targetWire.sent[0]!)).not.toContain("Private parent input");
    expect(userText(targetWire.sent[1]!)).toContain("Private parent input");
    expect(result.inputs.map((r) => r.id)).toEqual(["early", "transfer", "late"]);
    expect(result.inputs.every((r) => r.status === "consumed")).toBe(true);
    const users = result.newMessages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users).toEqual(["First", "Early input", "Use billing context", "Private parent input"]);
    const again = await source.resume(result.snapshot, {
      host: { authorizeResume, inbox },
      session,
    });
    expect(again.newMessages).toEqual(result.newMessages);
    expect((await session.load({ signal: signal() })).messages).toEqual(result.newMessages);
    expect(sourceWire.sent).toHaveLength(1);
    expect(targetWire.sent).toHaveLength(2);
  });

  it("does not give the root inbox to a handoff inside a delegated specialist", async () => {
    const inbox = createMemoryInbox(runId);
    const leafWire = wire([text("leaf")]);
    const leaf = defineAgent({ ...base, id: "leaf", provider: leafWire.provider });
    const middle = defineAgent({
      ...base,
      id: "middle",
      provider: wire([calls("transfer")]).provider,
      tools: [defineHandoff({ name: "transfer", description: "Transfer", to: leaf })],
    });
    const model = wire(
      [
        [
          {
            type: "finish",
            finishReason: "tool_calls",
            toolCalls: [{ index: 0, id: "c", name: "child", arguments: '{"input":"Task"}' }],
          },
        ],
        text(),
      ],
      () => {
        inbox.enqueue({ id: "private", content: "Root only" });
      },
    );
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      tools: [middle.asTool({ name: "child", description: "Delegate" })],
    });
    const poll = vi.fn(inbox.poll);
    const result = await agent.run("First", { runId, host: { inbox: { ...inbox, poll } } });
    expect(result.status).toBe("completed");
    expect(poll.mock.calls.every(([scope]) => scope.runId === runId)).toBe(true);
    expect(JSON.stringify(leafWire.sent)).not.toContain("Root only");
    expect(result.inputs[0]?.runId).toBe(runId);
  });

  it("normalizes media, loads references without saving their bytes and enforces cumulative inline limits", async () => {
    const inbox = createMemoryInbox(runId);
    inbox.enqueue({
      id: "image",
      content: [
        { type: "text", text: "" },
        { type: "media", id: "upload", mimeType: "image/png" },
      ],
    });
    const model = wire([text()]);
    const loadMedia = vi.fn(() => "YQ==");
    const agent = defineAgent({ ...base, provider: model.provider, limits: { inlineBytes: 0 } });
    const result = await agent.run("First", { runId, host: { inbox, loadMedia } });
    expect(result.status).toBe("completed");
    expect(userText(model.sent[0]!)[1]).toEqual([
      { type: "image", mimeType: "image/png", data: "YQ==" },
    ]);
    expect(JSON.stringify(result)).not.toContain("YQ==");
    expect(loadMedia).toHaveBeenCalledOnce();
    const inline = createMemoryInbox(runId);
    inline.enqueue({
      id: "second",
      content: [{ type: "image", mimeType: "image/png", data: "YQ==" }],
    });
    const limited = defineAgent({ ...base, provider: model.provider, limits: { inlineBytes: 1 } });
    const refused = await limited.run([{ type: "image", mimeType: "image/png", data: "YQ==" }], {
      runId,
      host: { inbox: inline },
    });
    expect(refused).toMatchObject({ status: "failed", error: { code: "input_media_limit" } });
    expect(refused.inputs).toEqual([]);
    expect(inline.list()[0]?.status).toBe("queued");
    expect(model.sent).toHaveLength(1);
  });

  it.each(["pending", "bytes"] as const)(
    "rejects a host exceeding the %s bound before accepting a partial batch",
    async (bound) => {
      const model = wire([text()]);
      const agent = defineAgent({ ...base, provider: model.provider });
      const acknowledge = vi.fn();
      const inbox: InputInbox = {
        acknowledge,
        poll: () =>
          bound === "pending"
            ? Array.from({ length: INPUT_LIMITS.pending + 1 }, (_, i) => ({
                id: String(i),
                content: "hi",
              }))
            : [{ id: "large", content: "x".repeat(INPUT_LIMITS.bytes) }],
      };
      const result = await agent.run("First", { runId, host: { inbox } });
      expect(result).toMatchObject({ status: "failed", error: { code: "invalid_inbox" } });
      expect(result.inputs).toEqual([]);
      expect(acknowledge).not.toHaveBeenCalled();
      expect(model.sent).toEqual([]);
    },
  );

  it.each(["deadline", "cancel", "budget"] as const)(
    "retains original %s limits and unconsumed input",
    async (bound) => {
      vi.useFakeTimers();
      const inbox = createMemoryInbox(runId);
      const controller = new AbortController();
      const model = wire([calls("read"), text()]);
      const agent = defineAgent({
        ...base,
        provider: model.provider,
        tools: [tool()],
        limits: { elapsedMs: 50 },
        treeLimits: { modelCalls: bound === "budget" ? 1 : 10 },
      });
      const result = await agent.run("First", {
        runId,
        signal: controller.signal,
        host: {
          inbox: {
            ...inbox,
            poll(request) {
              if (bound !== "budget") inbox.enqueue({ id: "note", content: "Late" });
              if (bound === "deadline") vi.advanceTimersByTime(51);
              if (bound === "cancel") controller.abort();
              return inbox.poll(request);
            },
          },
          beforeTool() {
            if (bound === "budget") inbox.enqueue({ id: "note", content: "Late" });
          },
        },
      });
      expect(result.status).toBe(bound === "cancel" ? "cancelled" : "limited");
      expect(inbox.list()[0]?.status).toBe("queued");
      expect(model.sent).toHaveLength(bound === "budget" ? 1 : 0);
    },
  );

  it("rejects changed positions, duplicate ids and erased journal entries", async () => {
    const inbox = createMemoryInbox(runId);
    inbox.enqueue({ id: "note", content: "Original" });
    const agent = defineAgent({ ...base, provider: wire([text()]).provider });
    const result = await agent.run("First", { runId, host: { inbox } });
    const position = saved(result.snapshot);
    position.inputs[0]!.beforeModel = 1;
    expect(() => agent[AGENT_RUNTIME].restore(position)).toThrow("whole non-final");
    const duplicate = saved(result.snapshot);
    duplicate.inputs.push({ ...duplicate.inputs[0]! });
    expect(() => agent[AGENT_RUNTIME].restore(duplicate)).toThrow("Duplicate input id");
    const erased = saved(result.snapshot);
    erased.inputs = [];
    expect(() => checkChildProgress(result.snapshot, erased)).toThrow("erased an input");
    const forged = saved(result.snapshot);
    forged.inputs.push({ id: "new", content: "Late edit", beforeModel: 0 });
    expect(() => checkChildProgress(result.snapshot, forged)).toThrow("admitted model");
  });
});
