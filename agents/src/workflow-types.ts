import type { TokenUsage, ToolContext } from "@providerkit/core";
import type {
  AGENT_RUNTIME,
  Delegation,
  NodeRuntime,
  SpecialistToolOptions,
} from "./delegation.ts";
import type {
  Agent,
  AgentInput,
  Answer,
  AskRecord,
  ChildEnvelope,
  PendingRequest,
  RequestProblem,
  QuestionAsk,
  ResultSchema,
  ResumeOptions,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  RunState,
  TreeLimits,
} from "./types.ts";

export type StepKind = "step" | "agent" | "workflow" | "ask" | "sleep";
export interface StepError {
  reason: "failed" | "timeout" | "denied" | "cancelled";
  name: string;
  message: string;
}
export interface WorkflowLimits {
  steps: number;
  parallelSteps: number;
  /** Zero (default) always returns control for a future wake. */
  inlineWaitMs: number;
  resultBytes: number;
}
export interface StepRequest {
  workflowId: string;
  version: string;
  runId: string;
  attemptId: string;
  operationId: string;
  key: string;
  kind: StepKind;
  input?: unknown;
}
export interface StepAttempt {
  attemptId: string;
  status: "running" | "completed" | "failed" | "interrupted" | "not_run";
  error?: StepError;
  reconciliation?: string;
}
export interface StepExecution {
  id: string;
  key: string;
  kind: StepKind;
  /** JSON identity: input, target definition and effect/retry policy. */
  definition: Record<string, unknown>;
  status: "pending" | "running" | "waiting" | "retrying" | "completed" | "failed";
  attempts: StepAttempt[];
  result?: unknown;
  error?: StepError;
  wakeAt?: number;
  children: (ChildEnvelope & { key: string })[];
  asks?: AskRecord[];
  /** Authoritative not-run evidence for whole-child retries, keyed by child run id. */
  reconciliations?: Record<string, string>;
}
export interface ChildRetry {
  maxAttempts: number;
  /** Host assertion that the whole child is read-only, or host reconciliation of all its effects. */
  replay: "read-only" | "reconcile";
  retryOn?: (outcome: RunOutcome<unknown> | WorkflowOutcome<unknown>) => boolean;
}
export interface WorkflowSnapshot {
  format: 3;
  kind: "workflow";
  workflowId: string;
  version: string;
  runId: string;
  attemptId: string;
  startedAt: number;
  input: unknown;
  definition: Record<string, unknown>;
  limits: WorkflowLimits;
  steps: StepExecution[];
  tree: RunSnapshot["tree"];
  state: RunState;
}
export type WorkflowRunOptions = Pick<
  RunOptions,
  | "runId"
  | "signal"
  | "context"
  | "memory"
  | "host"
  | "onEvent"
  | "onLifecycle"
  | "bindModelProvider"
>;
export type WorkflowResumeOptions = Omit<ResumeOptions, "session">;
export type WorkflowOutcome<O = unknown> = {
  runId: string;
  attemptId: string;
  treeUsage: TokenUsage;
  steps: StepReceipt[];
  snapshot: WorkflowSnapshot;
} & (
  | Exclude<RunState, { status: "running" | "completed" | "suspended" }>
  | { status: "completed"; output: O }
  | {
      status: "suspended";
      requests: (PendingRequest & { problem?: RequestProblem })[];
      wakeAt?: number;
    }
);
export interface StepReceipt {
  id: string;
  key: string;
  kind: StepKind;
  status: StepExecution["status"];
  attempts: StepAttempt[];
}
export interface WorkflowRuntime<O> extends NodeRuntime<WorkflowOutcome<O>> {
  open(input: unknown, options: RunOptions, runId: string): Promise<WorkflowSnapshot>;
  create(
    input: unknown,
    runId: string,
    tree?: RunSnapshot["tree"],
    options?: RunOptions,
  ): Promise<WorkflowSnapshot>;
  restore(raw: unknown, tree?: RunSnapshot["tree"]): WorkflowSnapshot;
  configuration(): Record<string, unknown>;
  replay(snapshot: WorkflowSnapshot): Promise<void>;
}
export interface Workflow<I = unknown, O = unknown> {
  readonly kind: "workflow";
  readonly id: string;
  readonly version: string;
  run(input: I, options?: WorkflowRunOptions): Promise<WorkflowOutcome<O>>;
  resume(snapshot: unknown, options: WorkflowResumeOptions): Promise<WorkflowOutcome<O>>;
  asTool(options: SpecialistToolOptions<O>): Delegation;
  readonly [AGENT_RUNTIME]: WorkflowRuntime<O>;
}
export interface WorkflowSpec<I, O> {
  id: string;
  /** Change when coordination, callback implementations or result meaning changes. */
  version: string;
  input: ResultSchema<I>;
  output?: ResultSchema<O>;
  agents?: readonly Agent<unknown>[];
  workflows?: readonly Workflow<unknown, unknown>[];
  limits?: Partial<WorkflowLimits>;
  treeLimits?: Partial<TreeLimits>;
  /** Pure coordination only. Put every effect and nondeterministic read in a step. */
  run(input: I, context: WorkflowContext): Promise<O>;
}
export interface StepOptions<T, I> {
  input?: I;
  /** Pure. Rechecked on replay. Without it T must itself be plain JSON. */
  validate?: (value: unknown) => T;
  timeoutMs?: number;
  /** No retries by default. A read-only assertion or authoritative reconciliation is required. */
  retry?: {
    maxAttempts: number;
    replay: "read-only" | "reconcile";
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryOn?: (error: StepError, attempt: number) => boolean;
  };
  needsApproval?: boolean;
  /** Required before accepting an approval's edited input. */
  validateInput?: (raw: unknown) => I;
}
export interface StepRun<I = undefined> {
  readonly key: string;
  readonly attempt: number;
  /** Stable identity, not proof that the receiver deduplicates writes. */
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  readonly input: I;
  readonly context: Readonly<ToolContext>;
  report(data: unknown): void;
}
export interface WorkflowContext {
  readonly runId: string;
  readonly context: Readonly<ToolContext>;
  step<T, I = undefined>(
    key: string,
    fn: (run: StepRun<I>) => T | Promise<T>,
    options?: StepOptions<T, I>,
  ): Promise<T>;
  agent<T>(
    key: string,
    agent: Agent<T>,
    input: AgentInput,
    options?: { retry?: ChildRetry },
  ): Promise<RunOutcome<T>>;
  workflow<I, O>(
    key: string,
    workflow: Workflow<I, O>,
    input: I,
    options?: { retry?: ChildRetry },
  ): Promise<WorkflowOutcome<O>>;
  ask<T>(question: Omit<QuestionAsk, "type">, validate: (answer: Answer) => T): Promise<T>;
  sleep(key: string, ms: number): Promise<void>;
}
