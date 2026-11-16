// ROUGE-1 counting adapted from Google ADK JS, core/src/cli/cli_eval.ts (Apache-2.0).
// Copyright 2026 Google LLC. Changed: Unicode word segmentation instead of ASCII tokens.
// Argument selection/matching adapted from PydanticAI's evaluators/agentic.py (MIT).
// Copyright (c) Pydantic Services Inc. 2024 to present. Reasons do not include private values.
import { parseJsonAnswer } from "@providerkit/core";
import { copyData, equalData, isId, isRecord } from "../snapshot.ts";
import { argumentsMatch, checkExpectation, matchTrajectory, nonNegative } from "./trajectory.ts";
import {
  SKIP,
  type NamedScore,
  type ScoreContext,
  type ScoreResult,
  type Scorer,
  type ScorerOutput,
  type ScoreThreshold,
  type ScoreValue,
  type Skip,
  type TrajectoryExpectation,
} from "./types.ts";

export function skip(reason: string): Skip {
  if (!isId(reason)) throw new TypeError("A skipped score needs a reason.");
  return { [SKIP]: true, reason };
}

export function checkThreshold(threshold: ScoreThreshold | undefined): void {
  if (threshold === undefined) return;
  const unit = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  if (
    typeof threshold === "number"
      ? !unit(threshold)
      : !isRecord(threshold) ||
        !Object.keys(threshold).length ||
        Object.keys(threshold).some((key) => key !== "min" && key !== "max") ||
        (threshold.min === undefined && threshold.max === undefined) ||
        (threshold.min !== undefined && !unit(threshold.min)) ||
        (threshold.max !== undefined && !unit(threshold.max)) ||
        (threshold.min ?? 0) > (threshold.max ?? 1)
  )
    throw new TypeError("Score thresholds must be between 0 and 1, with min no greater than max.");
}

export function checkScorers(scorers: readonly Scorer[]): void {
  if (!Array.isArray(scorers)) throw new TypeError("Scorers must be an array.");
  const names = new Set<string>();
  for (const scorer of scorers) {
    if (
      !scorer ||
      !isId(scorer.name) ||
      names.has(scorer.name) ||
      typeof scorer.score !== "function" ||
      (scorer.gate !== undefined && typeof scorer.gate !== "boolean")
    )
      throw new TypeError("Scorers need unique names and a score function.");
    names.add(scorer.name);
    checkThreshold(scorer.threshold);
  }
}

export function defineScorer<E = unknown>(
  name: string,
  score: Scorer<E>["score"],
  options: Pick<Scorer, "threshold" | "gate"> = {},
): Scorer<E> {
  const scorer = { name, score, ...options };
  checkScorers([scorer]);
  return scorer;
}

function isValue(value: unknown): value is ScoreValue {
  return (
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
  );
}

function named(value: unknown): { value: ScoreValue; reason?: string } {
  if (isValue(value)) return { value };
  if (
    isRecord(value) &&
    isValue(value.value) &&
    (value.reason === undefined || typeof value.reason === "string") &&
    Object.keys(value).every((key) => key === "value" || key === "reason")
  )
    return { value: value.value, reason: value.reason };
  throw new TypeError(
    "A scorer must return a boolean, a finite score from 0 to 1, a label, or { value, reason }.",
  );
}

export function normalizeScores(
  scorer: Scorer,
  raw: unknown,
  includePrivateData: boolean,
): ScoreResult[] {
  const base = { scorer: scorer.name, gate: scorer.gate !== false };
  if (typeof raw === "object" && raw !== null && SKIP in raw && raw[SKIP] === true) {
    if (!("reason" in raw) || !isId(raw.reason))
      throw new TypeError("A skipped score needs a reason.");
    return [
      {
        ...base,
        name: scorer.name,
        kind: "skipped",
        ...(includePrivateData ? { reason: raw.reason } : {}),
      },
    ];
  }
  const entries =
    isRecord(raw) && !Object.hasOwn(raw, "value") ? Object.entries(raw) : [[scorer.name, raw]];
  if (!entries.length) throw new TypeError("Return skip(reason), not an empty score map.");
  return entries.map(([name, result]) => {
    if (!isId(name)) throw new TypeError("Each score needs a name.");
    const { value, reason } = named(result);
    const threshold = scorer.threshold;
    const passed =
      typeof value === "boolean"
        ? value
        : typeof value !== "number" || threshold === undefined
          ? undefined
          : typeof threshold === "number"
            ? value >= threshold
            : value >= (threshold.min ?? 0) && value <= (threshold.max ?? 1);
    return {
      ...base,
      name,
      kind:
        typeof value === "boolean" ? "assertion" : typeof value === "number" ? "score" : "label",
      ...(passed === undefined ? {} : { passed }),
      ...(typeof value !== "string" || includePrivateData ? { value } : {}),
      ...(includePrivateData && reason ? { reason } : {}),
    };
  });
}

function expectedFor(context: ScoreContext, provided: unknown): unknown {
  return provided === undefined ? context.expected : provided;
}

export function exact(value?: unknown): Scorer {
  const expected = copyData(value);
  return defineScorer("exact", (ctx) => {
    const target = expectedFor(ctx, expected);
    if (target === undefined) return skip("No expected value was supplied.");
    if (ctx.run.status !== "completed") return skip("The run has no completed output.");
    return equalData(ctx.run.value, target);
  });
}

export function contains(
  value?: string | readonly string[] | Record<string, unknown>,
  options: { caseSensitive?: boolean; mode?: "all" | "any" } = {},
): Scorer {
  const expected = copyData(value);
  if (
    (options.caseSensitive !== undefined && typeof options.caseSensitive !== "boolean") ||
    (options.mode !== undefined && options.mode !== "all" && options.mode !== "any")
  )
    throw new TypeError("Invalid contains options.");
  const normalize = (s: string) =>
    options.caseSensitive === false ? s.toLocaleLowerCase("und") : s;
  return defineScorer("contains", (ctx) => {
    const target = expectedFor(ctx, expected);
    if (target === undefined) return skip("No expected value was supplied.");
    if (ctx.run.status !== "completed") return skip("The run has no completed output.");
    const actual = ctx.run.value;
    if (typeof actual === "string") {
      const needles =
        typeof target === "string"
          ? [target]
          : Array.isArray(target) &&
              target.every((item): item is string => typeof item === "string")
            ? target
            : [];
      if (!needles.length) return false;
      const found = (needle: string) => normalize(actual).includes(normalize(needle));
      return options.mode === "any" ? needles.some(found) : needles.every(found);
    }
    if (Array.isArray(actual)) {
      const needles = Array.isArray(target) ? target : [target];
      const found = (needle: unknown) => actual.some((item) => equalData(item, needle));
      return options.mode === "any" ? needles.some(found) : needles.every(found);
    }
    return isRecord(actual) && isRecord(target) && argumentsMatch(actual, target);
  });
}

/** A validator returns a value or throws. Reuse your existing runtime schema validator. */
export function schema<V>(
  validate: (value: unknown) => V,
  options: { from?: "value" | "text" } = {},
): Scorer {
  if (
    typeof validate !== "function" ||
    (options.from !== undefined && options.from !== "value" && options.from !== "text")
  )
    throw new TypeError("Supply a schema validator and value or text as its source.");
  return defineScorer("schema", async (ctx) => {
    if (ctx.run.status !== "completed") return skip("The run has no completed output.");
    try {
      await validate(options.from === "text" ? parseJsonAnswer(ctx.run.text) : ctx.run.value);
      return true;
    } catch {
      return false;
    }
  });
}

export function similarity(options: { threshold?: number } = {}): Scorer {
  const segmenter = new Intl.Segmenter("und", { granularity: "word" });
  const words = (s: string) =>
    [...segmenter.segment(s.normalize("NFKC").toLowerCase())]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
  return defineScorer(
    "similarity",
    (ctx) => {
      if (typeof ctx.expected !== "string") return skip("Similarity needs expected text.");
      if (ctx.run.status !== "completed" || typeof ctx.run.value !== "string")
        return skip("Similarity needs a completed text output.");
      const target = words(ctx.expected);
      const prediction = words(ctx.run.value);
      if (!target.length && !prediction.length) return 1;
      const counts = new Map<string, number>();
      for (const word of target) counts.set(word, (counts.get(word) ?? 0) + 1);
      let overlap = 0;
      for (const word of prediction) {
        const remaining = counts.get(word) ?? 0;
        if (remaining > 0) {
          overlap++;
          counts.set(word, remaining - 1);
        }
      }
      return (2 * overlap) / (target.length + prediction.length);
    },
    { threshold: options.threshold ?? 0.8 },
  );
}

export function trajectory(
  expectation?: TrajectoryExpectation,
  options: { graded?: boolean; threshold?: number } = {},
): Scorer {
  if (expectation !== undefined) checkExpectation(expectation);
  const expected = copyData(expectation);
  return defineScorer(
    "trajectory",
    (ctx) => {
      const target = expected ?? ctx.case.trajectory;
      if (!target) return skip("No trajectory expectation was supplied.");
      checkExpectation(target);
      const match = matchTrajectory(ctx.run.trajectory, target);
      return { value: options.graded ? match.score : match.passed, reason: match.reason };
    },
    options.graded ? { threshold: options.threshold ?? 1 } : {},
  );
}

export function toolArguments(
  name: string,
  expected: Record<string, unknown>,
  options: {
    occurrence?: "first" | "last" | number;
    match?: "subset" | "exact";
    scope?: "root" | "tree";
    includeFailed?: boolean;
  } = {},
): Scorer {
  const args = copyData(expected);
  const occurrence = options.occurrence ?? "first";
  if (
    !isId(name) ||
    !isRecord(args) ||
    (occurrence !== "first" &&
      occurrence !== "last" &&
      (!nonNegative(occurrence) || !Number.isSafeInteger(occurrence))) ||
    (options.match !== undefined && options.match !== "exact" && options.match !== "subset") ||
    (options.scope !== undefined && options.scope !== "root" && options.scope !== "tree")
  )
    throw new TypeError("Invalid tool-argument scorer options.");
  return defineScorer(`arguments:${name}`, (ctx) => {
    const calls = (
      options.scope === "tree" ? ctx.run.trajectory.flat : ctx.run.trajectory.steps
    ).filter((step) => step.name === name && (options.includeFailed || step.result?.ok));
    const call =
      occurrence === "last" ? calls.at(-1) : calls[occurrence === "first" ? 0 : occurrence];
    return call !== undefined && argumentsMatch(call.arguments, args, options.match);
  });
}

function maximum(
  name: string,
  limit: number,
  measure: (ctx: ScoreContext) => number | null | undefined,
): Scorer {
  if (!nonNegative(limit))
    throw new TypeError("A budget score needs a finite, non-negative limit.");
  return defineScorer(name, (ctx) => {
    const value = measure(ctx);
    return value == null
      ? skip("This measurement is unknown. It cannot prove the budget passed.")
      : value <= limit;
  });
}
export function maxDuration(ms: number): Scorer {
  return maximum("maxDuration", ms, (ctx) => ctx.run.durationMs);
}
export function maxCost(usd: number): Scorer {
  return maximum("maxCost", usd, (ctx) => ctx.run.costUsd);
}
export function maxTokens(tokens: number): Scorer {
  return maximum("maxTokens", tokens, (ctx) =>
    ctx.run.unknownCharges ? undefined : ctx.run.usage.inputTokens + ctx.run.usage.outputTokens,
  );
}
export function maxToolCalls(calls: number): Scorer {
  return maximum("maxToolCalls", calls, (ctx) => ctx.run.trajectory.toolCalls);
}
export function maxModelCalls(calls: number): Scorer {
  return maximum("maxModelCalls", calls, (ctx) => ctx.run.trajectory.modelCalls);
}

// Keep these public types reachable from this entry without making implementation helpers API.
export type { NamedScore, ScorerOutput };
