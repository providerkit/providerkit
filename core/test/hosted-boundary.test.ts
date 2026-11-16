/// <reference types="node" />
// The bundle check runs build tools on the host. src has its own Node-free typecheck.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as plain from "../src/index.ts";
import * as hosted from "../src/hosted.ts";
import type { FallbackSpec, FetchLike, Provider, StreamOptions } from "../src/index.ts";

const messages: plain.ChatMessage[] = [{ role: "user", content: "Search for cats." }];
const search: StreamOptions = { hostedTools: [{ type: "web_search" }] };
const config = { apiKey: "test-key", model: "gpt-5-search-preview" };
const factories = [
  ["Anthropic", plain.createAnthropicProvider, hosted.createAnthropicProvider],
  ["Responses", plain.createResponsesProvider, hosted.createResponsesProvider],
  ["Gemini", plain.createGeminiProvider, hosted.createGeminiProvider],
  ["Chat Completions", plain.createOpenAIProvider, hosted.createOpenAIProvider],
] as const;
const sse = (...events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const geminiAnswer = () =>
  sse({ candidates: [{ content: { parts: [{ text: "Found cats." }] }, finishReason: "STOP" }] });
const chatAnswer = () =>
  sse({ choices: [{ delta: { content: "Found cats." }, finish_reason: "stop" }] });

async function answer(provider: Provider, opts = search) {
  return plain.collectTurn(provider.createStream(messages, [], opts));
}

describe("hosted import boundary", () => {
  it.each(factories)(
    "%s refuses without opt-in, even after an opted-in instance exists",
    async (_name, createPlain, createHosted) => {
      const fetchImpl = vi.fn<FetchLike>();
      createHosted({ ...config, fetchImpl });
      const provider = createPlain({ ...config, fetchImpl, servesHostedTools: ["web_search"] });
      for (const opts of [
        search,
        { hostedTools: [{ type: "web_search", optional: true }] },
        { ...search, toolChoice: "none" },
      ] satisfies StreamOptions[]) {
        await expect(answer(provider, opts)).rejects.toMatchObject({
          kind: "invalid",
          message: expect.stringContaining("@providerkit/core/hosted"),
        });
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("refuses same-provider hosted replay without opt-in", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const provider = plain.createAnthropicProvider({ ...config, fetchImpl });
    await expect(
      plain.collectTurn(
        provider.createStream(
          [
            ...messages,
            { role: "assistant", content: "", hostedItems: { provider: provider.id, items: [] } },
          ],
          [],
        ),
      ),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("plain preset constructors and bare adapters refuse hosted options", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    for (const create of [plain.createPresetProvider, plain.presetAdapter]) {
      await expect(answer(create("google", { ...config, fetchImpl }))).rejects.toMatchObject({
        kind: "invalid",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(factories)(
    "%s propagates opt-in through nested preset fallbacks",
    async (_name, _plain, createHosted) => {
      const requests: Record<string, unknown>[] = [];
      const fetchImpl: FetchLike = async (_url, init) => {
        const body: Record<string, unknown> = JSON.parse(String(init?.body));
        requests.push(body);
        return requests.length < 3 ? new Response("rate limit", { status: 429 }) : geminiAnswer();
      };
      const fallback: FallbackSpec = {
        preset: "openrouter",
        ...config,
        fetchImpl,
        fallbacks: [{ preset: "google", apiKey: "test-key", model: "gemini-3-pro", fetchImpl }],
      };
      const result = await answer(
        createHosted({ ...config, fetchImpl, fallbacks: [fallback], watchdog: { idleMs: 1000 } }),
      );
      expect(result.message.content).toBe("Found cats.");
      expect(requests).toHaveLength(3);
      expect(requests[2]?.tools).toEqual([{ googleSearch: {} }]);
    },
  );

  it("keeps opt-in across a model chain that changes wire", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      requests.push(body);
      return requests.length === 1
        ? new Response("rate limit", { status: 429 })
        : sse(
            { type: "response.output_text.delta", delta: "Found cats." },
            { type: "response.completed" },
          );
    };
    const result = await answer(
      hosted.createPresetProvider("opencode-go", {
        apiKey: "test-key",
        models: ["qwen3.8-flash", "gpt-5.6"],
        servesHostedTools: ["web_search"],
        fetchImpl,
      }),
    );
    expect(result.message.content).toBe("Found cats.");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toContainEqual({ type: "web_search_20250305", name: "web_search" });
    expect(requests[1]?.tools).toContainEqual({ type: "web_search" });
  });

  it("keeps opt-in when Zen rebuilds its free-tier adapter for anonymous retry", async () => {
    const requests: { body: Record<string, unknown>; authorization: string | null }[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      requests.push({ body, authorization: new Headers(init?.headers).get("authorization") });
      return requests.length === 1 ? new Response("invalid key", { status: 401 }) : chatAnswer();
    };
    const result = await answer(
      hosted.createPresetProvider("opencode-zen", {
        apiKey: "test-key",
        model: "minimax-m3.1-flash-free",
        servesHostedTools: ["web_search"],
        fetchImpl,
      }),
    );
    expect(result.message.content).toBe("Found cats.");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.authorization).toBe("Bearer public");
    for (const { body } of requests) {
      expect(body.web_search_options).toEqual({});
      expect(body.tool_choice).toBeUndefined();
    }
  });

  it("opts bare preset adapters and explicit fallback specs in", async () => {
    const fetchImpl: FetchLike = async () => geminiAnswer();
    expect(
      (await answer(hosted.presetAdapter("google", { apiKey: "test-key", fetchImpl }))).message
        .content,
    ).toBe("Found cats.");
    const primary: Provider = {
      id: "unavailable",
      model: "none",
      createStream() {
        throw new plain.ProviderError("unavailable", "quota", "No quota.");
      },
    };
    const provider = hosted.withConfiguredFallbacks(primary, {
      fallbacks: [{ preset: "google", apiKey: "test-key", fetchImpl }],
    });
    expect((await answer(provider)).message.content).toBe("Found cats.");
  });

  it.each(["apiKey", "keys", "token"] as const)(
    "keeps opt-in in registry %s adapters and updates",
    async (kind) => {
      const requests: Record<string, unknown>[] = [];
      const fetchImpl: FetchLike = async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        // Key rotation and token refresh each rebuild an adapter after a 401.
        return kind !== "apiKey" && requests.length === 1
          ? new Response("invalid key", { status: 401 })
          : geminiAnswer();
      };
      const credential: plain.ConnectionCredential =
        kind === "apiKey"
          ? { apiKey: "test-key" }
          : kind === "keys"
            ? { keys: { keys: ["first", "second"] } }
            : {
                token: {
                  async getToken(opts) {
                    return {
                      accessToken: opts?.rejected ? "fresh" : "old",
                      refreshToken: "refresh",
                      expiresAt: Infinity,
                    };
                  },
                },
              };
      const connection: plain.ConnectionConfig = { preset: "google", ...credential, fetchImpl };
      const registry = hosted.createRegistry({ connections: { search: connection } });
      const provider = registry.get("search");
      expect((await answer(provider)).message.content).toBe("Found cats.");
      registry.update("search", { ...connection, model: "gemini-3-pro" });
      expect((await answer(provider)).message.content).toBe("Found cats.");
      expect(requests).toHaveLength(kind === "apiKey" ? 2 : 3);
      for (const body of requests) expect(body.tools).toEqual([{ googleSearch: {} }]);
    },
  );

  it("bundles no hosted-only implementation for an ordinary browser chat consumer", () => {
    const cache = join(homedir(), ".cache", "providerkit", "core-hosted-tools");
    mkdirSync(cache, { recursive: true });
    const directory = mkdtempSync(join(cache, "boundary-"));
    const codecs = /\/hosted\/(?:anthropic|responses|gemini|openai|shared)\.ts$/;
    try {
      for (const entry of ["chat", "hosted"]) {
        const fixture = fileURLToPath(new URL(`./fixtures/${entry}-consumer.ts`, import.meta.url));
        const output = join(directory, `${entry}-consumer.js`);
        execFileSync(
          "bun",
          [
            "build",
            "--minify",
            "--target=browser",
            "--sourcemap=external",
            fixture,
            `--outdir=${directory}`,
          ],
          { stdio: "pipe" },
        );
        const map: { sources: string[] } = JSON.parse(readFileSync(`${output}.map`, "utf8"));
        const included = map.sources.filter((source) => codecs.test(source));
        expect(included.length).toBe(entry === "chat" ? 0 : 5);
        const code = readFileSync(output, "utf8");
        expect(code).not.toMatch(/\bimport\s*\(/);
        // Paired Bun 1.4.4 baseline at 7891647: 81,243 minified bytes.
        // The source map comment counts too. The unused-capability cap stays 12 KB.
        if (entry === "chat") expect(statSync(output).size - 81_243).toBeLessThan(12_000);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
