/**
 * A transport for React Native: the request builders of `@providerkit/react/sse`, over two
 * functions the app passes in. `open` reads an event stream, and `command` sends one request.
 *
 * React Native 0.86 cannot read a fetch body as it arrives. Its `fetch` resolves only once the
 * whole response is in, and Hermes has no `TextDecoder`. XMLHttpRequest progress events do
 * arrive, and a phone app already reads its streams that way, through a reader that holds its
 * session and its token refresh. A second reader here would drift from that one, so the app keeps
 * its reader and its API client, and this file keeps the rules every phone needs the same way:
 * which failure is a refusal, and when a stream ends so the client can pick up from its cursor.
 *
 * Because `fetch` waits for the whole response, a command cannot carry the stream. The server
 * answers `send` and `respond` with a short receipt, and the events arrive on `observe`.
 *
 * No retry loop here: the client already reattaches from its cursor, with backoff, and stops on a
 * refusal. A second loop would retry what the client is already retrying.
 */
import type {
  ChatEvent,
  ChatTransport,
  Cursor,
  RequestAnswer,
  RunInfo,
  SendInput,
} from "@providerkit/react";
import { parseChatEvent } from "@providerkit/react/protocol";

/** Where a request goes, as a builder returns it: the shapes `@providerkit/react/sse` takes, with
 * headers as a plain object, the form a React Native stream reader takes. An address alone uses
 * the method and the body in the table on `SseTransportOptions`. */
export type SseRequest =
  | string
  | URL
  | {
      url: string | URL;
      /** Defaults to GET without a body and POST with one. */
      method?: string;
      headers?: Record<string, string>;
      /** Any JSON value. Defaults to the command's own value from the table. */
      body?: unknown;
    };

/** A request as `open` and `command` receive it, with the defaults filled in. */
export interface NativeRequest {
  url: string;
  method: string;
  /** Lowercase names. `accept` is set, and `content-type` when there is a body, unless the builder
   * set them. */
  headers: Record<string, string>;
  /** The JSON value to send. Absent for GET and HEAD. */
  body?: unknown;
}

/** What `open` calls as its stream goes. Nothing needs to be called after `abort()`. */
export interface StreamHandlers {
  /** One frame's `data`, as text. Hand over every frame, even one this version cannot read. */
  onData(data: string): void;
  /** The stream failed. A `TransportError` with `refused` says the server turned it down, as a 4xx
   * does, and the client stops trying unless `error.retryable` says a later try can work. Anything
   * else is a lost connection, and the client tries again from its cursor. */
  onError(error: unknown): void;
  /** The stream ended. Calling it after `onError` is fine. */
  onClose(): void;
}

/** Opens one stream. Calling `abort()` on what it returns closes it. */
export type OpenStream = (request: NativeRequest, handlers: StreamHandlers) => { abort(): void };

/** Sends one command and resolves once the server took it. Throw a `TransportError` with `refused`
 * when the server turned it down, as a 4xx does, and the client takes the command back. Anything
 * else thrown is an unknown outcome: the server may have acted, so the client never sends it again
 * on its own. */
export type SendCommand = (
  request: NativeRequest,
  options: { signal?: AbortSignal },
) => Promise<unknown>;

/**
 * One builder per command, the same as `@providerkit/react/sse`, so a web build and a phone build
 * can share them. A command without one is one this transport cannot do, and the client does not
 * offer it.
 *
 * | Builder   | Method | Default body    | A success is                         |
 * | --------- | ------ | --------------- | ------------------------------------ |
 * | `observe` | GET    | none            | frames through `open`, then a close  |
 * | `send`    | POST   | the `SendInput` | `command` resolving, with a receipt  |
 * | `respond` | POST   | `{ answers }`   | `command` resolving, with a receipt  |
 * | `stop`    | POST   | `{ run }`       | `command` resolving                  |
 */
export interface SseTransportOptions {
  /** The stream after `cursor`, or from the start without one. */
  observe?: (cursor: Cursor | undefined) => SseRequest;
  send?: (input: SendInput) => SseRequest;
  respond?: (answers: readonly RequestAnswer[]) => SseRequest;
  stop?: (run: RunInfo) => SseRequest;
  /** Reads one event stream: your app's reader over XMLHttpRequest, with its session. */
  open: OpenStream;
  /** Sends one command: your app's API client, so sign-in and token refresh stay in one place. */
  command: SendCommand;
  /** How much frame data, in characters, one stream reads before it ends. XMLHttpRequest keeps the
   * whole response in memory until the request ends, so a long stream keeps growing the app's
   * memory. At this size the stream ends, and while the run goes on the client reconnects from its
   * cursor after its first wait (one second by default). Default 1,000,000, about 1 to 2 MB. */
  maxStreamChars?: number;
}

const EVENT_STREAM = "text/event-stream";
// A command's reply is a receipt. A server that serves the web too can tell from this header not to
// answer with the stream: React Native's fetch would hand it over only once the run had ended.
const RECEIPT = "application/json";

const DEFAULT_MAX_STREAM_CHARS = 1_000_000;

/** The request a builder described, with the defaults of the table filled in. */
function prepare(spec: SseRequest, fallback: unknown, accept: string): NativeRequest {
  const {
    url,
    method,
    headers = {},
    body = fallback,
  } = typeof spec === "object" && "url" in spec ? spec : { url: spec };
  const verb = (method ?? (body === undefined ? "GET" : "POST")).toUpperCase();
  // A GET carries no body, even the default one: fetch refuses it, and XMLHttpRequest drops it.
  const sends = body !== undefined && verb !== "GET" && verb !== "HEAD";
  const named: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) named[name.toLowerCase()] = value;
  named.accept ??= accept;
  if (sends) named["content-type"] ??= "application/json";
  return { url: String(url), method: verb, headers: named, ...(sends && { body }) };
}

/** A frame's event, or nothing for data that is not a valid event. It is skipped, the same as an
 * event type this version does not know: a newer server must not break an older app, and a part
 * that streams arrives whole again when it settles. */
function eventOf(data: string): ChatEvent | undefined {
  try {
    return parseChatEvent(JSON.parse(data)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A transport that reads streams through the app's `open` and sends commands through its
 * `command`. */
export function createSseTransport(options: SseTransportOptions): ChatTransport {
  const {
    observe,
    send,
    respond,
    stop,
    open,
    command,
    maxStreamChars = DEFAULT_MAX_STREAM_CHARS,
  } = options;
  if (!(maxStreamChars > 0)) throw new RangeError("maxStreamChars must be a number above zero.");

  async function call(spec: SseRequest, fallback: unknown, signal?: AbortSignal): Promise<void> {
    await command(prepare(spec, fallback, RECEIPT), { signal });
  }

  /** One stream, as the events the client reads. It ends quietly once the client aborts `signal`,
   * and throws what `open` reported when the stream failed. */
  async function* events(build: () => SseRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    if (signal.aborted) return;
    const request = prepare(build(), undefined, EVENT_STREAM);
    const frames: string[] = [];
    // Set when the stream said it ended, by closing or failing, and once this side stops reading.
    // A frame that comes after it is dropped.
    let ended = false;
    // Boxed, so a reader that fails with `undefined` still counts as a failure, not a clean end.
    let failure: { error: unknown } | undefined;
    let wake: (() => void) | undefined;
    function nudge(): void {
      const resume = wake;
      wake = undefined;
      resume?.();
    }
    function end(error?: { error: unknown }): void {
      if (ended) return;
      ended = true;
      failure = error;
      nudge();
    }
    let stream: { abort(): void } | undefined;
    try {
      stream = open(request, {
        onData(data) {
          if (ended) return;
          frames.push(data);
          nudge();
        },
        onError(error) {
          end({ error });
        },
        onClose() {
          end();
        },
      });
    } catch (error) {
      end({ error });
    }
    // React Native's AbortSignal is a polyfill without `reason` or `throwIfAborted`: `aborted` and
    // the abort event are all there is.
    signal.addEventListener("abort", nudge);
    let read = 0;
    try {
      while (!signal.aborted) {
        const data = frames.shift();
        if (data === undefined) {
          if (ended) {
            if (failure) throw failure.error;
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        read += data.length;
        const event = eventOf(data);
        if (event) yield event;
        // Past the budget the stream ends here, and the client reattaches from its cursor.
        if (read >= maxStreamChars) return;
      }
    } finally {
      signal.removeEventListener("abort", nudge);
      const live = !ended;
      ended = true;
      if (live) stream?.abort();
    }
  }

  const transport: ChatTransport = {};
  if (observe) transport.observe = ({ cursor, signal }) => events(() => observe(cursor), signal);
  if (send)
    transport.send = async (input, { signal }) => {
      await call(send(input), input, signal);
    };
  if (respond)
    transport.respond = async (answers, { signal }) => {
      await call(respond(answers), { answers }, signal);
    };
  if (stop)
    transport.stop = async (run) => {
      await call(stop(run), { run });
    };
  return transport;
}
