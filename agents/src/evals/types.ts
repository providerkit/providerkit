import type { ModelRate, TokenUsage } from "@providerkit/core";
import type {
  Agent,
  AgentHost,
  AgentInput,
  AgentRef,
  AskRecord,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  ToolResult,
} from "../index.ts";

export interface EvalCase<E = unknown> {
  /** A public label, not a prompt or a person's identifier. Unique within the dataset. */
  id: string;
  input: AgentInput;
  expected?: E;
  expectStatus?: RunOutcome["status"];
  trajectory?: TrajectoryExpectation;
  scorers?: readonly Scorer<E>[];
}

export interface EvalDataset<E = unknown> {
  name: string;
  cases: readonly EvalCase<E>[];
  scorers?: readonly Scorer<E>[];
}

export interface ExpectedCall {
  name: string;
  arguments?: Record<string, unknown>;
  argumentsMatch?: "subset" | "exact" | "ignore";
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

export interface TrajectoryStep {
  kind: "tool" | "delegation" | "handoff";
  name: string;
  arguments: Record<string, unknown>;
  status: "running" | "completed" | "interrupted";
  attempts: number;
  result?: ToolResult;
  asks: AskRecord[];
  agentId: string;
  runId: string;
  operationId: string;
  turn: number;
  children: { key: string; agentId: string; runId: string; trajectory: Trajectory }[];
}

export interface Trajectory {
  steps: TrajectoryStep[];
  flat: TrajectoryStep[];
  /** SDK admissions, including interrupted attempts, not provider-internal retries. */
  modelCalls: number;
  /** Local calls and coordination attempts, excluding submit_result. Failed attempts count. */
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
  /** Null if any model attempt has unknown billing or lacks a price. */
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

/** New executions only. Human requests stay pending; no answer/resume/child binding is accepted. */
export type EvalHost = Pick<
  AgentHost,
  | "checkpoint"
  | "loadMedia"
  | "prepareRequest"
  | "needsApproval"
  | "beforeTool"
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
  agent:
    | Agent<T>
    | ((context: {
        case: EvalCase<E>;
        repeat: number;
        signal: AbortSignal;
      }) => Agent<T> | Promise<Agent<T>>);
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

export interface CaseResult {
  id: string;
  repeat: number;
  status: EvalStatus;
  problems: string[];
  run?: {
    runId: string;
    agent: AgentRef;
    status: EvalRun["status"];
    modelCalls: number;
    toolCalls: number;
    durationMs?: number;
    /** Present only after explicit consent to include private data. */
    snapshot?: RunSnapshot;
  };
  scores: ScoreResult[];
  agentUsage: EvalUsage;
  judgeUsage: EvalUsage;
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
