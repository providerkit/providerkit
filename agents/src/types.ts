import type {
  ChatMessage,
  ContentPart,
  FileMimeType,
  ImageMimeType,
  JsonObjectSchema,
  Provider,
  ProviderChunk,
  StreamOptions,
  TokenUsage,
  Tool,
  ToolCall,
  ToolContext,
  ToolFailure,
  Turn,
} from "@providerkit/core";

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
   * against the tree's model-call budget. Checked-output agents keep the hard cap. */
  turns: number;
  toolCalls: number;
  /** Wall time, including time spent waiting for approval. */
  elapsedMs: number;
  parallelTools: number;
  /** Decoded bytes of the images and files sent inline, history and new turn together. The
   * snapshot holds them, and every checkpoint writes the whole snapshot again, so large files
   * belong behind a MediaRef. Zero accepts media references only. */
  inlineBytes: number;
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
 * the loop. Provider defaults apply first, then agent settings, then run settings. */
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

/** The resolved definition used for every turn, including after a restart. No host context
 * or callbacks: they can contain credentials and process-local services. */
export interface RunDefinition {
  instructions: string;
  modelSettings: RecordedModelSettings;
  enabledTools: string[];
  stopAtTools: string[];
}

export interface AgentConfig {
  id: string;
  /** Change this when instructions, tools or output contracts change. */
  version: string;
  /** A function runs once when the run is created; resume uses the recorded text. */
  instructions: AgentInstructions;
  /** Already composed with whatever routing, retries and watchdog the caller needs. */
  provider: Provider;
  modelSettings?: ModelSettings;
  /** Core tools or delegation descriptors. A host terminal tool must be called alone. */
  tools?: readonly (Tool | Delegation)[];
  /** A host policy or allow-list. A run may narrow this list, never widen it. The reserved
   * submit_result tool stays available when there is an output contract. */
  enabledTools?: EnabledTools;
  /** End on the first successful result from these tools, in model call order, after the
   * whole batch settles. Text agents return its summary; checked agents validate its raw
   * output. A failed or invalid result goes back to the model. */
  stopAtTools?: readonly string[];
  limits?: Partial<RunLimits>;
  /** Applies when this agent is the root. Descendants share the root's limits. */
  treeLimits?: Partial<TreeLimits>;
}

export type AgentDefinition<T = string> = AgentConfig & { output?: ResultSchema<T> };

export interface Agent<T = string> {
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
  agentId: string;
  version: string;
  runId: string;
  attemptId: string;
  operationId: string;
  call: ToolCall;
  arguments: Record<string, unknown>;
}

export interface ApprovalScope {
  actorId: string;
  resource: { id: string; version: string };
  expiresAt: number;
}

export interface PendingApproval {
  request: ToolRequest;
  scope: ApprovalScope;
}

export interface ChildPathStep {
  operationId: string;
  key: string;
  runId: string;
}

export interface ChildEnvelope {
  snapshot: RunSnapshot;
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
  /** Persist the whole snapshot before returning. Writes are serialized within this attempt. */
  checkpoint?: (snapshot: RunSnapshot) => void | Promise<void>;
  /** Load/compare authoritative state and check ownership and freshness, or throw.
   * The host must also exclude concurrent attempts; this loop does not take a lease. */
  authorizeResume?: (snapshot: RunSnapshot) => void | Promise<void>;
  /** Supplies the actor and resource version from trusted host state. */
  approvalContext?: (request: ToolRequest) => ApprovalScope | Promise<ApprovalScope>;
  /** Authenticate and consume a decision once. A supplied value is evidence, not permission.
   * A crash after consumption but before the running marker may need host reconciliation. */
  resolveApproval?: (
    approval: PendingApproval,
    decision: unknown,
  ) => "approved" | "denied" | "pending" | Promise<"approved" | "denied" | "pending">;
  /** Recheck permissions and resource versions immediately before each invocation.
   * Required before executing an approved call. Throw to refuse the run. */
  beforeTool?: (request: ToolRequest, approval?: PendingApproval) => void | Promise<void>;
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
}

export interface RunOptions {
  runId?: string;
  signal?: AbortSignal;
  /** Overrides agent settings for this run. Recorded settings cannot change on resume. */
  modelSettings?: ModelSettings;
  /** Narrows the agent's enabled tools for this run. Resolved once, before saving. */
  enabledTools?: EnabledTools;
  /** Passed to tools with reserved runId, attemptId, operationId, callId and signal supplied by the loop. */
  context?: ToolContext;
  host?: AgentHost;
  /** Best-effort progress from the one stream reader. Observer errors do not stop work. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
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
  "runId" | "session" | "historyLimit" | "prepareHistory" | "modelSettings" | "enabledTools"
> {
  host: AgentHost & { authorizeResume: NonNullable<AgentHost["authorizeResume"]> };
  /** The run's own session, so the turn is appended once the run settles. Resume never loads
   * it again: the history stays the one the snapshot froze. Another session is refused. */
  session?: Session;
  /** JSON evidence for resolveApproval, never a trusted approve flag. */
  decision?: unknown;
  /** Exact path from the suspended outcome. Required for descendant decision evidence. */
  approvalPath?: readonly ChildPathStep[];
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
  | "treeElapsedMs";

export type RunState =
  | { status: "running" }
  /** Saves the original result input, not a validator's potentially non-JSON return value. */
  | { status: "completed"; candidate: unknown }
  | { status: "suspended"; approval: PendingApproval; path: ChildPathStep[] }
  | { status: "cancelled" }
  | { status: "limited"; limit: LimitReason }
  | { status: "failed"; error: RunFailure };

export type ToolResult =
  /** final keeps the raw stopping-tool output (or summary for text agents), not the
   * validator's possibly non-JSON return value. Restoring can validate without replay. */
  | { ok: true; content: string; final?: { candidate: unknown } }
  | {
      ok: false;
      content: string;
      kind: ToolFailure | "denied" | "unknown_tool" | "disabled_tool" | "invalid_output";
    };

export type ToolExecution =
  | { id: string; status: "pending" }
  | { id: string; status: "running"; attemptId: string }
  /** Pure coordination can replay. Its children keep their own effect journals. */
  | { id: string; status: "delegating"; attemptId: string }
  | { id: string; status: "completed"; attemptId: string; result: ToolResult };

export type ModelExecution =
  | { id: string; attemptId: string; status: "running"; usage: TokenUsage }
  | {
      id: string;
      attemptId: string;
      status: "completed";
      usage: TokenUsage;
      turn: Turn;
      tools: ToolExecution[];
    };

export interface DelegationExecution {
  operationId: string;
  /** Admission order is the deterministic join/approval order. Receipts are never removed. */
  children: (ChildEnvelope & { key: string })[];
}

/** JSON-serializable execution journal. Contains private prompts, arguments and results;
 * the host owns storage, access and retention. Never accept it as proof of permission, and
 * never send it to a browser. */
export interface RunSnapshot {
  format: 3;
  agentId: string;
  version: string;
  runId: string;
  attemptId: string;
  startedAt: number;
  /** Resolved once before the first checkpoint. Resume never reruns definition callbacks. */
  definition: RunDefinition;
  /** The conversation before the new turn, repaired once when the run was created and never
   * read again, so every request starts with the same bytes. Never a system message. */
  history: AgentMessage[];
  /** The new user turn. */
  input: UserContent;
  /** The session the history came from, and the revision a settled run appends after. */
  session?: { id: string; revision: string | null };
  limits: RunLimits;
  models: ModelExecution[];
  delegations: DelegationExecution[];
  /** Identical in every node. Admissions are counted from the journals, including running work. */
  tree: { runId: string; startedAt: number; limits: TreeLimits };
  state: RunState;
}

/** Stable operation identity; an attempt changes on resume, an operation does not.
 * A model receipt's usage may be partial if the stream failed. */
export type OperationReceipt =
  | {
      kind: "model";
      id: string;
      attemptId: string;
      status: "running" | "completed";
      usage: TokenUsage;
      source?: Turn["source"];
    }
  | {
      kind: "tool" | "delegation";
      id: string;
      callId: string;
      attemptId: string;
      status: "running" | "completed";
      result?: ToolResult;
    };

interface RunRecord {
  runId: string;
  attemptId: string;
  usage: TokenUsage;
  /** This run and all descendants, deduplicated by stable model receipt IDs. */
  treeUsage: TokenUsage;
  /** The history, the new turn and whole settled rounds, without the system prompt. An
   * unfinished tool round remains in snapshot.models. Server-side: pass it through
   * toClientMessages before it reaches a browser. */
  history: AgentMessage[];
  /** The new turn and this run's settled rounds: what a session appends. */
  newMessages: AgentMessage[];
  receipts: OperationReceipt[];
  snapshot: RunSnapshot;
  /** Present when the run has a session. An append that failed never changes the run's own
   * status. */
  session?: SessionStatus;
}

export type RunOutcome<T = string> = RunRecord &
  (
    | { status: "completed"; output: T }
    | { status: "suspended"; approval: PendingApproval; path: ChildPathStep[] }
    | { status: "cancelled" }
    | { status: "limited"; limit: LimitReason }
    | { status: "failed"; error: RunFailure }
  );

export type AgentEvent =
  | {
      type: "model_chunk";
      runId: string;
      attemptId: string;
      operationId: string;
      chunk: ProviderChunk;
    }
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
  | {
      type: "child";
      parentRunId: string;
      operationId: string;
      key: string;
      runId: string;
      agentId: string;
      version: string;
    };
