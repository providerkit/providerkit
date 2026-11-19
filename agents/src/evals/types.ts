import type { ModelRate, Provider, TokenUsage } from "@providerkit/core";
import type { RemoteReceipt } from "../a2a/remote.ts";
import type {
  Agent,
  AgentHost,
  AgentConfig,
  AgentInput,
  Decision,
  ModelSettings,
  UserContent,
  AgentRef,
  AskRecord,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  StepExecution,
  StepKind,
  ToolResult,
} from "../index.ts";

export interface EvalTurn<E = unknown> {
  input: UserContent;
  expected?: E;
  expectStatus?: RunOutcome["status"];
  trajectory?: TrajectoryExpectation;
  scorers?: readonly Scorer<E>[];
}

export interface SimulatedUser {
  opening: UserContent;
  plan: string;
  persona?: string;
  /** Target-agent turns, including opening. Default 10, maximum 100. */
  maxTurns?: number;
}

export interface EvalCase<E = unknown> {
  /** A public label, not a prompt or a person's identifier. Unique within the dataset. */
  id: string;
  /** Exactly one of input, turns and user. Turns share a fresh SDK memory session. */
  input?: AgentInput;
  turns?: readonly EvalTurn<E>[];
  user?: SimulatedUser;
  expected?: E;
  expectStatus?: RunOutcome["status"];
  trajectory?: TrajectoryExpectation;
  scorers?: readonly Scorer<E>[];
}

type ScriptedDecision =
  | {
      ask: "approval";
      decision: Extract<Decision, { type: "approve" | "deny" | "cancel" | "stop" }>;
    }
  | {
      ask: "question";
      key: string;
      decision: Extract<Decision, { type: "answer" | "cancel" | "stop" }>;
    };

/** Trusted test-driver data, never loaded by readCases. Each answer is consumed once.
 * Match exact agent/tool or workflow/step identities and question keys, not request prose.
 * More than one unused match leaves the request pending; script order grants no authority. */
export type ScriptedAnswer = {
  /** Child keys from the root. Omitted means root-only, never any delegated child. */
  path?: readonly string[];
} & (
  | ({
      agentId: string;
      tool: string;
      arguments?: Record<string, unknown>;
      workflowId?: never;
      step?: never;
      input?: never;
    } & (
      | ScriptedDecision
      | { ask: "client"; decision: Extract<Decision, { type: "result" | "cancel" | "stop" }> }
    ))
  | ({
      workflowId: string;
      step: string;
      /** Exact JSON input recorded for this step, before any approval edits. */
      input?: unknown;
      agentId?: never;
      tool?: never;
      arguments?: never;
    } & ScriptedDecision)
);

export interface ToolMock {
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface EvalDriver {
  answers?: readonly ScriptedAnswer[];
  /** Applied only by factory.stub(), including code-only bindings. Unmatched calls fail closed.
   * Direct and code paths share the same replacement object and current host checks.
   * Replaces validation and execution: this does not test the real backend's checks. */
  toolMocks?: readonly ToolMock[];
}

export type EvalTools = NonNullable<AgentConfig["tools"]>;
export interface AgentFactoryContext<E = unknown> {
  case: EvalCase<E>;
  repeat: number;
  signal: AbortSignal;
  stub(tools: EvalTools): EvalTools;
}

export interface EvalDataset<E = unknown> {
  name: string;
  cases: readonly EvalCase<E>[];
  scorers?: readonly Scorer<E>[];
}

export interface ExpectedCall {
  /** Tool name or workflow step key. */
  name: string;
  arguments?: Record<string, unknown>;
  argumentsMatch?: "subset" | "exact" | "ignore";
  /** Exact workflow step input. Does not match agent tool arguments. */
  input?: unknown;
  /** At least one child must match. Other children still obey tree-wide prohibitions. */
  inside?: TrajectoryExpectation;
}

export interface TrajectoryExpectation {
  calls?: readonly ExpectedCall[];
  match?: "exact" | "inOrder" | "anyOrder" | "subset";
  scope?: "root" | "tree";
  forbidden?: readonly string[];
  forbiddenSequences?: readonly (readonly string[])[];
  maxToolCalls?: number;
  maxModelCalls?: number;
  noRepeats?: boolean;
  includeFailed?: boolean;
}

export type TrajectoryStep = {
  /** Tool name or workflow step key. */
  name: string;
  /** Admitted effects/children, excluding reconciled not-run attempts. Questions and sleeps count once. */
  attempts: number;
  asks: AskRecord[];
  runId: string;
  operationId: string;
  /** The real program operation for an inner tool, never a child run. */
  parentOperationId?: string;
  children: ({ key: string; runId: string; trajectory: Trajectory } & (
    | { kind: "agent"; agentId: string }
    | { kind: "remote"; agentId: string; version: string }
    | { kind: "workflow"; workflowId: string }
  ))[];
} & (
  | {
      kind: "tool" | "code" | "delegation" | "handoff";
      arguments: Record<string, unknown>;
      status: "pending" | "running" | "completed" | "interrupted";
      result?: ToolResult;
      agentId: string;
      turn: number;
      workflowId?: never;
      input?: never;
      output?: never;
    }
  | {
      /** A remote receipt, not a workflow's remote-child step. Acceptance is not task completion. */
      kind: "remote-operation";
      action: RemoteReceipt["action"];
      status: RemoteReceipt["status"];
      billing: "unknown";
      agentId: string;
      version: string;
      attemptId: string;
      workflowId?: never;
      /** Message parts only, without transport IDs. Kept out of built-in judge prompts. */
      input?: unknown;
      output?: never;
      arguments?: never;
      result?: never;
      turn?: never;
    }
  | {
      kind: StepKind;
      workflowId: string;
      input?: unknown;
      output?: unknown;
      status: StepExecution["status"];
      arguments?: never;
      result?: never;
      agentId?: never;
      turn?: never;
    }
);

export interface Trajectory {
  /** This run's operations in admission order, including inner calls after their code operation. */
  steps: TrajectoryStep[];
  flat: TrajectoryStep[];
  /** SDK admissions, including interrupted attempts, not provider-internal retries. */
  modelCalls: number;
  /** Agent tool calls and coordination attempts, including inner code calls but not workflow
   * steps or submit_result. Failed/interrupted attempts count; pending calls have no current receipt. */
  toolCalls: number;
}

export interface ModelRef {
  agentId: string;
  provider?: string;
  model?: string;
}

export type EvalPrice = (model: ModelRef) => ModelRate | undefined;

export interface EvalUsage {
  usage: TokenUsage;
  /** Sum of available bills/estimates, including partial usage. Not a full bill. */
  knownCostUsd: number;
  /** Null if any model attempt or remote operation has unknown billing, or a model lacks a price. */
  costUsd: number | null;
  unknownCharges: number;
  unpricedCalls: number;
}

export interface EvalRun extends EvalUsage {
  runId: string;
  agentId: string;
  version: string;
  input: AgentInput;
  status: RunSnapshot["state"]["status"];
  /** The journal's JSON candidate, not a second call to the agent's output validator. */
  value?: unknown;
  text: string;
  snapshot: RunSnapshot;
  /** The admitted handoff chain's owner, never an ordinary delegated specialist. */
  activeAgent: AgentRef;
  trajectory: Trajectory;
  /** Stored journals have no completion timestamp. Never inferred from the current time. */
  durationMs?: number;
}

export type ScoreValue = boolean | number | string;
export type NamedScore = ScoreValue | { value: ScoreValue; reason?: string };
// Adapted from Mastra, packages/core/src/evals/not-scorable.ts (Apache-2.0).
// Copyright (c) 2025 Kepler Software, Inc. Changed: required reason and our own brand.
export const SKIP: unique symbol = Symbol.for("providerkit.evals.skip");
export interface Skip {
  readonly [SKIP]: true;
  readonly reason: string;
}
export type ScorerOutput = NamedScore | Skip | Record<string, NamedScore>;
export type ScoreThreshold = number | { min?: number; max?: number };

export interface ScoreContext<E = unknown> {
  case: EvalCase<E>;
  /** One-based case turn. Absent for scoreRun on a stored journal. */
  turn?: number;
  runs: readonly EvalRun[];
  expected?: E;
  run: EvalRun;
  signal: AbortSignal;
  /** Only available with allowJudge. Shares this case's cancellation and spend accounting.
   * Helpers are serial and maxJudgeRuns bounds their number. No automatic resume or retry. */
  runAgent<R>(agent: Agent<R>, input: AgentInput): Promise<RunOutcome<R>>;
}

export interface Scorer<E = unknown> {
  readonly name: string;
  readonly threshold?: ScoreThreshold;
  readonly gate?: boolean;
  score(context: ScoreContext<E>): ScorerOutput | Promise<ScorerOutput>;
}

export interface ScoreResult {
  turn?: number;
  scorer: string;
  name: string;
  gate: boolean;
  kind: "assertion" | "score" | "label" | "skipped" | "error";
  /** Label text, reasons and exception messages require includePrivateData. */
  value?: ScoreValue;
  passed?: boolean;
  reason?: string;
  error?: "scorer_failed" | "invalid_score" | "cancelled";
}

/** New executions only. Only the separate trusted driver may answer; stored effects never resume.
 * `screenCall`, like `needsApproval`, is the agent's own policy, so a check runs the same agent. */
export type EvalHost = Pick<
  AgentHost,
  | "checkpoint"
  | "loadMedia"
  | "prepareRequest"
  | "needsApproval"
  | "screenCall"
  | "beforeTool"
  | "beforeStep"
  | "canRunConcurrently"
>;

export interface ScoringOptions<E = unknown> {
  case?: EvalCase<E>;
  price?: EvalPrice;
  signal?: AbortSignal;
  /** Explicit opt-in, also required by scoreRun and createLiveScorer. */
  allowJudge?: boolean;
  /** Helper agent runs per case, default 3. Each built-in judge also has SDK model-call limits. */
  maxJudgeRuns?: number;
  /** Default 60 seconds, including custom scorers. Cancellation is cooperative. */
  timeoutMs?: number;
  /** Includes raw data and reasons. Keep such reports in trusted storage. Default false. */
  includePrivateData?: boolean;
}

export interface EvalOptions<T = string, E = unknown>
  extends EvalDataset<E>, Omit<ScoringOptions<E>, "case"> {
  /** Cases start from an agent. Its delegated tree may contain workflows and remote agents. */
  agent: Agent<T> | ((context: AgentFactoryContext<E>) => Agent<T> | Promise<Agent<T>>);
  /** Explicit routing after a handoff, by both id and version. Missing targets stop the case. */
  resolveAgent?: (ref: AgentRef) => Agent<T> | Promise<Agent<T>>;
  /** Trusted scripts keyed by case id. Dataset files cannot set these. */
  drivers?: Readonly<Record<string, EvalDriver>>;
  /** Separate paid-work consent from allowJudge. No default simulator provider. */
  allowSimulation?: boolean;
  user?: {
    provider: Provider;
    modelSettings?: Omit<ModelSettings, "toolChoice" | "hostedTools" | "maxAttempts">;
  };
  repeat?: number;
  k?: readonly number[];
  /** Active case slots, default 1. External work that ignores abort may continue. */
  concurrency?: number;
  /** Admission/spend thresholds, NOT hard monetary or token caps. On reaching one, no new
   * case/helper starts and in-flight work is signalled to stop. SDK limits still bound each
   * tree. Provider retries, hosted charges and ignored cancellation can exceed thresholds. */
  budget?: { usd?: number; tokens?: number };
  run?: Pick<RunOptions, "context" | "modelSettings" | "enabledTools">;
  host?: EvalHost;
}

export type EvalStatus = "passed" | "failed" | "error" | "unscored" | "cancelled" | "skipped";

export interface EvalRunResult extends EvalUsage {
  runId: string;
  attemptId: string;
  agent: AgentRef;
  activeAgent: AgentRef;
  role: "agent" | "judge" | "user";
  turn?: number;
  status: EvalRun["status"];
  modelCalls: number;
  toolCalls: number;
  durationMs?: number;
  /** Model attempts, including interrupted ones. No prompts or tool results. */
  modelAttempts: {
    operationId: string;
    attemptId: string;
    status: "running" | "completed" | "interrupted";
    billing: "reported" | "unknown";
    usage: TokenUsage;
  }[];
  toolAttempts: {
    operationId: string;
    parentOperationId?: string;
    attemptId: string;
    status: "running" | "completed" | "interrupted";
    ok?: boolean;
  }[];
  /** Remote sends and cancellation requests, not local model or tool attempts. No peer endpoints,
   * callbacks, message bodies or task/context handles. Accepted does not mean cancelled. */
  remoteAttempts: (Pick<RemoteReceipt, "kind" | "action" | "attemptId" | "status" | "billing"> & {
    agentId: string;
    version: string;
    runId: string;
    operationId: string;
  })[];
  /** Present only after explicit consent to include private data. */
  snapshot?: RunSnapshot;
}

export interface EvalTurnResult {
  index: number;
  status: EvalStatus;
  runId?: string;
  scores: ScoreResult[];
  problems: string[];
}

export interface CaseResult {
  id: string;
  repeat: number;
  status: EvalStatus;
  problems: string[];
  /** Last target run, for the single-line report. runs retains all target and helper work. */
  run?: EvalRunResult;
  runs: EvalRunResult[];
  turns: EvalTurnResult[];
  simulation?: "finished" | "turn_limit" | "incomplete";
  scores: ScoreResult[];
  agentUsage: EvalUsage;
  judgeUsage: EvalUsage;
  userUsage: EvalUsage;
  durationMs: number;
}

export interface EvalCounts {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  unscored: number;
  cancelled: number;
  skipped: number;
  decided: number;
  /** Passed / decided. Always read alongside decided and total. */
  passRate: number | null;
  /** Passed / total, including errors and unscored work in the denominator. */
  successRate: number | null;
}

export interface ScoreAggregate {
  name: string;
  scorer: string;
  measured: number;
  skipped: number;
  errors: number;
  mean: number | null;
  passRate: number | null;
}

export interface EvalGroup extends EvalCounts {
  id: string;
  passAt: Record<string, number | null>;
  passHat: Record<string, number | null>;
}

export interface EvalReport {
  format: 1;
  name: string;
  startedAt: number;
  durationMs: number;
  options: { repeat: number; k: number[]; concurrency: number; budget?: EvalOptions["budget"] };
  cases: CaseResult[];
  groups: EvalGroup[];
  summary: EvalCounts & {
    scores: ScoreAggregate[];
    runStatuses: Record<string, number>;
    agentUsage: EvalUsage;
    judgeUsage: EvalUsage;
    userUsage: EvalUsage;
    turns: (EvalCounts & { index: number; scores: ScoreAggregate[] })[];
  };
  stopped?: { reason: "budget" | "unknown_cost" | "cancelled"; message: string };
}

export interface ScoredRun {
  runId: string;
  status: EvalRun["status"];
  scores: ScoreResult[];
  agentUsage: EvalUsage;
  judgeUsage: EvalUsage;
}
