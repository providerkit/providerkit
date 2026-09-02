// The wire. One `fetch`, one SSE reader, one error envelope — no vendor SDK,
// no Node built-ins, so the same build runs in Bun, Node, Workers, Deno and an
// MV3 service worker.
//
// Adapters keep only their per-event mapping; everything about being an HTTP
// client lives here once.
import { classify, isTransportFailure, ProviderError } from "./errors.ts";

export interface RequestInit_ {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  /** Names the provider in the error envelope. */
  provider: string;
  signal?: AbortSignal;
  /** Swapped in tests, or to route through a proxy. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * How long the provider says to wait, read from the RESPONSE rather than from
 * a thrown error. Headers are authoritative — `Retry-After` first, then the
 * vendor reset headers that name a subscription window rather than a
 * per-minute throttle, because "try again in a moment" is a lie for those.
 */
export function retryAfterFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  // Anthropic and several gateways publish an epoch-seconds reset instead.
  for (const name of [
    "anthropic-ratelimit-unified-reset",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset",
  ]) {
    const value = headers.get(name);
    if (!value) continue;
    if (/^\d+$/.test(value)) {
      const seconds = Number(value);
      // Epoch seconds (a big number) or a relative count — tell them apart by
      // magnitude rather than by trusting one vendor's convention.
      const ms = seconds > 1_000_000_000 ? seconds * 1000 - now : seconds * 1000;
      if (ms > 0) return ms;
    }
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  return undefined;
}

/** Turn a non-2xx response into the classified error every caller branches on. */
async function errorFor(provider: string, res: Response): Promise<ProviderError> {
  const text = await res.text().catch(() => "");
  const kind = classify({ status: res.status, error: text }, res.status, text);
  const message = text
    ? `${provider} ${res.status}: ${text.slice(0, 500)}`
    : `${provider} ${res.status} ${res.statusText}`;
  return new ProviderError(provider, kind, message, {
    status: res.status,
    retryAfterMs: retryAfterFromHeaders(res.headers),
    body: text.slice(0, 2_000) || undefined,
  });
}

async function send(opts: RequestInit_): Promise<Response> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  try {
    return await doFetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    // A stopped run rejects here too, and that is not a failure — let it pass
    // through untouched. Anything that is not a recognizable transport
    // rejection is a bug of ours and keeps its own loud shape.
    if (opts.signal?.aborted || !isTransportFailure(err)) throw err;
    throw new ProviderError(opts.provider, "network", `no response from ${opts.url}`, {
      cause: err,
    });
  }
}

/** POST and parse one JSON response. For the endpoints that do not stream. */
export async function postJson<T = unknown>(opts: RequestInit_): Promise<T> {
  const res = await send(opts);
  if (!res.ok) throw await errorFor(opts.provider, res);
  return (await res.json()) as T;
}

/**
 * POST an SSE request and yield each `data:` payload, trimmed.
 *
 * Frames are split on the blank line the spec requires, so a payload
 * containing a bare newline survives; `[DONE]` is swallowed here rather than in
 * every adapter. CRLF is normalized — some gateways send it, and a `\r` left on
 * the end of a JSON payload is a parse error nobody enjoys debugging.
 */
export async function* streamSse(opts: RequestInit_): AsyncGenerator<string> {
  const res = await send(opts);
  if (!res.ok) throw await errorFor(opts.provider, res);
  // A 2xx with no body at all is an upstream anomaly, not a request we got
  // wrong — worth the same retry a 5xx gets.
  if (!res.body) {
    throw new ProviderError(opts.provider, "overload", `${opts.provider}: empty response body`, {
      status: res.status,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /** Pull the `data:` payload out of one SSE frame, joining continuation
   *  lines the way the spec says to. Returns null for a comment or a frame
   *  carrying only an `event:` name. */
  function payloadOf(frame: string): string | null {
    const parts: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      parts.push(line.slice(5).replace(/^ /, ""));
    }
    if (parts.length === 0) return null;
    const payload = parts.join("\n").trim();
    return payload.length > 0 ? payload : null;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = payloadOf(frame);
        if (payload !== null && payload !== "[DONE]") yield payload;
        boundary = buffer.indexOf("\n\n");
      }
    }
    // A stream that ends without its final blank line still has an event in
    // hand — dropping it loses the last delta, or the usage record.
    const tail = payloadOf(buffer);
    if (tail !== null && tail !== "[DONE]") yield tail;
  } finally {
    reader.releaseLock();
  }
}
