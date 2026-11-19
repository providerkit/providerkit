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
import type { HostedToolType } from "../hosted/types.ts";
import { refuseHostedTools, type HostedCodecs } from "./hosted-codecs.ts";
import { schemaPrompt, toAnthropicToolSchema } from "../schema.ts";
import { parseToolArgs, settleToolCalls, type ToolCallIdentity } from "../tool-args.ts";
import { streamSse, apiUrl, parseFrame, withRedactedErrors, type FetchLike } from "../transport.ts";
import { attributionHeaders } from "../attribution.ts";
import { configuredFallbacks, type ProviderFallbackConfig } from "../fallback.ts";
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
  /** Leave the provider's words out of every error. See `PresetProviderConfig.redactErrors`. */
  redactErrors?: boolean;
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
   * For providers imported from `@providerkit/core/hosted`.
   * The hosted tools this endpoint runs. Defaults to web search, web fetch and
   * code execution on api.anthropic.com and to none anywhere else: Bedrock,
   * Vertex and the Anthropic-compatible gateways each run a different set, or
   * none, and one that ignores a tool answers unsearched without saying so.
   * Set it once you have checked the endpoint.
   */
  servesHostedTools?: readonly HostedToolType[];
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";

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
 * The system prompt: one text block per system message, in order, with the
 * cache breakpoint on the last.
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
 *
 * A block per message, not one joined block, because a decorator over a
 * Provider can only add a system message. A line it puts first then reaches the
 * wire as its own first block, which a gateway that reads the first block finds
 * alone, instead of as the start of a block that holds the whole prompt.
 *
 * A blank message gets no block. Joined, it was a few spaces inside real text;
 * alone, it is a 400 ("system text blocks must contain non-whitespace text",
 * recorded against claude-sonnet-5-5 by PydanticAI, MIT,
 * tests/test_history_properties.py).
 */
function systemBlocks(messages: readonly string[]): unknown[] | undefined {
  const texts = messages.filter((text) => text.trim() !== "");
  if (texts.length === 0) return undefined;
  return texts.map((text, i) =>
    i === texts.length - 1
      ? { type: "text", text, cache_control: { type: "ephemeral" } }
      : { type: "text", text },
  );
}

/**
 * Whether Anthropic takes a cache marker on this block. A list of the blocks
 * that do, rather than of the ones that don't: a marker on a block that refuses
 * one is a 400 that loses the turn, while a block missing from this list only
 * moves the marker back a block.
 *
 * Thinking blocks of both kinds and empty text cannot carry one; text, images,
 * tool use and tool results can, the last two in user and assistant turns alike
 * (Anthropic, Prompt caching, "What can be cached" and "What cannot be cached",
 * read 2026-11-19). A server tool's result takes one too: the API puts its own
 * breakpoint there before its tool loop's next step (Anthropic, Tool use with
 * prompt caching, read 2026-11-19). Blank text counts as empty: the API refuses
 * a text block of only whitespace outright.
 */
function takesMarker(block: unknown): block is Record<string, unknown> {
  if (typeof block !== "object" || block === null || !("type" in block)) return false;
  const { type } = block;
  if (type === "text") {
    return "text" in block && typeof block.text === "string" && block.text.trim() !== "";
  }
  return (
    type === "image" ||
    type === "tool_use" ||
    type === "tool_result" ||
    type === "server_tool_use" ||
    (typeof type === "string" && type.endsWith("_tool_result"))
  );
}

/** `message` with a marker on its last block that takes one, or as it was when none does. */
function markLast(message: AnthropicMessage): AnthropicMessage {
  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i];
    if (!takesMarker(block)) continue;
    const content = [...message.content];
    content[i] = { ...block, cache_control: { type: "ephemeral" } };
    return { ...message, content };
  }
  return message;
}

/**
 * The conversation's cache breakpoints. The system marker caches the fixed
 * prefix, tools and system; these cache the conversation, which grows every
 * turn while that prefix stays the same size. Without them every turn billed
 * the whole history again at the full input rate, and only tools and system
 * came from cache.
 *
 * Two of them, on the last block that takes one (see takesMarker):
 * - The newest message. Each request writes its entry there.
 * - The message just before the newest assistant message: where the previous
 *   request ended, so this one reads that request's entry exactly. A read looks
 *   back at most 20 positions from a breakpoint for an entry an earlier request
 *   wrote. On the Claude API a run of tool_use blocks counts as one position, and
 *   so does a run of tool_result blocks; the docs state that rule for no other
 *   platform. A turn that adds more than 20 would read nothing from the newest
 *   marker alone, and bill its whole prefix fresh. An adopter ran on the newest
 *   marker alone and named this second one as the upgrade.
 *
 * Only on a request another one will follow: one that declares tools, or one
 * whose messages already hold an assistant turn. A one-shot would pay the 1.25×
 * write for an entry nothing reads. A prefix under the model's minimum (512
 * tokens on the newest models, up to 4,096 on older ones) is neither cached
 * nor billed as a write.
 *
 * Block markers only, never the top-level `cache_control` field that turns on
 * automatic caching: the legacy Bedrock integration (bedrock-runtime) answers
 * that field with a 400, and no Anthropic-shape gateway has been checked.
 *
 * With the system's, three markers at most, under the API's cap of four. They
 * depend only on the messages, and a moved marker is not a changed prefix (the
 * docs' own growing conversation moves it every turn and reads the last
 * turn's entry), so a longer history still sends the shorter one's bytes plus
 * what is new (invariant 14).
 *
 * Documented (Anthropic, Prompt caching, read 2026-11-19:
 * platform.claude.com/docs/en/build-with-claude/prompt-caching); not measured
 * live here.
 */
function markConversation(
  messages: AnthropicMessage[],
  declaresTools: boolean,
): AnthropicMessage[] {
  const newestReply = messages.map((message) => message.role).lastIndexOf("assistant");
  if (!declaresTools && newestReply < 0) return messages;
  const previousEnd = newestReply - 1;
  return messages.map((message, i) =>
    i === messages.length - 1 || i === previousEnd ? markLast(message) : message,
  );
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

export interface AnthropicMessage {
  role: string;
  content: unknown[];
}

export function toAnthropicMessages(
  messages: readonly ChatMessage[],
  provider = "anthropic",
): { system?: unknown[]; messages: AnthropicMessage[] } {
  return anthropicMessages(messages, provider);
}

/** @internal Hosted replay stays outside the plain converter. */
export function anthropicMessages(
  messages: readonly ChatMessage[],
  provider = "anthropic",
  replay?: HostedCodecs["anthropic"]["replay"],
): {
  system?: unknown[];
  messages: AnthropicMessage[];
} {
  const wireId = anthropicIds();
  const system = messages.flatMap((m) => (m.role === "system" ? [m.content] : []));

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
    const replayed = replay?.(message, provider, toolUse);
    if (replayed) {
      pushBlocks("assistant", replayed);
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

export interface AnthropicUsage {
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

export interface AnthropicEvent {
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
  return anthropicProvider(config);
}

/** @internal Shared by the plain and hosted entry points. */
export function anthropicProvider(config: AnthropicConfig, codecs?: HostedCodecs): Provider {
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
      if (!codecs) refuseHostedTools(id, opts, messages);
      const model = opts.model ?? config.model;
      const maxTokens = opts.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS;
      const effort = opts.effort ?? config.effort;
      // Repaired first: a result with no call, a call with no result, or an id
      // used twice is a 400 that loses the turn. See repairHistory.
      const sent = repairHistory(messages).messages;
      const { system, messages: body } = anthropicMessages(sent, id, codecs?.anthropic.replay);

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
      const hosted = codecs?.anthropic.plan(config, baseUrl, id, offered, opts);
      if (offered.length > 0 || (hosted?.tools.length ?? 0) > 0) {
        request.tools = [
          ...offered.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: toAnthropicToolSchema(tool.inputSchema),
          })),
          ...(hosted?.tools ?? []),
        ];
      }
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
      let toolCall: ToolCallIdentity | null = null;
      let sawToolCall = false;
      let blockIndex = -1;
      const hostedStream = codecs?.anthropic.stream(sent, id);
      const usageChunk = (): ProviderChunk => {
        return {
          type: "usage",
          usage: {
            inputTokens: billed.fresh + billed.cached + billed.written,
            cachedInputTokens: billed.cached,
            cacheWriteTokens: billed.written,
            outputTokens: billed.output,
            ...hostedStream?.usage(),
          },
        };
      };
      const baseHeaders = {
        "anthropic-version": config.version ?? DEFAULT_VERSION,
        ...(config.bearer
          ? { authorization: `Bearer ${config.apiKey}` }
          : { "x-api-key": config.apiKey }),
        ...attributionHeaders(config, config.headers),
        ...(config.sessionHeader
          ? { [config.sessionHeader]: opts.sessionId ?? instanceSessionId }
          : {}),
        ...config.headers,
      };
      const headers = codecs?.anthropic.headers(baseHeaders, hosted?.betas ?? []) ?? baseHeaders;

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
        // Marked per pass, because each pass is a request of its own: the one
        // after a pause ends in the paused turn, so that is its newest message.
        const messages = markConversation(
          hostedStream?.messages(body) ?? body,
          request.tools !== undefined,
        );
        const payload = hostedStream?.payload({ ...request, messages }) ?? { ...request, messages };

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
          if (hostedStream) yield* hostedStream.event(event);

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
              break;
            }

            case "content_block_start": {
              blockIndex += 1;
              const block: Record<string, unknown> = { ...event.content_block };
              if (block.type === "tool_use") {
                toolCall = {
                  index: blockIndex,
                  id: typeof block.id === "string" ? block.id : "",
                  name: typeof block.name === "string" ? block.name : "",
                };
                // Checked here, because this block is the only place this shape
                // states a call's id and name.
                settleToolCalls(id, [toolCall]);
                sawToolCall = true;
                yield {
                  type: "delta",
                  toolCalls: [{ index: toolCall.index, id: toolCall.id, name: toolCall.name }],
                };
              }
              break;
            }

            case "content_block_delta": {
              const delta = event.delta;
              if (delta?.type === "text_delta" && delta.text) {
                yield { type: "delta", content: delta.text };
              } else if (delta?.type === "thinking_delta" && delta.thinking) {
                yield { type: "delta", reasoning: delta.thinking };
              } else if (delta?.type === "input_json_delta") {
                // Buffered per block. A server tool's input is the vendor's to
                // run, and fed into a function call's arguments it corrupts
                // them (TanStack ai-anthropic text.ts:1706-1710).
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
              const reason = event.delta?.stop_reason;
              if (!reason) break;
              stopped = true;
              if (reason === "pause_turn" && hostedStream) {
                paused = true;
                break;
              }
              const stated = mapStopReason(id, reason);
              if (hostedStream) yield* hostedStream.close();
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
        // A gateway that states its stop reason and then skips `message_stop`,
        // or whose socket dies after the reason, still finished the turn, and
        // still billed it.
        if (!stopped && !ended) throw streamCut(id);
        hostedStream?.endPass(paused, pauses);
        if (!paused) {
          yield usageChunk();
          return;
        }
      }
    },
  };
  return configuredFallbacks(
    config.redactErrors ? withRedactedErrors(provider) : provider,
    config,
    codecs,
  );
}
