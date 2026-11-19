import { describe, expect, it, vi } from "vitest";
import { defineTool, type Provider, type ProviderChunk } from "@providerkit/core";
import { defineAgent, type MeasuredModelCall, type TreeNode } from "../src/index.ts";
import { usageOf } from "../src/evals/journal.ts";

const base = { version: "1", instructions: "Host instructions." };
// Every scripted call reads 1,000 input tokens, so it costs whatever one thousand tokens cost.
const usage = { inputTokens: 1_000, outputTokens: 10, cachedInputTokens: 0 };

let ids = 0;
function call(name: string): ProviderChunk[] {
  ids += 1;
  return [
    { type: "delta", toolCalls: [{ index: 0, id: `call-${ids}`, name, arguments: "{}" }] },
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
/** A search that a paid service answers: it reports what the service charged. */
function paidSearch(usd: unknown) {
  return defineTool({
    name: "search",
    description: "Search the archive.",
    inputSchema: { type: "object" },
    isReadOnly: true,
    run: async (_input, context) => {
      if (typeof context.reportCost === "function") context.reportCost(usd);
      return "Results";
    },
  });
}
const host = {
  // $0.10 per model call.
  priceModelCall: vi.fn(({ usage }: MeasuredModelCall) => (usage.inputTokens / 1_000) * 0.1),
  authorizeResume: vi.fn(),
  // Replaying a read after a restart needs the host's current authorization.
  beforeTool: vi.fn(),
};

describe("tool cost", () => {
  it("counts what a tool reports toward the cost limit, and puts it on the receipt", async () => {
    const source = wire(call("search"), call("search"), text("Never sent"));
    const agent = defineAgent({
      ...base,
      id: "researcher",
      provider: source.provider,
      tools: [paidSearch(0.3)],
      limits: { costUsd: 0.5 },
    });
    const finished = await agent.run("Search twice", { host });
    // Model calls alone came to $0.20. The two searches' $0.60 is what reaches the limit.
    expect(finished).toMatchObject({ status: "limited", limit: "costUsd" });
    expect(source.calls()).toBe(2);
    const tools = finished.receipts.flatMap((receipt) =>
      receipt.kind === "tool" ? [receipt] : [],
    );
    expect(tools.map((receipt) => receipt.costUsd)).toEqual([0.3, 0.3]);
    expect(finished.snapshot.toolCosts).toEqual(
      tools.map((receipt) => ({
        operationId: receipt.id,
        attemptId: receipt.attemptId,
        costUsd: 0.3,
      })),
    );
    // Evals price model calls with their own rates, none here. A tool's charge needs no rate.
    expect(usageOf(finished.snapshot).knownCostUsd).toBeCloseTo(0.6);
  });

  it("saves a cost while the call still runs, and keeps it when a restart replays the call", async () => {
    const source = wire(call("search"), text("Found it"));
    const agent = defineAgent({
      ...base,
      id: "researcher",
      provider: source.provider,
      tools: [paidSearch(0.3)],
      recovery: { identity: "offline-1", maxAttempts: 2, readOnlyTools: ["search"] },
    });
    const saved: TreeNode[] = [];
    await agent.run("Search", {
      host: { ...host, checkpoint: (node: TreeNode) => void saved.push(node) },
    });
    // The checkpoint the report wrote: the search is still running, as when a worker dies.
    const lost = saved.find(
      (node) =>
        node.kind === "agent" &&
        node.models[0]?.status === "completed" &&
        node.models[0].tools[0]?.status === "running" &&
        node.toolCosts?.length === 1,
    );
    if (lost?.kind !== "agent") throw new Error("Expected a checkpoint taken mid-call");
    const replay = wire(text("Found it"));
    const resumed = await defineAgent({
      ...base,
      id: "researcher",
      provider: replay.provider,
      tools: [paidSearch(0.3)],
      recovery: { identity: "offline-1", maxAttempts: 2, readOnlyTools: ["search"] },
    }).resume(structuredClone(lost), { host });
    expect(resumed).toMatchObject({ status: "completed", output: "Found it" });
    // Both attempts charged, and each receipt says what its own attempt reported.
    expect(resumed.snapshot.toolCosts?.map((entry) => entry.costUsd)).toEqual([0.3, 0.3]);
    expect(
      resumed.receipts.flatMap((receipt) =>
        receipt.kind === "tool" ? [[receipt.status, receipt.costUsd]] : [],
      ),
    ).toEqual([
      ["interrupted", 0.3],
      ["completed", 0.3],
    ]);
  });

  it("refuses an amount that is not USD, and saves nothing for it", async () => {
    const source = wire(call("search"), text("Answered without it"));
    const agent = defineAgent({
      ...base,
      id: "researcher",
      provider: source.provider,
      tools: [paidSearch(Number.NaN)],
    });
    const finished = await agent.run("Search", { host });
    expect(finished.status).toBe("completed");
    const receipt = finished.receipts.find((entry) => entry.kind === "tool");
    expect(receipt?.kind === "tool" ? receipt.result : undefined).toMatchObject({
      ok: false,
      content: expect.stringContaining("reportCost"),
    });
    expect(finished.snapshot.toolCosts).toBeUndefined();
  });

  it("refuses a saved cost that names no call in the run", async () => {
    const source = wire(text());
    const agent = defineAgent({ ...base, id: "writer", provider: source.provider });
    const done = await agent.run("Write");
    const forged = {
      ...done.snapshot,
      toolCosts: [{ operationId: "made-up", attemptId: "attempt", costUsd: 5 }],
    };
    await expect(agent.resume(forged, { host })).rejects.toThrow("reported tool cost");
  });
});
