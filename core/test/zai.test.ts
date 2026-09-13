import { describe, expect, it, vi } from "vitest";
import { createZaiCodingProvider, drainStream, ProviderError } from "../src/index.ts";

describe("Z.ai Coding Plan", () => {
  it("uses the coding endpoint and Bearer auth, and reads text and usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        [
          { type: "message_start", message: { usage: { input_tokens: 0 } } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 2 },
          },
          { type: "message_stop" },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      ),
    );
    const provider = createZaiCodingProvider({ apiKey: "test-key", model: "glm-5.2", fetchImpl });
    const result = await drainStream(
      provider.createStream([{ role: "user", content: "Reply OK" }], []),
      provider.model,
    );

    expect(result.text).toBe("OK");
    expect(result.usage).toMatchObject({ inputTokens: 30, cachedInputTokens: 20, outputTokens: 2 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "glm-5.2",
      max_tokens: 65_536,
      // effort resolves to none → the explicit off marker, because silence
      // means the model default (thinking ON) on this endpoint.
      thinking: { type: "disabled" },
    });
  });

  it("says no thinking out loud where silence means on, and sends budgets for graded effort", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("data: [DONE]\n\n"));
    const provider = createZaiCodingProvider({ apiKey: "test-key", model: "glm-5.2", fetchImpl });
    await drainStream(
      provider.createStream([{ role: "user", content: "Hi" }], [], { effort: "low" }),
      provider.model,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      thinking: { type: "enabled", budget_tokens: 2_048 },
    });
    // Graded thinking and sampling are mutually exclusive on this shape.
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).temperature).toBeUndefined();
  });

  it("keeps caller output caps and names Z.ai on authentication failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"error":{"message":"Invalid API key"}}', { status: 401 }));
    const provider = createZaiCodingProvider({ apiKey: "bad-key", model: "glm-5.2", fetchImpl });
    await expect(
      drainStream(
        provider.createStream([{ role: "user", content: "Reply OK" }], [], { maxTokens: 4096 }),
        provider.model,
      ),
    ).rejects.toMatchObject({ provider: "zai", kind: "auth", name: ProviderError.name });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).max_tokens).toBe(4096);
  });
});
