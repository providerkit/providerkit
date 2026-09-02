// Golden transcripts: real SSE frame sequences replayed through each adapter,
// asserting the normalized chunks they must produce.
import { describe, expect, it } from "vitest";
import { createAnthropicProvider, toAnthropicMessages } from "../src/providers/anthropic.ts";
import { createOpenAIProvider, toOpenAIMessages } from "../src/providers/openai.ts";
import { ProviderError } from "../src/errors.ts";
import type { ChatMessage, ProviderChunk } from "../src/types.ts";

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

    expect(system).toBe("be brief");
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
