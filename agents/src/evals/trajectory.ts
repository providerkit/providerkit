// Adapted from PydanticAI, pydantic_evals/pydantic_evals/evaluators/agentic.py (MIT).
// Copyright (c) Pydantic Services Inc. 2024 to present.
// Changed: journals replace spans, matching includes arguments/children, and reasons omit data.
import { copyData, equalData, isId, isRecord } from "../snapshot.ts";
import type { ExpectedCall, Trajectory, TrajectoryExpectation, TrajectoryStep } from "./types.ts";

export function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function checkExpectation(raw: unknown): asserts raw is TrajectoryExpectation {
  copyData(raw);
  if (
    !isRecord(raw) ||
    Object.keys(raw).some(
      (key) =>
        ![
          "calls",
          "match",
          "scope",
          "forbidden",
          "forbiddenSequences",
          "maxToolCalls",
          "maxModelCalls",
          "noRepeats",
          "includeFailed",
        ].includes(key),
    ) ||
    (raw.match !== undefined &&
      !["exact", "inOrder", "anyOrder", "subset"].some((v) => v === raw.match)) ||
    (raw.scope !== undefined && raw.scope !== "root" && raw.scope !== "tree") ||
    [raw.maxToolCalls, raw.maxModelCalls].some(
      (v) => v !== undefined && (!nonNegative(v) || !Number.isSafeInteger(v)),
    ) ||
    [raw.noRepeats, raw.includeFailed].some((v) => v !== undefined && typeof v !== "boolean") ||
    (raw.forbidden !== undefined &&
      (!Array.isArray(raw.forbidden) || !raw.forbidden.every(isId))) ||
    (raw.forbiddenSequences !== undefined &&
      (!Array.isArray(raw.forbiddenSequences) ||
        !raw.forbiddenSequences.every(
          (seq) => Array.isArray(seq) && seq.length > 0 && seq.every(isId),
        )))
  )
    throw new TypeError("Invalid trajectory expectation.");
  if (raw.calls === undefined) return;
  if (!Array.isArray(raw.calls)) throw new TypeError("Trajectory calls must be an array.");
  for (const call of raw.calls) {
    if (
      !isRecord(call) ||
      !isId(call.name) ||
      Object.keys(call).some(
        (key) => !["name", "arguments", "argumentsMatch", "input", "inside"].includes(key),
      ) ||
      (call.arguments !== undefined && !isRecord(call.arguments)) ||
      (call.argumentsMatch !== undefined &&
        !["exact", "subset", "ignore"].some((v) => v === call.argumentsMatch))
    )
      throw new TypeError("Each expected call needs a name and valid argument matching options.");
    if (call.inside !== undefined) checkExpectation(call.inside);
  }
}

/** Subset applies to top-level keys. Nested values still compare in full. */
export function argumentsMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  match: "subset" | "exact" = "subset",
): boolean {
  return match === "exact"
    ? equalData(actual, expected)
    : Object.entries(expected).every(
        ([key, value]) => Object.hasOwn(actual, key) && equalData(actual[key], value),
      );
}

function matches(actual: TrajectoryStep, expected: ExpectedCall): boolean {
  const inside = expected.inside;
  return (
    actual.name === expected.name &&
    (expected.arguments === undefined ||
      expected.argumentsMatch === "ignore" ||
      (actual.arguments !== undefined &&
        argumentsMatch(actual.arguments, expected.arguments, expected.argumentsMatch))) &&
    (expected.input === undefined ||
      (actual.workflowId !== undefined && equalData(actual.input, expected.input))) &&
    (!inside || actual.children.some((child) => matchTrajectory(child.trajectory, inside).passed))
  );
}

function lcs(actual: readonly TrajectoryStep[], expected: readonly ExpectedCall[]): number {
  let previous: number[] = Array.from({ length: expected.length + 1 }, () => 0);
  // ponytail: O(actual * expected), with one rolling row. Run limits bound these lists.
  // Large offline traces should preselect the operations to score before using this matcher.
  for (const step of actual) {
    const current = [0];
    for (const [index, call] of expected.entries())
      current.push(
        matches(step, call)
          ? (previous[index] ?? 0) + 1
          : Math.max(previous[index + 1] ?? 0, current[index] ?? 0),
      );
    previous = current;
  }
  return previous.at(-1) ?? 0;
}

/** A greedy match fails when a broad argument subset takes the only match for a narrow one.
 * Reassign matches along an augmenting path so duplicates and overlapping subsets are correct. */
function unorderedOverlap(
  actual: readonly TrajectoryStep[],
  expected: readonly ExpectedCall[],
): number {
  const owners = new Map<number, number>();
  function assign(index: number, seen: Set<number>): boolean {
    const wanted = expected[index];
    if (!wanted) return false;
    for (const [position, step] of actual.entries()) {
      if (seen.has(position) || !matches(step, wanted)) continue;
      seen.add(position);
      const previous = owners.get(position);
      if (previous === undefined || assign(previous, seen)) {
        owners.set(position, index);
        return true;
      }
    }
    return false;
  }
  for (const index of expected.keys()) assign(index, new Set());
  return owners.size;
}

export function matchTrajectory(
  actual: Trajectory,
  expected: TrajectoryExpectation,
): { passed: boolean; score: number; reason?: string } {
  const all = expected.scope === "tree" ? actual.flat : actual.steps;
  const steps = all.filter(
    (step) =>
      expected.includeFailed ||
      (step.workflowId !== undefined ? step.status === "completed" : step.result?.ok === true),
  );
  const calls = expected.calls ?? [];
  const mode = expected.match ?? "inOrder";
  const problems: string[] = [];
  let overlap = 0;
  let passed = true;
  if (expected.calls !== undefined) {
    if (mode === "exact") {
      passed =
        steps.length === calls.length &&
        steps.every((step, index) => {
          const call = calls[index];
          return call !== undefined && matches(step, call);
        });
      overlap = passed ? calls.length : 0;
    } else {
      overlap = mode === "inOrder" ? lcs(steps, calls) : unorderedOverlap(steps, calls);
      passed = mode === "subset" ? overlap === steps.length : overlap === calls.length;
    }
    if (!passed) problems.push("The recorded calls do not match the expected calls and arguments.");
  }
  // Prohibitions include failed and interrupted work at every depth, even when positive
  // expectations deliberately inspect only successful root calls.
  if (actual.flat.some((step) => expected.forbidden?.includes(step.name)))
    problems.push("A forbidden tool or workflow step was recorded.");
  const runs = new Map<string, TrajectoryStep[]>();
  for (const step of actual.flat) {
    const run = runs.get(step.runId) ?? [];
    run.push(step);
    runs.set(step.runId, run);
  }
  for (const run of runs.values()) {
    if (
      expected.noRepeats &&
      (run.some((step) => step.attempts > 1) ||
        run.some((step, index) => {
          const previous = run[index - 1];
          return (
            previous?.name === step.name &&
            equalData(previous.arguments, step.arguments) &&
            equalData(previous.input, step.input)
          );
        }))
    )
      problems.push("A tool or workflow step repeated the same input.");
    if (
      expected.forbiddenSequences?.some((sequence) =>
        run.some((_step, index) =>
          sequence.every((name, offset) => run[index + offset]?.name === name),
        ),
      )
    )
      problems.push("A forbidden sequence of calls was recorded.");
  }
  if (expected.maxToolCalls !== undefined && actual.toolCalls > expected.maxToolCalls)
    problems.push("The tool-call budget was exceeded.");
  if (expected.maxModelCalls !== undefined && actual.modelCalls > expected.maxModelCalls)
    problems.push("The model-call budget was exceeded.");
  const constraintsFailed = problems.some(
    (problem) => problem !== "The recorded calls do not match the expected calls and arguments.",
  );
  const score = constraintsFailed
    ? 0
    : expected.calls === undefined
      ? 1
      : mode === "exact" || mode === "subset"
        ? Number(passed)
        : steps.length + calls.length === 0
          ? 1
          : (2 * overlap) / (steps.length + calls.length);
  return {
    passed: problems.length === 0,
    score,
    ...(problems.length ? { reason: [...new Set(problems)].join(" ") } : {}),
  };
}
