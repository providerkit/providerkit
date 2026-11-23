// @providerkit/core/embeddings. The chat entry point does not load this code.
import { ProviderError } from "./errors.ts";
import { apiUrl, callOnce, postBytes, versionedPath, type FetchLike } from "./transport.ts";

export type { FetchLike } from "./transport.ts";

export interface EmbeddingOptions {
  signal?: AbortSignal;
}

export interface EmbeddingUsage {
  inputTokens: number;
  source: "aggregate" | "per-vector";
}

export interface EmbeddingResult {
  /** One vector per input, in the same order. No normalization or truncation is applied here. */
  vectors: number[][];
  model: string;
  /** Absent when the provider did not report a complete input count. */
  usage?: EmbeddingUsage;
}

export interface EmbeddingProvider<Options extends EmbeddingOptions = EmbeddingOptions> {
  id: string;
  model: string;
  embed(input: string | readonly string[], options?: Options): Promise<EmbeddingResult>;
}

export type GeminiEmbeddingTask =
  | "RETRIEVAL_QUERY"
  | "RETRIEVAL_DOCUMENT"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING"
  | "QUESTION_ANSWERING"
  | "FACT_VERIFICATION"
  | "CODE_RETRIEVAL_QUERY";

export interface GeminiEmbeddingOptions extends EmbeddingOptions {
  taskType?: GeminiEmbeddingTask;
  /** Omitted unless the caller's wire used an explicit user content role. */
  role?: "user";
}

export interface GeminiEmbeddingConfig {
  apiKey: string;
  /** Pin this to the model that produced your stored vectors. Accepts a `models/` prefix. */
  model: string;
  /** Set the width of your vector index. Omitted: the model's native width. */
  dimensions?: number;
  /** 30 seconds by default. `null` leaves the deadline to the caller. */
  timeoutMs?: number | null;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

const PROVIDER = "gemini-embeddings";
const DEFAULT_BASE = "https://generativelanguage.googleapis.com";
const MAX_INPUTS = 100;
const MAX_REPLY_BYTES = 16 * 1024 * 1024;

function invalid(code: string, reason: string, status?: number): ProviderError {
  return new ProviderError(PROVIDER, "invalid", reason, { code, status, shouldRetry: false });
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readUsage(reply: unknown, embeddings: unknown[]): EmbeddingUsage | undefined {
  const aggregate = tokenCount(field(field(reply, "usageMetadata"), "promptTokenCount"));
  if (aggregate !== undefined) return { inputTokens: aggregate, source: "aggregate" };

  let sum = 0;
  for (const entry of embeddings) {
    const count = tokenCount(field(field(entry, "statistics"), "tokenCount"));
    if (count === undefined) return undefined;
    sum += count;
  }
  if (Number.isSafeInteger(sum)) return { inputTokens: sum, source: "per-vector" };
  return undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readEmbeddings(
  bytes: Uint8Array,
  status: number,
  count: number,
  dimensions?: number,
): Omit<EmbeddingResult, "model"> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalid("invalid_embedding_reply", "Gemini did not return embedding JSON.", status);
  }
  const embeddings = field(raw, "embeddings");
  if (!Array.isArray(embeddings) || embeddings.length !== count) {
    throw invalid(
      "embedding_count_mismatch",
      "Gemini did not return one vector per input.",
      status,
    );
  }
  let width = dimensions;
  const vectors = embeddings.map((embedding: unknown) => {
    const vector = field(embedding, "values");
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(finiteNumber)) {
      throw invalid(
        "invalid_embedding_reply",
        "Gemini returned a vector without finite values.",
        status,
      );
    }
    width ??= vector.length;
    if (vector.length !== width) {
      throw invalid(
        "embedding_dimensions_mismatch",
        `Gemini did not return ${width} values per vector.`,
        status,
      );
    }
    return vector;
  });
  const usage = readUsage(raw, embeddings);
  return { vectors, ...(usage ? { usage } : {}) };
}

/** Keep structured quota hints, not the error body or failed request. */
function safeFailure(error: ProviderError): ProviderError {
  if (!error.cause && (error.status === undefined || (error.status >= 200 && error.status < 300)))
    return error;
  const daily =
    error.status === 429 &&
    /"quotaId"\s*:\s*"[^"\n]{0,128}(?:per.?day|daily)/i.test(error.body ?? "");
  return new ProviderError(PROVIDER, error.kind, `Gemini embeddings failed (${error.kind}).`, {
    code: daily ? "gemini_daily_quota" : error.code,
    status: error.status,
    retryAfterMs: error.retryAfterMs,
    resetAtMs: error.resetAtMs,
    window: error.window,
    shouldRetry: error.shouldRetry,
  });
}

/** One synchronous API request. It never starts a Google Batch job or retries a paid call. */
export function createGeminiEmbeddingProvider(
  config: GeminiEmbeddingConfig,
): EmbeddingProvider<GeminiEmbeddingOptions> {
  const model = config.model.replace(/^models\//, "");
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(model)) {
    throw invalid(
      "embedding_model_invalid",
      "Set a Gemini model name, such as gemini-embedding-2.",
    );
  }
  const { apiKey, dimensions, fetchImpl } = config;
  if (!apiKey || [...apiKey].some((char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) > 126)) {
    throw invalid("embedding_key_invalid", "Set a Gemini API key with printable ASCII characters.");
  }
  if (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || dimensions <= 0)) {
    throw invalid("embedding_dimensions_invalid", "Set dimensions to a positive integer.");
  }
  const timeoutMs = config.timeoutMs === undefined ? 30_000 : config.timeoutMs;
  if (
    timeoutMs !== null &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
  ) {
    throw invalid("embedding_timeout_invalid", "Set a positive timeout in milliseconds.");
  }
  const baseUrl = config.baseUrl ?? DEFAULT_BASE;
  const resource = `models/${model}`;
  const url = apiUrl(baseUrl, versionedPath(baseUrl, `/${resource}:batchEmbedContents`, "v1beta"));
  return {
    id: "gemini",
    model,
    async embed(input, options) {
      const texts = typeof input === "string" ? [input] : input;
      if (texts.length === 0 || texts.length > MAX_INPUTS || texts.some((text) => !text.trim())) {
        throw invalid("embedding_input_invalid", `Send 1 to ${MAX_INPUTS} nonempty inputs.`);
      }
      const requests = texts.map((text) => ({
        model: resource,
        content: { ...(options?.role ? { role: options.role } : {}), parts: [{ text }] },
        ...(options?.taskType ? { taskType: options.taskType } : {}),
        ...(dimensions !== undefined ? { outputDimensionality: dimensions } : {}),
      }));
      try {
        return await callOnce(PROVIDER, timeoutMs, options?.signal, async (signal) => {
          const { bytes, status } = await postBytes({
            url,
            headers: { "x-goog-api-key": apiKey },
            body: { requests },
            provider: PROVIDER,
            signal,
            redirect: "error",
            maxBytes: MAX_REPLY_BYTES,
            fetchImpl,
          });
          signal.throwIfAborted();
          return { model, ...readEmbeddings(bytes, status, texts.length, dimensions) };
        });
      } catch (error) {
        options?.signal?.throwIfAborted();
        if (error instanceof ProviderError) throw safeFailure(error);
        throw error;
      }
    },
  };
}
