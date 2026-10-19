// Deciding when a conversation no longer fits, where to cut it, and how to
// make a saved one valid to send again.
//
// Everything here is pure and testable. The model call that writes the summary
// and the row that stores it belong to the caller — what is decidable without
// I/O is decided here.
import type { ChatMessage, ToolCall } from "./types.ts";

/**
 * What the answer needs after the prompt: an output budget, plus the tools'
 * own schemas, plus the slack no provider documents.
 *
 * Absolute rather than a percentage on purpose: a 1M window does not need a
 * 100k cushion, and a 128k window needs more than 12k.
 */
export const CONTEXT_RESERVE_TOKENS = 32_000;

/**
 * Four characters per token is the rule of thumb every provider's own
 * calculator agrees with to within a fifth, which is all the precision this
 * needs. It decides WHEN to fold: folding one turn early costs a cheap model
 * call, folding one turn late costs the whole turn.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function textOf(message: ChatMessage): string {
  if (message.role === "user" && typeof message.content !== "string") {
    // Only the words are countable; an image's or a file's cost is the
    // provider's own arithmetic and no character count approximates it.
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
  return estimateTokens(textOf(message) + extra) + reasoningItemTokens(message);
}

/**
 * Encrypted reasoning is base64 of the real thing, so its length says little:
 * three bytes per four characters, less ~650 bytes of envelope, then four bytes
 * a token (cc-proxy's estimate).
 */
function reasoningItemTokens(message: ChatMessage): number {
  if (message.role !== "assistant" || !message.reasoningItems) return 0;
  let tokens = 0;
  for (const item of message.reasoningItems.items) {
    const blob = (item as { encrypted_content?: unknown } | null)?.encrypted_content;
    if (typeof blob === "string") tokens += Math.max(0, ((blob.length * 3) / 4 - 650) / 4);
  }
  return Math.ceil(tokens);
}

export function conversationTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

/**
 * The provider's own input count says the limit is close. Fold before the next
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
 *     400 on the very next turn, the failure compaction was called to avoid.
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

type ToolResult = Extract<ChatMessage, { role: "tool" }>;

/** What a call with no result answers, by whether running it again is safe.
 *  The model reads this and decides whether to call again, so the two must
 *  differ on exactly that. */
const INTERRUPTED_READ_ONLY =
  "This call was interrupted before it returned. It changed nothing, so it is safe to call again.";
const INTERRUPTED =
  "This call was interrupted before it returned. It may have partly run, so check its effect before calling it again.";

/** `id`, or `id_2`, `id_3`… whichever is free first. Only ids already handed
 *  out are consulted, so an id never depends on what comes after it. */
function freshId(id: string, used: Set<string>): string {
  let fresh = id;
  for (let k = 2; used.has(fresh); k++) fresh = `${id}_${k}`;
  used.add(fresh);
  return fresh;
}

interface Span {
  calls: ToolCall[];
  vendorIds: string[];
  results: (ToolResult | undefined)[];
  rest: ChatMessage[];
}

/** The first call in the span asked under `id` that has no result yet, or -1.
 *  First unanswered rather than first: two calls in one reply can share an id,
 *  and their results then pair in order. */
function openSlot(span: Span, id: string): number {
  return span.vendorIds.findIndex((asked, i) => asked === id && !span.results[i]);
}

/** A result with no call to answer, kept as words the model can still read
 *  instead of a `tool` message every provider answers with a 400. */
function orphanNote(result: ToolResult): ChatMessage {
  const text = `[Tool result for ${result.toolCallId}; the tool call is missing or already has a result]\n${result.content}`;
  return {
    role: "user",
    content: result.images?.length ? [{ type: "text", text }, ...result.images] : text,
  };
}

/**
 * Make a saved, resumed or interrupted history valid to send: every call has
 * exactly one result, right after it, under an id no other call uses.
 *
 * A span runs from an assistant message with tool calls to the next assistant
 * message. Its results move to just after the calls, in call order, and the
 * rest of the span (a steer the user typed while the tools ran) keeps its
 * order after them. Then:
 *
 * - A call with no result in its span gets one under the same id, saying it was
 *   interrupted. `isReadOnly` picks the wording; without it every tool may
 *   have partly run. These calls come back as `interrupted`, under the ids
 *   the request carries.
 * - A result whose call is not in its span becomes a user note, images kept.
 *   Paired against the span only, because chat and Messages both require the
 *   result in the turn right after its call: a looser pairing still 400s.
 * - A repeated id becomes `{id}_{k}`, the smallest free k, call and result
 *   together. Kimi and Gemini restart their ids every reply
 *   (`functions.search:0`, `call_0`), and Anthropic and Responses reject the
 *   second use.
 * - An empty id becomes `call_{message}_{call}`, never `normalizeToolId`'s
 *   random fallback.
 * - An assistant message with no calls and only whitespace is dropped, as if
 *   it were never there, so a placeholder saved before the tools ran orphans
 *   nothing.
 *
 * No side effects, and the same input always gives the same bytes: a span's
 * output and every id depend only on what came before, so repairing a longer
 * history keeps the shorter one's bytes and the prompt cache keeps hitting.
 * Repairing a repaired history changes nothing. Every adapter here runs this
 * on what it sends; call it yourself to know what `interrupted` holds.
 */
export function repairHistory(
  messages: readonly ChatMessage[],
  opts: { isReadOnly?: (toolName: string) => boolean } = {},
): { messages: ChatMessage[]; interrupted: ToolCall[] } {
  const out: ChatMessage[] = [];
  const interrupted: ToolCall[] = [];
  const used = new Set<string>();
  // The open span: its calls as sent, the id the vendor gave each, the result
  // each has found so far, and everything else in arrival order.
  let span: Span | undefined;

  const close = () => {
    if (!span) return;
    for (const [i, call] of span.calls.entries()) {
      const result = span.results[i];
      if (result) {
        out.push(result);
        continue;
      }
      interrupted.push(call);
      const content = opts.isReadOnly?.(call.name) ? INTERRUPTED_READ_ONLY : INTERRUPTED;
      out.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    }
    out.push(...span.rest);
    span = undefined;
  };

  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      const calls = message.toolCalls ?? [];
      if (calls.length === 0 && !message.content.trim()) continue;
      close();
      if (calls.length === 0) {
        out.push(message);
        continue;
      }
      const sent = calls.map((call, c) => {
        const id = freshId(call.id.trim() ? call.id : `call_${index}_${c}`, used);
        return id === call.id ? call : { ...call, id };
      });
      const renamed = sent.some((call, c) => call !== calls[c]);
      out.push(renamed ? { ...message, toolCalls: sent } : message);
      span = { calls: sent, vendorIds: calls.map((call) => call.id), results: [], rest: [] };
    } else if (message.role === "tool") {
      const slot = span ? openSlot(span, message.toolCallId) : -1;
      if (span && slot !== -1) {
        const id = span.calls[slot]!.id;
        span.results[slot] = id === message.toolCallId ? message : { ...message, toolCallId: id };
      } else {
        (span?.rest ?? out).push(orphanNote(message));
      }
    } else {
      (span?.rest ?? out).push(message);
    }
  }
  close();
  return { messages: out, interrupted };
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
