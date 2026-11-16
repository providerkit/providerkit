import { afterEach, describe, expect, it, vi } from "vitest";
import { defineTool, type Provider, type ProviderChunk, type ToolContext } from "@providerkit/core";
import {
  answerOf,
  createMemorySession,
  defineAgent,
  defineClientTool,
  defineDelegation,
  InputRequired,
  questionTool,
  type AgentHost,
  type AgentEvent,
  type AskRecord,
  type Decision,
  type RunOutcome,
  type RunSnapshot,
} from "../src/index.ts";
import { checkDecision } from "../src/request.ts";
import { requestRecords } from "../src/tree.ts";
import { evidenceFor, firstRequest } from "./fixtures/requests.ts";

const base = { id: "requests", version: "1", instructions: "Ask before acting." };
const usage = { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 };
function calls(...names: (string | { name: string; args: object })[]): ProviderChunk[] {
  return [
    {
      type: "delta",
      toolCalls: names.map((value, index) => ({
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
    beforeTool: vi.fn((_call: Parameters<NonNullable<AgentHost["beforeTool"]>>[0]) => {}),
  } satisfies AgentHost;
}
function pending<T>(result: RunOutcome<T>) {
  expect(result.status).toBe("suspended");
  if (result.status !== "suspended") throw new Error(JSON.stringify(result));
  return result;
}
function records(snapshot: RunSnapshot): AskRecord[] {
  return [...requestRecords(snapshot)].map(({ record }) => record);
}
function write(run = vi.fn(async (_input: unknown, _context: ToolContext) => "Written")) {
  return defineTool({
    name: "write",
    description: "Write a record.",
    inputSchema: { type: "object" },
    needsApproval: true,
    run,
  });
}

afterEach(() => vi.useRealTimers());

describe("durable requests", () => {
  it("cancels a coordinator request without leaving unfinished child journals", async () => {
    const childWire = wire(calls("write"));
    const child = defineAgent({
      ...base,
      id: "child",
      provider: childWire.provider,
      tools: [write()],
    });
    const coordinate = defineDelegation({
      name: "coordinate",
      description: "Ask with a child",
      inputSchema: { type: "object" },
      validate: () => null,
      specialists: [child],
      async run(_input, context) {
        context.child("child", child, "Write");
        await Promise.all([
          context.ask({ key: "one", message: "First?" }, (answer) => answer.text),
          context.ask({ key: "two", message: "Second?" }, (answer) => answer.text),
        ]);
        return "Done";
      },
    });
    const model = wire(calls("coordinate"), text);
    const agent = defineAgent({ ...base, provider: model.provider, tools: [coordinate] });
    const policy = host(() => ({ type: "cancel" }));
    const waiting = pending(await agent.run("Ask", { host: policy }));
    expect(waiting.requests).toHaveLength(3);
    const done = await agent.resume(waiting.snapshot, {
      host: policy,
      answers: evidenceFor(waiting.snapshot, "cancel"),
    });
    expect(done.status).toBe("completed");
    expect(done.snapshot.delegations[0]?.children[0]?.snapshot.state.status).toBe("cancelled");
    await expect(agent.resume(done.snapshot, { host: policy })).resolves.toMatchObject({
      status: "completed",
    });
    expect(childWire.count()).toBe(1);
  });

  it("journals every approval before suspension and holds a later partial answer behind the first", async () => {
    const effect = vi.fn(async () => "Written");
    const model = wire(calls("write", "write"), text);
    const agent = defineAgent({ ...base, provider: model.provider, tools: [write(effect)] });
    const policy = host();
    const saved: RunSnapshot[] = [];
    const events: AgentEvent[] = [];
    const waiting = pending(
      await agent.run("Write two records", {
        host: {
          ...policy,
          checkpoint: (snapshot) => {
            saved.push(snapshot);
          },
        },
        onEvent: (event) => {
          events.push(event);
        },
      }),
    );
    expect(waiting.requests.map((request) => request.call.call.id)).toEqual(["wire-0", "wire-1"]);
    expect(saved.at(-1)?.state.status).toBe("suspended");
    expect(records(saved.at(-1) ?? waiting.snapshot)).toHaveLength(2);
    expect(events.filter((event) => event.type === "request")).toHaveLength(2);
    expect(effect).not.toHaveBeenCalled();
    const secondId = waiting.requests[1]?.id;
    if (!secondId) throw new Error("Missing second request");
    const partial = pending(
      await agent.resume(waiting.snapshot, { host: policy, answers: { [secondId]: "ticket-2" } }),
    );
    expect(partial.requests).toHaveLength(1);
    expect(effect).not.toHaveBeenCalled();
    expect(records(partial.snapshot)[1]?.decision).toEqual({ type: "approve" });
    const rebuilt = defineAgent({ ...base, provider: model.provider, tools: [write(effect)] });
    const done = await rebuilt.resume(JSON.parse(JSON.stringify(partial.snapshot)), {
      host: policy,
      answers: evidenceFor(partial.snapshot, "ticket-1"),
    });
    expect(done.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(2);
    expect(policy.resolveRequest).toHaveBeenCalledTimes(2);
    expect(policy.beforeTool).toHaveBeenCalledTimes(2);
    expect(done.treeUsage.inputTokens).toBe(6);
    expect(model.count()).toBe(2);
    await expect(
      agent.resume(done.snapshot, { host: policy, answers: { [secondId]: "ticket-2" } }),
    ).rejects.toThrow("already-decided");
  });

  it("stops the tree when a later inline approval stops behind an open request", async () => {
    const effect = vi.fn(async () => "Written");
    const model = wire(calls("write", "write", "write"));
    const agent = defineAgent({ ...base, provider: model.provider, tools: [write(effect)] });
    const policy = host();
    let savedDecision: RunSnapshot | undefined;
    const done = await agent.run("Write", {
      host: {
        ...policy,
        answerNow: (request) => (request.call.call.id === "wire-1" ? { type: "stop" } : undefined),
        checkpoint(snapshot) {
          if (
            snapshot.state.status === "running" &&
            records(snapshot).some((record) => record.decision?.type === "stop")
          )
            savedDecision = snapshot;
        },
      },
    });
    expect(done.status).toBe("cancelled");
    expect(records(done.snapshot)).toMatchObject([
      { closed: "stopped" },
      { decision: { type: "stop" } },
    ]);
    expect(policy.prepareRequest).toHaveBeenCalledTimes(2);
    expect(effect).not.toHaveBeenCalled();
    expect(model.count()).toBe(1);
    if (!savedDecision) throw new Error("Missing saved stop decision");
    const recovered = await agent.resume(savedDecision, { host: policy });
    expect(recovered.status).toBe("cancelled");
    expect(recovered.treeUsage).toEqual(done.treeUsage);
    expect(effect).not.toHaveBeenCalled();
    expect(model.count()).toBe(1);
  });

  it("refuses unknown or duplicate evidence before host callbacks, and refuses changed call identity", async () => {
    const agent = defineAgent({
      ...base,
      provider: wire(calls("write"), text).provider,
      tools: [write()],
    });
    const policy = host();
    const waiting = pending(await agent.run("Write", { host: policy }));
    await expect(
      agent.resume(waiting.snapshot, { host: policy, answers: { unknown: "ticket" } }),
    ).rejects.toThrow("unknown");
    const corrupt = structuredClone(waiting.snapshot);
    firstRequest(corrupt).call.arguments = { forged: true };
    await expect(agent.resume(corrupt, { host: policy })).rejects.toThrow("request does not match");
    expect(policy.authorizeResume).not.toHaveBeenCalled();
    expect(policy.resolveRequest).not.toHaveBeenCalled();
    const done = await agent.resume(waiting.snapshot, {
      host: policy,
      answers: evidenceFor(waiting.snapshot, "ticket"),
    });
    policy.authorizeResume.mockClear();
    await expect(
      agent.resume(done.snapshot, {
        host: policy,
        answers: evidenceFor(waiting.snapshot, "ticket"),
      }),
    ).rejects.toThrow("already-decided");
    expect(policy.authorizeResume).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "validates edited arguments with the registered tool (valid %s)",
    async (valid) => {
      const effect = vi.fn(async (input: { count: number }) => input.count);
      const edited = defineTool({
        name: "write",
        description: "Write",
        inputSchema: { type: "object" },
        needsApproval: true,
        validate(raw) {
          if (
            typeof raw !== "object" ||
            raw === null ||
            !("count" in raw) ||
            typeof raw.count !== "number"
          )
            throw new Error("count must be a number");
          return { count: raw.count };
        },
        run: effect,
      });
      const agent = defineAgent({
        ...base,
        provider: wire(calls({ name: "write", args: { count: 1, removed: true } }), text).provider,
        tools: [edited],
      });
      const policy = host(() => ({ type: "approve", arguments: { count: valid ? 2 : "bad" } }));
      const prepare = policy.prepareRequest;
      const trusted = {
        ...policy,
        prepareRequest: () => ({
          ...prepare(),
          ask: { type: "approval" as const, editable: true },
        }),
      };
      const waiting = pending(await agent.run("Write", { host: trusted }));
      const done = await agent.resume(waiting.snapshot, {
        host: trusted,
        answers: evidenceFor(waiting.snapshot, "edit"),
      });
      expect(done.status).toBe("completed");
      expect(effect).toHaveBeenCalledTimes(valid ? 1 : 0);
      expect(policy.beforeTool.mock.calls[0]?.[0]).toMatchObject({
        arguments: { count: valid ? 2 : "bad" },
      });
      expect(done.history.find((message) => message.role === "tool")?.content).toContain(
        "reviewer replaced",
      );
      expect(records(done.snapshot)[0]?.decision?.type).toBe("approve");
    },
  );

  it("leaves forbidden edits and wrong decision kinds pending, then accepts a denial", async () => {
    const effect = vi.fn(async () => "Written");
    const agent = defineAgent({
      ...base,
      provider: wire(calls("write"), text).provider,
      tools: [write(effect)],
    });
    let decision: Decision = { type: "approve", arguments: { changed: true } };
    const policy = host(() => decision);
    let result = pending(await agent.run("Write", { host: policy }));
    for (const next of [decision, { type: "answer", answer: { text: "yes" } } satisfies Decision]) {
      decision = next;
      result = pending(
        await agent.resume(result.snapshot, {
          host: policy,
          answers: evidenceFor(result.snapshot, "evidence"),
        }),
      );
      expect(result.requests[0]?.problem?.code).toBe("invalid_answer");
    }
    decision = { type: "deny", message: "Keep the current record." };
    const done = await agent.resume(result.snapshot, {
      host: policy,
      answers: evidenceFor(result.snapshot, "deny"),
    });
    expect(done.history.find((message) => message.role === "tool")?.content).toBe(
      "Keep the current record.",
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(["expired", "stale"] as const)(
    "replaces a %s request without consuming old evidence",
    async (reason) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const effect = vi.fn(async () => "Written");
      const tool = write(effect);
      const model = wire(calls("write"), text);
      const agent = defineAgent({ ...base, provider: model.provider, tools: [tool] });
      const policy = host();
      const waiting = pending(await agent.run("Write", { host: policy }));
      if (reason === "expired") vi.setSystemTime(Date.now() + 60_001);
      const changed =
        reason === "stale"
          ? {
              ...tool,
              definition: () => ({ ...tool.definition(), description: "Changed meaning" }),
            }
          : tool;
      const rebuilt = defineAgent({ ...base, provider: model.provider, tools: [changed] });
      const renewed = pending(
        await rebuilt.resume(waiting.snapshot, {
          host: policy,
          answers: evidenceFor(waiting.snapshot, "old-ticket"),
        }),
      );
      expect(renewed.requests[0]?.id).not.toBe(waiting.requests[0]?.id);
      expect(records(renewed.snapshot)[0]?.closed).toBe(reason);
      expect(policy.resolveRequest).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
      await expect(
        rebuilt.resume(renewed.snapshot, {
          host: policy,
          answers: evidenceFor(waiting.snapshot, "old-ticket"),
        }),
      ).rejects.toThrow("closed");
    },
  );

  it("opens a real request when an inline approval expires before invocation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const effect = vi.fn(async () => "Written");
    const agent = defineAgent({
      ...base,
      provider: wire(calls("write")).provider,
      tools: [write(effect)],
    });
    const policy = host();
    const result = pending(
      await agent.run("Write", {
        host: {
          ...policy,
          answerNow: () => ({ type: "approve" }),
          prepareRequest: () => ({
            scope: {
              actorId: "person",
              resource: { id: "record", version: "1" },
              expiresAt: Date.now() + 5,
            },
          }),
        },
        onEvent(event) {
          if (event.type === "tool_start") vi.setSystemTime(Date.now() + 6);
        },
      }),
    );
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.problem?.code).toBe("expired");
    expect(effect).not.toHaveBeenCalled();
  });

  it("keeps the run deadline while host approval policy is pending", async () => {
    vi.useFakeTimers();
    const effect = vi.fn(async () => "Written");
    const tool = { ...write(effect), needsApproval: false };
    const agent = defineAgent({
      ...base,
      provider: wire(calls("write")).provider,
      tools: [tool],
      limits: { elapsedMs: 10 },
    });
    const work = agent.run("Write", {
      host: { ...host(), needsApproval: () => new Promise<boolean>(() => {}) },
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(await work).toMatchObject({ status: "limited", limit: "elapsedMs" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("does not use a consumed decision to approve a later call with the same wire id", async () => {
    const effect = vi.fn(async () => "Written");
    const agent = defineAgent({
      ...base,
      provider: wire(calls("write"), calls("write"), text).provider,
      tools: [write(effect)],
    });
    const policy = host();
    const first = pending(await agent.run("Write twice", { host: policy }));
    const second = pending(
      await agent.resume(first.snapshot, {
        host: policy,
        answers: evidenceFor(first.snapshot, "first-ticket"),
      }),
    );
    expect(effect).toHaveBeenCalledTimes(1);
    expect(second.requests[0]?.id).not.toBe(first.requests[0]?.id);
    await expect(
      agent.resume(second.snapshot, {
        host: policy,
        answers: evidenceFor(first.snapshot, "first-ticket"),
      }),
    ).rejects.toThrow("already-decided");
  });

  it("keeps consumed decisions in a checkpoint and rechecks authorization after a restart", async () => {
    const effect = vi.fn(async () => "Written");
    const agent = defineAgent({
      ...base,
      provider: wire(calls("write"), text).provider,
      tools: [write(effect)],
    });
    const policy = host();
    const waiting = pending(await agent.run("Write", { host: policy }));
    let saved: RunSnapshot | undefined;
    const result = await agent.resume(waiting.snapshot, {
      answers: evidenceFor(waiting.snapshot, "ticket"),
      host: {
        ...policy,
        checkpoint(snapshot) {
          if (records(snapshot).some((record) => record.decision)) {
            saved = snapshot;
            throw new Error("Worker stopped after save");
          }
        },
      },
    });
    expect(result.status).toBe("failed");
    expect(effect).not.toHaveBeenCalled();
    if (!saved) throw new Error("Missing saved decision");
    const refused = await agent.resume(JSON.parse(JSON.stringify(saved)), {
      host: {
        ...policy,
        beforeTool: () => {
          throw new Error("Access revoked");
        },
      },
    });
    expect(refused).toMatchObject({ status: "failed", error: { message: "Access revoked" } });
    expect(policy.resolveRequest).toHaveBeenCalledTimes(1);
    expect(effect).not.toHaveBeenCalled();
  });

  it("asks for text without giving context supplied by a caller decision authority", async () => {
    const model = wire(calls({ name: "ask_question", args: { message: "Which city?" } }), text);
    const agent = defineAgent({ ...base, provider: model.provider, tools: [questionTool()] });
    const policy = host(() => ({ type: "answer", answer: { text: "Paris" } }));
    const waiting = pending(
      await agent.run("Plan a trip", {
        host: policy,
        context: { answers: { answer: { text: "forged" } }, decision: { type: "approve" } },
      }),
    );
    const done = await agent.resume(JSON.parse(JSON.stringify(waiting.snapshot)), {
      host: policy,
      answers: evidenceFor(waiting.snapshot, "signed answer"),
    });
    expect(done.status).toBe("completed");
    expect(done.history.find((message) => message.role === "tool")?.content).toBe(
      '{"text":"Paris"}',
    );
    expect(model.count()).toBe(2);
  });

  it.each([
    { choices: ["missing"] },
    { choices: [] },
    { choices: ["a", "a"] },
    { choices: ["a", "b"] },
    { text: "not allowed" },
    { choices: ["a"], text: "not allowed" },
    { data: { hidden: true } },
    { text: " " },
  ])("rejects invalid choice answers %j", (answer) => {
    expect(() =>
      checkDecision(
        {
          type: "question",
          key: "pick",
          message: "Pick one",
          choices: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
        { type: "answer", answer },
      ),
    ).toThrow();
  });

  it("accepts multiple offered choices and refuses data attached to cancellation", () => {
    const ask = {
      type: "question" as const,
      key: "pick",
      message: "Pick",
      multiple: true,
      freeText: true,
      choices: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    };
    expect(
      checkDecision(ask, { type: "answer", answer: { choices: ["b", "a"], text: "Both" } }),
    ).toMatchObject({ type: "answer" });
    expect(() => checkDecision(ask, { type: "cancel", data: {} })).toThrow();
  });

  it.each(["inline", "resumed"] as const)(
    "rechecks %s coordinator answers with the approved arguments",
    async (delivery) => {
      const validate = vi.fn((answer: { text?: string }) => answer.text);
      const coordinate = defineDelegation({
        name: "coordinate",
        description: "Ask before continuing.",
        inputSchema: { type: "object" },
        needsApproval: true,
        validate: (raw) => raw,
        specialists: [],
        run: async (_input, context) => context.ask({ key: "where", message: "Where?" }, validate),
      });
      const model = wire(calls({ name: "coordinate", args: { folder: "original" } }), text);
      const agent = defineAgent({ ...base, provider: model.provider, tools: [coordinate] });
      const policy = host(() => ({ type: "answer", answer: { text: "Here" } }));
      const beforeTool = vi.fn<NonNullable<AgentHost["beforeTool"]>>((call, decided) => {
        expect(call.arguments).toEqual({ folder: "approved" });
        if (decided?.decision.type === "answer") throw new Error("Access revoked");
      });
      const trusted = {
        ...policy,
        beforeTool,
        prepareRequest: (request) => ({
          ...policy.prepareRequest(),
          ...(request.ask.type === "approval"
            ? { ask: { type: "approval" as const, editable: true } }
            : {}),
        }),
        answerNow(request) {
          if (request.ask.type === "approval")
            return { type: "approve", arguments: { folder: "approved" } };
          if (delivery === "inline") return { type: "answer", answer: { text: "Here" } };
          return undefined;
        },
      } satisfies AgentHost;
      const first = await agent.run("Ask", { host: trusted });
      const result =
        delivery === "inline"
          ? first
          : await agent.resume(pending(first).snapshot, {
              host: trusted,
              answers: evidenceFor(first.snapshot, "answer ticket"),
            });
      expect(result).toMatchObject({ status: "failed", error: { message: "Access revoked" } });
      expect(beforeTool.mock.calls.some(([, decided]) => decided?.decision.type === "answer")).toBe(
        true,
      );
      expect(validate).not.toHaveBeenCalled();
      expect(model.count()).toBe(1);
    },
  );

  it.each(["answerNow", "beforeTool"] as const)(
    "renews a coordinator answer that expires during %s before consuming it",
    async (boundary) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const validate = vi.fn((answer: { text?: string }) => answer.text);
      const coordinate = defineDelegation({
        name: "coordinate",
        description: "Ask before continuing.",
        inputSchema: { type: "object" },
        validate: () => null,
        specialists: [],
        run: async (_input, context) => context.ask({ key: "where", message: "Where?" }, validate),
      });
      const model = wire(calls("coordinate"), text);
      const agent = defineAgent({ ...base, provider: model.provider, tools: [coordinate] });
      const policy = host();
      const answerNow = vi.fn<NonNullable<AgentHost["answerNow"]>>(() => {
        if (boundary === "answerNow") vi.setSystemTime(Date.now() + 6);
        return { type: "answer", answer: { text: "Here" } };
      });
      const result = pending(
        await agent.run("Ask", {
          host: {
            ...policy,
            prepareRequest: () => ({
              scope: { ...policy.prepareRequest().scope, expiresAt: Date.now() + 5 },
            }),
            answerNow,
            beforeTool: (_call, decided) => {
              if (boundary === "beforeTool" && decided?.decision.type === "answer")
                vi.setSystemTime(Date.now() + 6);
            },
          },
        }),
      );
      expect(records(result.snapshot)).toMatchObject([
        { closed: "expired", decision: { type: "answer" } },
        { problem: { code: "expired" } },
      ]);
      expect(result.requests).toHaveLength(1);
      expect(answerNow).toHaveBeenCalledTimes(1);
      expect(validate).not.toHaveBeenCalled();
      expect(model.count()).toBe(1);
    },
  );

  it("replays pure coordination with typed forms and retains simultaneous requests", async () => {
    const values: number[] = [];
    const coordinate = defineDelegation({
      name: "coordinate",
      description: "Ask two questions.",
      inputSchema: { type: "object" },
      validate: () => null,
      specialists: [],
      async run(_input, context) {
        const answers = await Promise.all([
          context.ask(
            { key: "form", message: "How many?", schema: { type: "object" } },
            (answer) => {
              const data = answer.data;
              if (
                typeof data !== "object" ||
                data === null ||
                !("count" in data) ||
                typeof data.count !== "number"
              )
                throw new Error("count must be a number");
              return data.count;
            },
          ),
          context.ask({ key: "text", message: "Where?" }, (answer) => answer.text),
        ]);
        values.push(answers[0]);
        return answers;
      },
    });
    const agent = defineAgent({
      ...base,
      provider: wire(calls("coordinate"), text).provider,
      tools: [coordinate],
    });
    const policy = host((evidence) => ({ type: "answer", answer: { data: evidence } }));
    let result = pending(await agent.run("Ask", { host: policy }));
    expect(
      result.requests.map((request) => request.ask.type === "question" && request.ask.key),
    ).toEqual(["form", "text"]);
    const [form, freeText] = result.requests;
    if (!form || !freeText) throw new Error("Missing questions");
    result = pending(
      await agent.resume(result.snapshot, {
        host: policy,
        answers: { [form.id]: { count: "bad" } },
      }),
    );
    const all = {
      ...policy,
      resolveRequest: (request, _evidence) =>
        request.ask.type === "question" && request.ask.key === "text"
          ? { type: "answer" as const, answer: { text: "Here" } }
          : { type: "answer" as const, answer: { data: { count: 2 } } },
    } satisfies AgentHost;
    result = pending(
      await agent.resume(result.snapshot, { host: all, answers: { [freeText.id]: "text ticket" } }),
    );
    expect(result.requests[0]?.problem?.code).toBe("invalid_answer");
    expect(result.requests[0]?.id).not.toBe(form.id);
    const done = await agent.resume(result.snapshot, {
      host: all,
      answers: evidenceFor(result.snapshot, "form ticket"),
    });
    expect(done.status).toBe("completed");
    expect(values).toEqual([2]);
  });

  it("still suspends when a coordinator catches its question and ignores its promise", async () => {
    const coordinate = defineDelegation({
      name: "ask",
      description: "Ask",
      inputSchema: { type: "object" },
      validate: () => null,
      specialists: [],
      async run(_input, context) {
        void context
          .ask({ key: "one", message: "Continue?" }, (answer) => answer.text)
          .catch(() => {});
        return "ignored";
      },
    });
    const agent = defineAgent({
      ...base,
      provider: wire(calls("ask")).provider,
      tools: [coordinate],
    });
    expect(pending(await agent.run("Ask", { host: host() })).requests).toHaveLength(1);
  });

  it("collects sibling questions, resumes only the answered child and keeps settled usage", async () => {
    const one = wire(calls({ name: "ask_question", args: { message: "First?" } }), text);
    const two = wire(calls({ name: "ask_question", args: { message: "Second?" } }), text);
    const children = [one, two].map((model, index) =>
      defineAgent({
        ...base,
        id: `child-${index}`,
        provider: model.provider,
        tools: [questionTool()],
      }),
    );
    const coordinate = defineDelegation({
      name: "both",
      description: "Ask both",
      inputSchema: { type: "object" },
      validate: () => null,
      specialists: children,
      run: async (_input, context) =>
        context.join(children.map((child, index) => context.child(String(index), child, "Ask"))),
      summarize: () => "Answered",
    });
    const model = wire(calls("both"), text);
    const agent = defineAgent({ ...base, provider: model.provider, tools: [coordinate] });
    const policy = host(() => ({ type: "answer", answer: { text: "Yes" } }));
    const waiting = pending(await agent.run("Ask both", { host: policy }));
    expect(waiting.requests.map((request) => request.path[0]?.key)).toEqual(["0", "1"]);
    const partial = pending(
      await agent.resume(waiting.snapshot, {
        host: policy,
        answers: evidenceFor(waiting.snapshot, "first"),
      }),
    );
    expect([one.count(), two.count()]).toEqual([2, 1]);
    expect(partial.requests[0]?.path[0]?.key).toBe("1");
    expect(partial.treeUsage.inputTokens).toBe(12);
    const done = await agent.resume(JSON.parse(JSON.stringify(partial.snapshot)), {
      host: policy,
      answers: evidenceFor(partial.snapshot, "second"),
    });
    expect(done.status).toBe("completed");
    expect([one.count(), two.count(), model.count()]).toEqual([2, 2, 2]);
    expect(done.treeUsage.inputTokens).toBe(18);
  });

  it.each(["cancel", "stop"] as const)(
    "handles %s and keeps the session pending only while suspended",
    async (type) => {
      const store = createMemorySession();
      const load = vi.fn(store.load);
      const thread = { ...store, load };
      const model = wire(calls("write", "write"), text);
      const effect = vi.fn(async () => "Written");
      const agent = defineAgent({ ...base, provider: model.provider, tools: [write(effect)] });
      const policy = host(() => ({ type }));
      const waiting = pending(await agent.run("Write", { host: policy, session: thread }));
      expect(waiting.session?.status).toBe("pending");
      const done = await agent.resume(waiting.snapshot, {
        host: policy,
        session: thread,
        answers: Object.fromEntries(
          waiting.requests.map((request) => [request.id, "cancel ticket"]),
        ),
      });
      expect(done.status).toBe(type === "stop" ? "cancelled" : "completed");
      expect(done.session?.status).toBe("saved");
      expect(load).toHaveBeenCalledTimes(1);
      expect(model.count()).toBe(type === "stop" ? 1 : 2);
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("allows two explicit pre-effect questions but never replays an unknown invocation", async () => {
    let effects = 0;
    const preflight = defineTool({
      name: "preflight",
      description: "Ask before writing.",
      inputSchema: { type: "object" },
      async run(_input, context) {
        if (!answerOf(context, "first"))
          throw new InputRequired({ key: "first", message: "First?" });
        if (!answerOf(context, "second"))
          throw new InputRequired({ key: "second", message: "Second?" });
        effects++;
        return "Written";
      },
    });
    const agent = defineAgent({
      ...base,
      provider: wire(calls("preflight"), text).provider,
      tools: [preflight],
    });
    const policy = host(() => ({ type: "answer", answer: { text: "Yes" } }));
    const first = pending(await agent.run("Write", { host: policy }));
    const second = pending(
      await agent.resume(first.snapshot, {
        host: policy,
        answers: evidenceFor(first.snapshot, "first"),
      }),
    );
    expect(records(second.snapshot)).toHaveLength(2);
    let durable: RunSnapshot | undefined;
    await agent.resume(second.snapshot, {
      answers: evidenceFor(second.snapshot, "second"),
      host: {
        ...policy,
        checkpoint(snapshot) {
          const execution = snapshot.models[0];
          if (execution?.status === "completed" && execution.tools[0]?.status === "completed")
            throw new Error("Lost receipt");
          durable = snapshot;
        },
      },
    });
    expect(effects).toBe(1);
    if (!durable) throw new Error("Missing journal");
    const recovered = await agent.resume(durable, { host: policy });
    expect(recovered).toMatchObject({ status: "failed", error: { code: "interrupted_operation" } });
    expect(effects).toBe(1);
  });

  it("requires host approval for unmarked tools and for a delegation", async () => {
    const effect = vi.fn(async () => "Written");
    const ordinary = { ...write(effect), needsApproval: false };
    const coordinate = defineDelegation({
      name: "coordinate",
      description: "Coordinate",
      inputSchema: { type: "object" },
      validate: () => null,
      specialists: [],
      needsApproval: true,
      run: async () => "Done",
    });
    const agent = defineAgent({
      ...base,
      provider: wire(calls("write", "coordinate"), text).provider,
      tools: [ordinary, coordinate],
    });
    const policy = { ...host(), needsApproval: () => true };
    const result = pending(await agent.run("Write", { host: policy }));
    expect(result.requests).toHaveLength(2);
    const done = await agent.resume(result.snapshot, {
      host: policy,
      answers: Object.fromEntries(result.requests.map((request) => [request.id, "ticket"])),
    });
    expect(done.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(1);
  });
});

describe("client tools", () => {
  function client() {
    return defineClientTool({
      name: "pick",
      description: "Choose a file in the client.",
      inputSchema: { type: "object" },
      validate: () => null,
      result: {
        schema: { type: "object" },
        validate(raw) {
          if (
            typeof raw !== "object" ||
            raw === null ||
            !("id" in raw) ||
            typeof raw.id !== "string"
          )
            throw new Error("A result needs a file id.");
          return { id: raw.id };
        },
      },
    });
  }
  it("validates a deferred result and never resends the client call on reconnect or restart", async () => {
    const model = wire(calls("pick"), text);
    const agent = defineAgent({ ...base, provider: model.provider, tools: [client()] });
    let value: unknown = { invalid: true };
    const policy = host(() => ({ type: "result", value }));
    const waiting = pending(await agent.run("Pick", { host: policy }));
    expect(waiting.requests[0]?.ask.type).toBe("client");
    const event = vi.fn();
    const reconnect = pending(
      await agent.resume(waiting.snapshot, { host: policy, onEvent: event }),
    );
    expect(reconnect.requests[0]?.id).toBe(waiting.requests[0]?.id);
    expect(event.mock.calls.some(([item]) => item.type === "request")).toBe(false);
    const invalid = pending(
      await agent.resume(reconnect.snapshot, {
        host: policy,
        answers: evidenceFor(reconnect.snapshot, "result ticket"),
      }),
    );
    expect(invalid.requests[0]?.problem?.code).toBe("invalid_answer");
    value = { id: "upload-1" };
    const rebuilt = defineAgent({ ...base, provider: model.provider, tools: [client()] });
    const done = await rebuilt.resume(JSON.parse(JSON.stringify(invalid.snapshot)), {
      host: policy,
      answers: evidenceFor(invalid.snapshot, "valid result ticket"),
      onEvent: event,
    });
    expect(done.status).toBe("completed");
    expect(done.history.find((message) => message.role === "tool")?.content).toBe(
      '{"id":"upload-1"}',
    );
    expect(event.mock.calls.some(([item]) => item.type === "request")).toBe(false);
    await rebuilt.resume(done.snapshot, { host: policy, onEvent: event });
    expect(model.count()).toBe(2);
  });

  it("dispatches and restores approved client arguments without changing the model call", async () => {
    const model = wire(calls({ name: "pick", args: { folder: "original" } }), text);
    const agent = defineAgent({
      ...base,
      provider: model.provider,
      tools: [{ ...client(), needsApproval: true }],
    });
    const policy = host((evidence) =>
      evidence === "approval ticket"
        ? { type: "approve", arguments: { folder: "approved" } }
        : { type: "result", value: { id: "upload-1" } },
    );
    const trusted = {
      ...policy,
      prepareRequest: (request) => ({
        ...policy.prepareRequest(),
        ...(request.ask.type === "approval"
          ? { ask: { type: "approval" as const, editable: true } }
          : {}),
      }),
    } satisfies AgentHost;
    const approval = pending(await agent.run("Pick", { host: trusted }));
    const events: AgentEvent[] = [];
    let saved: RunSnapshot | undefined;
    const dispatched = pending(
      await agent.resume(approval.snapshot, {
        host: {
          ...trusted,
          checkpoint: (snapshot) => {
            saved = snapshot;
          },
        },
        answers: evidenceFor(approval.snapshot, "approval ticket"),
        onEvent: (event) => {
          events.push(event);
        },
      }),
    );
    const dispatch = dispatched.requests[0];
    expect(dispatch).toMatchObject({
      ask: { type: "client" },
      call: { arguments: { folder: "approved" }, call: { arguments: '{"folder":"original"}' } },
    });
    expect(events.find((event) => event.type === "request")).toMatchObject({ request: dispatch });
    if (!saved) throw new Error("Missing client checkpoint");
    expect(records(saved)[1]?.request).toEqual(dispatch);
    expect(records(saved)[0]?.request.call.arguments).toEqual({ folder: "original" });
    const corrupted = structuredClone(saved);
    const clientRequest = records(corrupted)[1];
    if (!clientRequest) throw new Error("Missing client request");
    clientRequest.request.call.arguments = { folder: "forged" };
    const authorize = policy.authorizeResume.mock.calls.length;
    await expect(agent.resume(corrupted, { host: trusted })).rejects.toThrow(
      "request does not match",
    );
    expect(policy.authorizeResume).toHaveBeenCalledTimes(authorize);
    const onEvent = vi.fn();
    const reconnected = pending(
      await agent.resume(JSON.parse(JSON.stringify(saved)), {
        host: trusted,
        onEvent,
      }),
    );
    expect(reconnected.requests).toEqual(dispatched.requests);
    const done = await agent.resume(reconnected.snapshot, {
      host: trusted,
      answers: evidenceFor(reconnected.snapshot, "result ticket"),
      onEvent,
    });
    expect(done.status).toBe("completed");
    expect(
      policy.beforeTool.mock.calls.every(([call]) => call.arguments.folder === "approved"),
    ).toBe(true);
    expect(onEvent.mock.calls.some(([event]) => event.type === "request")).toBe(false);
    expect(model.count()).toBe(2);
  });

  it("never renews an expired client call whose external outcome could be unknown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const agent = defineAgent({
      ...base,
      provider: wire(calls("pick")).provider,
      tools: [client()],
    });
    const policy = host();
    const waiting = pending(await agent.run("Pick", { host: policy }));
    vi.setSystemTime(Date.now() + 60_001);
    const onEvent = vi.fn();
    const failed = await agent.resume(waiting.snapshot, { host: policy, onEvent });
    expect(failed).toMatchObject({ status: "failed", error: { code: "client_result_unknown" } });
    expect(onEvent.mock.calls.some(([item]) => item.type === "request")).toBe(false);
  });
});
