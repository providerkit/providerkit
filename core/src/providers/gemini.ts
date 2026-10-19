// Gemini adapter — SSE from POST /v1beta/models/{model}:streamGenerateContent.
//
// Native Gemini, not its OpenAI-compatible shim: only this endpoint carries
// thought signatures, and a signature dropped on the way back costs the model
// its own chain of thought on the next turn. Written straight against the REST
// wire rather than @google/genai, because this package ships zero dependencies
// and the SDK is a Node-shaped one.
import { repairHistory } from "../context.ts";
import { ProviderError, streamCut, streamError, type ErrorKind } from "../errors.ts";
import { schemaPrompt, toGeminiToolSchema } from "../schema.ts";
import { parseToolArgs, settleToolCalls } from "../tool-args.ts";
import { streamSse, apiUrl } from "../transport.ts";
import { withConfiguredFallbacks, type ProviderFallbackConfig } from "../fallback.ts";
import type {
  ChatMessage,
  Effort,
  FinishReason,
  JsonWithTools,
  Provider,
  ProviderChunk,
  StreamOptions,
  ToolCallDelta,
  ToolChoice,
  ToolDefinition,
} from "../types.ts";

export interface GeminiConfig extends ProviderFallbackConfig {
  apiKey: string;
  model: string;
  /** Any endpoint speaking the Generative Language REST dialect, including a proxy or
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
  /**
   * How the schema rides on a call that also carries tools. See
   * {@link JsonWithTools}. Note that it is the model's answer, not the
   * endpoint's: measured 2026-09-07, `gemini-3.5-flash` and
   * `gemini-3.5-flash-lite` called their tool under `responseJsonSchema` every
   * time, while `gemini-3.8-flash` managed 3/10. `probeJsonWithTools` asks the
   * one you actually serve. Overridable per call.
   */
  jsonWithTools?: JsonWithTools;
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

/**
 * Gemini 2.x thinking budget dial (tokens). Gemini 2.5 takes `thinkingBudget`
 * (0 disables thinking) and has no level. Every newer model takes
 * `thinkingLevel`, and Google has said the next ones answer a budget with a
 * 400 instead of remapping it.
 */
const GEMINI_2_THINKING_BUDGET: Record<Effort, number> = {
  none: 0,
  low: 1024,
  medium: 4096,
  high: 8192,
  max: 16384,
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
 * A bare JSON scalar or array is wrapped rather than rejected. The shared
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
 *
 * A run of results is ONE user turn: Gemini answers a model turn's parallel
 * calls with every response together, and spread over several turns it 400s
 * that the response count does not match the call count. The responses go
 * first, in call order, and the run's images follow them all, the way the
 * OpenAI dialect places them.
 */
export function toGeminiContents(messages: readonly ChatMessage[]): {
  system?: string;
  contents: GeminiContent[];
} {
  let system = "";
  const contents: GeminiContent[] = [];
  // The open run of tool results: its parts, and how many lead with a response.
  let results: { parts: unknown[]; responses: number } | undefined;

  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") results = undefined;
    switch (message.role) {
      case "system":
        system = system ? `${system}\n\n${message.content}` : message.content;
        break;

      case "user":
        // An image and a file ride the same way, as bytes and their media
        // type. This is the one wire that takes a file.
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

      case "tool": {
        if (!results) {
          results = { parts: [], responses: 0 };
          contents.push({ role: "user", parts: results.parts });
        }
        results.parts.splice(results.responses, 0, {
          functionResponse: {
            id: message.toolCallId,
            name: message.name,
            response: toResponseObject(message.content),
          },
        });
        results.responses += 1;
        for (const image of message.images ?? []) {
          results.parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
        }
        break;
      }
    }
  }

  return { ...(system ? { system } : {}), contents };
}

/**
 * `auto` and an absent choice are Gemini's own default, so the field is omitted
 * rather than sent as AUTO. `required` and a pinned tool are both mode ANY:
 * the pin is the allow-list, not the mode.
 */
function toToolConfig(choice: ToolChoice | undefined): unknown {
  if (choice === undefined || choice === "auto") return undefined;
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
}

/**
 * Every finish reason Gemini documents (the generate-content reference, read
 * 2026-10-19), decided one by one. Anything this switch did not name used to
 * read as `stop`, so a call the model botched (`MALFORMED_FUNCTION_CALL`) or a
 * turn that ended for no stated reason (`OTHER`) came back as a finished, empty
 * answer. After a tool result, `requireContent` takes an empty `stop` as the
 * model choosing to say nothing, so nothing retried it.
 */
function mapFinishReason(provider: string, reason: string): FinishReason {
  const fail = (kind: ErrorKind, why: string): never => {
    throw new ProviderError(provider, kind, `${provider} ended the turn on ${reason}: ${why}`, {
      code: reason,
    });
  };
  switch (reason) {
    case "STOP":
      return "stop";
    // The output cap. CONTINUATION is the same cap with a token to carry on,
    // which this adapter never sends back.
    case "MAX_TOKENS":
    case "CONTINUATION":
      return "length";
    // A filter on what was said or drawn. The text so far stands and the
    // finish says why it ended, as `content_filter` does on every wire. A
    // retry would mostly meet the same filter.
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "SPII":
    case "RECITATION":
    case "LANGUAGE":
    case "ESCALATION":
    case "IMAGE_SAFETY":
    case "IMAGE_PROHIBITED_CONTENT":
    case "IMAGE_RECITATION":
      return "content_filter";
    // The request lost a thought signature, and the same request loses it
    // again. A bug in what was sent, so nothing retries it.
    case "MISSING_THOUGHT_SIGNATURE":
      return fail("invalid", "the request is missing a thought signature");
    // The account was limited for a policy violation. Benched like a refused
    // key, so a key pool moves to another project.
    case "PUP_LIMITED_DISABLED":
      return fail("auth", "the account is limited or disabled");
    // The model broke its own turn: a call it could not form, one with no tool
    // offered, too many in a row, a malformed reply, an image it never made.
    // The same request usually works on the next try.
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
    case "TOO_MANY_TOOL_CALLS":
    case "MALFORMED_RESPONSE":
    case "NO_IMAGE":
      return fail("overload", "the model broke its own turn");
    // These say nothing about why, and a reason added after this list says
    // nothing we can read. Neither proves the answer is whole.
    case "OTHER":
    case "IMAGE_OTHER":
    case "FINISH_REASON_UNSPECIFIED":
    default:
      return fail("overload", "it gave no reason that shows the answer is complete");
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
 *  and `details`, which is where RetryInfo's `retryDelay` rides. */
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
  /** Present only on the in-band failure below. Never on a real candidate. */
  error?: GeminiStatus;
  /** A prompt Gemini refused outright: no candidate at all, just the reason. */
  promptFeedback?: { blockReason?: string };
}

export function createGeminiProvider(config: GeminiConfig): Provider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const id = config.id ?? "gemini";

  const provider: Provider = {
    id,
    model: config.model,

    async *createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      const effort = opts.effort ?? config.effort;
      const maxTokens = opts.maxTokens ?? config.maxTokens;
      // Repaired first: a result with no call, or a call with no result, is a
      // 400 that loses the turn. See repairHistory.
      const { system, contents } = toGeminiContents(repairHistory(messages).messages);

      // A model id copied out of Gemini's docs is often already `models/…`, and
      // the doubled segment 404s as "model not found" — a confusing way to
      // learn about a prefix.
      const model = (opts.model ?? config.model).replace(/^models\//, "");
      const isGemini3 = /gemini-3/i.test(model);
      // Not `!isGemini3`: `gemini-flash-latest` and models newer than 3 are not
      // Gemini 3 either, and they must get a level.
      const isGemini2 = /gemini-2/i.test(model);

      const generationConfig: Record<string, unknown> = {};
      if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
      // `temperature` and `topP` are never sent: Gemini 3.6 Flash and later ignore
      // them and the next models reject them. Dropping them, rather than refusing,
      // keeps a fallback chain that shares one set of options working.
      if (opts.stopSequences?.length) generationConfig.stopSequences = opts.stopSequences;
      // No effort means the model's own dynamic thinking. Sending MINIMAL / 0 here
      // would switch that off for a caller who never asked, which is the whole
      // reason the seam treats an absent effort as "never sent".
      if (effort) {
        generationConfig.thinkingConfig = isGemini2
          ? { thinkingBudget: GEMINI_2_THINKING_BUDGET[effort] }
          : { thinkingLevel: THINKING_LEVEL[effort] };
      }
      // A schema that shares its call with tools pins the decoder, and a pinned
      // decoder cannot emit a functionCall — the model narrates the call it
      // could not make and the turn ends, with nothing logged. See
      // `jsonWithTools` for what that costs and which models it costs it on.
      //
      // On Gemini 2.x it is not a bet at all: the API refuses the combination
      // outright with `400 "Function calling with a response mime type:
      // 'application/json' is unsupported"`, so the prompt is the only way a
      // schema travels beside tools there. Gemini 3 serves both, and there the
      // setting is the caller's measured preference.
      const promptCarried =
        tools.length > 0 &&
        ((opts.jsonWithTools ?? config.jsonWithTools) === "prompt" || !isGemini3);
      if (opts.json && !promptCarried) {
        generationConfig.responseMimeType = "application/json";
        // `responseJsonSchema` takes JSON Schema as written; `responseSchema`
        // is Gemini's own trimmed dialect and rejects most of what a real
        // schema carries.
        generationConfig.responseJsonSchema = toGeminiToolSchema(opts.json.schema);
      }

      if (opts.serviceTier) {
        throw new ProviderError(
          id,
          "invalid",
          `${id}: Gemini has no service tier switch. Leave serviceTier unset for Gemini models.`,
        );
      }
      const request: Record<string, unknown> = { contents, generationConfig };
      // A Content, not the bare string the SDK accepts — REST rejects a string.
      // The prompt-carried schema rides as a second part, after the caller's
      // own text: this shape's cache is a prefix too, so a per-call schema in
      // front of the conversation would cold-start it on every change.
      const systemParts = [
        ...(system ? [{ text: system }] : []),
        ...(opts.json && promptCarried ? [{ text: schemaPrompt(opts.json.schema) }] : []),
      ];
      if (systemParts.length > 0) request.systemInstruction = { parts: systemParts };
      if (tools.length > 0) {
        // Gemini has no switch for one call per turn. Sending the request
        // anyway would hand back the parallel calls the caller ruled out.
        if (opts.parallelToolCalls === false) {
          throw new ProviderError(
            id,
            "invalid",
            `${id}: Gemini can't limit a turn to one tool call. Leave parallelToolCalls unset ` +
              "for Gemini models, or run the calls it returns one at a time.",
          );
        }
        request.tools = [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              // Same rule as the response schema: `parameters` is the trimmed
              // dialect, `parametersJsonSchema` is the schema we actually wrote.
              parametersJsonSchema: toGeminiToolSchema(tool.inputSchema),
            })),
          },
        ];
        // Pointless without declarations, and Gemini 400s on a tool config that
        // names a function it was never given.
        const toolConfig = toToolConfig(opts.toolChoice);
        if (toolConfig) request.toolConfig = toolConfig;
      }

      // Gemini reports the finish reason on a candidate that can arrive AFTER
      // the chunk carrying the function calls, so a turn's tool use has to be
      // remembered rather than read off the final chunk.
      let sawFunctionCalls = false;
      let callIndex = 0;
      let finished = false;

      for await (const data of streamSse({
        // Without `?alt=sse` the response is one long JSON array that only
        // parses once complete, which is not a stream.
        url: apiUrl(baseUrl, `/v1beta/models/${model}:streamGenerateContent?alt=sse`),
        headers: { "x-goog-api-key": config.apiKey, ...config.headers },
        body: request,
        provider: id,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
        ...(opts.onRateLimit ? { onRateLimit: opts.onRateLimit } : {}),
        // This wire has no terminal event to stop at, so the finish reason is
        // the end: a read that dies after it can cost a late usage record, never
        // the answer.
        finished: () => finished,
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
        // A blocked PROMPT has no candidate to finish, so it reads as a cut
        // stream — retried, into the same block. It is a content failure.
        const blocked = chunk.promptFeedback?.blockReason;
        if (blocked) {
          throw new ProviderError(id, "content", `${id}: the prompt was blocked (${blocked})`, {
            code: blocked,
          });
        }

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
              ...(usage.thoughtsTokenCount !== undefined
                ? { reasoningTokens: usage.thoughtsTokenCount }
                : {}),
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
          const identity = { index, id: call.id ?? "", name: call.name ?? "" };
          // The part is the whole call, so it is settled here: one with no
          // name can't run, and one with no id gets one the way the other
          // three wires mint it. Gemini omits the id on a single-call turn, and
          // the seam's consumers pair a result back to its call by id.
          settleToolCalls(id, [identity]);
          toolCalls.push({
            ...identity,
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
          // Mapped first: a reason that throws must not be dressed as tool_calls.
          const finishReason = mapFinishReason(id, candidate.finishReason);
          finished = true;
          yield {
            type: "finish",
            // Gemini routinely reports STOP on a turn that called tools, and a
            // caller reading that as "done" drops the tool round entirely.
            // Only STOP is promoted, as on the other three wires: a length cut
            // or a filter may be what broke the call (invariant 10).
            finishReason: sawFunctionCalls && finishReason === "stop" ? "tool_calls" : finishReason,
          };
        }
      }
      // Gemini states a finish reason on the last candidate of every turn it
      // completes; a stream that closes without one was cut.
      if (!finished) throw streamCut(id);
    },
  };

  return withConfiguredFallbacks(provider, config);
}
