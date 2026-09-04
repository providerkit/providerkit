// Gemini adapter — SSE from POST /v1beta/models/{model}:streamGenerateContent.
//
// Native Gemini, not its OpenAI-compatible shim: only this endpoint carries
// thought signatures, and a signature dropped on the way back costs the model
// its own chain of thought on the next turn. Written straight against the REST
// wire rather than @google/genai, because this package ships zero dependencies
// and the SDK is a Node-shaped one.
import { streamError } from "../errors.ts";
import { parseToolArgs } from "../tool-args.ts";
import { streamSse, apiUrl } from "../transport.ts";
import type {
  ChatMessage,
  Effort,
  FinishReason,
  Provider,
  ProviderChunk,
  StreamOptions,
  ToolCallDelta,
  ToolChoice,
  ToolDefinition,
} from "../types.ts";

export interface GeminiConfig {
  apiKey: string;
  model: string;
  /** Any endpoint speaking the Generative Language REST dialect — a proxy or
   *  gateway. Defaults to the Generative Language API.
   *
   *  Not Vertex: it serves `/v1/projects/…/locations/…/publishers/google/models`
   *  and authenticates with a Bearer token, and both the path and the
   *  `x-goog-api-key` header are fixed below. Vertex would be its own adapter. */
  baseUrl?: string;
  /** Names the provider in errors and logs. */
  id?: string;
  /** Bound default; a per-call `effort` overrides it. */
  effort?: Effort;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * Gemini 3's thinking dial. `none` is MINIMAL rather than a 0 budget: the Pro
 * models reject a hard 0, so the only way to say "think as little as possible"
 * without a 400 is the lowest level.
 *
 * Sent as the REST enum NAMES. The SDK's `ThinkingLevel` members serialize to
 * exactly these strings, so nothing is lost by writing them out.
 */
const THINKING_LEVEL: Record<Effort, string> = {
  none: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  max: "HIGH",
};

/** A turn in Gemini's history. `model` is its word for the assistant. */
export interface GeminiContent {
  role: "user" | "model";
  parts: unknown[];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tool-call arguments as the OBJECT Gemini's `functionCall.args` requires.
 *
 * A bare JSON scalar or array is wrapped rather than rejected — the shared
 * `parseToolArgs` drops a non-object as a protocol violation, which is right
 * for reading a fresh tool call and wrong here, where replaying `{}` deletes an
 * argument the model did send. Everything else defers to it, so a truncated or
 * double-escaped argument string is salvaged on replay rather than degraded to
 * `{}`.
 */
function parseArgs(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isJsonObject(parsed)) return { value: parsed };
  } catch {
    // Unparseable — the salvage below is the whole point.
  }
  return parseToolArgs(json);
}

/** Same rule for a tool RESULT, which `functionResponse.response` also requires
 *  as an object. Plain text (the common case) rides under `output`. */
function toResponseObject(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    return isJsonObject(parsed) ? parsed : { output: parsed };
  } catch {
    return { output: content };
  }
}

/**
 * Our messages → Gemini contents.
 *
 * Three shape differences the rest of the adapter must not have to know about:
 * system text is lifted out and merged into ONE instruction (Gemini takes a
 * single one, not a role in the turn list); assistant turns are role `model`
 * and carry tool calls as `functionCall` parts with the thought signature
 * beside them; tool results are role `user` with a `functionResponse` part
 * naming the FUNCTION, since Gemini pairs a result to its call by name.
 */
export function toGeminiContents(messages: readonly ChatMessage[]): {
  system?: string;
  contents: GeminiContent[];
} {
  let system = "";
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        system = system ? `${system}\n\n${message.content}` : message.content;
        break;

      case "user":
        contents.push({
          role: "user",
          parts:
            typeof message.content === "string"
              ? [{ text: message.content }]
              : message.content.map((part) =>
                  part.type === "text"
                    ? { text: part.text }
                    : { inlineData: { mimeType: part.mimeType, data: part.data } },
                ),
        });
        break;

      case "assistant": {
        const parts: unknown[] = [];
        if (message.content) parts.push({ text: message.content });
        for (const call of message.toolCalls ?? []) {
          parts.push({
            functionCall: { id: call.id, name: call.name, args: parseArgs(call.arguments) },
            // Replayed verbatim: this is the model's own reasoning token, and
            // without it the next turn starts from a chain of thought that
            // no longer includes the call it just made.
            ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
          });
        }
        // An assistant turn with neither text nor calls has no representation
        // here, and an empty `parts` is a 400.
        if (parts.length > 0) contents.push({ role: "model", parts });
        break;
      }

      case "tool":
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                id: message.toolCallId,
                name: message.name,
                response: toResponseObject(message.content),
              },
            },
            ...(message.images ?? []).map((image) => ({
              inlineData: { mimeType: image.mimeType, data: image.data },
            })),
          ],
        });
        break;
    }
  }

  return { ...(system ? { system } : {}), contents };
}

/**
 * `auto` and an absent choice are Gemini's own default, so the field is omitted
 * rather than sent as AUTO. `required` and a pinned tool are both mode ANY —
 * the pin is the allow-list, not the mode.
 */
function toToolConfig(choice: ToolChoice | undefined): unknown {
  if (choice === undefined || choice === "auto") return undefined;
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
      return "content_filter";
    default:
      return "stop";
  }
}

interface GeminiPart {
  text?: string;
  /** Marks the parts that are the model's reasoning. Absent on the answer. */
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
}

/** Google's `google.rpc.Status`: an HTTP `code`, the canonical `status` name,
 *  and `details` — which is where RetryInfo's `retryDelay` rides. */
interface GeminiStatus {
  code?: number;
  message?: string;
  status?: string;
  details?: unknown;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  /** Present only on the in-band failure below — never on a real candidate. */
  error?: GeminiStatus;
}

export function createGeminiProvider(config: GeminiConfig): Provider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const id = config.id ?? "gemini";

  return {
    id,
    model: config.model,

    async *createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      const effort = opts.effort ?? config.effort;
      const maxTokens = opts.maxTokens ?? config.maxTokens;
      const { system, contents } = toGeminiContents(messages);

      const generationConfig: Record<string, unknown> = {};
      if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
      if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
      if (opts.topP !== undefined) generationConfig.topP = opts.topP;
      if (opts.stopSequences?.length) generationConfig.stopSequences = opts.stopSequences;
      // No effort means the model's own dynamic thinking. Sending MINIMAL here
      // would switch that off for a caller who never asked, which is the whole
      // reason the seam treats an absent effort as "never sent".
      if (effort) generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL[effort] };
      if (opts.json) {
        generationConfig.responseMimeType = "application/json";
        // `responseJsonSchema` takes JSON Schema as written; `responseSchema`
        // is Gemini's own trimmed dialect and rejects most of what a real
        // schema carries.
        generationConfig.responseJsonSchema = opts.json.schema;
      }

      const request: Record<string, unknown> = { contents, generationConfig };
      // A Content, not the bare string the SDK accepts — REST rejects a string.
      if (system) request.systemInstruction = { parts: [{ text: system }] };
      if (tools.length > 0) {
        request.tools = [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              // Same rule as the response schema: `parameters` is the trimmed
              // dialect, `parametersJsonSchema` is the schema we actually wrote.
              parametersJsonSchema: tool.inputSchema,
            })),
          },
        ];
        // Pointless without declarations, and Gemini 400s on a tool config that
        // names a function it was never given.
        const toolConfig = toToolConfig(opts.toolChoice);
        if (toolConfig) request.toolConfig = toolConfig;
      }

      // A model id copied out of Gemini's docs is often already `models/…`, and
      // the doubled segment 404s as "model not found" — a confusing way to
      // learn about a prefix.
      const model = (opts.model ?? config.model).replace(/^models\//, "");

      // Gemini reports the finish reason on a candidate that can arrive AFTER
      // the chunk carrying the function calls, so a turn's tool use has to be
      // remembered rather than read off the final chunk.
      let sawFunctionCalls = false;
      let callIndex = 0;

      for await (const data of streamSse({
        // Without `?alt=sse` the response is one long JSON array that only
        // parses once complete, which is not a stream.
        url: apiUrl(baseUrl, `/v1beta/models/${model}:streamGenerateContent?alt=sse`),
        headers: { "x-goog-api-key": config.apiKey, ...config.headers },
        body: request,
        provider: id,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      })) {
        let chunk: GeminiResponse;
        try {
          chunk = JSON.parse(data) as GeminiResponse;
        } catch {
          continue;
        }

        // `?alt=sse` commits to 200 the moment the headers go out, so a
        // throttle or an overload landing after that arrives here as a
        // google.rpc.Status in the body rather than as a status line.
        if (chunk.error) throw streamError(id, chunk.error);

        if (chunk.usageMetadata) {
          const usage = chunk.usageMetadata;
          yield {
            type: "usage",
            usage: {
              inputTokens: usage.promptTokenCount ?? 0,
              // Thoughts bill as OUTPUT, and Gemini reports them OUTSIDE
              // candidatesTokenCount — leaving them out undercounts a thinking
              // turn by most of what it cost.
              outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
              cachedInputTokens: usage.cachedContentTokenCount ?? 0,
            },
          };
        }

        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        // One chunk can carry several parts of each kind. They are coalesced
        // per kind so the seam sees one reasoning delta and one content delta
        // per chunk, in that order, rather than interleaved fragments.
        let reasoning = "";
        let content = "";
        const toolCalls: ToolCallDelta[] = [];
        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            if (part.thought) reasoning += part.text;
            else content += part.text;
            continue;
          }
          const call = part.functionCall;
          if (!call) continue;
          const index = callIndex++;
          toolCalls.push({
            index,
            // Gemini omits the id on a single-call turn, and the seam's
            // consumers pair a result back to its call by id.
            id: call.id ?? `call_${index}`,
            ...(call.name ? { name: call.name } : {}),
            // Whole and already assembled — unlike the OpenAI shape, Gemini
            // never fragments an argument object across chunks.
            arguments: JSON.stringify(call.args ?? {}),
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          });
        }

        if (reasoning) yield { type: "delta", reasoning };
        if (content) yield { type: "delta", content };
        if (toolCalls.length > 0) {
          sawFunctionCalls = true;
          yield { type: "delta", toolCalls };
        }

        if (candidate.finishReason) {
          yield {
            type: "finish",
            // A turn that called tools finishes as tool_calls whatever the
            // candidate says — Gemini routinely reports STOP there, and a
            // caller reading that as "done" drops the tool round entirely.
            finishReason: sawFunctionCalls ? "tool_calls" : mapFinishReason(candidate.finishReason),
          };
        }
      }
    },
  };
}
