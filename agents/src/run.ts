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
  checkOptions,
  completeArguments,
  copyData,
  immutableCopy,
  isId,
  isRecord,
  isScope,
  isUsage,
  modelId,
  readLimits,
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
  RunFailure,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  RunState,
  ToolRequest,
  ToolResult,
} from "./types.ts";

/** Reserved for the output contract supplied to defineAgent. */
export const RESULT_TOOL_NAME = "submit_result";

type CompletedModel = Extract<ModelExecution, { status: "completed" }>;
type StopState = Extract<RunState, { status: "failed" | "cancelled" | "limited" }>;

class Halt extends Error {
  constructor(readonly state: StopState) {
    super(state.status);
  }
}

function fail(code: string, message: string, operationId?: string): never {
  throw new Halt({ status: "failed", error: { code, message, operationId } });
}

/** This is the run's wall-clock/caller cancellation, not a provider retry or watchdog.
 * A provider or tool that ignores its signal can still finish externally after we stop. */
async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

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
        kind: "tool",
        id: tool.id,
        callId: call.id,
        attemptId: tool.attemptId,
        status: tool.status,
        ...(tool.status === "completed" ? { result: tool.result } : {}),
      });
    }
  }
  return {
    runId: saved.runId,
    attemptId: saved.attemptId,
    usage,
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
    tools.some((tool) => !isId(tool.name) || tool.name === RESULT_TOOL_NAME || tool.isTerminal)
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
  const registry = new ToolRegistry(tools);

  function validateResult(candidate: unknown): T | string {
    if (output) return output.validate(copyData(candidate));
    if (typeof candidate !== "string" || !candidate.trim())
      throw new TypeError("The model returned no answer.");
    return candidate;
  }

  async function execute(
    snapshot: RunSnapshot,
    options: RunOptions,
    decision?: unknown,
  ): Promise<RunOutcome<T | string>> {
    const host = options.host;
    const deadline = snapshot.startedAt + limits.elapsedMs;
    const timeout = new AbortController();
    const signal = AbortSignal.any(
      options.signal ? [options.signal, timeout.signal] : [timeout.signal],
    );
    const timer = setTimeout(
      () => timeout.abort(new Error("The run reached its time limit.")),
      Math.max(0, deadline - Date.now()),
    );
    let writes = Promise.resolve();
    let checkpointError: RunFailure | undefined;
    let approved: PendingApproval | undefined;
    let completed: { output: T | string } | undefined;

    function active(): void {
      if (options.signal?.aborted) throw new Halt({ status: "cancelled" });
      if (timeout.signal.aborted || Date.now() >= deadline)
        throw new Halt({ status: "limited", limit: "elapsedMs" });
      if (checkpointError) throw new Halt({ status: "failed", error: checkpointError });
    }

    function emit(event: AgentEvent): void {
      try {
        void Promise.resolve(options.onEvent?.(immutableCopy(event))).catch(() => {});
      } catch {
        // Progress is not the durable journal, and an observer cannot stop execution.
      }
    }

    async function save(): Promise<void> {
      const saved = immutableCopy(snapshot);
      // Capture at enqueue time and serialize writes: a slow older write cannot erase a receipt.
      writes = writes.then(async () => {
        await host?.checkpoint?.(saved);
      });
      try {
        await writes;
      } catch (error) {
        checkpointError ??= {
          code: "checkpoint_failed",
          message: `Checkpoint failed: ${messageOf(error)}. Reconcile stored state before resuming.`,
        };
        throw new Halt({ status: "failed", error: checkpointError });
      }
    }

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
      tool?: Tool,
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
        const outcome = await untilAbort(
          tool.invoke(copyData(request.arguments), {
            ...options.context,
            runId: snapshot.runId,
            attemptId: snapshot.attemptId,
            operationId: request.operationId,
            callId: request.call.id,
            signal,
          }),
          signal,
        );
        // Core reports an aborted invocation as data. It must not buy another model turn.
        if (!outcome.ok) active();
        result = outcome.ok
          ? { ok: true, content: outcome.summary }
          : { ok: false, content: outcome.error, kind: outcome.kind };
      }
      await finishTool(model, index, request, result);
      active();
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
        if (capacity <= 0) throw new Halt({ status: "limited", limit: "toolCalls" });
        const request = requestFor(model, index);
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
          snapshot.state = { status: "suspended", approval: { request: copyData(request), scope } };
          return;
        }

        const batch = [{ index, request, tool }];
        const parallel = (request: ToolRequest, tool?: Tool) =>
          tool?.isConcurrencySafe === true &&
          !tool.needsApproval &&
          !tool.isTerminal &&
          host?.canRunConcurrently?.(immutableCopy(request)) === true;
        if (parallel(request, tool)) {
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
          batch.map((job) => runTool(model, job.index, job.request, job.tool)),
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
          copyData(registry.definitions()),
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
        if (snapshot.state.status === "suspended") {
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
            Promise.resolve(host.resolveApproval(immutableCopy(approval), immutableCopy(decision))),
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
      if (!(failure instanceof Halt)) {
        try {
          active();
        } catch (stopped) {
          failure = stopped;
        }
      }
      if (checkpointError) {
        snapshot.state = { status: "failed", error: checkpointError };
      } else if (failure instanceof Halt) {
        snapshot.state = failure.state;
      } else {
        snapshot.state = {
          status: "failed",
          error: { code: "execution_failed", message: messageOf(failure) },
        };
      }
      if (!checkpointError) {
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
      }
    } finally {
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

  return {
    id,
    version,
    async run(input, options = {}) {
      if (!isId(input)) throw new TypeError("Give the agent a non-empty text input.");
      checkOptions(options);
      return execute(
        {
          format: 1,
          agentId: id,
          version,
          runId: options.runId ?? crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          startedAt: Date.now(),
          input,
          limits: copyData(limits),
          models: [],
          state: { status: "running" },
        },
        options,
      );
    },
    async resume(raw, options) {
      checkOptions(options);
      if (!options.host?.authorizeResume)
        throw new TypeError("Resume requires a trusted host.authorizeResume callback.");
      const snapshot = readSnapshot(
        raw,
        id,
        version,
        limits,
        output ? RESULT_TOOL_NAME : undefined,
      );
      await options.host.authorizeResume(immutableCopy(snapshot));
      snapshot.attemptId = crypto.randomUUID();
      return execute(snapshot, options, options.decision);
    },
  };
}
