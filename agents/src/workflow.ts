/**
 * Keyed JSON replay adapted from TanStack AI and Microsoft Agent Framework (MIT).
 * Retry exclusions adapted from LangGraph.js (MIT).
 * Child replay and suspension adapted from Google ADK JS:
 * Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0
 * Changes: explicit keys, fail-closed effects, existing SDK requests, leases and tree budgets.
 * See THIRD_PARTY_NOTICES.md for source paths and licenses.
 */
import {
  backoffMs,
  createGate,
  isTransient,
  messageOf,
  ProviderError,
  sleep,
} from "@providerkit/core";
import {
  AGENT_RUNTIME,
  defineDelegation,
  specialistFailures,
  runtimeOf,
  type NodeOutcome,
  type Specialist,
} from "./delegation.ts";
import type { RemoteAgent, RemoteInput, RemoteOutcome } from "./a2a/remote.ts";
import { admitChild, matchesChildInput, startChild, childOptions, prepareChild } from "./child.ts";
import { checkMemoryBinding, memoryScopes, readMemoryBinding } from "./memory.ts";
import { RequestJournal, isAsk, requestHash } from "./request.ts";
import {
  checkOptions,
  childRunId,
  copyData,
  equalData,
  immutableCopy,
  isId,
  isRecord,
  readTreeLimits,
  readWorkflowSnapshot,
} from "./snapshot.ts";
import { readWorkflowLimits, stepData, stepId } from "./workflow-snapshot.ts";
import {
  authorizeTree,
  checkPricing,
  emitEvent,
  ExecutionTree,
  fail,
  Halt,
  isLocalStop,
  nodeId,
  openRequests,
  readAnswers,
  requestRecords,
  snapshots,
  treeUsage,
  untilAbort,
  wakeAt,
  type ExecutionScope,
} from "./tree.ts";
import type {
  Agent,
  AgentInput,
  Answer,
  QuestionAsk,
  RunOptions,
  RunOutcome,
  TreeNode,
} from "./types.ts";
import type {
  ChildRetry,
  StepAttempt,
  StepError,
  StepExecution,
  StepKind,
  StepOptions,
  StepRequest,
  StepRun,
  Workflow,
  WorkflowContext,
  WorkflowOutcome,
  WorkflowRuntime,
  WorkflowSnapshot,
  WorkflowSpec,
} from "./workflow-types.ts";
export type * from "./workflow-types.ts";

export class StepFailedError extends Error {
  readonly reason: StepError["reason"];
  constructor(
    readonly key: string,
    readonly error: StepError,
  ) {
    super(error.message);
    this.name = "StepFailedError";
    this.reason = error.reason;
  }
}
class Pause extends Error {}
const pause = new Pause();

function workflowNode(node: TreeNode): WorkflowSnapshot {
  if (node.kind !== "workflow") throw new TypeError("Expected a workflow node.");
  return node;
}
function retryable(error: unknown): boolean {
  if (error instanceof ProviderError) return isTransient(error.kind) && error.shouldRetry !== false;
  if (!isRecord(error)) return true;
  if (
    error.name === "AbortError" ||
    error.code === "ECONNABORTED" ||
    (typeof error.message === "string" && /^(Cancel|AbortError)/.test(error.message))
  )
    return false;
  const status = isRecord(error.response) ? error.response.status : error.status;
  if ([400, 401, 402, 403, 404, 405, 406, 407, 409].includes(Number(status))) return false;
  return (
    error.code !== "insufficient_quota" &&
    !(isRecord(error.error) && error.error.code === "insufficient_quota")
  );
}
function errorOf(error: unknown, reason: StepError["reason"] = "failed"): StepError {
  return { reason, name: error instanceof Error ? error.name : "Error", message: messageOf(error) };
}
function stepPolicy<T, I>(options: StepOptions<T, I>): Record<string, unknown> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retry = options.retry;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new TypeError("timeoutMs must be a positive whole number that fits a timer.");
  if (
    retry &&
    (!Number.isSafeInteger(retry.maxAttempts) ||
      retry.maxAttempts < 1 ||
      retry.maxAttempts > 100 ||
      !["read-only", "reconcile"].includes(retry.replay) ||
      [retry.baseDelayMs ?? 1_000, retry.maxDelayMs ?? 30_000].some(
        (ms) => !Number.isSafeInteger(ms) || ms < 0 || ms > 2_147_483_647,
      ))
  )
    throw new TypeError("Retries need a bounded attempt count and read-only or reconcile policy.");
  if (options.needsApproval && retry)
    throw new TypeError("Approval-gated effects cannot retry an old decision.");
  return {
    input: options.input,
    timeoutMs,
    needsApproval: options.needsApproval === true,
    validate: !!options.validate,
    validateInput: !!options.validateInput,
    retry: retry
      ? {
          maxAttempts: retry.maxAttempts,
          replay: retry.replay,
          baseDelayMs: retry.baseDelayMs ?? 1_000,
          maxDelayMs: retry.maxDelayMs ?? 30_000,
          retryOn: !!retry.retryOn,
        }
      : null,
  };
}

export function defineWorkflow<I, O>(spec: WorkflowSpec<I, O>): Workflow<I, O> {
  if (
    !isId(spec.id) ||
    !isId(spec.version) ||
    typeof spec.run !== "function" ||
    !isRecord(spec.input?.schema) ||
    spec.input.schema.type !== "object" ||
    typeof spec.input.validate !== "function" ||
    (spec.output &&
      (!isRecord(spec.output.schema) ||
        spec.output.schema.type !== "object" ||
        typeof spec.output.validate !== "function"))
  )
    throw new TypeError(
      "A workflow needs an id, version, input schema, validator and async function.",
    );
  const { id, version, run } = spec;
  const input = { schema: immutableCopy(spec.input.schema), validate: spec.input.validate };
  const output = spec.output && {
    schema: immutableCopy(spec.output.schema),
    validate: spec.output.validate,
  };
  const limits = readWorkflowLimits(spec.limits);
  const treeLimits = readTreeLimits(spec.treeLimits);
  const agents = [...(spec.agents ?? [])];
  const workflows = [...(spec.workflows ?? [])];
  const specialists: Specialist[] = [...agents, ...workflows];
  if (
    specialists.some((node) => !node?.[AGENT_RUNTIME]) ||
    new Set(specialists.map((node) => node.id)).size !== specialists.length
  )
    throw new TypeError("Register each workflow or agent once, with a unique id.");
  const definition = immutableCopy({
    input: input.schema,
    output: output?.schema ?? null,
    specialists: specialists.map((node) => ({
      kind: node.kind,
      id: node.id,
      version: node.version,
      definition: node[AGENT_RUNTIME].configuration(),
    })),
  });
  const data = <T>(value: T) => stepData(value, limits.resultBytes);
  function validateOutput(value: unknown): O {
    // The unvalidated contract promises O is JSON. Validated contracts may rebuild application values.
    return output ? output.validate(copyData(value)) : (copyData(value) as O);
  }
  function target(step: StepExecution): Specialist {
    const node = specialists.find(
      (node) =>
        node.id === step.definition.targetId &&
        node.version === step.definition.version &&
        node.kind === step.kind,
    );
    if (!node) throw new TypeError("Restore the registered workflow specialist version.");
    return node;
  }
  function request(snapshot: WorkflowSnapshot, step: StepExecution): StepRequest {
    return {
      workflowId: id,
      version,
      runId: snapshot.runId,
      attemptId: step.attempts.at(-1)?.attemptId ?? snapshot.attemptId,
      operationId: step.id,
      key: step.key,
      kind: step.kind,
      input: step.definition.input,
    };
  }
  function journal(
    snapshot: WorkflowSnapshot,
    step: StepExecution,
    options: RunOptions,
    scope: ExecutionScope,
    signal: AbortSignal,
  ) {
    return new RequestJournal(step, request(snapshot, step), options, scope, signal, () =>
      requestHash({ workflowId: id, version, kind: step.kind, definition: step.definition }),
    );
  }
  async function answerRequests(
    node: TreeNode,
    options: RunOptions,
    scope: ExecutionScope,
    answers: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void> {
    const snapshot = workflowNode(node);
    if (!["running", "suspended"].includes(snapshot.state.status)) return;
    for (const step of snapshot.steps) {
      if (step.status === "completed" || step.status === "failed") continue;
      const requests = journal(snapshot, step, options, scope, signal);
      for (const record of [...(step.asks ?? [])]) {
        scope.tree.active();
        signal.throwIfAborted();
        if (record.closed) continue;
        if (!record.decision && Object.hasOwn(answers, record.request.id))
          await requests.resolve(record, answers[record.request.id]);
        else await requests.refresh(record);
      }
      for (const child of step.children)
        await runtimeOf(target(step)).answerRequests(
          child.snapshot,
          childOptions(options),
          {
            tree: scope.tree,
            depth: scope.depth + 1,
            path: [
              ...scope.path,
              { operationId: step.id, key: child.key, runId: child.snapshot.runId },
            ],
          },
          answers,
          signal,
        );
    }
  }

  /** Replay coordination is also a preflight: no host callback, new admission or effect here. */
  async function coordinate(
    snapshot: WorkflowSnapshot,
    options: RunOptions,
    scope: ExecutionScope,
    replay: boolean,
    strictReplay = false,
    matched?: ReadonlySet<string>,
  ): Promise<{ candidate?: unknown; visited: Set<string>; paused: boolean }> {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      scope.tree.signal,
      controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const gate = createGate(limits.parallelSteps);
    const recorded = [...snapshot.steps];
    const visited = new Set<string>();
    const work: Promise<unknown>[] = [];
    let accepting = true;
    let paused = false;
    let frontier = false;
    let fatal: unknown;
    const hostContext = Object.freeze({ ...options.context });
    const emit: typeof emitEvent = (opts, event) => {
      try {
        emitEvent(opts, event);
      } catch {
        fail(
          "progress_failed",
          "Workflow progress could not be stored. Reconcile saved state before continuing.",
        );
      }
    };
    function active(): void {
      if (!strictReplay) scope.tree.active();
      if (options.signal?.aborted) throw new Halt({ status: "cancelled" });
      if (fatal) throw fatal;
      signal.throwIfAborted();
    }
    function stop(error: unknown): void {
      if (error === pause || (error instanceof Halt && error.state.status === "suspended")) {
        paused = true;
        return;
      }
      if (error instanceof Halt || !(error instanceof StepFailedError)) {
        fatal ??= error;
        controller.abort(error);
      }
    }
    function admit<T>(
      key: string,
      kind: StepKind,
      identity: Record<string, unknown>,
      execute: (step: StepExecution) => Promise<T>,
    ): Promise<T> {
      let entry: StepExecution;
      try {
        active();
        if (!accepting)
          fail("workflow_closed", "Start steps only inside the active workflow function.");
        if (!isId(key) || key.length > 256)
          fail("invalid_step_key", "Use a nonempty step key of at most 256 characters.");
        if (visited.has(key))
          fail("duplicate_step_key", "Use a different key for each step in one workflow attempt.");
        visited.add(key);
        const saved = snapshot.steps.find((step) => step.key === key);
        identity = data(identity);
        if (saved && (saved.kind !== kind || !equalData(saved.definition, identity)))
          fail(
            "nondeterministic_step",
            "A recorded step changed kind, input or definition. Restore its workflow version.",
            saved.id,
          );
        if (!replay && paused) throw pause;
        if (!saved) {
          if (replay) {
            if (strictReplay || snapshot.state.status === "completed")
              fail("nondeterministic_workflow", "Replay reached an unrecorded step.");
            frontier = true;
            throw pause;
          }
          if (snapshot.steps.length >= limits.steps)
            throw new Halt({ status: "limited", limit: "steps" });
          // ponytail: bounded whole-root checkpoints. A patch journal is the upgrade for large workflows.
          entry = {
            id: stepId(snapshot.runId, key),
            key,
            kind,
            definition: identity,
            status: "pending",
            attempts: [],
            children: [],
          };
          snapshot.steps.push(entry);
        } else entry = saved;
      } catch (error) {
        stop(error);
        const rejected = Promise.reject<T>(error);
        void rejected.catch(() => {});
        work.push(rejected);
        return rejected;
      }
      // Defer dispatch one microtask: duplicate synchronous admissions fail before any effect.
      const pending = Promise.resolve()
        .then(async () => {
          active();
          if (entry.status === "failed")
            throw new StepFailedError(key, entry.error ?? errorOf("Step failed."));
          if (!replay && entry.kind !== "step" && entry.status !== "completed")
            emit(options, {
              type: "step_start",
              runId: snapshot.runId,
              attemptId: snapshot.attemptId,
              operationId: entry.id,
              key,
              kind: entry.kind,
              attempt: Math.max(1, entry.children.length),
            });
          return execute(entry);
        })
        .catch((error: unknown) => {
          if (
            !replay &&
            entry.status !== "retrying" &&
            (error === pause || (error instanceof Halt && error.state.status === "suspended"))
          )
            entry.status = "waiting";
          // Only callback failures saved as StepFailedError are local. A request, host,
          // progress or journal error must not become recoverable specialist feedback.
          const failure =
            error === pause || error instanceof Halt || error instanceof StepFailedError
              ? error
              : new Halt({
                  status: "failed",
                  error: {
                    code: "workflow_operation_failed",
                    message:
                      "A workflow host operation failed. Reconcile stored state before continuing.",
                    operationId: entry.id,
                  },
                });
          stop(failure);
          throw failure;
        });
      work.push(pending);
      void pending.catch(() => {});
      return pending;
    }
    async function beforeEffect(
      step: StepExecution,
      current: StepRequest = request(snapshot, step),
    ): Promise<void> {
      active();
      // Replay already matched cached sibling chains. Their live microtask order is not drift.
      if (recorded.some((saved) => !visited.has(saved.key) && !matched?.has(saved.key)))
        fail(
          "nondeterministic_workflow",
          "Replay must reach every recorded step before starting more effects.",
          step.id,
        );
      const requests = journal(snapshot, step, options, scope, signal);
      try {
        await requests.recheck(current);
      } catch (error) {
        if (error instanceof Halt) throw error;
        fail(
          "step_authorization_failed",
          "The host could not authorize this workflow step. Check current ownership and lease before continuing.",
          step.id,
        );
      }
      active();
      await requests.assertFresh();
    }
    async function finish(step: StepExecution, result: unknown): Promise<void> {
      step.result = data(result);
      step.status = "completed";
      await scope.tree.save();
      active();
      emit(options, {
        type: "step_result",
        runId: snapshot.runId,
        attemptId: step.attempts.at(-1)?.attemptId ?? snapshot.attemptId,
        operationId: step.id,
        key: step.key,
        kind: step.kind,
        status: "completed",
      });
    }
    async function failed(step: StepExecution, error: StepError): Promise<never> {
      step.error = copyData(error);
      step.status = "failed";
      for (const record of step.asks ?? [])
        if (!record.closed && !record.decision) record.closed = "stopped";
      await scope.tree.save();
      emit(options, {
        type: "step_result",
        runId: snapshot.runId,
        attemptId: step.attempts.at(-1)?.attemptId ?? snapshot.attemptId,
        operationId: step.id,
        key: step.key,
        kind: step.kind,
        status: "failed",
        error,
      });
      throw new StepFailedError(step.key, error);
    }
    async function wait(step: StepExecution): Promise<void> {
      active();
      const at = step.wakeAt;
      if (at === undefined) throw new TypeError("Missing saved wake time.");
      if (at >= snapshot.tree.startedAt + snapshot.tree.limits.elapsedMs)
        throw new Halt({ status: "limited", limit: "treeElapsedMs" });
      const remaining = at - Date.now();
      if (remaining > 0) {
        if (replay || remaining > limits.inlineWaitMs) throw pause;
        await sleep(remaining, signal);
      }
      active();
    }
    async function repeat(
      step: StepExecution,
      attempt: StepAttempt,
      policy: NonNullable<StepOptions<unknown, unknown>["retry"]>,
    ): Promise<void> {
      if (
        step.asks?.length ||
        step.attempts.filter((item) => item.status !== "not_run").length >= policy.maxAttempts
      )
        fail(
          "step_retry_unsafe",
          "This step cannot repeat an answered or exhausted attempt. Reconcile it with the host.",
          step.id,
        );
      await beforeEffect(step);
      if (policy.replay === "reconcile" && !attempt.reconciliation) {
        const verdict = await untilAbort(
          Promise.resolve(
            options.host?.reconcileStep?.(
              immutableCopy(request(snapshot, step)),
              immutableCopy(attempt),
              signal,
            ),
          ),
          signal,
        );
        active();
        if (verdict?.outcome !== "not_run" || !isId(verdict.receipt))
          fail(
            "step_retry_unsafe",
            "The host could not prove this attempt did not run and cannot still complete. Reconcile its result.",
            step.id,
          );
        attempt.reconciliation = verdict.receipt;
      }
      if (attempt.status === "running") attempt.status = "interrupted";
      step.status = "retrying";
      step.wakeAt ??=
        Date.now() +
        backoffMs(
          step.attempts.length - 1,
          policy.baseDelayMs ?? 1_000,
          policy.maxDelayMs ?? 30_000,
        );
      await scope.tree.save();
      await wait(step);
    }
    function step<T, SI = undefined>(
      key: string,
      fn: (run: StepRun<SI>) => T | Promise<T>,
      opts: StepOptions<T, SI> = {},
    ): Promise<T> {
      opts = { ...opts, input: copyData(opts.input), retry: opts.retry && { ...opts.retry } };
      const policy = stepPolicy(opts);
      const validate = (value: unknown): T => {
        try {
          return opts.validate ? opts.validate(copyData(value)) : (copyData(value) as T);
        } catch {
          fail(
            "invalid_step_result",
            "A saved step result no longer passes its validator. Restore its original contract.",
            stepId(snapshot.runId, key),
          );
        }
      };
      return admit(key, "step", policy, async (entry) => {
        if (entry.status === "completed") return validate(entry.result);
        if (replay) throw pause;
        const release = await gate.acquire(signal);
        try {
          let effective: SI = copyData(opts.input) as SI;
          const requests = journal(snapshot, entry, options, scope, signal);
          if (opts.needsApproval) {
            entry.status = "waiting";
            const record = await requests.ensure({ type: "approval" });
            if (!record.decision) throw pause;
            const decision = record.decision;
            if (decision.type === "stop") {
              scope.tree.stop();
              throw new Halt({ status: "cancelled" });
            }
            if (decision.type === "deny" || decision.type === "cancel")
              return failed(entry, {
                reason: decision.type === "deny" ? "denied" : "cancelled",
                name: "Decision",
                message:
                  decision.type === "deny"
                    ? (decision.message ?? "This step was denied.")
                    : "This step was cancelled.",
              });
            if (decision.type !== "approve") throw new TypeError("This step needs an approval.");
            if (decision.arguments !== undefined) {
              if (!opts.validateInput)
                fail(
                  "invalid_step_input",
                  "Supply validateInput before allowing edited step input.",
                  entry.id,
                );
              effective = opts.validateInput(copyData(decision.arguments));
            }
          }
          for (;;) {
            active();
            if (entry.attempts.length >= 100) throw new Halt({ status: "limited", limit: "steps" });
            const previous = entry.attempts.at(-1);
            if (previous && (previous.status === "running" || entry.status === "retrying")) {
              if (!opts.retry)
                fail(
                  "interrupted_operation",
                  "This step has an unknown outcome. Reconcile it before starting different work.",
                  entry.id,
                );
              await repeat(entry, previous, opts.retry);
            }
            await beforeEffect(entry, { ...request(snapshot, entry), input: effective });
            entry.status = "running";
            delete entry.wakeAt;
            const attempt: StepAttempt = {
              attemptId: `${snapshot.attemptId}/step-attempt/${entry.attempts.length + 1}`,
              status: "running",
            };
            entry.attempts.push(attempt);
            await scope.tree.save();
            active();
            // Progress observers cannot waive the last ownership or expiry check.
            emit(options, {
              type: "step_start",
              runId: snapshot.runId,
              attemptId: attempt.attemptId,
              operationId: entry.id,
              key,
              kind: "step",
              attempt: entry.attempts.length,
            });
            // A slow checkpoint can outlive the owner's lease or the approval's expiry.
            try {
              await requests.recheck({ ...request(snapshot, entry), input: effective });
              await requests.assertFresh();
              active();
            } catch (error) {
              attempt.status = "not_run";
              entry.status = "waiting";
              if (error instanceof Halt) throw error;
              fail(
                "step_authorization_failed",
                "The host refused current access before dispatch. Reconcile ownership before continuing.",
                entry.id,
              );
            }
            const timeout = new AbortController();
            const attemptSignal = AbortSignal.any([signal, timeout.signal]);
            const timer = setTimeout(
              () => timeout.abort(new Error("The workflow step timed out.")),
              opts.timeoutMs ?? 60_000,
            );
            let value: unknown;
            let thrown: { error: unknown } | undefined;
            try {
              value = await untilAbort(
                Promise.resolve(
                  fn(
                    Object.freeze({
                      key,
                      attempt: entry.attempts.length,
                      idempotencyKey: entry.id,
                      input: immutableCopy(effective),
                      context: hostContext,
                      signal: attemptSignal,
                      report(value: unknown) {
                        active();
                        attemptSignal.throwIfAborted();
                        if (attempt.status !== "running")
                          throw new Error("The step already settled.");
                        emit(options, {
                          type: "step_progress",
                          runId: snapshot.runId,
                          attemptId: attempt.attemptId,
                          operationId: entry.id,
                          key,
                          data: data(value),
                        });
                      },
                    }),
                  ),
                ),
                attemptSignal,
              );
            } catch (error) {
              thrown = { error };
            } finally {
              clearTimeout(timer);
            }
            active();
            let invalidResult = false;
            if (!thrown) {
              try {
                value = data(value);
                opts.validate?.(copyData(value));
              } catch (error) {
                invalidResult = true;
                thrown = { error };
              }
            }
            if (!thrown) {
              attempt.status = "completed";
              await finish(entry, value);
              return validate(entry.result);
            }
            if (thrown.error instanceof Halt) throw thrown.error;
            const error = errorOf(thrown.error, timeout.signal.aborted ? "timeout" : "failed");
            attempt.status = "failed";
            attempt.error = error;
            entry.error = error;
            if (
              !invalidResult &&
              opts.retry &&
              entry.attempts.filter((item) => item.status !== "not_run").length <
                opts.retry.maxAttempts &&
              !entry.asks?.length &&
              (opts.retry.retryOn
                ? opts.retry.retryOn(immutableCopy(error), entry.attempts.length)
                : retryable(thrown.error))
            ) {
              entry.status = "retrying";
              entry.wakeAt =
                Date.now() +
                backoffMs(
                  entry.attempts.length - 1,
                  opts.retry.baseDelayMs ?? 1_000,
                  opts.retry.maxDelayMs ?? 30_000,
                );
              await scope.tree.save();
              emit(options, {
                type: "step_result",
                runId: snapshot.runId,
                attemptId: attempt.attemptId,
                operationId: entry.id,
                key,
                kind: "step",
                status: "retrying",
                error,
              });
              continue;
            }
            return failed(entry, error);
          }
        } finally {
          release();
        }
      });
    }
    function ask<T>(
      question: Omit<QuestionAsk, "type">,
      validate: (answer: Answer) => T,
    ): Promise<T> {
      const ask = { ...question, type: "question" as const };
      if (!isAsk(ask)) throw new TypeError("Provide a valid question with a stable key.");
      return admit(question.key, "ask", { question: ask }, async (entry) => {
        if (entry.status === "completed") {
          try {
            return validate(copyData(entry.result) as Answer);
          } catch {
            fail("invalid_step_result", "A recorded answer no longer passes validation.", entry.id);
          }
        }
        const requests = journal(snapshot, entry, options, scope, signal);
        const record = replay
          ? requests.latest(ask)
          : await (async () => {
              entry.status = "waiting";
              return requests.ensure(ask);
            })();
        if (!record?.decision) throw pause;
        const decision = record.decision;
        if (decision.type === "stop") {
          if (!replay) scope.tree.stop();
          throw new Halt({ status: "cancelled" });
        }
        if (decision.type === "cancel") {
          const error: StepError = {
            reason: "cancelled",
            name: "Decision",
            message: "This question was cancelled.",
          };
          if (replay) throw new StepFailedError(entry.key, error);
          return failed(entry, error);
        }
        if (decision.type !== "answer") throw new TypeError("This question needs an answer.");
        if (!replay) await beforeEffect(entry);
        let value: T;
        try {
          value = validate(copyData(decision.answer));
        } catch (error) {
          if (!replay) {
            record.closed = "invalid";
            await requests.open(ask, { code: "invalid_answer", message: messageOf(error) });
          }
          throw pause;
        }
        if (!replay) await finish(entry, decision.answer);
        return value;
      });
    }
    function child<T>(
      key: string,
      node: Agent<T>,
      value: AgentInput,
      options?: { retry?: ChildRetry },
    ): Promise<RunOutcome<T>>;
    function child<T>(
      key: string,
      node: RemoteAgent<T>,
      value: RemoteInput,
    ): Promise<RemoteOutcome<T>>;
    function child<CI, CO>(
      key: string,
      node: Workflow<CI, CO>,
      value: CI,
      options?: { retry?: ChildRetry },
    ): Promise<WorkflowOutcome<CO>>;
    function child(
      key: string,
      node: Specialist,
      value: unknown,
      childPolicy: { retry?: ChildRetry } = {},
    ): Promise<NodeOutcome> {
      const runtime = runtimeOf(node);
      if (!specialists.includes(node))
        fail("unregistered_specialist", "Register this child in the workflow definition.");
      const retry = childPolicy.retry && { ...childPolicy.retry };
      if (
        retry &&
        (!Number.isSafeInteger(retry.maxAttempts) ||
          retry.maxAttempts < 1 ||
          retry.maxAttempts > 100 ||
          !["read-only", "reconcile"].includes(retry.replay))
      )
        throw new TypeError(
          "Child retries need bounded attempts and an explicit repeatability policy.",
        );
      if (retry && node.kind === "remote")
        throw new TypeError(
          "Remote messages cannot be replayed by child retries. Resume the saved task.",
        );
      const prepared = prepareChild(node, value, undefined, scope.tree.root);
      const normalized = prepared.input;
      return admit(
        key,
        node.kind,
        {
          targetId: node.id,
          version: node.version,
          input: normalized,
          configuration: node[AGENT_RUNTIME].configuration(),
          retry: retry
            ? { maxAttempts: retry.maxAttempts, replay: retry.replay, retryOn: !!retry.retryOn }
            : null,
        },
        async (entry) => {
          let saved = entry.children.at(-1);
          if (replay) {
            if (!saved || entry.status !== "completed") throw pause;
            return runtime.hydrate(saved.snapshot);
          }
          while (entry.status !== "completed") {
            await beforeEffect(entry);
            const resume = !!saved;
            if (!saved) {
              scope.tree.reserveChild(scope.depth + 1);
              const childKey = String(entry.children.length + 1);
              const runId = childRunId(entry.id, childKey);
              const created = await prepared.create(runId, snapshot.tree, childOptions(options));
              active();
              saved = admitChild(entry.children, { key: childKey, snapshot: created }, scope);
            }
            entry.status = "running";
            try {
              await startChild(
                saved,
                snapshot,
                entry.id,
                {
                  ...runtime,
                  async execute(childSnapshot, inherited, childScope, answers) {
                    // startChild saved admission and notified observers. Check current authority now.
                    await beforeEffect(entry);
                    return runtime.execute(childSnapshot, inherited, childScope, answers);
                  },
                },
                childOptions(options),
                scope,
                signal,
                active,
                resume,
              );
            } catch (error) {
              if (error instanceof Halt) throw error;
              active();
              fail(
                "child_host_failed",
                "The child host failed or changed its journal. Reconcile stored state before continuing.",
                entry.id,
              );
            }
            const state = saved.snapshot.state;
            if (state.status === "suspended") {
              entry.status = "waiting";
              await scope.tree.save();
              throw pause;
            }
            if (state.status === "cancelled") {
              scope.tree.stop();
              throw new Halt(state);
            }
            if ((state.status === "limited" || state.status === "failed") && !isLocalStop(state))
              throw new Halt(state);
            const result = runtime.hydrate(saved.snapshot);
            if (
              state.status === "failed" &&
              state.error.code !== "content_filtered" &&
              retry &&
              entry.children.length < retry.maxAttempts &&
              result.snapshot.kind !== "remote" &&
              (retry.retryOn?.(result) ?? true)
            ) {
              if (
                [...requestRecords(saved.snapshot)].length ||
                [...snapshots(saved.snapshot)].some(
                  (node) =>
                    node.kind === "remote" ||
                    (node.kind === "agent" && node.definition.modelSettings.hostedTools?.length),
                )
              )
                fail(
                  "step_retry_unsafe",
                  "A child with requests or hosted effects cannot restart under workflow retry policy.",
                  entry.id,
                );
              if (retry.replay === "reconcile" && !entry.reconciliations?.[saved.snapshot.runId]) {
                const verdict = await untilAbort(
                  Promise.resolve(
                    options.host?.reconcileStep?.(
                      immutableCopy(request(snapshot, entry)),
                      { attemptId: saved.snapshot.attemptId },
                      signal,
                    ),
                  ),
                  signal,
                );
                active();
                if (verdict?.outcome !== "not_run" || !isId(verdict.receipt))
                  fail(
                    "step_retry_unsafe",
                    "The host must reconcile every child effect before restarting it.",
                    entry.id,
                  );
                (entry.reconciliations ??= {})[saved.snapshot.runId] = verdict.receipt;
              }
              entry.status = "retrying";
              await scope.tree.save();
              saved = undefined;
              continue;
            }
            await finish(entry, { childRunId: saved.snapshot.runId });
          }
          if (!saved) throw new TypeError("Missing completed child.");
          return runtime.hydrate(saved.snapshot);
        },
      );
    }
    const ctx: WorkflowContext = Object.freeze({
      runId: snapshot.runId,
      context: hostContext,
      step,
      ask,
      agent: child,
      workflow: child,
      sleep(key: string, ms: number) {
        if (!Number.isSafeInteger(ms) || ms < 0 || ms > 2_147_483_647)
          throw new TypeError("Sleep needs a nonnegative whole number that fits a timer.");
        return admit(key, "sleep", { ms }, async (entry) => {
          if (entry.status === "completed") return;
          if (replay) throw pause;
          if (entry.wakeAt === undefined) {
            entry.wakeAt = Date.now() + ms;
            entry.status = "waiting";
            await scope.tree.save();
          }
          await wait(entry);
          await finish(entry, null);
        });
      },
    });
    let candidate: unknown;
    let failure: { error: unknown } | undefined;
    try {
      candidate = await untilAbort(run(input.validate(immutableCopy(snapshot.input)), ctx), signal);
    } catch (error) {
      failure = { error };
      if (error instanceof Halt) stop(error);
    } finally {
      accepting = false;
      // A rejected Promise.all or an ignored call must not orphan a sibling effect.
      await Promise.allSettled(work);
    }
    active();
    if (fatal) throw fatal;
    if (frontier && recorded.some((entry) => !visited.has(entry.key)))
      fail(
        "nondeterministic_workflow",
        "Replay reached new work without reaching every recorded step.",
      );
    if (paused) return { visited, paused: true };
    if (failure) throw failure.error;
    if (recorded.some((entry) => !visited.has(entry.key)))
      fail(
        "nondeterministic_workflow",
        "The workflow returned without reaching every recorded step.",
      );
    candidate = data(candidate);
    validateOutput(candidate);
    if (
      replay &&
      snapshot.state.status === "completed" &&
      !equalData(snapshot.state.candidate, candidate)
    )
      fail("nondeterministic_workflow", "Replay returned a different result for the same journal.");
    return { candidate, visited, paused: false };
  }

  function hydrate(node: TreeNode): WorkflowOutcome<O> {
    const snapshot = workflowNode(copyData(node));
    const state = snapshot.state;
    if (state.status === "running") throw new TypeError("The workflow has not settled.");
    const record = {
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      treeUsage: treeUsage(snapshot),
      steps: snapshot.steps.map(({ id, key, kind, status, attempts }) => ({
        id,
        key,
        kind,
        status,
        attempts,
      })),
      snapshot,
    };
    return state.status === "completed"
      ? { ...record, status: "completed", output: validateOutput(state.candidate) }
      : state.status === "suspended"
        ? { ...record, ...state, requests: openRequests(snapshot), wakeAt: wakeAt(snapshot) }
        : { ...record, ...state };
  }
  async function execute(
    node: TreeNode,
    options: RunOptions,
    scope: ExecutionScope,
    answers?: Readonly<Record<string, unknown>>,
  ): Promise<WorkflowOutcome<O>> {
    const snapshot = workflowNode(node);
    if (!["running", "suspended"].includes(snapshot.state.status)) return hydrate(snapshot);
    const signal = AbortSignal.any([
      scope.tree.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      emitEvent(options, {
        type: "execution_start",
        kind: "workflow",
        nodeId: id,
        version,
        runId: snapshot.runId,
        attemptId: snapshot.attemptId,
      });
      scope.tree.active();
      checkMemoryBinding(snapshot, options.memory);
      // Refuse unknown writes before any coordination callback or sibling effect.
      for (const step of snapshot.steps)
        if (
          step.kind === "step" &&
          step.status === "running" &&
          (!isRecord(step.definition.retry) || step.asks?.length)
        )
          fail(
            "interrupted_operation",
            "A workflow effect has no saved result. Reconcile its outcome with the host.",
            step.id,
          );
      await coordinate(snapshot, {}, scope, true);
      if (scope.depth === 0 && answers) {
        try {
          await answerRequests(snapshot, options, scope, answers, signal);
        } catch (error) {
          if (error instanceof Halt) throw error;
          fail(
            "request_failed",
            "The host could not authenticate the workflow answers. Check access before continuing.",
          );
        }
      }
      const preflight = await coordinate(snapshot, {}, scope, true);
      snapshot.state = { status: "running" };
      await scope.tree.save();
      const result = await coordinate(snapshot, options, scope, false, false, preflight.visited);
      snapshot.state = result.paused
        ? { status: "suspended" }
        : { status: "completed", candidate: result.candidate };
    } catch (error) {
      let failure = error;
      try {
        scope.tree.active();
        signal.throwIfAborted();
      } catch (stopped) {
        failure = stopped instanceof Halt ? stopped : new Halt({ status: "cancelled" });
      }
      snapshot.state =
        failure instanceof Halt
          ? failure.state
          : {
              status: "failed",
              error: {
                code: failure instanceof StepFailedError ? "step_failed" : "workflow_failed",
                message: messageOf(failure),
              },
            };
    }
    try {
      await scope.tree.save();
    } catch (error) {
      snapshot.state =
        error instanceof Halt
          ? error.state
          : { status: "failed", error: { code: "checkpoint_failed", message: messageOf(error) } };
    }
    emitEvent(options, {
      type: "state",
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      state: snapshot.state,
    });
    await options.host?.progress?.flush();
    return hydrate(snapshot);
  }
  async function create(
    value: unknown,
    runId: string,
    tree?: WorkflowSnapshot["tree"],
    options: RunOptions = {},
  ): Promise<WorkflowSnapshot> {
    const frozen = data(value);
    input.validate(immutableCopy(frozen));
    const startedAt = Date.now();
    return {
      kind: "workflow",
      format: 3,
      workflowId: id,
      version,
      runId,
      attemptId: crypto.randomUUID(),
      startedAt,
      input: frozen,
      definition: copyData(definition),
      limits: copyData(limits),
      steps: [],
      state: { status: "running" },
      tree: tree
        ? copyData(tree)
        : {
            runId,
            startedAt,
            limits: copyData(treeLimits),
            ...(options.memory ? { memory: memoryScopes(options.memory) } : {}),
          },
    };
  }
  const runtime: WorkflowRuntime<O> = {
    create,
    execute,
    hydrate,
    answerRequests,
    configuration: () => copyData({ id, version, limits, ...definition }),
    async open(value, options, runId) {
      checkWorkflowOptions(options);
      return create(value, runId, undefined, options);
    },
    restore(raw, tree) {
      const snapshot = readWorkflowSnapshot(raw);
      if (
        snapshot.workflowId !== id ||
        snapshot.version !== version ||
        !equalData(snapshot.definition, definition) ||
        !equalData(snapshot.limits, limits)
      )
        throw new TypeError(
          "The workflow definition, version or limits changed. Restore the original version.",
        );
      if (
        tree
          ? !equalData(snapshot.tree, tree)
          : snapshot.tree.runId !== snapshot.runId || !equalData(snapshot.tree.limits, treeLimits)
      )
        throw new TypeError("The workflow belongs to another tree.");
      input.validate(immutableCopy(snapshot.input));
      for (const step of snapshot.steps)
        for (const child of step.children) {
          const specialist = target(step);
          if (child.snapshot.kind !== specialist.kind || nodeId(child.snapshot) !== specialist.id)
            throw new TypeError("The saved child identity changed.");
          child.snapshot = runtimeOf(specialist).restore(child.snapshot, snapshot.tree);
          if (
            !matchesChildInput(child.snapshot, step.definition.input) ||
            !equalData(step.definition.configuration, specialist[AGENT_RUNTIME].configuration())
          )
            throw new TypeError("The workflow child input or configuration changed.");
        }
      if (snapshot.state.status === "completed") validateOutput(snapshot.state.candidate);
      return snapshot;
    },
    async replay(snapshot) {
      const tree = new ExecutionTree(snapshot, {});
      try {
        await coordinate(snapshot, {}, { tree, depth: 0, path: [] }, true, true);
      } finally {
        tree.close();
      }
    },
  };
  async function root(
    snapshot: WorkflowSnapshot,
    options: RunOptions,
    answers?: Readonly<Record<string, unknown>>,
  ) {
    const tree = new ExecutionTree(snapshot, options);
    try {
      return await execute(snapshot, options, { tree, depth: 0, path: [] }, answers);
    } finally {
      tree.close();
    }
  }
  const workflow: Workflow<I, O> = Object.freeze({
    kind: "workflow",
    id,
    version,
    [AGENT_RUNTIME]: runtime,
    async run(value: I, options: import("./workflow-types.ts").WorkflowRunOptions = {}) {
      checkWorkflowOptions(options);
      const prepared = { ...options, memory: readMemoryBinding(options.memory) };
      return root(
        await runtime.open(value, prepared, options.runId ?? crypto.randomUUID()),
        prepared,
      );
    },
    async resume(raw: unknown, options: import("./workflow-types.ts").WorkflowResumeOptions) {
      checkWorkflowOptions(options, true);
      const snapshot = runtime.restore(raw);
      const prepared = { ...options, memory: readMemoryBinding(options.memory) };
      checkMemoryBinding(snapshot, prepared.memory);
      checkPricing(snapshot, options.host);
      const answers = readAnswers(snapshot, options.answers ?? {});
      await authorizeTree(snapshot, options.host);
      snapshot.attemptId = crypto.randomUUID();
      return root(snapshot, prepared, answers);
    },
    asTool(options: import("./delegation.ts").SpecialistToolOptions<O>) {
      return specialistFailures(
        defineDelegation({
          ...options,
          inputSchema: input.schema,
          validate: input.validate,
          specialists: [workflow],
          async run(value, ctx) {
            const result = await ctx.child("result", workflow, value).join();
            if (result.status !== "completed") {
              const state = result.snapshot.state;
              if (state.status === "running" || state.status === "completed")
                throw new TypeError("Invalid workflow outcome.");
              throw new Halt(state);
            }
            return result.output;
          },
        }),
      );
    },
  });
  return workflow;
}
function checkWorkflowOptions(options: RunOptions, resume = false): void {
  checkOptions(options, resume ? "resume" : "run");
  // A workflow makes no model calls, and childOptions drops all of these for its agent steps, so
  // naming one is refused rather than ignored. Model settings and tool selection belong on the
  // agent; a session and a provider session have no place in a workflow at all.
  if (options.modelSettings || options.enabledTools)
    throw new TypeError(
      "Workflows do not take modelSettings or enabledTools. Set them on each agent with defineAgent.",
    );
  if (
    options.session ||
    options.historyLimit !== undefined ||
    options.prepareHistory ||
    options.providerSessionId !== undefined
  )
    throw new TypeError(
      "Workflows do not take session, historyLimit, prepareHistory or providerSessionId. Each agent step runs on the input the workflow passes it, with no session, and uses its own run id as its provider session.",
    );
}
export async function checkReplay<I, O>(
  workflow: Workflow<I, O>,
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  try {
    const runtime = workflow[AGENT_RUNTIME];
    await runtime.replay(runtime.restore(raw));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Halt && error.state.status === "failed"
          ? error.state.error
          : { code: "invalid_replay", message: messageOf(error) },
    };
  }
}
