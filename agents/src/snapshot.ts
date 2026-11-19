import { isRemoteSnapshot, checkRemoteSnapshot, checkRemoteProgress } from "./a2a/remote.ts";
import {
  isWorkflowSnapshot,
  checkWorkflowSnapshot,
  checkWorkflowProgress,
} from "./workflow-snapshot.ts";
import { CODE_LIMITS, programJson, textBytes, type CodeTool } from "./code.ts";
import type { TreeNode, WorkflowSnapshot, StepRequest, ProgramCall } from "./types.ts";
import {
  HOSTED_TOOL_TYPES,
  isEffort,
  parseToolArgs,
  type ChatMessage,
  type FileMimeType,
  type HostedTool,
  type ImageMimeType,
  type ImagePart,
  type TokenUsage,
  type ToolCall,
  type Turn,
} from "@providerkit/core";
import {
  checkMemorySnapshot,
  isMemoryPolicy,
  isMemoryRecall,
  isMemoryScopes,
  readMemoryBinding,
} from "./memory.ts";
import { allModels, checkCompactions, isCompactionDefinition } from "./compaction.ts";
import { isSubagentRecord } from "./subagents.ts";
import { isToolRetryDefinition, retryBudget, toolAttempts } from "./tool-retry.ts";
import { GUARD_STAGES } from "./extensions.ts";
import { INPUT_LIMITS, inputBytes, readQueuedInput, type RunInput } from "./steering.ts";
import { isRecoveryDefinition } from "./recovery.ts";
import { checkDecision, isAsk } from "./request.ts";
import type {
  AgentMessage,
  RequestScope,
  AskRecord,
  ChildPathStep,
  CompactionExecution,
  RetriedToolAttempt,
  DelegationExecution,
  GuardDefinition,
  GuardRecord,
  GuardStage,
  InputPart,
  ModelExecution,
  ModelSettings,
  PendingRequest,
  RecordedModelSettings,
  RecordedCodeTool,
  RunDefinition,
  RunFailure,
  RunLimits,
  RunOptions,
  RunSnapshot,
  RunState,
  Session,
  SessionStatus,
  ToolCost,
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
    ...(value.costUsd !== undefined ? { costUsd: value.costUsd } : {}),
  };
  if (!isLimits(limits)) {
    throw new TypeError(
      "Agent limits must be positive finite integers (inlineBytes may be 0, and costUsd is a finite USD amount of 0 or more); elapsedMs must fit a timer.",
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
    Number.isSafeInteger(value.inlineBytes) &&
    optional(value.costUsd, finite)
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

/** All retained inline media, including results of a partially settled tool batch. */
export function snapshotInlineBytes(snapshot: RunSnapshot): number {
  return inlineBytes(
    [
      ...snapshot.history,
      ...snapshot.inputs.map((input) => ({ role: "user" as const, content: input.content })),
      ...snapshot.models.flatMap((model) =>
        model.status === "completed"
          ? model.tools.flatMap((tool) =>
              tool.status === "completed" && tool.result.ok && tool.result.images
                ? [
                    {
                      role: "tool" as const,
                      name: "",
                      toolCallId: "",
                      content: "",
                      images: tool.result.images,
                    },
                  ]
                : [],
            )
          : [],
      ),
    ],
    snapshot.input,
  );
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

function isStringList(value: unknown): boolean {
  // Iteration visits sparse entries too: JSON would turn those holes into null.
  return Array.isArray(value) && [...value].every(isId);
}

// Snapshot shapes only. Core still decides which tools and fields a provider can send.
const HOSTED_SETTINGS = {
  web_search: {
    allowedDomains: (value) => optional(value, isStringList),
    blockedDomains: (value) => optional(value, isStringList),
    maxUses: (value) => value === 0 || optional(value, positive),
    userLocation: (value) =>
      optional(
        value,
        (location) =>
          isRecord(location) &&
          Object.keys(location).every((key) =>
            ["city", "region", "country", "timezone"].includes(key),
          ) &&
          Object.values(location).every((item) => optional(item, isId)),
      ),
  },
  web_fetch: {
    allowedDomains: (value) => optional(value, isStringList),
    blockedDomains: (value) => optional(value, isStringList),
    maxUses: (value) => value === 0 || optional(value, positive),
    maxContentTokens: (value) => optional(value, positive),
  },
  code_execution: {
    fileIds: (value) => optional(value, isStringList),
  },
  file_search: {
    storeIds: isStringList,
    maxResults: (value) => optional(value, positive),
  },
  image_generation: {
    size: (value) =>
      optional(value, (item) =>
        ["auto", "1024x1024", "1024x1536", "1536x1024"].some((size) => size === item),
      ),
    quality: (value) =>
      optional(value, (item) =>
        ["auto", "low", "medium", "high"].some((quality) => quality === item),
      ),
    format: (value) =>
      optional(value, (item) => ["png", "jpeg", "webp"].some((format) => format === item)),
    background: (value) =>
      optional(value, (item) =>
        ["auto", "opaque", "transparent"].some((background) => background === item),
      ),
  },
} satisfies {
  [Type in HostedTool["type"]]: Record<
    Exclude<keyof Extract<HostedTool, { type: Type }>, "type" | "optional">,
    (value: unknown) => boolean
  >;
};

function isHostedTools(value: unknown): value is readonly HostedTool[] {
  if (!Array.isArray(value) || !serializable(value)) return false;
  const seen = new Set<HostedTool["type"]>();
  for (const tool of value) {
    if (!isRecord(tool) || !optional(tool.optional, (item) => typeof item === "boolean"))
      return false;
    const type = HOSTED_TOOL_TYPES.find((type) => type === tool.type);
    if (!type || seen.has(type)) return false;
    seen.add(type);
    const guards = HOSTED_SETTINGS[type];
    if (
      !Object.keys(tool).every(
        (key) => key === "type" || key === "optional" || Object.hasOwn(guards, key),
      ) ||
      !Object.entries(guards).every(([key, guard]) => guard(tool[key]))
    )
      return false;
  }
  return true;
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
  hostedTools: isHostedTools,
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
      "Invalid modelSettings. Use core StreamOptions without signal, sessionId or json; the agent owns those fields. Name a provider session with the providerSessionId run option.",
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

function isGuardDefinition(value: unknown): value is GuardDefinition | null {
  return (
    value === null ||
    (isRecord(value) &&
      isId(value.identity) &&
      positive(value.maxOutputBytes) &&
      isNames(value.stages) &&
      value.stages.length > 0 &&
      value.stages.every((stage) => GUARD_STAGES.some((name) => name === stage)))
  );
}

function isGuardRecord(value: unknown): value is GuardRecord {
  return (
    isRecord(value) &&
    GUARD_STAGES.some((stage) => stage === value.stage) &&
    isId(value.operationId) &&
    isId(value.attemptId) &&
    typeof value.inputHash === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.inputHash) &&
    ["running", "allowed", "rejected", "failed"].some((status) => status === value.status)
  );
}

/** Record only validation data. Reading an archive must not construct executable tools. */
export function recordCodeTools(
  tools: ReadonlyMap<string, CodeTool>,
): Record<string, RecordedCodeTool> {
  return Object.fromEntries(
    [...tools].map(([name, code]) => [
      name,
      {
        name,
        limits: { ...code.limits },
        tools: code.tools.map((tool) => ({ name: tool.name, isReadOnly: tool.isReadOnly })),
      },
    ]),
  );
}

function isRecordedCodeTools(value: unknown): value is Record<string, RecordedCodeTool> {
  if (!isRecord(value)) return false;
  for (const [name, code] of Object.entries(value)) {
    if (
      !isId(name) ||
      !isRecord(code) ||
      code.name !== name ||
      Object.keys(code).some((key) => !["name", "limits", "tools"].includes(key)) ||
      !isRecord(code.limits) ||
      !Array.isArray(code.tools) ||
      !code.tools.length
    )
      return false;
    const limits = code.limits;
    if (
      Object.keys(limits).length !== Object.keys(CODE_LIMITS).length ||
      !Object.keys(CODE_LIMITS).every((key) => positive(limits[key])) ||
      typeof limits.timeoutMs !== "number" ||
      limits.timeoutMs > 2_147_483_647
    )
      return false;
    const names = new Set<string>();
    for (const tool of code.tools) {
      if (
        !isRecord(tool) ||
        !isId(tool.name) ||
        typeof tool.isReadOnly !== "boolean" ||
        Object.keys(tool).some((key) => key !== "name" && key !== "isReadOnly") ||
        names.has(tool.name)
      )
        return false;
      names.add(tool.name);
    }
  }
  return true;
}

function isRunDefinition(value: unknown): value is RunDefinition {
  return (
    isRecord(value) &&
    typeof value.instructions === "string" &&
    isRecordedModelSettings(value.modelSettings) &&
    optional(value.providerSessionId, isId) &&
    isNames(value.enabledTools) &&
    isNames(value.stopAtTools) &&
    optional(value.codeTools, isRecordedCodeTools) &&
    isGuardDefinition(value.guardrails) &&
    isCompactionDefinition(value.compaction) &&
    isToolRetryDefinition(value.toolRetries) &&
    optional(value.memory, isMemoryPolicy) &&
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
    !optional(value.onLifecycle, (fn) => typeof fn === "function") ||
    !optional(value.answers, isRecord)
  ) {
    throw new TypeError("Invalid run options.");
  }
  readMemoryBinding(value.memory);
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
  if (!optional(value.providerSessionId, isId))
    throw new TypeError("providerSessionId must be a non-empty string.");
  // ResumeOptions leaves these out, but a JavaScript caller can still pass them. Say so,
  // rather than ignore a value someone set.
  if (
    use === "resume" &&
    [
      value.historyLimit,
      value.prepareHistory,
      value.modelSettings,
      value.enabledTools,
      value.providerSessionId,
    ].some((item) => item !== undefined)
  )
    throw new TypeError(
      "historyLimit, prepareHistory, modelSettings, enabledTools and providerSessionId apply when a run starts. A resumed run keeps its recorded history and definition.",
    );
  if (value.host !== undefined) {
    if (!isRecord(value.host)) throw new TypeError("The run host must be an object.");
    if (
      value.host.inbox !== undefined &&
      (!isRecord(value.host.inbox) ||
        typeof value.host.inbox.poll !== "function" ||
        typeof value.host.inbox.acknowledge !== "function")
    )
      throw new TypeError("host.inbox needs poll and acknowledge functions.");
    for (const key of [
      "checkpoint",
      "authorizeResume",
      "prepareRequest",
      "resolveRequest",
      "needsApproval",
      "answerNow",
      "beforeStep",
      "reconcileStep",
      "beforeTool",
      "reconcileToolRetry",
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

/** Code and guest inputs are exact JSON, not prose whose escapes may be repaired. */
export function jsonArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function completeArguments(raw: string): boolean {
  return jsonArguments(raw) !== undefined;
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
    optional(value.subagent, isId) &&
    optional(value.parentOperationId, isId) &&
    isRecord(value.arguments)
  );
}

function isStepRequest(value: unknown): value is StepRequest {
  return (
    isRecord(value) &&
    [
      value.workflowId,
      value.version,
      value.runId,
      value.attemptId,
      value.operationId,
      value.key,
    ].every(isId) &&
    ["step", "ask", "agent", "remote", "workflow", "sleep"].includes(String(value.kind))
  );
}

function isPendingRequest(value: unknown): value is PendingRequest {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isPath(value.path) &&
    ((value.step === undefined && isRequest(value.call)) ||
      (value.call === undefined && isStepRequest(value.step))) &&
    isScope(value.scope) &&
    isAsk(value.ask) &&
    positive(value.createdAt) &&
    typeof value.definitionHash === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.definitionHash)
  );
}

export function isAskRecord(value: unknown): value is AskRecord {
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
        optional(value.images, (images) => Array.isArray(images) && images.every(isImage)) &&
        optional(value.output, serializable) &&
        optional(value.final, (final) => isRecord(final) && serializable(final.candidate))
      : value.ok === false &&
        value.images === undefined &&
        value.output === undefined &&
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
          "interrupted",
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

function isRetriedAttempt(value: unknown): value is RetriedToolAttempt {
  return (
    isRecord(value) &&
    isId(value.attemptId) &&
    isRecord(value.arguments) &&
    isToolResult(value.result) &&
    !value.result.ok &&
    ["failed", "timeout"].includes(value.result.kind) &&
    optional(value.reconciliation, isId)
  );
}

function isProgramCall(value: unknown): value is ProgramCall {
  return (
    isRecord(value) &&
    value.calls === undefined &&
    isToolExecution(value) &&
    value.status !== "delegating" &&
    (value.status === "completed" || !("result" in value)) &&
    "attemptId" in value &&
    isId(value.attemptId) &&
    "programAttemptId" in value &&
    isId(value.programAttemptId) &&
    "name" in value &&
    isId(value.name) &&
    "arguments" in value &&
    isRecord(value.arguments) &&
    "started" in value &&
    typeof value.started === "boolean" &&
    (!("bytes" in value) ||
      optional(value.bytes, (bytes) => finite(bytes) && Number.isSafeInteger(bytes)))
  );
}

function isToolExecution(value: unknown): value is ToolExecution {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isInterrupted(value.interrupted) ||
    !Array.isArray(value.retries) ||
    !value.retries.every(isRetriedAttempt) ||
    !isInterrupted([...value.interrupted, ...value.retries]) ||
    [...value.interrupted, ...value.retries].some(
      (attempt) => attempt.attemptId === value.attemptId,
    ) ||
    !optional(value.calls, (calls) => Array.isArray(calls) && calls.every(isProgramCall)) ||
    !optional(value.asks, (v) => Array.isArray(v) && v.every(isAskRecord))
  )
    return false;
  if (value.status === "pending")
    return value.previousAttemptId === undefined
      ? (value.interrupted.length === 0 && value.retries.length === 0) ||
          (Array.isArray(value.asks) && value.asks.length > 0)
      : isId(value.previousAttemptId) &&
          [value.interrupted.at(-1), value.retries.at(-1)].some(
            (attempt) => attempt?.attemptId === value.previousAttemptId,
          );
  return (
    value.previousAttemptId === undefined &&
    isId(value.attemptId) &&
    (value.status === "running" ||
      value.status === "delegating" ||
      (value.status === "completed" && isToolResult(value.result)))
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
    !optional(value.costUsd, finite) ||
    !isInterrupted(value.interrupted) ||
    value.interrupted.some(
      (attempt) =>
        attempt.attemptId === value.attemptId ||
        !("usage" in attempt) ||
        !isUsage(attempt.usage) ||
        ("costUsd" in attempt && !finite(attempt.costUsd)),
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

function isCompaction(value: unknown): value is CompactionExecution {
  return (
    isRecord(value) &&
    isId(value.id) &&
    finite(value.beforeModel) &&
    Number.isSafeInteger(value.beforeModel) &&
    positive(value.sourceCount) &&
    positive(value.cut) &&
    optional(value.model, isModel) &&
    (value.status === "running" || (value.status === "completed" && isId(value.summary)))
  );
}

function isToolCost(value: unknown): value is ToolCost {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isId(value.operationId) &&
    isId(value.attemptId) &&
    finite(value.costUsd)
  );
}

export function isState(value: unknown): value is RunState {
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
        "steps",
        "treeElapsedMs",
        "costUsd",
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
    (value.kind === "delegation"
      ? value.target === undefined && value.note === undefined
      : value.kind === "handoff" &&
        isRecord(value.target) &&
        isId(value.target.id) &&
        isId(value.target.version) &&
        optional(value.note, (note) => typeof note === "string")) &&
    Array.isArray(value.children) &&
    value.children.every(
      (child) =>
        isRecord(child) &&
        isId(child.key) &&
        optional(child.reference, isId) &&
        isTreeNode(child.snapshot),
    )
  );
}

function isRunInput(value: unknown): value is RunInput {
  if (!isRecord(value) || !finite(value.beforeModel) || !Number.isSafeInteger(value.beforeModel))
    return false;
  try {
    return equalData(
      value.content,
      readQueuedInput({ id: value.id, content: value.content }).content,
    );
  } catch {
    return false;
  }
}

/** Format 3 only. A format 2 snapshot from 0.1.0 has no reader: it is refused, not migrated. */
function isSnapshot(value: unknown): value is RunSnapshot {
  return (
    isRecord(value) &&
    value.format === 3 &&
    value.kind === "agent" &&
    [value.agentId, value.version, value.runId, value.attemptId].every(isId) &&
    positive(value.startedAt) &&
    isRunDefinition(value.definition) &&
    optional(value.recall, isMemoryRecall) &&
    optional(
      value.subagent,
      (record) => isSubagentRecord(record) && isRunDefinition(record.base),
    ) &&
    Array.isArray(value.history) &&
    value.history.every(isAgentMessage) &&
    isTurnContent(value.input) &&
    Array.isArray(value.inputs) &&
    value.inputs.every(isRunInput) &&
    Array.isArray(value.guards) &&
    value.guards.every(isGuardRecord) &&
    Array.isArray(value.compactions) &&
    value.compactions.every(isCompaction) &&
    optional(value.toolCosts, (costs) => Array.isArray(costs) && costs.every(isToolCost)) &&
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
    optional(value.tree.memory, isMemoryScopes) &&
    isState(value.state)
  );
}

export function isTreeInfo(value: unknown): value is RunSnapshot["tree"] {
  return (
    isRecord(value) &&
    isId(value.runId) &&
    positive(value.startedAt) &&
    isTreeLimits(value.limits) &&
    optional(value.memory, isMemoryScopes)
  );
}

export function isTreeNode(value: unknown): value is TreeNode {
  return isSnapshot(value) || isWorkflowSnapshot(value) || isRemoteSnapshot(value);
}

export function agentSnapshot(node: TreeNode): RunSnapshot {
  if (node.kind !== "agent") throw new TypeError("Expected an agent node, not a workflow.");
  return node;
}

export function readWorkflowSnapshot(raw: unknown): WorkflowSnapshot {
  if (!serializable(raw) || !isWorkflowSnapshot(raw))
    throw new TypeError("Invalid workflow snapshot.");
  checkWorkflowSnapshot(raw);
  checkTree(raw);
  return copyData(raw);
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
export function checkTree(root: TreeNode): void {
  let children = 0;
  let models = 0;
  const inputIds = new Set<string>();
  const remoteNodes = new Map<string, Extract<TreeNode, { kind: "remote" }>>();
  const continued = new Set<string>();
  let inputSize = 0;
  function visit(
    node: TreeNode,
    depth: number,
    path: ChildPathStep[],
    conversation: boolean,
    createdLevel: number,
    createdCeiling: number,
  ): void {
    if (!equalData(node.tree, root.tree) || node.startedAt < root.tree.startedAt)
      throw new TypeError("The child belongs to a different tree or deadline.");
    if (depth > root.tree.limits.maxDepth) throw new TypeError("The tree exceeds its depth limit.");
    if (node.kind === "remote") {
      checkRemoteSnapshot(node);
      if (
        root.runId === root.tree.runId &&
        node.remote.sends.some((send) =>
          send.asks?.some((record) => !equalData(record.request.path, path)),
        )
      )
        throw new TypeError("The remote request path is invalid.");
      if (node.input.continue && root.runId === root.tree.runId) {
        const source = remoteNodes.get(node.input.continue);
        if (
          !source ||
          source.agentId !== node.agentId ||
          source.version !== node.version ||
          !equalData(source.definition, node.definition) ||
          source.state.status !== "completed" ||
          source.remote.state !== "input_required" ||
          source.remote.cancel ||
          !equalData(source.remote.endpoint, node.remote.endpoint) ||
          source.remote.taskId !== node.remote.taskId ||
          source.remote.contextId !== node.remote.contextId ||
          node.remote.priorTurns !== source.remote.priorTurns + source.remote.sends.length ||
          continued.has(source.runId)
        )
          throw new TypeError("The remote continuation does not match an open task in this tree.");
        continued.add(source.runId);
      }
      remoteNodes.set(node.runId, node);
      return;
    }
    if (node.kind === "workflow") {
      checkWorkflowSnapshot(node);
      for (const step of node.steps) {
        if (
          root.runId === root.tree.runId &&
          step.asks?.some((record) => !equalData(record.request.path, path))
        )
          throw new TypeError("The workflow request path is invalid.");
        for (const child of step.children) {
          children++;
          visit(
            child.snapshot,
            depth + 1,
            [...path, { operationId: step.id, key: child.key, runId: child.snapshot.runId }],
            false,
            createdLevel,
            createdCeiling,
          );
        }
      }
      return;
    }
    if (node.subagent) {
      createdLevel++;
      createdCeiling = Math.min(createdCeiling, node.subagent.policy.maxLevels);
      if (createdLevel > createdCeiling || node.session)
        throw new TypeError(
          "A helper exceeds its recursive creation permission or carries a session.",
        );
    }
    if (!conversation && node.inputs.length)
      throw new TypeError("A delegated specialist cannot receive the root conversation's inbox.");
    for (const input of node.inputs) {
      if (inputIds.has(input.id)) throw new TypeError("Duplicate input id in the run tree.");
      inputIds.add(input.id);
      inputSize += inputBytes(input);
    }
    if (!equalData(node.tree, root.tree) || node.startedAt < root.tree.startedAt)
      throw new TypeError("The child belongs to a different tree or deadline.");
    if (depth > root.tree.limits.maxDepth) throw new TypeError("The tree exceeds its depth limit.");
    models += allModels(node).reduce((total, model) => total + 1 + model.interrupted.length, 0);
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
      if (journal.kind === "handoff") {
        const child = journal.children[0];
        const model = node.models.find(
          (entry) =>
            entry.status === "completed" && entry.tools.some((entry) => entry.id === tool.id),
        );
        if (
          journal.target.id === node.agentId ||
          journal.children.length > 1 ||
          model?.status !== "completed" ||
          model.tools.length !== 1 ||
          (child &&
            (child.key !== "handoff" ||
              child.snapshot.kind !== "agent" ||
              child.snapshot.session !== undefined ||
              child.snapshot.agentId !== journal.target.id ||
              child.snapshot.version !== journal.target.version)) ||
          (child && model !== node.models.at(-1)) ||
          (tool.status === "completed" &&
            tool.result.ok &&
            child?.snapshot.state.status !== "completed")
        )
          throw new TypeError(
            "The handoff must have one fixed target, one call and no later source turn.",
          );
      }
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
        visit(
          child.snapshot,
          depth + 1,
          [
            ...path,
            { operationId: journal.operationId, key: child.key, runId: child.snapshot.runId },
          ],
          conversation && journal.kind === "handoff",
          createdLevel,
          createdCeiling,
        );
      }
    }
    for (const model of node.models) {
      if (model.status === "completed" && root.runId === root.tree.runId)
        for (const tool of model.tools)
          for (const record of [
            ...(tool.asks ?? []),
            ...(tool.calls ?? []).flatMap((call) => call.asks ?? []),
          ])
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
  visit(root, 0, [], true, 0, Infinity);
  if (inputIds.size > INPUT_LIMITS.count || inputSize > INPUT_LIMITS.bytes)
    throw new TypeError("The snapshot exceeds its input count or byte limit.");
  if (children > root.tree.limits.maxChildren || models > root.tree.limits.modelCalls)
    throw new TypeError("The snapshot exceeds its tree limits.");
}

/** A later attempt must retain the exact measurements and identity of every lost attempt. */
function checkAttemptProgress(
  previous: {
    attemptId?: string;
    interrupted: { attemptId: string; usage?: TokenUsage; costUsd?: number }[];
    usage?: TokenUsage;
    costUsd?: number;
  },
  next: {
    attemptId?: string;
    interrupted: { attemptId: string; usage?: TokenUsage; costUsd?: number }[];
  },
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
      ...(previous.costUsd !== undefined ? { costUsd: previous.costUsd } : {}),
    })
  )
    throw new TypeError("The host changed an attempt without retaining its receipt.");
}

/** A host cache may fill a missing receipt, never erase or replace a known effect. */
export function checkChildProgress(previous: TreeNode, next: TreeNode): void {
  if (
    previous.kind !== next.kind ||
    previous.runId !== next.runId ||
    previous.version !== next.version ||
    previous.startedAt !== next.startedAt ||
    !equalData(previous.definition, next.definition) ||
    !equalData(previous.input, next.input) ||
    !equalData(previous.limits, next.limits) ||
    !equalData(previous.tree, next.tree) ||
    (previous.state.status !== "running" &&
      previous.state.status !== "suspended" &&
      !equalData(previous.state, next.state))
  )
    throw new TypeError("The child host returned a different or regressed node.");
  if (previous.kind === "remote" && next.kind === "remote") {
    checkRemoteProgress(previous, next);
    return;
  }
  if (previous.kind === "workflow" && next.kind === "workflow") {
    if (previous.workflowId !== next.workflowId)
      throw new TypeError("The child host changed the workflow.");
    checkWorkflowProgress(previous, next);
    return;
  }
  if (previous.kind !== "agent" || next.kind !== "agent")
    throw new TypeError("The child kind changed.");
  if (
    previous.runId !== next.runId ||
    !equalData(previous.definition, next.definition) ||
    !equalData(previous.subagent, next.subagent) ||
    (previous.recall !== undefined && !equalData(previous.recall, next.recall)) ||
    !equalData(previous.limits, next.limits) ||
    !equalData(previous.history, next.history) ||
    !equalData(previous.input, next.input) ||
    !equalData(previous.session, next.session) ||
    previous.startedAt !== next.startedAt ||
    previous.agentId !== next.agentId ||
    previous.version !== next.version ||
    !equalData(previous.tree, next.tree)
  )
    throw new TypeError("The child host returned a different child.");
  if (
    previous.inputs.some((input, index) => !equalData(input, next.inputs[index])) ||
    next.inputs
      .slice(previous.inputs.length)
      .some((input) => input.beforeModel < previous.models.length)
  )
    throw new TypeError("The child host erased an input or changed an admitted model's input.");
  for (const [index, guard] of previous.guards.entries()) {
    const saved = next.guards[index];
    if (
      !saved ||
      !equalData({ ...guard, status: saved.status }, saved) ||
      (guard.status !== "running" && guard.status !== saved.status)
    )
      throw new TypeError("The child host erased or replaced a guard verdict.");
  }
  if (previous.compactions.length > next.compactions.length)
    throw new TypeError("The child host dropped compaction receipts.");
  for (const [index, entry] of previous.compactions.entries()) {
    const saved = next.compactions[index];
    if (
      !saved ||
      entry.id !== saved.id ||
      entry.cut !== saved.cut ||
      entry.sourceCount !== saved.sourceCount ||
      entry.beforeModel !== saved.beforeModel ||
      (entry.status === "completed" && !equalData(entry, saved)) ||
      (entry.model && (!saved.model || entry.model.attemptId !== saved.model.attemptId))
    )
      throw new TypeError("The child host erased or replaced a compaction.");
  }
  if (
    next.compactions
      .slice(previous.compactions.length)
      .some((entry) => entry.beforeModel < previous.models.length)
  )
    throw new TypeError("The child host changed an admitted model's context.");
  // A charge only grows while its attempt runs, and is never dropped.
  if (
    (previous.toolCosts ?? []).some((entry, index) => {
      const saved = next.toolCosts?.[index];
      return (
        !saved ||
        saved.operationId !== entry.operationId ||
        saved.attemptId !== entry.attemptId ||
        saved.costUsd < entry.costUsd
      );
    })
  )
    throw new TypeError("The child host erased or lowered a reported tool cost.");
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
      saved.costUsd !== model.costUsd ||
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
        tool.id !== restored.id ||
        tool.retries.some((attempt, index) => !equalData(attempt, restored.retries[index])) ||
        tool.interrupted.some(
          (attempt, index) => !equalData(attempt, restored.interrupted[index]),
        ) ||
        (tool.status === "running" && restored.status === "delegating")
      )
        throw new TypeError("The child host replaced a tool receipt.");
      for (const [callIndex, call] of (tool.calls ?? []).entries()) {
        const nextCall = restored?.calls?.[callIndex];
        if (
          !nextCall ||
          call.id !== nextCall.id ||
          call.programAttemptId !== nextCall.programAttemptId ||
          call.name !== nextCall.name ||
          !equalData(call.arguments, nextCall.arguments) ||
          (call.started && !nextCall.started) ||
          (call.attemptId === nextCall.attemptId &&
            call.bytes !== undefined &&
            call.bytes !== nextCall.bytes) ||
          call.interrupted.some((entry, i) => !equalData(entry, nextCall.interrupted[i])) ||
          call.retries.some((entry, i) => !equalData(entry, nextCall.retries[i])) ||
          (call.status === "running" &&
            nextCall.status === "pending" &&
            nextCall.retries.length === call.retries.length) ||
          (call.status === "completed" &&
            !equalData(call, nextCall) &&
            !nextCall.retries
              .slice(call.retries.length)
              .some(
                (entry) =>
                  entry.attemptId === call.attemptId && equalData(entry.result, call.result),
              )) ||
          (call.attemptId !== nextCall.attemptId &&
            !nextCall.retries.some((entry) => entry.attemptId === call.attemptId))
        )
          throw new TypeError("The child host erased, replaced or rolled back a program call.");
        for (const [askIndex, ask] of (call.asks ?? []).entries()) {
          const nextAsk = nextCall.asks?.[askIndex];
          if (
            !nextAsk ||
            !equalData(ask.request, nextAsk.request) ||
            (ask.decision && !equalData(ask.decision, nextAsk.decision)) ||
            (ask.closed && ask.closed !== nextAsk.closed)
          )
            throw new TypeError("The child host replaced an inner request receipt.");
        }
      }
      const retained =
        tool.status === "pending"
          ? undefined
          : restored.retries
              .slice(tool.retries.length)
              .find((attempt) => attempt.attemptId === tool.attemptId);
      if (
        tool.status === "completed" &&
        !equalData(tool, restored) &&
        (!retained || tool.result.ok || !equalData(retained.result, tool.result))
      )
        throw new TypeError("The child host replaced a completed tool receipt.");
      // A settled failed attempt can move to retries. An interrupted attempt stays in its
      // existing history; pure coordinators still carry no external attempt of their own.
      if (tool.status !== "delegating" && !retained) checkAttemptProgress(tool, restored);
    }
  }
  for (const journal of previous.delegations) {
    const saved = next.delegations.find((entry) => entry.operationId === journal.operationId);
    if (!saved || saved.children.length < journal.children.length)
      throw new TypeError("The child host dropped a delegation receipt.");
    if (
      saved.kind !== journal.kind ||
      (journal.kind === "handoff" &&
        (saved.kind !== "handoff" ||
          !equalData(saved.target, journal.target) ||
          (journal.children.length > 0 && saved.note !== journal.note)))
    )
      throw new TypeError("The child host changed a handoff identity or admitted note.");
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
    if ((calls.length === 1 && call.name === resultTool) || stopAtTools.includes(call.name))
      if (tool.result.final) return tool.result.final;
  }
  return undefined;
}

/** A successful handoff keeps the target's raw candidate, not its transformed output. The
 * target runtime owns validation, even when the source has a different output contract. */
export function finalHandoffResult(
  snapshot: RunSnapshot,
  model: Extract<ModelExecution, { status: "completed" }>,
): { candidate: unknown; child: RunSnapshot } | undefined {
  const tool = model.tools[0];
  if (model.tools.length !== 1 || tool?.status !== "completed" || !tool.result.ok) return undefined;
  const journal = snapshot.delegations.find((entry) => entry.operationId === tool.id);
  const child = journal?.kind === "handoff" ? journal.children[0]?.snapshot : undefined;
  return child?.kind === "agent" && child.state.status === "completed"
    ? { candidate: child.state.candidate, child }
    : undefined;
}

/** Saved verdicts cannot be dropped to turn a withheld response into a completed one. This
 * checks journal structure, not authenticity: the host still supplies authoritative state. */
function checkGuards(snapshot: RunSnapshot): void {
  const stages = snapshot.definition.guardrails?.stages ?? [];
  for (const guard of snapshot.guards) {
    if (!stages.includes(guard.stage))
      throw new TypeError("A guard is not in the recorded policy.");
    const model = allModels(snapshot).find(
      (model) =>
        model.id === guard.operationId ||
        (model.status === "completed" &&
          model.tools.some(
            (tool) =>
              tool.id === guard.operationId ||
              tool.calls?.some((call) => call.id === guard.operationId),
          )),
    );
    if (
      !model &&
      !(
        guard.stage === "modelInput" &&
        (guard.operationId === modelId(snapshot.runId, snapshot.models.length) ||
          snapshot.compactions.some((entry) => entry.id === guard.operationId))
      )
    )
      throw new TypeError("A guard does not match a journaled operation.");
    if (snapshot.state.status === "completed" && guard.status !== "allowed")
      throw new TypeError("A completed run cannot have an unfinished or rejected guard.");
  }
  function requireGuardVerdict(stage: GuardStage, id: string, attemptId: string): void {
    if (
      stages.includes(stage) &&
      !snapshot.guards.some(
        (guard) =>
          guard.stage === stage &&
          guard.operationId === id &&
          guard.attemptId === attemptId &&
          guard.status === "allowed",
      )
    )
      throw new TypeError("A completed operation is missing its allowed guard verdict.");
  }
  for (const model of allModels(snapshot)) {
    // Input checks precede admission; even running work must have passed them.
    requireGuardVerdict("modelInput", model.id, model.attemptId);
    if (model.status !== "completed") continue;
    requireGuardVerdict("modelOutput", model.id, model.attemptId);
    for (const tool of model.tools) {
      for (const call of tool.calls ?? []) {
        for (const attempt of call.retries) {
          requireGuardVerdict("toolInput", call.id, attempt.attemptId);
          requireGuardVerdict("toolOutput", call.id, attempt.attemptId);
        }
        if (call.status !== "completed") continue;
        if (call.result.ok) requireGuardVerdict("toolInput", call.id, call.attemptId);
        if (call.result.ok || !["aborted", "interrupted"].includes(call.result.kind))
          requireGuardVerdict("toolOutput", call.id, call.attemptId);
      }
      for (const attempt of tool.retries) {
        requireGuardVerdict("toolInput", tool.id, attempt.attemptId);
        requireGuardVerdict("toolOutput", tool.id, attempt.attemptId);
      }
      if (tool.status !== "completed") continue;
      if (tool.result.ok) requireGuardVerdict("toolInput", tool.id, tool.attemptId);
      requireGuardVerdict("toolOutput", tool.id, tool.attemptId);
    }
  }
}

/** Program receipts are private evidence, never a continuation of the guest VM. */
function checkProgramJournal(
  snapshot: RunSnapshot,
  tool: ToolExecution,
  code?: RecordedCodeTool,
): number {
  if (tool.calls === undefined) {
    if (
      code &&
      (tool.status === "running" ||
        tool.interrupted.length ||
        (tool.status === "completed" && tool.result.ok))
    )
      throw new TypeError("An admitted code program is missing its call journal.");
    return 0;
  }
  if (
    !code ||
    !snapshot.definition.enabledTools.includes(code.name) ||
    tool.status === "delegating" ||
    (tool.status === "pending" && !tool.interrupted.length)
  )
    throw new TypeError("Only an admitted code tool can contain program calls.");
  if (tool.status === "completed") {
    let envelope: unknown;
    try {
      envelope = JSON.parse(tool.result.content);
    } catch {
      throw new TypeError("A code result must be a JSON envelope.");
    }
    if (
      !isRecord(envelope) ||
      envelope.toolCalls !== tool.calls.length ||
      (tool.result.ok
        ? envelope.error !== undefined || envelope.calls !== undefined
        : envelope.error === undefined || envelope.result !== undefined) ||
      (envelope.result !== undefined &&
        textBytes(programJson(envelope.result)) > code.limits.resultBytes) ||
      (envelope.logs !== undefined &&
        (typeof envelope.logs !== "string" || textBytes(envelope.logs) > code.limits.logBytes)) ||
      (envelope.droppedLogBytes !== undefined &&
        (!finite(envelope.droppedLogBytes) || !Number.isSafeInteger(envelope.droppedLogBytes))) ||
      (envelope.toolCallsLeft !== undefined &&
        (!finite(envelope.toolCallsLeft) ||
          !Number.isSafeInteger(envelope.toolCallsLeft) ||
          envelope.toolCallsLeft > code.limits.calls)) ||
      (envelope.error !== undefined &&
        (!isRecord(envelope.error) ||
          !isId(envelope.error.name) ||
          envelope.error.name.length > 64 ||
          typeof envelope.error.message !== "string" ||
          textBytes(envelope.error.message) > 2048 ||
          !optional(envelope.error.line, positive))) ||
      (envelope.calls !== undefined &&
        (!Array.isArray(envelope.calls) ||
          envelope.calls.length > 20 ||
          envelope.calls.some(
            (note) =>
              !isRecord(note) ||
              !isId(note.tool) ||
              !code.tools.some((tool) => tool.name === note.tool) ||
              typeof note.note !== "string" ||
              note.note.length > 200 ||
              !["returned", "failed", "refused", "stopped", "not started"].includes(
                String(note.status),
              ),
          ))) ||
      Object.keys(envelope).some(
        (key) =>
          ![
            "result",
            "logs",
            "droppedLogBytes",
            "toolCalls",
            "toolCallsLeft",
            "error",
            "calls",
          ].includes(key),
      )
    )
      throw new TypeError("The code result exceeds its recorded count or byte limits.");
  }
  const attempts = [
    ...tool.interrupted.map((entry) => entry.attemptId),
    ...(tool.status !== "pending" ? [tool.attemptId] : []),
  ];
  let previousAttempt = -1;
  let total = 0;
  const counts = new Map<string, number>();
  for (const [position, call] of tool.calls.entries()) {
    const bound = code.tools.find((bound) => bound.name === call.name);
    const attempt = attempts.indexOf(call.programAttemptId);
    if (
      !bound ||
      !snapshot.definition.enabledTools.includes(call.name) ||
      call.id !== `${tool.id}/call/${position + 1}` ||
      call.interrupted.length ||
      attempt < previousAttempt ||
      attempt < 0 ||
      textBytes(programJson(call.arguments)) > code.limits.callInputBytes ||
      ((call.status === "running" || call.retries.length > 0) && !call.started) ||
      (call.status === "completed" && call.result.ok && !call.started) ||
      ((tool.status === "completed" ||
        attempt < attempts.length - 1 ||
        tool.status === "pending") &&
        call.status !== "completed")
    )
      throw new TypeError("Invalid code call identity, binding, input, attempt or settlement.");
    previousAttempt = attempt;
    const expectedAttempt = (n: number) =>
      n === 0
        ? call.programAttemptId
        : `${call.programAttemptId}/call/${position + 1}/attempt/${n + 1}`;
    if (
      call.attemptId !== expectedAttempt(call.retries.length) ||
      call.retries.some((retry, index) => retry.attemptId !== expectedAttempt(index))
    )
      throw new TypeError(
        "Code tool attempts must keep their original identity and increase in order.",
      );
    const retry = retryBudget(snapshot.definition.toolRetries, call.name);
    if (
      call.retries.length &&
      (!retry ||
        call.asks?.length ||
        call.retries.length + 1 > retry.maxAttempts ||
        call.retries.some(
          (entry) =>
            !equalData(entry.arguments, call.arguments) ||
            (retry.replay === "reconcile"
              ? !isId(entry.reconciliation)
              : entry.reconciliation !== undefined),
        ))
    )
      throw new TypeError("Code retries do not match the saved retry policy.");
    const results = [
      ...call.retries.map((entry) => entry.result),
      ...(call.status === "completed" ? [call.result] : []),
    ];
    if (
      results.some(
        (result) =>
          textBytes(result.content) > 1024 ||
          (result.ok &&
            (result.output !== undefined ||
              result.images !== undefined ||
              result.final !== undefined)),
      )
    )
      throw new TypeError("Code receipts may retain only bounded result previews.");
    for (const [index, ask] of (call.asks ?? []).entries()) {
      const request = ask.request;
      if (
        request.ask.type !== "approval" ||
        !request.call ||
        request.step !== undefined ||
        request.id !== `${call.id}/ask/${index + 1}` ||
        request.call.parentOperationId !== tool.id ||
        request.call.operationId !== call.id ||
        request.call.call.id !== call.id ||
        request.call.call.name !== call.name ||
        request.call.agentId !== snapshot.agentId ||
        request.call.runId !== snapshot.runId ||
        request.call.version !== snapshot.version ||
        request.call.subagent !== snapshot.subagent?.spec.name ||
        ![call.attemptId, ...call.retries.map((entry) => entry.attemptId)].includes(
          request.call.attemptId,
        ) ||
        !equalData(jsonArguments(request.call.call.arguments), call.arguments) ||
        !equalData(request.call.arguments, call.arguments) ||
        request.createdAt < snapshot.startedAt ||
        (call.status === "completed" && !ask.closed && !ask.decision) ||
        (ask.decision?.type === "approve" &&
          ask.decision.arguments !== undefined &&
          textBytes(programJson(ask.decision.arguments)) > code.limits.callInputBytes &&
          call.started)
      )
        throw new TypeError("An inner approval does not match its owning code call.");
    }
    const count = (counts.get(call.programAttemptId) ?? 0) + 1 + call.retries.length;
    if (count > code.limits.calls) throw new TypeError("The program exceeds its call limit.");
    counts.set(call.programAttemptId, count);
    total += 1 + call.retries.length;
  }
  if (
    tool.interrupted.length &&
    tool.calls.some(
      (call) =>
        call.programAttemptId !== (tool.status !== "pending" ? tool.attemptId : undefined) &&
        (!code.tools.find((bound) => bound.name === call.name)?.isReadOnly || call.asks?.length),
    )
  )
    throw new TypeError("A restarted program cannot contain an earlier effect or approval.");
  return total;
}

/** Each reported cost belongs to one attempt of a call in this run's journal. */
function checkToolCosts(snapshot: RunSnapshot): void {
  const costs = snapshot.toolCosts ?? [];
  const calls = new Set(
    snapshot.models.flatMap((model) =>
      model.status === "completed"
        ? model.tools.flatMap((tool) => [tool.id, ...(tool.calls ?? []).map((call) => call.id)])
        : [],
    ),
  );
  if (
    costs.some(
      (entry, index) =>
        !calls.has(entry.operationId) ||
        costs.findIndex(
          (other) => other.operationId === entry.operationId && other.attemptId === entry.attemptId,
        ) !== index,
    )
  )
    throw new TypeError("A reported tool cost names no call in this run, or repeats an attempt.");
}

/** Validate data-only journals without live tools. Execution callers supply their actual code
 * registry, which must match the saved policy. Recorded data never replaces host authorization. */
export function readSnapshot(
  raw: unknown,
  agentId: string,
  version: string,
  limits: RunLimits,
  resultTool?: string,
  codeTools?: ReadonlyMap<string, CodeTool>,
): RunSnapshot {
  if (!serializable(raw) || !isSnapshot(raw)) throw new TypeError("Invalid agent snapshot.");
  const recordedCode = raw.definition.codeTools ?? {};
  if (codeTools !== undefined && !equalData(recordedCode, recordCodeTools(codeTools))) {
    throw new TypeError(
      "The recorded code bindings or limits changed. Restore the same code tools before resuming.",
    );
  }
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
        !!raw.definition.modelSettings.hostedTools?.length ||
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
        (pending &&
          tool.status !== "pending" &&
          !tool.asks?.length &&
          !tool.interrupted.length &&
          !tool.retries.length)
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
        const stopping = raw.definition.stopAtTools.includes(call.name) || call.name === resultTool;
        if (tool.result.final && !stopping)
          throw new TypeError("This tool is not configured to produce a final result.");
        if (stopping && !tool.result.final)
          throw new TypeError("A successful stopping tool must record its final result.");
      }
      const keys = new Set<string>();
      const code = Object.hasOwn(recordedCode, call.name) ? recordedCode[call.name] : undefined;
      const originalArguments = code
        ? (jsonArguments(call.arguments) ?? {})
        : parseToolArgs(call.arguments);
      let clientArguments = originalArguments;
      for (const [askIndex, record] of (tool.asks ?? []).entries()) {
        const request = record.request;
        if (
          !request.call ||
          request.step !== undefined ||
          request.id !== `${tool.id}/ask/${askIndex + 1}` ||
          request.call.operationId !== tool.id ||
          request.call.parentOperationId !== undefined ||
          request.call.runId !== raw.runId ||
          request.call.agentId !== raw.agentId ||
          request.call.version !== raw.version ||
          request.call.subagent !== raw.subagent?.spec.name ||
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
        call.name === resultTool &&
        tool.status === "completed" &&
        tool.result.ok &&
        (tools.length !== 1 || !equalData(tool.result.final?.candidate, clientArguments))
      )
        throw new TypeError("The submitted result does not match its effective arguments.");
      if (
        tool.interrupted.length &&
        (!raw.definition.recovery?.policy.readOnlyTools?.includes(call.name) ||
          toolAttempts(tool) > raw.definition.recovery.policy.maxAttempts ||
          tool.status === "delegating")
      )
        throw new TypeError("Tool attempts exceed the recorded recovery policy.");
      const retry = retryBudget(raw.definition.toolRetries, call.name);
      if (
        (retry && toolAttempts(tool) > retry.maxAttempts) ||
        (tool.retries.length &&
          (!retry ||
            tool.asks?.length ||
            tool.status === "delegating" ||
            raw.definition.stopAtTools.includes(call.name) ||
            call.name === resultTool ||
            !raw.definition.enabledTools.includes(call.name) ||
            raw.definition.modelSettings.toolChoice === "none" ||
            !completeArguments(call.arguments) ||
            tool.retries.some(
              (attempt) =>
                !equalData(attempt.arguments, originalArguments) ||
                (retry.replay === "reconcile"
                  ? !isId(attempt.reconciliation)
                  : attempt.reconciliation !== undefined),
            )))
      )
        throw new TypeError("Tool retries do not match the recorded policy or call.");
      pending ||=
        tool.status === "pending" &&
        !tool.asks?.length &&
        !tool.interrupted.length &&
        !tool.retries.length;
      const approved = [...(tool.asks ?? [])]
        .reverse()
        .find((record) => !record.closed && record.decision?.type === "approve")?.decision;
      const effectiveCode =
        approved?.type === "approve" && approved.arguments !== undefined
          ? approved.arguments
          : originalArguments;
      if (
        code &&
        (tool.calls?.length || (tool.status === "completed" && tool.result.ok)) &&
        (!completeArguments(call.arguments) ||
          typeof effectiveCode.code !== "string" ||
          Object.keys(effectiveCode).length !== 1 ||
          textBytes(effectiveCode.code) > code.limits.sourceBytes)
      )
        throw new TypeError(
          "The admitted code source does not fit its saved limit or input schema.",
        );
      calls += toolAttempts(tool) + checkProgramJournal(raw, tool, code);
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
  for (const [index, input] of raw.inputs.entries()) {
    if (
      input.beforeModel > raw.models.length ||
      input.beforeModel < (raw.inputs[index - 1]?.beforeModel ?? 0) ||
      raw.models
        .slice(0, input.beforeModel)
        .some(
          (model) =>
            model.status !== "completed" ||
            model.tools.some((tool) => tool.status !== "completed") ||
            !model.tools.length ||
            model.turn.finishReason === null ||
            model.turn.finishReason === "length" ||
            model.turn.finishReason === "content_filter" ||
            finalToolResult(model, raw.definition.stopAtTools, resultTool) ||
            finalHandoffResult(raw, model),
        )
    )
      throw new TypeError(
        "An input must join before a new model call, after whole non-final rounds.",
      );
  }
  if (
    raw.models.length > limits.turns + (resultTool ? 0 : 1) ||
    calls > limits.toolCalls ||
    snapshotInlineBytes(raw) > limits.inlineBytes
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
    const final =
      finalHandoffResult(raw, last) ??
      finalToolResult(last, raw.definition.stopAtTools, resultTool);
    const candidate = final
      ? final.candidate
      : !resultTool && tools.length === 0 && last.turn.message.content.trim()
        ? last.turn.message.content
        : undefined;
    if (candidate === undefined || !equalData(candidate, raw.state.candidate)) {
      throw new TypeError("The completed result does not match its recorded turn.");
    }
  }
  checkMemorySnapshot(raw);
  checkCompactions(raw);
  checkToolCosts(raw);
  for (const entry of raw.compactions) {
    if (
      raw.models
        .slice(0, entry.beforeModel)
        .some(
          (model) =>
            model.status !== "completed" ||
            !model.tools.length ||
            model.tools.some((tool) => tool.status !== "completed") ||
            !["stop", "tool_calls"].includes(model.turn.finishReason ?? "") ||
            finalToolResult(model, raw.definition.stopAtTools, resultTool) ||
            finalHandoffResult(raw, model),
        )
    )
      throw new TypeError("Compaction must follow whole non-final rounds.");
    if (entry.model?.status === "completed") {
      readTurn(entry.model.turn);
      if (!equalData(entry.model.usage, entry.model.turn.usage))
        throw new TypeError("Summary usage does not match its completed turn.");
    }
  }
  checkGuards(raw);
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
