import { describe, expect, it, vi } from "vitest";
import { defineTool, type Provider, type ProviderChunk } from "@providerkit/core";
import {
  defineAgent,
  defineClientTool,
  type AgentHost,
  type Decision,
  type RunOutcome,
} from "../src/index.ts";
import { evidenceFor } from "./fixtures/requests.ts";

const base = { id: "requests-policy", version: "1", instructions: "Ask before acting." };
const usage = { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 };

function calls(...items: (string | { name: string; args: object })[]): ProviderChunk[] {
  return [
    {
      type: "delta",
      toolCalls: items.map((value, index) => ({
        index,
        id: `wire-${index}`,
        name: typeof value === "string" ? value : value.name,
        arguments: JSON.stringify(typeof value === "string" ? {} : value.args),
      })),
    },
    { type: "finish", finishReason: "tool_calls", usage },
  ];
}

const text: ProviderChunk[] = [{ type: "finish", finishReason: "stop", content: "Done", usage }];

function wire(...turns: ProviderChunk[][]) {
  let count = 0;
  const provider: Provider = {
    id: "fake",
    model: "fake",
    async *createStream() {
      const turn = turns[count++];
      if (!turn) throw new Error("Unexpected model call");
      yield* turn;
    },
  };
  return { provider, count: () => count };
}

function host(decision: (evidence: unknown) => Decision = () => ({ type: "approve" })) {
  return {
    authorizeResume: vi.fn(() => {}),
    prepareRequest: vi.fn(() => ({
      scope: {
        actorId: "person",
        resource: { id: "record", version: "1" },
        expiresAt: Date.now() + 60_000,
      },
    })),
    resolveRequest: vi.fn((_request, evidence) => decision(evidence)),
    beforeTool: vi.fn(() => {}),
  } satisfies AgentHost;
}

function pending<T>(result: RunOutcome<T>) {
  expect(result.status, JSON.stringify(result.snapshot.state)).toBe("suspended");
  if (result.status !== "suspended") throw new Error(JSON.stringify(result));
  return result;
}

function validatedWrite(run = vi.fn(async (input: { title: string }) => `Wrote ${input.title}`)) {
  return defineTool({
    name: "write",
    description: "Write a titled record.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    validate(raw) {
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as { title?: unknown }).title !== "string" ||
        !(raw as { title: string }).title.trim()
      )
        throw new TypeError("title must be a non-empty string.");
      return { title: (raw as { title: string }).title };
    },
    needsApproval: true,
    run,
  });
}

describe("requests policy (onePerTurn and validateBeforeAsk)", () => {
  it("opens only the first approval in a turn when onePerTurn is enabled, then opens the next on resume", async () => {
    const effect = vi.fn(async (input: { title: string }) => `Wrote ${input.title}`);
    const model = wire(
      calls(
        { name: "write", args: { title: "first" } },
        { name: "write", args: { title: "second" } },
      ),
      text,
    );
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      tools: [validatedWrite(effect)],
      requests: { onePerTurn: true },
    });
    const policy = host();

    const firstWait = pending(await agent.run("Write two records", { host: policy }));
    expect(firstWait.requests).toHaveLength(1);
    expect(firstWait.requests[0]?.call?.arguments).toEqual({ title: "first" });
    expect(policy.prepareRequest).toHaveBeenCalledTimes(1);

    const secondWait = pending(
      await agent.resume(firstWait.snapshot, {
        host: policy,
        answers: evidenceFor(firstWait.snapshot, "approve"),
      }),
    );
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledWith({ title: "first" }, expect.anything());
    expect(secondWait.requests).toHaveLength(1);
    expect(secondWait.requests[0]?.call?.arguments).toEqual({ title: "second" });
    expect(policy.prepareRequest).toHaveBeenCalledTimes(2);

    const done = await agent.resume(secondWait.snapshot, {
      host: policy,
      answers: evidenceFor(secondWait.snapshot, "approve"),
    });
    expect(done.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(2);
    expect(model.count()).toBe(2);
  });

  it("opens only the client request without eagerly opening later approvals when onePerTurn is enabled", async () => {
    const client = defineClientTool({
      name: "browser_pick",
      description: "Pick an item in the browser.",
      inputSchema: { type: "object" },
      validate: () => ({}),
      result: { schema: { type: "object" }, validate: (raw) => raw },
    });
    const model = wire(calls("browser_pick", { name: "write", args: { title: "after" } }), text);
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      tools: [client, validatedWrite()],
      requests: { onePerTurn: true },
    });
    const policy = host((evidence) =>
      evidence === "client" ? { type: "result", value: { ok: true } } : { type: "approve" },
    );

    const waiting = pending(await agent.run("Pick then write", { host: policy }));
    expect(waiting.requests).toHaveLength(1);
    expect(waiting.requests[0]?.ask.type).toBe("client");

    const next = pending(
      await agent.resume(waiting.snapshot, {
        host: policy,
        answers: { [waiting.requests[0]!.id]: "client" },
      }),
    );
    expect(next.requests).toHaveLength(1);
    expect(next.requests[0]?.ask.type).toBe("approval");
  });

  it("skips approval and returns invalid_input to the model when validateBeforeAsk rejects arguments", async () => {
    const effect = vi.fn(async (input: { title: string }) => `Wrote ${input.title}`);
    const model = wire(
      calls({ name: "write", args: { title: "" } }),
      calls({ name: "write", args: { title: "valid" } }),
      text,
    );
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      tools: [validatedWrite(effect)],
      requests: { validateBeforeAsk: true },
    });
    const policy = host();

    // First turn has invalid arguments: no approval opens, the tool returns invalid_input and the
    // model gets a second turn with valid arguments that DOES open an approval.
    const waiting = pending(await agent.run("Write a record", { host: policy }));
    expect(model.count()).toBe(2);
    expect(policy.prepareRequest).toHaveBeenCalledTimes(1);
    expect(waiting.requests).toHaveLength(1);
    expect(waiting.requests[0]?.call?.arguments).toEqual({ title: "valid" });
    const firstTurnResult = waiting.snapshot.models[0];
    expect(firstTurnResult?.status).toBe("completed");
    if (firstTurnResult?.status === "completed") {
      expect(firstTurnResult.tools[0]?.status).toBe("completed");
      if (firstTurnResult.tools[0]?.status === "completed") {
        expect(firstTurnResult.tools[0].result).toMatchObject({
          ok: false,
          kind: "invalid_input",
        });
      }
    }

    const done = await agent.resume(waiting.snapshot, {
      host: policy,
      answers: evidenceFor(waiting.snapshot, "approve"),
    });
    expect(done.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledWith({ title: "valid" }, expect.anything());
  });

  it("does not open a batch approval for a later call whose arguments fail accepts()", async () => {
    const effect = vi.fn(async (input: { title: string }) => `Wrote ${input.title}`);
    const model = wire(
      calls({ name: "write", args: { title: "good" } }, { name: "write", args: { title: "" } }),
      text,
    );
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      tools: [validatedWrite(effect)],
      requests: { validateBeforeAsk: true },
    });
    const policy = host();

    const waiting = pending(await agent.run("Write two records", { host: policy }));
    expect(waiting.requests).toHaveLength(1);
    expect(waiting.requests[0]?.call?.arguments).toEqual({ title: "good" });
    expect(policy.prepareRequest).toHaveBeenCalledTimes(1);

    const done = await agent.resume(waiting.snapshot, {
      host: policy,
      answers: evidenceFor(waiting.snapshot, "approve"),
    });
    expect(done.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(1);
    const turn = done.snapshot.models[0];
    if (turn?.status === "completed" && turn.tools[1]?.status === "completed") {
      expect(turn.tools[1].result).toMatchObject({ ok: false, kind: "invalid_input" });
    }
  });

  it("checks client tool arguments before approval when validateBeforeAsk is enabled", async () => {
    const client = defineClientTool({
      name: "browser_pick",
      description: "Pick an item.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      needsApproval: true,
      validate(raw) {
        if (
          typeof raw !== "object" ||
          raw === null ||
          typeof (raw as { id?: unknown }).id !== "string"
        )
          throw new TypeError("id must be a string.");
        return { id: (raw as { id: string }).id };
      },
      result: { schema: { type: "object" }, validate: (raw) => raw },
    });
    const model = wire(calls({ name: "browser_pick", args: {} }), text);
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      tools: [client],
      requests: { validateBeforeAsk: true },
    });
    const policy = host();

    const done = await agent.run("Pick", { host: policy });
    expect(done.status).toBe("completed");
    expect(policy.prepareRequest).not.toHaveBeenCalled();
    const turn = done.snapshot.models[0];
    if (turn?.status === "completed" && turn.tools[0]?.status === "completed") {
      expect(turn.tools[0].result).toMatchObject({ ok: false, kind: "invalid_input" });
    }
  });

  it("refuses resuming a snapshot with a changed requests policy and accepts existing snapshots without it", async () => {
    const model = wire(calls({ name: "write", args: { title: "a" } }), text);
    const policy = host();
    const plain = defineAgent({ ...base, provider: model.provider, tools: [validatedWrite()] });
    const strict = defineAgent({
      ...base,
      provider: model.provider,
      tools: [validatedWrite()],
      requests: { onePerTurn: true },
    });

    const waiting = pending(await plain.run("Write", { host: policy }));
    expect(waiting.snapshot.definition.requests).toBeUndefined();
    await expect(
      strict.resume(waiting.snapshot, {
        host: policy,
        answers: evidenceFor(waiting.snapshot, "approve"),
      }),
    ).rejects.toThrow("tool behavior");
  });

  it("rejects invalid requests configuration", () => {
    const { provider } = wire();
    expect(() =>
      defineAgent({
        ...base,
        provider,
        requests: { onePerTurn: "yes" as unknown as boolean },
      }),
    ).toThrow(TypeError);
    expect(() =>
      defineAgent({
        ...base,
        provider,
        requests: { unknownFlag: true } as unknown as { onePerTurn?: boolean },
      }),
    ).toThrow(TypeError);
  });
});
