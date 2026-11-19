// `redactErrors`: a chat error without the provider's words, the speech rule of invariant 18.
//
// Each case puts a marker where a failed call can carry the vendor's words, and looks
// everywhere an error reaches: its fields, its `cause` chain, its stack and its JSON. The same
// answer through a provider without the option must still show the marker, or the case
// proves nothing. And the copy must make every retry decision the original makes, because a
// pool, a key pool and `withStreamRetry` read nothing else. Ported from the tests of the stream
// wrapper an adopter wrote for this before the option existed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classify,
  createAnthropicProvider,
  createGeminiProvider,
  createOpenAIProvider,
  createPresetProvider,
  createRegistry,
  createResponsesProvider,
  isRetryable,
  parseRetryAfterMs,
  ProviderError,
  type FetchLike,
  type Provider,
} from "../src/index.ts";

const MARKER = "VISITOR-MARKER-7f3a";

const sse = (...frames: string[]) =>
  new Response(frames.map((frame) => `${frame}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

/** A throttle whose body quotes the person, with a wait and a spent weekly window. */
const httpEcho = () =>
  Response.json(
    { error: { message: `Too many requests about ${MARKER}` } },
    {
      status: 429,
      headers: {
        "retry-after": "7",
        "anthropic-ratelimit-unified-7d-utilization": "1",
        "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 259_200),
      },
    },
  );

type Make = (config: { fetchImpl: FetchLike; redactErrors?: boolean }) => Provider;

/** Each wire, and the overload it reports inside a 200 in its own dialect, quoting the person. */
const WIRES: { name: string; make: Make; inStream: () => Response; code: string }[] = [
  {
    name: "openai",
    make: (config) => createOpenAIProvider({ apiKey: "k", model: "gpt-5", ...config }),
    inStream: () =>
      sse(`data: {"error":{"message":"Overloaded on ${MARKER}","type":"overloaded_error"}}`),
    code: "overloaded_error",
  },
  {
    name: "anthropic",
    make: (config) => createAnthropicProvider({ apiKey: "k", model: "claude-sonnet-5", ...config }),
    inStream: () =>
      sse(
        `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded on ${MARKER}"}}`,
      ),
    code: "overloaded_error",
  },
  {
    name: "gemini",
    make: (config) => createGeminiProvider({ apiKey: "k", model: "gemini-3.5-pro", ...config }),
    inStream: () =>
      sse(
        `data: {"error":{"code":503,"message":"Overloaded on ${MARKER}","status":"UNAVAILABLE"}}`,
      ),
    code: "UNAVAILABLE",
  },
  {
    name: "responses",
    make: (config) => createResponsesProvider({ apiKey: "k", model: "gpt-5", ...config }),
    inStream: () =>
      sse(
        `event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_error","message":"Overloaded on ${MARKER}"}}}`,
      ),
    code: "server_error",
  },
];

/** The rest of the places a failure carries words, on the OpenAI wire through the preset. */
const ECHOES: { name: string; answer: FetchLike; code?: string }[] = [
  {
    name: "a sentence in the vendor's code",
    answer: async () =>
      sse(`data: {"error":{"code":"Echo of ${MARKER}","type":"rate_limit_error"}}`),
  },
  {
    name: "a lost socket whose cause quotes it",
    answer: async () => {
      throw new TypeError("fetch failed", { cause: new Error(MARKER) });
    },
  },
  {
    name: "a frame that is not JSON",
    answer: async () => sse(`data: not json ${MARKER}`),
  },
  {
    name: "a cancel phrase, which keeps the call from being retried",
    answer: async () =>
      new Response(`client closed request: ${MARKER}`, {
        status: 503,
        headers: { "x-should-retry": "true" },
      }),
  },
];

/** The person's words go out in the prompt, which is what a vendor's error can quote back. */
async function failure(provider: Provider, signal?: AbortSignal): Promise<unknown> {
  try {
    const stream = provider.createStream([{ role: "user", content: `Hi, ${MARKER}` }], [], {
      ...(signal ? { signal } : {}),
    });
    for await (const _ of stream) void _;
  } catch (error) {
    return error;
  }
  throw new Error("the call did not fail");
}

/** Every word a failure shows, down its `cause` chain. */
function exposed(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  for (
    let e = error;
    e !== undefined && !seen.has(e);
    e = e instanceof Error ? e.cause : undefined
  ) {
    seen.add(e);
    parts.push(
      e instanceof Error
        ? `${e.name} ${e.message} ${e.stack ?? ""} ${JSON.stringify(e)}`
        : String(e),
    );
  }
  return parts.join("\n");
}

/** What retries, pools and logs read off a failure, apart from its words. */
function retryFacts(error: unknown) {
  if (!(error instanceof ProviderError)) throw new Error(`expected a ProviderError: ${error}`);
  return {
    provider: error.provider,
    kind: error.kind,
    status: error.status,
    retryAfterMs: error.retryAfterMs,
    resetAtMs: error.resetAtMs,
    window: error.window,
    shouldRetry: error.shouldRetry,
    classified: classify(error),
    retryable: isRetryable(error),
    waitMs: parseRetryAfterMs(error),
  };
}

/** The same answer without the option, then with it. */
async function bothWays(make: Make, answer: FetchLike): Promise<[unknown, unknown]> {
  return [
    await failure(make({ fetchImpl: answer })),
    await failure(make({ fetchImpl: answer, redactErrors: true })),
  ];
}

function expectRedacted(bare: unknown, redacted: unknown, code?: string): void {
  expect(exposed(bare)).toContain(MARKER);
  expect(redacted).toBeInstanceOf(ProviderError);
  expect(exposed(redacted)).not.toContain(MARKER);
  expect(redacted).toMatchObject({ body: undefined, cause: undefined, code });
  expect(retryFacts(redacted)).toEqual(retryFacts(bare));
}

// A throttle's reset is read against the clock, so both calls must see the same now.
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

describe("redactErrors on each wire", () => {
  it.each(WIRES)("keeps the person's words out of an HTTP error on $name", async ({ make }) => {
    const [bare, redacted] = await bothWays(make, async () => httpEcho());
    expectRedacted(bare, redacted);
    expect(redacted).toMatchObject({ kind: "rate", status: 429, retryAfterMs: 7_000 });
    expect(redacted).toMatchObject({ window: "weekly", resetAtMs: expect.any(Number) });
  });

  it.each(WIRES)(
    "keeps the person's words out of a failure inside a 200 on $name",
    async ({ make, inStream, code }) => {
      const [bare, redacted] = await bothWays(make, async () => inStream());
      expectRedacted(bare, redacted, code);
    },
  );
});

describe("redactErrors on a preset", () => {
  const openrouter: Make = (config) =>
    createPresetProvider("openrouter", { apiKey: "k", model: "z-ai/glm-5.3-flash", ...config });

  it.each(ECHOES)("keeps the person's words out of $name", async ({ answer, code }) => {
    const [bare, redacted] = await bothWays(openrouter, answer);
    expectRedacted(bare, redacted, code);
  });

  it("says what failed, and why the words are missing", async () => {
    const error = await failure(
      openrouter({ fetchImpl: async () => httpEcho(), redactErrors: true }),
    );
    expect(error).toHaveProperty(
      "message",
      "openrouter: the model call failed (rate, HTTP 429). The error text is left out because redactErrors is on.",
    );
  });

  it("keeps the words when the option is off, as before", async () => {
    const error = await failure(openrouter({ fetchImpl: async () => httpEcho() }));
    expect(error).toHaveProperty("body", expect.stringContaining(MARKER));
    expect(error).toHaveProperty("message", expect.stringContaining(MARKER));
  });

  it("ends a caller's Stop with the caller's own abort", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const fetchImpl = vi.fn<FetchLike>(hang);
    const stop = new AbortController();
    const pending = failure(openrouter({ fetchImpl, redactErrors: true }), stop.signal);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    stop.abort();
    const error = await pending;
    expect(error).toBe(stop.signal.reason);
    expect(classify(error)).toBe("aborted");
  });

  it("reaches the models in its chain and its fallback specs, unless a spec turns it off", async () => {
    const fetchImpl: FetchLike = async () => httpEcho();
    const chain = (spec: { redactErrors?: boolean } = {}) =>
      createPresetProvider("openrouter", {
        apiKey: "k",
        models: ["z-ai/glm-5.3-flash", "xiaomi/mimo-v2.6-flash"],
        redactErrors: true,
        fetchImpl,
        fallbacks: [{ preset: "deepseek", apiKey: "d", fetchImpl, ...spec }],
      });
    // Every candidate answers 429, so the pool throws the last one's error: the spec's.
    const inherited = await failure(chain());
    expect(inherited).toMatchObject({ provider: "deepseek", kind: "rate" });
    expect(exposed(inherited)).not.toContain(MARKER);
    expect(exposed(await failure(chain({ redactErrors: false })))).toContain(MARKER);
  });
});

describe("redactErrors on a registry connection", () => {
  it("applies to the connection that sets it, and to no other", async () => {
    const fetchImpl: FetchLike = async () => httpEcho();
    const providers = createRegistry({
      connections: {
        quiet: {
          preset: "openrouter",
          apiKey: "k",
          model: "z-ai/glm-5.3-flash",
          redactErrors: true,
          fetchImpl,
        },
        loud: { preset: "openrouter", apiKey: "k", model: "z-ai/glm-5.3-flash", fetchImpl },
      },
    });
    const quiet = await failure(providers.get("quiet"));
    const loud = await failure(providers.get("loud"));
    expectRedacted(loud, quiet);
  });
});
