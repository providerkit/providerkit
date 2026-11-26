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
            { inlineData: { data: reference.data, mimeType: "image/webp" } },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 9, thoughtsTokenCount: 12 },
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
      images: [
        { bytes, mimeType: "image/webp", seed: 7 },
        { bytes, mimeType: "image/webp", seed: 8 },
      ],
      usage: { size: "2K", images: 2, inputTokens: 12, outputTokens: 18 },
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

  it("sends OpenAI references in a multipart edit without generation moderation", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => openAIReply());
    const provider = createOpenAIImageProvider({
      apiKey: "openai-test",
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
    expect(url).toBe("https://api.openai.com/v1/images/edits");
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

  it("does not return a URL or malformed base64 as an image", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({ data: [{ url: "https://remote.example/output" }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: "bad!" }] }));
    const provider = createOpenAIImageProvider({ apiKey: "test", model: "image", fetchImpl });
    await expect(provider.generate(input)).rejects.toMatchObject({ kind: "overload" });
    await expect(provider.generate(input)).rejects.toMatchObject({
      kind: "invalid",
      shouldRetry: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
