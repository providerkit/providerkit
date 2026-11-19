import type {
  ChatMessage,
  ContentPart,
  FileMimeType,
  ImageMimeType,
  ImagePart,
  JsonObjectSchema,
  Provider,
  ProviderChunk,
  StreamOptions,
  TokenUsage,
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolFailure,
  Turn,
} from "@providerkit/core";

import type {
  AgentMemory,
  MemoryBinding,
  MemoryPolicy,
  MemoryRecall,
  MemoryScopes,
} from "./memory.ts";
import type { ClientTool } from "./request.ts";
import type { CodeTool, CodeLimits } from "./code.ts";
import type { WorkflowSnapshot, StepRequest, StepKind, StepError } from "./workflow-types.ts";
export type { WorkflowSnapshot, StepRequest, StepKind, StepError } from "./workflow-types.ts";
import type { RemoteSnapshot, RemoteReceipt } from "./a2a/remote.ts";
export type TreeNode = RunSnapshot | WorkflowSnapshot | RemoteSnapshot;
import type { SubagentRecord } from "./subagents.ts";
import type { InputInbox, InputReceipt, RunInput } from "./steering.ts";
import type { Handoff } from "./handoff.ts";
import type {
  AGENT_RUNTIME,
  AgentRuntime,
  Delegation,
  SpecialistToolOptions,
} from "./delegation.ts";

/** Tree limits count the root too, except maxChildren and maxDepth (root depth is zero). */
export interface TreeLimits {
  maxParallel: number;
  maxChildren: number;
  maxDepth: number;
  /** SDK admissions only. Provider-internal retries stay in core. */
  modelCalls: number;
  /** Includes queueing and waiting for approval, across resumed attempts. */
  elapsedMs: number;
}

/** Limits for one run, not a whole tree of delegated runs. Cancellation is cooperative:
 * an admitted call can still finish or incur a charge after the signal aborts. */
export interface RunLimits {
  /** Tool-capable model turns. Text agents may make one final tool-free call, still counted
   * against the tree's model-call budget. Checked-output agents and `stopOnlyAtTools` agents
   * keep the hard cap: a tool-free call cannot end them. */
  turns: number;
  /** A call `host.screenCall` refused, or one cancelled with the rest of its turn, does not
   * count: it never started. That holds inside a code program too, where the program's own
   * call limit still counts it. */
  toolCalls: number;
  /** Wall time, including time spent waiting for approval. */
  elapsedMs: number;
  parallelTools: number;
  /** Decoded bytes of the images and files sent inline, history and new turn together. The
   * snapshot holds them, and every checkpoint writes the whole snapshot again, so large files
   * belong behind a MediaRef. Zero accepts media references only. */
  inlineBytes: number;
  /** USD this run may spend: its own model calls, compaction summaries included, what its tools
   * report through `context.reportCost`, and the same for every agent it starts (helpers,
   * specialists, handoff targets). `host.priceModelCall` prices each call when its usage
   * arrives, and the journal keeps that price. Once the known cost reaches the limit, no new
   * model call starts in the run or under it, and the run ends `limited` with `costUsd`. It
   * limits starting calls, not the bill: calls already running when the limit is reached, such
   * as parallel helpers or the rest of a tool batch, can finish above it. A call that never
   * reported usage adds nothing. Absent means no limit. */
  costUsd?: number;
}

/** Bytes the host keeps under an id. The SDK stores only the reference and asks
 * `host.loadMedia` for the bytes right before each model call. The bytes behind an id must
 * never change: an earlier byte that changes re-bills the provider's whole prompt cache. */
export interface MediaRef {
  type: "media";
  id: string;
  mimeType: ImageMimeType | FileMimeType;
}

/** Core's text, image and file parts, plus media the host keeps. */
export type InputPart = ContentPart | MediaRef;

/** One user turn: text, or parts with images and files. */
export type UserContent = string | InputPart[];

/** Core's messages without the system prompt, which stays the agent's. A user message may
 * hold media references. */
export type AgentMessage =
  | { role: "user"; content: UserContent }
  | Extract<ChatMessage, { role: "assistant" | "tool" }>;

/** A new turn, or a whole conversation whose last message is the new user turn. */
export type AgentInput =
  | string
  | readonly InputPart[]
  | { readonly messages: readonly AgentMessage[] };

/** What a run asks its session to append once it settles. */
export interface SessionTurn {
  /** The logical run id, which is the idempotency key. Repeating the same turn (same runId,
   * after and messages) must succeed without writing; the same runId with anything else must
   * throw SessionConflictError. */
  runId: string;
  /** The revision the history was loaded at, or null when the session was empty. */
  after: string | null;
  /** The new user turn and the run's settled rounds, never the system prompt. */
  messages: AgentMessage[];
}

/** A trusted, server-side conversation store. Every method is required. */
export interface Session {
  readonly id: string;
  /** The newest `limit` messages, or all of them, oldest first, with the revision they belong
   * to. A window may start inside a tool round; the run repairs it before sending. */
  load(options: {
    limit?: number;
    signal: AbortSignal;
  }): Promise<{ messages: AgentMessage[]; revision: string | null }>;
  /** Atomic. Throw SessionConflictError when `after` is not the current revision, or when
   * `runId` already appended a different turn. Write nothing when you throw. */
  append(turn: SessionTurn, options: { signal: AbortSignal }): Promise<{ revision: string }>;
}

/** Whether the session has this run's turn. `pending`: not appended yet, because the run is
 * waiting, its last checkpoint failed, or it was resumed without its session. */
export type SessionStatus = { id: string } & (
  | { status: "saved"; revision: string }
  | { status: "pending" }
  | { status: "unsaved"; error: RunFailure }
);

export interface ResultSchema<T> {
  schema: JsonObjectSchema;
  /** Pure runtime validation. Throw to reject; also used when restoring a result. */
  validate: (value: unknown) => T;
}

/** Core's call settings. Cancellation, conversation identity and checked output stay with
 * the loop: `RunOptions.signal`, `RunOptions.providerSessionId` and `output`. Provider
 * defaults apply first, then agent settings, then run settings. */
export type ModelSettings = Omit<StreamOptions, "signal" | "sessionId" | "json">;

/** Observers do not change the request and cannot be saved as JSON. */
export type RecordedModelSettings = Omit<ModelSettings, "onActivity" | "onRateLimit">;

/** Available while resolving a new run, never reconstructed from a snapshot. The history
 * and input are frozen copies. context keeps host services by reference, like tool context. */
export interface RunContext {
  readonly agentId: string;
  readonly version: string;
  readonly runId: string;
  readonly history: readonly AgentMessage[];
  readonly input: UserContent;
  readonly context: ToolContext;
  readonly signal: AbortSignal;
}

/** Dynamic instruction shape adapted from OpenAI Agents JS (MIT), agent.ts. */
export type AgentInstructions = string | ((run: RunContext) => string | Promise<string>);

/** Names from this agent's fixed tool list. Resolved once, not on every model turn. */
export type EnabledTools =
  | readonly string[]
  | ((run: RunContext) => readonly string[] | Promise<readonly string[]>);

/** Trusted host assertions, never inferred from model output or an idempotency key. */
export interface RecoveryPolicy {
  /** Change when hidden provider defaults, hosted capabilities or tool implementations change. */
  identity: string;
  /** Total attempts per operation, including the first. Tree and local limits still apply. */
  maxAttempts: number;
  /** Assert that this provider profile performs inference only, with no hosted effects. */
  inferenceOnly?: boolean;
  /** Explicit allow-list of ordinary isReadOnly tools. Calls with human requests cannot replay. */
  readOnlyTools?: readonly string[];
}

export interface RecoveryDefinition {
  policy: RecoveryPolicy;
  provider: { id: string; model: string };
  /** Definitions advertised to the model, including the output schema. */
  modelToolsHash: string;
  toolHashes: Record<string, string>;
}

/** Callback context is host-only. Hidden calls inside callbacks do not use SDK tree budgets. */
export interface LifecycleContext {
  readonly agentId: string;
  readonly version: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly context: ToolContext;
  readonly signal: AbortSignal;
}

export interface ModelProviderScope {
  readonly run: LifecycleContext;
  readonly operationId: string;
  readonly operationAttemptId: string;
  readonly purpose: "turn" | "compaction";
}

/** Synchronous instrumentation binding at the final dispatch boundary. Never starts a call,
 * changes routing or grants permission. A failure before dispatch leaves the provider unchanged. */
export type ModelProviderBinding = (provider: Provider, scope: ModelProviderScope) => Provider;

export interface ModelInput {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  settings: RecordedModelSettings;
}

/** Blocking checks, adapted from OpenAI Agents JS (MIT), guardrail.ts. No parallel tripwire:
 * an input must pass before dispatch, and an output before ordinary progress or history. */
export interface GuardInputs {
  modelInput: ModelInput;
  modelOutput: Turn;
  toolInput: ToolRequest;
  toolOutput: { request: ToolRequest; result: ToolResult };
}
export type GuardStage = keyof GuardInputs;
export type GuardVerdict = { allow: true } | { allow: false };
export type Guardrail<K extends GuardStage> = (
  input: GuardInputs[K],
  context: LifecycleContext,
) => GuardVerdict | Promise<GuardVerdict>;

/** Model-only history trimming. The full journal and session turn are never shortened. */
export interface CompactionPolicy {
  /** Change when the summary prompt or hidden provider configuration changes. */
  identity: string;
  /** Supply the actual window for the configured model. No model-name guessing. */
  contextWindow: number;
  /** Recent tokens to keep. Core's historyBudgetTokens(contextWindow) is the default. */
  keepTokens?: number;
  /** Omit to trim without a paid call. This provider must do inference only. The SDK sends
   * no tools, allows one attempt, counts usage and refuses interrupted summarization. */
  summarize?: { provider: Provider; instructions: string; maxTokens: number };
}
export interface CompactionDefinition {
  identity: string;
  contextWindow: number;
  keepTokens: number;
  summarize: {
    provider: { id: string; model: string };
    instructions: string;
    maxTokens: number;
  } | null;
}
export type CompactionExecution = {
  id: string;
  beforeModel: number;
  /** Count and cut in the full conversation, not in the shortened model view. */
  sourceCount: number;
  cut: number;
  model?: ModelExecution;
} & ({ status: "running" } | { status: "completed"; summary: string });

/** Per-operation budgets adapted from PydanticAI's tool_manager.py (MIT). No retries by
 * default. These retry settled failures only; crash recovery remains a separate policy. */
export interface ToolRetryPolicy {
  identity: string;
  tools: Record<
    string,
    {
      /** Includes the first attempt and any crash recovery attempts. */
      maxAttempts: number;
      /** read-only also requires isReadOnly; reconcile requires host.reconcileToolRetry. */
      replay: "read-only" | "reconcile";
    }
  >;
}
export interface ToolRetryDefinition {
  policy: ToolRetryPolicy;
  toolHashes: Record<string, string>;
}
export interface RetriedToolAttempt {
  attemptId: string;
  arguments: Record<string, unknown>;
  result: Extract<ToolResult, { ok: false }>;
  /** Host receipt proving this attempt did not run, not an unenforced idempotency key. */
  reconciliation?: string;
}

/** Node-local policy. Configure each specialist/target separately. Callbacks cannot edit data,
 * grant tool access or replace request decisions. Change identity when policy code changes. */
export type Guardrails = { [K in GuardStage]?: Guardrail<K> } & {
  identity: string;
  /** UTF-8 JSON bytes across model chunks, or in one tool result. Default 1,000,000.
   * Guarded model streams also stop at 4,096 chunks. No protected delta is sent before allow. */
  maxOutputBytes?: number;
};
export interface GuardDefinition {
  identity: string;
  stages: GuardStage[];
  maxOutputBytes: number;
}
export interface GuardRecord {
  stage: GuardStage;
  operationId: string;
  attemptId: string;
  /** Hash of the checked value; no rejected content or callback exception is saved here. */
  inputHash: string;
  status: "running" | "allowed" | "rejected" | "failed";
}

/** Privileged host inspection, NOT safe display output. End hooks see raw output before its
 * guard. Hooks are ordered and awaited, but exceptions/return values never authorize or block.
 * They may repeat after a crash. Use guards for policy and onEvent for checked progress. */
export type LifecycleEvent =
  | { type: "run_start" }
  | { type: "run_end"; state: RunState }
  | { type: "model_start"; operationId: string; attemptId: string; input: ModelInput }
  | { type: "model_end"; operationId: string; attemptId: string; turn: Turn }
  | { type: "model_error"; operationId: string; attemptId: string }
  | { type: "tool_start"; request: ToolRequest }
  | { type: "tool_end"; request: ToolRequest; result: ToolResult }
  | { type: "tool_error"; request: ToolRequest };
export type LifecycleHook = (
  event: LifecycleEvent,
  context: LifecycleContext,
) => void | Promise<void>;

/** The resolved definition used for every turn, including after a restart. No host context
 * or callbacks: they can contain credentials and process-local services. */
/** Data needed to validate stored program calls. It contains no driver, tool body or authority. */
export interface RecordedCodeTool {
  name: string;
  limits: CodeLimits;
  tools: { name: string; isReadOnly: boolean }[];
}

export interface RunDefinition {
  instructions: string;
  modelSettings: RecordedModelSettings;
  /** `RunOptions.providerSessionId`, when the run named one. */
  providerSessionId?: string;
  enabledTools: string[];
  stopAtTools: string[];
  /** `AgentConfig.runFirst`, when the agent names any. */
  runFirst?: string[];
  /** `AgentConfig.stopOnlyAtTools`, when set. */
  stopOnlyAtTools?: { nudge: string };
  /** Present for registered code tools, including ones disabled for this run. */
  codeTools?: Record<string, RecordedCodeTool>;
  /** Null refuses interrupted effects. Recorded policy and identities must match on recovery. */
  recovery: RecoveryDefinition | null;
  guardrails: GuardDefinition | null;
  compaction: CompactionDefinition | null;
  toolRetries: ToolRetryDefinition | null;
  /** Recall policy only. Memory tools are explicit registered tools, never implicit grants. */
  memory?: MemoryPolicy;
}

export interface AgentConfig<H = unknown> {
  id: string;
  /** Change this when instructions, tools or output contracts change. */
  version: string;
  /** A function runs once when the run is created; resume uses the recorded text. */
  instructions: AgentInstructions;
  /** Already composed with whatever routing, retries and watchdog the caller needs. */
  provider: Provider;
  modelSettings?: ModelSettings;
  /** Opt in before starting a run. Never retries a settled failure or an unknown write. */
  recovery?: RecoveryPolicy;
  guardrails?: Guardrails;
  compaction?: CompactionPolicy;
  toolRetries?: ToolRetryPolicy;
  /** Bounded recall, recorded before the first model call. Requires host-supplied memory. */
  memory?: AgentMemory | true;
  /** Host-only observer. Runs before RunOptions.onLifecycle at each boundary. */
  onLifecycle?: LifecycleHook;
  /** Core tools, client tools, code tools, delegations or handoffs. Terminal tools and handoffs
   * must be called alone. H is the union of the registered targets' output types. */
  tools?: readonly (Tool | Delegation | ClientTool | CodeTool | Handoff<H>)[];
  /** A host policy or allow-list. A run may narrow this list, never widen it. The reserved
   * submit_result tool stays available when there is an output contract. */
  enabledTools?: EnabledTools;
  /** End on the first successful result from these tools, in model call order, after the
   * whole batch settles. Text agents return its summary; checked agents validate its raw
   * output. A failed or invalid result goes back to the model. */
  stopAtTools?: readonly string[];
  /** Calls of these tools run before the rest of their turn, in the model's order, and the
   * rest waits for their results even when both sides may run in parallel. Models often send a
   * plan with the first step it describes; run in wire order, that step would reach the host's
   * check before the plan it depends on. Results keep the model's order. */
  runFirst?: readonly string[];
  /** End the run only through a stopping tool: `stopAtTools`, an `isTerminal` tool or
   * `submit_result`. A turn that answers in text, with no tool call, no longer ends the run:
   * the model reads `nudge` as the next user message and keeps working. A stopping tool may
   * share its turn with other calls; once it succeeds, each call after it gets a result that
   * says it did not run. `submit_result` and handoffs still run alone. When a text agent's
   * stopping tool returns an empty summary, the turn's text is the answer. The turn limit is a
   * hard cap, with no tool-free final call. */
  stopOnlyAtTools?: { nudge: string };
  limits?: Partial<RunLimits>;
  /** Applies when this agent is the root. Descendants share the root's limits. */
  treeLimits?: Partial<TreeLimits>;
}

/** T is this agent's output. H is its handoff targets' output, never checked as T. */
export type AgentDefinition<T = string, H = never> = AgentConfig<H> & { output?: ResultSchema<T> };

/** T is every possible completed output, including registered handoff chains. */
export interface Agent<T = string> {
  readonly kind: "agent";
  readonly id: string;
  readonly version: string;
  /** Invalid input throws a TypeError before anything is saved or loaded. */
  run(input: AgentInput, options?: RunOptions): Promise<RunOutcome<T>>;
  /** Structural validation is not authorization. A host must authorize every resume. */
  resume(snapshot: unknown, options: ResumeOptions): Promise<RunOutcome<T>>;
  asTool(options: SpecialistToolOptions<T>): Delegation;
  /** @internal Execution is scoped explicitly, never through global current-run state. */
  readonly [AGENT_RUNTIME]: AgentRuntime<T>;
}

export interface ToolRequest {
  /** Private model-written name, for host policy only. Never a public label or permission. */
  subagent?: string;
  agentId: string;
  version: string;
  runId: string;
  attemptId: string;
  operationId: string;
  /** Present only for a call made by a code program. Never a permission grant. */
  parentOperationId?: string;
  call: ToolCall;
  arguments: Record<string, unknown>;
}

export interface RequestScope {
  actorId: string;
  resource: { id: string; version: string };
  expiresAt: number;
}

export interface Choice {
  id: string;
  label: string;
  description?: string;
}

export interface ApprovalAsk {
  type: "approval";
  message?: string;
  /** Full argument replacement, only when trusted host policy allows it. */
  editable?: boolean;
  approveSchema?: JsonObjectSchema;
  denySchema?: JsonObjectSchema;
}

export interface QuestionAsk {
  type: "question";
  /** Stable within this call. Coordination replays match by key, not call position. */
  key: string;
  message: string;
  choices?: readonly Choice[];
  multiple?: boolean;
  freeText?: boolean;
  /** Describes form data. The host and asker must validate it at runtime. */
  schema?: JsonObjectSchema;
}

export interface ClientAsk {
  type: "client";
  resultSchema: JsonObjectSchema;
}

export type Ask = ApprovalAsk | QuestionAsk | ClientAsk;

export type RequestOrigin =
  | { call: ToolRequest; step?: never }
  | { step: StepRequest; call?: never };

export type PendingRequest = RequestOrigin & {
  id: string;
  /** Absolute path from the logical root, derived by the SDK, never supplied by the client. */
  path: ChildPathStep[];
  definitionHash: string;
  ask: Ask;
  scope: RequestScope;
  createdAt: number;
};

export interface Answer {
  choices?: string[];
  text?: string;
  data?: unknown;
}

export type Decision =
  | { type: "approve"; arguments?: Record<string, unknown>; data?: unknown; receipt?: string }
  | { type: "deny"; message?: string; data?: unknown; receipt?: string }
  | { type: "answer"; answer: Answer; receipt?: string }
  | { type: "result"; value: unknown; receipt?: string }
  | { type: "cancel"; receipt?: string }
  | { type: "stop"; receipt?: string };

export type Resolution = Decision | { type: "pending"; problem?: string };

export interface RequestProblem {
  code: "expired" | "stale" | "invalid_answer" | "refused";
  message: string;
}

export interface AskRecord {
  request: PendingRequest;
  /** Written once before any effect. A stored decision is data, not permission. */
  decision?: Decision;
  closed?: "expired" | "stale" | "invalid" | "stopped";
  problem?: RequestProblem;
}

export interface ChildPathStep {
  operationId: string;
  key: string;
  runId: string;
}

export interface ChildEnvelope {
  snapshot: TreeNode;
  /** An opaque host execution segment, not an independently owned SDK run. */
  reference?: string;
}

export interface ChildRequest extends ChildEnvelope {
  key: string;
  parentRunId: string;
  operationId: string;
  /** A stored SDK child needs resuming, not replay of a successful host segment. */
  resume: boolean;
}

/** Host callbacks are trusted code, never functions reconstructed from a client snapshot.
 * Data passed to callbacks is a frozen copy, not the loop's live state. Without checkpoint,
 * execution is in-memory only. Checkpoints are not leases or exactly-once effect guarantees. */
export interface AgentHost {
  /** New user messages for the root's active conversation owner, never every specialist.
   * A durable host must supply durable authenticated storage. Does not answer human requests. */
  inbox?: InputInbox;
  /** Required progress storage, separate from best-effort onEvent. push synchronously accepts
   * a frozen event into a bounded buffer; flush must report any write failure, not hide it.
   * The loop awaits flush before every checkpoint and final outcome, including children. */
  progress?: {
    push(event: AgentEvent): void;
    flush(): Promise<void>;
  };
  /** Persist the whole snapshot before returning. Writes are serialized within this attempt. */
  checkpoint?: (snapshot: TreeNode) => void | Promise<void>;
  /** Load/compare authoritative state and check ownership and freshness, or throw.
   * The host must also exclude concurrent attempts; this loop does not take a lease. */
  authorizeResume?: (snapshot: TreeNode) => void | Promise<void>;
  /** May require approval for an unmarked tool, never waive a tool's needsApproval. */
  needsApproval?: (call: ToolRequest) => boolean | Promise<boolean>;
  /** Runs for each call the model or a code program makes, right before it would start.
   * Return nothing to let it run. `{ refuse }` answers this call with that text instead, as
   * the model's result for it: the tool does not run and no request opens. `{ cancel }`
   * answers this call and every call after it in its turn with that text, and holds after a
   * restart. A call that needs approval is also screened before its approval opens, so nobody
   * is asked about a call the host refuses, and again before it runs, since the calls ahead
   * of it ran in the meantime. Specialists' calls come here too, each with its own run's
   * `earlier`. Decide from `earlier` rather than process state: after a restart, calls that
   * had not started are screened again. */
  screenCall?: (
    call: ToolRequest,
    run: ScreenContext,
  ) => CallVerdict | undefined | Promise<CallVerdict | undefined>;
  /** Required to open a request. Supplies trusted actor, resource version and expiry.
   * Only an approval's presentation/edit policy may be overridden. */
  prepareRequest?: (
    draft: RequestOrigin & Omit<PendingRequest, "scope" | "call" | "step">,
  ) =>
    | { scope: RequestScope; ask?: ApprovalAsk }
    | Promise<{ scope: RequestScope; ask?: ApprovalAsk }>;
  /** Optional standing host policy. undefined leaves the request pending. */
  answerNow?: (request: PendingRequest) => Decision | undefined | Promise<Decision | undefined>;
  /** Authenticate evidence, validate form data and consume it for this exact request. Recovery
   * of the same host claim must return the same decision; another claim must be refused. */
  resolveRequest?: (request: PendingRequest, evidence: unknown) => Resolution | Promise<Resolution>;
  /** Recheck current access and resource version, with the arguments that will run. Required
   * for every invocation carrying a decision, and before exposing a client-tool request. */
  beforeTool?: (
    call: ToolRequest,
    decided?: { request: PendingRequest; decision: Decision },
  ) => void | Promise<void>;
  /** Authoritatively query the external service for this exact failed attempt. Return not_run
   * only when it cannot still complete. An error string or literal key is not proof. Never
   * dispatch from this callback. Requests and control tools cannot use this retry path. */
  reconcileToolRetry?: (
    attempt: { request: ToolRequest; result: Extract<ToolResult, { ok: false }> },
    context: LifecycleContext,
  ) =>
    | { outcome: "not_run"; receipt: string }
    | { outcome: "unknown" }
    | Promise<{ outcome: "not_run"; receipt: string } | { outcome: "unknown" }>;
  /** Required before every workflow effect or use of an answer. Check current ownership and lease. */
  beforeStep?: (
    step: StepRequest,
    decided?: { request: PendingRequest; decision: Decision },
  ) => void | Promise<void>;
  reconcileStep?: (
    step: StepRequest,
    attempt: { attemptId: string; error?: StepError },
    signal: AbortSignal,
  ) =>
    | { outcome: "not_run"; receipt: string }
    | { outcome: "unknown" }
    | Promise<{ outcome: "not_run"; receipt: string } | { outcome: "unknown" }>;
  /** Both this callback and the tool's isConcurrencySafe flag must allow batching. */
  canRunConcurrently?: (request: ToolRequest) => boolean;
  /** Optional in-process child binding under this root's lease and cancellation.
   * A host may return a saved envelope. To resume a suspended SDK child it must call
   * execute in a new/resumable segment, not treat a cached suspension as completion.
   * execute may be called once, and must settle before the hook returns. */
  child?: (request: ChildRequest, execute: () => Promise<ChildEnvelope>) => Promise<ChildEnvelope>;
  /** Check that this run's owner may read the media, then return its bytes as base64. Called
   * once per id per attempt, before the model call that needs it. An id is not permission. */
  loadMedia?: (
    ref: MediaRef,
    run: { runId: string; signal: AbortSignal },
  ) => string | Promise<string>;
  /** USD for one model call's usage, from the host's own rates: no price table ships here, and
   * core's `costUsd(usage, rate)` does the arithmetic. Required by `limits.costUsd`. Called
   * when usage arrives and when the call completes, then saved in the journal, so a resumed
   * run never prices a saved call again, even when the host's prices change by time of day.
   * Synchronous; return a finite amount of 0 or more. */
  priceModelCall?: (call: MeasuredModelCall) => number;
}

/** One model call's usage and the endpoint that served it: the turn's source when a fallback
 * named it, otherwise the agent's provider. */
export interface MeasuredModelCall {
  usage: TokenUsage;
  provider: string;
  model: string;
}

/** What `host.screenCall` decides for one call, as text the model reads as its result. */
export type CallVerdict = { refuse: string } | { cancel: string };

/** What `host.screenCall` knows besides the call itself. */
export interface ScreenContext {
  /** The model turn that asked for this call, counting from 0. */
  turn: number;
  /** The calls this run handled before this one, so a policy can count them. Turn by turn,
   * each turn in run order: `runFirst` calls come before the calls they ran ahead of. */
  earlier: readonly EarlierCall[];
}

/** One of this run's calls that came before the one being screened: settled, refused,
 * running, waiting for a person, or let through earlier in the same batch. */
export interface EarlierCall {
  operationId: string;
  /** The program call that made it, for a call from code mode. */
  parentOperationId?: string;
  /** The model turn that asked for it, counting from 0. */
  turn: number;
  name: string;
  /** What the model or the program wrote, before any approved edit. */
  arguments: Record<string, unknown>;
  /** Absent until the call has a result. `refused` and `cancelled` calls never ran. */
  result?:
    | { ok: true; kind?: never }
    | { ok: false; kind: Extract<ToolResult, { ok: false }>["kind"] };
}

export interface RunOptions {
  runId?: string;
  signal?: AbortSignal;
  /** Overrides agent settings for this run. Recorded settings cannot change on resume. */
  modelSettings?: ModelSettings;
  /** The id this run's model calls send as core's `sessionId`, which some providers route and
   * cache by: OpenCode Go's session header, the ChatGPT backend's `session-id` and
   * `prompt_cache_key` on the Responses shape. Defaults to the run id, so each run is its own
   * session. Pass the conversation id to keep one provider session across a conversation's
   * turns. Recorded when the run starts; resume keeps it. Never passed to specialists. */
  providerSessionId?: string;
  /** Narrows the agent's enabled tools for this run. Resolved once, before saving. */
  enabledTools?: EnabledTools;
  /** Passed to tools with reserved runId, attemptId, operationId, callId, signal and reportCost
   * supplied by the loop. `reportCost(usd)` adds what the call spent outside the model calls. */
  context?: ToolContext;
  /** Trusted binding from authentication. Never select a scope from model arguments. */
  memory?: MemoryBinding;
  host?: AgentHost;
  /** Best-effort progress from the one stream reader. Observer errors do not stop work. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /** Privileged observer, inherited by children. Return values and failures are ignored. */
  onLifecycle?: LifecycleHook;
  /** Per-dispatch provider instrumentation. Inherited by children, never saved in checkpoints.
   * Does not wrap tool execution or install an ambient async context manager. */
  bindModelProvider?: ModelProviderBinding;
  /** Loads the history once, before the run is saved, and appends the turn once the run
   * settles. The input must then be the new turn only, not `{ messages }`. Never passed to
   * specialists. */
  session?: Session;
  /** How many of the session's newest messages to load. Needs `session`. */
  historyLimit?: number;
  /** Runs once on the loaded or supplied history, before the run is saved, to trim or
   * summarize it. Its result is frozen in the snapshot; resume never calls it again. */
  prepareHistory?: (history: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
}

export interface ResumeOptions extends Omit<
  RunOptions,
  | "runId"
  | "session"
  | "historyLimit"
  | "prepareHistory"
  | "modelSettings"
  | "enabledTools"
  | "providerSessionId"
> {
  host: AgentHost & { authorizeResume: NonNullable<AgentHost["authorizeResume"]> };
  /** The run's own session, so the turn is appended once the run settles. Resume never loads
   * it again: the history stays the one the snapshot froze. Another session is refused. */
  session?: Session;
  /** Untrusted JSON evidence by request id. Unknown, closed and already-decided ids are refused. */
  answers?: Readonly<Record<string, unknown>>;
}

export interface RunFailure {
  code: string;
  message: string;
  operationId?: string;
}

export type LimitReason =
  | "turns"
  | "toolCalls"
  | "elapsedMs"
  | "outputTokens"
  | "maxChildren"
  | "maxDepth"
  | "modelCalls"
  | "steps"
  | "treeElapsedMs"
  | "costUsd";

export type RunState =
  | { status: "running" }
  /** Saves the original result input, not a validator's potentially non-JSON return value.
   * After a handoff this is the active target's candidate, validated only by that target. */
  | { status: "completed"; candidate: unknown }
  | { status: "suspended" }
  | { status: "cancelled" }
  | { status: "limited"; limit: LimitReason }
  | { status: "failed"; error: RunFailure };

export type ToolResult =
  /** final keeps the raw stopping-tool output (or summary for text agents), not the
   * validator's possibly non-JSON return value. Restoring can validate without replay. */
  | {
      ok: true;
      content: string;
      /** Core image parts, forwarded with the text in the next tool message. */
      images?: ImagePart[];
      /** JSON output for trusted host inspection. Not a browser display policy. Rich part
       * arrays use content/images instead so inline bytes are not stored twice. */
      output?: unknown;
      final?: { candidate: unknown };
    }
  | {
      ok: false;
      content: string;
      /** `refused`: `host.screenCall` refused the call before it started. */
      kind:
        | ToolFailure
        | "denied"
        | "refused"
        | "cancelled"
        | "unknown_tool"
        | "disabled_tool"
        | "invalid_output"
        | "interrupted";
    };

export interface InterruptedAttempt {
  attemptId: string;
}

/** Last measured usage, not a final bill. An interrupted call may have cost more. */
export interface InterruptedModelAttempt extends InterruptedAttempt {
  usage: TokenUsage;
  /** The host's price for that usage, kept from the attempt. Never priced again. */
  costUsd?: number;
}

/** USD one attempt of a tool call reported, the sum of its `reportCost` calls. Kept apart from
 * the call's own record, so a retry, a restart or a request never drops a charge. */
export interface ToolCost {
  /** The call's operation id, or a code program's inner call id. */
  operationId: string;
  attemptId: string;
  costUsd: number;
}

/** Private inner-call journal. IDs increase across program restarts; old calls never replay. */
export type ProgramCall = {
  id: string;
  attemptId: string;
  /** The outer program attempt which admitted this call. */
  programAttemptId: string;
  name: string;
  arguments: Record<string, unknown>;
  /** False means dispatch never started, even if this receipt is now completed. */
  started: boolean;
  asks?: AskRecord[];
  interrupted: InterruptedAttempt[];
  retries: RetriedToolAttempt[];
  /** Current attempt's JSON output size, or failure text size. Result content is at most 1 KiB. */
  bytes?: number;
} & (
  | { status: "pending"; previousAttemptId?: string }
  | { status: "running" }
  | { status: "completed"; result: ToolResult }
);

export type ToolExecution = {
  asks?: AskRecord[];
  /** Code tools only. Kept across a read-only program restart. */
  calls?: ProgramCall[];
  interrupted: InterruptedAttempt[];
  retries: RetriedToolAttempt[];
} & (
  | {
      id: string;
      status: "pending";
      /** Failed or interrupted attempt being replaced. Saved before replacement admission. */
      previousAttemptId?: string;
    }
  | { id: string; status: "running"; attemptId: string }
  /** Pure coordination can replay. Its children keep their own effect journals. */
  | { id: string; status: "delegating"; attemptId: string }
  | { id: string; status: "completed"; attemptId: string; result: ToolResult }
);

export type ModelExecution = {
  interrupted: InterruptedModelAttempt[];
  billing: "unknown" | "reported";
  /** What `host.priceModelCall` returned for this attempt's usage when it arrived. Absent
   * without a price function or before any usage. */
  costUsd?: number;
} & (
  | { id: string; attemptId: string; status: "running"; usage: TokenUsage }
  | {
      id: string;
      attemptId: string;
      status: "completed";
      usage: TokenUsage;
      turn: Turn;
      tools: ToolExecution[];
    }
);

export interface AgentRef {
  id: string;
  version: string;
}

/** A server-side receipt. The note is model-written context, never authority. */
export interface HandoffReceipt {
  operationId: string;
  runId: string;
  childRunId: string;
  from: AgentRef;
  to: AgentRef;
  note?: string;
}

export type DelegationExecution = {
  operationId: string;
  /** Admission order is the deterministic join/request order. Receipts are never removed. */
  children: (ChildEnvelope & { key: string })[];
} & ({ kind: "delegation" } | { kind: "handoff"; target: AgentRef; note?: string });

/** JSON-serializable execution journal. Contains private prompts, arguments and results;
 * the host owns storage, access and retention. Never accept it as proof of permission, and
 * never send it to a browser. */
export interface RunSnapshot {
  kind: "agent";
  format: 3;
  agentId: string;
  version: string;
  runId: string;
  attemptId: string;
  startedAt: number;
  /** Resolved once before the first checkpoint. Resume never reruns definition callbacks. */
  definition: RunDefinition;
  /** Present only for model-created helpers. Private definition and frozen host capabilities. */
  subagent?: SubagentRecord;
  /** Private model-input data, recorded once. Never part of the session transcript. */
  recall?: MemoryRecall;
  /** The conversation before the new turn, repaired once when the run was created and never
   * read again, so every request starts with the same bytes. Never a system message. */
  history: AgentMessage[];
  /** The new user turn. */
  input: UserContent;
  /** Accepted user messages, in order at safe model boundaries. Never replaces frozen input. */
  inputs: RunInput[];
  /** Guard checks are journaled before callbacks and before releasing their checked output. */
  guards: GuardRecord[];
  /** Completed model-view cuts and any in-flight paid summary. Never session edits. */
  compactions: CompactionExecution[];
  /** What tools reported spending through `context.reportCost`, one entry per call attempt, in
   * the order they first reported. Absent until a tool reports. */
  toolCosts?: ToolCost[];
  /** The session the history came from, and the revision a settled run appends after. */
  session?: { id: string; revision: string | null };
  limits: RunLimits;
  models: ModelExecution[];
  delegations: DelegationExecution[];
  /** Identical in every node. Admissions are counted from the journals, including running work. */
  tree: { runId: string; startedAt: number; limits: TreeLimits; memory?: MemoryScopes };
  state: RunState;
}

/** Stable operation identity; an attempt changes on resume, an operation does not.
 * A model receipt's usage may be partial if the stream failed. */
export type OperationReceipt =
  | RemoteReceipt
  | {
      kind: "model";
      purpose?: "compaction";
      id: string;
      attemptId: string;
      status: "running" | "completed" | "interrupted";
      /** reported means a stream with usage ended, not that the SDK verified the vendor's bill. */
      billing: "unknown" | "reported";
      usage: TokenUsage;
      /** The host's price for this usage, saved when it arrived. */
      costUsd?: number;
      source?: Turn["source"];
    }
  | {
      kind: "tool" | "delegation" | "handoff";
      id: string;
      parentOperationId?: string;
      callId: string;
      attemptId: string;
      /** `asked`: the attempt reported a cost, then stopped to ask the person. The answer runs the
       * tool again as a new attempt with its own receipt, so the charge stays on this one. An
       * attempt that asked without reporting a cost gets no receipt. */
      status: "running" | "completed" | "interrupted" | "asked";
      result?: ToolResult;
      /** What this attempt reported through `context.reportCost`. */
      costUsd?: number;
    };

interface RunRecord {
  runId: string;
  attemptId: string;
  usage: TokenUsage;
  /** This run and all descendants, deduplicated by stable model receipt IDs. */
  treeUsage: TokenUsage;
  /** The last admitted agent on this run's handoff chain. Delegated specialists do not change
   * their parent's conversation owner. Route the next turn by both id and version. */
  activeAgent: AgentRef;
  handoffs: HandoffReceipt[];
  /** The active agent's settled conversation, without its system prompt. May contain an
   * SDK-written transfer note, not a person's message. Server-only, not a display transcript. */
  history: AgentMessage[];
  /** The original new turn and settled rounds along its handoff chain. Excludes transferred
   * history and synthetic transfer inputs, so session append never duplicates earlier turns. */
  newMessages: AgentMessage[];
  receipts: OperationReceipt[];
  /** Input delivery receipts. Queued messages still held by the host are not in the journal. */
  inputs: InputReceipt[];
  snapshot: RunSnapshot;
  /** Present when the run has a session. An append that failed never changes the run's own
   * status. */
  session?: SessionStatus;
}

export type RunOutcome<T = string> = RunRecord &
  (
    | { status: "completed"; output: T }
    | {
        status: "suspended";
        requests: (PendingRequest & { problem?: RequestProblem })[];
        wakeAt?: number;
      }
    | { status: "cancelled" }
    | { status: "limited"; limit: LimitReason }
    | { status: "failed"; error: RunFailure }
  );

export type AgentEvent =
  /** Portable start identity for nodes without agent lifecycle hooks. No host context or
   * signal is serialized. Cached terminal nodes do not emit a new execution start. */
  | {
      type: "execution_start";
      kind: "workflow" | "remote";
      nodeId: string;
      version: string;
      runId: string;
      attemptId: string;
    }
  | {
      type: "remote_status";
      runId: string;
      attemptId: string;
      operationId: string;
      state: import("./a2a/wire.ts").A2AState;
    }
  | ({ runId: string; attemptId: string; operationId: string; key: string } & (
      | { type: "step_start"; kind: StepKind; attempt: number }
      | { type: "step_progress"; data: unknown }
      | {
          type: "step_result";
          kind: StepKind;
          status: "completed" | "retrying" | "failed";
          error?: StepError;
        }
    ))
  /** Best-effort delivery update without the input's content. The snapshot is authoritative. */
  | { type: "input"; receipt: InputReceipt }
  /** Sent before the target's progress, also on resume. Upsert by operationId. Raw events
   * remain server-only; project only the identities and labels your viewer may see. */
  | ({ type: "handoff"; attemptId: string } & HandoffReceipt)
  /** Replace the interrupted attempt's partial display, do not append to it. Saved attempts
   * are authoritative if this best-effort event is missed. */
  | {
      type: "operation_restart";
      kind: "model" | "tool";
      runId: string;
      operationId: string;
      previousAttemptId: string;
      attemptId: string;
      parentOperationId?: string;
    }
  | {
      type: "model_chunk";
      runId: string;
      attemptId: string;
      operationId: string;
      chunk: ProviderChunk;
    }
  | { type: "request"; request: PendingRequest }
  | { type: "decision"; requestId: string; decision: Decision }
  | { type: "tool_start"; request: ToolRequest }
  | { type: "tool_result"; request: ToolRequest; result: ToolResult }
  | { type: "state"; runId: string; attemptId: string; state: RunState }
  /** Names the specialist run a delegation is starting or resuming, before that run reports
   * anything, so an observer can file the run's events under its parent without reading ID
   * formats. Best-effort progress like every other event: it can be missed, and it carries no
   * status (the child's own state event and the snapshot do). A child resumed after an approval
   * or an interruption sends it again with the same identity, so upsert by runId. Only a child
   * that runs here sends it: a settled child that is reused, or one the host serves from a
   * saved copy, stays silent. */
  | ({
      type: "child";
      /** A model-created helper. Its private name, instructions and task are not display data. */
      subagent?: true;
      parentRunId: string;
      operationId: string;
      key: string;
      runId: string;
      version: string;
    } & ({ kind: "agent" | "remote"; agentId: string } | { kind: "workflow"; workflowId: string }));
