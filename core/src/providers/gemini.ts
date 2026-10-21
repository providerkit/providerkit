// Gemini adapter — SSE from POST /v1beta/models/{model}:streamGenerateContent.
//
// Native Gemini, not its OpenAI-compatible shim: only this endpoint carries
// thought signatures, and a signature dropped on the way back costs the model
// its own chain of thought on the next turn. Written straight against the REST
// wire rather than @google/genai, because this package ships zero dependencies
// and the SDK is a Node-shaped one.
import { repairHistory } from "../context.ts";
import { ProviderError, streamCut, streamError, type ErrorKind } from "../errors.ts";
import { schemaPrompt, toAntigravityToolSchema, toGeminiToolSchema } from "../schema.ts";
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
   *  gateway. Defaults to the Generative Language API. */
  baseUrl?: string;
  /** Explicit path override when a backend has custom routing (Antigravity:
   *  `/v1internal:streamGenerateContent?alt=sse`). */
  path?: string;
  /** Send the credential as `Authorization: Bearer` instead of `x-goog-api-key`
   *  (Antigravity OAuth). */
  bearer?: boolean;
  /** Google Antigravity (Cloud Code Assist) project id for the request envelope. */
  projectId?: string;
  /** Header that carries `StreamOptions.sessionId`. */
  sessionHeader?: string;
  /** The id `sessionHeader` carries when a call has no `sessionId`. */
  instanceSessionId?: string;
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
const ANTIGRAVITY_DAILY_API = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_PROD_API = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_IDE_USER_AGENT =
  "antigravity/ide/2.5.5 (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)";
const ANTIGRAVITY_CLI_USER_AGENT =
  "antigravity/cli/1.3.4 (os_type=darwin; arch=arm64; aidev_client; auth_method=oauth)";
const REJECTED_CLAUDE_SDK_PARAGRAPH =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const ANTIGRAVITY_WIRE_MODELS: Record<string, string> = {
  "gemini-4-argon": "gemini-4-argon-high",
  "gemini-3.8-flash": "gemini-3.8-flash-medium",
  "gemini-3.7-flash": "gemini-3.7-flash-tiered",
  "gemini-3.1-pro": "gemini-pro-agent",
  "claude-opus-5-5": "claude-opus-5-5-high",
  "claude-sonnet-5-5": "claude-sonnet-5-5-high",
};

/** Resolve an Antigravity model id to its Cloud Code Assist wire model id. */
export function resolveAntigravityWireModel(model: string): string {
  const stripped = model.replace(/^antigravity\//, "");
  return ANTIGRAVITY_WIRE_MODELS[stripped] ?? stripped;
}

/** Deterministic Antigravity session id (`-<uint64>`), matching cc-proxy. */
export async function antigravitySessionId(sessionId?: string): Promise<string> {
  const seed = sessionId && sessionId.length > 0 ? sessionId : crypto.randomUUID();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  const view = new DataView(digest.buffer, digest.byteOffset, 8);
  const masked = view.getBigUint64(0, false) & 0x7fffffffffffffffn;
  return `-${masked.toString()}`;
}

function cleanAntigravitySystemText(text: string): string {
  return text
    .replace(/^x-anthropic-billing-header:[^\n]*\n*/, "")
    .split("\n\n")
    .filter((p) => p !== REJECTED_CLAUDE_SDK_PARAGRAPH)
    .join("\n\n");
}

/**
 * Gemini 3+ thinking dial.
 *
 * Measured across all 17 text models on 2026-10-21:
 * - Only `gemini-3-flash*`, `gemini-3.5-flash*`, `gemini-3.6-flash`, and the
 *   `flash-lite` models accept `MINIMAL` (which spends 0 thought tokens).
 * - `gemini-3.7-flash`, `gemini-3.8-flash`, `gemini-4-*`, `gemini-flash-latest`,
 *   and every Pro model answer `MINIMAL` with `400 Thinking level MINIMAL is not
 *   supported for this model`, and take `LOW` as their lowest level.
 *
 * Sent as the REST enum NAMES. The SDK's `ThinkingLevel` members serialize to
 * exactly these strings, so nothing is lost by writing them out.
 */
const THINKING_LEVEL: Record<Exclude<Effort, "none">, string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  max: "HIGH",
};

const TAKES_MINIMAL_THINKING =
  /^gemini-(?:3(?:\.[056])?-flash(?:-preview|-lite(?:-preview)?)?|3\.1-flash-lite(?:-preview)?|flash-lite-latest)$/i;

function geminiThinkingLevel(model: string, effort: Effort): string {
  if (effort !== "none") return THINKING_LEVEL[effort];
  return TAKES_MINIMAL_THINKING.test(model) ? "MINIMAL" : "LOW";
}

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
  const isAntigravity = id === "antigravity";
  const instanceSessionId =
    config.sessionHeader || isAntigravity ? (config.instanceSessionId ?? crypto.randomUUID()) : "";

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
      const wireModel = isAntigravity ? resolveAntigravityWireModel(model) : model;
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
      if (effort && !isAntigravity) {
        generationConfig.thinkingConfig = isGemini2
          ? { thinkingBudget: GEMINI_2_THINKING_BUDGET[effort] }
          : { thinkingLevel: geminiThinkingLevel(model, effort) };
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
      const cleanedSystem = system && isAntigravity ? cleanAntigravitySystemText(system) : system;
      const systemParts = [
        ...(cleanedSystem ? [{ text: cleanedSystem }] : []),
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
              // Antigravity (Cloud Code Assist) still expects the OpenAPI-subset
              // `parameters` field; the Gemini API and OpenCode Zen take standard
              // JSON Schema in `parametersJsonSchema` (cc-proxy 0.2.8).
              ...(isAntigravity
                ? { parameters: toAntigravityToolSchema(tool.inputSchema) }
                : { parametersJsonSchema: toGeminiToolSchema(tool.inputSchema) }),
            })),
          },
        ];
        // Pointless without declarations, and Gemini 400s on a tool config that
        // names a function it was never given.
        const toolConfig = toToolConfig(opts.toolChoice);
        if (toolConfig) request.toolConfig = toolConfig;
      }

      const rawHeaders = { ...config.headers };
      const headerProjectId = rawHeaders["x-antigravity-project"];
      delete rawHeaders["x-antigravity-project"];

      let wireBody: Record<string, unknown> = request;
      if (isAntigravity) {
        request.sessionId = await antigravitySessionId(opts.sessionId ?? instanceSessionId);
        if (wireModel.includes("claude") && !request.toolConfig) {
          request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
        }
        wireBody = {
          model: wireModel,
          userAgent: "antigravity",
          requestType: "agent",
          project: config.projectId ?? headerProjectId ?? "",
          requestId: `agent-${crypto.randomUUID()}`,
          request,
        };
      }

      const versionedBase = /\/v\d+[^/]*$/i.test(baseUrl.replace(/\/+$/, ""));
      const defaultPath = `${versionedBase ? "" : "/v1beta"}/models/${model}:streamGenerateContent?alt=sse`;
      const path = config.path ?? defaultPath;
      const useBearer = config.bearer || isAntigravity;
      const authHeader: Record<string, string> = config.apiKey
        ? useBearer
          ? { authorization: `Bearer ${config.apiKey}` }
          : { "x-goog-api-key": config.apiKey }
        : {};
      const antigravityUa: Record<string, string> = isAntigravity
        ? {
            "user-agent": wireModel.startsWith("gemini-4-argon")
              ? ANTIGRAVITY_CLI_USER_AGENT
              : ANTIGRAVITY_IDE_USER_AGENT,
          }
        : {};
      const headers: Record<string, string> = {
        ...antigravityUa,
        ...authHeader,
        ...rawHeaders,
        ...(config.sessionHeader
          ? { [config.sessionHeader]: opts.sessionId ?? instanceSessionId }
          : {}),
      };

      const bases =
        isAntigravity && baseUrl.replace(/\/+$/, "") === ANTIGRAVITY_DAILY_API
          ? [ANTIGRAVITY_DAILY_API, ANTIGRAVITY_PROD_API]
          : [baseUrl];

      let sawFunctionCalls = false;
      let callIndex = 0;
      let finished = false;
      let emitted = false;

      for (let baseIdx = 0; baseIdx < bases.length; baseIdx++) {
        const currentBase = bases[baseIdx]!;
        try {
          for await (const data of streamSse({
            // Without `?alt=sse` the response is one long JSON array that only
            // parses once complete, which is not a stream.
            url: apiUrl(currentBase, path),
            headers,
            body: wireBody,
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
            let parsed: GeminiResponse & { response?: GeminiResponse };
            try {
              parsed = JSON.parse(data) as GeminiResponse & { response?: GeminiResponse };
            } catch {
              continue;
            }
            const chunk = parsed.response ?? parsed;

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
              emitted = true;
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

            if (reasoning) {
              emitted = true;
              yield { type: "delta", reasoning };
            }
            if (content) {
              emitted = true;
              yield { type: "delta", content };
            }
            if (toolCalls.length > 0) {
              sawFunctionCalls = true;
              emitted = true;
              yield { type: "delta", toolCalls };
            }

            if (candidate.finishReason) {
              // Mapped first: a reason that throws must not be dressed as tool_calls.
              const finishReason = mapFinishReason(id, candidate.finishReason);
              finished = true;
              emitted = true;
              yield {
                type: "finish",
                // Gemini routinely reports STOP on a turn that called tools, and a
                // caller reading that as "done" drops the tool round entirely.
                // Only STOP is promoted, as on the other three wires: a length cut
                // or a filter may be what broke the call (invariant 10).
                finishReason:
                  sawFunctionCalls && finishReason === "stop" ? "tool_calls" : finishReason,
              };
            }
          }
          break;
        } catch (err) {
          const canFallback =
            !emitted &&
            baseIdx === 0 &&
            bases.length > 1 &&
            err instanceof ProviderError &&
            (err.status === 403 ||
              err.status === 404 ||
              err.status === 500 ||
              err.status === 502 ||
              err.status === 503 ||
              err.status === 504);
          if (canFallback) continue;
          throw err;
        }
      }
      // Gemini states a finish reason on the last candidate of every turn it
      // completes; a stream that closes without one was cut.
      if (!finished) throw streamCut(id);
    },
  };

  return withConfiguredFallbacks(provider, config);
}
