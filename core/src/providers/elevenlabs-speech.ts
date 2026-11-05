// The ElevenLabs speech wire: POST {base}/v1/text-to-speech/{voice_id}, JSON in, audio bytes
// out, billed per character. One request per call; speech-core.ts says why. The voice is the
// account's voice id, and `listElevenLabsVoices` reads the ones a key can use.
import { attributionHeaders, type Attribution } from "../attribution.ts";
import { ProviderError } from "../errors.ts";
import {
  asRecord,
  describeAudio,
  prepareSpeech,
  resolveLimits,
  sniffFormat,
  synthesizeOnce,
  unusable,
  type SpeechFormat,
  type SpeechLimits,
  type SpeechProvider,
} from "../speech-core.ts";
import { apiUrl, getJson, postBytes, withDeadline, type FetchLike } from "../transport.ts";

export interface ElevenLabsSpeechConfig extends SpeechLimits, Attribution {
  apiKey: string;
  /** Default `eleven_multilingual_v2`, which speaks 29 languages. `eleven_flash_v2_5` is faster
   *  and costs half the characters. */
  model?: string;
  /** Default `https://api.elevenlabs.io`. A regional host (`https://api.eu.residency.elevenlabs.io`)
   *  is passed whole. */
  baseUrl?: string;
  /** Used when a call names no voice: a voice id, such as one `listElevenLabsVoices` returned. */
  voice?: string;
  /** Used when a call names no format. Default "wav". */
  format?: SpeechFormat;
  headers?: Record<string, string>;
  /** Swapped in tests, or to route through a proxy. Defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export const ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2";
const DEFAULT_BASE = "https://api.elevenlabs.io";

// What each format asks for. 44.1 kHz PCM and WAV need a Pro plan, so speech comes at 24 kHz,
// like the other wires; MP3 at 128 kbps and Opus at 64 kbps work on every plan.
const OUTPUT: Partial<Record<SpeechFormat, string>> = {
  wav: "wav_24000",
  pcm: "pcm_24000",
  mp3: "mp3_44100_128",
  opus: "opus_48000_64",
};
const FORMATS = Object.keys(OUTPUT) as SpeechFormat[];

/** A voice the key can use. `languages` holds the codes ElevenLabs verified for it, if any. */
export interface ElevenLabsVoice {
  id: string;
  name: string;
  /** "premade", "cloned", "generated", "professional", ... */
  category?: string;
  languages: string[];
}

export function createElevenLabsSpeechProvider(config: ElevenLabsSpeechConfig): SpeechProvider {
  const provider = "speech:elevenlabs";
  const model = config.model ?? ELEVENLABS_DEFAULT_MODEL;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE;
  const limits = resolveLimits(config);
  return {
    id: "elevenlabs",
    model,
    async synthesize(request) {
      const { text, voice, format } = prepareSpeech(provider, request, {
        apiKey: config.apiKey,
        voice: config.voice,
        format: config.format,
        maxInputChars: limits.maxInputChars,
        formats: FORMATS,
      });
      if (!config.apiKey)
        throw new ProviderError(provider, "auth", `${provider}: an API key is required`);
      return synthesizeOnce(provider, limits.timeoutMs, request, async (signal) => {
        const url = new URL(apiUrl(baseUrl, `/v1/text-to-speech/${encodeURIComponent(voice)}`));
        url.searchParams.set("output_format", OUTPUT[format] ?? "wav_24000");
        const { bytes, contentType } = await postBytes({
          url: url.href,
          headers: {
            "xi-api-key": config.apiKey,
            ...attributionHeaders(config, config.headers),
            ...config.headers,
          },
          body: { text, model_id: model },
          provider,
          signal,
          redirect: "error",
          maxBytes: limits.maxAudioBytes,
          // The body is read here for its machine code, then dropped: see `redacted`.
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        }).catch((error: unknown) => {
          throw redacted(provider, baseUrl, error);
        });
        // A JSON or text body that came with a 200 is no audio, whatever was asked for. Every
        // format but raw PCM is also named by its bytes; PCM has no header to sniff.
        if (bytes.byteLength > 0 && !sniffFormat(bytes)) {
          if (TEXTUAL.test(contentType) || startsLikeJson(bytes))
            throw unusable(provider, "unknown", "bad_audio", "the reply is text, not audio");
          if (format !== "pcm")
            throw unusable(provider, "unknown", "bad_audio", "the reply is not audio");
        }
        const result = describeAudio(provider, bytes, format, {
          model,
          voice,
          characters: text.length,
          ...(format === "pcm" ? { sampleRate: 24_000, channels: 1 } : {}),
        });
        signal.throwIfAborted();
        return result;
      });
    },
  };
}

const TEXTUAL = /^(application\/(?:[\w.+-]*\+)?json|text\/)/;
/** First byte that is not blank or a control character is "{" or "<". */
const startsLikeJson = (bytes: Uint8Array) => {
  const first = bytes.subarray(0, 16).find((byte) => byte > 0x20);
  return first === 0x7b || first === 0x3c;
};
// A key with a line break or a character outside plain ASCII makes the runtime refuse the header
// and quote its value in the error, so it is refused before any request.
const HEADER_SAFE = /^[\x20-\x7e]+$/;
const MAX_PAGES = 20;
const PAGE_TIMEOUT_MS = 30_000;

/**
 * The error a caller sees: kind, status and retry timing, never the vendor's words, which can
 * echo the text that was sent, and no URL path or query. A missing or malformed voice id is
 * ElevenLabs' 404 or 400 with `voice_not_found` or `invalid_voice_id`, which the shared
 * classifier reads as an unknown model; it is named the voice here, because the fix is another
 * voice, not another model.
 */
function redacted(provider: string, baseUrl: string, error: unknown): unknown {
  if (!(error instanceof ProviderError)) return error;
  if (error.kind === "network")
    return new ProviderError(provider, "network", `no response from ${new URL(baseUrl).origin}`);
  // Our own deadline: its words are ours, its cause is only the abort.
  if (error.kind === "timeout") return new ProviderError(provider, "timeout", error.message);
  const body = error.body ?? "";
  const voice = /"code"\s*:\s*"(voice_not_found|invalid_voice_id)"/.test(body);
  // Older answers say a spent character quota with a 401; it is the balance, not the key.
  const quota = /"(code|status)"\s*:\s*"quota_exceeded"/.test(body);
  return new ProviderError(
    provider,
    voice ? "invalid" : quota ? "quota" : error.kind,
    voice
      ? `${provider}: the voice does not exist for this key`
      : error.code
        ? error.message
        : `${provider} ${error.status ?? ""}`.trim(),
    {
      status: error.status,
      ...(voice
        ? { code: "voice_not_found", shouldRetry: false }
        : { code: error.code, shouldRetry: error.shouldRetry }),
      retryAfterMs: error.retryAfterMs,
      resetAtMs: error.resetAtMs,
      window: error.window,
    },
  );
}

/**
 * The voices an ElevenLabs key can use, through `GET /v2/voices`, up to `max` (default 100).
 * Throws a `ProviderError` the way a speech call does: a wrong key is `auth`.
 */
export async function listElevenLabsVoices(config: {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
  max?: number;
  fetchImpl?: FetchLike;
}): Promise<ElevenLabsVoice[]> {
  const provider = "speech:elevenlabs";
  const max = config.max ?? 100;
  if (!Number.isSafeInteger(max) || max < 1)
    throw new RangeError(`[providerkit] max must be a positive integer, not ${String(max)}`);
  if (!HEADER_SAFE.test(config.apiKey))
    throw new ProviderError(
      provider,
      "auth",
      `${provider}: the API key is empty or holds a character that cannot be sent in a header. Paste the key again`,
      { code: "key_invalid", shouldRetry: false },
    );
  const baseUrl = config.baseUrl ?? DEFAULT_BASE;
  const voices: ElevenLabsVoice[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  // A server that keeps saying "more" with nothing new, or the same token, ends the list: it is
  // read at most MAX_PAGES times, each page under its own deadline.
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const url = new URL(apiUrl(baseUrl, "/v2/voices"));
    url.searchParams.set("page_size", String(Math.min(100, max - voices.length)));
    url.searchParams.set("include_total_count", "false");
    if (token) url.searchParams.set("next_page_token", token);
    const page = asRecord(
      await withDeadline(provider, PAGE_TIMEOUT_MS, config.signal, (signal) =>
        getJson({
          url: url.href,
          headers: { "xi-api-key": config.apiKey },
          provider,
          redirect: "error",
          signal,
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        }),
      ).catch((error: unknown) => {
        throw redacted(provider, baseUrl, error);
      }),
    );
    const before = voices.length;
    for (const raw of Array.isArray(page?.voices) ? page.voices : []) {
      const voice = asRecord(raw);
      if (typeof voice?.voice_id !== "string" || !voice.voice_id || seen.has(voice.voice_id))
        continue;
      seen.add(voice.voice_id);
      const verified = Array.isArray(voice.verified_languages) ? voice.verified_languages : [];
      voices.push({
        id: voice.voice_id,
        name: typeof voice.name === "string" && voice.name ? voice.name : voice.voice_id,
        ...(typeof voice.category === "string" ? { category: voice.category } : {}),
        languages: [
          ...new Set(
            verified
              .map((entry) => asRecord(entry)?.language)
              .filter((language): language is string => typeof language === "string"),
          ),
        ],
      });
    }
    const next =
      page?.has_more === true && typeof page.next_page_token === "string"
        ? page.next_page_token
        : undefined;
    if (!next || next === token || voices.length === before || voices.length >= max) break;
    token = next;
  }
  return voices.slice(0, max);
}
