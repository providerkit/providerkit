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
});

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) void _;
}
