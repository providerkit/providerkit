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
import { streamError } from "../errors.ts";
import { streamSse, apiUrl } from "../transport.ts";
import type {
  ChatMessage,
  ContentPart,
  Effort,
  FinishReason,
  ImagePart,
  Provider,
  ProviderChunk,
  StreamOptions,
  ToolDefinition,
} from "../types.ts";
import { toDataUri } from "../types.ts";
import { isStrictSchema } from "../schema.ts";

export interface ResponsesConfig {
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
  /**
   * Where this backend serves the endpoint, when it is not `/v1/responses`.
   * The ChatGPT subscription surface serves it at `/backend-api/codex/responses`
   * with no version segment, so that backend needs
   * `{ baseUrl: "https://chatgpt.com/backend-api/codex", path: "/responses" }`.
   * Without the override the POST 404s, and a 404 classifies as "model" — the
   * user is told the model id does not exist when the path was the problem.
   */
  path?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_PATH = "/v1/responses";

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

type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant"; content: ResponsesContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string | ResponsesContentPart[] };

function partsToResponses(content: string | ContentPart[]): ResponsesContentPart[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return content.map((part): ResponsesContentPart =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", image_url: toDataUri(part) },
  );
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
export function toResponsesInput(messages: readonly ChatMessage[]): {
  instructions?: string;
  input: unknown[];
} {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break; // lifted into `instructions` above

      case "user":
        input.push({ type: "message", role: "user", content: partsToResponses(message.content) });
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
        // Reasoning is deliberately NOT replayed. This shape wants the ORIGINAL
        // reasoning item back — its `rs_…` id, and under `store: false` its
        // `encrypted_content` blob — and the seam carries neither, only the
        // plain summary text a caller renders. A synthesized reasoning item is
        // rejected; omitting it costs only the model re-deriving its own chain
        // of thought, which is what every stateless caller already lives with.
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
}

interface ResponsesItem {
  type?: string;
  /** The output item's own id (`fc_…`) — what the argument deltas reference. */
  id?: string;
  /** The id a `function_call_output` must quote on the next turn. */
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  item?: ResponsesItem;
  response?: {
    usage?: ResponsesUsage;
    incomplete_details?: { reason?: string };
    error?: { message?: string; code?: string };
  };
  error?: { message?: string; code?: string };
  message?: string;
  code?: string;
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

export function createResponsesProvider(config: ResponsesConfig): Provider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const id = config.id ?? "openai-responses";

  return {
    id,
    model: config.model,

    async *createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      const effort = opts.effort ?? config.effort;
      const { instructions, input } = toResponsesInput(messages);

      const request: Record<string, unknown> = {
        model: opts.model ?? config.model,
        input,
        stream: true,
        // The caller's history is the entire state of a run. Server-side
        // storage adds a retention surface nobody asked for, and is refused
        // outright on zero-data-retention accounts.
        store: false,
      };
      if (instructions) request.instructions = instructions;
      const maxTokens = opts.maxTokens ?? config.maxTokens;
      if (maxTokens !== undefined) request.max_output_tokens = maxTokens;
      if (opts.temperature !== undefined) request.temperature = opts.temperature;
      if (opts.topP !== undefined) request.top_p = opts.topP;
      // No stop sequences on this shape — it has no equivalent field, and
      // inventing one would 400 the request rather than shorten the answer.
      if (effort && effort !== "none") {
        // `summary` is what switches the reasoning stream ON. Without it this
        // shape emits no reasoning_summary_text events at all, and a caller
        // rendering a thinking pane silently gets nothing while the tokens are
        // billed either way.
        request.reasoning = { effort, summary: "auto" };
      }
      if (tools.length > 0) {
        // Flat here — no nested `function` envelope, unlike chat/completions.
        request.tools = tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        }));
      }
      if (opts.toolChoice && opts.toolChoice !== "auto") {
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
      // output item id so parallel calls never cross wires. The seam's index is
      // ours to assign — `output_index` counts reasoning and message items too.
      const pending = new Map<string, PendingCall>();
      let nextIndex = 0;
      // This shape never states a stop reason on a clean finish, so it is
      // inferred from whether the turn produced a function call.
      let sawToolCall = false;

      for await (const data of streamSse({
        url: apiUrl(baseUrl, config.path ?? DEFAULT_PATH),
        headers: { authorization: `Bearer ${config.apiKey}`, ...config.headers },
        body: request,
        provider: id,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      })) {
        let event: ResponsesEvent;
        try {
          event = JSON.parse(data) as ResponsesEvent;
        } catch {
          continue; // a keep-alive or a frame we do not model
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
            if (item?.type !== "function_call" || !item.id) break;
            sawToolCall = true;
            const index = nextIndex++;
            // Normally empty here, but a backend that already has the whole
            // call sends it in the skeleton.
            const seeded = item.arguments ?? "";
            pending.set(item.id, {
              index,
              id: item.call_id ?? "",
              name: item.name ?? "",
              streamed: seeded,
            });
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
            const call = event.item_id ? pending.get(event.item_id) : undefined;
            if (!call || !event.delta) break;
            call.streamed += event.delta;
            yield { type: "delta", toolCalls: [{ index: call.index, arguments: event.delta }] };
            break;
          }

          case "response.output_item.done": {
            const item = event.item;
            if (item?.type !== "function_call") break;
            const known = item.id ? pending.get(item.id) : undefined;
            if (item.id) pending.delete(item.id);
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
            // out: re-emitting it whole concatenates the JSON with itself and
            // every argument parse fails. Send only what the deltas missed —
            // which is all of it when they never came.
            const tail =
              snapshot.length > known.streamed.length && snapshot.startsWith(known.streamed)
                ? snapshot.slice(known.streamed.length)
                : "";
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

          case "response.completed": {
            const usage = event.response?.usage;
            if (usage) yield usageChunk(usage);
            yield { type: "finish", finishReason: sawToolCall ? "tool_calls" : "stop" };
            return;
          }

          case "response.incomplete": {
            // A turn that ran out of output tokens still billed for its input,
            // and this event carries usage in the same shape as `completed`.
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
            throw streamError(id, event.error ?? { message: event.message, code: event.code });
        }
      }

      // The stream closed without a terminal event. Nothing is lost but the
      // finish reason and the usage record — every delta, tool-call fragment
      // included, was already yielded as it arrived.
    },
  };
}
