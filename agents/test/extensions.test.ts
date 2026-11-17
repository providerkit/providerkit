import { describe, expect, it, vi } from "vitest";
import { assertAgent } from "./fixtures/assertions.ts";
import {
  collectTurn,
  defineTool,
  type ChatMessage,
  type ImagePart,
  type Provider,
  type ProviderChunk,
  type ToolSpec,
} from "@providerkit/core";
import {
  createMemoryInbox,
  createMemorySession,
  defineAgent,
  defineClientTool,
  defineDelegation,
  defineHandoff,
  type AgentHost,
  type Guardrails,
  type LifecycleEvent,
  type RunSnapshot,
} from "../src/index.ts";
import { evidenceFor } from "./fixtures/requests.ts";

const base = { id: "extensions", version: "1", instructions: "Use tools, then answer." };
const authorizeResume = () => {};
const allow = () => ({ allow: true as const });
const image: ImagePart = { type: "image", mimeType: "image/png", data: "AQID" };
const usage = { inputTokens: 5, outputTokens: 3, cachedInputTokens: 0 };

function text(content = "Done"): ProviderChunk[] {
  return [
    { type: "delta", content },
    { type: "usage", usage },
    { type: "finish", finishReason: "stop" },
  ];
}
function call(name: string, args: Record<string, unknown> = {}): ProviderChunk[] {
  return [
    { type: "delta", toolCalls: [{ index: 0, id: "call", name, arguments: JSON.stringify(args) }] },
    { type: "finish", finishReason: "tool_calls" },
  ];
}
function fake(turns: ProviderChunk[][], log?: string[]) {
  const requests: ChatMessage[][] = [];
  const provider: Provider = {
    id: "fake",
    model: "offline",
    async *createStream(messages) {
      const chunks = turns[requests.length];
      requests.push(structuredClone(messages));
      log?.push("provider");
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
    run: async () => ({ count: 2 }),
    ...spec,
  });
}
function saved(value: RunSnapshot | undefined): RunSnapshot {
  if (!value) throw new Error("Expected a checkpoint");
  return value;
}
const approval: AgentHost = {
  prepareRequest: ({ ask }) => ({
    scope: {
      actorId: "actor",
      resource: { id: "resource", version: "1" },
      expiresAt: Date.now() + 60_000,
    },
    ...(ask.type === "approval" ? { ask: { type: "approval" as const, editable: true } } : {}),
  }),
  beforeTool: () => {},
  resolveRequest: () => ({ type: "approve", arguments: { count: 3 } }),
};

describe("lifecycle and guard boundaries", () => {
  it("orders awaited observers, guards, host checks and checked progress on real turns", async () => {
    const log: string[] = [];
    const wire = fake([call("lookup"), text()], log);
    const hooks: LifecycleEvent[] = [];
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [
        tool("lookup", {
          run: async () => {
            log.push("invoke");
            return { count: 2 };
          },
        }),
      ],
      onLifecycle: async (event) => {
        await Promise.resolve();
        hooks.push(event);
        log.push(event.type);
      },
      guardrails: {
        identity: "checks-1",
        modelInput: () => {
          log.push("modelInput");
          return allow();
        },
        modelOutput: () => {
          log.push("modelOutput");
          return allow();
        },
        toolInput: () => {
          log.push("toolInput");
          return allow();
        },
        toolOutput: () => {
          log.push("toolOutput");
          return allow();
        },
      },
    });
    const result = await agent.run("Look up the count", {
      onLifecycle: (event) => {
        log.push(`host:${event.type}`);
      },
      onEvent: (event) => {
        if (event.type === "tool_result") log.push("published-tool");
      },
      host: {
        beforeTool: () => {
          log.push("authorize");
        },
      },
    });
    expect(result.status).toBe("completed");
    expect(log).toEqual([
      "run_start",
      "host:run_start",
      "modelInput",
      "model_start",
      "host:model_start",
      "provider",
      "model_end",
      "host:model_end",
      "modelOutput",
      "toolInput",
      "tool_start",
      "host:tool_start",
      "authorize",
      "invoke",
      "tool_end",
      "host:tool_end",
      "toolOutput",
      "published-tool",
      "modelInput",
      "model_start",
      "host:model_start",
      "provider",
      "model_end",
      "host:model_end",
      "modelOutput",
      "run_end",
      "host:run_end",
    ]);
    expect(hooks.every(Object.isFrozen)).toBe(true);
    expect(result.snapshot.guards).toHaveLength(6);
    expect(result.snapshot.guards.every((guard) => guard.status === "allowed")).toBe(true);
    expect(result.snapshot.definition.guardrails).toEqual({
      identity: "checks-1",
      stages: ["modelInput", "modelOutput", "toolInput", "toolOutput"],
      maxOutputBytes: 1_000_000,
    });
  });

  it("observer exceptions cannot deny work, allow a denied request or waive the last host check", async () => {
    const wire = fake([call("write"), text()]);
    const effect = vi.fn(async () => "written");
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("write", { run: effect, needsApproval: true })],
      onLifecycle: () => {
        throw new Error("Observer is not policy");
      },
      guardrails: { identity: "allow", toolInput: allow },
    });
    const waiting = await agent.run("Write", { host: approval });
    expect(waiting.status).toBe("suspended");
    const denied = await agent.resume(waiting.snapshot, {
      answers: evidenceFor(waiting.snapshot, "deny"),
      host: { ...approval, authorizeResume, resolveRequest: () => ({ type: "deny" }) },
    });
    expect(denied.status).toBe("completed");
    expect(effect).not.toHaveBeenCalled();

    const second = fake([call("write")]);
    let authorized = true;
    const revoked = await defineAgent({
      ...base,
      provider: second.provider,
      tools: [tool("write", { run: effect })],
      onLifecycle: (event) => {
        if (event.type === "tool_start") authorized = false;
      },
      guardrails: { identity: "allow", toolInput: allow },
    }).run("Write", {
      host: {
        beforeTool: () => {
          if (!authorized) throw new Error("Access revoked");
        },
      },
    });
    expect(revoked.status).toBe("failed");
    expect(effect).not.toHaveBeenCalled();
  });

  it("blocks model input before provider dispatch, including new inbox input", async () => {
    const wire = fake([call("lookup"), text()]);
    const inbox = createMemoryInbox("guard-input");
    const effect = vi.fn(async () => {
      inbox.enqueue({ id: "extra", content: "private" });
      return "read";
    });
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("lookup", { run: effect })],
      guardrails: {
        identity: "input",
        modelInput: ({ messages }) => ({ allow: !JSON.stringify(messages).includes("private") }),
      },
    });
    const result = await agent.run("Read", { runId: "guard-input", host: { inbox } });
    expect(result).toMatchObject({ status: "failed", error: { code: "guard_rejected" } });
    expect(wire.requests).toHaveLength(1);
    expect(effect).toHaveBeenCalledOnce();
    expect(result.inputs[0]?.status).toBe("accepted");
    const first = fake([text()]);
    const refused = await defineAgent({
      ...base,
      provider: first.provider,
      guardrails: { identity: "refuse", modelInput: () => ({ allow: false }) },
    }).run("No");
    expect(refused.status).toBe("failed");
    expect(first.requests).toHaveLength(0);
  });

  it("checks approved effective arguments before invoking and keeps core validation", async () => {
    const wire = fake([call("write", { count: 1 })]);
    const effect = vi.fn(async () => "written");
    const input = vi.fn((request) => ({ allow: request.arguments.count === 1 }));
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("write", { needsApproval: true, run: effect })],
      guardrails: { identity: "edited", toolInput: input },
    });
    const waiting = await agent.run("Write", { host: approval });
    const result = await agent.resume(waiting.snapshot, {
      answers: evidenceFor(waiting.snapshot, "approve"),
      host: { ...approval, authorizeResume },
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "guard_rejected" } });
    expect(input.mock.calls[0]?.[0].arguments).toEqual({ count: 3 });
    expect(effect).not.toHaveBeenCalled();
    expect(wire.requests).toHaveLength(1);

    const invalid = fake([call("write"), text()]);
    const rejected = await defineAgent({
      ...base,
      provider: invalid.provider,
      tools: [
        tool("write", {
          validate: () => {
            throw new Error("count is required");
          },
          run: effect,
        }),
      ],
      guardrails: { identity: "allow", toolInput: allow },
    }).run("Write");
    expect(rejected.status).toBe("completed");
    expect(effect).not.toHaveBeenCalled();
    expect(invalid.requests[1]?.at(-1)?.content).toContain("count is required");
  });

  it("rejects a client dispatch and a handoff before exposing work", async () => {
    const clientWire = fake([call("client")]);
    const prepareRequest = vi.fn(approval.prepareRequest);
    const client = defineClientTool({
      name: "client",
      description: "client",
      inputSchema: { type: "object" },
      validate: (raw) => raw,
      result: { schema: { type: "object" }, validate: (raw) => raw },
    });
    const result = await defineAgent({
      ...base,
      provider: clientWire.provider,
      tools: [client],
      guardrails: { identity: "no-client", toolInput: () => ({ allow: false }) },
    }).run("Run", { host: { ...approval, prepareRequest } });
    expect(result.status).toBe("failed");
    expect(prepareRequest).not.toHaveBeenCalled();
    const targetWire = fake([text()]);
    const target = defineAgent({ ...base, id: "target", provider: targetWire.provider });
    const sourceWire = fake([call("transfer")]);
    const source = defineAgent({
      ...base,
      provider: sourceWire.provider,
      tools: [defineHandoff({ name: "transfer", description: "Transfer", to: target })],
      guardrails: { identity: "no-handoff", toolInput: () => ({ allow: false }) },
    });
    const refused = await source.run("Transfer");
    expect(refused.status).toBe("failed");
    expect(targetWire.requests).toHaveLength(0);
    expect(refused.activeAgent.id).toBe(base.id);
  });

  it.each(["hook", "guard"] as const)(
    "cancellation stops waiting for an uncooperative %s without dispatch",
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const late = Promise.withResolvers<{ allow: true }>();
      const controller = new AbortController();
      const wire = fake([text()]);
      let callbackSignal: AbortSignal | undefined;
      const agent = defineAgent({
        ...base,
        provider: wire.provider,
        ...(kind === "hook"
          ? {
              onLifecycle: async (_event: LifecycleEvent, context: { signal: AbortSignal }) => {
                callbackSignal = context.signal;
                entered.resolve();
                await late.promise;
              },
            }
          : {
              guardrails: {
                identity: "pending",
                modelInput: (_input, context) => {
                  callbackSignal = context.signal;
                  entered.resolve();
                  return late.promise;
                },
              } satisfies Guardrails,
            }),
      });
      const pending = agent.run("Wait", { signal: controller.signal });
      await entered.promise;
      controller.abort();
      expect(await pending).toMatchObject({ status: "cancelled" });
      expect(callbackSignal?.aborted).toBe(true);
      late.resolve({ allow: true });
      await Promise.resolve();
      expect(wire.requests).toHaveLength(0);
    },
  );
});

describe("withheld output and recovery", () => {
  it("withholds every model chunk and tool dispatch until the full output verdict", async () => {
    const waiting = Promise.withResolvers<void>();
    const verdict = Promise.withResolvers<{ allow: false }>();
    const wire = fake([
      [{ type: "delta", content: "private", reasoning: "private reasoning" }, ...call("write")],
    ]);
    const effect = vi.fn(async () => "written");
    const chunks: unknown[] = [];
    const privateHooks: LifecycleEvent[] = [];
    const checkpoints: RunSnapshot[] = [];
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("write", { run: effect })],
      onLifecycle: (event) => {
        privateHooks.push(event);
      },
      guardrails: {
        identity: "output",
        modelOutput: () => {
          waiting.resolve();
          return verdict.promise;
        },
      },
    });
    const pending = agent.run("Write", {
      onEvent: (event) => {
        chunks.push(event);
      },
      host: {
        checkpoint: (snapshot) => {
          assertAgent(snapshot);
          checkpoints.push(snapshot);
        },
      },
    });
    await waiting.promise;
    expect(chunks).toEqual([]);
    expect(effect).not.toHaveBeenCalled();
    expect(JSON.stringify(checkpoints)).not.toContain("private");
    expect(JSON.stringify(privateHooks)).toContain("private reasoning");
    verdict.resolve({ allow: false });
    const result = await pending;
    expect(result).toMatchObject({ status: "failed", error: { code: "guard_rejected" } });
    expect(JSON.stringify(chunks)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(effect).not.toHaveBeenCalled();
    expect(wire.requests).toHaveLength(1);
  });

  it("releases allowed buffered chunks in order only after their checked receipt is saved", async () => {
    const wire = fake([text("Allowed")]);
    const chunks: ProviderChunk[] = [];
    let checked = false;
    let persisted = false;
    let premature = false;
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      guardrails: {
        identity: "output",
        modelOutput: () => {
          checked = true;
          return allow();
        },
      },
    });
    const result = await agent.run("Answer", {
      host: {
        checkpoint: (snapshot) => {
          assertAgent(snapshot);
          if (snapshot.models[0]?.status === "completed") persisted = true;
        },
      },
      onEvent: (event) => {
        if (event.type === "model_chunk") {
          premature ||= !checked || !persisted;
          chunks.push(event.chunk);
        }
      },
    });
    expect(result).toMatchObject({ status: "completed", output: "Allowed" });
    expect(premature).toBe(false);
    expect(chunks).toHaveLength(1);
    expect(
      await collectTurn(
        (async function* () {
          yield* chunks;
        })(),
      ),
    ).toEqual(
      result.snapshot.models[0]?.status === "completed" ? result.snapshot.models[0].turn : null,
    );
    expect(result.usage).toMatchObject(usage);
  });

  it("never replays uninspected metadata replaced while collecting a guarded turn", async () => {
    const wire = fake([
      [
        { type: "delta", reasoningDetails: [{ text: "private-old-metadata" }] },
        { type: "delta", reasoningDetails: [{ text: "Allowed metadata" }] },
        ...text("Allowed"),
      ],
    ]);
    const events: unknown[] = [];
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      guardrails: {
        identity: "metadata",
        modelOutput: (turn) => ({ allow: !JSON.stringify(turn).includes("private") }),
      },
    }).run("Answer", {
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.status).toBe("completed");
    expect(JSON.stringify(events)).not.toContain("private-old-metadata");
    expect(JSON.stringify(events)).toContain("Allowed metadata");
  });

  it.each(["bytes", "chunks"] as const)(
    "bounds withheld model %s and retains reported usage without content",
    async (bound) => {
      const chunks: ProviderChunk[] =
        bound === "bytes"
          ? [{ type: "delta", reasoning: "private".repeat(100) }]
          : Array.from({ length: 4_097 }, () => ({ type: "delta" }));
      const wire = fake([[{ type: "usage", usage }, ...chunks, ...text("Never")]]);
      const inspect = vi.fn(allow);
      const events: unknown[] = [];
      const result = await defineAgent({
        ...base,
        provider: wire.provider,
        guardrails: {
          identity: "bound",
          maxOutputBytes: bound === "bytes" ? 200 : 1_000_000,
          modelOutput: inspect,
        },
      }).run("Answer", {
        onEvent: (event) => {
          events.push(event);
        },
      });
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "guard_output_limit" },
        usage,
      });
      expect(inspect).not.toHaveBeenCalled();
      expect(JSON.stringify(events)).not.toContain("private");
      expect(result.history).toEqual([{ role: "user", content: "Answer" }]);
    },
  );

  it("a rejected tool result reaches neither the next model, progress nor terminal output", async () => {
    const wire = fake([call("finish")]);
    const effect = vi.fn(async () => ({ secret: "private-result" }));
    const observed: unknown[] = [];
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("finish", { run: effect, isTerminal: true })],
      guardrails: { identity: "tool-output", toolOutput: () => ({ allow: false }) },
      recovery: { identity: "read", maxAttempts: 2, readOnlyTools: [] },
    });
    const result = await agent.run("Finish", {
      onEvent: (event) => {
        observed.push(event);
      },
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "guard_rejected" } });
    expect(JSON.stringify(result)).not.toContain("private-result");
    expect(JSON.stringify(observed)).not.toContain("private-result");
    expect(wire.requests).toHaveLength(1);
    await agent.resume(result.snapshot, { host: { authorizeResume } });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("does not publish a client result through an earlier decision event", async () => {
    const wire = fake([call("client")]);
    const client = defineClientTool({
      name: "client",
      description: "Client",
      inputSchema: { type: "object" },
      validate: (raw) => raw,
      result: { schema: { type: "object" }, validate: (raw) => raw },
    });
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [client],
      guardrails: { identity: "client-output", toolOutput: () => ({ allow: false }) },
    });
    const waiting = await agent.run("Read", { host: approval });
    const events: unknown[] = [];
    const progress: unknown[] = [];
    const result = await agent.resume(waiting.snapshot, {
      answers: evidenceFor(waiting.snapshot, "result"),
      onEvent: (event) => {
        events.push(event);
      },
      host: {
        ...approval,
        authorizeResume,
        resolveRequest: () => ({ type: "result", value: { secret: "private-client" } }),
        progress: {
          push: (event) => {
            progress.push(event);
          },
          flush: async () => {},
        },
      },
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "guard_rejected" } });
    expect(JSON.stringify(events)).not.toContain("private-client");
    expect(JSON.stringify(progress)).not.toContain("private-client");
    expect(JSON.stringify(result.history)).not.toContain("private-client");
    // The private authority journal must retain the accepted decision, even on rejection.
    expect(JSON.stringify(result.snapshot)).toContain("private-client");
    expect(wire.requests).toHaveLength(1);
  });

  it("bounds rich tool output before publishing it, and does not retry the effect", async () => {
    const wire = fake([call("read")]);
    const effect = vi.fn(async () => [{ type: "text", text: "private".repeat(100) }, image]);
    const guard = vi.fn(allow);
    const events: unknown[] = [];
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("read", { run: effect, isReadOnly: true })],
      guardrails: { identity: "limit", maxOutputBytes: 100, toolOutput: guard },
    }).run("Read", {
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "guard_output_limit" } });
    expect(guard).not.toHaveBeenCalled();
    expect(effect).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toContain("private");
    expect(wire.requests).toHaveLength(1);
  });

  it("a rejected specialist guard stops its parent and never leaks the child's output", async () => {
    const childWire = fake([text("private-child")]);
    const child = defineAgent({
      ...base,
      id: "child",
      provider: childWire.provider,
      guardrails: { identity: "child-output", modelOutput: () => ({ allow: false }) },
    });
    const wire = fake([call("review", { input: "Review" })]);
    const events: unknown[] = [];
    const hooks: string[] = [];
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      tools: [child.asTool({ name: "review", description: "Review" })],
    }).run("Review", {
      onEvent: (event) => {
        events.push(event);
      },
      onLifecycle: (event, context) => {
        hooks.push(`${context.agentId}:${event.type}`);
      },
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "guard_rejected" } });
    expect(hooks).toContain("child:run_start");
    expect(JSON.stringify(events)).not.toContain("private-child");
    expect(JSON.stringify(result)).not.toContain("private-child");
    expect(wire.requests).toHaveLength(1);
  });

  it("keeps a checked terminal tool's raw candidate and rich receipt through guard recovery", async () => {
    const wire = fake([call("finish")]);
    const effect = vi.fn(async () => ({ count: 2 }));
    const guard = vi.fn(allow);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("finish", { run: effect, isTerminal: true, summarize: () => "Two" })],
      output: {
        schema: { type: "object" },
        validate: (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            !("count" in value) ||
            typeof value.count !== "number"
          )
            throw new Error("count must be a number");
          return value.count * 2;
        },
      },
      guardrails: { identity: "terminal", toolOutput: guard },
    });
    let checkpoint: RunSnapshot | undefined;
    const first = await agent.run("Finish", {
      host: {
        checkpoint: (snapshot) => {
          assertAgent(snapshot);
          if (
            snapshot.state.status === "running" &&
            snapshot.models[0]?.status === "completed" &&
            snapshot.models[0].tools[0]?.status === "completed"
          )
            checkpoint = structuredClone(snapshot);
        },
      },
    });
    expect(first).toMatchObject({ status: "completed", output: 4 });
    expect(first.snapshot.models[0]).toMatchObject({
      tools: [{ result: { output: { count: 2 }, final: { candidate: { count: 2 } } } }],
    });
    const resumed = await agent.resume(saved(checkpoint), { host: { authorizeResume } });
    expect(resumed).toMatchObject({ status: "completed", output: 4 });
    expect(effect).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledOnce();
    expect(wire.requests).toHaveLength(1);
  });

  it("guard callback failures redact their exception and never turn into effect retries", async () => {
    const wire = fake([call("read")]);
    const effect = vi.fn(async () => "private-result");
    const guard = vi.fn(() => {
      throw new Error("private-result token=credential");
    });
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("read", { run: effect, isReadOnly: true })],
      recovery: { identity: "read-only", maxAttempts: 2, readOnlyTools: ["read"] },
      guardrails: { identity: "broken", toolOutput: guard },
    });
    const result = await agent.run("Read");
    expect(result).toMatchObject({ status: "failed", error: { code: "guard_failed" } });
    expect(JSON.stringify(result)).not.toContain("private-result");
    expect(JSON.stringify(result)).not.toContain("credential");
    await agent.resume(result.snapshot, { host: { authorizeResume, beforeTool: () => {} } });
    expect(effect).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledOnce();
  });

  it.each(["running", "allowed"] as const)(
    "refuses recovery from a %s output check instead of replaying the effect",
    async (status) => {
      const wire = fake([call("read"), text()]);
      const effect = vi.fn(async () => "read");
      const guard = vi.fn(allow);
      const agent = defineAgent({
        ...base,
        provider: wire.provider,
        tools: [tool("read", { run: effect, isReadOnly: true })],
        recovery: { identity: "read", maxAttempts: 3, readOnlyTools: ["read"] },
        guardrails: { identity: "result", toolOutput: guard },
      });
      let checkpoint: RunSnapshot | undefined;
      await agent.run("Read", {
        host: {
          checkpoint: (snapshot) => {
            assertAgent(snapshot);
            if (
              snapshot.guards.at(-1)?.status === status &&
              snapshot.models[0]?.status === "completed" &&
              snapshot.models[0].tools[0]?.status === "running"
            )
              checkpoint = structuredClone(snapshot);
          },
        },
      });
      const result = await agent.resume(saved(checkpoint), {
        host: { authorizeResume, beforeTool: () => {} },
      });
      expect(result).toMatchObject({
        status: "failed",
        error: { code: status === "running" ? "interrupted_guard" : "guarded_output_unsettled" },
      });
      expect(effect).toHaveBeenCalledOnce();
      expect(guard).toHaveBeenCalledOnce();
    },
  );

  it("restores completed checked results without rerunning guards and rejects missing verdicts or policy changes", async () => {
    const wire = fake([call("submit_result", { count: 2 })]);
    const guard = vi.fn(allow);
    const validate = (raw: unknown) => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("count" in raw) ||
        typeof raw.count !== "number"
      )
        throw new Error("count must be a number");
      return new Date(raw.count);
    };
    const config = {
      ...base,
      provider: wire.provider,
      output: { schema: { type: "object" as const }, validate },
      guardrails: { identity: "checked", modelOutput: guard, toolOutput: guard },
    };
    const agent = defineAgent(config);
    const result = await agent.run("Count");
    expect(result).toMatchObject({ status: "completed", output: new Date(2) });
    const resumed = await agent.resume(JSON.parse(JSON.stringify(result.snapshot)), {
      host: { authorizeResume },
    });
    expect(resumed).toMatchObject({ status: "completed", output: new Date(2) });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(wire.requests).toHaveLength(1);
    await expect(
      agent.resume({ ...result.snapshot, guards: [] }, { host: { authorizeResume } }),
    ).rejects.toThrow("guard verdict");
    const forged = structuredClone(result.snapshot);
    const model = forged.models[0];
    if (
      model?.status !== "completed" ||
      model.tools[0]?.status !== "completed" ||
      !model.tools[0].result.ok
    )
      throw new Error("Expected checked result receipt");
    model.tools[0].result.final = { candidate: { count: 99 } };
    forged.state = { status: "completed", candidate: { count: 99 } };
    await expect(agent.resume(forged, { host: { authorizeResume } })).rejects.toThrow(
      "effective arguments",
    );
    const changed = defineAgent({
      ...config,
      guardrails: { ...config.guardrails, identity: "changed" },
    });
    await expect(changed.resume(result.snapshot, { host: { authorizeResume } })).rejects.toThrow(
      "guard policy changed",
    );
  });

  it("safe inference replay still checks the new attempt and hosted effects still refuse replay", async () => {
    const wire = fake([text(), text()]);
    const guard = vi.fn(allow);
    const config = {
      ...base,
      provider: wire.provider,
      recovery: { identity: "inference", maxAttempts: 2, inferenceOnly: true },
      guardrails: { identity: "guard", modelInput: guard, modelOutput: guard },
    };
    const agent = defineAgent(config);
    let checkpoint: RunSnapshot | undefined;
    await agent.run("Answer", {
      host: {
        checkpoint: (snapshot) => {
          assertAgent(snapshot);
          if (snapshot.models[0]?.status === "running" && snapshot.guards.length === 1)
            checkpoint = structuredClone(snapshot);
        },
      },
    });
    const result = await agent.resume(saved(checkpoint), { host: { authorizeResume } });
    expect(result.status).toBe("completed");
    expect(wire.requests).toHaveLength(2);
    expect(result.snapshot.models[0]?.interrupted).toHaveLength(1);
    expect(guard).toHaveBeenCalledTimes(4);

    const hostedWire = fake([text()]);
    const hosted = defineAgent({
      ...config,
      provider: hostedWire.provider,
      modelSettings: { hostedTools: [{ type: "web_search" }] },
    });
    await hosted.run("Answer", {
      host: {
        checkpoint: (snapshot) => {
          assertAgent(snapshot);
          if (snapshot.models[0]?.status === "running" && snapshot.guards.length === 1)
            checkpoint = structuredClone(snapshot);
        },
      },
    });
    expect(await hosted.resume(saved(checkpoint), { host: { authorizeResume } })).toMatchObject({
      status: "failed",
      error: { code: "interrupted_operation" },
    });
    expect(hostedWire.requests).toHaveLength(1);
  });
});

describe("core tool outputs", () => {
  it("sends text and image parts to the next real fake-provider turn and preserves session/resume identity", async () => {
    const wire = fake([call("picture"), text("Three bytes")]);
    const effect = vi.fn(async () => [{ type: "text", text: "The picture" }, image]);
    const session = createMemorySession();
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("picture", { run: effect })],
      limits: { inlineBytes: 3 },
      guardrails: {
        identity: "rich",
        toolOutput: ({ result }) => ({
          allow: result.ok && result.images?.[0]?.data === image.data,
        }),
      },
    });
    const result = await agent.run("Look", { session });
    expect(result.status).toBe("completed");
    const message = {
      role: "tool",
      toolCallId: "call",
      name: "picture",
      content: "The picture",
      images: [image],
    };
    expect(wire.requests[1]?.at(-1)).toEqual(message);
    expect(result.history).toContainEqual(message);
    expect(result.newMessages).toContainEqual(message);
    const loaded = await session.load({ signal: new AbortController().signal });
    expect(loaded.messages).toEqual(result.newMessages);
    const resumed = await agent.resume(JSON.parse(JSON.stringify(result.snapshot)), {
      session,
      host: { authorizeResume },
    });
    expect(resumed.history).toEqual(result.history);
    expect(resumed.newMessages).toEqual(result.newMessages);
    expect(effect).toHaveBeenCalledOnce();
    expect((await session.load({ signal: new AbortController().signal })).messages).toEqual(
      loaded.messages,
    );
  });

  it("keeps structured JSON outside model history and preserves explicitly summarized non-JSON values", async () => {
    const wire = fake([call("structured"), call("date"), text()]);
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      tools: [
        tool("structured", { run: async () => ({ count: 2 }), summarize: () => "Two matches" }),
        tool("date", { run: async () => new Date(0), summarize: () => "1970" }),
      ],
    }).run("Look");
    expect(result.status).toBe("completed");
    expect(result.receipts.find((receipt) => receipt.kind === "tool")).toMatchObject({
      result: { ok: true, output: { count: 2 }, content: "Two matches" },
    });
    expect(wire.requests[1]?.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call",
      name: "structured",
      content: "Two matches",
    });
    expect(wire.requests[2]?.at(-1)?.content).toBe("1970");
  });

  it("enforces image bytes across successive tool results, including on snapshot restore", async () => {
    const wire = fake([call("picture"), call("picture"), text()]);
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [tool("picture", { run: async () => [image] })],
      limits: { inlineBytes: 3 },
    });
    const result = await agent.run("Look");
    expect(result).toMatchObject({ status: "failed", error: { code: "tool_media_limit" } });
    expect(wire.requests).toHaveLength(2);
    const snapshot = structuredClone(result.snapshot);
    const model = snapshot.models[0];
    if (
      model?.status !== "completed" ||
      model.tools[0]?.status !== "completed" ||
      !model.tools[0].result.ok
    )
      throw new Error("Expected image result");
    model.tools[0].result.images = [image, image];
    await expect(agent.resume(snapshot, { host: { authorizeResume } })).rejects.toThrow("limits");
  });

  it("normalizes delegation and client results through the same content path", async () => {
    const wire = fake([call("coordinate"), call("client"), text()]);
    const delegation = defineDelegation({
      name: "coordinate",
      description: "Coordinate",
      inputSchema: { type: "object" },
      specialists: [],
      validate: (raw) => raw,
      run: async () => [{ type: "text", text: "From coordinator" }, image],
    });
    const client = defineClientTool({
      name: "client",
      description: "Client",
      inputSchema: { type: "object" },
      validate: (raw) => raw,
      result: {
        schema: { type: "object" },
        validate: () => [{ type: "text", text: "From client" }, image],
      },
    });
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [delegation, client],
      guardrails: { identity: "results", toolInput: allow, toolOutput: allow },
    });
    const waiting = await agent.run("Look", { host: approval });
    expect(waiting.status).toBe("suspended");
    expect(wire.requests[1]?.at(-1)).toMatchObject({
      content: "From coordinator",
      images: [image],
    });
    const result = await agent.resume(waiting.snapshot, {
      answers: evidenceFor(waiting.snapshot, "result"),
      host: { ...approval, authorizeResume, resolveRequest: () => ({ type: "result", value: {} }) },
    });
    expect(result.status).toBe("completed");
    expect(wire.requests[2]?.at(-1)).toMatchObject({ content: "From client", images: [image] });
  });
});
