import { describe, expect, it, vi } from "vitest";
import {
  defineTool,
  type ChatMessage,
  type Provider,
  type ProviderChunk,
  type ToolSpec,
} from "@providerkit/core";
import {
  defineAgent,
  questionTool,
  type AgentEvent,
  type AgentHost,
  type CallVerdict,
  type EarlierCall,
  type RunSnapshot,
  type ScreenContext,
  type ToolRequest,
} from "../src/index.ts";
import { codeMode } from "../src/code.ts";
import { createQuickJsDriver } from "../src/quickjs.ts";
import { evidenceFor } from "./fixtures/requests.ts";

const base = { id: "browser", version: "1", instructions: "Work the page, then answer." };
const usage = { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 };

// TabRunner's model-facing texts, word for word: its loop tests pin them, and a port that
// rewords them changes what the model reads.
const PLAN_GATE =
  "Blocked: no plan has been posted yet. Call the plan tool with your intended steps first. No page action runs before that, and the user may have to approve the plan.";
const cancelledAfterFailure = (name: string) =>
  `Earlier action \`${name}\` in this turn failed. Its error is in that call's result. This call did not run. Re-observe the page before retrying.`;
const CANCELLED_PAGE_CHANGED =
  "The page moved after an earlier action this turn, so the refs you wrote this call with may no longer mean what they did. This call and the rest of the turn did not run. Call snapshot for fresh refs and continue from there.";
const CANCELLED_RUN_PAUSED =
  "The run paused earlier this turn on `ask_user`. This call did not run.";
// A private adopter's refusal for a tool past its allowance, word for word, at one a request.
const limitRefusal = (name: string) =>
  `${name} is limited to 1 for this request, and that is spent. Work from what you have, and say what you found and what you could not check`;

let ids = 0;
/** One model turn asking for these calls, in this order, each with its own id. */
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
function text(content = "Done"): ProviderChunk[] {
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
const fails = (message: string) => async () => {
  throw new Error(message);
};

/** The results a request sends for the model's last turn. Each call it made has exactly one. */
function lastResults(messages: ChatMessage[] | undefined) {
  if (!messages) throw new Error("Expected a model request");
  const start = messages.findLastIndex((message) => message.role === "assistant");
  const assistant = messages[start];
  const results = messages
    .slice(start + 1)
    .flatMap((message) => (message.role === "tool" ? [message] : []));
  expect(results.map((result) => result.toolCallId)).toEqual(
    assistant?.role === "assistant" ? assistant.toolCalls?.map((call) => call.id) : [],
  );
  return results.map((result) => ({ name: result.name, content: result.content }));
}
function kinds(snapshot: RunSnapshot, position = snapshot.models.length - 1) {
  const model = snapshot.models[position];
  if (model?.status !== "completed") throw new Error("Expected a completed turn");
  return model.tools.map((tool) =>
    tool.status !== "completed" ? tool.status : tool.result.ok ? "ok" : tool.result.kind,
  );
}
const started = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === "tool_start" ? [event.request.call.name] : []));

const ACTIONS = new Set(["click", "navigate"]);
/** TabRunner's batch rules as the host's screen: no page action before a plan, and a failed
 * action, an answered question or a page that moved ends what the turn wrote after it. */
function tabRunner(pageMoved: () => Promise<boolean> = async () => false) {
  return async (
    call: ToolRequest,
    { turn, earlier }: ScreenContext,
  ): Promise<CallVerdict | undefined> => {
    const thisTurn = earlier.filter((entry) => entry.turn === turn);
    // A refusal is not a failure: the gate bounces one call and leaves the rest of the batch.
    const failed = thisTurn.find(
      (entry) =>
        ACTIONS.has(entry.name) &&
        entry.result &&
        !entry.result.ok &&
        entry.result.kind !== "refused",
    );
    if (failed) return { cancel: cancelledAfterFailure(failed.name) };
    if (thisTurn.some((entry) => entry.name === "ask_user" && entry.result?.ok))
      return { cancel: CANCELLED_RUN_PAUSED };
    if (!ACTIONS.has(call.call.name)) return undefined;
    if (!earlier.some((entry) => entry.name === "plan" && entry.result?.ok))
      return { refuse: PLAN_GATE };
    const acted = thisTurn.some((entry) => ACTIONS.has(entry.name) && entry.result?.ok);
    if (acted && (await pageMoved())) return { cancel: CANCELLED_PAGE_CHANGED };
    return undefined;
  };
}

/** That adopter's allowances: `limit` searches a request, counted from the calls that ran. */
function allowance(limit: number) {
  const ran = (entry: EarlierCall) =>
    entry.result?.kind !== "refused" && entry.result?.kind !== "cancelled";
  return (call: ToolRequest, { earlier }: ScreenContext): CallVerdict | undefined =>
    call.call.name === "search" &&
    earlier.filter((entry) => entry.name === "search" && ran(entry)).length >= limit
      ? { refuse: limitRefusal("search") }
      : undefined;
}

const approval = {
  prepareRequest: () => ({
    scope: {
      actorId: "person",
      resource: { id: "page", version: "1" },
      expiresAt: Date.now() + 60_000,
    },
  }),
  beforeTool: () => {},
  resolveRequest: () => ({ type: "approve" }) as const,
  authorizeResume: () => {},
} satisfies AgentHost;

describe("host.screenCall", () => {
  it("answers a refused call with the host's text, and the rest of the turn still runs", async () => {
    const click = vi.fn(async () => "clicked");
    const source = wire(turn(["click", { ref: "e1" }], "snapshot"), text());
    const events: AgentEvent[] = [];
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [
        tool("click", { run: click }),
        tool("snapshot", { run: async () => "Page with a button [ref=e1]" }),
        tool("plan"),
      ],
    }).run("Click it", {
      host: { screenCall: tabRunner() },
      onEvent: (event) => void events.push(event),
    });
    expect(outcome.status).toBe("completed");
    expect(click).not.toHaveBeenCalled();
    expect(lastResults(source.requests[1])).toEqual([
      { name: "click", content: PLAN_GATE },
      { name: "snapshot", content: "Page with a button [ref=e1]" },
    ]);
    // Data the model reads, not a request, an error or a step that ran.
    expect(kinds(outcome.snapshot, 0)).toEqual(["refused", "ok"]);
    expect(events.some((event) => event.type === "request")).toBe(false);
    expect(started(events)).toEqual(["snapshot"]);
  });

  it("runs the plan first in its turn, so the step it opens gets past the gate", async () => {
    const order: string[] = [];
    const step = (name: string, content: string) =>
      tool(name, {
        run: async () => {
          order.push(name);
          return content;
        },
      });
    const source = wire(turn(["navigate", { url: "https://x.com" }], "plan"), text());
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [step("navigate", "Landed"), step("plan", "Plan posted")],
      runFirst: ["plan"],
    }).run("Go to x", { host: { screenCall: tabRunner() } });
    expect(outcome.status).toBe("completed");
    expect(order).toEqual(["plan", "navigate"]);
    // Results keep the model's order: each follows the call it answers.
    expect(lastResults(source.requests[1])).toEqual([
      { name: "navigate", content: "Landed" },
      { name: "plan", content: "Plan posted" },
    ]);
    expect(outcome.snapshot.definition.runFirst).toEqual(["plan"]);
    expect(() =>
      defineAgent({ ...base, provider: source.provider, tools: [tool("plan")], runFirst: ["x"] }),
    ).toThrow("runFirst must name tools registered on this agent");
  });

  it("cancels what a failed action was batched in front of, one result for each call", async () => {
    const click = vi.fn(fails("click boom"));
    const screen = vi.fn(tabRunner());
    const events: AgentEvent[] = [];
    const source = wire(
      turn("plan"),
      turn(["click", { ref: "e1" }], ["click", { ref: "e2" }], "snapshot"),
      text(),
    );
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [tool("plan"), tool("click", { run: click }), tool("snapshot")],
    }).run("Click both", {
      host: { screenCall: screen },
      onEvent: (event) => void events.push(event),
    });
    expect(outcome.status).toBe("completed");
    // One attempt, not two: the second click was written for the page the first should produce.
    expect(click).toHaveBeenCalledOnce();
    const results = lastResults(source.requests[2]);
    expect(results[0]?.content).toContain("click boom");
    expect(results.slice(1)).toEqual([
      { name: "click", content: cancelledAfterFailure("click") },
      { name: "snapshot", content: cancelledAfterFailure("click") },
    ]);
    expect(kinds(outcome.snapshot, 1)).toEqual(["failed", "cancelled", "cancelled"]);
    // The verdict holds for the rest of the turn, so the host is not asked about the snapshot.
    expect(screen).toHaveBeenCalledTimes(3);
    // A call that never ran never started.
    expect(started(events)).toEqual(["plan", "click"]);
  });

  it("does not stop the batch at a failed read", async () => {
    const click = vi.fn(async () => "clicked");
    const source = wire(
      turn("plan"),
      turn(["find", { query: "x" }], ["click", { ref: "e1" }]),
      text(),
    );
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [
        tool("plan"),
        tool("find", { run: fails("find boom") }),
        tool("click", { run: click }),
      ],
    }).run("Find and click", { host: { screenCall: tabRunner() } });
    expect(outcome.status).toBe("completed");
    expect(click).toHaveBeenCalledOnce();
    expect(kinds(outcome.snapshot, 1)).toEqual(["failed", "ok"]);
  });

  it("cancels a call and the rest of its turn when the page moved under them", async () => {
    const click = vi.fn(async () => "clicked");
    const moved = vi.fn(async () => true);
    const source = wire(
      turn("plan"),
      turn(["click", { ref: "e1" }], ["click", { ref: "e2" }], "snapshot"),
      text(),
    );
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [tool("plan"), tool("click", { run: click }), tool("snapshot")],
    }).run("Click both", { host: { screenCall: tabRunner(moved) } });
    expect(outcome.status).toBe("completed");
    expect(click).toHaveBeenCalledOnce();
    expect(lastResults(source.requests[2])).toEqual([
      { name: "click", content: "clicked" },
      { name: "click", content: CANCELLED_PAGE_CHANGED },
      { name: "snapshot", content: CANCELLED_PAGE_CHANGED },
    ]);
    // Asked before the second click only: the first acts on the page the model saw.
    expect(moved).toHaveBeenCalledOnce();
  });

  it("cancels what an ask_user call was batched in front of, once the answer is in", async () => {
    const click = vi.fn(async () => "clicked");
    const source = wire(
      turn("plan"),
      turn(["ask_user", { message: "Which one?" }], ["click", { ref: "e1" }]),
      text(),
    );
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [tool("plan"), questionTool({ name: "ask_user" }), tool("click", { run: click })],
    }).run("Click the right one", {
      host: {
        ...approval,
        screenCall: tabRunner(),
        // TabRunner answers its cards in the worker, while the run waits.
        answerNow: () => ({ type: "answer", answer: { text: "The first one" } }),
      },
    });
    expect(outcome.status).toBe("completed");
    expect(click).not.toHaveBeenCalled();
    const results = lastResults(source.requests[2]);
    expect(results[0]?.content).toContain("The first one");
    expect(results[1]).toEqual({ name: "click", content: CANCELLED_RUN_PAUSED });
  });

  it("shares an allowance between calls batched together", async () => {
    const search = vi.fn(async () => "Results");
    const screen = vi.fn(allowance(1));
    const source = wire(turn("search", "search", "search"), text());
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [tool("search", { run: search, isReadOnly: true, isConcurrencySafe: true })],
    }).run("Search three ways", {
      host: { screenCall: screen, canRunConcurrently: () => true },
    });
    expect(outcome.status).toBe("completed");
    expect(search).toHaveBeenCalledOnce();
    expect(lastResults(source.requests[1])).toEqual([
      { name: "search", content: "Results" },
      { name: "search", content: limitRefusal("search") },
      { name: "search", content: limitRefusal("search") },
    ]);
    // The second call saw the first, admitted with it but not yet run.
    const [, second] = screen.mock.calls;
    expect(second?.[1].earlier).toEqual([
      { operationId: expect.any(String), turn: 0, name: "search", arguments: {} },
    ]);
  });

  it("charges nothing for a call that never ran, to the allowance or the tool budget", async () => {
    const search = vi.fn(async () => "Results");
    const lookup = vi.fn(async () => "Record");
    const source = wire(turn("search", "search", "search"), turn("lookup", "search"), text());
    const outcome = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [tool("search", { run: search }), tool("lookup", { run: lookup })],
      limits: { toolCalls: 2 },
    }).run("Search, then look up", { host: { screenCall: allowance(1) } });
    // Two calls started: one search and the lookup. The refused searches spent none of the two.
    expect(outcome.status).toBe("completed");
    expect(search).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
    expect(kinds(outcome.snapshot, 1)).toEqual(["ok", "refused"]);
    expect(outcome.receipts.filter((receipt) => receipt.kind === "tool")).toHaveLength(5);
  });

  it("keeps the count when the run resumes after an approval", async () => {
    const search = vi.fn(async () => "Results");
    const publish = vi.fn(async () => "Published");
    const source = wire(turn("search", "publish"), turn("search"), text());
    const agent = defineAgent({
      ...base,
      provider: source.provider,
      tools: [
        tool("search", { run: search }),
        tool("publish", { run: publish, needsApproval: true }),
      ],
    });
    const host = { ...approval, screenCall: allowance(1) };
    const waiting = await agent.run("Research and publish", { host });
    expect(waiting.status).toBe("suspended");
    const done = await agent.resume(JSON.parse(JSON.stringify(waiting.snapshot)), {
      host,
      answers: evidenceFor(waiting.snapshot, "yes"),
    });
    expect(done.status).toBe("completed");
    expect(search).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    // The third request: the first came before the wait, the second after it.
    expect(lastResults(source.requests[2])).toEqual([
      { name: "search", content: limitRefusal("search") },
    ]);
  });

  it("asks nobody about a call it refuses", async () => {
    const prepareRequest = vi.fn(approval.prepareRequest);
    const events: AgentEvent[] = [];
    const gated = (name: string) => tool(name, { needsApproval: true });
    const source = wire(turn("erase", "publish", "delete"));
    const waiting = await defineAgent({
      ...base,
      provider: source.provider,
      tools: [gated("erase"), gated("publish"), gated("delete")],
    }).run("Clean up", {
      host: {
        ...approval,
        prepareRequest,
        screenCall: (call) =>
          call.call.name === "publish" ? undefined : { refuse: "Only publishing is allowed." },
      },
      onEvent: (event) => void events.push(event),
    });
    // erase is refused before its own approval, delete before the approvals the turn opens
    // together. Only publish asks.
    expect(waiting.status).toBe("suspended");
    expect(prepareRequest).toHaveBeenCalledOnce();
    expect(
      waiting.status === "suspended" && waiting.requests.map((r) => r.call?.call.name),
    ).toEqual(["publish"]);
    expect(events.flatMap((event) => (event.type === "request" ? [event] : []))).toHaveLength(1);
    expect(kinds(waiting.snapshot, 0)).toEqual(["refused", "pending", "refused"]);
  });

  it("screens the calls a program makes, and counts them for the next one", async () => {
    const search = vi.fn(async () => ({ hits: 1 }));
    const mode = codeMode({
      tools: [tool("search", { run: search, isReadOnly: true })],
      driver: createQuickJsDriver(),
    });
    const code =
      "const out = []; for (const _ of [1, 2]) { try { await tools.search({}); out.push('ran'); } catch (e) { out.push(e.kind + ': ' + e.message); } } return out;";
    const source = wire(turn([mode.name, { code }]), text());
    const outcome = await defineAgent({ ...base, provider: source.provider, tools: [mode] }).run(
      "Search twice in code",
      { host: { screenCall: allowance(1), beforeTool: () => {} } },
    );
    expect(outcome.status).toBe("completed");
    expect(search).toHaveBeenCalledOnce();
    const model = outcome.snapshot.models[0];
    const program = model?.status === "completed" ? model.tools[0] : undefined;
    if (program?.status !== "completed") throw new Error("Expected the program's result");
    expect(JSON.parse(program.result.content)).toMatchObject({
      result: ["ran", `refused: ${limitRefusal("search")}`],
    });
    expect(program.calls?.map((call) => call.status === "completed" && call.result.ok)).toEqual([
      true,
      false,
    ]);
  });

  it("restores a run saved after the plan ran and before the step it leads", async () => {
    let saved: RunSnapshot | undefined;
    const first = wire(turn("navigate", "plan"), text());
    const config = {
      ...base,
      tools: [tool("navigate"), tool("plan")],
      runFirst: ["plan"],
    };
    await defineAgent({ ...config, provider: first.provider }).run("Go", {
      host: {
        checkpoint(node) {
          const model = node.kind === "agent" ? node.models[0] : undefined;
          if (
            node.kind === "agent" &&
            model?.status === "completed" &&
            model.tools[0]?.status === "pending" &&
            model.tools[1]?.status === "completed"
          )
            saved ??= structuredClone(node);
        },
      },
    });
    if (!saved) throw new Error("Expected a checkpoint between the plan and the step");
    const navigate = vi.fn(async () => "Landed");
    const second = wire(text());
    const resumed = await defineAgent({
      ...config,
      tools: [tool("navigate", { run: navigate }), tool("plan")],
      provider: second.provider,
    }).resume(JSON.parse(JSON.stringify(saved)), { host: { authorizeResume: () => {} } });
    expect(resumed.status).toBe("completed");
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("restores a run saved after a refusal and before the call ahead of it ran", async () => {
    let saved: RunSnapshot | undefined;
    const config = {
      ...base,
      tools: [tool("search", { isReadOnly: true, isConcurrencySafe: true })],
    };
    const host = {
      screenCall: allowance(1),
      canRunConcurrently: () => true,
      authorizeResume: () => {},
    } satisfies AgentHost;
    await defineAgent({ ...config, provider: wire(turn("search", "search"), text()).provider }).run(
      "Search twice",
      {
        host: {
          ...host,
          checkpoint(node) {
            const model = node.kind === "agent" ? node.models[0] : undefined;
            if (
              node.kind === "agent" &&
              model?.status === "completed" &&
              model.tools[0]?.status === "pending" &&
              model.tools[1]?.status === "completed"
            )
              saved ??= structuredClone(node);
          },
        },
      },
    );
    if (!saved) throw new Error("Expected a checkpoint between the refusal and the first call");
    const search = vi.fn(async () => "Results");
    const resumed = await defineAgent({
      ...config,
      tools: [tool("search", { run: search, isReadOnly: true, isConcurrencySafe: true })],
      provider: wire(text()).provider,
    }).resume(JSON.parse(JSON.stringify(saved)), { host });
    // The first call is screened again after the restart. The refusal it saw spends nothing.
    expect(resumed.status).toBe("completed");
    expect(search).toHaveBeenCalledOnce();
    expect(kinds(resumed.snapshot, 0)).toEqual(["ok", "refused"]);
  });

  it.each([{}, { refuse: " " }, { refuse: "No", cancel: "No" }, { stop: "No" }, "No"])(
    "fails the run on a verdict it cannot read: %j",
    async (verdict) => {
      const run = vi.fn(async () => "ran");
      const outcome = await defineAgent({
        ...base,
        provider: wire(turn("click")).provider,
        tools: [tool("click", { run })],
      }).run("Click", {
        // A JavaScript host can return anything; the declared type cannot say so.
        host: { screenCall: () => verdict as unknown as CallVerdict },
      });
      expect(outcome).toMatchObject({ status: "failed", error: { code: "invalid_screen" } });
      expect(run).not.toHaveBeenCalled();
    },
  );
});
