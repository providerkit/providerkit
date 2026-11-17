import { describe, expect, it, vi } from "vitest";
import {
  defineTool,
  type Provider,
  type ProviderChunk,
  type Tool,
  type ToolContext,
  type ToolSpec,
} from "@providerkit/core";
import { defineAgent } from "../src/run.ts";
import {
  codeMode,
  CODE_LIMITS,
  textBytes,
  type CodeDriver,
  type CodeModeOptions,
} from "../src/code.ts";
import { createQuickJsDriver } from "../src/quickjs.ts";
import { defineClientTool, InputRequired, questionTool } from "../src/request.ts";
import { defineHandoff } from "../src/handoff.ts";
import { subagentTool } from "../src/subagents.ts";
import { AGENT_RUNTIME, defineDelegation } from "../src/delegation.ts";
import { checkChildProgress } from "../src/snapshot.ts";
import type {
  AgentConfig,
  AgentEvent,
  AgentHost,
  ProgramCall,
  RunSnapshot,
  ToolExecution,
  ToolRequest,
} from "../src/types.ts";

const driver = createQuickJsDriver();
const host: AgentHost = { authorizeResume() {}, beforeTool() {} };
const base = { id: "code-test", version: "1", instructions: "Use code, then answer." };
function chunks(name: string, input: unknown): ProviderChunk[] {
  return [
    {
      type: "finish",
      finishReason: "tool_calls",
      toolCalls: [{ index: 0, id: "call", name, arguments: JSON.stringify(input) }],
    },
  ];
}
function wire(turns: ProviderChunk[][]) {
  const definitions: string[][] = [];
  const descriptions: string[][] = [];
  let index = 0;
  const provider: Provider = {
    id: "offline",
    model: "offline",
    async *createStream(_messages, tools) {
      definitions.push(tools?.map((tool) => tool.name) ?? []);
      descriptions.push(tools?.map((tool) => tool.description) ?? []);
      const turn = turns[index++];
      if (!turn) throw new Error("Unexpected model call");
      yield* turn;
    },
  };
  return { provider, definitions, descriptions };
}
const done: ProviderChunk[] = [{ type: "finish", content: "Done", finishReason: "stop" }];
function ordinary(name = "read", spec: Partial<ToolSpec<unknown, unknown>> = {}) {
  return defineTool({
    name,
    description: `Run ${name}`,
    inputSchema: { type: "object" },
    isReadOnly: true,
    run: async () => ({ n: 3 }),
    ...spec,
  });
}
function setup(
  code: string,
  tools: Tool[] = [ordinary()],
  options: Partial<CodeModeOptions> = {},
  config: Partial<AgentConfig> = {},
) {
  const mode = codeMode({ tools, driver, ...options });
  const fake = wire([chunks(mode.name, { code }), done]);
  const agent = defineAgent({ ...base, provider: fake.provider, tools: [mode], ...config });
  return { agent, mode, ...fake };
}
function execution(snapshot: RunSnapshot): ToolExecution {
  const model = snapshot.models[0];
  if (model?.status !== "completed" || !model.tools[0]) throw new Error("Missing code operation");
  return model.tools[0];
}
function calls(snapshot: RunSnapshot): ProgramCall[] {
  return execution(snapshot).calls ?? [];
}
function program(snapshot: RunSnapshot): Record<string, unknown> {
  const entry = execution(snapshot);
  if (entry.status !== "completed") throw new Error("Missing code result");
  const value: unknown = JSON.parse(entry.result.content);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid result");
  return Object.fromEntries(Object.entries(value));
}
function saved(snapshot: RunSnapshot | undefined): RunSnapshot {
  if (!snapshot) throw new Error("Missing checkpoint");
  return snapshot;
}
function interrupted(snapshot: RunSnapshot): RunSnapshot {
  const copy = structuredClone(snapshot);
  const model = copy.models[0];
  const entry = execution(copy);
  if (model?.status !== "completed" || entry.status !== "completed")
    throw new Error("Missing final code operation");
  copy.models = [model];
  model.tools[0] = {
    id: entry.id,
    status: "running",
    attemptId: entry.attemptId,
    calls: entry.calls,
    interrupted: entry.interrupted,
    retries: entry.retries,
    asks: entry.asks,
  };
  copy.state = { status: "running" };
  return copy;
}

describe("journaled code mode", () => {
  it("rebinds the same tools without mutating the descriptor or its pinned settings", async () => {
    const original = ordinary("read");
    const options = { tools: [original], driver, instructions: "Pinned", needsApproval: false };
    const mode = codeMode(options);
    options.instructions = "Changed";
    options.needsApproval = true;
    const replacement = ordinary("read", { run: async () => 7 });
    const rebound = mode.withTools([replacement]);
    expect(rebound.tools[0]).toBe(replacement);
    expect(mode.tools[0]).toBe(original);
    expect(rebound.definition()).toEqual(mode.definition());
    expect(rebound.needsApproval).toBe(false);
    expect(rebound.limits).toEqual(mode.limits);
    expect(() => mode.withTools([])).toThrow("same names");
    expect(() => mode.withTools([ordinary("other")])).toThrow("same names");
    expect(() => mode.withTools([ordinary("read", { needsApproval: true })])).toThrow(
      "cannot bind",
    );
    const agent = defineAgent({
      ...base,
      tools: [replacement, rebound],
      provider: wire([chunks(rebound.name, { code: "return await tools.read({});" }), done])
        .provider,
    });
    expect(program((await agent.run("Go", { host })).snapshot)).toMatchObject({ result: 7 });
  });

  it("uses the approved defaults and refuses control descriptors and duplicate bindings", () => {
    expect(codeMode({ tools: [ordinary()], driver }).limits).toEqual(CODE_LIMITS);
    const target = defineAgent({ ...base, provider: wire([done]).provider });
    const client = defineClientTool({
      name: "client",
      description: "Client",
      inputSchema: { type: "object" },
      validate: (value) => value,
      result: { schema: { type: "object" }, validate: (value) => value },
    });
    const forbidden = [
      ordinary("approval", { needsApproval: true }),
      ordinary("terminal", { isTerminal: true }),
      questionTool(),
      client,
      target.asTool({ name: "delegate", description: "Delegate" }),
      defineHandoff({ name: "handoff", description: "Transfer", to: target }),
      subagentTool({ name: "helpers", description: "Helpers", agent: target }),
      codeMode({ tools: [ordinary()], driver }),
    ];
    for (const tool of forbidden) {
      // Runtime callers can supply JSON/JavaScript without TypeScript. No cast grants a capability.
      expect(() => Reflect.apply(codeMode, undefined, [{ tools: [tool], driver }])).toThrow(
        "Code mode cannot bind",
      );
    }
    expect(() => codeMode({ tools: [], driver })).toThrow();
    expect(() => codeMode({ tools: [ordinary(), ordinary()], driver })).toThrow();
    expect(() => codeMode({ tools: [ordinary()], driver, limits: { calls: Infinity } })).toThrow();
  });

  it("requires same-name identity and prevents direct calls to code-only tools", async () => {
    const tool = ordinary();
    const mode = codeMode({ tools: [tool], driver });
    expect(() =>
      defineAgent({ ...base, provider: wire([done]).provider, tools: [mode, ordinary()] }),
    ).toThrow("same tool object");
    const fake = wire([
      chunks("read", {}),
      chunks("run_code", { code: "return await tools.read({});" }),
      done,
    ]);
    const agent = defineAgent({ ...base, provider: fake.provider, tools: [mode] });
    const result = await agent.run("Read", { host });
    expect(result.status).toBe("completed");
    expect(execution(result.snapshot)).toMatchObject({
      status: "completed",
      result: { ok: false, kind: "disabled_tool" },
    });
    expect(fake.definitions[0]).toEqual(["run_code"]);
    expect(
      result.receipts.filter((receipt) => receipt.kind === "tool" && receipt.parentOperationId),
    ).toHaveLength(1);
  });

  it("narrows bindings in execution and typings without granting disabled names", async () => {
    const read = ordinary();
    const hidden = ordinary("hidden");
    const mode = codeMode({ tools: [read, hidden], driver });
    const fake = wire([chunks("run_code", { code: "return await tools.hidden({});" }), done]);
    const agent = defineAgent({
      ...base,
      provider: fake.provider,
      tools: [read, mode],
      enabledTools: ["read", "run_code"],
    });
    await expect(agent.run("Read", { enabledTools: ["run_code", "hidden"] })).rejects.toThrow(
      "not enable",
    );
    const result = await agent.run("Read", { host, enabledTools: ["run_code"] });
    expect(result.status).toBe("completed");
    expect(calls(result.snapshot)).toHaveLength(0);
    expect(fake.definitions[0]).toEqual(["run_code"]);
    expect(fake.descriptions[0]?.[0]).not.toContain('"hidden"');
    expect(execution(result.snapshot)).toMatchObject({
      status: "completed",
      result: { ok: false },
    });
  });

  it("runs real QuickJS with isolated bridges, arbitrary tool names and a transpiler semicolon", async () => {
    const code = `const value = await tools["read-a"]({}); console.log("kept", value); return { value, hidden: [typeof __pk_call, typeof __pk_log, typeof call, typeof log, eval("typeof call"), new Function("return typeof call")(), typeof fetch, typeof process, typeof require, typeof setTimeout] };`;
    const transpile = vi.fn((source: string) => `${source};`);
    const { agent } = setup(code, [ordinary("read-a")], { transpile });
    const result = await agent.run("Read", { host });
    expect(result.status).toBe("completed");
    expect(transpile).toHaveBeenCalledWith(`(async () => {\n${code}\n})`);
    expect(program(result.snapshot)).toMatchObject({
      result: { value: { n: 3 }, hidden: Array(10).fill("undefined") },
      logs: 'kept {"n":3}',
    });
    expect(
      (await agent.resume(result.snapshot, { host: { ...host, authorizeResume() {} } })).status,
    ).toBe("completed");
  });

  it.each([
    {
      name: "source escapes",
      code: 'return "' + String.fromCharCode(92) + 'u0022";',
      input: undefined,
      value: '"',
    },
    {
      name: "guest string escapes",
      code: "return await tools.read({text: String.fromCharCode(92,117,48,48,54,49)});",
      input: { text: String.fromCharCode(92, 117, 48, 48, 54, 49) },
      value: { text: String.fromCharCode(92, 117, 48, 48, 54, 49) },
    },
    {
      name: "own __proto__ fields",
      code: 'return await tools.read({["__proto__"]:{kept:true}});',
      input: { ["__proto__"]: { kept: true } },
      value: { ["__proto__"]: { kept: true } },
    },
  ])("preserves exact $name across approvals and snapshots", async ({ code, input, value }) => {
    const effect = vi.fn(async (input: unknown) => input);
    const { agent } = setup(code, [ordinary("read", { run: effect })], { needsApproval: true });
    const result = await agent.run("Read", {
      host: {
        ...host,
        needsApproval: (request) => !!request.parentOperationId,
        prepareRequest: () => ({
          scope: {
            actorId: "owner",
            resource: { id: "record", version: "1" },
            expiresAt: Date.now() + 60_000,
          },
        }),
        answerNow: () => ({ type: "approve" }),
      },
    });
    expect(result.status).toBe("completed");
    expect(program(result.snapshot).result).toStrictEqual(value);
    expect(execution(result.snapshot).asks?.[0]?.request.call?.arguments).toEqual({ code });
    expect(effect).toHaveBeenCalledTimes(input ? 1 : 0);
    if (input) {
      expect(effect.mock.calls[0]?.[0]).toStrictEqual(input);
      const call = calls(result.snapshot)[0];
      if (!call) throw new Error("Missing inner call");
      expect(call.arguments).toStrictEqual(input);
      expect(Object.getPrototypeOf(call.arguments)).toBe(Object.prototype);
      expect(call.asks?.[0]?.request.call?.arguments).toStrictEqual(input);
    }
    expect(() =>
      agent[AGENT_RUNTIME].restore(JSON.parse(JSON.stringify(result.snapshot))),
    ).not.toThrow();
  });

  it("shares direct and inner authorization, guards, retries and stable parent receipts", async () => {
    const attempts = new Map<string, number>();
    const effect = vi.fn(async (_value: unknown, context: ToolContext) => {
      const key = String(context.operationId);
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      if (count === 1) throw new Error("Unavailable");
      return { n: 7 };
    });
    const tool = ordinary("read", { run: effect });
    const mode = codeMode({ tools: [tool], driver });
    const fake = wire([
      chunks("read", {}),
      chunks("run_code", { code: "return await tools.read({});" }),
      done,
    ]);
    const beforeTool = vi.fn(() => {});
    const inputGuard = vi.fn(() => ({ allow: true as const }));
    const outputGuard = vi.fn(() => ({ allow: true as const }));
    const events: AgentEvent[] = [];
    const agent = defineAgent({
      ...base,
      provider: fake.provider,
      tools: [tool, mode],
      toolRetries: { identity: "retry", tools: { read: { maxAttempts: 2, replay: "read-only" } } },
      guardrails: { identity: "guard", toolInput: inputGuard, toolOutput: outputGuard },
    });
    const result = await agent.run("Read", {
      host: { ...host, beforeTool },
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(4);
    // Reauthorize after start observers and after inner-call checkpoints, not just admission.
    expect(beforeTool).toHaveBeenCalledTimes(12);
    expect(inputGuard).toHaveBeenCalledTimes(5);
    expect(outputGuard).toHaveBeenCalledTimes(5);
    const receipts = result.receipts.filter(
      (receipt) => receipt.kind === "tool" && receipt.parentOperationId,
    );
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(1);
    expect(new Set(receipts.map((receipt) => receipt.attemptId)).size).toBe(2);
    expect(
      events.filter((event) => event.type === "tool_start" && event.request.parentOperationId),
    ).toHaveLength(2);
    expect(
      (await agent.resume(result.snapshot, { host: { ...host, authorizeResume() {} } })).status,
    ).toBe("completed");
  });

  it.each(["guard", "authorization"])(
    "stops inner effects at the shared %s boundary",
    async (boundary) => {
      const effect = vi.fn(async () => 3);
      const { agent } = setup(
        "try { await tools.read({}); } catch {} return 1;",
        [ordinary("read", { run: effect })],
        {},
        boundary === "guard"
          ? {
              guardrails: {
                identity: "deny",
                toolInput: (request) => ({ allow: !request.parentOperationId }),
              },
            }
          : {},
      );
      const result = await agent.run("Read", {
        host: {
          ...host,
          beforeTool(request) {
            if (boundary === "authorization" && request.parentOperationId)
              throw new Error("Access revoked");
          },
        },
      });
      expect(result.status).toBe("failed");
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("settles every admitted call when synchronous concurrency admission throws", async () => {
    const effect = vi.fn(async () => "read");
    const { agent, definitions } = setup(
      "try { await Promise.all([tools.read({n:1}), tools.read({n:2})]); } catch {} return 1;",
      [ordinary("read", { run: effect, isConcurrencySafe: true })],
    );
    let checkpoint: RunSnapshot | undefined;
    const canRunConcurrently = vi.fn((request: ToolRequest) => {
      if (request.arguments.n === 2) throw new Error("Admission failed");
      return true;
    });
    const result = await agent.run("Read", {
      host: {
        ...host,
        canRunConcurrently,
        checkpoint(snapshot) {
          if (snapshot.kind !== "agent") throw new Error("Expected agent");
          checkpoint = structuredClone(snapshot);
        },
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "execution_failed", message: "Admission failed" },
    });
    expect(canRunConcurrently).toHaveBeenCalledTimes(2);
    expect(effect).not.toHaveBeenCalled();
    expect(definitions).toHaveLength(1);
    expect(calls(result.snapshot)).toHaveLength(2);
    expect(calls(result.snapshot).map((call) => [call.status, call.started])).toEqual([
      ["completed", false],
      ["completed", false],
    ]);
    expect(execution(result.snapshot).status).toBe("running");
    expect(
      result.receipts.filter((receipt) => receipt.kind === "tool" && receipt.parentOperationId),
    ).toEqual(
      calls(result.snapshot).map((call) =>
        expect.objectContaining({
          id: call.id,
          status: "completed",
          result: {
            ok: false,
            kind: "aborted",
            content: "The program stopped before this call started. It did not run.",
          },
        }),
      ),
    );
    expect(() => agent[AGENT_RUNTIME].restore(saved(checkpoint))).not.toThrow();
    expect(
      (await agent.resume(saved(checkpoint), { host: { ...host, authorizeResume() {} } })).status,
    ).toBe("failed");
    expect(definitions).toHaveLength(1);
  });

  it("serializes unsafe calls while bounding safe parallelism and reserving the final slot", async () => {
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const read = ordinary("read", {
      isConcurrencySafe: true,
      run: async (input) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        running--;
        return input;
      },
    });
    const write = ordinary("write", {
      isReadOnly: false,
      run: async (input) => {
        expect(running).toBe(0);
        if (input && typeof input === "object" && "n" in input && typeof input.n === "number")
          order.push(input.n);
        return input;
      },
    });
    const mode = codeMode({ tools: [read, write], driver, limits: { calls: 20 } });
    const fake = wire([
      chunks("run_code", {
        code: "return await Promise.allSettled([tools.read({}), tools.read({}), tools.write({n:1}), tools.read({}), tools.write({n:2}), tools.read({})]);",
      }),
      chunks("submit_result", { done: true }),
    ]);
    const agent = defineAgent({
      ...base,
      provider: fake.provider,
      tools: [mode],
      limits: { toolCalls: 7, parallelTools: 2 },
      output: { schema: { type: "object" }, validate: (value) => value },
    });
    const result = await agent.run("Read", { host: { ...host, canRunConcurrently: () => true } });
    expect(result.status).toBe("completed");
    expect(calls(result.snapshot)).toHaveLength(5);
    expect(order).toEqual([1, 2]);
    expect(peak).toBe(2);
    expect(program(result.snapshot)).toMatchObject({ toolCalls: 5, toolCallsLeft: 0 });
  });

  it.each([false, true])(
    "requires separate inner-tool grants for a model-created helper (%s)",
    async (grant) => {
      const effect = vi.fn(async () => "read");
      const mode = codeMode({ tools: [ordinary("read", { run: effect })], driver });
      const worker = defineAgent({
        ...base,
        id: "worker",
        provider: wire([chunks("run_code", { code: "return await tools.read({});" }), done])
          .provider,
        tools: [mode],
      });
      const create = subagentTool({
        name: "helpers",
        description: "Create helpers",
        agent: worker,
      });
      const agent = defineAgent({
        ...base,
        provider: wire([
          chunks("helpers", {
            agents: [
              { name: "reader", task: "Read", tools: grant ? ["run_code", "read"] : ["run_code"] },
            ],
          }),
          done,
        ]).provider,
        tools: [mode, create],
      });
      const result = await agent.run("Read", { host });
      expect(result.status).toBe("completed");
      expect(effect).toHaveBeenCalledTimes(grant ? 1 : 0);
      const child = result.snapshot.delegations[0]?.children[0]?.snapshot;
      if (child?.kind !== "agent") throw new Error("Missing generated agent");
      expect(calls(child)).toHaveLength(grant ? 1 : 0);
      expect(() => agent[AGENT_RUNTIME].restore(result.snapshot)).not.toThrow();
    },
  );

  it("shares the tree's effect barrier with direct tools in another specialist", async () => {
    let active = 0;
    let peak = 0;
    const write = ordinary("write", {
      isReadOnly: false,
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        active--;
        return "changed";
      },
    });
    const coder = setup("return await tools.write({});", [write], {}, { id: "coder" }).agent;
    const direct = defineAgent({
      ...base,
      id: "direct",
      provider: wire([chunks("write", {}), done]).provider,
      tools: [write],
    });
    const coordinate = defineDelegation({
      name: "coordinate",
      description: "Run both checks",
      inputSchema: { type: "object" },
      validate: () => undefined,
      specialists: [coder, direct],
      async run(_input, context) {
        const results = await context.join([
          context.child("code", coder, "Write"),
          context.child("direct", direct, "Write"),
        ]);
        return results.map((result) => result.status);
      },
    });
    const agent = defineAgent({
      ...base,
      provider: wire([chunks("coordinate", {}), done]).provider,
      tools: [coordinate],
    });
    const result = await agent.run("Write", { host: { ...host, canRunConcurrently: () => true } });
    expect(result.status).toBe("completed");
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(() => agent[AGENT_RUNTIME].restore(result.snapshot)).not.toThrow();
  });

  it("reserves retry budgets again after awaited host reconciliation", async () => {
    let reserve = () => {};
    let effects = 0;
    const tool = ordinary("write", {
      isReadOnly: false,
      run: async () => {
        if (++effects === 1) throw new Error("Not performed");
        return "changed";
      },
    });
    const custom: CodeDriver = {
      async run(job) {
        let queued: Promise<string> | undefined;
        reserve = () => {
          queued = job.call("write", "{}");
        };
        await job.call("write", "{}");
        await queued;
        return { ok: true, envelope: '{"ok":true}' };
      },
    };
    const { agent } = setup(
      "return 1;",
      [tool],
      { driver: custom, limits: { calls: 2 } },
      {
        limits: { toolCalls: 4 },
        toolRetries: {
          identity: "writes",
          tools: { write: { replay: "reconcile", maxAttempts: 2 } },
        },
      },
    );
    const result = await agent.run("Write", {
      host: {
        ...host,
        reconcileToolRetry() {
          reserve();
          return { outcome: "not_run", receipt: "verified-no-effect" };
        },
      },
    });
    expect(result.status).toBe("completed");
    expect(effects).toBe(2);
    expect(calls(result.snapshot).map((call) => call.retries.length)).toEqual([0, 0]);
    expect(() => agent[AGENT_RUNTIME].restore(result.snapshot)).not.toThrow();
  });

  it("aborts abandoned running calls, closes queued calls and waits for recorded settlement", async () => {
    let resolveLate: ((value: string) => void) | undefined;
    const effect = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
    );
    const slow = ordinary("slow", { isReadOnly: false, run: effect });
    const { agent } = setup(
      "tools.slow({}); tools.slow({}); await tools.tick({}); return 1;",
      [slow, ordinary("tick")],
      { limits: { timeoutMs: 40 } },
      { limits: { parallelTools: 3 } },
    );
    // A trusted test driver models a caller which returns without awaiting a host call.
    const driver: CodeDriver = {
      async run(job) {
        void job.call("slow", "{}");
        void job.call("slow", "{}");
        while (!resolveLate) await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return { ok: true, envelope: '{"ok":true,"value":1}' };
      },
    };
    const mode = codeMode({ tools: [slow], driver });
    const fake = wire([chunks("run_code", { code: "return 1;" }), done]);
    const custom = defineAgent({ ...base, provider: fake.provider, tools: [mode] });
    const result = await custom.run("Read", { host });
    expect(result.status).toBe("completed");
    expect(effect).toHaveBeenCalledOnce();
    expect(calls(result.snapshot).map((call) => [call.status, call.started])).toEqual([
      ["completed", true],
      ["completed", false],
    ]);
    const stable = JSON.stringify(result.snapshot);
    resolveLate?.("late effect");
    await Promise.resolve();
    expect(JSON.stringify(result.snapshot)).toBe(stable);
    expect(
      (await custom.resume(result.snapshot, { host: { ...host, authorizeResume() {} } })).status,
    ).toBe("completed");
    // Keep the real-driver hanging program in the same focused boundary check.
    const stopped = await agent.run("Read", { host });
    expect(stopped.status).toBe("completed");
    expect(calls(stopped.snapshot).every((call) => call.status === "completed")).toBe(true);
  }, 40_000);

  it.each(["observer", "guard"] as const)(
    "bounds a waiting inner output %s by the program deadline",
    async (boundary) => {
      let entered = false;
      let release = () => {};
      const { agent } = setup(
        "return await tools.read({});",
        [ordinary()],
        { limits: { timeoutMs: 50 } },
        {
          limits: { elapsedMs: 1000 },
          ...(boundary === "guard"
            ? {
                guardrails: {
                  identity: "slow-output",
                  toolOutput: ({ request }) => {
                    if (!request.parentOperationId) return { allow: true };
                    entered = true;
                    return new Promise<{ allow: true }>((resolve) => {
                      release = () => resolve({ allow: true });
                    });
                  },
                },
              }
            : {}),
        },
      );
      const result = await agent.run("Read", {
        host,
        async onLifecycle(event) {
          if (
            boundary === "observer" &&
            event.type === "tool_end" &&
            event.request.parentOperationId
          ) {
            entered = true;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
        },
      });
      expect(entered).toBe(true);
      expect(result.status).toBe(boundary === "observer" ? "completed" : "failed");
      if (boundary === "observer")
        expect(execution(result.snapshot)).toMatchObject({
          status: "completed",
          result: { kind: "timeout" },
        });
      else expect(result).toMatchObject({ error: { code: "guard_failed" } });
      expect(calls(result.snapshot).every((call) => call.status === "completed")).toBe(true);
      const final = JSON.stringify(result.snapshot);
      release();
      await Promise.resolve();
      expect(JSON.stringify(result.snapshot)).toBe(final);
      expect(() => agent[AGENT_RUNTIME].restore(result.snapshot)).not.toThrow();
    },
  );

  it.each(["approve", "deny", "cancel", "pending", "missing"] as const)(
    "handles immediate approval %s without suspension",
    async (decision) => {
      const effect = vi.fn(async (value: unknown) => value);
      const tool = ordinary("read", { run: effect });
      const { agent } = setup(
        "try { return await tools.read({n:1}); } catch (e) { return e.kind; }",
        [tool],
      );
      const beforeTool = vi.fn(() => {});
      const authority: AgentHost = {
        ...host,
        beforeTool,
        needsApproval: (request) => !!request.parentOperationId,
        ...(decision === "missing"
          ? {}
          : {
              prepareRequest: () => ({
                scope: {
                  actorId: "owner",
                  resource: { id: "record", version: "1" },
                  expiresAt: Date.now() + 60_000,
                },
                ask: { type: "approval" as const, editable: true },
              }),
              answerNow: () =>
                decision === "pending"
                  ? undefined
                  : decision === "approve"
                    ? { type: "approve" as const, arguments: { n: 9 } }
                    : { type: decision },
            }),
      };
      const result = await agent.run("Read", { host: authority });
      expect(result.status).toBe("completed");
      expect(effect).toHaveBeenCalledTimes(decision === "approve" ? 1 : 0);
      if (decision === "approve") {
        expect(program(result.snapshot)).toMatchObject({ result: { n: 9 } });
        expect(beforeTool.mock.calls).toHaveLength(5);
        expect(beforeTool).toHaveBeenLastCalledWith(
          expect.objectContaining({ arguments: { n: 9 } }),
          expect.objectContaining({
            decision: expect.objectContaining({ type: "approve", arguments: { n: 9 } }),
          }),
        );
      }
      expect(
        (await agent.resume(result.snapshot, { host: { ...authority, authorizeResume() {} } }))
          .status,
      ).toBe("completed");
    },
  );

  it("does not admit a code-only tool through a direct parallel batch", async () => {
    const effect = vi.fn(async () => "private");
    const direct = ordinary("direct", { isConcurrencySafe: true });
    const hidden = ordinary("hidden", { isConcurrencySafe: true, run: effect });
    const mode = codeMode({ tools: [hidden], driver });
    const fake = wire([
      [
        {
          type: "finish",
          finishReason: "tool_calls",
          toolCalls: [
            { index: 0, id: "direct", name: "direct", arguments: "{}" },
            { index: 1, id: "hidden", name: "hidden", arguments: "{}" },
          ],
        },
      ],
      done,
    ]);
    const agent = defineAgent({ ...base, provider: fake.provider, tools: [direct, mode] });
    const result = await agent.run("Read", { host: { ...host, canRunConcurrently: () => true } });
    expect(result.status).toBe("completed");
    expect(effect).not.toHaveBeenCalled();
    const model = result.snapshot.models[0];
    expect(model?.status === "completed" && model.tools[1]).toMatchObject({
      status: "completed",
      result: { kind: "disabled_tool" },
    });
  });

  it.each(["lifecycle", "event", "checkpoint", "authorization", "policy"] as const)(
    "refuses an inner approval expired by %s without suspending",
    async (boundary) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const effect = vi.fn(async () => "changed");
        const { agent } = setup(
          "try { await tools.write({}); } catch (e) { return e.kind; }",
          [ordinary("write", { isReadOnly: false, run: effect })],
          {},
          { guardrails: { identity: "checked", toolOutput: () => ({ allow: true }) } },
        );
        let atStart = false;
        let advanced = false;
        const advance = () => {
          if (!advanced) {
            vi.setSystemTime(Date.now() + 6);
            advanced = true;
          }
        };
        const result = await agent.run("Write", {
          host: {
            ...host,
            prepareRequest: () => ({
              scope: {
                actorId: "owner",
                resource: { id: "record", version: "1" },
                expiresAt: Date.now() + 5,
              },
            }),
            answerNow: () => ({ type: "approve" }),
            needsApproval(request) {
              if (boundary === "policy" && atStart && request.parentOperationId) advance();
              return !!request.parentOperationId;
            },
            beforeTool(request) {
              if (boundary === "authorization" && request.parentOperationId) advance();
            },
            checkpoint(snapshot) {
              if (snapshot.kind !== "agent") throw new Error("Expected agent");
              const model = snapshot.models[0];
              if (
                boundary === "checkpoint" &&
                model?.status === "completed" &&
                model.tools[0]?.calls?.[0]?.status === "running"
              )
                advance();
            },
          },
          onLifecycle(event) {
            if (
              boundary === "lifecycle" &&
              event.type === "tool_start" &&
              event.request.parentOperationId
            )
              advance();
          },
          onEvent(event) {
            if (event.type === "tool_start" && event.request.parentOperationId) {
              atStart = true;
              if (boundary === "event") advance();
            }
          },
        });
        expect(result.status).toBe("completed");
        expect(effect).not.toHaveBeenCalled();
        expect(program(result.snapshot)).toMatchObject({ result: "denied" });
        expect(calls(result.snapshot)[0]?.asks?.map((ask) => ask.closed)).toEqual([
          "expired",
          "stopped",
        ]);
        expect(() => agent[AGENT_RUNTIME].restore(result.snapshot)).not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("renews an outer program approval before entering the VM", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const run = vi.fn(driver.run);
      const { agent } = setup("return await tools.read({});", [ordinary()], {
        needsApproval: true,
        driver: { run },
      });
      const result = await agent.run("Read", {
        host: {
          ...host,
          prepareRequest: () => ({
            scope: {
              actorId: "owner",
              resource: { id: "record", version: "1" },
              expiresAt: Date.now() + 5,
            },
          }),
          answerNow: () => ({ type: "approve" }),
        },
        onEvent(event) {
          if (event.type === "tool_start") vi.setSystemTime(Date.now() + 6);
        },
      });
      expect(result.status).toBe("suspended");
      expect(run).not.toHaveBeenCalled();
      expect(execution(result.snapshot)).toMatchObject({ status: "pending" });
      expect(() => agent[AGENT_RUNTIME].restore(result.snapshot)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses dynamic questions as data and respects stop decisions", async () => {
    const asking = ordinary("question", {
      run: async () => {
        throw new InputRequired({ key: "x", message: "Which one?" });
      },
    });
    const first = setup("try { await tools.question({}); } catch (e) { return e.kind; }", [asking]);
    const result = await first.agent.run("Ask", { host });
    expect(program(result.snapshot)).toMatchObject({ result: "denied" });
    expect(calls(result.snapshot)[0]?.asks).toBeUndefined();
    const second = setup("await tools.read({});");
    const stopped = await second.agent.run("Read", {
      host: {
        ...host,
        needsApproval: (request) => !!request.parentOperationId,
        prepareRequest: () => ({
          scope: {
            actorId: "owner",
            resource: { id: "record", version: "1" },
            expiresAt: Date.now() + 60_000,
          },
        }),
        answerNow: () => ({ type: "stop" }),
      },
    });
    expect(stopped.status).toBe("cancelled");
    expect(calls(stopped.snapshot).every((call) => call.status === "completed")).toBe(true);
  });

  it("fails closed on an unknown write and never replays completed changes", async () => {
    const effect = vi.fn(async () => "changed");
    const { agent } = setup("return await tools.write({});", [
      ordinary("write", { isReadOnly: false, run: effect }),
    ]);
    let checkpoint: RunSnapshot | undefined;
    const first = await agent.run("Write", {
      host: {
        ...host,
        checkpoint(snapshot) {
          if (snapshot.kind !== "agent") throw new Error("Expected agent");
          const model = snapshot.models[0];
          const call = model?.status === "completed" ? model.tools[0]?.calls?.[0] : undefined;
          if (call?.status === "completed") throw new Error("Worker lost after effect");
          checkpoint = structuredClone(snapshot);
        },
      },
    });
    expect(first.status).toBe("failed");
    expect(effect).toHaveBeenCalledOnce();
    const result = await agent.resume(saved(checkpoint), {
      host: { ...host, authorizeResume() {} },
    });
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "interrupted_operation",
        operationId: `${execution(saved(checkpoint)).id}/call/1`,
      },
    });
    expect(effect).toHaveBeenCalledOnce();
    const second = setup("return await tools.write({});", [
      ordinary("write", { isReadOnly: false, run: effect }),
    ]);
    const completed = await second.agent.run("Write", { host });
    const known = interrupted(completed.snapshot);
    // A new provider turn is not needed to reconcile or repeat the saved program.
    const replacement = defineAgent({
      ...base,
      provider: wire([done]).provider,
      tools: [second.mode],
    });
    const resumed = await replacement.resume(known, { host: { ...host, authorizeResume() {} } });
    expect(resumed.status).toBe("completed");
    expect(execution(resumed.snapshot)).toMatchObject({
      status: "completed",
      result: { kind: "interrupted" },
    });
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("restarts only explicit read-only programs with new attempts and continuing call ids", async () => {
    const effect = vi.fn(async () => 4);
    const { agent, mode } = setup(
      "return await tools.read({});",
      [ordinary("read", { run: effect })],
      {},
      { recovery: { identity: "reads", maxAttempts: 2, readOnlyTools: ["run_code"] } },
    );
    const result = await agent.run("Read", { host });
    const prior = interrupted(result.snapshot);
    const replacement = defineAgent({
      ...base,
      provider: wire([done]).provider,
      tools: [mode],
      recovery: { identity: "reads", maxAttempts: 2, readOnlyTools: ["run_code"] },
    });
    const resumed = await replacement.resume(prior, { host: { ...host, authorizeResume() {} } });
    expect(resumed.status).toBe("completed");
    expect(effect).toHaveBeenCalledTimes(2);
    expect(calls(resumed.snapshot).map((call) => call.id)).toEqual([
      `${execution(prior).id}/call/1`,
      `${execution(prior).id}/call/2`,
    ]);
    expect(new Set(calls(resumed.snapshot).map((call) => call.programAttemptId)).size).toBe(2);
    expect(execution(resumed.snapshot).interrupted).toHaveLength(1);
    expect(() => replacement[AGENT_RUNTIME].restore(resumed.snapshot)).not.toThrow();
    expect(() => checkChildProgress(prior, resumed.snapshot)).not.toThrow();
  });

  it.each(["pending", "running", "completed"] as const)(
    "closes a %s read after interruption without implicit replay",
    async (status) => {
      const effect = vi.fn(async () => "read");
      const { agent, mode } = setup("return await tools.read({});", [
        ordinary("read", { run: effect }),
      ]);
      const completed = await agent.run("Read", { host });
      const prior = interrupted(completed.snapshot);
      const call = calls(prior)[0];
      if (call?.status !== "completed") throw new Error("Missing completed read");
      if (status !== "completed") {
        const { result: _result, bytes: _bytes, ...entry } = call;
        calls(prior)[0] = { ...entry, status, started: status === "running" };
      }
      const replacement = defineAgent({ ...base, provider: wire([done]).provider, tools: [mode] });
      const result = await replacement.resume(prior, { host: { ...host, authorizeResume() {} } });
      expect(result.status).toBe("completed");
      expect(effect).toHaveBeenCalledOnce();
      expect(execution(result.snapshot)).toMatchObject({
        status: "completed",
        result: { kind: "interrupted" },
      });
      expect(calls(result.snapshot)[0]?.status).toBe("completed");
      expect(() => replacement[AGENT_RUNTIME].restore(result.snapshot)).not.toThrow();
    },
  );

  it("keeps monotonic child progress when an inner retry returns a different byte count", async () => {
    let attempt = 0;
    const checkpoints: RunSnapshot[] = [];
    const { agent } = setup(
      "return await tools.read({});",
      [
        ordinary("read", {
          run: async () => {
            if (++attempt === 1) throw new Error("Try later");
            return "ok";
          },
        }),
      ],
      {},
      {
        toolRetries: {
          identity: "reads",
          tools: { read: { maxAttempts: 2, replay: "read-only" } },
        },
      },
    );
    const result = await agent.run("Read", {
      host: {
        ...host,
        checkpoint(snapshot) {
          if (snapshot.kind !== "agent") throw new Error("Expected agent");
          checkpoints.push(structuredClone(snapshot));
        },
      },
    });
    expect(result.status).toBe("completed");
    expect(calls(result.snapshot)[0]?.retries).toHaveLength(1);
    for (const [index, previous] of checkpoints.entries()) {
      const next = checkpoints[index + 1];
      if (next) expect(() => checkChildProgress(previous, next)).not.toThrow();
      expect(() => agent[AGENT_RUNTIME].restore(previous)).not.toThrow();
    }
  });

  it("enforces UTF-8 source, input, result and log ceilings while retaining oversized effects", async () => {
    const small = setup('return "é".repeat(80);', [ordinary()], { limits: { resultBytes: 32 } });
    const result = await small.agent.run("Read", { host });
    expect(execution(result.snapshot)).toMatchObject({
      status: "completed",
      result: { kind: "invalid_input" },
    });
    const source = setup("/*" + "é".repeat(20) + "*/", [ordinary()], {
      limits: { sourceBytes: 32 },
    });
    expect(execution((await source.agent.run("Read", { host })).snapshot)).toMatchObject({
      status: "completed",
      result: { kind: "invalid_input" },
    });
    const input = setup(
      'try { await tools.read({text:"é".repeat(20)}); } catch(e) { return e.kind; }',
      [ordinary()],
      { limits: { callInputBytes: 32 } },
    );
    const refused = await input.agent.run("Read", { host });
    expect(calls(refused.snapshot)).toHaveLength(0);
    expect(program(refused.snapshot)).toMatchObject({ result: "invalid_input" });
    const effect = vi.fn(async () => "é".repeat(2000));
    const output = setup(
      'console.log("é".repeat(20)); try { await tools.write({}); } catch(e) { return e.kind; }',
      [ordinary("write", { run: effect, isReadOnly: false })],
      { limits: { callOutputBytes: 32, logBytes: 9 } },
    );
    const oversized = await output.agent.run("Write", { host });
    expect(program(oversized.snapshot)).toMatchObject({
      result: "invalid_output",
      droppedLogBytes: 32,
    });
    expect(textBytes(String(program(oversized.snapshot).logs))).toBeLessThanOrEqual(9);
    expect(calls(oversized.snapshot)[0]).toMatchObject({
      status: "completed",
      started: true,
      bytes: 4002,
      result: { ok: true },
    });
    expect(effect).toHaveBeenCalledOnce();
  });

  it.each(["symbol", "getter", "sparse", "undefined", "cycle"])(
    "records an effect but refuses its non-JSON %s output",
    async (kind) => {
      const getter = vi.fn(() => 1);
      let value: unknown;
      if (kind === "symbol") value = { [Symbol("hidden")]: "secret" };
      if (kind === "getter")
        value = Object.defineProperty({}, "value", { enumerable: true, get: getter });
      if (kind === "sparse") value = Object.assign(new Array(1), { other: "value" });
      if (kind === "undefined") value = { nested: undefined };
      if (kind === "cycle") {
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        value = cycle;
      }
      const effect = vi.fn(async () => value);
      const { agent } = setup("try { await tools.write({}); } catch (e) { return e.kind; }", [
        ordinary("write", { isReadOnly: false, run: effect, summarize: () => "Changed" }),
      ]);
      const result = await agent.run("Write", { host });
      expect(result.status).toBe("completed");
      expect(program(result.snapshot)).toMatchObject({ result: "invalid_output" });
      expect(calls(result.snapshot)[0]).toMatchObject({
        status: "completed",
        started: true,
        result: { ok: true },
      });
      expect(effect).toHaveBeenCalledOnce();
      expect(getter).not.toHaveBeenCalled();
      expect(() => agent[AGENT_RUNTIME].restore(result.snapshot)).not.toThrow();
    },
  );

  it("keeps runtime errors separate from tiny JSON return limits", async () => {
    const { agent } = setup('throw new Error("é".repeat(1000));', [ordinary()], {
      limits: { resultBytes: 8 },
    });
    const result = await agent.run("Read", { host });
    expect(execution(result.snapshot)).toMatchObject({
      status: "completed",
      result: { kind: "failed" },
    });
    expect(program(result.snapshot)).toMatchObject({ error: { name: "ProgramError", line: 1 } });
    expect(() => agent[AGENT_RUNTIME].restore(result.snapshot)).not.toThrow();
  });

  it.each(["return NaN;", "return {x:undefined};", "return 1n;", "return (; "])(
    "rejects non-JSON or invalid program output %s",
    async (code) => {
      const { agent } = setup(code);
      expect(execution((await agent.run("Read", { host })).snapshot)).toMatchObject({
        status: "completed",
        result: { kind: "invalid_input" },
      });
    },
  );

  it("rejects tampered call names, ids, bytes, attempts, unfinished programs and dropped child receipts", async () => {
    const { agent } = setup("return await tools.read({});");
    const result = await agent.run("Read", { host });
    for (const mutate of [
      (entry: ProgramCall) => {
        entry.name = "unbound";
      },
      (entry: ProgramCall) => {
        entry.id += "x";
      },
      (entry: ProgramCall) => {
        entry.attemptId = "invented";
      },
      (entry: ProgramCall) => {
        entry.arguments = { text: "x".repeat(CODE_LIMITS.callInputBytes) };
      },
      (entry: ProgramCall) => {
        if (entry.status === "completed") entry.result.content = "x".repeat(1025);
      },
    ]) {
      const bad = structuredClone(result.snapshot);
      const call = calls(bad)[0];
      if (!call) throw new Error("Missing inner call");
      mutate(call);
      expect(() => agent[AGENT_RUNTIME].restore(bad)).toThrow();
    }
    const unfinished = structuredClone(result.snapshot);
    const entry = calls(unfinished)[0];
    if (!entry) throw new Error("Missing inner call");
    calls(unfinished)[0] = { ...entry, status: "running" };
    expect(() => agent[AGENT_RUNTIME].restore(unfinished)).toThrow();
    const dropped = structuredClone(result.snapshot);
    calls(dropped).pop();
    expect(() => checkChildProgress(result.snapshot, dropped)).toThrow();
  });
});
