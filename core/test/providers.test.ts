// Golden transcripts: real SSE frame sequences replayed through each adapter,
// asserting the normalized chunks they must produce.
import { describe, expect, it } from "vitest";
import { createAnthropicProvider, toAnthropicMessages } from "../src/providers/anthropic.ts";
import { createOpenAIProvider, effortParams, toOpenAIMessages } from "../src/providers/openai.ts";
import { createPresetProvider } from "../src/providers/factory.ts";
import { ProviderError } from "../src/errors.ts";
import {
  EFFORTS,
  stripReasoning,
  type ChatMessage,
  type Effort,
  type ProviderChunk,
} from "../src/types.ts";

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

  it("serves any endpoint speaking the dialect — a base url, a Bearer and gateway headers", async () => {
    // This adapter is not "the Anthropic one". Most 2026 vendors publish an
    // Anthropic-dialect endpoint beside their OpenAI-dialect one, and the
    // dialect is the only thing that decides which adapter to use. What varies
    // between them is exactly three fields, so all three are pinned together:
    // the host, where the credential rides (these gateways read Bearer, not
    // x-api-key), and whatever header the gateway wants for itself.
    const { seen, fetchImpl } = recorder(ANTHROPIC_TEXT_TURN);
    await collect(
      createAnthropicProvider({
        apiKey: "sk-or-1",
        model: "glm-5",
        baseUrl: "https://openrouter.ai/api",
        bearer: true,
        headers: { "http-referer": "https://example.test" },
        fetchImpl,
      }).createStream([{ role: "user", content: "hi" }], []),
    );
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/v1/messages");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer sk-or-1");
    expect(seen[0]!.headers.get("x-api-key")).toBeNull();
    expect(seen[0]!.headers.get("http-referer")).toBe("https://example.test");
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

  it("serves any endpoint speaking the dialect — a base url and gateway headers", async () => {
    // The sibling of the Anthropic-shape test above. Same package, same two
    // fields, and a trailing slash on the base url must not double the one
    // `apiUrl` adds — a `//v1/chat/completions` is a 404 on most gateways.
    const { seen, fetchImpl } = recorder(OPENAI_TEXT_TURN);
    await collect(
      createOpenAIProvider({
        apiKey: "sk-or-1",
        model: "glm-5",
        baseUrl: "https://openrouter.ai/api/",
        headers: { "http-referer": "https://example.test" },
        fetchImpl,
      }).createStream([{ role: "user", content: "hi" }], []),
    );
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer sk-or-1");
    expect(seen[0]!.headers.get("http-referer")).toBe("https://example.test");
  });

  describe("app attribution (OpenRouter)", () => {
    it("sends HTTP-Referer and X-Title from siteUrl/siteName on the OpenAI shape", async () => {
      const { seen, fetchImpl } = recorder(OPENAI_TEXT_TURN);
      await collect(
        createOpenAIProvider({
          apiKey: "sk-or-1",
          model: "glm-5",
          baseUrl: "https://openrouter.ai/api",
          siteUrl: "https://example.test",
          siteName: "Example",
          fetchImpl,
        }).createStream([{ role: "user", content: "hi" }], []),
      );
      expect(seen[0]!.headers.get("http-referer")).toBe("https://example.test");
      expect(seen[0]!.headers.get("x-title")).toBe("Example");
    });

    it("sends HTTP-Referer and X-Title from siteUrl/siteName on the Anthropic shape", async () => {
      const { seen, fetchImpl } = recorder(ANTHROPIC_TEXT_TURN);
      await collect(
        createAnthropicProvider({
          apiKey: "sk-or-1",
          model: "glm-5",
          baseUrl: "https://openrouter.ai/api",
          bearer: true,
          siteUrl: "https://example.test",
          siteName: "Example",
          fetchImpl,
        }).createStream([{ role: "user", content: "hi" }], []),
      );
      expect(seen[0]!.headers.get("http-referer")).toBe("https://example.test");
      expect(seen[0]!.headers.get("x-title")).toBe("Example");
    });

    it("sends nothing when no app is named", async () => {
      const { seen, fetchImpl } = recorder(OPENAI_TEXT_TURN);
      await collect(
        createOpenAIProvider({
          apiKey: "sk-or-1",
          model: "glm-5",
          baseUrl: "https://openrouter.ai/api",
          fetchImpl,
        }).createStream([{ role: "user", content: "hi" }], []),
      );
      expect(seen[0]!.headers.get("http-referer")).toBeNull();
      expect(seen[0]!.headers.get("x-title")).toBeNull();
    });

    it("an explicit headers entry wins over siteUrl/siteName, case-insensitively", async () => {
      const { seen, fetchImpl } = recorder(OPENAI_TEXT_TURN);
      await collect(
        createOpenAIProvider({
          apiKey: "sk-or-1",
          model: "glm-5",
          baseUrl: "https://openrouter.ai/api",
          siteUrl: "https://example.test",
          siteName: "Example",
          headers: { "http-referer": "https://override.test", "X-Title": "Override" },
          fetchImpl,
        }).createStream([{ role: "user", content: "hi" }], []),
      );
      expect(seen[0]!.headers.get("http-referer")).toBe("https://override.test");
      expect(seen[0]!.headers.get("x-title")).toBe("Override");
    });

    it("an explicit X-OpenRouter-Title suppresses the default X-Title", async () => {
      const { seen, fetchImpl } = recorder(OPENAI_TEXT_TURN);
      await collect(
        createOpenAIProvider({
          apiKey: "sk-or-1",
          model: "glm-5",
          baseUrl: "https://openrouter.ai/api",
          siteName: "Example",
          headers: { "X-OpenRouter-Title": "Alias" },
          fetchImpl,
        }).createStream([{ role: "user", content: "hi" }], []),
      );
      expect(seen[0]!.headers.get("x-title")).toBeNull();
      expect(seen[0]!.headers.get("x-openrouter-title")).toBe("Alias");
    });
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

  it("auto-pins OpenRouter calls to the first-party vendor host for prompt caching", async () => {
    const autoPinned = recorder(OPENAI_TEXT_TURN);
    await collect(
      createOpenAIProvider({
        apiKey: "k",
        model: "z-ai/glm-5.3-flash",
        baseUrl: "https://openrouter.ai/api/v1",
        fetchImpl: autoPinned.fetchImpl,
      }).createStream([{ role: "user", content: "hi" }], []),
    );
    expect(autoPinned.seen[0]!.body.provider).toEqual({
      order: ["z-ai"],
      allow_fallbacks: true,
    });
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

  it("sends nothing for none — the absent field IS GLM's off switch — and names low/high/max verbatim", () => {
    // Not setting `reasoning` at all disables thinking for GLM 5.3 Flash
    // (measured live 2026-09-14), so `none` omits the field rather than naming
    // a level: the model answers 400 "Reasoning is mandatory" to
    // `reasoning.effort: "none"` exactly as to `reasoning.enabled: false`.
    // The 400 that once looked like "OpenRouter cannot be told not to think"
    // was `reasoning.enabled: false`, a different field — which the test above
    // pins as never sent.
    expect(effortParams("openrouter", "none")).toEqual({});
    // Naming a level raises it; low/high/max ride as asked (`max` verbatim —
    // measured accepted on the live endpoint).
    expect(effortParams("openrouter", "max")).toEqual({ reasoning: { effort: "max" } });
    expect(effortParams("openrouter", "high")).toEqual({ reasoning: { effort: "high" } });
    expect(effortParams("openrouter", "low")).toEqual({ reasoning: { effort: "low" } });
  });

  it("keeps the real off switch where a model has one — DeepSeek defaults ON", () => {
    expect(effortParams("deepseek", "none")).toEqual({ thinking: { type: "disabled" } });
    expect(effortParams("deepseek", "medium")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "medium",
    });
  });

  it("never caps DeepSeek at the top — it auto-bumps the turns that need it", () => {
    // A graded level rides only when it asks for LESS. DeepSeek pushes a complex
    // agent or tool request past its own default, and naming the top tier caps
    // exactly those turns. `max` clamps to `high` first, so both land here.
    expect(effortParams("deepseek", "high")).toEqual({ thinking: { type: "enabled" } });
    expect(effortParams("deepseek", "max")).toEqual({ thinking: { type: "enabled" } });
  });

  it("names OpenAI's own off switch — `none` is a value, not an omission", () => {
    expect(effortParams("openai", "high")).toEqual({ reasoning_effort: "high" });
    // Sending nothing is not "do not think": GPT-5.1 defaults to `none`, but
    // gpt-5 and everything before it defaults to `medium`, and those tokens
    // come out of the answer's budget.
    expect(effortParams("openai", "none")).toEqual({ reasoning_effort: "none" });
    expect(effortParams("off", "high")).toEqual({});
  });

  it("sends nothing at all when the caller never asked", () => {
    // Absent is not `none` — except on OpenRouter, where GLM's off switch IS
    // the absent field, so the two are the same request by design there.
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
    expect(await seen("openrouter", "none")).not.toHaveProperty("reasoning");
    expect(await seen("openrouter", "low")).toMatchObject({ reasoning: { effort: "low" } });
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

describe("provider-reported cost", () => {
  // OpenRouter's usage record, shaped as its API reference prints it. `cost` is
  // what the call was billed, in USD; one model id is served by many hosts at
  // different rates, so this number is the only one that knows which answered.
  const OPENROUTER_USAGE = {
    prompt_tokens: 1_200,
    completion_tokens: 40,
    total_tokens: 1_240,
    cost: 0.000196,
    is_byok: false,
    prompt_tokens_details: { cached_tokens: 1_000, audio_tokens: 0 },
    cost_details: {
      upstream_inference_cost: null,
      upstream_inference_prompt_cost: 0.000176,
      upstream_inference_completions_cost: 0.00002,
    },
    completion_tokens_details: { reasoning_tokens: 0 },
  };

  const usageFrom = async (
    record: Record<string, unknown>,
    baseUrl = "https://openrouter.ai/api",
  ) => {
    const { fetchImpl } = recorder([j({ choices: [], usage: record })]);
    const chunks = await collect(
      createOpenAIProvider({ apiKey: "k", model: "m", baseUrl, fetchImpl }).createStream(
        [{ role: "user", content: "hi" }],
        [],
      ),
    );
    return chunks.find((c) => c.type === "usage")?.usage;
  };

  it("reads the cost off the last frame of a streamed OpenRouter turn", async () => {
    // The wire as OpenRouter sends it: a keep-alive comment first, the usage
    // record on the final frame beside an empty choice, then `[DONE]`, and
    // reads that end mid-frame.
    const frame = (o: unknown) => `data: ${j(o)}\n\n`;
    const body = [
      ": OPENROUTER PROCESSING\n\n",
      frame({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] }),
      frame({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] }),
      frame({
        choices: [{ index: 0, delta: { content: "" }, finish_reason: null }],
        usage: OPENROUTER_USAGE,
      }),
      "data: [DONE]\n\n",
    ].join("");
    const bytes = new TextEncoder().encode(body);
    const cuts = [0, 7, Math.floor(bytes.length / 2), bytes.length - 20, bytes.length];
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < cuts.length - 1; i += 1) {
              controller.enqueue(bytes.slice(cuts[i], cuts[i + 1]));
            }
            controller.close();
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const chunks = await collect(
      createPresetProvider("openrouter", {
        apiKey: "k",
        model: "z-ai/glm-5.3-flash",
        fetchImpl,
      }).createStream([{ role: "user", content: "hi" }], []),
    );
    expect(chunks.filter((c) => c.content).map((c) => c.content)).toEqual(["Hi"]);
    expect(chunks.filter((c) => c.type === "usage").map((c) => c.usage)).toEqual([
      {
        inputTokens: 1_200,
        cachedInputTokens: 1_000,
        outputTokens: 40,
        reportedCostUsd: 0.000196,
      },
    ]);
  });

  it("reads a free call as 0, not as a missing cost", async () => {
    // A `:free` model bills nothing. Read as "no cost reported", the caller's
    // rate would price it as if it had been paid for.
    expect(await usageFrom({ ...OPENROUTER_USAGE, cost: 0 })).toMatchObject({
      reportedCostUsd: 0,
    });
  });

  it("does not trust a cost it cannot read as money", async () => {
    // A malformed field falls back to the caller's rate rather than billing
    // a nonsense number.
    for (const cost of [-0.01, "0.0002", null, undefined]) {
      expect(await usageFrom({ ...OPENROUTER_USAGE, cost })).not.toHaveProperty("reportedCostUsd");
    }
  });

  it("adds the upstream bill on a bring-your-own-key call", async () => {
    // With the caller's own provider key, `cost` is only OpenRouter's fee and
    // the inference itself is billed to that provider account. Taking `cost`
    // alone would under-report the call many times over.
    expect(
      await usageFrom({
        ...OPENROUTER_USAGE,
        is_byok: true,
        cost: 0.00001,
        cost_details: { upstream_inference_cost: 0.0002 },
      }),
    ).toMatchObject({ reportedCostUsd: 0.00021 });
    // No upstream figure means no full cost to report — the rate prices it.
    expect(
      await usageFrom({ ...OPENROUTER_USAGE, is_byok: true, cost_details: null }),
    ).not.toHaveProperty("reportedCostUsd");
  });

  it("reads no cost from an endpoint that is not OpenRouter", async () => {
    // `usage.cost` is OpenRouter's field, in OpenRouter's unit. Another
    // gateway that happens to send one has not told us what it means.
    expect(await usageFrom(OPENROUTER_USAGE, "https://api.deepseek.com")).toEqual({
      inputTokens: 1_200,
      cachedInputTokens: 1_000,
      outputTokens: 40,
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

  it("puts the schema in the prompt wherever it cannot be enforced", async () => {
    // `json_object` asks for valid JSON and says NOTHING about its shape, so on
    // its own it honours half of `opts.json`: the model returns syntactically
    // perfect JSON of a shape nobody asked for, and the caller's parse fails on
    // the happy path where no retry looks and no error is recorded. The seam
    // promises the schema reaches the model either way — the Anthropic adapter
    // has always kept that promise; this dialect did not.
    const body = async (id: string) => {
      const { seen, fetchImpl } = recorder([j({ choices: [] })]);
      await collect(
        createOpenAIProvider({ apiKey: "k", model: "m", id, fetchImpl }).createStream(
          [
            { role: "system", content: "be brief" },
            { role: "user", content: "hi" },
          ],
          [],
          { json: { name: "out", schema: { type: "object", properties: { hrn: {} } } } },
        ),
      );
      return seen[0]!.body.messages as { role: string; content: string }[];
    };

    const gateway = await body("deepseek");
    expect(JSON.stringify(gateway)).toContain("hrn");
    // Appended, never folded into the system prompt: the cache on this shape is
    // a PREFIX cache, so a per-call schema up front would invalidate the whole
    // conversation behind it every time the schema changed.
    expect(gateway[0]).toEqual({ role: "system", content: "be brief" });
    expect(gateway[gateway.length - 1]!.role).toBe("system");

    // Where the schema IS enforced it rides in response_format alone — no
    // second copy burning input tokens on every call.
    const enforced = await body("openai");
    expect(JSON.stringify(enforced)).not.toContain("hrn");
  });

  it("clears the response format off tool calls when the caller asks for it", async () => {
    // A pinned decoder cannot emit a tool call, and the models it happens to do
    // not report it — they narrate the call ("let me look that up") and the turn
    // ends. Measured 2026-09-07: z-ai/glm-5.3-flash 0/10 tool calls under a
    // response format, 8/8 without one. It stays a setting because the opposite
    // is just as real: qwen3.8-flash went 6/6 → 1/6 the same way.
    const tool = { name: "search", description: "look it up", inputSchema: { type: "object" } };
    const sent = async (jsonWithTools?: "response_format" | "prompt", withTools = true) => {
      const { seen, fetchImpl } = recorder([j({ choices: [] })]);
      await collect(
        createOpenAIProvider({
          apiKey: "k",
          model: "m",
          id: "openrouter",
          fetchImpl,
          ...(jsonWithTools ? { jsonWithTools } : {}),
        }).createStream([{ role: "user", content: "hi" }], withTools ? [tool] : [], {
          json: { name: "out", schema: { type: "object", properties: { hrn: {} } } },
        }),
      );
      const body = seen[0]!.body as { response_format?: unknown; messages: { role: string }[] };
      return { format: body.response_format, messages: body.messages };
    };

    const carried = await sent("prompt");
    expect(carried.format).toBeUndefined();
    // The schema still reaches the model — the one way nothing can suppress.
    expect(JSON.stringify(carried.messages)).toContain("hrn");
    expect(carried.messages[carried.messages.length - 1]!.role).toBe("system");

    // Only the calls that carry tools change. A call without them has no bet to
    // lose, and the format is strictly better than the prompt.
    expect((await sent("prompt", false)).format).toEqual({ type: "json_object" });

    // Unset is the shape every caller had before, tools or not.
    expect((await sent(undefined)).format).toEqual({ type: "json_object" });
  });
});

describe("reasoning that must ride back", () => {
  it("carries OpenRouter's reasoning_details out of the stream and back in", async () => {
    // Opaque on purpose — the same contract as Gemini's thoughtSignature. It is
    // the provider's own record of how it reached the tool round it is being
    // asked to continue; reshaped or dropped, that continuity is gone and
    // nothing reports it.
    const details = [{ type: "reasoning.text", text: "…", signature: "abc" }];
    const { fetchImpl } = recorder([
      j({ choices: [{ delta: { reasoning_details: details }, finish_reason: null }] }),
    ]);
    const chunks = await collect(
      createOpenAIProvider({ apiKey: "k", model: "m", id: "openrouter", fetchImpl }).createStream(
        [{ role: "user", content: "hi" }],
        [],
      ),
    );
    expect(chunks[0]?.reasoningDetails).toEqual(details);

    expect(
      toOpenAIMessages([{ role: "assistant", content: "ok", reasoningDetails: details }]),
    ).toEqual([{ role: "assistant", content: "ok", reasoning_details: details }]);
  });

  it("strips it for a thinking-OFF turn, like the text half", () => {
    const stripped = stripReasoning([
      { role: "assistant", content: "ok", reasoning: "why", reasoningDetails: [{ a: 1 }] },
    ]);
    expect(stripped[0]).toEqual({ role: "assistant", content: "ok" });
  });
});

// ── what the fifth migration found ────────────────────────────────────────
describe("the schema reaches a provider with no schema mode", () => {
  const schema = {
    type: "object" as const,
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  };

  // It went out carrying nothing at all: the model answered in prose, the
  // caller's JSON.parse threw, and the turn failed on the happy path.
  it("puts the schema in Anthropic's system prompt", async () => {
    const { seen, fetchImpl } = recorder([JSON.stringify({ type: "message_stop" })]);
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude", fetchImpl });
    await collect(
      provider.createStream([{ role: "system", content: "You are terse." }], [], {
        json: { name: "out", schema },
      }),
    ).catch(() => undefined);

    const system = seen[0].body.system as { type: string; text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(2);
    expect(system[1].text).toContain('"required":["message"]');
    // The cache breakpoint stays on the STABLE block. Folding a per-call schema
    // into it would re-bill the whole system prompt every turn.
    expect(system[0].cache_control).toBeDefined();
    expect(system[1].cache_control).toBeUndefined();
  });

  it("enforces strict only when the schema can satisfy it", async () => {
    const loose = { ...schema, properties: { ...schema.properties, data: { type: "object" } } };
    for (const [candidate, expected] of [
      [schema, true],
      [loose, false],
    ] as const) {
      const { seen, fetchImpl } = recorder([]);
      const provider = createOpenAIProvider({ apiKey: "k", model: "gpt", fetchImpl });
      await collect(
        provider.createStream([{ role: "user", content: "hi" }], [], {
          json: { name: "out", schema: candidate },
        }),
      ).catch(() => undefined);
      const format = seen[0].body.response_format as { json_schema: { strict: boolean } };
      expect(format.json_schema.strict).toBe(expected);
    }
  });

  it("carries the two sampling controls every shape has", async () => {
    const { seen, fetchImpl } = recorder([]);
    const provider = createOpenAIProvider({ apiKey: "k", model: "gpt", fetchImpl });
    await collect(
      provider.createStream([{ role: "user", content: "hi" }], [], {
        topP: 0.1,
        stopSequences: ["</answer>"],
      }),
    ).catch(() => undefined);
    expect(seen[0].body.top_p).toBe(0.1);
    expect(seen[0].body.stop).toEqual(["</answer>"]);
  });
});
