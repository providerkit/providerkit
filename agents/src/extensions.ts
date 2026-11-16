// Guard verdicts and the blocking input boundary are adapted from OpenAI Agents JS (MIT),
// guardrail.ts and runner/toolExecution.ts. Lifecycle boundaries follow Vercel AI SDK
// (Apache-2.0), agent/tool-loop-agent-settings.ts. See THIRD_PARTY_NOTICES.md.
import type { ImagePart, ProviderChunk, ToolOutcome, Turn } from "@providerkit/core";
import { readContent } from "./input.ts";
import { requestHash } from "./request.ts";
import { copyData, immutableCopy, isId, isRecord } from "./snapshot.ts";
import { fail, untilAbort } from "./tree.ts";
import type {
  GuardDefinition,
  GuardInputs,
  Guardrail,
  Guardrails,
  GuardRecord,
  GuardStage,
  LifecycleContext,
  LifecycleEvent,
  LifecycleHook,
  RunSnapshot,
  ToolResult,
} from "./types.ts";

export const GUARD_STAGES: readonly GuardStage[] = [
  "modelInput",
  "modelOutput",
  "toolInput",
  "toolOutput",
];
export const GUARDED_CHUNK_LIMIT = 4_096;

export function guardDefinition(guards: Guardrails | undefined): GuardDefinition | null {
  if (guards === undefined) return null;
  if (
    !isRecord(guards) ||
    !isId(guards.identity) ||
    Object.keys(guards).some(
      (key) => !["identity", "maxOutputBytes", ...GUARD_STAGES].includes(key),
    ) ||
    GUARD_STAGES.some((stage) => guards[stage] !== undefined && typeof guards[stage] !== "function")
  )
    throw new TypeError("Guardrails need an identity and named check functions.");
  const stages = GUARD_STAGES.filter((stage) => guards[stage] !== undefined);
  const maxOutputBytes = guards.maxOutputBytes ?? 1_000_000;
  if (!stages.length || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)
    throw new TypeError("Guardrails need a check and a positive whole maxOutputBytes limit.");
  return { identity: guards.identity, stages, maxOutputBytes };
}

/** Ordered observation only. Cancellation stops waiting, not arbitrary host code. */
export async function observeLifecycle(
  hooks: readonly (LifecycleHook | undefined)[],
  event: LifecycleEvent,
  context: LifecycleContext,
): Promise<void> {
  for (const hook of hooks) {
    if (context.signal.aborted) return;
    if (!hook) continue;
    try {
      await untilAbort(Promise.resolve(hook(immutableCopy(event), context)), context.signal);
    } catch {
      // Like onEvent, an observer's return value or failure is never a policy decision.
    }
  }
}

export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Publish only what the guard inspected. Replaying buffered raw chunks could disclose an
 * earlier metadata value that collectTurn replaced before the guard saw the completed turn. */
export function guardedChunk(turn: Turn): ProviderChunk {
  const message = turn.message;
  return {
    type: "delta",
    content: message.content,
    reasoning: message.reasoning,
    reasoningDetails: message.reasoningDetails,
    reasoningItems: message.reasoningItems,
    toolCalls: message.toolCalls?.map((call, index) => ({ ...call, index })),
    hosted: message.hostedCalls?.map((call, index) => ({ ...call, index })),
    citations: message.citations,
    hostedItems: message.hostedItems,
    source: turn.source,
    usage: turn.usage,
    ...(turn.finishReason ? { finishReason: turn.finishReason } : {}),
  };
}

export function refuseGuardedReplay(
  snapshot: RunSnapshot,
  operationId: string,
  attemptId?: string,
): void {
  if (
    snapshot.guards.some(
      (record) =>
        record.operationId === operationId &&
        (attemptId === undefined || record.attemptId === attemptId) &&
        (record.stage === "modelOutput" || record.stage === "toolOutput"),
    )
  )
    fail(
      "guarded_output_unsettled",
      "The call returned but its checked result was not saved. Reconcile the saved run; do not repeat the effect.",
      operationId,
    );
}

export function requireGuardVerdicts(snapshot: RunSnapshot): void {
  const blocked = snapshot.guards.find((record) => record.status !== "allowed");
  if (blocked) guardFailure(blocked);
}

function guardFailure(record: GuardRecord): never {
  fail(
    record.status === "running" ? "interrupted_guard" : `guard_${record.status}`,
    record.status === "rejected"
      ? "A guard rejected this operation. Review the request and policy before starting new work."
      : "A guard did not finish successfully. Reconcile the saved run and check the guard before starting new work.",
    record.operationId,
  );
}

/** One fixed policy per agent version, not a middleware stack or an authorization override. */
export class GuardChecks {
  constructor(
    private readonly snapshot: RunSnapshot,
    private readonly guards: Guardrails | undefined,
    private readonly context: LifecycleContext,
    private readonly save: () => Promise<void>,
    private readonly active: () => void,
  ) {}

  async check<K extends GuardStage>(
    stage: K,
    operationId: string,
    attemptId: string,
    value: GuardInputs[K],
  ): Promise<void> {
    const checks: { [P in GuardStage]?: Guardrail<P> } = this.guards ?? {};
    const check = checks[stage];
    if (!check) return;
    this.active();
    const inputHash = await requestHash(value);
    this.active();
    const previous = this.snapshot.guards.find(
      (record) =>
        record.stage === stage &&
        record.operationId === operationId &&
        record.attemptId === attemptId &&
        record.inputHash === inputHash,
    );
    if (previous) {
      if (previous.status !== "allowed") guardFailure(previous);
      return;
    }
    const record: GuardRecord = { stage, operationId, attemptId, inputHash, status: "running" };
    this.snapshot.guards.push(record);
    await this.save();
    this.active();
    try {
      const verdict = await untilAbort(
        Promise.resolve(check(immutableCopy(value), this.context)),
        this.context.signal,
      );
      this.active();
      if (!isRecord(verdict) || typeof verdict.allow !== "boolean")
        throw new TypeError("A guard must return { allow: true } or { allow: false }.");
      record.status = verdict.allow ? "allowed" : "rejected";
    } catch {
      // Exceptions can quote the rejected data or credentials. Save only the failed verdict.
      record.status = "failed";
    }
    await this.save();
    this.active();
    if (record.status !== "allowed") guardFailure(record);
  }

  async overflow(
    stage: "modelOutput" | "toolOutput",
    operationId: string,
    attemptId = this.snapshot.attemptId,
  ): Promise<never> {
    this.snapshot.guards.push({
      stage,
      operationId,
      attemptId,
      inputHash: await requestHash(null),
      status: "failed",
    });
    await this.save();
    this.active();
    fail(
      "guard_output_limit",
      "The output exceeded the guard buffer limit. Review the output size and guard limit before starting new work.",
      operationId,
    );
  }
}

/** Adapted from TanStack AI (MIT), utilities/tool-result.ts: recognize a nonempty content
 * array, otherwise keep the tool's normal summary. Reuse core's outcome and image parts;
 * there is no new tool kernel or output wrapper for authors to implement. */
export function toolResultOf(outcome: ToolOutcome<unknown>): ToolResult {
  if (!outcome.ok) return { ok: false, kind: outcome.kind, content: outcome.error };
  return successfulToolResult(outcome);
}

export function successfulToolResult(outcome: { output: unknown; summary: string }): ToolResult {
  const value = outcome.output;
  if (typeof outcome.summary !== "string") throw new TypeError("A tool summary must be text.");
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (part) => isRecord(part) && ["text", "image", "file", "media"].includes(String(part.type)),
    )
  ) {
    const parts = readContent(value, "A tool result");
    if (typeof parts === "string") throw new TypeError("Expected content parts.");
    const images: ImagePart[] = [];
    const text: string[] = [];
    for (const part of parts) {
      if (part.type === "image") images.push(part);
      else if (part.type === "text") text.push(part.text);
      else
        throw new TypeError(
          "Tool results support text and inline images, not file or media parts.",
        );
    }
    return { ok: true, content: text.join("\n"), ...(images.length ? { images } : {}) };
  }
  // Core permits typed outputs (such as Date) when a tool supplies a text summary. Preserve
  // that path; only JSON values can also be kept as structured journal data.
  let output: unknown;
  try {
    output = copyData(value);
  } catch {
    output = undefined;
  }
  return {
    ok: true,
    content: outcome.summary,
    ...(output !== undefined ? { output } : {}),
  };
}
