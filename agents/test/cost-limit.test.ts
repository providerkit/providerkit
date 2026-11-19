import { describe, expect, it, vi } from "vitest";
import { defineTool, type Provider, type ProviderChunk } from "@providerkit/core";
import {
  defineAgent,
  subagentTool,
  type MeasuredModelCall,
  type RunSnapshot,
  type TreeNode,
} from "../src/index.ts";
import { defineWorkflow } from "../src/workflow.ts";
import { isRecord } from "../src/snapshot.ts";

const base = { version: "1", instructions: "Host instructions." };
// Every scripted call reads 1,000 input tokens, so it costs whatever one thousand tokens cost.
const usage = { inputTokens: 1_000, outputTokens: 10, cachedInputTokens: 0 };
const draft = { name: "helper", task: "Compare the two excerpts." };

let ids = 0;
function call(name: string, args: Record<string, unknown> = {}): ProviderChunk[] {
  ids += 1;
  return [
    {
      type: "delta",
      toolCalls: [{ index: 0, id: `call-${ids}`, name, arguments: JSON.stringify(args) }],
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
function wire(...turns: ProviderChunk[][]) {
  let calls = 0;
  const provider: Provider = {
    id: "offline",
    model: "default",
    async *createStream() {
      const turn = turns[calls];
      calls += 1;
      if (!turn) throw new Error("Unexpected model call");
      yield* turn;
    },
  };
  return { provider, calls: () => calls };
}
const read = defineTool({
  name: "read",
  description: "Read the excerpt.",
  inputSchema: { type: "object" },
  isReadOnly: true,
  run: async () => "Excerpt",
});
/** USD per thousand input tokens, as a host's own rate table would price it. */
function prices(perThousand: number) {
  return vi.fn(({ usage }: MeasuredModelCall) => (usage.inputTokens / 1_000) * perThousand);
}
function host(priceModelCall = prices(0.4)) {
  return {
    priceModelCall,
    authorizeResume: vi.fn(),
    beforeTool: vi.fn(),
    beforeStep: vi.fn(),
    prepareRequest: () => ({
      scope: {
        actorId: "owner",
        resource: { id: "record", version: "1" },
        expiresAt: Date.now() + 60_000,
      },
    }),
    resolveRequest: () => ({ type: "approve" as const }),
  };
}
function helperOf(snapshot: RunSnapshot): RunSnapshot {
  const helper = snapshot.delegations[0]?.children[0]?.snapshot;
  if (helper?.kind !== "agent") throw new Error("Expected a helper");
  return helper;
}

describe("cost limit", () => {
  it("starts no call once the known cost reaches the limit, and keeps each call's price", async () => {
    const source = wire(call("read"), call("read"), text("Never sent"));
    const price = prices(0.4);
    const agent = defineAgent({
      ...base,
      id: "analyst",
      provider: source.provider,
      tools: [read],
      limits: { costUsd: 0.5 },
    });
    const finished = await agent.run("Read twice", { host: host(price) });
    expect(finished).toMatchObject({ status: "limited", limit: "costUsd" });
    // $0.40 left room for a second call; $0.80 left none, and the third call has no receipt.
    expect(source.calls()).toBe(2);
    expect(finished.snapshot.models).toHaveLength(2);
    expect(
      finished.receipts.flatMap((receipt) => (receipt.kind === "model" ? [receipt.costUsd] : [])),
    ).toEqual([0.4, 0.4]);
    expect(price).toHaveBeenCalledWith({ usage, provider: "offline", model: "default" });
  });

  it("counts a helper's calls toward its creator's limit", async () => {
    const helper = wire(text("Helper answer"));
    const worker = defineAgent({ ...base, id: "worker", provider: helper.provider });
    const source = wire(call("create_helpers", { agents: [draft] }), text("Never sent"));
    const lead = defineAgent({
      ...base,
      id: "lead",
      provider: source.provider,
      limits: { costUsd: 0.7 },
      tools: [subagentTool({ name: "create_helpers", description: "Create.", agent: worker })],
    });
    const finished = await lead.run("Compare", { host: host() });
    // The lead's own call cost $0.40. Only the helper's $0.40 takes it past $0.70.
    expect(finished).toMatchObject({ status: "limited", limit: "costUsd" });
    expect(helper.calls()).toBe(1);
    expect(source.calls()).toBe(1);
  });

  it("stops a helper before its next call once its creator's budget is spent", async () => {
    const helper = wire(call("read"), text("Never sent"));
    const worker = defineAgent({ ...base, id: "worker", provider: helper.provider, tools: [read] });
    const source = wire(
      call("create_helpers", { agents: [{ ...draft, tools: ["read"] }] }),
      text("Never sent"),
    );
    const lead = defineAgent({
      ...base,
      id: "lead",
      provider: source.provider,
      limits: { costUsd: 0.5 },
      tools: [
        read,
        subagentTool({ name: "create_helpers", description: "Create.", agent: worker }),
      ],
    });
    const finished = await lead.run("Compare", { host: host() });
    expect(finished).toMatchObject({ status: "limited", limit: "costUsd" });
    expect(helperOf(finished.snapshot).state).toEqual({ status: "limited", limit: "costUsd" });
    expect(helper.calls()).toBe(1);
    expect(source.calls()).toBe(1);
  });

  it("lets a host give a helper its own lower cost limit", async () => {
    const helper = wire(call("read"), text("Never sent"));
    const worker = defineAgent({ ...base, id: "worker", provider: helper.provider, tools: [read] });
    const source = wire(
      call("create_helpers", { agents: [{ ...draft, tools: ["read"] }] }),
      text("Combined"),
    );
    const lead = defineAgent({
      ...base,
      id: "lead",
      provider: source.provider,
      tools: [
        read,
        subagentTool({
          name: "create_helpers",
          description: "Create.",
          agent: worker,
          prepare: (value) => ({ ...value, limits: { costUsd: 0.1 } }),
        }),
      ],
    });
    const finished = await lead.run("Compare", { host: host() });
    // The helper stops as local tool data; the lead has no limit and answers.
    expect(finished).toMatchObject({ status: "completed", output: "Combined" });
    expect(helperOf(finished.snapshot)).toMatchObject({
      limits: { costUsd: 0.1 },
      state: { status: "limited", limit: "costUsd" },
    });
    expect(helper.calls()).toBe(1);
  });

  it("resumes with the saved prices, not the host's new ones", async () => {
    const send = defineTool({
      name: "send",
      description: "Send the message.",
      inputSchema: { type: "object" },
      needsApproval: true,
      run: async () => "Sent",
    });
    const source = wire(call("send"), text("Never sent"));
    const agent = defineAgent({
      ...base,
      id: "writer",
      provider: source.provider,
      tools: [send],
      limits: { costUsd: 0.5 },
    });
    // At peak hours the first call costs $0.60, more than the whole limit.
    const waiting = await agent.run("Send it", { host: host(prices(0.6)) });
    const request = waiting.status === "suspended" ? waiting.requests[0] : undefined;
    if (!request) throw new Error("Expected an approval request");
    expect(waiting.snapshot.models[0]?.costUsd).toBe(0.6);
    const { priceModelCall: _price, ...unpriced } = host();
    await expect(agent.resume(waiting.snapshot, { host: unpriced })).rejects.toThrow(
      /priceModelCall/,
    );
    // Off peak the same call would cost $0.01 and leave room for another one.
    const offPeak = prices(0.01);
    const done = await agent.resume(waiting.snapshot, {
      host: host(offPeak),
      answers: { [request.id]: "evidence" },
    });
    expect(done).toMatchObject({ status: "limited", limit: "costUsd" });
    expect(source.calls()).toBe(1);
    expect(offPeak).not.toHaveBeenCalled();
  });

  it("keeps a lost attempt's price when it replays the call", async () => {
    const source = wire(text("Lost draft"), text("Draft"));
    const agent = defineAgent({
      ...base,
      id: "writer",
      provider: source.provider,
      recovery: { identity: "offline-1", maxAttempts: 2, inferenceOnly: true },
      limits: { costUsd: 1 },
    });
    const saved: TreeNode[] = [];
    await agent.run("Write", {
      host: { ...host(prices(0.6)), checkpoint: (node: TreeNode) => void saved.push(node) },
    });
    // The checkpoint written when usage arrived: the call is still running, as after a crash.
    const lost = saved.find(
      (node) =>
        node.kind === "agent" &&
        node.models[0]?.status === "running" &&
        node.models[0].costUsd !== undefined,
    );
    if (!lost) throw new Error("Expected a checkpoint taken mid-call");
    const resumed = await agent.resume(structuredClone(lost), { host: host(prices(0.01)) });
    expect(resumed).toMatchObject({ status: "completed", output: "Draft" });
    const replayed = resumed.snapshot.models[0];
    expect(replayed?.interrupted).toEqual([{ attemptId: expect.any(String), usage, costUsd: 0.6 }]);
    expect(replayed?.costUsd).toBe(0.01);
  });

  it("returns a workflow agent stopped by cost as limited, and the next step still runs", async () => {
    const analysis = wire(call("read"), text("Never sent"));
    const analyst = defineAgent({
      ...base,
      id: "analyst",
      provider: analysis.provider,
      tools: [read],
      limits: { costUsd: 0.3 },
    });
    const writing = wire(text("Report"));
    const writer = defineAgent({ ...base, id: "writer", provider: writing.provider });
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
      agents: [analyst, writer],
      async run(_, ctx) {
        const analyzed = await ctx.agent("analyst", analyst, "Analyze");
        const report = await ctx.agent("writer", writer, "Write");
        return {
          analyzed: analyzed.status === "limited" ? analyzed.limit : analyzed.status,
          report: report.status === "completed" ? report.output : null,
        };
      },
    });
    const done = await flow.run({}, { host: host() });
    expect(done).toMatchObject({
      status: "completed",
      output: { analyzed: "costUsd", report: "Report" },
    });
    expect(analysis.calls()).toBe(1);
  });

  it("refuses a cost limit without a price function, before any call", async () => {
    const source = wire(text());
    const agent = defineAgent({
      ...base,
      id: "writer",
      provider: source.provider,
      limits: { costUsd: 1 },
    });
    await expect(agent.run("Write")).rejects.toThrow(/priceModelCall/);
    expect(source.calls()).toBe(0);
  });

  it("fails closed on a price that is not a USD amount", async () => {
    const agent = defineAgent({ ...base, id: "writer", provider: wire(text()).provider });
    const finished = await agent.run("Write", { host: host(vi.fn(() => Number.NaN)) });
    expect(finished).toMatchObject({ status: "failed", error: { code: "invalid_cost" } });
  });
});
