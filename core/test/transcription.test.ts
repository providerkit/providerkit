// Transcription on two wires. Every path runs on a fake `fetch` that answers with the replies
// each vendor documents (Deepgram's pre-recorded reference and errors page, OpenAI's
// transcription reference and speech-to-text guide, read 2026-11-11): nothing here touches a
// network or holds a real key.
//
// The checks that matter most are the ones a vendor's quiet behaviour would break: one paid
// request per call, speakers only when asked for, and a failure classified by what fixes it.
import { describe, expect, it, vi } from "vitest";
import { classify, isRetryable, ProviderError } from "../src/errors.ts";
import { PROVIDER_PRESETS, PRESET_IDS } from "../src/presets.ts";
import { withRetry } from "../src/retry.ts";
import {
  createDeepgramTranscriptionProvider,
  createOpenAITranscriptionProvider,
  createTranscriptionProvider,
  DEFAULT_TRANSCRIPTION_LIMITS,
  TranscriptionError,
  TRANSCRIPTION_PRESET_IDS,
} from "../src/transcription.ts";

// ── recorded replies ──────────────────────────────────────────────────────

const KEY = "sk-test-secret-123";
const recording = (type = "audio/wav") => new Blob([Uint8Array.of(1, 2, 3, 4)], { type });

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Deepgram's documented reply, trimmed to the fields that matter, with utterances on. */
const deepgramReply = (speakers: boolean) => ({
  metadata: {
    request_id: "6d0e3c1f-0000-4000-8000-000000000000",
    created: "2026-11-11T12:00:00.000Z",
    duration: 4.48,
    channels: 1,
    models: ["30089e05-99d1-4376-b32e-c263170674af"],
  },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: "Bom dia. Tudo bem?",
            confidence: 0.99,
            words: [{ word: "bom", start: 0.08, end: 0.4, confidence: 0.99 }],
          },
        ],
      },
    ],
    utterances: [
      {
        start: 0.08,
        end: 1.2,
        confidence: 0.98,
        channel: 0,
        transcript: "Bom dia.",
        // Deepgram stamps speaker 0 on every utterance even with diarization off.
        speaker: 0,
        id: "a",
      },
      {
        start: 1.6,
        end: 2.9,
        confidence: 0.97,
        channel: 0,
        transcript: "Tudo bem?",
        speaker: speakers ? 1 : 0,
        id: "b",
      },
    ],
  },
});

const deepgramError = (status: number, err_code: string, err_msg: string) =>
  json({ err_code, err_msg, request_id: "6d0e3c1f-0000-4000-8000-000000000000" }, status);

const openaiError = (status: number, error: Record<string, unknown>, headers = {}) =>
  json({ error: { param: null, code: null, ...error } }, status, headers);

/** A fetch that answers every call with `reply()` and remembers what it was asked. */
const fakeFetch = (reply: () => Response | Promise<Response>) =>
  vi.fn<typeof fetch>(async () => reply());

const sent = (fetchImpl: ReturnType<typeof fakeFetch>, call = 0) => {
  const [input, init] = fetchImpl.mock.calls[call]!;
  return { url: new URL(String(input)), init: init!, headers: new Headers(init?.headers) };
};
const sentForm = (fetchImpl: ReturnType<typeof fakeFetch>, call = 0) => {
  const body = sent(fetchImpl, call).init.body;
  if (!(body instanceof FormData)) throw new Error("expected a multipart body");
  return body;
};
const sentFile = (fetchImpl: ReturnType<typeof fakeFetch>, call = 0) => {
  const file = sentForm(fetchImpl, call).get("file");
  if (!(file instanceof File)) throw new Error("expected a file part");
  return file;
};

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

/** A fetch that never answers until its signal aborts, then fails the way fetch does. */
const hangingFetch = () =>
  vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      }),
  );

type Extra = { apiKey?: string; maxAudioBytes?: number; timeoutMs?: number };
const deepgram = (fetchImpl: typeof fetch, extra: Extra = {}) =>
  createDeepgramTranscriptionProvider({ apiKey: KEY, fetchImpl, ...extra });
const openai = (fetchImpl: typeof fetch, model = "gpt-transcribe", extra: Extra = {}) =>
  createOpenAITranscriptionProvider({ apiKey: KEY, model, fetchImpl, ...extra });

// ── Deepgram ──────────────────────────────────────────────────────────────

describe("deepgram wire", () => {
  it("sends the recording as the body, with the key, its type and the documented options", async () => {
    const fetchImpl = fakeFetch(() => json(deepgramReply(false)));
    const audio = recording();
    await deepgram(fetchImpl).transcribe({ audio, language: "pt-BR" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, init, headers } = sent(fetchImpl);
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(url.search).toBe(
      "?model=nova-3&language=pt-BR&punctuate=true&smart_format=true&utterances=true",
    );
    expect(headers.get("authorization")).toBe(`Token ${KEY}`);
    expect(headers.get("content-type")).toBe("audio/wav");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(audio);
    expect(init.redirect).toBe("error");
  });

  it("returns the text, the timed utterances and the duration, with no speakers it was not asked for", async () => {
    const result = await deepgram(fakeFetch(() => json(deepgramReply(false)))).transcribe({
      audio: recording(),
      language: "pt-BR",
    });
    expect(result).toEqual({
      text: "Bom dia. Tudo bem?",
      segments: [
        { start: 0.08, end: 1.2, text: "Bom dia." },
        { start: 1.6, end: 2.9, text: "Tudo bem?" },
      ],
      durationSeconds: 4.48,
      model: "nova-3",
    });
    expect(result.usage).toBeUndefined();
  });

  it("turns speakers on with diarize_model and labels each utterance with Deepgram's number", async () => {
    const fetchImpl = fakeFetch(() => json(deepgramReply(true)));
    const result = await deepgram(fetchImpl).transcribe({
      audio: recording(),
      language: "pt-BR",
      diarize: true,
    });
    expect(sent(fetchImpl).url.searchParams.get("diarize_model")).toBe("latest");
    expect(result.segments.map((segment) => segment.speaker)).toEqual([0, 1]);
  });

  it("sends the same request for diarize: false as for saying nothing", async () => {
    const fetchImpl = fakeFetch(() => json(deepgramReply(false)));
    const listen = deepgram(fetchImpl);
    await listen.transcribe({ audio: recording(), language: "pt-BR", diarize: false });
    await listen.transcribe({ audio: recording(), language: "pt-BR" });
    expect(sent(fetchImpl, 0).url.href).toBe(sent(fetchImpl, 1).url.href);
    expect(sent(fetchImpl, 0).url.searchParams.has("diarize_model")).toBe(false);
  });

  it("asks Deepgram to detect the language when none is given, because it would assume English", async () => {
    const fetchImpl = fakeFetch(() => json(deepgramReply(false)));
    await deepgram(fetchImpl).transcribe({ audio: recording() });
    const { searchParams } = sent(fetchImpl).url;
    expect(searchParams.get("detect_language")).toBe("true");
    expect(searchParams.has("language")).toBe(false);
  });

  it("takes this call's model over the provider's, and reports the one used", async () => {
    const fetchImpl = fakeFetch(() => json(deepgramReply(false)));
    const result = await deepgram(fetchImpl).transcribe({ audio: recording(), model: "nova-2" });
    expect(sent(fetchImpl).url.searchParams.get("model")).toBe("nova-2");
    expect(result.model).toBe("nova-2");
  });

  it("reads silence as empty text, not as a failure", async () => {
    const reply = deepgramReply(false);
    reply.results.channels[0]!.alternatives[0]!.transcript = "";
    reply.results.utterances = [];
    const result = await deepgram(fakeFetch(() => json(reply))).transcribe({ audio: recording() });
    expect(result).toMatchObject({ text: "", segments: [] });
  });

  it("skips an utterance whose times do not check out, and keeps the rest", async () => {
    const reply = deepgramReply(false);
    reply.results.utterances[0]!.end = 0;
    const result = await deepgram(fakeFetch(() => json(reply))).transcribe({ audio: recording() });
    expect(result.segments).toEqual([{ start: 1.6, end: 2.9, text: "Tudo bem?" }]);
  });

  it("refuses an empty key before any request, because Deepgram has no keyless mode", async () => {
    const fetchImpl = fakeFetch(() => json(deepgramReply(false)));
    const error = await failure(
      createDeepgramTranscriptionProvider({ apiKey: "", fetchImpl }).transcribe({
        audio: recording(),
      }),
    );
    expect(error).toMatchObject({ kind: "auth", code: "key_invalid", shouldRetry: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("failures, classified by what fixes them", () => {
    it.each([
      [401, "INVALID_AUTH", "Invalid credentials.", "auth"],
      [
        402,
        "ASR_PAYMENT_REQUIRED",
        "Project does not have enough credits for an ASR request and does not have an overage agreement.",
        "quota",
      ],
      [
        403,
        "INSUFFICIENT_PERMISSIONS",
        "Project does not have access to the requested model.",
        "model",
      ],
      [429, "TOO_MANY_REQUESTS", "Too many requests. Please try again later", "rate"],
    ] as const)("%i %s is %s", async (status, code, message, kind) => {
      const fetchImpl = fakeFetch(() => deepgramError(status, code, message));
      const error = await failure(deepgram(fetchImpl).transcribe({ audio: recording() }));
      expect(error).toMatchObject({ kind, status, provider: "transcription:deepgram" });
      expect(error.body).toContain(message);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("names audio it could not read audio_invalid, and keeps Deepgram's words", async () => {
      const error = await failure(
        deepgram(
          fakeFetch(() =>
            deepgramError(
              400,
              "Bad Request",
              "Bad Request: failed to process audio: corrupt or unsupported data",
            ),
          ),
        ).transcribe({ audio: recording() }),
      );
      expect(error).toMatchObject({ kind: "invalid", code: "audio_invalid", status: 400 });
      expect(error.message).toContain("failed to process audio");
      expect(isRetryable(error)).toBe(false);
    });

    it("names a 413 audio_too_large", async () => {
      const error = await failure(
        deepgram(
          fakeFetch(() => deepgramError(413, "PAYLOAD_TOO_LARGE", "Payload too large")),
        ).transcribe({
          audio: recording(),
        }),
      );
      expect(error).toMatchObject({ kind: "invalid", code: "audio_too_large", status: 413 });
    });

    it("leaves another bad request invalid with no audio code", async () => {
      const error = await failure(
        deepgram(
          fakeFetch(() =>
            deepgramError(400, "Bad Request", "No such model/language/tier combination found."),
          ),
        ).transcribe({
          audio: recording(),
        }),
      );
      expect(error).toMatchObject({ kind: "invalid", status: 400 });
      expect(error.code).toBeUndefined();
    });

    it("calls a 200 with no transcript bad_reply, and does not replay it", async () => {
      const fetchImpl = fakeFetch(() => json({ metadata: { duration: 4 } }));
      const error = await failure(deepgram(fetchImpl).transcribe({ audio: recording() }));
      expect(error).toBeInstanceOf(TranscriptionError);
      expect(error).toMatchObject({ kind: "unknown", code: "bad_reply", shouldRetry: false });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("calls a 200 that is not JSON bad_reply", async () => {
      const error = await failure(
        deepgram(fakeFetch(() => new Response("<html>proxy</html>", { status: 200 }))).transcribe({
          audio: recording(),
        }),
      );
      expect(error).toMatchObject({ kind: "unknown", code: "bad_reply" });
    });
  });
});

// ── OpenAI ────────────────────────────────────────────────────────────────

const gptTranscribeReply = {
  text: "Bom dia. Tudo bem?",
  languages: [{ code: "pt" }],
  usage: {
    type: "tokens",
    input_tokens: 70,
    input_token_details: { text_tokens: 0, audio_tokens: 70 },
    output_tokens: 12,
    total_tokens: 82,
  },
};

const whisperReply = {
  task: "transcribe",
  language: "portuguese",
  duration: 4.48,
  text: " Bom dia. Tudo bem?",
  segments: [
    {
      id: 0,
      seek: 0,
      start: 0,
      end: 1.2,
      text: " Bom dia.",
      tokens: [50364],
      temperature: 0,
      avg_logprob: -0.2,
      compression_ratio: 0.8,
      no_speech_prob: 0.01,
    },
    {
      id: 1,
      seek: 0,
      start: 1.6,
      end: 2.9,
      text: " Tudo bem?",
      tokens: [50444],
      temperature: 0,
      avg_logprob: -0.2,
      compression_ratio: 0.8,
      no_speech_prob: 0.01,
    },
  ],
  usage: { type: "duration", seconds: 5 },
};

const diarizedReply = {
  task: "transcribe",
  duration: 4.48,
  text: "Bom dia. Tudo bem?",
  segments: [
    {
      type: "transcript.text.segment",
      id: "seg_0",
      start: 0.08,
      end: 1.2,
      text: "Bom dia.",
      speaker: "A",
    },
    {
      type: "transcript.text.segment",
      id: "seg_1",
      start: 1.6,
      end: 2.9,
      text: "Tudo bem?",
      speaker: "B",
    },
  ],
  usage: {
    type: "tokens",
    input_tokens: 70,
    input_token_details: { text_tokens: 0, audio_tokens: 70 },
    output_tokens: 14,
    total_tokens: 84,
  },
};

describe("openai wire", () => {
  it("sends one multipart request with the file named for its type, the model and languages[]", async () => {
    const fetchImpl = fakeFetch(() => json(gptTranscribeReply));
    await openai(fetchImpl).transcribe({ audio: recording(), language: "pt-BR" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, init, headers } = sent(fetchImpl);
    expect(url.href).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(init.redirect).toBe("error");
    const form = sentForm(fetchImpl);
    const fields: string[] = [];
    form.forEach((_value, name) => fields.push(name));
    expect(fields.sort()).toEqual(["file", "languages[]", "model"]);
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("languages[]")).toBe("pt");
    expect(sentFile(fetchImpl)).toMatchObject({ name: "audio.wav", type: "audio/wav" });
  });

  it("leaves the Content-Type to fetch, so the multipart boundary is the real one", async () => {
    const fetchImpl = fakeFetch(() => json(gptTranscribeReply));
    await openai(fetchImpl).transcribe({ audio: recording() });
    const { url, init, headers } = sent(fetchImpl);
    expect(headers.has("content-type")).toBe(false);
    const request = new Request(url, init);
    expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(await request.text()).toContain('name="file"; filename="audio.wav"');
  });

  it("returns the text and the token usage, with no segments the model does not give", async () => {
    const result = await openai(fakeFetch(() => json(gptTranscribeReply))).transcribe({
      audio: recording(),
    });
    expect(result).toEqual({
      text: "Bom dia. Tudo bem?",
      segments: [],
      usage: {
        type: "tokens",
        inputTokens: 70,
        outputTokens: 12,
        totalTokens: 82,
        audioTokens: 70,
        textTokens: 0,
      },
      model: "gpt-transcribe",
    });
  });

  it("sends no language field when none is given, so the model detects it", async () => {
    const fetchImpl = fakeFetch(() => json(gptTranscribeReply));
    await openai(fetchImpl).transcribe({ audio: recording() });
    const form = sentForm(fetchImpl);
    expect(form.has("language")).toBe(false);
    expect(form.has("languages[]")).toBe(false);
  });

  it("asks Whisper for verbose_json, and reads its timed segments, duration and billed seconds", async () => {
    const fetchImpl = fakeFetch(() => json(whisperReply));
    const result = await openai(fetchImpl, "whisper-1").transcribe({
      audio: recording("audio/mpeg"),
      language: "pt-BR",
    });
    const form = sentForm(fetchImpl);
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("pt");
    expect(form.has("languages[]")).toBe(false);
    expect(sentFile(fetchImpl).name).toBe("audio.mp3");
    expect(result).toEqual({
      text: "Bom dia. Tudo bem?",
      segments: [
        { start: 0, end: 1.2, text: "Bom dia." },
        { start: 1.6, end: 2.9, text: "Tudo bem?" },
      ],
      durationSeconds: 4.48,
      usage: { type: "duration", seconds: 5 },
      model: "whisper-1",
    });
  });

  it("asks for diarized_json with chunking when diarize is on, and keeps OpenAI's speaker labels", async () => {
    const fetchImpl = fakeFetch(() => json(diarizedReply));
    const result = await openai(fetchImpl, "gpt-4o-transcribe-diarize").transcribe({
      audio: recording(),
      diarize: true,
    });
    const form = sentForm(fetchImpl);
    expect(form.get("response_format")).toBe("diarized_json");
    expect(form.get("chunking_strategy")).toBe("auto");
    expect(result.segments).toEqual([
      { start: 0.08, end: 1.2, text: "Bom dia.", speaker: "A" },
      { start: 1.6, end: 2.9, text: "Tudo bem?", speaker: "B" },
    ]);
    expect(result.durationSeconds).toBe(4.48);
  });

  it("drops speakers a reply carries when diarize was off", async () => {
    const fetchImpl = fakeFetch(() => json(diarizedReply));
    const result = await openai(fetchImpl, "gpt-4o-transcribe-diarize").transcribe({
      audio: recording(),
    });
    expect(sentForm(fetchImpl).has("response_format")).toBe(false);
    expect(result.segments.every((segment) => segment.speaker === undefined)).toBe(true);
  });

  it("asks a model that cannot label speakers anyway, and lets its 400 say so", async () => {
    const fetchImpl = fakeFetch(() =>
      openaiError(400, {
        message: "response_format 'diarized_json' is not compatible with model 'gpt-transcribe'.",
        type: "invalid_request_error",
        param: "response_format",
      }),
    );
    const error = await failure(
      openai(fetchImpl).transcribe({ audio: recording(), diarize: true }),
    );
    expect(sentForm(fetchImpl).get("response_format")).toBe("diarized_json");
    expect(error).toMatchObject({ kind: "invalid", status: 400 });
  });

  it("keeps a File's own name when its type is not one the table knows", async () => {
    const fetchImpl = fakeFetch(() => json(gptTranscribeReply));
    await openai(fetchImpl).transcribe({
      audio: new File([Uint8Array.of(1, 2)], "call.mpga", { type: "audio/x-unknown" }),
    });
    expect(sentFile(fetchImpl).name).toBe("call.mpga");
  });

  it("drops token counts that do not add up, rather than bill a wrong number", async () => {
    const result = await openai(
      fakeFetch(() =>
        json({
          text: "Oi.",
          usage: { type: "tokens", input_tokens: 70, output_tokens: 12, total_tokens: 3 },
        }),
      ),
    ).transcribe({ audio: recording() });
    expect(result.usage).toBeUndefined();
  });

  it("sends no Authorization header for a local server that wants none", async () => {
    const fetchImpl = fakeFetch(() => json(gptTranscribeReply));
    await createOpenAITranscriptionProvider({
      apiKey: "",
      model: "whisper",
      baseUrl: "http://localhost:8000/v1",
      fetchImpl,
    }).transcribe({ audio: recording() });
    const { url, headers } = sent(fetchImpl);
    expect(url.href).toBe("http://localhost:8000/v1/audio/transcriptions");
    expect(headers.has("authorization")).toBe(false);
  });

  describe("failures, classified by what fixes them", () => {
    it("401 is auth", async () => {
      const error = await failure(
        openai(
          fakeFetch(() =>
            openaiError(401, {
              message: "Incorrect API key provided: sk-test-***-123.",
              type: "invalid_request_error",
              code: "invalid_api_key",
            }),
          ),
        ).transcribe({ audio: recording() }),
      );
      expect(error).toMatchObject({ kind: "auth", status: 401, provider: "transcription:openai" });
    });

    it("429 with an empty balance is quota, not a throttle", async () => {
      const error = await failure(
        openai(
          fakeFetch(() =>
            openaiError(429, {
              message:
                "You exceeded your current quota, please check your plan and billing details.",
              type: "insufficient_quota",
              code: "insufficient_quota",
            }),
          ),
        ).transcribe({ audio: recording() }),
      );
      expect(error).toMatchObject({ kind: "quota", status: 429 });
      expect(isRetryable(error)).toBe(false);
    });

    it("429 throttle is rate, keeps its wait and stays retryable", async () => {
      const error = await failure(
        openai(
          fakeFetch(() =>
            openaiError(
              429,
              {
                message:
                  "Rate limit reached for whisper-1 on requests per min (RPM): Limit 50, Used 50, Requested 1.",
                type: "requests",
                code: "rate_limit_exceeded",
              },
              { "retry-after": "2" },
            ),
          ),
        ).transcribe({ audio: recording() }),
      );
      expect(error).toMatchObject({ kind: "rate", retryAfterMs: 2_000 });
      expect(isRetryable(error)).toBe(true);
    });

    it.each([
      "Invalid file format. Supported formats: ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']",
      "Audio file might be corrupted or unsupported",
    ])("400 %j is audio_invalid, with OpenAI's words kept", async (message) => {
      const error = await failure(
        openai(
          fakeFetch(() =>
            openaiError(400, { message, type: "invalid_request_error", param: "file" }),
          ),
        ).transcribe({ audio: recording() }),
      );
      expect(error).toMatchObject({ kind: "invalid", code: "audio_invalid", status: 400 });
      expect(error.body).toContain(message);
    });

    it("413 is audio_too_large", async () => {
      const error = await failure(
        openai(
          fakeFetch(() =>
            openaiError(413, {
              message: "Maximum content size limit (26214400) exceeded (26228340 bytes read)",
              type: "server_error",
            }),
          ),
        ).transcribe({ audio: recording() }),
      );
      expect(error).toMatchObject({ kind: "invalid", code: "audio_too_large", status: 413 });
    });

    it("reads a quota refusal that arrives inside a 200 as the failure it is", async () => {
      const fetchImpl = fakeFetch(() =>
        json({
          error: { message: "You exceeded your current quota.", type: "insufficient_quota" },
        }),
      );
      const error = await failure(openai(fetchImpl).transcribe({ audio: recording() }));
      expect(error).toBeInstanceOf(TranscriptionError);
      expect(error.kind).toBe("quota");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("calls a 200 with no text bad_reply, and keeps the usage it billed", async () => {
      const error = await failure(
        openai(fakeFetch(() => json({ usage: whisperReply.usage }))).transcribe({
          audio: recording(),
        }),
      );
      expect(error).toBeInstanceOf(TranscriptionError);
      expect(error).toMatchObject({ kind: "unknown", code: "bad_reply", shouldRetry: false });
      expect((error as TranscriptionError).usage).toEqual({ type: "duration", seconds: 5 });
    });
  });
});

// ── what both wires share ─────────────────────────────────────────────────

const WIRES = [
  { name: "deepgram", make: deepgram, ok: () => json(deepgramReply(false)) },
  {
    name: "openai",
    make: (fetchImpl: typeof fetch, extra: Extra = {}) =>
      openai(fetchImpl, "gpt-transcribe", extra),
    ok: () => json(gptTranscribeReply),
  },
] as const;

describe("openai wire: no model at all", () => {
  it("refuses a provider built without a model, as plain JavaScript can, instead of crashing", async () => {
    const fetchImpl = fakeFetch(() => json(gptTranscribeReply));
    const config = { apiKey: KEY, fetchImpl } as unknown as Parameters<
      typeof createOpenAITranscriptionProvider
    >[0];
    const error = await failure(
      createOpenAITranscriptionProvider(config).transcribe({ audio: recording() }),
    );
    expect(error).toMatchObject({ kind: "invalid", code: "model_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe.each(WIRES)("$name: refused before any request", ({ make, ok }) => {
  const refusal = async (audio: Blob, extra: Extra = {}) => {
    const fetchImpl = fakeFetch(ok);
    const error = await failure(make(fetchImpl, extra).transcribe({ audio }));
    expect(fetchImpl).not.toHaveBeenCalled();
    return error;
  };

  it("an empty recording", async () => {
    expect(await refusal(new Blob([], { type: "audio/wav" }))).toMatchObject({
      kind: "invalid",
      code: "audio_empty",
    });
  });

  it("a recording with no media type", async () => {
    expect(await refusal(new Blob([Uint8Array.of(1)]))).toMatchObject({
      kind: "invalid",
      code: "audio_type_missing",
    });
  });

  it("a recording over maxAudioBytes, which is never cut", async () => {
    expect(await refusal(recording(), { maxAudioBytes: 3 })).toMatchObject({
      kind: "invalid",
      code: "audio_too_large",
    });
  });

  it("a key a runtime would refuse to put in a header, never quoted", async () => {
    const error = await refusal(recording(), { apiKey: `${KEY}\n` });
    expect(error).toMatchObject({ kind: "auth", code: "key_invalid" });
    expect(error.message).not.toContain(KEY);
  });

  it("a caller who already pressed Stop", async () => {
    const fetchImpl = fakeFetch(ok);
    const controller = new AbortController();
    controller.abort();
    const error = await make(fetchImpl)
      .transcribe({ audio: recording(), signal: controller.signal })
      .catch((e: unknown) => e);
    expect(classify(error)).toBe("aborted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe.each(WIRES)("$name: one paid request per call", ({ make, ok }) => {
  const retry = <T>(call: () => Promise<T>) =>
    withRetry(call, { sleep: async () => {}, baseDelayMs: 1 });

  it("does not replay a 503, because the vendor may already have billed", async () => {
    const fetchImpl = fakeFetch(() =>
      json({ error: "Service Unavailable" }, 503, { "x-should-retry": "true" }),
    );
    const error = await failure(retry(() => make(fetchImpl).transcribe({ audio: recording() })));
    expect(error).toMatchObject({ kind: "overload", shouldRetry: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not replay a lost socket", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await failure(retry(() => make(fetchImpl).transcribe({ audio: recording() })));
    expect(error).toMatchObject({ kind: "network", shouldRetry: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends a throttled call again, since nothing ran", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: "slow down" }, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(ok());
    const listen = make(fetchImpl);
    await retry(() => listen.transcribe({ audio: recording() }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("turns OUR deadline into a timeout that is not replayed", async () => {
    const fetchImpl = hangingFetch();
    const listen = make(fetchImpl, { timeoutMs: 20 });
    const error = await failure(retry(() => listen.transcribe({ audio: recording() })));
    expect(error).toMatchObject({ kind: "timeout", shouldRetry: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never turns the caller's Stop into a timeout", async () => {
    const fetchImpl = hangingFetch();
    const controller = new AbortController();
    const pending = make(fetchImpl).transcribe({ audio: recording(), signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect(classify(error)).toBe("aborted");
    expect(isRetryable(error)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("limits", () => {
  it("default to 25 MiB and ten minutes", () => {
    expect(DEFAULT_TRANSCRIPTION_LIMITS).toEqual({
      maxAudioBytes: 25 * 1024 * 1024,
      timeoutMs: 600_000,
    });
  });

  it("refuse values that are not positive integers when the provider is built", () => {
    expect(() => createDeepgramTranscriptionProvider({ apiKey: KEY, maxAudioBytes: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      createOpenAITranscriptionProvider({ apiKey: KEY, model: "m", timeoutMs: 1.5 }),
    ).toThrow(RangeError);
  });

  it("let Deepgram take a recording past OpenAI's 25 MiB, up to its own 2 GB", async () => {
    const fetchImpl = fakeFetch(() => json(deepgramReply(false)));
    const big = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: "audio/wav" });
    await deepgram(fetchImpl).transcribe({ audio: big });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const refused = await failure(
      openai(fakeFetch(() => json(gptTranscribeReply))).transcribe({ audio: big }),
    );
    expect(refused.code).toBe("audio_too_large");
  });
});

// ── presets and the factory ───────────────────────────────────────────────

describe("createTranscriptionProvider", () => {
  it("lists exactly the presets that carry a transcription row", () => {
    const withRow = PRESET_IDS.filter((id) => "transcription" in PROVIDER_PRESETS[id]);
    expect(TRANSCRIPTION_PRESET_IDS).toEqual(withRow);
    expect(TRANSCRIPTION_PRESET_IDS).toEqual(["openai"]);
  });

  it("builds the openai preset on its own host with the model OpenAI recommends", async () => {
    const fetchImpl = fakeFetch(() => json(gptTranscribeReply));
    const listen = createTranscriptionProvider("openai", { apiKey: KEY, fetchImpl });
    expect(listen).toMatchObject({ id: "openai", model: "gpt-transcribe" });
    await listen.transcribe({ audio: recording() });
    expect(sent(fetchImpl).url.href).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  it("reaches a server that copies the route, and asks for a model there", async () => {
    expect(() =>
      createTranscriptionProvider("openai", {
        apiKey: KEY,
        baseUrl: "https://api.groq.com/openai/v1",
      }),
    ).toThrow(/no default model for another host/);
    const fetchImpl = fakeFetch(() => json(whisperReply));
    await createTranscriptionProvider("openai", {
      apiKey: KEY,
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3",
      fetchImpl,
    }).transcribe({ audio: recording() });
    expect(sent(fetchImpl).url.href).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(sentForm(fetchImpl).get("response_format")).toBe("verbose_json");
  });

  it("names the presets that can, and Deepgram's own constructor, for one that cannot", () => {
    expect(() => createTranscriptionProvider("anthropic", { apiKey: KEY })).toThrow(
      /no transcription endpoint\. Presets that do: openai\. Deepgram has its own/,
    );
  });

  it("gives a sign-in preset no transcription row", () => {
    for (const id of PRESET_IDS) {
      const preset: { auth: string; transcription?: unknown } = PROVIDER_PRESETS[id];
      if (preset.auth === "oauth") expect(preset.transcription, id).toBeUndefined();
    }
  });
});
