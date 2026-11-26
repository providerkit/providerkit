import { describe, expect, it, vi } from "vitest";
import { createGeminiVideoProvider } from "../src/video.ts";
import type { FetchLike } from "../src/transport.ts";

const origin = "https://generativelanguage.googleapis.com";
const upload = `${origin}/upload/v1beta/files?upload_id=temporary`;
const file = { name: "files/abc", uri: `${origin}/v1beta/files/abc`, state: "ACTIVE" };
const bytes = Uint8Array.of(0, 0, 0, 24);
const input = { bytes, mimeType: "video/mp4", prompt: "Read it." };

function fake(responses: (Response | ((signal?: AbortSignal | null) => Response))[]) {
  const fetchImpl = vi.fn<FetchLike>(async (_url, init) => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return typeof response === "function" ? response(init?.signal) : response;
  });
  const onCleanupError = vi.fn();
  const reader = createGeminiVideoProvider({
    apiKey: "test-key",
    model: "models/gemini-3.8-flash",
    fetchImpl,
    onCleanupError,
  });
  return { reader, fetchImpl, onCleanupError };
}

function start(session = upload): Response {
  return new Response(null, { headers: { "x-goog-upload-url": session } });
}

function uploaded(state = "ACTIVE"): Response {
  return Response.json({ file: { ...file, state } });
}

function done(): Response {
  return new Response(null, { status: 204 });
}

describe("Gemini video", () => {
  it("uploads the original bytes, polls, reads the requested clip and deletes the file", async () => {
    vi.useFakeTimers();
    try {
      const { reader, fetchImpl } = fake([
        start(),
        uploaded("PROCESSING"),
        Response.json(file),
        Response.json({
          candidates: [
            {
              content: {
                parts: [
                  { text: "private reasoning", thought: true },
                  { text: '{"ok":' },
                  { text: "true}" },
                ],
              },
            },
            { content: { parts: [{ text: "unused answer" }] } },
          ],
          usageMetadata: {
            promptTokenCount: 9000,
            candidatesTokenCount: 200,
            cachedContentTokenCount: 11,
            thoughtsTokenCount: 5,
            toolUsePromptTokenCount: 0,
          },
        }),
        done(),
      ]);
      const read = reader.read({
        ...input,
        seconds: 90,
        lowResolution: true,
        json: true,
        maxOutputTokens: 2048,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await read).toEqual({
        text: '{"ok":true}',
        usage: {
          inputTokens: 9000,
          outputTokens: 205,
          cachedInputTokens: 11,
          reasoningTokens: 5,
          toolUsePromptTokens: 0,
        },
      });
      const calls = fetchImpl.mock.calls;
      expect(calls.map(([url, init]) => [url, init?.method, init?.redirect])).toEqual([
        [`${origin}/upload/v1beta/files`, "POST", "error"],
        [upload, "POST", "error"],
        [file.uri, "GET", "error"],
        [`${origin}/v1beta/models/gemini-3.8-flash:generateContent`, "POST", "error"],
        [file.uri, "DELETE", "error"],
      ]);
      expect(calls[0]?.[1]?.headers).toMatchObject({
        "x-goog-api-key": "test-key",
        "x-goog-upload-command": "start",
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-header-content-length": "4",
        "x-goog-upload-header-content-type": "video/mp4",
      });
      expect(calls[1]?.[1]?.headers).toEqual({
        "x-goog-upload-command": "upload, finalize",
        "x-goog-upload-offset": "0",
      });
      const body = calls[1]?.[1]?.body;
      expect(body).toBeInstanceOf(Blob);
      if (!(body instanceof Blob)) throw new Error("Missing video");
      expect(body.type).toBe("video/mp4");
      expect(new Uint8Array(await body.arrayBuffer())).toEqual(bytes);
      expect(JSON.parse(String(calls[3]?.[1]?.body))).toEqual({
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: { fileUri: file.uri, mimeType: "video/mp4" },
                videoMetadata: { startOffset: "0s", endOffset: "90s" },
              },
              { text: "Read it." },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 2048,
          mediaResolution: "MEDIA_RESOLUTION_LOW",
          responseMimeType: "application/json",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues past 8 MiB without replaying or finalizing the first chunk", async () => {
    const { reader, fetchImpl } = fake([
      start(),
      new Response(null, { headers: { "x-goog-upload-status": "active" } }),
      uploaded(),
      Response.json({}),
      done(),
    ]);
    const chunkSize = 8 * 1024 * 1024;
    await reader.read({ ...input, bytes: new Uint8Array(chunkSize + 1) });
    const requests = fetchImpl.mock.calls.slice(1, 3).map(([, init]) => init);
    expect(requests).toMatchObject([
      {
        headers: { "x-goog-upload-command": "upload", "x-goog-upload-offset": "0" },
        body: { size: chunkSize },
      },
      {
        headers: {
          "x-goog-upload-command": "upload, finalize",
          "x-goog-upload-offset": String(chunkSize),
        },
        body: { size: 1 },
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("refuses a different upload origin before sending private bytes", async () => {
    const { reader, fetchImpl } = fake([start("https://other.example/upload/v1beta/files")]);
    await expect(reader.read(input)).rejects.toMatchObject({ code: "invalid_video_upload_url" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not send inference for a failed file and still deletes it", async () => {
    const { reader, fetchImpl } = fake([start(), uploaded("FAILED"), done()]);
    await expect(reader.read(input)).rejects.toMatchObject({ code: "video_processing_failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      file.uri,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("keeps the first failure, does not replay, and reports a failed cleanup separately", async () => {
    const { reader, fetchImpl, onCleanupError } = fake([
      start(),
      uploaded(),
      new Response("private prompt", { status: 503, headers: { "x-should-retry": "true" } }),
      new Response("private file", { status: 500 }),
    ]);
    await expect(reader.read(input)).rejects.toMatchObject({
      status: 503,
      shouldRetry: false,
      message: "gemini 503",
      body: undefined,
    });
    expect(onCleanupError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500, body: undefined }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("cleans up using a fresh signal even if the caller stops after the upload", async () => {
    const controller = new AbortController();
    const stop = new Error("stop");
    const { reader, fetchImpl } = fake([
      start(),
      () => {
        controller.abort(stop);
        return uploaded("PROCESSING");
      },
      done(),
    ]);
    await expect(reader.read({ ...input, signal: controller.signal })).rejects.toBe(stop);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({
      method: "DELETE",
      signal: { aborted: false },
    });
  });

  it("reads the final upload receipt after Stop, deletes the video and never starts inference", async () => {
    const controller = new AbortController();
    const stop = new Error("stop");
    const { reader, fetchImpl } = fake([
      start(),
      (signal) =>
        new Response(
          new ReadableStream({
            pull(body) {
              controller.abort(stop);
              if (signal?.aborted) {
                body.error(signal.reason);
                return;
              }
              body.enqueue(new TextEncoder().encode(JSON.stringify({ file })));
              body.close();
            },
          }),
        ),
      done(),
    ]);
    await expect(reader.read({ ...input, signal: controller.signal })).rejects.toBe(stop);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "POST",
      "DELETE",
    ]);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      file.uri,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("keeps billed usage even when there is no text", async () => {
    const { reader } = fake([
      start(),
      uploaded(),
      Response.json({ usageMetadata: { promptTokenCount: 800 } }),
      done(),
    ]);
    await expect(reader.read(input)).resolves.toEqual({
      text: "",
      usage: { inputTokens: 800, outputTokens: 0, cachedInputTokens: 0 },
    });
  });
});
