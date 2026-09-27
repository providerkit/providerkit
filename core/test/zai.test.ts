import { describe, expect, it, vi } from "vitest";
import {
  createPresetProvider,
  createZaiCodingProvider,
  drainStream,
  ProviderError,
  type ChatMessage,
  type Effort,
  type ToolDefinition,
} from "../src/index.ts";

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

  it("keeps GLM on the budget dialect at every effort, through both ways in", async () => {
    // The adapter spells thinking per Claude model; none of that may reach this
    // endpoint, whose dialect was measured on its own (see createZaiCodingProvider).
    const sent = async (via: "coding" | "preset", effort: Effort | undefined) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("data: [DONE]\n\n"));
      const config = { apiKey: "test-key", model: "glm-5.3-flash", fetchImpl };
      const provider =
        via === "coding" ? createZaiCodingProvider(config) : createPresetProvider("zai", config);
      await drainStream(
        provider.createStream([{ role: "user", content: "Hi" }], [], {
          temperature: 0.3,
          ...(effort ? { effort } : {}),
        }),
        provider.model,
      );
      const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
      return {
        thinking: body.thinking,
        output_config: body.output_config,
        temperature: body.temperature,
      };
    };
    const off = { thinking: { type: "disabled" }, temperature: 0.3 };
    const budget = (budget_tokens: number) => ({ thinking: { type: "enabled", budget_tokens } });
    for (const via of ["coding", "preset"] as const) {
      expect(await sent(via, undefined)).toEqual(off);
      expect(await sent(via, "none")).toEqual(off);
      expect(await sent(via, "low")).toEqual(budget(2_048));
      expect(await sent(via, "medium")).toEqual(budget(8_192));
      expect(await sent(via, "high")).toEqual(budget(16_384));
      expect(await sent(via, "max")).toEqual(budget(32_768));
    }
  });

  it("keeps thinking on through a tool loop, byte for byte", async () => {
    // Claude 4.5 and older think only on the first request of a tool loop:
    // extended mode wants a thinking block this adapter never sends back. That
    // rule is Claude's. GLM gets exactly the body it got before the rule.
    const loop: ChatMessage[] = [
      { role: "user", content: "Weather in Paris?" },
      {
        role: "assistant",
        content: "",
        reasoning: "hmm",
        toolCalls: [{ id: "call_1", name: "weather", arguments: '{"city":"Paris"}' }],
      },
      { role: "tool", toolCallId: "call_1", name: "weather", content: "20°C, sunny" },
    ];
    const weather: ToolDefinition = {
      name: "weather",
      description: "Weather for a city",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    };
    const expected = JSON.stringify({
      model: "glm-5.3-flash",
      max_tokens: 65_536,
      messages: [
        { role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "weather", input: { city: "Paris" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [{ type: "text", text: "20°C, sunny" }],
            },
          ],
        },
      ],
      stream: true,
      tools: [
        { name: "weather", description: "Weather for a city", input_schema: weather.inputSchema },
      ],
      thinking: { type: "enabled", budget_tokens: 2_048 },
    });
    for (const via of ["coding", "preset"] as const) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("data: [DONE]\n\n"));
      const config = { apiKey: "test-key", model: "glm-5.3-flash", fetchImpl };
      const provider =
        via === "coding" ? createZaiCodingProvider(config) : createPresetProvider("zai", config);
      await drainStream(
        provider.createStream(loop, [weather], { effort: "low", temperature: 0.3 }),
        provider.model,
      );
      expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toBe(expected);
    }
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
