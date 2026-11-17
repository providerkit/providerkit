// Validation/replay cases adapted from PydanticAI Harness / Vstorm (MIT),
// test_task_control.py and test_dbos.py; attenuation from TanStack AI (MIT), agents.test.ts.
import { describe, expect, it, vi } from "vitest";
import { assertAgent, assertCall } from "./fixtures/assertions.ts";
import {
  defineTool,
  type ChatMessage,
  type Provider,
  type ProviderChunk,
  type StreamOptions,
  type ToolDefinition,
} from "@providerkit/core";
import {
  createMemorySession,
  createMemoryStore,
  defineAgent,
  defineHandoff,
  subagentTool,
  SUBAGENT_SPEC_BYTES,
  type Agent,
  type AgentEvent,
  type AgentHost,
  type RunSnapshot,
  type SubagentToolSpec,
  type ToolResult,
} from "../src/index.ts";
import { AGENT_RUNTIME } from "../src/delegation.ts";
import { isRecord } from "../src/snapshot.ts";

const base = { version: "1", instructions: "Host instructions." };
const usage = { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0 };
const draft = { name: "private_name", task: "Private task", instructions: "Private instructions" };
function call(name: string, args: Record<string, unknown> = {}): ProviderChunk[] {
  return [
    { type: "delta", toolCalls: [{ index: 0, id: name, name, arguments: JSON.stringify(args) }] },
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
function wire(...turns: (ProviderChunk[] | ((messages: ChatMessage[]) => ProviderChunk[]))[]) {
  const calls: { messages: ChatMessage[]; tools: ToolDefinition[]; options?: StreamOptions }[] = [];
  const provider: Provider = {
    id: "offline",
    model: "default",
    async *createStream(messages, tools, options) {
      const turn = turns[calls.length];
      calls.push({
        messages: structuredClone(messages),
        tools: structuredClone(tools ?? []),
        options,
      });
      if (!turn) throw new Error("Unexpected model call");
      yield* typeof turn === "function" ? turn(messages) : turn;
    },
  };
  return { provider, calls };
}
function tool(name = "read", options: { approval?: boolean; description?: string } = {}) {
  const performed = vi.fn(async () => "Tool result");
  return {
    ...defineTool({
      name,
      description: options.description ?? `Use ${name}.`,
      inputSchema: { type: "object" },
      isReadOnly: true,
      needsApproval: options.approval,
      run: performed,
    }),
    performed,
  };
}
function lead(
  worker: Agent<unknown>,
  args: Record<string, unknown>,
  spec: Partial<SubagentToolSpec> = {},
  tools: NonNullable<Parameters<typeof defineAgent>[0]["tools"]> = [],
  source = wire(call("create_helpers", args), text("Combined")),
) {
  const agent = defineAgent({
    ...base,
    id: "lead",
    provider: source.provider,
    tools: [
      ...tools,
      subagentTool({
        name: "create_helpers",
        description: "Create helpers.",
        agent: worker,
        ...spec,
      }),
    ],
  });
  return { agent, source };
}
function children(snapshot: RunSnapshot) {
  return snapshot.delegations.flatMap((entry) =>
    entry.children.map(({ snapshot }) => {
      assertAgent(snapshot);
      return snapshot;
    }),
  );
}
function first(snapshot: RunSnapshot): RunSnapshot {
  const node = children(snapshot)[0];
  if (!node) throw new Error("Expected helper");
  return node;
}
function result(snapshot: RunSnapshot): ToolResult {
  const model = snapshot.models[0];
  const tool = model?.status === "completed" ? model.tools[0] : undefined;
  if (tool?.status !== "completed") throw new Error("Expected settled creation tool");
  return tool.result;
}
function host(): AgentHost & { authorizeResume(): void } {
  return {
    authorizeResume: vi.fn(),
    beforeTool: vi.fn(),
    prepareRequest: () => ({
      scope: {
        actorId: "owner",
        resource: { id: "record", version: "1" },
        expiresAt: Date.now() + 60_000,
      },
    }),
    resolveRequest: () => ({ type: "approve" }),
  };
}

describe("model-created helpers", () => {
  it("records the admitted definition before work, attenuates tools and keeps names out of child identity", async () => {
    const read = tool();
    const edit = tool("edit");
    const target = wire(call("read"), text("Helper answer"));
    const guard = vi.fn(() => ({ allow: true as const }));
    const worker = defineAgent({
      ...base,
      id: "worker",
      provider: target.provider,
      tools: [read, edit],
      modelSettings: { maxTokens: 512 },
      guardrails: { identity: "worker-1", modelInput: guard },
    });
    const { agent } = lead(
      worker,
      { agents: [{ ...draft, tools: ["read"], model: "small" }] },
      {
        models: {
          small: {
            description: "Small model.",
            settings: { model: "offline-small", effort: "low" },
          },
        },
      },
      [edit, read],
    );
    const events: AgentEvent[] = [];
    const checkpoints: RunSnapshot[] = [];
    const policy = host();
    const session = createMemorySession({
      messages: [{ role: "user", content: "Private earlier turn" }],
    });
    const finished = await agent.run("Root task", {
      session,
      host: {
        ...policy,
        checkpoint: (snapshot) => {
          assertAgent(snapshot);
          checkpoints.push(snapshot);
        },
      },
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(finished.status).toBe("completed");
    const node = first(finished.snapshot);
    expect(node.input).toBe(draft.task);
    expect(node.history).toEqual([]);
    expect(node.session).toBeUndefined();
    expect(node.definition.enabledTools).toEqual(["read"]);
    expect(node.definition.instructions).toBe(
      `${base.instructions}\n\nInstructions from the agent that created you:\n${draft.instructions}`,
    );
    expect(node.subagent).toMatchObject({
      tool: "create_helpers",
      requested: { ...draft, tools: ["read"], model: "small" },
    });
    expect(target.calls[0]?.options).toMatchObject({
      maxTokens: 512,
      model: "offline-small",
      effort: "low",
      sessionId: node.runId,
    });
    expect(target.calls[0]?.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(
      checkpoints.some((saved) =>
        children(saved).some((child) => !!child.subagent && child.models.length === 0),
      ),
    ).toBe(true);
    expect(guard).toHaveBeenCalledTimes(2);
    expect(policy.beforeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        subagent: draft.name,
        call: expect.objectContaining({ name: "read" }),
      }),
      undefined,
    );
    const childEvents = events.filter((event) => event.type === "child");
    expect(childEvents).toHaveLength(1);
    expect(childEvents[0]).toMatchObject({ subagent: true, key: "helper-1", agentId: "worker" });
    for (const privateValue of Object.values(draft))
      expect(JSON.stringify(childEvents)).not.toContain(privateValue);
    expect(node.runId).not.toContain(draft.name);
    expect(finished.treeUsage.inputTokens).toBe(16);
  });

  it.each([
    { ...draft, tools: ["missing"] },
    { ...draft, model: "raw-vendor-model" },
    { ...draft, hostedTools: [{ type: "web_search" }] },
    { ...draft, credentials: "secret" },
    { ...draft, limits: { turns: 200 } },
    { ...draft, scope: "another-person" },
    { ...draft, name: "name with spaces" },
    { ...draft, task: "" },
    { ...draft, instructions: "x".repeat(SUBAGENT_SPEC_BYTES) },
  ])("rejects invalid or authority-bearing specifications before admission: %j", async (spec) => {
    const target = wire();
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
    const { agent } = lead(worker, { agents: [spec] });
    const finished = await agent.run("Create a helper");
    expect(finished.status).toBe("completed");
    expect(result(finished.snapshot)).toMatchObject({ ok: false, kind: "invalid_input" });
    expect(children(finished.snapshot)).toEqual([]);
    expect(target.calls).toEqual([]);
  });

  it("requires object identity, current creator selection and unique names for the whole batch", async () => {
    const shared = tool();
    const target = wire();
    const worker = defineAgent({
      ...base,
      id: "worker",
      provider: target.provider,
      tools: [shared],
    });
    for (const mode of ["different-object", "disabled", "duplicate"] as const) {
      const { agent } = lead(
        worker,
        { agents: mode === "duplicate" ? [draft, draft] : [{ ...draft, tools: ["read"] }] },
        {},
        [mode === "different-object" ? tool() : shared],
      );
      const finished = await agent.run(
        "Create",
        mode === "disabled" ? { enabledTools: ["create_helpers"] } : {},
      );
      expect(result(finished.snapshot).ok).toBe(false);
      expect(children(finished.snapshot)).toEqual([]);
    }
    expect(target.calls).toHaveLength(0);
  });

  it("defaults to no tools and refuses calls to ungranted tools", async () => {
    const read = tool();
    const target = wire(call("read"), text());
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider, tools: [read] });
    const { agent } = lead(worker, { agents: [draft] }, {}, [read]);
    const finished = await agent.run("Create");
    expect(finished.status).toBe("completed");
    expect(target.calls[0]?.tools).toEqual([]);
    expect(result(first(finished.snapshot))).toMatchObject({ ok: false, kind: "disabled_tool" });
    expect(read.performed).not.toHaveBeenCalled();
  });

  it("runs a declared batch concurrently but joins in declaration order", async () => {
    let active = 0;
    let peak = 0;
    const bothStarted = Promise.withResolvers<void>();
    const provider: Provider = {
      id: "offline",
      model: "default",
      async *createStream(messages) {
        active++;
        peak = Math.max(peak, active);
        if (active === 2) bothStarted.resolve();
        await bothStarted.promise;
        yield* text(String(messages.at(-1)?.content));
        active--;
      },
    };
    const worker = defineAgent({ ...base, id: "worker", provider });
    const { agent } = lead(worker, {
      agents: [
        { ...draft, name: "one", task: "First" },
        { ...draft, name: "two", task: "Second" },
      ],
    });
    const finished = await agent.run("Create");
    expect(finished.status).toBe("completed");
    expect(peak).toBe(2);
    const receipt = result(finished.snapshot);
    expect(receipt).toMatchObject({
      ok: true,
      output: [
        { name: "one", output: "First" },
        { name: "two", output: "Second" },
      ],
    });
    expect(finished.treeUsage.inputTokens).toBe(16);
  });

  it("resumes saved helpers without resolving prompts or admission policy again", async () => {
    const target = wire(text("Saved result"));
    const instructions = vi.fn(() => "Resolved host instructions");
    const prepare = vi.fn((spec) => ({
      ...spec,
      instructions: "Admitted instructions",
      limits: { turns: 2 },
    }));
    function build(source = wire(call("create_helpers", { agents: [draft] }), text("Combined"))) {
      const worker = defineAgent({
        ...base,
        instructions,
        id: "worker",
        provider: target.provider,
      });
      const agent = defineAgent({
        ...base,
        id: "lead",
        provider: source.provider,
        tools: [
          subagentTool({ name: "create_helpers", description: "Create.", agent: worker, prepare }),
        ],
      });
      return { agent, source };
    }
    const original = build();
    let checkpoint: RunSnapshot | undefined;
    await original.agent.run("Create", {
      host: {
        checkpoint(saved) {
          assertAgent(saved);
          if (
            firstOrUndefined(saved)?.state.status === "completed" &&
            saved.models[0]?.status === "completed" &&
            saved.models[0].tools[0]?.status === "delegating"
          )
            checkpoint = saved;
        },
      },
    });
    expect(checkpoint).toBeDefined();
    const rebuilt = build(wire(text("Resumed answer")));
    const restored = await rebuilt.agent.resume(JSON.parse(JSON.stringify(checkpoint)), {
      host: host(),
    });
    expect(restored).toMatchObject({ status: "completed", output: "Resumed answer" });
    expect(instructions).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(target.calls).toHaveLength(1);
    expect(first(restored.snapshot).limits.turns).toBe(2);
    expect(first(restored.snapshot).definition).toEqual(first(checkpoint!).definition);
  });

  it.each(["task", "instructions"] as const)(
    "resumes a helper whose %s contains double-escaped Unicode",
    async (field) => {
      const target = wire(text("Saved result"));
      const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
      const { agent, source } = lead(worker, {
        agents: [{ ...draft, [field]: "caf\\u00e9" }],
      });
      const finished = await agent.run("Create");
      expect(finished.status).toBe("completed");
      expect(first(finished.snapshot).subagent?.requested[field]).toBe("café");
      const restored = await agent.resume(JSON.parse(JSON.stringify(finished.snapshot)), {
        host: host(),
      });
      expect(restored).toMatchObject({ status: "completed", output: "Combined" });
      expect(first(restored.snapshot).definition).toEqual(first(finished.snapshot).definition);
      expect(target.calls).toHaveLength(1);
      expect(source.calls).toHaveLength(2);
    },
  );

  it.each(["tool", "model", "instructions", "provider", "creator-revoked"] as const)(
    "refuses a changed or revoked %s before host resume callbacks",
    async (change) => {
      const target = wire(text());
      const read = tool();
      function build(changed: boolean) {
        const shared =
          changed && change === "tool" ? tool("read", { description: "Changed definition" }) : read;
        const worker = defineAgent({
          ...base,
          instructions:
            changed && change === "instructions" ? "Changed instructions" : base.instructions,
          id: "worker",
          provider:
            changed && change === "provider"
              ? { ...target.provider, model: "different" }
              : target.provider,
          tools: [shared],
        });
        const source = wire(
          call("create_helpers", { agents: [{ ...draft, tools: ["read"], model: "small" }] }),
          text(),
        );
        return defineAgent({
          ...base,
          id: "lead",
          provider: source.provider,
          enabledTools: changed && change === "creator-revoked" ? ["create_helpers"] : undefined,
          tools: [
            shared,
            subagentTool({
              name: "create_helpers",
              description: "Create.",
              agent: worker,
              models: {
                small: {
                  description: "Small",
                  settings: { model: changed && change === "model" ? "changed" : "small" },
                },
              },
            }),
          ],
        });
      }
      const finished = await build(false).run("Create");
      expect(finished.status).toBe("completed");
      const policy = host();
      await expect(build(true).resume(finished.snapshot, { host: policy })).rejects.toThrow();
      expect(policy.authorizeResume).not.toHaveBeenCalled();
      expect(target.calls).toHaveLength(1);
    },
  );

  it.each(["grant", "definition", "task", "record", "limits"] as const)(
    "refuses a changed saved %s",
    async (change) => {
      const target = wire(text());
      const read = tool();
      const worker = defineAgent({
        ...base,
        id: "worker",
        provider: target.provider,
        tools: [read],
      });
      const { agent } = lead(worker, { agents: [draft] }, {}, [read]);
      const finished = await agent.run("Create");
      const saved = structuredClone(finished.snapshot);
      const child = first(saved);
      if (!child.subagent) throw new Error("Expected admission");
      if (change === "grant") child.subagent.spec.tools.push("read");
      if (change === "definition") child.definition.instructions = "Replaced prompt";
      if (change === "task") child.input = "New task";
      if (change === "record") delete child.subagent;
      if (change === "limits") child.limits.turns++;
      const policy = host();
      await expect(agent.resume(saved, { host: policy })).rejects.toThrow();
      expect(policy.authorizeResume).not.toHaveBeenCalled();
    },
  );

  it("keeps requests in each child's journal and rechecks host permission on resume", async () => {
    const read = tool("read", { approval: true });
    const target = wire(call("read"), text("Approved result"));
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider, tools: [read] });
    const { agent } = lead(worker, { agents: [{ ...draft, tools: ["read"] }] }, {}, [read]);
    const policy = host();
    const waiting = await agent.run("Create", { host: policy });
    if (waiting.status !== "suspended" || !waiting.requests[0])
      throw new Error("Expected approval");
    const request = waiting.requests[0];
    assertCall(request);
    expect(request.path[0]?.key).toBe("helper-1");
    expect(request.call.subagent).toBe(draft.name);
    expect(read.performed).not.toHaveBeenCalled();
    const done = await agent.resume(waiting.snapshot, {
      host: policy,
      answers: { [request.id]: "authenticated-evidence" },
    });
    expect(done.status).toBe("completed");
    expect(read.performed).toHaveBeenCalledTimes(1);
    expect(policy.beforeTool).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: draft.name }),
      expect.objectContaining({ request: expect.objectContaining({ id: request.id }) }),
    );
  });

  it.each([0, 1])("returns capacity feedback without partial admission (room %s)", async (room) => {
    const target = wire();
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
    const source = wire(
      call("create_helpers", {
        agents: [
          { ...draft, name: "one" },
          { ...draft, name: "two" },
        ],
      }),
      text(),
    );
    const agent = defineAgent({
      ...base,
      id: "lead",
      provider: source.provider,
      treeLimits: { maxChildren: room },
      tools: [subagentTool({ name: "create_helpers", description: "Create.", agent: worker })],
    });
    const finished = await agent.run("Create");
    expect(finished.status).toBe("completed");
    expect(result(finished.snapshot)).toMatchObject({ ok: false, kind: "invalid_input" });
    expect(children(finished.snapshot)).toEqual([]);
  });

  it("does not turn a tree model limit into a local helper failure", async () => {
    const target = wire();
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
    const source = wire(call("create_helpers", { agents: [draft] }));
    const agent = defineAgent({
      ...base,
      id: "lead",
      provider: source.provider,
      treeLimits: { modelCalls: 1 },
      tools: [subagentTool({ name: "create_helpers", description: "Create.", agent: worker })],
    });
    const finished = await agent.run("Create");
    expect(finished).toMatchObject({ status: "limited", limit: "modelCalls" });
    expect(target.calls).toHaveLength(0);
  });

  it("returns a local output limit as failed tool data", async () => {
    const target = wire([{ type: "finish", finishReason: "length" }]);
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
    const { agent } = lead(worker, { agents: [draft] });
    const finished = await agent.run("Create");
    expect(finished.status).toBe("completed");
    expect(result(finished.snapshot)).toMatchObject({ ok: false, kind: "failed" });
  });

  it.each([1, 2])("requires explicit recursive permission (levels %s)", async (maxLevels) => {
    const source = wire(
      call("create_helpers", {
        agents: [{ ...draft, tools: maxLevels > 1 ? ["create_helpers"] : [] }],
      }),
      call("create_helpers", { agents: [{ ...draft, name: "nested" }] }),
      text("Nested answer"),
      text("Helper answer"),
      text("Root answer"),
    );
    const agent = defineAgent({
      ...base,
      id: "lead",
      provider: source.provider,
      tools: [
        subagentTool({ name: "create_helpers", description: "Create.", agent: "self", maxLevels }),
      ],
    });
    const finished = await agent.run("Create");
    expect(finished.status).toBe("completed");
    expect(children(first(finished.snapshot))).toHaveLength(maxLevels === 1 ? 0 : 1);
    const again = await agent.resume(finished.snapshot, { host: host() });
    expect(again.treeUsage).toEqual(finished.treeUsage);
  });

  it("refuses handoff and fixed delegation capabilities", async () => {
    const target = defineAgent({ ...base, id: "target", provider: wire().provider });
    const handoff = defineHandoff({ name: "transfer", description: "Transfer.", to: target });
    const delegated = target.asTool({ name: "delegate", description: "Delegate." });
    const worker = defineAgent({
      ...base,
      id: "worker",
      provider: wire().provider,
      tools: [handoff, delegated],
    });
    const { agent } = lead(
      worker,
      { agents: [{ ...draft, tools: ["transfer", "delegate"] }] },
      {},
      [handoff, delegated],
    );
    expect(result((await agent.run("Create")).snapshot)).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });
  });

  it("cancels running and queued helpers without buying another model call", async () => {
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const provider: Provider = {
      id: "offline",
      model: "default",
      async *createStream(_messages, _tools, options) {
        calls++;
        started.resolve();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield* text();
      },
    };
    const worker = defineAgent({ ...base, id: "worker", provider });
    const source = wire(
      call("create_helpers", {
        agents: [
          { ...draft, name: "one" },
          { ...draft, name: "two" },
        ],
      }),
    );
    const agent = defineAgent({
      ...base,
      id: "lead",
      provider: source.provider,
      treeLimits: { maxParallel: 1 },
      tools: [subagentTool({ name: "create_helpers", description: "Create.", agent: worker })],
    });
    const controller = new AbortController();
    const running = agent.run("Create", { signal: controller.signal });
    await started.promise;
    controller.abort();
    expect(await running).toMatchObject({ status: "cancelled" });
    expect(calls).toBe(1);
    expect(source.calls).toHaveLength(1);
  });

  it("rejects host cache changes to an admitted helper", async () => {
    const target = wire(text());
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
    const { agent } = lead(worker, { agents: [draft] });
    const finished = await agent.run("Create", {
      host: {
        async child(_request, execute) {
          const envelope = await execute();
          assertAgent(envelope.snapshot);
          if (!envelope.snapshot.subagent) throw new Error("Missing admission");
          envelope.snapshot.subagent.spec.instructions = "Changed";
          return envelope;
        },
      },
    });
    expect(finished.status).toBe("failed");
    expect(target.calls).toHaveLength(1);
  });

  it("keeps the output contract and returns its serializable candidate", async () => {
    const target = wire(call("submit_result", { count: 3 }));
    const worker = defineAgent({
      ...base,
      id: "worker",
      provider: target.provider,
      output: {
        schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        validate(raw) {
          if (!isRecord(raw) || typeof raw.count !== "number") throw new Error("Return a count.");
          return new Set([raw.count]);
        },
      },
    });
    const { agent } = lead(worker, { agents: [draft] });
    const finished = await agent.run("Create");
    expect(finished.status).toBe("completed");
    expect(result(finished.snapshot)).toMatchObject({
      ok: true,
      output: [{ output: { count: 3 } }],
    });
    expect((await agent.resume(finished.snapshot, { host: host() })).status).toBe("completed");
  });

  it.each(["widen-tools", "raise-limits", "throw"] as const)(
    "fails closed on a bad admission policy: %s",
    async (mode) => {
      const read = tool();
      const worker = defineAgent({
        ...base,
        id: "worker",
        provider: wire().provider,
        tools: [read],
      });
      const { agent } = lead(
        worker,
        { agents: [draft] },
        {
          prepare(value) {
            if (mode === "throw") throw new Error("Secret from a host service");
            return mode === "widen-tools"
              ? { ...value, tools: ["read"] }
              : { ...value, limits: { turns: 99 } };
          },
        },
        [read],
      );
      const finished = await agent.run("Create");
      expect(finished).toMatchObject({
        status: "failed",
        error: { code: "subagent_policy_failed" },
      });
      expect(children(finished.snapshot)).toHaveLength(0);
      expect(JSON.stringify(finished)).not.toContain("Secret from a host service");
    },
  );

  it("keeps declaration positions after a refused helper, including resume", async () => {
    const worker = defineAgent({ ...base, id: "worker", provider: wire(text()).provider });
    const { agent } = lead(
      worker,
      {
        agents: [
          { ...draft, name: "refused" },
          { ...draft, name: "allowed" },
        ],
      },
      {
        prepare: (value) =>
          value.name === "refused" ? { refuse: "Use the other helper." } : value,
      },
    );
    let checkpoint: RunSnapshot | undefined;
    const finished = await agent.run("Create", {
      host: {
        checkpoint(saved) {
          assertAgent(saved);
          if (
            firstOrUndefined(saved)?.state.status === "completed" &&
            saved.models[0]?.status === "completed" &&
            saved.models[0].tools[0]?.status === "delegating"
          )
            checkpoint = saved;
        },
      },
    });
    expect(finished.status).toBe("completed");
    expect(finished.snapshot.delegations[0]?.children[0]?.key).toBe("helper-2");
    expect(result(finished.snapshot)).toMatchObject({
      ok: true,
      output: [
        { name: "refused", status: "refused" },
        { name: "allowed", status: "completed" },
      ],
    });
    // The same provider already supplied the final source turn, so use the saved completed run.
    expect(checkpoint).toBeDefined();
    expect((await agent.resume(finished.snapshot, { host: host() })).status).toBe("completed");
  });

  it.each(["count", "depth"] as const)("refuses host-disabled creation: %s", async (limit) => {
    const worker = defineAgent({ ...base, id: "worker", provider: wire().provider });
    const source = wire(call("create_helpers", { agents: [draft] }), text());
    const agent = defineAgent({
      ...base,
      id: "lead",
      provider: source.provider,
      treeLimits: limit === "depth" ? { maxDepth: 0 } : undefined,
      tools: [
        subagentTool({
          name: "create_helpers",
          description: "Create.",
          agent: worker,
          maxPerRun: limit === "count" ? 0 : 8,
        }),
      ],
    });
    const finished = await agent.run("Create");
    expect(finished.status).toBe("completed");
    expect(children(finished.snapshot)).toHaveLength(0);
    expect(result(finished.snapshot)).toMatchObject({ ok: false, kind: "invalid_input" });
  });

  it("keeps unsafe tools serialized across parallel created helpers", async () => {
    let active = 0;
    let peak = 0;
    const write = defineTool({
      name: "write",
      description: "Write.",
      inputSchema: { type: "object" },
      async run() {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return "Saved";
      },
    });
    const provider: Provider = {
      id: "offline",
      model: "default",
      async *createStream(messages) {
        yield* messages.some((message) => message.role === "tool") ? text() : call("write");
      },
    };
    const worker = defineAgent({ ...base, id: "worker", provider, tools: [write] });
    const { agent } = lead(
      worker,
      {
        agents: [
          { ...draft, name: "one", tools: ["write"] },
          { ...draft, name: "two", tools: ["write"] },
        ],
      },
      {},
      [write],
    );
    expect((await agent.run("Create")).status).toBe("completed");
    expect(peak).toBe(1);
  });

  it("honors lowered child time limits without stopping the parent", async () => {
    vi.useFakeTimers();
    try {
      const entered = Promise.withResolvers<void>();
      const provider: Provider = {
        id: "offline",
        model: "default",
        async *createStream(_messages, _tools, options) {
          entered.resolve();
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield* text();
        },
      };
      const worker = defineAgent({ ...base, id: "worker", provider });
      const { agent } = lead(
        worker,
        { agents: [draft] },
        { prepare: (value) => ({ ...value, limits: { elapsedMs: 100 } }) },
      );
      const pending = agent.run("Create");
      await entered.promise;
      await vi.advanceTimersByTimeAsync(101);
      const finished = await pending;
      expect(finished.status).toBe("completed");
      expect(first(finished.snapshot).state).toEqual({ status: "limited", limit: "elapsedMs" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot replay a created helper's interrupted hosted effects", async () => {
    const target = wire(text());
    const worker = defineAgent({
      ...base,
      id: "worker",
      provider: target.provider,
      modelSettings: { hostedTools: [{ type: "web_search" }] },
      recovery: { identity: "hosted", maxAttempts: 2, inferenceOnly: true },
    });
    const { agent } = lead(worker, { agents: [draft] });
    let checkpoint: RunSnapshot | undefined;
    await agent.run("Create", {
      host: {
        checkpoint(saved) {
          assertAgent(saved);
          if (firstOrUndefined(saved)?.models[0]?.status === "running") checkpoint = saved;
        },
      },
    });
    expect(checkpoint).toBeDefined();
    const resumed = await agent.resume(checkpoint, { host: host() });
    expect(resumed).toMatchObject({ status: "failed", error: { code: "interrupted_operation" } });
    expect(target.calls).toHaveLength(1);
  });

  it("does not resume an admitted child after a reviewer changes its definition", async () => {
    const read = tool("read", { approval: true });
    const target = wire(call("read"));
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider, tools: [read] });
    const { agent } = lead(
      worker,
      { agents: [{ ...draft, tools: ["read"] }] },
      { needsApproval: true },
      [read],
    );
    const policy = host();
    policy.prepareRequest = () => ({
      scope: {
        actorId: "owner",
        resource: { id: "record", version: "1" },
        expiresAt: Date.now() + 60_000,
      },
      ask: { type: "approval", editable: true },
    });
    const initial = await agent.run("Create", { host: policy });
    if (initial.status !== "suspended" || !initial.requests[0])
      throw new Error(`Expected create approval: ${JSON.stringify(initial.snapshot.state)}`);
    const waiting = await agent.resume(initial.snapshot, {
      host: policy,
      answers: { [initial.requests[0].id]: "approval" },
    });
    if (waiting.status !== "suspended") throw new Error("Expected child approval");
    const saved = structuredClone(waiting.snapshot);
    const model = saved.models[0];
    if (model?.status !== "completed") throw new Error("Missing creation call");
    const approval = model.tools[0]?.asks?.[0];
    if (!approval) throw new Error("Missing creation approval");
    approval.request.scope.expiresAt = Date.now() - 1;
    const renewed = await agent.resume(saved, { host: policy });
    if (renewed.status !== "suspended") throw new Error("Expected renewed approval");
    const request = renewed.requests.find((request) => {
      assertCall(request);
      return request.call.agentId === "lead";
    });
    if (!request) throw new Error("Missing renewed creation approval");
    policy.resolveRequest = () => ({
      type: "approve",
      arguments: { agents: [{ ...draft, task: "Changed task", tools: ["read"] }] },
    });
    const finished = await agent.resume(renewed.snapshot, {
      host: policy,
      answers: { [request.id]: "edited approval" },
    });
    expect(finished).toMatchObject({ status: "failed", error: { code: "subagent_input_changed" } });
    expect(read.performed).not.toHaveBeenCalled();
    expect(target.calls).toHaveLength(1);
  });

  it("does not execute a helper when its admission checkpoint fails", async () => {
    const target = wire(text());
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
    const { agent } = lead(worker, { agents: [draft] });
    const finished = await agent.run("Create", {
      host: {
        checkpoint(snapshot) {
          assertAgent(snapshot);
          if (children(snapshot).length) throw new Error("Checkpoint unavailable");
        },
      },
    });
    expect(finished).toMatchObject({ status: "failed", error: { code: "checkpoint_failed" } });
    expect(target.calls).toHaveLength(0);
  });

  it("refuses direct helper restore outside its parent", async () => {
    const worker = defineAgent({ ...base, id: "worker", provider: wire(text()).provider });
    const { agent } = lead(worker, { agents: [draft] });
    const finished = await agent.run("Create");
    expect(() => worker[AGENT_RUNTIME].restore(first(finished.snapshot))).toThrow(
      "owning creation tool",
    );
  });
});

function firstOrUndefined(snapshot: RunSnapshot) {
  return children(snapshot)[0];
}

function followup(messages: ChatMessage[]) {
  const last = [...messages].reverse().find((message) => message.role === "tool");
  const output: unknown = last && JSON.parse(last.content);
  const helper: unknown = Array.isArray(output) ? output[0] : undefined;
  if (!isRecord(helper) || typeof helper.helperId !== "string" || typeof helper.name !== "string")
    throw new Error("Expected a saved helper identity");
  return { name: helper.name, continues: helper.helperId, task: "Explain that in more detail" };
}

const forkPolicy = {
  identity: "approved-history-1",
  maxMessages: 4,
  maxBytes: 4_000,
  select: () => [0, 1],
};

describe("helper forks and follow-ups", () => {
  it("forks only host-selected plain conversation and records it before dispatch", async () => {
    const target = wire(text("Fork answer"));
    const worker = defineAgent({
      ...base,
      instructions: "Worker instructions.",
      id: "worker",
      provider: target.provider,
    });
    const select = vi.fn(() => [0, 1]);
    const { agent } = lead(
      worker,
      { agents: [{ ...draft, fork: true }] },
      { fork: { ...forkPolicy, select } },
    );
    const session = createMemorySession({
      messages: [
        { role: "user", content: "Approved question" },
        {
          role: "assistant",
          content: "Approved answer",
          reasoning: "Private reasoning",
          toolCalls: [{ id: "old", name: "write", arguments: '{"private":"arguments"}' }],
        },
        { role: "tool", toolCallId: "old", name: "write", content: "Private tool result" },
        { role: "user", content: "Unapproved data" },
      ],
    });
    let admitted: RunSnapshot | undefined;
    const outcome = await agent.run("Fork", {
      session,
      host: {
        ...host(),
        checkpoint(saved) {
          assertAgent(saved);
          if (firstOrUndefined(saved)?.models.length === 0) admitted = saved;
        },
      },
    });
    expect(outcome.status).toBe("completed");
    const node = first(outcome.snapshot);
    expect(node.history).toEqual([
      { role: "user", content: "Approved question" },
      { role: "assistant", content: "Approved answer" },
    ]);
    expect(first(admitted!).history).toEqual(node.history);
    expect(node.session).toBeUndefined();
    const sent = JSON.stringify(target.calls[0]);
    for (const secret of [
      base.instructions,
      "Private reasoning",
      "Private tool result",
      "Unapproved data",
      'private":"arguments',
    ])
      expect(sent).not.toContain(secret);
    expect(select).toHaveBeenCalledTimes(1);
    await agent.resume(outcome.snapshot, { host: host(), session });
    expect(select).toHaveBeenCalledTimes(1);
    expect(target.calls).toHaveLength(1);
    const changed = structuredClone(outcome.snapshot);
    first(changed).history[0] = { role: "user", content: "Changed fork" };
    await expect(agent.resume(changed, { host: host() })).rejects.toThrow();
  });

  it.each(["disabled", "bytes", "count", "reordered", "authority"] as const)(
    "refuses an unsafe fork: %s",
    async (mode) => {
      const target = wire();
      const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
      const { agent } = lead(
        worker,
        { agents: [{ ...draft, fork: true }] },
        {
          fork:
            mode === "disabled"
              ? undefined
              : {
                  ...forkPolicy,
                  maxBytes: mode === "bytes" ? 1 : 4_000,
                  maxMessages: mode === "count" ? 1 : 4,
                  select: () => (mode === "reordered" ? [1, 0] : [0, 1]),
                },
        },
      );
      const outcome = await agent.run(
        {
          messages: [
            { role: "user", content: "Earlier" },
            { role: "user", content: "Fork" },
          ],
        },
        { host: mode === "authority" ? {} : host() },
      );
      expect(target.calls).toHaveLength(0);
      expect(children(outcome.snapshot)).toHaveLength(0);
      if (mode === "disabled") expect(result(outcome.snapshot).ok).toBe(false);
      else expect(outcome.status).toBe("failed");
    },
  );

  it("continues the latest helper by opaque id, keeps exact prefixes and never repeats effects", async () => {
    const read = tool();
    const target = wire(
      call("read"),
      text("Original answer"),
      text("Follow-up answer"),
      text("Third answer"),
    );
    const instructions = vi.fn(() => "Frozen template instructions");
    const worker = defineAgent({
      ...base,
      id: "worker",
      instructions,
      provider: target.provider,
      tools: [read],
    });
    const source = wire(
      call("create_helpers", { agents: [{ ...draft, tools: ["read"] }] }),
      (messages) => call("create_helpers", { agents: [followup(messages)] }),
      (messages) => call("create_helpers", { agents: [followup(messages)] }),
      text(),
    );
    const { agent } = lead(worker, {}, { followUp: true }, [read], source);
    const events: AgentEvent[] = [];
    const session = createMemorySession();
    let checkpoint: RunSnapshot | undefined;
    const done = await agent.run("Create", {
      session,
      host: {
        ...host(),
        checkpoint(saved) {
          assertAgent(saved);
          if (
            children(saved).length === 3 &&
            children(saved)[2]?.state.status === "completed" &&
            saved.models[2]?.status === "completed" &&
            saved.models[2].tools[0]?.status === "delegating"
          )
            checkpoint = saved;
        },
      },
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(done.status).toBe("completed");
    const [original, next, third] = children(done.snapshot);
    expect(next?.subagent?.identity).toEqual(original?.subagent?.identity);
    expect(next?.subagent?.previousRunId).toBe(original?.runId);
    expect(third?.subagent?.previousRunId).toBe(next?.runId);
    expect(next?.definition).toEqual(original?.definition);
    expect(third?.history.slice(0, next?.history.length)).toEqual(next?.history);
    expect(
      JSON.stringify(target.calls[2]?.messages.slice(0, target.calls[1]?.messages.length)),
    ).toBe(JSON.stringify(target.calls[1]?.messages));
    expect(target.calls.every((call) => call.options?.sessionId === original?.runId)).toBe(true);
    expect(children(done.snapshot).every((node) => node.session === undefined)).toBe(true);
    expect(read.performed).toHaveBeenCalledTimes(1);
    expect(instructions).toHaveBeenCalledTimes(1);
    expect(done.treeUsage.inputTokens).toBe(32);
    expect(JSON.stringify(events.filter((event) => event.type === "child"))).not.toContain(
      draft.name,
    );
    expect(JSON.stringify(events.filter((event) => event.type === "child"))).not.toContain(
      original?.subagent?.identity.id,
    );
    expect(checkpoint).toBeDefined();
    const resumedSource = wire(text("Recovered"));
    const rebuilt = lead(worker, {}, { followUp: true }, [read], resumedSource).agent;
    const restored = await rebuilt.resume(JSON.parse(JSON.stringify(checkpoint)), {
      host: host(),
      session,
    });
    expect(restored.status).toBe("completed");
    expect(target.calls).toHaveLength(4);
    expect(read.performed).toHaveBeenCalledTimes(1);
    expect(instructions).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "delegating"] as const)(
    "resumes a %s follow-up checkpoint with repeated tool-call ids without replaying work",
    async (status) => {
      const read = tool();
      const target = wire(
        call("read"),
        call("read"),
        text("Original answer"),
        text("Follow-up answer"),
      );
      const worker = defineAgent({
        ...base,
        id: "worker",
        provider: target.provider,
        tools: [read],
      });
      const source = wire(
        call("create_helpers", { agents: [{ ...draft, tools: ["read"] }] }),
        (messages) => call("create_helpers", { agents: [followup(messages)] }),
        text("Combined"),
      );
      const { agent } = lead(worker, {}, { followUp: true }, [read], source);
      let checkpoint: RunSnapshot | undefined;
      const done = await agent.run("Create", {
        host: {
          ...host(),
          checkpoint(saved) {
            assertAgent(saved);
            if (
              children(saved)[1]?.state.status === "completed" &&
              saved.models[1]?.status === "completed" &&
              saved.models[1].tools[0]?.status === "delegating"
            )
              checkpoint = saved;
          },
        },
      });
      expect(done.status).toBe("completed");
      const [original, next] = children(done.snapshot);
      if (!original || !next) throw new Error("Expected the original helper and its follow-up");
      expect(
        original.models.flatMap((model) =>
          model.status === "completed"
            ? (model.turn.message.toolCalls ?? []).map((call) => call.id)
            : [],
        ),
      ).toEqual(["read", "read"]);
      expect(
        next.history.flatMap((message) =>
          message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : [],
        ),
      ).toEqual(["read", "read_2"]);
      expect(
        next.history.flatMap((message) => (message.role === "tool" ? [message.toolCallId] : [])),
      ).toEqual(["read", "read_2"]);
      expect(read.performed).toHaveBeenCalledTimes(2);
      expect(checkpoint).toBeDefined();
      const resumedSource = wire(text("Combined"));
      const rebuilt = lead(worker, {}, { followUp: true }, [read], resumedSource).agent;
      const restored = await rebuilt.resume(
        JSON.parse(JSON.stringify(status === "completed" ? done.snapshot : checkpoint)),
        { host: host() },
      );
      expect(restored).toMatchObject({ status: "completed", output: "Combined" });
      expect(children(restored.snapshot)).toEqual(children(done.snapshot));
      expect(restored.treeUsage).toEqual(done.treeUsage);
      expect(target.calls).toHaveLength(4);
      expect(read.performed).toHaveBeenCalledTimes(2);
      expect(resumedSource.calls).toHaveLength(status === "completed" ? 0 : 1);
    },
  );

  it.each(["name", "run-id", "other-root", "tools", "duplicate", "limit", "disabled"] as const)(
    "refuses invalid follow-up ownership or admission: %s",
    async (mode) => {
      const target = wire(text());
      const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
      const source = wire(
        call("create_helpers", { agents: [draft] }),
        (messages) => {
          const next: Record<string, unknown> = followup(messages);
          if (mode === "name") next.name = "guessed_name";
          if (mode === "run-id") next.continues = "root/model/1/tool/1/child/helper-1";
          if (mode === "other-root") next.continues = crypto.randomUUID();
          if (mode === "tools") next.tools = [];
          return call("create_helpers", { agents: mode === "duplicate" ? [next, next] : [next] });
        },
        text(),
      );
      const { agent } = lead(
        worker,
        {},
        { followUp: mode !== "disabled", maxPerRun: mode === "limit" ? 1 : 8 },
        [],
        source,
      );
      const done = await agent.run("Create", { host: host() });
      expect(done.status).toBe("completed");
      expect(children(done.snapshot)).toHaveLength(1);
      expect(target.calls).toHaveLength(1);
      const model = done.snapshot.models[1];
      expect(
        model?.status === "completed" &&
          model.tools[0]?.status === "completed" &&
          model.tools[0].result.ok,
      ).toBe(false);
    },
  );

  it.each(["creator", "template", "host", "memory"] as const)(
    "rechecks live grants before a new follow-up: %s",
    async (mode) => {
      let revoked = false;
      const read = tool();
      const store = createMemoryStore();
      const scope = await store.access(
        { tenantId: "tenant", userId: "person" },
        { signal: new AbortController().signal },
      );
      const target = wire(text());
      const worker = defineAgent({
        ...base,
        id: "worker",
        provider: target.provider,
        tools: [read],
        enabledTools: () => (mode === "template" && revoked ? [] : ["read"]),
      });
      const source = wire(
        call("create_helpers", { agents: [{ ...draft, tools: ["read"] }] }),
        (messages) => {
          revoked = true;
          return call("create_helpers", { agents: [followup(messages)] });
        },
      );
      const agent = defineAgent({
        ...base,
        id: "lead",
        provider: source.provider,
        enabledTools: () =>
          mode === "creator" && revoked ? ["create_helpers"] : ["read", "create_helpers"],
        tools: [
          read,
          subagentTool({
            name: "create_helpers",
            description: "Create.",
            agent: worker,
            followUp: true,
          }),
        ],
      });
      const policy = host();
      policy.beforeTool = async () => {
        if (revoked && mode === "host") throw new Error("Host access revoked");
        if (revoked && mode === "memory")
          await store.erase(
            { tenantId: "tenant", userId: "person" },
            { signal: new AbortController().signal },
          );
      };
      const done = await agent.run("Create", { host: policy, memory: { store, scope } });
      expect(done.status).toBe("failed");
      expect(target.calls).toHaveLength(1);
      expect(children(done.snapshot)).toHaveLength(1);
    },
  );

  it("keeps a follow-up's approvals separate and refuses changed replay inputs", async () => {
    const read = tool("read", { approval: true });
    const target = wire(text(), call("read"), text("Approved follow-up"));
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider, tools: [read] });
    const source = wire(
      call("create_helpers", { agents: [{ ...draft, tools: ["read"] }] }),
      (messages) => call("create_helpers", { agents: [followup(messages)] }),
      text(),
    );
    const { agent } = lead(worker, {}, { followUp: true }, [read], source);
    const policy = host();
    const waiting = await agent.run("Create", { host: policy });
    if (waiting.status !== "suspended" || !waiting.requests[0])
      throw new Error("Expected follow-up approval");
    expect(read.performed).not.toHaveBeenCalled();
    assertCall(waiting.requests[0]);
    expect(waiting.requests[0].call.runId).toBe(children(waiting.snapshot)[1]?.runId);
    const altered = structuredClone(waiting.snapshot);
    const next = children(altered)[1];
    if (!next) throw new Error("Missing follow-up");
    next.history[0] = { role: "user", content: "Replaced prior conversation" };
    await expect(agent.resume(altered, { host: policy })).rejects.toThrow();
    const completed = await agent.resume(waiting.snapshot, {
      host: policy,
      answers: { [waiting.requests[0].id]: "approved" },
    });
    expect(completed.status).toBe("completed");
    expect(read.performed).toHaveBeenCalledTimes(1);
    expect(target.calls).toHaveLength(3);
  });

  it("cancels an executing follow-up without restarting its earlier conversation", async () => {
    const entered = Promise.withResolvers<void>();
    let calls = 0;
    const worker = defineAgent({
      ...base,
      id: "worker",
      provider: {
        id: "offline",
        model: "default",
        async *createStream(_messages, _tools, options) {
          if (++calls === 2) {
            entered.resolve();
            await new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
          }
          yield* text();
        },
      },
    });
    const source = wire(call("create_helpers", { agents: [draft] }), (messages) =>
      call("create_helpers", { agents: [followup(messages)] }),
    );
    const { agent } = lead(worker, {}, { followUp: true }, [], source);
    const controller = new AbortController();
    const pending = agent.run("Create", { host: host(), signal: controller.signal });
    await entered.promise;
    controller.abort();
    const done = await pending;
    expect(done.status).toBe("cancelled");
    expect(children(done.snapshot)[0]?.state.status).toBe("completed");
    expect(calls).toBe(2);
  });

  it("refuses a real identity from another root and from a sibling creator", async () => {
    const worker = defineAgent({ ...base, id: "worker", provider: wire(text()).provider });
    const original = await lead(worker, { agents: [draft] }, { followUp: true }).agent.run(
      "Original",
    );
    const foreignId = first(original.snapshot).subagent?.identity.id;
    expect(foreignId).toBeDefined();
    const other = lead(
      worker,
      { agents: [{ name: draft.name, continues: foreignId, task: "Stolen" }] },
      { followUp: true },
    );
    const refused = await other.agent.run("Other root", { host: host() });
    expect(children(refused.snapshot)).toHaveLength(0);
    expect(result(refused.snapshot).ok).toBe(false);

    let siblingId: string | undefined;
    const provider: Provider = {
      id: "offline",
      model: "default",
      async *createStream(messages) {
        const task = messages.find((message) => message.role === "user")?.content;
        if (messages.some((message) => message.role === "tool")) {
          yield* text();
          return;
        }
        if (task === "Root")
          yield* call("create_helpers", {
            agents: [
              { name: "first", task: "First" },
              { name: "second", task: "Second", tools: ["create_helpers"] },
            ],
          });
        else if (task === "Second") {
          expect(siblingId).toBeDefined();
          yield* call("create_helpers", {
            agents: [{ name: "first", continues: siblingId, task: "Stolen sibling" }],
          });
        } else yield* text();
      },
    };
    const creator = defineAgent({
      ...base,
      id: "creator",
      provider,
      tools: [
        subagentTool({
          name: "create_helpers",
          description: "Create.",
          agent: "self",
          maxLevels: 2,
          followUp: true,
        }),
      ],
    });
    const done = await creator.run("Root", {
      host: {
        ...host(),
        checkpoint(snapshot) {
          assertAgent(snapshot);
          siblingId ??= firstOrUndefined(snapshot)?.subagent?.identity.id;
        },
      },
    });
    expect(done.status).toBe("completed");
    const second = children(done.snapshot)[1];
    if (!second) throw new Error("Missing sibling");
    expect(result(second).ok).toBe(false);
    expect(children(second)).toHaveLength(0);
  });

  it("refuses a changed provider before starting a new follow-up", async () => {
    let changed = false;
    const target = wire(text());
    const worker = defineAgent({
      ...base,
      id: "worker",
      provider: {
        ...target.provider,
        get model() {
          return changed ? "changed" : "default";
        },
      },
    });
    const source = wire(
      call("create_helpers", { agents: [draft] }),
      (messages) => {
        changed = true;
        return call("create_helpers", { agents: [followup(messages)] });
      },
      text(),
    );
    const done = await lead(worker, {}, { followUp: true }, [], source).agent.run("Create", {
      host: host(),
    });
    expect(done.status).toBe("completed");
    expect(children(done.snapshot)).toHaveLength(1);
    expect(target.calls).toHaveLength(1);
  });

  it.each(["model", "children", "tool", "time"] as const)(
    "charges a follow-up against the existing %s budget",
    async (limit) => {
      const target = wire(text());
      const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
      const source = wire(
        call("create_helpers", { agents: [draft] }),
        (messages) => call("create_helpers", { agents: [followup(messages)] }),
        text(),
      );
      const agent = defineAgent({
        ...base,
        id: "lead",
        provider: source.provider,
        treeLimits:
          limit === "model"
            ? { modelCalls: 3 }
            : limit === "children"
              ? { maxChildren: 1 }
              : limit === "time"
                ? { elapsedMs: 1_000 }
                : undefined,
        limits: limit === "tool" ? { toolCalls: 1 } : undefined,
        tools: [
          subagentTool({
            name: "create_helpers",
            description: "Create.",
            agent: worker,
            followUp: true,
          }),
        ],
      });
      const policy = host();
      let requests = 0;
      if (limit === "time") vi.useFakeTimers();
      try {
        policy.beforeTool = async () => {
          if (++requests === 2 && limit === "time") await vi.advanceTimersByTimeAsync(1_001);
        };
        const done = await agent.run("Create", { host: policy });
        expect(target.calls).toHaveLength(1);
        if (limit === "children") expect(done.status).toBe("completed");
        else expect(done.status).toBe("limited");
        expect(first(done.snapshot).state.status).toBe("completed");
      } finally {
        if (limit === "time") vi.useRealTimers();
      }
    },
  );

  it("bounds the complete inherited definition before a follow-up starts", async () => {
    const target = wire(text());
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
    const source = wire(
      call("create_helpers", { agents: [{ ...draft, instructions: "i".repeat(40_000) }] }),
      (messages) =>
        call("create_helpers", { agents: [{ ...followup(messages), task: "t".repeat(40_000) }] }),
    );
    const done = await lead(worker, {}, { followUp: true }, [], source).agent.run("Create", {
      host: host(),
    });
    expect(done).toMatchObject({ status: "failed", error: { code: "subagent_spec_limit" } });
    expect(children(done.snapshot)).toHaveLength(1);
    expect(target.calls).toHaveLength(1);
  });

  it("does not let follow-up admission replace its earlier definition", async () => {
    const target = wire(text());
    const worker = defineAgent({ ...base, id: "worker", provider: target.provider });
    const source = wire(call("create_helpers", { agents: [draft] }), (messages) =>
      call("create_helpers", { agents: [followup(messages)] }),
    );
    const { agent } = lead(
      worker,
      {},
      {
        followUp: true,
        prepare: (value) =>
          value.continues ? { ...value, instructions: "New instructions" } : value,
      },
      [],
      source,
    );
    const done = await agent.run("Create", { host: host() });
    expect(done).toMatchObject({ status: "failed", error: { code: "subagent_policy_failed" } });
    expect(children(done.snapshot)).toHaveLength(1);
    expect(target.calls).toHaveLength(1);
  });

  it("refuses unsafe replay of an interrupted follow-up with hosted tools", async () => {
    const target = wire(text(), text());
    const worker = defineAgent({
      ...base,
      id: "worker",
      provider: target.provider,
      modelSettings: { hostedTools: [{ type: "web_search" }] },
      recovery: { identity: "hosted", maxAttempts: 2, inferenceOnly: true },
    });
    const source = wire(
      call("create_helpers", { agents: [draft] }),
      (messages) => call("create_helpers", { agents: [followup(messages)] }),
      text(),
    );
    const { agent } = lead(worker, {}, { followUp: true }, [], source);
    let checkpoint: RunSnapshot | undefined;
    await agent.run("Create", {
      host: {
        ...host(),
        checkpoint(saved) {
          assertAgent(saved);
          if (children(saved)[1]?.models[0]?.status === "running") checkpoint = saved;
        },
      },
    });
    expect(checkpoint).toBeDefined();
    const resumed = await agent.resume(checkpoint, { host: host() });
    expect(resumed).toMatchObject({ status: "failed", error: { code: "interrupted_operation" } });
    expect(target.calls).toHaveLength(2);
  });
});
