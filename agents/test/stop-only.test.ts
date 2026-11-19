import { describe, expect, it, vi } from "vitest";
import {
  defineTool,
  type ChatMessage,
  type Provider,
  type ProviderChunk,
  type ToolSpec,
} from "@providerkit/core";
import {
  createMemoryInbox,
  defineAgent,
  RESULT_TOOL_NAME,
  type AgentEvent,
  type RunSnapshot,
} from "../src/index.ts";

const base = { id: "browser", version: "1", instructions: "Work the page, then call done." };
const usage = { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 };
const authorizeResume = () => {};
// TabRunner's nudge after a turn with no tool call, word for word: a question written as prose
// pauses nothing, so the person never gets to answer it.
const NUDGE =
  "Respond with a tool call, not plain text. If you just asked the user a question, call `ask_user` with that same question now. Written-out questions do not pause the run, so the user never got to answer. Otherwise make progress on the task: call snapshot if you need to see the page, or `done` if the task is complete.";
const ended = (name: string) =>
  `The run ended earlier this turn (\`${name}\`). This call did not run.`;

let ids = 0;
/** One model turn asking for these calls, in this order, after any text it writes. */
function turn(...calls: (string | [string, Record<string, unknown>])[]): ProviderChunk[] {
  return [
    {
      type: "delta",
      toolCalls: calls.map((call, index) => {
        const [name, args] = typeof call === "string" ? [call, {}] : call;
        ids += 1;
        return { index, id: `call-${ids}`, name, arguments: JSON.stringify(args) };
      }),
    },
    { type: "finish", finishReason: "tool_calls" },
    { type: "usage", usage },
  ];
}
const written = (content: string, chunks: ProviderChunk[]): ProviderChunk[] => [
  { type: "delta", content },
  ...chunks,
];
function text(content: string): ProviderChunk[] {
  return [
    { type: "delta", content },
    { type: "finish", finishReason: "stop" },
    { type: "usage", usage },
  ];
}
function wire(...turns: ProviderChunk[][]) {
  const requests: ChatMessage[][] = [];
  const provider: Provider = {
    id: "offline",
    model: "default",
    async *createStream(messages) {
      const chunks = turns[requests.length];
      requests.push(structuredClone(messages));
      if (!chunks) throw new Error("Unexpected model call");
      yield* chunks;
    },
  };
  return { provider, requests };
}
function tool(name: string, spec: Partial<Omit<ToolSpec<unknown, unknown>, "name">> = {}) {
  return defineTool({
    name,
    description: name,
    inputSchema: { type: "object" },
    run: async () => `${name} ok`,
    summarize: (value) => String(value),
    ...spec,
  });
}
/** TabRunner's `done`: its summary is the answer. */
const done = tool("done", {
  run: async (input) =>
    typeof input === "object" && input !== null && "summary" in input ? input.summary : "",
});
const config = {
  ...base,
  tools: [done, tool("snapshot"), tool("click")],
  stopAtTools: ["done"],
  stopOnlyAtTools: { nudge: NUDGE },
};
function kinds(snapshot: RunSnapshot, position = snapshot.models.length - 1) {
  const model = snapshot.models[position];
  if (model?.status !== "completed") throw new Error("Expected a completed turn");
  return model.tools.map((tool) =>
    tool.status !== "completed" ? tool.status : tool.result.ok ? "ok" : tool.result.kind,
  );
}

describe("stopOnlyAtTools", () => {
  it("answers a turn without a tool call with the nudge, and ends only on the stopping tool", async () => {
    const source = wire(
      text("I think the newsletter is archived."),
      turn(["done", { summary: "Archived the newsletter." }]),
    );
    const agent = defineAgent({ ...config, provider: source.provider });
    const outcome = await agent.run("Archive the newsletter");
    expect(outcome).toMatchObject({ status: "completed", output: "Archived the newsletter." });
    expect(source.requests[1]?.at(-2)).toMatchObject({
      role: "assistant",
      content: "I think the newsletter is archived.",
    });
    expect(source.requests[1]?.at(-1)).toEqual({ role: "user", content: NUDGE });
    // The nudge is part of the conversation the run returns, right after the turn it answers.
    expect(outcome.newMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
    ]);
    // A saved run may hold a text turn with later work after it, when the nudge answered it.
    await expect(
      agent.resume(JSON.parse(JSON.stringify(outcome.snapshot)), { host: { authorizeResume } }),
    ).resolves.toMatchObject({ status: "completed", output: "Archived the newsletter." });
  });

  it("does not run what a closing done was batched in front of", async () => {
    const look = vi.fn(async () => "Page with a button [ref=e1]");
    const click = vi.fn(async () => "clicked");
    const events: AgentEvent[] = [];
    const source = wire(
      turn("snapshot", ["done", { summary: "all set" }], ["click", { ref: "e1" }]),
    );
    const outcome = await defineAgent({
      ...config,
      provider: source.provider,
      tools: [done, tool("snapshot", { run: look }), tool("click", { run: click })],
    }).run("Wrap up", { onEvent: (event) => void events.push(event) });
    expect(outcome).toMatchObject({ status: "completed", output: "all set" });
    // The call before it ran; the one after it never did, and nobody is left to watch it.
    expect(look).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
    expect(source.requests).toHaveLength(1);
    expect(kinds(outcome.snapshot)).toEqual(["ok", "ok", "cancelled"]);
    expect(outcome.history.at(-1)).toMatchObject({ role: "tool", content: ended("done") });
    expect(
      events.flatMap((event) => (event.type === "tool_start" ? [event.request.call.name] : [])),
    ).toEqual(["snapshot", "done"]);
  });

  it("closes on the turn's text when done comes back with an empty summary", async () => {
    const source = wire(written("Tier 1: acmeapp, acmeco. Tier 2: useacme.", turn("done")));
    const outcome = await defineAgent({ ...config, provider: source.provider }).run(
      "Rank the domains",
    );
    expect(outcome).toMatchObject({
      status: "completed",
      output: "Tier 1: acmeapp, acmeco. Tier 2: useacme.",
    });
  });

  it("sends an empty done with no text back to the model instead of closing on nothing", async () => {
    const source = wire(turn("done"), turn(["done", { summary: "The answer." }]));
    const outcome = await defineAgent({ ...config, provider: source.provider }).run("Answer");
    expect(outcome).toMatchObject({ status: "completed", output: "The answer." });
    expect(source.requests[1]?.at(-1)?.content).toContain("The model returned no answer.");
  });

  it("keeps the turn limit a hard cap, and returns no nudge it never sent", async () => {
    const source = wire(text("One."), text("Two."));
    const outcome = await defineAgent({
      ...config,
      provider: source.provider,
      limits: { turns: 2 },
    }).run("Count");
    // No tool-free final call: it could not call done.
    expect(outcome).toMatchObject({ status: "limited", limit: "turns" });
    expect(source.requests).toHaveLength(2);
    expect(outcome.newMessages.at(-1)).toMatchObject({ role: "assistant", content: "Two." });
  });

  it("nudges a checked-output agent instead of failing it", async () => {
    const source = wire(text("The answer is 4."), turn([RESULT_TOOL_NAME, { answer: "4" }]));
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      output: {
        schema: { type: "object" },
        validate: (value) => {
          if (typeof value !== "object" || value === null || !("answer" in value))
            throw new Error("Send an answer.");
          return { answer: String(value.answer) };
        },
      },
      stopOnlyAtTools: { nudge: NUDGE },
    }).run("Add 2 and 2");
    expect(outcome).toMatchObject({ status: "completed", output: { answer: "4" } });
    expect(source.requests[1]?.at(-1)).toEqual({ role: "user", content: NUDGE });
  });

  it("lets a terminal tool share its turn, while submit_result still runs alone", async () => {
    const read = vi.fn(async () => "Record");
    const source = wire(turn("read", "finish"));
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [tool("read", { run: read }), tool("finish", { isTerminal: true })],
      stopOnlyAtTools: { nudge: NUDGE },
    }).run("Read, then finish");
    expect(outcome).toMatchObject({ status: "completed", output: "finish ok" });
    expect(read).toHaveBeenCalledOnce();

    const checked = wire(
      turn("read", [RESULT_TOOL_NAME, { answer: "4" }]),
      turn([RESULT_TOOL_NAME, { answer: "4" }]),
    );
    const result = await defineAgent({
      ...base,
      provider: checked.provider,
      tools: [tool("read")],
      output: { schema: { type: "object" }, validate: (value) => value },
      stopOnlyAtTools: { nudge: NUDGE },
    }).run("Read, then answer");
    expect(result.status).toBe("completed");
    expect(checked.requests[1]?.at(-1)?.content).toContain(`Call ${RESULT_TOOL_NAME} alone`);
  });

  it("restores a run saved after a nudged turn, and sends the same request again", async () => {
    let saved: RunSnapshot | undefined;
    const source = wire(text("Looking."), turn(["done", { summary: "Done." }]));
    const agent = defineAgent({ ...config, provider: source.provider });
    await agent.run("Look", {
      runId: "nudged-run",
      host: {
        checkpoint(node) {
          if (
            node.kind === "agent" &&
            node.models.length === 1 &&
            node.models[0]?.status === "completed"
          )
            saved ??= structuredClone(node);
        },
      },
    });
    if (!saved) throw new Error("Expected a checkpoint after the text turn");
    const again = wire(turn(["done", { summary: "Done." }]));
    const resumed = await defineAgent({ ...config, provider: again.provider }).resume(
      JSON.parse(JSON.stringify(saved)),
      { host: { authorizeResume } },
    );
    expect(resumed).toMatchObject({ status: "completed", output: "Done." });
    // Byte for byte, so the provider's cached prefix holds across the restart.
    expect(again.requests[0]).toEqual(source.requests[1]);
  });

  it("keeps the nudge and a steer that joins after it through a compaction", async () => {
    const runId = "steered-run";
    const steer = "Also check the spam folder.";
    const compaction = { identity: "trim-1", contextWindow: 1_000, keepTokens: 5 };
    /** A run the person writes to while its first turn streams. */
    function steered() {
      const inbox = createMemoryInbox(runId);
      const source = wire(text("Archived."), turn(["done", { summary: "Archived both." }]));
      const provider: Provider = {
        ...source.provider,
        async *createStream(messages, tools, options) {
          if (source.requests.length === 0) inbox.enqueue({ id: "note", content: steer });
          yield* source.provider.createStream(messages, tools, options);
        },
      };
      return { inbox, source, agent: defineAgent({ ...config, provider, compaction }) };
    }
    const first = steered();
    const outcome = await first.agent.run("Archive the newsletter", {
      runId,
      host: { inbox: first.inbox },
    });
    expect(outcome).toMatchObject({ status: "completed", output: "Archived both." });
    expect(outcome.snapshot.compactions).toHaveLength(1);
    // The cut drops older turns, never the nudge or the steer the next call must read.
    expect(first.source.requests[1]?.slice(-2)).toEqual([
      { role: "user", content: NUDGE },
      { role: "user", content: steer },
    ]);

    // The same run, with the worker lost right after the cut and before the next call. The cut
    // checks out against the request it was planned for, nudge included, and that request goes
    // out unchanged.
    const second = steered();
    let cut: RunSnapshot | undefined;
    await second.agent.run("Archive the newsletter", {
      runId,
      host: {
        inbox: second.inbox,
        checkpoint(node) {
          if (node.kind !== "agent" || node.compactions.length === 0) return;
          cut = structuredClone(node);
          throw new Error("Worker stopped");
        },
      },
    });
    if (!cut) throw new Error("Expected a checkpoint at the cut");
    const again = wire(turn(["done", { summary: "Archived both." }]));
    const resumed = await defineAgent({ ...config, provider: again.provider, compaction }).resume(
      JSON.parse(JSON.stringify(cut)),
      { host: { authorizeResume, inbox: second.inbox } },
    );
    expect(resumed).toMatchObject({ status: "completed", output: "Archived both." });
    expect(again.requests[0]).toEqual(first.source.requests[1]);
  });

  it("still fails a turn with no text and no tool call", async () => {
    const source = wire([
      { type: "finish", finishReason: "stop" },
      { type: "usage", usage },
    ]);
    const outcome = await defineAgent({ ...config, provider: source.provider }).run("Answer");
    expect(outcome).toMatchObject({ status: "failed", error: { code: "empty_output" } });
  });

  it("refuses the mode without a nudge or a tool that can end the run", () => {
    const { provider } = wire();
    expect(() =>
      defineAgent({
        ...base,
        provider,
        tools: [tool("read")],
        stopOnlyAtTools: { nudge: NUDGE },
      }),
    ).toThrow("a tool that can end the run");
    expect(() => defineAgent({ ...config, provider, stopOnlyAtTools: { nudge: " " } })).toThrow(
      "stopOnlyAtTools needs { nudge }",
    );
  });

  it("refuses a run that turns off every stopping tool, before any paid call", async () => {
    const source = wire(text("Here is the answer."));
    const agent = defineAgent({ ...config, provider: source.provider });
    // It could never end: every text turn gets the nudge, and done is never offered.
    await expect(agent.run("Look", { enabledTools: ["snapshot", "click"] })).rejects.toThrow(
      "this run disables every one",
    );
    await expect(agent.run("Look", { modelSettings: { toolChoice: "none" } })).rejects.toThrow(
      "this run disables every one",
    );
    expect(source.requests).toHaveLength(0);
  });
});
