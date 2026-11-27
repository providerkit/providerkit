// @providerkit/core/images. Standalone generation and editing, not chat tools.
import { attributionHeaders, type Attribution } from "./attribution.ts";
import { classifyHttp, ProviderError, validateMaxAttempts } from "./errors.ts";
import type { KeyPool } from "./key-pool.ts";
import { withRetry } from "./retry.ts";
import { apiUrl, callOnce, postBytes, withDeadline, type FetchLike } from "./transport.ts";
import { toDataUri, type ImagePart } from "./types.ts";

export type ImageProviderId = "gemini" | "openai" | "openrouter";
export type AspectRatio = "1:1" | "4:5" | "3:4" | "9:16" | "16:9" | "4:3" | "3:2" | "2:3";
export type ImageSize = "512" | "1K" | "2K" | "4K";

type RequestedSize = ImageSize | "provider";
type Rgb = readonly [red: number, green: number, blue: number];

export interface GenerateImagesInput<S extends RequestedSize = ImageSize> {
  prompt: string;
  aspectRatio: AspectRatio;
  /** Defaults to 1K. OpenAI uses aspectRatio instead. On OpenRouter, "provider" omits resolution. */
  size?: S;
  /** OpenRouter output format. Defaults to PNG. */
  outputFormat?: "png" | "svg";
  /** Recraft models on OpenRouter only. Each RGB channel is an integer from 0 to 255. */
  recraft?: { colors?: readonly Rgb[]; backgroundColor?: Rgb };
  n?: number;
  referenceImages?: readonly ImagePart[];
  /** Unsupported by OpenAI's Images API. */
  seed?: number;
  signal?: AbortSignal;
  /** Do not retry or rotate keys for this call. Does not change `n`. */
  retry?: "never";
  model?: string;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
  seed?: number;
}

export interface ImageUsage<S extends RequestedSize = ImageSize> {
  images: number;
  /** Requested size class, not the decoded dimensions. */
  size: S;
  inputTokens?: number;
  /** On Gemini, candidate tokens only. Add reasoningTokens for the billed output count. */
  outputTokens?: number;
  /** Already included in inputTokens. */
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** Exact USD charge when the provider reports it. */
  costUsd?: number;
}

export interface ImageResult<S extends RequestedSize = ImageSize> {
  images: GeneratedImage[];
  usage: ImageUsage<S>;
  model: string;
  /** The Gemini version that made every image, when reported and the same for all of them. */
  modelVersion?: string;
}

export interface ImageProvider {
  readonly id: ImageProviderId;
  readonly model: string;
  generate(input: GenerateImagesInput): Promise<ImageResult>;
}

export interface OpenRouterImageProvider extends ImageProvider {
  generate<S extends RequestedSize = ImageSize>(
    input: GenerateImagesInput<S>,
  ): Promise<ImageResult<S | "1K">>;
}

interface ImageConfig {
  model: string;
  /** Time limit per request. Defaults to 180 seconds. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export type GeminiImageConfig = ImageConfig &
  ({ apiKey: string; pool?: never } | { pool: KeyPool; apiKey?: never });

export interface OpenAIImageConfig extends ImageConfig {
  apiKey: string;
  /** API root before `/images`. Defaults to `https://api.openai.com/v1`. */
  baseUrl?: string;
  quality?: "auto" | "low" | "medium" | "high";
  /** Applied only to generation. */
  moderation?: "auto" | "low";
  /** Applied only to edits. Check that the selected model supports it. */
  inputFidelity?: "low" | "high";
  /** Explicit opt-in to the Images SDK's retry policy. Default: one attempt. */
  maxAttempts?: number;
}

export interface OpenRouterImageConfig extends ImageConfig, Attribution {
  apiKey: string;
  baseUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_REPLY_BYTES = 64 * 1024 * 1024;
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function parseObject(text: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (isObject(value)) return value;
  } catch {
    // Never include a prompt or pixels from a malformed response in the error.
  }
  return undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function decode(
  id: ImageProviderId,
  data: string,
  kind: "input" | "reply",
): Uint8Array<ArrayBuffer> {
  try {
    const bytes = Uint8Array.from(atob(data), (value) => value.charCodeAt(0));
    if (bytes.length) return bytes;
  } catch {
    // The payload can contain private pixels. Do not put it in the error.
  }
  throw new ProviderError(id, "invalid", `${id}: invalid base64 image ${kind}`, {
    code: kind === "reply" ? "image_invalid_data" : undefined,
    shouldRetry: false,
  });
}

function readJson(bytes: Uint8Array, id: ImageProviderId): JsonObject {
  const reply = parseObject(new TextDecoder().decode(bytes));
  if (reply) return reply;
  throw new ProviderError(id, "invalid", `${id}: invalid image response JSON`, {
    code: "image_invalid_json",
    shouldRetry: false,
  });
}

function checkedKey(id: ImageProviderId, apiKey: string): string {
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new ProviderError(id, "auth", `${id}: set an API key with printable ASCII characters.`);
  }
  return apiKey;
}

function validateInput(id: ImageProviderId, input: GenerateImagesInput<RequestedSize>): number {
  if (id !== "openrouter") {
    if (input.recraft || input.size === "provider") {
      throw new ProviderError(
        id,
        "invalid",
        "Recraft controls and provider sizing require OpenRouter Images.",
      );
    }
    if (input.outputFormat !== undefined && !(id === "openai" && input.outputFormat === "png")) {
      throw new ProviderError(id, "invalid", `${id} cannot request this image format.`);
    }
  }
  const count = input.n ?? 1;
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new ProviderError(id, "invalid", "Set the number of images to a positive integer.");
  }
  return count;
}

function result<S extends RequestedSize>(
  id: ImageProviderId,
  model: string,
  size: S,
  images: GeneratedImage[],
  usage: Omit<ImageUsage, "images" | "size">,
): ImageResult<S> {
  if (!images.length)
    throw new ProviderError(id, "overload", `${id}: no image data returned`, {
      code: "image_empty",
      shouldRetry: false,
    });
  return { model, images, usage: { ...usage, size, images: images.length } };
}

async function requestImage(
  id: ImageProviderId,
  config: ImageConfig,
  input: Pick<GenerateImagesInput, "signal" | "retry">,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Uint8Array> {
  const run = async (signal: AbortSignal) => {
    const { bytes } = await postBytes({
      provider: id,
      url,
      headers,
      body,
      signal,
      maxBytes: MAX_REPLY_BYTES,
      classifyError: id === "openrouter" ? openRouterImageError : undefined,
      redirect: "error",
      fetchImpl: config.fetchImpl,
    });
    signal.throwIfAborted();
    return bytes;
  };
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return input.retry === "never"
    ? callOnce(id, timeout, input.signal, run)
    : withDeadline(id, timeout, input.signal, run);
}

export function createGeminiImageProvider(config: GeminiImageConfig): ImageProvider {
  const id = "gemini";
  return {
    id,
    model: config.model,
    async generate(input) {
      const model = (input.model ?? config.model).replace(/^models\//, "");
      if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(model)) {
        throw new ProviderError(id, "invalid", "Set a Gemini image model name.");
      }
      const size = input.size ?? "1K";
      const n = validateInput(id, input);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const contents = [
        {
          role: "user",
          parts: [
            ...(input.referenceImages ?? []).map(({ mimeType, data }) => ({
              inlineData: { mimeType, data },
            })),
            { text: input.prompt },
          ],
        },
      ];
      const images: GeneratedImage[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedInputTokens = 0;
      let reasoningTokens = 0;
      let modelVersion: string | undefined;
      for (let i = 0; i < n; i++) {
        const seed = input.seed === undefined ? undefined : input.seed + i;
        const body = {
          contents,
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: input.aspectRatio, imageSize: size },
            seed,
          },
        };
        const send = (apiKey: string): Promise<Uint8Array> =>
          requestImage(id, config, input, url, { "x-goog-api-key": checkedKey(id, apiKey) }, body);
        const bytes = config.pool
          ? await config.pool.with(send, input.retry === "never" ? { maxAttempts: 1 } : {})
          : await send(config.apiKey);
        // A finished call with no image must not rotate across keys.
        const reply = readJson(bytes, id);
        const candidate = object(list(reply.candidates)[0]);
        const part = list(object(candidate.content).parts)
          .map(object)
          .find((part) => !part.thought && object(part.inlineData).data);
        const blob = object(part?.inlineData);
        if (typeof blob.data !== "string" || !blob.data) {
          const filtered = [object(reply.promptFeedback).blockReason, candidate.finishReason].some(
            (reason) =>
              typeof reason === "string" && /SAFETY|PROHIBITED|BLOCK|RECITATION|SPII/i.test(reason),
          );
          throw new ProviderError(
            id,
            filtered ? "content" : "overload",
            "Gemini returned no image.",
            { code: filtered ? "image_refused" : "image_empty", shouldRetry: false },
          );
        }
        images.push({
          bytes: decode(id, blob.data, "reply"),
          mimeType: typeof blob.mimeType === "string" ? blob.mimeType : "image/png",
          ...(seed === undefined ? {} : { seed }),
        });
        const usage = object(reply.usageMetadata);
        inputTokens += usageNumber(usage.promptTokenCount) ?? 0;
        outputTokens += usageNumber(usage.candidatesTokenCount) ?? 0;
        cachedInputTokens += usageNumber(usage.cachedContentTokenCount) ?? 0;
        reasoningTokens += usageNumber(usage.thoughtsTokenCount) ?? 0;
        if (i === 0 && typeof reply.modelVersion === "string") modelVersion = reply.modelVersion;
        else if (reply.modelVersion !== modelVersion) modelVersion = undefined;
      }
      return {
        model,
        ...(modelVersion ? { modelVersion } : {}),
        images,
        usage: {
          size,
          images: images.length,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          reasoningTokens,
        },
      };
    },
  };
}

function openAIPixelSize(aspect: AspectRatio): string {
  switch (aspect) {
    case "1:1":
      return "1024x1024";
    case "16:9":
    case "4:3":
    case "3:2":
      return "1536x1024";
    default:
      return "1024x1536";
  }
}

function openAIShouldRetry(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.shouldRetry !== undefined) return error.shouldRetry;
  if (error.status === undefined) return error.kind === "network" || error.kind === "timeout";
  return (
    error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
  );
}

function base64Images(
  id: "openai" | "openrouter",
  reply: JsonObject,
  defaultMime = "image/png",
): GeneratedImage[] {
  return list(reply.data)
    .map(object)
    .flatMap(({ b64_json, media_type }) => {
      if (typeof b64_json !== "string" || !b64_json) return [];
      const mimeType =
        id === "openrouter" && typeof media_type === "string" ? media_type : defaultMime;
      return [{ bytes: decode(id, b64_json, "reply"), mimeType }];
    });
}

export function createOpenAIImageProvider(config: OpenAIImageConfig): ImageProvider {
  const id = "openai";
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  const headers = { Authorization: `Bearer ${checkedKey(id, config.apiKey)}` };
  validateMaxAttempts(config.maxAttempts);
  return {
    id,
    model: config.model,
    async generate(input) {
      input.signal?.throwIfAborted();
      if (input.seed !== undefined)
        throw new ProviderError(id, "invalid", "OpenAI Images does not accept a seed.");
      const model = input.model ?? config.model;
      const fields = {
        model,
        prompt: input.prompt,
        n: validateInput(id, input),
        size: openAIPixelSize(input.aspectRatio),
        quality: config.quality,
        output_format: "png",
      };
      const refs = input.referenceImages ?? [];
      const path = refs.length ? "/images/edits" : "/images/generations";
      let body: object = { ...fields, moderation: config.moderation };
      if (refs.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields))
          if (value !== undefined) form.append(key, String(value));
        if (config.inputFidelity) form.append("input_fidelity", config.inputFidelity);
        refs.forEach(({ mimeType, data }, i) => {
          const file = new Blob([decode(id, data, "input")], { type: mimeType });
          form.append("image[]", file, `ref-${i}.${mimeType.split("/")[1]}`);
        });
        body = form;
      }
      const url = apiUrl(baseUrl, path);
      const bytes = await withRetry(() => requestImage(id, config, input, url, headers, body), {
        maxAttempts: input.retry === "never" ? 1 : (config.maxAttempts ?? 1),
        shouldRetry: openAIShouldRetry,
        signal: input.signal,
        baseDelayMs: 500,
        maxDelayMs: 60_000,
        budgetMs: Infinity,
      });
      const reply = readJson(bytes, id);
      const usage = object(reply.usage);
      return result(id, model, input.size ?? "1K", base64Images(id, reply), {
        inputTokens: usageNumber(usage.input_tokens),
        outputTokens: usageNumber(usage.output_tokens),
      });
    },
  };
}

function openRouterImageError(status: number | undefined, body: string) {
  // A failed moderation service is not a refusal of this prompt.
  if (status !== undefined && status >= 500) return classifyHttp(status, "");
  const message = object(parseObject(body)?.error).message;
  if (
    typeof message === "string" &&
    /moderat|safety|content[_ ]polic|flagged|prohibited|(?:prompt|image|content).*not allowed/i.test(
      message,
    )
  ) {
    return "content";
  }
  return classifyHttp(status, body);
}

function recraftProvider(model: string, recraft: GenerateImagesInput["recraft"]) {
  if (!recraft) return undefined;
  if (!model.startsWith("recraft/"))
    throw new ProviderError("openrouter", "invalid", "Choose a Recraft model to set image colors.");
  function color(rgb: Rgb) {
    if (
      !Array.isArray(rgb) ||
      rgb.length !== 3 ||
      !rgb.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)
    )
      throw new ProviderError(
        "openrouter",
        "invalid",
        "Use three integers from 0 to 255 for each RGB color.",
      );
    return { rgb };
  }
  const controls = {
    colors: recraft.colors?.length ? recraft.colors.map(color) : undefined,
    background_color:
      recraft.backgroundColor === undefined ? undefined : color(recraft.backgroundColor),
  };
  return controls.colors || controls.background_color
    ? { options: { recraft: { controls } } }
    : undefined;
}

export function createOpenRouterImageProvider(
  config: OpenRouterImageConfig,
): OpenRouterImageProvider {
  const id = "openrouter";
  const url = apiUrl(config.baseUrl ?? "https://openrouter.ai/api/v1", "/images");
  const headers = {
    Authorization: `Bearer ${checkedKey(id, config.apiKey)}`,
    ...attributionHeaders(config),
  };
  return {
    id,
    model: config.model,
    async generate(input) {
      const model = input.model ?? config.model;
      const size = input.size ?? "1K";
      const inputReferences = input.referenceImages?.map((part) => ({
        type: "image_url",
        image_url: { url: toDataUri(part) },
      }));
      const bytes = await requestImage(id, config, input, url, headers, {
        model,
        prompt: input.prompt,
        n: validateInput(id, input),
        aspect_ratio: input.aspectRatio,
        resolution: size === "provider" ? undefined : size,
        output_format: input.outputFormat ?? "png",
        provider: recraftProvider(model, input.recraft),
        seed: input.seed,
        ...(inputReferences?.length ? { input_references: inputReferences } : {}),
      });
      const reply = readJson(bytes, id);
      const usage = object(reply.usage);
      const mime = input.outputFormat === "svg" ? "image/svg+xml" : "image/png";
      return result(id, model, size, base64Images(id, reply, mime), {
        inputTokens: usageNumber(usage.prompt_tokens),
        outputTokens: usageNumber(usage.completion_tokens),
        costUsd: usageNumber(usage.cost),
      });
    },
  };
}
