// Anthropic-shape adapter — SSE from POST /v1/messages.
import { fileRefused, streamError } from "../errors.ts";
import { schemaPrompt, toAnthropicToolSchema } from "../schema.ts";
import { parseToolArgs } from "../tool-args.ts";
import { streamSse, apiUrl } from "../transport.ts";
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
  ToolDefinition,
} from "../types.ts";

export interface AnthropicConfig extends ProviderFallbackConfig {
  apiKey: string;
  model: string;
  /** Any endpoint speaking the Anthropic Messages dialect — a proxy or gateway.
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
  fetchImpl?: typeof fetch;
  /** Merged into every request. The subscription backend needs its own beta
   *  headers, and a gateway in front usually wants one of its own. */
  headers?: Record<string, string>;
  /**
   * App attribution for OpenRouter's rankings — the site URL rides as
   * `HTTP-Referer`, the app name as `X-Title`. Public, not secret. Sent
   * whenever set (other vendors ignore unknown headers); an explicit entry
   * in `headers` always wins. Covers OpenRouter's Anthropic-dialect endpoint.
   */
  siteUrl?: string;
  /**
   * App name for OpenRouter's rankings, sent as `X-Title`. See `siteUrl`.
   */
  siteName?: string;
  /** Send the key as a Bearer instead of `x-api-key` — what a subscription
   *  access token needs. */
  bearer?: boolean;
  /** Say "no thinking" with an explicit `thinking: { type: "disabled" }` when
   *  effort resolves to none, instead of omitting the field. For endpoints
   *  where an absent field means the MODEL's default, not off — Z.ai's coding
   *  endpoint reads silence as thinking ON for reasoning-mandatory models like
   *  GLM 5.3 Flash (measured 2026-09-13: omit → thinking block; disabled →
   *  none), and it accepts the marker natively. Ignored for a Claude id that
   *  thinks adaptively (4.6 and later): each has its own spelling of none (see
   *  `CLAUDE_THINKING`), and several reject this marker outright. Claude 4.5
   *  and older accept it, and get it. */
  explicitNone?: boolean;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";
/** Anthropic rejects a request without one, so a default is not optional. */
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * Thinking budgets, in output tokens, for extended thinking — Claude 4.5 and
 * older, and every non-Claude endpoint on this wire. Thinking and the answer
 * SHARE `max_tokens`, so a budget is always left below the ceiling — a budget
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
  /** How `effort: "none"` is said: nothing, an explicit off, or the lowest
   *  effort where there is no off to ask for. */
  none: "omit" | "disabled" | "low";
  /** Whether a non-default temperature or top_p survives while thinking is off. */
  sampling: boolean;
}

const ALWAYS_ON: ClaudeThinking = { none: "low", sampling: false };

/**
 * Claude models that take adaptive thinking, keyed by id. A graded effort is
 * said the same way on all of them — `thinking: { type: "adaptive" }` plus
 * `output_config.effort` — which every one accepts, and which the docs say to
 * use wherever a model also takes `budget_tokens`. What differs is `none`,
 * because what each model does when told nothing differs. Documented (Anthropic per-model table, read
 * 2026-09-27: platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting);
 * none of it was measured live.
 *
 * `sampling: false` marks the models where a non-default temperature, top_p or
 * top_k is a 400 on every request, thinking or not. Documented on the same date
 * (…/build-with-claude/thinking, "Sampling parameters").
 */
const CLAUDE_THINKING: ReadonlyMap<string, ClaudeThinking> = new Map([
  // Always on: `enabled` and `disabled` are both 400s (Mythos Preview still
  // takes `enabled`), so there is no off to ask for. `none` is the lowest
  // effort rather than silence, because silence runs the model's own default —
  // `high`, or `medium` on Opus 5.5 — which is the request `none` exists to
  // refuse (invariant 12).
  ["claude-fable-5-1", ALWAYS_ON],
  ["claude-mythos-5-1", ALWAYS_ON],
  ["claude-fable-5", ALWAYS_ON],
  ["claude-mythos-5", ALWAYS_ON],
  ["claude-mythos-preview", ALWAYS_ON],
  ["claude-opus-5-5", ALWAYS_ON],
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
  ["claude-sonnet-5", { none: "disabled", sampling: false }],
  // Off by default, so saying nothing already is none.
  ["claude-opus-4-8", { none: "omit", sampling: false }],
  ["claude-opus-4-7", { none: "omit", sampling: false }],
  // These still take `budget_tokens`, deprecated. Adaptive is the mode the docs
  // say to use where both exist, and it drops extended mode's rule that the
  // final assistant turn open with a thinking block — which this adapter,
  // replaying no thinking, can never satisfy.
  ["claude-opus-4-6", { none: "omit", sampling: true }],
  ["claude-sonnet-4-6", { none: "omit", sampling: true }],
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
 * Claude since Opus 4.7 answers a non-default one with a 400. A model that
 * turns out to differ will say so with a 400 of its own, and earn a row.
 */
function claudeThinking(model: string): ClaudeThinking | undefined {
  if (!model.startsWith("claude-")) return undefined;
  const family = model.replace(/-\d{8}$/, ""); // a dated snapshot is its family
  if (CLAUDE_EXTENDED_ONLY.test(family)) return undefined;
  return CLAUDE_THINKING.get(family) ?? ALWAYS_ON;
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

function mapStopReason(reason: string | undefined): FinishReason | undefined {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return undefined;
  }
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
 * turns carrying `tool_result` blocks — not as a role of their own. Consecutive
 * tool results are merged into one user turn, which the API requires.
 */
/**
 * The system prompt as ONE cached block.
 *
 * Anthropic's prompt caching is opt-in PER BLOCK — a plain string system prompt
 * is never cached, however many times it is re-sent. An agent loop re-sends this
 * every single turn, and it is the largest stable prefix in the request, so
 * without the breakpoint the whole thing bills at the full input rate on every
 * round instead of a tenth of it on all but the first.
 *
 * Unconditional. Below the model's minimum cacheable length the field is
 * ignored rather than rejected, and above it the one-time 1.25× write is repaid
 * by the second turn — which, in the loop this package sits under, always comes.
 */
function systemBlocks(text: string): unknown[] | undefined {
  return text ? [{ type: "text", text, cache_control: { type: "ephemeral" } }] : undefined;
}

/**
 * The schema, as an extra system block — Anthropic has no native schema mode,
 * and the seam promises that a provider without one gets the schema in the
 * prompt instead. Without this an `opts.json` request went out carrying
 * nothing at all: the model answered in prose, the caller's `JSON.parse` threw,
 * and the turn failed on the happy path where no retry looks.
 *
 * It rides AFTER the cached block, and that order is load-bearing. A cache
 * breakpoint caches everything before it, so folding a per-call schema into the
 * cached block would change the cached prefix on every turn whose schema
 * differs and throw the whole system prompt's cache away — paying for the
 * schema with the most expensive thing in an agent loop.
 */
function jsonBlock(json: JsonOutput): unknown {
  return { type: "text", text: schemaPrompt(json.schema) };
}

export function toAnthropicMessages(
  messages: readonly ChatMessage[],
  provider = "anthropic",
): {
  system?: unknown[];
  messages: unknown[];
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const out: { role: string; content: unknown[] }[] = [];
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
          tool_use_id: message.toolCallId,
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
    const blocks: unknown[] = [];
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const call of message.toolCalls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseToolArgs(call.arguments),
      });
    }
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
}

interface AnthropicEvent {
  type?: string;
  message?: {
    usage?: AnthropicUsage;
  };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: AnthropicUsage;
  index?: number;
  error?: { message?: string; type?: string };
}

export function createAnthropicProvider(config: AnthropicConfig): Provider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const id = config.id ?? "anthropic";

  const provider: Provider = {
    id,
    model: config.model,

    async *createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      const model = opts.model ?? config.model;
      const maxTokens = opts.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS;
      const effort = opts.effort ?? config.effort;
      const { system, messages: body } = toAnthropicMessages(messages, id);

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
      if (tools.length > 0) {
        request.tools = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: toAnthropicToolSchema(tool.inputSchema),
        }));
      }
      if (opts.toolChoice && opts.toolChoice !== "auto") {
        request.tool_choice =
          opts.toolChoice === "none"
            ? { type: "none" }
            : opts.toolChoice === "required"
              ? { type: "any" }
              : { type: "tool", name: opts.toolChoice.name };
      }
      const claude = claudeThinking(model);
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
      const forcesTool = opts.toolChoice === "required" || typeof opts.toolChoice === "object";
      const unthought =
        !claude && model.startsWith("claude-") && (forcesTool || continuesToolLoop(messages));
      if (claude) {
        // An effort the caller never set sends nothing: the model keeps its own
        // default, which on most of these is thinking ON.
        if (effort === "none") {
          if (claude.none === "disabled") request.thinking = { type: "disabled" };
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
      let freshInputTokens = 0;
      let cachedInputTokens = 0;
      let cacheWriteTokens = 0;
      let outputTokens = 0;
      let toolCall: { index: number; id: string; name: string } | null = null;
      let blockIndex = -1;

      for await (const data of streamSse({
        url: apiUrl(baseUrl, "/v1/messages"),
        headers: {
          "anthropic-version": config.version ?? DEFAULT_VERSION,
          ...(config.bearer
            ? { authorization: `Bearer ${config.apiKey}` }
            : { "x-api-key": config.apiKey }),
          ...attributionHeaders(config, config.headers),
          ...config.headers,
        },
        body: request,
        provider: id,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      })) {
        let event: AnthropicEvent;
        try {
          event = JSON.parse(data) as AnthropicEvent;
        } catch {
          continue; // a keep-alive or a frame we do not model
        }

        switch (event.type) {
          // A failure the backend reports after its headers went out. Classified
          // rather than assumed transient: this shape carries `overloaded_error`
          // most of the time, but a prompt found too long mid-stream arrives the
          // same way, and retrying that one only fails it again more slowly.
          case "error":
            throw streamError(id, event.error);

          case "message_start": {
            const usage = event.message?.usage;
            cachedInputTokens = usage?.cache_read_input_tokens ?? 0;
            cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
            freshInputTokens = usage?.input_tokens ?? 0;
            break;
          }

          case "content_block_start": {
            blockIndex += 1;
            if (event.content_block?.type === "tool_use") {
              toolCall = {
                index: blockIndex,
                id: event.content_block.id ?? "",
                name: event.content_block.name ?? "",
              };
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
            } else if (delta?.type === "input_json_delta" && toolCall) {
              yield {
                type: "delta",
                toolCalls: [{ index: toolCall.index, arguments: delta.partial_json ?? "" }],
              };
            }
            break;
          }

          case "content_block_stop":
            toolCall = null;
            break;

          case "message_delta": {
            // Z.ai starts with zero input usage and reports the real totals here.
            // These are cumulative counters, not increments. Native Anthropic
            // usually sends only output_tokens here, so absent fields retain theirs.
            freshInputTokens = event.usage?.input_tokens ?? freshInputTokens;
            cachedInputTokens = event.usage?.cache_read_input_tokens ?? cachedInputTokens;
            cacheWriteTokens = event.usage?.cache_creation_input_tokens ?? cacheWriteTokens;
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            const finishReason = mapStopReason(event.delta?.stop_reason);
            if (finishReason) yield { type: "finish", finishReason };
            break;
          }

          case "message_stop":
            yield {
              type: "usage",
              usage: {
                inputTokens: freshInputTokens + cachedInputTokens + cacheWriteTokens,
                cachedInputTokens,
                cacheWriteTokens,
                outputTokens,
              },
            };
            break;
        }
      }
    },
  };
  return withConfiguredFallbacks(provider, config);
}
