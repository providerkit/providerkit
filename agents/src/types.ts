import type {
  ChatMessage,
  JsonObjectSchema,
  Provider,
  ProviderChunk,
  TokenUsage,
  Tool,
  ToolCall,
  ToolContext,
  ToolFailure,
  Turn,
} from "@providerkit/core";

/** Limits for one run, not a whole tree of delegated runs. Cancellation is cooperative:
 * an admitted call can still finish or incur a charge after the signal aborts. */
export interface RunLimits {
  turns: number;
  toolCalls: number;
  /** Wall time, including time spent waiting for approval. */
  elapsedMs: number;
  parallelTools: number;
}

export interface ResultSchema<T> {
  schema: JsonObjectSchema;
  /** Pure runtime validation. Throw to reject; also used when restoring a result. */
  validate: (value: unknown) => T;
}

export interface AgentConfig {
  id: string;
  /** Change this when instructions, tools or output contracts change. */
  version: string;
  instructions: string;
  /** Already composed with whatever routing, retries and watchdog the caller needs. */
  provider: Provider;
  /** Core tools. Use output for a terminal tool; user-supplied terminal tools are refused. */
  tools?: readonly Tool[];
  limits?: Partial<RunLimits>;
}

export type AgentDefinition<T = string> = AgentConfig & { output?: ResultSchema<T> };

export interface Agent<T = string> {
  readonly id: string;
  readonly version: string;
  run(input: string, options?: RunOptions): Promise<RunOutcome<T>>;
  /** Structural validation is not authorization. A host must authorize every resume. */
  resume(snapshot: unknown, options: ResumeOptions): Promise<RunOutcome<T>>;
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
}

export interface RunOptions {
  runId?: string;
  signal?: AbortSignal;
  /** Passed to tools with reserved runId, attemptId, operationId, callId and signal supplied by the loop. */
  context?: ToolContext;
  host?: AgentHost;
  /** Best-effort progress from the one stream reader. Observer errors do not stop work. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface ResumeOptions extends Omit<RunOptions, "runId"> {
  host: AgentHost & { authorizeResume: NonNullable<AgentHost["authorizeResume"]> };
  /** JSON evidence for resolveApproval, never a trusted approve flag. */
  decision?: unknown;
}

export interface RunFailure {
  code: string;
  message: string;
  operationId?: string;
}

export type LimitReason = "turns" | "toolCalls" | "elapsedMs" | "outputTokens";

export type RunState =
  | { status: "running" }
  /** Saves the original result input, not a validator's potentially non-JSON return value. */
  | { status: "completed"; candidate: unknown }
  | { status: "suspended"; approval: PendingApproval }
  | { status: "cancelled" }
  | { status: "limited"; limit: LimitReason }
  | { status: "failed"; error: RunFailure };

export type ToolResult =
  | { ok: true; content: string }
  | { ok: false; content: string; kind: ToolFailure | "denied" | "unknown_tool" };

export type ToolExecution =
  | { id: string; status: "pending" }
  | { id: string; status: "running"; attemptId: string }
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

/** JSON-serializable execution journal. Contains private prompts, arguments and results;
 * the host owns storage, access and retention. Never accept it as proof of permission. */
export interface RunSnapshot {
  format: 1;
  agentId: string;
  version: string;
  runId: string;
  attemptId: string;
  startedAt: number;
  input: string;
  limits: RunLimits;
  models: ModelExecution[];
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
      kind: "tool";
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
  /** Whole settled turns only. An unfinished tool round remains in snapshot.models. */
  history: ChatMessage[];
  receipts: OperationReceipt[];
  snapshot: RunSnapshot;
}

export type RunOutcome<T = string> = RunRecord &
  (
    | { status: "completed"; output: T }
    | { status: "suspended"; approval: PendingApproval }
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
  | { type: "state"; runId: string; attemptId: string; state: RunState };
