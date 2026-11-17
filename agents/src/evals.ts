/** Explicit agent evaluations. No default provider, storage, telemetry or live hooks. */
export { runEvals, scoreRun, createLiveScorer } from "./evals/runner.ts";
export type { LiveScorerOptions, LiveScoreOutcome } from "./evals/runner.ts";
export { scriptedProvider } from "./evals/testing.ts";
export type { ScriptedProvider, ScriptedCall, ScriptStep, ScriptReply } from "./evals/testing.ts";
export { readCases, caseFromRun, trajectoryOf } from "./evals/journal.ts";
export {
  defineScorer,
  skip,
  exact,
  contains,
  schema,
  similarity,
  trajectory,
  toolArguments,
  answeredBy,
  maxDuration,
  maxCost,
  maxTokens,
  maxToolCalls,
  maxModelCalls,
} from "./evals/scorers.ts";
export { llmJudge, grounded } from "./evals/judge.ts";
export type { JudgeOptions } from "./evals/judge.ts";
export {
  reportJson,
  formatReport,
  compareReports,
  assertReport,
  EvalFailedError,
} from "./evals/report.ts";
export type { ReportComparison } from "./evals/report.ts";
export { SKIP } from "./evals/types.ts";
export type {
  EvalCase,
  EvalTurn,
  SimulatedUser,
  ScriptedAnswer,
  ToolMock,
  EvalDriver,
  EvalTools,
  AgentFactoryContext,
  EvalTurnResult,
  EvalRunResult,
  EvalDataset,
  ExpectedCall,
  TrajectoryExpectation,
  TrajectoryStep,
  Trajectory,
  ModelRef,
  EvalPrice,
  EvalUsage,
  EvalRun,
  ScoreValue,
  NamedScore,
  Skip,
  ScorerOutput,
  ScoreThreshold,
  ScoreContext,
  Scorer,
  ScoreResult,
  EvalHost,
  ScoringOptions,
  EvalOptions,
  EvalStatus,
  CaseResult,
  EvalCounts,
  ScoreAggregate,
  EvalGroup,
  EvalReport,
  ScoredRun,
} from "./evals/types.ts";
