import { describe, expect, it, vi } from "vitest";
import type { Provider } from "@providerkit/core";
import { defineAgent, type ModelProviderBinding, type ModelProviderScope } from "../src/index.ts";
import { defineWorkflow } from "../src/workflow.ts";
import { createBackgroundAgent, type BackgroundWorker } from "../src/runs.ts";

const base = { id: "writer", version: "1", instructions: "Answer briefly." };
function wire(content = "Done") {
  const called = vi.fn();
  const provider: Provider = {
    id: "offline",
    model: "fixture",
    async *createStream(messages, tools, options) {
      called(messages, tools, options);
      yield { type: "delta", content };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  return { provider, called };
}

function recorder() {
  const scopes: ModelProviderScope[] = [];
  const binding: ModelProviderBinding = (provider, scope) => {
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.run)).toBe(true);
    scopes.push(scope);
    return provider;
  };
  return { scopes, binding };
}

describe("per-dispatch provider instrumentation", () => {
  it("binds actual run/operation identities once and never journals the callback", async () => {
    const source = wire();
    const { binding, scopes } = recorder();
    const agent = defineAgent({ ...base, provider: source.provider });
    const result = await agent.run("Work", { runId: "root", bindModelProvider: binding });
    expect(result.status).toBe("completed");
    expect(source.called).toHaveBeenCalledTimes(1);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      run: { runId: "root", agentId: "writer", attemptId: result.attemptId },
      operationId: result.snapshot.models[0]?.id,
      operationAttemptId: result.snapshot.models[0]?.attemptId,
      purpose: "turn",
    });
    expect(JSON.stringify(result.snapshot)).not.toContain("bindModelProvider");
    await agent.resume(result.snapshot, {
      host: { authorizeResume() {} },
      bindModelProvider: binding,
    });
    expect(scopes).toHaveLength(1);
  });

  it("falls back only when binding throws before dispatch", async () => {
    const source = wire();
    const agent = defineAgent({ ...base, provider: source.provider });
    const result = await agent.run("Work", {
      bindModelProvider() {
        throw new Error("A broken tracer");
      },
    });
    expect(result.status).toBe("completed");
    expect(source.called).toHaveBeenCalledTimes(1);
    const dispatch = vi.fn(() => {
      throw new Error("A provider failure");
    });
    const failed = await agent.run("Again", {
      bindModelProvider: (provider) => ({ ...provider, createStream: dispatch }),
    });
    expect(failed.status).toBe("failed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(source.called).toHaveBeenCalledTimes(1);
  });

  it("checks cancellation after binding and never binds rejected model input", async () => {
    const source = wire();
    const controller = new AbortController();
    const agent = defineAgent({ ...base, provider: source.provider });
    const result = await agent.run("Work", {
      signal: controller.signal,
      bindModelProvider(provider) {
        controller.abort();
        return provider;
      },
    });
    expect(result.status).toBe("cancelled");
    expect(source.called).not.toHaveBeenCalled();
    const binding = vi.fn((provider: Provider) => provider);
    const guarded = defineAgent({
      ...base,
      provider: source.provider,
      guardrails: { identity: "deny", modelInput: () => ({ allow: false }) },
    });
    expect((await guarded.run("Work", { bindModelProvider: binding })).status).toBe("failed");
    expect(binding).not.toHaveBeenCalled();
  });

  it("binds the actual summary provider with a separate purpose and operation", async () => {
    const source = wire("Answer");
    const summary = wire("Earlier facts");
    const { binding, scopes } = recorder();
    const selected: Provider[] = [];
    const agent = defineAgent({
      ...base,
      provider: source.provider,
      compaction: {
        identity: "trim",
        contextWindow: 1_000,
        keepTokens: 5,
        summarize: { provider: summary.provider, instructions: "Summarize.", maxTokens: 40 },
      },
    });
    const result = await agent.run(
      {
        messages: [
          { role: "user", content: "Old question ".repeat(30) },
          { role: "assistant", content: "Old answer ".repeat(30) },
          { role: "user", content: "New question" },
        ],
      },
      {
        bindModelProvider(provider, scope) {
          selected.push(provider);
          return binding(provider, scope);
        },
      },
    );
    expect(result.status).toBe("completed");
    expect(selected).toEqual([summary.provider, source.provider]);
    expect(scopes.map((scope) => scope.purpose)).toEqual(["compaction", "turn"]);
    expect(new Set(scopes.map((scope) => scope.operationId)).size).toBe(2);
  });

  it("inherits binding through a workflow and keeps simultaneous runs separate", async () => {
    const source = wire();
    const agent = defineAgent({ ...base, provider: source.provider });
    const flow = defineWorkflow({
      id: "flow",
      version: "1",
      agents: [agent],
      input: { schema: { type: "object" }, validate: () => ({}) },
      async run(_input, context) {
        const result = await context.agent("write", agent, "Work");
        if (result.status !== "completed") throw new Error("The child did not finish.");
        return result.output;
      },
    });
    const { binding, scopes } = recorder();
    // The synthetic host owns both workflows; production hosts check their current lease here.
    const host = { beforeStep() {} };
    const results = await Promise.all([
      flow.run({}, { runId: "one", bindModelProvider: binding, host }),
      flow.run({}, { runId: "two", bindModelProvider: binding, host }),
    ]);
    for (const result of results) {
      expect(result.status, result.status === "failed" ? result.error.message : undefined).toBe(
        "completed",
      );
    }
    expect(scopes).toHaveLength(2);
    expect(new Set(scopes.map((scope) => scope.run.runId)).size).toBe(2);
    expect(new Set(scopes.map((scope) => scope.run.signal)).size).toBe(2);
  });

  it("binds worker-local instrumentation without replacing stored progress", async () => {
    const source = wire();
    const agent = defineAgent({ ...base, provider: source.provider });
    const { binding, scopes } = recorder();
    const onEvent = vi.fn();
    const onLifecycle = vi.fn();
    let input: unknown;
    const jobs = createBackgroundAgent({
      agent,
      kind: "traced",
      enqueue: async () => {},
      policy: () => ({
        authorizeResume() {},
        beforeTool() {},
        claimContinuation() {},
        prepareRequest: () => ({
          scope: {
            actorId: "owner",
            resource: { id: "resource", version: "1" },
            expiresAt: Date.now() + 60_000,
          },
        }),
        resolveRequest: () => ({ type: "approve" }),
        bindModelProvider: binding,
        onEvent,
        onLifecycle,
      }),
      runs: {
        async create(spec) {
          input = spec.input;
          return { id: "segment" };
        },
        read: async () => null,
        cancel: async () => true,
        async *tail() {},
      },
    });
    await jobs.start("owner", "Work");
    const emit = vi.fn();
    const worker: BackgroundWorker = {
      id: "segment",
      owner: "owner",
      input,
      checkpoint: null,
      resumed: false,
      crashes: 0,
      signal: new AbortController().signal,
      save: async () => {},
      emit,
      async child(_key, _spec, execute) {
        return { ok: true, value: await execute(worker) };
      },
    };
    const handler = jobs.handlers.traced;
    if (!handler) throw new Error("Missing handler");
    await handler(worker);
    expect(scopes).toHaveLength(1);
    expect(onLifecycle).toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("agent", expect.objectContaining({ type: "state" }));
    expect(JSON.stringify(input)).not.toContain("bindModelProvider");
  });
});
