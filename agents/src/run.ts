import {
  EMPTY_USAGE,
  ProviderError,
  ToolRegistry,
  collectTurn,
  createGate,
  defineTool,
  messageOf,
  parseToolArgs,
  type Provider,
  type ProviderChunk,
  type TokenUsage,
  type Tool,
} from "@providerkit/core";
import {
  bindMemoryTool,
  checkMemoryBinding,
  isMemoryTool,
  memoryPolicy,
  memoryScopes,
  MEMORY_TOOL_NAMES,
  readMemoryBinding,
  recallMemory,
  withMemoryRecall,
} from "./memory.ts";
import {
  allModels,
  compactionDefinition,
  compactionId,
  compactionPlan,
  modelConversation,
} from "./compaction.ts";
import {
  bindSubagentTool,
  checkSubagentChildren,
  subagentInstructions,
  subagentLimits,
  type SubagentCreation,
} from "./subagents.ts";
import {
  isCodeTool,
  programJson,
  programReceipt,
  programReply,
  textBytes,
  type CodeTool,
} from "./code.ts";
import { checkRetryTool, readToolRetryPolicy, retryBudget, toolAttempts } from "./tool-retry.ts";
import {
  GuardChecks,
  GUARDED_CHUNK_LIMIT,
  guardDefinition,
  guardedChunk,
  jsonBytes,
  observeLifecycle,
  refuseGuardedReplay,
  requireGuardVerdicts,
  successfulToolResult,
  toolResultOf,
} from "./extensions.ts";
import {
  AGENT_RUNTIME,
  executeDelegation,
  isDelegation,
  specialistTool,
  runtimeOf,
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
  type Handoff,
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
import { readInput, readStored, repairConversation, requestOf } from "./input.ts";
import {
  ExecutionTree,
  Halt,
  authorizeTree,
  checkPricing,
  emitEvent,
  fail,
  requirePricing,
  treeUsage,
  nodeId,
  wakeAt,
  openRequests,
  readAnswers,
  requestRecords,
  stopRequests,
  untilAbort,
  type ExecutionScope,
} from "./tree.ts";
import {
  checkOptions,
  agentSnapshot,
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
  jsonArguments,
  modelId,
  recordCodeTools,
  readLimits,
  readModelSettings,
  readTreeLimits,
  readSnapshot,
  readTurn,
  snapshotInlineBytes,
  toolId,
} from "./snapshot.ts";
import type {
  Agent,
  AgentConfig,
  AgentDefinition,
  AgentEvent,
  CompactionExecution,
  EnabledTools,
  LifecycleContext,
  LifecycleEvent,
  ModelInput,
  MediaRef,
  ModelExecution,
  OperationReceipt,
  ProgramCall,
  ToolExecution,
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

/** The same dispatcher writes either a model tool slot or an inner program call. */
interface ToolSlot {
  get(): ToolExecution;
  set(execution: ToolExecution): void;
  request(): ToolRequest;
  model?: CompletedModel;
  inner?: {
    signal: AbortSignal;
    code: CodeTool;
    start(): void;
    record(result: ToolResult): ToolResult;
    callsLeft(): number;
    outputError?: string;
  };
}

function recordOf(snapshot: RunSnapshot) {
  const saved = copyData(snapshot);
  const receipts: OperationReceipt[] = [];
  const usage = modelsUsage(allModels(saved));
  for (const model of allModels(saved)) {
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
      ...(saved.compactions.some((entry) => entry.id === model.id)
        ? { purpose: "compaction" as const }
        : {}),
      id: model.id,
      attemptId: model.attemptId,
      status: model.status,
      billing: model.billing,
      usage: model.usage,
      ...(model.costUsd !== undefined ? { costUsd: model.costUsd } : {}),
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
      for (const attempt of tool.retries)
        receipts.push({
          kind: "tool",
          id: tool.id,
          callId: call.id,
          attemptId: attempt.attemptId,
          result: attempt.result,
          status: "completed",
        });
      for (const inner of tool.calls ?? []) {
        for (const attempt of inner.retries)
          receipts.push({
            kind: "tool",
            id: inner.id,
            parentOperationId: tool.id,
            callId: inner.id,
            attemptId: attempt.attemptId,
            status: "completed",
            result: attempt.result,
          });
        if (inner.status !== "pending")
          receipts.push({
            kind: "tool",
            id: inner.id,
            parentOperationId: tool.id,
            callId: inner.id,
            attemptId: inner.attemptId,
            status: inner.status,
            ...(inner.status === "completed" ? { result: inner.result } : {}),
          });
      }
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

// Adapted from OpenAI Agents JS (MIT), agent.ts: infer every registered handoff's output.
// Ordinary tools contribute nothing; each runtime still validates only its own contract.
type RegisteredTools = NonNullable<AgentConfig["tools"]>;
type HandoffOutput<Tool> = Tool extends Handoff<infer Output> ? Output : never;
type ConfigWithTools<Tools extends RegisteredTools> = Omit<AgentConfig, "tools"> & {
  tools?: Tools;
};

export function defineAgent<T, const Tools extends RegisteredTools = []>(
  definition: ConfigWithTools<Tools> & { output: ResultSchema<T> },
): Agent<T | HandoffOutput<Tools[number]>>;
export function defineAgent<const Tools extends RegisteredTools = []>(
  definition: ConfigWithTools<Tools> & { output?: undefined },
): Agent<string | HandoffOutput<Tools[number]>>;
export function defineAgent<T, const Tools extends RegisteredTools = []>(
  definition: ConfigWithTools<Tools> & { output?: ResultSchema<T> },
): Agent<T | string | HandoffOutput<Tools[number]>>;
export function defineAgent<T, H>(definition: AgentDefinition<T, H>): Agent<T | string | H> {
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
  const memory = memoryPolicy(definition.memory);
  const compaction = compactionDefinition(definition.compaction);
  const summarizer = definition.compaction?.summarize?.provider;
  const toolRetries = readToolRetryPolicy(definition.toolRetries);
  const guardPolicy = guardDefinition(definition.guardrails);
  const guardrails = definition.guardrails && Object.freeze({ ...definition.guardrails });
  const onLifecycle = definition.onLifecycle;
  if (onLifecycle !== undefined && typeof onLifecycle !== "function")
    throw new TypeError("onLifecycle must be a function.");
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
  const registeredTools = [...(definition.tools ?? [])];
  const codeTools = new Map(registeredTools.filter(isCodeTool).map((tool) => [tool.name, tool]));
  // Keep capability identity for helper grants; approval/dispatch use the bound tools below.
  const capabilities = new Map(registeredTools.map((tool) => [tool.name, tool]));
  for (const code of codeTools.values())
    for (const tool of code.tools) {
      if (capabilities.has(tool.name) && capabilities.get(tool.name) !== tool)
        throw new TypeError(
          `The name ${tool.name} must refer to the same tool object directly and in every code binding.`,
        );
      capabilities.set(tool.name, tool);
    }
  const needsMemory = !!memory || [...capabilities.values()].some(isMemoryTool);
  if (
    [...capabilities.values()].some(
      (tool) => MEMORY_TOOL_NAMES.includes(tool.name) && !isMemoryTool(tool),
    )
  )
    throw new TypeError(
      "memory_search, memory_save and memory_forget are reserved. Register tools from memoryTools().",
    );
  const tools = registeredTools.map((tool) =>
    isDelegation(tool) ? bindSubagentTool(tool, () => agent) : tool,
  );
  if (
    new Set(tools.map((tool) => tool.name)).size !== tools.length ||
    [...capabilities.values()].some((tool) => !isId(tool.name) || tool.name === RESULT_TOOL_NAME)
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
    if (!tool || isDelegation(tool) || isHandoff(tool) || isClientTool(tool) || isCodeTool(tool))
      throw new TypeError("stopAtTools must name ordinary tools registered on this agent.");
  }
  for (const tool of tools)
    if (
      !isDelegation(tool) &&
      !isHandoff(tool) &&
      !isClientTool(tool) &&
      !isCodeTool(tool) &&
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
  if (
    [...codeTools.values()].some((code) =>
      code.tools.some((tool) => stopAtTools.includes(tool.name)),
    )
  )
    throw new TypeError("Stopping tools must stay direct, outside code mode.");
  const registry = new ToolRegistry(
    [...new Set([...tools, ...capabilities.values()])].filter(
      (tool): tool is Tool =>
        !isDelegation(tool) && !isHandoff(tool) && !isClientTool(tool) && !isCodeTool(tool),
    ),
  );
  for (const name of recovery?.readOnlyTools ?? [])
    if ((!registry.get(name)?.isReadOnly && !codeTools.has(name)) || name === RESULT_TOOL_NAME)
      throw new TypeError(
        "Recovery readOnlyTools must name ordinary isReadOnly tools registered on this agent.",
      );
  for (const [name, policy] of Object.entries(toolRetries?.tools ?? {})) {
    const tool = registry.get(name);
    if (
      !tool ||
      tool.isTerminal ||
      tool.needsApproval ||
      stopAtTools.includes(name) ||
      (policy.replay === "read-only" && !tool.isReadOnly)
    )
      throw new TypeError(
        "toolRetries must name ordinary non-stopping tools without required approval. Read-only retries need isReadOnly.",
      );
  }
  const delegations = new Map(tools.filter(isDelegation).map((tool) => [tool.name, tool]));
  const handoffs = new Map(tools.filter(isHandoff<H>).map((tool) => [tool.name, tool]));

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
  const names = [...new Set([...capabilities.keys(), ...tools.map((tool) => tool.name)])];
  const directNames = tools.map((tool) => tool.name);
  const definitionsFor = (enabled: readonly string[]) =>
    tools
      .filter((tool) => enabled.includes(tool.name))
      .map((tool) => (isCodeTool(tool) ? tool.definition(enabled) : tool.definition()));
  async function toolHash(name: string): Promise<string> {
    const code = codeTools.get(name);
    if (code)
      return requestHash({
        definition: code.definition(),
        limits: code.limits,
        tools: await Promise.all(code.tools.map(recoveryToolHash)),
      });
    const tool = registry.get(name);
    if (!tool) throw new TypeError("Missing recovery tool.");
    return recoveryToolHash(tool);
  }
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
    source?: RunDefinition,
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
    const text: unknown = source
      ? source.instructions
      : typeof instructions === "function"
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
    const allowed = source ? source.enabledTools : await select(enabledTools);
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
      ...(source ? source.modelSettings : settings),
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
          return [name, await toolHash(name)] as const;
        }),
      ),
    );
    const retryHashes = Object.fromEntries(
      await Promise.all(
        Object.keys(toolRetries?.tools ?? {}).map(async (name) => {
          const tool = registry.get(name);
          if (!tool) throw new TypeError("Missing retry tool.");
          return [name, await recoveryToolHash(tool)] as const;
        }),
      ),
    );
    return {
      instructions: text,
      ...(memory ? { memory: copyData(memory) } : {}),
      modelSettings,
      ...(options.providerSessionId !== undefined
        ? { providerSessionId: options.providerSessionId }
        : {}),
      enabledTools: enabled,
      stopAtTools: [...stopAtTools],
      ...(codeTools.size ? { codeTools: recordCodeTools(codeTools) } : {}),
      guardrails: copyData(guardPolicy),
      compaction: copyData(compaction),
      toolRetries: toolRetries ? { policy: copyData(toolRetries), toolHashes: retryHashes } : null,
      recovery: recovery
        ? {
            policy: copyData(recovery),
            provider: { id: provider.id, model: provider.model },
            toolHashes,
            modelToolsHash: await requestHash(definitionsFor(enabled)),
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

  // Adapted from OpenAI Agents JS (MIT), result.ts: the active agent processes its own
  // final output. Follow our saved child instead of casting it to the source's output type.
  function completedOutput(snapshot: RunSnapshot): T | string | H {
    if (snapshot.state.status !== "completed")
      throw new TypeError("The run has no completed result.");
    const last = snapshot.models.at(-1);
    const transfer = last?.status === "completed" && finalHandoffResult(snapshot, last);
    if (!transfer) return validateResult(snapshot.state.candidate);
    const name = last.turn.message.toolCalls?.[0]?.name;
    const target = name && handoffs.get(name)?.target();
    if (!target || !equalData(handoffRef(target), handoffRef(transfer.child)))
      throw new TypeError("The completed handoff does not match its registered target.");
    const result = target[AGENT_RUNTIME].hydrate(transfer.child);
    if (result.status !== "completed")
      throw new TypeError("The handoff target has no completed result.");
    return result.output;
  }

  function requestFor(snapshot: RunSnapshot, model: CompletedModel, index: number): ToolRequest {
    const call = model.turn.message.toolCalls?.[index];
    const tool = model.tools[index];
    if (!call || !tool) fail("invalid_journal", "The tool call is missing from its journal.");
    return {
      agentId: id,
      version,
      runId: snapshot.runId,
      attemptId:
        tool.status === "running" || tool.status === "completed"
          ? tool.attemptId
          : tool.retries.length
            ? `${snapshot.attemptId}/tool-attempt/${tool.retries.length + tool.interrupted.length + 1}`
            : snapshot.attemptId,
      operationId: tool.id,
      ...(snapshot.subagent ? { subagent: snapshot.subagent.spec.name } : {}),
      call,
      arguments: codeTools.has(call.name)
        ? (jsonArguments(call.arguments) ?? {})
        : parseToolArgs(call.arguments),
    };
  }

  async function needsApproval(
    call: ToolRequest,
    options: RunOptions,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (call.call.name === RESULT_TOOL_NAME) return false;
    const tool =
      tools.find((tool) => tool.name === call.call.name) ?? capabilities.get(call.call.name);
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
    return requestsFor(call, execution, options, scope, signal, effectiveCall);
  }

  function requestsFor(
    call: ToolRequest,
    execution: ToolExecution,
    options: RunOptions,
    scope: ExecutionScope,
    signal: AbortSignal,
    effectiveCall?: ToolRequest,
  ): RequestJournal {
    const tool =
      tools.find((tool) => tool.name === call.call.name) ?? capabilities.get(call.call.name);
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
      !!guardrails?.toolOutput,
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
            agent.kind === child.snapshot.kind &&
            agent.id === nodeId(child.snapshot) &&
            agent.version === child.snapshot.version,
        );
        if (!specialist) throw new TypeError("Unregistered specialist.");
        await runtimeOf(specialist).answerRequests(
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
  ): Promise<RunOutcome<T | string | H>> {
    const host = options.host;
    const limits = snapshot.limits;
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
    let completed: { output: T | string | H } | undefined;
    let started = false;

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

    /** The host's USD for measured usage, saved with the receipt and never asked again. */
    function priceOf(
      usage: TokenUsage,
      served: { provider: string; model: string },
      operationId: string,
    ): number | undefined {
      if (!host?.priceModelCall) return undefined;
      const cost = host.priceModelCall(immutableCopy({ usage, ...served }));
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
        fail(
          "invalid_cost",
          "The host priced a model call at an invalid amount. Return a finite USD amount of 0 or more.",
          operationId,
        );
      return cost;
    }
    const callbackContext: LifecycleContext = Object.freeze({
      agentId: id,
      version,
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      context: Object.freeze({ ...options.context }),
      signal,
    });
    const observe = (event: LifecycleEvent, callSignal = signal) =>
      observeLifecycle(
        [onLifecycle, options.onLifecycle],
        event,
        callSignal === signal ? callbackContext : { ...callbackContext, signal: callSignal },
      );
    const guards = new GuardChecks(snapshot, guardrails, callbackContext, save, active);

    function slotFor(model: CompletedModel, index: number): ToolSlot {
      return {
        model,
        get() {
          const execution = model.tools[index];
          if (!execution) fail("invalid_journal", "The tool call is missing from its journal.");
          return execution;
        },
        set(execution) {
          model.tools[index] = execution;
        },
        request: () => requestFor(snapshot, model, index),
      };
    }

    function invocationActive(slot: ToolSlot): void {
      active();
      slot.inner?.signal.throwIfAborted();
    }

    function toolChecks(callSignal: AbortSignal): GuardChecks {
      return callSignal === signal
        ? guards
        : new GuardChecks(
            snapshot,
            guardrails,
            { ...callbackContext, signal: callSignal },
            save,
            () => {
              active();
              callSignal.throwIfAborted();
            },
          );
    }

    async function beforeTool(request: ToolRequest, callSignal = signal): Promise<void> {
      await toolChecks(callSignal).check(
        "toolInput",
        request.operationId,
        request.attemptId,
        request,
      );
      active();
      callSignal.throwIfAborted();
      await observe({ type: "tool_start", request }, callSignal);
      active();
      callSignal.throwIfAborted();
    }

    async function withToolError(
      request: ToolRequest,
      work: () => Promise<void>,
      callSignal = signal,
    ): Promise<void> {
      try {
        await work();
      } catch (error) {
        await observe({ type: "tool_error", request }, callSignal);
        throw error;
      }
    }

    function restart(
      kind: "model" | "tool",
      operationId: string,
      previousAttemptId: string,
      attemptId = snapshot.attemptId,
    ): void {
      // Adapted from Vercel AI SDK (Apache-2.0), workflow/do-stream-step.ts: reset the
      // current display before replacement output. Unlike reset-step, identity stays explicit.
      emit({
        type: "operation_restart",
        kind,
        runId: snapshot.runId,
        operationId,
        previousAttemptId,
        attemptId,
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
      const budget = retryBudget(snapshot.definition.toolRetries, request.call.name);
      if (budget && previous + 1 >= budget.maxAttempts)
        fail(
          "tool_retry_exhausted",
          "This call reached its tool attempt limit. Reconcile the saved attempts with the host.",
          execution.id,
        );
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
        const code = codeTools.get(model.turn.message.toolCalls?.[index]?.name ?? "");
        if (code) {
          const calls = execution.calls ?? [];
          const unknown = calls.find(
            (call) => call.status === "running" && !registry.get(call.name)?.isReadOnly,
          );
          if (unknown)
            fail(
              "interrupted_operation",
              "This inner call started but has no saved result. Reconcile its effect with the host; the program will not replay it.",
              unknown.id,
            );
          refuseGuardedReplay(snapshot, execution.id, execution.attemptId);
          const restartable =
            calls.every((call) => registry.get(call.name)?.isReadOnly && !call.asks?.length) &&
            !execution.asks?.length &&
            snapshot.definition.recovery?.policy.readOnlyTools?.includes(code.name) &&
            !!host?.beforeTool &&
            toolAttempts(execution) < (snapshot.definition.recovery?.policy.maxAttempts ?? 0);
          for (const [position, call] of calls.entries()) {
            if (call.status === "completed") continue;
            calls[position] = {
              ...call,
              status: "completed",
              result: {
                ok: false,
                kind: "interrupted",
                content: call.started
                  ? "This read stopped before its result was saved. It changed nothing."
                  : "This call did not start. It changed nothing.",
              },
            };
          }
          if (restartable) {
            if ((await toolHash(code.name)) !== snapshot.definition.recovery?.toolHashes[code.name])
              fail(
                "recovery_definition_changed",
                "The code tool's bindings or limits changed. Restore the saved definition before restarting.",
                execution.id,
              );
            model.tools[index] = {
              id: execution.id,
              status: "pending",
              previousAttemptId: execution.attemptId,
              interrupted: [...execution.interrupted, { attemptId: execution.attemptId }],
              retries: execution.retries,
              calls,
            };
            await save();
          } else
            await finishTool(model, index, requestFor(snapshot, model, index), code.close(calls));
          continue;
        }
        refuseGuardedReplay(snapshot, execution.id, execution.attemptId);
        await checkToolRecovery(
          model,
          index,
          execution.interrupted.length + execution.retries.length,
        );
        model.tools[index] = {
          id: execution.id,
          status: "pending",
          previousAttemptId: execution.attemptId,
          retries: execution.retries,
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
                  toolAttempts(tool) +
                  (tool.calls ?? []).reduce(
                    (innerTotal, call) => innerTotal + 1 + call.retries.length,
                    0,
                  ),
                0,
              )
            : 0),
        0,
      );
    }

    async function checkToolRetry(slot: ToolSlot): Promise<void> {
      const execution = slot.get();
      const recorded = snapshot.definition.toolRetries;
      if (!recorded) fail("invalid_journal", "Missing tool retry policy.");
      const request = slot.request();
      await checkRetryTool(registry.get(request.call.name), recorded, execution);
      if (
        !host?.beforeTool ||
        (await needsApproval(request, options, slot.inner?.signal ?? signal))
      )
        fail(
          "tool_retry_unsafe",
          "A retry needs current host authorization and cannot reuse or open an approval.",
          execution.id,
        );
      invocationActive(slot);
    }

    async function retryTool(slot: ToolSlot): Promise<boolean> {
      const execution = slot.get();
      if (
        execution.status !== "completed" ||
        execution.result.ok ||
        execution.asks?.length ||
        !["failed", "timeout"].includes(execution.result.kind)
      )
        return false;
      const request = slot.request();
      const policy = retryBudget(snapshot.definition.toolRetries, request.call.name);
      const recoveryCeiling = execution.interrupted.length
        ? snapshot.definition.recovery?.policy.maxAttempts
        : undefined;
      if (
        !policy ||
        toolAttempts(execution) >=
          Math.min(policy.maxAttempts, recoveryCeiling ?? policy.maxAttempts)
      )
        return false;
      invocationActive(slot);
      if (slot.inner && slot.inner.callsLeft() <= 0) return false;
      if (usedTools() >= limits.toolCalls) {
        throw new Halt({ status: "limited", limit: "toolCalls" });
      }
      await checkToolRetry(slot);
      let reconciliation: string | undefined;
      if (policy.replay === "reconcile") {
        const reconcile = host?.reconcileToolRetry;
        if (!reconcile)
          fail(
            "tool_retry_unsafe",
            "This failed call needs host reconciliation before it can be repeated.",
            execution.id,
          );
        const verdict = await untilAbort(
          Promise.resolve(
            reconcile(immutableCopy({ request, result: execution.result }), callbackContext),
          ),
          slot.inner?.signal ?? signal,
        );
        invocationActive(slot);
        if (verdict?.outcome !== "not_run" || !isId(verdict.receipt))
          fail(
            "tool_retry_unsafe",
            "The host could not confirm that the failed call did not run. Reconcile its effect before continuing.",
            execution.id,
          );
        reconciliation = verdict.receipt;
      }
      // Guest calls can reserve the remaining budget while host reconciliation is awaited.
      invocationActive(slot);
      if (slot.inner && slot.inner.callsLeft() <= 0) return false;
      slot.set({
        id: execution.id,
        status: "pending",
        previousAttemptId: execution.attemptId,
        interrupted: execution.interrupted,
        retries: [
          ...execution.retries,
          {
            attemptId: execution.attemptId,
            arguments: copyData(request.arguments),
            result: execution.result,
            ...(reconciliation ? { reconciliation } : {}),
          },
        ],
      });
      // Retain the failure and reconciliation before reserving another attempt.
      await save();
      return true;
    }

    async function finishTool(
      model: CompletedModel,
      index: number,
      request: ToolRequest,
      result: ToolResult,
    ): Promise<void> {
      return finishExecution(slotFor(model, index), request, result);
    }

    async function finishExecution(
      slot: ToolSlot,
      request: ToolRequest,
      result: ToolResult,
    ): Promise<void> {
      if (!result.ok && (result.kind === "cancelled" || result.kind === "denied")) {
        for (const record of slot.get().asks ?? [])
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
      const edited = slot
        .get()
        .asks?.some(
          (record) =>
            !record.closed &&
            record.decision?.type === "approve" &&
            record.decision.arguments !== undefined,
        );
      if (edited && !codeTools.has(request.call.name))
        result = {
          ...result,
          content: `${result.content}\nThe reviewer replaced the tool arguments before this call.`,
        };
      const callSignal = slot.inner?.signal ?? signal;
      const checks = toolChecks(callSignal);
      await observe({ type: "tool_end", request, result }, callSignal);
      invocationActive(slot);
      if (
        guardPolicy?.stages.includes("toolOutput") &&
        jsonBytes(result) > guardPolicy.maxOutputBytes
      )
        await checks.overflow("toolOutput", request.operationId, request.attemptId);
      await checks.check("toolOutput", request.operationId, request.attemptId, {
        request,
        result,
      });
      invocationActive(slot);
      // Check after callbacks: another concurrent result may have consumed the remaining bytes.
      if (
        result.ok &&
        result.images &&
        snapshotInlineBytes(snapshot) +
          inlineBytes(
            [
              {
                role: "tool",
                name: request.call.name,
                toolCallId: request.call.id,
                content: result.content,
                images: result.images,
              },
            ],
            "",
          ) >
          limits.inlineBytes
      )
        fail(
          "tool_media_limit",
          "Tool images exceed this run's inline byte limit. Return fewer or smaller images before starting new work.",
          request.operationId,
        );
      if (slot.inner) result = slot.inner.record(result);
      const previous = slot.get();
      slot.set({
        interrupted: previous.interrupted,
        retries: previous.retries,
        asks: previous.asks,
        calls: previous.calls,
        id: request.operationId,
        attemptId: request.attemptId,
        status: "completed",
        result,
      });
      await save();
      emit({ type: "tool_result", request, result });
    }

    async function runTool(
      slot: ToolSlot,
      request: ToolRequest,
      tool: Tool | undefined,
      parallel: boolean,
    ): Promise<void> {
      invocationActive(slot);
      const callSignal = slot.inner?.signal ?? signal;
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
      } else if (tool.isTerminal && slot.model?.tools.length !== 1) {
        result = {
          ok: false,
          kind: "invalid_input",
          content: `Call ${tool.name} alone, after the other tool results arrive.`,
        };
      } else {
        // The barrier can return on abort before its callback unwinds. Retain that callback
        // so a program cannot finish while a late guard or tool can still write a receipt.
        let dispatch: Promise<Awaited<ReturnType<Tool["invoke"]>>> | undefined;
        async function invoke() {
          invocationActive(slot);
          const journal = requestsFor(slot.request(), slot.get(), options, scope, callSignal);
          try {
            await beforeTool(request, callSignal);
            if (slot.get().retries.length) await checkToolRetry(slot);
            await journal.recheck(request);
            invocationActive(slot);
            if (slot.inner) {
              slot.inner.start();
              if (!tool?.isReadOnly) await save();
              invocationActive(slot);
              await journal.recheck(request);
              invocationActive(slot);
            }
            emit({ type: "tool_start", request });
            invocationActive(slot);
            // Observers and checkpoints can expire an approval or revoke ownership.
            // Reauthorize after them, with no further callback before the actual invocation.
            await journal.recheck(request);
            await journal.assertFresh();
            invocationActive(slot);
          } catch (error) {
            if (!slot.inner && error instanceof Halt && error.state.status === "suspended")
              slot.set({
                id: request.operationId,
                status: "pending",
                interrupted: slot.get().interrupted,
                retries: slot.get().retries,
                asks: slot.get().asks,
              });
            throw error;
          }
          const records = slot.get().asks ?? [];
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
          if (!tool) throw new TypeError("Missing dispatched tool.");
          return untilAbort(
            bindMemoryTool(tool, options.memory, snapshot, request).invoke(
              copyData(request.arguments),
              {
                ...options.context,
                answers: immutableCopy(answers),
                decision: immutableCopy(decision),
                runId: snapshot.runId,
                attemptId: request.attemptId,
                operationId: request.operationId,
                parentOperationId: request.parentOperationId,
                callId: request.call.id,
                signal: callSignal,
              },
            ),
            callSignal,
          );
        }
        let outcome;
        try {
          outcome = await scope.tree.invokeTool(parallel, callSignal, () => {
            dispatch = invoke();
            return dispatch;
          });
        } catch (error) {
          if (slot.inner && dispatch) await dispatch.catch(() => {});
          throw error;
        }
        // Run/tree stops never buy another model turn. Program-only abort is settled below.
        if (!outcome.ok) active();
        if (
          !outcome.ok &&
          isMemoryTool(tool) &&
          outcome.cause instanceof Error &&
          outcome.cause.name === "MemoryScopeError"
        )
          fail(
            "memory_scope_violation",
            "Memory returned another scope's data. Fix the store before continuing.",
            request.operationId,
          );
        if (!outcome.ok && outcome.kind === "failed" && isInputRequired(outcome.cause)) {
          if (slot.inner) {
            result = {
              ok: false,
              kind: "denied",
              content: `This call needs a person's answer, and code cannot wait for one.${directNames.includes(tool.name) ? ` Call ${tool.name} directly.` : " Ask the host to provide a direct tool."}`,
            };
            await finishExecution(slot, request, result);
            return;
          }
          if (slot.get().retries.length)
            fail(
              "tool_retry_unsafe",
              "A retried call requested input. Reconcile it with the host; retries cannot create request replay paths.",
              request.operationId,
            );
          slot.set({
            id: request.operationId,
            status: "pending",
            asks: slot.get().asks,
            retries: slot.get().retries,
            interrupted: slot.get().interrupted,
          });
          const journal = requestsFor(request, slot.get(), options, scope, signal);
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
        try {
          if (slot.inner && outcome.ok) {
            try {
              if (outcome.output !== undefined) programJson(outcome.output);
              result = { ok: true, content: outcome.summary, output: outcome.output };
            } catch {
              slot.inner.outputError =
                "The call ran but returned a non-JSON value. Check its effect before calling it again.";
              result = { ok: true, content: slot.inner.outputError };
            }
          } else
            result =
              tool.name === RESULT_TOOL_NAME && outcome.ok
                ? { ok: true, content: outcome.summary }
                : toolResultOf(outcome);
        } catch {
          fail(
            "invalid_tool_output",
            "The tool returned unsavable data or unsupported content. Return JSON or core text/image parts.",
            request.operationId,
          );
        }
        if (outcome.ok && tool.name === RESULT_TOOL_NAME && result.ok)
          result.final = { candidate: copyData(request.arguments) };
        if (outcome.ok && snapshot.definition.stopAtTools.includes(tool.name)) {
          try {
            const candidate = output ? copyData(outcome.output) : outcome.summary;
            validateResult(candidate);
            result = { ...result, ok: true, final: { candidate } };
          } catch (error) {
            result = {
              ok: false,
              kind: "invalid_output",
              content: `The tool result did not pass the output check: ${messageOf(error)}`,
            };
          }
        }
      }
      await finishExecution(slot, request, result);
      active();
    }

    function canParallel(
      request: ToolRequest,
      tool: Tool | undefined,
      execution: ToolExecution,
    ): boolean {
      return (
        !guardrails?.toolInput &&
        !guardrails?.toolOutput &&
        !retryBudget(snapshot.definition.toolRetries, request.call.name) &&
        tool?.isConcurrencySafe === true &&
        snapshot.definition.enabledTools.includes(tool.name) &&
        (request.parentOperationId !== undefined || directNames.includes(tool.name)) &&
        !tool.needsApproval &&
        !host?.needsApproval &&
        !execution.asks?.length &&
        !tool.isTerminal &&
        host?.canRunConcurrently?.(immutableCopy(request)) === true
      );
    }

    async function runProgram(
      model: CompletedModel,
      index: number,
      request: ToolRequest,
      code: CodeTool,
    ): Promise<void> {
      const slot = slotFor(model, index);
      const previous = slot.get();
      if (previous.interrupted.length) {
        requireRecovery(
          snapshot.definition.recovery?.policy.readOnlyTools?.includes(code.name) === true &&
            !!host?.beforeTool &&
            !previous.asks?.length &&
            (previous.calls ?? []).every(
              (call) =>
                call.status === "completed" &&
                registry.get(call.name)?.isReadOnly &&
                !call.asks?.length,
            ),
          previous.interrupted.length - 1,
          snapshot.definition.recovery,
          previous.id,
        );
        if ((await toolHash(code.name)) !== snapshot.definition.recovery?.toolHashes[code.name])
          fail(
            "recovery_definition_changed",
            "The code bindings changed. Restore the saved definition before restarting.",
            previous.id,
          );
      }
      const calls = previous.calls ?? [];
      slot.set({
        id: request.operationId,
        attemptId: request.attemptId,
        status: "running",
        calls,
        asks: previous.asks,
        interrupted: previous.interrupted,
        retries: previous.retries,
      });
      await save();
      const requests = journalFor(snapshot, model, index, options, scope, signal);
      try {
        await beforeTool(request);
        await requests.recheck(request);
        active();
        if (previous.status === "pending" && previous.previousAttemptId)
          restart("tool", request.operationId, previous.previousAttemptId, request.attemptId);
        emit({ type: "tool_start", request });
        await requests.recheck(request);
        await requests.assertFresh();
        active();
      } catch (error) {
        if (error instanceof Halt && error.state.status === "suspended")
          slot.set({ ...previous, asks: slot.get().asks });
        throw error;
      }
      const end = new AbortController();
      const programSignal = AbortSignal.any([signal, end.signal]);
      const programDeadline = Math.min(
        Date.now() + code.limits.timeoutMs,
        deadline,
        snapshot.tree.startedAt + snapshot.tree.limits.elapsedMs,
      );
      const timer = setTimeout(
        () => end.abort(new Error("The program reached its time limit.")),
        Math.max(0, programDeadline - Date.now()),
      );
      const enabled = code.tools.filter((tool) =>
        snapshot.definition.enabledTools.includes(tool.name),
      );
      const gate = createGate(limits.parallelTools);
      const jobs: Promise<string>[] = [];
      let barrier = Promise.resolve();
      let settled = Promise.resolve();
      let fatal: unknown;
      let closed = false;
      const reject = (kind: string, message: string) =>
        JSON.stringify({ ok: false, error: { kind, message } });
      const stopped = (call: ProgramCall): ToolResult => ({
        ok: false,
        kind: "aborted",
        content: call.started
          ? "The program stopped. This call may have partly run. Check its effect before repeating it."
          : "The program stopped before this call started. It did not run.",
      });
      const count = () =>
        calls
          .filter((call) => call.programAttemptId === request.attemptId)
          .reduce((total, call) => total + 1 + call.retries.length, 0);
      const bridge = {
        tools: enabled,
        signal: programSignal,
        deadline: programDeadline,
        calls,
        toolCallsLeft: () =>
          Math.max(0, Math.min(code.limits.calls - count(), limits.toolCalls - usedTools() - 1)),
        call(name: string, input: string): Promise<string> {
          if (closed || programSignal.aborted)
            return Promise.resolve(
              reject("aborted", "The program has finished. No more calls can start."),
            );
          const tool = enabled.find((tool) => tool.name === name);
          if (!tool)
            return Promise.resolve(
              reject("disabled_tool", "This tool is not bound and enabled for this program."),
            );
          if (tool.needsApproval || tool.isTerminal)
            return Promise.resolve(
              reject("denied", "This control tool must be called directly, outside code."),
            );
          const arguments_ =
            typeof input === "string" && textBytes(input) <= code.limits.callInputBytes
              ? jsonArguments(input)
              : undefined;
          if (!arguments_)
            return Promise.resolve(
              reject(
                "invalid_input",
                `Pass one JSON object within ${code.limits.callInputBytes} bytes.`,
              ),
            );
          if (bridge.toolCallsLeft() === 0)
            return Promise.resolve(
              reject(
                "denied",
                "The program has no tool calls left. Return what you have; the final direct call is reserved.",
              ),
            );
          // Admission and budget reservation are synchronous. Promise.all cannot overspend.
          const position = calls.length;
          const operationId = `${request.operationId}/call/${position + 1}`;
          let call: ProgramCall = {
            id: operationId,
            attemptId: request.attemptId,
            programAttemptId: request.attemptId,
            name,
            arguments: arguments_,
            status: "pending",
            started: false,
            interrupted: [],
            retries: [],
          };
          calls.push(call);
          let reply = reject("aborted", "The call did not finish.");
          const inner: ToolSlot = {
            get: () => call,
            set(execution) {
              if (execution.status === "delegating" || execution.calls !== undefined)
                throw new TypeError("A program may only call ordinary tools.");
              call = {
                ...execution,
                name,
                arguments: arguments_,
                programAttemptId: request.attemptId,
                attemptId:
                  execution.status === "pending"
                    ? `${request.attemptId}/call/${position + 1}/attempt/${execution.retries.length + 1}`
                    : execution.attemptId,
                started: call.started,
                bytes: execution.status === "pending" ? undefined : call.bytes,
              };
              calls[position] = call;
            },
            request: () => ({
              agentId: id,
              version,
              runId: snapshot.runId,
              attemptId:
                call.status === "pending" && call.retries.length
                  ? `${request.attemptId}/call/${position + 1}/attempt/${call.retries.length + 1}`
                  : call.attemptId,
              operationId,
              parentOperationId: request.operationId,
              ...(snapshot.subagent ? { subagent: snapshot.subagent.spec.name } : {}),
              call: { id: operationId, name, arguments: input },
              arguments: copyData(arguments_),
            }),
            inner: {
              signal: programSignal,
              code,
              callsLeft: () => bridge.toolCallsLeft(),
              start() {
                call = {
                  id: call.id,
                  name,
                  arguments: arguments_,
                  programAttemptId: request.attemptId,
                  interrupted: call.interrupted,
                  retries: call.retries,
                  asks: call.asks,
                  status: "running",
                  attemptId: inner.request().attemptId,
                  started: true,
                };
                calls[position] = call;
              },
              record(result) {
                const receipt = programReceipt(result);
                call.bytes = receipt.bytes;
                reply = inner.inner?.outputError
                  ? reject("invalid_output", inner.inner.outputError)
                  : programReply(result, code.limits.callOutputBytes);
                return receipt.result;
              },
            },
          };
          let concurrent = false;
          const work = (async () => {
            let releaseCall = () => {};
            try {
              // Synchronous admission is host work too: a throw must settle its pending call.
              concurrent = canParallel(inner.request(), tool, call);
              await (concurrent ? barrier : settled);
              releaseCall = await gate.acquire(programSignal);
              do {
                invocationActive(inner);
                let effective = inner.request();
                const journal = requestsFor(effective, call, options, scope, programSignal);
                if (await needsApproval(effective, options, programSignal)) {
                  let refusal: ToolResult | undefined;
                  if (!host?.prepareRequest || !host.beforeTool)
                    refusal = {
                      ok: false,
                      kind: "denied",
                      content: "This call needs a person's approval, and code cannot wait for one.",
                    };
                  else {
                    const record = await journal.ensure({ type: "approval" });
                    const decision = record.decision;
                    if (decision?.type === "approve") {
                      if (decision.arguments !== undefined)
                        effective = { ...effective, arguments: copyData(decision.arguments) };
                    } else {
                      if (!record.decision) record.closed = "stopped";
                      refusal = {
                        ok: false,
                        kind: decision?.type === "cancel" ? "cancelled" : "denied",
                        content:
                          decision?.type === "deny"
                            ? (decision.message ?? "The person denied this call.")
                            : "This call needs a person's approval, and code cannot wait for one.",
                      };
                    }
                  }
                  if (refusal) {
                    if (directNames.includes(name)) refusal.content += ` Call ${name} directly.`;
                    await finishExecution(inner, effective, refusal);
                    break;
                  }
                }
                if (textBytes(programJson(effective.arguments)) > code.limits.callInputBytes) {
                  await finishExecution(inner, effective, {
                    ok: false,
                    kind: "invalid_input",
                    content: `The approved arguments exceed ${code.limits.callInputBytes} bytes. Send less data.`,
                  });
                  break;
                }
                if (call.status === "pending" && call.previousAttemptId) {
                  emit({
                    type: "operation_restart",
                    kind: "tool",
                    runId: snapshot.runId,
                    operationId,
                    parentOperationId: request.operationId,
                    previousAttemptId: call.previousAttemptId,
                    attemptId: effective.attemptId,
                  });
                }
                await withToolError(
                  effective,
                  () => runTool(inner, effective, tool, concurrent),
                  programSignal,
                );
                if (count() >= code.limits.calls || programSignal.aborted) break;
              } while (await retryTool(inner));
              return reply;
            } catch (error) {
              // A host/guard/checkpoint error stops the run, not merely one guest call.
              if (
                !programSignal.aborted &&
                !(error instanceof Halt && error.state.status === "suspended")
              ) {
                fatal ??= error;
                end.abort(error);
              }
              for (const ask of call.asks ?? [])
                if (!ask.closed && !ask.decision) ask.closed = "stopped";
              if (
                !programSignal.aborted &&
                error instanceof Halt &&
                error.state.status === "suspended"
              ) {
                const result: ToolResult = {
                  ok: false,
                  kind: "denied",
                  content:
                    "The approval expired. Code cannot wait for a new decision. Call this tool directly.",
                };
                await finishExecution(inner, inner.request(), result);
                return programReply(result, code.limits.callOutputBytes);
              }
              if (inner.get().status !== "completed") {
                const result = stopped(call);
                inner.set({
                  id: operationId,
                  attemptId: call.attemptId,
                  status: "completed",
                  interrupted: call.interrupted,
                  retries: call.retries,
                  asks: call.asks,
                  result: programReceipt(result).result,
                });
                await save();
                if (!guardPolicy?.stages.includes("toolOutput"))
                  emit({ type: "tool_result", request: inner.request(), result });
              }
              return reject(
                "aborted",
                "The call stopped. Check its saved receipt before repeating it.",
              );
            } finally {
              releaseCall();
            }
          })();
          const done = work.then(
            () => {},
            () => {},
          );
          settled = Promise.all([settled, done]).then(() => {});
          if (!concurrent) barrier = settled;
          jobs.push(work);
          return work.catch((error) => {
            fatal ??= error;
            end.abort(error);
            return reject(
              "aborted",
              "The host could not record the call. Stop and reconcile its effect.",
            );
          });
        },
        async settle() {
          closed = true;
          end.abort(new Error("The program has finished."));
          await Promise.allSettled(jobs);
          clearTimeout(timer);
          if (fatal) throw fatal;
          // A deadline may interrupt a guard after an effect returned. Never turn its
          // unfinished verdict into a successful program or buy another model turn.
          requireGuardVerdicts(snapshot);
        },
      };
      const outcome = await code.execute(
        completeArguments(request.call.arguments) ? request.arguments : undefined,
        bridge,
      );
      await finishTool(model, index, request, outcome.result);
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
        retries: model.tools[index]?.retries ?? [],
        asks: model.tools[index]?.asks,
        id: request.operationId,
        attemptId: request.attemptId,
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
      refuseGuardedReplay(snapshot, request.operationId);
      await beforeTool(request);
      await requests.recheck(request);
      active();
      emit({ type: "tool_start", request });
      active();
      await requests.recheck(request);
      await requests.assertFresh();
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
            !isCodeTool(tool) &&
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
      refuseGuardedReplay(snapshot, request.operationId);
      await beforeTool(request);
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
      await finishTool(model, index, request, successfulToolResult(result));
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
        if (
          model.tools[index]?.status === "completed" &&
          !(await retryTool(slotFor(model, index)))
        ) {
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
        if (model.tools[index]?.retries.length) await checkToolRetry(slotFor(model, index));
        if (
          !directNames.includes(request.call.name) ||
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
            retries: [],
          };
          await save();
          active();
        }
        const descriptor = descriptorFor(request.call.name, snapshot, request.operationId);
        const tool = registry.get(request.call.name);
        const client = clients.get(request.call.name);
        const code = codeTools.get(request.call.name);
        const requests = journalFor(snapshot, model, index, options, scope, signal);
        if (
          (tool || descriptor || client || code) &&
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
        if (code) {
          await withToolError(request, () => runProgram(model, index, request, code));
          index++;
          continue;
        }
        if (descriptor) {
          await withToolError(request, () => runDelegation(model, index, request, descriptor));
          index++;
          continue;
        }
        if (client) {
          await withToolError(request, () => runClient(model, index, request, client));
          if (model.tools[index]?.status !== "completed") {
            await openApprovals(model, index + 1);
            snapshot.state = { status: "suspended" };
            return;
          }
          index++;
          continue;
        }

        const execution = model.tools[index];
        const batch = [
          {
            index,
            request,
            tool,
            previousAttemptId:
              execution?.status === "pending" ? execution.previousAttemptId : undefined,
          },
        ];
        const parallel = (request: ToolRequest, tool?: Tool) =>
          canParallel(
            request,
            tool,
            slotFor(
              model,
              model.tools.findIndex((entry) => entry.id === request.operationId),
            ).get(),
          );
        const concurrent = parallel(request, tool);
        if (concurrent) {
          for (
            let next = index + 1;
            next < calls.length && batch.length < Math.min(limits.parallelTools, capacity);
            next++
          ) {
            const execution = model.tools[next];
            if (execution?.status !== "pending") break;
            const nextRequest = requestFor(snapshot, model, next);
            const nextTool = registry.get(nextRequest.call.name);
            if (!parallel(nextRequest, nextTool)) break;
            batch.push({
              index: next,
              request: nextRequest,
              tool: nextTool,
              previousAttemptId: execution.previousAttemptId,
            });
          }
        }
        // A checkpoint can capture the pending retry while another child saves. Check its
        // identity again before admission, even if this worker did not perform the reset.
        for (const job of batch) {
          const execution = model.tools[job.index];
          if (execution?.interrupted.length && !execution.asks?.length)
            await checkToolRecovery(
              model,
              job.index,
              execution.interrupted.length + execution.retries.length - 1,
            );
        }
        active();
        // Reserve the whole admitted batch before any invocation, including its tool-call budget.
        for (const job of batch)
          model.tools[job.index] = {
            interrupted: model.tools[job.index]?.interrupted ?? [],
            retries: model.tools[job.index]?.retries ?? [],
            asks: model.tools[job.index]?.asks,
            id: job.request.operationId,
            attemptId: job.request.attemptId,
            status: "running",
          };
        await save();
        const settled = await Promise.allSettled(
          batch.map((job) => {
            // Retry and recovery histories can interleave. Use the predecessor saved when
            // this replacement was scheduled, not the tail of either history alone.
            if (job.previousAttemptId)
              restart(
                "tool",
                job.request.operationId,
                job.previousAttemptId,
                job.request.attemptId,
              );
            return withToolError(job.request, () =>
              runTool(slotFor(model, job.index), job.request, job.tool, concurrent),
            );
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
        // Retrying tools run serially. Revisit their settled failure through the same
        // admission path; ordinary batches advance as before.
        if (!retryBudget(snapshot.definition.toolRetries, request.call.name)) index += batch.length;
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

    async function compact(): Promise<void> {
      const last = snapshot.compactions.at(-1);
      if (last?.status === "running")
        fail(
          "interrupted_compaction",
          "The summary has no saved result and may have been billed. Reconcile it with the host before continuing.",
          last.id,
        );
      const plan = compactionPlan(snapshot);
      if (!plan) return;
      const { removed, ...position } = plan;
      const index = snapshot.compactions.length;
      const entry: CompactionExecution = {
        id: compactionId(snapshot.runId, index),
        beforeModel: snapshot.models.length,
        ...position,
        status: "running",
      };
      const summary = snapshot.definition.compaction?.summarize;
      if (!summary) {
        snapshot.compactions.push({
          ...entry,
          status: "completed",
          summary: "Earlier messages were omitted. No summary was generated.",
        });
        await save();
        return;
      }
      if (!summarizer) fail("invalid_journal", "The recorded summary provider is missing.");
      // A separate receipt freezes this cut before any paid work. A crash, even before
      // dispatch, fails closed instead of silently purchasing the same summary twice.
      snapshot.compactions.push(entry);
      await save();
      active();
      const messages = await requestOf(summary.instructions, removed, loadMedia);
      await callModel(
        entry.id,
        {
          messages,
          tools: [],
          settings: {
            maxTokens: summary.maxTokens,
            maxAttempts: 1,
            toolChoice: "none",
            hostedTools: [],
          },
        },
        summarizer,
        (model) => {
          if (model.status === "completed") {
            if (
              model.turn.finishReason !== "stop" ||
              !model.turn.message.content.trim() ||
              model.tools.length ||
              model.turn.message.hostedCalls?.length ||
              model.turn.message.hostedItems
            )
              fail(
                "invalid_compaction",
                "The summary must be complete text without tool calls. Check the summary provider before starting new work.",
                entry.id,
              );
            snapshot.compactions[index] = {
              ...entry,
              model,
              status: "completed",
              summary: model.turn.message.content,
            };
          } else entry.model = model;
        },
        undefined,
        true,
      );
    }

    async function nextTurn(
      previous?: Extract<ModelExecution, { status: "running" }>,
    ): Promise<CompletedModel> {
      active();
      // Hosted actions may run before any local tool call appears. Their explicit presence
      // overrides a profile's inference-only claim when an interrupted call is recovered.
      if (previous) {
        refuseGuardedReplay(snapshot, previous.id);
        requireRecovery(
          snapshot.definition.recovery?.policy.inferenceOnly === true &&
            !snapshot.definition.modelSettings.hostedTools?.length,
          previous.interrupted.length,
          snapshot.definition.recovery,
          previous.id,
        );
      }
      const position = previous ? snapshot.models.indexOf(previous) : snapshot.models.length;
      const selected = definitionsFor(snapshot.definition.enabledTools);
      if (
        previous &&
        (await requestHash(selected)) !== snapshot.definition.recovery?.modelToolsHash
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
      scope.tree.reserveCost(scope.path);
      if (!previous) {
        await acceptInputs(snapshot, scope, options, signal);
        await compact();
      }
      active();
      // Media is read before the receipt below exists, so a missing loader or file fails the
      // run with no model operation left running and nothing to reconcile.
      const request = await requestOf(
        snapshot.definition.instructions,
        withMemoryRecall(snapshot, modelConversation(snapshot)),
        loadMedia,
      );
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
      const operationId = modelId(snapshot.runId, position);
      const modelInput: ModelInput = {
        messages: request,
        tools: finalTurn ? [] : copyData(selected),
        settings: modelSettings,
      };
      const done = await callModel(
        operationId,
        modelInput,
        provider,
        (model) => {
          snapshot.models[position] = model;
        },
        previous,
      );
      for (const receipt of inputReceipts(snapshot).filter(
        (receipt) => receipt.modelId === done.id,
      ))
        emit({ type: "input", receipt });
      await acknowledgeInputs(snapshot, options, signal);
      return done;
    }

    // Both ordinary turns and explicit summaries use the same admission, guards, usage
    // checkpoints and collection path. Summaries stay private and never dispatch tools.
    async function callModel(
      operationId: string,
      modelInput: ModelInput,
      selectedProvider: Provider,
      record: (model: ModelExecution) => void,
      previous?: Extract<ModelExecution, { status: "running" }>,
      summary = false,
    ): Promise<CompletedModel> {
      const { messages: request, settings: modelSettings } = modelInput;
      await guards.check("modelInput", operationId, snapshot.attemptId, modelInput);
      await observe({
        type: "model_start",
        operationId,
        attemptId: snapshot.attemptId,
        input: modelInput,
      });
      active();
      // The tree check and the receipt stay together, with no await between them, so two
      // children racing for the tree's last model call cannot both take it.
      scope.tree.reserveModel();
      scope.tree.reserveCost(scope.path);
      const model: ModelExecution = {
        id: operationId,
        attemptId: snapshot.attemptId,
        status: "running",
        billing: "unknown",
        usage: { ...EMPTY_USAGE },
        interrupted: previous
          ? [
              ...previous.interrupted,
              {
                attemptId: previous.attemptId,
                usage: copyData(previous.usage),
                // The lost attempt keeps the price it was given, never a new one.
                ...(previous.costUsd !== undefined ? { costUsd: previous.costUsd } : {}),
              },
            ]
          : [],
      };
      record(model);
      await save();
      if (previous) restart("model", model.id, previous.attemptId);
      active();
      let reportedUsage = false;
      let bufferedChunks = 0;
      let bufferedBytes = 0;
      const guarded = !!guardrails?.modelOutput;
      const served = {
        provider: selectedProvider.id,
        model: modelSettings.model ?? selectedProvider.model,
      };
      async function* observed(): AsyncIterable<ProviderChunk> {
        let dispatchProvider = selectedProvider;
        if (options.bindModelProvider) {
          try {
            const bound = options.bindModelProvider(
              selectedProvider,
              Object.freeze({
                run: callbackContext,
                operationId: model.id,
                operationAttemptId: model.attemptId,
                purpose: summary ? "compaction" : "turn",
              }),
            );
            if (bound && typeof bound.createStream === "function") dispatchProvider = bound;
          } catch {
            // Instrumentation can fail before dispatch. Never catch/replay the provider call.
          }
        }
        active();
        const stream = dispatchProvider.createStream(request, modelInput.tools, {
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
          // A summary keeps a session of its own: it has its own instructions, so it shares no
          // cached prefix with the turns.
          sessionId: summary
            ? operationId
            : (snapshot.definition.providerSessionId ??
              snapshot.subagent?.identity.originRunId ??
              snapshot.runId),
        });
        for await (const chunk of stream) {
          active();
          if (chunk.usage) {
            if (!isUsage(chunk.usage))
              fail("invalid_usage", "The provider returned invalid token usage.", model.id);
            model.usage = copyData(chunk.usage);
            reportedUsage = true;
            const cost = priceOf(model.usage, served, model.id);
            if (cost !== undefined) model.costUsd = cost;
            // Preserve measurements before another pull can hang or the worker can disappear.
            // This saves usage, not partial text, and does not claim final billing is known.
            await save();
            active();
          }
          if (guarded) {
            // Bound collection before yielding. Only the checked assembled turn is published.
            // All fields count, including reasoning, signatures, tool args and hosted payloads.
            bufferedBytes += jsonBytes(chunk);
            bufferedChunks++;
            if (
              bufferedBytes > (guardPolicy?.maxOutputBytes ?? 0) ||
              bufferedChunks > GUARDED_CHUNK_LIMIT
            )
              await guards.overflow("modelOutput", model.id);
          } else if (!summary) {
            emit({
              type: "model_chunk",
              runId: snapshot.runId,
              attemptId: snapshot.attemptId,
              operationId: model.id,
              chunk,
            });
          }
          active();
          yield chunk;
        }
      }
      let collected;
      try {
        collected = await untilAbort(collectTurn(observed()), signal);
      } catch (error) {
        await observe({ type: "model_error", operationId: model.id, attemptId: model.attemptId });
        active();
        // Only core's classified provider failures are local model failures. Host/checkpoint
        // errors and unclassified programming errors must not become benign tool strings.
        if (!(error instanceof ProviderError)) {
          if (guarded && !(error instanceof Halt))
            fail(
              "guarded_model_failed",
              "The guarded model call failed before its output could be checked. Inspect the provider on the server before starting new work.",
              model.id,
            );
          throw error;
        }
        if (error.kind === "aborted") {
          scope.tree.stop();
          throw new Halt({ status: "cancelled" });
        }
        fail(
          "model_failed",
          guarded
            ? `The model call failed (${error.kind}). Check the provider before starting new work.`
            : `The model call failed (${error.kind}): ${error.message}`,
          model.id,
        );
      }
      let turn;
      try {
        turn = readTurn(collected);
      } catch (error) {
        fail(
          "invalid_model_output",
          guarded
            ? "The provider returned an invalid guarded turn. Check the provider before starting new work."
            : messageOf(error),
          model.id,
        );
      }
      await observe({ type: "model_end", operationId: model.id, attemptId: model.attemptId, turn });
      active();
      await guards.check("modelOutput", model.id, model.attemptId, turn);
      active();
      // A call that never reported usage keeps no price: its cost is unknown, not zero.
      const costUsd = reportedUsage
        ? priceOf(turn.usage, turn.source ?? served, model.id)
        : undefined;
      const done: CompletedModel = {
        ...model,
        status: "completed",
        billing: reportedUsage ? "reported" : "unknown",
        usage: turn.usage,
        ...(costUsd !== undefined ? { costUsd } : {}),
        turn,
        tools: (turn.message.toolCalls ?? []).map((_call, index) => ({
          id: toolId(model.id, index),
          status: "pending",
          interrupted: [],
          retries: [],
        })),
      };
      record(done);
      await save();
      if (guarded && !summary) {
        active();
        emit({
          type: "model_chunk",
          runId: snapshot.runId,
          attemptId: model.attemptId,
          operationId: model.id,
          chunk: guardedChunk(turn),
        });
      }
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
        requireGuardVerdicts(snapshot);
        started = true;
        await observe({ type: "run_start" });
        active();
        const last = snapshot.models.at(-1);
        snapshot.state = { status: "running" };
        checkMemoryBinding(snapshot, options.memory);
        if (needsMemory && !options.memory)
          fail("memory_missing", "Supply authenticated memory access before starting this agent.");
        if (
          !options.memory?.scope &&
          [...capabilities.values()].some(
            (tool) =>
              isMemoryTool(tool) &&
              !tool.isReadOnly &&
              snapshot.definition.enabledTools.includes(tool.name),
          )
        )
          fail(
            "memory_missing",
            "Memory writes need an authenticated person's writable scope. Disable save and forget for shared-only access.",
          );
        if (memory && options.memory && !snapshot.recall) {
          snapshot.recall = await recallMemory(
            snapshot,
            options.memory,
            signal,
            scope.handoffInput,
          );
          // No model sees recall until the existing progress/checkpoint barrier confirms it.
          await save();
          active();
        }
        if (snapshot.recall?.status === "failed" && memory?.onError === "fail")
          fail(
            "memory_unavailable",
            "Memory could not be read. Check the store before starting a new run.",
          );
        if (last?.status === "running") await handleTurn(await nextTurn(last));
        else if (last?.status === "completed") {
          await recoverTools(last);
          await handleTurn(last);
        }
        while (snapshot.state.status === "running") await handleTurn(await nextTurn());
      }
      if (snapshot.state.status === "completed") completed = { output: completedOutput(snapshot) };
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
      if (started) await observe({ type: "run_end", state: snapshot.state });
      clearTimeout(timer);
    }
    emit({
      type: "state",
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      state: snapshot.state,
    });
    // Includes the final state event, before a child host receipt or session append can land.
    await host?.progress?.flush();
    const record = recordOf(snapshot);
    const state = snapshot.state;
    if (state.status === "completed") {
      if (!completed) throw new Error("The agent completed without validating its result.");
      return { ...record, status: "completed", output: completed.output };
    }
    return state.status === "suspended"
      ? { ...record, ...state, requests: openRequests(snapshot), wakeAt: wakeAt(snapshot) }
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
      (name) => (registry.get(name) ?? codeTools.get(name))?.isReadOnly === true,
    );
    checkInline({ history, input: start.input });
    return { ...start, history };
  }

  async function create(
    start: RunStart,
    runId: string,
    tree?: RunSnapshot["tree"],
    options: RunOptions = {},
    subagent?: SubagentCreation,
  ): Promise<RunSnapshot> {
    const frozen = freeze(start);
    const spec = subagent?.record.spec;
    const resolved = await resolveDefinition(
      frozen,
      spec
        ? {
            ...options,
            enabledTools: spec.tools,
            modelSettings: subagent.record.policy.models[spec.model ?? ""]?.settings,
          }
        : options,
      runId,
      subagent?.source,
    );
    const record = subagent
      ? { ...copyData(subagent.record), base: copyData(resolved) }
      : undefined;
    if (subagent?.record.previousRunId && !equalData(resolved, subagent.source))
      throw new TypeError(
        "The helper's admitted definition changed. Restore its original configuration before continuing.",
      );
    if (spec)
      resolved.instructions = subagentInstructions(resolved.instructions, spec.instructions);
    const childLimits = spec ? subagentLimits(limits, spec.limits) : limits;
    if (inlineBytes(frozen.history, frozen.input) > childLimits.inlineBytes)
      throw new TypeError("The helper input exceeds its admitted inline byte limit.");
    const { history, input, session } = frozen;
    requirePricing(childLimits, options.host);
    const startedAt = Date.now();
    return {
      kind: "agent",
      format: 3,
      agentId: id,
      version,
      runId,
      attemptId: crypto.randomUUID(),
      startedAt,
      definition: resolved,
      ...(record ? { subagent: record } : {}),
      history: copyData(history),
      input: copyData(input),
      inputs: [],
      guards: [],
      compactions: [],
      ...(session ? { session: copyData(session) } : {}),
      limits: copyData(childLimits),
      models: [],
      delegations: [],
      state: { status: "running" },
      tree: tree
        ? copyData(tree)
        : {
            runId,
            startedAt,
            limits: copyData(treeLimits),
            ...(options.memory ? { memory: memoryScopes(options.memory) } : {}),
          },
    };
  }

  const runtime: AgentRuntime<T | string | H> = {
    node: {
      restore: (raw, tree, subagent) => runtime.restore(raw, tree, subagent),
      hydrate: (node) => runtime.hydrate(agentSnapshot(node)),
      answerRequests: (node, options, scope, answers, signal) =>
        answerRequests(agentSnapshot(node), options, scope, answers, signal),
      execute: (node, options, scope, answers) =>
        execute(agentSnapshot(node), options, scope, answers),
    },
    handoffs: [...handoffs.values()],
    tools: Object.freeze([...capabilities.values()]),
    enabledTools: Array.isArray(enabledTools) ? Object.freeze([...enabledTools]) : undefined,
    limits: immutableCopy(limits),
    async checkTools(snapshot, options) {
      const signal = options.signal ?? new AbortController().signal;
      const current = checkNames(
        typeof enabledTools === "function"
          ? await untilAbort(
              Promise.resolve(
                enabledTools(
                  Object.freeze({
                    agentId: id,
                    version,
                    runId: snapshot.runId,
                    ...immutableCopy({ history: snapshot.history, input: snapshot.input }),
                    context: Object.freeze({ ...options.context }),
                    signal,
                  }),
                ),
              ),
              signal,
            )
          : (enabledTools ?? names),
      );
      if (
        snapshot.definition.enabledTools.some(
          (name) => name !== RESULT_TOOL_NAME && !current.includes(name),
        )
      )
        fail(
          "subagent_grant_changed",
          "The host revoked a helper capability. Obtain fresh authorization before starting different work.",
        );
    },
    configuration() {
      const { onActivity: _activity, onRateLimit: _rateLimit, ...modelSettings } = settings;
      return immutableCopy({
        id,
        version,
        provider: { id: provider.id, model: provider.model },
        instructions: typeof instructions === "string" ? instructions : null,
        enabledTools: Array.isArray(enabledTools) ? enabledTools : null,
        modelSettings,
        limits,
        output: output?.schema ?? null,
        stopAtTools,
        recovery,
        guardrails: guardPolicy,
        compaction,
        toolRetries,
        ...(memory ? { memory } : {}),
        tools: tools.map((tool) => ({
          definition: tool.definition(),
          needsApproval: tool.needsApproval === true,
          ...(isDelegation(tool)
            ? {
                kind: "delegation",
                specialists: tool.specialists.map(({ id, version }) => ({ id, version })),
              }
            : isHandoff(tool)
              ? { kind: "handoff", target: handoffRef(tool.target()) }
              : isCodeTool(tool)
                ? {
                    kind: "code",
                    limits: tool.limits,
                    bindings: tool.tools.map((bound) => ({
                      definition: bound.definition(),
                      outputSchema: bound.outputSchema,
                      isReadOnly: bound.isReadOnly,
                      needsApproval: bound.needsApproval,
                      isConcurrencySafe: bound.isConcurrencySafe,
                      timeoutMs: bound.timeoutMs,
                    })),
                  }
                : isClientTool(tool)
                  ? { kind: "client", resultSchema: tool.resultSchema }
                  : {
                      kind: "tool",
                      isReadOnly: tool.isReadOnly === true,
                      isConcurrencySafe: tool.isConcurrencySafe === true,
                      isTerminal: tool.isTerminal === true,
                    }),
        })),
      });
    },
    execute,
    answerRequests,
    freeze,
    create,
    async open(input, options, runId) {
      options = { ...options, memory: readMemoryBinding(options.memory) };
      if (needsMemory && !options.memory)
        throw new TypeError("This agent needs authenticated memory access in RunOptions.memory.");
      requirePricing(limits, options.host);
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
    restore(raw, tree, subagent) {
      if (isRecord(raw) && (!equalData(raw.subagent, subagent) || (subagent && !tree)))
        throw new TypeError("Restore a model-created helper through its owning creation tool.");
      const snapshot = readSnapshot(
        raw,
        id,
        version,
        subagent ? subagentLimits(limits, subagent.spec.limits) : limits,
        output ? RESULT_TOOL_NAME : undefined,
        codeTools,
      );
      checkNames(snapshot.definition.enabledTools);
      if (!equalData(snapshot.definition.memory, memory))
        throw new TypeError("Restore the same memory recall policy before resuming.");
      if (
        !equalData(snapshot.definition.compaction, compaction) ||
        !equalData(snapshot.definition.toolRetries?.policy ?? null, toolRetries)
      )
        throw new TypeError(
          "The recorded compaction or tool retry policy changed. Restore the same definition before resuming.",
        );
      if (!equalData(snapshot.definition.guardrails, guardPolicy))
        throw new TypeError(
          "The recorded guard policy changed. Restore the same guard identity, stages and limits.",
        );
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
          checkSubagentChildren(descriptor, snapshot, journal);
          for (const entry of journal.children) {
            const agent = descriptor.specialists.find(
              (agent) =>
                agent.kind === entry.snapshot.kind &&
                agent.id === nodeId(entry.snapshot) &&
                agent.version === entry.snapshot.version,
            );
            if (!agent)
              throw new TypeError("The saved child is not a registered specialist version.");
            entry.snapshot = runtimeOf(agent).restore(
              entry.snapshot,
              snapshot.tree,
              entry.snapshot.kind === "agent" ? entry.snapshot.subagent : undefined,
            );
          }
        }
      }
      if (snapshot.state.status === "completed") completedOutput(snapshot);
      return snapshot;
    },
    hydrate(snapshot) {
      const record = recordOf(snapshot);
      const state = record.snapshot.state;
      if (state.status === "running") throw new Error("A child has not settled yet.");
      return state.status === "completed"
        ? { ...record, status: "completed", output: completedOutput(record.snapshot) }
        : state.status === "suspended"
          ? { ...record, ...state, requests: openRequests(snapshot), wakeAt: wakeAt(snapshot) }
          : { ...record, ...state };
    },
  };

  /** Once per root, after its final checkpoint. Never changes the run's own status. */
  async function appendTurn(
    outcome: RunOutcome<T | string | H>,
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
    let outcome: RunOutcome<T | string | H>;
    try {
      outcome = await execute(snapshot, options, { tree, depth: 0, path: [] }, answers);
    } finally {
      tree.close();
    }
    const session = await appendTurn(outcome, options, tree);
    return session ? { ...outcome, session } : outcome;
  }

  const agent: Agent<T | string | H> = {
    kind: "agent",
    id,
    version,
    [AGENT_RUNTIME]: runtime,
    asTool(options) {
      return specialistTool(agent, options);
    },
    async run(input, options = {}) {
      checkOptions(options);
      options = { ...options, memory: readMemoryBinding(options.memory) };
      return root(
        await runtime.open(input, options, options.runId ?? crypto.randomUUID()),
        options,
      );
    },
    async resume(raw, options) {
      checkOptions(options, "resume");
      options = { ...options, memory: readMemoryBinding(options.memory) };
      const snapshot = runtime.restore(raw);
      checkMemoryBinding(snapshot, options.memory);
      checkPricing(snapshot, options.host);
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
