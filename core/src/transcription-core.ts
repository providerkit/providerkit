// Transcription: one recording in, its text out. The inverse of speech, and a third kind of
// client next to `Provider`, reached through `@providerkit/core/transcription` so a chat-only
// app never loads it.
//
// This file holds what both wires share: the types, the error, the checks made before a
// request, and the rule that a paid transcription is never replayed. A recording is billed by
// its length the moment the vendor starts on it, so a timeout or a dropped socket after the
// upload may already have cost money. One request per call (invariant 16).
import { ProviderError, streamError, type ErrorKind } from "./errors.ts";
import { callOnce, type ErrorRebuild } from "./transport.ts";

/** Which wire listens. A second shape is one new file and one preset row. */
export type TranscriptionShape = "openai";

export interface TranscriptionRequest {
  /**
   * The recording. A `File` is a `Blob`. Its `type` is required ("audio/wav", "audio/mpeg"):
   * Deepgram reads the format from the Content-Type it becomes, OpenAI from the file name it
   * implies. Empty, untyped or over `maxAudioBytes` is refused before any request.
   */
  audio: Blob;
  /** This call's model. Absent: the provider's. */
  model?: string;
  /** BCP-47, such as "pt-BR". Absent: the provider detects the language. */
  language?: string;
  /** Label who speaks each segment. Absent or false: no speaker labels. */
  diarize?: boolean;
  /** The caller's Stop. Never retried and never turned into a timeout. */
  signal?: AbortSignal;
}

export interface TranscriptionSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
  /**
   * Who spoke, as the provider labels them: Deepgram counts from 0, OpenAI sends a string.
   * Only when `diarize` was asked for and the provider said.
   */
  speaker?: number | string;
}

/**
 * What the provider stated it billed for, in its own unit. Never estimated. Deepgram states
 * none: it bills by the recording's length, which is `durationSeconds`.
 */
export type TranscriptionUsage =
  | {
      type: "tokens";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      /** The parts of `inputTokens` that were audio and prompt text, when stated. */
      audioTokens?: number;
      textTokens?: number;
    }
  | { type: "duration"; seconds: number };

export interface TranscriptionResult {
  /** The whole transcript. "" when nobody spoke. */
  text: string;
  /** Timed pieces of the transcript. Empty when the wire or the model gives none. */
  segments: TranscriptionSegment[];
  /** The recording's length in seconds, as the provider stated it. Never estimated. */
  durationSeconds?: number;
  /** Only when the provider reported it. */
  usage?: TranscriptionUsage;
  /** The model that was asked for. */
  model: string;
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly model: string;
  /**
   * Exactly one HTTP request. No retry, no fallback, no second key. Throws a
   * `ProviderError`; a reply that arrived but holds no usable transcript throws a
   * `TranscriptionError`, which keeps the usage the provider billed for it.
   */
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface TranscriptionLimits {
  /** Largest recording sent, in bytes. Default 25 MiB, OpenAI's documented limit; Deepgram's
   *  own wire defaults to its 2 GB. Over it is refused before any request. Never cut. */
  maxAudioBytes?: number;
  /** One deadline for the whole call: the upload, the work and the reply. Default 600,000:
   *  ten minutes, past which Deepgram itself answers 504. */
  timeoutMs?: number;
}

export const DEFAULT_TRANSCRIPTION_LIMITS = {
  maxAudioBytes: 25 * 1024 * 1024,
  timeoutMs: 600_000,
} as const satisfies Required<TranscriptionLimits>;

/**
 * The largest reply read. A transcript is text, and an hour of speech with every word timed is
 * a few megabytes, so this only stops a runaway server from filling an MV3 worker's memory.
 */
export const MAX_REPLY_BYTES = 64 * 1024 * 1024;

type ProviderErrorOptions = NonNullable<ConstructorParameters<typeof ProviderError>[3]>;

/**
 * A reply that arrived but holds no usable transcript, or a failure the provider reported
 * inside a 200. Carries the usage the provider stated for it, because it billed that: a caller
 * that drops this loses the only record of the charge. Plain `ProviderError`s carry no usage.
 */
export class TranscriptionError extends ProviderError {
  readonly usage?: TranscriptionUsage;

  constructor(
    provider: string,
    kind: ErrorKind,
    message: string,
    opts: ProviderErrorOptions & { usage?: TranscriptionUsage } = {},
  ) {
    const { usage, ...rest } = opts;
    super(provider, kind, message, rest);
    this.name = "TranscriptionError";
    this.usage = usage;
  }
}

/** @internal Positive integers or a RangeError, at build time, never mid-call. */
export function resolveLimits(
  config: TranscriptionLimits,
  maxAudioBytes: number = DEFAULT_TRANSCRIPTION_LIMITS.maxAudioBytes,
): Required<TranscriptionLimits> {
  const limits = {
    maxAudioBytes: config.maxAudioBytes ?? maxAudioBytes,
    timeoutMs: config.timeoutMs ?? DEFAULT_TRANSCRIPTION_LIMITS.timeoutMs,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`[providerkit] ${name} must be a positive integer`);
    }
  }
  return limits;
}

const refuse = (provider: string, code: string, message: string, kind: ErrorKind = "invalid") =>
  new ProviderError(provider, kind, `${provider}: ${message}`, { code, shouldRetry: false });

/** Space to tilde. Anything else in a header value is refused or altered by a runtime, which
 *  then quotes the value, key included, in its error. */
const HEADER_SAFE = /^[\x20-\x7e]*$/;

/** The media type without its parameters, lowercased: "audio/ogg; codecs=opus" is "audio/ogg". */
export const mediaType = (type: string) => type.split(";")[0]!.trim().toLowerCase();

/**
 * @internal Check what the call carries and fill in its model. Throws BEFORE any request, so a
 * recording that cannot go is never uploaded, and a refusal costs nothing.
 */
export function prepareTranscription(
  provider: string,
  request: TranscriptionRequest,
  defaults: {
    /** Checked, never echoed. */
    apiKey: string;
    /** Deepgram has no keyless mode; a local OpenAI-shaped server may. */
    keyRequired: boolean;
    model: string;
    maxAudioBytes: number;
  },
): { audio: Blob; model: string; language?: string; diarize: boolean } {
  if (!HEADER_SAFE.test(defaults.apiKey) || (defaults.keyRequired && !defaults.apiKey)) {
    throw refuse(
      provider,
      "key_invalid",
      "the API key is empty or holds a character that cannot be sent in a header (a line break or a character outside plain ASCII). Paste the key again",
      "auth",
    );
  }
  const { audio } = request;
  if (!(audio instanceof Blob) || audio.size === 0) {
    throw refuse(provider, "audio_empty", "there is no audio to transcribe");
  }
  if (!mediaType(audio.type)) {
    throw refuse(
      provider,
      "audio_type_missing",
      'the audio has no media type. Give the Blob one, such as new Blob([bytes], { type: "audio/wav" })',
    );
  }
  if (audio.size > defaults.maxAudioBytes) {
    throw refuse(
      provider,
      "audio_too_large",
      `the audio is ${audio.size} bytes and the limit is ${defaults.maxAudioBytes}`,
    );
  }
  const model = (request.model ?? defaults.model ?? "").trim();
  if (!model) throw refuse(provider, "model_required", "name a model");
  const language = request.language?.trim();
  return { audio, model, ...(language ? { language } : {}), diarize: request.diarize === true };
}

/** A `TranscriptionError` comes back as itself, with the usage it carries. */
const asTranscriptionError: ErrorRebuild = (err, opts) =>
  err instanceof TranscriptionError
    ? new TranscriptionError(err.provider, err.kind, err.message, { ...opts, usage: err.usage })
    : new ProviderError(err.provider, err.kind, err.message, opts);

// Both vendors' words for a recording they could not read. Deepgram: "Bad Request: failed to
// process audio: corrupt or unsupported data". OpenAI: "Invalid file format. Supported formats:
// [...]" and "Audio file might be corrupted or unsupported". Read 2026-11-11.
const AUDIO_UNREADABLE: readonly RegExp[] = [
  /failed to process audio/i,
  /corrupt(?:ed)? or unsupported/i,
  /(?:invalid|unrecognized|unsupported) file format/i,
  /could not be decoded/i,
];

/**
 * The classifier calls a refused recording `invalid`, the same as any request we got wrong.
 * The fix is a different file, so it is named by `code`: `audio_too_large` for a 413, and
 * `audio_invalid` when the vendor says it could not read the audio. The kind stays.
 */
function audioRefusalCode(error: ProviderError): string | undefined {
  if (error.status === 413) return "audio_too_large";
  if (AUDIO_UNREADABLE.some((pattern) => pattern.test(error.body ?? ""))) return "audio_invalid";
  return undefined;
}

function nameAudioRefusal(error: unknown): unknown {
  if (!(error instanceof ProviderError) || error.kind !== "invalid" || error.code) return error;
  const code = audioRefusalCode(error);
  if (!code) return error;
  return new ProviderError(error.provider, error.kind, error.message, {
    status: error.status,
    code,
    shouldRetry: false,
    body: error.body,
    cause: error.cause,
  });
}

/**
 * @internal The one place a call runs: under one deadline, once, with a refused recording
 * named and the no-replay rule applied to whatever it throws. Both wires go through here.
 */
export function transcribeOnce<T>(
  provider: string,
  timeoutMs: number,
  request: TranscriptionRequest,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return callOnce(
    provider,
    timeoutMs,
    request.signal,
    (signal) =>
      call(signal).catch((error: unknown) => {
        throw nameAudioRefusal(error);
      }),
    asTranscriptionError,
  );
}

// ── replies ───────────────────────────────────────────────────────────────

/** @internal A reply that arrived but cannot be used. Never retried: it was billed. */
export function unusable(
  provider: string,
  message: string,
  usage?: TranscriptionUsage,
): TranscriptionError {
  return new TranscriptionError(provider, "unknown", `${provider}: ${message}`, {
    code: "bad_reply",
    shouldRetry: false,
    ...(usage ? { usage } : {}),
  });
}

/**
 * @internal A failure the provider reported inside a 200 (a gateway that answers 200 with a
 * JSON error). Classified like any other failure, with the same words-over-status rules, and
 * the provider's words kept: unlike speech, nothing the caller sent can come back in them.
 */
export function inBandFailure(provider: string, envelope: unknown): TranscriptionError {
  const found = streamError(provider, envelope);
  return new TranscriptionError(provider, found.kind, found.message, {
    status: found.status,
    code: found.code,
    retryAfterMs: found.retryAfterMs,
    resetAtMs: found.resetAtMs,
    window: found.window,
    body: found.body,
  });
}

/** @internal */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** @internal The reply as a JSON object, or `undefined` for anything else. */
export function parseObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

/** @internal A finite, non-negative number of seconds, or `undefined`. */
export const seconds = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * @internal The segments that check out: a start and an end in seconds, end not before start,
 * and text. A malformed one is skipped rather than guessed at. `speaker` is read only when the
 * caller asked for speakers, so a provider that stamps speaker 0 on everyone without being asked
 * does not label a monologue.
 */
export function readSegments(
  raw: unknown,
  textKey: string,
  diarize: boolean,
): TranscriptionSegment[] {
  if (!Array.isArray(raw)) return [];
  const segments: TranscriptionSegment[] = [];
  for (const entry of raw) {
    const segment = asRecord(entry);
    const start = seconds(segment?.start);
    const end = seconds(segment?.end);
    const text = segment?.[textKey];
    if (start === undefined || end === undefined || end < start || typeof text !== "string") {
      continue;
    }
    const speaker = segment?.speaker;
    const labelled =
      diarize &&
      ((typeof speaker === "number" && Number.isSafeInteger(speaker) && speaker >= 0) ||
        (typeof speaker === "string" && speaker !== ""));
    segments.push({ start, end, text: text.trim(), ...(labelled ? { speaker } : {}) });
  }
  return segments;
}
