import * as hosted from "../src/hosted.ts";
// Golden transcripts for the Gemini adapter: real `?alt=sse` frame sequences
// replayed through it, asserting the normalized chunks and the request it
// builds. Same shape as providers.test.ts, plus the signal the fetch must see.
import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.ts";
import type { HostedTool } from "../src/hosted.ts";
import {
  antigravityUserAgent,
  createGeminiProvider,
  toGeminiContents,
} from "../src/providers/gemini.ts";
import { collectTurn } from "../src/turn.ts";
import { withStreamRetry } from "../src/retry.ts";
import { costUsd } from "../src/usage.ts";
import { withWatchdog } from "../src/watchdog.ts";
import type {
  ChatMessage,
  Effort,
  ProviderChunk,
  ToolChoice,
  ToolDefinition,
} from "../src/types.ts";

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
      reasoningTokens: 300,
    });
  });

  it("refuses one-call-per-turn rather than ignore it", async () => {
    // Gemini has no switch for it. Sent anyway, the turn hands back the
    // parallel calls the caller ruled out.
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    const tool = { name: "t", description: "t", inputSchema: { type: "object" as const } };
    const err = await collect(
      provider(fetchImpl).createStream(HI, [tool], { parallelToolCalls: false }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "invalid" });
    expect(seen).toHaveLength(0);

    // Without tools there is nothing to serialize, and `true` is the default.
    await collect(provider(fetchImpl).createStream(HI, [], { parallelToolCalls: false }));
    await collect(provider(fetchImpl).createStream(HI, [tool], { parallelToolCalls: true }));
    expect(seen).toHaveLength(2);
  });

  it("splits thought parts into reasoning and the rest into content", async () => {
    const { fetchImpl } = recorder([
      candidate([
        { text: "weighing it", thought: true },
        { text: "still weighing", thought: true },
        { text: "the answer" },
      ]),
      candidate([], "STOP"),
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
      candidate([], "STOP"),
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
      candidate([], "STOP"),
    ]);
    const calls = (await collect(provider(fetchImpl).createStream(HI, []))).flatMap(
      (c) => c.toolCalls ?? [],
    );

    expect(calls.map((c) => c.index)).toEqual([0, 1, 2]);
    const ids = calls.map((c) => c.id ?? "");
    expect(ids.every((id) => /^call_pk_\w+$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(3);
    // An absent `args` is an empty object, never `undefined` in the JSON.
    expect(calls.map((c) => c.arguments)).toEqual(["{}", "{}", "{}"]);
  });

  it("reads a blocked prompt as content, not as a cut stream", async () => {
    // No candidate at all, so nothing ever states a finish. Read as a cut
    // stream it is retried, into the same block.
    const { fetchImpl } = recorder([j({ promptFeedback: { blockReason: "SAFETY" } })]);
    await expect(collect(provider(fetchImpl).createStream(HI, []))).rejects.toMatchObject({
      kind: "content",
      code: "SAFETY",
    });
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

  it("keeps a length cut on a turn that called a tool, as the other wires do", async () => {
    // The cut may be what broke the call. Dressed as tool_calls, the loop runs
    // a call whose arguments never finished.
    const { fetchImpl } = recorder([
      candidate([{ functionCall: { id: "fc_1", name: "search", args: {} } }]),
      candidate([], "MAX_TOKENS"),
    ]);
    const chunks = await collect(provider(fetchImpl).createStream(HI, []));

    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("length");
  });

  it("maps each finish reason Gemini documents", async () => {
    const cases: [string, string][] = [
      ["STOP", "stop"],
      ["MAX_TOKENS", "length"],
      ["CONTINUATION", "length"],
      ["SAFETY", "content_filter"],
      ["PROHIBITED_CONTENT", "content_filter"],
      ["BLOCKLIST", "content_filter"],
      ["SPII", "content_filter"],
      ["RECITATION", "content_filter"],
      ["LANGUAGE", "content_filter"],
      ["ESCALATION", "content_filter"],
      ["IMAGE_SAFETY", "content_filter"],
      ["IMAGE_PROHIBITED_CONTENT", "content_filter"],
      ["IMAGE_RECITATION", "content_filter"],
    ];
    for (const [reason, expected] of cases) {
      const { fetchImpl } = recorder([candidate([{ text: "x" }], reason)]);
      const chunks = await collect(provider(fetchImpl).createStream(HI, []));
      expect(chunks.find((c) => c.type === "finish")?.finishReason, reason).toBe(expected);
    }
  });

  it("throws on a finish that does not say the answer is whole", async () => {
    // Each of these read as `stop` once. After a tool result an empty `stop`
    // passes as the model choosing to say nothing, so a botched call was
    // never retried.
    const cases: [string, string][] = [
      ["MALFORMED_FUNCTION_CALL", "overload"],
      ["UNEXPECTED_TOOL_CALL", "overload"],
      ["TOO_MANY_TOOL_CALLS", "overload"],
      ["MALFORMED_RESPONSE", "overload"],
      ["NO_IMAGE", "overload"],
      ["OTHER", "overload"],
      ["IMAGE_OTHER", "overload"],
      ["FINISH_REASON_UNSPECIFIED", "overload"],
      ["A_REASON_ADDED_NEXT_YEAR", "overload"],
      // The same request fails the same way, so nothing retries it.
      ["MISSING_THOUGHT_SIGNATURE", "invalid"],
      // The account, not the request: a key pool benches the key.
      ["PUP_LIMITED_DISABLED", "auth"],
    ];
    for (const [reason, kind] of cases) {
      const { fetchImpl } = recorder([candidate([], reason)]);
      const err = await collect(provider(fetchImpl).createStream(HI, [])).catch((e: unknown) => e);
      expect(err, reason).toBeInstanceOf(ProviderError);
      expect(err, reason).toMatchObject({ kind, code: reason, provider: "gemini" });
    }
  });

  it("does not dress a botched call as tool_calls", async () => {
    // A call arrived, then the model botched the next one. Promoting the
    // finish would run half a turn as if it were the whole one.
    const { fetchImpl } = recorder([
      candidate([{ functionCall: { id: "fc_1", name: "search", args: {} } }]),
      candidate([], "MALFORMED_FUNCTION_CALL"),
    ]);
    await expect(collect(provider(fetchImpl).createStream(HI, []))).rejects.toMatchObject({
      kind: "overload",
    });
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
    const levelFor = async (effort?: Effort, model?: string) => {
      const { seen, fetchImpl } = recorder(TEXT_TURN);
      await collect(
        provider(fetchImpl, model ? { model } : {}).createStream(HI, [], {
          ...(effort ? { effort } : {}),
        }),
      );
      const generationConfig = seen[0]!.body.generationConfig as {
        thinkingConfig?: { thinkingLevel: string };
      };
      return generationConfig.thinkingConfig?.thinkingLevel;
    };

    // Flash 3.0 / 3.5 / 3.6 and Flash-Lite accept MINIMAL (0 thought tokens).
    // Pro, 3.7-flash, 3.8-flash, 4-argon and flash-latest reject MINIMAL with
    // a 400 and take LOW as their lowest level (measured 2026-10-21).
    expect(await levelFor("none", "gemini-3.6-flash")).toBe("MINIMAL");
    expect(await levelFor("none", "gemini-3.5-flash-lite")).toBe("MINIMAL");
    expect(await levelFor("none", "gemini-3.8-flash")).toBe("LOW");
    expect(await levelFor("none", "gemini-3.1-pro-preview")).toBe("LOW");
    expect(await levelFor("none", "gemini-4-argon")).toBe("LOW");
    expect(await levelFor("low")).toBe("LOW");
    expect(await levelFor("medium")).toBe("MEDIUM");
    expect(await levelFor("high")).toBe("HIGH");
    expect(await levelFor("max")).toBe("HIGH");
    // Absent effort is the model's own dynamic thinking, never MINIMAL or LOW.
    expect(await levelFor()).toBeUndefined();
  });

  it("sends a budget to Gemini 2 and a level to every other model", async () => {
    const thinkingFor = async (model: string) => {
      const { seen, fetchImpl } = recorder(TEXT_TURN);
      await collect(provider(fetchImpl, { model }).createStream(HI, [], { effort: "low" }));
      return (seen[0]!.body.generationConfig as { thinkingConfig: unknown }).thinkingConfig;
    };

    expect(await thinkingFor("gemini-2.5-flash")).toEqual({ thinkingBudget: 1024 });
    // Google answers a budget from the next models with a 400, so a model this
    // adapter can't name, such as an alias or one released later, gets a level.
    for (const model of ["gemini-3.8-flash", "gemini-flash-latest", "gemini-4-pro"]) {
      expect(await thinkingFor(model)).toEqual({ thinkingLevel: "LOW" });
    }
  });

  it("omits temperature and topP by default", async () => {
    // Gemini 3.6 Flash and later ignore them, and the next models reject them.
    for (const model of ["gemini-2.5-flash", "gemini-3.8-flash"]) {
      const { seen, fetchImpl } = recorder(TEXT_TURN);
      await collect(
        provider(fetchImpl, { model }).createStream(HI, [], { temperature: 0.2, topP: 0.9 }),
      );
      expect(seen[0]!.body.generationConfig).toEqual({});
    }
  });

  it("preserves explicit zero temperature on a pinned legacy model", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    const legacy = provider(fetchImpl, {
      model: "gemini-3.1-flash-lite",
      allowLegacySampling: true,
    });
    await collect(legacy.createStream(HI, [], { temperature: 0, topP: 0.9 }));
    await collect(legacy.createStream(HI, []));
    expect(seen[0]!.body.generationConfig).toEqual({ temperature: 0, topP: 0.9 });
    expect(seen[1]!.body.generationConfig).toEqual({});
  });

  it("sends the JSON schema and the ceiling in generationConfig", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider(fetchImpl, { maxTokens: 4_000 }).createStream(HI, [], {
        json: { name: "answer", schema: { type: "object", properties: { a: { type: "string" } } } },
      }),
    );

    expect(seen[0]!.body.generationConfig).toEqual({
      maxOutputTokens: 4_000,
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object", properties: { a: { type: "string" } } },
    });
  });

  it("moves the schema into the system instruction on tool calls when asked", async () => {
    // A pinned decoder cannot emit a functionCall, and the models that hit it
    // narrate the call instead of making it — `gemini-3.8-flash` managed 3/10
    // (2026-09-07). Only the calls that carry tools change.
    const schema = { type: "object" as const, properties: { hrn: { type: "string" } } };
    const sent = async (tools: ToolDefinition[]) => {
      const { seen, fetchImpl } = recorder(TEXT_TURN);
      await collect(
        provider(fetchImpl, { jsonWithTools: "prompt" }).createStream(
          [{ role: "system", content: "be brief" }, ...HI],
          tools,
          { json: { name: "answer", schema } },
        ),
      );
      return seen[0]!.body as {
        generationConfig: Record<string, unknown>;
        systemInstruction?: { parts: { text: string }[] };
      };
    };

    const withTools = await sent([
      { name: "look_up", description: "look it up", inputSchema: { type: "object" } },
    ]);
    expect(withTools.generationConfig.responseMimeType).toBeUndefined();
    expect(withTools.generationConfig.responseJsonSchema).toBeUndefined();
    // The schema still reaches the model, after the caller's own text so the
    // prefix cache in front of it survives.
    expect(withTools.systemInstruction!.parts[0]).toEqual({ text: "be brief" });
    expect(withTools.systemInstruction!.parts[1]!.text).toContain("hrn");

    // No tools, no bet to lose: the enforced schema rides as it always did.
    const noTools = await sent([]);
    expect(noTools.generationConfig.responseJsonSchema).toEqual(schema);
    expect(noTools.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
  });

  it("keeps the schema out of a Gemini 2 tool call, asked or not", async () => {
    // Not a preference on this generation: the API answers `400 "Function
    // calling with a response mime type: 'application/json' is unsupported"`.
    // Honouring `response_format` here would only buy the caller that 400.
    const schema = { type: "object" as const, properties: { hrn: { type: "string" } } };
    const sent = async (model: string, jsonWithTools?: string) => {
      const { seen, fetchImpl } = recorder(TEXT_TURN);
      await collect(
        provider(fetchImpl, { model, ...(jsonWithTools ? { jsonWithTools } : {}) }).createStream(
          HI,
          [{ name: "look_up", description: "look it up", inputSchema: { type: "object" } }],
          { json: { name: "answer", schema } },
        ),
      );
      return seen[0]!.body as {
        generationConfig: Record<string, unknown>;
        systemInstruction?: { parts: { text: string }[] };
      };
    };

    const two = await sent("gemini-2.5-flash");
    expect(two.generationConfig.responseMimeType).toBeUndefined();
    expect(two.systemInstruction!.parts[0]!.text).toContain("hrn");

    const asked = await sent("gemini-2.5-flash", "response_format");
    expect(asked.generationConfig.responseMimeType).toBeUndefined();

    // Gemini 3 serves both, so the default stays the enforced schema.
    const three = await sent("gemini-3-pro");
    expect(three.generationConfig.responseJsonSchema).toEqual(schema);
    expect(three.systemInstruction).toBeUndefined();
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

  it("answers parallel calls in ONE user turn, responses in call order, then their images", () => {
    // Spread over one turn each, Gemini 400s that the response count does not
    // match the call count, and the whole tool round is lost.
    const shot = { type: "image" as const, mimeType: "image/png" as const, data: "AAA" };
    const { contents } = toGeminiContents([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "shot", arguments: "{}" },
          { id: "b", name: "search", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "a", name: "shot", content: "taken", images: [shot] },
      { role: "tool", toolCallId: "b", name: "search", content: "found" },
      { role: "user", content: "go on" },
    ]);

    expect(contents.map((c) => c.role)).toEqual(["model", "user", "user"]);
    expect(contents[1]!.parts).toEqual([
      { functionResponse: { id: "a", name: "shot", response: { output: "taken" } } },
      { functionResponse: { id: "b", name: "search", response: { output: "found" } } },
      { inlineData: { mimeType: "image/png", data: "AAA" } },
    ]);
  });

  it("wraps a non-object tool result — Gemini requires an object response", () => {
    const responses = toGeminiContents([
      { role: "tool", toolCallId: "a", name: "s", content: "plain text" },
      { role: "tool", toolCallId: "b", name: "s", content: "42" },
      { role: "tool", toolCallId: "c", name: "s", content: "[1,2]" },
    ]).contents[0]!.parts.map(
      (p) => (p as { functionResponse: { response: unknown } }).functionResponse.response,
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

  it("sends a PDF, audio and video as inlineData, the way it sends an image", async () => {
    // The one adapter that takes files. Without it, media is the reason an
    // adopter keeps a vendor SDK beside this package.
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider(fetchImpl).createStream(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in these" },
              { type: "file", mimeType: "application/pdf", data: "JVBERi0" },
              { type: "file", mimeType: "audio/mpeg", data: "SUQz" },
              { type: "file", mimeType: "video/mp4", data: "AAAAIGZ0eXA" },
              { type: "image", mimeType: "image/png", data: "iVBORw0K" },
            ],
          },
        ],
        [],
      ),
    );
    expect(seen[0]!.body.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "what is in these" },
          { inlineData: { mimeType: "application/pdf", data: "JVBERi0" } },
          { inlineData: { mimeType: "audio/mpeg", data: "SUQz" } },
          { inlineData: { mimeType: "video/mp4", data: "AAAAIGZ0eXA" } },
          { inlineData: { mimeType: "image/png", data: "iVBORw0K" } },
        ],
      },
    ]);
  });
});

describe("antigravityUserAgent", () => {
  it("serves gemini-4-argon to the CLI and every other model to the IDE", () => {
    expect(antigravityUserAgent("gemini-4-argon")).toContain("antigravity/cli/");
    expect(antigravityUserAgent("antigravity/gemini-4-argon")).toContain("antigravity/cli/");
    expect(antigravityUserAgent("gemini-3.8-flash")).toContain("antigravity/ide/");
    expect(antigravityUserAgent("claude-opus-5-5")).toContain("antigravity/ide/");
  });
});

// ── hosted tools ──────────────────────────────────────────────────────────

const SOURCE_URL = "https://cats.example/sleep";
/** The claim holds an emoji, so its UTF-8 byte offsets and its JS indices
 *  part. It is said twice, so only offsets converted right find the second:
 *  matching the text alone can't tell the two apart. */
const CLAIM = "Cats 🐈 sleep 12 to 16 hours.";
const ANSWER = `${CLAIM} Again: ${CLAIM}`;
const SECOND = ANSWER.lastIndexOf(CLAIM);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const secondClaim = {
  startIndex: bytes(ANSWER.slice(0, SECOND)),
  endIndex: bytes(ANSWER),
  text: CLAIM,
};

/** A grounded answer: the text, then the metadata saying what it read and
 *  which sentence each page backs, in bytes. */
const groundedTurn = (segment: { startIndex?: number; endIndex: number; text: string }) => [
  candidate([{ text: ANSWER.slice(0, 7) }]),
  candidate([{ text: ANSWER.slice(7) }]),
  j({
    candidates: [
      {
        content: { parts: [] },
        finishReason: "STOP",
        groundingMetadata: {
          webSearchQueries: ["how long do cats sleep"],
          searchEntryPoint: { renderedContent: "<div>suggestions</div>" },
          groundingChunks: [
            { web: { uri: SOURCE_URL, title: "cats.example" } },
            { web: { uri: SOURCE_URL, title: "cats.example" } },
          ],
          groundingSupports: [{ segment, groundingChunkIndices: [0] }],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, toolUsePromptTokenCount: 400 },
  }),
];

describe("gemini hosted tools", () => {
  const provider = (fetchImpl: typeof fetch, config: Record<string, unknown> = {}) =>
    hosted.createGeminiProvider({ apiKey: "k", model: "gemini-3-pro", fetchImpl, ...config });
  const search = { hostedTools: [{ type: "web_search" as const }] };
  const fn: ToolDefinition = { name: "save", description: "save", inputSchema: { type: "object" } };

  it("sends each built-in, and none of them when the tool choice is none", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    const tools: HostedTool[] = [
      { type: "web_search" },
      { type: "web_fetch" },
      { type: "code_execution" },
      { type: "file_search", storeIds: ["fileSearchStores/cats"], maxResults: 3 },
    ];
    for (const tool of tools) {
      await collect(provider(fetchImpl).createStream(HI, [], { hostedTools: [tool] }));
    }
    expect(seen.map(({ body }) => body.tools)).toEqual([
      [{ googleSearch: {} }],
      [{ urlContext: {} }],
      [{ codeExecution: {} }],
      [{ fileSearch: { fileSearchStoreNames: ["fileSearchStores/cats"], topK: 3 } }],
    ]);
    // `NONE` stops only function calls here, so `none` leaves the built-ins out.
    const none = recorder(TEXT_TURN);
    await collect(
      provider(none.fetchImpl).createStream(HI, [fn], { ...search, toolChoice: "none" }),
    );
    expect(none.seen[0]!.body.tools).toEqual([
      { functionDeclarations: [expect.objectContaining({ name: "save" })] },
    ]);
  });

  it.each([
    ["web_search", { googleSearch: {} }],
    ["web_fetch", { urlContext: {} }],
    ["code_execution", { codeExecution: {} }],
  ] as const)(
    "refuses File Search beside %s and drops only an optional conflicting tool",
    async (type, expectedTool) => {
      const file: HostedTool = { type: "file_search", storeIds: ["fileSearchStores/cats"] };
      const other: HostedTool = { type };
      const refused = recorder(TEXT_TURN);
      await expect(
        collect(provider(refused.fetchImpl).createStream(HI, [], { hostedTools: [file, other] })),
      ).rejects.toMatchObject({ kind: "invalid", message: expect.stringContaining("file_search") });
      expect(refused.seen).toHaveLength(0);

      const keepFile = recorder(TEXT_TURN);
      await collect(
        provider(keepFile.fetchImpl).createStream(HI, [], {
          hostedTools: [file, { ...other, optional: true }],
        }),
      );
      expect(keepFile.seen[0]!.body.tools).toEqual([
        { fileSearch: { fileSearchStoreNames: ["fileSearchStores/cats"] } },
      ]);

      const keepOther = recorder(TEXT_TURN);
      await collect(
        provider(keepOther.fetchImpl).createStream(HI, [], {
          hostedTools: [{ ...file, optional: true }, other],
        }),
      );
      expect(keepOther.seen[0]!.body.tools).toEqual([expectedTool]);
    },
  );

  it("never drops a required restriction to resolve an optional File Search conflict", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await expect(
      collect(
        provider(fetchImpl).createStream(HI, [], {
          hostedTools: [
            { type: "file_search", storeIds: ["fileSearchStores/cats"], optional: true },
            { type: "web_search", maxUses: 1 },
          ],
        }),
      ),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(seen).toHaveLength(0);
  });

  it("asks Gemini 3 to run built-ins beside functions, and refuses the mix on Gemini 2", async () => {
    const mixed = recorder(TEXT_TURN);
    await collect(provider(mixed.fetchImpl).createStream(HI, [fn], search));
    expect(mixed.seen[0]!.body.tools).toEqual([
      { functionDeclarations: [expect.objectContaining({ name: "save" })] },
      { googleSearch: {} },
    ]);
    expect(mixed.seen[0]!.body.toolConfig).toEqual({
      functionCallingConfig: { mode: "VALIDATED" },
      includeServerSideToolInvocations: true,
    });

    const old = recorder(TEXT_TURN);
    await expect(
      collect(
        provider(old.fetchImpl, { model: "gemini-2.5-flash" }).createStream(HI, [fn], search),
      ),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(old.seen).toHaveLength(0);
    // Without functions, Gemini 2 searches.
    const alone = recorder(TEXT_TURN);
    await collect(
      provider(alone.fetchImpl, { model: "gemini-2.5-flash" }).createStream(HI, [], search),
    );
    expect(alone.seen[0]!.body.tools).toEqual([{ googleSearch: {} }]);
  });

  it("refuses every field Gemini can't apply, and every tool on Antigravity", async () => {
    const refusals: [HostedTool, Record<string, unknown>?][] = [
      [{ type: "web_search", allowedDomains: ["cats.example"] }],
      [{ type: "web_fetch", maxUses: 1 }],
      [{ type: "web_search", userLocation: { country: "US" } }],
      [{ type: "code_execution", fileIds: ["file_1"] }],
      [{ type: "image_generation" }],
      [
        { type: "web_search" },
        { id: "antigravity", baseUrl: "https://cloudcode-pa.googleapis.com" },
      ],
    ];
    for (const [tool, config] of refusals) {
      const { seen, fetchImpl } = recorder(TEXT_TURN);
      await expect(
        collect(provider(fetchImpl, config).createStream(HI, [], { hostedTools: [tool] })),
      ).rejects.toMatchObject({ kind: "invalid" });
      expect(seen).toHaveLength(0);
    }
  });

  it("reads grounding as one search, its pages as sources, and each supported sentence as a claim", async () => {
    const turn = await collectTurn(
      provider(recorder(groundedTurn(secondClaim)).fetchImpl).createStream(HI, [], search),
    );
    expect(turn.message.hostedCalls).toEqual([
      {
        id: "hosted_0",
        type: "web_search",
        status: "completed",
        input: { query: "how long do cats sleep" },
        // One page, cited twice by the chunks, is one source of the search.
        output: {
          sources: [{ type: "url", url: SOURCE_URL, title: "cats.example" }],
          searchSuggestions: "<div>suggestions</div>",
        },
        at: 0,
      },
    ]);
    const [citation] = turn.message.citations ?? [];
    // Bytes became JS indices: the span lands on the second claim, not the first.
    expect(citation).toMatchObject({ anchor: "claim", start: SECOND, end: ANSWER.length });
    expect(turn.message.content.slice(citation?.start, citation?.end)).toBe(CLAIM);
    // The prompt the search results added bills as input too.
    expect(turn.usage).toMatchObject({ inputTokens: 450, hostedCalls: { web_search: 1 } });
    // Nothing to send back: grounding is not a part of the model's turn.
    expect(turn.message.hostedItems).toBeUndefined();
    expect(turn.message.toolCalls).toBeUndefined();
  });

  it("places a segment Google reported a byte off by its text, and drops a span that checks out nowhere", async () => {
    // A text said once places the citation even when its bytes are a byte off
    // (PydanticAI google.py:2379-2384).
    const unique = `Again: ${CLAIM}`;
    const start = bytes(ANSWER.slice(0, ANSWER.indexOf(unique)));
    const off = groundedTurn({ startIndex: start + 1, endIndex: bytes(ANSWER) + 1, text: unique });
    const placed = await collectTurn(
      provider(recorder(off).fetchImpl).createStream(HI, [], search),
    );
    const [citation] = placed.message.citations ?? [];
    expect(placed.message.content.slice(citation?.start, citation?.end)).toBe(unique);

    // The claim is said twice, so a byte off can't be placed: the span goes.
    const twice = groundedTurn({ ...secondClaim, startIndex: secondClaim.startIndex + 1 });
    const unplaced = await collectTurn(
      provider(recorder(twice).fetchImpl).createStream(HI, [], search),
    );
    expect(unplaced.message.citations).toEqual([
      { source: { type: "url", url: SOURCE_URL, title: "cats.example" } },
    ]);

    const nowhere = groundedTurn({ endIndex: 4, text: "words the answer never said" });
    const kept = await collectTurn(
      provider(recorder(nowhere).fetchImpl).createStream(HI, [], search),
    );
    expect(kept.message.citations).toEqual([
      { source: { type: "url", url: SOURCE_URL, title: "cats.example" } },
    ]);
  });

  it.each([false, true])("honors citation partIndex with streamed parts: %s", async (streamed) => {
    const claim = "Same 🐈 claim.";
    const call = { toolCall: { id: "s", toolType: "GOOGLE_SEARCH_WEB", args: { query: "cats" } } };
    const result = { toolResponse: { id: "s", toolType: "GOOGLE_SEARCH_WEB", response: {} } };
    const frames = streamed
      ? [
          candidate([{ text: claim.slice(0, 5) }]),
          candidate([{ text: claim.slice(5) }]),
          candidate([call, result, { text: claim.slice(0, 5) }]),
          candidate([{ text: claim.slice(5) }]),
        ]
      : [candidate([{ text: claim }, call, result, { text: claim }])];
    frames.push(
      j({
        candidates: [
          {
            finishReason: "STOP",
            groundingMetadata: {
              webSearchQueries: ["cats"],
              groundingChunks: [{ web: { uri: SOURCE_URL } }],
              groundingSupports: [
                {
                  segment: { partIndex: 3, startIndex: 0, endIndex: bytes(claim), text: claim },
                  groundingChunkIndices: [0],
                },
              ],
            },
          },
        ],
      }),
    );
    const turn = await collectTurn(
      provider(recorder(frames).fetchImpl).createStream(HI, [fn], search),
    );
    expect(turn.message.content).toBe(claim + claim);
    expect(turn.message.citations).toEqual([
      {
        source: { type: "url", url: SOURCE_URL },
        start: claim.length,
        end: claim.length * 2,
        anchor: "claim",
      },
    ]);
  });

  it.each([
    ["gemini-3-flash-preview", true, ["cats", "dogs", "cats", "", "  "], 2],
    ["gemini-4-pro", true, ["cats", "dogs", "cats"], 2],
    ["gemini-2.5-pro", true, ["cats", "dogs"], 1],
    ["gemini-2.5-pro", false, ["cats", "dogs"], 0],
    ["gemini-3-flash-preview", true, ["", "  "], 0],
  ] as const)(
    "counts billable searches on %s, web sources: %s, queries: %j",
    async (model, web, queries, count) => {
      const frames = [
        j({
          candidates: [
            {
              content: { parts: [{ text: "An answer." }] },
              finishReason: "STOP",
              groundingMetadata: {
                webSearchQueries: queries,
                groundingChunks: web ? [{ web: { uri: SOURCE_URL } }] : [],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
        }),
      ];
      const turn = await collectTurn(
        provider(recorder(frames).fetchImpl, { model }).createStream(HI, [], search),
      );
      // The one summary record is display data, not the number of billed queries.
      expect(turn.message.hostedCalls).toHaveLength(1);
      expect(turn.usage.hostedCalls?.web_search ?? 0).toBe(count);
      expect(
        costUsd(turn.usage, { input: 0, output: 0, cacheRead: 0, hosted: { web_search: 0.25 } }),
      ).toBe(count * 0.25);
    },
  );

  it.each([1, 2])(
    "fills %s explicit File Search calls without counting grounding again",
    async (count) => {
      // PydanticAI's Gemini 3 fixture returns empty FILE_SEARCH responses and
      // supplies the retrieved passages later, in grounding metadata.
      const frames = [
        candidate(
          Array.from({ length: count }, (_, index) => [
            {
              toolCall: {
                id: `file_${index}`,
                toolType: "FILE_SEARCH",
                args: { query: "Capital of France" },
              },
            },
            { toolResponse: { id: `file_${index}`, toolType: "FILE_SEARCH", response: {} } },
          ]).flat(),
        ),
        j({
          candidates: [
            {
              content: { parts: [{ text: "Paris." }] },
              finishReason: "STOP",
              groundingMetadata: {
                groundingChunks: [
                  { retrievedContext: { text: "Paris is the capital of France." } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        }),
      ];
      const turn = await collectTurn(
        provider(recorder(frames).fetchImpl).createStream(HI, [], {
          hostedTools: [{ type: "file_search", storeIds: ["fileSearchStores/geography"] }],
        }),
      );
      expect(turn.message.hostedCalls).toEqual(
        Array.from({ length: count }, (_, index) => ({
          id: `file_${index}`,
          type: "file_search",
          status: "completed",
          input: { query: "Capital of France" },
          output: { sources: [{ type: "file", excerpt: "Paris is the capital of France." }] },
          at: 0,
        })),
      );
      expect(turn.usage.hostedCalls).toEqual({ file_search: count });
      expect(
        costUsd(turn.usage, { input: 0, output: 0, cacheRead: 0, hosted: { file_search: 0.25 } }),
      ).toBe(count * 0.25);
    },
  );

  it.each([
    ['print(file_search.query(query="Capital of France"))\n', "Capital of France"],
    ["print(file_search.query(query='France\\'s capital'))\n", "France's capital"],
  ])("recognizes a Gemini 2.5 code-shaped File Search: %s", async (code, query) => {
    // Ported from PydanticAI's test_google_model_file_search_tool_stream.yaml
    // (MIT): there is no codeExecutionResult, only retrievedContext grounding.
    const frames = [
      candidate([{ executableCode: { language: "PYTHON", code } }]),
      j({
        candidates: [
          {
            content: { parts: [{ text: "Paris." }] },
            finishReason: "STOP",
            groundingMetadata: {
              groundingChunks: [{ retrievedContext: { text: "Paris is the capital of France." } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      }),
    ];
    const turn = await collectTurn(
      provider(recorder(frames).fetchImpl, { model: "gemini-2.5-pro" }).createStream(HI, [], {
        hostedTools: [{ type: "file_search", storeIds: ["fileSearchStores/geography"] }],
      }),
    );
    expect(turn.message.hostedCalls).toEqual([
      {
        id: "hosted_0",
        type: "file_search",
        status: "completed",
        input: { query },
        output: { sources: [{ type: "file", excerpt: "Paris is the capital of France." }] },
        at: 0,
      },
    ]);
    expect(turn.usage.hostedCalls).toEqual({ file_search: 1 });
    expect(turn.message.hostedItems?.items[0]).toEqual({
      executableCode: { language: "PYTHON", code },
    });
    expect(turn.finishReason).toBe("stop");
  });

  it("commits paid hosted work before validating a later function call in the same frame", async () => {
    const { seen, fetchImpl } = recorder([
      candidate([
        { executableCode: { language: "PYTHON", code: "print(34)" } },
        { codeExecutionResult: { outcome: "OUTCOME_OK", output: "34\\n" } },
        { functionCall: { id: "broken", args: {} } },
      ]),
    ]);
    const chunks: ProviderChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of withStreamRetry(
          (signal) =>
            withWatchdog(provider(fetchImpl)).createStream(HI, [fn], {
              hostedTools: [{ type: "code_execution" }],
              signal,
            }),
          { maxAttempts: 2, sleep: async () => {} },
        ))
          chunks.push(chunk);
      })(),
    ).rejects.toMatchObject({ kind: "overload" });
    expect(seen).toHaveLength(1);
    expect(chunks.flatMap((chunk) => chunk.hosted ?? [])).toMatchObject([
      { type: "code_execution", status: "running" },
      { status: "completed", output: { stdout: "34\\n" } },
    ]);
  });

  it("pairs each code run with its result, keeping a timed-out run as data", async () => {
    const code = [
      candidate([{ text: "Running it. " }]),
      candidate([
        { executableCode: { language: "PYTHON", code: "print(34)" } },
        { codeExecutionResult: { outcome: "OUTCOME_OK", output: "34\n" } },
        { executableCode: { language: "PYTHON", code: "while True: pass" } },
        { codeExecutionResult: { outcome: "OUTCOME_DEADLINE_EXCEEDED" } },
      ]),
      candidate([{ text: "Done." }], "STOP"),
    ];
    const turn = await collectTurn(
      provider(recorder(code).fetchImpl).createStream(HI, [], {
        hostedTools: [{ type: "code_execution" }],
      }),
    );
    expect(turn.message.hostedCalls).toEqual([
      {
        id: "hosted_0",
        type: "code_execution",
        status: "completed",
        input: { code: "print(34)", language: "python" },
        output: { stdout: "34\n" },
        at: 12,
      },
      {
        id: "hosted_1",
        type: "code_execution",
        status: "failed",
        input: { code: "while True: pass", language: "python" },
        error: "OUTCOME_DEADLINE_EXCEEDED",
        at: 12,
      },
    ]);
    expect(turn.finishReason).toBe("stop");
    // The parts go back as they came, with the text as lengths.
    expect(turn.message.hostedItems).toEqual({
      provider: "gemini",
      items: [
        { length: 12 },
        { executableCode: { language: "PYTHON", code: "print(34)" } },
        { codeExecutionResult: { outcome: "OUTCOME_OK", output: "34\n" } },
        { executableCode: { language: "PYTHON", code: "while True: pass" } },
        { codeExecutionResult: { outcome: "OUTCOME_DEADLINE_EXCEEDED" } },
        { length: 5 },
      ],
    });
    // …and only to the provider that made them.
    const history: ChatMessage[] = [...HI, turn.message, { role: "user", content: "thanks" }];
    expect(hosted.toGeminiContents(history, "gemini").contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "Running it. " },
        { executableCode: { language: "PYTHON", code: "print(34)" } },
        { codeExecutionResult: { outcome: "OUTCOME_OK", output: "34\n" } },
        { executableCode: { language: "PYTHON", code: "while True: pass" } },
        { codeExecutionResult: { outcome: "OUTCOME_DEADLINE_EXCEEDED" } },
        { text: "Done." },
      ],
    });
    expect(hosted.toGeminiContents(history, "zen").contents[1]).toEqual({
      role: "model",
      parts: [{ text: "Running it. Done." }],
    });
  });

  it("reads a server-side search beside a function call, and sends both back in order with their signatures", async () => {
    const mixed = [
      candidate([
        {
          toolCall: { id: "srv_1", toolType: "GOOGLE_SEARCH_WEB", args: { query: "cats" } },
          thoughtSignature: "sig_a",
        },
        {
          toolResponse: { id: "srv_1", toolType: "GOOGLE_SEARCH_WEB", response: { ok: true } },
          thoughtSignature: "sig_b",
        },
        { functionCall: { id: "call_1", name: "save", args: { n: 1 } }, thoughtSignature: "sig_c" },
      ]),
      candidate([], "STOP"),
    ];
    const turn = await collectTurn(
      provider(recorder(mixed).fetchImpl).createStream(HI, [fn], search),
    );
    expect(turn.message.hostedCalls).toEqual([
      { id: "srv_1", type: "web_search", status: "completed", input: { query: "cats" }, at: 0 },
    ]);
    expect(turn.message.toolCalls).toEqual([
      { id: "call_1", name: "save", arguments: '{"n":1}', thoughtSignature: "sig_c" },
    ]);
    // The function call makes it a tool round; the search does not.
    expect(turn.finishReason).toBe("tool_calls");
    const result: ChatMessage = { role: "tool", toolCallId: "call_1", name: "save", content: "ok" };
    const next = recorder(TEXT_TURN);
    await collect(
      provider(next.fetchImpl).createStream([...HI, turn.message, result], [fn], search),
    );
    expect((next.seen[0]!.body.contents as unknown[])[1]).toEqual({
      role: "model",
      parts: [
        {
          toolCall: { id: "srv_1", toolType: "GOOGLE_SEARCH_WEB", args: { query: "cats" } },
          thoughtSignature: "sig_a",
        },
        {
          toolResponse: { id: "srv_1", toolType: "GOOGLE_SEARCH_WEB", response: { ok: true } },
          thoughtSignature: "sig_b",
        },
        { functionCall: { id: "call_1", name: "save", args: { n: 1 } }, thoughtSignature: "sig_c" },
      ],
    });
  });

  it("reconciles URL-context results onto server calls without hiding failed pages", async () => {
    const blockedUrl = "https://paywall.example";
    const extraUrl = "https://other.example";
    const frames = [
      candidate([
        {
          toolCall: {
            id: "fetch",
            toolType: "URL_CONTEXT",
            args: { urls: [SOURCE_URL, blockedUrl] },
          },
        },
        { toolResponse: { id: "fetch", toolType: "URL_CONTEXT", response: {} } },
      ]),
      j({
        candidates: [
          {
            content: { parts: [{ text: "One page could not be read." }] },
            finishReason: "STOP",
            urlContextMetadata: {
              urlMetadata: [
                { retrievedUrl: SOURCE_URL, urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" },
                { retrievedUrl: blockedUrl, urlRetrievalStatus: "URL_RETRIEVAL_STATUS_PAYWALL" },
                { retrievedUrl: extraUrl, urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
      }),
    ];
    const turn = await collectTurn(
      provider(recorder(frames).fetchImpl).createStream(HI, [fn], {
        hostedTools: [{ type: "web_fetch" }],
      }),
    );
    expect(turn.message.hostedCalls).toEqual([
      {
        id: "fetch",
        type: "web_fetch",
        status: "failed",
        at: 0,
        input: { url: SOURCE_URL },
        output: { sources: [{ type: "url", url: SOURCE_URL }] },
        error: "URL_RETRIEVAL_STATUS_PAYWALL",
      },
      {
        id: "hosted_1",
        type: "web_fetch",
        status: "completed",
        at: 0,
        input: { url: extraUrl },
        output: { sources: [{ type: "url", url: extraUrl }] },
      },
    ]);
    expect(turn.usage.hostedCalls).toEqual({ web_fetch: 2 });
    expect(turn.finishReason).toBe("stop");
  });

  it("reads URL context as one fetch per page, a failed one as data", async () => {
    const fetched = [
      candidate([{ text: "It is about cats." }]),
      j({
        candidates: [
          {
            content: { parts: [] },
            finishReason: "STOP",
            urlContextMetadata: {
              urlMetadata: [
                { retrievedUrl: SOURCE_URL, urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" },
                {
                  retrievedUrl: "https://paywall.example",
                  urlRetrievalStatus: "URL_RETRIEVAL_STATUS_PAYWALL",
                },
              ],
            },
          },
        ],
      }),
    ];
    const turn = await collectTurn(
      provider(recorder(fetched).fetchImpl).createStream(HI, [], {
        hostedTools: [{ type: "web_fetch" }],
      }),
    );
    expect(turn.message.hostedCalls).toEqual([
      {
        id: "hosted_0",
        type: "web_fetch",
        status: "completed",
        input: { url: SOURCE_URL },
        output: { sources: [{ type: "url", url: SOURCE_URL }] },
        at: 0,
      },
      {
        id: "hosted_1",
        type: "web_fetch",
        status: "failed",
        input: { url: "https://paywall.example" },
        error: "URL_RETRIEVAL_STATUS_PAYWALL",
        at: 0,
      },
    ]);
  });
});
