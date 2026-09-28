import { describe, expect, it, vi } from "vitest";
import {
  createPresetProvider,
  PRESET_IDS,
  PROVIDER_PRESETS,
  type ProviderPresetId,
} from "../src/index.ts";

const ok = () => new Response("data: [DONE]\n\n");

describe("provider presets — every row joins to one request, correctly", () => {
  // One mocked request per preset. This is the table-driven check that keeps
  // the data honest: a wrong base URL, a wrong auth header, or a preset
  // pointing at an adapter that cannot speak its shape fails HERE, per row,
  // instead of at some adopter's runtime months later.
  const model = "test-model";

  for (const id of PRESET_IDS) {
    const preset = PROVIDER_PRESETS[id];
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
  it.each(["opencode-go", "opencode-go-responses"] satisfies ProviderPresetId[])(
    "%s sends the call's sessionId, and its own stable id when the call has none",
    async (preset) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok());
      const provider = createPresetProvider(preset, { apiKey: "k", fetchImpl });
      const sent = (i: number) =>
        new Headers(fetchImpl.mock.calls[i]?.[1]?.headers).get("x-opencode-session");

      await drain(
        provider.createStream([{ role: "user", content: "hi" }], [], { sessionId: "conv-1" }),
      );
      await drain(provider.createStream([{ role: "user", content: "hi" }], []));
      await drain(provider.createStream([{ role: "user", content: "hi" }], []));

      expect(sent(0)).toBe("conv-1");
      expect(sent(1)).toMatch(/^[0-9a-f-]{36}$/);
      expect(sent(2)).toBe(sent(1));
    },
  );

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
  const modelOf = (init?: RequestInit) => JSON.parse(String(init?.body)).model as string;
  const spent = () =>
    new Response(JSON.stringify({ error: { message: "monthly usage limit reached" } }), {
      status: 429,
    });

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
        watchdog: { idleMs: 10 },
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
