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
 * (`reasoning_effort`). On Anthropic-shape, mapped to adaptive thinking and
 * `output_config.effort` for current Claude models, where `none` is the lowest
 * effort on a model that cannot stop thinking; and to thinking budgets for
 * Claude 4.5 and older and for every other vendor on that wire.
 * Support varies per model. An unsupported level comes back as a clean 400.
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

/** An image the model looks at (vision), with bytes as base64, never a URL the
 *  provider would have to fetch on our behalf. */
export interface ImagePart {
  type: "image";
  mimeType: ImageMimeType;
  data: string;
}

/** A file's media type: anything but an image's, because an image is an
 *  `ImagePart`, which every adapter can send. */
export type FileMimeType =
  `application/${string}` | `audio/${string}` | `video/${string}` | `text/${string}`;

/**
 * A file the model reads (a PDF, a recording, a video) as base64 bytes,
 * never a URL. Only the Gemini adapter sends one, as `inlineData`, the way it
 * sends an image. Every other adapter refuses it with an `invalid`
 * ProviderError before any request goes out, rather than drop it: a dropped
 * attachment is a model answering about a file it never saw.
 *
 * Gemini takes inline data up to 100 MB per request, 50 MB for a PDF (Gemini
 * API "File input methods", read 2026-09-27). The request carries the base64
 * text, which is a third larger than the file. Past that limit the documented
 * route is Gemini's File API, which this package does not wrap. Nothing here
 * enforces the limit; Gemini answers an oversized request itself.
 */
export interface FilePart {
  type: "file";
  mimeType: FileMimeType;
  data: string;
}

export type ContentPart = TextPart | ImagePart | FilePart;

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
       * A turn that disables thinking must not carry it. Mixing the two is
       * unsupported. `stripReasoning` below is that rule, once.
       */
      reasoning?: string;
      /**
       * OpenRouter's normalized reasoning payload, arriving on the stream and
       * riding back UNMODIFIED on the next turn's assistant message.
       *
       * Opaque on purpose, with the same contract as Gemini's `thoughtSignature`,
       * and for the same reason: it is the provider's own record of how it got
       * here, and reading, reshaping or dropping it costs the model its
       * continuity across a tool round. Absent on every other dialect.
       */
      reasoningDetails?: unknown[];
      /**
       * The ChatGPT backend's own reasoning items, encrypted, riding back
       * UNMODIFIED on the next turn so the model keeps its chain of thought.
       * Tagged with the provider that made them: only that provider replays
       * them, because another vendor (after a fallback) would reject them.
       * Opaque, like `reasoningDetails`.
       */
      reasoningItems?: ReasoningItems;
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

/** Provider-owned reasoning items and the id of the provider that made them. */
export interface ReasoningItems {
  provider: string;
  items: unknown[];
}

/** JSON Schema for an object, as every provider's tool contract requires. */
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
  /** Cache-hit subset of `inputTokens`. Providers auto-cache repeated
   *  prefixes and bill the hit portion far cheaper, so it must be tracked
   *  separately to cost a turn correctly. 0 when the provider reports none. */
  cachedInputTokens: number;
  /** Tokens written to cache, also a subset of `inputTokens`, so the total
   *  stays the whole prompt the window has to hold. Anthropic bills these
   *  above the input rate; the OpenAI-shape auto-cachers bill them at it.
   *  0 when not reported. */
  cacheWriteTokens?: number;
  outputTokens: number;
  /**
   * The part of `outputTokens` spent thinking, when the provider reports it.
   * Already inside `outputTokens`, so never add it again. It is the number
   * that explains a turn that came back empty with a length finish: the
   * reasoning ate the budget. Anthropic does not report it; absent there.
   */
  reasoningTokens?: number;
  /**
   * What the provider says this call cost, in USD: its bill, not our
   * arithmetic. Only OpenRouter sends one today. It is the one number a rate
   * cannot give, because OpenRouter serves one model id from many hosts at
   * different prices, and only the response knows which host answered.
   * Absent when the provider sent none, or sent one we could not trust.
   * `costUsd` and `UsageTracker` bill it over any rate.
   */
  reportedCostUsd?: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
};

/** Normalized streaming chunk. Every provider's shape maps to this. */
export interface ProviderChunk {
  type: "delta" | "usage" | "finish";
  /** The selected endpoint and model when a fallback provider emits this chunk.
   *  Per-call metadata, never shared mutable state on the provider object. */
  source?: { provider: string; model: string };
  content?: string;
  reasoning?: string;
  /** OpenRouter's normalized reasoning payload. Hand it back on the next
   *  turn's assistant message verbatim. See ChatMessage.reasoningDetails. */
  reasoningDetails?: unknown[];
  /** Once per turn, where a provider replays its reasoning. See ChatMessage.reasoningItems. */
  reasoningItems?: ReasoningItems;
  toolCalls?: ToolCallDelta[];
  usage?: TokenUsage;
  finishReason?: FinishReason;
}

/** Pin or deny tool use. `{ name }` forces one specific tool, so a run is
 *  made to commit an answer at its step budget's edge. */
export type ToolChoice = "auto" | "none" | "required" | { name: string };

/**
 * Ask for a JSON object matching `schema`. Providers that enforce schemas get
 * it verbatim; the rest get JSON mode plus the schema in the prompt. Either
 * way the caller validates: a provider's "guaranteed" JSON is not one.
 */
export interface JsonOutput {
  name: string;
  schema: JsonObjectSchema;
  /**
   * Force OpenAI's strict schema mode on or off. Left unset, the adapters ask
   * `isStrictSchema` and enforce whenever the schema actually qualifies.
   * This keeps an optional field from turning a working call into a
   * 400. Set it only to overrule that reading.
   */
  strict?: boolean;
}

/**
 * Read the JSON out of a model's answer. Models wrap it: a ```json fence, an
 * unmarked fence, a sentence before it, notes after it. This takes the first
 * fenced block marked `json` or not marked at all. Text after the language on
 * the fence line is read as the start of the JSON first, and as a label on the
 * block when that doesn't parse. With no such block, it takes the text from the
 * first `{` or `[` to the bracket that closes it, and with no bracket either,
 * the whole answer (a bare number, say). Then it parses that.
 *
 * It returns `unknown` on purpose: parsed is not validated, and a model's JSON
 * has the schema's shape only once the caller has checked it.
 *
 * @throws {JsonAnswerError} when that text is not JSON. The error carries the
 * answer, so a log shows what the model actually said.
 */
export function parseJsonAnswer(text: string): unknown {
  const block = fencedBlock(text);
  if (block === undefined) return parseAnswer(text, bracketed(text));
  const { rest, body } = block;
  if (rest.trim() === "") return parseAnswer(text, body);
  try {
    return JSON.parse(`${rest}\n${body}`);
  } catch (joinedError) {
    try {
      return JSON.parse(body);
    } catch (bodyError) {
      // Neither reading parses, so name the fault of the one holding the JSON.
      // A body that opens an object or array is the whole document, and the
      // joined reading only trips on the label. A body that doesn't is the tail
      // of JSON begun on the fence line, or empty, and alone says nothing useful.
      throw new JsonAnswerError(text, /^\s*[[{]/.test(body) ? bodyError : joinedError);
    }
  }
}

function parseAnswer(text: string, candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new JsonAnswerError(text, error);
  }
}

/** An answer `parseJsonAnswer` found no JSON in. `text` is the answer, cut to
 *  2,000 characters like a provider's error body; `cause` is the SyntaxError. */
export class JsonAnswerError extends Error {
  readonly text: string;

  constructor(text: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`The model's answer is not JSON: ${reason}`, { cause });
    this.name = "JsonAnswerError";
    this.text = text.slice(0, 2_000);
  }
}

/** A fenced block, whose fences count only at the start of a line. A JSON
 *  string can't hold a raw newline, so no line of JSON starts with a fence, and
 *  a value carrying one (a code sample) never ends the block early. `[^\S\n]`
 *  is a space, a tab, or the `\r` of a CRLF line.
 *
 *  What follows the language on the fence line is kept as `rest`, because it
 *  means one of two things. A model sometimes starts the JSON there
 *  (```json {"a": 1}), and dropping it leaves an empty body or only the tail.
 *  Or it is a label: a title, an attribute block, a few words. */
const FENCED_BLOCK = /^[^\S\n]*```[^\S\n]*([^\s`]*)([^\n]*)\n([\s\S]*?)^[^\S\n]*```/gm;

function fencedBlock(text: string): { rest: string; body: string } | undefined {
  for (const [, info = "", rest = "", body = ""] of text.matchAll(FENCED_BLOCK)) {
    const language = info.toLowerCase();
    if (language === "" || language === "json") return { rest, body };
  }
  return undefined;
}

/** From the first `{` or `[` to the bracket that closes it, skipping brackets
 *  inside strings. An answer cut off before it closes keeps its tail, and
 *  JSON.parse says what is wrong with it.
 *
 *  ponytail: the FIRST opener wins, so prose with a bracket before the JSON
 *  ("see [1]: {…}") picks the prose's. The upgrade is to try the next opener
 *  when one fails to parse, once a model that writes that turns up. */
function bracketed(text: string): string {
  const start = text.search(/[[{]/);
  if (start === -1) return text;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/**
 * How the schema rides on a call that ALSO carries tools.
 *
 * `"response_format"` sends both, as the shapes document and most models
 * honour. `"prompt"` leaves the format off that call and sends the schema as
 * prompt instead, which is what the Anthropic shape has always done.
 *
 * It is a setting because a model that cannot serve both never says so: its
 * decoder is pinned to the schema, the tool call has nowhere to go, and it
 * writes the announcement instead ("let me look that up") and stops. Nothing
 * is logged, because nothing failed. `probeJsonWithTools` answers it in one
 * call; there is no default that is right for every model.
 */
export type JsonWithTools = "response_format" | "prompt";

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
   * Nucleus sampling. Set this or `temperature`, not both. The vendors all
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
  /**
   * Overrides the provider's own setting for this call, so `probeJsonWithTools`
   * asks the same model both ways. See {@link JsonWithTools}.
   */
  jsonWithTools?: JsonWithTools;
  /**
   * Stable id for the conversation or job this call belongs to. Sent only to
   * endpoints whose preset names a `sessionHeader` (OpenCode Go routes and
   * caches by it); every other endpoint ignores it.
   */
  sessionId?: string;
  /**
   * Called when the response headers arrive and on every read of the body
   * after, keep-alives included. `withWatchdog` sets it: a stream that is only
   * sending keep-alives is alive, which no chunk an adapter yields can show.
   * Every adapter here forwards it; a custom Provider that does not still
   * works, on the watchdog's progress clock alone.
   */
  onActivity?: () => void;
  /**
   * `false` asks for at most one tool call per turn, for tools that must run
   * in order, or a backend lane that refuses parallel calls. Absent or `true`
   * is every vendor's default and sends nothing. Gemini has no such switch,
   * so it refuses `false` rather than silently ignore it.
   */
  parallelToolCalls?: boolean;
  /**
   * Which service tier to buy this call on: `priority` is faster and costs
   * more, `flex` is slower and costs less. Sent as `service_tier` on the
   * OpenAI and Responses shapes. Anthropic and Gemini refuse it with an
   * `invalid` error: Anthropic's own `service_tier` means something else, and
   * Gemini has no such switch. Overrides the provider's own setting.
   */
  serviceTier?: ServiceTier;
}

// ponytail: Codex's `ultrafast` tier (gpt-6-astra only) is the next value to add.
export type ServiceTier = "priority" | "flex";

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
  /** Present when the stream identifies the endpoint that answered. */
  provider?: string;
  reasoning: string;
  /** Present only where the provider sent one. See ChatMessage.reasoningDetails. */
  reasoningDetails?: unknown[];
  /** Present only where the provider sent them. See ChatMessage.reasoningItems. */
  reasoningItems?: ReasoningItems;
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
  let reasoningItems: ReasoningItems | undefined;
  let usage: TokenUsage = EMPTY_USAGE;
  let finishReason: FinishReason | null = null;
  let source: ProviderChunk["source"];
  for await (const chunk of stream) {
    if (chunk.source) source = chunk.source;
    if (chunk.type === "delta") {
      if (chunk.content) text += chunk.content;
      if (chunk.reasoning) reasoning += chunk.reasoning;
      if (chunk.reasoningDetails?.length) reasoningDetails = chunk.reasoningDetails;
      if (chunk.reasoningItems?.items.length) reasoningItems = chunk.reasoningItems;
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
    ...(reasoningItems ? { reasoningItems } : {}),
    usage,
    finishReason,
    model: source?.model ?? model,
    ...(source ? { provider: source.provider } : {}),
  };
}

/**
 * Prepare a history for a thinking-DISABLED turn: strip `reasoning` from every
 * assistant message.
 *
 * The chain-of-thought belongs only to thinking turns. A provider that
 * requires it replayed while thinking is ON (DeepSeek) rejects it when
 * thinking is off. This is exactly the shape of a forced-submit salvage
 * turn, where a run reasons through its whole investigation and then drops
 * thinking to serialize what it already found.
 *
 * Returns a shallow-cleaned copy; the caller's array is left untouched.
 */
export function stripReasoning(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    if (
      message.reasoning === undefined &&
      message.reasoningDetails === undefined &&
      message.reasoningItems === undefined
    ) {
      return message;
    }
    // Every half goes. `reasoningDetails` and `reasoningItems` are the same
    // chain of thought in the provider's own words, so leaving them behind
    // carries into a thinking-off turn exactly what stripping `reasoning` was
    // meant to keep out.
    const {
      reasoning: _text,
      reasoningDetails: _payload,
      reasoningItems: _items,
      ...rest
    } = message;
    return rest;
  });
}

/** `data:` URI for an image part, as the OpenAI dialect requires inline. */
export function toDataUri(part: ImagePart): string {
  return `data:${part.mimeType};base64,${part.data}`;
}
