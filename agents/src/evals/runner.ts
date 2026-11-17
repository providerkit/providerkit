import { messageOf } from "@providerkit/core";
import {
  createMemorySession,
  type Agent,
  type AgentInput,
  type RunOutcome,
  type RunSnapshot,
  type TreeNode,
  type UserContent,
} from "../index.ts";
import { agentSnapshot, copyData, immutableCopy, isId, isRecord } from "../snapshot.ts";
import {
  caseData,
  combineUsage,
  emptyUsage,
  evalRun,
  readCases,
  readJournal,
  runResult,
  usageOf,
} from "./journal.ts";
import { checkDriver, createDriver } from "./driver.ts";
import { simulationAgent, simulationPrompt } from "./simulation.ts";
import { checkScorers, normalizeScores } from "./scorers.ts";
import { reportGroups, summarize } from "./report.ts";
import { nonNegative } from "./trajectory.ts";
import type {
  CaseResult,
  EvalCase,
  EvalOptions,
  EvalReport,
  EvalRun,
  EvalRunResult,
  EvalTurnResult,
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
  readCases([caseData(item)]);
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
  users: Map<string, EvalUsage>;
  judges: Map<number, EvalUsage>;
  judgeCount: number;
  records: Map<string, EvalRunResult>;
  settledUnknown: boolean;
}

function newAccount(): Accounting {
  return {
    agent: emptyUsage(),
    users: new Map(),
    judges: new Map(),
    judgeCount: 0,
    records: new Map(),
    settledUnknown: false,
  };
}

async function score<E>(
  run: EvalRun,
  item: EvalCase<E>,
  scorers: readonly Scorer<E>[],
  options: ScoringOptions<E>,
  signal: AbortSignal,
  accounting: Accounting,
  changed: () => void,
  runs: readonly EvalRun[] = [run],
  turn?: number,
): Promise<ScoreResult[]> {
  const results: ScoreResult[] = [];
  const helpers = new Set<Promise<unknown>>();
  const helperStop = new AbortController();
  const helperSignal = AbortSignal.any([signal, helperStop.signal]);
  let helperBusy = false,
    active = true;
  const frozenCase = immutableCopy(caseData(item));
  const context: ScoreContext<E> = {
    case: frozenCase,
    turn,
    runs: immutableCopy(runs),
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
      if (helperBusy || accounting.judgeCount >= (options.maxJudgeRuns ?? 3))
        throw new Error("The helper-run limit was reached. Helpers must run one at a time.");
      helperBusy = true;
      const index = accounting.judgeCount++;
      const began = Date.now();
      let latest: RunSnapshot | undefined;
      const capture = (node: TreeNode) => {
        if (!active) return;
        const snapshot = agentSnapshot(node);
        latest = snapshot;
        let usage: EvalUsage;
        try {
          usage = usageOf(snapshot, options.price);
        } catch (error) {
          accounting.judges.set(index, usageOf(snapshot));
          throw error;
        }
        accounting.judges.set(index, usage);
        accounting.records.set(
          snapshot.runId,
          runResult(snapshot, usage, "judge", options.includePrivateData, turn, Date.now() - began),
        );
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
            accounting.records.set(
              latest.runId,
              runResult(
                latest,
                usage,
                "judge",
                options.includePrivateData,
                turn,
                Date.now() - began,
              ),
            );
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
  return results.map((result) => ({ ...result, ...(turn === undefined ? {} : { turn }) }));
}

function verdict(
  row: Pick<CaseResult, "run" | "scores" | "status" | "problems">,
  item: EvalCase,
): void {
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
        ? "The run is waiting for an answer or a workflow wake time. Supply a matching scripted answer if needed, or expect suspended status. Evals do not resume waiting runs."
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

/** Executes explicitly supplied agents through the SDK. Sandbox real tools. Only the separate
 * trusted driver answers new requests; no stored effect is resumed and no case is retried. */
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
          "beforeStep",
          "canRunConcurrently",
        ].includes(key),
    )
  )
    throw new TypeError(
      "An eval host cannot answer requests, resume effects or replace child execution.",
    );
  if (options.allowSimulation !== undefined && typeof options.allowSimulation !== "boolean")
    throw new TypeError("allowSimulation must be a boolean.");
  if (options.resolveAgent !== undefined && typeof options.resolveAgent !== "function")
    throw new TypeError("resolveAgent must be a function.");
  const needsSimulation = options.cases.some((item) => item.user !== undefined);
  if (needsSimulation && (!options.user || options.allowSimulation !== true))
    throw new TypeError(
      "Simulated-user cases need an explicit user provider and allowSimulation: true. Simulation sends conversation text to that provider and can cost money.",
    );
  const simulator = needsSimulation && options.user ? simulationAgent(options.user) : undefined;
  const ids = new Set<string>();
  for (const item of options.cases) {
    checkCase(item);
    if (ids.has(item.id)) throw new TypeError("Eval case ids must be unique.");
    ids.add(item.id);
    const scorers = [...(options.scorers ?? []), ...(item.scorers ?? [])];
    checkScorers(scorers);
    for (const turn of item.turns ?? []) checkScorers([...scorers, ...(turn.scorers ?? [])]);
  }
  if (options.drivers !== undefined && !isRecord(options.drivers))
    throw new TypeError("Drivers must be keyed by case id.");
  for (const [id, driver] of Object.entries(options.drivers ?? {})) {
    if (!ids.has(id)) throw new TypeError("A driver refers to an unknown case id.");
    checkDriver(driver);
  }
  const startedAt = Date.now();
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, ...(options.signal ? [options.signal] : [])]);
  let stopped: EvalReport["stopped"];
  const accounts: Accounting[] = [];
  function inspect() {
    if (stopped || !budget) return;
    const usage = combineUsage(
      accounts.flatMap((account) => [
        account.agent,
        ...account.judges.values(),
        ...account.users.values(),
      ]),
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
  const jobs: { item: EvalCase<E>; repeat: number }[] = options.cases.flatMap((item) =>
    Array.from({ length: repeat }, (_, index) => ({ item, repeat: index + 1 })),
  );
  const rows: CaseResult[] = jobs.map(({ item, repeat }) => ({
    id: item.id,
    repeat,
    status: "skipped",
    problems: [],
    scores: [],
    runs: [],
    turns: (item.turns ?? [item]).map((_turn, index) => ({
      index: index + 1,
      status: "skipped",
      scores: [],
      problems: [],
    })),
    ...(item.user ? { simulation: "incomplete" as const } : {}),
    agentUsage: emptyUsage(),
    judgeUsage: emptyUsage(),
    userUsage: emptyUsage(),
    durationMs: 0,
  }));
  let next = 0;
  inspect();
  const configuredAgent = options.agent;
  async function worker() {
    while (!signal.aborted) {
      const index = next++,
        job = jobs[index],
        pendingRow = rows[index];
      if (!job || !pendingRow) return;
      const row: CaseResult = pendingRow;
      const began = Date.now(),
        timer = deadline(options, signal);
      const account = newAccount();
      accounts.push(account);
      const driver = createDriver(job.item.id, options.drivers?.[job.item.id], options.host);
      const session = job.item.turns || job.item.user ? createMemorySession() : undefined;
      const runs: EvalRun[] = [];
      let currentTurn: EvalTurnResult | undefined;
      async function execute<R>(
        target: Agent<R>,
        input: AgentInput,
        role: "agent" | "user",
        turn: number,
      ) {
        timer.signal.throwIfAborted();
        const start = Date.now();
        let latest: RunSnapshot | undefined;
        let closed = false;
        const capture = (node: TreeNode, fallback = false) => {
          if (closed) return;
          const snapshot = agentSnapshot(node);
          latest = snapshot;
          let usage: EvalUsage;
          try {
            usage = usageOf(snapshot, options.price);
          } catch (error) {
            usage = usageOf(snapshot);
            if (!fallback) throw error;
          }
          const record = runResult(
            snapshot,
            usage,
            role,
            options.includePrivateData,
            turn,
            Date.now() - start,
          );
          account.records.set(snapshot.runId, record);
          if (role === "user") account.users.set(snapshot.runId, usage);
          else {
            account.agent = combineUsage(
              [...account.records.values()].filter((entry) => entry.role === "agent"),
            );
            row.run = record;
            if (currentTurn) currentTurn.runId = record.runId;
          }
          if (snapshot.state.status !== "running" && usage.unknownCharges)
            account.settledUnknown = true;
          inspect();
        };
        try {
          const outcome = await waitFor(
            target.run(input, {
              ...(role === "agent" ? { ...options.run, session } : {}),
              signal: timer.signal,
              host: {
                ...(role === "agent" ? { ...options.host, ...driver.host } : {}),
                checkpoint: async (snapshot) => {
                  capture(snapshot);
                  if (role === "agent") await options.host?.checkpoint?.(snapshot);
                },
              },
            }),
            timer.signal,
          );
          capture(readJournal(outcome));
          return { outcome, run: evalRun(outcome.snapshot, options.price, Date.now() - start) };
        } finally {
          // Preserve partial receipts on timeout or a host/pricing error, never overwrite earlier turns.
          if (latest) capture(latest, true);
          closed = true;
        }
      }
      try {
        let agent =
          typeof configuredAgent === "function"
            ? await waitFor(
                Promise.resolve().then(() =>
                  configuredAgent({
                    case: job.item,
                    repeat: job.repeat,
                    signal: timer.signal,
                    stub: driver.stub,
                  }),
                ),
                timer.signal,
              )
            : configuredAgent;
        driver.assertApplied();
        const user = job.item.user;
        let input = user?.opening ?? job.item.turns?.[0]?.input ?? job.item.input;
        if (input === undefined) throw new TypeError("The case has no input.");
        const maxTurns = user?.maxTurns ?? (user ? 10 : (job.item.turns?.length ?? 1));
        const transcript: { role: "user" | "assistant"; text: string }[] = [];
        for (let turn = 1; turn <= maxTurns; turn++) {
          timer.signal.throwIfAborted();
          currentTurn = row.turns[turn - 1];
          if (!currentTurn) {
            currentTurn = { index: turn, status: "skipped", scores: [], problems: [] };
            row.turns.push(currentTurn);
          }
          currentTurn.status = "unscored";
          const spec = job.item.turns?.[turn - 1];
          input = spec?.input ?? input;
          const { outcome, run } = await execute(agent, input, "agent", turn);
          runs.push(run);
          const item = { ...job.item, ...(spec ?? {}) };
          const scores = await score(
            run,
            item,
            [...(options.scorers ?? []), ...(job.item.scorers ?? []), ...(spec?.scorers ?? [])],
            options,
            timer.signal,
            account,
            inspect,
            runs,
            turn,
          );
          row.scores.push(...scores);
          currentTurn.scores = scores;
          const result = {
            run: row.run,
            scores,
            status: "unscored" as CaseResult["status"],
            problems: currentTurn.problems,
          };
          verdict(result, item);
          currentTurn.status = result.status;
          row.status = result.status;
          row.problems.push(...result.problems);
          // A completed setup turn can lack scores without blocking the next turn.
          if (
            (result.status !== "passed" && result.status !== "unscored") ||
            outcome.status !== "completed"
          )
            break;
          if (session && outcome.session?.status !== "saved") {
            row.problems.push(
              "The session did not save this turn. Fix the session error before continuing.",
            );
            throw new Error("Session append failed.");
          }
          if (user && simulator) {
            const content: UserContent = run.snapshot.input;
            transcript.push({
              role: "user",
              text:
                typeof content === "string"
                  ? content
                  : content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n"),
            });
            // submit_result can finish without assistant text. Send the saved answer only.
            transcript.push({
              role: "assistant",
              text: typeof run.value === "string" ? run.value : JSON.stringify(run.value),
            });
            const simulated = await execute(
              simulator,
              simulationPrompt(user, transcript),
              "user",
              turn,
            );
            if (
              simulated.outcome.status !== "completed" ||
              typeof simulated.run.value !== "string" ||
              !simulated.run.value.trim()
            ) {
              row.problems.push(
                "The simulated user did not return a non-empty message. Check its provider and settings.",
              );
              throw new Error("Invalid simulated-user reply.");
            }
            const nextInput = simulated.run.value.trim();
            if (nextInput === "</finished>") {
              row.simulation = "finished";
              break;
            }
            if (turn === maxTurns) {
              row.simulation = "turn_limit";
              row.status = "unscored";
              row.problems.push(
                "The simulated conversation reached its turn limit before the user finished. Review the transcript or raise maxTurns.",
              );
              break;
            }
            input = nextInput;
          }
          if (
            turn < maxTurns &&
            (run.activeAgent.id !== agent.id || run.activeAgent.version !== agent.version)
          ) {
            const nextAgent = await waitFor(
              Promise.resolve(options.resolveAgent?.(run.activeAgent)),
              timer.signal,
            );
            if (
              !nextAgent ||
              nextAgent.id !== run.activeAgent.id ||
              nextAgent.version !== run.activeAgent.version
            ) {
              row.problems.push(
                "A handoff changed the conversation owner. Supply resolveAgent for that exact agent id and version.",
              );
              throw new Error("The active agent is not registered for the next turn.");
            }
            agent = nextAgent;
          }
        }
        if (
          row.status === "passed" &&
          (row.turns.some((turn) => turn.status === "skipped") || row.simulation === "incomplete")
        ) {
          row.status = "unscored";
          row.problems.push(
            "The conversation stopped before all turns finished. Review its pending requests and expected statuses.",
          );
        }
        // A later passing turn cannot erase an earlier missing score.
        if (row.status === "passed" && row.turns.some((turn) => turn.status === "unscored"))
          row.status = "unscored";
      } catch (error) {
        row.status = timer.signal.aborted ? "cancelled" : "error";
        if (currentTurn?.status === "unscored") currentTurn.status = row.status;
        row.problems.push(
          timer.signal.aborted
            ? "The case was cancelled or reached its time limit. Work already sent may still finish."
            : "The agent, simulator or host failed. Check the supplied agents, tools and host callbacks.",
        );
        if (options.includePrivateData) row.problems.push(messageOf(error));
      } finally {
        timer.close();
        row.durationMs = Date.now() - began;
        row.runs = [...account.records.values()];
        row.agentUsage = account.agent;
        row.judgeUsage = combineUsage(account.judges.values());
        row.userUsage = combineUsage(account.users.values());
      }
      if (timer.signal.aborted) {
        row.status = "cancelled";
        if (currentTurn && currentTurn.status !== "passed") currentTurn.status = "cancelled";
        if (!row.problems.length)
          row.problems.push(
            "The case was cancelled before scoring finished. Work already sent may still finish.",
          );
      }
      for (const turn of row.turns)
        if (turn.status === "skipped")
          turn.problems.push(
            "This turn was not run because an earlier turn or the evaluation stopped.",
          );
      // A settled unknown bill is not a zero. Under a money threshold stop before the next case.
      if (
        budget?.usd !== undefined &&
        (account.agent.unknownCharges ||
          row.judgeUsage.unknownCharges ||
          row.userUsage.unknownCharges) &&
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
    if (row.status === "skipped") {
      row.problems.push("The case was not started because evaluation stopped.");
      for (const turn of row.turns)
        turn.problems.push("The case was not started because evaluation stopped.");
    }
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
  const accounting = newAccount();
  accounting.agent = usageOf(snapshot, options.price);
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
