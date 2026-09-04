// Golden transcripts: real SSE frame sequences replayed through each adapter,
// asserting the normalized chunks they must produce.
import { describe, expect, it } from "vitest";
import { createAnthropicProvider, toAnthropicMessages } from "../src/providers/anthropic.ts";
import { createOpenAIProvider, effortParams, toOpenAIMessages } from "../src/providers/openai.ts";
import { ProviderError } from "../src/errors.ts";
import { EFFORTS, type ChatMessage, type Effort, type ProviderChunk } from "../src/types.ts";

/** Records the request and replays a canned SSE transcript. */
function recorder(frames: string[], status = 200) {
  const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      body: JSON.parse(init.body as string),
      headers: new Headers(init.headers),
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

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const j = (o: unknown) => JSON.stringify(o);

// ── Anthropic ─────────────────────────────────────────────────────────────

const ANTHROPIC_TEXT_TURN = [
  j({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
      },
    },
  }),
  j({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
  j({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }),
  j({ type: "content_block_delta", delta: { type: "text_delta", text: " there" } }),
  j({ type: "content_block_stop", index: 0 }),
  j({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }),
  j({ type: "message_stop" }),
];

describe("anthropic adapter", () => {
  it("streams text deltas and a finish reason", async () => {
    const { fetchImpl } = recorder(ANTHROPIC_TEXT_TURN);
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl });
    const chunks = await collect(provider.createStream([{ role: "user", content: "hi" }], []));

    expect(chunks.filter((c) => c.content).map((c) => c.content)).toEqual(["Hello", " there"]);
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("stop");
  });

  it("reconciles usage — input_tokens EXCLUDES cache on this shape", async () => {
    // 100 fresh + 900 read + 50 written = 1050 tokens the turn actually billed.
    // Reporting 100 would understate the prompt tenfold and break compaction.
    const { fetchImpl } = recorder(ANTHROPIC_TEXT_TURN);
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl });
    const chunks = await collect(provider.createStream([{ role: "user", content: "hi" }], []));

    expect(chunks.find((c) => c.type === "usage")?.usage).toEqual({
      inputTokens: 1_050,
      cachedInputTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 12,
    });
  });

  it("maps thinking deltas to reasoning", async () => {
    const { fetchImpl } = recorder([
      j({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      j({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }),
      j({ type: "message_stop" }),
    ]);
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl });
    const chunks = await collect(provider.createStream([{ role: "user", content: "hi" }], []));
    expect(chunks.find((c) => c.reasoning)?.reasoning).toBe("hmm");
  });

  it("assembles a tool call from its block and json fragments", async () => {
    const { fetchImpl } = recorder([
      j({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "search" },
      }),
      j({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"q":' },
      }),
      j({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '"cats"}' },
      }),
      j({ type: "content_block_stop", index: 0 }),
      j({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
      j({ type: "message_stop" }),
    ]);
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl });
    const chunks = await collect(provider.createStream([{ role: "user", content: "hi" }], []));

    const calls = chunks.flatMap((c) => c.toolCalls ?? []);
    expect(calls[0]).toMatchObject({ index: 0, id: "toolu_1", name: "search" });
    expect(calls.map((c) => c.arguments ?? "").join("")).toBe('{"q":"cats"}');
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("tool_calls");
  });

  it("turns a mid-stream error event into a ProviderError", async () => {
    const { fetchImpl } = recorder([
      j({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    ]);
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl });
    await expect(
      collect(provider.createStream([{ role: "user", content: "hi" }], [])),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("sends x-api-key by default and a Bearer when asked", async () => {
    const key = recorder(ANTHROPIC_TEXT_TURN);
    await collect(
      createAnthropicProvider({
        apiKey: "sk-1",
        model: "m",
        fetchImpl: key.fetchImpl,
      }).createStream([{ role: "user", content: "hi" }], []),
    );
    expect(key.seen[0]!.headers.get("x-api-key")).toBe("sk-1");

    const bearer = recorder(ANTHROPIC_TEXT_TURN);
    await collect(
      createAnthropicProvider({
        apiKey: "tok",
        model: "m",
        bearer: true,
        fetchImpl: bearer.fetchImpl,
      }).createStream([{ role: "user", content: "hi" }], []),
    );
    expect(bearer.seen[0]!.headers.get("authorization")).toBe("Bearer tok");
  });

  it("keeps the thinking budget below max_tokens — they share the ceiling", async () => {
    // A budget at or above the ceiling leaves no room to answer, and the turn
    // ends mid-thought.
    const { seen, fetchImpl } = recorder(ANTHROPIC_TEXT_TURN);
    await collect(
      createAnthropicProvider({
        apiKey: "k",
        model: "m",
        maxTokens: 4_000,
        effort: "max",
        fetchImpl,
      }).createStream([{ role: "user", content: "hi" }], []),
    );
    const thinking = seen[0]!.body.thinking as { budget_tokens: number };
    expect(thinking.budget_tokens).toBeLessThan(4_000);
  });

  it("sends no thinking block at effort none, and always a max_tokens", async () => {
    const { seen, fetchImpl } = recorder(ANTHROPIC_TEXT_TURN);
    await collect(
      createAnthropicProvider({ apiKey: "k", model: "m", effort: "none", fetchImpl }).createStream(
        [{ role: "user", content: "hi" }],
        [],
      ),
    );
    expect(seen[0]!.body.thinking).toBeUndefined();
    expect(seen[0]!.body.max_tokens).toBeGreaterThan(0);
  });
});

describe("toAnthropicMessages", () => {
  it("lifts system out and merges consecutive tool results into one user turn", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "search twice" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "s", arguments: "{}" },
          { id: "b", name: "s", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "a", name: "s", content: "one" },
      { role: "tool", toolCallId: "b", name: "s", content: "two" },
    ];
    const { system, messages: out } = toAnthropicMessages(messages);

    // One cached block, not a bare string: Anthropic's caching is opt-in per
    // block, and this is the largest stable prefix an agent loop re-sends every
    // turn. A plain string here bills the whole system prompt at the full input
    // rate on every round, forever, and nothing fails to say so.
    expect(system).toEqual([
      { type: "text", text: "be brief", cache_control: { type: "ephemeral" } },
    ]);
    // The API requires the two results in a single user turn.
    const roles = (out as { role: string }[]).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    expect((out[2] as { content: unknown[] }).content).toHaveLength(2);
  });

  it("does NOT replay reasoning — the blocks need signatures we never captured", () => {
    const { messages } = toAnthropicMessages([
      { role: "assistant", content: "hi", reasoning: "secret thoughts" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("secret thoughts");
  });
});

// ── OpenAI shape ──────────────────────────────────────────────────────────

const OPENAI_TEXT_TURN = [
  j({ choices: [{ delta: { content: "Hel" } }] }),
  j({ choices: [{ delta: { content: "lo" } }] }),
  j({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  j({
    choices: [],
    usage: {
      prompt_tokens: 1_000,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 800 },
    },
  }),
];

describe("openai-shape adapter", () => {
  it("streams content deltas and a finish reason", async () => {
    const { fetchImpl } = recorder(OPENAI_TEXT_TURN);
    const provider = createOpenAIProvider({ apiKey: "k", model: "gpt-5.6", fetchImpl });
    const chunks = await collect(provider.createStream([{ role: "user", content: "hi" }], []));
    expect(chunks.filter((c) => c.content).map((c) => c.content)).toEqual(["Hel", "lo"]);
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("stop");
  });

  it("takes cached_tokens as a SUBSET — no reconciling on this shape", async () => {
    const { fetchImpl } = recorder(OPENAI_TEXT_TURN);
    const provider = createOpenAIProvider({ apiKey: "k", model: "gpt-5.6", fetchImpl });
    const chunks = await collect(provider.createStream([{ role: "user", content: "hi" }], []));
    expect(chunks.find((c) => c.type === "usage")?.usage).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 20,
    });
  });

  it("always asks for usage — without it every call silently costs zero", async () => {
    const { seen, fetchImpl } = recorder(OPENAI_TEXT_TURN);
    await collect(
      createOpenAIProvider({ apiKey: "k", model: "m", fetchImpl }).createStream(
        [{ role: "user", content: "hi" }],
        [],
      ),
    );
    expect(seen[0]!.body.stream_options).toEqual({ include_usage: true });
  });

  it("maps both reasoning field names to the same thing", async () => {
    const { fetchImpl } = recorder([
      j({ choices: [{ delta: { reasoning_content: "deepseek says" } }] }),
      j({ choices: [{ delta: { reasoning: "openrouter says" } }] }),
    ]);
    const provider = createOpenAIProvider({ apiKey: "k", model: "m", fetchImpl });
    const chunks = await collect(provider.createStream([{ role: "user", content: "hi" }], []));
    expect(chunks.map((c) => c.reasoning)).toEqual(["deepseek says", "openrouter says"]);
  });

  it("assembles fragmented tool calls, defaulting an omitted index", async () => {
    // Several gateways omit `index` on single-tool turns.
    const { fetchImpl } = recorder([
      j({
        choices: [
          {
            delta: { tool_calls: [{ id: "call_1", function: { name: "search", arguments: "" } }] },
          },
        ],
      }),
      j({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"q":"x"}' } }] } }] }),
      j({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    const provider = createOpenAIProvider({ apiKey: "k", model: "m", fetchImpl });
    const chunks = await collect(provider.createStream([{ role: "user", content: "hi" }], []));

    const calls = chunks.flatMap((c) => c.toolCalls ?? []);
    expect(calls.every((c) => c.index === 0)).toBe(true);
    expect(calls.map((c) => c.arguments ?? "").join("")).toBe('{"q":"x"}');
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("tool_calls");
  });

  it("sends the OpenRouter route pin only when asked", async () => {
    const pinned = recorder(OPENAI_TEXT_TURN);
    await collect(
      createOpenAIProvider({
        apiKey: "k",
        model: "m",
        providerOrder: ["deepinfra"],
        fetchImpl: pinned.fetchImpl,
      }).createStream([{ role: "user", content: "hi" }], []),
    );
    expect(pinned.seen[0]!.body.provider).toEqual({
      order: ["deepinfra"],
      allow_fallbacks: true,
    });

    const plain = recorder(OPENAI_TEXT_TURN);
    await collect(
      createOpenAIProvider({ apiKey: "k", model: "m", fetchImpl: plain.fetchImpl }).createStream(
        [{ role: "user", content: "hi" }],
        [],
      ),
    );
    expect(plain.seen[0]!.body.provider).toBeUndefined();
  });

  it("sends NO routing block without a pin — never an empty order array", async () => {
    // An empty `order` on the wire is not "no preference", it is a preference
    // for nothing, and nothing above the adapter can see the difference: one
    // reads as default routing and the other as wrong routing.
    for (const providerOrder of [undefined, []]) {
      const { seen, fetchImpl } = recorder([j({ choices: [] })]);
      await collect(
        createOpenAIProvider({
          apiKey: "k",
          model: "m",
          id: "openrouter",
          fetchImpl,
          ...(providerOrder ? { providerOrder } : {}),
        }).createStream([{ role: "user", content: "hi" }], []),
      );
      expect(seen[0]!.body).not.toHaveProperty("provider");
    }
  });

  it("surfaces a non-2xx through the shared classifier", async () => {
    const { fetchImpl } = recorder([], 429);
    const provider = createOpenAIProvider({ apiKey: "k", model: "m", fetchImpl });
    await expect(
      collect(provider.createStream([{ role: "user", content: "hi" }], [])),
    ).rejects.toMatchObject({ kind: "rate" });
  });
});

describe("toOpenAIMessages", () => {
  it("sends '' rather than null beside tool_calls — several gateways reject null", () => {
    const [message] = toOpenAIMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "s", arguments: "{}" }] },
    ]) as Record<string, unknown>[];
    expect(message!.content).toBe("");
    expect(message!.tool_calls).toHaveLength(1);
  });

  it("replays reasoning_content when the history carries it", () => {
    const [message] = toOpenAIMessages([
      { role: "assistant", content: "hi", reasoning: "because" },
    ]) as Record<string, unknown>[];
    expect(message!.reasoning_content).toBe("because");
  });

  it("carries images as data URIs", () => {
    const [message] = toOpenAIMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", mimeType: "image/png", data: "AAA" },
        ],
      },
    ]) as Record<string, unknown>[];
    const parts = message!.content as { type: string; image_url?: { url: string } }[];
    expect(parts[1]!.image_url!.url).toBe("data:image/png;base64,AAA");
  });
});

describe("effortParams", () => {
  // One knob, three incompatible spellings. The contract behind a silent
  // production failure: GLM 5.3 Flash through OpenRouter answers
  // 400 "Reasoning is mandatory for this endpoint and cannot be disabled."
  // `none` is a legal effort everywhere else, so nothing above the wire can
  // see it — these are that check.
  it("never asks OpenRouter to switch reasoning off", () => {
    for (const effort of EFFORTS) {
      expect(JSON.stringify(effortParams("openrouter", effort))).not.toContain("disabled");
      expect(effortParams("openrouter", effort)).not.toHaveProperty("reasoning.enabled");
    }
  });

  it("floors OpenRouter's `none` at `low` and clamps `max` to `high`", () => {
    expect(effortParams("openrouter", "none")).toEqual({ reasoning: { effort: "low" } });
    expect(effortParams("openrouter", "max")).toEqual({ reasoning: { effort: "high" } });
  });

  it("keeps the real off switch where a model has one — DeepSeek defaults ON", () => {
    expect(effortParams("deepseek", "none")).toEqual({ thinking: { type: "disabled" } });
    expect(effortParams("deepseek", "medium")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "medium",
    });
  });

  it("sends OpenAI reasoning_effort, and nothing for none", () => {
    expect(effortParams("openai", "high")).toEqual({ reasoning_effort: "high" });
    expect(effortParams("openai", "none")).toEqual({});
    expect(effortParams("off", "high")).toEqual({});
  });

  it("sends nothing at all when the caller never asked", () => {
    // Absent is not `none`: a knob the caller never touched stays the
    // provider's, which is why OpenRouter's floor does not fire here.
    for (const dialect of ["openai", "openrouter", "deepseek", "off"] as const) {
      expect(effortParams(dialect, undefined)).toEqual({});
    }
  });

  it("picks the dialect from the provider id, over the wire", async () => {
    const seen = async (id: string, effort: Effort) => {
      const { seen: calls, fetchImpl } = recorder([j({ choices: [] })]);
      await collect(
        createOpenAIProvider({ apiKey: "k", model: "m", id, fetchImpl }).createStream(
          [{ role: "user", content: "hi" }],
          [],
          { effort },
        ),
      );
      return calls[0]!.body;
    };
    expect(await seen("openrouter", "none")).toMatchObject({ reasoning: { effort: "low" } });
    expect(await seen("deepseek", "none")).toMatchObject({ thinking: { type: "disabled" } });
    expect(await seen("kimi", "high")).toMatchObject({ reasoning_effort: "high" });
  });
});

describe("cached-token spellings", () => {
  it("reads DeepSeek's own field as well as the standard one", async () => {
    // Absent from every OpenAI SDK usage type, so nothing catches it but this.
    // Read only the standard name and a cached token bills at the full input
    // rate — on an agent loop that is most of the prompt, every round.
    const usage = async (record: Record<string, unknown>) => {
      const { fetchImpl } = recorder([j({ choices: [], usage: record })]);
      const chunks = await collect(
        createOpenAIProvider({ apiKey: "k", model: "m", fetchImpl }).createStream(
          [{ role: "user", content: "hi" }],
          [],
        ),
      );
      return chunks.find((c) => c.type === "usage")?.usage;
    };
    expect(
      await usage({ prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 900 }),
    ).toMatchObject({ inputTokens: 1000, cachedInputTokens: 900 });
    expect(
      await usage({
        prompt_tokens: 1000,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 700 },
      }),
    ).toMatchObject({ cachedInputTokens: 700 });
    expect(await usage({ prompt_tokens: 10, completion_tokens: 5 })).toMatchObject({
      cachedInputTokens: 0,
    });
  });
});

describe("what the OpenAI dialect cannot carry", () => {
  it("follows a tool's images with a user message — the tool role has no image slot", async () => {
    // Dropped instead, the turn reads as a tool that returned words about a
    // picture nobody was shown, and nothing anywhere reports a loss.
    const out = toOpenAIMessages([
      {
        role: "tool",
        toolCallId: "call_1",
        name: "screenshot",
        content: "captured",
        images: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
      },
    ]);
    expect(out).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "captured" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
      },
    ]);
  });

  it("asks for schema enforcement only where it exists, JSON mode everywhere else", async () => {
    // Schema enforcement is OpenAI's; the gateways offer JSON mode at best and
    // several answer a flat 400 to a `json_schema` block. The caller validates
    // either way, so this only decides whether the request is accepted at all.
    const format = async (id: string, jsonMode?: "schema" | "object") => {
      const { seen, fetchImpl } = recorder([j({ choices: [] })]);
      await collect(
        createOpenAIProvider({
          apiKey: "k",
          model: "m",
          id,
          fetchImpl,
          ...(jsonMode ? { jsonMode } : {}),
        }).createStream([{ role: "user", content: "hi" }], [], {
          json: { name: "out", schema: { type: "object" } },
        }),
      );
      return seen[0]!.body.response_format;
    };
    expect(await format("openai")).toMatchObject({ type: "json_schema" });
    expect(await format("deepseek")).toEqual({ type: "json_object" });
    expect(await format("openrouter")).toEqual({ type: "json_object" });
    // The override, for a gateway that does enforce schemas.
    expect(await format("my-gateway", "schema")).toMatchObject({ type: "json_schema" });
  });
});
