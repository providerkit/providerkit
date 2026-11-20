// Adapted from TanStack AI (MIT), packages/ai-compaction/src/index.ts: a saved model-only
// view plus an untouched transcript. Copyright (c) 2025 Tanner Linsley.
// Changed: core owns cutting/pairing; a running summary is never silently called twice.
import {
  applyCompaction,
  conversationTokens,
  historyBudgetTokens,
  needsCompaction,
  pickCut,
  type ChatMessage,
} from "@providerkit/core";
import { conversationOf } from "./input.ts";
import { copyData, isId, isRecord, nearEndBefore, nudgeAfter } from "./snapshot.ts";
import type {
  AgentMessage,
  CompactionDefinition,
  CompactionExecution,
  CompactionPolicy,
  ModelExecution,
  RunSnapshot,
} from "./types.ts";

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function isCompactionDefinition(value: unknown): value is CompactionDefinition | null {
  return (
    value === null ||
    (isRecord(value) &&
      isId(value.identity) &&
      positive(value.contextWindow) &&
      positive(value.keepTokens) &&
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
  const definition = {
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
): AgentMessage[] {
  const last = snapshot.compactions.at(-1);
  return last?.status === "completed"
    ? compactMessages(messages, last.cut, last.summary)
    : messages;
}

function cutFor(
  snapshot: RunSnapshot,
  beforeModel: number,
  view: readonly AgentMessage[],
  previousCut = 0,
): number {
  const policy = snapshot.definition.compaction;
  if (!policy) return 0;
  const cut = pickCut(wire(view).messages, policy.keepTokens) + (previousCut ? previousCut - 1 : 0);
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
): { cut: number; sourceCount: number; removed: AgentMessage[] } | undefined {
  const policy = snapshot.definition.compaction;
  if (!policy) return;
  const last = snapshot.compactions.at(-1);
  // Once per boundary, including a crash after the summary was saved but before model admission.
  if (last?.beforeModel === snapshot.models.length) return;
  const full = conversationOf(snapshot, snapshot.models.length, true);
  const view = modelConversation(snapshot, full);
  const core = wire(view).messages;
  const previous = snapshot.models.at(-1);
  const measured = previous?.status === "completed" && previous.billing === "reported";
  // The last call counted its input, not its newly added answer, tools or steers.
  const priorCount = previous
    ? conversationOf(snapshot, snapshot.models.length - 1, true).length
    : 0;
  const count = measured
    ? previous.usage.inputTokens + conversationTokens(wire(full.slice(priorCount)).messages)
    : conversationTokens([{ role: "system", content: snapshot.definition.instructions }, ...core]);
  if (!needsCompaction(count, policy.contextWindow)) return;
  const cut = cutFor(snapshot, snapshot.models.length, view, last?.cut);
  const localCut = cut - (last ? last.cut - 1 : 0);
  if (localCut <= 0 || cut <= (last?.cut ?? 0)) return;
  return { cut, sourceCount: full.length, removed: view.slice(0, localCut) };
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
  for (const [index, entry] of snapshot.compactions.entries()) {
    const policy = snapshot.definition.compaction;
    // Each cut was planned for the request at its boundary, so it is checked against that one.
    const source = conversationOf(snapshot, entry.beforeModel, true);
    const full = source.slice(0, entry.sourceCount);
    const minimumSource =
      source.length -
      snapshot.inputs.filter((input) => input.beforeModel === entry.beforeModel).length;
    const view = previous ? compactMessages(full, previous.cut, previous.summary) : full;
    const cut = cutFor(snapshot, entry.beforeModel, view, previous?.cut);
    if (
      !policy ||
      entry.id !== compactionId(snapshot.runId, index) ||
      entry.beforeModel > snapshot.models.length ||
      entry.beforeModel <= (previous?.beforeModel ?? -1) ||
      full.length !== entry.sourceCount ||
      entry.sourceCount < minimumSource ||
      entry.cut !== cut ||
      entry.cut <= (previous?.cut ?? 0) ||
      entry.cut >= full.length ||
      (entry.status === "running" &&
        (index !== snapshot.compactions.length - 1 ||
          entry.beforeModel !== snapshot.models.length ||
          snapshot.state.status === "completed")) ||
      (entry.model && !policy.summarize) ||
      (entry.status === "completed" && !!entry.model !== !!policy.summarize)
    )
      throw new TypeError("Invalid compaction position or definition.");
    if (
      entry.model &&
      (entry.model.id !== entry.id ||
        entry.model.interrupted.length !== 0 ||
        entry.model.status !== entry.status ||
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
