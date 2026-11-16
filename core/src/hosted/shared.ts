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
import type {
  HostedToolType,
  HostedTool,
  HostedWire,
  HostedInput,
  HostedCallDelta,
} from "./types.ts";
export * from "./types.ts";
import { ProviderError } from "../errors.ts";
import type { ChatMessage, StreamOptions, ToolCall } from "../types.ts";

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
