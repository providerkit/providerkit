// Validation/replay cases adapted from PydanticAI Harness / Vstorm (MIT),
// test_task_control.py and test_dbos.py; attenuation from TanStack AI (MIT), agents.test.ts.
import { describe, expect, it, vi } from "vitest";
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
function wire(...turns: ProviderChunk[][]) {
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
      yield* turn;
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
) {
  const source = wire(call("create_helpers", args), text("Combined"));
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
  return snapshot.delegations.flatMap((entry) => entry.children.map((child) => child.snapshot));
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
      throw new Error("Expected create approval");
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
    const request = renewed.requests.find((request) => request.call.agentId === "lead");
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
