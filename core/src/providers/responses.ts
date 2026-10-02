// Responses-shape adapter — SSE from POST /v1/responses.
//
// OpenAI's second wire format, and the only one some backends expose: the
// ChatGPT subscription surface (chatgpt.com/backend-api/codex) has no
// chat/completions endpoint at all. It is not chat/completions with a new path
// — the input is an ITEM LIST rather than a message list, the stream is
// event-typed rather than choice-delta'd, and the terminal event carries the
// usage record instead of a trailing usage-only frame.
//
// The event names arrive on the SSE `event:` line and are repeated inside each
// payload's own `type`. The transport yields only `data:` payloads, so this
// adapter reads `type` — which is what survives, and what gateways agree on.
import { fileRefused, ProviderError, streamCut, streamError } from "../errors.ts";
import { streamSse, apiUrl } from "../transport.ts";
import type {
  ChatMessage,
  ContentPart,
  Effort,
  FinishReason,
  ImagePart,
  Provider,
  ProviderChunk,
  ServiceTier,
  StreamOptions,
  ToolDefinition,
} from "../types.ts";
import { toDataUri } from "../types.ts";
import { isStrictSchema, withoutPatterns } from "../schema.ts";
import { withConfiguredFallbacks, type ProviderFallbackConfig } from "../fallback.ts";
import { gateImages, type ImageLimits } from "../image.ts";

export interface ResponsesConfig extends ProviderFallbackConfig {
  apiKey: string;
  model: string;
  /** Any endpoint speaking the Responses format. Defaults to OpenAI itself. */
  baseUrl?: string;
  /** Names the provider in errors and logs. */
  id?: string;
  effort?: Effort;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  /** Extra request headers — where a subscription backend's account id goes
   *  (`ChatGPT-Account-Id`), which those backends reject the request without. */
  headers?: Record<string, string>;
  /** Header that carries `StreamOptions.sessionId`. When set and a call has no
   *  sessionId, one stable id for this provider instance rides instead. */
  sessionHeader?: string;
  /**
   * Where this backend serves the endpoint, when it is not `/v1/responses`.
   * The ChatGPT subscription surface serves it at `/backend-api/codex/responses`
   * with no version segment, so that backend needs
   * `{ baseUrl: "https://chatgpt.com/backend-api/codex", path: "/responses" }`.
   * Without the override the POST 404s, and a 404 classifies as "model" — the
   * user is told the model id does not exist when the path was the problem.
   */
  path?: string;
  /** What this backend accepts as an image. Each image it would refuse is
   *  replaced by a note naming the reason, instead of failing the request. */
  imageLimits?: ImageLimits;
  /** Ask for the encrypted reasoning items and replay them on the next turn,
   *  so the model keeps its chain of thought across a stateless turn. Only for
   *  backends that accept `include: ["reasoning.encrypted_content"]`. */
  replayReasoning?: boolean;
  /** Default `service_tier` for every call; `StreamOptions.serviceTier` wins. */
  serviceTier?: ServiceTier;
}

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_PATH = "/v1/responses";
const MUSE_SPARK_CONTRIBUTOR = "muse-spark-1.3-contributor";

function isMuseSparkContributor(model: string): boolean {
  return model === MUSE_SPARK_CONTRIBUTOR;
}

/** Go's Muse endpoint requires reasoning and starts at `minimal`; OpenAI's
 * Responses models accept `none` but stop at `high`. Keep that dialect here,
 * where the request shape already owns the spelling. */
function reasoningEffort(model: string, effort: Effort): string {
  if (isMuseSparkContributor(model)) return effort === "none" ? "minimal" : effort;
  return effort === "max" ? "high" : effort;
}

/**
 * `response.incomplete` means the turn was cut short, and the seam has one word
 * for that: "length". `content_filter` is the only other reason this shape
 * documents; anything new stays on "length" rather than reporting a clean stop,
 * because a caller that believes a truncated answer finished will act on it.
 */
function mapIncompleteReason(reason: string | undefined): FinishReason {
  return reason === "content_filter" ? "content_filter" : "length";
}

// ── input items ───────────────────────────────────────────────────────────

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

/** A reasoning item the backend made, sent back as it came. */
type ReplayedReasoning = { type: "reasoning" } & Record<string, unknown>;

function isReplayedReasoning(item: unknown): item is ReplayedReasoning {
  return typeof item === "object" && item !== null && "type" in item && item.type === "reasoning";
}

/** The most encrypted reasoning one request carries back. Newest turns win. */
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;

/** Which assistant messages get their reasoning replayed: this provider's own,
 *  newest first, until the cap. An older turn's reasoning is the cheapest to lose. */
function replayable(messages: readonly ChatMessage[], provider: string): Set<ChatMessage> {
  const keep = new Set<ChatMessage>();
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant" || message.reasoningItems?.provider !== provider) continue;
    bytes += JSON.stringify(message.reasoningItems.items).length;
    if (bytes > MAX_REPLAY_BYTES) break;
    keep.add(message);
  }
  return keep;
}

type ResponsesInputItem =
  | ReplayedReasoning
  | { type: "message"; role: "user" | "assistant"; content: ResponsesContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string | ResponsesContentPart[] };

function partsToResponses(
  content: string | ContentPart[],
  provider: string,
): ResponsesContentPart[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return content.map((part): ResponsesContentPart => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type === "file") throw fileRefused(provider, "Responses", part);
    return { type: "input_image", image_url: toDataUri(part) };
  });
}

/** A tool result is a bare string unless it carried images — then the content-
 *  array form, the only way to hand this shape a screenshot back. */
function toolOutput(
  content: string,
  images: readonly ImagePart[],
): string | ResponsesContentPart[] {
  if (images.length === 0) return content;
  const parts: ResponsesContentPart[] = [];
  if (content) parts.push({ type: "input_text", text: content });
  for (const image of images) parts.push({ type: "input_image", image_url: toDataUri(image) });
  return parts;
}

/**
 * Flatten a history into `instructions` plus the input item list.
 *
 * This shape has no system ROLE — the system prompt is a top-level
 * `instructions` string, and everything else is items. One assistant turn can
 * become several items (its text, then one `function_call` per tool it asked
 * for), which is why a message maps to a list rather than to one item.
 */
export function toResponsesInput(
  messages: readonly ChatMessage[],
  provider = "openai-responses",
): {
  instructions?: string;
  input: unknown[];
} {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const replayed = replayable(messages, provider);
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break; // lifted into `instructions` above

      case "user":
        input.push({
          type: "message",
          role: "user",
          content: partsToResponses(message.content, provider),
        });
        break;

      case "tool":
        input.push({
          // `call_id` — the id the model coined for the CALL, not the `fc_…` id
          // of the output item that carried it. Sending the wrong one is a 400
          // reading "No tool output found for function call", one turn later.
          type: "function_call_output",
          call_id: message.toolCallId,
          output: toolOutput(message.content, message.images ?? []),
        });
        break;

      case "assistant": {
        // `reasoning` (the summary a caller renders) is never replayed: this
        // shape wants the ORIGINAL item back, `rs_…` id and `encrypted_content`
        // blob included, and a synthesized one is rejected. `reasoningItems`
        // are those originals, so they go back first, but only to the provider
        // that made them. Without them the model re-derives its own chain of
        // thought, which is what every stateless caller already lives with.
        if (replayed.has(message)) {
          input.push(...message.reasoningItems!.items.filter(isReplayedReasoning));
        }
        if (message.content) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: message.content }],
          });
        }
        for (const call of message.toolCalls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          });
        }
        break;
      }
    }
  }

  return { ...(instructions ? { instructions } : {}), input };
}

// ── stream events ─────────────────────────────────────────────────────────

interface ResponsesUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
}

interface ResponsesItem {
  type?: string;
  /** The output item's own id (`fc_…`) — what the argument deltas reference. */
  id?: string;
  /** The id a `function_call_output` must quote on the next turn. */
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string;
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  /** xAI keys argument events by the CALL id instead of the item id. */
  call_id?: string;
  /** The whole argument string, on `function_call_arguments.done`. */
  arguments?: string;
  item?: ResponsesItem;
  response?: {
    /** `completed`, `incomplete` or `failed` — stated on the terminal event,
     *  and not always the one its `type` implies. */
    status?: string;
    usage?: ResponsesUsage;
    incomplete_details?: { reason?: string } | null;
    error?: { message?: string; code?: string } | null;
  };
  /** The ChatGPT backend's quota snapshot (`codex.rate_limits`). */
  rate_limits?: CodexRateLimits;
  credits?: { has_credits?: boolean; unlimited?: boolean };
  error?: { message?: string; code?: string };
  message?: string;
  code?: string;
  /** The ChatGPT backend's error frame states the HTTP status it stands for,
   *  and mirrors its `x-codex-*` rate-limit headers, beside `error`. */
  status_code?: number;
  headers?: Record<string, unknown>;
}

interface CodexWindow {
  used_percent?: number;
  reset_after_seconds?: number;
}

interface CodexRateLimits {
  limit_reached?: boolean;
  allowed?: boolean;
  primary?: CodexWindow;
  secondary?: CodexWindow;
}

/**
 * The quota wall a `codex.rate_limits` snapshot reports, if it is one.
 *
 * The snapshot rides ahead of the first output on every turn and is telemetry
 * — a full window the account's credits cover, or that the backend still
 * `allowed`, lets the turn proceed. It is only the reason when the stream then
 * closes without a response: that close is a spent window, not a dropped
 * socket, and retrying it walks every backup into the same wall. The fuller
 * window binds; cc-proxy took the primary's clock first and told a weekly wall
 * to come back in a few hours.
 */
function quotaWall(event: ResponsesEvent, provider: string): ProviderError | undefined {
  const limits = event.rate_limits;
  if (!limits?.limit_reached || limits.allowed) return undefined;
  if (event.credits?.has_credits || event.credits?.unlimited) return undefined;
  const windows = [limits.primary, limits.secondary].filter((w): w is CodexWindow => !!w);
  const binding = windows.sort((a, b) => (b.used_percent ?? 0) - (a.used_percent ?? 0))[0];
  const after = binding?.reset_after_seconds;
  return new ProviderError(provider, "quota", `${provider}: the usage limit has been reached`, {
    ...(after !== undefined && after >= 0
      ? { retryAfterMs: after * 1000, resetAtMs: Date.now() + after * 1000 }
      : {}),
  });
}

function usageChunk(usage: ResponsesUsage): ProviderChunk {
  return {
    type: "usage",
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      // Already a SUBSET of input_tokens on this shape, as on chat/completions
      // — and the only signal that its automatic prefix caching is working.
      cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
      // Reasoning tokens are billed INSIDE output_tokens, not beside them.
      outputTokens: usage.output_tokens ?? 0,
      ...(usage.output_tokens_details?.reasoning_tokens !== undefined
        ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
        : {}),
    },
  };
}

/** What has already gone out for one in-flight function call — identity and
 *  arguments both — so the authoritative snapshot on `.done` can be diffed
 *  against it instead of duplicated. */
interface PendingCall {
  index: number;
  id: string;
  name: string;
  streamed: string;
}

/** The part of an authoritative snapshot the deltas have not already sent.
 *  Re-emitting it whole concatenates the JSON with itself and every argument
 *  parse fails; all of it goes when no delta came. */
function unsentTail(snapshot: string, streamed: string): string {
  return snapshot.length > streamed.length && snapshot.startsWith(streamed)
    ? snapshot.slice(streamed.length)
    : "";
}

export function createResponsesProvider(config: ResponsesConfig): Provider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const id = config.id ?? "openai-responses";
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
      const museContributor = isMuseSparkContributor(model);
      const requestTools = museContributor && opts.toolChoice === "none" ? [] : tools;
      const { instructions, input } = toResponsesInput(
        config.imageLimits ? gateImages(messages, config.imageLimits) : messages,
        id,
      );

      const request: Record<string, unknown> = {
        model,
        input,
        stream: true,
        // The caller's history is the entire state of a run. Server-side
        // storage adds a retention surface nobody asked for, and is refused
        // outright on zero-data-retention accounts.
        store: false,
      };
      if (instructions) request.instructions = instructions;
      if (config.replayReasoning) request.include = ["reasoning.encrypted_content"];
      const maxTokens = opts.maxTokens ?? config.maxTokens;
      if (maxTokens !== undefined) request.max_output_tokens = maxTokens;
      if (opts.temperature !== undefined) request.temperature = opts.temperature;
      if (opts.topP !== undefined) request.top_p = opts.topP;
      // No stop sequences on this shape — it has no equivalent field, and
      // inventing one would 400 the request rather than shorten the answer.
      if (effort) {
        const level = reasoningEffort(model, effort);
        // `summary` is what switches the reasoning stream ON. Without it this
        // shape emits no reasoning_summary_text events at all, and a caller
        // rendering a thinking pane silently gets nothing while the tokens are
        // billed either way. OpenAI accepts `none`; Go's Muse Contributor
        // requires reasoning, so its lowest equivalent is `minimal`.
        request.reasoning =
          level === "none" ? { effort: "none" } : { effort: level, summary: "auto" };
      }
      if (requestTools.length > 0) {
        // Flat here — no nested `function` envelope, unlike chat/completions.
        request.tools = requestTools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: withoutPatterns(tool.inputSchema),
          // Said either way, never left to the default. Strict demands every
          // property required and every object closed; on a schema that is not
          // already shaped that way the backend makes optional arguments
          // mandatory, and the model starts filling in parameters nobody asked
          // for (cc-proxy, 0.1.15). Where the schema already qualifies, the
          // enforcement is free.
          strict: isStrictSchema(tool.inputSchema),
        }));
        if (opts.parallelToolCalls === false) request.parallel_tool_calls = false;
      }
      // The cache affinity key. Without one the backend spreads a
      // conversation's turns across cache shards, and a re-sent prefix misses.
      if (opts.sessionId) request.prompt_cache_key = opts.sessionId;
      const serviceTier = opts.serviceTier ?? config.serviceTier;
      if (serviceTier) request.service_tier = serviceTier;
      // Muse Contributor accepts only `auto`. `none` has an exact wire-level
      // equivalent: send no tools. Required/named choices stay explicit and let
      // the endpoint refuse a promise it cannot keep.
      const omitMuseTools = museContributor && opts.toolChoice === "none";
      if (opts.toolChoice && opts.toolChoice !== "auto" && !omitMuseTools) {
        request.tool_choice =
          typeof opts.toolChoice === "string"
            ? opts.toolChoice
            : { type: "function", name: opts.toolChoice.name };
      }
      if (opts.json) {
        // The schema rides in `text.format`, not `response_format`.
        request.text = {
          format: {
            type: "json_schema",
            name: opts.json.name,
            schema: opts.json.schema,
            strict: opts.json.strict ?? isStrictSchema(opts.json.schema),
          },
        };
      }

      // Tool calls arrive as an item skeleton plus argument deltas; keyed by the
      // output item id AND the call id, whichever the backend quotes, so
      // parallel calls never cross wires. The seam's index is ours to assign —
      // `output_index` counts reasoning and message items too.
      const pending = new Map<string, PendingCall>();
      const pendingFor = (itemId?: string, callId?: string) =>
        (itemId ? pending.get(itemId) : undefined) ?? (callId ? pending.get(callId) : undefined);
      let nextIndex = 0;
      // This shape never states a stop reason on a clean finish, so it is
      // inferred from whether the turn produced a function call.
      let sawToolCall = false;
      let wall: ProviderError | undefined;
      let produced = false;
      const reasoningItems: unknown[] = [];
      const reasoningChunk = (): ProviderChunk[] =>
        reasoningItems.length
          ? [{ type: "delta", reasoningItems: { provider: id, items: reasoningItems } }]
          : [];

      for await (const data of streamSse({
        url: apiUrl(baseUrl, config.path ?? DEFAULT_PATH),
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...(config.sessionHeader
            ? { [config.sessionHeader]: opts.sessionId ?? instanceSessionId }
            : {}),
          ...config.headers,
        },
        body: request,
        provider: id,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
      })) {
        let event: ResponsesEvent;
        try {
          event = JSON.parse(data) as ResponsesEvent;
        } catch {
          continue; // a keep-alive or a frame we do not model
        }
        if (event.type?.endsWith(".delta") || event.type === "response.output_item.added") {
          produced = true;
        }

        switch (event.type) {
          case "response.output_text.delta":
            if (event.delta) yield { type: "delta", content: event.delta };
            break;

          // Two names for the same stream: `reasoning_summary_text` is the
          // redacted summary the API returns, `reasoning_text` the raw trace
          // the ChatGPT backend streams. A caller wants whichever it gets.
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            if (event.delta) yield { type: "delta", reasoning: event.delta };
            break;

          case "response.output_item.added": {
            const item = event.item;
            if (item?.type !== "function_call") break;
            // OpenAI names the item (`fc_…`) and keys argument deltas by it;
            // xAI's Grok sends no item id at all and keys them by `call_id`.
            // Requiring the item id dropped every Grok call here, and the
            // turn came back as a nameless call with empty arguments.
            const key = item.id ?? item.call_id;
            if (!key) break;
            sawToolCall = true;
            const index = nextIndex++;
            // Normally empty here, but a backend that already has the whole
            // call sends it in the skeleton.
            const seeded = item.arguments ?? "";
            const call: PendingCall = {
              index,
              id: item.call_id ?? "",
              name: item.name ?? "",
              streamed: seeded,
            };
            pending.set(key, call);
            if (item.call_id) pending.set(item.call_id, call);
            // Only the fields the skeleton actually states. An empty `id` here
            // is not "unknown", it is a wrong answer: a consumer takes the last
            // stated value, so `""` written into the slot survives the real
            // `call_id` arriving on `.done`.
            yield {
              type: "delta",
              toolCalls: [
                {
                  index,
                  ...(item.call_id ? { id: item.call_id } : {}),
                  ...(item.name ? { name: item.name } : {}),
                  ...(seeded ? { arguments: seeded } : {}),
                },
              ],
            };
            break;
          }

          case "response.function_call_arguments.delta": {
            const call = pendingFor(event.item_id, event.call_id);
            if (!call || !event.delta) break;
            call.streamed += event.delta;
            yield { type: "delta", toolCalls: [{ index: call.index, arguments: event.delta }] };
            break;
          }

          // xAI states the finished argument string here and NOT on the
          // closing item, which carries only `call_id`. Skipped, a call whose
          // deltas never came reaches the caller with empty arguments.
          case "response.function_call_arguments.done": {
            const call = pendingFor(event.item_id, event.call_id);
            const tail = call ? unsentTail(event.arguments ?? "", call.streamed) : "";
            if (!call || !tail) break;
            call.streamed += tail;
            yield { type: "delta", toolCalls: [{ index: call.index, arguments: tail }] };
            break;
          }

          case "response.output_item.done": {
            const item = event.item;
            // Kept whole and emitted once, at the end of the turn: it is the
            // backend's own record, and it only means something complete.
            if (config.replayReasoning && item?.type === "reasoning") {
              reasoningItems.push(item);
              break;
            }
            if (item?.type !== "function_call") break;
            const known = pendingFor(item.id, item.call_id);
            if (item.id) pending.delete(item.id);
            if (item.call_id) pending.delete(item.call_id);
            const snapshot = item.arguments ?? "";

            if (!known) {
              // A backend that emits neither the skeleton nor the deltas — the
              // whole call arrives here or not at all. Without a `call_id`
              // there is nothing to answer it with: the caller's
              // `function_call_output` would quote `""` and take a 400 reading
              // "No tool output found for function call" one turn later, so the
              // call is dropped rather than handed over unrunnable. Dropping is
              // only possible here, where nothing has been streamed for it yet.
              if (!item.call_id) break;
              sawToolCall = true;
              yield {
                type: "delta",
                toolCalls: [
                  {
                    index: nextIndex++,
                    id: item.call_id,
                    ...(item.name ? { name: item.name } : {}),
                    arguments: snapshot,
                  },
                ],
              };
              break;
            }

            // The snapshot is authoritative, but the fragments already went
            // out: send only what the deltas missed.
            const tail = unsentTail(snapshot, known.streamed);
            // `.done` restates the identity, and on a backend that leaves it
            // out of the skeleton this is the only frame that carries it. It
            // rides last so it WINS: the alternative is a caller assembling a
            // nameless call it has no tool to dispatch, quoting an empty
            // `call_id` back on the turn after.
            const restated = {
              ...(item.call_id && item.call_id !== known.id ? { id: item.call_id } : {}),
              ...(item.name && item.name !== known.name ? { name: item.name } : {}),
              ...(tail ? { arguments: tail } : {}),
            };
            if (Object.keys(restated).length > 0) {
              yield { type: "delta", toolCalls: [{ index: known.index, ...restated }] };
            }
            break;
          }

          // `response.done` is the same terminal event under the name
          // OpenCode's gateway uses.
          case "response.completed":
          case "response.done": {
            const response = event.response;
            // A terminal event names its own outcome, and the type is not
            // always it: a `completed` that states `failed` or carries an
            // error failed, and one that states `incomplete` was cut. Read as
            // a clean stop, either is a broken turn reported as a finished one.
            if (response?.status === "failed" || response?.error) {
              throw streamError(id, response.error ?? { message: "response failed" });
            }
            yield* reasoningChunk();
            if (response?.usage) yield usageChunk(response.usage);
            if (response?.status === "incomplete") {
              yield {
                type: "finish",
                finishReason: mapIncompleteReason(response.incomplete_details?.reason),
              };
              return;
            }
            yield { type: "finish", finishReason: sawToolCall ? "tool_calls" : "stop" };
            return;
          }

          case "codex.rate_limits":
            wall = quotaWall(event, id);
            break;

          case "response.incomplete": {
            // A turn that ran out of output tokens still billed for its input,
            // and this event carries usage in the same shape as `completed`.
            yield* reasoningChunk();
            const usage = event.response?.usage;
            if (usage) yield usageChunk(usage);
            yield {
              type: "finish",
              finishReason: mapIncompleteReason(event.response?.incomplete_details?.reason),
            };
            return;
          }

          // The two ways this shape reports a failure after its headers went
          // out: a terminal `response.failed`, or a bare error frame from a
          // gateway in front of it.
          case "response.failed":
            throw streamError(id, event.response?.error);

          case "error":
          case "response.error":
            // The status and the window clocks ride beside `error`. Without
            // them a spent Codex window reads as an unnamed in-stream failure:
            // floored to overload, then retried and walked across every backup
            // on the same account wall.
            throw streamError(
              id,
              event.error
                ? { ...event.error, status_code: event.status_code, headers: event.headers }
                : { message: event.message, code: event.code },
            );
        }
      }

      // The stream closed without a terminal event. If the backend's last word
      // was a spent window and nothing was produced, that is why; otherwise
      // the stream was cut (see `streamCut`).
      if (wall && !produced) throw wall;
      throw streamCut(id);
    },
  };

  return withConfiguredFallbacks(provider, config);
}
