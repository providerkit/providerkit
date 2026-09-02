// OpenAI-shape adapter — SSE from POST /v1/chat/completions.
//
// This is the dialect most gateways speak, so one adapter serves OpenAI,
// OpenRouter, DeepSeek, GLM, Kimi, Groq, Together, vLLM, Ollama and LM Studio.
// Their divergences are small and named where they appear.
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
import { toDataUri } from "../types.ts";

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  /** Any OpenAI-compatible endpoint. Defaults to OpenAI itself. */
  baseUrl?: string;
  /** Names the provider in errors and logs — "openrouter", "deepseek", … */
  id?: string;
  effort?: Effort;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /**
   * Pin OpenRouter to preferred upstream hosts so the PROMPT CACHE stays warm
   * across rounds. The cache lives on the upstream host's account and default
   * routing hops between them, and every hop is a cold cache — worse latency
   * and higher effective input cost. Fallbacks stay on: this is a preference,
   * not a lock.
   */
  providerOrder?: string[];
}

const DEFAULT_BASE_URL = "https://api.openai.com";

function mapFinishReason(reason: string | null | undefined): FinishReason | undefined {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return undefined;
  }
}

function partsToOpenAI(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: toDataUri(part) } },
  );
}

/**
 * Assistant turns carry `reasoning_content` when the history has it — thinking
 * providers require the prior turn's chain-of-thought replayed on a turn that
 * made a tool call. A caller running a turn with thinking OFF must strip it
 * first (`stripReasoning`); the two cannot be mixed.
 */
export function toOpenAIMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: partsToOpenAI(message.content) };
      case "tool":
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
      case "assistant": {
        const out: Record<string, unknown> = {
          role: "assistant",
          // Nullable content beside tool_calls is what this shape expects, but
          // several gateways reject a bare null — "" satisfies both.
          content: message.content || "",
        };
        if (message.reasoning) out.reasoning_content = message.reasoning;
        if (message.toolCalls?.length) {
          out.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          }));
        }
        return out;
      }
    }
  });
}

interface OpenAIChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

export function createOpenAIProvider(config: OpenAIConfig): Provider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const id = config.id ?? "openai";

  return {
    id,
    model: config.model,

    async *createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      const effort = opts.effort ?? config.effort;

      const request: Record<string, unknown> = {
        model: opts.model ?? config.model,
        messages: toOpenAIMessages(messages),
        stream: true,
        // Without this the usage record never arrives and every call costs
        // zero — a silent, total loss of the ledger.
        stream_options: { include_usage: true },
      };
      const maxTokens = opts.maxTokens ?? config.maxTokens;
      if (maxTokens !== undefined) request.max_tokens = maxTokens;
      if (opts.temperature !== undefined) request.temperature = opts.temperature;
      if (effort && effort !== "none") request.reasoning_effort = effort;
      if (tools.length > 0) {
        request.tools = tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        }));
      }
      if (opts.toolChoice && opts.toolChoice !== "auto") {
        request.tool_choice =
          typeof opts.toolChoice === "string"
            ? opts.toolChoice
            : { type: "function", function: { name: opts.toolChoice.name } };
      }
      if (opts.json) {
        request.response_format = {
          type: "json_schema",
          json_schema: { name: opts.json.name, schema: opts.json.schema, strict: true },
        };
      }
      if (config.providerOrder?.length) {
        request.provider = { order: config.providerOrder, allow_fallbacks: true };
      }

      for await (const data of streamSse({
        url: apiUrl(baseUrl, "/v1/chat/completions"),
        headers: { authorization: `Bearer ${config.apiKey}`, ...config.headers },
        body: request,
        provider: id,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      })) {
        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(data) as OpenAIChunk;
        } catch {
          continue;
        }

        // A usage-only frame carries no choices — this shape sends it last.
        if (chunk.usage) {
          const input = chunk.usage.prompt_tokens ?? 0;
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          yield {
            type: "usage",
            usage: {
              inputTokens: input,
              // Already a SUBSET of prompt_tokens on this shape — unlike
              // Anthropic's, which excludes them. No reconciling to do.
              cachedInputTokens: cached,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            },
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta) {
          const out: ProviderChunk = { type: "delta" };
          let has = false;
          if (delta.content) {
            out.content = delta.content;
            has = true;
          }
          // `reasoning_content` is DeepSeek's field; `reasoning` is
          // OpenRouter's normalized one. Whichever arrives is the same thing.
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (reasoning) {
            out.reasoning = reasoning;
            has = true;
          }
          if (delta.tool_calls?.length) {
            out.toolCalls = delta.tool_calls.map((call, position) => ({
              // Some gateways omit `index` entirely on single-tool turns.
              index: call.index ?? position,
              ...(call.id ? { id: call.id } : {}),
              ...(call.function?.name ? { name: call.function.name } : {}),
              ...(call.function?.arguments !== undefined
                ? { arguments: call.function.arguments }
                : {}),
            }));
            has = true;
          }
          if (has) yield out;
        }

        const finishReason = mapFinishReason(choice.finish_reason);
        if (finishReason) yield { type: "finish", finishReason };
      }
    },
  };
}
