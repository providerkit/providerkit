// The OpenAI speech wire: POST {base}/audio/speech, JSON in, audio bytes out.
// Serves OpenAI, OpenRouter and any server that copies the route (a local Kokoro,
// a proxy). One request per call; speech-core.ts says why.
import { attributionHeaders, type Attribution } from "../attribution.ts";
import {
  asRecord,
  describeAudio,
  inBandFailure,
  prepareSpeech,
  resolveLimits,
  sniffFormat,
  SPEECH_FORMATS,
  synthesizeOnce,
  unusable,
  type SpeechError,
  type SpeechFormat,
  type SpeechLimits,
  type SpeechProvider,
} from "../speech-core.ts";
import { apiUrl, postBytes, versionedPath } from "../transport.ts";

export interface OpenAISpeechConfig extends SpeechLimits, Attribution {
  /** "" sends no Authorization header, for a local server that wants none. */
  apiKey: string;
  model: string;
  /** Default `https://api.openai.com`. */
  baseUrl?: string;
  /** Default `/v1/audio/speech`, or `/audio/speech` when the base already ends in a version. */
  path?: string;
  /** The preset id. Names the provider in errors and on `SpeechProvider.id`. Default "openai". */
  id?: string;
  /** Used when a call names no voice. */
  voice?: string;
  /** Used when a call names no format. Default "wav". It is always sent: each host's own
   *  default differs (mp3, wav, pcm), and "I never asked" must not choose for the caller. */
  format?: SpeechFormat;
  headers?: Record<string, string>;
  /** Swapped in tests, or to route through a proxy. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// A JSON or text body is an error that arrived with a 200, not audio.
const TEXT_TYPE = /^(application\/(?:[\w.+-]*\+)?json|text\/)/;

/** First byte that is not blank or a control character is "{". */
const startsLikeJson = (bytes: Uint8Array) => bytes.subarray(0, 16).find((b) => b > 0x20) === 0x7b;

/**
 * A 200 reply that is not audio: a JSON error, or JSON or text where audio belongs.
 * Audio is named by its bytes first, so a server that sends audio under a wrong
 * content type still gets through. `undefined` means the bytes may be audio.
 */
function notAudio(
  provider: string,
  bytes: Uint8Array,
  contentType: string,
): SpeechError | undefined {
  if (bytes.byteLength === 0 || sniffFormat(bytes)) return undefined;
  const textual = TEXT_TYPE.test(contentType);
  const body = textual || startsLikeJson(bytes) ? parseObject(bytes) : undefined;
  if (body) {
    return body.error !== undefined || body.errors !== undefined
      ? inBandFailure(provider, body)
      : unusable(provider, "unknown", "bad_audio", "the reply is JSON and holds no audio");
  }
  return textual
    ? unusable(provider, "unknown", "bad_audio", "the reply is text, not audio")
    : undefined;
}

/** Only the head is read: an error object sits at the start of a body. */
function parseObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(new TextDecoder().decode(bytes.subarray(0, 64 * 1024))));
  } catch {
    return undefined;
  }
}

export function createOpenAISpeechProvider(config: OpenAISpeechConfig): SpeechProvider {
  const id = config.id ?? "openai";
  const provider = `speech:${id}`;
  const baseUrl = config.baseUrl ?? "https://api.openai.com";
  const limits = resolveLimits(config);
  return {
    id,
    model: config.model,
    async synthesize(request) {
      const { text, voice, format } = prepareSpeech(provider, request, {
        voice: config.voice,
        format: config.format,
        maxInputChars: limits.maxInputChars,
        formats: SPEECH_FORMATS,
      });
      return synthesizeOnce(provider, limits.timeoutMs, request, async (signal) => {
        const { bytes, contentType } = await postBytes({
          url: apiUrl(baseUrl, config.path ?? versionedPath(baseUrl, "/audio/speech")),
          headers: {
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            ...attributionHeaders(config, config.headers),
            ...config.headers,
          },
          body: { model: config.model, input: text, voice, response_format: format },
          provider,
          signal,
          redirect: "error",
          maxBytes: limits.maxAudioBytes,
          redactErrors: true,
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        });
        // A failure inside a 200 is still a failure (invariant 11).
        const problem = notAudio(provider, bytes, contentType);
        if (problem) throw problem;
        const result = describeAudio(provider, bytes, format, {
          model: config.model,
          voice,
          characters: text.length,
        });
        signal.throwIfAborted();
        return result;
      });
    },
  };
}
