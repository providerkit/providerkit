import {
  isEffort,
  parseToolArgs,
  type ChatMessage,
  type FileMimeType,
  type ImageMimeType,
  type ImagePart,
  type TokenUsage,
  type ToolCall,
  type Turn,
} from "@providerkit/core";
import { isRecoveryDefinition } from "./recovery.ts";
import { checkDecision, isAsk } from "./request.ts";
import type {
  AgentMessage,
  RequestScope,
  AskRecord,
  ChildPathStep,
  DelegationExecution,
  InputPart,
  ModelExecution,
  ModelSettings,
  PendingRequest,
  RecordedModelSettings,
  RunDefinition,
  RunFailure,
  RunLimits,
  RunOptions,
  RunSnapshot,
  RunState,
  Session,
  SessionStatus,
  ToolExecution,
  ToolRequest,
  ToolResult,
  TreeLimits,
  UserContent,
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
    inlineBytes: value.inlineBytes ?? 5_000_000,
  };
  if (!isLimits(limits)) {
    throw new TypeError(
      "Agent limits must be positive finite integers (inlineBytes may be 0); elapsedMs must fit a timer.",
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
    positive(value.parallelTools) &&
    finite(value.inlineBytes) &&
    Number.isSafeInteger(value.inlineBytes)
  );
}

const IMAGE_TYPES: readonly ImageMimeType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export function isImageMime(value: unknown): value is ImageMimeType {
  return IMAGE_TYPES.some((type) => type === value);
}

/** Core's file types, with an RFC 6838 subtype and no parameters, so the value a provider
 * receives is the plain media type it documents. */
export function isFileMime(value: unknown): value is FileMimeType {
  return (
    typeof value === "string" &&
    /^(?:application|audio|video|text)\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(value)
  );
}

// Ported from TanStack AI (MIT), packages/ai-harness/src/inline-media.ts: check base64 and
// count its bytes from the length, without decoding. Stricter here: no whitespace and padded
// to a multiple of four, because the text goes to the provider exactly as given.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function isBase64(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length % 4 === 0 && BASE64.test(value)
  );
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** Decoded bytes of every inline image and file: user parts and tool images alike. */
export function inlineBytes(history: readonly AgentMessage[], input: UserContent): number {
  let total = 0;
  const count = (parts: readonly InputPart[]) => {
    for (const part of parts)
      if (part.type === "image" || part.type === "file") total += decodedBytes(part.data);
  };
  for (const message of history) {
    if (message.role === "user" && typeof message.content !== "string") count(message.content);
    if (message.role === "tool" && message.images) count(message.images);
  }
  if (typeof input !== "string") count(input);
  return total;
}

function isImage(value: unknown): value is ImagePart {
  return (
    isRecord(value) && value.type === "image" && isImageMime(value.mimeType) && isBase64(value.data)
  );
}

export function isPart(value: unknown): value is InputPart {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
      return isImage(value);
    case "file":
      return isFileMime(value.mimeType) && isBase64(value.data);
    case "media":
      return isId(value.id) && (isImageMime(value.mimeType) || isFileMime(value.mimeType));
    default:
      return false;
  }
}

/** A frozen new turn: non-empty text, or at least one part. */
export function isTurnContent(value: unknown): value is UserContent {
  return isId(value) || (Array.isArray(value) && value.length > 0 && value.every(isPart));
}

function isAssistant(value: unknown): value is Extract<ChatMessage, { role: "assistant" }> {
  return (
    isRecord(value) &&
    value.role === "assistant" &&
    typeof value.content === "string" &&
    optional(value.reasoning, (v) => typeof v === "string") &&
    optional(value.reasoningDetails, Array.isArray) &&
    optional(
      value.reasoningItems,
      (v) => isRecord(v) && typeof v.provider === "string" && Array.isArray(v.items),
    ) &&
    optional(value.toolCalls, (v) => Array.isArray(v) && v.every(isCall))
  );
}

/** Shape only. Who may send which message is the input normalizer's rule, not this one. */
export function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) return false;
  switch (value.role) {
    case "user":
      return (
        typeof value.content === "string" ||
        (Array.isArray(value.content) && value.content.every(isPart))
      );
    case "assistant":
      return isAssistant(value);
    case "tool":
      return (
        isId(value.toolCallId) &&
        isId(value.name) &&
        typeof value.content === "string" &&
        optional(value.images, (v) => Array.isArray(v) && v.every(isImage))
      );
    default:
      return false;
  }
}

function isFailure(value: unknown): value is RunFailure {
  return (
    isRecord(value) && isId(value.code) && isId(value.message) && optional(value.operationId, isId)
  );
}

export function isRevision(value: unknown): value is string | null {
  return value === null || isId(value);
}

function isSessionRef(value: unknown): value is NonNullable<RunSnapshot["session"]> {
  return isRecord(value) && isId(value.id) && isRevision(value.revision);
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !optional(value.asks, (v) => Array.isArray(v) && v.every(isAskRecord))
  )
    return false;
  return (
    value.status === "pending" ||
    (value.status === "saved" && isId(value.revision)) ||
    (value.status === "unsaved" && isFailure(value.error))
  );
}

export function isSession(value: unknown): value is Session {
  return (
    isRecord(value) &&
    isId(value.id) &&
    typeof value.load === "function" &&
    typeof value.append === "function"
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

export function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isId) && new Set(value).size === value.length;
}

export function isEnabledTools(value: unknown): boolean {
  return typeof value === "function" || isNames(value);
}

const MODEL_SETTINGS = {
  model: isId,
  maxAttempts: positive,
  effort: (value) => typeof value === "string" && isEffort(value),
  maxTokens: positive,
  temperature: finite,
  topP: (value) => finite(value) && value <= 1,
  stopSequences: (value) => Array.isArray(value) && value.every(isId),
  toolChoice: (value) =>
    ["auto", "none", "required"].some((choice) => choice === value) ||
    (isRecord(value) && isId(value.name) && Object.keys(value).length === 1),
  jsonWithTools: (value) => value === "prompt" || value === "response_format",
  parallelToolCalls: (value) => typeof value === "boolean",
  serviceTier: (value) => value === "priority" || value === "flex",
  onActivity: (value) => typeof value === "function",
  onRateLimit: (value) => typeof value === "function",
} satisfies Record<keyof ModelSettings, (value: unknown) => boolean>;

function isModelSettings(value: unknown): value is ModelSettings {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => Object.hasOwn(MODEL_SETTINGS, key)) &&
    Object.entries(MODEL_SETTINGS).every(([key, guard]) => optional(value[key], guard))
  );
}

export function isRecordedModelSettings(value: unknown): value is RecordedModelSettings {
  return (
    isModelSettings(value) && value.onActivity === undefined && value.onRateLimit === undefined
  );
}

export function readModelSettings(value: unknown = {}): ModelSettings {
  if (!isModelSettings(value))
    throw new TypeError(
      "Invalid modelSettings. Use core StreamOptions without signal, sessionId or json; the agent owns those fields.",
    );
  // Undefined means inherit, not erase a lower-precedence value. Keep observers outside the
  // JSON copy: they do not change the request and may close over process-local services.
  const defined = Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
  if (!isModelSettings(defined)) throw new TypeError("Invalid modelSettings.");
  const { onActivity, onRateLimit, ...data } = defined;
  return {
    ...copyData(data),
    ...(onActivity ? { onActivity } : {}),
    ...(onRateLimit ? { onRateLimit } : {}),
  };
}

function isRunDefinition(value: unknown): value is RunDefinition {
  return (
    isRecord(value) &&
    typeof value.instructions === "string" &&
    isRecordedModelSettings(value.modelSettings) &&
    isNames(value.enabledTools) &&
    isNames(value.stopAtTools) &&
    isRecoveryDefinition(value.recovery)
  );
}

export function checkOptions(
  value: unknown,
  use: "run" | "resume" = "run",
): asserts value is RunOptions {
  if (
    !isRecord(value) ||
    !optional(value.runId, isId) ||
    !optional(value.signal, (signal) => signal instanceof AbortSignal) ||
    !optional(value.context, isRecord) ||
    !optional(value.onEvent, (fn) => typeof fn === "function") ||
    !optional(value.answers, isRecord)
  ) {
    throw new TypeError("Invalid run options.");
  }
  if (!optional(value.session, isSession))
    throw new TypeError("A session needs an id and load and append functions.");
  if (!optional(value.historyLimit, positive))
    throw new TypeError("historyLimit must be a positive whole number.");
  if (!optional(value.prepareHistory, (fn) => typeof fn === "function"))
    throw new TypeError("prepareHistory must be a function.");
  if (!optional(value.enabledTools, isEnabledTools))
    throw new TypeError(
      "enabledTools must be an allow-list of unique tool names, or a function returning one.",
    );
  if (value.modelSettings !== undefined) readModelSettings(value.modelSettings);
  // ResumeOptions leaves these out, but a JavaScript caller can still pass them. Say so,
  // rather than ignore a value someone set.
  if (
    use === "resume" &&
    [value.historyLimit, value.prepareHistory, value.modelSettings, value.enabledTools].some(
      (item) => item !== undefined,
    )
  )
    throw new TypeError(
      "historyLimit, prepareHistory, modelSettings and enabledTools apply when a run starts. A resumed run keeps its recorded history and definition.",
    );
  if (value.host !== undefined) {
    if (!isRecord(value.host)) throw new TypeError("The run host must be an object.");
    for (const key of [
      "checkpoint",
      "authorizeResume",
      "prepareRequest",
      "resolveRequest",
      "needsApproval",
      "answerNow",
      "beforeTool",
      "canRunConcurrently",
      "child",
      "loadMedia",
    ]) {
      if (!optional(value.host[key], (fn) => typeof fn === "function")) {
        throw new TypeError(`host.${key} must be a function.`);
      }
    }
  }
}

export function isScope(value: unknown): value is RequestScope {
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

function isPendingRequest(value: unknown): value is PendingRequest {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isPath(value.path) &&
    isRequest(value.call) &&
    isScope(value.scope) &&
    isAsk(value.ask) &&
    positive(value.createdAt) &&
    typeof value.definitionHash === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.definitionHash)
  );
}

function isAskRecord(value: unknown): value is AskRecord {
  if (
    !isRecord(value) ||
    !isPendingRequest(value.request) ||
    !optional(value.closed, (v) =>
      ["expired", "stale", "invalid", "stopped"].includes(String(v)),
    ) ||
    !optional(
      value.problem,
      (v) =>
        isRecord(v) &&
        ["expired", "stale", "invalid_answer", "refused"].includes(String(v.code)) &&
        isId(v.message),
    )
  )
    return false;
  if (value.decision !== undefined) {
    try {
      checkDecision(value.request.ask, value.decision);
    } catch {
      return false;
    }
  }
  return true;
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
  if (!isRecord(value) || !isUsage(value.usage)) return false;
  return (
    isAssistant(value.message) &&
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
      ? value.kind === undefined &&
        optional(value.final, (final) => isRecord(final) && serializable(final.candidate))
      : value.ok === false &&
        value.final === undefined &&
        [
          "invalid_input",
          "timeout",
          "aborted",
          "failed",
          "denied",
          "cancelled",
          "unknown_tool",
          "disabled_tool",
          "invalid_output",
        ].some((kind) => kind === value.kind))
  );
}

function isInterrupted(value: unknown): value is { attemptId: string }[] {
  return (
    Array.isArray(value) &&
    value.every((attempt) => isRecord(attempt) && isId(attempt.attemptId)) &&
    new Set(value.map((attempt) => attempt.attemptId)).size === value.length
  );
}

function isToolExecution(value: unknown): value is ToolExecution {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isInterrupted(value.interrupted) ||
    value.interrupted.some((attempt) => attempt.attemptId === value.attemptId) ||
    !optional(value.asks, (v) => Array.isArray(v) && v.every(isAskRecord))
  )
    return false;
  return (
    value.status === "pending" ||
    (isId(value.attemptId) &&
      (value.status === "running" ||
        value.status === "delegating" ||
        (value.status === "completed" && isToolResult(value.result))))
  );
}

function isModel(value: unknown): value is ModelExecution {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.attemptId) ||
    !isUsage(value.usage) ||
    (value.billing !== "unknown" && value.billing !== "reported") ||
    (value.status === "running" && value.billing !== "unknown") ||
    !isInterrupted(value.interrupted) ||
    value.interrupted.some(
      (attempt) =>
        attempt.attemptId === value.attemptId || !("usage" in attempt) || !isUsage(attempt.usage),
    )
  )
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
      return Object.keys(value).length === 1;
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
      return isFailure(value.error);
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

/** Format 3 only. A format 2 snapshot from 0.1.0 has no reader: it is refused, not migrated. */
function isSnapshot(value: unknown): value is RunSnapshot {
  return (
    isRecord(value) &&
    value.format === 3 &&
    [value.agentId, value.version, value.runId, value.attemptId].every(isId) &&
    positive(value.startedAt) &&
    isRunDefinition(value.definition) &&
    Array.isArray(value.history) &&
    value.history.every(isAgentMessage) &&
    isTurnContent(value.input) &&
    optional(value.session, isSessionRef) &&
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
  function visit(node: RunSnapshot, depth: number, path: ChildPathStep[]): void {
    if (!equalData(node.tree, root.tree) || node.startedAt < root.tree.startedAt)
      throw new TypeError("The child belongs to a different tree or deadline.");
    if (depth > root.tree.limits.maxDepth) throw new TypeError("The tree exceeds its depth limit.");
    models += node.models.reduce((total, model) => total + 1 + model.interrupted.length, 0);
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
        visit(child.snapshot, depth + 1, [
          ...path,
          { operationId: journal.operationId, key: child.key, runId: child.snapshot.runId },
        ]);
      }
    }
    for (const model of node.models) {
      if (model.status === "completed" && root.runId === root.tree.runId)
        for (const tool of model.tools)
          for (const record of tool.asks ?? [])
            if (!equalData(record.request.path, path))
              throw new TypeError("The request path does not match its owning call.");
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
  visit(root, 0, []);
  if (children > root.tree.limits.maxChildren || models > root.tree.limits.modelCalls)
    throw new TypeError("The snapshot exceeds its tree limits.");
}

/** A later attempt must retain the exact measurements and identity of every lost attempt. */
function checkAttemptProgress(
  previous: {
    attemptId?: string;
    interrupted: { attemptId: string; usage?: TokenUsage }[];
    usage?: TokenUsage;
  },
  next: { attemptId?: string; interrupted: { attemptId: string; usage?: TokenUsage }[] },
): void {
  if (previous.interrupted.some((attempt, index) => !equalData(attempt, next.interrupted[index])))
    throw new TypeError("The host erased or replaced interrupted attempts.");
  if (!previous.attemptId) return;
  if (previous.attemptId === next.attemptId) {
    if (previous.interrupted.length !== next.interrupted.length)
      throw new TypeError("The host changed a current attempt's history.");
  } else if (
    !equalData(next.interrupted[previous.interrupted.length], {
      attemptId: previous.attemptId,
      ...(previous.usage ? { usage: previous.usage } : {}),
    })
  )
    throw new TypeError("The host changed an attempt without retaining its receipt.");
}

/** A host cache may fill a missing receipt, never erase or replace a known effect. */
export function checkChildProgress(previous: RunSnapshot, next: RunSnapshot): void {
  if (
    previous.runId !== next.runId ||
    !equalData(previous.definition, next.definition) ||
    !equalData(previous.history, next.history) ||
    !equalData(previous.input, next.input) ||
    !equalData(previous.session, next.session) ||
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
    if (!saved || saved.id !== model.id)
      throw new TypeError("The child host changed a model operation.");
    checkAttemptProgress(model, saved);
    if (model.status !== "completed") continue;
    if (
      saved.status !== "completed" ||
      saved.attemptId !== model.attemptId ||
      saved.billing !== model.billing ||
      !equalData(model.turn, saved.turn)
    )
      throw new TypeError("The child host replaced a completed model receipt.");
    for (const [position, tool] of model.tools.entries()) {
      const restored = saved.tools[position];
      for (const [index, ask] of (tool.asks ?? []).entries()) {
        const nextAsk = restored?.asks?.[index];
        if (
          !nextAsk ||
          !equalData(ask.request, nextAsk.request) ||
          (ask.decision && !equalData(ask.decision, nextAsk.decision)) ||
          (ask.closed && ask.closed !== nextAsk.closed)
        )
          throw new TypeError("The child host erased or replaced a request receipt.");
      }
      if (
        !restored ||
        (tool.status === "completed" && !equalData(tool, restored)) ||
        (tool.status === "running" && restored.status === "delegating")
      )
        throw new TypeError("The child host replaced a tool receipt.");
      // Pure coordination already replays across approval resumes. It has no external
      // attempt to retain; its children carry the effect receipts checked below.
      if (tool.status !== "delegating") checkAttemptProgress(tool, restored);
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

/** The selected result is journal data, not a second invocation of the tool. Model order
 * wins even when a later tool in a parallel batch finishes first. */
export function finalToolResult(
  model: Extract<ModelExecution, { status: "completed" }>,
  stopAtTools: readonly string[],
  resultTool?: string,
): { candidate: unknown } | undefined {
  const calls = model.turn.message.toolCalls ?? [];
  for (const [index, call] of calls.entries()) {
    const tool = model.tools[index];
    if (tool?.status !== "completed" || !tool.result.ok) continue;
    if (calls.length === 1 && call.name === resultTool)
      return { candidate: parseToolArgs(call.arguments) };
    if (stopAtTools.includes(call.name) && tool.result.final) return tool.result.final;
  }
  return undefined;
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
    if (
      model.interrupted.length &&
      (!raw.definition.recovery?.policy.inferenceOnly ||
        model.interrupted.length >= raw.definition.recovery.policy.maxAttempts)
    )
      throw new TypeError("Model attempts exceed the recorded recovery policy.");
    const last = index === raw.models.length - 1;
    // A plain-text run gets one last answer with no tools. It is still a model operation
    // counted by the tree. No receipt on that extra turn may claim a tool was executed.
    if (
      index >= limits.turns &&
      (resultTool ||
        index !== limits.turns ||
        (model.status === "completed" && model.tools.some((tool) => tool.status !== "pending")))
    )
      throw new TypeError(
        "The final tool-free turn cannot execute tools or exceed the turn allowance.",
      );
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
        (pending && tool.status !== "pending" && !tool.asks?.length && !tool.interrupted.length)
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
      if (tool.status === "completed" && tool.result.ok) {
        if (
          !raw.definition.enabledTools.includes(call.name) ||
          raw.definition.modelSettings.toolChoice === "none"
        )
          throw new TypeError("A disabled tool cannot have a successful result.");
        if (tool.result.final && !raw.definition.stopAtTools.includes(call.name))
          throw new TypeError("This tool is not configured to produce a final result.");
        if (raw.definition.stopAtTools.includes(call.name) && !tool.result.final)
          throw new TypeError("A successful stopping tool must record its final result.");
      }
      const keys = new Set<string>();
      const originalArguments = parseToolArgs(call.arguments);
      let clientArguments = originalArguments;
      for (const [askIndex, record] of (tool.asks ?? []).entries()) {
        const request = record.request;
        if (
          request.id !== `${tool.id}/ask/${askIndex + 1}` ||
          request.call.operationId !== tool.id ||
          request.call.runId !== raw.runId ||
          request.call.agentId !== raw.agentId ||
          request.call.version !== raw.version ||
          !equalData(request.call.call, call) ||
          !completeArguments(call.arguments) ||
          !equalData(
            request.call.arguments,
            request.ask.type === "client" ? clientArguments : originalArguments,
          ) ||
          request.createdAt < raw.startedAt ||
          (tool.status === "completed" && !record.closed && !record.decision)
        )
          throw new TypeError("The request does not match its journaled tool call.");
        // A dispatch keeps the approval that preceded it, even if that approval later expired.
        if (request.ask.type === "approval")
          clientArguments =
            record.decision?.type === "approve"
              ? (record.decision.arguments ?? originalArguments)
              : originalArguments;
        if (!record.closed) {
          const key =
            request.ask.type === "question" ? `question:${request.ask.key}` : request.ask.type;
          if (keys.has(key)) throw new TypeError("A call has duplicate open request keys.");
          keys.add(key);
        }
      }
      if (
        tool.interrupted.length &&
        (!raw.definition.recovery?.policy.readOnlyTools?.includes(call.name) ||
          tool.interrupted.length + (tool.status === "pending" ? 0 : 1) >
            raw.definition.recovery.policy.maxAttempts ||
          tool.status === "delegating")
      )
        throw new TypeError("Tool attempts exceed the recorded recovery policy.");
      pending ||= tool.status === "pending" && !tool.asks?.length && !tool.interrupted.length;
      calls += tool.interrupted.length;
      if (tool.status !== "pending" || tool.asks?.length) calls++;
    }
    if (
      !last &&
      (tools.length === 0 ||
        model.turn.finishReason === null ||
        model.turn.finishReason === "length" ||
        model.turn.finishReason === "content_filter" ||
        finalToolResult(model, raw.definition.stopAtTools, resultTool))
    ) {
      throw new TypeError("A finished model turn cannot have later work.");
    }
  }
  if (
    raw.models.length > limits.turns + (resultTool ? 0 : 1) ||
    calls > limits.toolCalls ||
    inlineBytes(raw.history, raw.input) > limits.inlineBytes
  )
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
    const final = finalToolResult(last, raw.definition.stopAtTools, resultTool);
    const candidate = final
      ? final.candidate
      : !resultTool && tools.length === 0 && last.turn.message.content.trim()
        ? last.turn.message.content
        : undefined;
    if (candidate === undefined || !equalData(candidate, raw.state.candidate)) {
      throw new TypeError("The completed result does not match its recorded turn.");
    }
  }
  checkTree(raw);
  if (
    raw.state.status === "suspended" &&
    !raw.models.some(
      (model) =>
        model.status === "completed" &&
        model.tools.some(
          (tool) =>
            tool.status !== "completed" && (tool.asks?.length || tool.status === "delegating"),
        ),
    )
  )
    throw new TypeError("A suspended run needs a journaled request or delegation.");
  return copyData(raw);
}
