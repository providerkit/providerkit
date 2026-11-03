// Speech on two wires. Every path runs on a fake `fetch` and audio built here:
// nothing in this file touches a network or holds a real key.
//
// The checks that matter most are the ones a vendor's quiet behaviour would break:
// one paid request per call, audio named by its bytes, and a failure that says what
// went wrong without repeating the text that was sent.
import { describe, expect, it, vi } from "vitest";
import { classify, isRetryable, ProviderError } from "../src/errors.ts";
import { withRetry } from "../src/retry.ts";
import {
  decodeBase64,
  describeAudio,
  noReplay,
  resolveLimits,
  sniffFormat,
} from "../src/speech-core.ts";
import {
  createGeminiSpeechProvider,
  createOpenAISpeechProvider,
  createSpeechProvider,
  DEFAULT_SPEECH_LIMITS,
  readWav,
  SpeechError,
  SPEECH_PRESET_IDS,
  type SpeechProvider,
  type SpeechUsage,
} from "../src/speech.ts";

// ── audio built in the test ───────────────────────────────────────────────

const text = (value: string) => new TextEncoder().encode(value);
const u16 = (n: number) => Uint8Array.of(n & 255, (n >> 8) & 255);
const u32 = (n: number) => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

/** One RIFF chunk: name, size, payload, and the pad byte an odd size carries. */
const chunk = (name: string, payload: Uint8Array, size = payload.byteLength) =>
  join(text(name), u32(size), payload, size % 2 ? Uint8Array.of(0) : new Uint8Array(0));

const fmtChunk = (rate = 24_000, channels = 1, bits = 16, tag = 1) => {
  const blockAlign = (channels * bits) / 8;
  return chunk(
    "fmt ",
    join(u16(tag), u16(channels), u32(rate), u32(rate * blockAlign), u16(blockAlign), u16(bits)),
  );
};

const riff = (...chunks: Uint8Array[]) => {
  const body = join(text("WAVE"), ...chunks);
  return join(text("RIFF"), u32(body.byteLength), body);
};

/** 240 frames of 24 kHz mono 16-bit audio: 10 ms, 524 bytes. */
const wav = (frames = 240) => riff(fmtChunk(), chunk("data", new Uint8Array(frames * 2).fill(1)));

const mp3 = () =>
  join(
    text("ID3"),
    Uint8Array.of(4, 0, 0, 0, 0, 0, 4),
    new Uint8Array(4),
    Uint8Array.of(0xff, 0xfb, 0x90, 0x00),
    new Uint8Array(32),
  );
const mp3NoTag = () => join(Uint8Array.of(0xff, 0xfb, 0x90, 0x00), new Uint8Array(32));
const adts = () => join(Uint8Array.of(0xff, 0xf1, 0x50, 0x80), new Uint8Array(32));
const flac = () => join(text("fLaC"), new Uint8Array(32));
const opus = () => {
  const head = join(text("OpusHead"), new Uint8Array(11));
  return join(text("OggS"), new Uint8Array(22), Uint8Array.of(1, head.byteLength), head);
};

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

// ── fake network ──────────────────────────────────────────────────────────

const KEY = "sk-test-secret-123";
const WAV_BYTES = wav();

const audioReply = (bytes: Uint8Array, type = "audio/wav", init: ResponseInit = {}) =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": type },
    ...init,
  });
const jsonReply = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

/** A fetch that answers every call with `reply()` and remembers what it was asked. */
function fakeFetch(reply: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => reply());
}

const sentBody = (fetchImpl: ReturnType<typeof fakeFetch>, call = 0): unknown =>
  JSON.parse(String(fetchImpl.mock.calls[call]?.[1]?.body));
const sentHeaders = (fetchImpl: ReturnType<typeof fakeFetch>, call = 0) =>
  new Headers(fetchImpl.mock.calls[call]?.[1]?.headers);
const sentUrl = (fetchImpl: ReturnType<typeof fakeFetch>, call = 0) =>
  String(fetchImpl.mock.calls[call]?.[0]);

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

/** All a log line or a bug report could print about an error: its text, its stack, its own
 *  fields, and the same for every cause behind it. */
function everythingAbout(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  for (
    let e = error;
    e !== undefined && !seen.has(e);
    e = e instanceof Error ? e.cause : undefined
  ) {
    seen.add(e);
    parts.push(
      e instanceof Error
        ? `${e.name} ${e.message} ${e.stack ?? ""} ${JSON.stringify(e)}`
        : String(e),
    );
  }
  return parts.join("\n");
}

/** A fetch that never answers until its signal aborts, then fails the way fetch does. */
const hangingFetch = (): typeof fetch => (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

/** A response whose body starts, then waits for the request's signal to abort it. */
function stallingBodyFetch(): typeof fetch {
  return async (_url, init) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(1, 2, 3));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      }),
      { status: 200, headers: { "content-type": "audio/wav" } },
    );
}

// ── the two providers under one set of expectations ───────────────────────

const openai = (
  fetchImpl: typeof fetch,
  extra: Partial<Parameters<typeof createOpenAISpeechProvider>[0]> = {},
) =>
  createOpenAISpeechProvider({
    apiKey: KEY,
    model: "tts-model",
    voice: "alloy",
    fetchImpl,
    ...extra,
  });

const gemini = (
  fetchImpl: typeof fetch,
  extra: Partial<Parameters<typeof createGeminiSpeechProvider>[0]> = {},
) =>
  createGeminiSpeechProvider({
    apiKey: KEY,
    model: "gemini-tts",
    voice: "Kore",
    fetchImpl,
    ...extra,
  });

const geminiEnvelope = (
  blocks: unknown[] = [{ type: "audio", data: base64(WAV_BYTES), mime_type: "audio/wav" }],
  more: Record<string, unknown> = {},
) => ({
  status: "completed",
  steps: [{ type: "model_output", content: blocks }],
  usage: { total_input_tokens: 13, total_output_tokens: 96, total_tokens: 109 },
  ...more,
});

/** The same logical success on each wire. */
const SHAPES = [
  {
    name: "openai",
    make: (fetchImpl: typeof fetch, extra = {}): SpeechProvider => openai(fetchImpl, extra),
    ok: () => audioReply(WAV_BYTES),
    failWith: (status: number, body: string, headers: Record<string, string> = {}) =>
      new Response(body, { status, headers }),
    empty: () => audioReply(new Uint8Array(0)),
    jsonError: (error: unknown) => jsonReply({ error }),
  },
  {
    name: "gemini",
    make: (fetchImpl: typeof fetch, extra = {}): SpeechProvider => gemini(fetchImpl, extra),
    ok: () => jsonReply(geminiEnvelope()),
    failWith: (status: number, body: string, headers: Record<string, string> = {}) =>
      new Response(body, { status, headers }),
    empty: () => jsonReply(geminiEnvelope([])),
    jsonError: (error: unknown) => jsonReply({ error }),
  },
] as const;

// ── readWav ───────────────────────────────────────────────────────────────

describe("readWav", () => {
  it("reads the numbers a valid file states", () => {
    expect(readWav(WAV_BYTES)).toEqual({
      sampleRate: 24_000,
      channels: 1,
      bitsPerSample: 16,
      frames: 240,
      durationMs: 10,
    });
  });

  it("reads other rates, channel counts and sample widths", () => {
    const stereo8 = riff(fmtChunk(8_000, 2, 8), chunk("data", new Uint8Array(800)));
    expect(readWav(stereo8)).toMatchObject({
      sampleRate: 8_000,
      channels: 2,
      bitsPerSample: 8,
      frames: 400,
      durationMs: 50,
    });
  });

  it("skips an extra chunk before the audio", () => {
    const withList = riff(
      fmtChunk(),
      chunk("LIST", text("INFOISFT")),
      chunk("data", new Uint8Array(480)),
    );
    expect(readWav(withList)?.frames).toBe(240);
  });

  it("counts the pad byte of an odd-sized chunk", () => {
    const odd = riff(
      fmtChunk(),
      chunk("junk", new Uint8Array(3)),
      chunk("data", new Uint8Array(480)),
    );
    expect(readWav(odd)?.frames).toBe(240);
    // The same file with the pad byte missing: the next header is read one byte early.
    const unpadded = riff(
      fmtChunk(),
      join(text("junk"), u32(3), new Uint8Array(3)),
      chunk("data", new Uint8Array(480)),
    );
    expect(readWav(unpadded)).toBeUndefined();
  });

  it("accepts an 18-byte fmt chunk with no extension, and refuses one with an extension", () => {
    const body = (cb: number) =>
      riff(
        chunk("fmt ", join(u16(1), u16(1), u32(24_000), u32(48_000), u16(2), u16(16), u16(cb))),
        chunk("data", new Uint8Array(480)),
      );
    expect(readWav(body(0))?.frames).toBe(240);
    expect(readWav(body(22))).toBeUndefined();
  });

  it.each([
    ["truncated", () => WAV_BYTES.subarray(0, WAV_BYTES.byteLength - 10)],
    [
      "a RIFF size one too large",
      () => {
        const copy = WAV_BYTES.slice();
        copy.set(u32(WAV_BYTES.byteLength - 7), 4);
        return copy;
      },
    ],
    [
      "a RIFF size one too small",
      () => {
        const copy = WAV_BYTES.slice();
        copy.set(u32(WAV_BYTES.byteLength - 9), 4);
        return copy;
      },
    ],
    [
      "a size field of all ones",
      () => {
        const copy = WAV_BYTES.slice();
        copy.set(u32(0xffffffff), 4);
        return copy;
      },
    ],
    [
      "data that is not whole frames",
      () => riff(fmtChunk(24_000, 2, 16), chunk("data", new Uint8Array(6))),
    ],
    ["two fmt chunks", () => riff(fmtChunk(), fmtChunk(), chunk("data", new Uint8Array(480)))],
    [
      "a non-PCM format tag",
      () => riff(fmtChunk(24_000, 1, 32, 3), chunk("data", new Uint8Array(480))),
    ],
    ["no audio in the data chunk", () => riff(fmtChunk(), chunk("data", new Uint8Array(0)))],
    ["audio before the format", () => riff(chunk("data", new Uint8Array(480)), fmtChunk())],
    ["no data chunk", () => riff(fmtChunk())],
    [
      "two data chunks",
      () =>
        riff(fmtChunk(), chunk("data", new Uint8Array(480)), chunk("data", new Uint8Array(480))),
    ],
    [
      "a nested RIFF chunk",
      () => riff(fmtChunk(), chunk("RIFF", new Uint8Array(4)), chunk("data", new Uint8Array(480))),
    ],
    [
      "a width that is not whole bytes",
      () => riff(fmtChunk(24_000, 1, 12), chunk("data", new Uint8Array(480))),
    ],
    [
      "bytes after the RIFF ends",
      () => join(riff(fmtChunk(), chunk("data", new Uint8Array(480))), Uint8Array.of(1, 2)),
    ],
    [
      "stray bytes inside the RIFF that are not a chunk",
      () => riff(fmtChunk(), chunk("data", new Uint8Array(480)), Uint8Array.of(1, 2)),
    ],
    [
      "a chunk that runs past the end",
      () => riff(fmtChunk(), join(text("data"), u32(9_999), new Uint8Array(4))),
    ],
    ["not a RIFF file", () => mp3()],
    ["nothing", () => new Uint8Array(0)],
  ])("refuses %s", (_name, make) => {
    expect(readWav(make())).toBeUndefined();
  });

  it("reads a view into a larger buffer", () => {
    const padded = join(new Uint8Array(7), WAV_BYTES, new Uint8Array(5));
    expect(readWav(padded.subarray(7, 7 + WAV_BYTES.byteLength))?.frames).toBe(240);
  });
});

// ── sniffFormat, decodeBase64 ─────────────────────────────────────────────

describe("sniffFormat", () => {
  it.each([
    ["wav", wav()],
    ["flac", flac()],
    ["opus", opus()],
    ["mp3", mp3NoTag()],
    ["mp3", mp3()],
    ["aac", adts()],
  ])("names %s from its first bytes", (name, bytes) => {
    expect(sniffFormat(bytes)).toBe(name);
  });

  it("tells ADTS AAC from mp3 by the layer field", () => {
    expect(sniffFormat(Uint8Array.of(0xff, 0xf1, 0x50, 0x80))).toBe("aac");
    expect(sniffFormat(Uint8Array.of(0xff, 0xfb, 0x90, 0x00))).toBe("mp3");
  });

  it.each([
    [
      "Ogg audio that is not Opus",
      join(text("OggS"), new Uint8Array(22), Uint8Array.of(1, 8), text("\u0001vorbis")),
    ],
    ["MPEG Layer II", Uint8Array.of(0xff, 0xfd, 0x90, 0x00)],
    ["a reserved sample rate", Uint8Array.of(0xff, 0xfb, 0x9c, 0x00)],
    ["an ID3 tag with no audio behind it", join(text("ID3"), Uint8Array.of(4, 0, 0, 0, 0, 0, 0))],
    ["JSON", text('{"error":{}}')],
    ["raw samples", new Uint8Array(64)],
    ["a few bytes", Uint8Array.of(0xff)],
    ["nothing", new Uint8Array(0)],
  ])("does not name %s", (_name, bytes) => {
    expect(sniffFormat(bytes)).toBeUndefined();
  });
});

describe("decodeBase64", () => {
  it("decodes standard base64", () => {
    expect([...decodeBase64(base64(Uint8Array.of(1, 2, 3, 250, 251)))!]).toEqual([
      1, 2, 3, 250, 251,
    ]);
  });

  it.each([
    ["an empty string", ""],
    ["a length that is not a multiple of 4", "QUJDRA="],
    ["missing padding", "QUJDRA"],
    ["whitespace inside", "QUJD RA=="],
    ["a newline", "QUJD\nRA=="],
    ["the URL-safe alphabet", "QUJD-A__"],
    ["padding in the middle", "QU==QUJD"],
    ["three padding characters", "QU==="],
    ["a data URL prefix", "data:audio/wav;base64,QUJD"],
  ])("refuses %s", (_name, value) => {
    expect(decodeBase64(value)).toBeUndefined();
  });
});

// ── describeAudio ─────────────────────────────────────────────────────────

describe("describeAudio", () => {
  const extras = { model: "m", voice: "v", characters: 5 };
  const usage: SpeechUsage = {
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 2,
    totalTokens: 3,
  };

  it("measures a WAV from its own header", () => {
    expect(describeAudio("p", WAV_BYTES, "wav", extras)).toEqual({
      bytes: WAV_BYTES,
      format: "wav",
      mimeType: "audio/wav",
      sampleRate: 24_000,
      channels: 1,
      durationMs: 10,
      characters: 5,
      model: "m",
      voice: "v",
    });
  });

  it("labels what the bytes are, not what was asked for", () => {
    expect(describeAudio("p", mp3(), "wav", extras)).toMatchObject({
      format: "mp3",
      mimeType: "audio/mpeg",
    });
    expect(describeAudio("p", opus(), "mp3", extras)).toMatchObject({
      format: "opus",
      mimeType: "audio/ogg; codecs=opus",
    });
    expect(describeAudio("p", adts(), "wav", extras)).toMatchObject({
      format: "aac",
      mimeType: "audio/aac",
    });
    expect(describeAudio("p", flac(), "wav", extras)).toMatchObject({
      format: "flac",
      mimeType: "audio/flac",
    });
  });

  it("states no duration for a compressed format, because it cannot read one", () => {
    const result = describeAudio("p", mp3(), "mp3", extras);
    expect(result.durationMs).toBeUndefined();
    expect(result.sampleRate).toBeUndefined();
  });

  it("keeps a WAV whose header does not check out, with no numbers a caller could trust", () => {
    const lying = WAV_BYTES.slice();
    lying.set(u32(0xffffffff), 4);
    const result = describeAudio("p", lying, "wav", extras);
    expect(result.format).toBe("wav");
    expect(result.durationMs).toBeUndefined();
    expect(result.sampleRate).toBeUndefined();
  });

  it("accepts raw PCM only when PCM was asked for, and states only what it was told", () => {
    const samples = new Uint8Array(480).fill(3);
    expect(describeAudio("p", samples, "pcm", extras)).toMatchObject({
      format: "pcm",
      mimeType: "audio/L16",
    });
    expect(describeAudio("p", samples, "pcm", extras).sampleRate).toBeUndefined();
    const rated = describeAudio("p", samples, "pcm", { ...extras, sampleRate: 24_000 });
    expect(rated).toMatchObject({ mimeType: "audio/L16;rate=24000", sampleRate: 24_000 });
    expect(rated.durationMs).toBeUndefined();
    expect(
      describeAudio("p", samples, "pcm", { ...extras, sampleRate: 24_000, channels: 1 }).durationMs,
    ).toBe(10);
  });

  it.each([
    [
      "raw samples when WAV was asked for",
      () => describeAudio("p", new Uint8Array(480), "wav", extras),
    ],
    [
      "raw samples that are not whole 16-bit samples",
      () => describeAudio("p", new Uint8Array(481), "pcm", extras),
    ],
    ["JSON", () => describeAudio("p", text('{"a":1}'), "mp3", extras)],
  ])("refuses %s as bad_audio", (_name, run) => {
    expect(run).toThrow(SpeechError);
    try {
      run();
    } catch (error) {
      expect(error).toMatchObject({ code: "bad_audio", shouldRetry: false });
    }
  });

  it("refuses an empty body as empty_audio, and keeps the usage that was billed for it", () => {
    try {
      describeAudio("p", new Uint8Array(0), "wav", { ...extras, usage });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SpeechError);
      expect(error).toMatchObject({
        kind: "overload",
        code: "empty_audio",
        shouldRetry: false,
        usage,
      });
    }
  });
});

// ── noReplay ──────────────────────────────────────────────────────────────

describe("noReplay", () => {
  it.each(["network", "timeout", "overload", "unknown"] as const)(
    "marks %s as not worth a replay",
    (kind) => {
      const out = noReplay("p", new ProviderError("p", kind, "x", { status: 500 }));
      expect(out).toMatchObject({ kind, status: 500, shouldRetry: false });
      expect(isRetryable(out)).toBe(false);
    },
  );

  it.each(["network", "timeout", "overload", "unknown"] as const)(
    "does not believe a vendor that says a %s is safe to replay",
    (kind) => {
      // `x-should-retry: true` says a resend is fine for the vendor. It does not say the
      // first call went unbilled, which is the only thing that makes a replay safe.
      const said = new ProviderError("p", kind, "x", {
        status: 503,
        retryAfterMs: 2000,
        shouldRetry: true,
      });
      const out = noReplay("p", said);
      expect(out).toMatchObject({ kind, status: 503, retryAfterMs: 2000, shouldRetry: false });
      expect(isRetryable(out)).toBe(false);
    },
  );

  it("hands back an error that already refuses a replay, not a copy of it", () => {
    const refused = new ProviderError("p", "network", "x", { shouldRetry: false });
    expect(noReplay("p", refused)).toBe(refused);
  });

  it("leaves a throttle retryable, since nothing ran", () => {
    const rate = new ProviderError("p", "rate", "x", { status: 429, retryAfterMs: 1000 });
    expect(noReplay("p", rate)).toBe(rate);
    expect(isRetryable(rate)).toBe(true);
  });

  it("believes x-should-retry on a throttle, in either direction", () => {
    const yes = new ProviderError("p", "rate", "x", { status: 429, shouldRetry: true });
    expect(isRetryable(noReplay("p", yes))).toBe(true);
    const no = new ProviderError("p", "quota", "x", { status: 429, shouldRetry: false });
    expect(isRetryable(noReplay("p", no))).toBe(false);
  });

  it("keeps the usage on a SpeechError it rewrites", () => {
    const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 };
    const out = noReplay("p", new SpeechError("p", "overload", "x", { usage }));
    expect(out).toBeInstanceOf(SpeechError);
    expect(out).toMatchObject({ usage, shouldRetry: false });
  });

  it("returns the caller's Stop exactly as it came", () => {
    const controller = new AbortController();
    controller.abort();
    const stop = new DOMException("stopped", "AbortError");
    expect(noReplay("p", stop, controller.signal)).toBe(stop);
  });

  it("turns a bare transport failure into a classified, unreplayable network error", () => {
    const out = noReplay("p", new TypeError("fetch failed"));
    expect(out).toBeInstanceOf(ProviderError);
    expect(out).toMatchObject({ kind: "network", shouldRetry: false });
  });
});

// ── both wires ────────────────────────────────────────────────────────────

describe.each(SHAPES)("$name wire", (shape) => {
  const make = (fetchImpl: typeof fetch, extra = {}) => shape.make(fetchImpl, extra);

  it("sends exactly one request and returns the clip", async () => {
    const fetchImpl = fakeFetch(shape.ok);
    const result = await make(fetchImpl).synthesize({ text: "  Click Settings.  " });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      format: "wav",
      mimeType: "audio/wav",
      sampleRate: 24_000,
      channels: 1,
      durationMs: 10,
      characters: 15,
    });
    expect(result.bytes).toEqual(WAV_BYTES);
  });

  it("never follows a redirect, because the key rides in a header", async () => {
    const fetchImpl = fakeFetch(shape.ok);
    await make(fetchImpl).synthesize({ text: "Hi." });
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  describe("refuses before any request", () => {
    it.each([
      ["empty text", { text: "" }, "text_empty"],
      ["blank text", { text: " \n\t " }, "text_empty"],
      ["text over the limit", { text: "x".repeat(11) }, "text_too_long"],
      [
        "a format the wire cannot make",
        { text: "Hi.", format: "ogg" as never },
        "format_unsupported",
      ],
    ])("%s", async (_name, request, code) => {
      const fetchImpl = fakeFetch(shape.ok);
      const error = await failure(make(fetchImpl, { maxInputChars: 10 }).synthesize(request));
      expect(error).toMatchObject({ kind: "invalid", code, shouldRetry: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("no voice and no default", async () => {
      const fetchImpl = fakeFetch(shape.ok);
      const error = await failure(
        make(fetchImpl, { voice: undefined }).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({ kind: "invalid", code: "voice_required" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("a caller who already pressed Stop", async () => {
      const fetchImpl = fakeFetch(shape.ok);
      const controller = new AbortController();
      controller.abort();
      await expect(
        make(fetchImpl).synthesize({ text: "Hi.", signal: controller.signal }),
      ).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("never puts the text in the message", async () => {
      const error = await failure(
        make(fakeFetch(shape.ok), { maxInputChars: 5 }).synthesize({ text: "a private sentence" }),
      );
      expect(error.message).not.toContain("private");
    });

    it.each([
      ["a line break", "sk-abc\nSECRET"],
      ["a tab", "sk-abc\tSECRET"],
      ["a delete character", "sk-abc\u007fSECRET"],
      ["a character outside plain ASCII", "sk-\u00e9-SECRET"],
      ["a zero-width character", "sk-\u200bSECRET"],
    ])(
      "a key with %s, which a runtime would quote back in its own error",
      async (_name, apiKey) => {
        const fetchImpl = fakeFetch(shape.ok);
        const error = await failure(make(fetchImpl, { apiKey }).synthesize({ text: "Hi." }));
        expect(error).toMatchObject({ kind: "auth", code: "key_invalid", shouldRetry: false });
        expect(everythingAbout(error)).not.toContain("SECRET");
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );

    it("a key of every printable ASCII character, space to tilde, is sent as it is", async () => {
      const apiKey = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
        String.fromCharCode(0x20 + i),
      ).join("");
      const fetchImpl = fakeFetch(shape.ok);
      await make(fetchImpl, { apiKey }).synthesize({ text: "Hi." });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  it("takes text of exactly 4,096 characters by default, and refuses one more", async () => {
    const fetchImpl = fakeFetch(shape.ok);
    const speech = make(fetchImpl);
    await speech.synthesize({ text: "x".repeat(4096) });
    const error = await failure(speech.synthesize({ text: "x".repeat(4097) }));
    expect(error).toMatchObject({ kind: "invalid", code: "text_too_long", shouldRetry: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  describe("failures", () => {
    it.each([
      [401, '{"error":{"message":"Incorrect API key provided"}}', "auth"],
      [403, "forbidden", "auth"],
      [429, '{"error":{"message":"Rate limit reached"}}', "rate"],
      [
        429,
        '{"error":{"message":"You exceeded your current quota, check your plan and billing"}}',
        "quota",
      ],
      [400, '{"error":{"message":"You exceeded your current quota"}}', "quota"],
      [404, '{"error":{"message":"The model `nope` does not exist"}}', "model"],
      [400, '{"error":{"message":"bad input"}}', "invalid"],
      [500, "oops", "overload"],
      [503, "unavailable", "overload"],
    ])("%i %s classifies as %s, the same on both wires", async (status, body, kind) => {
      const fetchImpl = fakeFetch(() => shape.failWith(status, body));
      const error = await failure(make(fetchImpl).synthesize({ text: "Hi." }));
      expect(error.kind).toBe(kind);
      expect(error.status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("keeps none of the provider's words, and never the key", async () => {
      // A vendor error can echo the text that was sent and, on a bad day, the key.
      const echoed = `{"error":{"message":"Cannot read: Click Settings. ${KEY}"}}`;
      const error = await failure(
        make(fakeFetch(() => shape.failWith(400, echoed))).synthesize({ text: "Click Settings." }),
      );
      const everything = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      expect(everything).not.toContain("Click Settings");
      expect(everything).not.toContain(KEY);
      expect(error.body).toBeUndefined();
    });

    it("keeps the key and the address a user typed out of a lost-socket error", async () => {
      const leaky = vi
        .fn<typeof fetch>()
        .mockRejectedValue(
          new TypeError(`Header 'Authorization' has invalid value: 'Bearer ${KEY}'`),
        );
      const error = await failure(
        make(leaky, { baseUrl: "https://user:hunter2@host.example/private" }).synthesize({
          text: "Hi.",
        }),
      );
      expect(error).toMatchObject({ kind: "network", shouldRetry: false });
      expect(error.cause).toBeUndefined();
      expect(error.message).toBe("no response from https://host.example");
      const everything = everythingAbout(error);
      for (const secret of [KEY, "hunter2", "private"]) expect(everything).not.toContain(secret);
    });

    it("keeps out what the runtime itself quotes when it refuses a header", async () => {
      // Bun and Node both put the rejected value in the TypeError. This fetch has the runtime
      // validate the headers, so the test follows the runtime's own wording, and sends nothing.
      const strict: typeof fetch = async (_url, init) => {
        new Headers(init?.headers);
        return shape.ok();
      };
      const error = await failure(
        make(strict, { headers: { "x-extra": "a\nSECRET" } }).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({ kind: "network", shouldRetry: false });
      expect(everythingAbout(error)).not.toContain("SECRET");
    });

    it("reads the wait a 429 asks for, and leaves it retryable", async () => {
      const fetchImpl = fakeFetch(() => shape.failWith(429, "slow down", { "retry-after": "3" }));
      const error = await failure(make(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toMatchObject({ kind: "rate", retryAfterMs: 3000 });
      expect(isRetryable(error)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("does not replay a 503, because the vendor may already have billed", async () => {
      const fetchImpl = fakeFetch(() => shape.failWith(503, "unavailable"));
      const error = await failure(make(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toMatchObject({ kind: "overload", shouldRetry: false });
      expect(isRetryable(error)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("does not believe a 503 that says x-should-retry: true", async () => {
      const fetchImpl = fakeFetch(() =>
        shape.failWith(503, "unavailable", { "x-should-retry": "true" }),
      );
      const error = await failure(make(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toMatchObject({ kind: "overload", shouldRetry: false });
      expect(isRetryable(error)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("keeps the wait a 503 asked for, even though it will not be replayed", async () => {
      const fetchImpl = fakeFetch(() => shape.failWith(503, "unavailable", { "retry-after": "3" }));
      const error = await failure(make(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toMatchObject({ shouldRetry: false, retryAfterMs: 3000 });
    });

    it("does not replay a lost socket", async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
      const error = await failure(make(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toMatchObject({ kind: "network", shouldRetry: false });
      expect(isRetryable(error)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("does not replay a reply that dies halfway", async () => {
      const dying = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Uint8Array.of(1));
              controller.error(new TypeError("terminated"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      const fetchImpl = fakeFetch(dying);
      const error = await failure(make(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toMatchObject({ kind: "network", shouldRetry: false });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reads a quota refusal that arrives inside a 200", async () => {
      const fetchImpl = fakeFetch(() =>
        shape.jsonError({ code: 429, message: "You exceeded your current quota" }),
      );
      const error = await failure(make(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toMatchObject({ kind: "quota" });
      expect(error.body).toBeUndefined();
      expect(error.message).not.toContain("exceeded");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("calls an empty reply empty_audio and does not replay it", async () => {
      const fetchImpl = fakeFetch(shape.empty);
      const error = await failure(make(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toBeInstanceOf(SpeechError);
      expect(error).toMatchObject({ kind: "overload", code: "empty_audio", shouldRetry: false });
      expect(isRetryable(error)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("bounds", () => {
    it("refuses a reply whose Content-Length is over the cap before reading it", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
        cancel: () => {
          cancelled = true;
        },
      });
      const fetchImpl = fakeFetch(
        () =>
          new Response(body, {
            headers: { "content-type": "application/json", "content-length": "99999999" },
          }),
      );
      const error = await failure(
        make(fetchImpl, { maxAudioBytes: 1024 }).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({
        kind: "invalid",
        code: "response_too_large",
        shouldRetry: false,
      });
      expect(cancelled).toBe(true);
    });

    it("stops a reply that outgrows the cap mid-read", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(100 * 1024));
        },
        cancel: () => {
          cancelled = true;
        },
      });
      const fetchImpl = fakeFetch(
        () => new Response(body, { headers: { "content-type": "application/json" } }),
      );
      const error = await failure(
        make(fetchImpl, { maxAudioBytes: 1024 }).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({ code: "response_too_large" });
      expect(cancelled).toBe(true);
    });

    it("turns OUR deadline into a timeout that is not replayed", async () => {
      const fetchImpl = vi.fn(hangingFetch());
      const error = await failure(make(fetchImpl, { timeoutMs: 20 }).synthesize({ text: "Hi." }));
      expect(error).toMatchObject({ kind: "timeout", shouldRetry: false });
      expect(isRetryable(error)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("runs one deadline over the headers AND the body", async () => {
      const error = await failure(
        make(stallingBodyFetch(), { timeoutMs: 20 }).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({ kind: "timeout", shouldRetry: false });
    });

    it("never turns the caller's Stop into a timeout", async () => {
      const controller = new AbortController();
      const pending = make(hangingFetch(), { timeoutMs: 5_000 }).synthesize({
        text: "Hi.",
        signal: controller.signal,
      });
      controller.abort();
      const error = await pending.catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(ProviderError);
      expect(classify(error)).toBe("aborted");
      expect(isRetryable(error)).toBe(false);
    });

    it("keeps the caller's Stop a Stop when it lands during the body", async () => {
      const controller = new AbortController();
      const pending = make(stallingBodyFetch(), { timeoutMs: 5_000 }).synthesize({
        text: "Hi.",
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      const error = await pending.catch((e: unknown) => e);
      expect(classify(error)).toBe("aborted");
    });
  });

  it("refuses limits that are not positive integers when the provider is built", () => {
    expect(() => make(fakeFetch(shape.ok), { timeoutMs: 0 })).toThrow(RangeError);
    expect(() => make(fakeFetch(shape.ok), { maxAudioBytes: 1.5 })).toThrow(RangeError);
    expect(() => make(fakeFetch(shape.ok), { maxInputChars: -1 })).toThrow(RangeError);
  });
});

// ── the OpenAI wire on its own ────────────────────────────────────────────

describe("openai wire", () => {
  it("sends the documented request and nothing else", async () => {
    const fetchImpl = fakeFetch(() => audioReply(WAV_BYTES));
    await openai(fetchImpl, { format: "mp3" }).synthesize({
      text: "Click Settings.",
      voice: "nova",
    });
    expect(sentUrl(fetchImpl)).toBe("https://api.openai.com/v1/audio/speech");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(sentBody(fetchImpl)).toEqual({
      model: "tts-model",
      input: "Click Settings.",
      voice: "nova",
      response_format: "mp3",
    });
    const headers = sentHeaders(fetchImpl);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("always spells the format out, since each host's own default differs", async () => {
    const fetchImpl = fakeFetch(() => audioReply(WAV_BYTES));
    await openai(fetchImpl).synthesize({ text: "Hi." });
    expect(sentBody(fetchImpl)).toMatchObject({ response_format: "wav" });
  });

  it("lets a call override the voice and format", async () => {
    const fetchImpl = fakeFetch(() => audioReply(mp3()));
    await openai(fetchImpl, { format: "wav" }).synthesize({
      text: "Hi.",
      voice: "onyx",
      format: "mp3",
    });
    expect(sentBody(fetchImpl)).toMatchObject({ voice: "onyx", response_format: "mp3" });
  });

  it.each([
    ["https://api.openai.com", "https://api.openai.com/v1/audio/speech"],
    ["https://api.openai.com/", "https://api.openai.com/v1/audio/speech"],
    ["http://localhost:8880/v1", "http://localhost:8880/v1/audio/speech"],
    ["https://host.example/openai/v1/", "https://host.example/openai/v1/audio/speech"],
    ["https://openrouter.ai/api", "https://openrouter.ai/api/v1/audio/speech"],
  ])("builds the route from %s", async (baseUrl, expected) => {
    const fetchImpl = fakeFetch(() => audioReply(WAV_BYTES));
    await openai(fetchImpl, { baseUrl }).synthesize({ text: "Hi." });
    expect(sentUrl(fetchImpl)).toBe(expected);
  });

  it("takes an explicit path as given", async () => {
    const fetchImpl = fakeFetch(() => audioReply(WAV_BYTES));
    await openai(fetchImpl, { baseUrl: "https://host.example", path: "/tts/speak" }).synthesize({
      text: "Hi.",
    });
    expect(sentUrl(fetchImpl)).toBe("https://host.example/tts/speak");
  });

  it("sends no Authorization header for a server that wants none", async () => {
    const fetchImpl = fakeFetch(() => audioReply(WAV_BYTES));
    await openai(fetchImpl, { apiKey: "" }).synthesize({ text: "Hi." });
    expect(sentHeaders(fetchImpl).has("authorization")).toBe(false);
  });

  it("sends the attribution headers, and lets an explicit header win", async () => {
    const fetchImpl = fakeFetch(() => audioReply(WAV_BYTES));
    await openai(fetchImpl, {
      siteUrl: "https://app.example",
      siteName: "App",
      headers: { "x-title": "Mine" },
    }).synthesize({ text: "Hi." });
    const headers = sentHeaders(fetchImpl);
    expect(headers.get("http-referer")).toBe("https://app.example");
    expect(headers.get("x-title")).toBe("Mine");
  });

  it("names the provider after the preset in its errors", async () => {
    const error = await failure(
      openai(
        fakeFetch(() => new Response("no", { status: 401 })),
        { id: "openrouter" },
      ).synthesize({ text: "Hi." }),
    );
    expect(error.provider).toBe("speech:openrouter");
  });

  it("gives back mp3 as mp3, with no duration it did not measure", async () => {
    const result = await openai(
      fakeFetch(() => audioReply(mp3(), "audio/mpeg")),
      { format: "mp3" },
    ).synthesize({ text: "Hi." });
    expect(result).toMatchObject({ format: "mp3", mimeType: "audio/mpeg" });
    expect(result.durationMs).toBeUndefined();
  });

  it("labels audio by its bytes when the server ignored the format it was sent", async () => {
    // Asked for wav, the server sent mp3, and said it was octet-stream.
    const result = await openai(
      fakeFetch(() => audioReply(mp3(), "application/octet-stream")),
    ).synthesize({ text: "Hi." });
    expect(result.format).toBe("mp3");
  });

  it("accepts audio sent under a JSON content type, because the bytes decide", async () => {
    const result = await openai(
      fakeFetch(() => audioReply(WAV_BYTES, "application/json")),
    ).synthesize({ text: "Hi." });
    expect(result.format).toBe("wav");
  });

  it("reads raw PCM only when PCM was asked for, with no rate it was not told", async () => {
    const pcm = new Uint8Array(480).fill(5);
    const result = await openai(fakeFetch(() => audioReply(pcm, "audio/pcm"))).synthesize({
      text: "Hi.",
      format: "pcm",
    });
    expect(result).toMatchObject({ format: "pcm", mimeType: "audio/L16" });
    expect(result.sampleRate).toBeUndefined();
    await expect(
      openai(fakeFetch(() => audioReply(pcm, "audio/pcm"))).synthesize({
        text: "Hi.",
        format: "wav",
      }),
    ).rejects.toMatchObject({ code: "bad_audio" });
  });

  describe("a 200 that is not audio", () => {
    it("classifies a JSON error as the failure it is", async () => {
      const error = await failure(
        openai(
          fakeFetch(() => jsonReply({ error: { message: "You exceeded your current quota" } })),
        ).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({ kind: "quota" });
    });

    it("finds a JSON error behind a content type that does not say so", async () => {
      const error = await failure(
        openai(
          fakeFetch(() =>
            audioReply(text('{"error":{"message":"invalid api key"}}'), "application/octet-stream"),
          ),
        ).synthesize({ text: "Hi." }),
      );
      expect(error.kind).toBe("auth");
    });

    it.each([
      ["JSON with no error and no audio", () => jsonReply({ ok: true })],
      ["a JSON array", () => jsonReply([1, 2])],
      ["an HTML page", () => audioReply(text("<html>login</html>"), "text/html")],
      ["plain text", () => audioReply(text("hello"), "text/plain")],
      ["bytes nobody recognises", () => audioReply(new Uint8Array(64).fill(9), "audio/wav")],
    ])("refuses %s as bad_audio", async (_name, reply) => {
      const fetchImpl = fakeFetch(reply);
      const error = await failure(openai(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toBeInstanceOf(SpeechError);
      expect(error).toMatchObject({ code: "bad_audio", shouldRetry: false });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});

// ── the Gemini wire on its own ────────────────────────────────────────────

describe("gemini wire", () => {
  it("sends the request an adopter has already run, and nothing more", async () => {
    const fetchImpl = fakeFetch(() => jsonReply(geminiEnvelope()));
    await gemini(fetchImpl).synthesize({ text: "Click Settings.", voice: "Puck" });
    expect(sentUrl(fetchImpl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(sentBody(fetchImpl)).toEqual({
      model: "gemini-tts",
      store: false,
      input: [{ type: "user_input", content: [{ type: "text", text: "Click Settings." }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: "Puck" }] },
    });
    const headers = sentHeaders(fetchImpl);
    expect(headers.get("x-goog-api-key")).toBe(KEY);
    expect(headers.has("authorization")).toBe(false);
  });

  it("sends max_output_tokens only when asked to", async () => {
    const fetchImpl = fakeFetch(() => jsonReply(geminiEnvelope()));
    await gemini(fetchImpl, { maxOutputTokens: 8192 }).synthesize({ text: "Hi." });
    expect(sentBody(fetchImpl)).toMatchObject({
      generation_config: { max_output_tokens: 8192, speech_config: [{ voice: "Kore" }] },
    });
  });

  it("refuses a max_output_tokens that is not a positive integer", () => {
    expect(() =>
      gemini(
        fakeFetch(() => jsonReply({})),
        { maxOutputTokens: 0 },
      ),
    ).toThrow(RangeError);
    expect(() =>
      gemini(
        fakeFetch(() => jsonReply({})),
        { maxOutputTokens: 1.5 },
      ),
    ).toThrow(RangeError);
  });

  it("sends mime_type only for raw PCM, where it is needed", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonReply(geminiEnvelope([{ type: "audio", data: base64(new Uint8Array(480)) }])),
    );
    await gemini(fetchImpl).synthesize({ text: "Hi.", format: "pcm" });
    expect(sentBody(fetchImpl)).toMatchObject({
      response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24_000 },
    });
  });

  it("states the PCM rate the request asked for, and a duration only with a channel count", async () => {
    const pcm = base64(new Uint8Array(480).fill(2));
    const plain = await gemini(
      fakeFetch(() => jsonReply(geminiEnvelope([{ type: "audio", data: pcm }]))),
    ).synthesize({ text: "Hi.", format: "pcm" });
    expect(plain).toMatchObject({ format: "pcm", sampleRate: 24_000 });
    expect(plain.durationMs).toBeUndefined();
    const counted = await gemini(
      fakeFetch(() => jsonReply(geminiEnvelope([{ type: "audio", data: pcm, channels: 1 }]))),
    ).synthesize({ text: "Hi.", format: "pcm" });
    expect(counted).toMatchObject({ channels: 1, durationMs: 10 });
  });

  it.each(["mp3", "opus", "aac", "flac"] as const)(
    "refuses %s before any request",
    async (format) => {
      const fetchImpl = fakeFetch(() => jsonReply(geminiEnvelope()));
      await expect(gemini(fetchImpl).synthesize({ text: "Hi.", format })).rejects.toMatchObject({
        code: "format_unsupported",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("honours a base URL that already carries a version", async () => {
    const fetchImpl = fakeFetch(() => jsonReply(geminiEnvelope()));
    await gemini(fetchImpl, { baseUrl: "https://proxy.example/v1beta" }).synthesize({
      text: "Hi.",
    });
    expect(sentUrl(fetchImpl)).toBe("https://proxy.example/v1beta/interactions");
  });

  it("maps the usage the provider stated, and nothing it did not", async () => {
    const result = await gemini(fakeFetch(() => jsonReply(geminiEnvelope()))).synthesize({
      text: "Hi.",
    });
    expect(result.usage).toEqual({
      inputTokens: 13,
      cachedInputTokens: 0,
      outputTokens: 96,
      totalTokens: 109,
    });
    const cached = await gemini(
      fakeFetch(() =>
        jsonReply(
          geminiEnvelope(undefined, {
            usage: {
              total_input_tokens: 13,
              total_output_tokens: 96,
              total_tokens: 112,
              total_cached_tokens: 4,
            },
          }),
        ),
      ),
    ).synthesize({ text: "Hi." });
    expect(cached.usage).toEqual({
      inputTokens: 13,
      cachedInputTokens: 4,
      outputTokens: 96,
      totalTokens: 112,
    });
  });

  it.each([
    ["absent", undefined],
    ["a string", "109"],
    ["a negative count", { total_input_tokens: -1, total_output_tokens: 96, total_tokens: 95 }],
    ["a fractional count", { total_input_tokens: 1.5, total_output_tokens: 96, total_tokens: 100 }],
    [
      "a total below input plus output",
      { total_input_tokens: 13, total_output_tokens: 96, total_tokens: 100 },
    ],
    ["a missing field", { total_input_tokens: 13, total_output_tokens: 96 }],
    [
      "more cached than input",
      {
        total_input_tokens: 13,
        total_output_tokens: 96,
        total_tokens: 109,
        total_cached_tokens: 20,
      },
    ],
    [
      "a count past the safe range",
      { total_input_tokens: 2 ** 60, total_output_tokens: 1, total_tokens: 2 ** 60 },
    ],
  ])(
    "drops usage that is %s rather than guess, and still returns the audio",
    async (_name, usage) => {
      const result = await gemini(
        fakeFetch(() => jsonReply(geminiEnvelope(undefined, { usage }))),
      ).synthesize({ text: "Hi." });
      expect(result.usage).toBeUndefined();
      expect(result.format).toBe("wav");
    },
  );

  describe("which audio block counts", () => {
    const good = { type: "audio", data: base64(WAV_BYTES) };
    const bad = { type: "audio", data: "!!!not base64!!!" };

    it("the last one wins", async () => {
      const result = await gemini(
        fakeFetch(() => jsonReply(geminiEnvelope([bad, good]))),
      ).synthesize({ text: "Hi." });
      expect(result.bytes).toEqual(WAV_BYTES);
    });

    it("an earlier good block is not preferred over a bad last one", async () => {
      const error = await failure(
        gemini(fakeFetch(() => jsonReply(geminiEnvelope([good, bad])))).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({ code: "bad_audio" });
    });

    it("reads across several steps, skipping steps that are not model output", async () => {
      const envelope = {
        status: "completed",
        steps: [
          { type: "model_output", content: [bad] },
          { type: "thought", content: [{ type: "audio", data: base64(mp3()) }] },
          { type: "model_output", content: [{ type: "text", text: "ok" }, good] },
        ],
      };
      const result = await gemini(fakeFetch(() => jsonReply(envelope))).synthesize({ text: "Hi." });
      expect(result.format).toBe("wav");
    });

    it("never fetches a link", async () => {
      const fetchImpl = fakeFetch(() =>
        jsonReply(geminiEnvelope([{ type: "audio", uri: "https://example.com/a.wav" }])),
      );
      const error = await failure(gemini(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toMatchObject({ code: "bad_audio", shouldRetry: false });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("uses inline data and ignores a link beside it", async () => {
      const fetchImpl = fakeFetch(() =>
        jsonReply(geminiEnvelope([{ ...good, uri: "https://example.com/a.wav" }])),
      );
      const result = await gemini(fetchImpl).synthesize({ text: "Hi." });
      expect(result.bytes).toEqual(WAV_BYTES);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reports a reply with no audio block as empty_audio, with the billed usage", async () => {
      const error = await failure(
        gemini(
          fakeFetch(() => jsonReply(geminiEnvelope([{ type: "text", text: "no" }]))),
        ).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({ kind: "overload", code: "empty_audio", shouldRetry: false });
      expect((error as SpeechError).usage).toEqual({
        inputTokens: 13,
        cachedInputTokens: 0,
        outputTokens: 96,
        totalTokens: 109,
      });
    });
  });

  describe("the interaction's own status", () => {
    const usage = { inputTokens: 13, cachedInputTokens: 0, outputTokens: 96, totalTokens: 109 };

    it("calls a cut clip incomplete, and keeps the usage the provider billed for it", async () => {
      const error = await failure(
        gemini(
          fakeFetch(() => jsonReply(geminiEnvelope(undefined, { status: "incomplete" }))),
        ).synthesize({ text: "Hi." }),
      );
      expect(error).toBeInstanceOf(SpeechError);
      expect(error).toMatchObject({
        kind: "invalid",
        code: "incomplete",
        shouldRetry: false,
        usage,
      });
      expect(isRetryable(error)).toBe(false);
    });

    it("classifies a failed interaction by the error it reported", async () => {
      const failed = geminiEnvelope([], {
        status: "failed",
        errors: [{ code: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota" }],
      });
      const error = await failure(
        gemini(fakeFetch(() => jsonReply(failed))).synthesize({ text: "Hi." }),
      );
      expect(error).toBeInstanceOf(SpeechError);
      expect(error.kind).toBe("quota");
      expect((error as SpeechError).usage).toEqual(usage);
      expect(error.body).toBeUndefined();
      expect(error.message).not.toContain("exceeded");
    });

    it("keeps a failed interaction with no reason as an unreplayable failure", async () => {
      const error = await failure(
        gemini(fakeFetch(() => jsonReply(geminiEnvelope([], { status: "cancelled" })))).synthesize({
          text: "Hi.",
        }),
      );
      expect(error).toMatchObject({ code: "cancelled", shouldRetry: false });
    });

    it.each(["in_progress", "requires_action", "requires_continuation", undefined, 7])(
      "does not take %s for a finished clip",
      async (status) => {
        const error = await failure(
          gemini(fakeFetch(() => jsonReply(geminiEnvelope(undefined, { status })))).synthesize({
            text: "Hi.",
          }),
        );
        expect(error).toMatchObject({ code: "unexpected_status", shouldRetry: false });
      },
    );
  });

  describe("a reply that is not what was promised", () => {
    it.each([
      [
        "a content type that is not JSON",
        () =>
          new Response(JSON.stringify(geminiEnvelope()), {
            headers: { "content-type": "text/html" },
          }),
      ],
      [
        "a body that is not JSON",
        () => new Response("{nope", { headers: { "content-type": "application/json" } }),
      ],
      ["a JSON array", () => jsonReply([geminiEnvelope()])],
      ["JSON null", () => jsonReply(null)],
    ])("refuses %s", async (_name, reply) => {
      const fetchImpl = fakeFetch(reply);
      const error = await failure(gemini(fetchImpl).synthesize({ text: "Hi." }));
      expect(error).toBeInstanceOf(SpeechError);
      expect(error).toMatchObject({ code: "bad_audio", shouldRetry: false });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("accepts a JSON content type with a charset", async () => {
      const reply = () =>
        new Response(JSON.stringify(geminiEnvelope()), {
          headers: { "content-type": "application/json; charset=UTF-8" },
        });
      expect((await gemini(fakeFetch(reply)).synthesize({ text: "Hi." })).format).toBe("wav");
    });

    it("refuses base64 that is not strict, with the usage attached", async () => {
      const error = await failure(
        gemini(
          fakeFetch(() => jsonReply(geminiEnvelope([{ type: "audio", data: "QUJD RA==" }]))),
        ).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({ code: "bad_audio" });
      expect((error as SpeechError).usage?.totalTokens).toBe(109);
    });

    it("refuses audio that decodes past the cap, even inside the JSON allowance", async () => {
      const tooBig = base64(new Uint8Array(900).fill(1));
      const error = await failure(
        gemini(
          fakeFetch(() => jsonReply(geminiEnvelope([{ type: "audio", data: tooBig }]))),
          { maxAudioBytes: 600 },
        ).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({
        kind: "invalid",
        code: "response_too_large",
        shouldRetry: false,
      });
      expect((error as SpeechError).usage?.totalTokens).toBe(109);
    });

    it("does not decode a payload that is already longer than the cap allows", async () => {
      const decode = vi.spyOn(globalThis, "atob");
      try {
        const tooBig = base64(new Uint8Array(900).fill(1));
        await gemini(
          fakeFetch(() => jsonReply(geminiEnvelope([{ type: "audio", data: tooBig }]))),
          {
            maxAudioBytes: 600,
          },
        )
          .synthesize({ text: "Hi." })
          .catch(() => undefined);
        expect(decode).not.toHaveBeenCalled();
      } finally {
        decode.mockRestore();
      }
    });

    it("holds the decoded audio to the cap too, since base64 rounds up to whole groups", async () => {
      // A 601-byte cap allows 804 base64 characters, and 804 characters decode to 603 bytes.
      const slack = base64(new Uint8Array(603).fill(1));
      expect(slack).toHaveLength(804);
      const error = await failure(
        gemini(
          fakeFetch(() => jsonReply(geminiEnvelope([{ type: "audio", data: slack }]))),
          {
            maxAudioBytes: 601,
          },
        ).synthesize({ text: "Hi." }),
      );
      expect(error).toMatchObject({ code: "response_too_large" });
    });

    it("allows the base64 envelope on top of the audio cap, and no more", async () => {
      // 600 bytes of audio is 800 base64 characters. The JSON around it gets 64 KiB.
      const fits = base64(wav(240)); // 524 bytes
      const result = await gemini(
        fakeFetch(() => jsonReply(geminiEnvelope([{ type: "audio", data: fits }]))),
        { maxAudioBytes: 600 },
      ).synthesize({ text: "Hi." });
      expect(result.bytes.byteLength).toBe(524);
      const bloated = jsonReply(geminiEnvelope(undefined, { padding: "x".repeat(70 * 1024) }));
      await expect(
        gemini(
          fakeFetch(() => bloated),
          { maxAudioBytes: 600 },
        ).synthesize({ text: "Hi." }),
      ).rejects.toMatchObject({
        code: "response_too_large",
      });
    });
  });
});

// ── a retry the caller chooses ────────────────────────────────────────────

describe("retrying a speech call on purpose", () => {
  // The package never replays a paid call by itself. A caller who wants a retry
  // writes one, and the stock withRetry already does the safe thing with these errors.
  const retry = <T>(call: () => Promise<T>) =>
    withRetry(call, { sleep: async () => {}, baseDelayMs: 1 });

  it.each(SHAPES)(
    "$name: sends a throttled call again, after the wait it asked for",
    async (shape) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(shape.failWith(429, "slow down", { "retry-after": "1" }))
        .mockResolvedValueOnce(shape.ok());
      const result = await retry(() => shape.make(fetchImpl).synthesize({ text: "Hi." }));
      expect(result.format).toBe("wav");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it.each(SHAPES)(
    "$name: does not send a 503 again, since it may have been billed",
    async (shape) => {
      const fetchImpl = fakeFetch(() => shape.failWith(503, "unavailable"));
      await expect(
        retry(() => shape.make(fetchImpl).synthesize({ text: "Hi." })),
      ).rejects.toMatchObject({
        kind: "overload",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each(SHAPES)("$name: does not send a call again after a lost socket", async (shape) => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      retry(() => shape.make(fetchImpl).synthesize({ text: "Hi." })),
    ).rejects.toMatchObject({
      kind: "network",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ── the entry point ───────────────────────────────────────────────────────

describe("the main entry", () => {
  it("does not carry speech, so an app that only chats pays nothing for it", async () => {
    const main = await import("../src/index.ts");
    for (const name of [
      "createSpeechProvider",
      "createOpenAISpeechProvider",
      "createGeminiSpeechProvider",
      "SpeechError",
      "readWav",
      "describeAudio",
      // Transport helpers the speech entry uses. A chat adopter has not asked for them.
      "postBytes",
      "readBounded",
      "withDeadline",
      "versionedPath",
    ]) {
      expect(name in main, name).toBe(false);
    }
  });

  it("still carries every transport name it had before speech", async () => {
    const main = await import("../src/index.ts");
    for (const name of [
      "apiUrl",
      "getJson",
      "MAX_SSE_FRAME_CHARS",
      "parseFrame",
      "parseSseStream",
      "postJson",
      "retryAfterFromHeaders",
      "streamSse",
    ]) {
      expect(name in main, name).toBe(true);
    }
  });

  it("gives the speech entry its public names and none of the helpers behind them", async () => {
    const speech = await import("../src/speech.ts");
    expect(Object.keys(speech).sort()).toEqual([
      "DEFAULT_SPEECH_LIMITS",
      "SPEECH_FORMATS",
      "SPEECH_PRESET_IDS",
      "SpeechError",
      "createGeminiSpeechProvider",
      "createOpenAISpeechProvider",
      "createSpeechProvider",
      "readWav",
    ]);
  });
});

// ── the factory ───────────────────────────────────────────────────────────

describe("createSpeechProvider", () => {
  it("builds the Google provider with the preset's model and voice", async () => {
    const fetchImpl = fakeFetch(() => jsonReply(geminiEnvelope()));
    const speech = createSpeechProvider("google", { apiKey: KEY, fetchImpl });
    expect(speech).toMatchObject({ id: "google", model: "gemini-3.8-flash-tts" });
    await speech.synthesize({ text: "Hi." });
    expect(sentUrl(fetchImpl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    expect(sentBody(fetchImpl)).toMatchObject({
      model: "gemini-3.8-flash-tts",
      generation_config: { speech_config: [{ voice: "Kore" }] },
    });
  });

  it("builds the OpenAI provider with the preset's model, voice and limit", async () => {
    const fetchImpl = fakeFetch(() => audioReply(mp3()));
    const speech = createSpeechProvider("openai", { apiKey: KEY, fetchImpl });
    expect(speech.model).toBe("gpt-4o-mini-tts");
    await speech.synthesize({ text: "Hi." });
    expect(sentUrl(fetchImpl)).toBe("https://api.openai.com/v1/audio/speech");
    expect(sentBody(fetchImpl)).toMatchObject({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      response_format: "wav",
    });
    const error = await failure(speech.synthesize({ text: "x".repeat(4097) }));
    expect(error.code).toBe("text_too_long");
  });

  it("reaches OpenRouter at /api/v1, asks for mp3, and wants a model", async () => {
    expect(() => createSpeechProvider("openrouter", { apiKey: KEY })).toThrow(/Pass a model/);
    const fetchImpl = fakeFetch(() => audioReply(mp3()));
    const speech = createSpeechProvider("openrouter", {
      apiKey: KEY,
      model: "some/speech-model",
      voice: "v1",
      siteName: "App",
      fetchImpl,
    });
    await speech.synthesize({ text: "Hi." });
    expect(sentUrl(fetchImpl)).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(sentBody(fetchImpl)).toMatchObject({ response_format: "mp3" });
    expect(sentHeaders(fetchImpl).get("x-title")).toBe("App");
  });

  it("asks for a voice before any request when the preset names none", async () => {
    const fetchImpl = fakeFetch(() => audioReply(mp3()));
    const speech = createSpeechProvider("openrouter", { apiKey: KEY, model: "m", fetchImpl });
    await expect(speech.synthesize({ text: "Hi." })).rejects.toMatchObject({
      code: "voice_required",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reaches a compatible server through baseUrl, and leaves the preset's own defaults behind", async () => {
    const fetchImpl = fakeFetch(() => audioReply(mp3()));
    expect(() =>
      createSpeechProvider("openai", { apiKey: "", baseUrl: "http://localhost:8880/v1" }),
    ).toThrow(/another host/);
    const speech = createSpeechProvider("openai", {
      apiKey: "",
      baseUrl: "http://localhost:8880/v1",
      model: "kokoro",
      fetchImpl,
    });
    // The preset's voice (alloy) and format belong to OpenAI's host, not to this one.
    await expect(speech.synthesize({ text: "Hi." })).rejects.toMatchObject({
      code: "voice_required",
    });
    await speech.synthesize({ text: "Hi.", voice: "af_bella" });
    expect(sentUrl(fetchImpl)).toBe("http://localhost:8880/v1/audio/speech");
    expect(sentHeaders(fetchImpl).has("authorization")).toBe(false);
    expect(sentBody(fetchImpl)).toEqual({
      model: "kokoro",
      input: "Hi.",
      voice: "af_bella",
      response_format: "wav",
    });
  });

  it("lets the caller's own values win over the preset's", async () => {
    const fetchImpl = fakeFetch(() => audioReply(mp3()));
    const speech = createSpeechProvider("openai", {
      apiKey: KEY,
      model: "tts-1",
      voice: "onyx",
      format: "mp3",
      maxInputChars: 20,
      fetchImpl,
    });
    await speech.synthesize({ text: "Hi." });
    expect(sentBody(fetchImpl)).toMatchObject({
      model: "tts-1",
      voice: "onyx",
      response_format: "mp3",
    });
    await expect(speech.synthesize({ text: "x".repeat(21) })).rejects.toMatchObject({
      code: "text_too_long",
    });
  });

  it("passes maxOutputTokens to the Gemini wire and refuses it on a wire without one", async () => {
    const fetchImpl = fakeFetch(() => jsonReply(geminiEnvelope()));
    await createSpeechProvider("google", {
      apiKey: KEY,
      maxOutputTokens: 256,
      fetchImpl,
    }).synthesize({ text: "Hi." });
    expect(sentBody(fetchImpl)).toMatchObject({ generation_config: { max_output_tokens: 256 } });
    expect(() => createSpeechProvider("openai", { apiKey: KEY, maxOutputTokens: 256 })).toThrow(
      /maxOutputTokens/,
    );
  });

  it("refuses a preset that cannot speak, and names the ones that can", () => {
    expect(() => createSpeechProvider("anthropic", { apiKey: KEY })).toThrow(
      new RegExp(`Presets that do: ${SPEECH_PRESET_IDS.join(", ")}`),
    );
    expect(SPEECH_PRESET_IDS).toEqual(["openai", "google", "openrouter"]);
  });

  it("refuses limits that are not positive integers", () => {
    expect(() => createSpeechProvider("google", { apiKey: KEY, timeoutMs: 0 })).toThrow(RangeError);
  });
});
