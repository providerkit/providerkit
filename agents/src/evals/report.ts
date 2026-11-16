// pass@k/pass^k adapted from Google ADK Python,
// src/google/adk/evaluation/_multi_run_aggregation_methods.py (Apache-2.0).
// Copyright 2026 Google LLC. Changed: products replace combinations; excluded outcomes are counted.
import { copyData, isRecord } from "../snapshot.ts";
import { combineUsage } from "./journal.ts";
import type { CaseResult, EvalCounts, EvalGroup, EvalReport, ScoreAggregate } from "./types.ts";

export function counts(rows: readonly Pick<CaseResult, "status">[]): EvalCounts {
  const count = (status: CaseResult["status"]) =>
    rows.filter((row) => row.status === status).length;
  const passed = count("passed");
  const failed = count("failed");
  return {
    total: rows.length,
    passed,
    failed,
    errors: count("error"),
    unscored: count("unscored"),
    cancelled: count("cancelled"),
    skipped: count("skipped"),
    decided: passed + failed,
    passRate: passed + failed ? passed / (passed + failed) : null,
    successRate: rows.length ? passed / rows.length : null,
  };
}

function combinationRatio(count: number, total: number, k: number): number {
  if (count < k) return 0;
  let value = 1;
  for (let i = 0; i < k; i++) value *= (count - i) / (total - i);
  return value;
}

export function reportGroups(rows: readonly CaseResult[], ks: readonly number[]): EvalGroup[] {
  const groups = new Map<string, CaseResult[]>();
  for (const row of rows) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
  return [...groups].map(([id, cases]) => {
    const total = counts(cases);
    return {
      id,
      ...total,
      passAt: Object.fromEntries(
        ks.map((k) => [
          k,
          total.decided < k
            ? null
            : 1 - combinationRatio(total.decided - total.passed, total.decided, k),
        ]),
      ),
      passHat: Object.fromEntries(
        ks.map((k) => [
          k,
          total.decided < k ? null : combinationRatio(total.passed, total.decided, k),
        ]),
      ),
    };
  });
}

function aggregateScores(rows: readonly Pick<CaseResult, "id" | "scores">[]): ScoreAggregate[] {
  const scores = new Map<
    string,
    { scorer: string; name: string; rows: { id: string; score: CaseResult["scores"][number] }[] }
  >();
  for (const row of rows) {
    for (const score of row.scores) {
      const key = JSON.stringify([score.scorer, score.name]);
      const group = scores.get(key) ?? { scorer: score.scorer, name: score.name, rows: [] };
      group.rows.push({ id: row.id, score });
      scores.set(key, group);
    }
  }
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const aggregate = [...scores.values()].map((group): ScoreAggregate => {
    const cases = new Map<string, number[]>();
    const verdicts = new Map<string, number[]>();
    let measured = 0,
      skipped = 0,
      errors = 0;
    for (const { id, score } of group.rows) {
      if (score.kind === "skipped") {
        skipped++;
        continue;
      }
      if (score.kind === "error") {
        errors++;
        continue;
      }
      measured++;
      if (score.passed !== undefined)
        verdicts.set(id, [...(verdicts.get(id) ?? []), Number(score.passed)]);
      if (typeof score.value === "number") cases.set(id, [...(cases.get(id) ?? []), score.value]);
    }
    // Equal weight per source case, rather than rewarding a case with more recorded scores.
    const means = [...cases.values()].map(mean).filter((value): value is number => value !== null);
    const passRates = [...verdicts.values()]
      .map(mean)
      .filter((value): value is number => value !== null);
    return {
      scorer: group.scorer,
      name: group.name,
      measured,
      skipped,
      errors,
      mean: mean(means),
      passRate: mean(passRates),
    };
  });
  return aggregate;
}

export function summarize(rows: readonly CaseResult[]): EvalReport["summary"] {
  const statuses = new Map<string, number>();
  const turns = new Map<
    number,
    { id: string; status: CaseResult["status"]; scores: CaseResult["scores"] }[]
  >();
  for (const row of rows) {
    for (const run of row.runs.filter((run) => run.role === "agent"))
      statuses.set(run.status, (statuses.get(run.status) ?? 0) + 1);
    for (const turn of row.turns) {
      const group = turns.get(turn.index) ?? [];
      group.push({ id: row.id, status: turn.status, scores: turn.scores });
      turns.set(turn.index, group);
    }
  }
  return {
    ...counts(rows),
    scores: aggregateScores(rows),
    turns: [...turns].map(([index, group]) => ({
      index,
      ...counts(group),
      scores: aggregateScores(group),
    })),
    runStatuses: Object.fromEntries(statuses),
    agentUsage: combineUsage(rows.map((row) => row.agentUsage)),
    judgeUsage: combineUsage(rows.map((row) => row.judgeUsage)),
    userUsage: combineUsage(rows.map((row) => row.userUsage)),
  };
}

/** Stable key order, no filesystem access. The report itself decides whether private data
 * exists; serialization does not silently redact a report created with includePrivateData. */
export function reportJson(report: EvalReport): string {
  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered);
    if (isRecord(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, ordered(value[key])]),
      );
    return value;
  }
  return JSON.stringify(ordered(copyData(report)), null, 2) + "\n";
}

export interface ReportComparison {
  regressed: string[];
  improved: string[];
  unchanged: string[];
  incomparable: string[];
  added: string[];
  removed: string[];
  scores: { scorer: string; name: string; before: number | null; after: number | null }[];
}

export function compareReports(baseline: EvalReport, current: EvalReport): ReportComparison {
  const before = new Map(baseline.groups.map((group) => [group.id, group]));
  const after = new Map(current.groups.map((group) => [group.id, group]));
  const result: ReportComparison = {
    regressed: [],
    improved: [],
    unchanged: [],
    incomparable: [],
    added: [],
    removed: [],
    scores: [],
  };
  for (const [id, group] of after) {
    const old = before.get(id);
    if (!old) result.added.push(id);
    else if (
      old.successRate === null ||
      group.successRate === null ||
      !old.decided ||
      !group.decided
    )
      result.incomparable.push(id);
    else if (group.successRate < old.successRate) result.regressed.push(id);
    else if (group.successRate > old.successRate) result.improved.push(id);
    else result.unchanged.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) result.removed.push(id);
  const oldScores = new Map(
    baseline.summary.scores.map((score) => [JSON.stringify([score.scorer, score.name]), score]),
  );
  const newScores = new Map(
    current.summary.scores.map((score) => [JSON.stringify([score.scorer, score.name]), score]),
  );
  for (const key of new Set([...oldScores.keys(), ...newScores.keys()])) {
    const old = oldScores.get(key),
      next = newScores.get(key),
      identity = next ?? old;
    if (identity)
      result.scores.push({
        scorer: identity.scorer,
        name: identity.name,
        before: old?.mean ?? null,
        after: next?.mean ?? null,
      });
  }
  return result;
}

/** ASCII only, including host labels. Control characters cannot escape into a terminal. */
export function formatReport(report: EvalReport, options: { baseline?: EvalReport } = {}): string {
  const ascii = (s: string) =>
    s.replace(/[^\x20-\x7e]/gu, (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`);
  const cell = (s: string, width: number) => ascii(s).slice(0, width).padEnd(width);
  const lines = [
    ascii(report.name),
    `${cell("Case", 30)} ${cell("Repeat", 6)} ${cell("Result", 10)} ${cell("Run", 10)} Tokens   Cost USD`,
  ];
  for (const row of report.cases) {
    const usage = combineUsage([row.agentUsage, row.judgeUsage, row.userUsage]);
    lines.push(
      `${cell(row.id, 30)} ${cell(String(row.repeat), 6)} ${cell(row.status, 10)} ${cell(row.run?.status ?? "not run", 10)} ${String(usage.usage.inputTokens + usage.usage.outputTokens).padEnd(8)} ${usage.costUsd === null ? "unknown" : usage.costUsd.toFixed(6)}`,
    );
    for (const turn of row.turns)
      lines.push(`  Turn ${turn.index}: ${turn.status}${turn.runId ? "" : " (not run)"}`);
    if (row.simulation) lines.push(`  Simulation: ${row.simulation}`);
    for (const score of row.scores)
      lines.push(
        `  ${ascii(score.scorer)} / ${ascii(score.name)}: ${score.kind === "error" || score.kind === "skipped" ? score.kind : score.value === undefined ? score.kind : ascii(String(score.value))}${score.passed === undefined ? "" : score.passed ? " (pass)" : " (fail)"}`,
      );
    for (const problem of row.problems) lines.push(`  ${ascii(problem)}`);
  }
  const s = report.summary;
  lines.push(
    `${s.passed}/${s.total} passed; ${s.failed} failed; ${s.errors} errors; ${s.unscored} unscored; ${s.cancelled} cancelled; ${s.skipped} not run.`,
  );
  const usage = combineUsage([s.agentUsage, s.judgeUsage, s.userUsage]);
  lines.push(
    `${usage.unknownCharges} unknown charges; ${usage.unpricedCalls} unpriced calls. Available cost: USD ${usage.knownCostUsd.toFixed(6)}.`,
  );
  for (const group of report.groups)
    for (const [k, value] of Object.entries(group.passAt))
      lines.push(
        `${ascii(group.id)} pass@${k}: ${value === null ? "unknown" : value.toFixed(4)} (${group.decided}/${group.total} decided).`,
      );
  if (report.stopped) lines.push(ascii(report.stopped.message));
  if (options.baseline) {
    const comparison = compareReports(options.baseline, report);
    lines.push(
      `Baseline: ${comparison.regressed.length} regressed; ${comparison.improved.length} improved; ${comparison.incomparable.length} cannot be compared; ${comparison.added.length} added; ${comparison.removed.length} removed.`,
    );
  }
  return lines.join("\n") + "\n";
}

export class EvalFailedError extends Error {
  constructor(readonly report: EvalReport) {
    super(
      `Evaluation did not pass: ${report.summary.passed}/${report.summary.total} cases passed. Inspect the report for failures and missing scores.`,
    );
    this.name = "EvalFailedError";
  }
}

export function assertReport(
  report: EvalReport,
  options: {
    minPassRate?: number;
    allowErrors?: boolean;
    allowSkipped?: boolean;
    allowUnscored?: boolean;
    allowCancelled?: boolean;
  } = {},
): void {
  const min = options.minPassRate ?? 1;
  if (!Number.isFinite(min) || min < 0 || min > 1)
    throw new TypeError("minPassRate must be between 0 and 1.");
  const summary = report.summary;
  if (
    summary.passRate === null ||
    summary.passRate < min ||
    (!options.allowErrors && summary.errors > 0) ||
    (!options.allowSkipped && summary.skipped > 0) ||
    (!options.allowUnscored && summary.unscored > 0) ||
    (!options.allowCancelled && summary.cancelled > 0)
  )
    throw new EvalFailedError(report);
}
