import { EMPTY_USAGE, addUsage, type TokenUsage, type Tool } from "@providerkit/core";
import { requestHash } from "./request.ts";
import { copyData, isId, isNames, isRecord } from "./snapshot.ts";
import { fail } from "./tree.ts";
import type { ModelExecution, RecoveryDefinition, RecoveryPolicy } from "./types.ts";

export function isRecoveryPolicy(value: unknown): value is RecoveryPolicy {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["identity", "maxAttempts", "inferenceOnly", "readOnlyTools"].includes(key),
    ) &&
    isId(value.identity) &&
    typeof value.maxAttempts === "number" &&
    Number.isSafeInteger(value.maxAttempts) &&
    value.maxAttempts > 0 &&
    (value.inferenceOnly === undefined || typeof value.inferenceOnly === "boolean") &&
    (value.readOnlyTools === undefined || isNames(value.readOnlyTools))
  );
}

export function readRecoveryPolicy(value: unknown): RecoveryPolicy | null {
  if (value === undefined) return null;
  if (!isRecoveryPolicy(value))
    throw new TypeError(
      "Recovery needs an identity, a positive maxAttempts and explicit inference-only or read-only permissions.",
    );
  return copyData(value);
}

export function isRecoveryDefinition(value: unknown): value is RecoveryDefinition | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const { policy, provider, toolHashes } = value;
  return (
    isRecoveryPolicy(policy) &&
    isRecord(provider) &&
    isId(provider.id) &&
    isId(provider.model) &&
    typeof value.modelToolsHash === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.modelToolsHash) &&
    isRecord(toolHashes) &&
    Object.entries(toolHashes).every(
      ([name, hash]) =>
        policy.readOnlyTools?.includes(name) &&
        typeof hash === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(hash),
    ) &&
    (policy.readOnlyTools ?? []).every((name) => Object.hasOwn(toolHashes, name))
  );
}

export function recoveryToolHash(tool: Tool): Promise<string> {
  return requestHash({
    definition: tool.definition(),
    isReadOnly: tool.isReadOnly,
    needsApproval: tool.needsApproval,
    isTerminal: tool.isTerminal,
    isConcurrencySafe: tool.isConcurrencySafe,
    timeoutMs: tool.timeoutMs,
  });
}

export function requireRecovery(
  allowed: boolean,
  previous: number,
  definition: RecoveryDefinition | null,
  operationId: string,
): void {
  if (!allowed || !definition)
    fail(
      "interrupted_operation",
      "This operation started but has no saved result. Reconcile it with the host; its recovery policy does not allow replay.",
      operationId,
    );
  if (previous + 1 >= definition.policy.maxAttempts)
    fail(
      "recovery_exhausted",
      "This operation reached its recovery attempt limit. Reconcile the saved attempts with the host.",
      operationId,
    );
}

export function modelUsage(model: ModelExecution): TokenUsage {
  return model.interrupted.reduce((total, attempt) => addUsage(total, attempt.usage), model.usage);
}

export function modelsUsage(models: readonly ModelExecution[]): TokenUsage {
  return models.reduce((total, model) => addUsage(total, modelUsage(model)), { ...EMPTY_USAGE });
}
