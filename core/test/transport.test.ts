import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.ts";
import {
  apiUrl,
  parseSseStream,
  postJson,
  retryAfterFromHeaders,
  streamSse,
} from "../src/transport.ts";

/** A Response whose body streams the given chunks, as the network would. */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

const fetchReturning = (res: Response | (() => Response | Promise<Response>)): typeof fetch =>
  (async () => (typeof res === "function" ? res() : res)) as unknown as typeof fetch;

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const opts = (fetchImpl: typeof fetch) => ({
  url: "https://api.example.com/v1/messages",
  body: {},
  provider: "test",
  fetchImpl,
});

describe("apiUrl", () => {
  it.each([
    ["https://api.x.com", "v1/chat", "https://api.x.com/v1/chat"],
    ["https://api.x.com/", "v1/chat", "https://api.x.com/v1/chat"],
    ["https://api.x.com//", "/v1/chat", "https://api.x.com/v1/chat"],
    ["https://api.x.com/v1", "chat", "https://api.x.com/v1/chat"],
  ])("%s + %s", (base, path, expected) => {
    expect(apiUrl(base, path)).toBe(expected);
  });
});

describe("parseSseStream", () => {
  // The framing half, reachable on its own. An app that must keep its own
  // envelope — translated error copy, its own log levels, a token refresh —
  // takes this and skips streamSse; tabrunner is the first to do it.
  it("parses a body without going through the request envelope", async () => {
    const body = sseResponse(['data: {"a":1}\n\n', "data: [DONE]\n\n"]).body!;
    expect(await collect(parseSseStream(body))).toEqual(['{"a":1}']);
  });

  it("releases the reader when the consumer stops early", async () => {
    const body = sseResponse(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']).body!;
    for await (const chunk of parseSseStream(body)) {
      expect(chunk).toBe('{"a":1}');
      break;
    }
    // A held lock would make this throw — the `finally` is what prevents a
    // leaked reader on every aborted turn.
    expect(() => body.getReader()).not.toThrow();
  });
});

describe("streamSse", () => {
  it("yields each frame's data payload", async () => {
    const stream = streamSse(
      opts(fetchReturning(sseResponse(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']))),
    );
    expect(await collect(stream)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("reassembles frames split across network chunks", async () => {
    // The network does not respect frame boundaries; the reader must.
    const stream = streamSse(
      opts(fetchReturning(sseResponse(['data: {"hel', 'lo":"wor', 'ld"}\n\n']))),
    );
    expect(await collect(stream)).toEqual(['{"hello":"world"}']);
  });

  it("swallows [DONE] so no adapter has to", async () => {
    const stream = streamSse(
      opts(fetchReturning(sseResponse(['data: {"a":1}\n\n', "data: [DONE]\n\n"]))),
    );
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it("normalizes CRLF — a stray \\r is a JSON parse error nobody enjoys", async () => {
    const stream = streamSse(
      opts(fetchReturning(sseResponse(['data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n']))),
    );
    expect(await collect(stream)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("keeps a payload containing a newline, per the spec's continuation rule", async () => {
    const stream = streamSse(
      opts(fetchReturning(sseResponse(["data: line one\ndata: line two\n\n"]))),
    );
    expect(await collect(stream)).toEqual(["line one\nline two"]);
  });

  it("ignores comments and bare event: frames", async () => {
    const stream = streamSse(
      opts(
        fetchReturning(
          sseResponse([": keep-alive\n\n", "event: ping\n\n", 'event: delta\ndata: {"a":1}\n\n']),
        ),
      ),
    );
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it("does not drop a final frame that arrived without its blank line", async () => {
    // Losing this loses the last delta — or the whole usage record.
    const stream = streamSse(
      opts(fetchReturning(sseResponse(['data: {"a":1}\n\n', 'data: {"usage":true}']))),
    );
    expect(await collect(stream)).toEqual(['{"a":1}', '{"usage":true}']);
  });

  it("classifies a non-2xx through the shared classifier and keeps the body", async () => {
    const res = new Response('{"error":{"message":"insufficient_quota"}}', { status: 429 });
    const err = await collect(streamSse(opts(fetchReturning(res)))).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("quota");
    expect((err as ProviderError).status).toBe(429);
    expect((err as ProviderError).body).toContain("insufficient_quota");
  });

  it("reads Retry-After off the response, not off a guess", async () => {
    const res = new Response("slow down", {
      status: 429,
      headers: { "retry-after": "42" },
    });
    const err = (await collect(streamSse(opts(fetchReturning(res)))).catch(
      (e) => e,
    )) as ProviderError;
    expect(err.retryAfterMs).toBe(42_000);
  });

  it("turns a transport rejection into a network ProviderError", async () => {
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = (await collect(streamSse(opts(failing))).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("network");
  });

  it("lets a caller's Stop through untouched rather than dressing it as network", async () => {
    const controller = new AbortController();
    const stop = new Error("stopped");
    controller.abort(stop);
    const failing = (async () => {
      throw stop;
    }) as unknown as typeof fetch;
    await expect(collect(streamSse({ ...opts(failing), signal: controller.signal }))).rejects.toBe(
      stop,
    );
  });

  it("treats a 2xx with no body as an upstream anomaly, not our bug", async () => {
    const err = (await collect(
      streamSse(opts(fetchReturning(new Response(null, { status: 200 })))),
    ).catch((e) => e)) as ProviderError;
    expect(err.kind).toBe("overload");
  });
});

describe("postJson", () => {
  it("returns the parsed body", async () => {
    const res = new Response(JSON.stringify({ ok: true }), { status: 200 });
    expect(await postJson(opts(fetchReturning(res)))).toEqual({ ok: true });
  });

  it("throws the classified error on a non-2xx", async () => {
    const res = new Response('{"error":{"message":"invalid api key"}}', { status: 401 });
    await expect(postJson(opts(fetchReturning(res)))).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("retryAfterFromHeaders", () => {
  const now = 1_700_000_000_000;

  it("prefers Retry-After in seconds", () => {
    expect(retryAfterFromHeaders(new Headers({ "retry-after": "30" }), now)).toBe(30_000);
  });

  it("accepts Retry-After as an HTTP-date", () => {
    const when = new Date(now + 45_000).toUTCString();
    expect(retryAfterFromHeaders(new Headers({ "retry-after": when }), now)).toBeCloseTo(
      45_000,
      -3,
    );
  });

  it("falls back to a vendor reset header in epoch seconds", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-reset": String(Math.floor(now / 1000) + 120),
    });
    expect(retryAfterFromHeaders(headers, now)).toBe(120_000);
  });

  it("reads a relative reset count too", () => {
    expect(retryAfterFromHeaders(new Headers({ "x-ratelimit-reset": "15" }), now)).toBe(15_000);
  });

  it("is undefined when the provider said nothing", () => {
    expect(retryAfterFromHeaders(new Headers(), now)).toBeUndefined();
  });
});
