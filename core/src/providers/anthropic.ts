// Anthropic-shape adapter — SSE from POST /v1/messages.
//
// Hosted tool shapes, betas and result blocks follow Vercel's AI SDK
// (Apache-2.0, Copyright 2023 Vercel, Inc.: anthropic-prepare-tools.ts,
// anthropic-language-model.ts, convert-to-anthropic-prompt.ts); the
// continuation and the citation and container rules follow PydanticAI (MIT).
// See THIRD_PARTY_NOTICES.
import { repairHistory } from "../context.ts";
import {
  fileRefused,
  ProviderError,
  streamCut,
  streamError,
  validateMaxAttempts,
} from "../errors.ts";
import {
  hostedCounts,
  hostedReplay,
  HostedRecorder,
  isRecord,
  planHostedTools,
  queryInput,
  servedAt,
  type Citation,
  type HostedCallDelta,
  type HostedInput,
  type HostedTool,
  type HostedToolType,
} from "../hosted.ts";
import { schemaPrompt, toAnthropicToolSchema } from "../schema.ts";
import { parseToolArgs, settleToolCalls, type ToolCallIdentity } from "../tool-args.ts";
import { streamSse, apiUrl, parseFrame, type FetchLike } from "../transport.ts";
import { attributionHeaders } from "../attribution.ts";
import { withConfiguredFallbacks, type ProviderFallbackConfig } from "../fallback.ts";
import type {
  JsonOutput,
  ChatMessage,
  ContentPart,
  Effort,
  FinishReason,
  Provider,
  ProviderChunk,
  StreamOptions,
  ToolChoice,
  ToolDefinition,
} from "../types.ts";

export interface AnthropicConfig extends ProviderFallbackConfig {
  apiKey: string;
  model: string;
  /** Any endpoint speaking the Anthropic Messages dialect, including a proxy or gateway.
   *  Defaults to Anthropic itself. */
  baseUrl?: string;
  /** Names the provider in errors and logs. The subscription backend is the
   *  reason this is not hardcoded: a token failure there is a re-login, not a
   *  bad API key, and the two must not read the same in a ledger. */
  id?: string;
  /** Bound default; a per-call `effort` overrides it. */
  effort?: Effort;
  /** Anthropic requires an output ceiling on every request. */
  maxTokens?: number;
  version?: string;
  fetchImpl?: FetchLike;
  /** Merged into every request. The subscription backend needs its own beta
   *  headers, and a gateway in front usually wants one of its own. */
  headers?: Record<string, string>;
  /**
   * App attribution for OpenRouter's rankings. The site URL rides as
   * `HTTP-Referer`, the app name as `X-Title`. Public, not secret. Sent
   * whenever set (other vendors ignore unknown headers); an explicit entry
   * in `headers` always wins. Covers OpenRouter's Anthropic-dialect endpoint.
   */
  siteUrl?: string;
  /**
   * App name for OpenRouter's rankings, sent as `X-Title`. See `siteUrl`.
   */
  siteName?: string;
  /** Send the key as a Bearer instead of `x-api-key`, as a subscription
   *  access token requires. */
  bearer?: boolean;
  /** Header that carries `StreamOptions.sessionId`. When set and a call has no
   *  sessionId, one stable id for this provider instance rides instead. */
  sessionHeader?: string;
  /** The id `sessionHeader` carries when a call has no `sessionId`. Absent, the
   *  adapter mints one when it is built. Pass one when something rebuilds the
   *  adapter (`withKeyPool` and `withToken` build one per attempt): each build
   *  mints a new id, and a gateway that pins a session to one upstream host
   *  then treats every call as a new session, re-routes it and misses its
   *  prompt cache. Ignored without `sessionHeader`. */
  instanceSessionId?: string;
  /** Say "no thinking" with an explicit `thinking: { type: "disabled" }` when
   *  effort resolves to none, instead of omitting the field. For endpoints
   *  where an absent field means the model's default, not off. Z.ai's coding
   *  endpoint reads silence as thinking ON for reasoning-mandatory models like
   *  GLM 5.3 Flash (measured 2026-09-13: omit → thinking block; disabled →
   *  none), and it accepts the marker natively. Ignored for a Claude id that
   *  thinks adaptively (4.6 and later): each has its own spelling of none (see
   *  `CLAUDE_THINKING`), and several reject this marker outright. Claude 4.5
   *  and older accept it, and get it. */
  explicitNone?: boolean;
  /**
   * The hosted tools this endpoint runs. Defaults to web search, web fetch and
   * code execution on api.anthropic.com and to none anywhere else: Bedrock,
   * Vertex and the Anthropic-compatible gateways each run a different set, or
   * none, and one that ignores a tool answers unsearched without saying so.
   * Set it once you have checked the endpoint.
   */
  servesHostedTools?: readonly HostedToolType[];
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** The hosted types this wire has a shape for, and the fields it applies. */
const ANTHROPIC_FIELDS: Partial<Record<HostedToolType, readonly string[]>> = {
  web_search: ["allowedDomains", "blockedDomains", "maxUses", "userLocation"],
  web_fetch: ["allowedDomains", "blockedDomains", "maxUses", "maxContentTokens"],
  // `fileIds` would ride as container_upload blocks in the prompt, not on the
  // tool; until that is built it is refused rather than dropped.
  code_execution: [],
};
const ANTHROPIC_SENDS = Object.keys(ANTHROPIC_FIELDS);

/** The names Anthropic's server tools answer to. A function tool under one of
 *  them, beside the hosted tool, is a request the API refuses. */
const RESERVED_NAMES: Partial<Record<HostedToolType, readonly string[]>> = {
  web_search: ["web_search"],
  web_fetch: ["web_fetch"],
  code_execution: ["code_execution", "bash_code_execution", "text_editor_code_execution"],
};

/** A paused turn resumed this many times without finishing is a vendor stuck
 *  pausing: PydanticAI's cap (models/_continuation.py:92-106). */
const MAX_PAUSES = 10;

/**
 * One hosted tool on the wire, and the beta header its version needs. Pinned
 * to the versions the model calls directly: the 2026-02-09 and 2026-03-18 web
 * tools route their calls through code execution and come back uncited
 * (PydanticAI anthropic/_citations.py:73-100). Shapes from Vercel's AI SDK
 * (Apache-2.0), anthropic-prepare-tools.ts:167-173,313-330,368-383.
 */
function anthropicHostedTool(provider: string, tool: HostedTool): { wire: unknown; beta?: string } {
  switch (tool.type) {
    case "web_search":
      return {
        wire: {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: tool.maxUses,
          allowed_domains: tool.allowedDomains,
          blocked_domains: tool.blockedDomains,
          ...(tool.userLocation
            ? { user_location: { type: "approximate", ...tool.userLocation } }
            : {}),
        },
      };
    case "web_fetch":
      return {
        wire: {
          type: "web_fetch_20250910",
          name: "web_fetch",
          max_uses: tool.maxUses,
          allowed_domains: tool.allowedDomains,
          blocked_domains: tool.blockedDomains,
          max_content_tokens: tool.maxContentTokens,
        },
        beta: "web-fetch-2025-09-10",
      };
    case "code_execution":
      return {
        wire: { type: "code_execution_20250825", name: "code_execution" },
        beta: "code-execution-2025-08-25",
      };
    default:
      // planHostedTools only passes the types in ANTHROPIC_FIELDS.
      throw new ProviderError(
        provider,
        "invalid",
        `${provider}: no Anthropic shape for ${tool.type}`,
      );
  }
}

/** The headers with this request's betas added to any the caller set, as one
 *  comma-separated `anthropic-beta`, whatever case the caller wrote it in. */
function withBetas(
  headers: Record<string, string>,
  betas: readonly string[],
): Record<string, string> {
  if (betas.length === 0) return headers;
  const out: Record<string, string> = {};
  const merged: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "anthropic-beta") out[name] = value;
    else
      merged.push(
        ...value
          .split(",")
          .map((beta) => beta.trim())
          .filter(Boolean),
      );
  }
  for (const beta of betas) if (!merged.includes(beta)) merged.push(beta);
  out["anthropic-beta"] = merged.join(",");
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** The seam's type for a server tool name; undefined for the server tools this
 *  adapter never asks for (tool search, MCP, the advisor). */
function serverToolType(name: string): HostedToolType | undefined {
  if (name === "web_search" || name === "web_fetch") return name;
  if (RESERVED_NAMES.code_execution?.includes(name)) return "code_execution";
  return undefined;
}

/** What a server tool was asked to do. Code execution 20250825 runs as two
 *  tools, a shell and a file editor, so both read as code runs. */
function serverToolInput(name: string, input: unknown): HostedInput {
  if (!isRecord(input)) return {};
  switch (name) {
    case "web_search":
      return queryInput([str(input.query)]);
    case "web_fetch": {
      const url = str(input.url);
      return url ? { url } : {};
    }
    case "bash_code_execution": {
      const code = str(input.command);
      return code ? { code, language: "bash" } : {};
    }
    case "text_editor_code_execution": {
      const path = str(input.path);
      const code = str(input.file_text);
      return { ...(path ? { path } : {}), ...(code ? { code } : {}) };
    }
    case "code_execution": {
      const code = str(input.code);
      return code ? { code, language: "python" } : {};
    }
    default:
      return {};
  }
}

/** A result block: `web_search_tool_result`, `bash_code_execution_tool_result`… */
function isResultBlock(block: Record<string, unknown>): boolean {
  return typeof block.type === "string" && block.type.endsWith("_tool_result");
}

/** What a server tool's result block says it did. An `*_error` content is a
 *  failed call, kept as data with the vendor's code (invariant 7). A shell
 *  that exits non-zero still ran: that is the program failing, not the tool. */
function serverToolResult(block: Record<string, unknown>): Omit<HostedCallDelta, "index"> {
  const { content } = block;
  if (Array.isArray(content)) {
    const sources = content.flatMap((result) => {
      const url = isRecord(result) ? str(result.url) : undefined;
      const title = isRecord(result) ? str(result.title) : undefined;
      return url ? [{ type: "url" as const, url, ...(title ? { title } : {}) }] : [];
    });
    return { status: "completed", output: { sources } };
  }
  if (!isRecord(content)) return { status: "completed" };
  const kind = str(content.type) ?? "";
  if (kind.endsWith("_error")) return { status: "failed", error: str(content.error_code) ?? kind };
  if (kind === "web_fetch_result") {
    const url = str(content.url);
    const title = isRecord(content.content) ? str(content.content.title) : undefined;
    return {
      status: "completed",
      output: url ? { sources: [{ type: "url", url, ...(title ? { title } : {}) }] } : {},
    };
  }
  if (kind === "bash_code_execution_result" || kind === "code_execution_result") {
    const files = (Array.isArray(content.content) ? content.content : []).flatMap((file) => {
      const id = isRecord(file) ? str(file.file_id) : undefined;
      return id ? [{ id }] : [];
    });
    const stdout = str(content.stdout);
    const stderr = str(content.stderr);
    return {
      status: "completed",
      output: {
        ...(stdout ? { stdout } : {}),
        ...(stderr ? { stderr } : {}),
        ...(typeof content.return_code === "number" ? { exitCode: content.return_code } : {}),
        ...(files.length > 0 ? { files } : {}),
      },
    };
  }
  const viewed = str(content.content);
  return { status: "completed", ...(viewed ? { output: { stdout: viewed } } : {}) };
}

/**
 * A text block's citations as the seam's: one claim per source over the whole
 * block, because Anthropic cites whole blocks (PydanticAI
 * anthropic/_citations.py:197-198). Only web search locations name a page;
 * the document kinds point into the prompt and stay in the vendor's record.
 */
function blockCitations(raw: readonly unknown[], start: number, end: number): Citation[] {
  return raw.flatMap((citation): Citation[] => {
    if (!isRecord(citation) || citation.type !== "web_search_result_location") return [];
    const url = str(citation.url);
    if (!url) return [];
    const title = str(citation.title);
    const excerpt = str(citation.cited_text);
    const source = {
      type: "url" as const,
      url,
      ...(title ? { title } : {}),
      ...(excerpt ? { excerpt } : {}),
    };
    return [{ source, start, end, anchor: "claim" }];
  });
}

/**
 * The code execution container of the turn still open: everything after the
 * last user message. A request inside that turn has to name the container its
 * earlier responses ran in, or the code it already ran is gone (PydanticAI
 * anthropic/_native_tools.py:128-147).
 */
function openTurnContainer(messages: readonly ChatMessage[], provider: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") return undefined;
    if (message.role === "assistant" && message.hostedItems?.provider === provider) {
      if (message.hostedItems.container) return message.hostedItems.container;
    }
  }
  return undefined;
}

/** The paused blocks as the last assistant message, which is how Anthropic is
 *  told to carry on with the turn it paused. */
function resumeWith(messages: AnthropicMessage[], blocks: readonly unknown[]): AnthropicMessage[] {
  const last = messages.at(-1);
  return last?.role === "assistant"
    ? [...messages.slice(0, -1), { role: "assistant", content: [...last.content, ...blocks] }]
    : [...messages, { role: "assistant", content: [...blocks] }];
}

/** The prompt of a turn's last model pass, cache included, when the vendor
 *  lists its passes. A server tool loop bills the sum of its passes, which is
 *  more than the window ever held. Ported from PydanticAI (MIT),
 *  anthropic/_response.py:180-196. */
function lastPassTokens(usage: AnthropicUsage | undefined): number | undefined {
  const passes = usage?.iterations ?? [];
  for (let i = passes.length - 1; i >= 0; i--) {
    const pass = passes[i]!;
    if (pass.type === "message" || pass.type === "fallback_message") {
      return (
        (pass.input_tokens ?? 0) +
        (pass.cache_read_input_tokens ?? 0) +
        (pass.cache_creation_input_tokens ?? 0)
      );
    }
  }
  return undefined;
}

/** The counts Anthropic states, by the seam's types. */
const STATED_COUNTS = [
  ["web_search_requests", "web_search"],
  ["web_fetch_requests", "web_fetch"],
  ["code_execution_requests", "code_execution"],
] as const;
const DEFAULT_VERSION = "2023-06-01";
/** Anthropic rejects a request without one, so a default is not optional. */
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * Thinking budgets, in output tokens, for extended thinking on Claude 4.5 and
 * older, and every non-Claude endpoint on this wire. Thinking and the answer
 * share `max_tokens`, so a budget is always left below the ceiling. A budget
 * at or above it leaves no room to answer, and the turn ends mid-thought.
 */
const THINKING_BUDGET: Record<Exclude<Effort, "none">, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  max: 32_768,
};

/** How one Claude model that thinks adaptively takes `effort`. */
interface ClaudeThinking {
  /** How `effort: "none"` is said: nothing, an explicit off, an off for
   *  up-front thinking only, or the lowest effort where there is no off. */
  none: "omit" | "disabled" | "between_tools" | "low";
  /** Whether a non-default temperature or top_p survives while thinking is off. */
  sampling: boolean;
  /** Whether a tool choice that forces a tool (`any`, or one named tool) is
   *  accepted. Where it is not, it is a 400 on every request. */
  forcedTool: boolean;
}

const ALWAYS_ON: ClaudeThinking = { none: "low", sampling: false, forcedTool: true };
/** Always on, and a forced tool choice is a 400: the 5.1 and 5.5 models. */
const LATEST: ClaudeThinking = { ...ALWAYS_ON, forcedTool: false };

/**
 * Claude models that take adaptive thinking, keyed by id. A graded effort is
 * said the same way on all of them: `thinking: { type: "adaptive" }` plus
 * `output_config.effort`, which every one accepts, and which the docs say to
 * use wherever a model also takes `budget_tokens`. What differs is `none`,
 * because what each model does when told nothing differs. Documented (Anthropic per-model table, read
 * 2026-09-27: platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting);
 * none of it was measured live.
 *
 * `sampling: false` marks the models where a non-default temperature, top_p or
 * top_k is a 400 on every request, thinking or not. Documented on the same date
 * (…/build-with-claude/thinking, "Sampling parameters").
 *
 * `forcedTool: false` marks the models that "reject forced tool use on every
 * request with a 400 error" (same page, "Response prefill and forced tool use",
 * read 2026-10-01). Every other model here takes it with adaptive thinking.
 */
const CLAUDE_THINKING: ReadonlyMap<string, ClaudeThinking> = new Map([
  // Always on: `enabled` and `disabled` are both 400s (Mythos Preview still
  // takes `enabled`), so there is no off to ask for. `none` is the lowest
  // effort rather than silence, because silence runs the model's own default —
  // `high`, or `medium` on Opus 5.5 — which is the request `none` exists to
  // refuse (invariant 12).
  ["claude-fable-5-1", LATEST],
  ["claude-mythos-5-1", LATEST],
  ["claude-opus-5-5", LATEST],
  ["claude-fable-5", ALWAYS_ON],
  ["claude-mythos-5", ALWAYS_ON],
  ["claude-mythos-preview", ALWAYS_ON],
  // On by default, and `disabled` is a 400. `between_tools` is its lowest
  // setting: no thinking up front, at effort high or below — and high is this
  // model's default, so it needs no effort beside it (effort page, read
  // 2026-10-01). It is also the one field it takes.
  ["claude-sonnet-5-5", { ...LATEST, none: "between_tools" }],
  // On by default, and `disabled` is accepted at effort high or below. `none`
  // still says `low`: with thinking disabled, Opus 5 occasionally writes a tool
  // call into its visible text instead of a tool_use block, most often on
  // tool-heavy work (documented, same page). That call never runs and nothing
  // errors, so the turn reads as a clean answer — a failure on the happy path,
  // in exactly the loop this package sits under. Anthropic's own advice is to
  // keep thinking on and lower effort; at `low` the model can still skip
  // thinking on a turn it judges simple.
  ["claude-opus-5", ALWAYS_ON],
  // On by default; `disabled` is accepted, with no such warning attached.
  ["claude-sonnet-5", { none: "disabled", sampling: false, forcedTool: true }],
  // Off by default, so saying nothing already is none.
  ["claude-opus-4-8", { none: "omit", sampling: false, forcedTool: true }],
  ["claude-opus-4-7", { none: "omit", sampling: false, forcedTool: true }],
  // These still take `budget_tokens`, deprecated. Adaptive is the mode the docs
  // say to use where both exist, and it drops extended mode's rule that the
  // final assistant turn open with a thinking block — which this adapter,
  // replaying no thinking, can never satisfy.
  ["claude-opus-4-6", { none: "omit", sampling: true, forcedTool: true }],
  ["claude-sonnet-4-6", { none: "omit", sampling: true, forcedTool: true }],
]);

/** Claude 4.5 and everything before it: extended thinking only (`adaptive` is
 *  a 400), off by default. The budget dialect below was written for these. */
const CLAUDE_EXTENDED_ONLY = /^claude-(3-|(opus|sonnet|haiku)-4(-[0-5])?$)/;

/**
 * The adaptive-thinking rule for a Claude id, or `undefined` for every id that
 * keeps the budget dialect: Claude 4.5 and older, and every other vendor's
 * model on this wire (their endpoints' dialects are their own).
 *
 * An id that starts with `claude-` but is in neither list is a Claude newer
 * than this table, and it is treated as always on. Every Claude since Opus 4.7
 * rejects `enabled`; the newest reject `disabled` too; and `output_config.effort`
 * is accepted by every model that thinks adaptively. So an unknown id gets the
 * one request none of them has refused, and no sampling fields, since every
 * Claude since Opus 4.7 answers a non-default one with a 400. Nor a forced tool
 * choice, which the newest refuse and an unforced request never trips. A model
 * that turns out to differ will say so with a 400 of its own, and earn a row.
 */
function claudeThinking(model: string): ClaudeThinking | undefined {
  if (!model.startsWith("claude-")) return undefined;
  const family = model.replace(/-\d{8}$/, ""); // a dated snapshot is its family
  if (CLAUDE_EXTENDED_ONLY.test(family)) return undefined;
  return CLAUDE_THINKING.get(family) ?? LATEST;
}

/** Whether a request continues a tool loop: its last assistant message made
 *  tool calls, so the request carries their results inside the same turn. */
function continuesToolLoop(messages: readonly ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") return (message.toolCalls?.length ?? 0) > 0;
  }
  return false;
}

/**
 * A stated stop, or a throw for one this adapter does not know. An unknown
 * reason used to end the stream as a clean success with no finish at all.
 * Nothing says the answer ended on purpose, so it is `overload`: theirs, and
 * worth a retry (cc-proxy answers it the same way). `pause_turn` never reaches
 * here: the stream sends the paused turn back and carries on (see below).
 */
function mapStopReason(provider: string, reason: string): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    // `model_context_window_exceeded`: the context window filled before the
    // answer did. Cut short, and a retry fills it the same way.
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      throw new ProviderError(provider, "overload", `${provider} stopped the turn on "${reason}"`, {
        code: reason,
      });
  }
}

interface AnthropicToolChoice {
  type: "auto" | "any" | "none" | "tool";
  name?: string;
  disable_parallel_tool_use?: boolean;
}

function toAnthropicToolChoice(choice: Exclude<ToolChoice, "auto">): AnthropicToolChoice {
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

function partsToAnthropic(content: string | ContentPart[], provider: string): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "file") throw fileRefused(provider, "Anthropic", part);
    return {
      type: "image",
      source: { type: "base64", media_type: part.mimeType, data: part.data },
    };
  });
}

/**
 * Anthropic takes `system` at the top level and expects tool RESULTS as user
 * turns carrying `tool_result` blocks, not as a role of their own. Consecutive
 * tool results are merged into one user turn, which the API requires.
 */
/**
 * The system prompt as ONE cached block.
 *
 * Anthropic's prompt caching is opt-in per block. A plain string system prompt
 * is never cached, however many times it is re-sent. An agent loop re-sends this
 * every single turn, and it is the largest stable prefix in the request, so
 * without the breakpoint the whole thing bills at the full input rate on every
 * round instead of a tenth of it on all but the first.
 *
 * Unconditional. Below the model's minimum cacheable length the field is
 * ignored rather than rejected, and above it the one-time 1.25× write is repaid
 * by the second turn, which always comes in the loop this package sits under.
 */
function systemBlocks(text: string): unknown[] | undefined {
  return text ? [{ type: "text", text, cache_control: { type: "ephemeral" } }] : undefined;
}

/**
 * The schema, as an extra system block. Anthropic has no native schema mode,
 * and the seam promises that a provider without one gets the schema in the
 * prompt instead. Without this an `opts.json` request went out carrying
 * nothing at all: the model answered in prose, the caller's `JSON.parse` threw,
 * and the turn failed on the happy path where no retry looks.
 *
 * It rides AFTER the cached block, and that order is load-bearing. A cache
 * breakpoint caches everything before it, so folding a per-call schema into the
 * cached block would change the cached prefix on every turn whose schema
 * differs and throw the whole system prompt's cache away, paying for the
 * schema with the most expensive thing in an agent loop.
 */
function jsonBlock(json: JsonOutput): unknown {
  return { type: "text", text: schemaPrompt(json.schema) };
}

/**
 * Tool ids as this wire accepts them: `[A-Za-z0-9_-]` only. Kimi's
 * `functions.search:0` is a 400 here, and an opencode-go rotation hands a
 * history from chat completions to Messages mid-conversation, so a Kimi id
 * does arrive. Each other character becomes `_`, and a result follows its call
 * because both go through the same map.
 *
 * Collision-safe in one forward pass: an id whose cleaned form is already
 * taken gets `_2`, `_3`…, judged only against ids seen before it, so an earlier
 * id never changes because of a later one and the prompt cache keeps its
 * prefix. A history whose ids are already clean comes out byte for byte.
 */
function anthropicIds(): (id: string) => string {
  const sent = new Map<string, string>();
  const taken = new Set<string>();
  return (id) => {
    let wire = sent.get(id);
    if (wire === undefined) {
      const clean = id.replace(/[^A-Za-z0-9_-]/g, "_");
      wire = clean;
      for (let k = 2; taken.has(wire); k++) wire = `${clean}_${k}`;
      sent.set(id, wire);
      taken.add(wire);
    }
    return wire;
  };
}

interface AnthropicMessage {
  role: string;
  content: unknown[];
}

export function toAnthropicMessages(
  messages: readonly ChatMessage[],
  provider = "anthropic",
): {
  system?: unknown[];
  messages: AnthropicMessage[];
} {
  const wireId = anthropicIds();
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const toolUse = (call: { id: string; name: string; arguments: string }) => ({
    type: "tool_use",
    id: wireId(call.id),
    name: call.name,
    input: parseToolArgs(call.arguments),
  });
  const out: AnthropicMessage[] = [];
  const pushBlocks = (role: string, blocks: unknown[]) => {
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      pushBlocks("user", partsToAnthropic(message.content, provider));
      continue;
    }
    if (message.role === "tool") {
      pushBlocks("user", [
        {
          type: "tool_result",
          tool_use_id: wireId(message.toolCallId),
          content: [
            { type: "text", text: message.content },
            ...(message.images ?? []).map((image) => ({
              type: "image",
              source: { type: "base64", media_type: image.mimeType, data: image.data },
            })),
          ],
        },
      ]);
      continue;
    }
    // assistant. Reasoning is deliberately NOT replayed: Anthropic's thinking
    // blocks carry signatures we never captured, and a block without its
    // signature is rejected.
    //
    // A hosted turn this provider made goes back as the blocks it came in, so
    // the model keeps the search results it read and the code it ran, and
    // each text block keeps the citations it was given. Its text and calls
    // come from the message, so an id `repairHistory` renamed still pairs.
    const replayed = hostedReplay(message, provider);
    if (replayed) {
      pushBlocks(
        "assistant",
        replayed.map((entry) => {
          if ("call" in entry) return toolUse(entry.call);
          if ("item" in entry) return entry.item;
          const { citations } = entry.slot;
          return { type: "text", text: entry.text, ...(citations ? { citations } : {}) };
        }),
      );
      continue;
    }
    const blocks: unknown[] = [];
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const call of message.toolCalls ?? []) blocks.push(toolUse(call));
    if (blocks.length > 0) pushBlocks("assistant", blocks);
  }

  const blocks = systemBlocks(system);
  return { ...(blocks ? { system: blocks } : {}), messages: out };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** The server tool calls this response billed. */
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
    code_execution_requests?: number;
  } | null;
  /** Each model pass of the response, on the betas that report them. */
  iterations?:
    | {
        type?: string;
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }[]
    | null;
}

interface AnthropicEvent {
  type?: string;
  message?: {
    usage?: AnthropicUsage;
    container?: { id?: string } | null;
  };
  content_block?: { type?: string; id?: string; name?: string; [field: string]: unknown };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    citation?: unknown;
    stop_reason?: string;
    container?: { id?: string } | null;
  };
  usage?: AnthropicUsage;
  index?: number;
  error?: { message?: string; type?: string };
}

export function createAnthropicProvider(config: AnthropicConfig): Provider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const id = config.id ?? "anthropic";
  const instanceSessionId = config.sessionHeader
    ? (config.instanceSessionId ?? crypto.randomUUID())
    : undefined;

  const provider: Provider = {
    id,
    model: config.model,

    async *createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      validateMaxAttempts(opts.maxAttempts);
      const model = opts.model ?? config.model;
      const maxTokens = opts.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS;
      const effort = opts.effort ?? config.effort;
      // Repaired first: a result with no call, a call with no result, or an id
      // used twice is a 400 that loses the turn. See repairHistory.
      const sent = repairHistory(messages).messages;
      const { system, messages: body } = toAnthropicMessages(sent, id);

      // Anthropic's own `service_tier` means auto or standard_only, not this.
      if (opts.serviceTier) {
        throw new ProviderError(
          id,
          "invalid",
          `${id}: Anthropic has no priority or flex tier (its service_tier field means something else). ` +
            "Leave serviceTier unset for Claude models.",
        );
      }
      const request: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: body,
        stream: true,
      };
      const systemBody = opts.json ? [...(system ?? []), jsonBlock(opts.json)] : system;
      if (systemBody?.length) request.system = systemBody;
      if (opts.temperature !== undefined) request.temperature = opts.temperature;
      if (opts.topP !== undefined) request.top_p = opts.topP;
      if (opts.stopSequences?.length) request.stop_sequences = opts.stopSequences;
      const claude = claudeThinking(model);
      const forcesTool = opts.toolChoice === "required" || typeof opts.toolChoice === "object";
      // A model that refuses a forced tool choice gets `auto` instead, which is
      // the docs' own advice, and a named tool becomes the only tool it is
      // offered. Sending the choice anyway is a 400 on every request.
      // ponytail: the model may still answer in text. The upgrade is strict
      // tool use or structured outputs, which the docs pair with `auto`.
      const unforced = forcesTool && claude?.forcedTool === false;
      const named = typeof opts.toolChoice === "object" ? opts.toolChoice.name : undefined;
      const offered =
        unforced && named !== undefined ? tools.filter((tool) => tool.name === named) : tools;
      const hosted = planHostedTools(
        id,
        {
          name: "Anthropic",
          serves: (
            config.servesHostedTools ??
            servedAt(baseUrl, "api.anthropic.com", ["web_search", "web_fetch", "code_execution"])
          ).filter((type) => ANTHROPIC_SENDS.includes(type)),
          fields: ANTHROPIC_FIELDS,
          refuse(tool) {
            // TanStack's rule (MIT, ai-anthropic tools/web-search-tool.ts:12-18).
            if (
              (tool.type === "web_search" || tool.type === "web_fetch") &&
              tool.allowedDomains !== undefined &&
              tool.blockedDomains !== undefined
            ) {
              return "Anthropic takes allowedDomains or blockedDomains, not both. Set one, or mark the tool optional.";
            }
            const taken = offered.find((fn) => RESERVED_NAMES[tool.type]?.includes(fn.name));
            return taken
              ? `a function tool is named ${taken.name}, which Anthropic keeps for this hosted tool. Rename the function tool.`
              : undefined;
          },
        },
        opts,
      );
      const hostedWire = hosted.map((tool) => anthropicHostedTool(id, tool));
      if (offered.length > 0 || hostedWire.length > 0) {
        request.tools = [
          ...offered.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: toAnthropicToolSchema(tool.inputSchema),
          })),
          ...hostedWire.map(({ wire }) => wire),
        ];
      }
      const betas = hostedWire.flatMap(({ beta }) => (beta ? [beta] : []));
      const choice =
        opts.toolChoice && opts.toolChoice !== "auto" && !unforced
          ? toAnthropicToolChoice(opts.toolChoice)
          : undefined;
      // This wire says "one call at a time" inside the tool choice, so asking
      // for it needs a choice to ride on — `auto` when the caller named none.
      // `none` calls nothing, so there is nothing to serialize.
      if (opts.parallelToolCalls === false && offered.length > 0 && choice?.type !== "none") {
        request.tool_choice = { ...(choice ?? { type: "auto" }), disable_parallel_tool_use: true };
      } else if (choice) {
        request.tool_choice = choice;
      }
      // Extended mode, which is all Claude 4.5 and older have, can't think on
      // two kinds of request this adapter sends, so those run without thinking.
      // Documented (Anthropic Thinking page, read 2026-09-27):
      // - One that continues a tool loop. A thinking request's final assistant
      //   turn must open with a thinking block, and this adapter sends none back
      //   (see toAnthropicMessages). Turning thinking off mid-turn is documented
      //   not to error, and the next user turn thinks again.
      // - One whose tool choice forces a tool: `any` or `tool` "results in an
      //   error because these options force tool use, which is incompatible with
      //   manual extended thinking." The caller asked for the tool, so it wins.
      // ponytail: every loop step after the first goes unthought on these
      // models. The upgrade is replaying the signed thinking blocks.
      const unthought =
        !claude && model.startsWith("claude-") && (forcesTool || continuesToolLoop(sent));
      if (claude) {
        // An effort the caller never set sends nothing: the model keeps its own
        // default, which on most of these is thinking ON.
        if (effort === "none") {
          if (claude.none === "disabled") request.thinking = { type: "disabled" };
          if (claude.none === "between_tools") request.thinking = { type: "between_tools" };
          if (claude.none === "low") request.output_config = { effort: "low" };
        } else if (effort) {
          request.thinking = { type: "adaptive" };
          request.output_config = { effort };
        }
        const thinking = effort !== undefined && effort !== "none";
        if (thinking || !claude.sampling) {
          delete request.temperature;
          delete request.top_p;
        }
      } else if (effort && effort !== "none" && !unthought) {
        const budget = Math.min(THINKING_BUDGET[effort], Math.floor(maxTokens * 0.8));
        request.thinking = { type: "enabled", budget_tokens: budget };
        // Thinking and sampling are mutually exclusive on this shape.
        delete request.temperature;
        delete request.top_p;
      } else if (config.explicitNone) {
        // Z.ai's coding endpoint: silence means the model default — which is
        // ON for a reasoning-mandatory model — so "none" has to be said out
        // loud. An effort nobody set reads as none here, as it always has.
        request.thinking = { type: "disabled" };
      }

      // Anthropic reports cache reads and writes as fields of their OWN,
      // EXCLUDED from `input_tokens` — where the OpenAI shapes report a cached
      // subset already inside the prompt count. Reconciling here is what keeps
      // one usage record meaningful across both, and a cost figure honest.
      //
      // Summed over the passes of a paused turn: each pass is a response of its
      // own, and each is billed.
      const billed = { fresh: 0, cached: 0, written: 0, output: 0 };
      const statedCounts: Partial<Record<HostedToolType, number>> = {};
      let contextTokens: number | undefined;
      let toolCall: ToolCallIdentity | null = null;
      let sawToolCall = false;
      let blockIndex = -1;
      // The answer's length so far, in JS string units: where a hosted call
      // sits in it, and the span a text block's citations cover.
      let length = 0;
      const recorder = new HostedRecorder();
      // The vendor's record of the turn, for `hostedItems`: its server blocks
      // as they came, its text as `{ length }`, its function calls as `{ call }`.
      const items: unknown[] = [];
      let recordedCalls = 0;
      let container = openTurnContainer(sent, id);
      // Every block of the passes so far, thinking and signatures included, to
      // send back when the turn pauses. Kept for this call only: the signatures
      // are what lets the model pick its own turn back up.
      const resumed: unknown[] = [];
      const usageChunk = (): ProviderChunk => {
        const hostedCalls = hostedCounts(recorder.shown(), statedCounts);
        return {
          type: "usage",
          usage: {
            inputTokens: billed.fresh + billed.cached + billed.written,
            cachedInputTokens: billed.cached,
            cacheWriteTokens: billed.written,
            outputTokens: billed.output,
            ...(hostedCalls ? { hostedCalls } : {}),
            ...(contextTokens !== undefined ? { contextTokens } : {}),
          },
        };
      };
      // The end of the turn, before its finish: a hosted call that never got a
      // result fails, and leaves the record, because Anthropic pairs every
      // server block with its result and a lone one is a 400 on the next send.
      function* closeTurn(): Generator<ProviderChunk> {
        const unsettled = recorder.unsettled();
        const failed = recorder.settle();
        if (failed.length > 0) yield { type: "delta", hosted: failed };
        const kept = items.filter(
          (item) =>
            !(
              isRecord(item) &&
              item.type === "server_tool_use" &&
              unsettled.has(str(item.id) ?? "")
            ),
        );
        if (kept.some((item) => isRecord(item) && "type" in item)) {
          yield {
            type: "delta",
            hostedItems: { provider: id, items: kept, ...(container ? { container } : {}) },
          };
        }
      }
      const headers = withBetas(
        {
          "anthropic-version": config.version ?? DEFAULT_VERSION,
          ...(config.bearer
            ? { authorization: `Bearer ${config.apiKey}` }
            : { "x-api-key": config.apiKey }),
          ...attributionHeaders(config, config.headers),
          ...(config.sessionHeader
            ? { [config.sessionHeader]: opts.sessionId ?? instanceSessionId }
            : {}),
          ...config.headers,
        },
        betas,
      );

      // One pass per response. A server tool loop that runs long ends its
      // response on `pause_turn`, and the turn goes on only once the paused
      // content is sent back as the last assistant message. The reader sees
      // one turn: the next pass's blocks continue at the same offset.
      // (PydanticAI's accumulate loop, MIT, models/_continuation.py:1-24.)
      for (let pauses = 0; ; pauses++) {
        // What proves the pass ended rather than the socket: a stated stop
        // reason, or `message_stop`. See the check after the loop.
        let stopped = false;
        let ended = false;
        let paused = false;
        let fresh = 0;
        let cached = 0;
        let written = 0;
        let output = 0;
        let servers: AnthropicUsage["server_tool_use"];
        let open:
          | { block: Record<string, unknown>; json: string; start: number; citations: unknown[] }
          | undefined;
        const blocks: unknown[] = [];
        const payload = {
          ...request,
          ...(resumed.length > 0 ? { messages: resumeWith(body, resumed) } : {}),
          ...(container ? { container } : {}),
        };

        read: for await (const data of streamSse({
          url: apiUrl(baseUrl, "/v1/messages"),
          headers,
          body: payload,
          provider: id,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
          ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
          ...(opts.onRateLimit ? { onRateLimit: opts.onRateLimit } : {}),
          // The stop reason rides in `message_delta` with the final usage, so a
          // read that dies after it loses nothing but `message_stop`.
          finished: () => stopped,
        })) {
          const event = parseFrame<AnthropicEvent>(data, id);

          switch (event.type) {
            // A failure the backend reports after its headers went out. Classified
            // rather than assumed transient: this shape carries `overloaded_error`
            // most of the time, but a prompt found too long mid-stream arrives the
            // same way, and retrying that one only fails it again more slowly.
            case "error":
              throw streamError(id, event);

            case "message_start": {
              const usage = event.message?.usage;
              cached = usage?.cache_read_input_tokens ?? 0;
              written = usage?.cache_creation_input_tokens ?? 0;
              fresh = usage?.input_tokens ?? 0;
              servers = usage?.server_tool_use ?? servers;
              contextTokens = lastPassTokens(usage) ?? contextTokens;
              container = event.message?.container?.id ?? container;
              break;
            }

            case "content_block_start": {
              blockIndex += 1;
              const block: Record<string, unknown> = { ...event.content_block };
              open = { block, json: "", start: length, citations: [] };
              if (block.type === "tool_use") {
                toolCall = {
                  index: blockIndex,
                  id: str(block.id) ?? "",
                  name: str(block.name) ?? "",
                };
                // Checked here, because this block is the only place this shape
                // states a call's id and name.
                settleToolCalls(id, [toolCall]);
                sawToolCall = true;
                yield {
                  type: "delta",
                  toolCalls: [{ index: toolCall.index, id: toolCall.id, name: toolCall.name }],
                };
              } else if (block.type === "server_tool_use") {
                const name = str(block.name) ?? "";
                const type = serverToolType(name);
                if (type) {
                  // Whole here on some versions, in deltas of its own on others
                  // (Vercel anthropic-language-model.ts:2635-2643).
                  const whole = isRecord(block.input) && Object.keys(block.input).length > 0;
                  const input = whole ? serverToolInput(name, block.input) : undefined;
                  yield {
                    type: "delta",
                    hosted: [recorder.start(str(block.id), type, length, input)],
                  };
                }
              } else if (isResultBlock(block)) {
                // A result arrives whole, in the block that opens it.
                const done = recorder.end(str(block.tool_use_id), serverToolResult(block));
                if (done) yield { type: "delta", hosted: [done] };
              }
              break;
            }

            case "content_block_delta": {
              const delta = event.delta;
              if (delta?.type === "text_delta" && delta.text) {
                length += delta.text.length;
                if (open) open.block.text = (str(open.block.text) ?? "") + delta.text;
                yield { type: "delta", content: delta.text };
              } else if (delta?.type === "thinking_delta" && delta.thinking) {
                if (open) open.block.thinking = (str(open.block.thinking) ?? "") + delta.thinking;
                yield { type: "delta", reasoning: delta.thinking };
              } else if (delta?.type === "signature_delta" && open) {
                open.block.signature = delta.signature;
              } else if (delta?.type === "citations_delta" && open) {
                // It arrives ahead of the text it cites, so it is placed when
                // the block ends and its span is known.
                open.citations.push(delta.citation);
              } else if (delta?.type === "input_json_delta") {
                // Buffered per block. A server tool's input is the vendor's to
                // run, and fed into a function call's arguments it corrupts
                // them (TanStack ai-anthropic text.ts:1706-1710).
                if (open) open.json += delta.partial_json ?? "";
                if (toolCall) {
                  yield {
                    type: "delta",
                    toolCalls: [{ index: toolCall.index, arguments: delta.partial_json ?? "" }],
                  };
                }
              }
              break;
            }

            case "content_block_stop": {
              toolCall = null;
              if (!open) break;
              const { block, json, start, citations } = open;
              open = undefined;
              // An empty text block holds nothing, and sent back it is a 400.
              const size = block.type === "text" ? (str(block.text)?.length ?? 0) : undefined;
              if (size !== undefined) {
                if (citations.length > 0) {
                  block.citations = citations;
                  const cited = blockCitations(citations, start, length);
                  if (cited.length > 0) yield { type: "delta", citations: cited };
                }
                if (size > 0) {
                  items.push({ length: size, ...(citations.length > 0 ? { citations } : {}) });
                }
              } else if (block.type === "tool_use") {
                if (json) block.input = parseToolArgs(json);
                items.push({ call: recordedCalls++ });
              } else if (block.type === "server_tool_use") {
                // Kept exactly as the vendor wrote it: this goes back to it.
                if (json) block.input = parseJson(json) ?? block.input;
                const index = recorder.indexOf(str(block.id));
                if (index !== undefined && json) {
                  const input = serverToolInput(str(block.name) ?? "", block.input);
                  yield { type: "delta", hosted: [{ index, input }] };
                }
                items.push(block);
              } else if (isResultBlock(block)) {
                items.push(block);
              }
              if (size !== 0) blocks.push(block);
              break;
            }

            case "message_delta": {
              // Z.ai starts with zero input usage and reports the real totals here.
              // These are cumulative counters, not increments. Native Anthropic
              // usually sends only output_tokens here, so absent fields retain theirs.
              fresh = event.usage?.input_tokens ?? fresh;
              cached = event.usage?.cache_read_input_tokens ?? cached;
              written = event.usage?.cache_creation_input_tokens ?? written;
              output = event.usage?.output_tokens ?? output;
              servers = event.usage?.server_tool_use ?? servers;
              contextTokens = lastPassTokens(event.usage) ?? contextTokens;
              container = event.delta?.container?.id ?? container;
              const reason = event.delta?.stop_reason;
              if (!reason) break;
              stopped = true;
              if (reason === "pause_turn") {
                paused = true;
                break;
              }
              const stated = mapStopReason(id, reason);
              yield* closeTurn();
              // Anthropic-compatible gateways can end a tool turn on
              // `end_turn`, and a caller reading that as done never runs the
              // tool. Only `stop` is promoted: a length cut may be what broke
              // the call. Hosted calls never count: the loop runs none of them.
              const finishReason = stated === "stop" && sawToolCall ? "tool_calls" : stated;
              yield { type: "finish", finishReason };
              break;
            }

            // The pass's last event, so the reader stops here. Some gateways
            // append a `[DONE]` or other bytes after it, and a read that died on
            // those failed an answer that was already whole (Kimi, GLM and
            // OpenCode Go, measured by cc-proxy).
            case "message_stop":
              ended = true;
              break read;
          }
        }

        billed.fresh += fresh;
        billed.cached += cached;
        billed.written += written;
        billed.output += output;
        for (const [field, type] of STATED_COUNTS) {
          const count = servers?.[field];
          if (count !== undefined) statedCounts[type] = (statedCounts[type] ?? 0) + count;
        }
        // A gateway that states its stop reason and then skips `message_stop`,
        // or whose socket dies after the reason, still finished the turn, and
        // still billed it.
        if (!stopped && !ended) throw streamCut(id);
        if (!paused) {
          yield usageChunk();
          return;
        }
        if (pauses >= MAX_PAUSES) {
          throw new ProviderError(
            id,
            "overload",
            `${id}: the turn paused ${pauses + 1} times without finishing`,
            { code: "pause_turn" },
          );
        }
        resumed.push(...blocks);
      }
    },
  };
  return withConfiguredFallbacks(provider, config);
}
