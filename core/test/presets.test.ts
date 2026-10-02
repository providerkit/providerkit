import { describe, expect, it, vi } from "vitest";
import {
  createPresetProvider,
  PRESET_IDS,
  PROVIDER_PRESETS,
  type ProviderPresetId,
} from "../src/index.ts";
import type { ProviderPreset } from "../src/presets.ts";

/** A body that ends a turn on every shape: each adapter reads its own end
 *  signal and skips the other three's frames. These tests are about the
 *  request; a response that never ends would fail them on the way back. */
const ok = () =>
  new Response(
    [
      '{"type":"message_stop"}',
      '{"type":"response.completed","response":{}}',
      '{"candidates":[{"finishReason":"STOP"}]}',
      "[DONE]",
    ]
      .map((payload) => `data: ${payload}\n\n`)
      .join(""),
  );

const modelOf = (init?: RequestInit) => JSON.parse(String(init?.body)).model as string;
const spent = () =>
  new Response(JSON.stringify({ error: { message: "monthly usage limit reached" } }), {
    status: 429,
  });

describe("provider presets — every row joins to one request, correctly", () => {
  // One mocked request per preset. This is the table-driven check that keeps
  // the data honest: a wrong base URL, a wrong auth header, or a preset
  // pointing at an adapter that cannot speak its shape fails HERE, per row,
  // instead of at some adopter's runtime months later.
  const model = "test-model";

  for (const id of PRESET_IDS) {
    const preset: ProviderPreset = PROVIDER_PRESETS[id];
    it(`joins ${id} (${preset.shape}/${preset.auth})`, async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok());
      const provider = createPresetProvider(id, {
        apiKey: "test-key",
        model,
        fetchImpl,
      });
      await drain(provider.createStream([{ role: "user", content: "hi" }], []));

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      const headers = new Headers(init?.headers);
      const sentUrl = String(url);

      // The URL starts at the preset's root and carries NO doubled version —
      // the /api/v1/v1 class of bug, caught per row.
      expect(sentUrl.startsWith(preset.baseUrl)).toBe(true);
      expect(sentUrl.includes("//v") || sentUrl.includes("/v1/v1")).toBe(false);

      // Auth lands in the header the endpoint actually reads — and the
      // natives differ: Anthropic reads x-api-key, Gemini x-goog-api-key,
      // everything else Bearer.
      if (preset.shape === "anthropic" && preset.auth === "key") {
        expect(headers.get("x-api-key")).toBe("test-key");
      } else if (preset.shape === "gemini" && preset.auth === "key") {
        expect(headers.get("x-goog-api-key")).toBe("test-key");
      } else {
        expect(headers.get("authorization")).toBe("Bearer test-key");
      }

      // Static protocol headers ride; the credential never disappears.
      for (const [k, v] of Object.entries(preset.headers ?? {})) {
        expect(headers.get(k)).toBe(v);
      }

      // The model resolves: preset default when none is passed, never empty.
      // Gemini carries it in the URL path (/v1beta/models/<id>:…), not the body.
      if (preset.shape === "gemini") {
        expect(sentUrl).toContain(encodeURIComponent(model));
      } else {
        const body = JSON.parse(String(init?.body));
        expect(body.model.length).toBeGreaterThan(0);
      }
    });
  }

  it("keeps the caller's model over the preset default", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok());
    const provider = createPresetProvider("deepseek", {
      apiKey: "k",
      model: "deepseek-v4-pro",
      fetchImpl,
    });
    await drain(provider.createStream([{ role: "user", content: "hi" }], []));
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).model).toBe("deepseek-v4-pro");
  });

  it("refuses an unknown id by naming the valid ones", () => {
    expect(() => createPresetProvider("nope" as ProviderPresetId, { apiKey: "k" })).toThrow(
      /Unknown provider preset/,
    );
  });

  it("refuses a modelless preset asked to send nothing", () => {
    expect(() => createPresetProvider("ollama", { apiKey: "k" })).toThrow(/defaultModel/);
  });

  it("carries siteUrl/siteName through the factory to OpenRouter", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok());
    const provider = createPresetProvider("openrouter", {
      apiKey: "k",
      model: "z-ai/glm-5.3-flash",
      siteUrl: "https://example.test",
      siteName: "Example",
      fetchImpl,
    });
    await drain(provider.createStream([{ role: "user", content: "hi" }], []));
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("http-referer")).toBe("https://example.test");
    expect(headers.get("x-title")).toBe("Example");
  });

  it("applies zai's thinking dialect through the factory", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok());
    const provider = createPresetProvider("zai", {
      apiKey: "k",
      model: "glm-5.3-flash",
      fetchImpl,
    });
    await drain(provider.createStream([{ role: "user", content: "hi" }], []));
    // effort resolves to none → the explicit off marker, because silence
    // means the model default (thinking ON) on this endpoint.
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).thinking).toEqual({
      type: "disabled",
    });
  });

  it("gives zai room to reason and still answer, unless the caller sets a ceiling", async () => {
    const sent = async (maxTokens?: number) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok());
      const provider = createPresetProvider("zai", {
        apiKey: "k",
        effort: "high",
        ...(maxTokens ? { maxTokens } : {}),
        fetchImpl,
      });
      await drain(provider.createStream([{ role: "user", content: "hi" }], []));
      return JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).max_tokens;
    };
    // The adapter's own default is 8,192, which GLM fills with reasoning alone.
    expect(await sent()).toBe(65_536);
    expect(await sent(4_000)).toBe(4_000);
  });
});

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) void _;
}

describe("opencode-go — the session header", () => {
  it.each(["mimo-v2.6-flash", "muse-spark-1.3-contributor", "minimax-m3"])(
    "%s sends the call's sessionId, and its own stable id when the call has none",
    async (model) => {
      // The stream is the chat dialect's, so the other wires end in an error
      // after the request. Only the request is under test here.
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok());
      const provider = createPresetProvider("opencode-go", { apiKey: "k", model, fetchImpl });
      const sent = (i: number) =>
        new Headers(fetchImpl.mock.calls[i]?.[1]?.headers).get("x-opencode-session");

      const ask = (opts = {}) =>
        drain(provider.createStream([{ role: "user", content: "hi" }], [], opts)).catch(() => {});
      await ask({ sessionId: "conv-1" });
      await ask();
      await ask();

      expect(sent(0)).toBe("conv-1");
      expect(sent(1)).toMatch(/^[0-9a-f-]{36}$/);
      expect(sent(2)).toBe(sent(1));
    },
  );

  describe("opencode-go routes", () => {
    const hi = [{ role: "user" as const, content: "hi" }];
    const call = async (model: string, opts = {}) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok());
      const provider = createPresetProvider("opencode-go", { apiKey: "k", model, fetchImpl });
      await drain(provider.createStream(hi, [], opts)).catch(() => {});
      const [url, init] = fetchImpl.mock.calls[0]!;
      return {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
    };

    it.each([
      ["mimo-v2.6-flash", "https://opencode.ai/zen/go/v1/chat/completions"],
      ["glm-5.3-flash", "https://opencode.ai/zen/go/v1/chat/completions"],
      ["kimi-k3", "https://opencode.ai/zen/go/v1/chat/completions"],
      ["minimax-m3", "https://opencode.ai/zen/go/v1/messages"],
      ["qwen3.8-flash", "https://opencode.ai/zen/go/v1/messages"],
      ["gpt-6-luna", "https://opencode.ai/zen/go/v1/responses"],
      ["grok-4.7", "https://opencode.ai/zen/go/v1/responses"],
      ["muse-spark-1.3-contributor", "https://opencode.ai/zen/go/v1/responses"],
    ])("sends %s to %s", async (model, url) => {
      const sent = await call(model);
      expect(sent.url).toBe(url);
      expect(sent.body.model).toBe(model);
    });

    it("reads the key as x-api-key on the Anthropic route and as a Bearer on the others", async () => {
      expect((await call("minimax-m3")).headers.get("x-api-key")).toBe("k");
      expect((await call("minimax-m3")).headers.get("authorization")).toBeNull();
      expect((await call("gpt-6-luna")).headers.get("authorization")).toBe("Bearer k");
      expect((await call("mimo-v2.5")).headers.get("authorization")).toBe("Bearer k");
    });

    it("refuses a per-call model that lives on another wire, before any request", async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok());
      const provider = createPresetProvider("opencode-go", {
        apiKey: "k",
        model: "mimo-v2.5",
        fetchImpl,
      });
      await expect(
        drain(provider.createStream(hi, [], { model: "gpt-6-luna" })),
      ).rejects.toMatchObject({ kind: "invalid" });
      expect(fetchImpl).not.toHaveBeenCalled();
      // Another model on the SAME wire is fine.
      await drain(provider.createStream(hi, [], { model: "glm-5.3-flash" }));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("sends each member of a chain down its own wire", async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async (_url, init) =>
          modelOf(init) === "muse-spark-1.3-contributor" ? spent() : ok(),
        );
      const provider = createPresetProvider("opencode-go", {
        apiKey: "k",
        models: ["muse-spark-1.3-contributor", "mimo-v2.5"],
        fetchImpl,
      });
      await drain(provider.createStream(hi, []));
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
        "https://opencode.ai/zen/go/v1/responses",
        "https://opencode.ai/zen/go/v1/chat/completions",
      ]);
    });

    it.each([
      ["glm-5.3-flash", "none", "high"],
      ["glm-5.3-flash", "low", "high"],
      ["glm-5.2", "medium", "high"],
      ["glm-5.2", "high", "high"],
      ["glm-5.3", "max", "max"],
      ["deepseek-v4-pro", "none", "low"],
      ["deepseek-v4-flash", "medium", "medium"],
      ["deepseek-v4-flash", "max", "max"],
      ["mimo-v2.6-flash", "none", "none"],
      ["mimo-v2.5", "medium", "medium"],
      ["longcat-2.0", "none", "none"],
    ] as const)("says %s at effort %s as reasoning_effort %s", async (model, effort, wire) => {
      const sent = await call(model, { effort });
      expect(sent.body.reasoning_effort).toBe(wire);
    });

    it.each([["mimo-v2.5", "max"]] as const)(
      "refuses effort %2$s on %1$s instead of changing it",
      async (model, effort) => {
        const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok());
        const provider = createPresetProvider("opencode-go", { apiKey: "k", model, fetchImpl });
        await expect(drain(provider.createStream(hi, [], { effort }))).rejects.toMatchObject({
          kind: "invalid",
        });
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );
  });

  it("only chatgpt replays reasoning", () => {
    expect(PROVIDER_PRESETS.chatgpt.replayReasoning).toBe(true);
    for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (id !== "chatgpt") expect(preset).not.toHaveProperty("replayReasoning");
    }
  });

  it("chatgpt posts to the Codex path, not /v1, and carries its session header", async () => {
    // Without the path the POST 404s, and a 404 reads as kind "model": the
    // user is told the model id is wrong when the URL was.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok());
    const provider = createPresetProvider("chatgpt", { apiKey: "k", fetchImpl });
    await drain(
      provider.createStream([{ role: "user", content: "hi" }], [], { sessionId: "conv-1" }),
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(new Headers(init?.headers).get("session-id")).toBe("conv-1");
  });

  it("github-copilot posts to /chat/completions on the host the sign-in named, and says who started the turn", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok());
    const provider = createPresetProvider("github-copilot", {
      apiKey: "tok",
      baseUrl: "https://api.business.githubcopilot.com",
      fetchImpl,
    });
    await drain(provider.createStream([{ role: "user", content: "hi" }], []));
    await drain(
      provider.createStream(
        [
          { role: "user", content: "hi" },
          { role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: "{}" }] },
          { role: "tool", toolCallId: "c", name: "t", content: "done" },
        ],
        [],
      ),
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.business.githubcopilot.com/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("copilot-integration-id")).toBe("vscode-chat");
    expect(headers.get("x-initiator")).toBe("user");
    expect(new Headers(fetchImpl.mock.calls[1]![1]?.headers).get("x-initiator")).toBe("agent");

    const own = createPresetProvider("github-copilot", { apiKey: "tok", fetchImpl });
    await drain(own.createStream([{ role: "user", content: "hi" }], []));
    expect(String(fetchImpl.mock.calls[2]![0])).toBe(
      "https://api.individual.githubcopilot.com/chat/completions",
    );
  });

  it("grok reaches the CLI backend with the headers that admit a subscription token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok());
    const provider = createPresetProvider("grok", { apiKey: "tok", fetchImpl });
    await drain(provider.createStream([{ role: "user", content: "hi" }], []));
    const [url, init] = fetchImpl.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-grok-client-identifier")).toBe("grok-shell");
  });

  it("grok gets a note instead of an image its backend would fail the request over", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok());
    const provider = createPresetProvider("grok", { apiKey: "tok", fetchImpl });
    await drain(
      provider.createStream(
        [{ role: "user", content: [{ type: "image", mimeType: "image/webp", data: "UklGRg==" }] }],
        [],
      ),
    );
    const { input } = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(input[0].content).toEqual([
      {
        type: "input_text",
        text: "[image omitted: image/webp] (unreadable dimensions for image/webp)",
      },
    ]);
  });

  it("keeps the header off endpoints that don't ask for it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok());
    const provider = createPresetProvider("openrouter", { apiKey: "k", model: "m", fetchImpl });
    await drain(
      provider.createStream([{ role: "user", content: "hi" }], [], { sessionId: "conv-1" }),
    );
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has("x-opencode-session")).toBe(
      false,
    );
  });
});

describe("model chains — one endpoint, one key, several models", () => {
  it("opencode-go rotates through its own chain when a model's limit is spent", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) =>
        modelOf(init) === "mimo-v2.6-flash" ? spent() : ok(),
      );
    const provider = createPresetProvider("opencode-go", { apiKey: "k", fetchImpl });
    await drain(provider.createStream([{ role: "user", content: "hi" }], []));
    expect(fetchImpl.mock.calls.map(([, init]) => modelOf(init))).toEqual([
      "mimo-v2.6-flash",
      "mimo-v2.5",
    ]);
  });

  it("times each candidate separately, then keeps the silent model on cooldown", async () => {
    vi.useFakeTimers();
    try {
      const models: string[] = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        const model = modelOf(init);
        models.push(model);
        if (model === "silent") {
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error("expected a watchdog signal");
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return new Response(
          `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const provider = createPresetProvider("opencode-go", {
        apiKey: "k",
        models: ["silent", "answering"],
        // Never answers at all, so it is the progress clock that catches it:
        // the idle one only starts once a response does.
        watchdog: { progressMs: 10 },
        fetchImpl,
      });

      const first = drain(provider.createStream([{ role: "user", content: "hi" }], []));
      await vi.advanceTimersByTimeAsync(10);
      await first;
      await drain(provider.createStream([{ role: "user", content: "again" }], []));

      expect(models).toEqual(["silent", "answering", "answering"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still treats the caller's abort as cancellation of the whole chain", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected a bridged caller signal");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const provider = createPresetProvider("opencode-go", {
      apiKey: "k",
      models: ["a", "b"],
      watchdog: { idleMs: 60_000 },
      fetchImpl,
    });
    const controller = new AbortController();
    const reason = new DOMException("stopped", "AbortError");
    const pending = drain(
      provider.createStream([{ role: "user", content: "hi" }], [], {
        signal: controller.signal,
      }),
    );
    const failed = expect(pending).rejects.toBe(reason);

    controller.abort(reason);

    await failed;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("`models` overrides the chain, and `fallbacks` still run after it", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) => (String(url).includes("openrouter") ? ok() : spent()));
    const provider = createPresetProvider("opencode-go", {
      apiKey: "k",
      models: ["a", "b"],
      fallbacks: [{ preset: "openrouter", apiKey: "or", model: "c", fetchImpl }],
      fetchImpl,
    });
    await drain(provider.createStream([{ role: "user", content: "hi" }], []));
    expect(fetchImpl.mock.calls.map(([, init]) => modelOf(init))).toEqual(["a", "b", "c"]);
  });

  it("a single `model` means no chain", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => spent());
    const provider = createPresetProvider("opencode-go", {
      apiKey: "k",
      model: "glm-5.3-flash",
      fetchImpl,
    });
    await expect(
      drain(provider.createStream([{ role: "user", content: "hi" }], [])),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
