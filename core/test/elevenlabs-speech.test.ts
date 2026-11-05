// The ElevenLabs speech wire on a fake `fetch`: the request it sends, audio named by its
// bytes, and failures that name their fix without the vendor's words. No network, no real key.
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors.ts";
import {
  createElevenLabsSpeechProvider,
  listElevenLabsVoices,
  SpeechError,
} from "../src/speech.ts";
import type { FetchLike } from "../src/transport.ts";

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
/** 240 frames of 24 kHz mono 16-bit audio: 10 ms. */
const wav = () => {
  const fmt = join(
    text("fmt "),
    u32(16),
    u16(1),
    u16(1),
    u32(24_000),
    u32(48_000),
    u16(2),
    u16(16),
  );
  const data = join(text("data"), u32(480), new Uint8Array(480).fill(1));
  const body = join(text("WAVE"), fmt, data);
  return join(text("RIFF"), u32(body.byteLength), body);
};

/** A fetch that answers once with `reply` and records what it was asked. */
function fake(reply: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return reply();
  };
  return { calls, fetchImpl };
}

const audio = (bytes: Uint8Array, type = "audio/wav") =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } });
const failure = (status: number, code: string, message = "Hello there, said the text") =>
  new Response(JSON.stringify({ detail: { type: "x", code, message, status: code } }), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("ElevenLabs speech", () => {
  it("sends one request with the voice in the path, the key in xi-api-key and 24 kHz WAV", async () => {
    const { calls, fetchImpl } = fake(() => audio(wav()));
    const speech = createElevenLabsSpeechProvider({
      apiKey: "sk_test",
      voice: "voice/1",
      fetchImpl,
    });
    const result = await speech.synthesize({ text: "  Click Settings.  " });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%2F1");
    expect(url.searchParams.get("output_format")).toBe("wav_24000");
    expect((calls[0]!.init?.headers as Record<string, string>)["xi-api-key"]).toBe("sk_test");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      text: "Click Settings.",
      model_id: "eleven_multilingual_v2",
    });
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(result).toMatchObject({
      format: "wav",
      sampleRate: 24_000,
      durationMs: 10,
      characters: 15,
      model: "eleven_multilingual_v2",
      voice: "voice/1",
    });
    expect(result.usage).toBeUndefined();
  });

  it("asks for MP3 by its own name and keeps the model it was given", async () => {
    const mp3 = join(Uint8Array.of(0xff, 0xfb, 0x90, 0x00), new Uint8Array(32));
    const { calls, fetchImpl } = fake(() => audio(mp3, "audio/mpeg"));
    const speech = createElevenLabsSpeechProvider({
      apiKey: "sk_test",
      model: "eleven_flash_v2_5",
      fetchImpl,
    });
    const result = await speech.synthesize({ text: "Hi", voice: "v", format: "mp3" });
    expect(new URL(calls[0]!.url).searchParams.get("output_format")).toBe("mp3_44100_128");
    expect(JSON.parse(String(calls[0]!.init?.body)).model_id).toBe("eleven_flash_v2_5");
    expect(result.format).toBe("mp3");
  });

  it("refuses a format it cannot make, a missing voice and a missing key before any request", async () => {
    const { calls, fetchImpl } = fake(() => audio(wav()));
    await expect(
      createElevenLabsSpeechProvider({ apiKey: "sk", voice: "v", fetchImpl }).synthesize({
        text: "Hi",
        format: "flac",
      }),
    ).rejects.toThrow(/cannot make flac/);
    await expect(
      createElevenLabsSpeechProvider({ apiKey: "sk", fetchImpl }).synthesize({ text: "Hi" }),
    ).rejects.toThrow(/needs a voice/);
    await expect(
      createElevenLabsSpeechProvider({ apiKey: "", voice: "v", fetchImpl }).synthesize({
        text: "Hi",
      }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toHaveLength(0);
  });

  it("names a missing voice as the voice, and never repeats the vendor's words", async () => {
    for (const [status, code] of [
      [404, "voice_not_found"],
      [400, "invalid_voice_id"],
    ] as const) {
      const { fetchImpl } = fake(() => failure(status, code));
      const error = await createElevenLabsSpeechProvider({ apiKey: "sk", voice: "nope", fetchImpl })
        .synthesize({ text: "Hello there" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({
        kind: "invalid",
        code: "voice_not_found",
        status,
        shouldRetry: false,
      });
      expect(String((error as Error).message)).not.toContain("Hello there");
      expect((error as ProviderError).body).toBeUndefined();
    }
  });

  it("reads a wrong key as auth, no credits as quota and a throttle as rate, without the body", async () => {
    for (const [status, code, kind] of [
      [401, "invalid_api_key", "auth"],
      [402, "insufficient_credits", "quota"],
      [429, "concurrent_limit_exceeded", "rate"],
    ] as const) {
      const { fetchImpl } = fake(() => failure(status, code));
      const error = await createElevenLabsSpeechProvider({ apiKey: "sk", voice: "v", fetchImpl })
        .synthesize({ text: "Hello there" })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind, status });
      expect((error as ProviderError).body).toBeUndefined();
      expect(String((error as Error).message)).not.toContain("Hello there");
    }
  });

  it("refuses a 200 that holds JSON instead of audio", async () => {
    const { fetchImpl } = fake(
      () =>
        new Response(JSON.stringify({ detail: { code: "x" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const error = await createElevenLabsSpeechProvider({ apiKey: "sk", voice: "v", fetchImpl })
      .synthesize({ text: "Hi" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpeechError);
    expect(error).toMatchObject({ code: "bad_audio" });
  });

  it("hides the URL and the cause when nothing answered", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    const error = await createElevenLabsSpeechProvider({
      apiKey: "sk",
      voice: "secret-voice",
      fetchImpl,
    })
      .synthesize({ text: "Hi" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "network" });
    expect(String((error as Error).message)).toBe("no response from https://api.elevenlabs.io");
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("listElevenLabsVoices", () => {
  it("reads every page and keeps the id, the name, the category and the verified languages", async () => {
    const pages = [
      {
        voices: [
          {
            voice_id: "a",
            name: "Ana",
            category: "premade",
            verified_languages: [
              { language: "pt", model_id: "m" },
              { language: "pt", model_id: "n" },
              { language: "es", model_id: "m" },
            ],
          },
          { voice_id: "", name: "Broken" },
        ],
        has_more: true,
        next_page_token: "next",
      },
      { voices: [{ voice_id: "b" }], has_more: false, next_page_token: null },
    ];
    const urls: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(pages.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const voices = await listElevenLabsVoices({ apiKey: "sk", fetchImpl });
    expect(voices).toEqual([
      { id: "a", name: "Ana", category: "premade", languages: ["pt", "es"] },
      { id: "b", name: "b", languages: [] },
    ]);
    expect(new URL(urls[0]!).pathname).toBe("/v2/voices");
    expect(new URL(urls[1]!).searchParams.get("next_page_token")).toBe("next");
    expect((fetchImpl.mock.calls[0]![1]?.headers as Record<string, string>)["xi-api-key"]).toBe(
      "sk",
    );
  });

  it("throws auth for a wrong key", async () => {
    const { fetchImpl } = fake(() => failure(401, "invalid_api_key"));
    await expect(listElevenLabsVoices({ apiKey: "bad", fetchImpl })).rejects.toMatchObject({
      kind: "auth",
    });
  });
});
