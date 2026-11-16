import type { ImagePart } from "../types.ts";

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
