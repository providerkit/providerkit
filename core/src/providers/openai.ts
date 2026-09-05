// OpenAI-shape adapter — SSE from POST /v1/chat/completions.
//
// This is the dialect most gateways speak, so one adapter serves OpenAI,
// OpenRouter, DeepSeek, GLM, Kimi, Groq, Together, vLLM, Ollama and LM Studio.
// Their divergences are small and named where they appear.
import { streamError } from "../errors.ts";
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
import { isStrictSchema, schemaPrompt } from "../schema.ts";

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  /** Any OpenAI-compatible endpoint. Defaults to OpenAI itself. */
  baseUrl?: string;
  /** Names the provider in errors and logs — "openrouter", "deepseek", … It
   *  also picks the effort dialect below, unless `effortDialect` overrides. */
  id?: string;
  effort?: Effort;
  /**
   * Which spelling of "think this hard" this endpoint accepts. Inferred from
   * `id`; set it when the gateway is not named after its dialect, or to `off`
   * for one that rejects the field outright.
   */
  effortDialect?: EffortDialect;
  /**
   * `schema` sends a `json_schema` response format, `object` plain JSON mode.
   * Defaults to `schema` for OpenAI itself and `object` everywhere else, which
   * is the only setting every gateway accepts.
   */
  jsonMode?: "schema" | "object";
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

/** The spellings of "think this hard" across the dialects that share this
 *  adapter. `off` sends nothing and leaves the model on its own default. */
export type EffortDialect = "openai" | "openrouter" | "deepseek" | "off";

/**
 * Effort → the request fields THIS endpoint accepts.
 *
 * One knob, three incompatible spellings, and the differences are not cosmetic:
 *
 * - **OpenRouter's off switch is the effort, never the `enabled` flag.**
 *   `reasoning.enabled: false` IS refused by models that always think — GLM 5.3
 *   Flash answers `400 "Reasoning is mandatory for this endpoint and cannot be
 *   disabled."`, which cost one app its onboarding read. That measurement is
 *   still why nothing here ever emits that field. But it was read as "OpenRouter
 *   has no off switch" and `none` was floored to `low` on the strength of it,
 *   which is a different field: `none` is a member of OpenRouter's own effort
 *   enum, an unsupported level is mapped to the nearest rather than refused, and
 *   an app has been sending it in production throughout. The floor was buying a
 *   thinking pass on every turn that asked for none.
 * - **DeepSeek V4 defaults thinking ON**, so `none` has to be an explicit
 *   refusal. That is the case proving OpenRouter's floor is a constraint and
 *   not a preference for always thinking.
 * - **OpenAI** takes `reasoning_effort`, and `none` is one of its values — not
 *   the absence of the field. GPT-5.1 both accepted `none` and made it the
 *   default; everything from GPT-5 back still defaults to `medium`. So sending
 *   nothing is NOT a way to say "do not think": on every model released before
 *   5.1 it means medium, and thinking tokens come out of the same budget as the
 *   answer. A capped turn then spends its whole allowance thinking and returns
 *   empty with `finish_reason: "length"`.
 *
 * An absent effort sends nothing on every dialect: the seam's rule is that a
 * knob the caller never touched is a knob the provider still owns. `none` is
 * the caller touching it, and the two must not produce the same request.
 */
export function effortParams(
  dialect: EffortDialect,
  effort: Effort | undefined,
): Record<string, unknown> {
  if (!effort) return {};
  const level = effort === "max" ? "high" : effort === "none" ? null : effort;
  switch (dialect) {
    case "deepseek":
      if (level === null) return { thinking: { type: "disabled" } };
      // A graded level rides only when it asks for LESS. DeepSeek auto-bumps a
      // complex agent or tool request past its own default, and naming the top
      // tier here caps exactly the turns that most need the bump — so `high`
      // and `max` say "on" and leave the ceiling where DeepSeek puts it, while
      // `low` and `medium` mean what they say.
      return level === "high"
        ? { thinking: { type: "enabled" } }
        : { thinking: { type: "enabled" }, reasoning_effort: level };
    case "openrouter":
      // Its own enum runs xhigh > high > medium > low > minimal > none, so `max`
      // has a real tier here and clamping it to `high` throws the top one away —
      // 0.95 of the budget against 0.8. Naming it is safe even where a model
      // cannot do it: OpenRouter maps an unsupported level to its nearest rather
      // than refusing the request.
      return { reasoning: { effort: effort === "max" ? "xhigh" : (level ?? "none") } };
    case "openai":
      return { reasoning_effort: level ?? "none" };
    case "off":
      return {};
  }
}

/** Gateways named after their dialect get it for free; everything else keeps
 *  the dialect this adapter is named for. */
function dialectFor(id: string): EffortDialect {
  if (id === "openrouter") return "openrouter";
  if (id === "deepseek") return "deepseek";
  return "openai";
}

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
  const out: unknown[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: message.content });
        break;

      case "user":
        out.push({ role: "user", content: partsToOpenAI(message.content) });
        break;

      case "tool":
        out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
        // This dialect has no image slot on a tool message — a `tool` role takes
        // text and nothing else. A screenshot a tool hands back therefore
        // follows as its own user message, which is the only way the model ever
        // sees it. Dropped instead, the turn reads as a tool that returned
        // words about a picture nobody was shown.
        if (message.images?.length) {
          out.push({
            role: "user",
            content: message.images.map((image) => ({
              type: "image_url",
              image_url: { url: toDataUri(image) },
            })),
          });
        }
        break;

      case "assistant": {
        const assistant: Record<string, unknown> = {
          role: "assistant",
          // Nullable content beside tool_calls is what this shape expects, but
          // several gateways reject a bare null — "" satisfies both.
          content: message.content || "",
        };
        if (message.reasoning) assistant.reasoning_content = message.reasoning;
        // Verbatim, under the name the gateway gave it. Reshaped or dropped, the
        // model loses its own record of how it reached the tool round it is
        // being asked to continue.
        if (message.reasoningDetails?.length) {
          assistant.reasoning_details = message.reasoningDetails;
        }
        if (message.toolCalls?.length) {
          assistant.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          }));
        }
        out.push(assistant);
        break;
      }
    }
  }
  return out;
}

interface OpenAIChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      /** OpenRouter's normalized reasoning payload, on the final delta. */
      reasoning_details?: unknown[];
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
    /** DeepSeek's native API reports the cache-hit count here instead of in
     *  `prompt_tokens_details`, and it is absent from every OpenAI SDK type. */
    prompt_cache_hit_tokens?: number;
  } | null;
  /** Present only on the in-band failure below — never beside a choice.
   *  `code` is the numeric HTTP status on the gateways, a slug on OpenAI. */
  error?: { message?: string; code?: string | number; type?: string };
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

      const body = toOpenAIMessages(messages);
      const request: Record<string, unknown> = {
        model: opts.model ?? config.model,
        messages: body,
        stream: true,
        // Without this the usage record never arrives and every call costs
        // zero — a silent, total loss of the ledger.
        stream_options: { include_usage: true },
      };
      const maxTokens = opts.maxTokens ?? config.maxTokens;
      if (maxTokens !== undefined) request.max_tokens = maxTokens;
      if (opts.temperature !== undefined) request.temperature = opts.temperature;
      if (opts.topP !== undefined) request.top_p = opts.topP;
      if (opts.stopSequences?.length) request.stop = opts.stopSequences;
      Object.assign(request, effortParams(config.effortDialect ?? dialectFor(id), effort));
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
        const enforced = (config.jsonMode ?? (id === "openai" ? "schema" : "object")) === "schema";
        request.response_format = enforced
          ? {
              type: "json_schema",
              json_schema: {
                name: opts.json.name,
                schema: opts.json.schema,
                strict: opts.json.strict ?? isStrictSchema(opts.json.schema),
              },
            }
          : // Everything else gets plain JSON mode. Schema ENFORCEMENT is
            // OpenAI's; the gateways and the vendors behind them offer JSON
            // mode at best, and several answer a flat 400 to a `json_schema`
            // block. The seam's rule makes this safe either way: a provider's
            // "guaranteed" JSON is not one, so the caller validates regardless —
            // this only decides whether the request is accepted.
            { type: "json_object" };
        if (!enforced) {
          // …but `json_object` asks for valid JSON and says NOTHING about its
          // shape, so on its own it turns `opts.json` into half a request: the
          // model returns syntactically perfect JSON of a shape nobody asked
          // for, and the caller's parse fails on the happy path where no retry
          // looks. The schema has to reach the model as prompt — the same
          // promise the Anthropic adapter keeps, for the same reason.
          //
          // Appended rather than folded into the system prompt, because the
          // cache on this shape is a PREFIX cache: a per-call schema placed up
          // front would invalidate the whole conversation behind it every time
          // the schema changed.
          body.push({ role: "system", content: schemaPrompt(opts.json.schema) });
        }
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

        // A failure the backend reports after its headers went out. The
        // gateways speaking this dialect — OpenRouter above all — report a
        // throttle or an upstream outage this way rather than as a status
        // line, and a frame carrying `error` carries no choices: unread, it
        // falls through both branches below and the turn ends as a successful
        // zero-token completion nobody retries.
        if (chunk.error) throw streamError(id, chunk.error);

        // A usage-only frame carries no choices — this shape sends it last.
        if (chunk.usage) {
          const input = chunk.usage.prompt_tokens ?? 0;
          // Two spellings for the same subset. DeepSeek's native endpoint uses
          // its own field, and reading only the standard one bills every cached
          // token at the full input rate — on an agent loop, where the re-sent
          // prefix is overwhelmingly hits, that overstates a run by up to 10×.
          const cached =
            chunk.usage.prompt_tokens_details?.cached_tokens ??
            chunk.usage.prompt_cache_hit_tokens ??
            0;
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
          if (delta.reasoning_details?.length) {
            out.reasoningDetails = delta.reasoning_details;
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
