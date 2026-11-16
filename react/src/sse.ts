/**
 * A transport over plain HTTP: each command is one request, and an event stream is a
 * `text/event-stream` response, framed by core's SSE parser.
 *
 * The host builds every request, so it keeps its own routes, its own auth (pass your `fetch`) and
 * its own place for the cursor: a query parameter, a `Last-Event-ID` header or a body. The cursor
 * also travels inside each event's JSON (`seq` and `segment`), because the parser reads only
 * `data:` lines and drops SSE `id:` fields.
 *
 * Loads `@providerkit/core` and nothing from React, which is why it is an entry of its own.
 */
import { parseSseStream, type FetchLike } from "@providerkit/core";
import {
  TransportError,
  type ChatTransport,
  type EventReply,
  type RequestAnswer,
  type SendInput,
} from "./client.ts";
import { parseChatEvent, type ChatEvent, type DisplayError, type RunInfo } from "./protocol.ts";
import { isRecord, type Cursor } from "./state.ts";

/** Where a request goes. An address alone uses the method and the body in the table on
 * `SseTransportOptions`. */
export type SseRequest =
  | string
  | URL
  | {
      url: string | URL;
      /** Defaults to GET without a body and POST with one. */
      method?: string;
      headers?: HeadersInit;
      /** Any JSON value, sent as JSON. Defaults to the command's own value from the table. */
      body?: unknown;
    };

/**
 * One builder per command. A command without one is one this transport cannot do, and the client
 * does not offer it.
 *
 * | Builder   | Method | Default body       | A success is                                   |
 * | --------- | ------ | ------------------ | ---------------------------------------------- |
 * | `observe` | GET    | none               | an event stream, or a 204 with nothing to send |
 * | `send`    | POST   | the `SendInput`    | the event stream, or anything else when taken  |
 * | `respond` | POST   | `{ answers }`      | the event stream, or anything else when taken  |
 * | `stop`    | POST   | `{ run }`          | any 2xx                                         |
 *
 * A 4xx means the host refused and did nothing, and a JSON body of `{ code, message }` (or
 * `{ error: { code, message } }`) becomes the error shown. A 5xx or a lost connection means the
 * outcome is unknown.
 */
export interface SseTransportOptions {
  /** The stream after `cursor`, or from the start without one. */
  observe?: (cursor: Cursor | undefined) => SseRequest;
  send?: (input: SendInput) => SseRequest;
  respond?: (answers: readonly RequestAnswer[]) => SseRequest;
  stop?: (run: RunInfo) => SseRequest;
  /** Every request goes through it. Pass your own to add auth, cookies or a base URL. Defaults to
   * the global `fetch`. */
  fetch?: FetchLike;
}

const EVENT_STREAM = "text/event-stream";

const UNREACHABLE: DisplayError = Object.freeze({
  code: "network",
  message: "Could not reach the server. Check your connection and try again.",
});

// A deterministic answer, such as an HTML page from a route that does not exist, so trying again
// would fail the same way.
const NOT_A_STREAM: DisplayError = Object.freeze({
  code: "not_event_stream",
  message: "The server did not answer with an event stream.",
});

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().startsWith(EVENT_STREAM) === true;
}

/** Lets go of a body nobody will read, so the connection is free now, not whenever it is
 * collected. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => {});
}

/** The host's own words for a failure, when it sent them in the protocol's error shape. */
async function hostError(response: Response): Promise<DisplayError | undefined> {
  if (response.headers.get("content-type")?.toLowerCase().includes("json") !== true) {
    discard(response);
    return undefined;
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return undefined;
  }
  const said = isRecord(value) && isRecord(value.error) ? value.error : value;
  if (!isRecord(said) || typeof said.code !== "string" || !said.code) return undefined;
  if (typeof said.message !== "string") return undefined;
  const error: DisplayError = { code: said.code, message: said.message };
  if (typeof said.retryable === "boolean") error.retryable = said.retryable;
  return error;
}

async function failure(response: Response): Promise<TransportError> {
  const { status } = response;
  const said = await hostError(response);
  if (status >= 400 && status < 500) {
    const error = said ?? {
      code: `http_${status}`,
      message: `The server turned down the request (error ${status}).`,
    };
    // A timeout and a throttle refuse before doing anything, so a later try can work.
    const later = (status === 408 || status === 429) && error.retryable === undefined;
    return new TransportError("refused", later ? { ...error, retryable: true } : error);
  }
  return new TransportError(
    "unknown",
    said ?? { code: `http_${status}`, message: `The server had a problem (error ${status}).` },
  );
}

/** Every `data:` payload that is a valid event. A payload that is not one is skipped, the same as
 * an event type this version does not know: a newer host must not break an older client, and a
 * part that streams arrives whole again when it settles. */
async function* eventsOf(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  for await (const payload of parseSseStream(body)) {
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      continue;
    }
    const event = parseChatEvent(value);
    if (event) yield event;
  }
}

/** A transport that speaks HTTP and Server-Sent Events. */
export function createSseTransport(options: SseTransportOptions): ChatTransport {
  const request: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function call(
    spec: SseRequest,
    fallback: unknown,
    accept: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const {
      url,
      method,
      headers,
      body = fallback,
    } = typeof spec === "string" || spec instanceof URL ? { url: spec } : spec;
    const verb = (method ?? (body === undefined ? "GET" : "POST")).toUpperCase();
    // A GET carries no body, even the default one: `fetch` refuses the request outright.
    const payload = body !== undefined && verb !== "GET" && verb !== "HEAD";
    const head = new Headers(headers);
    if (accept && !head.has("accept")) head.set("accept", accept);
    if (payload && !head.has("content-type")) head.set("content-type", "application/json");
    let response: Response;
    try {
      response = await request(url, {
        method: verb,
        headers: head,
        ...(payload && { body: JSON.stringify(body) }),
        ...(signal && { signal }),
      });
    } catch (error) {
      // The client's own abort: it no longer reads, so this is not a failure to report.
      if (signal?.aborted) throw error;
      throw new TransportError("unknown", UNREACHABLE, { cause: error });
    }
    if (!response.ok) throw await failure(response);
    return response;
  }

  /** A command's reply: the stream when the host sent one, otherwise nothing more to read. */
  function replyOf(response: Response): EventReply | undefined {
    if (response.body && isEventStream(response)) return { events: eventsOf(response.body) };
    discard(response);
    return undefined;
  }

  const transport: ChatTransport = {};
  const { observe, send, respond, stop } = options;
  if (observe)
    transport.observe = async function* ({ cursor, signal }) {
      const response = await call(observe(cursor), undefined, EVENT_STREAM, signal);
      if (response.status === 204) return discard(response);
      if (!response.body || !isEventStream(response)) {
        discard(response);
        throw new TransportError("refused", NOT_A_STREAM);
      }
      yield* eventsOf(response.body);
    };
  if (send)
    transport.send = async (input, { signal }) =>
      replyOf(await call(send(input), input, EVENT_STREAM, signal));
  if (respond)
    transport.respond = async (answers, { signal }) =>
      replyOf(await call(respond(answers), { answers }, EVENT_STREAM, signal));
  if (stop)
    transport.stop = async (run) => {
      discard(await call(stop(run), { run }, undefined, undefined));
    };
  return transport;
}
