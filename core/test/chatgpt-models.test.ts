import { describe, expect, it, vi } from "vitest";
import { listChatGPTModels } from "../src/auth/index.ts";

const credential = { accessToken: "access-token", chatgptAccountId: "account-id" };
const listed = { slug: "account-model", visibility: "list" };
const reply = (body: unknown) => new Response(JSON.stringify(body));
const hang: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) throw new Error("Expected a request deadline.");
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

describe("listChatGPTModels", () => {
  it("gets the native Codex catalog with the account headers and no redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply({ models: [] }));
    expect(await listChatGPTModels(credential, { fetchImpl })).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.0.0");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("chatgpt-account-id")).toBe("account-id");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("uses the caller's base URL and version, preserving routing parameters", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply({ models: [] }));
    await listChatGPTModels(
      { accessToken: "access-token" },
      {
        baseUrl: "https://gateway.example/codex/?route=one",
        clientVersion: "0.16.0 beta",
        fetchImpl,
      },
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://gateway.example/codex/models?route=one&client_version=0.16.0+beta");
    expect(new Headers(init?.headers).has("chatgpt-account-id")).toBe(false);
  });

  it("keeps subscription-only models, reads metadata and sorts priority ascending", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      reply({
        models: [
          { ...listed, slug: "later-model", priority: 10 },
          { ...listed, slug: "hidden-model", visibility: "hide", priority: -5 },
          {
            ...listed,
            display_name: "Account model",
            supported_in_api: false,
            context_window: 272_000,
            supported_reasoning_levels: [
              { effort: "minimal" },
              { effort: "low" },
              { effort: "high" },
              { effort: "xhigh" },
            ],
            priority: 1,
          },
          { ...listed, slug: "unlisted-model", visibility: "none" },
        ],
      }),
    );
    expect(await listChatGPTModels(credential, { fetchImpl })).toEqual([
      {
        id: "account-model",
        name: "Account model",
        contextLength: 272_000,
        reasoningEfforts: ["low", "high"],
        priority: 1,
      },
      { id: "later-model", priority: 10 },
    ]);
  });

  it("preserves a valid catalog with no visible models", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      reply({
        models: [
          { ...listed, visibility: "hide", context_window: null, supported_reasoning_levels: [] },
        ],
      }),
    );
    expect(await listChatGPTModels(credential, { fetchImpl })).toEqual([]);
  });

  it.each([
    null,
    {},
    [],
    { data: [] },
    { models: null },
    { models: {} },
    { models: [null] },
    { models: [{}] },
    { models: [{ slug: "model" }] },
    { models: [{ ...listed, slug: " " }] },
    { models: [{ ...listed, visibility: "unknown" }] },
    { models: [{ ...listed, display_name: 4 }] },
    { models: [{ ...listed, context_window: "272000" }] },
    { models: [{ ...listed, context_window: 0 }] },
    { models: [{ ...listed, priority: "1" }] },
    { models: [{ ...listed, supported_reasoning_levels: {} }] },
    { models: [{ ...listed, supported_reasoning_levels: ["low"] }] },
  ])("rejects a malformed catalog instead of returning an empty list: %j", async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
    await expect(listChatGPTModels(credential, { fetchImpl })).rejects.toMatchObject({
      provider: "chatgpt",
      kind: "invalid",
      code: "models_response_invalid",
    });
  });

  it.each(["list", "hide", "none"])(
    "rejects duplicate slugs with %s visibility",
    async (visibility) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(reply({ models: [listed, { ...listed, visibility }] }));
      await expect(listChatGPTModels(credential, { fetchImpl })).rejects.toMatchObject({
        provider: "chatgpt",
        kind: "invalid",
        code: "models_response_invalid",
      });
    },
  );

  it("rejects invalid JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("not JSON"));
    await expect(listChatGPTModels(credential, { fetchImpl })).rejects.toMatchObject({
      code: "models_response_invalid",
    });
  });

  it("keeps HTTP authentication errors and never retries them", async () => {
    const body = '{"error":{"message":"Token expired"}}';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 401 }));
    await expect(listChatGPTModels(credential, { fetchImpl })).rejects.toMatchObject({
      provider: "chatgpt",
      kind: "auth",
      status: 401,
      body,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not follow or replay a refused redirect", async () => {
    const error = new TypeError("Redirect refused");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      throw error;
    });
    await expect(listChatGPTModels(credential, { fetchImpl })).rejects.toBe(error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("times out a request that never answers without replaying it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(hang);
    await expect(listChatGPTModels(credential, { fetchImpl, timeoutMs: 20 })).rejects.toMatchObject(
      {
        name: "TimeoutError",
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the deadline while reading the response body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
        ),
    );
    await expect(listChatGPTModels(credential, { fetchImpl, timeoutMs: 20 })).rejects.toMatchObject(
      {
        name: "TimeoutError",
      },
    );
  });

  it.each([false, true])("preserves caller cancellation (already aborted: %s)", async (before) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(hang);
    const controller = new AbortController();
    const reason = new DOMException("Stopped", "AbortError");
    if (before) controller.abort(reason);
    const pending = listChatGPTModels(credential, { fetchImpl, signal: controller.signal });
    if (!before) controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
