// The seam — provider-neutral messages, tools and chunks. Every adapter
// (OpenAI-compatible, Anthropic, Responses, Gemini) translates to and from
// exactly these shapes, so a caller never sees a vendor's dialect.
//
// Deliberately NOT OpenAI's parameter types. Using one vendor's wire shape as
// the lingua franca forces the other adapters to round-trip through a dialect
// that isn't theirs, and every quirk of that dialect then leaks into callers
// who never asked for it.

/**
 * How hard the model thinks before answering. Absent = the provider's own
 * default (never sent). Passed through verbatim on OpenAI-shape
 * (`reasoning_effort`); mapped to thinking budgets on Anthropic-shape.
 * Support varies per model — an unsupported level comes back as a clean 400.
 *
 * Ordered least → most; the type derives from the array so the runtime guard
 * and the union can never drift apart.
 */
export const EFFORTS = ["none", "low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The one place the effort union meets raw input (pickers, CLI flags). */
export function isEffort(value: string): value is Effort {
  return EFFORTS.some((effort) => effort === value);
}

export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface TextPart {
  type: "text";
  text: string;
}

/** An image the model looks at (vision) — bytes as base64, never a URL the
 *  provider would have to fetch on our behalf. */
export interface ImagePart {
  type: "image";
  mimeType: ImageMimeType;
  data: string;
}

export type ContentPart = TextPart | ImagePart;

/**
 * A tool the model asked to run. `arguments` is the RAW JSON string, not a
 * parsed object: it arrives in fragments and can be truncated mid-stream, so
 * assembly and validation are the consumer's job (see tools/define).
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  /** Gemini's opaque reasoning token. It must ride back on the next turn
   *  verbatim or the model loses its own chain of thought. */
  thoughtSignature?: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      content: string;
      /**
       * The model's chain-of-thought. Thinking-mode providers require it
       * replayed on a turn that made a tool call (DeepSeek 400s without it).
       * OpenAI-shape serializes it as `reasoning_content`; Anthropic-shape
       * drops it, since its thinking blocks carry signatures we never capture.
       *
       * A turn that DISABLES thinking must not carry it — mixing the two is
       * unsupported. `stripReasoning` below is that rule, once.
       */
      reasoning?: string;
      /**
       * OpenRouter's normalized reasoning payload, arriving on the stream and
       * riding back UNMODIFIED on the next turn's assistant message.
       *
       * Opaque on purpose — the same contract as Gemini's `thoughtSignature`,
       * and for the same reason: it is the provider's own record of how it got
       * here, and reading, reshaping or dropping it costs the model its
       * continuity across a tool round. Absent on every other dialect.
       */
      reasoningDetails?: unknown[];
      toolCalls?: ToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
      /** Images a tool hands back (a screenshot, a rendered chart). */
      images?: ImagePart[];
    };

/** JSON Schema for an object — what every provider's tool contract wants. */
export interface JsonObjectSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

/** Incremental tool-call fragment, assembled by `index` by the consumer. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
  thoughtSignature?: string;
}

export interface TokenUsage {
  inputTokens: number;
  /** Cache-HIT subset of `inputTokens` — providers auto-cache repeated
   *  prefixes and bill the hit portion far cheaper, so it must be tracked
   *  separately to cost a turn correctly. 0 when the provider reports none. */
  cachedInputTokens: number;
  /** Tokens WRITTEN to cache. Anthropic bills these above the input rate;
   *  the OpenAI-shape auto-cachers bill them at it. 0 when not reported. */
  cacheWriteTokens?: number;
  outputTokens: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
};

/** Normalized streaming chunk — every provider's shape collapses into this. */
export interface ProviderChunk {
  type: "delta" | "usage" | "finish";
  content?: string;
  reasoning?: string;
  /** OpenRouter's normalized reasoning payload — hand it back on the next
   *  turn's assistant message verbatim. See ChatMessage.reasoningDetails. */
  reasoningDetails?: unknown[];
  toolCalls?: ToolCallDelta[];
  usage?: TokenUsage;
  finishReason?: FinishReason;
}

/** Pin or deny tool use. `{ name }` forces one specific tool — how a run is
 *  made to commit an answer at its step budget's edge. */
export type ToolChoice = "auto" | "none" | "required" | { name: string };

/**
 * Ask for a JSON object matching `schema`. Providers that enforce schemas get
 * it verbatim; the rest get JSON mode plus the schema in the prompt. Either
 * way the CALLER validates — a provider's "guaranteed" JSON is not one.
 */
export interface JsonOutput {
  name: string;
  schema: JsonObjectSchema;
  /**
   * Force OpenAI's strict schema mode on or off. Left unset, the adapters ask
   * `isStrictSchema` and enforce whenever the schema actually qualifies —
   * which is what keeps an optional field from turning a working call into a
   * 400. Set it only to overrule that reading.
   */
  strict?: boolean;
}

export interface StreamOptions {
  /** Override the provider's bound model for this call. */
  model?: string;
  effort?: Effort;
  /** Output ceiling. On most providers thinking and answer SHARE it, so a
   *  task emitting a large artifact must raise it or the tool-call JSON is
   *  silently truncated mid-argument. */
  maxTokens?: number;
  temperature?: number;
  /**
   * Nucleus sampling. Set this OR `temperature`, not both — the vendors all
   * document them as alternatives and some reject the pair outright.
   */
  topP?: number;
  /**
   * Strings that end the turn when generated. The only four-shape sampling
   * field beyond these two; `top_k`, `metadata` and the rest are one vendor's
   * each and stay off the seam, where a caller reaching for them is asking for
   * that vendor rather than for a provider.
   *
   * Not sent on the Responses shape, which has no equivalent.
   */
  stopSequences?: string[];
  signal?: AbortSignal;
  toolChoice?: ToolChoice;
  json?: JsonOutput;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  createStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: StreamOptions,
  ): AsyncIterable<ProviderChunk>;
}

export interface Completion {
  text: string;
  reasoning: string;
  /** Present only where the provider sent one. See ChatMessage.reasoningDetails. */
  reasoningDetails?: unknown[];
  usage: TokenUsage;
  finishReason: FinishReason | null;
  model: string;
}

/** Drain a no-tools stream into a Completion. Usage chunks are cumulative on
 *  some providers and final-only on others: the LAST one wins. */
export async function drainStream(
  stream: AsyncIterable<ProviderChunk>,
  model: string,
): Promise<Completion> {
  let text = "";
  let reasoning = "";
  // Not concatenated: this half of the record is a payload the provider owns,
  // and it arrives whole on one delta rather than in fragments. Dropped here,
  // a drained turn replays only half its own reasoning on the next round —
  // which is the failure `reasoningDetails` exists to prevent.
  let reasoningDetails: unknown[] | undefined;
  let usage: TokenUsage = EMPTY_USAGE;
  let finishReason: FinishReason | null = null;
  for await (const chunk of stream) {
    if (chunk.type === "delta") {
      if (chunk.content) text += chunk.content;
      if (chunk.reasoning) reasoning += chunk.reasoning;
      if (chunk.reasoningDetails?.length) reasoningDetails = chunk.reasoningDetails;
    } else if (chunk.type === "usage" && chunk.usage) {
      usage = chunk.usage;
    } else if (chunk.type === "finish" && chunk.finishReason) {
      finishReason = chunk.finishReason;
    }
  }
  return {
    text,
    reasoning,
    ...(reasoningDetails ? { reasoningDetails } : {}),
    usage,
    finishReason,
    model,
  };
}

/**
 * Prepare a history for a thinking-DISABLED turn: strip `reasoning` from every
 * assistant message.
 *
 * The chain-of-thought belongs only to thinking turns. A provider that
 * requires it replayed while thinking is ON (DeepSeek) rejects it when
 * thinking is OFF — which is exactly the shape of a forced-submit salvage
 * turn, where a run reasons through its whole investigation and then drops
 * thinking to serialize what it already found.
 *
 * Returns a shallow-cleaned copy; the caller's array is left untouched.
 */
export function stripReasoning(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    if (message.reasoning === undefined && message.reasoningDetails === undefined) return message;
    // Both halves go. `reasoningDetails` is the same chain of thought in the
    // provider's own words, so leaving it behind carries into a thinking-off
    // turn exactly what stripping `reasoning` was meant to keep out.
    const { reasoning: _text, reasoningDetails: _payload, ...rest } = message;
    return rest;
  });
}

/** `data:` URI for an image part — what the OpenAI dialect wants inline. */
export function toDataUri(part: ImagePart): string {
  return `data:${part.mimeType};base64,${part.data}`;
}
