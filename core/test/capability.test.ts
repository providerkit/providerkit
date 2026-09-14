// The prober asks a model both ways and reports what it saw. What matters here
// is that it never guesses: a shape passes only when EVERY sample called the
// tool, and a model that fails both is reported as such rather than defaulted.
import { describe, expect, it } from "vitest";
import { probeJsonWithTools, resolveModelCapabilities } from "../src/capability.ts";
import type { JsonWithTools, Provider, ProviderChunk, StreamOptions } from "../src/types.ts";

/** A provider whose tool-calling depends on the shape it is asked in — the
 *  whole failure this prober exists for. `calls` records every shape asked. */
function fake(willCall: (shape: JsonWithTools | undefined, nth: number) => boolean): {
  provider: Provider;
  asked: (JsonWithTools | undefined)[];
  requests: StreamOptions[];
} {
  const asked: (JsonWithTools | undefined)[] = [];
  const requests: StreamOptions[] = [];
  const seen = new Map<string, number>();
  const provider: Provider = {
    id: "fake",
    model: "m",
    async *createStream(_messages, _tools, opts: StreamOptions = {}) {
      asked.push(opts.jsonWithTools);
      requests.push(opts);
      const key = String(opts.jsonWithTools);
      const nth = (seen.get(key) ?? 0) + 1;
      seen.set(key, nth);
      if (willCall(opts.jsonWithTools, nth)) {
        yield {
          type: "delta",
          toolCalls: [{ index: 0, name: "get_current_time" }],
        } as ProviderChunk;
      } else {
        yield { type: "delta", content: '{"message":"It is around noon."}' } as ProviderChunk;
      }
      yield { type: "finish", finishReason: "stop" } as ProviderChunk;
    },
  };
  return { provider, asked, requests };
}

describe("probeJsonWithTools", () => {
  it("picks the shape the model actually serves", async () => {
    // The GLM shape: never calls under a response format, always without one.
    const { provider } = fake((shape) => shape === "prompt");
    const probe = await probeJsonWithTools(provider);

    expect(probe.use).toBe("prompt");
    expect(probe.calls).toEqual({ response_format: 0, prompt: 3 });
  });

  it("prefers the response format when both shapes work", async () => {
    // It is the only one of the two the endpoint enforces; the prompt shape is
    // the fallback, not the equal.
    const { provider } = fake(() => true);
    expect((await probeJsonWithTools(provider)).use).toBe("response_format");
  });

  it("fails a shape that only works sometimes", async () => {
    // The reason samples default above one: `gemini-3.8-flash` called its tool
    // 3/10, and a single sample would have reported that coin flip as a
    // capability and shipped it.
    const { provider } = fake((shape, nth) => shape === "response_format" && nth === 1);
    const probe = await probeJsonWithTools(provider, { samples: 3 });

    expect(probe.calls.response_format).toBe(1);
    expect(probe.use).toBeNull();
  });

  it("reports a model that cannot do it either way instead of choosing one", async () => {
    const { provider } = fake(() => false);
    const probe = await probeJsonWithTools(provider);

    expect(probe.use).toBeNull();
    expect(probe.calls).toEqual({ response_format: 0, prompt: 0 });
  });

  it("asks both shapes, with a schema and a tool, deterministically", async () => {
    const { provider, asked, requests } = fake(() => true);
    await probeJsonWithTools(provider, { samples: 2 });

    expect(asked.filter((s) => s === "response_format")).toHaveLength(2);
    expect(asked.filter((s) => s === "prompt")).toHaveLength(2);
    // Both halves of the bet have to be on the table or the probe answers a
    // question nobody asked.
    expect(requests[0]!.json?.schema).toBeDefined();
    expect(requests[0]!.temperature).toBe(0);
    // No token cap: on a thinking model a small one is spent before the answer
    // starts, and an empty completion reads as "did not call the tool".
    expect(requests[0]!.maxTokens).toBeUndefined();
  });

  it("lets a failed call through rather than calling it a missing capability", async () => {
    const provider: Provider = {
      id: "fake",
      model: "m",
      // eslint-disable-next-line require-yield
      async *createStream() {
        throw new Error("401 invalid api key");
      },
    };
    await expect(probeJsonWithTools(provider)).rejects.toThrow("401");
  });
});

describe("resolveModelCapabilities", () => {
  const mockCatalog = {
    anthropic: {
      models: {
        "claude-sonnet-5": {
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          tool_call: true,
          structured_output: true,
          reasoning: true,
          attachment: true,
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          limit: { context: 1_000_000, output: 128_000 },
        },
      },
    },
    zai: {
      models: {
        "glm-5.3-flash": {
          id: "glm-5.3-flash",
          name: "GLM 5.3 Flash",
          tool_call: true,
          structured_output: true,
          reasoning: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 200_000, output: 8_192 },
        },
      },
    },
  };

  it("resolves capabilities by exact model id", async () => {
    const info = await resolveModelCapabilities("claude-sonnet-5", { catalog: mockCatalog });
    expect(info).toBeDefined();
    expect(info?.name).toBe("Claude Sonnet 5");
    expect(info?.contextWindow).toBe(1_000_000);
    expect(info?.maxOutput).toBe(128_000);
    expect(info?.supportsTools).toBe(true);
    expect(info?.supportsVision).toBe(true);
    expect(info?.supportsReasoning).toBe(true);
  });

  it("normalizes gateway prefixes to resolve models", async () => {
    // OpenRouter style: z-ai/glm-5.3-flash
    const info = await resolveModelCapabilities("z-ai/glm-5.3-flash", { catalog: mockCatalog });
    expect(info).toBeDefined();
    expect(info?.id).toBe("glm-5.3-flash");
    expect(info?.contextWindow).toBe(200_000);
    expect(info?.supportsVision).toBe(false);
  });

  it("normalizes punctuation variants across gateways", async () => {
    // Fireworks style: accounts/fireworks/models/glm-5p3-flash
    const info = await resolveModelCapabilities("accounts/fireworks/models/glm-5p3-flash", {
      catalog: mockCatalog,
    });
    expect(info).toBeDefined();
    expect(info?.id).toBe("glm-5.3-flash");
  });

  it("returns undefined without throwing for unknown models or failures", async () => {
    const unknown = await resolveModelCapabilities("completely-unknown-model", { catalog: mockCatalog });
    expect(unknown).toBeUndefined();

    const failingFetch: typeof fetch = async () => new Response("down", { status: 500 });
    const offline = await resolveModelCapabilities("claude-sonnet-5", {
      catalogUrl: "https://invalid.example/api.json",
      fetchImpl: failingFetch,
    });
    expect(offline).toBeUndefined();
  });
});
