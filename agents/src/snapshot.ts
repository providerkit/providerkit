import { parseToolArgs, type TokenUsage, type ToolCall, type Turn } from "@providerkit/core";
import type {
  ApprovalScope,
  ModelExecution,
  PendingApproval,
  RunLimits,
  RunOptions,
  RunSnapshot,
  RunState,
  ToolExecution,
  ToolRequest,
  ToolResult,
} from "./types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positive(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value > 0;
}

function optional(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

/** JSON cannot preserve cycles, class instances, non-finite numbers or functions. */
function serializable(value: unknown, parents = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || parents.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  parents.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => serializable(item, parents))
    : Object.values(value).every((item) => item === undefined || serializable(item, parents));
  parents.delete(value);
  return valid;
}

export function copyData<T>(value: T): T {
  if (value !== undefined && !serializable(value)) {
    throw new TypeError("Run data must use plain JSON values so a checkpoint can save it.");
  }
  return structuredClone(value);
}

/** A callback cannot edit the live journal, even by retaining a nested reference. */
export function immutableCopy<T>(value: T): T {
  const copy = copyData(value);
  function freeze(item: unknown): void {
    if (typeof item !== "object" || item === null) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(copy);
  return copy;
}

/** Object key order can change when a host stores JSON; array order cannot. */
function equalData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => equalData(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => equalData(left[key], right[key]));
}

export function readLimits(value: unknown = {}): RunLimits {
  if (!isRecord(value)) throw new TypeError("Agent limits must be an object.");
  const limits = {
    turns: value.turns ?? 12,
    toolCalls: value.toolCalls ?? 32,
    elapsedMs: value.elapsedMs ?? 300_000,
    parallelTools: value.parallelTools ?? 3,
  };
  if (!isLimits(limits)) {
    throw new TypeError(
      "Agent limits must be positive finite integers; elapsedMs must fit a timer.",
    );
  }
  return limits;
}

function isLimits(value: unknown): value is RunLimits {
  return (
    isRecord(value) &&
    positive(value.turns) &&
    positive(value.toolCalls) &&
    positive(value.elapsedMs) &&
    value.elapsedMs <= 2_147_483_647 &&
    positive(value.parallelTools)
  );
}

export function checkOptions(value: unknown): asserts value is RunOptions {
  if (
    !isRecord(value) ||
    !optional(value.runId, isId) ||
    !optional(value.signal, (signal) => signal instanceof AbortSignal) ||
    !optional(value.context, isRecord) ||
    !optional(value.onEvent, (fn) => typeof fn === "function")
  ) {
    throw new TypeError("Invalid run options.");
  }
  if (value.host !== undefined) {
    if (!isRecord(value.host)) throw new TypeError("The run host must be an object.");
    for (const key of [
      "checkpoint",
      "authorizeResume",
      "approvalContext",
      "resolveApproval",
      "beforeTool",
      "canRunConcurrently",
    ]) {
      if (!optional(value.host[key], (fn) => typeof fn === "function")) {
        throw new TypeError(`host.${key} must be a function.`);
      }
    }
  }
}

export function isScope(value: unknown): value is ApprovalScope {
  return (
    isRecord(value) &&
    isId(value.actorId) &&
    isRecord(value.resource) &&
    isId(value.resource.id) &&
    isId(value.resource.version) &&
    positive(value.expiresAt)
  );
}

export function completeArguments(raw: string): boolean {
  try {
    return isRecord(JSON.parse(raw));
  } catch {
    return false;
  }
}

function isCall(value: unknown): value is ToolCall {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isId(value.name) &&
    typeof value.arguments === "string" &&
    optional(value.thoughtSignature, (v) => typeof v === "string")
  );
}

function isRequest(value: unknown): value is ToolRequest {
  return (
    isRecord(value) &&
    [value.agentId, value.version, value.runId, value.attemptId, value.operationId].every(isId) &&
    isCall(value.call) &&
    isRecord(value.arguments)
  );
}

function isApproval(value: unknown): value is PendingApproval {
  return isRecord(value) && isRequest(value.request) && isScope(value.scope);
}

export function isUsage(value: unknown): value is TokenUsage {
  return (
    isRecord(value) &&
    finite(value.inputTokens) &&
    finite(value.outputTokens) &&
    finite(value.cachedInputTokens) &&
    [value.cacheWriteTokens, value.reasoningTokens, value.reportedCostUsd].every((v) =>
      optional(v, finite),
    )
  );
}

function isTurn(value: unknown): value is Turn {
  if (!isRecord(value) || !isUsage(value.usage) || !isRecord(value.message)) return false;
  const message = value.message;
  return (
    message.role === "assistant" &&
    typeof message.content === "string" &&
    optional(message.reasoning, (v) => typeof v === "string") &&
    optional(message.reasoningDetails, Array.isArray) &&
    optional(
      message.reasoningItems,
      (v) => isRecord(v) && typeof v.provider === "string" && Array.isArray(v.items),
    ) &&
    optional(message.toolCalls, (v) => Array.isArray(v) && v.every(isCall)) &&
    [null, "stop", "length", "tool_calls", "content_filter"].some(
      (v) => v === value.finishReason,
    ) &&
    optional(
      value.source,
      (v) => isRecord(v) && typeof v.provider === "string" && typeof v.model === "string",
    )
  );
}

export function readTurn(value: unknown): Turn {
  if (!serializable(value) || !isTurn(value))
    throw new TypeError("The provider returned an invalid or unsavable turn.");
  const ids = value.message.toolCalls?.map((call) => call.id) ?? [];
  if (new Set(ids).size !== ids.length)
    throw new TypeError("The provider reused a tool-call ID within one turn.");
  return copyData(value);
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    isRecord(value) &&
    typeof value.content === "string" &&
    (value.ok === true
      ? value.kind === undefined
      : value.ok === false &&
        ["invalid_input", "timeout", "aborted", "failed", "denied", "unknown_tool"].some(
          (kind) => kind === value.kind,
        ))
  );
}

function isToolExecution(value: unknown): value is ToolExecution {
  if (!isRecord(value) || !isId(value.id)) return false;
  return (
    value.status === "pending" ||
    (isId(value.attemptId) &&
      (value.status === "running" || (value.status === "completed" && isToolResult(value.result))))
  );
}

function isModel(value: unknown): value is ModelExecution {
  if (!isRecord(value) || !isId(value.id) || !isId(value.attemptId) || !isUsage(value.usage))
    return false;
  return (
    value.status === "running" ||
    (value.status === "completed" &&
      isTurn(value.turn) &&
      Array.isArray(value.tools) &&
      value.tools.every(isToolExecution))
  );
}

function isState(value: unknown): value is RunState {
  if (!isRecord(value)) return false;
  switch (value.status) {
    case "running":
    case "cancelled":
      return true;
    case "completed":
      return serializable(value.candidate);
    case "suspended":
      return isApproval(value.approval);
    case "limited":
      return ["turns", "toolCalls", "elapsedMs", "outputTokens"].some((v) => v === value.limit);
    case "failed":
      return (
        isRecord(value.error) &&
        isId(value.error.code) &&
        isId(value.error.message) &&
        optional(value.error.operationId, isId)
      );
    default:
      return false;
  }
}

function isSnapshot(value: unknown): value is RunSnapshot {
  return (
    isRecord(value) &&
    value.format === 1 &&
    [value.agentId, value.version, value.runId, value.attemptId, value.input].every(isId) &&
    positive(value.startedAt) &&
    isLimits(value.limits) &&
    Array.isArray(value.models) &&
    value.models.every(isModel) &&
    isState(value.state)
  );
}

export function modelId(runId: string, index: number): string {
  return `${runId}/model/${index + 1}`;
}

export function toolId(model: string, index: number): string {
  return `${model}/tool/${index + 1}`;
}

/** Validate the journal as well as its fields, so a cursor cannot skip unrecorded work. */
export function readSnapshot(
  raw: unknown,
  agentId: string,
  version: string,
  limits: RunLimits,
  resultTool?: string,
): RunSnapshot {
  if (!serializable(raw) || !isSnapshot(raw)) throw new TypeError("Invalid agent snapshot.");
  if (raw.agentId !== agentId || raw.version !== version)
    throw new TypeError("The snapshot belongs to a different agent definition or version.");
  if (!equalData(raw.limits, limits))
    throw new TypeError("The snapshot limits do not match this agent version.");
  let calls = 0;
  for (const [index, model] of raw.models.entries()) {
    if (model.id !== modelId(raw.runId, index))
      throw new TypeError("Invalid model operation identity.");
    const last = index === raw.models.length - 1;
    if (model.status === "running") {
      if (!last) throw new TypeError("A model operation has an unknown outcome before later work.");
      continue;
    }
    readTurn(model.turn);
    const tools = model.turn.message.toolCalls ?? [];
    if (tools.length !== model.tools.length)
      throw new TypeError("The tool journal does not match the model turn.");
    if (!equalData(model.usage, model.turn.usage))
      throw new TypeError("The model usage does not match its completed turn.");
    let pending = false;
    for (const [position, tool] of model.tools.entries()) {
      if (
        tool.id !== toolId(model.id, position) ||
        (!last && tool.status !== "completed") ||
        (pending && tool.status !== "pending")
      ) {
        throw new TypeError("Invalid tool operation position.");
      }
      const call = tools[position];
      if (
        !call ||
        (tool.status === "completed" && tool.result.ok && !completeArguments(call.arguments))
      ) {
        throw new TypeError("A successful tool result must have complete arguments.");
      }
      if (
        tool.status !== "pending" &&
        model.turn.finishReason !== "stop" &&
        model.turn.finishReason !== "tool_calls"
      ) {
        throw new TypeError("An unfinished model turn cannot have executed tools.");
      }
      pending ||= tool.status === "pending";
      if (tool.status !== "pending") calls++;
    }
    if (
      !last &&
      (tools.length === 0 ||
        model.turn.finishReason === null ||
        model.turn.finishReason === "length" ||
        model.turn.finishReason === "content_filter" ||
        (tools.length === 1 &&
          tools[0]?.name === resultTool &&
          model.tools[0]?.status === "completed" &&
          model.tools[0].result.ok))
    ) {
      throw new TypeError("A finished model turn cannot have later work.");
    }
  }
  if (raw.models.length > limits.turns || calls > limits.toolCalls)
    throw new TypeError("The snapshot exceeds this agent's limits.");
  const last = raw.models.at(-1);
  if (raw.state.status === "completed") {
    if (
      last?.status !== "completed" ||
      last.tools.some((tool) => tool.status !== "completed") ||
      last.turn.finishReason === null ||
      last.turn.finishReason === "length" ||
      last.turn.finishReason === "content_filter"
    ) {
      throw new TypeError("A completed run must have a completed final turn.");
    }
    const tools = last.turn.message.toolCalls ?? [];
    let candidate: unknown;
    if (resultTool) {
      if (
        tools.length === 1 &&
        tools[0]?.name === resultTool &&
        last.tools[0]?.status === "completed" &&
        last.tools[0].result.ok
      ) {
        candidate = parseToolArgs(tools[0].arguments);
      }
    } else if (tools.length === 0 && last.turn.message.content.trim()) {
      candidate = last.turn.message.content;
    }
    if (candidate === undefined || !equalData(candidate, raw.state.candidate)) {
      throw new TypeError("The completed result does not match its recorded turn.");
    }
  }
  if (raw.state.status === "suspended") {
    if (last?.status !== "completed")
      throw new TypeError("The approval does not match the pending tool call.");
    const { request } = raw.state.approval;
    const position = last.tools.findIndex((tool) => tool.status !== "completed");
    const call = last.turn.message.toolCalls?.[position];
    const tool = last.tools[position];
    if (
      !call ||
      !completeArguments(call.arguments) ||
      (last.turn.finishReason !== "stop" && last.turn.finishReason !== "tool_calls") ||
      tool?.status !== "pending" ||
      request.runId !== raw.runId ||
      request.agentId !== agentId ||
      request.version !== version ||
      request.operationId !== tool.id ||
      !equalData(request.call, call) ||
      !equalData(request.arguments, parseToolArgs(call.arguments))
    ) {
      throw new TypeError("The approval does not match the pending tool call.");
    }
  }
  return copyData(raw);
}
