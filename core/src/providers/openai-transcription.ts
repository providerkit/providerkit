// The OpenAI transcription wire: POST {base}/audio/transcriptions, multipart in, JSON out.
// Serves OpenAI and any server that copies the route (Groq, a local Whisper server, a proxy).
// One request per call; transcription-core.ts says why.
//
// Three things depend on the model, from OpenAI's speech-to-text guide and transcription
// reference (read 2026-11-11):
// - `gpt-transcribe` takes the language as `languages[]`; every other model takes `language`,
//   and the guide says not to send both.
// - Only `gpt-4o-transcribe-diarize` labels speakers, in `diarized_json`, and it needs a
//   `chunking_strategy` for anything over 30 seconds.
// - Only Whisper models return timed segments without speakers, in `verbose_json`. The rest
//   answer `json`: the text alone.
import { attributionHeaders, type Attribution } from "../attribution.ts";
import {
  asRecord,
  inBandFailure,
  MAX_REPLY_BYTES,
  mediaType,
  parseObject,
  prepareTranscription,
  readSegments,
  resolveLimits,
  seconds,
  transcribeOnce,
  unusable,
  type TranscriptionLimits,
  type TranscriptionProvider,
  type TranscriptionUsage,
} from "../transcription-core.ts";
import { apiUrl, postBytes, versionedPath, type FetchLike } from "../transport.ts";

export interface OpenAITranscriptionConfig extends TranscriptionLimits, Attribution {
  /** "" sends no Authorization header, for a local server that wants none. */
  apiKey: string;
  model: string;
  /** Default `https://api.openai.com`. */
  baseUrl?: string;
  /** Default `/v1/audio/transcriptions`, or `/audio/transcriptions` when the base already ends
   *  in a version. */
  path?: string;
  /** The preset id. Names the provider in errors and on `TranscriptionProvider.id`. Default
   *  "openai". */
  id?: string;
  headers?: Record<string, string>;
  /** Swapped in tests, or to route through a proxy. Defaults to global fetch. */
  fetchImpl?: FetchLike;
}

// The server reads the format from the file name, so the name carries the extension the media
// type stands for. The formats are the ones the reference lists.
const EXTENSION: Readonly<Record<string, string>> = {
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "video/mp4": "mp4",
  "video/mpeg": "mpeg",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/vnd.wave": "wav",
  "audio/webm": "webm",
  "video/webm": "webm",
};

/** A type the table knows names the file; otherwise a `File` keeps its own name. */
function fileName(audio: Blob): string {
  const extension = EXTENSION[mediaType(audio.type)];
  if (extension) return `audio.${extension}`;
  return audio instanceof File && audio.name ? audio.name : "audio";
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * The provider's own usage, or nothing. Token counts that do not add up are dropped whole: a
 * wrong number in a ledger is worse than a missing one. The audio and text parts are kept only
 * when they fit inside the input.
 */
function readUsage(raw: unknown): TranscriptionUsage | undefined {
  const usage = asRecord(raw);
  if (usage?.type === "duration") {
    const billed = seconds(usage.seconds);
    return billed === undefined ? undefined : { type: "duration", seconds: billed };
  }
  if (usage?.type !== "tokens") return undefined;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const total = count(usage.total_tokens);
  if (input === undefined || output === undefined || total === undefined) return undefined;
  if (!Number.isSafeInteger(input + output) || total < input + output) return undefined;
  const details = asRecord(usage.input_token_details);
  const audio = count(details?.audio_tokens);
  const text = count(details?.text_tokens);
  const parts = audio !== undefined && text !== undefined && audio + text <= input;
  return {
    type: "tokens",
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(parts ? { audioTokens: audio, textTokens: text } : {}),
  };
}

export function createOpenAITranscriptionProvider(
  config: OpenAITranscriptionConfig,
): TranscriptionProvider {
  const id = config.id ?? "openai";
  const provider = `transcription:${id}`;
  const baseUrl = config.baseUrl ?? "https://api.openai.com";
  const limits = resolveLimits(config);
  return {
    id,
    model: config.model,
    async transcribe(request) {
      const { audio, model, language, diarize } = prepareTranscription(provider, request, {
        apiKey: config.apiKey,
        keyRequired: false,
        model: config.model,
        maxAudioBytes: limits.maxAudioBytes,
      });
      return transcribeOnce(provider, limits.timeoutMs, request, async (signal) => {
        const form = new FormData();
        form.append("file", audio, fileName(audio));
        form.append("model", model);
        // The models take ISO 639-1 ("pt"), so a BCP-47 tag goes as its language subtag.
        if (language) {
          const code = language.split("-")[0]!.toLowerCase();
          form.append(model.startsWith("gpt-transcribe") ? "languages[]" : "language", code);
        }
        if (diarize) {
          // A model that cannot label speakers answers this with a 400, which is the honest
          // refusal: speakers asked for and silently dropped would read as one voice.
          form.append("response_format", "diarized_json");
          form.append("chunking_strategy", "auto");
        } else if (/whisper/i.test(model)) {
          form.append("response_format", "verbose_json");
        }
        const { bytes } = await postBytes({
          url: apiUrl(baseUrl, config.path ?? versionedPath(baseUrl, "/audio/transcriptions")),
          headers: {
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            ...attributionHeaders(config, config.headers),
            ...config.headers,
          },
          body: form,
          provider,
          signal,
          redirect: "error",
          maxBytes: MAX_REPLY_BYTES,
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        });
        const body = parseObject(bytes);
        const usage = readUsage(body?.usage);
        // A failure inside a 200 is still a failure (invariant 11).
        if (body?.error !== undefined && body.error !== null) throw inBandFailure(provider, body);
        if (typeof body?.text !== "string") {
          throw unusable(provider, "the reply holds no transcript", usage);
        }
        const durationSeconds = seconds(body.duration);
        signal.throwIfAborted();
        return {
          text: body.text.trim(),
          segments: readSegments(body.segments, "text", diarize),
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          ...(usage ? { usage } : {}),
          model,
        };
      });
    },
  };
}
