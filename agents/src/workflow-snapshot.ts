import { isAsk } from "./request.ts";
import {
  copyData,
  equalData,
  isId,
  isRecord,
  isAskRecord,
  isState,
  isTreeInfo,
  isTreeNode,
  childRunId,
  checkChildProgress,
} from "./snapshot.ts";
import type {
  WorkflowLimits,
  WorkflowSnapshot,
  StepExecution,
  StepAttempt,
  StepError,
} from "./workflow-types.ts";

export function readWorkflowLimits(value: Partial<WorkflowLimits> = {}): WorkflowLimits {
  const limits = { steps: 100, parallelSteps: 4, inlineWaitMs: 0, resultBytes: 262_144, ...value };
  if (!isWorkflowLimits(limits))
    throw new TypeError("Workflow limits must be bounded whole numbers; inlineWaitMs may be zero.");
  return limits;
}
function integer(value: unknown, min = 1): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= 2_147_483_647
  );
}
function isWorkflowLimits(raw: unknown): raw is WorkflowLimits {
  return (
    isRecord(raw) &&
    integer(raw.steps) &&
    raw.steps <= 10_000 &&
    integer(raw.parallelSteps) &&
    raw.parallelSteps <= 1_024 &&
    integer(raw.inlineWaitMs, 0) &&
    integer(raw.resultBytes)
  );
}
export function stepId(runId: string, key: string): string {
  return `${runId}/step/${encodeURIComponent(key)}`;
}
export function stepData<T>(value: T, bytes: number): T {
  copyData(value);
  // JSON round-trip makes first execution and database replay return the same representation.
  const text = JSON.stringify(value);
  if (text === undefined || new TextEncoder().encode(text).byteLength > bytes)
    throw new TypeError("Workflow input and results must be JSON within limits.resultBytes.");
  return JSON.parse(text);
}
function isError(value: unknown): value is StepError {
  return (
    isRecord(value) &&
    ["failed", "timeout", "denied", "cancelled"].includes(String(value.reason)) &&
    typeof value.name === "string" &&
    typeof value.message === "string"
  );
}
function isAttempt(value: unknown): value is StepAttempt {
  return (
    isRecord(value) &&
    isId(value.attemptId) &&
    ["running", "completed", "failed", "interrupted", "not_run"].includes(String(value.status)) &&
    (value.error === undefined || isError(value.error)) &&
    (value.reconciliation === undefined || isId(value.reconciliation))
  );
}
function isStep(raw: unknown): raw is StepExecution {
  return (
    isRecord(raw) &&
    isId(raw.id) &&
    isId(raw.key) &&
    raw.key.length <= 256 &&
    ["step", "agent", "remote", "workflow", "ask", "sleep"].includes(String(raw.kind)) &&
    ["pending", "running", "waiting", "retrying", "completed", "failed"].includes(
      String(raw.status),
    ) &&
    isRecord(raw.definition) &&
    Array.isArray(raw.attempts) &&
    raw.attempts.every(isAttempt) &&
    (raw.error === undefined || isError(raw.error)) &&
    (raw.wakeAt === undefined ||
      (typeof raw.wakeAt === "number" && Number.isSafeInteger(raw.wakeAt) && raw.wakeAt > 0)) &&
    Array.isArray(raw.children) &&
    raw.children.every(
      (child) =>
        isRecord(child) &&
        isId(child.key) &&
        (child.reference === undefined || isId(child.reference)) &&
        isTreeNode(child.snapshot),
    ) &&
    (raw.reconciliations === undefined ||
      (isRecord(raw.reconciliations) && Object.values(raw.reconciliations).every(isId))) &&
    (raw.asks === undefined || (Array.isArray(raw.asks) && raw.asks.every(isAskRecord)))
  );
}
export function isWorkflowSnapshot(raw: unknown): raw is WorkflowSnapshot {
  return (
    isRecord(raw) &&
    raw.kind === "workflow" &&
    raw.format === 3 &&
    [raw.workflowId, raw.version, raw.runId, raw.attemptId].every(isId) &&
    typeof raw.startedAt === "number" &&
    Number.isSafeInteger(raw.startedAt) &&
    raw.startedAt > 0 &&
    isRecord(raw.definition) &&
    isWorkflowLimits(raw.limits) &&
    Array.isArray(raw.steps) &&
    raw.steps.every(isStep) &&
    isTreeInfo(raw.tree) &&
    isState(raw.state)
  );
}
export function checkWorkflowSnapshot(node: WorkflowSnapshot): void {
  stepData(node.input, node.limits.resultBytes);
  if (
    node.steps.length > node.limits.steps ||
    new Set(node.steps.map((step) => step.key)).size !== node.steps.length
  )
    throw new TypeError("Duplicate workflow keys or exceeded step limit.");
  for (const step of node.steps) {
    if (step.id !== stepId(node.runId, step.key))
      throw new TypeError("Invalid workflow step identity.");
    stepData(step.definition, node.limits.resultBytes);
    const retryPolicy = step.definition.retry;
    if (
      retryPolicy !== undefined &&
      retryPolicy !== null &&
      (!isRecord(retryPolicy) ||
        !integer(retryPolicy.maxAttempts) ||
        retryPolicy.maxAttempts > 100 ||
        !["read-only", "reconcile"].includes(String(retryPolicy.replay)))
    )
      throw new TypeError("Invalid workflow retry policy.");
    if (
      step.kind === "step" &&
      (!integer(step.definition.timeoutMs) ||
        typeof step.definition.needsApproval !== "boolean" ||
        (step.definition.needsApproval && retryPolicy))
    )
      throw new TypeError("Invalid host step policy.");
    if (
      step.kind === "ask" &&
      (!isAsk(step.definition.question) ||
        step.definition.question.type !== "question" ||
        step.definition.question.key !== step.key)
    )
      throw new TypeError("Invalid workflow question.");
    if (
      step.kind === "sleep" &&
      (!integer(step.definition.ms, 0) || (step.status === "completed" && step.result !== null))
    )
      throw new TypeError("Invalid saved sleep.");
    if (step.status === "completed") stepData(step.result, node.limits.resultBytes);
    if (step.status === "failed" && !step.error)
      throw new TypeError("A failed step needs its saved error.");
    if (new Set(step.attempts.map((attempt) => attempt.attemptId)).size !== step.attempts.length)
      throw new TypeError("Duplicate workflow attempt.");
    if (step.kind === "step") {
      if (
        step.children.length ||
        step.attempts.some(
          (attempt, index) => attempt.status === "running" && index !== step.attempts.length - 1,
        )
      )
        throw new TypeError("Invalid effect attempt history.");
      const retry = step.definition.retry;
      const max = isRecord(retry) && integer(retry.maxAttempts) ? retry.maxAttempts : 1;
      const effects = step.attempts.filter((attempt) => attempt.status !== "not_run");
      if (
        step.attempts.length > 100 ||
        effects.length > max ||
        (effects.length > 1 &&
          (!isRecord(retry) ||
            !["read-only", "reconcile"].includes(String(retry.replay)) ||
            step.asks?.length))
      )
        throw new TypeError("Effect attempts exceed their repeatability policy.");
      if (
        isRecord(retry) &&
        retry.replay === "reconcile" &&
        effects.slice(0, -1).some((attempt) => !isId(attempt.reconciliation))
      )
        throw new TypeError("A write was retried without reconciliation.");
      if (step.status === "running" && step.attempts.at(-1)?.status !== "running")
        throw new TypeError("A running effect needs an attempt marker.");
      if (step.status === "completed" && step.attempts.at(-1)?.status !== "completed")
        throw new TypeError("A completed effect needs a receipt.");
    } else if (step.attempts.length) throw new TypeError("Only host effects have effect attempts.");
    if (
      step.kind !== "agent" &&
      step.kind !== "workflow" &&
      step.kind !== "remote" &&
      step.children.length
    )
      throw new TypeError("This step cannot own a child.");
    if (step.kind === "agent" || step.kind === "workflow" || step.kind === "remote") {
      const retry = step.definition.retry;
      if (step.kind === "remote" && retry)
        throw new TypeError("Remote children cannot be retried.");
      const max = isRecord(retry) && integer(retry.maxAttempts) ? retry.maxAttempts : 1;
      if (
        step.children.length > max ||
        step.children.some(
          (child, index) =>
            child.key !== String(index + 1) ||
            child.snapshot.kind !== step.kind ||
            (index < step.children.length - 1 && child.snapshot.state.status !== "failed"),
        )
      )
        throw new TypeError("Invalid workflow child attempts.");
      if (
        step.children.length > 1 &&
        (!isRecord(retry) || !["read-only", "reconcile"].includes(String(retry.replay)))
      )
        throw new TypeError("A child retry needs repeatability policy.");
      if (
        isRecord(retry) &&
        retry.replay === "reconcile" &&
        step.children
          .slice(0, -1)
          .some((child) => !isId(step.reconciliations?.[child.snapshot.runId]))
      )
        throw new TypeError("A child retry is missing reconciliation.");
      if (
        step.status === "completed" &&
        (!step.children.length ||
          !equalData(step.result, { childRunId: step.children.at(-1)?.snapshot.runId }))
      )
        throw new TypeError("A completed child step needs its exact child receipt.");
    }
    if (
      step.kind === "sleep" &&
      step.status !== "pending" &&
      step.status !== "completed" &&
      step.wakeAt === undefined
    )
      throw new TypeError("A sleeping step needs a wake time.");
    const openKeys = new Set<string>();
    for (const [index, record] of (step.asks ?? []).entries()) {
      const request = record.request;
      if (!record.closed) {
        if (openKeys.has(request.ask.type))
          throw new TypeError("A workflow step has duplicate open requests.");
        openKeys.add(request.ask.type);
      }
      if (
        (step.kind === "ask" && !equalData(request.ask, step.definition.question)) ||
        (step.kind !== "ask" &&
          (step.kind !== "step" ||
            request.ask.type !== "approval" ||
            step.definition.needsApproval !== true))
      )
        throw new TypeError("The request kind does not match its workflow step.");
      if (
        !request.step ||
        request.call ||
        request.id !== `${step.id}/ask/${index + 1}` ||
        request.step.operationId !== step.id ||
        request.step.runId !== node.runId ||
        request.step.workflowId !== node.workflowId ||
        request.step.version !== node.version ||
        request.step.key !== step.key ||
        request.step.kind !== step.kind ||
        !equalData(request.step.input, step.definition.input) ||
        request.createdAt < node.startedAt ||
        request.ask.type === "client"
      )
        throw new TypeError("The request does not belong to this workflow step.");
      if (
        (step.status === "completed" || step.status === "failed") &&
        !record.closed &&
        !record.decision
      )
        throw new TypeError("A settled step cannot have an unanswered request.");
    }
    if (
      step.kind === "ask" &&
      step.status === "completed" &&
      !step.asks?.some(
        (record) =>
          !record.closed &&
          record.decision?.type === "answer" &&
          equalData(record.decision.answer, step.result),
      )
    )
      throw new TypeError("The completed question differs from its saved answer.");
    for (const child of step.children) {
      if (
        child.snapshot.runId !== childRunId(step.id, child.key) ||
        child.snapshot.startedAt < node.startedAt
      )
        throw new TypeError("Invalid workflow child identity.");
      if (
        step.status === "completed" &&
        ["running", "suspended"].includes(child.snapshot.state.status)
      )
        throw new TypeError("A settled step cannot own unfinished work.");
    }
  }
  if (
    node.state.status === "completed" &&
    node.steps.some((step) => step.status !== "completed" && step.status !== "failed")
  )
    throw new TypeError("A completed workflow has unfinished steps.");
  if (
    node.state.status === "suspended" &&
    !node.steps.some((step) => step.status === "waiting" || step.status === "retrying")
  )
    throw new TypeError("A suspended workflow needs a waiting step.");
}
export function checkWorkflowProgress(previous: WorkflowSnapshot, next: WorkflowSnapshot): void {
  if (previous.steps.length > next.steps.length)
    throw new TypeError("The host dropped workflow steps.");
  for (const [index, step] of previous.steps.entries()) {
    const saved = next.steps[index];
    if (
      !saved ||
      step.id !== saved.id ||
      step.kind !== saved.kind ||
      step.key !== saved.key ||
      !equalData(step.definition, saved.definition) ||
      ((step.status === "completed" || step.status === "failed") && !equalData(step, saved))
    )
      throw new TypeError("The host changed a recorded workflow step.");
    for (const [runId, receipt] of Object.entries(step.reconciliations ?? {}))
      if (saved.reconciliations?.[runId] !== receipt)
        throw new TypeError("The host dropped child reconciliation evidence.");
    if (step.wakeAt !== undefined && step.kind === "sleep" && step.wakeAt !== saved.wakeAt)
      throw new TypeError("The host changed a wake time.");
    for (const [i, attempt] of step.attempts.entries()) {
      const after = saved.attempts[i];
      if (
        !after ||
        attempt.attemptId !== after.attemptId ||
        (attempt.reconciliation !== undefined && attempt.reconciliation !== after.reconciliation) ||
        (attempt.status !== "running" &&
          !equalData({ ...attempt, reconciliation: after.reconciliation }, after))
      )
        throw new TypeError("The host erased or replaced a step attempt.");
    }
    for (const [i, ask] of (step.asks ?? []).entries()) {
      const after = saved.asks?.[i];
      if (
        !after ||
        !equalData(ask.request, after.request) ||
        (ask.decision && !equalData(ask.decision, after.decision)) ||
        (ask.closed && ask.closed !== after.closed)
      )
        throw new TypeError("The host changed a workflow request.");
    }
    for (const [i, child] of step.children.entries()) {
      const after = saved.children[i];
      if (!after || child.key !== after.key)
        throw new TypeError("The host dropped a workflow child.");
      checkChildProgress(child.snapshot, after.snapshot);
    }
  }
}
