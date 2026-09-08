// The prober asks a model both ways and reports what it saw. What matters here
// is that it never guesses: a shape passes only when EVERY sample called the
// tool, and a model that fails both is reported as such rather than defaulted.
import { describe, expect, it } from "vitest";
import { probeJsonWithTools } from "../src/capability.ts";
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
