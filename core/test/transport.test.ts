import { describe, expect, it } from "vitest";
import { classify, isRetryable, ProviderError } from "../src/errors.ts";
import {
  apiUrl,
  parseFrame,
  parseSseStream,
  postBytes,
  postJson,
  readBounded,
  retryAfterFromHeaders,
  streamSse,
  versionedPath,
  withDeadline,
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

/** A body that delivers `chunks`, then fails its next read the way undici
 *  does when the other side closes. */
function dyingBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) return controller.error(new TypeError("terminated"));
      controller.enqueue(encoder.encode(next));
    },
  });
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
  // takes this and skips streamSse. The first adopter did exactly that.
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

  it("stops at [DONE], so a socket that dies after it costs nothing", async () => {
    // Kimi, GLM and OpenCode Go: the answer and its `[DONE]` arrive, then the
    // read after them fails. Reading on threw away a turn the reader had
    // already been shown.
    const body = dyingBody(['data: {"a":1}\n\n', "data: [DONE]\n\n"]);
    expect(await collect(parseSseStream(body))).toEqual(['{"a":1}']);
  });

  it("lets the connection go at [DONE] rather than holding it open", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\ndata: [DONE]\n\n'));
        // Never closed: a server that keeps the socket after its last word.
      },
      cancel: () => {
        cancelled = true;
      },
    });
    expect(await collect(parseSseStream(body))).toEqual(['{"a":1}']);
    expect(cancelled).toBe(true);
  });

  it("keeps a finished turn when the read after its finish fails", async () => {
    const body = dyingBody(['data: {"finish":"stop"}\n\n']);
    expect(await collect(parseSseStream(body, { finished: () => true }))).toEqual([
      '{"finish":"stop"}',
    ]);
  });

  it("still fails a read that dies before the finish", async () => {
    const body = dyingBody(['data: {"a":1}\n\n']);
    await expect(collect(parseSseStream(body, { finished: () => false }))).rejects.toThrow(
      "terminated",
    );
  });

  it("never swallows a Stop, even after the finish", async () => {
    // A loop handed a clean end goes on to run the turn's tools.
    const controller = new AbortController();
    const stop = new Error("stopped");
    const body = new ReadableStream<Uint8Array>({
      start(source) {
        source.enqueue(new TextEncoder().encode('data: {"finish":"stop"}\n\n'));
        controller.signal.addEventListener("abort", () => source.error(stop));
      },
    });
    const stream = parseSseStream(body, { finished: () => true, signal: controller.signal });
    expect(await stream.next()).toEqual({ done: false, value: '{"finish":"stop"}' });
    controller.abort(stop);
    await expect(stream.next()).rejects.toBe(stop);
  });
});

describe("parseFrame", () => {
  it("parses a JSON event", () => {
    expect(parseFrame('{"a":1}', "p")).toEqual({ a: 1 });
  });

  it("fails a frame that is not JSON as network, with the frame kept", () => {
    // Keep-alives never get here (comments and empty frames are dropped
    // upstream), so what does is a delta, a tool call or a finish, lost.
    let err: unknown;
    try {
      parseFrame('{"choices":[{"delta":{"content":"hel', "p");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ provider: "p", kind: "network" });
    expect((err as ProviderError).body).toContain('"content":"hel');
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

  it("reports [DONE] through its hook while still swallowing it", async () => {
    let done = false;
    const body = sseResponse(['data: {"a":1}\n\n', "data: [DONE]\n\n"]).body!;
    const out = await collect(parseSseStream(body, { onDone: () => (done = true) }));
    expect(out).toEqual(['{"a":1}']);
    expect(done).toBe(true);
  });

  it("reads bare-CR line endings, and a CRLF split across reads", async () => {
    // The spec allows CR alone; a CR at the end of one read may be half a CRLF.
    const body = sseResponse(['data: {"a":1}\r\r', 'data: {"b":2}\r', "\n\r\n"]).body!;
    expect(await collect(parseSseStream(body))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("counts every read as activity, keep-alives included", async () => {
    let reads = 0;
    const body = sseResponse([": keep-alive\n\n", ": keep-alive\n\n", 'data: {"a":1}\n\n']).body!;
    await collect(parseSseStream(body, { onActivity: () => reads++ }));
    expect(reads).toBe(3);
  });

  it("gives up on a frame that never ends instead of buffering forever", async () => {
    const body = sseResponse(["data: " + "x".repeat(64), "y".repeat(64)]).body!;
    const err = await collect(parseSseStream(body, { maxFrameChars: 100, provider: "p" })).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ provider: "p", kind: "overload", shouldRetry: false });
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

  it("reads a fractional Retry-After and retry-after-ms as waits, not dates", async () => {
    // `Date.parse("1.5")` is a day in 2001 — a wait of zero.
    const failWith = async (headers: Record<string, string>) =>
      (await collect(
        streamSse(opts(fetchReturning(new Response("slow down", { status: 429, headers })))),
      ).catch((e) => e)) as ProviderError;
    expect((await failWith({ "retry-after": "1.5" })).retryAfterMs).toBe(1_500);
    expect((await failWith({ "retry-after-ms": "250" })).retryAfterMs).toBe(250);
  });

  it("does not read the account's window reset as the wait on an overload", async () => {
    // Claude OAuth stamps the unified reset on every response. On a 529 it is
    // the account's weekly horizon, not this failure's: read as the wait, the
    // overload was never retried and its model was benched for days.
    const reset = String(Math.floor(Date.now() / 1000) + 3 * 86_400);
    const res = new Response('{"type":"error","error":{"type":"overloaded_error"}}', {
      status: 529,
      headers: { "anthropic-ratelimit-unified-reset": reset },
    });
    const err = (await collect(streamSse(opts(fetchReturning(res)))).catch(
      (e) => e,
    )) as ProviderError;
    expect(err.kind).toBe("overload");
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.resetAtMs).toBeUndefined();
    expect(err.isTransient).toBe(true);

    // The same header on a throttle IS about the window.
    const throttled = (await collect(
      streamSse(
        opts(
          fetchReturning(
            new Response("rate limited", {
              status: 429,
              headers: { "anthropic-ratelimit-unified-reset": reset },
            }),
          ),
        ),
      ),
    ).catch((e) => e)) as ProviderError;
    expect(throttled.resetAtMs).toBe(Number(reset) * 1000);
  });

  it("turns a transport rejection into a network ProviderError", async () => {
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = (await collect(streamSse(opts(failing))).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("network");
  });

  it("reads a rejection in wording nobody listed as network too", async () => {
    // Each runtime words a dead socket its own way, and a list of wordings is
    // always one short. A rejection that is not the caller's Stop means no
    // response came back, which is a transport failure.
    const odd = new Error("error sending request for url (https://api.example.com/v1/messages)");
    const failing = (async () => {
      throw odd;
    }) as unknown as typeof fetch;
    const err = (await collect(streamSse(opts(failing))).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("network");
    expect(err.cause).toBe(odd);
    expect(isRetryable(err)).toBe(true);
  });

  it("keeps a body that cannot become JSON as our own bug, not a network blip", async () => {
    const body: Record<string, unknown> = {};
    body.self = body;
    const fetchImpl = (async () => new Response("{}")) as unknown as typeof fetch;
    const err = await collect(streamSse({ ...opts(fetchImpl), body })).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(ProviderError);
  });

  it("keeps the caller's abort an abort, never a retried network failure", async () => {
    // The real shape: fetch rejects with the signal's reason, a DOMException.
    const controller = new AbortController();
    controller.abort();
    const failing = (async (_url: string, init: RequestInit) => {
      throw init.signal?.reason;
    }) as unknown as typeof fetch;
    const err = await collect(streamSse({ ...opts(failing), signal: controller.signal })).catch(
      (e) => e,
    );
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(classify(err)).toBe("aborted");
    expect(isRetryable(err)).toBe(false);
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

describe("versionedPath", () => {
  it.each([
    ["https://api.x.com", "/audio/speech", "v1", "/v1/audio/speech"],
    ["https://api.x.com/", "/audio/speech", "v1", "/v1/audio/speech"],
    ["https://api.x.com/v1", "/audio/speech", "v1", "/audio/speech"],
    ["https://api.x.com/openai/v1/", "/audio/speech", "v1", "/audio/speech"],
    ["https://api.x.com/api/v4", "/audio/speech", "v1", "/audio/speech"],
    ["https://api.x.com", "/interactions", "v1beta", "/v1beta/interactions"],
    ["https://api.x.com/v1beta", "/interactions", "v1beta", "/interactions"],
  ])("%s + %s (%s)", (base, path, version, expected) => {
    expect(versionedPath(base, path, version)).toBe(expected);
  });
});

/** A body that hands out `chunks` and records whether it was cancelled. */
function trackedBody(chunks: Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const queue = [...chunks];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
    cancel: () => {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

describe("readBounded", () => {
  it("returns the whole body when it fits, chunks joined in order", async () => {
    const res = new Response(trackedBody([Uint8Array.of(1, 2), Uint8Array.of(3)]).body);
    expect([...(await readBounded(res, 3, "test"))]).toEqual([1, 2, 3]);
  });

  it("returns an empty array for a response with no body", async () => {
    expect((await readBounded(new Response(null), 10, "test")).byteLength).toBe(0);
  });

  it("refuses a Content-Length over the cap without reading a byte", async () => {
    const { body, cancelled } = trackedBody([Uint8Array.of(1, 2, 3, 4)]);
    const res = new Response(body, { headers: { "content-length": "4" } });
    const error = await readBounded(res, 3, "test").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      kind: "invalid",
      code: "response_too_large",
      shouldRetry: false,
    });
    expect(cancelled()).toBe(true);
  });

  it("stops a body that grows past the cap mid-read and cancels the rest", async () => {
    // No Content-Length, as with a chunked reply: only the running count can tell.
    const { body, cancelled } = trackedBody([
      Uint8Array.of(1, 2),
      Uint8Array.of(3, 4),
      Uint8Array.of(5),
    ]);
    const error = await readBounded(new Response(body), 3, "test").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "invalid", code: "response_too_large" });
    expect(cancelled()).toBe(true);
  });

  it("accepts a body of exactly the cap", async () => {
    const res = new Response(trackedBody([Uint8Array.of(1, 2, 3)]).body);
    expect((await readBounded(res, 3, "test")).byteLength).toBe(3);
  });

  it("calls a read that dies network, so the caller's one-attempt rule can see it", async () => {
    const res = new Response(dyingBody(["abc"]));
    const error = await readBounded(res, 100, "test").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "network" });
    expect((error as ProviderError).cause).toBeInstanceOf(TypeError);
  });

  it("does not wrap a read that failed because the caller stopped", async () => {
    const controller = new AbortController();
    const stop = new Error("stopped");
    controller.abort(stop);
    const res = new Response(dyingBody([]));
    await expect(readBounded(res, 100, "test", controller.signal)).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe("postBytes", () => {
  it("returns the bytes and the bare media type", async () => {
    const out = await postBytes({
      ...opts(
        fetchReturning(
          new Response(Uint8Array.of(7, 8), {
            headers: { "content-type": "Audio/Mpeg; charset=x" },
          }),
        ),
      ),
      maxBytes: 10,
    });
    expect([...out.bytes]).toEqual([7, 8]);
    expect(out.contentType).toBe("audio/mpeg");
  });

  it("forwards redirect so a credential never follows a redirect", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen = init;
      return new Response(Uint8Array.of(1));
    }) as typeof fetch;
    await postBytes({ ...opts(fetchImpl), redirect: "error", maxBytes: 10 });
    expect(seen?.redirect).toBe("error");
  });

  it("leaves redirect to the runtime when the caller says nothing", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen = init;
      return new Response(Uint8Array.of(1));
    }) as typeof fetch;
    await postBytes({ ...opts(fetchImpl), maxBytes: 10 });
    expect(seen && "redirect" in seen).toBe(false);
  });

  it("classifies a non-2xx like postJson and keeps the provider's words by default", async () => {
    const res = new Response('{"error":{"message":"insufficient_quota for abc"}}', { status: 429 });
    const error = await postBytes({ ...opts(fetchReturning(res)), maxBytes: 10 }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ kind: "quota", status: 429 });
    expect((error as ProviderError).body).toContain("insufficient_quota");
  });

  it("keeps the kind and the wait but none of the provider's words when asked to redact", async () => {
    const res = new Response(
      '{"error":{"message":"The text you sent: Click Settings. is not allowed"}}',
      { status: 429, headers: { "retry-after": "7" } },
    );
    const error = await postBytes({
      ...opts(fetchReturning(res)),
      maxBytes: 10,
      redactErrors: true,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "rate", status: 429, retryAfterMs: 7000 });
    const failure = error as ProviderError;
    expect(failure.body).toBeUndefined();
    expect(failure.message).toBe("test 429");
    expect(JSON.stringify(failure)).not.toContain("Click Settings");
  });

  it("still reads the kind from the body when it redacts it", async () => {
    const res = new Response('{"error":{"message":"You exceeded your current quota"}}', {
      status: 429,
    });
    const error = await postBytes({
      ...opts(fetchReturning(res)),
      maxBytes: 10,
      redactErrors: true,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "quota" });
  });

  it("reads at most 64 KiB of an error body, and still classifies from its head", async () => {
    // A user-typed base URL can answer with an endless error. The kind is in the head.
    const head = '{"error":{"message":"You exceeded your current quota"}}';
    const { body, cancelled } = trackedBody([
      new TextEncoder().encode(head),
      new Uint8Array(200 * 1024).fill(32),
      new Uint8Array(200 * 1024).fill(32),
    ]);
    const error = await postBytes({
      ...opts(fetchReturning(new Response(body, { status: 429 }))),
      maxBytes: 10,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "quota" });
    expect(cancelled()).toBe(true);
  });

  it("calls a dropped socket network", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch; // a fetch that rejects the way undici does
    await expect(postBytes({ ...opts(fetchImpl), maxBytes: 10 })).rejects.toMatchObject({
      kind: "network",
    });
  });
});

describe("withDeadline", () => {
  it("returns what the call returns", async () => {
    expect(await withDeadline("test", 1000, undefined, async () => 42)).toBe(42);
  });

  it("turns OUR deadline into a timeout", async () => {
    const error = await withDeadline("test", 20, undefined, (signal) => waitFor(signal)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "timeout", provider: "test" });
  });

  it("never turns the caller's Stop into a timeout", async () => {
    const controller = new AbortController();
    const stop = new Error("stopped");
    const pending = withDeadline("test", 5000, controller.signal, (signal) => waitFor(signal));
    controller.abort(stop);
    await expect(pending).rejects.toBe(stop);
  });

  it("does not start the call when the caller already stopped", async () => {
    let started = false;
    const controller = new AbortController();
    controller.abort();
    await expect(
      withDeadline("test", 1000, controller.signal, async () => {
        started = true;
      }),
    ).rejects.toThrow();
    expect(started).toBe(false);
  });
});

/** A call that waits until its signal aborts, then fails with the signal's reason. */
function waitFor(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
