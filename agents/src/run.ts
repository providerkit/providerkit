import {
  EMPTY_USAGE,
  ToolRegistry,
  addUsage,
  collectTurn,
  defineTool,
  messageOf,
  parseToolArgs,
  type ChatMessage,
  type ProviderChunk,
  type Tool,
} from "@providerkit/core";
import {
  AGENT_RUNTIME,
  executeDelegation,
  isDelegation,
  specialistTool,
  type AgentRuntime,
  type ApprovalEvidence,
  type Delegation,
} from "./delegation.ts";
import {
  ExecutionTree,
  Halt,
  authorizeTree,
  fail,
  treeUsage,
  untilAbort,
  type ExecutionScope,
} from "./tree.ts";
import {
  checkOptions,
  completeArguments,
  copyData,
  equalData,
  immutableCopy,
  isId,
  isRecord,
  isScope,
  isUsage,
  modelId,
  readLimits,
  readTreeLimits,
  readSnapshot,
  readTurn,
  toolId,
} from "./snapshot.ts";
import type {
  Agent,
  AgentConfig,
  AgentDefinition,
  AgentEvent,
  ModelExecution,
  OperationReceipt,
  PendingApproval,
  ResultSchema,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  ToolRequest,
  ToolResult,
} from "./types.ts";

/** Reserved for the output contract supplied to defineAgent. */
export const RESULT_TOOL_NAME = "submit_result";

type CompletedModel = Extract<ModelExecution, { status: "completed" }>;

function historyOf(snapshot: RunSnapshot, instructions: string): ChatMessage[] {
  const history: ChatMessage[] = [
    { role: "system", content: instructions },
    { role: "user", content: snapshot.input },
  ];
  for (const model of snapshot.models) {
    // Never give a provider half a tool round. The journal retains unfinished work.
    if (model.status !== "completed" || model.tools.some((tool) => tool.status !== "completed"))
      break;
    history.push(model.turn.message);
    for (const [index, tool] of model.tools.entries()) {
      const call = model.turn.message.toolCalls?.[index];
      if (call && tool.status === "completed") {
        history.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: tool.result.content,
        });
      }
    }
  }
  return copyData(history);
}

function recordOf(snapshot: RunSnapshot, instructions: string) {
  const saved = copyData(snapshot);
  const receipts: OperationReceipt[] = [];
  let usage = { ...EMPTY_USAGE };
  for (const model of saved.models) {
    usage = addUsage(usage, model.usage);
    receipts.push({
      kind: "model",
      id: model.id,
      attemptId: model.attemptId,
      status: model.status,
      usage: model.usage,
      ...(model.status === "completed" && model.turn.source ? { source: model.turn.source } : {}),
    });
    if (model.status !== "completed") continue;
    for (const [index, tool] of model.tools.entries()) {
      const call = model.turn.message.toolCalls?.[index];
      if (!call || tool.status === "pending") continue;
      receipts.push({
        kind: saved.delegations.some((journal) => journal.operationId === tool.id)
          ? "delegation"
          : "tool",
        id: tool.id,
        callId: call.id,
        attemptId: tool.attemptId,
        status: tool.status === "delegating" ? "running" : tool.status,
        ...(tool.status === "completed" ? { result: tool.result } : {}),
      });
    }
  }
  return {
    runId: saved.runId,
    attemptId: saved.attemptId,
    usage,
    treeUsage: treeUsage(saved),
    receipts,
    history: historyOf(saved, instructions),
    snapshot: saved,
  };
}

export function defineAgent<T>(definition: AgentConfig & { output: ResultSchema<T> }): Agent<T>;
export function defineAgent(definition: AgentDefinition): Agent<string>;
export function defineAgent<T>(definition: AgentDefinition<T>): Agent<T | string> {
  const { id, version, instructions, provider } = definition;
  if (
    !isId(id) ||
    !isId(version) ||
    typeof instructions !== "string" ||
    !provider ||
    typeof provider.createStream !== "function"
  ) {
    throw new TypeError("An agent needs an id, version, instructions and provider.");
  }
  const limits = readLimits(definition.limits);
  const treeLimits = readTreeLimits(definition.treeLimits);
  const output = definition.output && {
    schema: copyData(definition.output.schema),
    validate: definition.output.validate,
  };
  if (
    output &&
    (!isRecord(output.schema) ||
      output.schema.type !== "object" ||
      typeof output.validate !== "function")
  ) {
    throw new TypeError("An output contract needs an object schema and a runtime validator.");
  }
  const tools = [...(definition.tools ?? [])];
  if (
    new Set(tools.map((tool) => tool.name)).size !== tools.length ||
    tools.some(
      (tool) =>
        !isId(tool.name) ||
        tool.name === RESULT_TOOL_NAME ||
        (!isDelegation(tool) && tool.isTerminal),
    )
  ) {
    throw new TypeError(
      `Use unique tool names and the output contract for terminal results. ${RESULT_TOOL_NAME} is reserved.`,
    );
  }
  if (output) {
    tools.push(
      defineTool({
        name: RESULT_TOOL_NAME,
        description:
          "Submit the final result. Call this tool alone, after all other work is finished.",
        inputSchema: output.schema,
        validate: output.validate,
        run: async (value) => value,
        summarize: () => "Result accepted.",
        isTerminal: true,
        isReadOnly: true,
      }),
    );
  }
  const registry = new ToolRegistry(tools.filter((tool): tool is Tool => !isDelegation(tool)));
  const delegations = new Map(tools.filter(isDelegation).map((tool) => [tool.name, tool]));

  function validateResult(candidate: unknown): T | string {
    if (output) return output.validate(copyData(candidate));
    if (typeof candidate !== "string" || !candidate.trim())
      throw new TypeError("The model returned no answer.");
    return candidate;
  }

  async function execute(
    snapshot: RunSnapshot,
    options: RunOptions,
    scope: ExecutionScope,
    evidence?: ApprovalEvidence,
  ): Promise<RunOutcome<T | string>> {
    const host = options.host;
    const deadline = snapshot.startedAt + limits.elapsedMs;
    const timeout = new AbortController();
    const signal = AbortSignal.any([
      scope.tree.signal,
      timeout.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const timer = setTimeout(
      () => timeout.abort(new Error("The run reached its time limit.")),
      Math.max(0, deadline - Date.now()),
    );
    let release = () => {};
    let approved: PendingApproval | undefined;
    let completed: { output: T | string } | undefined;

    function active(): void {
      scope.tree.active();
      if (options.signal?.aborted) throw new Halt({ status: "cancelled" });
      if (timeout.signal.aborted || Date.now() >= deadline)
        throw new Halt({ status: "limited", limit: "elapsedMs" });
    }

    function emit(event: AgentEvent): void {
      try {
        void Promise.resolve(options.onEvent?.(immutableCopy(event))).catch(() => {});
      } catch {
        // Progress is not the durable journal, and an observer cannot stop execution.
      }
    }

    const save = () => scope.tree.save();

    function usedTools(): number {
      return snapshot.models.reduce(
        (count, model) =>
          count +
          (model.status === "completed"
            ? model.tools.filter((tool) => tool.status !== "pending").length
            : 0),
        0,
      );
    }

    function requestFor(model: CompletedModel, index: number): ToolRequest {
      const call = model.turn.message.toolCalls?.[index];
      const tool = model.tools[index];
      if (!call || !tool) fail("invalid_journal", "The tool call is missing from its journal.");
      return {
        agentId: id,
        version,
        runId: snapshot.runId,
        attemptId: snapshot.attemptId,
        operationId: tool.id,
        call,
        arguments: parseToolArgs(call.arguments),
      };
    }

    async function finishTool(
      model: CompletedModel,
      index: number,
      request: ToolRequest,
      result: ToolResult,
    ): Promise<void> {
      model.tools[index] = {
        id: request.operationId,
        attemptId: snapshot.attemptId,
        status: "completed",
        result,
      };
      await save();
      emit({ type: "tool_result", request, result });
    }

    async function runTool(
      model: CompletedModel,
      index: number,
      request: ToolRequest,
      tool: Tool | undefined,
      parallel: boolean,
    ): Promise<void> {
      active();
      let result: ToolResult;
      if (!tool) {
        result = {
          ok: false,
          kind: "unknown_tool",
          content: `Unknown tool "${request.call.name}". Choose one of the provided tools.`,
        };
      } else if (!completeArguments(request.call.arguments)) {
        result = {
          ok: false,
          kind: "invalid_input",
          content: "Tool arguments must be one complete JSON object. Send the full object again.",
        };
      } else if (tool.isTerminal && model.tools.length !== 1) {
        result = {
          ok: false,
          kind: "invalid_input",
          content: `Call ${RESULT_TOOL_NAME} alone, after the other tool results arrive.`,
        };
      } else {
        const outcome = await scope.tree.invokeTool(parallel, signal, async () => {
          active();
          const approval =
            approved?.request.operationId === request.operationId ? approved : undefined;
          if (tool.needsApproval && !approval)
            fail(
              "approval_required",
              "This tool needs a host-approved decision.",
              request.operationId,
            );
          function checkExpiry(): void {
            if (approval && approval.scope.expiresAt <= Date.now())
              fail(
                "approval_expired",
                "The approval expired. Request a new decision before running this tool.",
                request.operationId,
              );
          }
          checkExpiry();
          await untilAbort(
            Promise.resolve(host?.beforeTool?.(immutableCopy(request), immutableCopy(approval))),
            signal,
          );
          active();
          checkExpiry();
          emit({ type: "tool_start", request });
          active();
          // A synchronous observer can delay invocation past the approval's expiry.
          checkExpiry();
          return tool.invoke(copyData(request.arguments), {
            ...options.context,
            runId: snapshot.runId,
            attemptId: snapshot.attemptId,
            operationId: request.operationId,
            callId: request.call.id,
            signal,
          });
        });
        // Core reports an aborted invocation as data. It must not buy another model turn.
        if (!outcome.ok) active();
        result = outcome.ok
          ? { ok: true, content: outcome.summary }
          : { ok: false, content: outcome.error, kind: outcome.kind };
      }
      await finishTool(model, index, request, result);
      active();
    }

    async function runDelegation(
      model: CompletedModel,
      index: number,
      request: ToolRequest,
      descriptor: Delegation,
    ): Promise<void> {
      let journal = snapshot.delegations.find((entry) => entry.operationId === request.operationId);
      if (!journal) {
        journal = { operationId: request.operationId, children: [] };
        snapshot.delegations.push(journal);
      }
      model.tools[index] = {
        id: request.operationId,
        attemptId: snapshot.attemptId,
        status: "delegating",
      };
      await save();
      active();
      if (!completeArguments(request.call.arguments)) {
        await finishTool(model, index, request, {
          ok: false,
          kind: "invalid_input",
          content: "Tool arguments must be one complete JSON object. Send the full object again.",
        });
        return;
      }
      await untilAbort(Promise.resolve(host?.beforeTool?.(immutableCopy(request))), signal);
      active();
      emit({ type: "tool_start", request });
      active();
      // Coordination is pure and is the only place children can start. Lend once
      // for this entire barrier, including ignored children and overlapping joins.
      release();
      let result: ToolResult;
      try {
        result = await executeDelegation(
          descriptor,
          journal,
          snapshot,
          request.arguments,
          options,
          scope,
          signal,
          active,
          evidence,
        );
      } finally {
        release = await scope.tree.gate.acquire(signal);
      }
      active();
      await finishTool(model, index, request, result);
    }

    async function handleTurn(model: CompletedModel): Promise<void> {
      active();
      const { message, finishReason } = model.turn;
      if (finishReason === "length") throw new Halt({ status: "limited", limit: "outputTokens" });
      if (finishReason === "content_filter")
        fail(
          "content_filtered",
          "The provider blocked this answer. Revise the request before trying again.",
          model.id,
        );
      if (finishReason === null)
        fail(
          "incomplete_turn",
          "The model turn ended without a finish reason. Check the provider before trying again.",
          model.id,
        );
      const calls = message.toolCalls ?? [];
      if (calls.length === 0) {
        if (output)
          fail(
            "missing_result",
            `The model did not submit a result through ${RESULT_TOOL_NAME}.`,
            model.id,
          );
        if (!message.content.trim())
          fail(
            "empty_output",
            "The model returned no answer, only reasoning or an empty turn.",
            model.id,
          );
        snapshot.state = { status: "completed", candidate: message.content };
        return;
      }

      for (let index = 0; index < calls.length;) {
        if (model.tools[index]?.status === "completed") {
          index++;
          continue;
        }
        active();
        const capacity = limits.toolCalls - usedTools();
        if (capacity <= 0 && model.tools[index]?.status === "pending")
          throw new Halt({ status: "limited", limit: "toolCalls" });
        const request = requestFor(model, index);
        const descriptor = delegations.get(request.call.name);
        if (descriptor) {
          await runDelegation(model, index, request, descriptor);
          index++;
          continue;
        }
        const tool = registry.get(request.call.name);
        if (
          tool?.needsApproval &&
          completeArguments(request.call.arguments) &&
          approved?.request.operationId !== request.operationId
        ) {
          if (!host?.approvalContext)
            fail(
              "approval_host_missing",
              "Provide host.approvalContext to request approval for this tool.",
              request.operationId,
            );
          const scope = copyData(
            await untilAbort(Promise.resolve(host.approvalContext(immutableCopy(request))), signal),
          );
          active();
          if (!isScope(scope) || scope.expiresAt <= Date.now())
            fail(
              "invalid_approval_scope",
              "The host must supply an actor, resource version and future approval expiry.",
              request.operationId,
            );
          snapshot.state = {
            status: "suspended",
            approval: { request: copyData(request), scope },
            path: [],
          };
          return;
        }

        const batch = [{ index, request, tool }];
        const parallel = (request: ToolRequest, tool?: Tool) =>
          tool?.isConcurrencySafe === true &&
          !tool.needsApproval &&
          !tool.isTerminal &&
          host?.canRunConcurrently?.(immutableCopy(request)) === true;
        const concurrent = parallel(request, tool);
        if (concurrent) {
          for (
            let next = index + 1;
            next < calls.length && batch.length < Math.min(limits.parallelTools, capacity);
            next++
          ) {
            if (model.tools[next]?.status !== "pending") break;
            const nextRequest = requestFor(model, next);
            const nextTool = registry.get(nextRequest.call.name);
            if (!parallel(nextRequest, nextTool)) break;
            batch.push({ index: next, request: nextRequest, tool: nextTool });
          }
        }
        active();
        // Reserve the whole admitted batch before any invocation, including its tool-call budget.
        for (const job of batch)
          model.tools[job.index] = {
            id: job.request.operationId,
            attemptId: snapshot.attemptId,
            status: "running",
          };
        await save();
        const settled = await Promise.allSettled(
          batch.map((job) => runTool(model, job.index, job.request, job.tool, concurrent)),
        );
        const rejected = settled.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        approved = undefined;
        index += batch.length;
      }
      const terminal = model.tools[0];
      if (
        output &&
        calls.length === 1 &&
        calls[0]?.name === RESULT_TOOL_NAME &&
        terminal?.status === "completed" &&
        terminal.result.ok
      ) {
        snapshot.state = { status: "completed", candidate: parseToolArgs(calls[0].arguments) };
      }
    }

    async function nextTurn(): Promise<CompletedModel> {
      active();
      if (snapshot.models.length >= limits.turns)
        throw new Halt({ status: "limited", limit: "turns" });
      scope.tree.reserveModel();
      const model: ModelExecution = {
        id: modelId(snapshot.runId, snapshot.models.length),
        attemptId: snapshot.attemptId,
        status: "running",
        usage: { ...EMPTY_USAGE },
      };
      snapshot.models.push(model);
      await save();
      active();
      async function* observed(): AsyncIterable<ProviderChunk> {
        const stream = provider.createStream(
          historyOf(snapshot, instructions),
          copyData(tools.map((tool) => tool.definition())),
          {
            signal,
            sessionId: snapshot.runId,
          },
        );
        for await (const chunk of stream) {
          active();
          if (chunk.usage) {
            if (!isUsage(chunk.usage))
              fail("invalid_usage", "The provider returned invalid token usage.", model.id);
            model.usage = copyData(chunk.usage);
          }
          emit({
            type: "model_chunk",
            runId: snapshot.runId,
            attemptId: snapshot.attemptId,
            operationId: model.id,
            chunk,
          });
          active();
          yield chunk;
        }
      }
      const turn = readTurn(await untilAbort(collectTurn(observed()), signal));
      const done: CompletedModel = {
        ...model,
        status: "completed",
        usage: turn.usage,
        turn,
        tools: (turn.message.toolCalls ?? []).map((_call, index) => ({
          id: toolId(model.id, index),
          status: "pending",
        })),
      };
      snapshot.models[snapshot.models.length - 1] = done;
      await save();
      return done;
    }

    try {
      if (snapshot.state.status === "running" || snapshot.state.status === "suspended") {
        release = await scope.tree.gate.acquire(signal);
        active();
        for (const model of snapshot.models) {
          const interrupted =
            model.status === "running"
              ? model
              : model.tools.find((tool) => tool.status === "running");
          if (interrupted)
            fail(
              "interrupted_operation",
              "This operation started but has no saved result. Reconcile it with the host; it will not be replayed.",
              interrupted.id,
            );
        }
        if (snapshot.state.status === "suspended" && snapshot.state.path.length > 0) {
          // Replay only pure coordination. Evidence follows its exact path to one leaf.
          snapshot.state = { status: "running" };
        }
        if (snapshot.state.status === "suspended" && evidence) {
          active();
          const approval = snapshot.state.approval;
          if (approval.scope.expiresAt <= Date.now())
            fail(
              "approval_expired",
              "The approval expired. Request a new decision before resuming.",
              approval.request.operationId,
            );
          if (!registry.get(approval.request.call.name)?.needsApproval)
            fail(
              "invalid_approval",
              "The pending approval does not belong to an approval-required tool.",
            );
          if (!host?.resolveApproval || !host.beforeTool)
            fail(
              "approval_host_missing",
              "Provide host.resolveApproval and host.beforeTool to authenticate a decision and recheck access.",
            );
          await save();
          active();
          const answer = await untilAbort(
            Promise.resolve(
              host.resolveApproval(immutableCopy(approval), immutableCopy(evidence.decision)),
            ),
            signal,
          );
          active();
          if (answer !== "pending") {
            if (answer !== "approved" && answer !== "denied")
              fail(
                "invalid_approval_decision",
                "The host must return approved, denied or pending.",
              );
            snapshot.state = { status: "running" };
            if (answer === "approved") approved = approval;
            else {
              const model = snapshot.models.at(-1);
              if (model?.status !== "completed")
                fail("invalid_journal", "The pending tool turn is missing.");
              const index = model.tools.findIndex(
                (tool) => tool.id === approval.request.operationId,
              );
              if (usedTools() >= limits.toolCalls)
                throw new Halt({ status: "limited", limit: "toolCalls" });
              await finishTool(model, index, requestFor(model, index), {
                ok: false,
                kind: "denied",
                content: "The host denied this tool call. Continue without this action.",
              });
            }
          }
        }
        if (snapshot.state.status === "running") {
          const last = snapshot.models.at(-1);
          if (last?.status === "completed") await handleTurn(last);
          while (snapshot.state.status === "running") await handleTurn(await nextTurn());
        }
      }
      if (snapshot.state.status === "completed")
        completed = { output: validateResult(snapshot.state.candidate) };
      await save();
    } catch (error) {
      let failure = error;
      try {
        active();
      } catch (stopped) {
        failure = stopped;
      }
      snapshot.state =
        failure instanceof Halt
          ? failure.state
          : {
              status: "failed",
              error: { code: "execution_failed", message: messageOf(failure) },
            };
      try {
        await save();
      } catch (saveError) {
        snapshot.state =
          saveError instanceof Halt
            ? saveError.state
            : {
                status: "failed",
                error: { code: "checkpoint_failed", message: messageOf(saveError) },
              };
      }
    } finally {
      release();
      clearTimeout(timer);
    }
    emit({
      type: "state",
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      state: snapshot.state,
    });
    const record = recordOf(snapshot, instructions);
    const state = snapshot.state;
    if (state.status === "completed") {
      if (!completed) throw new Error("The agent completed without validating its result.");
      return { ...record, status: "completed", output: completed.output };
    }
    return { ...record, ...state };
  }

  const runtime: AgentRuntime<T | string> = {
    execute,
    create(input, runId, tree) {
      const startedAt = Date.now();
      return {
        format: 2,
        agentId: id,
        version,
        runId,
        attemptId: crypto.randomUUID(),
        startedAt,
        input,
        limits: copyData(limits),
        models: [],
        delegations: [],
        state: { status: "running" },
        tree: tree ? copyData(tree) : { runId, startedAt, limits: copyData(treeLimits) },
      };
    },
    restore(raw, tree) {
      const snapshot = readSnapshot(
        raw,
        id,
        version,
        limits,
        output ? RESULT_TOOL_NAME : undefined,
      );
      if (
        tree
          ? !equalData(snapshot.tree, tree)
          : snapshot.tree.runId !== snapshot.runId || !equalData(snapshot.tree.limits, treeLimits)
      )
        throw new TypeError("The snapshot tree does not match this root or its limits.");
      for (const model of snapshot.models) {
        if (model.status !== "completed") continue;
        for (const [index, tool] of model.tools.entries()) {
          const call = model.turn.message.toolCalls?.[index];
          const descriptor = call && delegations.get(call.name);
          const journal = snapshot.delegations.find((entry) => entry.operationId === tool.id);
          if (descriptor && tool.status !== "pending") {
            if (!journal || tool.status === "running")
              throw new TypeError(
                "A delegation needs its own child journal, not an ordinary effect marker.",
              );
          } else if (journal)
            throw new TypeError("The saved delegation is not in this agent definition.");
          if (!journal || !descriptor) continue;
          for (const entry of journal.children) {
            const agent = descriptor.specialists.find(
              (agent) =>
                agent.id === entry.snapshot.agentId && agent.version === entry.snapshot.version,
            );
            if (!agent)
              throw new TypeError("The saved child is not a registered specialist version.");
            entry.snapshot = agent[AGENT_RUNTIME].restore(entry.snapshot, snapshot.tree);
          }
        }
      }
      if (snapshot.state.status === "completed") validateResult(snapshot.state.candidate);
      return snapshot;
    },
    hydrate(snapshot) {
      const record = recordOf(snapshot, instructions);
      const state = record.snapshot.state;
      if (state.status === "running") throw new Error("A child has not settled yet.");
      return state.status === "completed"
        ? { ...record, status: "completed", output: validateResult(state.candidate) }
        : { ...record, ...state };
    },
  };

  async function root(snapshot: RunSnapshot, options: RunOptions, evidence?: ApprovalEvidence) {
    const tree = new ExecutionTree(snapshot, options);
    try {
      return await execute(snapshot, options, { tree, depth: 0 }, evidence);
    } finally {
      tree.close();
    }
  }

  const agent: Agent<T | string> = {
    id,
    version,
    [AGENT_RUNTIME]: runtime,
    asTool(options) {
      return specialistTool(agent, options);
    },
    async run(input, options = {}) {
      if (!isId(input)) throw new TypeError("Give the agent a non-empty text input.");
      checkOptions(options);
      return root(runtime.create(input, options.runId ?? crypto.randomUUID()), options);
    },
    async resume(raw, options) {
      checkOptions(options);
      const snapshot = runtime.restore(raw);
      let evidence: ApprovalEvidence | undefined;
      if (options.decision !== undefined || options.approvalPath !== undefined) {
        if (
          snapshot.state.status !== "suspended" ||
          !equalData(options.approvalPath ?? [], snapshot.state.path)
        )
          throw new TypeError("The decision path must match the exposed pending approval.");
        if (options.decision !== undefined)
          evidence = copyData({ path: snapshot.state.path, decision: options.decision });
      }
      await authorizeTree(snapshot, options.host);
      snapshot.attemptId = crypto.randomUUID();
      return root(snapshot, options, evidence);
    },
  };
  return Object.freeze(agent);
}
