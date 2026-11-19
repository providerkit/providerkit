import { describe, expect, it, vi } from "vitest";
import {
  defineTool,
  repairHistory,
  withWatchdog,
  type ChatMessage,
  type Provider,
  type ProviderChunk,
  type StreamOptions,
  type ToolDefinition,
  type ToolSpec,
} from "@providerkit/core";
import {
  createMemoryInbox,
  defineAgent,
  RESULT_TOOL_NAME,
  subagentTool,
  type AgentEvent,
  type RunSnapshot,
} from "../src/index.ts";

// The cases below are ported from three adopters' loop tests: an engine's finalization cases, a
// research loop's final step, and a browser loop's output-limit and mute-model guards.
const base = { id: "finisher", version: "1", instructions: "Answer from what you gather." };
const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 8 };
const authorizeResume = () => {};

const BUDGET_SPENT = "You have reached your step budget.";
const REPLY_CUT = "Your last reply hit the output limit and was cut off.";
const BUDGET_NOTE = `${BUDGET_SPENT} Write your best final answer now from what you have already gathered. Do not request any more tools.`;
const CUT_NOTE = `${REPLY_CUT} Write your final answer again, shorter, from what you have already gathered. Do not request any more tools.`;
const forcedNote = (why: string, tool: string = RESULT_TOOL_NAME) =>
  `${why} Call \`${tool}\` now with your best answer, based only on the evidence you have already gathered. No other tool will run.`;
const CUT_CALL = "The output limit cut this turn off. This call did not run.";

let ids = 0;
/** One turn calling these tools, in this order, each with JSON arguments. */
function calls(...list: (string | [string, unknown])[]): ProviderChunk[] {
  return [
    {
      type: "delta",
      toolCalls: list.map((call, index) => {
        const [name, args] = typeof call === "string" ? [call, {}] : call;
        ids += 1;
        return { index, id: `call-${ids}`, name, arguments: JSON.stringify(args) };
      }),
    },
    { type: "usage", usage },
    { type: "finish", finishReason: "tool_calls" },
  ];
}
/** One call whose argument text is exactly `args`, as a cut stream leaves it. */
function cutCall(
  name: string,
  args: string,
  finishReason: "length" | "tool_calls" = "length",
): ProviderChunk[] {
  ids += 1;
  return [
    { type: "delta", toolCalls: [{ index: 0, id: `call-${ids}`, name, arguments: args }] },
    { type: "usage", usage },
    { type: "finish", finishReason },
  ];
}
function text(content: string, finishReason: "stop" | "length" = "stop"): ProviderChunk[] {
  return [
    { type: "delta", content },
    { type: "usage", usage },
    { type: "finish", finishReason },
  ];
}
const written = (content: string, chunks: ProviderChunk[]): ProviderChunk[] => [
  { type: "delta", content },
  ...chunks,
];
/** A turn with no text and no tool call. */
const silent: ProviderChunk[] = [
  { type: "usage", usage },
  { type: "finish", finishReason: "stop" },
];

function wire(...turns: ProviderChunk[][]) {
  const requests: { messages: ChatMessage[]; tools: ToolDefinition[]; options: StreamOptions }[] =
    [];
  const provider: Provider = {
    id: "offline",
    model: "default",
    async *createStream(messages, tools, options = {}) {
      const chunks = turns[requests.length];
      requests.push({
        messages: structuredClone(messages),
        tools: structuredClone(tools),
        options,
      });
      if (!chunks) throw new Error("Unexpected model call");
      yield* chunks;
    },
  };
  return { provider, requests };
}
function lastRequest(source: ReturnType<typeof wire>) {
  const request = source.requests.at(-1);
  if (!request) throw new Error("Expected a model request");
  return request;
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
const read = tool("read_file", { isReadOnly: true });

/** A number and a label, as in the engine these cases come from. */
const scored = {
  schema: {
    type: "object" as const,
    properties: { value: { type: "number" }, label: { type: "string" } },
    required: ["value", "label"],
  },
  validate(value: unknown) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("value" in value) ||
      !("label" in value) ||
      typeof value.value !== "number" ||
      typeof value.label !== "string"
    )
      throw new Error("Send a number value and a string label.");
    return { value: value.value, label: value.label };
  },
};
/** A list that defaults to empty, so `{}` is a real, empty submission. */
const areas = {
  schema: {
    type: "object" as const,
    properties: { areas: { type: "array", items: { type: "string" } } },
  },
  validate(value: unknown) {
    if (typeof value !== "object" || value === null) throw new Error("Send an object.");
    const list = "areas" in value ? value.areas : [];
    if (!Array.isArray(list)) throw new Error("areas must be a list.");
    return { areas: list.map(String) };
  },
};

describe("finish turn at a limit", () => {
  it("submits a checked result when the turn limit is reached", async () => {
    const source = wire(
      calls(["read_file", { path: "a.ts" }]),
      calls(["read_file", { path: "b.ts" }]),
      calls([RESULT_TOOL_NAME, { value: 7, label: "salvaged" }]),
    );
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      output: scored,
      limits: { turns: 2 },
      finish: {},
    }).run("go");
    expect(outcome).toMatchObject({
      status: "completed",
      output: { value: 7, label: "salvaged" },
      salvaged: "turns",
    });
    const finish = lastRequest(source);
    expect(finish.options).toMatchObject({
      toolChoice: { name: RESULT_TOOL_NAME },
      effort: "none",
    });
    // The tool list stays as it was, and with it the provider's cached prefix.
    expect(finish.tools.map((definition) => definition.name)).toEqual([
      "read_file",
      RESULT_TOOL_NAME,
    ]);
    expect(finish.messages.at(-1)).toEqual({ role: "user", content: forcedNote(BUDGET_SPENT) });
    // The note goes with that call only: the conversation the run returns does not carry it.
    expect(
      outcome.newMessages.some(
        (message) => message.role === "user" && String(message.content).includes(BUDGET_SPENT),
      ),
    ).toBe(false);
    // It is a model call like any other: saved, counted and given a receipt.
    expect(outcome.snapshot.models).toHaveLength(3);
    expect(outcome.receipts.filter((receipt) => receipt.kind === "model")).toHaveLength(3);
  });

  it("runs it at the lowest effort, with the reasoning of earlier turns left out", async () => {
    const source = wire(
      [{ type: "delta", reasoning: "Let me look at the billing code." }, ...calls("read_file")],
      calls([RESULT_TOOL_NAME, { value: 7, label: "salvaged" }]),
    );
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      output: scored,
      modelSettings: { effort: "high" },
      limits: { turns: 1 },
      finish: {},
    }).run("go");
    expect(outcome).toMatchObject({ status: "completed", salvaged: "turns" });
    expect(source.requests[0]?.options.effort).toBe("high");
    const finish = lastRequest(source);
    expect(finish.options.effort).toBe("none");
    const assistants = finish.messages.filter((message) => message.role === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    for (const message of assistants) expect(message).not.toHaveProperty("reasoning");
    // The saved turn keeps its reasoning: only the finish turn's request leaves it out.
    expect(outcome.history.find((message) => message.role === "assistant")).toHaveProperty(
      "reasoning",
    );
  });

  it("takes an honest empty result as a submission", async () => {
    const source = wire(calls("read_file"), calls([RESULT_TOOL_NAME, {}]));
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      output: areas,
      limits: { turns: 1 },
      finish: {},
    }).run("go");
    expect(outcome).toMatchObject({
      status: "completed",
      output: { areas: [] },
      salvaged: "turns",
    });
  });

  it("ends as it would have when the finish turn's result does not parse", async () => {
    const source = wire(calls("read_file"), cutCall(RESULT_TOOL_NAME, "{ areas: [", "tool_calls"));
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      output: areas,
      limits: { turns: 1 },
      finish: {},
    }).run("go");
    expect(outcome).toMatchObject({ status: "limited", limit: "turns" });
    expect(source.requests).toHaveLength(2);
  });

  it("asks a text agent for its answer in text, with no tools", async () => {
    const source = wire(calls("read_file"), text("Here is what I found so far."));
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      limits: { turns: 1 },
      finish: {},
    }).run("go");
    expect(outcome).toMatchObject({
      status: "completed",
      output: "Here is what I found so far.",
      salvaged: "turns",
    });
    const finish = lastRequest(source);
    expect(finish.tools).toEqual([]);
    expect(finish.options.toolChoice).toBe("none");
    expect(finish.messages.at(-1)).toEqual({ role: "user", content: BUDGET_NOTE });
  });

  it("never runs a call the tool-free finish turn returns anyway", async () => {
    const draft = vi.fn(async () => "Draft created");
    const source = wire(calls("read_file"), calls("create_draft"));
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read, tool("create_draft", { run: draft })],
      limits: { turns: 1 },
      finish: {},
    }).run("go");
    expect(outcome).toMatchObject({ status: "limited", limit: "turns" });
    expect(draft).not.toHaveBeenCalled();
  });

  it("spends nothing on a run that was stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = wire(calls("read_file"));
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      output: scored,
      finish: {},
    }).run("go", { signal: controller.signal });
    expect(outcome.status).toBe("cancelled");
    expect(source.requests).toHaveLength(0);
  });

  it("answers the calls the tool-call budget cannot hold, then finishes", async () => {
    const run = vi.fn(async () => "contents");
    const source = wire(
      calls(
        ["read_file", { path: "a" }],
        ["read_file", { path: "b" }],
        ["read_file", { path: "c" }],
      ),
      text("Two of the three files."),
    );
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [tool("read_file", { run })],
      limits: { toolCalls: 2 },
      finish: {},
    }).run("go");
    expect(outcome).toMatchObject({
      status: "completed",
      output: "Two of the three files.",
      salvaged: "toolCalls",
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(outcome.history.filter((message) => message.role === "tool").at(-1)).toMatchObject({
      content: "The run reached its tool call limit. This call did not run.",
    });
    expect(lastRequest(source).messages.at(-1)).toEqual({ role: "user", content: BUDGET_NOTE });
  });

  it("makes one bounded call past the cost limit, priced and counted like any other", async () => {
    const source = wire(calls("read_file"), calls("read_file"), text("Best answer so far."));
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      limits: { costUsd: 0.5 },
      finish: {},
    }).run("go", { host: { priceModelCall: () => 0.4 } });
    // $0.40 left room for a second call, and $0.80 reached the limit: the third call is the
    // finish turn, and nothing comes after it.
    expect(outcome).toMatchObject({
      status: "completed",
      output: "Best answer so far.",
      salvaged: "costUsd",
    });
    expect(source.requests).toHaveLength(3);
    expect(
      outcome.receipts.flatMap((receipt) => (receipt.kind === "model" ? [receipt.costUsd] : [])),
    ).toEqual([0.4, 0.4, 0.4]);
    expect(lastRequest(source).tools).toEqual([]);
  });

  it("gives a helper no finish turn past its creator's budget", async () => {
    const helper = wire(calls("read_file"), text("Never sent"));
    const worker = defineAgent({
      ...base,
      id: "worker",
      provider: helper.provider,
      tools: [read],
      finish: {},
    });
    const source = wire(
      calls([
        "create_helpers",
        { agents: [{ name: "helper", task: "Compare the excerpts.", tools: ["read_file"] }] },
      ]),
      text("Combined from what the helper found."),
    );
    const lead = defineAgent({
      ...base,
      id: "lead",
      provider: source.provider,
      tools: [
        read,
        subagentTool({ name: "create_helpers", description: "Create.", agent: worker }),
      ],
      limits: { costUsd: 0.5 },
      finish: {},
    });
    const outcome = await lead.run("Compare", {
      host: {
        priceModelCall: () => 0.4,
        beforeTool: () => {},
        prepareRequest: () => ({
          scope: {
            actorId: "owner",
            resource: { id: "record", version: "1" },
            expiresAt: Date.now() + 60_000,
          },
        }),
        resolveRequest: () => ({ type: "approve" as const }),
      },
    });
    // The helper stopped at its creator's limit. Only the lead, whose own limit it was, got the
    // one call past it, so the tree went over by that one call.
    expect(outcome).toMatchObject({
      status: "completed",
      output: "Combined from what the helper found.",
      salvaged: "costUsd",
    });
    expect(helper.requests).toHaveLength(1);
    expect(source.requests).toHaveLength(2);
  });
});

describe("finish turn after an unfinished answer", () => {
  it("asks once for the result a checked agent wrote as text", async () => {
    const source = wire(
      calls("read_file"),
      text("I believe this is the billing area."),
      calls([RESULT_TOOL_NAME, { value: 9, label: "from-stop" }]),
    );
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      output: scored,
      limits: { turns: 5 },
      finish: {},
    }).run("go");
    expect(outcome).toMatchObject({
      status: "completed",
      output: { value: 9, label: "from-stop" },
      salvaged: "missing_result",
    });
    const finish = lastRequest(source);
    expect(finish.options.toolChoice).toEqual({ name: RESULT_TOOL_NAME });
    expect(finish.messages.at(-1)).toEqual({
      role: "user",
      content: forcedNote(`You answered without calling \`${RESULT_TOOL_NAME}\`.`),
    });
  });

  it("leaves a text agent's answer alone", async () => {
    const source = wire(text("Here is my answer."));
    const outcome = await defineAgent({ ...base, provider: source.provider, finish: {} }).run("go");
    expect(outcome).toMatchObject({ status: "completed", output: "Here is my answer." });
    expect(outcome).not.toHaveProperty("salvaged");
    expect(source.requests).toHaveLength(1);
  });

  it("rewrites an answer the output limit cut, reading the cut text", async () => {
    const events: AgentEvent[] = [];
    const source = wire(
      text("The billing area covers invoices and the", "length"),
      text("Billing covers invoices and refunds."),
    );
    const outcome = await defineAgent({ ...base, provider: source.provider, finish: {} }).run(
      "Explain billing",
      { onEvent: (event) => void events.push(event) },
    );
    expect(outcome).toMatchObject({
      status: "completed",
      output: "Billing covers invoices and refunds.",
      salvaged: "outputTokens",
    });
    const finish = lastRequest(source);
    expect(finish.tools).toEqual([]);
    expect(finish.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: "The billing area covers invoices and the",
      }),
    );
    expect(finish.messages.at(-1)).toEqual({ role: "user", content: CUT_NOTE });
    // The rewrite streams as its own model call, so a reader can start it on a new line.
    const streamed = events.flatMap((event) =>
      event.type === "model_chunk" && event.chunk.content ? [event.operationId] : [],
    );
    expect(new Set(streamed).size).toBe(2);
  });

  it("ends limited when the rewrite is cut too", async () => {
    const cut = text("Billing covers invoices and", "length");
    const source = wire(cut, cut);
    const outcome = await defineAgent({ ...base, provider: source.provider, finish: {} }).run("go");
    expect(outcome).toMatchObject({ status: "limited", limit: "outputTokens" });
    expect(source.requests).toHaveLength(2);
  });

  it("finishes a turn the cap cut while the model was still thinking", async () => {
    const source = wire(
      [
        { type: "delta", reasoning: "Let me weigh every area before I" },
        { type: "finish", finishReason: "length" },
      ],
      cutCall(RESULT_TOOL_NAME, '{"value":1'),
    );
    // Core's watchdog, as production wraps a model: it throws `invalid` on the first turn, since
    // the cap ran out before any answer. That must still reach the finish turn.
    const outcome = await defineAgent({
      ...base,
      provider: withWatchdog(source.provider),
      tools: [read],
      output: scored,
      finish: {},
    }).run("go");
    expect(outcome).toMatchObject({ status: "limited", limit: "outputTokens" });
    expect(source.requests).toHaveLength(2);
    const finish = lastRequest(source);
    expect(finish.options).toMatchObject({
      toolChoice: { name: RESULT_TOOL_NAME },
      effort: "none",
    });
    expect(finish.messages.at(-1)).toEqual({ role: "user", content: forcedNote(REPLY_CUT) });
  });

  it("never runs a submission the output limit cut", async () => {
    const events: AgentEvent[] = [];
    const source = wire(
      cutCall(RESULT_TOOL_NAME, '{"areas":["billing","sign'),
      calls([RESULT_TOOL_NAME, { areas: ["billing", "sign-in"] }]),
    );
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      output: areas,
      finish: {},
    }).run("go", { onEvent: (event) => void events.push(event) });
    expect(outcome).toMatchObject({
      status: "completed",
      output: { areas: ["billing", "sign-in"] },
      salvaged: "outputTokens",
    });
    // The cut call never ran: the only submission that did is the finish turn's.
    expect(
      events.flatMap((event) => (event.type === "tool_start" ? [event.request.arguments] : [])),
    ).toEqual([{ areas: ["billing", "sign-in"] }]);
    expect(outcome.history).toContainEqual(
      expect.objectContaining({ role: "tool", content: CUT_CALL }),
    );
    expect(lastRequest(source).messages.at(-1)).toEqual({
      role: "user",
      content: forcedNote(REPLY_CUT),
    });
  });

  it.each([
    ["arguments cut before they began", "", "length"],
    ["a cut the provider did not report", '{"areas":[', "tool_calls"],
  ] as const)("does not take a cut call as a call: %s", async (_label, args, finishReason) => {
    const cut = cutCall(RESULT_TOOL_NAME, args, finishReason);
    const source = wire(cut, cut);
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      output: areas,
      finish: {},
    }).run("go");
    expect(outcome).toMatchObject({ status: "limited", limit: "outputTokens" });
    expect(source.requests).toHaveLength(2);
  });

  it("sends the run's maxTokens on every call, the finish turn's too", async () => {
    const source = wire(calls("read_file"), calls([RESULT_TOOL_NAME, { value: 1, label: "x" }]));
    await defineAgent({
      ...base,
      provider: source.provider,
      tools: [read],
      output: scored,
      modelSettings: { maxTokens: 24_000 },
      limits: { turns: 1 },
      finish: {},
    }).run("go");
    expect(source.requests).toHaveLength(2);
    for (const request of source.requests) expect(request.options.maxTokens).toBe(24_000);
  });
});

const NUDGE = "Respond with a tool call, not plain text. Call done when finished.";
/** A browser loop's `done`: its summary is the answer. */
const done = tool("done", {
  run: async (input) =>
    typeof input === "object" && input !== null && "summary" in input ? input.summary : "",
});
const browser = {
  ...base,
  tools: [done, tool("snapshot")],
  stopAtTools: ["done"],
  stopOnlyAtTools: { nudge: NUDGE },
};

describe("finish turn of an agent that ends only on a stopping tool", () => {
  it("runs only the stopping call on the last turn", async () => {
    const save = vi.fn(async () => "Brief saved.");
    const search = vi.fn(async () => "Results");
    const source = wire(
      calls("web_search"),
      calls("fetch_url"),
      calls("record_finding"),
      calls("web_search", "save_brief"),
    );
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [
        tool("web_search", { run: search }),
        tool("fetch_url"),
        tool("record_finding"),
        tool("save_brief", { run: save }),
      ],
      stopAtTools: ["save_brief"],
      stopOnlyAtTools: { nudge: "Respond with a tool call. Call save_brief when finished." },
      limits: { turns: 3 },
      finish: {},
    }).run("Research the topic");
    expect(outcome).toMatchObject({
      status: "completed",
      output: "Brief saved.",
      salvaged: "turns",
    });
    expect(source.requests.map((request) => request.options.toolChoice)).toEqual([
      undefined,
      undefined,
      undefined,
      { name: "save_brief" },
    ]);
    // A model that cannot be forced to a tool is told in words, on this call only.
    expect(lastRequest(source).messages.at(-1)).toEqual({
      role: "user",
      content: forcedNote(BUDGET_SPENT, "save_brief"),
    });
    expect(
      outcome.newMessages.some(
        (message) => message.role === "user" && String(message.content).includes(BUDGET_SPENT),
      ),
    ).toBe(false);
    // The search the model added beside the save never ran.
    expect(search).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledOnce();
    expect(outcome.history.filter((message) => message.role === "tool").slice(-2)).toEqual([
      expect.objectContaining({
        name: "web_search",
        content: "Only `save_brief` runs on the run's last turn. This call did not run.",
      }),
      expect.objectContaining({ name: "save_brief", content: "Brief saved." }),
    ]);
  });

  it("asks once more when done arrived empty on a cut turn, instead of closing hollow", async () => {
    const source = wire(
      cutCall("done", "{}"),
      written("The answer, restated short.", calls("done")),
    );
    const outcome = await defineAgent({ ...browser, provider: source.provider, finish: {} }).run(
      "Rank the domains",
    );
    expect(outcome).toMatchObject({
      status: "completed",
      output: "The answer, restated short.",
      salvaged: "outputTokens",
    });
    expect(source.requests).toHaveLength(2);
    expect(lastRequest(source).options.toolChoice).toEqual({ name: "done" });
  });

  it("never loops: a model that keeps getting cut still ends", async () => {
    const source = wire(cutCall("done", "{}"), cutCall("done", "{}"));
    const outcome = await defineAgent({ ...browser, provider: source.provider, finish: {} }).run(
      "Rank the domains",
    );
    expect(outcome).toMatchObject({ status: "limited", limit: "outputTokens" });
    expect(source.requests).toHaveLength(2);
  });

  it("reads the cut turn's text when its done was cut, and asks for done again", async () => {
    // The browser loop closes on that text at once. A cut call never runs here, so the finish
    // turn asks for done with the answer the model already wrote.
    const answer = "Tier 1: acmeapp, acmeco. Tier 2: useacme.";
    const source = wire(
      written(answer, cutCall("done", '{"summ')),
      calls(["done", { summary: answer }]),
    );
    const outcome = await defineAgent({ ...browser, provider: source.provider, finish: {} }).run(
      "Rank the domains",
    );
    expect(outcome).toMatchObject({ status: "completed", output: answer });
    expect(lastRequest(source).messages).toContainEqual(
      expect.objectContaining({ role: "assistant", content: answer }),
    );
  });

  it("offers a way out one turn before the limit, and keeps the note after it", async () => {
    const NEAR =
      "You are near the end of your working budget. Call done now with your best summary, or ask whether to continue.";
    const finished = wire(
      calls("snapshot"),
      calls("snapshot"),
      calls(["done", { summary: "Filled 12 of 20 fields." }]),
    );
    const agent = { ...browser, limits: { turns: 3 }, finish: { nearEnd: NEAR } };
    const outcome = await defineAgent({ ...agent, provider: finished.provider }).run("Fill it");
    expect(outcome).toMatchObject({ status: "completed", output: "Filled 12 of 20 fields." });
    expect(outcome).not.toHaveProperty("salvaged");
    expect(finished.requests.map((request) => request.messages.at(-1)?.content)).toEqual([
      "Fill it",
      "snapshot ok",
      NEAR,
    ]);

    // A model that ignores both notes still ends at the hard cap.
    const ignored = wire(
      calls("snapshot"),
      calls("snapshot"),
      calls("snapshot"),
      calls("snapshot"),
    );
    const limited = await defineAgent({ ...agent, provider: ignored.provider }).run("Fill it");
    expect(limited).toMatchObject({ status: "limited", limit: "turns" });
    const finish = lastRequest(ignored);
    // The note stays where it was read, so the cached prefix holds.
    expect(finish.messages.filter((message) => message.content === NEAR)).toHaveLength(1);
    expect(finish.messages.at(-1)).toEqual({
      role: "user",
      content: forcedNote(BUDGET_SPENT, "done"),
    });
  });
});

describe("empty turns", () => {
  it("ends the run after the allowed empty turns, with the nudge after each", async () => {
    const source = wire(silent, silent, silent);
    const outcome = await defineAgent({
      ...browser,
      provider: source.provider,
      finish: { emptyTurns: 2 },
    }).run("Say hello");
    // Three silent turns, not a whole budget of billed ones.
    expect(outcome).toMatchObject({ status: "failed", error: { code: "empty_output" } });
    expect(source.requests).toHaveLength(3);
    expect(source.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: NUDGE });
  });

  it("counts them in a row: a turn with output starts again", async () => {
    const source = wire(
      silent,
      silent,
      text("still here"),
      silent,
      silent,
      calls(["done", { summary: "ok" }]),
    );
    const outcome = await defineAgent({
      ...browser,
      provider: source.provider,
      finish: { emptyTurns: 2 },
    }).run("Say hello");
    expect(outcome).toMatchObject({ status: "completed", output: "ok" });
    expect(source.requests).toHaveLength(6);
  });

  it("sends the same request again after an empty turn, without a nudge", async () => {
    const source = wire(silent, text("Answer"));
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      finish: { emptyTurns: 1 },
    }).run("Answer me");
    expect(outcome).toMatchObject({ status: "completed", output: "Answer" });
    // Core's history repair drops the empty turn on every adapter.
    const [first, second] = source.requests;
    expect(repairHistory(second?.messages ?? []).messages).toEqual(first?.messages);
  });
});

describe("finish policy journal", () => {
  it("restores a run saved after a steer joined, before its finish turn was sent", async () => {
    const runId = "steered-cut";
    const steer = "Mention refunds too.";
    /** A run the person writes to while its first turn streams, and the output limit cuts. */
    function steered() {
      const inbox = createMemoryInbox(runId);
      const source = wire(
        text("The billing area covers invoices and the", "length"),
        text("Billing covers invoices and refunds."),
      );
      const provider: Provider = {
        ...source.provider,
        async *createStream(messages, tools, options) {
          if (source.requests.length === 0) inbox.enqueue({ id: "note", content: steer });
          yield* source.provider.createStream(messages, tools, options);
        },
      };
      return { inbox, source, agent: defineAgent({ ...base, provider, finish: {} }) };
    }
    const first = steered();
    const outcome = await first.agent.run("Explain billing", {
      runId,
      host: { inbox: first.inbox },
    });
    expect(outcome).toMatchObject({ status: "completed", salvaged: "outputTokens" });

    // The same run, with the worker lost once the steer was saved and before the finish turn.
    const second = steered();
    let saved: RunSnapshot | undefined;
    await second.agent.run("Explain billing", {
      runId,
      host: {
        inbox: second.inbox,
        checkpoint(node) {
          if (node.kind !== "agent" || node.inputs.length === 0 || node.models.length !== 1) return;
          saved = structuredClone(node);
          throw new Error("Worker stopped");
        },
      },
    });
    if (!saved) throw new Error("Expected a checkpoint with the steer and no finish turn");
    const again = wire(text("Billing covers invoices and refunds."));
    const resumed = await defineAgent({ ...base, provider: again.provider, finish: {} }).resume(
      JSON.parse(JSON.stringify(saved)),
      { host: { authorizeResume, inbox: second.inbox } },
    );
    expect(resumed).toMatchObject({ status: "completed", salvaged: "outputTokens" });
    // The finish turn reads the steer, then its note, and sends what the first run sent.
    expect(again.requests[0]?.messages.slice(-2)).toEqual([
      { role: "user", content: steer },
      { role: "user", content: CUT_NOTE },
    ]);
    expect(again.requests[0]?.messages).toEqual(first.source.requests[1]?.messages);
  });
  it("restores a run saved before its finish turn and sends the same request", async () => {
    let saved: RunSnapshot | undefined;
    const source = wire(
      text("The billing area covers invoices and the", "length"),
      text("Billing covers invoices and refunds."),
    );
    const agent = defineAgent({ ...base, provider: source.provider, finish: {} });
    await agent.run("Explain billing", {
      runId: "cut-run",
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
    if (!saved) throw new Error("Expected a checkpoint after the cut turn");
    const again = wire(text("Billing covers invoices and refunds."));
    const resumed = await defineAgent({ ...base, provider: again.provider, finish: {} }).resume(
      JSON.parse(JSON.stringify(saved)),
      { host: { authorizeResume } },
    );
    expect(resumed).toMatchObject({ status: "completed", salvaged: "outputTokens" });
    expect(again.requests[0]?.messages).toEqual(source.requests[1]?.messages);
  });

  it("refuses a finish turn its journal does not explain", async () => {
    const source = wire(calls("read_file"), text("Here is what I found."));
    const config = { ...base, provider: source.provider, tools: [read], limits: { turns: 1 } };
    const agent = defineAgent({ ...config, finish: {} });
    const outcome = await agent.run("Read");
    expect(outcome).toMatchObject({ status: "completed", salvaged: "turns" });
    await expect(
      agent.resume(structuredClone(outcome.snapshot), { host: { authorizeResume } }),
    ).resolves.toMatchObject({ status: "completed", salvaged: "turns" });
    function edited(change: (snapshot: RunSnapshot) => void): RunSnapshot {
      const copy = structuredClone(outcome.snapshot);
      change(copy);
      return copy;
    }
    for (const forged of [
      edited((snapshot) => {
        const first = snapshot.models[0];
        if (first) first.finish = "turns";
      }),
      edited((snapshot) => {
        const last = snapshot.models[1];
        if (last) last.finish = "missing_result";
      }),
    ])
      await expect(agent.resume(forged, { host: { authorizeResume } })).rejects.toThrow(
        "A finish turn must be the run's last call",
      );
    await expect(
      defineAgent(config).resume(structuredClone(outcome.snapshot), { host: { authorizeResume } }),
    ).rejects.toThrow("The recorded tool behavior does not match this agent version.");
  });

  it("changes nothing without a finish policy", async () => {
    const cut = wire(text("The billing area covers", "length"));
    await expect(defineAgent({ ...base, provider: cut.provider }).run("go")).resolves.toMatchObject(
      { status: "limited", limit: "outputTokens" },
    );
    const prose = wire(text("The answer is 9."));
    await expect(
      defineAgent({ ...base, provider: prose.provider, output: scored }).run("go"),
    ).resolves.toMatchObject({ status: "failed", error: { code: "missing_result" } });
    const capped = wire(calls("read_file"));
    await expect(
      defineAgent({
        ...base,
        provider: capped.provider,
        tools: [read],
        output: scored,
        limits: { turns: 1 },
      }).run("go"),
    ).resolves.toMatchObject({ status: "limited", limit: "turns" });
    expect([cut, prose, capped].map((source) => source.requests.length)).toEqual([1, 1, 1]);
  });

  it("refuses a finish policy it cannot read", () => {
    const { provider } = wire();
    const extra = { emptyTurns: 1, salvage: true };
    for (const finish of [{ emptyTurns: -1 }, { emptyTurns: 1.5 }, { nearEnd: " " }, extra])
      expect(() => defineAgent({ ...base, provider, finish })).toThrow("finish takes emptyTurns");
  });
});
