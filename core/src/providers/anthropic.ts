// Anthropic-shape adapter — SSE from POST /v1/messages.
import { streamError } from "../errors.ts";
import { parseToolArgs } from "../tool-args.ts";
import { streamSse, apiUrl } from "../transport.ts";
import type {
  ChatMessage,
  ContentPart,
  Effort,
  FinishReason,
  Provider,
  ProviderChunk,
  StreamOptions,
  ToolDefinition,
} from "../types.ts";

export interface AnthropicConfig {
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
  /** Send the key as a Bearer instead of `x-api-key` — what a subscription
   *  access token needs. */
  bearer?: boolean;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";
/** Anthropic rejects a request without one, so a default is not optional. */
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * Thinking budgets, in output tokens. Thinking and the answer SHARE
 * `max_tokens`, so a budget is always left below the ceiling — a budget at or
 * above it leaves no room to answer, and the turn ends mid-thought.
 */
const THINKING_BUDGET: Record<Exclude<Effort, "none">, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  max: 32_768,
};

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

function partsToAnthropic(content: string | ContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image",
          source: { type: "base64", media_type: part.mimeType, data: part.data },
        },
  );
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

export function toAnthropicMessages(messages: readonly ChatMessage[]): {
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
      pushBlocks("user", partsToAnthropic(message.content));
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

interface AnthropicEvent {
  type?: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { output_tokens?: number };
  index?: number;
  error?: { message?: string; type?: string };
}

export function createAnthropicProvider(config: AnthropicConfig): Provider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const id = config.id ?? "anthropic";

  return {
    id,
    model: config.model,

    async *createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      const model = opts.model ?? config.model;
      const maxTokens = opts.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS;
      const effort = opts.effort ?? config.effort ?? "none";
      const { system, messages: body } = toAnthropicMessages(messages);

      const request: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: body,
        stream: true,
      };
      if (system) request.system = system;
      if (opts.temperature !== undefined) request.temperature = opts.temperature;
      if (tools.length > 0) {
        request.tools = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
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
      if (effort !== "none") {
        const budget = Math.min(THINKING_BUDGET[effort], Math.floor(maxTokens * 0.8));
        request.thinking = { type: "enabled", budget_tokens: budget };
        // Thinking and sampling are mutually exclusive on this shape.
        delete request.temperature;
      }

      // Anthropic reports cache reads and writes as fields of their OWN,
      // EXCLUDED from `input_tokens` — where the OpenAI shapes report a cached
      // subset already inside the prompt count. Reconciling here is what keeps
      // one usage record meaningful across both, and a cost figure honest.
      let inputTokens = 0;
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
            inputTokens = (usage?.input_tokens ?? 0) + cachedInputTokens + cacheWriteTokens;
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
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            const finishReason = mapStopReason(event.delta?.stop_reason);
            if (finishReason) yield { type: "finish", finishReason };
            break;
          }

          case "message_stop":
            yield {
              type: "usage",
              usage: { inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens },
            };
            break;
        }
      }
    },
  };
}
