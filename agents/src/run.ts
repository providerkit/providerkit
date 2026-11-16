import {
  EMPTY_USAGE,
  ToolRegistry,
  addUsage,
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
  type ApprovalEvidence,
  type Delegation,
  type RunStart,
} from "./delegation.ts";
import { conversationOf, readInput, readStored, repairConversation, requestOf } from "./input.ts";
import {
  ExecutionTree,
  Halt,
  authorizeTree,
  emitEvent,
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
  finalToolResult,
  immutableCopy,
  inlineBytes,
  isBase64,
  isEnabledTools,
  isId,
  isNames,
  isRecord,
  isRevision,
  isScope,
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
  PendingApproval,
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
  const history = conversationOf(saved);
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
    history,
    newMessages: copyData(history.slice(saved.history.length)),
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
    if (!tool || isDelegation(tool))
      throw new TypeError("stopAtTools must name ordinary tools registered on this agent.");
  }
  for (const tool of tools)
    if (!isDelegation(tool) && tool.isTerminal && !stopAtTools.includes(tool.name))
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
  const registry = new ToolRegistry(tools.filter((tool): tool is Tool => !isDelegation(tool)));
  const delegations = new Map(tools.filter(isDelegation).map((tool) => [tool.name, tool]));
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
    return {
      instructions: text,
      modelSettings,
      enabledTools: enabled,
      stopAtTools: [...stopAtTools],
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
      emitEvent(options, event);
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
          content: `Call ${tool.name} alone, after the other tool results arrive.`,
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
        if (capacity <= 0 && model.tools[index]?.status === "pending")
          throw new Halt({ status: "limited", limit: "toolCalls" });
        const request = requestFor(model, index);
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
        const descriptor = delegations.get(request.call.name);
        if (descriptor) {
          await runDelegation(model, index, request, descriptor);
          index++;
          continue;
        }
        const tool = registry.get(request.call.name);
        if (
          tool?.needsApproval &&
          (!tool.isTerminal || model.tools.length === 1) &&
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
          snapshot.definition.enabledTools.includes(request.call.name) &&
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
      // Adapted from OpenAI Agents JS (MIT), runner/toolExecution.ts: settle this batch,
      // then select the first stopping tool in model order, not completion order.
      const final = finalToolResult(
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

    async function nextTurn(): Promise<CompletedModel> {
      active();
      // Ported from Microsoft Agent Framework (MIT), _tools.py: after the iteration
      // allowance, ask once for a tool-free answer. Checked output needs submit_result,
      // so that mode retains the hard local turn cap instead of buying an unusable call.
      const finalTurn = snapshot.models.length === limits.turns;
      if (snapshot.models.length > limits.turns || (finalTurn && output))
        throw new Halt({ status: "limited", limit: "turns" });
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
        id: modelId(snapshot.runId, snapshot.models.length),
        attemptId: snapshot.attemptId,
        status: "running",
        usage: { ...EMPTY_USAGE },
      };
      snapshot.models.push(model);
      await save();
      active();
      const selected = tools.filter((tool) => snapshot.definition.enabledTools.includes(tool.name));
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
          if (
            !snapshot.definition.enabledTools.includes(approval.request.call.name) ||
            snapshot.definition.modelSettings.toolChoice === "none" ||
            !registry.get(approval.request.call.name)?.needsApproval
          )
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
    const record = recordOf(snapshot);
    const state = snapshot.state;
    if (state.status === "completed") {
      if (!completed) throw new Error("The agent completed without validating its result.");
      return { ...record, status: "completed", output: completed.output };
    }
    return { ...record, ...state };
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
      ...(session ? { session: copyData(session) } : {}),
      limits: copyData(limits),
      models: [],
      delegations: [],
      state: { status: "running" },
      tree: tree ? copyData(tree) : { runId, startedAt, limits: copyData(treeLimits) },
    };
  }

  const runtime: AgentRuntime<T | string> = {
    execute,
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
            delegations.get(call.name);
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
      const record = recordOf(snapshot);
      const state = record.snapshot.state;
      if (state.status === "running") throw new Error("A child has not settled yet.");
      return state.status === "completed"
        ? { ...record, status: "completed", output: validateResult(state.candidate) }
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

  async function root(snapshot: RunSnapshot, options: RunOptions, evidence?: ApprovalEvidence) {
    const tree = new ExecutionTree(snapshot, options);
    let outcome: RunOutcome<T | string>;
    try {
      outcome = await execute(snapshot, options, { tree, depth: 0 }, evidence);
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
