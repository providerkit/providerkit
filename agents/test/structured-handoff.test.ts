import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { defineTool, type ChatMessage, type Provider, type ProviderChunk } from "@providerkit/core";
import {
  createMemorySession,
  defineAgent,
  defineDelegation,
  defineHandoff,
  type Agent,
  type AgentHost,
  type HandoffSpec,
  type ResultSchema,
  type RunOutcome,
  type RunSnapshot,
} from "../src/index.ts";
import { AGENT_RUNTIME } from "../src/delegation.ts";
import { isRecord } from "../src/snapshot.ts";
import { createBackgroundAgent, type BackgroundOptions } from "../src/runs.ts";

const base = { version: "1", instructions: "Answer the question." };
const usage = { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0 };
type Count = { count: number };
type Label = { label: string };
const countOutput: ResultSchema<Count> = {
  schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
  validate(raw) {
    if (!isRecord(raw) || typeof raw.count !== "number") throw new Error("Return a count.");
    return { count: raw.count };
  },
};
const labelOutput: ResultSchema<Label> = {
  schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  validate(raw) {
    if (!isRecord(raw) || typeof raw.label !== "string") throw new Error("Return a label.");
    return { label: raw.label };
  },
};
function call(name: string, args: Record<string, unknown> = {}): ProviderChunk[] {
  return [
    { type: "delta", toolCalls: [{ index: 0, id: name, name, arguments: JSON.stringify(args) }] },
    { type: "usage", usage },
    { type: "finish", finishReason: "tool_calls" },
  ];
}
function wire(...turns: ProviderChunk[][]) {
  const histories: ChatMessage[][] = [];
  const provider: Provider = {
    id: "fake",
    model: "fake",
    async *createStream(history) {
      const turn = turns[histories.length];
      histories.push(structuredClone(history));
      if (!turn) throw new Error("Unexpected model call");
      yield* turn;
    },
  };
  return { provider, histories };
}
function transfer<T>(to: HandoffSpec<T>["to"], name = "transfer") {
  return defineHandoff({ name, description: "Transfer the question.", to });
}
function child(snapshot: RunSnapshot): RunSnapshot {
  const node = snapshot.delegations[0]?.children[0]?.snapshot;
  if (!node) throw new Error("Missing target snapshot");
  return node;
}
function host(): AgentHost & { authorizeResume(): void } {
  return {
    authorizeResume() {},
    beforeTool() {},
    prepareRequest: () => ({
      scope: {
        actorId: "actor",
        resource: { id: "record", version: "1" },
        expiresAt: Date.now() + 60_000,
      },
    }),
    resolveRequest: () => ({ type: "approve" }),
  };
}

describe("structured handoff", () => {
  it("returns the target's transformed output from text, retaining only its raw candidate", async () => {
    const targetWire = wire(call("submit_result", { count: 4 }));
    const validate = vi.fn((raw: unknown) => new Set([countOutput.validate(raw).count]));
    const target = defineAgent({
      ...base,
      id: "target",
      provider: targetWire.provider,
      output: { schema: countOutput.schema, validate },
    });
    const sourceWire = wire(call("transfer"));
    const source = defineAgent({
      ...base,
      id: "source",
      provider: sourceWire.provider,
      tools: [transfer(target)],
    });
    expectTypeOf(source).toEqualTypeOf<Agent<string | Set<number>>>();
    const result = await source.run("Count them.");
    expect(result).toMatchObject({ status: "completed", activeAgent: { id: "target" } });
    if (result.status !== "completed") throw new Error(result.status);
    expectTypeOf(result.output).toEqualTypeOf<string | Set<number>>();
    expect(result.output).toEqual(new Set([4]));
    expect(result.snapshot.state).toEqual({ status: "completed", candidate: { count: 4 } });
    expect(child(result.snapshot).state).toEqual(result.snapshot.state);
    const restored = await source.resume(JSON.parse(JSON.stringify(result.snapshot)), {
      host: host(),
    });
    expect(restored).toMatchObject({ status: "completed", output: new Set([4]) });
    expect(sourceWire.histories).toHaveLength(1);
    expect(targetWire.histories).toHaveLength(1);
    expect(validate.mock.calls.every(([raw]) => isRecord(raw) && raw.count === 4)).toBe(true);
  });

  it.each([false, true])(
    "uses distinct source and target schemas (transfer: %s)",
    async (handoff) => {
      const sourceValidate = vi.fn(labelOutput.validate);
      const targetValidate = vi.fn(countOutput.validate);
      const targetWire = wire(call("submit_result", { count: 4 }));
      const target = defineAgent({
        ...base,
        id: "counter",
        provider: targetWire.provider,
        output: { ...countOutput, validate: targetValidate },
      });
      const sourceWire = wire(handoff ? call("transfer") : call("submit_result", { label: "own" }));
      const source = defineAgent({
        ...base,
        id: "labeler",
        provider: sourceWire.provider,
        output: { ...labelOutput, validate: sourceValidate },
        tools: [transfer(target)],
      });
      expectTypeOf(source).toEqualTypeOf<Agent<Label | Count>>();
      const result = await source.run("Answer.");
      const resumed = await source.resume(result.snapshot, { host: host() });
      expect(resumed).toMatchObject({
        status: "completed",
        output: handoff ? { count: 4 } : { label: "own" },
        activeAgent: { id: handoff ? "counter" : "labeler" },
      });
      expect(sourceWire.histories).toHaveLength(1);
      if (handoff) expect(sourceValidate).not.toHaveBeenCalled();
      else expect(targetValidate).not.toHaveBeenCalled();
    },
  );

  it("reuses a completed nested target after an interrupted coordinator", async () => {
    const leafWire = wire(call("submit_result", { count: 8 }));
    const leaf = defineAgent({
      ...base,
      id: "leaf",
      provider: leafWire.provider,
      output: countOutput,
    });
    const middleValidate = vi.fn(labelOutput.validate);
    const middleWire = wire(call("transfer"));
    const middle = defineAgent({
      ...base,
      id: "middle",
      provider: middleWire.provider,
      output: { ...labelOutput, validate: middleValidate },
      tools: [transfer(leaf)],
    });
    const filter = vi.fn(() => [{ role: "user" as const, content: "Filtered question" }]);
    const sourceWire = wire(call("transfer"));
    const source = defineAgent({
      ...base,
      id: "source",
      provider: sourceWire.provider,
      tools: [
        defineHandoff({ name: "transfer", description: "Transfer.", to: middle, history: filter }),
      ],
      treeLimits: { maxParallel: 1 },
    });
    expectTypeOf(source).toEqualTypeOf<Agent<string | Label | Count>>();
    const saved: RunSnapshot[] = [];
    const result = await source.run("Original question", {
      host: {
        checkpoint: (snapshot) => {
          saved.push(snapshot);
        },
      },
    });
    const interrupted = saved.find(
      (snapshot) =>
        snapshot.state.status === "running" &&
        snapshot.models[0]?.status === "completed" &&
        snapshot.models[0].tools[0]?.status === "delegating" &&
        snapshot.delegations[0]?.children[0]?.snapshot.state.status === "completed",
    );
    expect(interrupted).toBeDefined();
    const resumed = await source.resume(interrupted, { host: host() });
    expect(resumed).toMatchObject({
      status: "completed",
      output: { count: 8 },
      activeAgent: { id: "leaf" },
    });
    expect(resumed.handoffs).toHaveLength(2);
    expect(resumed.treeUsage).toEqual(result.treeUsage);
    expect(resumed.treeUsage.inputTokens).toBe(21);
    expect(filter).toHaveBeenCalledTimes(1);
    expect(middleValidate).not.toHaveBeenCalled();
    expect(sourceWire.histories).toHaveLength(1);
    expect(middleWire.histories).toHaveLength(1);
    expect(leafWire.histories).toHaveLength(1);
    expect(source[AGENT_RUNTIME].hydrate(resumed.snapshot)).toMatchObject({ output: { count: 8 } });
  });

  it.each([false, true])(
    "keeps target validation failures local to its loop (corrected: %s)",
    async (corrected) => {
      const targetWire = wire(
        call("submit_result", { label: "wrong schema" }),
        call("submit_result", { count: 4 }),
      );
      const target = defineAgent({
        ...base,
        id: "counter",
        provider: targetWire.provider,
        output: countOutput,
        limits: { turns: corrected ? 2 : 1 },
      });
      const validate = vi.fn(labelOutput.validate);
      const sourceWire = wire(call("transfer"));
      const source = defineAgent({
        ...base,
        id: "source",
        provider: sourceWire.provider,
        output: { ...labelOutput, validate },
        tools: [transfer(target)],
      });
      const result = await source.run("Count.");
      expect(result).toMatchObject(
        corrected
          ? { status: "completed", output: { count: 4 } }
          : { status: "limited", limit: "turns" },
      );
      expect(result.activeAgent.id).toBe("counter");
      expect(validate).not.toHaveBeenCalled();
      expect(sourceWire.histories).toHaveLength(1);
      if (corrected) expect(JSON.stringify(targetWire.histories[1])).toContain("Return a count.");
      else expect(result).not.toHaveProperty("output");
      const resumed = await source.resume(result.snapshot, { host: host() });
      expect(resumed.status).toBe(result.status);
      expect(resumed.treeUsage).toEqual(result.treeUsage);
    },
  );

  it("resumes target approval without changing source session identity or copied history", async () => {
    const write = vi.fn(async () => "saved");
    const tool = defineTool({
      name: "write",
      description: "Write a record.",
      inputSchema: { type: "object" },
      needsApproval: true,
      run: write,
    });
    const targetWire = wire(call("write"), call("submit_result", { count: 4 }));
    const target = defineAgent({
      ...base,
      id: "target",
      provider: targetWire.provider,
      output: countOutput,
      tools: [tool],
    });
    const sourceWire = wire(call("transfer"));
    const filter = vi.fn(() => []);
    const source = defineAgent({
      ...base,
      id: "source",
      provider: sourceWire.provider,
      output: labelOutput,
      tools: [
        defineHandoff({ name: "transfer", description: "Transfer.", to: target, history: filter }),
      ],
    });
    const store = createMemorySession({ messages: [{ role: "user", content: "Earlier turn" }] });
    const session = { ...store, append: vi.fn(store.append) };
    const policy = host();
    const before = vi.spyOn(policy, "beforeTool");
    const waiting = await source.run("New turn", { host: policy, session });
    if (waiting.status !== "suspended" || !waiting.requests[0])
      throw new Error("Expected approval");
    const request = waiting.requests[0];
    expect(request.path).toHaveLength(1);
    expect(request.call.agentId).toBe("target");
    expect(session.append).not.toHaveBeenCalled();
    const result = await source.resume(waiting.snapshot, {
      host: policy,
      session,
      answers: { [request.id]: "authenticated approval" },
    });
    expect(result).toMatchObject({
      status: "completed",
      output: { count: 4 },
      session: { status: "saved" },
    });
    const again = await source.resume(result.snapshot, { host: policy, session });
    expect(again.session).toEqual(result.session);
    expect(session.append.mock.calls[0]?.[0]).toEqual(session.append.mock.calls[1]?.[0]);
    expect(session.append.mock.calls[0]?.[0]).toMatchObject({
      runId: waiting.runId,
      after: waiting.snapshot.session?.revision,
    });
    expect(result.newMessages.filter((message) => message.role === "user")).toEqual([
      { role: "user", content: "New turn" },
    ]);
    expect(result.history.some((message) => message.content === "Earlier turn")).toBe(false);
    expect(JSON.stringify(result.newMessages)).not.toContain(
      "Continue the conversation transferred",
    );
    expect(child(result.snapshot).session).toBeUndefined();
    expect(
      before.mock.calls.some(
        ([call, decided]) => call.call.name === "write" && decided?.request.id === request.id,
      ),
    ).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(filter).toHaveBeenCalledTimes(1);
    expect(sourceWire.histories).toHaveLength(1);
    expect(targetWire.histories).toHaveLength(2);
    expect(result.treeUsage.inputTokens).toBe(21);
  });

  it("rejects a completed target under a changed validator instead of using the source validator", async () => {
    const sourceWire = wire(call("transfer"));
    const targetWire = wire(call("submit_result", { count: 4 }));
    function build(output: ResultSchema<Count>) {
      const target = defineAgent({ ...base, id: "target", provider: targetWire.provider, output });
      return defineAgent({
        ...base,
        id: "source",
        provider: sourceWire.provider,
        output: labelOutput,
        tools: [transfer(target)],
      });
    }
    const result = await build(countOutput).run("Count.");
    const rebuilt = build({
      ...countOutput,
      validate() {
        throw new Error("Count policy changed");
      },
    });
    const policy = host();
    const authorize = vi.spyOn(policy, "authorizeResume");
    await expect(rebuilt.resume(result.snapshot, { host: policy })).rejects.toThrow(
      "Count policy changed",
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(sourceWire.histories).toHaveLength(1);
    expect(targetWire.histories).toHaveLength(1);
  });

  it.each(["modelOutput", "toolOutput"] as const)(
    "cannot complete past a rejected target %s guard",
    async (stage) => {
      const targetWire = wire(call("submit_result", { count: 4 }));
      const target = defineAgent({
        ...base,
        id: "target",
        provider: targetWire.provider,
        output: countOutput,
        guardrails: { identity: "refuse-output", [stage]: () => ({ allow: false }) },
      });
      const sourceWire = wire(call("transfer"));
      const sourceValidate = vi.fn(labelOutput.validate);
      const source = defineAgent({
        ...base,
        id: "source",
        provider: sourceWire.provider,
        output: { ...labelOutput, validate: sourceValidate },
        tools: [transfer(target)],
      });
      const result = await source.run("Count.");
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "guard_rejected" },
        activeAgent: { id: "target" },
      });
      expect(result).not.toHaveProperty("output");
      expect(child(result.snapshot).guards).toContainEqual(
        expect.objectContaining({ stage, status: "rejected" }),
      );
      expect(sourceValidate).not.toHaveBeenCalled();
      expect((await source.resume(result.snapshot, { host: host() })).status).toBe("failed");
      expect(targetWire.histories).toHaveLength(1);
      expect(sourceWire.histories).toHaveLength(1);
    },
  );

  it("keeps full transferred history while both model views compact", async () => {
    const policy = { identity: "context", contextWindow: 100, keepTokens: 10 };
    const targetWire = wire(call("submit_result", { count: 4 }));
    const target = defineAgent({
      ...base,
      id: "target",
      provider: targetWire.provider,
      output: countOutput,
      compaction: policy,
      guardrails: {
        identity: "checked-count",
        modelOutput: () => ({ allow: true }),
        toolOutput: ({ result }) => ({
          allow:
            result.ok && isRecord(result.final?.candidate) && result.final.candidate.count === 4,
        }),
      },
    });
    const sourceWire = wire(call("transfer"));
    const source = defineAgent({
      ...base,
      id: "source",
      provider: sourceWire.provider,
      output: labelOutput,
      compaction: policy,
      tools: [transfer(target)],
    });
    const old = "Earlier facts. ".repeat(1_000);
    const result = await source.run({
      messages: [
        { role: "user", content: old },
        { role: "assistant", content: "Noted." },
        { role: "user", content: "Count." },
      ],
    });
    expect(result).toMatchObject({ status: "completed", output: { count: 4 } });
    expect(result.snapshot.compactions).toHaveLength(1);
    expect(child(result.snapshot).compactions).toHaveLength(1);
    expect(child(result.snapshot).history[0]?.content).toBe(old);
    expect(result.history[0]?.content).toBe(old);
    expect(JSON.stringify(sourceWire.histories)).not.toContain(old);
    expect(JSON.stringify(targetWire.histories)).not.toContain(old);
    const resumed = await source.resume(result.snapshot, { host: host() });
    expect(resumed).toMatchObject({ status: "completed", output: { count: 4 } });
    expect(resumed.newMessages).toEqual(result.newMessages);
    expect(sourceWire.histories).toHaveLength(1);
    expect(targetWire.histories).toHaveLength(1);
  });

  it("infers unions only from handoffs, including multiple targets and lazy cycles", () => {
    const provider = wire().provider;
    const plain = defineAgent({ ...base, id: "plain", provider });
    const count = defineAgent({ ...base, id: "count", provider, output: countOutput });
    const label = defineAgent({ ...base, id: "label", provider, output: labelOutput });
    expectTypeOf(plain).toEqualTypeOf<Agent<string>>();
    expectTypeOf(count).toEqualTypeOf<Agent<Count>>();
    const mixed = defineAgent({
      ...base,
      id: "mixed",
      provider,
      tools: [
        transfer(count),
        transfer(label, "label"),
        count.asTool({ name: "consult", description: "Consult." }),
      ],
    });
    expectTypeOf(mixed).toEqualTypeOf<Agent<string | Count | Label>>();
    // @ts-expect-error A structured target cannot be hidden behind a text-only source type.
    const textOnly: Agent<string> = mixed;
    void textOnly;
    const delegated = defineAgent({
      ...base,
      id: "delegated",
      provider,
      output: countOutput,
      tools: [
        mixed.asTool({
          name: "consult",
          description: "Consult.",
          summarize(output) {
            expectTypeOf(output).toEqualTypeOf<string | Count | Label>();
            return JSON.stringify(output);
          },
        }),
      ],
    });
    expectTypeOf(delegated).toEqualTypeOf<Agent<Count>>();
    const a: Agent<Count | Label> = defineAgent({
      ...base,
      id: "a",
      provider,
      output: countOutput,
      tools: [transfer(() => b)],
    });
    const b = defineAgent({
      ...base,
      id: "b",
      provider,
      output: labelOutput,
      tools: [transfer(a)],
    });
    expectTypeOf(b).toEqualTypeOf<Agent<Count | Label>>();
    const coordinator = defineDelegation({
      name: "coordinate",
      description: "Coordinate.",
      inputSchema: { type: "object" },
      specialists: [mixed, count],
      validate: () => "task",
      async run(input, context) {
        const results = await context.join([
          context.child("mixed", mixed, input),
          context.child("count", count, input),
        ]);
        expectTypeOf(results).toEqualTypeOf<
          readonly [RunOutcome<string | Count | Label>, RunOutcome<Count>]
        >();
        return results;
      },
    });
    void coordinator;
    // Public background reads preserve exactly the same union; this helper performs no IO.
    function background(options: BackgroundOptions<string | Count | Label>) {
      return createBackgroundAgent({ ...options, agent: mixed });
    }
    expectTypeOf<
      Awaited<ReturnType<ReturnType<typeof background>["read"]>>["outcome"]
    >().toEqualTypeOf<RunOutcome<string | Count | Label> | null>();
    expectTypeOf<Awaited<ReturnType<typeof mixed.resume>>>().toEqualTypeOf<
      RunOutcome<string | Count | Label>
    >();
  });
});
