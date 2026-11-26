// @providerkit/core/video. The chat entry point does not load the Files API.
import { ProviderError } from "./errors.ts";
import { geminiTokenUsage } from "./providers/gemini-usage.ts";
import { callOnce, readBounded, sendChecked, type FetchLike } from "./transport.ts";
import type { TokenUsage } from "./types.ts";

export interface GeminiVideoConfig {
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  /** Receives a cleanup failure without changing the result of the read. */
  onCleanupError?: (error: unknown) => void;
}

export interface GeminiVideoInput {
  bytes: Uint8Array;
  mimeType: string;
  prompt: string;
  /** Read only the first seconds of the video. Omit to read the whole file. */
  seconds?: number;
  lowResolution?: boolean;
  json?: boolean;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface GeminiVideoProvider {
  readonly model: string;
  /** An empty answer can still carry billed usage. */
  read(input: GeminiVideoInput): Promise<{ text: string; usage: TokenUsage }>;
}

const PROVIDER = "gemini";
const ORIGIN = "https://generativelanguage.googleapis.com";
const UPLOAD_PATH = "/upload/v1beta/files";
// Match the Gemini SDK's chunk size so large files do not depend on a single large POST.
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const FILE_OPERATION_TIMEOUT_MS = 120_000;
const PROCESSING_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 10_000;

function invalid(code: string, message: string): ProviderError {
  return new ProviderError(PROVIDER, "invalid", message, { code, shouldRetry: false });
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function tokens(metadata: unknown, key: string): number | undefined {
  const value = field(metadata, key);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function readJson(res: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const bytes = await readBounded(res, maxBytes, PROVIDER, signal);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalid("invalid_video_reply", "Gemini did not return JSON.");
  }
}

function uploadSession(value: string | null): string {
  const url = value && URL.canParse(value) ? new URL(value) : null;
  // The upload location is a response header. Never send private footage to another origin.
  if (url?.origin !== ORIGIN || url.pathname !== UPLOAD_PATH || url.username || url.password) {
    throw invalid("invalid_video_upload_url", "Gemini did not return a valid upload URL.");
  }
  return url.href;
}

function waitToPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 2_000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function videoAnswer(reply: unknown): { text: string; usage: TokenUsage } {
  const candidates = field(reply, "candidates");
  const first: unknown = Array.isArray(candidates) ? candidates[0] : undefined;
  const parts = field(field(first, "content"), "parts");
  let text = "";
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const value = field(part, "text");
      if (typeof value === "string" && field(part, "thought") !== true) text += value;
    }
  }
  const metadata = field(reply, "usageMetadata");
  return {
    text,
    usage: geminiTokenUsage({
      promptTokenCount: tokens(metadata, "promptTokenCount"),
      candidatesTokenCount: tokens(metadata, "candidatesTokenCount"),
      cachedContentTokenCount: tokens(metadata, "cachedContentTokenCount"),
      thoughtsTokenCount: tokens(metadata, "thoughtsTokenCount"),
      toolUsePromptTokenCount: tokens(metadata, "toolUsePromptTokenCount"),
    }),
  };
}

/** Upload one video, wait for it to be ready, read it once and try to delete it. */
export function createGeminiVideoProvider(config: GeminiVideoConfig): GeminiVideoProvider {
  const model = config.model.replace(/^models\//, "");
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(model)) {
    throw invalid("invalid_video_model", "Set a Gemini model name.");
  }
  if (!/^[\x21-\x7e]+$/.test(config.apiKey)) {
    throw invalid("invalid_video_key", "Set a Gemini API key with printable ASCII characters.");
  }
  const wire = {
    provider: PROVIDER,
    fetchImpl: config.fetchImpl,
    redactErrors: true,
    redirect: "error",
  } as const;
  const auth = { "x-goog-api-key": config.apiKey };
  return {
    model,
    async read(input) {
      if (!input.bytes.byteLength || !/^video\/[a-z0-9.+_-]+$/i.test(input.mimeType)) {
        throw invalid("invalid_video_input", "Send a nonempty video and its media type.");
      }
      if (
        input.seconds !== undefined &&
        (!Number.isSafeInteger(input.seconds) || input.seconds <= 0)
      ) {
        throw invalid("invalid_video_duration", "Set the number of seconds to a positive integer.");
      }
      const uploaded = await callOnce(
        PROVIDER,
        FILE_OPERATION_TIMEOUT_MS,
        input.signal,
        async (signal) => {
          const start = await sendChecked({
            ...wire,
            url: ORIGIN + UPLOAD_PATH,
            signal,
            body: { file: {} },
            headers: {
              ...auth,
              "x-goog-upload-protocol": "resumable",
              "x-goog-upload-command": "start",
              "x-goog-upload-header-content-length": String(input.bytes.byteLength),
              "x-goog-upload-header-content-type": input.mimeType,
            },
          });
          void start.body?.cancel().catch(() => {});
          const session = uploadSession(start.headers.get("x-goog-upload-url"));
          let offset = 0;
          for (;;) {
            signal.throwIfAborted();
            const end = Math.min(offset + UPLOAD_CHUNK_BYTES, input.bytes.byteLength);
            const final = end === input.bytes.byteLength;
            const chunk = Uint8Array.from(input.bytes.subarray(offset, end));
            const res = await sendChecked({
              ...wire,
              url: session,
              signal,
              headers: {
                "x-goog-upload-command": final ? "upload, finalize" : "upload",
                "x-goog-upload-offset": String(offset),
              },
              body: new Blob([chunk], { type: input.mimeType }),
            });
            if (final) return field(await readJson(res, 64 * 1024, signal), "file");
            void res.body?.cancel().catch(() => {});
            if (res.headers.get("x-goog-upload-status") !== "active") {
              throw invalid(
                "video_upload_stopped",
                "Gemini ended the upload before the last chunk.",
              );
            }
            offset = end;
          }
        },
      );
      const name = field(uploaded, "name");
      if (typeof name !== "string" || !/^files\/[a-z0-9-]+$/i.test(name)) {
        throw invalid("invalid_video_file_name", "Gemini did not return a valid file name.");
      }
      const url = `${ORIGIN}/v1beta/${name}`;
      try {
        const file = await callOnce(
          PROVIDER,
          PROCESSING_TIMEOUT_MS,
          input.signal,
          async (signal) => {
            let current = uploaded;
            while (field(current, "state") === "PROCESSING") {
              await waitToPoll(signal);
              const res = await sendChecked(
                { ...wire, url, signal, headers: auth, body: undefined },
                "GET",
              );
              current = await readJson(res, 64 * 1024, signal);
            }
            return current;
          },
        );
        const uri = field(file, "uri");
        if (field(file, "state") === "FAILED" || typeof uri !== "string" || !uri) {
          throw invalid("video_processing_failed", "Gemini could not process the video.");
        }
        return await callOnce(PROVIDER, FILE_OPERATION_TIMEOUT_MS, input.signal, async (signal) => {
          const res = await sendChecked({
            ...wire,
            url: `${ORIGIN}/v1beta/models/${model}:generateContent`,
            signal,
            headers: auth,
            body: {
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      fileData: { fileUri: uri, mimeType: input.mimeType },
                      ...(input.seconds === undefined
                        ? {}
                        : {
                            videoMetadata: { startOffset: "0s", endOffset: `${input.seconds}s` },
                          }),
                    },
                    { text: input.prompt },
                  ],
                },
              ],
              generationConfig: {
                maxOutputTokens: input.maxOutputTokens,
                ...(input.lowResolution ? { mediaResolution: "MEDIA_RESOLUTION_LOW" } : {}),
                ...(input.json ? { responseMimeType: "application/json" } : {}),
              },
            },
          });
          return videoAnswer(await readJson(res, 8 * 1024 * 1024, signal));
        });
      } finally {
        // Cancelling the read must not cancel deletion of the already uploaded file.
        try {
          await callOnce(PROVIDER, CLEANUP_TIMEOUT_MS, undefined, async (signal) => {
            const res = await sendChecked(
              { ...wire, url, signal, headers: auth, body: undefined },
              "DELETE",
            );
            void res.body?.cancel().catch(() => {});
          });
        } catch (error) {
          try {
            config.onCleanupError?.(error);
          } catch {
            // A reporting failure does not replace the answer or the original error.
          }
        }
      }
    },
  };
}
