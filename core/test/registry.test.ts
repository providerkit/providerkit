// The registry assembles the layers every app used to wire by hand: one gate
// per connection, one watchdog per candidate, one cooldown store for every
// chain. These tests drive it on a fake fetch, so each one checks the request
// a real connection would send.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenSource, type TokenSource } from "../src/auth/token-source.ts";
import { createAnthropicProvider } from "../src/providers/anthropic.ts";
import { createGeminiProvider } from "../src/providers/gemini.ts";
import { createOpenAIProvider } from "../src/providers/openai.ts";
import { createResponsesProvider } from "../src/providers/responses.ts";
import { createPresetProvider } from "../src/providers/factory.ts";
import { ProviderError } from "../src/errors.ts";
import { PROVIDER_PRESETS } from "../src/presets.ts";
import { createRegistry, type RegistryCooldownInfo } from "../src/registry.ts";
import type { Provider, ProviderChunk, StreamOptions } from "../src/types.ts";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

const unexpectedFetch = vi.fn<typeof fetch>(async () => {
  throw new Error("Unexpected network request in registry test");
});
beforeEach(() => {
  unexpectedFetch.mockClear();
  vi.stubGlobal("fetch", unexpectedFetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(unexpectedFetch).not.toHaveBeenCalled();
});

/** One whole chat-completions turn that answers `text`. */
const turn = (text: string) =>
  new Response(
    frame({ choices: [{ delta: { content: text } }] }) +
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
      frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }) +
      "data: [DONE]\n\n",
  );

/** A turn that ends cleanly having said nothing. */
const empty = () =>
  new Response(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");

const throttled = (retryAfterSeconds?: number) =>
  new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
    status: 429,
    headers: retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {},
  });

interface Sent {
  url: string;
  model: string;
  text: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

/** A fake API. `handle` answers each request; by default it echoes the model. */
function server(handle: (req: Sent) => Response | Promise<Response> = (req) => turn(req.model)) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const req: Sent = {
      url: String(url),
      model: String(body.model),
      text: JSON.stringify(body.messages ?? body.input ?? ""),
      headers: new Headers(init?.headers),
      body,
      signal: init?.signal ?? undefined,
    };
    sent.push(req);
    return handle(req);
  });
  return { fetchImpl, sent };
}

async function answer(stream: AsyncIterable<ProviderChunk>): Promise<string> {
  let out = "";
  for await (const chunk of stream) if (chunk.type === "delta") out += chunk.content ?? "";
  return out;
}

const ask = (provider: Provider, opts?: StreamOptions, prompt = "hi") =>
  answer(provider.createStream([{ role: "user", content: prompt }], [], opts));

/** Let every pending promise and zero-delay timer settle. */
const tick = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function deferred() {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A clock the test moves by hand, for the pools' cooldowns. */
function clock(at = 1_700_000_000_000) {
  let now = at;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("refs", () => {
  it("splits at the first slash, so a model id keeps its own", async () => {
    const { fetchImpl, sent } = server();
    const providers = createRegistry({
      connections: { openrouter: { preset: "openrouter", apiKey: "k", fetchImpl } },
    });
    const provider = providers.get("openrouter/xiaomi/mimo-v2.6-flash");
    expect(provider.id).toBe("openrouter");
    expect(provider.model).toBe("xiaomi/mimo-v2.6-flash");
    expect(await ask(provider)).toBe("xiaomi/mimo-v2.6-flash");
    expect(sent[0]?.url.startsWith(PROVIDER_PRESETS.openrouter.baseUrl)).toBe(true);
  });

  it("passes an openrouter connection's dataCollection to a chain's tail", async () => {
    // The registry builds each adapter from its connection, so a field it
    // drops here leaves the wire silently, and an app's privacy policy can
    // rest on this one.
    const { fetchImpl, sent } = server((req) =>
      req.model === "glm-5.3" ? throttled() : turn(req.model),
    );
    const providers = createRegistry({
      connections: {
        go: { preset: "opencode-go", apiKey: "k", fetchImpl },
        openrouter: { preset: "openrouter", apiKey: "k", dataCollection: "deny", fetchImpl },
      },
      chains: { default: ["go/glm-5.3", "openrouter/xiaomi/mimo-v2.6-flash"] },
    });
    expect(await ask(providers.get("default"))).toBe("xiaomi/mimo-v2.6-flash");
    const tail = sent.find((req) => req.url.startsWith(PROVIDER_PRESETS.openrouter.baseUrl));
    expect(tail?.body.provider).toEqual({ data_collection: "deny" });
    expect(sent.find((req) => req.model === "glm-5.3")?.body).not.toHaveProperty("provider");
  });

  it("expands a bare connection to the preset's rotation", () => {
    const { fetchImpl } = server();
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k", fetchImpl } },
    });
    void providers.get("go").model; // builds it
    expect(providers.status().go?.candidates.map((c) => c.ref)).toEqual(
      PROVIDER_PRESETS["opencode-go"].rotation.map((model) => `go/${model}`),
    );
  });

  it("expands a bare connection to its own models before the preset's", () => {
    const { fetchImpl } = server();
    const providers = createRegistry({
      connections: {
        go: { preset: "opencode-go", apiKey: "k", models: ["glm-5.3", "mimo-v2.5"], fetchImpl },
        one: { preset: "opencode-go", apiKey: "k", model: "glm-5.3", fetchImpl },
      },
    });
    void providers.get("go").model;
    void providers.get("one").model;
    const refs = providers.status();
    expect(refs.go?.candidates.map((c) => c.ref)).toEqual(["go/glm-5.3", "go/mimo-v2.5"]);
    expect(refs.one?.candidates.map((c) => c.ref)).toEqual(["one/glm-5.3"]);
  });

  it("drops a duplicate candidate and keeps the first", async () => {
    // Every model throttled, so one call walks the whole chain in order.
    const { fetchImpl, sent } = server(() => throttled());
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k", fetchImpl } },
      chains: { default: ["go/mimo-v2.5", "go", "go/mimo-v2.5"] },
    });
    await expect(ask(providers.get("default"))).rejects.toMatchObject({ kind: "rate" });
    const rotation = PROVIDER_PRESETS["opencode-go"].rotation;
    expect(sent.map((req) => req.model)).toEqual([
      "mimo-v2.5",
      ...rotation.filter((model) => model !== "mimo-v2.5"),
    ]);
  });
});

describe("config errors", () => {
  const source: TokenSource = {
    getToken: async () => ({ accessToken: "t", refreshToken: "", expiresAt: Infinity }),
  };

  it.each<[string, () => unknown]>([
    [
      "an unknown preset",
      () =>
        createRegistry({
          // @ts-expect-error the preset id is checked at compile time too
          connections: { x: { preset: "nope", apiKey: "k" } },
        }),
    ],
    [
      "no credential",
      () =>
        createRegistry({
          // @ts-expect-error a connection needs one credential
          connections: { x: { preset: "openrouter" } },
        }),
    ],
    [
      "two credentials",
      () =>
        createRegistry({
          // @ts-expect-error a connection takes only one credential
          connections: { x: { preset: "openrouter", apiKey: "k", token: source } },
        }),
    ],
    [
      "a chain named like a connection",
      () =>
        createRegistry({
          connections: { go: { preset: "opencode-go", apiKey: "k" } },
          chains: { go: ["go/glm-5.3"] },
        }),
    ],
    [
      "a chain that names an unknown connection",
      () =>
        createRegistry({
          connections: { go: { preset: "opencode-go", apiKey: "k" } },
          chains: { default: ["go/glm-5.3", "openrouter/x"] },
        }),
    ],
    [
      "a chain that names a chain",
      () =>
        createRegistry({
          connections: { go: { preset: "opencode-go", apiKey: "k" } },
          chains: { a: ["go/glm-5.3"], b: ["a"] },
        }),
    ],
    [
      "an empty chain",
      () =>
        createRegistry({
          connections: { go: { preset: "opencode-go", apiKey: "k" } },
          chains: { a: [] },
        }),
    ],
    [
      "a connection name with a slash",
      () => createRegistry({ connections: { "a/b": { preset: "openrouter", apiKey: "k" } } }),
    ],
    [
      "a gate with no slots",
      () =>
        createRegistry({
          connections: { go: { preset: "opencode-go", apiKey: "k", maxConcurrent: 0 } },
        }),
    ],
  ])("throws at creation on %s", (_, create) => {
    expect(create).toThrow(/\[providerkit\]/);
  });

  it("throws at creation on a key pool with no keys", () => {
    expect(() =>
      createRegistry({ connections: { g: { preset: "google", keys: { keys: [""] } } } }),
    ).toThrow(/needs at least one key/);
  });

  it("throws on a ref it doesn't know, and names the ones it does", () => {
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k" } },
      chains: { default: ["go"] },
    });
    expect(() => providers.get("nope")).toThrow(
      /"nope" is not a chain or a connection.*default, go/,
    );
  });

  it("refuses an update that names a chain, and keeps the old connection", () => {
    const { fetchImpl } = server();
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k", fetchImpl } },
      chains: { default: ["go"] },
    });
    expect(() => providers.update("default", { preset: "openrouter", apiKey: "k" })).toThrow(
      /both a chain and a connection/,
    );
    // @ts-expect-error a bad update is a type error first
    expect(() => providers.update("go", { preset: "opencode-go" })).toThrow(/exactly one/);
    expect(providers.get("go").id).toBe("opencode-go");
  });

  it("fails a chain whose connection was removed, on get and on a provider taken before", async () => {
    const { fetchImpl } = server();
    const providers = createRegistry({
      connections: {
        go: { preset: "opencode-go", apiKey: "k", fetchImpl },
        openrouter: { preset: "openrouter", apiKey: "k", fetchImpl },
      },
      chains: { default: ["openrouter/x", "go/glm-5.3"] },
    });
    const early = providers.get("default");
    providers.remove("go");
    expect(() => providers.get("default")).toThrow(/names connection "go", which doesn't exist/);
    await expect(ask(early)).rejects.toThrow(/names connection "go", which doesn't exist/);
  });
});

describe("a provider from get", () => {
  const effortOf = (req: Sent | undefined) => req?.body.reasoning_effort;

  it("applies its effort and maxTokens, and a call's own win", async () => {
    const { fetchImpl, sent } = server();
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k", fetchImpl } },
    });
    const provider = providers.get("go/mimo-v2.6-flash", { effort: "high", maxTokens: 500 });
    await ask(provider);
    await ask(provider, { effort: "low", maxTokens: 50 });
    expect(effortOf(sent[0])).toBe("high");
    expect(sent[0]?.body.max_tokens).toBe(500);
    expect(effortOf(sent[1])).toBe("low");
    expect(sent[1]?.body.max_tokens).toBe(50);
  });

  it("refuses a per-call model as invalid, before any request", async () => {
    const { fetchImpl } = server();
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k", fetchImpl } },
    });
    const error = await ask(providers.get("go"), { model: "glm-5.3" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names its current primary, and follows an update", () => {
    const { fetchImpl } = server();
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k", model: "glm-5.3", fetchImpl } },
    });
    const provider = providers.get("go");
    expect(provider.model).toBe("glm-5.3");
    providers.update("go", { preset: "opencode-go", apiKey: "k", model: "mimo-v2.5", fetchImpl });
    expect(provider.model).toBe("mimo-v2.5");
  });

  it("names the endpoint that answered on every chunk, with one candidate or several", async () => {
    const { fetchImpl } = server();
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k", fetchImpl } },
    });
    for (const ref of ["go/glm-5.3", "go"]) {
      const chunks: ProviderChunk[] = [];
      for await (const chunk of providers.get(ref).createStream([], [])) chunks.push(chunk);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) expect(chunk.source?.provider).toBe("opencode-go");
    }
  });

  it("gives a single candidate no pool, so a blip is not benched", async () => {
    // A pool of one would bench the only option and answer the next call with
    // NoAvailableProviderError. Bare, the next call reaches the wire again.
    let calls = 0;
    const { fetchImpl } = server((req) => (++calls === 1 ? throttled() : turn(req.model)));
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k", fetchImpl } },
    });
    const provider = providers.get("go/glm-5.3");
    await expect(ask(provider)).rejects.toMatchObject({ kind: "rate", provider: "opencode-go" });
    expect(await ask(provider)).toBe("glm-5.3");
  });
});

describe("the watchdog", () => {
  it("is on by default, so an empty turn fails instead of passing as an answer", async () => {
    const { fetchImpl } = server(() => empty());
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k", fetchImpl } },
    });
    await expect(ask(providers.get("go/glm-5.3"))).rejects.toMatchObject({ kind: "overload" });
  });

  it("turns off with false, and a connection's setting beats the registry's", async () => {
    const { fetchImpl } = server(() => empty());
    const providers = createRegistry({
      connections: {
        off: { preset: "opencode-go", apiKey: "k", fetchImpl },
        on: { preset: "opencode-go", apiKey: "k", fetchImpl, watchdog: {} },
      },
      watchdog: false,
    });
    expect(await ask(providers.get("off/glm-5.3"))).toBe("");
    await expect(ask(providers.get("on/glm-5.3"))).rejects.toMatchObject({ kind: "overload" });
  });
});

describe("the gate", () => {
  it("lets 10 parallel calls through 2 at a time, in the order they came", async () => {
    // In flight = requests the server holds unanswered, which is what a
    // vendor's concurrency cap counts.
    const waiting: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const { fetchImpl, sent } = server(async (req) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const { promise, resolve } = deferred();
      waiting.push(resolve);
      await promise;
      inFlight--;
      return turn(req.text);
    });
    const providers = createRegistry({
      connections: {
        go: { preset: "opencode-go", apiKey: "k", maxConcurrent: 2, fetchImpl },
        openrouter: { preset: "openrouter", apiKey: "k", fetchImpl },
      },
      chains: { default: ["go/glm-5.3", "openrouter/xiaomi/mimo-v2.6-flash"] },
    });
    const provider = providers.get("default");
    const calls = Array.from({ length: 10 }, (_, i) => ask(provider, {}, `call-${i}`));

    await tick();
    expect(providers.status().go?.gate).toEqual({ max: 2, held: 2, waiting: 8 });
    while (waiting.length > 0) {
      waiting.shift()!();
      await tick();
    }
    await Promise.all(calls);

    expect(peak).toBe(2);
    expect(sent.map((req) => /call-\d+/.exec(req.text)?.[0])).toEqual(
      Array.from({ length: 10 }, (_, i) => `call-${i}`),
    );
    // A full gate makes callers wait; it never pushes them down the chain.
    expect(sent.every((req) => req.model === "glm-5.3")).toBe(true);
    expect(providers.status().go?.gate).toEqual({ max: 2, held: 0, waiting: 0 });
  });

  it("holds callers behind a probe that queues at a full gate, instead of failing them", async () => {
    const time = clock();
    const holdB = deferred();
    let probeOpen = true;
    const { fetchImpl, sent } = server(async (req) => {
      if (req.model === "glm-5.3") {
        await holdB.promise;
        return turn("b");
      }
      if (req.model === "mimo-v2.5" && probeOpen) return throttled();
      if (req.model === "x") return throttled(3600);
      return turn(req.model);
    });
    const providers = createRegistry({
      connections: {
        go: { preset: "opencode-go", apiKey: "k", maxConcurrent: 1, fetchImpl },
        openrouter: { preset: "openrouter", apiKey: "k", fetchImpl },
      },
      chains: { pair: ["go/mimo-v2.5", "openrouter/x"] },
      fallback: { now: time.now },
    });
    const pair = providers.get("pair");

    // Bench both: go/mimo-v2.5 for the default minute, openrouter/x for an hour.
    await expect(ask(pair)).rejects.toMatchObject({ kind: "rate" });
    time.advance(61_000);
    probeOpen = false;

    // Another model on the same connection holds its only slot.
    const holder = ask(providers.get("go/glm-5.3"));
    await tick();
    expect(providers.status().go?.gate).toMatchObject({ held: 1, waiting: 0 });

    // The first call becomes the probe and queues at the gate; the other two
    // find nothing free but a probe, and wait for it.
    const calls = [ask(pair), ask(pair), ask(pair)];
    await tick();
    expect(providers.status().go?.gate).toMatchObject({ held: 1, waiting: 1 });
    expect(providers.status().go?.candidates).toContainEqual(
      expect.objectContaining({ ref: "go/mimo-v2.5", probing: true }),
    );

    holdB.resolve();
    expect(await holder).toBe("b");
    expect(await Promise.all(calls)).toEqual(["mimo-v2.5", "mimo-v2.5", "mimo-v2.5"]);
    expect(sent.filter((req) => req.model === "x")).toHaveLength(1);
  });
});

describe("shared cooldowns", () => {
  function setup(hooks: { onCooldown?: (info: RegistryCooldownInfo) => void } = {}) {
    const time = clock();
    const { fetchImpl, sent } = server((req) =>
      req.model === "mimo-v2.5" && req.headers.get("authorization") === "Bearer old"
        ? throttled(600)
        : turn(req.model),
    );
    const go = { preset: "opencode-go" as const, apiKey: "old", fetchImpl };
    const providers = createRegistry({
      connections: { go, openrouter: { preset: "openrouter", apiKey: "k", fetchImpl } },
      chains: {
        a: ["go/mimo-v2.5", "openrouter/x"],
        b: ["go/mimo-v2.5", "openrouter/y"],
      },
      fallback: { now: time.now, ...hooks },
    });
    return { providers, sent, go, fetchImpl, time };
  }

  it("benches a candidate in every chain that holds it", async () => {
    const { providers, sent } = setup();
    expect(await ask(providers.get("a"))).toBe("x");
    expect(await ask(providers.get("b"))).toBe("y");
    // Chain b never dialled the candidate chain a had just benched.
    expect(sent.map((req) => req.model)).toEqual(["mimo-v2.5", "x", "y"]);
  });

  it("names the candidate's ref to onCooldown", async () => {
    const seen: RegistryCooldownInfo[] = [];
    const { providers } = setup({ onCooldown: (info) => seen.push(info) });
    await ask(providers.get("a"));
    expect(seen).toMatchObject([{ ref: "go/mimo-v2.5", kind: "rate" }]);
  });

  it("keeps the cooldowns on an update with an equal config", async () => {
    const { providers, sent, go } = setup();
    await ask(providers.get("a"));
    // A fresh object with the same contents, as a config re-read per request is.
    providers.update("go", { ...go, headers: undefined });
    expect(await ask(providers.get("b"))).toBe("y");
    expect(sent.map((req) => req.model)).toEqual(["mimo-v2.5", "x", "y"]);
    expect(providers.status().go?.candidates[0]).toMatchObject({ kind: "rate" });
  });

  it("sends the new key from a provider taken before the update, and drops the old bench", async () => {
    const { providers, sent, go } = setup();
    const early = providers.get("a");
    await ask(early);
    providers.update("go", { ...go, apiKey: "new" });
    expect(await ask(early)).toBe("mimo-v2.5");
    expect(sent.at(-1)?.headers.get("authorization")).toBe("Bearer new");
  });

  it("shows gate use and a cooldown in status", async () => {
    const hold = deferred();
    const { fetchImpl } = server(async (req) => {
      if (req.model === "mimo-v2.5") return throttled(600);
      await hold.promise;
      return turn(req.model);
    });
    const providers = createRegistry({
      connections: {
        go: { preset: "opencode-go", apiKey: "k", maxConcurrent: 2, fetchImpl },
        openrouter: { preset: "openrouter", apiKey: "k", fetchImpl },
      },
      chains: { a: ["go/mimo-v2.5", "go/glm-5.3"] },
    });
    const call = ask(providers.get("a"));
    await tick();
    const before = Date.now();
    expect(providers.status()).toEqual({
      go: {
        gate: { max: 2, held: 1, waiting: 0 },
        candidates: [
          { ref: "go/mimo-v2.5", retryAtMs: expect.any(Number), kind: "rate", probing: false },
          { ref: "go/glm-5.3", retryAtMs: 0, probing: false },
        ],
      },
      openrouter: { candidates: [] },
    });
    // The bench is the 600 s the server asked for.
    const benched = providers.status().go?.candidates[0]?.retryAtMs ?? 0;
    expect(benched - before).toBeGreaterThan(590_000);
    expect(benched - before).toBeLessThanOrEqual(600_000);
    hold.resolve();
    expect(await call).toBe("glm-5.3");
  });
});

describe("credentials", () => {
  it("rotates a connection's keys and keeps one session id across the rebuilds", async () => {
    let calls = 0;
    const { fetchImpl, sent } = server((req) => (++calls === 1 ? throttled() : turn(req.model)));
    const providers = createRegistry({
      connections: {
        go: { preset: "opencode-go", keys: { keys: ["k1", "k2"] }, fetchImpl },
      },
    });
    const provider = providers.get("go/glm-5.3");
    await ask(provider); // k1 is throttled, k2 answers
    await ask(provider); // k1 is benched, k2 again
    expect(sent.map((req) => req.headers.get("authorization"))).toEqual([
      "Bearer k1",
      "Bearer k2",
      "Bearer k2",
    ]);
    const sessions = new Set(sent.map((req) => req.headers.get("x-opencode-session")));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(providers.status().go?.keys).toEqual([
      { tier: "free", evictedUntil: expect.any(Number) },
      { tier: "free", evictedUntil: 0 },
    ]);
  });

  it("signs with the token, merges its headers with the connection's, and keeps one session id", async () => {
    let issued = 0;
    const source: TokenSource = {
      getToken: async () => ({
        accessToken: `token-${++issued}`,
        refreshToken: "",
        expiresAt: Infinity,
        chatgptAccountId: "acct-1",
      }),
    };
    const { fetchImpl, sent } = server();
    const providers = createRegistry({
      connections: {
        go: {
          preset: "opencode-go",
          token: source,
          headers: { "user-agent": "registry-test" },
          fetchImpl,
        },
      },
    });
    const provider = providers.get("go/glm-5.3");
    await ask(provider);
    await ask(provider);
    expect(sent.map((req) => req.headers.get("authorization"))).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
    for (const req of sent) {
      expect(req.headers.get("chatgpt-account-id")).toBe("acct-1");
      expect(req.headers.get("user-agent")).toBe("registry-test");
    }
    expect(new Set(sent.map((req) => req.headers.get("x-opencode-session"))).size).toBe(1);
  });

  it("gives each candidate its own session id", async () => {
    const { fetchImpl, sent } = server();
    const providers = createRegistry({
      connections: { go: { preset: "opencode-go", apiKey: "k", fetchImpl } },
    });
    await ask(providers.get("go/glm-5.3"));
    await ask(providers.get("go/mimo-v2.5"));
    await ask(providers.get("go/glm-5.3"));
    const [a, b, c] = sent.map((req) => req.headers.get("x-opencode-session"));
    expect(a).toBe(c);
    expect(a).not.toBe(b);
  });
});

// These are real provider compositions and wire adapters, not fake Providers.
// Only the injected HTTP transport is fake; every unlisted network path fails.
describe("per-call inference attempt limits", () => {
  const muse = "muse-spark-1.3-contributor";
  const mimo = "mimo-v2.6-flash";

  function go(fetchImpl: typeof fetch, progressMs?: number) {
    return createRegistry({
      connections: {
        go: {
          preset: "opencode-go",
          apiKey: "test-go-key",
          models: [muse, mimo],
          maxConcurrent: 2,
          fetchImpl,
        },
      },
      ...(progressMs === undefined ? {} : { watchdog: { progressMs } }),
    });
  }

  it.each([
    ["registry", 1],
    ["registry", undefined],
    ["preset", 1],
    ["preset", undefined],
  ] as const)(
    "sends one Go request at cap 1 and retains default recovery through %s (cap %s)",
    async (composition, maxAttempts) => {
      const lost = new DOMException("accepted, answer lost", "TimeoutError");
      const { fetchImpl, sent } = server((req) => {
        if (req.model === muse) throw lost;
        return turn("backup answered");
      });
      const provider =
        composition === "registry"
          ? go(fetchImpl).get("go", { effort: "none", maxTokens: 42 })
          : createPresetProvider("opencode-go", {
              apiKey: "test-go-key",
              models: [muse, mimo],
              fetchImpl,
              watchdog: {},
              effort: "none",
              maxTokens: 42,
            });
      const result = await ask(provider, { maxAttempts, sessionId: "article-run" }).catch(
        (error: unknown) => error,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(maxAttempts === 1 ? 1 : 2);
      if (maxAttempts === 1) {
        expect(result).toBeInstanceOf(ProviderError);
        expect(result).toMatchObject({ provider: "opencode-go", kind: "network", cause: lost });
        expect(sent.map((req) => req.model)).toEqual([muse]);
      } else {
        expect(result).toBe("backup answered");
        expect(sent.map((req) => req.model)).toEqual([muse, mimo]);
        expect(sent[1]?.url).toContain("/chat/completions");
      }
      expect(sent[0]?.url).toContain("/responses");
      for (const req of sent) {
        expect(req.headers.get("x-opencode-session")).toBe("article-run");
        expect(JSON.stringify(req.body)).not.toMatch(/maxAttempts|max_attempts|recovery/);
      }
    },
  );

  it.each([1, undefined])(
    "keeps a watchdog timeout's retry directive and cooldown while honoring cap %s",
    async (maxAttempts) => {
      vi.useFakeTimers();
      const { fetchImpl, sent } = server((req) => {
        if (req.model !== muse) return turn("backup answered");
        return new Promise<Response>((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(req.signal?.reason), { once: true });
        });
      });
      const providers = go(fetchImpl, 10);
      const pending = ask(providers.get("go"), { maxAttempts }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      const result = await pending;
      if (maxAttempts === 1) {
        expect(result).toMatchObject({ kind: "timeout", shouldRetry: false });
        expect(sent).toHaveLength(1);
      } else {
        // shouldRetry:false stops same-provider retry, not ordinary fallback.
        expect(result).toBe("backup answered");
        expect(sent).toHaveLength(2);
      }
      expect(providers.status().go?.candidates[0]).toMatchObject({
        kind: "timeout",
        probing: false,
      });
      expect(providers.status().go?.gate).toMatchObject({ held: 0, waiting: 0 });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    [400, "invalid", 1],
    [401, "auth", 2],
    [503, "overload", 2],
  ] as const)(
    "keeps HTTP %s metadata at cap 1 and ordinary %s recovery unchanged",
    async (status, kind, ordinaryRequests) => {
      const body = JSON.stringify({ error: { message: "request refused" } });
      for (const maxAttempts of [1, undefined]) {
        const { fetchImpl, sent } = server((req) =>
          req.model === muse
            ? new Response(body, { status, headers: { "x-should-retry": "false" } })
            : turn("backup answered"),
        );
        const result = await ask(go(fetchImpl).get("go"), { maxAttempts }).catch(
          (error: unknown) => error,
        );
        if (maxAttempts === 1 || ordinaryRequests === 1) {
          expect(result).toMatchObject({
            provider: "opencode-go",
            status,
            kind,
            body,
            shouldRetry: false,
          });
          expect(sent).toHaveLength(1);
        } else {
          expect(result).toBe("backup answered");
          expect(sent).toHaveLength(ordinaryRequests);
        }
      }
    },
  );

  it.each([1, undefined])("never retries caller abort at cap %s", async (maxAttempts) => {
    const stop = new AbortController();
    const reason = new Error("caller stopped");
    const { fetchImpl, sent } = server(() => {
      stop.abort(reason);
      throw reason;
    });
    const providers = go(fetchImpl);
    await expect(ask(providers.get("go"), { maxAttempts, signal: stop.signal })).rejects.toBe(
      reason,
    );
    expect(sent).toHaveLength(1);
    expect(providers.status().go?.candidates.every((entry) => entry.retryAtMs === 0)).toBe(true);
  });

  it("sends no request for an already-aborted call", async () => {
    const { fetchImpl } = server();
    const reason = new Error("already stopped");
    await expect(
      ask(go(fetchImpl).get("go"), { maxAttempts: 1, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([1, undefined])(
    "honors cap %s through nested model and free/paid key pools, keeping both cooldowns",
    async (maxAttempts) => {
      const time = clock();
      const { fetchImpl, sent } = server((req) =>
        req.model === "primary" ? new Response("busy", { status: 503 }) : turn("backup answered"),
      );
      const providers = createRegistry({
        connections: {
          a: {
            preset: "openai",
            model: "primary",
            keys: { keys: ["free-a", "free-b"], paidKey: "paid", now: time.now },
            fetchImpl,
          },
          b: { preset: "openai", model: "backup", apiKey: "backup-key", fetchImpl },
        },
        chains: { pair: ["a", "b"] },
        fallback: { now: time.now },
      });
      const provider = providers.get("pair");
      const result = await ask(provider, { maxAttempts }).catch((error: unknown) => error);
      if (maxAttempts === 1) {
        expect(result).toMatchObject({ kind: "overload", status: 503, body: "busy" });
        expect(sent.map((req) => req.headers.get("authorization"))).toEqual(["Bearer free-a"]);
        expect(providers.status().a?.keys).toEqual([
          { tier: "free", evictedUntil: time.now() + 60_000 },
          { tier: "free", evictedUntil: 0 },
          { tier: "paid", evictedUntil: 0 },
        ]);
        expect(providers.status().a?.candidates[0]).toMatchObject({
          kind: "overload",
          retryAtMs: time.now() + 30_000,
        });
      } else {
        expect(result).toBe("backup answered");
        expect(sent.map((req) => req.headers.get("authorization"))).toEqual([
          "Bearer free-a",
          "Bearer free-b",
          "Bearer paid",
          "Bearer backup-key",
        ]);
      }
      const before = sent.length;
      await expect(ask(provider, { maxAttempts: 1 })).resolves.toBe("backup answered");
      expect(sent.slice(before).map((req) => req.model)).toEqual(["backup"]);
    },
  );

  it("treats larger caps as per-layer limits, not a total HTTP budget", async () => {
    const { fetchImpl, sent } = server(() => new Response("busy", { status: 503 }));
    const providers = createRegistry({
      connections: {
        a: { preset: "openai", model: "a", keys: { keys: ["a1", "a2"] }, fetchImpl },
        b: { preset: "openai", model: "b", keys: { keys: ["b1", "b2"] }, fetchImpl },
      },
      chains: { pair: ["a", "b"] },
    });
    await expect(ask(providers.get("pair"), { maxAttempts: 2 })).rejects.toMatchObject({
      status: 503,
    });
    expect(sent.map((req) => req.headers.get("authorization"))).toEqual([
      "Bearer a1",
      "Bearer a2",
      "Bearer b1",
      "Bearer b2",
    ]);
  });

  it.each([1, undefined])(
    "preserves token renewal for future calls but limits inference resends at cap %s",
    async (maxAttempts) => {
      let stored = { accessToken: "old", refreshToken: "r1", expiresAt: Infinity };
      const fresh = { accessToken: "fresh", refreshToken: "r2", expiresAt: Infinity };
      const refresh = vi.fn(async () => fresh);
      const save = vi.fn(async (credential: typeof stored) => {
        stored = credential;
      });
      const source = tokenSource({ load: async () => stored, save, refresh });
      const { fetchImpl, sent } = server((req) =>
        req.headers.get("authorization") === "Bearer old"
          ? new Response("token refused", { status: 401 })
          : turn("fresh answered"),
      );
      const providers = createRegistry({
        connections: { signed: { preset: "openai", model: "one", token: source, fetchImpl } },
      });
      const provider = providers.get("signed");
      const result = await ask(provider, { maxAttempts }).catch((error: unknown) => error);
      if (maxAttempts === 1) {
        expect(result).toMatchObject({ kind: "auth", status: 401, body: "token refused" });
        expect(sent).toHaveLength(1);
      } else {
        expect(result).toBe("fresh answered");
        expect(sent).toHaveLength(2);
      }
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(fresh);
      await expect(ask(provider, { maxAttempts: 1 })).resolves.toBe("fresh answered");
      expect(sent.at(-1)?.headers.get("authorization")).toBe("Bearer fresh");
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("allows credential refresh before the first capped inference", async () => {
    let stored = { accessToken: "expired", refreshToken: "r1", expiresAt: 0 };
    const fresh = { accessToken: "fresh", refreshToken: "r2", expiresAt: Infinity };
    const refresh = vi.fn(async () => fresh);
    const source = tokenSource({
      load: async () => stored,
      save: async (credential) => {
        stored = credential;
      },
      refresh,
    });
    const { fetchImpl, sent } = server(() => turn("answered"));
    const providers = createRegistry({
      connections: { signed: { preset: "openai", model: "one", token: source, fetchImpl } },
    });
    await expect(ask(providers.get("signed"), { maxAttempts: 1 })).resolves.toBe("answered");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sent.map((req) => req.headers.get("authorization"))).toEqual(["Bearer fresh"]);
  });

  it("lets abort win while capped credential maintenance still saves its result", async () => {
    let stored = { accessToken: "old", refreshToken: "r1", expiresAt: Infinity };
    const fresh = { accessToken: "fresh", refreshToken: "r2", expiresAt: Infinity };
    const renewal = Promise.withResolvers<typeof fresh>();
    const started = Promise.withResolvers<void>();
    const saved = Promise.withResolvers<void>();
    const source = tokenSource({
      load: async () => stored,
      save: async (credential) => {
        stored = credential;
        saved.resolve();
      },
      refresh: async () => {
        started.resolve();
        return renewal.promise;
      },
    });
    const { fetchImpl, sent } = server(() => new Response("token refused", { status: 401 }));
    const providers = createRegistry({
      connections: { signed: { preset: "openai", model: "one", token: source, fetchImpl } },
    });
    const stop = new AbortController();
    const reason = new Error("caller stopped during renewal");
    const result = ask(providers.get("signed"), { maxAttempts: 1, signal: stop.signal }).catch(
      (error: unknown) => error,
    );
    await started.promise;
    stop.abort(reason);
    expect(await result).toBe(reason);
    expect(sent).toHaveLength(1);
    renewal.resolve(fresh);
    await saved.promise;
    expect(stored).toBe(fresh);
  });

  it("starts a fresh allowance for an explicit repair after a known answer", async () => {
    const { fetchImpl, sent } = server((req) =>
      turn(req.text.includes("repair") ? '{"body":"fixed"}' : '{"body":7}'),
    );
    const providers = createRegistry({
      connections: { one: { preset: "openai", model: "one", apiKey: "test-key", fetchImpl } },
    });
    const provider = providers.get("one");
    const opts = { maxAttempts: 1 };
    await expect(ask(provider, opts, "first answer")).resolves.toBe('{"body":7}');
    await expect(ask(provider, opts, "explicit repair")).resolves.toBe('{"body":"fixed"}');
    expect(sent).toHaveLength(2);
    expect(opts).toEqual({ maxAttempts: 1 });
  });

  it("keeps the original capped 401 when credential renewal fails", async () => {
    const renewalFailure = new Error("auth endpoint unavailable");
    const source: TokenSource = {
      getToken: vi.fn<TokenSource["getToken"]>(async (opts) => {
        if (opts?.rejected) throw renewalFailure;
        return { accessToken: "old", refreshToken: "r1", expiresAt: Infinity };
      }),
    };
    const { fetchImpl, sent } = server(() => new Response("original refusal", { status: 401 }));
    const providers = createRegistry({
      connections: { signed: { preset: "openai", model: "one", token: source, fetchImpl } },
    });
    await expect(ask(providers.get("signed"), { maxAttempts: 1 })).rejects.toMatchObject({
      status: 401,
      body: "original refusal",
      kind: "auth",
    });
    expect(source.getToken).toHaveBeenCalledWith({ rejected: "old" });
    expect(sent).toHaveLength(1);
  });

  it.each([1, undefined])("limits Zen's anonymous resend at cap %s", async (maxAttempts) => {
    const { fetchImpl, sent } = server((req) =>
      req.headers.get("authorization") === "Bearer stale"
        ? new Response("key refused", { status: 401 })
        : turn("anonymous answered"),
    );
    const provider = createPresetProvider("opencode-zen", {
      apiKey: "stale",
      model: "mimo-v2.6-flash-free",
      fetchImpl,
    });
    const result = await ask(provider, { maxAttempts }).catch((error: unknown) => error);
    if (maxAttempts === 1) {
      expect(result).toMatchObject({ kind: "auth", status: 401, body: "key refused" });
      expect(sent.map((req) => req.headers.get("authorization"))).toEqual(["Bearer stale"]);
    } else {
      expect(result).toBe("anonymous answered");
      expect(sent.map((req) => req.headers.get("authorization"))).toEqual([
        "Bearer stale",
        "Bearer public",
      ]);
    }
  });

  it.each([1, undefined])("limits Antigravity's host resend at cap %s", async (maxAttempts) => {
    const { fetchImpl, sent } = server((req) =>
      req.url.startsWith("https://daily-cloudcode-pa.googleapis.com")
        ? new Response("daily refused", { status: 503 })
        : new Response(
            frame({
              response: {
                candidates: [
                  { content: { parts: [{ text: "prod answered" }] }, finishReason: "STOP" },
                ],
              },
            }),
          ),
    );
    const provider = createPresetProvider("antigravity", {
      apiKey: "test-token",
      projectId: "test-project",
      model: "gemini-4-argon",
      fetchImpl,
    });
    const result = await ask(provider, { maxAttempts }).catch((error: unknown) => error);
    if (maxAttempts === 1) {
      expect(result).toMatchObject({ kind: "overload", status: 503, body: "daily refused" });
      expect(sent).toHaveLength(1);
    } else {
      expect(result).toBe("prod answered");
      expect(sent).toHaveLength(2);
      expect(sent[1]?.url).toContain("https://cloudcode-pa.googleapis.com/");
    }
    for (const req of sent) expect(JSON.stringify(req.body)).not.toContain("maxAttempts");
  });

  it("isolates a capped call from a concurrent ordinary Go call", async () => {
    const hold = deferred();
    const lost = new DOMException("capped answer lost", "TimeoutError");
    const { fetchImpl, sent } = server(async (req) => {
      if (req.model !== muse) return turn("ordinary backup");
      if (req.text.includes("capped")) await hold.promise;
      throw lost;
    });
    const provider = go(fetchImpl).get("go");
    const capped = ask(provider, { maxAttempts: 1 }, "capped").catch((error: unknown) => error);
    await expect(ask(provider, {}, "ordinary")).resolves.toBe("ordinary backup");
    hold.resolve();
    expect(await capped).toMatchObject({ kind: "network", cause: lost });
    expect(sent.filter((req) => req.text.includes("capped")).map((req) => req.model)).toEqual([
      muse,
    ]);
    expect(sent.filter((req) => req.text.includes("ordinary")).map((req) => req.model)).toEqual([
      muse,
      mimo,
    ]);
  });

  it.each([
    ["chat", createOpenAIProvider],
    ["responses", createResponsesProvider],
    ["messages", createAnthropicProvider],
    ["gemini", createGeminiProvider],
  ] as const)(
    "validates the cap before HTTP and keeps it off the bare %s payload",
    async (_name, create) => {
      const { fetchImpl, sent } = server(() => new Response("busy", { status: 503 }));
      const provider = create({ apiKey: "test-key", model: "test-model", fetchImpl });
      for (const maxAttempts of [0, -1, 1.5, NaN, Infinity]) {
        await expect(ask(provider, { maxAttempts })).rejects.toThrow(
          /maxAttempts must be a positive integer/,
        );
      }
      expect(fetchImpl).not.toHaveBeenCalled();
      await expect(ask(provider, { maxAttempts: 1 })).rejects.toMatchObject({ status: 503 });
      expect(sent).toHaveLength(1);
      expect(JSON.stringify(sent[0]?.body)).not.toMatch(/maxAttempts|max_attempts|recovery/);
    },
  );
});
