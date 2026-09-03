// Deciding when a conversation no longer fits, and where to cut it.
//
// Everything here is pure and testable. The model call that writes the summary
// and the row that stores it belong to the caller — what is decidable without
// I/O is decided here.
import type { ChatMessage } from "./types.ts";

/**
 * What the answer needs after the prompt: an output budget, plus the tools'
 * own schemas, plus the slack no provider documents.
 *
 * Absolute rather than a percentage on purpose — a 1M window does not need a
 * 100k cushion, and a 128k window needs more than 12k.
 */
export const CONTEXT_RESERVE_TOKENS = 32_000;

/**
 * Four characters per token — the rule of thumb every provider's own
 * calculator agrees with to within a fifth, which is all the precision this
 * needs. It decides WHEN to fold: folding one turn early costs a cheap model
 * call, folding one turn late costs the whole turn.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function textOf(message: ChatMessage): string {
  if (message.role === "user" && typeof message.content !== "string") {
    // Only the words are countable; an image's cost is the provider's own
    // arithmetic and no character count approximates it.
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return typeof message.content === "string" ? message.content : "";
}

/** What one message costs to re-send: its words, its reasoning, and the
 *  arguments of any calls it made. */
export function messageTokens(message: ChatMessage): number {
  const extra =
    message.role === "assistant"
      ? (message.reasoning ?? "") +
        (message.toolCalls?.map((call) => call.name + call.arguments).join("") ?? "")
      : "";
  return estimateTokens(textOf(message) + extra);
}

export function conversationTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

/**
 * The provider's own input count says the wall is close — fold before the next
 * step rather than after the 400.
 *
 * Takes the REPORTED count, not an estimate, because it is the only figure
 * that is not a guess. Estimate only when there is no reported count yet.
 */
export function needsCompaction(inputTokens: number, contextWindow: number): boolean {
  // A window at or below the reserve puts the threshold at zero or less, and
  // every turn — including one that has not reported usage yet — then reads as
  // already full. That loops: folding a history this side of its first answer
  // changes nothing, so the next check says the same thing. Small windows are
  // not hypothetical; a caller that learns a real ceiling from a rejection
  // (rather than guessing one) can legitimately arrive here with 8k.
  if (inputTokens <= 0) return false;
  return inputTokens >= contextWindow - CONTEXT_RESERVE_TOKENS;
}

/**
 * How much of the window the history BEHIND the current turn may spend: a
 * tenth, floored so a small window still gets a usable memory. The tail stays
 * verbatim and the summary is short, so the rest is what folding buys back.
 */
export function historyBudgetTokens(contextWindow: number): number {
  return Math.max(6_000, Math.floor(contextWindow * 0.1));
}

/**
 * Where to cut so the messages AFTER the cut fit `budget`, walking backwards
 * from the newest.
 *
 * Two invariants the cut must respect, and both are correctness rather than
 * taste:
 *
 *  1. Never split a tool call from its result. Every provider rejects a tool
 *     result whose call is missing, so a cut landing between them produces a
 *     400 on the very next turn — the failure compaction was called to avoid.
 *  2. Never cut into the system prompt. It is not history.
 *
 * Returns the index the kept tail starts at, or 0 when everything already fits.
 */
export function pickCut(messages: readonly ChatMessage[], budget: number): number {
  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  // Nothing but a system prompt: there is no history to fold.
  if (firstNonSystem === -1) return messages.length;

  // The newest message is always kept, budget or not. A conversation whose
  // latest turn alone overruns the budget is not fixable by cutting history,
  // and answering a summary instead of the question the person just asked is
  // never the right failure.
  const latest = messages.length - 1;
  let cut = latest;
  let total = messageTokens(messages[latest]!);

  for (let i = latest - 1; i >= firstNonSystem; i--) {
    total += messageTokens(messages[i]!);
    if (total > budget) break;
    cut = i;
  }

  // Walk back off any tool result whose assistant turn would be left behind
  // it. Bounded by the first non-system message, so it can never run off the
  // front. This can exceed the budget by a message or two, which is the right
  // trade: an orphaned tool result is a hard 400, not an overrun.
  while (cut > firstNonSystem && messages[cut]!.role === "tool") cut--;

  return cut;
}

/**
 * Fold `messages` into `[…system, summary, …tail]`.
 *
 * The summary arrives as a user turn rather than a system one: a system
 * message added mid-conversation reads to the model as a new instruction, and
 * several providers require the system block to be first and singular anyway.
 */
export function applyCompaction(
  messages: readonly ChatMessage[],
  cut: number,
  summary: string,
): ChatMessage[] {
  const system = messages.filter((message) => message.role === "system");
  const tail = messages.slice(cut).filter((message) => message.role !== "system");
  return [
    ...system,
    { role: "user", content: `[Earlier conversation, summarized]\n\n${summary}` },
    ...tail,
  ];
}

/**
 * The context window for a model, when nothing volunteered one.
 *
 * The ladder exists because the endpoints disagree about whether to tell you:
 * OpenRouter, LM Studio and Ollama publish `context_length`; Anthropic and
 * OpenAI do not. A reported number always wins; this is the floor under it.
 *
 * A conservative default is the right failure: too small folds one turn early
 * and costs a cheap call, too large hits a hard 400 mid-run.
 */
export function guessContextWindow(model: string): number {
  const id = model.toLowerCase();
  if (/gemini|gpt-4\.1|grok-4|llama-4/.test(id)) return 1_000_000;
  if (/claude|gpt-5|o[34]|deepseek|kimi|glm|qwen/.test(id)) return 200_000;
  if (/gpt-4o|mistral|command-r/.test(id)) return 128_000;
  return 128_000;
}
