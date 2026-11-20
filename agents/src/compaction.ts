// Adapted from TanStack AI (MIT), packages/ai-compaction/src/index.ts: a saved model-only
// view plus an untouched transcript. Copyright (c) 2025 Tanner Linsley.
// Changed: core owns cutting/pairing; a running summary is never silently called twice.
import {
  applyCompaction,
  EMPTY_USAGE,
  conversationTokens,
  historyBudgetTokens,
  needsCompaction,
  pickCut,
  type ChatMessage,
} from "@providerkit/core";
import { conversationOf } from "./input.ts";
import { pruneToolText } from "./model-view.ts";
import { copyData, equalData, isId, isRecord, nearEndBefore, nudgeAfter } from "./snapshot.ts";
import type {
  AgentMessage,
  CompactionDefinition,
  CompactionExecution,
  CompactionPolicy,
  ModelExecution,
  RunSnapshot,
} from "./types.ts";

export const TRIM_NOTE = "Earlier messages were omitted. No summary was generated.";

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function isCompactionDefinition(value: unknown): value is CompactionDefinition | null {
  return (
    value === null ||
    (isRecord(value) &&
      isId(value.identity) &&
      positive(value.contextWindow) &&
      positive(value.keepTokens) &&
      (value.retryOnContextLimit === undefined || value.retryOnContextLimit === true) &&
      (value.summarize === null ||
        (isRecord(value.summarize) &&
          isRecord(value.summarize.provider) &&
          isId(value.summarize.provider.id) &&
          isId(value.summarize.provider.model) &&
          isId(value.summarize.instructions) &&
          positive(value.summarize.maxTokens))))
  );
}

export function compactionDefinition(policy?: CompactionPolicy): CompactionDefinition | null {
  if (policy === undefined) return null;
  const summary = policy.summarize;
  if (policy.retryOnContextLimit !== undefined && typeof policy.retryOnContextLimit !== "boolean")
    throw new TypeError("Set compaction.retryOnContextLimit to true or false.");
  const definition: CompactionDefinition = {
    ...(policy.retryOnContextLimit && { retryOnContextLimit: true }),
    identity: policy.identity,
    contextWindow: policy.contextWindow,
    keepTokens: policy.keepTokens ?? historyBudgetTokens(policy.contextWindow),
    summarize: summary
      ? {
          provider: { id: summary.provider?.id, model: summary.provider?.model },
          instructions: summary.instructions,
          maxTokens: summary.maxTokens,
        }
      : null,
  };
  if (
    !isCompactionDefinition(definition) ||
    (summary && typeof summary.provider?.createStream !== "function")
  )
    throw new TypeError(
      "Compaction needs an identity, a context window and positive token limits. A summarizer needs a provider, instructions and maxTokens.",
    );
  return copyData(definition);
}

/** Only core's text estimator reads these stand-ins. Media references are not loaded or
 * counted as text; the original user message returns unchanged after core chooses the cut. */
function wire(messages: readonly AgentMessage[]) {
  const users = new Map<ChatMessage, AgentMessage>();
  const messagesForCore = messages.map((message): ChatMessage => {
    if (message.role !== "user") return message;
    const stand: ChatMessage = {
      role: "user",
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.filter((part) => part.type !== "media"),
    };
    users.set(stand, message);
    return stand;
  });
  return { messages: messagesForCore, users };
}

export function compactMessages(
  messages: readonly AgentMessage[],
  cut: number,
  summary: string,
): AgentMessage[] {
  const core = wire(messages);
  return applyCompaction(core.messages, cut, summary).map((message) => {
    if (message.role === "system") throw new TypeError("Compaction cannot replace instructions.");
    return core.users.get(message) ?? message;
  });
}

/** The next request's view: compaction measures, cuts and checks this one. */
export function modelConversation(
  snapshot: RunSnapshot,
  messages = conversationOf(snapshot, snapshot.models.length, true),
  previous: CompactionExecution | null = snapshot.compactions.at(-1) ?? null,
): AgentMessage[] {
  const pinned = snapshot.definition.compaction?.retryOnContextLimit;
  const view = pinned || snapshot.definition.toolHistory ? pruneToolText(messages) : messages;
  if (previous?.status !== "completed") return view;
  const compacted = compactMessages(view, previous.cut, previous.summary);
  if (pinned && previous.cut > snapshot.history.length) {
    // Re-attach the run's original user turn right after the summary so the task is never lost.
    compacted.splice(1, 0, view[snapshot.history.length]!);
  }
  return compacted;
}

/** Offset from a compacted view back to the original journal. A cut past the task puts
 * both the summary and the original task before its tail. */
function cutOffset(snapshot: RunSnapshot, cut: number): number {
  if (!cut) return 0;
  return (
    cut -
    (snapshot.definition.compaction?.retryOnContextLimit && cut > snapshot.history.length ? 2 : 1)
  );
}

function cutFor(
  snapshot: RunSnapshot,
  beforeModel: number,
  view: readonly AgentMessage[],
  previousCut = 0,
  rejected = false,
): number {
  const policy = snapshot.definition.compaction;
  if (!policy) return 0;
  const messages = wire(view).messages;
  const offset = cutOffset(snapshot, previousCut);
  let cut = pickCut(messages, policy.keepTokens) + offset;
  // A length rejection overrides the advertised window. If that budget keeps everything,
  // ask core for just its newest intact round rather than retry the same request.
  const onlyTask =
    policy.retryOnContextLimit &&
    snapshot.history.length === previousCut &&
    cut === previousCut + 1;
  if (rejected && (cut <= previousCut || onlyTask)) cut = pickCut(messages, 0) + offset;
  // A not-yet-delivered steer must reach the model verbatim, and so must the nudge before it and
  // the finish policy's near-end note after it. These are user boundaries between whole rounds,
  // so capping core's cut here cannot split a call from its result.
  const full = conversationOf(snapshot, beforeModel, true);
  const nudged = nudgeAfter(snapshot, beforeModel - 1) ? 1 : 0;
  const noted = nearEndBefore(snapshot, beforeModel) ? 1 : 0;
  const unread =
    beforeModel === 0
      ? snapshot.history.length
      : full.length -
        nudged -
        noted -
        snapshot.inputs.filter((input) => input.beforeModel === beforeModel).length;
  return Math.min(cut, unread);
}

export function compactionPlan(
  snapshot: RunSnapshot,
  beforeModel = snapshot.models.length,
  rejected = false,
): { cut: number; sourceCount: number; removed: AgentMessage[] } | undefined {
  const policy = snapshot.definition.compaction;
  if (!policy) return;
  const last = snapshot.compactions.at(-1);
  // Once per boundary, including a crash after the summary was saved but before model admission.
  if (last?.beforeModel === beforeModel) return;
  const full = conversationOf(snapshot, beforeModel, true);
  const view = modelConversation(snapshot, full);
  if (!rejected) {
    const core = wire(view).messages;
    const previous = snapshot.models[beforeModel - 1];
    let count = conversationTokens([
      { role: "system", content: snapshot.definition.instructions },
      ...core,
    ]);
    if (previous?.status === "completed" && previous.billing === "reported") {
      const prior = conversationOf(snapshot, beforeModel - 1, true);
      // The provider measured the previous request, which already saw `last`. Price only the
      // change in the view, not all the newly arrived tool text: a pruning cut may have made room.
      const delta = policy.retryOnContextLimit
        ? conversationTokens(core) -
          conversationTokens(wire(modelConversation(snapshot, prior, last ?? null)).messages)
        : conversationTokens(wire(full.slice(prior.length)).messages);
      count = previous.usage.inputTokens + delta;
    }
    if (!needsCompaction(count, policy.contextWindow)) return;
  }
  const previousCut = last?.cut ?? 0;
  const cut = cutFor(snapshot, beforeModel, view, previousCut, rejected);
  if (cut <= previousCut) return;
  const offset = cutOffset(snapshot, previousCut);
  const removed = view.slice(0, cut - offset);
  if (policy.retryOnContextLimit && cut > snapshot.history.length) {
    if (previousCut === snapshot.history.length && cut === previousCut + 1) return;
    const pinnedIndex =
      previousCut > snapshot.history.length ? 1 : snapshot.history.length - offset;
    removed.splice(pinnedIndex, 1);
  }
  return { cut, sourceCount: full.length, removed };
}

export function compactionId(runId: string, index: number): string {
  return `${runId}/compaction/${index + 1}`;
}

/** Summary calls participate in the same model admissions, usage and receipts. */
export function allModels(snapshot: RunSnapshot): ModelExecution[] {
  return [
    ...snapshot.models,
    ...snapshot.compactions.flatMap((entry) => (entry.model ? [entry.model] : [])),
  ];
}

export function checkCompactions(snapshot: RunSnapshot): void {
  let previous: Extract<CompactionExecution, { status: "completed" }> | undefined;
  let recovered = false;
  for (const [index, entry] of snapshot.compactions.entries()) {
    const policy = snapshot.definition.compaction;
    // Each cut was planned for the request at its boundary, so it is checked against that one.
    const source = conversationOf(snapshot, entry.beforeModel, true);
    const full = source.slice(0, entry.sourceCount);
    const minimumSource =
      source.length -
      snapshot.inputs.filter((input) => input.beforeModel === entry.beforeModel).length;
    const view = modelConversation(snapshot, full, previous ?? null);
    const cut = cutFor(snapshot, entry.beforeModel, view, previous?.cut, !!entry.rejectedAttemptId);
    const turn = snapshot.models[entry.beforeModel];
    const pendingRetry = turn?.status === "running" && turn.attemptId === entry.rejectedAttemptId;
    if (entry.rejectedAttemptId) {
      const refused = pendingRetry
        ? turn
        : turn?.interrupted.find((attempt) => attempt.attemptId === entry.rejectedAttemptId);
      if (
        recovered ||
        !policy?.retryOnContextLimit ||
        snapshot.definition.modelSettings.hostedTools?.length ||
        !refused ||
        refused.costUsd !== undefined ||
        !equalData(refused.usage, EMPTY_USAGE) ||
        (entry.status === "running" && !pendingRetry)
      )
        throw new TypeError(
          "A context retry needs its own refused attempt with no streamed usage or hosted tools.",
        );
      recovered = true;
    }
    const fallback = entry.status === "completed" && entry.interruptedSummary === true;
    if (
      fallback &&
      (!policy?.retryOnContextLimit ||
        !policy.summarize ||
        entry.summary !== TRIM_NOTE ||
        entry.model?.status === "completed")
    )
      throw new TypeError("An interrupted summary can only use the saved trim note.");
    if (
      !policy ||
      entry.id !== compactionId(snapshot.runId, index) ||
      entry.beforeModel > snapshot.models.length ||
      entry.beforeModel <= (previous?.beforeModel ?? -1) ||
      full.length !== entry.sourceCount ||
      entry.sourceCount < minimumSource ||
      entry.cut !== cut ||
      entry.cut <= (previous?.cut ?? 0) ||
      (policy.retryOnContextLimit &&
        previous?.cut === snapshot.history.length &&
        entry.cut === previous.cut + 1) ||
      entry.cut >= full.length ||
      (entry.status === "running" &&
        (index !== snapshot.compactions.length - 1 ||
          entry.beforeModel !== snapshot.models.length - (pendingRetry ? 1 : 0) ||
          snapshot.state.status === "completed")) ||
      (entry.model && !policy.summarize) ||
      (entry.status === "completed" && !fallback && !!entry.model !== !!policy.summarize)
    )
      throw new TypeError("Invalid compaction position or definition.");
    if (
      entry.model &&
      (entry.model.id !== entry.id ||
        entry.model.interrupted.length !== 0 ||
        entry.model.status !== (fallback ? "running" : entry.status) ||
        (entry.model.status === "completed" &&
          (entry.model.tools.length !== 0 ||
            entry.model.turn.message.toolCalls?.length ||
            entry.model.turn.finishReason !== "stop" ||
            !entry.model.turn.message.content.trim() ||
            entry.model.turn.message.hostedCalls?.length ||
            entry.model.turn.message.hostedItems ||
            entry.status !== "completed" ||
            entry.summary !== entry.model.turn.message.content)))
    )
      throw new TypeError("Invalid summary receipt. Summaries cannot replay or dispatch tools.");
    if (entry.status === "completed") previous = entry;
  }
}
