// The wire. One `fetch`, one SSE reader, one error envelope — no vendor SDK,
// no Node built-ins, so the same build runs in Bun, Node, Workers, Deno and an
// MV3 service worker.
//
// Adapters keep only their per-event mapping; everything about being an HTTP
// client lives here once.
import { classifyHttp, parseRetryAfterMs, ProviderError } from "./errors.ts";
import {
  parseRateLimitReset,
  parseRateLimitResponse,
  type RateLimitReading,
} from "./rate-limit.ts";

export interface RequestInit_ {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  /** Names the provider in the error envelope. */
  provider: string;
  signal?: AbortSignal;
  /** Swapped in tests, or to route through a proxy. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Called when the response headers arrive and on every body read after,
   *  keep-alives included. What the watchdog's idle clock runs on. */
  onActivity?: () => void;
  /** Called when the body states `[DONE]`. See `SseHooks.onDone`. */
  onDone?: () => void;
  /** Called when the response headers report how full a subscription window
   *  is. See `StreamOptions.onRateLimit`. */
  onRateLimit?: (reading: RateLimitReading) => void;
}

export interface SseHooks {
  /** Every read of the body, keep-alives and partial frames included: the
   *  stream is alive even when no event is complete yet. */
  onActivity?: () => void;
  /**
   * The body said `[DONE]`. The payload itself is swallowed, but its arrival is
   * the OpenAI dialect's only proof that a stream which stated no finish reason
   * was not simply cut off.
   */
  onDone?: () => void;
  /** Largest partial frame held before giving up. Defaults to 8 MiB. */
  maxFrameChars?: number;
  /** Names the provider on the oversized-frame error. */
  provider?: string;
}

/**
 * One frame larger than this is not a frame. Without a cap a malformed or
 * runaway upstream grows the buffer until the runtime dies, starting with an
 * MV3 worker. cc-proxy caps the ChatGPT backend at the same 8 MiB.
 */
export const MAX_SSE_FRAME_CHARS = 8 * 1024 * 1024;

/** Join a base URL and a path without doubling or dropping the slash. */
export function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * How long the provider says to wait, read from the RESPONSE rather than from
 * a thrown error. Headers are authoritative: `Retry-After` first, then the
 * vendor reset headers that name a subscription window rather than a
 * per-minute throttle, because "try again in a moment" is a lie for those.
 */
export function retryAfterFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  // `retry-after-ms`, then `Retry-After` as seconds (fractions included), a
  // duration or an HTTP-date — one parser for both modules. This one used to
  // test for digits and hand anything else to `Date.parse`, which reads "1.5"
  // as a day in 2001: a wait of zero, and an immediate retry into the throttle.
  const asked = parseRateLimitReset(headers, now).retryAfterMs;
  if (asked !== undefined) return asked;
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
  const kind = classifyHttp(res.status, text);
  // A window-reset header describes the ACCOUNT, not this failure, and only a
  // throttle or a quota answer is about the window. Claude OAuth stamps the
  // unified reset on every response, so read on any status a 529 said "lifts in
  // three days": past every retry budget, and the backup walker benched the
  // model until the weekly window rolled — the overload that most wants another
  // attempt got none. A server's own Retry-After is honoured on any status.
  const aboutWindow = kind === "rate" || kind === "quota";
  const reset = aboutWindow ? parseRateLimitResponse(res.headers, text) : {};
  const asked = aboutWindow
    ? retryAfterFromHeaders(res.headers)
    : parseRateLimitReset(res.headers).retryAfterMs;
  const message = text
    ? `${provider} ${res.status}: ${text.slice(0, 500)}`
    : `${provider} ${res.status} ${res.statusText}`;
  const shouldRetryHeader = res.headers.get("x-should-retry");
  const shouldRetry =
    shouldRetryHeader === "false" ? false : shouldRetryHeader === "true" ? true : undefined;
  return new ProviderError(provider, kind, message, {
    status: res.status,
    ...reset,
    shouldRetry,
    retryAfterMs: asked ?? parseRetryAfterMs({}, text),
    body: text.slice(0, 2_000) || undefined,
  });
}

async function send(opts: RequestInit_): Promise<Response> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  // Serialized outside the catch below: a body that cannot become JSON is a
  // bug of ours, and must not be dressed as a network blip and retried.
  const body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  try {
    return await doFetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body,
      signal: opts.signal,
    });
  } catch (err) {
    // An aborted signal passes through untouched: the caller's Stop stays
    // `aborted`, and the watchdog re-issues its own abort as `timeout`
    // (invariant 2). Every other rejection means no response came back, so it
    // is a transport failure whatever its wording. Matching known wordings
    // missed each runtime's next one, and a missed one was never retried: a
    // long run died on its first blip. cc-proxy reads every failed send the
    // same way.
    if (opts.signal?.aborted) throw err;
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

/** Pull the `data:` payload out of one SSE frame, joining continuation lines
 *  the way the spec says to. Returns null for a comment or a frame carrying
 *  only an `event:` name. */
function payloadOf(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    parts.push(line.slice(5).replace(/^ /, ""));
  }
  // Gemini abandons the framing to report a mid-stream failure: the
  // google.rpc.Status is appended as a bare JSON object with no `data:` on
  // it. Dropped here it never reaches an adapter, and a 429 or a 503 that
  // lands after the headers reads as an empty, successful turn. Requiring an
  // object keeps comments and `event:`-only frames returning null.
  if (parts.length === 0) {
    const bare = frame.trim();
    return bare.startsWith("{") ? bare : null;
  }
  const payload = parts.join("\n").trim();
  return payload.length > 0 ? payload : null;
}

/**
 * Yield each `data:` payload of an SSE body, trimmed, plus the bare JSON
 * object a vendor appends outside the framing, which is only ever an error
 * (see `payloadOf`).
 *
 * Frames are split on the blank line the spec requires, so a payload containing
 * a bare newline survives; `[DONE]` is swallowed here rather than in every
 * adapter, and reported through `hooks.onDone`. CRLF and bare CR are
 * normalized: some gateways send them, and a `\r` left on the end of a JSON
 * payload is a parse error nobody enjoys debugging.
 *
 * Exported apart from `streamSse` because the envelope above it is the half an
 * adopting app most often cannot take: an app with its own translated error
 * copy, its own log levels, or its own auth refresh has to keep building the
 * request and reading the failure itself. Framing is the half nobody should
 * write twice. Hand it a `res.body` and keep your own envelope.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  hooks: SseHooks = {},
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const maxFrame = hooks.maxFrameChars ?? MAX_SSE_FRAME_CHARS;
  let buffer = "";
  // A CR at the very end of a read may be the first half of a CRLF; it waits
  // for the next read before it is turned into a line break.
  let heldCR = false;

  function* emit(frame: string): Generator<string> {
    const payload = payloadOf(frame);
    if (payload === "[DONE]") hooks.onDone?.();
    else if (payload !== null) yield payload;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hooks.onActivity?.();
      let text: string = (heldCR ? "\r" : "") + decoder.decode(value, { stream: true });
      heldCR = text.endsWith("\r");
      if (heldCR) text = text.slice(0, -1);
      // Line endings are normalized on the new text only, CRLF and the bare CR
      // the spec also allows. Normalizing the whole buffer on every read made a
      // multi-megabyte frame quadratic; normalizing each read on its own, with
      // no carry, strands the CR of a CRLF split across reads — a JSON parse
      // error that only reproduces under one packet split.
      text = text.replace(/\r\n?/g, "\n");
      // The boundary may straddle the join, so the search starts one char back.
      let from = Math.max(0, buffer.length - 1);
      buffer += text;

      let boundary = buffer.indexOf("\n\n", from);
      while (boundary !== -1) {
        yield* emit(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        from = 0;
        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > maxFrame) {
        throw new ProviderError(
          hooks.provider ?? "sse",
          "overload",
          `an SSE frame grew past ${maxFrame} characters without ending`,
          { shouldRetry: false },
        );
      }
    }
    // A stream that ends without its final blank line still has an event in
    // hand — dropping it loses the last delta, or the usage record.
    yield* emit(buffer + decoder.decode() + (heldCR ? "\n" : ""));
  } finally {
    reader.releaseLock();
  }
}

/**
 * POST an SSE request and stream its payloads: the envelope (auth, the
 * classified error, the retry hints) plus `parseSseStream`.
 */
export async function* streamSse(opts: RequestInit_): AsyncGenerator<string> {
  const res = await send(opts);
  // Headers are the first sign of life — the idle clock starts here, not at
  // the POST: a backend that withholds them until its first output token (the
  // ChatGPT backend does, for minutes on a large high-effort turn) is working.
  opts.onActivity?.();
  // The window's fill rides every response, the ones that go through too.
  // Read only off a refusal, a caller learns the window was filling once it
  // is already full.
  if (opts.onRateLimit) {
    const reading = parseRateLimitReset(res.headers);
    const { utilization, resetAtMs } = reading;
    if (utilization !== undefined && resetAtMs !== undefined) {
      opts.onRateLimit({ ...reading, utilization, resetAtMs });
    }
  }
  if (!res.ok) throw await errorFor(opts.provider, res);
  // A 2xx with no body at all is an upstream anomaly, not a request we got
  // wrong — worth the same retry a 5xx gets.
  if (!res.body) {
    throw new ProviderError(opts.provider, "overload", `${opts.provider}: empty response body`, {
      status: res.status,
    });
  }
  yield* parseSseStream(res.body, opts);
}
