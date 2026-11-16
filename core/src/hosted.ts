// Provider-hosted tools: web search, web fetch, code execution, file search and
// image generation that the model's VENDOR runs, inside its own turn. The seam
// asks for them in one neutral shape (`StreamOptions.hostedTools`), each adapter
// sends them in its vendor's dialect or refuses them before any request goes
// out, and what they did comes back as records and citations on the turn. They
// are never function calls: the loop has nothing to run and nothing to answer.
//
// Refused, never dropped. A gateway that does not know a hosted tool can ignore
// it and answer unsearched, on the happy path, where nothing retries and
// nothing logs: the failure `fileRefused` exists for, one capability over. A
// restriction a wire can't apply (a domain filter, a use cap) is refused too,
// because sending the tool without it widens what the vendor does for the
// caller. `optional` is the way to decline that: it drops the WHOLE tool, which
// narrows what happens instead.
//
// The vendor's own record of the turn (`HostedItems`) is opaque and tagged with
// the provider that made it, like `reasoningItems`: only that provider replays
// it, and only while it still fits the message it rides on.
import { ProviderError } from "./errors.ts";
import type { ChatMessage, ImagePart, StreamOptions, ToolCall } from "./types.ts";

/** Every hosted tool type, least to most invasive. The union derives from the
 *  array, so a runtime check and the type can never drift apart. */
export const HOSTED_TOOL_TYPES = [
  "web_search",
  "web_fetch",
  "code_execution",
  "file_search",
  "image_generation",
] as const;
export type HostedToolType = (typeof HOSTED_TOOL_TYPES)[number];

/** Roughly where the person asking is, so a search can rank local results. */
export interface UserLocation {
  city?: string;
  region?: string;
  /** Two-letter ISO country code, such as `US`. */
  country?: string;
  /** IANA time zone, such as `America/New_York`. */
  timezone?: string;
}

/**
 * A tool the model vendor runs inside its own turn.
 *
 * Which wire runs which type, and which fields each applies, is in the hosted
 * tools guide. A type the endpoint doesn't run, or a field the wire can't
 * apply, is refused with an `invalid` error before any request goes out. Set
 * `optional` to drop the tool there instead.
 */
export type HostedTool = {
  /**
   * Drop this tool, rather than refuse the request, where the endpoint can't
   * run it or can't apply one of its fields. The whole tool goes, never one
   * field: sending it without a domain filter or a use cap would widen what the
   * vendor does, and leaving it out only narrows it.
   */
  optional?: boolean;
} & (
  | {
      type: "web_search";
      allowedDomains?: readonly string[];
      blockedDomains?: readonly string[];
      /** At most this many searches in one turn. */
      maxUses?: number;
      userLocation?: UserLocation;
    }
  | {
      type: "web_fetch";
      allowedDomains?: readonly string[];
      blockedDomains?: readonly string[];
      /** At most this many fetches in one turn. */
      maxUses?: number;
      /** Cut each fetched page to about this many tokens. */
      maxContentTokens?: number;
    }
  | {
      type: "code_execution";
      /** Files the code may read, by the vendor's file id. */
      fileIds?: readonly string[];
    }
  | {
      type: "file_search";
      /** The vendor's vector stores (Responses) or file search stores (Gemini). */
      storeIds: readonly string[];
      maxResults?: number;
    }
  | {
      type: "image_generation";
      size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024";
      quality?: "auto" | "low" | "medium" | "high";
      format?: "png" | "jpeg" | "webp";
      background?: "auto" | "opaque" | "transparent";
    }
);

/** What a hosted call read: a web page, or a file in a store or a container. */
export interface Source {
  type: "url" | "file";
  url?: string;
  title?: string;
  fileId?: string;
  containerId?: string;
  /** The passage the vendor quoted from it, when it quoted one. */
  excerpt?: string;
}

/**
 * A source tied to the answer.
 *
 * `start` and `end` are JS string indices into the turn's `content`, converted
 * from whatever the vendor counts in (UTF-8 bytes on Gemini, code points on
 * OpenAI) and checked against the text. A span that doesn't check out is left
 * off, never guessed: the citation still names its source. `start` equal to
 * `end` is a point.
 *
 * `anchor` says what the span covers. `claim` is text the source backs:
 * Anthropic cites whole text blocks, Gemini sentences. `marker` is a link the
 * model wrote into the answer, which is what OpenAI's offsets select.
 */
export interface Citation {
  source: Source;
  start?: number;
  end?: number;
  anchor?: "claim" | "marker";
}

/** What a hosted call was asked to do, in the fields its type uses. */
export interface HostedInput {
  /** A search's query, when it ran one. */
  query?: string;
  /** A search's queries, when it ran several. */
  queries?: string[];
  /** The page a fetch read. */
  url?: string;
  /** The code a run executed. */
  code?: string;
  language?: string;
  /** The file a code run's editor touched. */
  path?: string;
  /** What an image generation drew, in the vendor's words. */
  prompt?: string;
}

/** A file a hosted call made. Downloading it needs the vendor's own files or
 *  containers API, which this package does not wrap, and containers expire. */
export interface HostedFile {
  id?: string;
  url?: string;
  name?: string;
  containerId?: string;
}

export interface HostedOutput {
  sources?: Source[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Images the call made, as base64. A generated image is an answer. */
  images?: ImagePart[];
  files?: HostedFile[];
  /** Gemini's search suggestions, as the HTML Google sends for them. */
  searchSuggestions?: string;
}

/**
 * One hosted run, assembled. Display data, with the sensitivity of `content`:
 * an excerpt can quote the caller's own documents.
 *
 * A failed call is data (`status: "failed"`, `error` the vendor's code, such as
 * `max_uses_exceeded`) and the turn goes on, as a failing function tool's does
 * (invariant 7). A call the vendor never finished fails with `no_result`.
 */
export interface HostedCall {
  id: string;
  type: HostedToolType;
  status: "running" | "completed" | "failed";
  input?: HostedInput;
  output?: HostedOutput;
  error?: string;
  /** Where in `content` the call ran: the text's length when it started. */
  at: number;
}

/**
 * A fragment of a hosted call, assembled by `index` (`collectTurn` does it).
 * Each field takes the last value stated, `codeDelta` appends to `input.code`,
 * and `output` is always stated whole.
 */
export interface HostedCallDelta {
  index: number;
  id?: string;
  type?: HostedToolType;
  status?: HostedCall["status"];
  input?: HostedInput;
  codeDelta?: string;
  output?: HostedOutput;
  error?: string;
  at?: number;
}

/**
 * The vendor's own record of a hosted turn, in the order it sent it: search
 * results, fetched pages, code output. Opaque, provider-owned, and replayed
 * only to the provider that made it, like `reasoningItems`. Never echo it to a
 * browser, and drop it from history a browser hands back.
 *
 * Answer text is stored as `{ length }` and function calls as `{ call: i }`,
 * so replay cuts the text from `content` and pairs the calls that
 * `repairHistory` may have renamed. When the lengths no longer sum to
 * `content.length`, or the calls no longer match, the message goes back as
 * plain text instead.
 */
export interface HostedItems {
  provider: string;
  items: unknown[];
  /** The code execution container the turn ran in, which the next request in
   *  the same turn has to name. */
  container?: string;
}

/**
 * A hosted tool the wire can't send. Refused, never dropped: see the module
 * comment. `wire` names the adapter, because `provider` is often a gateway's id.
 */
export function hostedRefused(
  provider: string,
  wire: string,
  tool: HostedToolType,
  why: string,
): ProviderError {
  return new ProviderError(
    provider,
    "invalid",
    `${provider}: the ${wire} adapter can't send ${tool}: ${why}`,
  );
}

/** What one adapter, at one endpoint, can send. */
export interface HostedWire {
  /** The adapter's name in a refusal: `Anthropic`, `Responses`, `Gemini`, `OpenAI chat`. */
  name: string;
  /** The types this endpoint runs. */
  serves: readonly HostedToolType[];
  /** The fields this wire applies, for each type it sends. Any other field set
   *  on a tool is one the wire would silently leave out. */
  fields: Partial<Record<HostedToolType, readonly string[]>>;
  /** This wire's own reason to refuse a tool, beyond the two above. */
  refuse?: (tool: HostedTool) => string | undefined;
}

const FORCED =
  'a forced toolChoice can\'t be combined with hosted tools, because each vendor reads it differently. Use toolChoice "auto", or leave the hosted tools off this call.';

/**
 * The hosted tools one request sends: each tool the caller asked for that this
 * wire can send with every field it set. One it can't is refused with an
 * `invalid` error before any request, unless it is `optional`, which drops it.
 *
 * `toolChoice: "none"` sends none, on every wire. A forced choice (`required`
 * or a named tool) with hosted tools is refused: Anthropic's `any` and
 * Responses' `required` can be met by a vendor tool, Gemini's `ANY` cannot, so
 * the pair has no one meaning. A type listed twice is refused everywhere.
 *
 * Ported from PydanticAI (MIT, Pydantic Services Inc.): the refusal rule and
 * `optional`, models/__init__.py:4080-4130 and native_tools/__init__.py:155-207.
 */
export function planHostedTools(
  provider: string,
  wire: HostedWire,
  opts: Pick<StreamOptions, "hostedTools" | "toolChoice">,
): HostedTool[] {
  const asked = opts.hostedTools ?? [];
  const seen = new Set<HostedToolType>();
  for (const tool of asked) {
    if (seen.has(tool.type)) {
      throw hostedRefused(
        provider,
        wire.name,
        tool.type,
        "it is listed twice. List each type once.",
      );
    }
    seen.add(tool.type);
  }
  if (opts.toolChoice === "none") return [];
  const forced = opts.toolChoice === "required" || typeof opts.toolChoice === "object";
  return asked.filter((tool) => {
    const why = forced ? FORCED : unsendable(tool, wire);
    if (why === undefined) return true;
    if (tool.optional) return false;
    throw hostedRefused(provider, wire.name, tool.type, why);
  });
}

function unsendable(tool: HostedTool, wire: HostedWire): string | undefined {
  if (!wire.serves.includes(tool.type)) {
    return (
      "this endpoint doesn't run it. Send the request to one that does, list the type in " +
      "servesHostedTools if this endpoint runs it, or mark the tool optional."
    );
  }
  const applied = wire.fields[tool.type] ?? [];
  const unapplied = Object.entries(tool)
    .filter(([key, value]) => key !== "type" && key !== "optional" && value !== undefined)
    .map(([key]) => key)
    .filter((key) => !applied.includes(key));
  if (unapplied.length > 0) {
    const fields = unapplied.join(" and ");
    return (
      `this wire can't apply ${fields}, so the tool would run without ${fields}. ` +
      `Remove ${fields}, or mark the tool optional.`
    );
  }
  return wire.refuse?.(tool);
}

/** The types an endpoint runs when its config doesn't say: the vendor's own API
 *  host runs its documented set, and every other host none. A gateway that
 *  ignores an unknown tool answers unsearched and says nothing, so a host runs
 *  hosted tools only once someone has measured it (`servesHostedTools`). */
export function servedAt(
  baseUrl: string,
  host: string,
  types: readonly HostedToolType[],
): readonly HostedToolType[] {
  try {
    return new URL(baseUrl).hostname === host ? types : [];
  } catch {
    return [];
  }
}

/** A search's input: one query as `query`, several as `queries`, so a reader
 *  that shows one string finds it in the same place on every wire. */
export function queryInput(queries: readonly (string | undefined | null)[]): HostedInput {
  const stated = queries.filter((query): query is string => typeof query === "string" && !!query);
  if (stated.length === 0) return {};
  return stated.length === 1 ? { query: stated[0] } : { queries: stated };
}

/**
 * The hosted calls one stream opened, keyed by the vendor's id, so a result
 * finds its call and the end of the turn can settle the ones that never got
 * one. It also counts what the stream showed, per type, for
 * `TokenUsage.hostedCalls` on a wire that does not state its own counts.
 */
export class HostedRecorder {
  private next = 0;
  private readonly open = new Map<string, number>();
  private readonly counts = new Map<HostedToolType, number>();

  /** A call the vendor started. One with no id of its own gets `hosted_{index}`,
   *  which depends on nothing but its position (invariant 14). */
  start(
    id: string | undefined,
    type: HostedToolType,
    at: number,
    input?: HostedInput,
  ): HostedCallDelta & { id: string } {
    const index = this.next++;
    const key = id || `hosted_${index}`;
    this.open.set(key, index);
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
    return { index, id: key, type, status: "running", at, ...(input ? { input } : {}) };
  }

  /** A call the vendor reports only once it is over (Gemini's grounding, a
   *  backend that sends only the finished item), in one delta. */
  whole(
    id: string | undefined,
    type: HostedToolType,
    at: number,
    delta: Omit<HostedCallDelta, "index" | "id" | "type" | "at">,
  ): HostedCallDelta {
    const started = this.start(id, type, at);
    this.open.delete(started.id);
    return { ...started, ...delta };
  }

  /** The seam index of a call still open, by the vendor's id. */
  indexOf(id: string | undefined): number | undefined {
    return id === undefined ? undefined : this.open.get(id);
  }

  /** A call the vendor finished, or undefined for an id it never opened. */
  end(id: string | undefined, delta: Omit<HostedCallDelta, "index">): HostedCallDelta | undefined {
    if (id === undefined) return undefined;
    const index = this.open.get(id);
    if (index === undefined) return undefined;
    this.open.delete(id);
    return { index, ...delta };
  }

  /** The ids still open. */
  unsettled(): ReadonlySet<string> {
    return new Set(this.open.keys());
  }

  /** Every call still open at the end of the turn, failed: the vendor never
   *  said how it went, so nothing it returned can be shown or replayed. */
  settle(): HostedCallDelta[] {
    const failed = [...this.open.values()].map((index): HostedCallDelta => ({
      index,
      status: "failed",
      error: "no_result",
    }));
    this.open.clear();
    return failed;
  }

  /** The calls the stream showed, by type, or undefined when it showed none. */
  shown(): Partial<Record<HostedToolType, number>> | undefined {
    return this.counts.size > 0 ? Object.fromEntries(this.counts) : undefined;
  }
}

/** The counts a usage record carries, with the types at zero left out, or
 *  undefined when every type is. A turn that ran nothing keeps its usage
 *  exactly as it was before hosted tools existed. */
export function hostedCounts(
  ...counts: (Partial<Record<HostedToolType, number>> | undefined)[]
): Partial<Record<HostedToolType, number>> | undefined {
  const merged: Partial<Record<HostedToolType, number>> = {};
  for (const count of counts) Object.assign(merged, count);
  const kept = Object.entries(merged).filter(([, count]) => (count ?? 0) > 0);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

/** One recorded item with its placeholder filled back in. */
export type ReplayedItem =
  | { text: string; slot: Record<string, unknown> }
  | { call: ToolCall }
  | { item: unknown };

/** A JSON object off the wire, as opposed to an array, a scalar or null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ length }`: answer text, cut back out of `content` on replay. A vendor item
 *  always carries a `type` or a part key of its own, so a placeholder can't be
 *  mistaken for one. */
function textSlot(item: unknown): { slot: Record<string, unknown>; length: number } | undefined {
  if (!isRecord(item) || "type" in item) return undefined;
  const { length } = item;
  return typeof length === "number" ? { slot: item, length } : undefined;
}

/** `{ call: i }`: the message's i-th tool call, whatever its id is now. */
function callSlot(item: unknown): number | undefined {
  if (!isRecord(item) || "type" in item) return undefined;
  const { call } = item;
  return typeof call === "number" ? call : undefined;
}

/**
 * The hosted items a message replays to `provider`, placeholders filled back
 * in, or undefined when it replays none: another provider made them, or the
 * message no longer matches them. Matching means the recorded text lengths sum
 * to `content.length` and every call placeholder names a distinct call the
 * message still has. An edited answer fails that and goes back as plain text,
 * because a citation replayed over edited text vouches for words its source
 * never backed.
 *
 * ponytail: an edit that keeps the length passes. PydanticAI and TanStack use
 * the same length test (anthropic/_citations.py:202-211, responses-text.ts:172-212);
 * the upgrade is a hash of the text in each placeholder.
 */
export function hostedReplay(
  message: AssistantMessage,
  provider: string,
): ReplayedItem[] | undefined {
  const recorded = message.hostedItems;
  if (!recorded || recorded.provider !== provider) return undefined;
  const calls = message.toolCalls ?? [];
  let length = 0;
  const paired = new Set<number>();
  for (const item of recorded.items) {
    const slot = textSlot(item);
    if (slot) length += slot.length;
    const call = callSlot(item);
    if (call === undefined) continue;
    if (!Number.isInteger(call) || call < 0 || call >= calls.length || paired.has(call)) {
      return undefined;
    }
    paired.add(call);
  }
  if (length !== message.content.length || paired.size !== calls.length) return undefined;

  let offset = 0;
  return recorded.items.map((item): ReplayedItem => {
    const text = textSlot(item);
    if (text) {
      offset += text.length;
      return { text: message.content.slice(offset - text.length, offset), slot: text.slot };
    }
    const call = callSlot(item);
    return call === undefined ? { item } : { call: calls[call]! };
  });
}

/**
 * A UTF-8 byte offset into `text` as a JS string index, or undefined when it
 * falls inside a character or past the end. Gemini counts its grounding
 * segments in bytes; a JS string counts UTF-16 units, so the two part at the
 * first character outside ASCII.
 *
 * Ported from PydanticAI (MIT, Pydantic Services Inc.), models/google.py:2347-2405.
 */
export function utf8Index(text: string, bytes: number): number | undefined {
  if (!Number.isInteger(bytes) || bytes < 0) return undefined;
  let seen = 0;
  let index = 0;
  for (const char of text) {
    if (seen >= bytes) break;
    seen += utf8Length(char.codePointAt(0) ?? 0);
    index += char.length;
  }
  return seen === bytes ? index : undefined;
}

/** How many bytes UTF-8 spends on one code point. */
function utf8Length(point: number): number {
  if (point < 0x80) return 1;
  if (point < 0x800) return 2;
  if (point < 0x10000) return 3;
  return 4;
}

/** A code point offset into `text` as a JS string index, or undefined past the
 *  end. OpenAI's annotation offsets count code points, which differ from JS
 *  indices at the first emoji or other character outside the BMP. */
export function codePointIndex(text: string, points: number): number | undefined {
  if (!Number.isInteger(points) || points < 0) return undefined;
  let seen = 0;
  let index = 0;
  for (const char of text) {
    if (seen === points) return index;
    seen += 1;
    index += char.length;
  }
  return seen === points ? index : undefined;
}
