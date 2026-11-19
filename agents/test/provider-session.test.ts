import { describe, expect, it, vi } from "vitest";
import {
  defineTool,
  type Provider,
  type ProviderChunk,
  type StreamOptions,
} from "@providerkit/core";
import { defineAgent } from "../src/index.ts";
import { defineWorkflow } from "../src/workflow.ts";
import { isRecord } from "../src/snapshot.ts";

const base = { version: "1", instructions: "Host instructions." };
const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 };

function call(name: string, args: Record<string, unknown> = {}): ProviderChunk[] {
  return [
    {
      type: "delta",
      toolCalls: [{ index: 0, id: `call-${name}`, name, arguments: JSON.stringify(args) }],
    },
    { type: "usage", usage },
    { type: "finish", finishReason: "tool_calls" },
  ];
}
function text(content = "Done"): ProviderChunk[] {
  return [
    { type: "delta", content },
    { type: "usage", usage },
    { type: "finish", finishReason: "stop" },
  ];
}
/** Answers in order and keeps the session id each call named. */
function wire(...turns: ProviderChunk[][]) {
  const sessions: (string | undefined)[] = [];
  const provider: Provider = {
    id: "offline",
    model: "default",
    async *createStream(_messages, _tools, options: StreamOptions = {}) {
      const turn = turns[sessions.length];
      sessions.push(options.sessionId);
      if (!turn) throw new Error("Unexpected model call");
      yield* turn;
    },
  };
  return { provider, sessions };
}
const read = defineTool({
  name: "read",
  description: "Read the record.",
  inputSchema: { type: "object" },
  isReadOnly: true,
  run: async () => "Record",
});
const send = defineTool({
  name: "send",
  description: "Send the message.",
  inputSchema: { type: "object" },
  needsApproval: true,
  run: async () => "Sent",
});
const host = {
  authorizeResume: vi.fn(),
  beforeTool: vi.fn(),
  prepareRequest: () => ({
    scope: {
      actorId: "owner",
      resource: { id: "record", version: "1" },
      expiresAt: Date.now() + 60_000,
    },
  }),
  resolveRequest: () => ({ type: "approve" as const }),
};

describe("provider session", () => {
  it("sends the run id by default, and the named session on every turn", async () => {
    const plain = wire(call("read"), text());
    const agent = defineAgent({ ...base, id: "reader", provider: plain.provider, tools: [read] });
    const first = await agent.run("Read it");
    expect(plain.sessions).toEqual([first.runId, first.runId]);
    expect(first.snapshot.definition).not.toHaveProperty("providerSessionId");

    const named = wire(call("read"), text());
    const chat = defineAgent({ ...base, id: "reader", provider: named.provider, tools: [read] });
    // Two turns of one conversation are two runs. With the conversation's id, both reach the
    // provider as one session, so a gateway that caches by it serves the history from cache.
    const turn = await chat.run("Read it", { providerSessionId: "conversation-1" });
    expect(turn.status).toBe("completed");
    expect(named.sessions).toEqual(["conversation-1", "conversation-1"]);
    expect(turn.snapshot.definition.providerSessionId).toBe("conversation-1");
  });

  it("keeps the recorded session across a resume, and refuses a new one there", async () => {
    const source = wire(call("send"), text("Sent it"));
    const agent = defineAgent({ ...base, id: "sender", provider: source.provider, tools: [send] });
    const waiting = await agent.run("Send it", {
      providerSessionId: "conversation-1",
      host,
    });
    const request = waiting.status === "suspended" ? waiting.requests[0] : undefined;
    if (!request) throw new Error("Expected an approval request");
    await expect(
      Reflect.apply(agent.resume, agent, [
        waiting.snapshot,
        { host, providerSessionId: "conversation-2" },
      ]),
    ).rejects.toThrow("providerSessionId");
    const done = await agent.resume(waiting.snapshot, {
      host,
      answers: { [request.id]: "evidence" },
    });
    expect(done).toMatchObject({ status: "completed", output: "Sent it" });
    expect(source.sessions).toEqual(["conversation-1", "conversation-1"]);
  });

  it("gives a specialist its own run id, not the parent's session", async () => {
    const childWire = wire(text("Child answer"));
    const child = defineAgent({ ...base, id: "child", provider: childWire.provider });
    const parentWire = wire(call("review", { input: "Review" }), text("Parent answer"));
    const parent = defineAgent({
      ...base,
      id: "parent",
      provider: parentWire.provider,
      tools: [child.asTool({ name: "review", description: "Review." })],
    });
    const done = await parent.run("Review", { providerSessionId: "conversation-1" });
    expect(done).toMatchObject({ status: "completed", output: "Parent answer" });
    const node = done.snapshot.delegations[0]?.children[0]?.snapshot;
    expect(node?.kind).toBe("agent");
    expect(childWire.sessions).toEqual([node?.runId]);
    expect(parentWire.sessions).toEqual(["conversation-1", "conversation-1"]);
  });

  it("refuses an empty id, and a workflow that names one, before any call", async () => {
    const source = wire(text());
    const agent = defineAgent({ ...base, id: "writer", provider: source.provider });
    await expect(agent.run("Write", { providerSessionId: "" })).rejects.toThrow(
      "providerSessionId",
    );
    const flow = defineWorkflow({
      id: "report",
      version: "1",
      input: {
        schema: { type: "object" as const },
        validate(value: unknown) {
          if (!isRecord(value)) throw new TypeError("Pass an object.");
          return value;
        },
      },
      agents: [agent],
      async run(_, ctx) {
        return ctx.agent("writer", agent, "Write");
      },
    });
    // Its type leaves the option out, and its agents would drop it, so a JavaScript caller who
    // passes one is told rather than ignored. No agent option can set it, so the error says what
    // an agent step does instead of sending the caller to look for one.
    await expect(
      Reflect.apply(flow.run, flow, [{}, { providerSessionId: "conversation-1" }]),
    ).rejects.toThrow("uses its own run id as its provider session");
    expect(source.sessions).toEqual([]);
  });
});
