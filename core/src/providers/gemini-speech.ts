// The Gemini speech wire: POST /v1beta/interactions, JSON in, JSON out with the audio
// as base64. One request per call; speech-core.ts says why.
//
// The request is the one an adopter has already run against the live API. Fields it
// has not proven are not sent: `mime_type` rides only on a raw PCM request, and
// `scripts/probe-speech.ts` is how a maintainer settles the rest with a real key.
import {
  asRecord,
  decodeBase64,
  describeAudio,
  inBandFailure,
  prepareSpeech,
  resolveLimits,
  synthesizeOnce,
  unusable,
  type SpeechFormat,
  type SpeechLimits,
  type SpeechProvider,
  type SpeechUsage,
} from "../speech-core.ts";
import { apiUrl, postBytes, versionedPath } from "../transport.ts";

export interface GeminiSpeechConfig extends SpeechLimits {
  apiKey: string;
  model: string;
  /** Default `https://generativelanguage.googleapis.com`. */
  baseUrl?: string;
  /** Default `/v1beta/interactions`. */
  path?: string;
  /** The preset id. Names the provider in errors and on `SpeechProvider.id`. Default "google". */
  id?: string;
  /** Used when a call names no voice. */
  voice?: string;
  /** "wav" (the default) or "pcm". Gemini makes no other format. */
  format?: SpeechFormat;
  /**
   * Caps the audio tokens generated. Not sent unless set. Whether a TTS model
   * honours the cap is unmeasured; the text limit is the real bound on cost.
   */
  maxOutputTokens?: number;
  headers?: Record<string, string>;
  /** Swapped in tests, or to route through a proxy. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const FORMATS: readonly SpeechFormat[] = ["wav", "pcm"];

/** The rate a raw PCM request asks for, and the only one this adapter asks for. */
const PCM_RATE = 24_000;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * The provider's own token counts, or nothing. Counts that do not add up are
 * dropped whole: a wrong number in a ledger is worse than a missing one.
 */
function readUsage(raw: unknown): SpeechUsage | undefined {
  const usage = asRecord(raw);
  const input = count(usage?.total_input_tokens);
  const output = count(usage?.total_output_tokens);
  const total = count(usage?.total_tokens);
  if (input === undefined || output === undefined || total === undefined) return undefined;
  if (!Number.isSafeInteger(input + output) || total < input + output) return undefined;
  let cached = 0;
  if (usage?.total_cached_tokens !== undefined) {
    const reported = count(usage.total_cached_tokens);
    if (reported === undefined || reported > input) return undefined;
    cached = reported;
  }
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens: total,
  };
}

export function createGeminiSpeechProvider(config: GeminiSpeechConfig): SpeechProvider {
  const id = config.id ?? "google";
  const provider = `speech:${id}`;
  const baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com";
  const limits = resolveLimits(config);
  if (config.maxOutputTokens !== undefined && (count(config.maxOutputTokens) ?? 0) < 1) {
    throw new RangeError("[providerkit] maxOutputTokens must be a positive integer");
  }
  // The reply is JSON with the audio as base64: four characters for every three bytes,
  // plus a bounded envelope around it.
  const maxBase64 = Math.ceil(limits.maxAudioBytes / 3) * 4;
  return {
    id,
    model: config.model,
    async synthesize(request) {
      const { text, voice, format } = prepareSpeech(provider, request, {
        apiKey: config.apiKey,
        voice: config.voice,
        format: config.format,
        maxInputChars: limits.maxInputChars,
        formats: FORMATS,
      });
      return synthesizeOnce(provider, limits.timeoutMs, request, async (signal) => {
        const { bytes, contentType } = await postBytes({
          url: apiUrl(baseUrl, config.path ?? versionedPath(baseUrl, "/interactions", "v1beta")),
          headers: {
            ...(config.apiKey ? { "x-goog-api-key": config.apiKey } : {}),
            ...config.headers,
          },
          body: {
            model: config.model,
            // Do not keep the person's text on the provider's side.
            store: false,
            input: [{ type: "user_input", content: [{ type: "text", text }] }],
            response_format:
              format === "pcm"
                ? { type: "audio", mime_type: "audio/l16", sample_rate: PCM_RATE }
                : { type: "audio" },
            generation_config: {
              ...(config.maxOutputTokens ? { max_output_tokens: config.maxOutputTokens } : {}),
              // ponytail: Google's speech guide writes `speech_config`, its API reference writes
              // `structured_speech_config`. This is the spelling that has run live. One field is
              // the whole fix if the probe ever shows it stale.
              speech_config: [{ voice }],
            },
          },
          provider,
          signal,
          redirect: "error",
          maxBytes: maxBase64 + 64 * 1024,
          redactErrors: true,
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        });
        const envelope = contentType === "application/json" ? parseEnvelope(bytes) : undefined;
        if (!envelope)
          throw unusable(provider, "unknown", "bad_audio", "the reply is not a JSON object");
        // From here on the provider has answered, so it has billed: every failure
        // below carries the usage it stated.
        const usage = readUsage(envelope.usage);
        if (envelope.error !== undefined) throw inBandFailure(provider, envelope, usage);
        const status = envelope.status;
        if (status === "incomplete") {
          throw unusable(
            provider,
            "invalid",
            "incomplete",
            "the audio stopped before it finished: shorten the text or raise maxOutputTokens",
            usage,
          );
        }
        if (status === "failed" || status === "cancelled") {
          const reported = Array.isArray(envelope.errors) ? envelope.errors[0] : undefined;
          throw reported !== undefined
            ? inBandFailure(provider, reported, usage)
            : unusable(provider, "unknown", status, `the interaction ${status}`, usage);
        }
        if (status !== "completed") {
          throw unusable(
            provider,
            "unknown",
            "unexpected_status",
            "the interaction did not complete",
            usage,
          );
        }
        const block = lastAudioBlock(envelope);
        if (!block)
          throw unusable(provider, "overload", "empty_audio", "the reply holds no audio", usage);
        // A link instead of data is refused and never fetched: a reply must not choose
        // which address this package calls next.
        if (typeof block.data !== "string" || block.data === "") {
          throw unusable(
            provider,
            "unknown",
            "bad_audio",
            "the audio block has no inline data",
            usage,
          );
        }
        const tooLarge = () =>
          unusable(
            provider,
            "invalid",
            "response_too_large",
            "the audio is larger than the limit",
            usage,
          );
        if (block.data.length > maxBase64) throw tooLarge();
        const audio = decodeBase64(block.data);
        if (!audio)
          throw unusable(provider, "unknown", "bad_audio", "the audio is not valid base64", usage);
        if (audio.byteLength > limits.maxAudioBytes) throw tooLarge();
        const result = describeAudio(provider, audio, format, {
          model: config.model,
          voice,
          characters: text.length,
          ...(usage ? { usage } : {}),
          // Raw PCM has no header. The rate was in the request, and the block may state
          // the channel count. ponytail: these two block field names come from the API
          // reference and are unverified, which is why a wrong value is ignored.
          ...(format === "pcm" ? { sampleRate: count(block.sample_rate) || PCM_RATE } : {}),
          ...(format === "pcm" && count(block.channels) ? { channels: count(block.channels) } : {}),
        });
        signal.throwIfAborted();
        return result;
      });
    },
  };
}

/** The last audio block across the `model_output` steps wins: an earlier invalid block
 *  is never preferred over it. */
function lastAudioBlock(envelope: Record<string, unknown>): Record<string, unknown> | undefined {
  const steps: unknown[] = Array.isArray(envelope.steps) ? envelope.steps : [];
  let block: Record<string, unknown> | undefined;
  for (const step of steps) {
    const record = asRecord(step);
    if (record?.type !== "model_output" || !Array.isArray(record.content)) continue;
    const parts: unknown[] = record.content;
    for (const part of parts) {
      const candidate = asRecord(part);
      if (candidate?.type === "audio") block = candidate;
    }
  }
  return block;
}

function parseEnvelope(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}
