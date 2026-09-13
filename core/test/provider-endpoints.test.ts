import { describe, expect, it, vi } from "vitest";
import { createOpenAIProvider, drainStream } from "../src/index.ts";

describe("OpenAI-compatible gateway paths", () => {
  it.each([
    ["https://openrouter.ai/api", undefined, "https://openrouter.ai/api/v1/chat/completions"],
    [
      "https://openrouter.ai/api/v1",
      "/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
    ],
    [
      "https://api.z.ai/api/paas/v4",
      "/chat/completions",
      "https://api.z.ai/api/paas/v4/chat/completions",
    ],
  ])("joins %s with its configured path", async (baseUrl, path, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("data: [DONE]\n\n"));
    const provider = createOpenAIProvider({
      apiKey: "test",
      model: "test",
      baseUrl,
      path,
      fetchImpl,
    });
    await drainStream(provider.createStream([{ role: "user", content: "Hi" }], []), provider.model);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(expected);
  });
});
