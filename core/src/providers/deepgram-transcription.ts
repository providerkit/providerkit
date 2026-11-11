// The Deepgram wire: POST {base}/v1/listen with the recording as the raw body, JSON out. One
// request per call; transcription-core.ts says why. Deepgram is not a chat preset, so it has
// its own constructor instead of a preset row, as ElevenLabs does for speech.
import { attributionHeaders, type Attribution } from "../attribution.ts";
import {
  asRecord,
  MAX_REPLY_BYTES,
  parseObject,
  prepareTranscription,
  readSegments,
  resolveLimits,
  seconds,
  transcribeOnce,
  unusable,
  type TranscriptionLimits,
  type TranscriptionProvider,
} from "../transcription-core.ts";
import { apiUrl, postBytes, type FetchLike } from "../transport.ts";

export interface DeepgramTranscriptionConfig extends TranscriptionLimits, Attribution {
  apiKey: string;
  /** Default `nova-3`. */
  model?: string;
  /** Default `https://api.deepgram.com`. Another host (a self-hosted Deepgram) is passed whole. */
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Swapped in tests, or to route through a proxy. Defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export const DEEPGRAM_DEFAULT_MODEL = "nova-3";
/** Deepgram's documented upload limit, "Maximum 2 GB" (read 2026-11-11). */
const MAX_AUDIO_BYTES = 2_000_000_000;

/**
 * Build a Deepgram transcription provider.
 *
 * ```ts
 * const listen = createDeepgramTranscriptionProvider({ apiKey });
 * const { text } = await listen.transcribe({ audio: file, language: "pt-BR" });
 * ```
 */
export function createDeepgramTranscriptionProvider(
  config: DeepgramTranscriptionConfig,
): TranscriptionProvider {
  const provider = "transcription:deepgram";
  const defaultModel = config.model ?? DEEPGRAM_DEFAULT_MODEL;
  const baseUrl = config.baseUrl ?? "https://api.deepgram.com";
  const limits = resolveLimits(config, MAX_AUDIO_BYTES);
  return {
    id: "deepgram",
    model: defaultModel,
    async transcribe(request) {
      const { audio, model, language, diarize } = prepareTranscription(provider, request, {
        apiKey: config.apiKey,
        keyRequired: true,
        model: defaultModel,
        maxAudioBytes: limits.maxAudioBytes,
      });
      return transcribeOnce(provider, limits.timeoutMs, request, async (signal) => {
        const url = new URL(apiUrl(baseUrl, "/v1/listen"));
        url.searchParams.set("model", model);
        // Absent, Deepgram assumes English rather than listening for the language, so the
        // neutral "absent: detect it" is asked for in words.
        if (language) url.searchParams.set("language", language);
        else url.searchParams.set("detect_language", "true");
        url.searchParams.set("punctuate", "true");
        url.searchParams.set("smart_format", "true");
        // Utterances are the timed segments, asked for on every call so `segments` is filled
        // whether or not speakers were. `diarize_model` is what turns speakers on: the older
        // `diarize` flag is deprecated, and naming a model enables it (Deepgram's reference).
        url.searchParams.set("utterances", "true");
        if (diarize) url.searchParams.set("diarize_model", "latest");
        const { bytes } = await postBytes({
          url: url.href,
          headers: {
            authorization: `Token ${config.apiKey}`,
            "content-type": audio.type,
            ...attributionHeaders(config, config.headers),
            ...config.headers,
          },
          body: audio,
          provider,
          signal,
          redirect: "error",
          maxBytes: MAX_REPLY_BYTES,
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        });
        const body = parseObject(bytes);
        const results = asRecord(body?.results);
        const channel = asRecord(Array.isArray(results?.channels) ? results.channels[0] : null);
        const best = asRecord(
          Array.isArray(channel?.alternatives) ? channel.alternatives[0] : null,
        );
        if (typeof best?.transcript !== "string") {
          throw unusable(provider, "the reply holds no transcript");
        }
        const durationSeconds = seconds(asRecord(body?.metadata)?.duration);
        signal.throwIfAborted();
        return {
          text: best.transcript.trim(),
          segments: readSegments(results?.utterances, "transcript", diarize),
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          model,
        };
      });
    },
  };
}
