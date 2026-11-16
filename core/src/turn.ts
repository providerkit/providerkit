// One turn, drained. Every agent loop reads a stream the same way: text and
// reasoning joined, tool-call fragments put back together by index, usage and
// finish taken from the last chunk that states them. The apps that use this
// package each wrote that by hand, a little differently each time, and the
// one in `drainStream` dropped the tool calls altogether.
//
// It assembles and nothing else. Arguments stay the raw string the seam
// promises, because tool-args.ts heals them and tools.ts validates them. And a
// turn that said nothing is not judged here: that is `requireContent`'s call
// (invariant 13), made where the retry that can fix it still can.
import { ProviderError } from "./errors.ts";
import type { Citation, HostedCall, HostedItems, HostedToolType } from "./hosted/types.ts";
import {
  EMPTY_USAGE,
  type ChatMessage,
  type FinishReason,
  type ProviderChunk,
  type ReasoningItems,
  type TokenUsage,
  type ToolCall,
} from "./types.ts";

/** A hosted call while it assembles: its type may not be stated yet. */
type AssemblingCall = Omit<HostedCall, "type"> & { type?: HostedToolType };

/** One drained turn: the message a loop appends, whose `toolCalls` are the
 *  calls it runs, and what the turn cost. */
export interface Turn {
  /** Ready to append to history as it is. `toolCalls` holds the calls to run,
   *  in the order the provider indexed them, and is absent when there are none. */
  message: Extract<ChatMessage, { role: "assistant" }>;
  /** The last usage the stream reported, or zeros when it reported none. */
  usage: TokenUsage;
  /** As the provider stated it, and null when it stated none. */
  finishReason: FinishReason | null;
  /** The endpoint and model that answered, when a fallback provider says. */
  source?: { provider: string; model: string };
}

/**
 * Drain one turn into the assistant message it produced, plus its usage,
 * finish reason and source.
 *
 * ```ts
 * const turn = await collectTurn(provider.createStream(history, tools));
 * history.push(turn.message);
 * for (const call of turn.message.toolCalls ?? []) history.push(await run(call));
 * ```
 *
 * Hosted calls (a vendor's search, fetch or code run) land in `hostedCalls`,
 * never in `toolCalls`: there is nothing for the loop to run.
 *
 * @throws {ProviderError} `overload` when a tool call ends the stream with no
 * name, or a hosted call with no type. Whatever the stream itself throws
 * passes through unchanged.
 */
export async function collectTurn(stream: AsyncIterable<ProviderChunk>): Promise<Turn> {
  let content = "";
  let reasoning = "";
  // Not concatenated: this half of the record is a payload the provider owns,
  // and it arrives whole on one delta rather than in fragments. Dropped here,
  // a drained turn replays only half its own reasoning on the next round,
  // which is the failure `reasoningDetails` exists to prevent.
  let reasoningDetails: unknown[] | undefined;
  let reasoningItems: ReasoningItems | undefined;
  const calls = new Map<number, ToolCall>();
  const hosted = new Map<number, AssemblingCall>();
  const citations: Citation[] = [];
  let hostedItems: HostedItems | undefined;
  // Cumulative on some providers and final-only on others: the LAST one wins.
  let usage: TokenUsage = EMPTY_USAGE;
  let finishReason: FinishReason | null = null;
  let source: Turn["source"];

  // Read to the end, past the finish chunk: the OpenAI shape sends its usage
  // after it, and a loop that stopped at the finish would bill every turn at zero.
  for await (const chunk of stream) {
    if (chunk.source) source = chunk.source;
    if (chunk.content) content += chunk.content;
    if (chunk.reasoning) reasoning += chunk.reasoning;
    if (chunk.reasoningDetails?.length) reasoningDetails = chunk.reasoningDetails;
    if (chunk.reasoningItems?.items.length) reasoningItems = chunk.reasoningItems;
    for (const delta of chunk.toolCalls ?? []) {
      const call = calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
      // Identity is the last value STATED, so an empty one never erases a real
      // one: Anthropic opens a call with `""` for what it lacks, and the
      // ChatGPT backend states the real call_id and name only on the call's
      // closing event. A call that never states an id keeps `""`. The four
      // adapters here mint one before their finish (`settleToolCalls`); for any
      // other Provider, one made up here would be ours and not the wire's
      // (invariant 10), and `repairHistory` already names it the same way on
      // every send. Arguments are fragments, joined in arrival order.
      if (delta.id) call.id = delta.id;
      if (delta.name) call.name = delta.name;
      if (delta.thoughtSignature) call.thoughtSignature = delta.thoughtSignature;
      call.arguments += delta.arguments ?? "";
      calls.set(delta.index, call);
    }
    for (const delta of chunk.hosted ?? []) {
      // The same rule as a tool call's identity: the last value stated wins,
      // so a skeleton's blanks never erase what the closing event says. A
      // call's place in the answer is where the text was when it first
      // appeared, unless the adapter said otherwise (Gemini's grounding record
      // arrives after the answer and covers it from 0).
      const call = hosted.get(delta.index) ?? { id: "", status: "running", at: content.length };
      if (delta.id) call.id = delta.id;
      if (delta.type) call.type = delta.type;
      if (delta.status) call.status = delta.status;
      if (delta.input) call.input = { ...call.input, ...delta.input };
      if (delta.codeDelta) {
        call.input = { ...call.input, code: (call.input?.code ?? "") + delta.codeDelta };
      }
      if (delta.output) call.output = delta.output;
      if (delta.error) call.error = delta.error;
      if (delta.at !== undefined) call.at = delta.at;
      hosted.set(delta.index, call);
    }
    if (chunk.citations?.length) citations.push(...chunk.citations);
    if (chunk.hostedItems) hostedItems = chunk.hostedItems;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.finishReason) finishReason = chunk.finishReason;
  }

  // By index, not by arrival: parallel calls interleave their fragments.
  const indexed = [...calls].sort(([a], [b]) => a - b);
  const nameless = indexed.find(([, call]) => !call.name);
  if (nameless) {
    const [index, call] = nameless;
    // `overload`, the kind for a provider's own anomaly inside a 200 (an empty
    // body, a turn that completed with nothing): our request was fine, the
    // vendor's frame was not. A retry may well get a whole call, and another
    // model is a fair next try if this one keeps doing it. `invalid` would
    // blame our request and stop the run over a fault that is not ours. The
    // four adapters here fail such a call themselves, with the same kind
    // (`settleToolCalls`); this gives any other Provider the same answer.
    const provider = source?.provider ?? "turn";
    const which = call.id || `at index ${index}`;
    throw new ProviderError(
      provider,
      "overload",
      `${provider}: tool call ${which} ended with no name, so there is no tool to run`,
    );
  }
  const toolCalls = indexed.map(([, call]) => call);
  const hostedCalls = [...hosted]
    .sort(([a], [b]) => a - b)
    .map(([index, { type, ...call }]): HostedCall => {
      // A record that never says what ran can't be shown or counted: the
      // vendor's frame was broken, as with a nameless tool call above.
      if (type) return { ...call, type };
      const provider = source?.provider ?? "turn";
      throw new ProviderError(
        provider,
        "overload",
        `${provider}: hosted call ${call.id || `at index ${index}`} never said which tool ran`,
      );
    });

  return {
    message: {
      role: "assistant",
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningDetails ? { reasoningDetails } : {}),
      ...(reasoningItems ? { reasoningItems } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(hostedCalls.length > 0 ? { hostedCalls } : {}),
      ...(citations.length > 0 ? { citations } : {}),
      ...(hostedItems ? { hostedItems } : {}),
    },
    usage,
    finishReason,
    ...(source ? { source } : {}),
  };
}

export interface Completion {
  text: string;
  /** Present when the stream identifies the endpoint that answered. */
  provider?: string;
  reasoning: string;
  /** Present only where the provider sent one. See ChatMessage.reasoningDetails. */
  reasoningDetails?: unknown[];
  /** Present only where the provider sent them. See ChatMessage.reasoningItems. */
  reasoningItems?: ReasoningItems;
  /** The calls the model asked for, in index order, and empty when it asked
   *  for none. Before this field a drained turn that called a tool read as a
   *  turn that said nothing. */
  toolCalls: ToolCall[];
  /** Present only when the vendor ran its own tools. See ChatMessage.hostedCalls. */
  hostedCalls?: HostedCall[];
  /** Present only when the answer cites sources. See ChatMessage.citations. */
  citations?: Citation[];
  usage: TokenUsage;
  finishReason: FinishReason | null;
  model: string;
}

/** Drain a stream into a Completion: `collectTurn`, flattened for a caller
 *  that wants the answer rather than a message to append. `model` names the
 *  model unless a fallback provider stamped the one that answered. */
export async function drainStream(
  stream: AsyncIterable<ProviderChunk>,
  model: string,
): Promise<Completion> {
  const { message, usage, finishReason, source } = await collectTurn(stream);
  return {
    text: message.content,
    reasoning: message.reasoning ?? "",
    ...(message.reasoningDetails ? { reasoningDetails: message.reasoningDetails } : {}),
    ...(message.reasoningItems ? { reasoningItems: message.reasoningItems } : {}),
    toolCalls: message.toolCalls ?? [],
    ...(message.hostedCalls ? { hostedCalls: message.hostedCalls } : {}),
    ...(message.citations ? { citations: message.citations } : {}),
    usage,
    finishReason,
    model: source?.model ?? model,
    ...(source ? { provider: source.provider } : {}),
  };
}
