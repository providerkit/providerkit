import {
  addUsage,
  costUsd,
  EMPTY_USAGE,
  HOSTED_TOOL_TYPES,
  parseToolArgs,
  type TokenUsage,
} from "@providerkit/core";
import { RESULT_TOOL_NAME, type RunSnapshot } from "../index.ts";
import { inputOf, readInput } from "../input.ts";
import { copyData, isId, isRecord, isUsage, readLimits, readSnapshot } from "../snapshot.ts";
import { checkExpectation } from "./trajectory.ts";
import type {
  EvalCase,
  EvalPrice,
  EvalRun,
  EvalRunResult,
  EvalTurn,
  EvalUsage,
  ModelRef,
  Trajectory,
  TrajectoryStep,
} from "./types.ts";

export function* nodes(root: RunSnapshot): Generator<RunSnapshot> {
  yield root;
  for (const journal of root.delegations)
    for (const child of journal.children) yield* nodes(child.snapshot);
}

function modelsOf(node: RunSnapshot) {
  return [
    ...node.models,
    ...node.compactions.flatMap((entry) => (entry.model ? [entry.model] : [])),
  ];
}

/** Uses the SDK's structural and journal checks, never resume or an output validator. A stored
 * journal is data, not permission to run a tool. Unknown output contracts stay unknown JSON. */
export function readJournal(raw: unknown): RunSnapshot {
  const value = isRecord(raw) && "snapshot" in raw ? raw.snapshot : raw;
  if (!isRecord(value) || !isId(value.agentId) || !isId(value.version))
    throw new TypeError("Provide a format-3 run journal or an SDK run outcome.");
  const limits = readLimits(value.limits);
  const definition = value.definition;
  const checkedOutput =
    isRecord(definition) &&
    Array.isArray(definition.enabledTools) &&
    definition.enabledTools.includes(RESULT_TOOL_NAME);
  const root = readSnapshot(
    value,
    value.agentId,
    value.version,
    limits,
    checkedOutput ? RESULT_TOOL_NAME : undefined,
  );
  // readSnapshot validates the whole tree's shape and root's operations. Validate each child's
  // operations too: stored data need not have come from our own checkpoint callback.
  for (const journal of root.delegations)
    for (const child of journal.children) readJournal(child.snapshot);
  for (const node of nodes(root))
    for (const model of modelsOf(node)) {
      checkUsage(model.usage);
      for (const attempt of model.interrupted) checkUsage(attempt.usage);
    }
  return root;
}

function checkUsage(value: TokenUsage): void {
  if (
    !isUsage(value) ||
    (value.hostedCalls !== undefined &&
      (!isRecord(value.hostedCalls) ||
        Object.entries(value.hostedCalls).some(
          ([key, count]) =>
            !HOSTED_TOOL_TYPES.some((type) => type === key) ||
            typeof count !== "number" ||
            !Number.isFinite(count) ||
            count < 0,
        )))
  )
    throw new TypeError("The journal has invalid token or hosted-call usage.");
}

export function emptyUsage(): EvalUsage {
  return {
    usage: { ...EMPTY_USAGE },
    knownCostUsd: 0,
    costUsd: 0,
    unknownCharges: 0,
    unpricedCalls: 0,
  };
}

export function combineUsage(values: Iterable<EvalUsage>): EvalUsage {
  const result = emptyUsage();
  for (const value of values) {
    result.usage = addUsage(result.usage, value.usage);
    result.knownCostUsd += value.knownCostUsd;
    result.unknownCharges += value.unknownCharges;
    result.unpricedCalls += value.unpricedCalls;
  }
  result.costUsd = result.unknownCharges || result.unpricedCalls ? null : result.knownCostUsd;
  return result;
}

export function usageOf(root: RunSnapshot, price?: EvalPrice): EvalUsage {
  const totals = emptyUsage();
  const seen = new Set<string>();
  for (const node of nodes(root)) {
    for (const model of modelsOf(node)) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const ref: ModelRef = {
        agentId: node.agentId,
        ...(model.status === "completed" ? model.turn.source : undefined),
      };
      for (const attempt of [
        ...model.interrupted.map((attempt) => ({ ...attempt, billing: "unknown" })),
        model,
      ]) {
        checkUsage(attempt.usage);
        totals.usage = addUsage(totals.usage, attempt.usage);
        if (attempt.billing === "unknown") totals.unknownCharges++;
        const measured = attempt.usage;
        if (measured.reportedCostUsd !== undefined) {
          totals.knownCostUsd += measured.reportedCostUsd;
          continue;
        }
        // A reserved operation with no usage has not given us a priceable measurement yet.
        const hasMeasurement =
          measured.inputTokens + measured.outputTokens > 0 ||
          Object.values(measured.hostedCalls ?? {}).some((n) => n > 0);
        if (!hasMeasurement && model.status === "running" && root.state.status === "running")
          continue;
        // An interrupted attempt can have used a different fallback route. The replacement
        // turn's source is not evidence of which model served the lost attempt.
        const rate = price?.(attempt === model ? ref : { agentId: node.agentId });
        if (
          rate &&
          [
            rate.input,
            rate.output,
            rate.cacheRead,
            rate.cacheWrite ?? rate.input,
            ...Object.values(rate.hosted ?? {}),
          ].some((n) => !Number.isFinite(n) || n < 0)
        )
          throw new TypeError("Prices must be finite, non-negative USD rates.");
        const missingHostedRate = HOSTED_TOOL_TYPES.some(
          (type) => (measured.hostedCalls?.[type] ?? 0) > 0 && rate?.hosted?.[type] === undefined,
        );
        const settled =
          attempt !== model || model.status === "completed" || root.state.status !== "running";
        // A running receipt has no source yet. Do not reject a model-specific caller price
        // before the completed turn identifies the model. The unknown charge still counts.
        if ((!rate || missingHostedRate) && settled) totals.unpricedCalls++;
        if (rate) totals.knownCostUsd += costUsd(measured, rate);
      }
    }
  }
  totals.costUsd = totals.unknownCharges || totals.unpricedCalls ? null : totals.knownCostUsd;
  return totals;
}

/** Call order comes from the journal, never completion time. Hosted provider tools are not
 * local calls and are not represented here. Their reported charges still enter usageOf. */
export function journalTrajectory(root: RunSnapshot): Trajectory {
  const result: Trajectory = {
    steps: [],
    flat: [],
    modelCalls: root.compactions.reduce(
      (count, entry) => count + (entry.model ? 1 + entry.model.interrupted.length : 0),
      0,
    ),
    toolCalls: 0,
  };
  for (const [index, model] of root.models.entries()) {
    result.modelCalls += 1 + model.interrupted.length;
    if (model.status !== "completed") continue;
    for (const [position, call] of (model.turn.message.toolCalls ?? []).entries()) {
      const execution = model.tools[position];
      if (!execution || call.name === RESULT_TOOL_NAME) continue;
      const attempts =
        execution.interrupted.length +
        execution.retries.length +
        (execution.status === "pending" ? 0 : 1);
      if (!attempts) continue;
      const journal = root.delegations.find((entry) => entry.operationId === execution.id);
      let args = parseToolArgs(call.arguments);
      for (const ask of execution.asks ?? [])
        if (ask.decision?.type === "approve" && ask.decision.arguments)
          args = ask.decision.arguments;
      const step: TrajectoryStep = {
        kind: journal?.kind ?? "tool",
        name: call.name,
        arguments: copyData(args),
        status:
          execution.status === "completed"
            ? "completed"
            : execution.status === "pending"
              ? "interrupted"
              : "running",
        attempts,
        ...(execution.status === "completed" ? { result: copyData(execution.result) } : {}),
        asks: copyData(execution.asks ?? []),
        agentId: root.agentId,
        runId: root.runId,
        operationId: execution.id,
        turn: index + 1,
        children: (journal?.children ?? []).map(({ key, snapshot }) => ({
          key,
          agentId: snapshot.agentId,
          runId: snapshot.runId,
          trajectory: journalTrajectory(snapshot),
        })),
      };
      result.steps.push(step);
      result.flat.push(step);
      result.toolCalls += attempts;
      for (const child of step.children) {
        result.flat.push(...child.trajectory.flat);
        result.modelCalls += child.trajectory.modelCalls;
        result.toolCalls += child.trajectory.toolCalls;
      }
    }
  }
  return result;
}

export function trajectoryOf(raw: unknown): Trajectory {
  return journalTrajectory(readJournal(raw));
}

export function evalRun(root: RunSnapshot, price?: EvalPrice, durationMs?: number): EvalRun {
  // The last admitted handoff owns the answer; delegated specialists do not.
  let active = root;
  while (true) {
    const child = active.delegations.find(
      (entry) => entry.kind === "handoff" && entry.children.length > 0,
    )?.children[0];
    if (!child) break;
    active = child.snapshot;
  }
  const last = active.models.at(-1);
  return {
    runId: root.runId,
    agentId: root.agentId,
    version: root.version,
    input: inputOf(root),
    status: root.state.status,
    ...(root.state.status === "completed" ? { value: copyData(root.state.candidate) } : {}),
    text: last?.status === "completed" ? last.turn.message.content : "",
    snapshot: root,
    activeAgent: { id: active.agentId, version: active.version },
    trajectory: journalTrajectory(root),
    durationMs,
    ...usageOf(root, price),
  };
}

export function runResult(
  snapshot: RunSnapshot,
  usage: EvalUsage,
  role: EvalRunResult["role"],
  includePrivateData = false,
  turn?: number,
  durationMs?: number,
): EvalRunResult {
  const run = evalRun(snapshot, undefined, durationMs);
  return {
    runId: snapshot.runId,
    attemptId: snapshot.attemptId,
    agent: { id: snapshot.agentId, version: snapshot.version },
    activeAgent: run.activeAgent,
    role,
    turn,
    status: snapshot.state.status,
    modelCalls: run.trajectory.modelCalls,
    toolCalls: run.trajectory.toolCalls,
    durationMs,
    ...usage,
    modelAttempts: [...nodes(snapshot)].flatMap((node) =>
      modelsOf(node).flatMap((model) => [
        ...model.interrupted.map((attempt) => ({
          operationId: model.id,
          attemptId: attempt.attemptId,
          status: "interrupted" as const,
          billing: "unknown" as const,
          usage: copyData(attempt.usage),
        })),
        {
          operationId: model.id,
          attemptId: model.attemptId,
          status: model.status,
          billing: model.billing,
          usage: copyData(model.usage),
        },
      ]),
    ),
    toolAttempts: [...nodes(snapshot)].flatMap((node) =>
      node.models.flatMap((model) =>
        model.status !== "completed"
          ? []
          : model.tools.flatMap((tool) => [
              ...tool.interrupted.map((attempt) => ({
                operationId: tool.id,
                attemptId: attempt.attemptId,
                status: "interrupted" as const,
              })),
              ...tool.retries.map((attempt) => ({
                operationId: tool.id,
                attemptId: attempt.attemptId,
                status: "completed" as const,
                ok: false,
              })),
              ...(tool.status === "pending"
                ? []
                : [
                    {
                      operationId: tool.id,
                      attemptId: tool.attemptId,
                      status:
                        tool.status === "completed" ? ("completed" as const) : ("running" as const),
                      ...(tool.status === "completed" ? { ok: tool.result.ok } : {}),
                    },
                  ]),
            ]),
      ),
    ),
    ...(includePrivateData ? { snapshot: copyData(snapshot) } : {}),
  };
}

/** Strip executable scorers before freezing context or validating stored case data. */
export function caseData<E>(item: EvalCase<E>): EvalCase<E> {
  const { scorers: _scorers, turns, ...data } = item;
  return {
    ...data,
    ...(turns ? { turns: turns.map(({ scorers: _turnScorers, ...turn }) => turn) } : {}),
  };
}

/** Validates data only; a dataset file cannot supply functions, drivers or scorer names.
 * Supply validateExpected to read typed expected values, including each turn's expectation. */
export function readCases(raw: unknown): EvalCase[];
export function readCases<E>(raw: unknown, validateExpected: (value: unknown) => E): EvalCase<E>[];
export function readCases(
  raw: unknown,
  validateExpected?: (value: unknown) => unknown,
): EvalCase[] {
  if (!Array.isArray(raw)) throw new TypeError("Cases must be an array.");
  const ids = new Set<string>();
  function expectations(
    value: Record<string, unknown>,
  ): Pick<EvalCase, "expected" | "expectStatus" | "trajectory"> {
    const status = value.expectStatus;
    if (
      status !== undefined &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "limited" &&
      status !== "suspended" &&
      status !== "cancelled"
    )
      throw new TypeError("Invalid expected run status.");
    if (value.trajectory !== undefined) checkExpectation(value.trajectory);
    return {
      ...(Object.hasOwn(value, "expected")
        ? {
            expected: validateExpected
              ? validateExpected(value.expected)
              : copyData(value.expected),
          }
        : {}),
      ...(status ? { expectStatus: status } : {}),
      ...(value.trajectory === undefined ? {} : { trajectory: value.trajectory }),
    };
  }
  return raw.map((rawValue): EvalCase => {
    const value = copyData(rawValue);
    if (
      !isRecord(value) ||
      !isId(value.id) ||
      ids.has(value.id) ||
      Object.keys(value).some(
        (key) =>
          !["id", "input", "turns", "user", "expected", "expectStatus", "trajectory"].includes(key),
      ) ||
      [value.input, value.turns, value.user].filter((entry) => entry !== undefined).length !== 1
    )
      throw new TypeError(
        "Each case needs a unique id and exactly one of input, turns and user. Drivers and code are not case data.",
      );
    ids.add(value.id);
    const base = { id: value.id, ...expectations(value) };
    if (value.turns !== undefined) {
      if (!Array.isArray(value.turns) || !value.turns.length)
        throw new TypeError("A conversation case needs at least one turn.");
      const turns = value.turns.map((turn): EvalTurn => {
        if (
          !isRecord(turn) ||
          Object.keys(turn).some(
            (key) => !["input", "expected", "expectStatus", "trajectory"].includes(key),
          ) ||
          isRecord(turn.input)
        )
          throw new TypeError(
            "Each session turn needs a new user input and only supported data fields.",
          );
        return { input: readInput(turn.input, "caller").input, ...expectations(turn) };
      });
      return { ...base, turns };
    }
    if (value.user !== undefined) {
      const user = value.user;
      if (
        !isRecord(user) ||
        Object.keys(user).some(
          (key) => !["opening", "plan", "persona", "maxTurns"].includes(key),
        ) ||
        !isId(user.plan) ||
        (user.persona !== undefined && !isId(user.persona)) ||
        isRecord(user.opening) ||
        (user.maxTurns !== undefined &&
          (typeof user.maxTurns !== "number" ||
            !Number.isSafeInteger(user.maxTurns) ||
            user.maxTurns < 1 ||
            user.maxTurns > 100))
      )
        throw new TypeError(
          "A simulated user needs a plan, an opening and a turn limit from 1 to 100.",
        );
      return {
        ...base,
        user: {
          opening: readInput(user.opening, "caller").input,
          plan: user.plan,
          ...(user.persona === undefined ? {} : { persona: user.persona }),
          ...(user.maxTurns === undefined ? {} : { maxTurns: user.maxTurns }),
        },
      };
    }
    const input = readInput(value.input, "caller");
    return {
      ...base,
      input: input.history.length
        ? { messages: [...input.history, { role: "user", content: input.input }] }
        : input.input,
    };
  });
}

/** Explicitly copies private input, output and tool arguments. Nothing is executed or approved.
 * Supply a sandboxed agent when you later run this case; stored results are not tool mocks. */
export function caseFromRun(raw: unknown, options: { id: string }): EvalCase {
  if (!isId(options.id)) throw new TypeError("Give the golden case a non-empty id.");
  const snapshot = readJournal(raw);
  if (snapshot.state.status !== "completed")
    throw new TypeError(
      "Only a completed run can become a golden case. No interrupted work is resumed.",
    );
  if ([...nodes(snapshot)].some((node) => node.inputs.length > 0))
    throw new TypeError(
      "This run received messages while working. Record its input timing in the host instead of replaying it as one case.",
    );
  return {
    id: options.id,
    input: inputOf(snapshot),
    expected: copyData(snapshot.state.candidate),
    trajectory: {
      match: "exact",
      calls: journalTrajectory(snapshot)
        .steps.filter((step) => step.result?.ok)
        .map((step) => ({ name: step.name, arguments: step.arguments, argumentsMatch: "exact" })),
    },
  };
}
