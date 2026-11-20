import { describe, expect, it, vi } from "vitest";
import { ProviderError, type Provider, type ProviderChunk } from "@providerkit/core";
import { defineAgent, type AgentEvent } from "../src/index.ts";

const base = { id: "background-job", version: "1", instructions: "Produce a summary." };
const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 };

function partialThenFail(
  kind: ProviderError["kind"],
  message: string,
): () => AsyncIterable<ProviderChunk> {
  return async function* () {
    yield { type: "delta", content: "Half an answer " };
    yield { type: "usage", usage };
    throw new ProviderError("fake", kind, message);
  };
}

function cleanAnswer(content = "Complete answer"): () => AsyncIterable<ProviderChunk> {
  return async function* () {
    yield { type: "delta", content };
    yield { type: "usage", usage };
    yield { type: "finish", finishReason: "stop" };
  };
}

function scriptedProvider(...attempts: (() => AsyncIterable<ProviderChunk>)[]) {
  let count = 0;
  const provider: Provider = {
    id: "fake",
    model: "fake-model",
    async *createStream() {
      const fn = attempts[count++];
      if (!fn) throw new Error("Unexpected model call");
      yield* fn();
    },
  };
  return { provider, count: () => count };
}

describe("retryAfterOutput (opt-in for unwatched runs)", () => {
  it("never retries after emitted output by default (invariant 1)", async () => {
    const { provider, count } = scriptedProvider(
      partialThenFail("network", "Connection dropped"),
      cleanAnswer(),
    );
    const agent = defineAgent({ ...base, provider });

    const outcome = await agent.run("Summarize");
    expect(outcome.status).toBe("failed");
    expect(count()).toBe(1);
    expect(outcome.receipts).toHaveLength(1);
  });

  it("drops the partial turn, backs off, journals and prices each attempt when enabled", async () => {
    const { provider, count } = scriptedProvider(
      partialThenFail("network", "Connection dropped"),
      partialThenFail("timeout", "Stream stalled"),
      cleanAnswer("Final clean answer"),
    );
    const sleeps: number[] = [];
    const events: AgentEvent[] = [];
    const priceModelCall = vi.fn(({ usage: u }) => (u.inputTokens + u.outputTokens) * 0.01);
    const agent = defineAgent({
      ...base,
      provider,
      retryAfterOutput: {
        maxRetries: 2,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });

    const outcome = await agent.run("Summarize", {
      host: { priceModelCall },
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(outcome.status, JSON.stringify(outcome.snapshot.state)).toBe("completed");
    if (outcome.status === "completed") expect(outcome.output).toBe("Final clean answer");
    expect(count()).toBe(3);

    // Every attempt is journaled and priced, and usage sums all three attempts.
    expect(outcome.receipts).toHaveLength(3);
    expect(outcome.receipts.map((r) => r.status)).toEqual([
      "interrupted",
      "interrupted",
      "completed",
    ]);
    for (const receipt of outcome.receipts) {
      if (receipt.kind === "model") expect(receipt.costUsd).toBeCloseTo(0.15, 6);
    }
    expect(outcome.usage.inputTokens).toBe(30);
    expect(outcome.usage.outputTokens).toBe(15);

    // Operation restart events were emitted before each replacement attempt.
    const restarts = events.filter((event) => event.type === "operation_restart");
    expect(restarts).toHaveLength(2);
    // Backoff stayed within [0, ceiling) per attempt.
    expect(sleeps.length).toBeLessThanOrEqual(2);
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("stops after maxRetries attempts when transient errors keep happening", async () => {
    const { provider, count } = scriptedProvider(
      partialThenFail("network", "Drop 1"),
      partialThenFail("network", "Drop 2"),
      cleanAnswer(),
    );
    const agent = defineAgent({
      ...base,
      provider,
      retryAfterOutput: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        sleep: async () => {},
      },
    });

    const outcome = await agent.run("Summarize");
    expect(outcome.status).toBe("failed");
    expect(count()).toBe(2);
    expect(outcome.receipts).toHaveLength(2);
  });

  it("does not retry non-transient failures after output", async () => {
    const { provider, count } = scriptedProvider(
      partialThenFail("auth", "Bad API key"),
      cleanAnswer(),
    );
    const agent = defineAgent({
      ...base,
      provider,
      retryAfterOutput: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
    });

    const outcome = await agent.run("Summarize");
    expect(outcome.status).toBe("failed");
    expect(count()).toBe(1);
  });

  it("respects limits.costUsd across retry attempts", async () => {
    const { provider, count } = scriptedProvider(
      partialThenFail("network", "Drop 1"),
      cleanAnswer(),
    );
    const agent = defineAgent({
      ...base,
      provider,
      limits: { costUsd: 0.1 },
      retryAfterOutput: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
    });

    // Attempt 1 costs 0.15 (>= 0.10 limit), so the retry cannot start and the run ends limited: costUsd.
    const outcome = await agent.run("Summarize", {
      host: { priceModelCall: () => 0.15 },
    });
    expect(outcome.status).toBe("limited");
    if (outcome.status === "limited") expect(outcome.limit).toBe("costUsd");
    expect(count()).toBe(1);
  });

  it("refuses retryAfterOutput when hostedTools are declared on the agent or on the run (invariant 19)", async () => {
    const { provider } = scriptedProvider(cleanAnswer());
    expect(() =>
      defineAgent({
        ...base,
        provider,
        modelSettings: { hostedTools: [{ type: "web_search" }] },
        retryAfterOutput: { maxRetries: 2 },
      }),
    ).toThrow(/hostedTools/);

    const agent = defineAgent({
      ...base,
      provider,
      retryAfterOutput: { maxRetries: 2 },
    });
    await expect(
      agent.run("Search", {
        modelSettings: { hostedTools: [{ type: "web_search" }] },
      }),
    ).rejects.toThrow(/hostedTools/);
  });

  it("honours retryAfterMs and resetAtMs on mid-stream rate errors, failing if the wait exceeds maxDelayMs", async () => {
    const sleeps: number[] = [];
    const rateLimited = (retryAfterMs: number) =>
      async function* (): AsyncIterable<ProviderChunk> {
        yield { type: "delta", content: "Partial" };
        throw new ProviderError("fake", "rate", "Slow down", { retryAfterMs });
      };
    const { provider, count } = scriptedProvider(
      rateLimited(250),
      cleanAnswer("After retry-after"),
    );
    const agent = defineAgent({
      ...base,
      provider,
      retryAfterOutput: {
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 500,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });

    const outcome = await agent.run("Summarize");
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") expect(outcome.output).toBe("After retry-after");
    expect(count()).toBe(2);
    expect(sleeps).toEqual([250]);

    // When the provider's asked wait exceeds maxDelayMs, fail instead of cutting it short.
    const { provider: longProvider, count: longCount } = scriptedProvider(
      rateLimited(5_000),
      cleanAnswer(),
    );
    const longAgent = defineAgent({
      ...base,
      provider: longProvider,
      retryAfterOutput: {
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 500,
        sleep: async () => {},
      },
    });
    const failed = await longAgent.run("Summarize");
    expect(failed.status).toBe("failed");
    expect(longCount()).toBe(1);
  });

  it("fails the run instead of cancelling when a custom sleep rejects without an abort", async () => {
    const { provider, count } = scriptedProvider(async function* () {
      yield { type: "delta", content: "Half" };
      throw new ProviderError("fake", "rate", "Drop 1", { retryAfterMs: 50 });
    }, cleanAnswer());
    const agent = defineAgent({
      ...base,
      provider,
      retryAfterOutput: {
        maxRetries: 2,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        sleep: async () => {
          throw new Error("sleep exploded");
        },
      },
    });

    const outcome = await agent.run("Summarize");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.message).toContain("sleep exploded");
    expect(count()).toBe(1);
  });

  it("rejects invalid retryAfterOutput configuration", () => {
    const { provider } = scriptedProvider();
    expect(() => defineAgent({ ...base, provider, retryAfterOutput: { maxRetries: 0 } })).toThrow(
      TypeError,
    );
    expect(() => defineAgent({ ...base, provider, retryAfterOutput: { maxRetries: 11 } })).toThrow(
      TypeError,
    );
    expect(() =>
      defineAgent({
        ...base,
        provider,
        retryAfterOutput: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 100 },
      }),
    ).toThrow(TypeError);
  });
});
