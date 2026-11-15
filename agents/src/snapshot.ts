import { parseToolArgs, type TokenUsage, type ToolCall, type Turn } from "@providerkit/core";
import type {
  ApprovalScope,
  ChildPathStep,
  DelegationExecution,
  ModelExecution,
  PendingApproval,
  RunLimits,
  RunOptions,
  RunSnapshot,
  RunState,
  ToolExecution,
  ToolRequest,
  ToolResult,
  TreeLimits,
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
export function equalData(left: unknown, right: unknown): boolean {
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

export function readTreeLimits(value: unknown = {}): TreeLimits {
  if (!isRecord(value)) throw new TypeError("Tree limits must be an object.");
  const limits = {
    maxParallel: value.maxParallel ?? 4,
    maxChildren: value.maxChildren ?? 32,
    maxDepth: value.maxDepth ?? 4,
    modelCalls: value.modelCalls ?? 128,
    elapsedMs: value.elapsedMs ?? 300_000,
  };
  if (!isTreeLimits(limits))
    throw new TypeError("Tree limits must be finite integers; elapsedMs must fit a timer.");
  return limits;
}

function isTreeLimits(value: unknown): value is TreeLimits {
  return (
    isRecord(value) &&
    positive(value.maxParallel) &&
    finite(value.maxChildren) &&
    Number.isSafeInteger(value.maxChildren) &&
    finite(value.maxDepth) &&
    Number.isSafeInteger(value.maxDepth) &&
    positive(value.modelCalls) &&
    positive(value.elapsedMs) &&
    value.elapsedMs <= 2_147_483_647
  );
}

function isPath(value: unknown): value is ChildPathStep[] {
  return (
    Array.isArray(value) &&
    value.every((step) => isRecord(step) && [step.operationId, step.key, step.runId].every(isId))
  );
}

export function checkOptions(value: unknown): asserts value is RunOptions {
  if (
    !isRecord(value) ||
    !optional(value.runId, isId) ||
    !optional(value.signal, (signal) => signal instanceof AbortSignal) ||
    !optional(value.context, isRecord) ||
    !optional(value.onEvent, (fn) => typeof fn === "function") ||
    !optional(value.approvalPath, isPath)
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
      "child",
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
      (value.status === "running" ||
        value.status === "delegating" ||
        (value.status === "completed" && isToolResult(value.result))))
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
      return isApproval(value.approval) && isPath(value.path);
    case "limited":
      return [
        "turns",
        "toolCalls",
        "elapsedMs",
        "outputTokens",
        "maxChildren",
        "maxDepth",
        "modelCalls",
        "treeElapsedMs",
      ].some((v) => v === value.limit);
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

function isDelegationJournal(value: unknown): value is DelegationExecution {
  return (
    isRecord(value) &&
    isId(value.operationId) &&
    Array.isArray(value.children) &&
    value.children.every(
      (child) =>
        isRecord(child) &&
        isId(child.key) &&
        optional(child.reference, isId) &&
        isSnapshot(child.snapshot),
    )
  );
}

function isSnapshot(value: unknown): value is RunSnapshot {
  return (
    isRecord(value) &&
    value.format === 2 &&
    [value.agentId, value.version, value.runId, value.attemptId, value.input].every(isId) &&
    positive(value.startedAt) &&
    isLimits(value.limits) &&
    Array.isArray(value.models) &&
    value.models.every(isModel) &&
    Array.isArray(value.delegations) &&
    value.delegations.every(isDelegationJournal) &&
    isRecord(value.tree) &&
    isId(value.tree.runId) &&
    positive(value.tree.startedAt) &&
    isTreeLimits(value.tree.limits) &&
    isState(value.state)
  );
}

export function modelId(runId: string, index: number): string {
  return `${runId}/model/${index + 1}`;
}

export function toolId(model: string, index: number): string {
  return `${model}/tool/${index + 1}`;
}

export function childRunId(operationId: string, key: string): string {
  return `${operationId}/child/${encodeURIComponent(key)}`;
}

/** Check global reservations from saved local journals, including work not yet sent. */
export function checkTree(root: RunSnapshot): void {
  let children = 0;
  let models = 0;
  function visit(node: RunSnapshot, depth: number): void {
    if (!equalData(node.tree, root.tree) || node.startedAt < root.tree.startedAt)
      throw new TypeError("The child belongs to a different tree or deadline.");
    if (depth > root.tree.limits.maxDepth) throw new TypeError("The tree exceeds its depth limit.");
    models += node.models.length;
    if (
      new Set(node.delegations.map((journal) => journal.operationId)).size !==
      node.delegations.length
    )
      throw new TypeError("Duplicate delegation journal.");
    for (const journal of node.delegations) {
      const tool = node.models
        .flatMap((model) => (model.status === "completed" ? model.tools : []))
        .find((tool) => tool.id === journal.operationId);
      if (!tool || (tool.status !== "delegating" && tool.status !== "completed"))
        throw new TypeError("The delegation journal does not match its tool call.");
      if (new Set(journal.children.map((child) => child.key)).size !== journal.children.length)
        throw new TypeError("Duplicate child key.");
      for (const child of journal.children) {
        if (
          child.snapshot.runId !== childRunId(journal.operationId, child.key) ||
          child.snapshot.startedAt < node.startedAt
        )
          throw new TypeError("Invalid child identity or start time.");
        if (
          (tool.status === "completed" || node.state.status === "completed") &&
          (child.snapshot.state.status === "running" || child.snapshot.state.status === "suspended")
        )
          throw new TypeError("A completed delegation cannot contain unfinished children.");
        children++;
        visit(child.snapshot, depth + 1);
      }
    }
    for (const model of node.models) {
      if (
        model.status === "completed" &&
        model.tools.some(
          (tool) =>
            tool.status === "delegating" &&
            !node.delegations.some((journal) => journal.operationId === tool.id),
        )
      )
        throw new TypeError("A delegation is missing its child journal.");
    }
  }
  if (root.runId === root.tree.runId && root.startedAt !== root.tree.startedAt)
    throw new TypeError("The root start time does not match its tree.");
  visit(root, 0);
  if (children > root.tree.limits.maxChildren || models > root.tree.limits.modelCalls)
    throw new TypeError("The snapshot exceeds its tree limits.");
}

/** A host cache may fill a missing receipt, never erase or replace a known effect. */
export function checkChildProgress(previous: RunSnapshot, next: RunSnapshot): void {
  if (
    previous.runId !== next.runId ||
    previous.input !== next.input ||
    previous.startedAt !== next.startedAt ||
    previous.agentId !== next.agentId ||
    previous.version !== next.version ||
    !equalData(previous.tree, next.tree)
  )
    throw new TypeError("The child host returned a different child.");
  if (previous.models.length > next.models.length)
    throw new TypeError("The child host dropped saved model receipts.");
  if (
    previous.state.status !== "running" &&
    previous.state.status !== "suspended" &&
    !equalData(previous.state, next.state)
  )
    throw new TypeError("The child host replaced a settled outcome.");
  for (const [index, model] of previous.models.entries()) {
    const saved = next.models[index];
    if (!saved || saved.id !== model.id || saved.attemptId !== model.attemptId)
      throw new TypeError("The child host changed a model operation.");
    if (model.status !== "completed") continue;
    if (saved.status !== "completed" || !equalData(model.turn, saved.turn))
      throw new TypeError("The child host replaced a completed model receipt.");
    for (const [position, tool] of model.tools.entries()) {
      const restored = saved.tools[position];
      if (
        !restored ||
        (tool.status === "completed" && !equalData(tool, restored)) ||
        (tool.status === "running" &&
          (restored.status === "pending" ||
            restored.status === "delegating" ||
            restored.attemptId !== tool.attemptId))
      )
        throw new TypeError("The child host replaced a tool receipt.");
    }
  }
  for (const journal of previous.delegations) {
    const saved = next.delegations.find((entry) => entry.operationId === journal.operationId);
    if (!saved || saved.children.length < journal.children.length)
      throw new TypeError("The child host dropped a delegation receipt.");
    for (const [index, child] of journal.children.entries()) {
      const restored = saved.children[index];
      if (!restored || restored.key !== child.key)
        throw new TypeError("The child host changed child admission order.");
      checkChildProgress(child.snapshot, restored.snapshot);
    }
  }
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
  checkTree(raw);
  if (raw.state.status === "suspended") {
    let leaf = raw;
    for (const [index, step] of raw.state.path.entries()) {
      const journal = leaf.delegations.find((journal) => journal.operationId === step.operationId);
      const child = journal?.children.find((child) => child.key === step.key);
      if (
        !child ||
        child.snapshot.runId !== step.runId ||
        child.snapshot.state.status !== "suspended" ||
        !equalData(child.snapshot.state.path, raw.state.path.slice(index + 1)) ||
        !equalData(child.snapshot.state.approval, raw.state.approval)
      )
        throw new TypeError("The approval path does not match a suspended child.");
      leaf = child.snapshot;
    }
    if (
      leaf.state.status !== "suspended" ||
      leaf.state.path.length !== 0 ||
      !equalData(leaf.state.approval, raw.state.approval)
    )
      throw new TypeError("The approval path does not match the leaf decision.");
    const last = leaf.models.at(-1);
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
      request.runId !== leaf.runId ||
      request.agentId !== leaf.agentId ||
      request.version !== leaf.version ||
      request.operationId !== tool.id ||
      !equalData(request.call, call) ||
      !equalData(request.arguments, parseToolArgs(call.arguments))
    ) {
      throw new TypeError("The approval does not match the pending tool call.");
    }
  }
  return copyData(raw);
}
