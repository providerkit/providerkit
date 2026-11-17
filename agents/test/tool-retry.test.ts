import { describe, expect, it, vi } from "vitest";
import { assertAgent } from "./fixtures/assertions.ts";
import { defineTool, type Provider, type ProviderChunk, type ToolSpec } from "@providerkit/core";
import {
  defineAgent,
  defineClientTool,
  defineHandoff,
  InputRequired,
  type AgentEvent,
  type AgentHost,
  type RunSnapshot,
  type ToolRetryPolicy,
} from "../src/index.ts";
import { checkChildProgress } from "../src/snapshot.ts";
import { AGENT_RUNTIME } from "../src/delegation.ts";
import { createBackgroundAgent, type BackgroundWorker } from "../src/runs.ts";
import { evidenceFor } from "./fixtures/requests.ts";

const base = { id: "retry", version: "1", instructions: "Read, then answer." };
const policy: ToolRetryPolicy = {
  identity: "reads-1",
  tools: { read: { maxAttempts: 3, replay: "read-only" } },
};
const host: AgentHost = { authorizeResume: () => {}, beforeTool: () => {} };
const authorizeResume = () => {};
function call(name = "read"): ProviderChunk[] {
  return [
    { type: "delta", toolCalls: [{ index: 0, id: "call", name, arguments: '{"count":1}' }] },
    { type: "finish", finishReason: "tool_calls" },
  ];
}
function fake(
  turns: ProviderChunk[][] = [
    call(),
    [
      { type: "delta", content: "Done" },
      { type: "finish", finishReason: "stop" },
    ],
  ],
) {
  let calls = 0;
  const provider: Provider = {
    id: "fake",
    model: "offline",
    async *createStream() {
      const chunks = turns[calls++];
      if (!chunks) throw new Error("Unexpected model call");
      yield* chunks;
    },
  };
  return { provider, count: () => calls };
}
function read(spec: Partial<Omit<ToolSpec<unknown, unknown>, "name">> = {}) {
  return defineTool({
    name: "read",
    description: "Read",
    inputSchema: { type: "object" },
    isReadOnly: true,
    run: async () => {
      throw new Error("Failed after dispatch; outcome unknown");
    },
    ...spec,
  });
}
function saved(value: RunSnapshot | undefined): RunSnapshot {
  if (!value) throw new Error("Missing checkpoint");
  return value;
}
function execution(snapshot: RunSnapshot) {
  const model = snapshot.models[0];
  if (model?.status !== "completed" || !model.tools[0]) throw new Error("Missing tool");
  return model.tools[0];
}

describe("bounded tool retries", () => {
  it("defaults to no retries, even for a read-only tool or an error claiming no effect", async () => {
    const wire = fake();
    const effect = vi.fn(async () => {
      throw new Error("Nothing happened. idempotency-key=123");
    });
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      tools: [read({ run: effect })],
    }).run("Read", { host });
    expect(result.status).toBe("completed");
    expect(effect).toHaveBeenCalledOnce();
    expect(execution(result.snapshot).retries).toEqual([]);
  });

  it("does not grant a retry from an inherited object property", async () => {
    const wire = fake([
      call("constructor"),
      [
        { type: "delta", content: "Done" },
        { type: "finish", finishReason: "stop" },
      ],
    ]);
    const effect = vi.fn(async () => {
      throw new Error("Failed");
    });
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      tools: [
        read(),
        defineTool({
          name: "constructor",
          description: "Read",
          inputSchema: { type: "object" },
          isReadOnly: true,
          run: effect,
        }),
      ],
      toolRetries: policy,
    }).run("Read", { host });
    expect(result.status).toBe("completed");
    expect(effect).toHaveBeenCalledOnce();
  });

  it.each(["read-only", "reconcile"] as const)(
    "handles a timed-out %s call without assuming it stopped",
    async (replay) => {
      const wire = fake();
      const effect = vi.fn(async () => new Promise<never>(() => {}));
      const reconcileToolRetry = vi.fn(() => ({ outcome: "unknown" as const }));
      const result = await defineAgent({
        ...base,
        provider: wire.provider,
        tools: [read({ run: effect, isReadOnly: replay === "read-only", timeoutMs: 5 })],
        toolRetries: { identity: "timeouts", tools: { read: { replay, maxAttempts: 2 } } },
      }).run("Read", { host: { ...host, reconcileToolRetry } });
      expect(result.status).toBe(replay === "read-only" ? "completed" : "failed");
      expect(effect).toHaveBeenCalledTimes(replay === "read-only" ? 2 : 1);
      expect(reconcileToolRetry).toHaveBeenCalledTimes(replay === "read-only" ? 0 : 1);
    },
  );

  it("retains each paid read attempt, checks authority and guards again, and publishes unique attempt ids", async () => {
    const wire = fake();
    const contexts: string[] = [];
    const effect = vi.fn(async (_value, context) => {
      contexts.push(context.attemptId);
      if (contexts.length < 3) throw new Error("Unavailable");
      return { count: 3 };
    });
    const beforeTool = vi.fn(() => {});
    const inputGuard = vi.fn(() => ({ allow: true as const }));
    const outputGuard = vi.fn(() => ({ allow: true as const }));
    const events: unknown[] = [];
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [read({ run: effect })],
      toolRetries: policy,
      guardrails: { identity: "retries", toolInput: inputGuard, toolOutput: outputGuard },
    });
    const result = await agent.run("Read", {
      host: { ...host, beforeTool },
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(3);
    expect(beforeTool).toHaveBeenCalledTimes(3);
    expect(inputGuard).toHaveBeenCalledTimes(3);
    expect(outputGuard).toHaveBeenCalledTimes(3);
    expect(new Set(contexts).size).toBe(3);
    expect(result.receipts.filter((entry) => entry.kind === "tool")).toHaveLength(3);
    expect(execution(result.snapshot).retries.map((attempt) => attempt.arguments)).toEqual([
      { count: 1 },
      { count: 1 },
    ]);
    expect(
      events.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "operation_restart",
      ),
    ).toHaveLength(2);
    expect(
      (await agent.resume(result.snapshot, { host: { ...host, authorizeResume } })).status,
    ).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(3);
  });

  it.each([1, 2, 3])(
    "honors maxAttempts=%s without buying another model turn",
    async (maxAttempts) => {
      const wire = fake();
      const effect = vi.fn(async () => {
        throw new Error("Failed");
      });
      const result = await defineAgent({
        ...base,
        provider: wire.provider,
        tools: [read({ run: effect })],
        toolRetries: { identity: "bound", tools: { read: { replay: "read-only", maxAttempts } } },
      }).run("Read", { host });
      expect(result.status).toBe("completed");
      expect(effect).toHaveBeenCalledTimes(maxAttempts);
      expect(execution(result.snapshot).retries).toHaveLength(maxAttempts - 1);
      expect(wire.count()).toBe(2);
    },
  );

  it("charges every retry to local tool admissions and preserves the last failure when the limit stops it", async () => {
    const wire = fake();
    const effect = vi.fn(async () => {
      throw new Error("Failed");
    });
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [read({ run: effect })],
      toolRetries: policy,
      limits: { toolCalls: 2 },
    });
    const result = await agent.run("Read", { host });
    expect(result).toMatchObject({ status: "limited", limit: "toolCalls" });
    expect(effect).toHaveBeenCalledTimes(2);
    expect(result.receipts.filter((entry) => entry.kind === "tool")).toHaveLength(2);
    expect(wire.count()).toBe(1);
    expect(
      (await agent.resume(result.snapshot, { host: { ...host, authorizeResume } })).status,
    ).toBe("limited");
  });

  it("requires authoritative not-run reconciliation for failed writes, never the error text", async () => {
    const wire = fake();
    const effect = vi.fn(async () => {
      if (effect.mock.calls.length === 1) throw new Error("No effect, key=123");
      return "Done";
    });
    const reconcileToolRetry = vi.fn<NonNullable<AgentHost["reconcileToolRetry"]>>(() => ({
      outcome: "not_run",
      receipt: "external-query-receipt",
    }));
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [read({ run: effect, isReadOnly: false })],
      toolRetries: {
        identity: "write-queries",
        tools: { read: { maxAttempts: 2, replay: "reconcile" } },
      },
    });
    const result = await agent.run("Write", { host: { ...host, reconcileToolRetry } });
    expect(result.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(2);
    expect(reconcileToolRetry).toHaveBeenCalledOnce();
    expect(reconcileToolRetry.mock.calls[0]?.[0]).toMatchObject({
      request: { arguments: { count: 1 } },
      result: { ok: false },
    });
    expect(execution(result.snapshot).retries[0]?.reconciliation).toBe("external-query-receipt");
  });

  it.each(["missing", "unknown", "empty-receipt"] as const)(
    "refuses %s reconciliation",
    async (mode) => {
      const wire = fake();
      const effect = vi.fn(async () => {
        throw new Error("not_run idempotency=abc");
      });
      const result = await defineAgent({
        ...base,
        provider: wire.provider,
        tools: [read({ run: effect, isReadOnly: false })],
        toolRetries: {
          identity: "write",
          tools: { read: { maxAttempts: 2, replay: "reconcile" } },
        },
      }).run("Write", {
        host: {
          ...host,
          ...(mode === "missing"
            ? {}
            : {
                reconcileToolRetry: () =>
                  mode === "unknown"
                    ? { outcome: "unknown" as const }
                    : { outcome: "not_run" as const, receipt: "" },
              }),
        },
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "tool_retry_unsafe" } });
      expect(effect).toHaveBeenCalledOnce();
      expect(wire.count()).toBe(1);
    },
  );

  it("never retries an approved call or loses the edited arguments", async () => {
    const wire = fake();
    const args: unknown[] = [];
    const effect = vi.fn(async (value) => {
      args.push(value);
      throw new Error("Failed");
    });
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [read({ run: effect })],
      toolRetries: policy,
    });
    const authority: AgentHost = {
      ...host,
      needsApproval: () => true,
      prepareRequest: () => ({
        scope: {
          actorId: "person",
          resource: { id: "record", version: "1" },
          expiresAt: Date.now() + 60_000,
        },
        ask: { type: "approval", editable: true },
      }),
      resolveRequest: () => ({ type: "approve", arguments: { count: 9 } }),
    };
    const waiting = await agent.run("Read", { host: authority });
    expect(waiting.status).toBe("suspended");
    const result = await agent.resume(waiting.snapshot, {
      host: { ...authority, authorizeResume },
      answers: evidenceFor(waiting.snapshot, "approve"),
    });
    expect(result.status).toBe("completed");
    expect(args).toEqual([{ count: 9 }]);
    expect(effect).toHaveBeenCalledOnce();
    expect(execution(result.snapshot).retries).toEqual([]);
  });

  it("rechecks dynamic approval and current access after the retry start hook", async () => {
    for (const mode of ["approval", "access"] as const) {
      const wire = fake();
      let attempts = 0;
      let revoked = false;
      const agent = defineAgent({
        ...base,
        provider: wire.provider,
        tools: [
          read({
            run: async () => {
              attempts++;
              throw new Error("Failed");
            },
          }),
        ],
        toolRetries: policy,
        onLifecycle: (event) => {
          if (event.type === "tool_start" && attempts) revoked = true;
        },
      });
      const result = await agent.run("Read", {
        host: {
          ...host,
          needsApproval: () => mode === "approval" && revoked,
          beforeTool: () => {
            if (mode === "access" && revoked) throw new Error("Access revoked");
          },
        },
      });
      expect(result.status).toBe("failed");
      expect(attempts).toBe(1);
      expect(wire.count()).toBe(1);
    }
  });

  it.each(["stop", "guard", "lease", "progress"] as const)(
    "does not turn %s failure into a tool retry",
    async (boundary) => {
      const wire = fake();
      const controller = new AbortController();
      const effect = vi.fn(async () => {
        if (boundary === "stop") controller.abort();
        throw new Error("Failed");
      });
      const agent = defineAgent({
        ...base,
        provider: wire.provider,
        tools: [read({ run: effect })],
        toolRetries: policy,
        ...(boundary === "guard"
          ? { guardrails: { identity: "reject", toolOutput: () => ({ allow: false }) } }
          : {}),
      });
      const result = await agent
        .run("Read", {
          signal: controller.signal,
          host: {
            ...host,
            ...(boundary === "lease"
              ? {
                  checkpoint: () => {
                    if (effect.mock.calls.length) throw new Error("Lease lost");
                  },
                }
              : {}),
            ...(boundary === "progress"
              ? {
                  progress: {
                    push: () => {},
                    flush: async () => {
                      if (effect.mock.calls.length) throw new Error("Storage lost");
                    },
                  },
                }
              : {}),
          },
        })
        .catch((error: unknown) => error);
      if (boundary === "progress") expect(result).toBeInstanceOf(Error);
      else expect(result).toMatchObject({ status: boundary === "stop" ? "cancelled" : "failed" });
      expect(effect).toHaveBeenCalledOnce();
      expect(wire.count()).toBe(1);
    },
  );

  it("resumes a journaled retry without redoing reconciliation and still requires fresh authority", async () => {
    const wire = fake();
    const effect = vi.fn(async () => {
      if (effect.mock.calls.length === 1) throw new Error("Failed");
      return "Done";
    });
    const reconcileToolRetry = vi.fn(() => ({ outcome: "not_run" as const, receipt: "confirmed" }));
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [read({ run: effect, isReadOnly: false })],
      toolRetries: { identity: "write", tools: { read: { replay: "reconcile", maxAttempts: 2 } } },
    });
    let checkpoint: RunSnapshot | undefined;
    await agent.run("Read", {
      host: {
        ...host,
        reconcileToolRetry,
        checkpoint: (snapshot) => {
          assertAgent(snapshot);
          const model = snapshot.models[0];
          const tool = model?.status === "completed" ? model.tools[0] : undefined;
          if (tool?.retries.length && tool.status === "running") throw new Error("Worker lost");
          checkpoint = structuredClone(snapshot);
        },
      },
    });
    const beforeTool = vi.fn(() => {});
    const result = await agent.resume(saved(checkpoint), {
      host: { ...host, authorizeResume, beforeTool, reconcileToolRetry },
    });
    expect(result.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(2);
    expect(reconcileToolRetry).toHaveBeenCalledOnce();
    expect(beforeTool).toHaveBeenCalledOnce();
  });

  it.each(["running", "pending"] as const)(
    "crash recovery from %s keeps the budget, prior failures and immediate predecessor",
    async (resumeFrom) => {
      const wire = fake();
      const effect = vi.fn(async () => {
        if (effect.mock.calls.length === 1) throw new Error("Failed");
        return "Done";
      });
      const agent = defineAgent({
        ...base,
        provider: wire.provider,
        tools: [read({ run: effect })],
        toolRetries: policy,
        recovery: { identity: "reads", maxAttempts: 3, readOnlyTools: ["read"] },
      });
      let checkpoint: RunSnapshot | undefined;
      await agent.run("Read", {
        host: {
          ...host,
          checkpoint: (snapshot) => {
            assertAgent(snapshot);
            const model = snapshot.models[0];
            const tool = model?.status === "completed" ? model.tools[0] : undefined;
            if (tool?.retries.length && tool.status === "completed") throw new Error("Worker lost");
            checkpoint = structuredClone(snapshot);
          },
        },
      });
      const before = saved(checkpoint);
      const interrupted = execution(before);
      if (interrupted.status !== "running") throw new Error("Missing interrupted retry");
      if (resumeFrom === "pending") {
        const model = before.models[0];
        if (model?.status !== "completed") throw new Error("Missing completed model");
        // A sibling's checkpoint can save the recovery reset before replacement admission.
        model.tools[0] = {
          id: interrupted.id,
          status: "pending",
          previousAttemptId: interrupted.attemptId,
          interrupted: [...interrupted.interrupted, { attemptId: interrupted.attemptId }],
          retries: interrupted.retries,
        };
        for (const previousAttemptId of [undefined, "not-a-recorded-attempt"]) {
          const invalid = structuredClone(before);
          const pending = execution(invalid);
          if (pending.status !== "pending") throw new Error("Missing pending replacement");
          pending.previousAttemptId = previousAttemptId;
          await expect(
            agent.resume(invalid, { host: { ...host, authorizeResume } }),
          ).rejects.toThrow("snapshot");
        }
      }
      const events: AgentEvent[] = [];
      const result = await agent.resume(before, {
        host: { ...host, authorizeResume },
        onEvent: (event) => {
          events.push(event);
        },
      });
      expect(result.status).toBe("completed");
      expect(execution(result.snapshot).retries).toHaveLength(1);
      expect(execution(result.snapshot).interrupted).toHaveLength(1);
      expect(effect).toHaveBeenCalledTimes(3);
      expect(result.receipts.filter((entry) => entry.kind === "tool")).toHaveLength(3);
      const replacement = execution(result.snapshot);
      if (replacement.status !== "completed") throw new Error("Missing replacement result");
      expect(events.filter((event) => event.type === "operation_restart")).toEqual([
        {
          type: "operation_restart",
          kind: "tool",
          runId: result.runId,
          operationId: interrupted.id,
          previousAttemptId: interrupted.attemptId,
          attemptId: replacement.attemptId,
        },
      ]);
      expect(events.findIndex((event) => event.type === "operation_restart")).toBeLessThan(
        events.findIndex((event) => event.type === "tool_start"),
      );
    },
  );

  it.each([false, true])(
    "forwards background reconciliation and respects lease loss=%s",
    async (loseLease) => {
      const wire = fake();
      const effect = vi.fn(async () => {
        if (effect.mock.calls.length === 1) throw new Error("Failed");
        return "Done";
      });
      const agent = defineAgent({
        ...base,
        provider: wire.provider,
        tools: [read({ run: effect, isReadOnly: false })],
        toolRetries: {
          identity: "write",
          tools: { read: { replay: "reconcile", maxAttempts: 2 } },
        },
      });
      const controller = new AbortController();
      const reconcileToolRetry = vi.fn(() => {
        if (loseLease) controller.abort(new Error("Lease lost"));
        return { outcome: "not_run" as const, receipt: "confirmed" };
      });
      let input: unknown;
      const order: string[] = [];
      const jobs = createBackgroundAgent({
        agent,
        kind: "retry-test",
        events: "awaited",
        runs: {
          create: async (spec) => {
            input = spec.input;
            order.push("commit");
            return { id: "segment" };
          },
          read: async () => null,
          cancel: async () => true,
          async *tail() {},
        },
        enqueue: async () => {
          order.push("enqueue");
        },
        policy: () => ({
          authorizeResume,
          beforeTool: () => {},
          claimContinuation: () => {},
          reconcileToolRetry,
          prepareRequest: () => ({
            scope: {
              actorId: "person",
              resource: { id: "record", version: "1" },
              expiresAt: Date.now() + 60_000,
            },
          }),
          resolveRequest: () => ({ type: "approve" as const }),
        }),
      });
      await jobs.start("owner", "Read");
      expect(order).toEqual(["commit", "enqueue"]);
      const saves: RunSnapshot[] = [];
      const worker: BackgroundWorker = {
        id: "segment",
        owner: "owner",
        input,
        checkpoint: null,
        resumed: false,
        crashes: 0,
        signal: controller.signal,
        emit: () => {},
        append: async () => {},
        save: async (snapshot) => {
          controller.signal.throwIfAborted();
          saves.push(agent[AGENT_RUNTIME].restore(snapshot));
        },
        child: async () => {
          throw new Error("No children in this test");
        },
      };
      const drive = jobs.handlers["retry-test"];
      if (!drive) throw new Error("Missing handler");
      if (loseLease) await expect(drive(worker)).rejects.toThrow("Lease lost");
      else {
        await drive(worker);
        expect(saves.at(-1)?.state.status).toBe("completed");
      }
      expect(reconcileToolRetry).toHaveBeenCalledOnce();
      expect(effect).toHaveBeenCalledTimes(loseLease ? 1 : 2);
    },
  );

  it("rejects replay policies for writes marked read-only, stopping tools, client tools and handoffs", () => {
    const provider = fake().provider;
    const target = defineAgent({ ...base, id: "target", provider });
    const client = defineClientTool({
      name: "read",
      description: "Read",
      inputSchema: { type: "object" },
      validate: (value) => value,
      result: { schema: { type: "object" }, validate: (value) => value },
    });
    for (const tool of [
      read({ isReadOnly: false }),
      read({ isTerminal: true }),
      read({ needsApproval: true }),
      client,
      defineHandoff({ name: "read", description: "Read", to: target }),
      target.asTool({ name: "read", description: "Read" }),
    ])
      expect(() =>
        defineAgent({ ...base, provider, tools: [tool], toolRetries: policy }),
      ).toThrow();
    expect(() =>
      defineAgent({
        ...base,
        provider,
        tools: [read()],
        stopAtTools: ["read"],
        toolRetries: policy,
      }),
    ).toThrow();
  });

  it("keeps question control flow out of retries", async () => {
    const wire = fake();
    const effect = vi.fn(async () => {
      throw new InputRequired({ key: "answer", message: "Which record?", freeText: true });
    });
    const result = await defineAgent({
      ...base,
      provider: wire.provider,
      tools: [read({ run: effect })],
      toolRetries: policy,
    }).run("Read", {
      host: {
        ...host,
        prepareRequest: () => ({
          scope: {
            actorId: "person",
            resource: { id: "record", version: "1" },
            expiresAt: Date.now() + 60_000,
          },
        }),
      },
    });
    expect(result.status).toBe("suspended");
    expect(effect).toHaveBeenCalledOnce();
    expect(execution(result.snapshot).retries).toHaveLength(0);
  });

  it("rejects dropped retry receipts, changed arguments and child-host replacement of failures", async () => {
    const wire = fake();
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [read()],
      toolRetries: policy,
    });
    const result = await agent.run("Read", { host });
    const changed = structuredClone(result.snapshot);
    const retry = execution(changed).retries[0];
    if (!retry) throw new Error("Missing retry");
    retry.arguments = { count: 100 };
    await expect(agent.resume(changed, { host: { ...host, authorizeResume } })).rejects.toThrow(
      "retries",
    );
    const dropped = structuredClone(result.snapshot);
    execution(dropped).retries.pop();
    expect(() => checkChildProgress(result.snapshot, dropped)).toThrow("tool receipt");
    const missing = JSON.parse(JSON.stringify(result.snapshot));
    delete missing.models[0].tools[0].retries;
    await expect(agent.resume(missing, { host: { ...host, authorizeResume } })).rejects.toThrow(
      "snapshot",
    );
  });
});
