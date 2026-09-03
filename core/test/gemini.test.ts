// Golden transcripts for the Gemini adapter: real `?alt=sse` frame sequences
// replayed through it, asserting the normalized chunks and the request it
// builds. Same shape as providers.test.ts, plus the signal the fetch must see.
import { describe, expect, it } from "vitest";
import { createGeminiProvider, toGeminiContents } from "../src/providers/gemini.ts";
import type { ChatMessage, Effort, ProviderChunk, ToolChoice } from "../src/types.ts";

/** Records the request (url, body, headers, signal) and replays a canned SSE
 *  transcript — each frame one GenerateContentResponse. */
function recorder(frames: string[], status = 200) {
  const seen: {
    url: string;
    body: Record<string, unknown>;
    headers: Headers;
    signal?: AbortSignal | null;
  }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      body: JSON.parse(init.body as string),
      headers: new Headers(init.headers),
      signal: init.signal,
    });
    if (status !== 200) return new Response("upstream said no", { status });
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
          controller.close();
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

/** Replays bytes onto the wire VERBATIM — for the shapes Gemini sends that are
 *  not SSE frames at all. */
function rawRecorder(chunks: string[]) {
  return (async () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const j = (o: unknown) => JSON.stringify(o);

/** One candidate carrying `parts`, plus an optional finishReason. */
const candidate = (parts: unknown[], finishReason?: string) =>
  j({ candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }] });

const TEXT_TURN = [
  candidate([{ text: "Hel" }]),
  candidate([{ text: "lo" }]),
  j({
    candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 1_000,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 300,
      cachedContentTokenCount: 800,
    },
  }),
];

const HI: ChatMessage[] = [{ role: "user", content: "hi" }];

const provider = (fetchImpl: typeof fetch, config: Record<string, unknown> = {}) =>
  createGeminiProvider({ apiKey: "k", model: "gemini-3-pro", fetchImpl, ...config });

describe("gemini adapter", () => {
  it("streams text deltas and a finish reason", async () => {
    const { fetchImpl } = recorder(TEXT_TURN);
    const chunks = await collect(provider(fetchImpl).createStream(HI, []));

    expect(chunks.filter((c) => c.content).map((c) => c.content)).toEqual(["Hel", "lo"]);
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("stop");
  });

  it("bills thoughts as OUTPUT — they sit outside candidatesTokenCount", async () => {
    // 20 answer + 300 thought tokens. Reporting 20 undercounts the turn by 94%.
    const { fetchImpl } = recorder(TEXT_TURN);
    const chunks = await collect(provider(fetchImpl).createStream(HI, []));

    expect(chunks.find((c) => c.type === "usage")?.usage).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 320,
    });
  });

  it("splits thought parts into reasoning and the rest into content", async () => {
    const { fetchImpl } = recorder([
      candidate([
        { text: "weighing it", thought: true },
        { text: "still weighing", thought: true },
        { text: "the answer" },
      ]),
    ]);
    const chunks = await collect(provider(fetchImpl).createStream(HI, []));

    expect(chunks.map((c) => c.reasoning).filter(Boolean)).toEqual(["weighing itstill weighing"]);
    expect(chunks.map((c) => c.content).filter(Boolean)).toEqual(["the answer"]);
  });

  it("carries the thoughtSignature off a function call", async () => {
    const { fetchImpl } = recorder([
      candidate([
        {
          functionCall: { id: "fc_1", name: "search", args: { q: "cats" } },
          thoughtSignature: "sig-abc",
        },
      ]),
    ]);
    const [call] = (await collect(provider(fetchImpl).createStream(HI, []))).flatMap(
      (c) => c.toolCalls ?? [],
    );

    expect(call).toEqual({
      index: 0,
      id: "fc_1",
      name: "search",
      arguments: '{"q":"cats"}',
      thoughtSignature: "sig-abc",
    });
  });

  it("synthesizes an id when Gemini omits one, and keeps the index monotonic", async () => {
    const { fetchImpl } = recorder([
      candidate([{ functionCall: { name: "a", args: {} } }]),
      candidate([{ functionCall: { name: "b" } }, { functionCall: { name: "c", args: {} } }]),
    ]);
    const calls = (await collect(provider(fetchImpl).createStream(HI, []))).flatMap(
      (c) => c.toolCalls ?? [],
    );

    expect(calls.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(calls.map((c) => c.id)).toEqual(["call_0", "call_1", "call_2"]);
    // An absent `args` is an empty object, never `undefined` in the JSON.
    expect(calls.map((c) => c.arguments)).toEqual(["{}", "{}", "{}"]);
  });

  it("finishes as tool_calls even when STOP lands on a LATER chunk", async () => {
    // Gemini reports STOP on the turn that called a tool, and the reason can
    // arrive after the calls did. Reading it literally drops the tool round.
    const { fetchImpl } = recorder([
      candidate([{ functionCall: { id: "fc_1", name: "search", args: {} } }]),
      candidate([], "STOP"),
    ]);
    const chunks = await collect(provider(fetchImpl).createStream(HI, []));

    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("tool_calls");
  });

  it("maps each finish reason", async () => {
    const cases: [string, string][] = [
      ["MAX_TOKENS", "length"],
      ["SAFETY", "content_filter"],
      ["PROHIBITED_CONTENT", "content_filter"],
      ["STOP", "stop"],
      ["OTHER", "stop"],
    ];
    for (const [reason, expected] of cases) {
      const { fetchImpl } = recorder([candidate([{ text: "x" }], reason)]);
      const chunks = await collect(provider(fetchImpl).createStream(HI, []));
      expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe(expected);
    }
  });

  it("posts to the streamGenerateContent URL with the api-key header", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(provider(fetchImpl).createStream(HI, []));

    expect(seen[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse",
    );
    expect(seen[0]!.headers.get("x-goog-api-key")).toBe("k");
  });

  it("honours a baseUrl with a trailing slash, a per-call model, and a models/ prefix", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider(fetchImpl, { baseUrl: "https://proxy.example/" }).createStream(HI, [], {
        model: "models/gemini-3-flash",
      }),
    );

    expect(seen[0]!.url).toBe(
      "https://proxy.example/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse",
    );
  });

  it("passes the abort signal through to the fetch", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    const controller = new AbortController();
    await collect(provider(fetchImpl).createStream(HI, [], { signal: controller.signal }));

    expect(seen[0]!.signal).toBe(controller.signal);
  });

  it("declares tools with parametersJsonSchema, not the trimmed dialect", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider(fetchImpl).createStream(HI, [
        {
          name: "search",
          description: "look it up",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
      ]),
    );

    const [tool] = seen[0]!.body.tools as { functionDeclarations: Record<string, unknown>[] }[];
    expect(tool!.functionDeclarations[0]).toEqual({
      name: "search",
      description: "look it up",
      parametersJsonSchema: { type: "object", properties: { q: { type: "string" } } },
    });
  });

  it("maps every tool choice, and omits the config for auto", async () => {
    const tools = [{ name: "search", description: "d", inputSchema: { type: "object" as const } }];
    const configFor = async (toolChoice?: ToolChoice) => {
      const { seen, fetchImpl } = recorder(TEXT_TURN);
      await collect(
        provider(fetchImpl).createStream(HI, tools, { ...(toolChoice ? { toolChoice } : {}) }),
      );
      return seen[0]!.body.toolConfig;
    };

    expect(await configFor()).toBeUndefined();
    expect(await configFor("auto")).toBeUndefined();
    expect(await configFor("none")).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(await configFor("required")).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(await configFor({ name: "search" })).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["search"] },
    });
  });

  it("sends no toolConfig when there are no declarations to point it at", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(provider(fetchImpl).createStream(HI, [], { toolChoice: "required" }));

    expect(seen[0]!.body.tools).toBeUndefined();
    expect(seen[0]!.body.toolConfig).toBeUndefined();
  });

  it("puts the thinking level under generationConfig, and omits it with no effort", async () => {
    const levelFor = async (effort?: Effort) => {
      const { seen, fetchImpl } = recorder(TEXT_TURN);
      await collect(provider(fetchImpl).createStream(HI, [], { ...(effort ? { effort } : {}) }));
      const generationConfig = seen[0]!.body.generationConfig as {
        thinkingConfig?: { thinkingLevel: string };
      };
      return generationConfig.thinkingConfig?.thinkingLevel;
    };

    // A hard 0 budget is rejected by the Pro models — MINIMAL is how `none`
    // survives the request.
    expect(await levelFor("none")).toBe("MINIMAL");
    expect(await levelFor("low")).toBe("LOW");
    expect(await levelFor("medium")).toBe("MEDIUM");
    expect(await levelFor("high")).toBe("HIGH");
    expect(await levelFor("max")).toBe("HIGH");
    // Absent effort is the model's own dynamic thinking, never MINIMAL.
    expect(await levelFor()).toBeUndefined();
  });

  it("sends the JSON schema and the ceiling in generationConfig", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider(fetchImpl, { maxTokens: 4_000 }).createStream(HI, [], {
        temperature: 0.2,
        json: { name: "answer", schema: { type: "object", properties: { a: { type: "string" } } } },
      }),
    );

    expect(seen[0]!.body.generationConfig).toEqual({
      maxOutputTokens: 4_000,
      temperature: 0.2,
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object", properties: { a: { type: "string" } } },
    });
  });

  it("surfaces a non-2xx through the shared classifier", async () => {
    const { fetchImpl } = recorder([], 429);
    await expect(collect(provider(fetchImpl).createStream(HI, []))).rejects.toMatchObject({
      kind: "rate",
      provider: "gemini",
    });
  });

  it("skips a frame that is not JSON rather than failing the stream", async () => {
    const { fetchImpl } = recorder(["not json at all", candidate([{ text: "ok" }], "STOP")]);
    const chunks = await collect(provider(fetchImpl).createStream(HI, []));

    expect(chunks.map((c) => c.content).filter(Boolean)).toEqual(["ok"]);
  });

  // `?alt=sse` has already sent 200 by the time these land, so the failure
  // arrives in the body. Draining them as a successful empty turn is the one
  // outcome that must never happen: retry.ts would see nothing to retry and
  // the key pool nothing to rotate off.
  it("throws an overload on a mid-stream UNAVAILABLE, after the text it did send", async () => {
    const { fetchImpl } = recorder([
      candidate([{ text: "partial" }]),
      j({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }),
    ]);
    const stream = provider(fetchImpl).createStream(HI, []);
    const seen: ProviderChunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of stream) seen.push(chunk);
      })(),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "gemini",
      kind: "overload",
      status: 503,
      code: "UNAVAILABLE",
      message: "gemini stream error: The model is overloaded.",
    });
    expect(seen.map((c) => c.content).filter(Boolean)).toEqual(["partial"]);
  });

  it("throws a rate on a mid-stream RESOURCE_EXHAUSTED, so the key pool rotates", async () => {
    const { fetchImpl } = recorder([j({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } })]);

    await expect(collect(provider(fetchImpl).createStream(HI, []))).rejects.toMatchObject({
      kind: "rate",
      status: 429,
      code: "RESOURCE_EXHAUSTED",
    });
  });

  it("throws on the bare un-prefixed Status Gemini appends outside the framing", async () => {
    // No `data:` on it, and no trailing blank line — the shape the SDK reads by
    // JSON-parsing raw network chunks.
    const fetchImpl = rawRecorder([
      `data: ${candidate([{ text: "par" }])}\n\n`,
      j({ error: { code: 503, status: "UNAVAILABLE" } }),
    ]);

    await expect(collect(provider(fetchImpl).createStream(HI, []))).rejects.toMatchObject({
      kind: "overload",
      status: 503,
    });
  });

  it("honours RetryInfo instead of guessing a backoff", async () => {
    const { fetchImpl } = recorder([
      j({
        error: {
          code: 429,
          message: "Quota exceeded.",
          status: "RESOURCE_EXHAUSTED",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "52s" }],
        },
      }),
    ]);

    await expect(collect(provider(fetchImpl).createStream(HI, []))).rejects.toMatchObject({
      retryAfterMs: 52_000,
    });
  });

  it("falls back to overload for an in-band failure it cannot classify", async () => {
    // "unknown" is never retried, and a stream that dies after its headers is
    // by construction transient.
    const { fetchImpl } = recorder([j({ error: { message: "something went sideways" } })]);

    await expect(collect(provider(fetchImpl).createStream(HI, []))).rejects.toMatchObject({
      kind: "overload",
      message: "gemini stream error: something went sideways",
    });
  });
});

describe("toGeminiContents", () => {
  it("merges every system message into one instruction and drops the role", () => {
    const { system, contents } = toGeminiContents([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "system", content: "and polite" },
    ]);

    expect(system).toBe("be brief\n\nand polite");
    expect(contents.map((c) => c.role)).toEqual(["user"]);
  });

  it("sends the merged system text as a Content — REST rejects a bare string", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider(fetchImpl).createStream([{ role: "system", content: "be brief" }, ...HI], []),
    );

    expect(seen[0]!.body.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
  });

  it("makes an assistant turn role `model` with functionCall parts", () => {
    const { contents } = toGeminiContents([
      {
        role: "assistant",
        content: "looking",
        toolCalls: [
          { id: "a", name: "search", arguments: '{"q":"cats"}', thoughtSignature: "sig" },
        ],
      },
    ]);

    expect(contents[0]!.role).toBe("model");
    expect(contents[0]!.parts).toEqual([
      { text: "looking" },
      { functionCall: { id: "a", name: "search", args: { q: "cats" } }, thoughtSignature: "sig" },
    ]);
  });

  it("drops an assistant turn with nothing in it — an empty parts array is a 400", () => {
    const { contents } = toGeminiContents([{ role: "assistant", content: "" }]);
    expect(contents).toEqual([]);
  });

  it("returns a tool result as a functionResponse on a USER turn, keyed by name", () => {
    const { contents } = toGeminiContents([
      { role: "tool", toolCallId: "a", name: "search", content: '{"hits":2}' },
    ]);

    expect(contents[0]!.role).toBe("user");
    expect(contents[0]!.parts).toEqual([
      { functionResponse: { id: "a", name: "search", response: { hits: 2 } } },
    ]);
  });

  it("wraps a non-object tool result — Gemini requires an object response", () => {
    const responses = toGeminiContents([
      { role: "tool", toolCallId: "a", name: "s", content: "plain text" },
      { role: "tool", toolCallId: "b", name: "s", content: "42" },
      { role: "tool", toolCallId: "c", name: "s", content: "[1,2]" },
    ]).contents.map(
      (c) => (c.parts[0] as { functionResponse: { response: unknown } }).functionResponse.response,
    );

    expect(responses).toEqual([{ output: "plain text" }, { output: 42 }, { output: [1, 2] }]);
  });

  it("wraps non-object arguments and salvages a truncated one", () => {
    const args = toGeminiContents([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "s", arguments: '"just a string"' },
          { id: "b", name: "s", arguments: '{"q":"trunc' },
        ],
      },
    ]).contents[0]!.parts.map((p) => (p as { functionCall: { args: unknown } }).functionCall.args);

    // The truncated call keeps the field the cut landed in. It used to degrade
    // to `{}` here — a bare JSON.parse in this adapter, while the package's own
    // salvage sat unused two files away. Replaying `{}` deletes an argument the
    // model did send, which is the failure `parseToolArgs` exists to prevent.
    expect(args).toEqual([{ value: "just a string" }, { q: "trunc" }]);
  });

  it("carries images as inlineData, on user turns and on tool results", () => {
    const { contents } = toGeminiContents([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", mimeType: "image/png", data: "AAA" },
        ],
      },
      {
        role: "tool",
        toolCallId: "a",
        name: "shot",
        content: "done",
        images: [{ type: "image", mimeType: "image/jpeg", data: "BBB" }],
      },
    ]);

    expect(contents[0]!.parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "AAA" } });
    expect(contents[1]!.parts[1]).toEqual({ inlineData: { mimeType: "image/jpeg", data: "BBB" } });
  });
});
