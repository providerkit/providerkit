// Budget check adapted from PydanticAI (MIT), tool_manager.py, _check_max_retries.
// Copyright (c) Pydantic Services Inc. 2024 to present.
// Changed: default zero retries, exact operation attempts, no model-directed replay permission.
import type { Tool } from "@providerkit/core";
import { recoveryToolHash } from "./recovery.ts";
import { copyData, isId, isRecord } from "./snapshot.ts";
import { fail } from "./tree.ts";
import type { ToolExecution, ToolRetryDefinition, ToolRetryPolicy } from "./types.ts";

export function isToolRetryPolicy(value: unknown): value is ToolRetryPolicy {
  return (
    isRecord(value) &&
    isId(value.identity) &&
    isRecord(value.tools) &&
    Object.entries(value.tools).every(
      ([name, policy]) =>
        isId(name) &&
        isRecord(policy) &&
        typeof policy.maxAttempts === "number" &&
        Number.isSafeInteger(policy.maxAttempts) &&
        policy.maxAttempts > 0 &&
        ["read-only", "reconcile"].includes(String(policy.replay)),
    )
  );
}

export function readToolRetryPolicy(value: unknown): ToolRetryPolicy | null {
  if (value === undefined) return null;
  if (!isToolRetryPolicy(value))
    throw new TypeError(
      "toolRetries needs an identity and named tool budgets with maxAttempts and replay.",
    );
  return copyData(value);
}

export function isToolRetryDefinition(value: unknown): value is ToolRetryDefinition | null {
  return (
    value === null ||
    (isRecord(value) &&
      isToolRetryPolicy(value.policy) &&
      isRecord(value.toolHashes) &&
      Object.keys(value.toolHashes).length === Object.keys(value.policy.tools).length &&
      Object.keys(value.policy.tools).every(
        (name) =>
          isRecord(value.toolHashes) &&
          typeof value.toolHashes[name] === "string" &&
          /^sha256:[a-f0-9]{64}$/.test(value.toolHashes[name]),
      ))
  );
}

export function retryBudget(definition: ToolRetryDefinition | null, name: string) {
  return definition && Object.hasOwn(definition.policy.tools, name)
    ? definition.policy.tools[name]
    : undefined;
}

export function toolAttempts(tool: ToolExecution): number {
  if (skipped(tool)) return 0;
  return (
    tool.retries.length +
    tool.interrupted.length +
    (tool.status !== "pending" || tool.asks?.length ? 1 : 0)
  );
}

type Journaled = Pick<ToolExecution, "status" | "asks" | "retries" | "interrupted">;

/** Nothing has happened to this call yet: no attempt, no request, no result. */
export function fresh(tool: Journaled | undefined): boolean {
  return (
    tool?.status === "pending" &&
    !tool.asks?.length &&
    !tool.retries.length &&
    !tool.interrupted.length
  );
}

/** The call has not started, though a request for it may be open. */
export function unstarted(tool: Journaled | undefined): boolean {
  return tool?.status === "pending" && !tool.retries.length && !tool.interrupted.length;
}

/** `host.screenCall` refused this call, or it was cancelled with the rest of its turn, before
 * anything else happened to it. It did nothing, so it spends no tool call. Every other cancel
 * a run writes answers a request, so it carries one. */
export function skipped(tool: ToolExecution): boolean {
  return (
    tool.status === "completed" &&
    !tool.result.ok &&
    (tool.result.kind === "refused" || tool.result.kind === "cancelled") &&
    !tool.asks?.length &&
    !tool.retries.length &&
    !tool.interrupted.length &&
    !tool.calls?.length
  );
}

export async function checkRetryTool(
  tool: Tool | undefined,
  definition: ToolRetryDefinition,
  execution: ToolExecution,
): Promise<void> {
  const policy = tool && retryBudget(definition, tool.name);
  if (
    !tool ||
    !policy ||
    tool.isTerminal ||
    tool.needsApproval ||
    execution.asks?.length ||
    (policy.replay === "read-only" && !tool.isReadOnly) ||
    (await recoveryToolHash(tool)) !== definition.toolHashes[tool.name]
  )
    fail(
      "tool_retry_unsafe",
      "This tool cannot be retried under its saved policy. Reconcile the failed call with the host.",
      execution.id,
    );
}
