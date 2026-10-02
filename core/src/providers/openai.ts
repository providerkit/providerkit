// OpenAI-shape adapter — SSE from POST /v1/chat/completions.
//
// This is the dialect most gateways speak, so one adapter serves OpenAI,
// OpenRouter, DeepSeek, GLM, Kimi, Groq, Together, vLLM, Ollama and LM Studio.
// Their divergences are small and named where they appear.
import { fileRefused, ProviderError, streamCut, streamError } from "../errors.ts";
import { streamSse, apiUrl } from "../transport.ts";
import { attributionHeaders } from "../attribution.ts";
import type {
  ChatMessage,
  ContentPart,
  Effort,
  FinishReason,
  JsonWithTools,
  Provider,
  ProviderChunk,
  ServiceTier,
  StreamOptions,
  ToolDefinition,
} from "../types.ts";
import { toDataUri } from "../types.ts";
import { isStrictSchema, schemaPrompt } from "../schema.ts";
import { withConfiguredFallbacks, type ProviderFallbackConfig } from "../fallback.ts";

export interface OpenAIConfig extends ProviderFallbackConfig {
  apiKey: string;
  model: string;
  /** Any OpenAI-compatible endpoint. Defaults to OpenAI itself. */
  baseUrl?: string;
  /** Path appended to baseUrl. Defaults to /v1/chat/completions. Set
   *  /chat/completions when the base already includes the API version, such as
   *  a gateway using /v4 rather than /v1. */
  path?: string;
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
  /**
   * How a json request rides when the SAME call also carries tools.
   *
   * `response_format` — the default — sends both, which is what the shape
   * documents and what most models honour. `prompt` drops the response format
   * from those calls only and sends the schema as prompt instead: the shape the
   * Anthropic adapter has always used, and the reason this failure cannot
   * happen there.
   *
   * It needs a knob because a model that cannot serve both does not say so. Its
   * decoder is pinned to the schema, the tool call has nowhere to go, and the
   * model writes the announcement instead — "let me look that up for you" — and
   * the turn ends looking like a model with no initiative rather than a request
   * that made the call impossible. Nothing is logged, because nothing failed.
   *
   * Measured 2026-09-07, one request, sampled: `z-ai/glm-5.3-flash` called its
   * tool 0/10 under a response format and 8/8 without one, `z-ai/glm-5.3` 0/5,
   * `deepseek-v4-flash-0731` 0/5, `gemini-3.8-flash` 3/10, while
   * `gemini-3.5-flash-lite`, `gpt-5.6-luna` and `qwen3.8-flash` were 10/10.
   *
   * No default is right for everyone, which is why this stays a setting rather
   * than becoming a rule: the same run put `qwen3.8-flash` at 1/6 with the
   * schema in the prompt against 6/6 with the response format. Don't guess it
   * from the model card — `probeJsonWithTools` asks the model itself, in one
   * call. `StreamOptions.jsonWithTools` overrides this per call.
   */
  jsonWithTools?: JsonWithTools;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /**
   * App attribution for OpenRouter's rankings — the site URL rides as
   * `HTTP-Referer`, the app name as `X-Title`. Public, not secret. Sent
   * whenever set (other vendors ignore unknown headers); an explicit entry
   * in `headers` always wins.
   */
  siteUrl?: string;
  /**
   * App name for OpenRouter's rankings, sent as `X-Title`. See `siteUrl`.
   */
  siteName?: string;
  /**
   * Pin OpenRouter to preferred upstream hosts so the PROMPT CACHE stays warm
   * across rounds. The cache lives on the upstream host's account and default
   * routing hops between them, and every hop is a cold cache — worse latency
   * and higher effective input cost. Fallbacks stay on: this is a preference,
   * not a lock.
   */
  providerOrder?: string[];
  /**
   * Automatically pin OpenRouter calls to the first-party model vendor's host
   * when hitting openrouter.ai and providerOrder is not passed. Defaults to true.
   */
  pinHost?: boolean;
  /** Header that carries `StreamOptions.sessionId`. When set and a call has
   *  no sessionId, the provider's own per-instance id rides instead, so the
   *  gateway never sees a call without one. */
  sessionHeader?: string;
  /** Send `X-Initiator`: `user` when the last message is the user's, else
   *  `agent`. GitHub Copilot bills a premium request per `user` turn and lets
   *  the agent's own follow-ups (tool results) ride free. */
  initiatorHeader?: boolean;
  /** Default `service_tier` for every call; `StreamOptions.serviceTier` wins. */
  serviceTier?: ServiceTier;
}

const DEFAULT_BASE_URL = "https://api.openai.com";

/**
 * Known first-party host slugs on OpenRouter for route pinning.
 * Pinning keeps consecutive turns on the vendor's own endpoint, preserving
 * the server-side KV prompt cache across rounds.
 */
const OPENROUTER_HOSTS: Record<string, string> = {
  anthropic: "anthropic",
  "arcee-ai": "arcee-ai",
  cohere: "cohere",
  deepseek: "deepseek",
  google: "google-ai-studio",
  meta: "meta",
  minimax: "minimax",
  mistralai: "mistral",
  moonshotai: "moonshotai",
  morph: "morph",
  openai: "openai",
  perplexity: "perplexity",
  qwen: "alibaba",
  stepfun: "stepfun",
  tencent: "tencent",
  upstage: "upstage",
  "x-ai": "xai",
  "z-ai": "z-ai",
  zai: "z-ai",
};

function isOpenRouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.includes("openrouter.ai");
  } catch {
    return false;
  }
}

export function openRouterHostFor(baseUrl: string, model: string): string | undefined {
  if (!isOpenRouter(baseUrl)) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  const vendor = model.slice(0, slash).toLowerCase();
  return OPENROUTER_HOSTS[vendor];
}

/** The spellings of "think this hard" across the dialects that share this
 *  adapter. `off` sends nothing and leaves the model on its own default. */
export type EffortDialect = "openai" | "openrouter" | "deepseek" | "opencode-go" | "off";

/**
 * How `none` is said on OpenRouter, per model id: the `reasoning.effort` that
 * turns the model's thinking off, or the lowest measured one where every off
 * is refused.
 *
 * An id that is not listed sends nothing, and that default is the point. An
 * explicit off is a 400 on a model whose reasoning is mandatory: GLM 5.3 Flash
 * and gpt-5-mini both answer "Reasoning is mandatory for this endpoint and
 * cannot be disabled." So a universal off would break every call to one. An
 * omitted field only costs reasoning tokens, and only on a model that thinks by
 * default. So an id gets a row once it is measured both ways: with the field
 * omitted, and with the spelling in its row.
 *
 * An adopter's matrix, 2026-09-27: one pinned host per model
 * (`allow_fallbacks: false`), two runs per cell, reasoning tokens with the
 * field omitted and with each of three offs (top-level `reasoning_effort:
 * "none"`, `reasoning.effort: "none"`, `reasoning.enabled: false`).
 *
 * - GLM 5.3 Flash @Together: 516, and 2,000 (cut off at `max_tokens`), with
 *   the field omitted. Every off was a 400. In the 2026-09-26 sweep (a
 *   production classify body sent to each of 28 hosts alone), 18 hosts thought
 *   with the field omitted (a 2026-09-14 reading, host unknown, saw no
 *   thinking), and `low` gave 0 reasoning tokens on every host that answered
 *   it but Sail Research (1) and Wafer (inverted: about 420 with `low`, 1
 *   omitted).
 * - gpt-5-mini @OpenAI: 320 and 320 with the field omitted, and every off was
 *   a 400. A follow-up the same day, same host, two runs: `minimal` gave 0 and
 *   0 (48 and 50 output tokens), `low` 64 and 64. So `minimal` is its floor.
 *   Only this exact id: gpt-5 and gpt-5-nano were not measured.
 * - MiMo v2.6 Flash @Xiaomi: 57 and 47 with the field omitted (103–151
 *   @DeepInfra in the 2026-09-26 sweep), 0 with every off. Its row names
 *   `none`, so the table varies one field.
 * - Not listed, on purpose. DeepSeek V4 Flash @DeepInfra: 0 in every cell, and
 *   the 2026-09-26 sweep saw it think at `low`. Gemini 2.5 Flash and Flash
 *   Lite @AI Studio: 0 in every cell.
 */
const OPENROUTER_NONE: ReadonlyMap<string, "low" | "minimal" | "none"> = new Map([
  ["z-ai/glm-5.3-flash", "low"],
  ["openai/gpt-5-mini", "minimal"],
  ["xiaomi/mimo-v2.6-flash", "none"],
]);

/**
 * Effort → the request fields THIS endpoint accepts.
 *
 * One knob, three incompatible spellings, and the differences are not cosmetic:
 *
 * - **On OpenRouter, "do not think" has no spelling that works on every
 *   model.** GLM 5.3 Flash and gpt-5-mini answer every explicit off with
 *   `400 "Reasoning is mandatory for this endpoint and cannot be disabled."`,
 *   MiMo v2.6 Flash takes one, and DeepSeek V4 Flash thinks at `low` and not
 *   with the field omitted. So `none` is said per model, from
 *   `OPENROUTER_NONE`, which also says why an unlisted model gets nothing.
 *   Naming a level raises it — the accepted values are `low`, `high` and
 *   `max` (`medium` and `xhigh` are accepted too, but our vocabulary has no
 *   use for them).
 * - **DeepSeek V4 defaults thinking ON** on its own API, so `none` has to be an
 *   explicit refusal there. The same word is a different request on each
 *   dialect, and on OpenRouter on each model: the spelling belongs to the
 *   endpoint, never to the caller.
 * - **OpenAI** takes `reasoning_effort`, and `none` is one of its values — not
 *   the absence of the field. GPT-5.1 both accepted `none` and made it the
 *   default; everything from GPT-5 back still defaults to `medium`. So sending
 *   nothing is NOT a way to say "do not think": on every model released before
 *   5.1 it means medium, and thinking tokens come out of the same budget as the
 *   answer. A capped turn then spends its whole allowance thinking and returns
 *   empty with `finish_reason: "length"`.
 *
 * An absent effort sends nothing on every dialect and for every model: the
 * seam's rule is that a knob the caller never touched is a knob the provider
 * still owns. On OpenRouter that makes `none` and "never asked" the same
 * request for every model outside `OPENROUTER_NONE`, and a different one for
 * the models in it.
 *
 * `model` is the id the request names. Without it, `none` on OpenRouter sends
 * nothing, as it always has.
 */
export function effortParams(
  dialect: EffortDialect,
  effort: Effort | undefined,
  model?: string,
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
      // `none` is said per model (see OPENROUTER_NONE): an explicit off where
      // one was measured to work, the lowest measured level where every off is
      // a 400, and nothing for a model nobody measured. Naming a level RAISES
      // it: the accepted values are low, high and max (`medium`, `xhigh` and
      // `minimal` exist on the wire too; `minimal` rides only as a row's none).
      // The refusal that once looked like "OpenRouter cannot be told not to
      // think" was `reasoning.enabled: false` — never sent (pinned by the test
      // below).
      //
      // `max` rides verbatim here — the enum clamp below is DeepSeek/OpenAI's
      // shape (DeepSeek auto-bumps past its own top, OpenAI's top IS high);
      // OpenRouter takes `max` as named (measured live 2026-09-14).
      if (effort !== "none") return { reasoning: { effort } };
      return model !== undefined && OPENROUTER_NONE.has(model)
        ? { reasoning: { effort: OPENROUTER_NONE.get(model) } }
        : {};
    case "opencode-go":
      return goEffortParams(effort, model);
    case "openai":
      return { reasoning_effort: level ?? "none" };
    case "off":
      return {};
  }
}

/**
 * OpenCode Go's chat models each take a different set of `reasoning_effort`
 * values (cc-proxy's table, measured on live traffic). A level a model can't
 * take is refused here, rather than sent as a 400 or quietly changed into a
 * level the caller didn't ask for.
 *
 * - GLM 5.2 and 5.3 take only `high` and `max`, with no way to turn thinking
 *   off. `none` gets `high`, the least they offer.
 * - DeepSeek V4 takes `low` to `max`. `none` gets `low`, its least.
 * - MiMo takes `low`, `medium` and `high`, and `none` (measured 2026-09-27 on
 *   `mimo-v2.6-flash`; cc-proxy maps it to `low` instead).
 * - Every other Go chat model gets the OpenAI spelling, as before.
 */
function goEffortParams(effort: Effort, model = ""): Record<string, unknown> {
  const id = model.toLowerCase();
  const refuse = (allowed: string): never => {
    throw new ProviderError(
      "opencode-go",
      "invalid",
      `opencode-go: ${model} can't take reasoning effort "${effort}". Use ${allowed}.`,
    );
  };
  const level = (value: string) => ({ reasoning_effort: value });
  if (/glm-5[-.p]?[23]/.test(id)) {
    if (effort === "none" || effort === "high") return level("high");
    return effort === "max" ? level("max") : refuse("high or max");
  }
  if (id.includes("deepseek-v4")) return level(effort === "none" ? "low" : effort);
  if (id.includes("mimo"))
    return effort === "max" ? refuse("none, low, medium or high") : level(effort);
  return level(effort === "max" ? "high" : effort);
}

/** Gateways named after their dialect get it for free; everything else keeps
 *  the dialect this adapter is named for. */
function dialectFor(id: string): EffortDialect {
  if (id === "openrouter") return "openrouter";
  if (id === "deepseek") return "deepseek";
  if (id === "opencode-go") return "opencode-go";
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

function partsToOpenAI(content: string | ContentPart[], provider: string): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "file") throw fileRefused(provider, "OpenAI", part);
    return { type: "image_url", image_url: { url: toDataUri(part) } };
  });
}

/**
 * Assistant turns carry `reasoning_content` when the history has it — thinking
 * providers require the prior turn's chain-of-thought replayed on a turn that
 * made a tool call. A caller running a turn with thinking OFF must strip it
 * first (`stripReasoning`); the two cannot be mixed.
 */
export function toOpenAIMessages(messages: readonly ChatMessage[], provider = "openai"): unknown[] {
  const out: unknown[] = [];
  // Images from a run of tool results, held until the run ends. See "tool".
  let toolImages: unknown[] = [];
  const flushToolImages = () => {
    if (toolImages.length > 0) out.push({ role: "user", content: toolImages });
    toolImages = [];
  };
  for (const message of messages) {
    if (message.role !== "tool") flushToolImages();
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: message.content });
        break;

      case "user":
        out.push({ role: "user", content: partsToOpenAI(message.content, provider) });
        break;

      case "tool":
        out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
        // This dialect has no image slot on a tool message — a `tool` role takes
        // text and nothing else. A screenshot a tool hands back therefore
        // follows as a user message, which is the only way the model ever sees
        // it. Dropped instead, the turn reads as a tool that returned words
        // about a picture nobody was shown.
        //
        // It follows the whole RUN of tool results, not this one: an assistant
        // turn that made parallel calls needs every answer before any user
        // message, and an image wedged between two of them is a 400 that
        // classifies as "invalid" — never retried, never walked to a backup.
        for (const image of message.images ?? []) {
          toolImages.push({ type: "image_url", image_url: { url: toDataUri(image) } });
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
  flushToolImages();
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
    completion_tokens_details?: { reasoning_tokens?: number };
    /** DeepSeek's native API reports the cache-hit count here instead of in
     *  `prompt_tokens_details`, and it is absent from every OpenAI SDK type. */
    prompt_cache_hit_tokens?: number;
    /** Kimi (Moonshot) puts it at the top level of `usage`. */
    cached_tokens?: number;
    /** OpenRouter only, from here down: what the call cost, in its credits,
     *  which are US dollars. */
    cost?: unknown;
    is_byok?: boolean;
    cost_details?: { upstream_inference_cost?: unknown } | null;
  } | null;
  /** Present only on the in-band failure below — never beside a choice.
   *  `code` is the numeric HTTP status on the gateways, a slug on OpenAI. */
  error?: { message?: string; code?: string | number; type?: string };
}

/** A price off the wire, or undefined when it is not one. A negative or a
 *  string falls back to the caller's rate rather than billing a nonsense
 *  number. 0 is a real price: the one a free model charges. */
function price(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * What an OpenRouter call cost, in USD, or undefined when it did not say.
 *
 * Nothing has to ask for it. OpenRouter's usage-accounting docs (read
 * 2026-09-26) say every response now carries the full usage record, cost
 * included, on the last frame of a stream, and that `usage: { include: true }`
 * is deprecated and does nothing. Measured the same day: a streamed call and a
 * plain one, neither sending the flag, both came back with `usage.cost`, the
 * stream on its last frame. So the request does not send it.
 *
 * With the caller's own provider key (BYOK), `cost` is only OpenRouter's fee.
 * The inference is billed to the caller's provider account and arrives as
 * `cost_details.upstream_inference_cost`, so the call cost the two together.
 * Without that second figure there is no whole bill to report, and the
 * caller's rate prices the call instead.
 *
 * Exported for the other OpenRouter wire that bills the same way: Jev's.
 */
export function openRouterCostUsd(usage: {
  cost?: unknown;
  is_byok?: boolean;
  cost_details?: { upstream_inference_cost?: unknown } | null;
}): number | undefined {
  const cost = price(usage.cost);
  if (cost === undefined || usage.is_byok !== true) return cost;
  const upstream = price(usage.cost_details?.upstream_inference_cost);
  return upstream === undefined ? undefined : cost + upstream;
}

export function createOpenAIProvider(config: OpenAIConfig): Provider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const id = config.id ?? "openai";
  // Keyed on the host, not the id: the host is who sends the bill, and
  // `usage.cost` is its field in its unit. Another gateway that sends a
  // `cost` has not said what it means.
  const reportsCost = isOpenRouter(baseUrl);
  const instanceSessionId = config.sessionHeader ? crypto.randomUUID() : undefined;

  const provider: Provider = {
    id,
    model: config.model,

    async *createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      const effort = opts.effort ?? config.effort;
      const model = opts.model ?? config.model;

      const body = toOpenAIMessages(messages, id);
      const request: Record<string, unknown> = {
        model,
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
      const serviceTier = opts.serviceTier ?? config.serviceTier;
      if (serviceTier) request.service_tier = serviceTier;
      Object.assign(request, effortParams(config.effortDialect ?? dialectFor(id), effort, model));
      if (tools.length > 0) {
        request.tools = tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        }));
        // Only beside tools: OpenAI refuses the field on a request without any.
        if (opts.parallelToolCalls === false) request.parallel_tool_calls = false;
      }
      if (opts.toolChoice && opts.toolChoice !== "auto") {
        request.tool_choice =
          typeof opts.toolChoice === "string"
            ? opts.toolChoice
            : { type: "function", function: { name: opts.toolChoice.name } };
      }
      if (opts.json) {
        // A json request sharing its call with tools is a bet that the model
        // serves both at once, and on several models it silently loses — see
        // `jsonWithTools` on OpenAIConfig for what that costs and what it was
        // measured at. A caller that has measured its own model says so there;
        // here the only job is to leave the response format off those calls, so
        // the schema reaches the model the one way nothing can suppress.
        const promptCarried =
          tools.length > 0 && (opts.jsonWithTools ?? config.jsonWithTools) === "prompt";
        const enforced =
          !promptCarried &&
          (config.jsonMode ?? (id === "openai" ? "schema" : "object")) === "schema";
        // Nothing at all on a prompt-carried call: `json_object` pins the
        // decoder every bit as hard as `json_schema` does — 0/8 tool calls on
        // the same model — so half-dropping the format would buy nothing.
        if (!promptCarried) {
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
        }
        if (!enforced) {
          // …but nothing left standing carries the shape. `json_object` asks
          // for valid JSON and says NOTHING about what is in it, and a
          // prompt-carried call sends no format at all — either way `opts.json`
          // is half a request: the model returns syntactically perfect JSON of
          // a shape nobody asked for, and the caller's parse fails on the happy
          // path where no retry looks. The schema has to reach the model as
          // prompt — the same promise the Anthropic adapter keeps, for the same
          // reason.
          //
          // Appended rather than folded into the system prompt, because the
          // cache on this shape is a PREFIX cache: a per-call schema placed up
          // front would invalidate the whole conversation behind it every time
          // the schema changed.
          body.push({ role: "system", content: schemaPrompt(opts.json.schema) });
        }
      }
      const pinOrder = config.providerOrder?.length
        ? config.providerOrder
        : config.pinHost !== false
          ? (() => {
              const pinned = openRouterHostFor(baseUrl, model);
              return pinned ? [pinned] : undefined;
            })()
          : undefined;

      if (pinOrder?.length) {
        request.provider = { order: pinOrder, allow_fallbacks: true };
      }

      const defaultPath = /\/v\d+[^/]*$/i.test(baseUrl.replace(/\/+$/, ""))
        ? "/chat/completions"
        : "/v1/chat/completions";

      let ended = false;
      for await (const data of streamSse({
        url: apiUrl(baseUrl, config.path ?? defaultPath),
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...attributionHeaders(config, config.headers),
          ...(config.sessionHeader
            ? { [config.sessionHeader]: opts.sessionId ?? instanceSessionId }
            : {}),
          ...(config.initiatorHeader
            ? { "X-Initiator": messages.at(-1)?.role === "user" ? "user" : "agent" }
            : {}),
          ...config.headers,
        },
        body: request,
        provider: id,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
        onDone: () => {
          ended = true;
        },
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
          // Three spellings for the same subset. DeepSeek's native endpoint and
          // Kimi each use their own field, and reading only the standard one
          // bills every cached token at the full input rate — on an agent loop,
          // where the re-sent prefix is overwhelmingly hits, that overstates a
          // run by up to 10×.
          const cached =
            chunk.usage.prompt_tokens_details?.cached_tokens ??
            chunk.usage.prompt_cache_hit_tokens ??
            chunk.usage.cached_tokens ??
            0;
          const reportedCostUsd = reportsCost ? openRouterCostUsd(chunk.usage) : undefined;
          yield {
            type: "usage",
            usage: {
              inputTokens: input,
              // Already a SUBSET of prompt_tokens on this shape — unlike
              // Anthropic's, which excludes them. No reconciling to do.
              cachedInputTokens: cached,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              ...(chunk.usage.completion_tokens_details?.reasoning_tokens !== undefined
                ? { reasoningTokens: chunk.usage.completion_tokens_details.reasoning_tokens }
                : {}),
              ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
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

        if (choice.finish_reason) ended = true;
        const finishReason = mapFinishReason(choice.finish_reason);
        if (finishReason) yield { type: "finish", finishReason };
      }
      // Either proof will do: some gateways send `[DONE]` with no finish, and
      // some a finish with no `[DONE]`. Neither means the socket closed early.
      if (!ended) throw streamCut(id);
    },
  };

  return withConfiguredFallbacks(provider, config);
}
