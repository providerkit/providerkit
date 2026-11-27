import { describe, expect, it, vi } from "vitest";
import {
  createGeminiImageProvider,
  createOpenAIImageProvider,
  createOpenRouterImageProvider,
} from "../src/images.ts";
import { KeyPool } from "../src/key-pool.ts";
import type { FetchLike } from "../src/transport.ts";
import type { ImagePart } from "../src/types.ts";

const input = { prompt: "Draw a circle", aspectRatio: "16:9" as const };
const reference: ImagePart = { type: "image", mimeType: "image/png", data: "AQID" };
const bytes = Uint8Array.of(1, 2, 3);
const openAIReply = () =>
  Response.json({
    data: [{ b64_json: reference.data }],
    usage: { input_tokens: 12, output_tokens: 34 },
  });
const geminiReply = () =>
  Response.json({
    candidates: [
      {
        content: {
          parts: [
            { text: "ignored" },
            { thought: true, inlineData: { data: "BAUG", mimeType: "image/png" } },
            { inlineData: { data: reference.data, mimeType: "image/webp" } },
          ],
        },
      },
    ],
    modelVersion: "gemini-image-001",
    usageMetadata: {
      promptTokenCount: 6,
      cachedContentTokenCount: 1,
      candidatesTokenCount: 9,
      thoughtsTokenCount: 12,
    },
  });

function wireBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("Expected JSON request");
  return JSON.parse(init.body);
}

describe("standalone images", () => {
  it("preserves Gemini references, size and one request per seeded variation", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => geminiReply());
    const provider = createGeminiImageProvider({
      apiKey: "gemini-test",
      model: "gemini-image",
      fetchImpl,
    });
    const reply = await provider.generate({
      ...input,
      model: "models/gemini-override",
      referenceImages: [reference],
      size: "2K",
      seed: 7,
      n: 2,
    });
    expect(reply).toEqual({
      model: "gemini-override",
      modelVersion: "gemini-image-001",
      images: [
        { bytes, mimeType: "image/webp", seed: 7 },
        { bytes, mimeType: "image/webp", seed: 8 },
      ],
      usage: {
        size: "2K",
        images: 2,
        inputTokens: 12,
        cachedInputTokens: 2,
        outputTokens: 18,
        reasoningTokens: 24,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [i, [url, init]] of fetchImpl.mock.calls.entries()) {
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-override:generateContent",
      );
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("gemini-test");
      expect(wireBody(init)).toEqual({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/png", data: "AQID" } },
              { text: input.prompt },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
          seed: 7 + i,
        },
      });
    }
  });

  it("does not rotate a Gemini fenced request even on an HTTP throttle", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("quota", { status: 429 }));
    const pool = new KeyPool("gemini", { keys: ["one", "two"] });
    const provider = createGeminiImageProvider({ pool, model: "gemini-image", fetchImpl });
    await expect(provider.generate({ ...input, retry: "never" })).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends OpenAI generation as JSON with the requested policy and returns the PNG usage", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => openAIReply());
    const provider = createOpenAIImageProvider({
      apiKey: "openai-test",
      model: "gpt-image",
      quality: "medium",
      moderation: "low",
      fetchImpl,
    });
    expect(await provider.generate({ ...input, n: 2 })).toEqual({
      model: "gpt-image",
      images: [{ bytes, mimeType: "image/png" }],
      usage: { size: "1K", images: 1, inputTokens: 12, outputTokens: 34 },
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({ redirect: "error" }),
    );
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer openai-test");
    expect(wireBody(init)).toEqual({
      model: "gpt-image",
      prompt: input.prompt,
      n: 2,
      size: "1536x1024",
      quality: "medium",
      output_format: "png",
      moderation: "low",
    });
  });

  it("sends multipart OpenAI edits under the configured API root", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => openAIReply());
    const provider = createOpenAIImageProvider({
      apiKey: "openai-test",
      baseUrl: "https://image-proxy.example/tenant/",
      model: "gpt-image",
      inputFidelity: "high",
      moderation: "low",
      fetchImpl,
    });
    await provider.generate({
      ...input,
      aspectRatio: "4:5",
      referenceImages: [reference, { ...reference, mimeType: "image/webp" }],
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://image-proxy.example/tenant/images/edits");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error("Expected multipart edit");
    expect(form.get("size")).toBe("1024x1536");
    expect(form.get("input_fidelity")).toBe("high");
    expect(form.has("moderation")).toBe(false);
    const files = form.getAll("image[]");
    expect(files).toHaveLength(2);
    for (const [i, part] of files.entries()) {
      if (typeof part === "string") throw new Error("Expected file data");
      expect(part.name).toBe(i === 0 ? "ref-0.png" : "ref-1.webp");
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes);
    }
  });

  it("keeps OpenRouter references and attribution and returns the exact USD charge, including zero", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      Response.json({
        data: [{ b64_json: "AQID", media_type: "image/webp" }],
        usage: { cost: 0, prompt_tokens: 20, completion_tokens: 30 },
      }),
    );
    const provider = createOpenRouterImageProvider({
      apiKey: "router-test",
      model: "vendor/image-model",
      siteName: "Test",
      siteUrl: "https://test.example",
      fetchImpl,
    });
    expect(
      await provider.generate({ ...input, referenceImages: [reference], size: "4K", seed: 0 }),
    ).toEqual({
      model: "vendor/image-model",
      images: [{ bytes, mimeType: "image/webp" }],
      usage: { images: 1, size: "4K", costUsd: 0, inputTokens: 20, outputTokens: 30 },
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    expect(new Headers(init?.headers).get("http-referer")).toBe("https://test.example");
    expect(new Headers(init?.headers).get("x-title")).toBe("Test");
    expect(wireBody(init)).toEqual({
      model: "vendor/image-model",
      prompt: input.prompt,
      n: 1,
      aspect_ratio: "16:9",
      resolution: "4K",
      output_format: "png",
      seed: 0,
      input_references: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }],
    });
  });

  it("sends Recraft controls and SVG in one OpenRouter call without a resolution", async () => {
    const svg = "<svg/>";
    const fetchImpl = vi.fn<FetchLike>(async () =>
      Response.json({ data: [{ b64_json: btoa(svg) }] }),
    );
    const provider = createOpenRouterImageProvider({
      apiKey: "key",
      model: "recraft/vector",
      fetchImpl,
    });
    const reply = await provider.generate({
      ...input,
      size: "provider",
      outputFormat: "svg",
      retry: "never",
      recraft: { colors: [[0, 128, 255]], backgroundColor: [255, 255, 255] },
      n: 3,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(wireBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
      model: "recraft/vector",
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio,
      n: 3,
      output_format: "svg",
      provider: {
        options: {
          recraft: {
            controls: {
              colors: [{ rgb: [0, 128, 255] }],
              background_color: { rgb: [255, 255, 255] },
            },
          },
        },
      },
    });
    expect(reply.usage.size).toBe("provider");
    expect(reply.images).toEqual([
      { bytes: new TextEncoder().encode(svg), mimeType: "image/svg+xml" },
    ]);
    await provider.generate(input);
    expect(wireBody(fetchImpl.mock.calls[1]?.[1])).toMatchObject({
      resolution: "1K",
      output_format: "png",
    });
  });

  it("rejects unsupported image options and invalid color channels before sending", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const config = { apiKey: "key", model: "recraft/vector", fetchImpl };
    const router = createOpenRouterImageProvider(config);
    await expect(
      router.generate({ ...input, model: "vendor/image", recraft: { colors: [[0, 0, 0]] } }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      router.generate({ ...input, recraft: { backgroundColor: [0, -1, 256] } }),
    ).rejects.toMatchObject({ kind: "invalid" });
    for (const provider of [createOpenAIImageProvider(config), createGeminiImageProvider(config)]) {
      await expect(provider.generate({ ...input, outputFormat: "svg" })).rejects.toMatchObject({
        kind: "invalid",
      });
      await expect(
        provider.generate({ ...input, recraft: { colors: [[0, 0, 0]] } }),
      ).rejects.toMatchObject({ kind: "invalid" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [
      Response.json({ error: { message: "Prompt flagged by moderation" } }, { status: 403 }),
      { status: 403, kind: "content" },
    ],
    [
      Response.json({ error: { message: "Invalid API key" } }, { status: 403 }),
      { status: 403, kind: "auth" },
    ],
    [
      Response.json({ error: { message: "Safety service unavailable" } }, { status: 503 }),
      { status: 503, kind: "overload", shouldRetry: false },
    ],
    [Response.json({ data: [] }), { code: "image_empty", kind: "overload", shouldRetry: false }],
    [new Response("<html>"), { code: "image_invalid_json", kind: "invalid" }],
    [Response.json(null), { code: "image_invalid_json", kind: "invalid" }],
  ])(
    "distinguishes HTTP and finished-image failures without replay",
    async (response, expected) => {
      const fetchImpl = vi.fn<FetchLike>(async () => response);
      const provider = createOpenRouterImageProvider({
        apiKey: "key",
        model: "vendor/model",
        fetchImpl,
      });
      await expect(provider.generate({ ...input, retry: "never" })).rejects.toMatchObject(expected);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("does not return a Gemini thought as the answer or miss a prompt-level refusal", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      Response.json({
        promptFeedback: { blockReason: "IMAGE_SAFETY" },
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ thought: true, inlineData: { data: "AQID" } }] },
          },
        ],
      }),
    );
    const provider = createGeminiImageProvider({ apiKey: "key", model: "image", fetchImpl });
    await expect(provider.generate({ ...input, retry: "never" })).rejects.toMatchObject({
      code: "image_refused",
      kind: "content",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not return a URL or malformed base64 as an image", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({ data: [{ url: "https://remote.example/output" }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: "bad!" }] }));
    const provider = createOpenAIImageProvider({ apiKey: "test", model: "image", fetchImpl });
    await expect(provider.generate(input)).rejects.toMatchObject({ kind: "overload" });
    await expect(provider.generate(input)).rejects.toMatchObject({
      kind: "invalid",
      code: "image_invalid_data",
      shouldRetry: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
