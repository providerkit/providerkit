import { messageOf } from "@providerkit/core";
import type { Agent, AgentInput, RunOutcome, RunSnapshot } from "../index.ts";
import { readInput } from "../input.ts";
import { copyData, immutableCopy, isId } from "../snapshot.ts";
import { combineUsage, emptyUsage, evalRun, readJournal, usageOf } from "./journal.ts";
import { checkScorers, normalizeScores } from "./scorers.ts";
import { reportGroups, summarize } from "./report.ts";
import { checkExpectation, nonNegative } from "./trajectory.ts";
import type {
  CaseResult,
  EvalCase,
  EvalOptions,
  EvalReport,
  EvalRun,
  EvalUsage,
  ScoreContext,
  ScoredRun,
  ScoreResult,
  Scorer,
  ScoringOptions,
} from "./types.ts";

function whole(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive whole number.`);
}

function checkScoring(options: ScoringOptions): void {
  whole(options.maxJudgeRuns ?? 3, "maxJudgeRuns");
  const timeout = options.timeoutMs ?? 60_000;
  whole(timeout, "timeoutMs");
  if (timeout > 2_147_483_647) throw new TypeError("timeoutMs must fit a platform timer.");
  for (const value of [options.allowJudge, options.includePrivateData])
    if (value !== undefined && typeof value !== "boolean")
      throw new TypeError("Judge and privacy options must be booleans.");
  if (options.price !== undefined && typeof options.price !== "function")
    throw new TypeError("price must be a function.");
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError("signal must be an AbortSignal.");
}

function checkCase(item: EvalCase): void {
  if (!item || !isId(item.id)) throw new TypeError("Each case needs a non-empty id.");
  readInput(item.input, "caller");
  copyData(item.expected);
  if (
    item.expectStatus !== undefined &&
    !["completed", "failed", "limited", "suspended", "cancelled"].includes(item.expectStatus)
  )
    throw new TypeError("Invalid expected run status.");
  if (item.trajectory !== undefined) checkExpectation(item.trajectory);
}

function deadline(options: ScoringOptions, parent?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("The case reached its time limit.")),
    options.timeoutMs ?? 60_000,
  );
  const signal = AbortSignal.any([
    controller.signal,
    ...(parent ? [parent] : []),
    ...(options.signal ? [options.signal] : []),
  ]);
  return { signal, close: () => clearTimeout(timer) };
}

/** Host callbacks and custom scorers are cooperative. This stops waiting, not their external
 * effects. No new SDK call is admitted from a retained context after scoring has ended. */
async function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

interface Accounting {
  agent: EvalUsage;
  judges: Map<number, EvalUsage>;
  settledUnknown: boolean;
}

async function score<E>(
  run: EvalRun,
  item: EvalCase<E>,
  scorers: readonly Scorer<E>[],
  options: ScoringOptions<E>,
  signal: AbortSignal,
  accounting: Accounting,
  changed: () => void,
): Promise<ScoreResult[]> {
  const results: ScoreResult[] = [];
  const helpers = new Set<Promise<unknown>>();
  const helperStop = new AbortController();
  const helperSignal = AbortSignal.any([signal, helperStop.signal]);
  let helperCount = 0,
    helperBusy = false,
    active = true;
  const { scorers: _scorers, ...caseData } = item;
  const frozenCase = immutableCopy(caseData);
  const context: ScoreContext<E> = {
    case: frozenCase,
    expected: frozenCase.expected,
    run: immutableCopy(run),
    signal,
    runAgent<R>(agent: Agent<R>, input: AgentInput): Promise<RunOutcome<R>> {
      if (!active)
        throw new Error("Scoring has ended. Start another explicit evaluation to run a judge.");
      helperSignal.throwIfAborted();
      if (options.allowJudge !== true)
        throw new Error(
          "Model judging is off. Set allowJudge to true to send data to the supplied provider.",
        );
      if (helperBusy || helperCount >= (options.maxJudgeRuns ?? 3))
        throw new Error("The helper-run limit was reached. Helpers must run one at a time.");
      helperBusy = true;
      const index = helperCount++;
      let latest: RunSnapshot | undefined;
      const capture = (snapshot: RunSnapshot) => {
        if (!active) return;
        latest = snapshot;
        let usage: EvalUsage;
        try {
          usage = usageOf(snapshot, options.price);
        } catch (error) {
          accounting.judges.set(index, usageOf(snapshot));
          throw error;
        }
        accounting.judges.set(index, usage);
        if (snapshot.state.status !== "running" && usage.unknownCharges)
          accounting.settledUnknown = true;
        changed();
      };
      const work = (async () => {
        try {
          const outcome = await agent.run(input, {
            signal: helperSignal,
            host: { checkpoint: capture },
          });
          capture(readJournal(outcome));
          return outcome;
        } finally {
          // If a helper failed after dispatch, the last journal still holds the unknown charge.
          if (latest && active) {
            let usage: EvalUsage;
            try {
              usage = usageOf(latest, options.price);
            } catch {
              usage = usageOf(latest);
            }
            accounting.judges.set(index, usage);
            if (usage.unknownCharges) accounting.settledUnknown = true;
            changed();
          }
        }
      })();
      helpers.add(work);
      void work.then(
        () => {
          helperBusy = false;
          helpers.delete(work);
        },
        () => {
          helperBusy = false;
          helpers.delete(work);
        },
      );
      return work;
    },
  };
  try {
    for (const scorer of scorers) {
      const failure = (code: ScoreResult["error"], error?: unknown): ScoreResult => ({
        scorer: scorer.name,
        name: scorer.name,
        gate: scorer.gate !== false,
        kind: "error",
        error: code,
        ...(options.includePrivateData && error !== undefined ? { reason: messageOf(error) } : {}),
      });
      if (signal.aborted) {
        results.push(failure("cancelled"));
        continue;
      }
      let raw: unknown;
      try {
        try {
          raw = await waitFor(
            Promise.resolve().then(() => scorer.score(context)),
            signal,
          );
        } finally {
          // A failed scorer still owns its helpers and their receipts until they settle.
          await waitFor(Promise.all([...helpers]), signal);
        }
      } catch (error) {
        results.push(failure(signal.aborted ? "cancelled" : "scorer_failed", error));
        continue;
      }
      try {
        results.push(...normalizeScores(scorer, raw, options.includePrivateData === true));
      } catch (error) {
        results.push(failure("invalid_score", error));
      }
    }
  } finally {
    // Stop admission first, then let SDK cancellation save its last available receipts.
    helperStop.abort();
    await Promise.allSettled(helpers);
    active = false;
  }
  return results;
}

function verdict(row: CaseResult, item: EvalCase): void {
  if (!row.run) {
    row.status = "error";
    row.problems.push("The agent did not return a valid run journal.");
    return;
  }
  const expected = item.expectStatus ?? "completed";
  if (row.run.status !== expected) {
    row.status = "failed";
    row.problems.push(
      row.run.status === "suspended"
        ? "The run is waiting for a human request. Evals do not answer or resume it."
        : `Expected run status ${expected}; received ${row.run.status}.`,
    );
  }
  const gates = row.scores.filter((result) => result.gate);
  if (gates.some((result) => result.kind === "error")) {
    row.status = "error";
    row.problems.push(
      "A required scorer failed. Inspect its configuration before running the case again.",
    );
  } else if (gates.some((result) => result.passed === false)) {
    row.status = "failed";
    row.problems.push("A required score did not pass.");
  } else if (row.status !== "failed") {
    if (
      gates.some((result) => result.kind === "skipped") ||
      (!gates.some((result) => result.passed !== undefined) && item.expectStatus === undefined)
    ) {
      row.status = "unscored";
      row.problems.push(
        "No complete set of required scores is available. Supply expectations or the missing measurements.",
      );
    } else row.status = "passed";
  }
}

/** Executes only explicitly supplied agents. Configure their SDK RunLimits/TreeLimits and
 * sandbox their tools. Nothing here grants approvals, resumes snapshots or retries cases. */
export async function runEvals<T, E>(options: EvalOptions<T, E>): Promise<EvalReport> {
  checkScoring(options);
  if (!isId(options.name) || !Array.isArray(options.cases) || !options.cases.length)
    throw new TypeError("An eval needs a name and at least one case.");
  if (
    !options.agent ||
    (typeof options.agent !== "function" && typeof options.agent.run !== "function")
  )
    throw new TypeError("Supply an agent or an agent factory.");
  const repeat = options.repeat ?? 1,
    concurrency = options.concurrency ?? 1;
  whole(repeat, "repeat");
  whole(concurrency, "concurrency");
  const ks = [...(options.k ?? [repeat])];
  if (!ks.length || new Set(ks).size !== ks.length)
    throw new TypeError("k must contain unique positive whole numbers.");
  for (const k of ks) whole(k, "k");
  const budget = copyData(options.budget);
  if (
    budget &&
    (Object.keys(budget).some((key) => key !== "usd" && key !== "tokens") ||
      !Object.keys(budget).length ||
      [budget.usd, budget.tokens].some((v) => v !== undefined && !nonNegative(v)))
  )
    throw new TypeError("Spend thresholds must be finite and non-negative.");
  if (
    options.run &&
    Object.keys(options.run).some(
      (key) => !["context", "modelSettings", "enabledTools"].includes(key),
    )
  )
    throw new TypeError("Eval run options accept only context, modelSettings and enabledTools.");
  if (
    options.host &&
    Object.keys(options.host).some(
      (key) =>
        ![
          "checkpoint",
          "loadMedia",
          "prepareRequest",
          "needsApproval",
          "beforeTool",
          "canRunConcurrently",
        ].includes(key),
    )
  )
    throw new TypeError(
      "An eval host cannot answer requests, resume effects or replace child execution.",
    );
  const ids = new Set<string>();
  for (const item of options.cases) {
    checkCase(item);
    if (ids.has(item.id)) throw new TypeError("Eval case ids must be unique.");
    ids.add(item.id);
    checkScorers([...(options.scorers ?? []), ...(item.scorers ?? [])]);
  }
  const startedAt = Date.now();
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, ...(options.signal ? [options.signal] : [])]);
  let stopped: EvalReport["stopped"];
  const accounts: Accounting[] = [];
  function inspect() {
    if (stopped || !budget) return;
    const usage = combineUsage(
      accounts.flatMap((account) => [account.agent, ...account.judges.values()]),
    );
    if (budget.usd !== undefined && accounts.some((account) => account.settledUnknown))
      stopped = {
        reason: "unknown_cost",
        message:
          "A call's final charge is unknown. Reconcile it with the provider before starting more paid work.",
      };
    else if (budget.usd !== undefined && usage.unpricedCalls > 0)
      stopped = {
        reason: "unknown_cost",
        message:
          "Stopped admitting work because a model call has no complete price. Supply caller rates, including hosted-tool rates, or use a token threshold.",
      };
    else if (
      (budget.usd !== undefined && usage.knownCostUsd >= budget.usd) ||
      (budget.tokens !== undefined &&
        usage.usage.inputTokens + usage.usage.outputTokens >= budget.tokens)
    )
      stopped = {
        reason: "budget",
        message:
          "The spend threshold was reached. No new work was admitted; calls already sent may still finish and charge.",
      };
    if (stopped) stop.abort(new Error(stopped.message));
  }
  // Finite workers avoid one pending promise per case while retaining dataset/repeat order.
  const jobs = options.cases.flatMap((item) =>
    Array.from({ length: repeat }, (_, index) => ({ item, repeat: index + 1 })),
  );
  const rows: CaseResult[] = jobs.map(({ item, repeat }) => ({
    id: item.id,
    repeat,
    status: "skipped",
    problems: [],
    scores: [],
    agentUsage: emptyUsage(),
    judgeUsage: emptyUsage(),
    durationMs: 0,
  }));
  let next = 0;
  inspect();
  const configuredAgent = options.agent;
  async function worker() {
    while (!signal.aborted) {
      const index = next++,
        job = jobs[index],
        row = rows[index];
      if (!job || !row) return;
      const began = Date.now(),
        timer = deadline(options, signal);
      const account: Accounting = { agent: emptyUsage(), judges: new Map(), settledUnknown: false };
      accounts.push(account);
      let latest: RunSnapshot | undefined,
        runDuration: number | undefined,
        closed = false;
      const capture = (snapshot: RunSnapshot) => {
        if (closed) return;
        latest = snapshot;
        account.agent = usageOf(snapshot, options.price);
        if (snapshot.state.status !== "running" && account.agent.unknownCharges)
          account.settledUnknown = true;
        inspect();
      };
      try {
        const agent =
          typeof configuredAgent === "function"
            ? await waitFor(
                Promise.resolve().then(() =>
                  configuredAgent({ case: job.item, repeat: job.repeat, signal: timer.signal }),
                ),
                timer.signal,
              )
            : configuredAgent;
        timer.signal.throwIfAborted();
        const runStarted = Date.now();
        const outcome = await waitFor(
          agent.run(job.item.input, {
            ...options.run,
            signal: timer.signal,
            host: {
              ...options.host,
              prepareRequest:
                options.host?.prepareRequest ??
                (() => ({
                  scope: {
                    actorId: "eval",
                    resource: { id: job.item.id, version: "1" },
                    expiresAt: Date.now() + 900_000,
                  },
                })),
              checkpoint: async (snapshot) => {
                capture(snapshot);
                await options.host?.checkpoint?.(snapshot);
              },
            },
          }),
          timer.signal,
        );
        runDuration = Date.now() - runStarted;
        capture(readJournal(outcome));
        if (!latest) throw new Error("The agent did not return a run journal.");
        const run = evalRun(latest, options.price, runDuration);
        row.scores = await score(
          run,
          job.item,
          [...(options.scorers ?? []), ...(job.item.scorers ?? [])],
          options,
          timer.signal,
          account,
          inspect,
        );
      } catch (error) {
        row.status = timer.signal.aborted ? "cancelled" : "error";
        row.problems.push(
          timer.signal.aborted
            ? "The case was cancelled or reached its time limit. Work already sent may still finish."
            : "The agent or its host failed. Check the supplied agent, tools and host callbacks.",
        );
        if (options.includePrivateData) row.problems.push(messageOf(error));
      } finally {
        closed = true;
        timer.close();
        row.durationMs = Date.now() - began;
        if (latest) {
          // Keep the last known receipt even if pricing or a host callback failed.
          try {
            account.agent = usageOf(latest, options.price);
          } catch {
            account.agent = usageOf(latest);
          }
          const run = evalRun(latest, undefined, runDuration);
          row.run = {
            runId: latest.runId,
            agent: { id: latest.agentId, version: latest.version },
            status: latest.state.status,
            modelCalls: run.trajectory.modelCalls,
            toolCalls: run.trajectory.toolCalls,
            durationMs: runDuration,
            ...(options.includePrivateData ? { snapshot: latest } : {}),
          };
        }
        row.agentUsage = account.agent;
        row.judgeUsage = combineUsage(account.judges.values());
      }
      if (timer.signal.aborted) {
        row.status = "cancelled";
        if (!row.problems.length)
          row.problems.push(
            "The case was cancelled before scoring finished. Work already sent may still finish.",
          );
      } else if (row.status !== "error") verdict(row, job.item);
      // A settled unknown bill is not a zero. Under a money threshold stop before the next case.
      if (
        budget?.usd !== undefined &&
        (account.agent.unknownCharges || row.judgeUsage.unknownCharges) &&
        !stopped
      ) {
        stopped = {
          reason: "unknown_cost",
          message:
            "A call's final charge is unknown. Reconcile it with the provider before starting more paid work.",
        };
        stop.abort(new Error(stopped.message));
      }
      inspect();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (!stopped && signal.aborted)
    stopped = {
      reason: "cancelled",
      message: "Evaluation cancelled. Cases not started remain counted as skipped.",
    };
  for (const row of rows)
    if (row.status === "skipped")
      row.problems.push("The case was not started because evaluation stopped.");
  return {
    format: 1,
    name: options.name,
    startedAt,
    durationMs: Date.now() - startedAt,
    options: { repeat, k: ks, concurrency, ...(budget ? { budget } : {}) },
    cases: rows,
    groups: reportGroups(rows, ks),
    summary: summarize(rows),
    ...(stopped ? { stopped } : {}),
  };
}

/** Scores a validated journal without re-executing its agent or tools. Only explicitly enabled
 * helper judges can make provider calls. Duration is unknown for a stored journal. */
export async function scoreRun<E = unknown>(
  raw: unknown,
  scorers: readonly Scorer<E>[],
  options: ScoringOptions<E> = {},
): Promise<ScoredRun> {
  checkScoring(options);
  const snapshot = readJournal(raw);
  const item = options.case ?? { id: snapshot.runId, input: snapshot.input };
  checkCase(item);
  checkScorers(scorers);
  const run = evalRun(snapshot, options.price);
  const accounting: Accounting = {
    agent: usageOf(snapshot, options.price),
    judges: new Map(),
    settledUnknown: false,
  };
  const timer = deadline(options);
  try {
    const scores = await score(run, item, scorers, options, timer.signal, accounting, () => {});
    return {
      runId: snapshot.runId,
      status: snapshot.state.status,
      scores,
      agentUsage: accounting.agent,
      judgeUsage: combineUsage(accounting.judges.values()),
    };
  } finally {
    timer.close();
  }
}

export interface LiveScorerOptions extends ScoringOptions {
  scorers: readonly Scorer[];
  rate: number;
  concurrency?: number;
}
export type LiveScoreOutcome =
  | { status: "scored"; result: ScoredRun }
  | { status: "not_sampled" | "not_completed" | "busy" | "error" };

/** Explicit host call, not a lifecycle hook. No queue, storage, retries or telemetry. A host
 * must deduplicate run IDs if it wants each completed run scored only once. */
export function createLiveScorer(options: LiveScorerOptions): {
  score(raw: unknown): Promise<LiveScoreOutcome>;
} {
  checkScoring(options);
  checkScorers(options.scorers);
  if (!nonNegative(options.rate) || options.rate > 1)
    throw new TypeError("The sampling rate must be between 0 and 1.");
  const concurrency = options.concurrency ?? 1;
  whole(concurrency, "concurrency");
  let active = 0;
  return {
    async score(raw) {
      if (active >= concurrency) return { status: "busy" };
      active++;
      try {
        const snapshot = readJournal(raw);
        if (snapshot.state.status !== "completed") return { status: "not_completed" };
        // Adapted from Mastra, packages/core/src/evals/hooks.ts (Apache-2.0).
        // Copyright (c) 2025 Kepler Software, Inc. Changed: Web Crypto, no tracing or hook wiring.
        const hash = new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot.runId)),
        );
        const unit = hash.slice(0, 6).reduce((value, byte) => value * 256 + byte, 0) / 2 ** 48;
        if (unit >= options.rate) return { status: "not_sampled" };
        return { status: "scored", result: await scoreRun(snapshot, options.scorers, options) };
      } catch {
        return { status: "error" };
      } finally {
        active--;
      }
    },
  };
}
