// Speech: text in, one audio clip out. A second kind of client next to `Provider`,
// reached through `@providerkit/core/speech` so a chat-only app never loads it.
//
// This file holds what both wires share: the types, the error, and the byte-level
// checks. Two rules run through all of it.
//
// 1. A paid synthesis is never replayed. A speech reply arrives whole, so there is
//    no "nothing was emitted yet" the way a chat stream has: a timeout or a dropped
//    socket may land after the vendor started billing. One request per call.
// 2. Audio is named by its own bytes, not by what was asked for. Many servers ignore
//    the format they were sent, and "WebM with an MP4 name" is not MP4.
import { ProviderError, streamError, type ErrorKind } from "./errors.ts";
import { withDeadline } from "./transport.ts";
import type { TokenUsage } from "./types.ts";

export const SPEECH_FORMATS = ["wav", "pcm", "mp3", "opus", "aac", "flac"] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

/** Which wire speaks. A third shape is one new file and one preset row. */
export type SpeechShape = "openai" | "gemini";

export interface SpeechRequest {
  /** What to say. Trimmed first. Empty is refused before any request. */
  text: string;
  /** The voice as the endpoint spells it ("Kore", "alloy"). Absent: the provider's default. */
  voice?: string;
  /** Absent: the provider's default format, else "wav". */
  format?: SpeechFormat;
  /** The caller's Stop. Never retried and never turned into a timeout. */
  signal?: AbortSignal;
}

/** Token counts the provider stated. `totalTokens` can exceed input plus output:
 *  the gap is what the provider counts and does not break out. */
export interface SpeechUsage extends TokenUsage {
  totalTokens?: number;
}

export interface SpeechResult {
  bytes: Uint8Array;
  /** Read from the bytes, so it can differ from the format asked for. */
  format: SpeechFormat;
  /** The media type of `format`. */
  mimeType: string;
  /** Hz. Only when the bytes (a WAV header) or the request state it. */
  sampleRate?: number;
  /** Only when the bytes or the provider state it. */
  channels?: number;
  /** Exact, from a WAV header that checks out. Absent for every other format:
   *  measuring those takes a decoder, and a guess here would be wrong in the ledger. */
  durationMs?: number;
  /** Characters sent after trimming, for endpoints billed per character. */
  characters: number;
  /** Only when the provider reported it. Never estimated. */
  usage?: SpeechUsage;
  /** The model and voice that were asked for. */
  model: string;
  voice: string;
}

export interface SpeechProvider {
  readonly id: string;
  readonly model: string;
  /**
   * Exactly one HTTP request. No retry, no fallback, no second key. Throws a
   * `ProviderError`; a reply that arrived but holds no usable audio throws a
   * `SpeechError`, which keeps the usage the provider billed for it.
   */
  synthesize(request: SpeechRequest): Promise<SpeechResult>;
}

export interface SpeechLimits {
  /** Longest `text`, in UTF-16 units (JavaScript's `.length`). Default 4,096.
   *  Over it is refused before any request. Never silently cut. */
  maxInputChars?: number;
  /** Largest audio accepted, in bytes. Default 32 MiB. */
  maxAudioBytes?: number;
  /** One deadline for the whole call, headers and body. Default 120,000. */
  timeoutMs?: number;
}

export const DEFAULT_SPEECH_LIMITS = {
  maxInputChars: 4_096,
  maxAudioBytes: 32 * 1024 * 1024,
  timeoutMs: 120_000,
} as const satisfies Required<SpeechLimits>;

type ProviderErrorOptions = NonNullable<ConstructorParameters<typeof ProviderError>[3]>;

/**
 * A reply that arrived but holds no usable audio, or a failure the provider
 * reported inside a 200. Carries the usage the provider stated for it, because it
 * billed that: a caller that drops this loses the only record of the charge.
 * Plain `ProviderError`s carry no usage.
 */
export class SpeechError extends ProviderError {
  readonly usage?: SpeechUsage;

  constructor(
    provider: string,
    kind: ErrorKind,
    message: string,
    opts: ProviderErrorOptions & { usage?: SpeechUsage } = {},
  ) {
    const { usage, ...rest } = opts;
    super(provider, kind, message, rest);
    this.name = "SpeechError";
    this.usage = usage;
  }
}

/** @internal Positive integers or a RangeError, at build time, never mid-call. */
export function resolveLimits(config: SpeechLimits): Required<SpeechLimits> {
  const limits = {
    maxInputChars: config.maxInputChars ?? DEFAULT_SPEECH_LIMITS.maxInputChars,
    maxAudioBytes: config.maxAudioBytes ?? DEFAULT_SPEECH_LIMITS.maxAudioBytes,
    timeoutMs: config.timeoutMs ?? DEFAULT_SPEECH_LIMITS.timeoutMs,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`[providerkit] ${name} must be a positive integer`);
    }
  }
  return limits;
}

const refuse = (provider: string, code: string, message: string) =>
  new ProviderError(provider, "invalid", `${provider}: ${message}`, { code, shouldRetry: false });

/**
 * @internal Trim, bound and fill in defaults. Throws `invalid` BEFORE any request,
 * and never puts the text in the message: it is the caller's, and may be private.
 */
export function prepareSpeech(
  provider: string,
  request: SpeechRequest,
  defaults: {
    voice?: string;
    format?: SpeechFormat;
    maxInputChars: number;
    /** What this wire can make. */
    formats: readonly SpeechFormat[];
  },
): { text: string; voice: string; format: SpeechFormat } {
  const text = typeof request.text === "string" ? request.text.trim() : "";
  if (!text) throw refuse(provider, "text_empty", "there is no text to speak");
  if (text.length > defaults.maxInputChars) {
    throw refuse(
      provider,
      "text_too_long",
      `the text is ${text.length} characters and the limit is ${defaults.maxInputChars}`,
    );
  }
  const voice = (request.voice ?? defaults.voice)?.trim();
  if (!voice) throw refuse(provider, "voice_required", "this provider needs a voice name");
  const format = request.format ?? defaults.format ?? "wav";
  if (!defaults.formats.includes(format)) {
    throw refuse(
      provider,
      "format_unsupported",
      `this provider cannot make ${String(format)}. It makes ${defaults.formats.join(", ")}`,
    );
  }
  return { text, voice, format };
}

const REPLAY_UNSAFE: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  "network",
  "timeout",
  "overload",
  "unknown",
]);

function neverRetry(err: ProviderError): ProviderError {
  const opts = {
    status: err.status,
    code: err.code,
    retryAfterMs: err.retryAfterMs,
    resetAtMs: err.resetAtMs,
    window: err.window,
    shouldRetry: false,
    body: err.body,
    cause: err.cause,
  };
  return err instanceof SpeechError
    ? new SpeechError(err.provider, err.kind, err.message, { ...opts, usage: err.usage })
    : new ProviderError(err.provider, err.kind, err.message, opts);
}

/**
 * @internal The "could the vendor already have billed this?" rule, applied in one
 * place so a new failure path cannot forget it.
 *
 * - The caller's Stop comes back untouched.
 * - A timeout, a dead socket, a 5xx or anything unclassified may have landed after
 *   the vendor started work, so it is marked `shouldRetry: false`. A vendor that
 *   says `x-should-retry: true` is believed.
 * - A 429 keeps its default. The vendor refused before doing any work, so sending
 *   it again is safe, and `Retry-After` is honoured by the caller's own retry.
 */
export function noReplay(provider: string, error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return error;
  const err = ProviderError.from(provider, error);
  return err.shouldRetry === undefined && REPLAY_UNSAFE.has(err.kind) ? neverRetry(err) : err;
}

/**
 * @internal The one place a call runs: under one deadline, once, and with the
 * no-replay rule applied to whatever it throws. Both wires go through here.
 */
export async function synthesizeOnce<T>(
  provider: string,
  timeoutMs: number,
  request: SpeechRequest,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await withDeadline(provider, timeoutMs, request.signal, call);
  } catch (error) {
    throw noReplay(provider, error, request.signal);
  }
}

// ── failures ──────────────────────────────────────────────────────────────

/** @internal A reply that arrived but cannot be used. Never retried: it was billed. */
export function unusable(
  provider: string,
  kind: ErrorKind,
  code: string,
  message: string,
  usage?: SpeechUsage,
): SpeechError {
  return new SpeechError(provider, kind, `${provider}: ${message}`, {
    code,
    shouldRetry: false,
    ...(usage ? { usage } : {}),
  });
}

/**
 * @internal A failure the provider reported inside a 200 body (a gateway that
 * answers 200 with a JSON error, an Interactions reply that says it failed). It is
 * classified like any other failure, with the same words-over-status rules, and
 * then the provider's words are dropped: they can echo the text that was sent.
 */
export function inBandFailure(
  provider: string,
  envelope: unknown,
  usage?: SpeechUsage,
): SpeechError {
  const found = streamError(provider, envelope);
  return new SpeechError(provider, found.kind, `${provider}: the provider reported ${found.kind}`, {
    status: found.status,
    retryAfterMs: found.retryAfterMs,
    resetAtMs: found.resetAtMs,
    window: found.window,
    ...(usage ? { usage } : {}),
  });
}

/** @internal */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ── bytes ─────────────────────────────────────────────────────────────────

/**
 * @internal Strict base64 to bytes: the length is a multiple of 4, the alphabet is
 * the standard one, padding sits only at the end. `atob` alone is too forgiving:
 * it drops whitespace and accepts missing padding. `undefined` on anything else.
 */
export function decodeBase64(data: string): Uint8Array | undefined {
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return undefined;
  }
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  if (at < 0 || at + length > bytes.byteLength) return "";
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[at + i]!);
  return out;
}

/** The first three bytes of an MPEG audio frame: Layer III is mp3, and a zero layer
 *  field behind twelve sync bits is AAC in ADTS. Layer I and II are neither. */
function mpegAudio(
  b0: number | undefined,
  b1: number | undefined,
  b2: number | undefined,
): "mp3" | "aac" | undefined {
  if (b0 !== 0xff || b1 === undefined || b2 === undefined || (b1 & 0xe0) !== 0xe0) {
    return undefined;
  }
  const layer = (b1 >> 1) & 3;
  if (layer === 0) return (b1 & 0xf0) === 0xf0 && ((b2 >> 2) & 15) < 13 ? "aac" : undefined;
  const reservedVersion = ((b1 >> 3) & 3) === 1;
  const reservedBitrate = b2 >> 4 === 15;
  const reservedRate = ((b2 >> 2) & 3) === 3;
  return layer === 1 && !reservedVersion && !reservedBitrate && !reservedRate ? "mp3" : undefined;
}

/** A format with a signature in its first bytes. Raw PCM has none. */
type ContainerFormat = Exclude<SpeechFormat, "pcm">;

/**
 * @internal Which container the first bytes say this is, or `undefined`. Raw PCM
 * has no signature, so it is never returned here. ADTS AAC and mp3 share a sync
 * pattern and are told apart by their layer field.
 */
export function sniffFormat(bytes: Uint8Array): ContainerFormat | undefined {
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (ascii(bytes, 0, 4) === "OggS") {
    // The first packet starts after the page's 27-byte header and its segment table.
    return ascii(bytes, 27 + (bytes[26] ?? 0), 8) === "OpusHead" ? "opus" : undefined;
  }
  let at = 0;
  if (ascii(bytes, 0, 3) === "ID3" && bytes.byteLength >= 10) {
    // An ID3v2 tag in front of the audio: a 10-byte header whose size is four
    // 7-bit bytes, plus a 10-byte footer when flag bit 4 says there is one.
    const size =
      ((bytes[6]! & 0x7f) << 21) |
      ((bytes[7]! & 0x7f) << 14) |
      ((bytes[8]! & 0x7f) << 7) |
      (bytes[9]! & 0x7f);
    at = 10 + size + (bytes[5]! & 0x10 ? 10 : 0);
  }
  return mpegAudio(bytes[at], bytes[at + 1], bytes[at + 2]);
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Samples per channel. */
  frames: number;
  durationMs: number;
}

/**
 * Read a WAV file's own numbers, strictly. PCM only (format tag 1). The RIFF size
 * is exact, every chunk sits inside the file, there is one `fmt ` before one
 * non-empty `data` that holds whole frames, and nothing trails. Extra chunks such
 * as `LIST` are skipped, and odd-sized chunks carry their pad byte. `undefined`
 * on anything else. It reports what the bytes say; whether 24 kHz mono is
 * acceptable is the caller's policy.
 */
export function readWav(bytes: Uint8Array): WavInfo | undefined {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.byteLength - 8) return undefined;
  let fmt: (Omit<WavInfo, "frames" | "durationMs"> & { blockAlign: number }) | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  let chunks = 0;
  while (offset < bytes.byteLength) {
    if (++chunks > 1024 || bytes.byteLength - offset < 8) return undefined;
    const name = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const paddedEnd = start + size + (size % 2);
    if (start + size > bytes.byteLength || paddedEnd > bytes.byteLength) return undefined;
    if (name === "fmt ") {
      if (fmt || (size !== 16 && size !== 18)) return undefined;
      const channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true);
      const blockAlign = view.getUint16(start + 12, true);
      const bitsPerSample = view.getUint16(start + 14, true);
      if (
        view.getUint16(start, true) !== 1 ||
        channels < 1 ||
        sampleRate < 1 ||
        bitsPerSample === 0 ||
        bitsPerSample % 8 !== 0 ||
        blockAlign !== (channels * bitsPerSample) / 8 ||
        view.getUint32(start + 8, true) !== sampleRate * blockAlign ||
        (size === 18 && view.getUint16(start + 16, true) !== 0)
      ) {
        return undefined;
      }
      fmt = { sampleRate, channels, bitsPerSample, blockAlign };
    } else if (name === "data") {
      if (!fmt || dataBytes !== undefined || size === 0 || size % fmt.blockAlign !== 0) {
        return undefined;
      }
      dataBytes = size;
    } else if (name === "RIFF" || name === "RIFX" || name === "RF64") {
      return undefined;
    }
    offset = paddedEnd;
  }
  if (!fmt || dataBytes === undefined) return undefined;
  const frames = dataBytes / fmt.blockAlign;
  const { blockAlign: _blockAlign, ...info } = fmt;
  return { ...info, frames, durationMs: (frames / fmt.sampleRate) * 1000 };
}

const MIME: Record<ContainerFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  opus: "audio/ogg; codecs=opus",
  aac: "audio/aac",
  flac: "audio/flac",
};

/** @internal Everything a result needs besides the audio itself. */
export interface AudioExtras {
  model: string;
  voice: string;
  characters: number;
  usage?: SpeechUsage;
  /** What the request or the provider stated, for raw PCM only. */
  sampleRate?: number;
  channels?: number;
}

/**
 * @internal Bytes in, `SpeechResult` out. An empty body is `empty_audio`. A
 * recognised container is accepted whatever was asked for, and `format` says what
 * it really is. Raw PCM is the one case with no signature to read, so it is
 * accepted only when PCM was asked for and the length is whole samples. Anything
 * else is `bad_audio`.
 *
 * A WAV is labelled by its signature. Its numbers (rate, channels, duration) are
 * filled in only when the header checks out, so a server whose header lies still
 * gets its audio through, without a duration anyone could take as measured.
 */
export function describeAudio(
  provider: string,
  bytes: Uint8Array,
  wanted: SpeechFormat,
  extras: AudioExtras,
): SpeechResult {
  if (bytes.byteLength === 0) {
    throw unusable(provider, "overload", "empty_audio", "the reply holds no audio", extras.usage);
  }
  const base = {
    bytes,
    characters: extras.characters,
    model: extras.model,
    voice: extras.voice,
    ...(extras.usage ? { usage: extras.usage } : {}),
  };
  const sniffed = sniffFormat(bytes);
  if (sniffed === "wav") {
    const wav = readWav(bytes);
    return {
      ...base,
      format: "wav",
      mimeType: MIME.wav,
      ...(wav
        ? { sampleRate: wav.sampleRate, channels: wav.channels, durationMs: wav.durationMs }
        : {}),
    };
  }
  if (sniffed) return { ...base, format: sniffed, mimeType: MIME[sniffed] };
  if (wanted !== "pcm" || bytes.byteLength % 2 !== 0) {
    throw unusable(
      provider,
      "unknown",
      "bad_audio",
      "the reply is not audio this package recognises",
      extras.usage,
    );
  }
  const { sampleRate, channels } = extras;
  return {
    ...base,
    format: "pcm",
    mimeType: sampleRate ? `audio/L16;rate=${sampleRate}` : "audio/L16",
    ...(sampleRate ? { sampleRate } : {}),
    ...(channels ? { channels } : {}),
    ...(sampleRate && channels
      ? { durationMs: (bytes.byteLength / 2 / channels / sampleRate) * 1000 }
      : {}),
  };
}
