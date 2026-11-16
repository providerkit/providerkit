import {
  EMPTY_USAGE,
  ProviderError,
  ToolRegistry,
  collectTurn,
  defineTool,
  messageOf,
  parseToolArgs,
  type ProviderChunk,
  type Tool,
} from "@providerkit/core";
import {
  AGENT_RUNTIME,
  executeDelegation,
  isDelegation,
  specialistTool,
  type AgentRuntime,
  type Delegation,
  type RunStart,
} from "./delegation.ts";
import {
  checkHandoffTargets,
  handoffDelegation,
  handoffNote,
  handoffRecord,
  handoffRef,
  isHandoff,
} from "./handoff.ts";
import {
  RequestJournal,
  isClientTool,
  isInputRequired,
  requestHash,
  type ClientTool,
} from "./request.ts";
import { acknowledgeInputs, acceptInputs, inputReceipts } from "./steering.ts";
import { modelsUsage, readRecoveryPolicy, recoveryToolHash, requireRecovery } from "./recovery.ts";
import { conversationOf, readInput, readStored, repairConversation, requestOf } from "./input.ts";
import {
  ExecutionTree,
  Halt,
  authorizeTree,
  emitEvent,
  fail,
  treeUsage,
  openRequests,
  readAnswers,
  requestRecords,
  stopRequests,
  untilAbort,
  type ExecutionScope,
} from "./tree.ts";
import {
  checkOptions,
  completeArguments,
  copyData,
  equalData,
  finalToolResult,
  finalHandoffResult,
  immutableCopy,
  inlineBytes,
  isBase64,
  isEnabledTools,
  isId,
  isNames,
  isRecord,
  isRevision,
  isUsage,
  modelId,
  readLimits,
  readModelSettings,
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
  EnabledTools,
  MediaRef,
  ModelExecution,
  OperationReceipt,
  ResultSchema,
  RunContext,
  RunDefinition,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  SessionStatus,
  ToolRequest,
  ToolResult,
} from "./types.ts";

/** Reserved for the output contract supplied to defineAgent. */
export const RESULT_TOOL_NAME = "submit_result";

type CompletedModel = Extract<ModelExecution, { status: "completed" }>;

function recordOf(snapshot: RunSnapshot) {
  const saved = copyData(snapshot);
  const receipts: OperationReceipt[] = [];
  const usage = modelsUsage(saved.models);
  for (const model of saved.models) {
    for (const attempt of model.interrupted)
      receipts.push({
        kind: "model",
        id: model.id,
        ...attempt,
        status: "interrupted",
        billing: "unknown",
      });
    receipts.push({
      kind: "model",
      id: model.id,
      attemptId: model.attemptId,
      status: model.status,
      billing: model.billing,
      usage: model.usage,
      ...(model.status === "completed" && model.turn.source ? { source: model.turn.source } : {}),
    });
    if (model.status !== "completed") continue;
    for (const [index, tool] of model.tools.entries()) {
      const call = model.turn.message.toolCalls?.[index];
      if (!call) continue;
      for (const attempt of tool.interrupted)
        receipts.push({
          kind: "tool",
          id: tool.id,
          callId: call.id,
          ...attempt,
          status: "interrupted",
        });
      if (tool.status === "pending") continue;
      receipts.push({
        kind: saved.delegations.find((journal) => journal.operationId === tool.id)?.kind ?? "tool",
        id: tool.id,
        callId: call.id,
        attemptId: tool.attemptId,
        status: tool.status === "delegating" ? "running" : tool.status,
        ...(tool.status === "completed" ? { result: tool.result } : {}),
      });
    }
  }
  // A root run replaces this with what its append did. Read from a snapshot alone, whether the
  // session has the turn is not known.
  const session: SessionStatus | undefined = saved.session && {
    id: saved.session.id,
    status: "pending",
  };
  return {
    runId: saved.runId,
    attemptId: saved.attemptId,
    usage,
    treeUsage: treeUsage(saved),
    receipts,
    inputs: inputReceipts(saved),
    ...handoffRecord(saved),
    snapshot: saved,
    ...(session ? { session } : {}),
  };
}

export function defineAgent<T>(definition: AgentConfig & { output: ResultSchema<T> }): Agent<T>;
export function defineAgent(definition: AgentDefinition): Agent<string>;
export function defineAgent<T>(definition: AgentDefinition<T>): Agent<T | string> {
  const { id, version, instructions, provider } = definition;
  if (
    !isId(id) ||
    !isId(version) ||
    (typeof instructions !== "string" && typeof instructions !== "function") ||
    !provider ||
    typeof provider.createStream !== "function"
  ) {
    throw new TypeError("An agent needs an id, version, instructions and provider.");
  }
  const settings = readModelSettings(definition.modelSettings);
  const recovery = readRecoveryPolicy(definition.recovery);
  if (recovery && (!isId(provider.id) || !isId(provider.model)))
    throw new TypeError("A recovery profile needs a stable provider id and model.");
  if (definition.enabledTools !== undefined && !isEnabledTools(definition.enabledTools))
    throw new TypeError("enabledTools must be an allow-list or a function returning one.");
  const enabledTools = Array.isArray(definition.enabledTools)
    ? [...definition.enabledTools]
    : definition.enabledTools;
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
  // ponytail: text-only transfer avoids claiming that an arbitrary target satisfies the
  // source's checked output. Typed handoffs need an explicit typed adapter before support.
  if (output && tools.some(isHandoff))
    throw new TypeError(
      "An agent with an output contract cannot offer handoffs. Use delegation instead.",
    );
  if (
    new Set(tools.map((tool) => tool.name)).size !== tools.length ||
    tools.some((tool) => !isId(tool.name) || tool.name === RESULT_TOOL_NAME)
  ) {
    throw new TypeError(
      `Use unique tool names. ${RESULT_TOOL_NAME} is reserved for the output contract.`,
    );
  }
  if (definition.stopAtTools !== undefined && !isNames(definition.stopAtTools))
    throw new TypeError("stopAtTools must be a list of unique tool names.");
  const stopAtTools = [...(definition.stopAtTools ?? [])];
  for (const name of stopAtTools) {
    const tool = tools.find((tool) => tool.name === name);
    if (!tool || isDelegation(tool) || isHandoff(tool) || isClientTool(tool))
      throw new TypeError("stopAtTools must name ordinary tools registered on this agent.");
  }
  for (const tool of tools)
    if (
      !isDelegation(tool) &&
      !isHandoff(tool) &&
      !isClientTool(tool) &&
      tool.isTerminal &&
      !stopAtTools.includes(tool.name)
    )
      stopAtTools.push(tool.name);
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
  const registry = new ToolRegistry(
    tools.filter(
      (tool): tool is Tool => !isDelegation(tool) && !isHandoff(tool) && !isClientTool(tool),
    ),
  );
  for (const name of recovery?.readOnlyTools ?? [])
    if (!registry.get(name)?.isReadOnly || name === RESULT_TOOL_NAME)
      throw new TypeError(
        "Recovery readOnlyTools must name ordinary isReadOnly tools registered on this agent.",
      );
  const delegations = new Map(tools.filter(isDelegation).map((tool) => [tool.name, tool]));
  const handoffs = new Map(tools.filter(isHandoff).map((tool) => [tool.name, tool]));

  function descriptorFor(
    name: string,
    snapshot: RunSnapshot,
    operationId: string,
  ): Delegation | undefined {
    const handoff = handoffs.get(name);
    if (!handoff) return delegations.get(name);
    const journal = snapshot.delegations.find((entry) => entry.operationId === operationId);
    if (!journal || journal.kind !== "handoff") return undefined;
    if (!equalData(journal.target, handoffRef(handoff.target())))
      throw new TypeError(
        "The saved handoff target or version changed. Restore the registered target.",
      );
    return handoffDelegation(handoff, snapshot, journal);
  }
  const clients = new Map(tools.filter(isClientTool).map((tool) => [tool.name, tool]));
  const names = tools.map((tool) => tool.name);
  function checkNames(value: unknown): string[] {
    if (!isNames(value) || value.some((name) => !names.includes(name)))
      throw new TypeError("enabledTools must name each registered tool at most once.");
    return [...value];
  }
  if (Array.isArray(enabledTools)) checkNames(enabledTools);

  // Adapted from OpenAI Agents JS (MIT), agent.ts and tool.ts. Unlike its per-turn
  // callbacks, these resolve once: a restarted worker must see the same prompt and tools.
  async function resolveDefinition(
    start: RunStart,
    options: RunOptions,
    runId: string,
  ): Promise<RunDefinition> {
    const signal = options.signal ?? new AbortController().signal;
    const run: RunContext = Object.freeze({
      agentId: id,
      version,
      runId,
      ...immutableCopy({ history: start.history, input: start.input }),
      context: Object.freeze({ ...options.context }),
      signal,
    });
    const text: unknown =
      typeof instructions === "function"
        ? await untilAbort(Promise.resolve(instructions(run)), signal)
        : instructions;
    if (typeof text !== "string") throw new TypeError("instructions must return a string.");
    async function select(selection: EnabledTools | undefined): Promise<string[]> {
      return selection === undefined
        ? [...names]
        : checkNames(
            typeof selection === "function"
              ? await untilAbort(Promise.resolve(selection(run)), signal)
              : selection,
          );
    }
    const allowed = await select(enabledTools);
    const selected =
      options.enabledTools === undefined ? allowed : await select(options.enabledTools);
    if (selected.some((name) => name !== RESULT_TOOL_NAME && !allowed.includes(name)))
      throw new TypeError(
        "Run enabledTools may narrow the agent's tools, not enable a disabled tool.",
      );
    // The definition's order is part of the provider's cached prefix, not the allow-list's.
    const enabled = names.filter(
      (name) => selected.includes(name) || (output && name === RESULT_TOOL_NAME),
    );
    // Ported from PydanticAI (MIT), settings.py, merge_model_settings: the run wins.
    // Provider defaults remain in core; passing only set values preserves that first layer.
    const {
      onActivity: _onActivity,
      onRateLimit: _onRateLimit,
      ...modelSettings
    } = {
      ...settings,
      ...readModelSettings(options.modelSettings),
    };
    const choice = modelSettings.toolChoice;
    if (output && choice === "none")
      throw new TypeError(
        "toolChoice none disables submit_result, which a checked-output run needs to finish.",
      );
    if (
      (choice === "required" && enabled.length === 0) ||
      (typeof choice === "object" && !enabled.includes(choice.name))
    )
      throw new TypeError("toolChoice must name an enabled tool; required needs at least one.");
    const toolHashes = Object.fromEntries(
      await Promise.all(
        (recovery?.readOnlyTools ?? []).map(async (name) => {
          const tool = registry.get(name);
          if (!tool) throw new TypeError("Missing recovery tool.");
          return [name, await recoveryToolHash(tool)] as const;
        }),
      ),
    );
    return {
      instructions: text,
      modelSettings,
      enabledTools: enabled,
      stopAtTools: [...stopAtTools],
      recovery: recovery
        ? {
            policy: copyData(recovery),
            provider: { id: provider.id, model: provider.model },
            toolHashes,
            modelToolsHash: await requestHash(
              tools.filter((tool) => enabled.includes(tool.name)).map((tool) => tool.definition()),
            ),
          }
        : null,
    };
  }

  function validateResult(candidate: unknown): T | string {
    // copyData permits absent optional values, but a result must survive a JSON checkpoint.
    if (candidate === undefined)
      throw new TypeError("The result must be a JSON value. Return null instead of undefined.");
    if (output) return output.validate(copyData(candidate));
    if (typeof candidate !== "string" || !candidate.trim())
      throw new TypeError("The model returned no answer.");
    return candidate;
  }

  function requestFor(snapshot: RunSnapshot, model: CompletedModel, index: number): ToolRequest {
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

  async function needsApproval(
    call: ToolRequest,
    options: RunOptions,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (call.call.name === RESULT_TOOL_NAME) return false;
    const tool = tools.find((tool) => tool.name === call.call.name);
    return (
      tool?.needsApproval === true ||
      (await untilAbort(
        Promise.resolve(options.host?.needsApproval?.(immutableCopy(call))),
        signal,
      )) === true
    );
  }

  function journalFor(
    snapshot: RunSnapshot,
    model: CompletedModel,
    index: number,
    options: RunOptions,
    scope: ExecutionScope,
    signal: AbortSignal,
    effectiveCall?: ToolRequest,
  ): RequestJournal {
    const call = requestFor(snapshot, model, index);
    const execution = model.tools[index];
    if (!execution) throw new TypeError("Missing tool journal.");
    const tool = tools.find((tool) => tool.name === call.call.name);
    return new RequestJournal(
      execution,
      effectiveCall ?? call,
      options,
      scope,
      signal,
      // The policy hash follows the original model call even when dispatch arguments were edited.
      async () =>
        requestHash({
          definition: tool?.definition() ?? null,
          needsApproval: await needsApproval(call, options, signal),
          kind:
            tool && isHandoff(tool)
              ? "handoff"
              : tool && isDelegation(tool)
                ? "delegation"
                : tool && isClientTool(tool)
                  ? "client"
                  : "tool",
          ...(tool && isHandoff(tool) ? { target: handoffRef(tool.target()) } : {}),
          ...(tool && isClientTool(tool) ? { resultSchema: tool.resultSchema } : {}),
        }),
      (decision) => {
        if (decision.type === "result") {
          const client = clients.get(call.call.name);
          if (!client) throw new TypeError("This call is not a registered client tool.");
          client.result(decision.value);
        }
      },
    );
  }

  // Intake is a tree-wide pre-effect barrier. A saved child receives its decisions in its
  // snapshot before the host may reuse a segment. No browser-supplied route is consulted.
  async function answerRequests(
    snapshot: RunSnapshot,
    options: RunOptions,
    scope: ExecutionScope,
    answers: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void> {
    if (snapshot.state.status !== "running" && snapshot.state.status !== "suspended") return;
    signal.throwIfAborted();
    for (const model of snapshot.models) {
      if (model.status !== "completed") continue;
      for (const [index, execution] of model.tools.entries()) {
        if (execution.status === "completed") continue;
        const journal = journalFor(snapshot, model, index, options, scope, signal);
        for (const record of [...(execution.asks ?? [])]) {
          if (record.closed) continue;
          scope.tree.active();
          signal.throwIfAborted();
          if (!record.decision && Object.hasOwn(answers, record.request.id))
            await journal.resolve(record, answers[record.request.id]);
          else await journal.refresh(record);
        }
      }
    }
    for (const entry of snapshot.delegations) {
      const model = snapshot.models.find(
        (model) =>
          model.status === "completed" && model.tools.some((tool) => tool.id === entry.operationId),
      );
      const position =
        model?.status === "completed"
          ? model.tools.findIndex((tool) => tool.id === entry.operationId)
          : -1;
      const name =
        model?.status === "completed" ? model.turn.message.toolCalls?.[position]?.name : undefined;
      const descriptor = name && descriptorFor(name, snapshot, entry.operationId);
      if (!descriptor) continue;
      for (const child of entry.children) {
        if (
          child.snapshot.state.status !== "running" &&
          child.snapshot.state.status !== "suspended"
        )
          continue;
        const specialist = descriptor.specialists.find(
          (agent) =>
            agent.id === child.snapshot.agentId && agent.version === child.snapshot.version,
        );
        if (!specialist) throw new TypeError("Unregistered specialist.");
        await specialist[AGENT_RUNTIME].answerRequests(
          child.snapshot,
          options,
          {
            tree: scope.tree,
            depth: scope.depth + 1,
            path: [
              ...scope.path,
              { operationId: entry.operationId, key: child.key, runId: child.snapshot.runId },
            ],
          },
          answers,
          signal,
        );
      }
    }
  }

  async function execute(
    snapshot: RunSnapshot,
    options: RunOptions,
    scope: ExecutionScope,
    answers?: Readonly<Record<string, unknown>>,
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
    let completed: { output: T | string } | undefined;

    function active(): void {
      scope.tree.active();
      if (options.signal?.aborted) throw new Halt({ status: "cancelled" });
      if (timeout.signal.aborted || Date.now() >= deadline)
        throw new Halt({ status: "limited", limit: "elapsedMs" });
    }

    function emit(event: AgentEvent): void {
      emitEvent(options, event);
    }

    const save = () => scope.tree.save();

    function restart(kind: "model" | "tool", operationId: string, previousAttemptId: string): void {
      // Adapted from Vercel AI SDK (Apache-2.0), workflow/do-stream-step.ts: reset the
      // current display before replacement output. Unlike reset-step, identity stays explicit.
      emit({
        type: "operation_restart",
        kind,
        runId: snapshot.runId,
        operationId,
        previousAttemptId,
        attemptId: snapshot.attemptId,
      });
    }

    async function checkToolRecovery(
      model: CompletedModel,
      index: number,
      previous: number,
    ): Promise<void> {
      const execution = model.tools[index];
      if (!execution) fail("invalid_journal", "The tool call is missing from its journal.");
      const request = requestFor(snapshot, model, index);
      const tool = registry.get(request.call.name);
      const recorded = snapshot.definition.recovery;
      requireRecovery(
        !!tool?.isReadOnly &&
          recorded?.policy.readOnlyTools?.includes(request.call.name) === true &&
          !execution.asks?.length &&
          !!host?.beforeTool,
        previous,
        recorded,
        execution.id,
      );
      if (!tool || (await recoveryToolHash(tool)) !== recorded?.toolHashes[tool.name])
        fail(
          "recovery_definition_changed",
          "The interrupted tool's definition changed. Reconcile it with the host before continuing.",
          execution.id,
        );
      active();
    }

    async function recoverTools(model: CompletedModel): Promise<void> {
      for (const [index, execution] of model.tools.entries()) {
        if (execution.status !== "running") continue;
        await checkToolRecovery(model, index, execution.interrupted.length);
        model.tools[index] = {
          id: execution.id,
          status: "pending",
          interrupted: [...execution.interrupted, { attemptId: execution.attemptId }],
        };
      }
    }

    function usedTools(): number {
      return snapshot.models.reduce(
        (count, model) =>
          count +
          (model.status === "completed"
            ? model.tools.reduce(
                (total, tool) =>
                  total +
                  tool.interrupted.length +
                  (tool.status !== "pending" || tool.asks?.length ? 1 : 0),
                0,
              )
            : 0),
        0,
      );
    }

    async function finishTool(
      model: CompletedModel,
      index: number,
      request: ToolRequest,
      result: ToolResult,
    ): Promise<void> {
      if (!result.ok && (result.kind === "cancelled" || result.kind === "denied")) {
        for (const record of model.tools[index]?.asks ?? [])
          if (!record.decision && !record.closed) record.closed = "stopped";
        // A cancelled coordination call cannot leave suspended children under a completed
        // tool receipt. Already settled children and their usage remain untouched.
        const delegation = snapshot.delegations.find(
          (entry) => entry.operationId === request.operationId,
        );
        for (const child of delegation?.children ?? []) stopRequests(child.snapshot);
        // Once a target was admitted, it owns this conversation. Denying a renewed transfer
        // stops that conversation; it cannot buy a new source turn after target effects.
        if (delegation?.kind === "handoff" && delegation.children.length > 0)
          snapshot.state = { status: "cancelled" };
      }
      const edited = model.tools[index]?.asks?.some(
        (record) =>
          !record.closed &&
          record.decision?.type === "approve" &&
          record.decision.arguments !== undefined,
      );
      if (edited)
        result = {
          ...result,
          content: `${result.content}\nThe reviewer replaced the tool arguments before this call.`,
        };
      model.tools[index] = {
        interrupted: model.tools[index]?.interrupted ?? [],
        asks: model.tools[index]?.asks,
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
          content: `Call ${tool.name} alone, after the other tool results arrive.`,
        };
      } else {
        const outcome = await scope.tree.invokeTool(parallel, signal, async () => {
          active();
          const journal = journalFor(snapshot, model, index, options, scope, signal);
          try {
            await journal.recheck(request);
            active();
            emit({ type: "tool_start", request });
            active();
            await journal.assertFresh();
          } catch (error) {
            // No invocation has started. Expiry reopens the request rather than leaving an
            // unknown effect marker for work that was never sent.
            if (error instanceof Halt && error.state.status === "suspended")
              model.tools[index] = {
                id: request.operationId,
                status: "pending",
                interrupted: model.tools[index]?.interrupted ?? [],
                asks: model.tools[index]?.asks,
              };
            throw error;
          }
          const records = model.tools[index]?.asks ?? [];
          const answers = Object.fromEntries(
            records
              .filter(
                (record) =>
                  !record.closed &&
                  record.request.ask.type === "question" &&
                  record.decision?.type === "answer",
              )
              .map((record) => [
                record.request.ask.type === "question" ? record.request.ask.key : "",
                record.decision?.type === "answer" ? record.decision.answer : undefined,
              ]),
          );
          const decision = [...records]
            .reverse()
            .find((record) => !record.closed && record.decision)?.decision;
          return tool.invoke(copyData(request.arguments), {
            ...options.context,
            answers: immutableCopy(answers),
            decision: immutableCopy(decision),
            runId: snapshot.runId,
            attemptId: snapshot.attemptId,
            operationId: request.operationId,
            callId: request.call.id,
            signal,
          });
        });
        // Core reports an aborted invocation as data. It must not buy another model turn.
        if (!outcome.ok) active();
        if (!outcome.ok && outcome.kind === "failed" && isInputRequired(outcome.cause)) {
          const asks = model.tools[index]?.asks;
          // The explicit InputRequired contract is the only ordinary-tool pre-effect boundary.
          // A worker death before this response keeps the running marker and cannot replay it.
          model.tools[index] = {
            id: request.operationId,
            status: "pending",
            asks,
            interrupted: model.tools[index]?.interrupted ?? [],
          };
          const journal = journalFor(snapshot, model, index, options, scope, signal);
          const previous = journal.latest(outcome.cause.ask);
          if (previous?.decision) previous.closed = "invalid";
          await journal.open(
            outcome.cause.ask,
            outcome.cause.problem
              ? { code: "invalid_answer", message: outcome.cause.problem }
              : undefined,
          );
          return;
        }
        result = outcome.ok
          ? { ok: true, content: outcome.summary }
          : { ok: false, content: outcome.error, kind: outcome.kind };
        if (outcome.ok && snapshot.definition.stopAtTools.includes(tool.name)) {
          // Keep the raw candidate, not the validator's return. Restoring runs applies the
          // same pure validator without repeating the effect or asking the model to rewrite it.
          try {
            const candidate = output ? copyData(outcome.output) : outcome.summary;
            validateResult(candidate);
            result = { ok: true, content: outcome.summary, final: { candidate } };
          } catch (error) {
            result = {
              ok: false,
              kind: "invalid_output",
              content: `The tool result did not pass the output check: ${messageOf(error)}`,
            };
          }
        }
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
        journal = { kind: "delegation", operationId: request.operationId, children: [] };
        snapshot.delegations.push(journal);
      }
      if (journal.kind === "handoff") {
        try {
          const note = handoffNote(request.arguments);
          if (journal.children.length > 0 && note !== journal.note)
            throw new TypeError("The transfer note changed after the target started.");
          journal.note = note;
        } catch (error) {
          if (journal.children.length > 0)
            fail(
              "handoff_input_changed",
              "The target already started. Its transfer arguments cannot change. Reconcile the saved run before starting different work.",
              request.operationId,
            );
          await finishTool(model, index, request, {
            ok: false,
            kind: "invalid_input",
            content: messageOf(error),
          });
          return;
        }
      }
      model.tools[index] = {
        interrupted: model.tools[index]?.interrupted ?? [],
        asks: model.tools[index]?.asks,
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
      const requests = journalFor(snapshot, model, index, options, scope, signal);
      await requests.recheck(request);
      active();
      emit({ type: "tool_start", request });
      active();
      await requests.assertFresh();
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
          requests,
        );
      } finally {
        release = await scope.tree.gate.acquire(signal);
      }
      active();
      await finishTool(model, index, request, result);
    }

    async function openApprovals(model: CompletedModel, from: number): Promise<void> {
      for (let index = from; index < model.tools.length; index++) {
        const execution = model.tools[index];
        if (!execution || execution.status === "completed") continue;
        if (usedTools() >= limits.toolCalls && !execution.asks?.length) break;
        const request = requestFor(snapshot, model, index);
        const tool = tools.find((tool) => tool.name === request.call.name);
        if (
          !tool ||
          request.call.name === RESULT_TOOL_NAME ||
          !snapshot.definition.enabledTools.includes(tool.name) ||
          snapshot.definition.modelSettings.toolChoice === "none" ||
          !completeArguments(request.call.arguments) ||
          (isHandoff(tool) && model.tools.length !== 1) ||
          (!isDelegation(tool) &&
            !isHandoff(tool) &&
            !isClientTool(tool) &&
            tool.isTerminal &&
            model.tools.length !== 1)
        )
          continue;
        if (await needsApproval(request, options, signal))
          await journalFor(snapshot, model, index, options, scope, signal).ensure({
            type: "approval",
          });
      }
    }

    async function runClient(
      model: CompletedModel,
      index: number,
      request: ToolRequest,
      client: ClientTool,
    ): Promise<void> {
      try {
        if (!completeArguments(request.call.arguments))
          throw new TypeError("Send one complete JSON object.");
        client.validateArguments(request.arguments);
      } catch (error) {
        await finishTool(model, index, request, {
          ok: false,
          kind: "invalid_input",
          content: messageOf(error),
        });
        return;
      }
      if (!host?.beforeTool)
        fail("request_host_missing", "Provide host.beforeTool before dispatching a client tool.");
      const requests = journalFor(snapshot, model, index, options, scope, signal, request);
      await requests.recheck(request);
      const record = await requests.ensure({ type: "client", resultSchema: client.resultSchema });
      if (!record.decision) return;
      if (record.decision.type === "stop") {
        scope.tree.stop();
        throw new Halt({ status: "cancelled" });
      }
      if (record.decision.type === "cancel") {
        await finishTool(model, index, request, {
          ok: false,
          kind: "cancelled",
          content:
            "The person cancelled this client request. This does not undo an action already taken.",
        });
        return;
      }
      if (record.decision.type !== "result")
        throw new TypeError("A client request needs a result.");
      await requests.recheck(request);
      active();
      const result = client.result(record.decision.value);
      await finishTool(model, index, request, { ok: true, content: result.summary });
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

      // The one extra call at the local turn limit has no tools, even if a provider ignores
      // toolChoice. Never execute calls it returns. The shared tree limit remains a hard cap.
      if (snapshot.models.indexOf(model) >= limits.turns)
        throw new Halt({ status: "limited", limit: "turns" });

      for (let index = 0; index < calls.length;) {
        if (model.tools[index]?.status === "completed") {
          index++;
          continue;
        }
        active();
        const capacity = limits.toolCalls - usedTools();
        if (
          capacity <= 0 &&
          model.tools[index]?.status === "pending" &&
          !model.tools[index]?.asks?.length
        )
          throw new Halt({ status: "limited", limit: "toolCalls" });
        let request = requestFor(snapshot, model, index);
        if (
          !snapshot.definition.enabledTools.includes(request.call.name) ||
          snapshot.definition.modelSettings.toolChoice === "none"
        ) {
          await finishTool(model, index, request, {
            ok: false,
            kind: names.includes(request.call.name) ? "disabled_tool" : "unknown_tool",
            content: "This tool is not available in this run. Choose one of the provided tools.",
          });
          index++;
          continue;
        }
        const handoff = handoffs.get(request.call.name);
        if (
          handoff &&
          !snapshot.delegations.some((entry) => entry.operationId === request.operationId)
        ) {
          let target;
          let note;
          try {
            if (calls.length !== 1)
              throw new TypeError(
                `Call ${handoff.name} alone, after the other tool results arrive.`,
              );
            if (!completeArguments(request.call.arguments))
              throw new TypeError(
                "Tool arguments must be one complete JSON object. Send the full object again.",
              );
            note = handoffNote(request.arguments);
            target = handoff.target();
            if (target.id === id)
              throw new TypeError(
                "This agent already owns the conversation. Choose a different target.",
              );
            checkHandoffTargets(agent);
          } catch (error) {
            await finishTool(model, index, request, {
              ok: false,
              kind: "invalid_input",
              content: messageOf(error),
            });
            index++;
            continue;
          }
          // Pin identity before asking for permission. A resumed lazy reference cannot turn
          // an approval for one target into a transfer to another.
          snapshot.delegations.push({
            kind: "handoff",
            operationId: request.operationId,
            target: handoffRef(target),
            ...(note !== undefined ? { note } : {}),
            children: [],
          });
          model.tools[index] = {
            id: request.operationId,
            status: "delegating",
            attemptId: snapshot.attemptId,
            interrupted: [],
          };
          await save();
          active();
        }
        const descriptor = descriptorFor(request.call.name, snapshot, request.operationId);
        const tool = registry.get(request.call.name);
        const client = clients.get(request.call.name);
        const requests = journalFor(snapshot, model, index, options, scope, signal);
        if (
          (tool || descriptor || client) &&
          completeArguments(request.call.arguments) &&
          (!tool?.isTerminal || model.tools.length === 1) &&
          (await needsApproval(request, options, signal))
        )
          await requests.ensure({ type: "approval" });
        const records = model.tools[index]?.asks ?? [];
        if (records.some((record) => !record.closed && record.decision?.type === "stop")) {
          scope.tree.stop();
          throw new Halt({ status: "cancelled" });
        }
        const decline = records.find(
          (record) =>
            !record.closed &&
            (record.decision?.type === "deny" || record.decision?.type === "cancel"),
        );
        if (decline?.decision) {
          await finishTool(
            model,
            index,
            request,
            decline.decision.type === "deny"
              ? {
                  ok: false,
                  kind: "denied",
                  content:
                    decline.decision.message ??
                    "The person denied this call. Continue without this action.",
                }
              : {
                  ok: false,
                  kind: "cancelled",
                  content: "The person cancelled this request. Continue without this action.",
                },
          );
          index++;
          continue;
        }
        if (records.some((record) => !record.closed && !record.decision)) {
          await openApprovals(model, index + 1);
          snapshot.state = { status: "suspended" };
          return;
        }
        const approval = requests.latest({ type: "approval" })?.decision;
        if (approval?.type === "approve" && approval.arguments !== undefined)
          request = { ...request, arguments: copyData(approval.arguments) };
        if (descriptor) {
          await runDelegation(model, index, request, descriptor);
          index++;
          continue;
        }
        if (client) {
          await runClient(model, index, request, client);
          if (model.tools[index]?.status !== "completed") {
            await openApprovals(model, index + 1);
            snapshot.state = { status: "suspended" };
            return;
          }
          index++;
          continue;
        }

        const batch = [{ index, request, tool }];
        const parallel = (request: ToolRequest, tool?: Tool) =>
          tool?.isConcurrencySafe === true &&
          snapshot.definition.enabledTools.includes(request.call.name) &&
          !tool.needsApproval &&
          !host?.needsApproval &&
          !model.tools.find((entry) => entry.id === request.operationId)?.asks?.length &&
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
            const nextRequest = requestFor(snapshot, model, next);
            const nextTool = registry.get(nextRequest.call.name);
            if (!parallel(nextRequest, nextTool)) break;
            batch.push({ index: next, request: nextRequest, tool: nextTool });
          }
        }
        // A checkpoint can capture the pending retry while another child saves. Check its
        // identity again before admission, even if this worker did not perform the reset.
        for (const job of batch) {
          const execution = model.tools[job.index];
          if (execution?.interrupted.length && !execution.asks?.length)
            await checkToolRecovery(model, job.index, execution.interrupted.length - 1);
        }
        active();
        // Reserve the whole admitted batch before any invocation, including its tool-call budget.
        for (const job of batch)
          model.tools[job.index] = {
            interrupted: model.tools[job.index]?.interrupted ?? [],
            asks: model.tools[job.index]?.asks,
            id: job.request.operationId,
            attemptId: snapshot.attemptId,
            status: "running",
          };
        await save();
        const settled = await Promise.allSettled(
          batch.map((job) => {
            const previous = model.tools[job.index]?.interrupted.at(-1);
            if (previous) restart("tool", job.request.operationId, previous.attemptId);
            return runTool(model, job.index, job.request, job.tool, concurrent);
          }),
        );
        const rejected = settled.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        if (batch.some((job) => model.tools[job.index]?.status === "pending")) {
          if (
            batch.some((job) =>
              model.tools[job.index]?.asks?.some((record) => !record.closed && !record.decision),
            )
          ) {
            await openApprovals(model, index + batch.length);
            snapshot.state = { status: "suspended" };
            return;
          }
          continue;
        }
        index += batch.length;
      }
      // Adapted from OpenAI Agents JS (MIT), runner/toolExecution.ts: settle this batch,
      // then select the first stopping tool in model order, not completion order.
      const final =
        finalHandoffResult(snapshot, model) ??
        finalToolResult(
          model,
          snapshot.definition.stopAtTools,
          output ? RESULT_TOOL_NAME : undefined,
        );
      if (final) snapshot.state = { status: "completed", candidate: final.candidate };
    }

    // One load per media id per attempt. The bytes live only in the requests built from it,
    // never in the journal, the outcome or an event. The per-run cache of pending loads is
    // adapted from TanStack AI (MIT), packages/ai-harness/src/media.ts.
    const media = new Map<string, Promise<string>>();
    function loadMedia(ref: MediaRef): Promise<string> {
      let loaded = media.get(ref.id);
      if (!loaded) {
        loaded = readMedia(ref);
        media.set(ref.id, loaded);
      }
      return loaded;
    }
    async function readMedia(ref: MediaRef): Promise<string> {
      const load = host?.loadMedia;
      if (!load)
        fail(
          "media_unavailable",
          "This run has media references. Provide host.loadMedia to read their bytes.",
        );
      let data: unknown;
      try {
        data = await untilAbort(
          Promise.resolve(load(immutableCopy(ref), { runId: snapshot.runId, signal })),
          signal,
        );
      } catch {
        active();
        // Loader errors can quote credentials from a header or request. Never persist them.
        fail(
          "media_unavailable",
          "The media could not be loaded. Check file access before trying again.",
        );
      }
      if (!isBase64(data))
        fail(
          "media_unavailable",
          `host.loadMedia returned no base64 bytes for media ${ref.id}. Return the bytes as padded base64 text.`,
        );
      return data;
    }

    async function nextTurn(
      previous?: Extract<ModelExecution, { status: "running" }>,
    ): Promise<CompletedModel> {
      active();
      // Hosted actions may run before any local tool call appears. Their explicit presence
      // overrides a profile's inference-only claim when an interrupted call is recovered.
      if (previous)
        requireRecovery(
          snapshot.definition.recovery?.policy.inferenceOnly === true &&
            !snapshot.definition.modelSettings.hostedTools?.length,
          previous.interrupted.length,
          snapshot.definition.recovery,
          previous.id,
        );
      const position = previous ? snapshot.models.indexOf(previous) : snapshot.models.length;
      const selected = tools.filter((tool) => snapshot.definition.enabledTools.includes(tool.name));
      if (
        previous &&
        (await requestHash(selected.map((tool) => tool.definition()))) !==
          snapshot.definition.recovery?.modelToolsHash
      )
        fail(
          "recovery_definition_changed",
          "The interrupted model call's tool definitions changed. Restore the same definitions or reconcile the run.",
          previous.id,
        );
      // Ported from Microsoft Agent Framework (MIT), _tools.py: after the iteration
      // allowance, ask once for a tool-free answer. Checked output needs submit_result,
      // so that mode retains the hard local turn cap instead of buying an unusable call.
      const finalTurn = position === limits.turns;
      if (position > limits.turns || (finalTurn && output))
        throw new Halt({ status: "limited", limit: "turns" });
      // A steer never changes the input of an already admitted call, including safe replay.
      // Check capacity before polling so a spent budget leaves delivery queued in the host.
      scope.tree.reserveModel();
      if (!previous) await acceptInputs(snapshot, scope, options, signal);
      active();
      // Media is read before the receipt below exists, so a missing loader or file fails the
      // run with no model operation left running and nothing to reconcile.
      const request = await requestOf(
        snapshot.definition.instructions,
        conversationOf(snapshot),
        loadMedia,
      );
      active();
      // The tree check and the receipt stay together, with no await between them, so two
      // children racing for the tree's last model call cannot both take it.
      scope.tree.reserveModel();
      const model: ModelExecution = {
        id: modelId(snapshot.runId, position),
        attemptId: snapshot.attemptId,
        status: "running",
        billing: "unknown",
        usage: { ...EMPTY_USAGE },
        interrupted: previous
          ? [
              ...previous.interrupted,
              { attemptId: previous.attemptId, usage: copyData(previous.usage) },
            ]
          : [],
      };
      snapshot.models[position] = model;
      await save();
      if (previous) restart("model", model.id, previous.attemptId);
      active();
      const modelSettings = copyData(snapshot.definition.modelSettings);
      // Ported from OpenAI Agents JS (MIT), runner/modelSettings.ts, maybeResetToolChoice.
      // Derive usage from the journal so resume cannot force the first tool a second time.
      const choice = modelSettings.toolChoice;
      if (
        (choice === "required" || typeof choice === "object") &&
        snapshot.models.some((model) => model.status === "completed" && model.tools.length > 0)
      )
        modelSettings.toolChoice = "auto";
      if (finalTurn) modelSettings.toolChoice = "none";
      let reportedUsage = false;
      async function* observed(): AsyncIterable<ProviderChunk> {
        const stream = provider.createStream(
          request,
          finalTurn ? [] : copyData(selected.map((tool) => tool.definition())),
          {
            ...modelSettings,
            ...(settings.onActivity ? { onActivity: settings.onActivity } : {}),
            ...(settings.onRateLimit ? { onRateLimit: settings.onRateLimit } : {}),
            ...(options.modelSettings?.onActivity
              ? { onActivity: options.modelSettings.onActivity }
              : {}),
            ...(options.modelSettings?.onRateLimit
              ? { onRateLimit: options.modelSettings.onRateLimit }
              : {}),
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
            reportedUsage = true;
            // Preserve measurements before another pull can hang or the worker can disappear.
            // This saves usage, not partial text, and does not claim final billing is known.
            await save();
            active();
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
      let collected;
      try {
        collected = await untilAbort(collectTurn(observed()), signal);
      } catch (error) {
        active();
        // Only core's classified provider failures are local model failures. Host/checkpoint
        // errors and unclassified programming errors must not become benign tool strings.
        if (!(error instanceof ProviderError)) throw error;
        if (error.kind === "aborted") {
          scope.tree.stop();
          throw new Halt({ status: "cancelled" });
        }
        fail("model_failed", `The model call failed (${error.kind}): ${error.message}`, model.id);
      }
      let turn;
      try {
        turn = readTurn(collected);
      } catch (error) {
        fail("invalid_model_output", messageOf(error), model.id);
      }
      const done: CompletedModel = {
        ...model,
        status: "completed",
        billing: reportedUsage ? "reported" : "unknown",
        usage: turn.usage,
        turn,
        tools: (turn.message.toolCalls ?? []).map((_call, index) => ({
          id: toolId(model.id, index),
          status: "pending",
          interrupted: [],
        })),
      };
      snapshot.models[position] = done;
      await save();
      for (const receipt of inputReceipts(snapshot).filter(
        (receipt) => receipt.modelId === done.id,
      ))
        emit({ type: "input", receipt });
      await acknowledgeInputs(snapshot, options, signal);
      return done;
    }

    try {
      // Repair a lost acknowledgement from the saved journal without rereading its payload.
      // Terminal snapshots synchronize too; this never starts a follow-up model call.
      if (scope.depth === 0) await acknowledgeInputs(snapshot, options, signal);
      if (scope.depth === 0 && answers) {
        await answerRequests(snapshot, options, scope, answers, signal);
        if (
          [...requestRecords(snapshot)].some(
            ({ record }) => !record.closed && record.decision?.type === "stop",
          )
        )
          scope.tree.stop();
        await save();
      }
      if (snapshot.state.status === "running" || snapshot.state.status === "suspended") {
        release = await scope.tree.gate.acquire(signal);
        active();
        const last = snapshot.models.at(-1);
        snapshot.state = { status: "running" };
        if (last?.status === "running") await handleTurn(await nextTurn(last));
        else if (last?.status === "completed") {
          await recoverTools(last);
          await handleTurn(last);
        }
        while (snapshot.state.status === "running") await handleTurn(await nextTurn());
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
    const record = recordOf(snapshot);
    const state = snapshot.state;
    if (state.status === "completed") {
      if (!completed) throw new Error("The agent completed without validating its result.");
      return { ...record, status: "completed", output: completed.output };
    }
    return state.status === "suspended"
      ? { ...record, ...state, requests: openRequests(snapshot) }
      : { ...record, ...state };
  }

  function checkInline(start: Pick<RunStart, "history" | "input">): void {
    const bytes = inlineBytes(start.history, start.input);
    if (bytes > limits.inlineBytes)
      throw new TypeError(
        `The inline images and files come to ${bytes} bytes, and this agent accepts ${limits.inlineBytes}. Send large files as media references, or raise limits.inlineBytes.`,
      );
  }

  function freeze(start: RunStart): RunStart {
    // Once, here: adapters repair every request again, and repair is idempotent, so the
    // bytes a provider caches never change between turns or across a resume.
    const history = repairConversation(
      start.history,
      (name) => registry.get(name)?.isReadOnly === true,
    );
    checkInline({ history, input: start.input });
    return { ...start, history };
  }

  async function create(
    start: RunStart,
    runId: string,
    tree?: RunSnapshot["tree"],
    options: RunOptions = {},
  ): Promise<RunSnapshot> {
    const frozen = freeze(start);
    const resolved = await resolveDefinition(frozen, options, runId);
    const { history, input, session } = frozen;
    const startedAt = Date.now();
    return {
      format: 3,
      agentId: id,
      version,
      runId,
      attemptId: crypto.randomUUID(),
      startedAt,
      definition: resolved,
      history: copyData(history),
      input: copyData(input),
      inputs: [],
      ...(session ? { session: copyData(session) } : {}),
      limits: copyData(limits),
      models: [],
      delegations: [],
      state: { status: "running" },
      tree: tree ? copyData(tree) : { runId, startedAt, limits: copyData(treeLimits) },
    };
  }

  const runtime: AgentRuntime<T | string> = {
    outputKind: output ? "checked" : "text",
    handoffs: [...handoffs.values()],
    execute,
    answerRequests,
    freeze,
    create,
    async open(input, options, runId) {
      // Everything before the snapshot exists runs outside the journal: a paid summarizer in
      // prepareHistory can run again if the process dies before the first checkpoint.
      const signal = options.signal ?? new AbortController().signal;
      const session = options.session;
      let start: RunStart;
      if (session) {
        if (isRecord(input) && "messages" in input)
          throw new TypeError(
            "With a session, pass only the new turn. The session holds the history.",
          );
        // Checked before the load, so a turn that would be refused costs no read.
        const turn = readInput(input, "caller").input;
        checkInline({ history: [], input: turn });
        const loaded: unknown = await untilAbort(
          Promise.resolve(
            session.load({
              ...(options.historyLimit !== undefined ? { limit: options.historyLimit } : {}),
              signal,
            }),
          ),
          signal,
        );
        if (!isRecord(loaded) || !isRevision(loaded.revision))
          throw new TypeError("session.load must return { messages, revision }.");
        start = {
          history: readStored(loaded.messages, "session.load"),
          input: turn,
          session: { id: session.id, revision: loaded.revision },
        };
      } else {
        if (options.historyLimit !== undefined)
          throw new TypeError(
            "historyLimit applies to a session. Trim the messages you pass in yourself.",
          );
        start = readInput(input, "caller");
      }
      if (options.prepareHistory) {
        const prepared: unknown = await untilAbort(
          Promise.resolve(options.prepareHistory(copyData(start.history))),
          signal,
        );
        start = { ...start, history: readStored(prepared, "prepareHistory") };
      }
      return create(start, runId, undefined, options);
    },
    restore(raw, tree) {
      const snapshot = readSnapshot(
        raw,
        id,
        version,
        limits,
        output ? RESULT_TOOL_NAME : undefined,
      );
      checkNames(snapshot.definition.enabledTools);
      if (
        !equalData(snapshot.definition.recovery?.policy ?? null, recovery) ||
        (snapshot.definition.recovery &&
          !equalData(snapshot.definition.recovery.provider, {
            id: provider.id,
            model: provider.model,
          }))
      )
        throw new TypeError(
          "The recorded recovery policy or provider identity changed. Restore the same profile or reconcile the run.",
        );
      if (
        !equalData(snapshot.definition.stopAtTools, stopAtTools) ||
        (output && !snapshot.definition.enabledTools.includes(RESULT_TOOL_NAME))
      )
        throw new TypeError("The recorded tool behavior does not match this agent version.");
      const choice = snapshot.definition.modelSettings.toolChoice;
      if (
        (output && choice === "none") ||
        (choice === "required" && snapshot.definition.enabledTools.length === 0) ||
        (typeof choice === "object" && !snapshot.definition.enabledTools.includes(choice.name))
      )
        throw new TypeError("The recorded tool choice does not name an enabled tool.");
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
          const descriptor =
            call &&
            snapshot.definition.enabledTools.includes(call.name) &&
            snapshot.definition.modelSettings.toolChoice !== "none" &&
            descriptorFor(call.name, snapshot, tool.id);
          const journal = snapshot.delegations.find((entry) => entry.operationId === tool.id);
          if (descriptor && tool.status !== "pending") {
            if (!journal || tool.status === "running")
              throw new TypeError(
                "A delegation needs its own child journal, not an ordinary effect marker.",
              );
          } else if (journal)
            throw new TypeError("The saved delegation is not in this agent definition.");
          if (!journal || !descriptor) continue;
          if (journal.kind !== (call && handoffs.has(call.name) ? "handoff" : "delegation"))
            throw new TypeError("The saved delegation kind does not match its registered tool.");
          if (journal.kind === "handoff") checkHandoffTargets(agent);
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
      const record = recordOf(snapshot);
      const state = record.snapshot.state;
      if (state.status === "running") throw new Error("A child has not settled yet.");
      return state.status === "completed"
        ? { ...record, status: "completed", output: validateResult(state.candidate) }
        : state.status === "suspended"
          ? { ...record, ...state, requests: openRequests(snapshot) }
          : { ...record, ...state };
    },
  };

  /** Once per root, after its final checkpoint. Never changes the run's own status. */
  async function appendTurn(
    outcome: RunOutcome<T | string>,
    options: RunOptions,
    tree: ExecutionTree,
  ): Promise<SessionStatus | undefined> {
    const ref = outcome.snapshot.session;
    if (!ref) return undefined;
    const session = options.session;
    // A waiting run has no settled turn yet. After a failed checkpoint the host's journal is
    // behind this outcome: resuming what it saved settles again and appends then.
    if (!session || outcome.status === "suspended" || tree.checkpointFailed)
      return { id: ref.id, status: "pending" };
    // A Stop ends the run, not the record of it: the turn the person sent is still saved.
    const signal =
      options.signal && !options.signal.aborted ? options.signal : new AbortController().signal;
    try {
      const saved: unknown = await untilAbort(
        Promise.resolve(
          session.append(
            immutableCopy({
              runId: outcome.runId,
              after: ref.revision,
              messages: outcome.newMessages,
            }),
            { signal },
          ),
        ),
        signal,
      );
      if (!isRecord(saved) || !isId(saved.revision))
        throw new TypeError("session.append returned no revision.");
      return { id: ref.id, status: "saved", revision: saved.revision };
    } catch (error) {
      // By name, not instanceof: a store built against another copy of this package throws
      // its own SessionConflictError class.
      const conflict = error instanceof Error && error.name === "SessionConflictError";
      return {
        id: ref.id,
        status: "unsaved",
        error: conflict
          ? {
              code: "session_conflict",
              message:
                "The conversation changed after this run loaded it. Load it again before you continue it.",
            }
          : {
              code: "session_failed",
              message: `The session did not save this turn: ${messageOf(error)}`,
            },
      };
    }
  }

  async function root(
    snapshot: RunSnapshot,
    options: RunOptions,
    answers?: Readonly<Record<string, unknown>>,
  ) {
    const tree = new ExecutionTree(snapshot, options);
    let outcome: RunOutcome<T | string>;
    try {
      outcome = await execute(snapshot, options, { tree, depth: 0, path: [] }, answers);
    } finally {
      tree.close();
    }
    const session = await appendTurn(outcome, options, tree);
    return session ? { ...outcome, session } : outcome;
  }

  const agent: Agent<T | string> = {
    id,
    version,
    [AGENT_RUNTIME]: runtime,
    asTool(options) {
      return specialistTool(agent, options);
    },
    async run(input, options = {}) {
      checkOptions(options);
      return root(
        await runtime.open(input, options, options.runId ?? crypto.randomUUID()),
        options,
      );
    },
    async resume(raw, options) {
      checkOptions(options, "resume");
      const snapshot = runtime.restore(raw);
      if (options.session && options.session.id !== snapshot.session?.id)
        throw new TypeError(
          snapshot.session
            ? "This run belongs to another session."
            : "This run has no session. Resume it without one.",
        );
      const answers = readAnswers(snapshot, options.answers ?? {});
      await authorizeTree(snapshot, options.host);
      snapshot.attemptId = crypto.randomUUID();
      return root(snapshot, options, answers);
    },
  };
  return Object.freeze(agent);
}
