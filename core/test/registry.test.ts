// The registry assembles the layers every app used to wire by hand: one gate
// per connection, one watchdog per candidate, one cooldown store for every
// chain. These tests drive it on a fake fetch, so each one checks the request
// a real connection would send.
import { describe, expect, it, vi } from "vitest";
import type { TokenSource } from "../src/auth/token-source.ts";
import { ProviderError } from "../src/errors.ts";
import { PROVIDER_PRESETS } from "../src/presets.ts";
import { createRegistry, type RegistryCooldownInfo } from "../src/registry.ts";
import type { Provider, ProviderChunk, StreamOptions } from "../src/types.ts";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

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
