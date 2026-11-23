import { describe, expect, it, vi } from "vitest";
import { createGeminiEmbeddingProvider, type FetchLike } from "../src/embeddings.ts";

const base = { apiKey: "example-key", model: "models/gemini-embedding-2", dimensions: 2 };

function reply(value: unknown): FetchLike {
  return async () => Response.json(value);
}

describe("Gemini embeddings", () => {
  it("posts one ordered request without trimming, rounding or normalizing", async () => {
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      expect(url).toBe("https://example.test/v1beta/models/gemini-embedding-2:batchEmbedContents");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(base.apiKey);
      expect(JSON.parse(String(init?.body))).toEqual({
        requests: ["  café\n", "toner"].map((text) => ({
          model: base.model,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: 2,
        })),
      });
      return Response.json({ embeddings: [{ values: [2.5, 0] }, { values: [-1, 4] }] });
    });
    const provider = createGeminiEmbeddingProvider({
      ...base,
      baseUrl: "https://example.test/v1beta/",
      fetchImpl,
    });
    await expect(
      provider.embed(["  café\n", "toner"], { taskType: "RETRIEVAL_DOCUMENT" }),
    ).resolves.toEqual({
      model: "gemini-embedding-2",
      vectors: [
        [2.5, 0],
        [-1, 4],
      ],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses the same endpoint for one query and keeps an explicit content role", async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      expect(JSON.parse(String(init?.body))).toEqual({
        requests: [
          {
            model: base.model,
            content: { role: "user", parts: [{ text: "paper" }] },
            taskType: "RETRIEVAL_QUERY",
          },
        ],
      });
      return Response.json({ embeddings: [{ values: [1, 2, 3] }] });
    });
    const provider = createGeminiEmbeddingProvider({
      ...base,
      dimensions: undefined,
      timeoutMs: null,
      fetchImpl,
    });
    await expect(
      provider.embed("paper", {
        taskType: "RETRIEVAL_QUERY",
        role: "user",
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ vectors: [[1, 2, 3]] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [{ promptTokenCount: 0 }, [3, 4], { inputTokens: 0, source: "aggregate" }],
    [undefined, [0, 4], { inputTokens: 4, source: "per-vector" }],
    [undefined, [3, undefined], undefined],
  ])("keeps only complete reported token counts", async (usageMetadata, counts, usage) => {
    const fetchImpl = reply({
      usageMetadata,
      embeddings: counts.map((tokenCount) => ({ values: [1, 2], statistics: { tokenCount } })),
    });
    const result = await createGeminiEmbeddingProvider({ ...base, fetchImpl }).embed([
      "one",
      "two",
    ]);
    expect(result.usage).toEqual(usage);
  });

  it.each([
    [[{ values: [1, 2] }], "embedding_count_mismatch"],
    [[{ values: [] }, { values: [2, 3] }], "invalid_embedding_reply"],
    [[{ values: ["1", 2] }, { values: [2, 3] }], "invalid_embedding_reply"],
    [[{ values: [1, 2] }, { values: [2] }], "embedding_dimensions_mismatch"],
  ])("rejects vectors that cannot be paired with the input", async (embeddings, code) => {
    const fetchImpl = vi.fn(reply({ embeddings }));
    await expect(
      createGeminiEmbeddingProvider({ ...base, fetchImpl }).embed(["one", "two"]),
    ).rejects.toMatchObject({
      code,
      kind: "invalid",
      status: 200,
      shouldRetry: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps structured daily quota and delay without exposing the provider's words", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: 429,
            message: "A private customer question",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [{ quotaId: "EmbedContentRequestsPerDayPerProjectPerModel" }],
              },
              { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3.25s" },
            ],
          },
        },
        { status: 429 },
      ),
    );
    const promise = createGeminiEmbeddingProvider({ ...base, fetchImpl }).embed("paper");
    await expect(promise).rejects.toMatchObject({
      status: 429,
      code: "gemini_daily_quota",
      retryAfterMs: 3250,
      body: undefined,
      cause: undefined,
    });
    await expect(promise).rejects.not.toThrow("private customer question");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not trust quota words in a message", async () => {
    const fetchImpl = async () =>
      Response.json({ error: { message: "embedded user words: daily" } }, { status: 429 });
    await expect(
      createGeminiEmbeddingProvider({ ...base, fetchImpl }).embed("paper"),
    ).rejects.toMatchObject({
      status: 429,
      code: undefined,
    });
  });

  it.each([
    { inputs: [] },
    { inputs: ["   "] },
    { inputs: Array.from({ length: 101 }, () => "paper") },
  ])("refuses invalid input before fetch", async ({ inputs }) => {
    const fetchImpl = vi.fn(reply({}));
    await expect(
      createGeminiEmbeddingProvider({ ...base, fetchImpl }).embed(inputs),
    ).rejects.toMatchObject({ code: "embedding_input_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes through a caller abort and never sends an already cancelled request", async () => {
    const fetchImpl = vi.fn(reply({}));
    const reason = new Error("Stop");
    await expect(
      createGeminiEmbeddingProvider({ ...base, fetchImpl }).embed("paper", {
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts errors after a lost response and never replays the request", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error(`header was ${base.apiKey}`);
    });
    await expect(
      createGeminiEmbeddingProvider({ ...base, fetchImpl }).embed("paper"),
    ).rejects.toMatchObject({
      kind: "network",
      shouldRetry: false,
      body: undefined,
      cause: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
