import type { FetchLike } from "@providerkit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatClient, TransportError, type ChatTransport } from "../src/client.ts";
import type { ChatEvent } from "../src/protocol.ts";
import { createSseTransport } from "../src/sse.ts";

const encoder = new TextEncoder();

/** A body that hands out one chunk per read, the way a socket delivers it. With `open`, it stays
 * open after its chunks until the request's signal aborts, like a fetch body does. */
function body(
  chunks: (string | Uint8Array)[],
  options: { open?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      options.open?.addEventListener("abort", () => controller.error(options.open?.reason));
    },
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined)
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      else if (!options.open) controller.close();
    },
  });
}

const sse = (stream: ReadableStream<Uint8Array>, status = 200) =>
  new Response(stream, { status, headers: { "content-type": "text/event-stream; charset=utf-8" } });

const json = (value: unknown, status: number) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

interface Sent {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: unknown;
}

/** A host's fetch that answers each request in turn and keeps what it was asked. */
function host(...answers: ((signal: AbortSignal | undefined) => Response | Promise<Response>)[]) {
  const sent: Sent[] = [];
  const fetch = vi.fn<FetchLike>(async (input, init) => {
    const raw = init?.body;
    sent.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    });
    const answer = answers.shift();
    if (!answer) throw new Error("The test host has no answer for this request.");
    return answer(init?.signal ?? undefined);
  });
  return { fetch, sent };
}

function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`The transport has no ${name}.`);
  return value;
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to fail.");
}

const signal = new AbortController().signal;

const runEvent = (status: string, seq: number) =>
  JSON.stringify({ v: 1, type: "run", run: { status }, seq, segment: "s1" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSseTransport", () => {
  it("lets the host put the cursor where its endpoint reads it", async () => {
    const { fetch, sent } = host(
      () => sse(body([])),
      () => sse(body([])),
    );
    const transport = createSseTransport({
      observe: (cursor) => {
        const headers: Record<string, string> = {};
        if (cursor) headers["Last-Event-ID"] = `${cursor.segment}:${cursor.seq}`;
        return {
          url: `https://host.test/chats/42/events?after=${cursor ? cursor.seq : ""}`,
          headers,
        };
      },
      fetch,
    });
    const observe = need(transport.observe, "observe");
    await collect(observe({ cursor: { segment: "s2", seq: 7 }, signal }));
    await collect(observe({ signal }));
    expect(sent[0]).toMatchObject({
      url: "https://host.test/chats/42/events?after=7",
      method: "GET",
      body: undefined,
    });
    expect(sent[0]?.headers.get("last-event-id")).toBe("s2:7");
    expect(sent[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(sent[1]?.url).toBe("https://host.test/chats/42/events?after=");
    expect(sent[1]?.headers.has("last-event-id")).toBe(false);
  });

  it("reads events whose frames break anywhere across reads", async () => {
    // "é" is two bytes in UTF-8, and this read ends between them.
    const accented = encoder.encode(
      '\ndata: {"v":1,"type":"text","messageId":"a1","partId":"t1","delta":"café"}\n\n',
    );
    const split = accented.indexOf(0xa9);
    const { fetch } = host(() =>
      sse(
        body([
          ": keep-alive\n\n",
          `id: 1\nevent: chat\ndata: ${runEvent("running", 1).slice(0, 30)}`,
          `${runEvent("running", 1).slice(30)}\r`,
          "\n\r",
          accented.slice(0, split),
          accented.slice(split),
          ": still here\n\n",
          // The last event, with no blank line after it before the body ends.
          `data: ${runEvent("completed", 2)}`,
        ]),
      ),
    );
    const transport = createSseTransport({ observe: () => "https://host.test/events", fetch });
    expect(await collect(need(transport.observe, "observe")({ signal }))).toEqual([
      { v: 1, type: "run", run: { status: "running" }, seq: 1, segment: "s1" },
      { v: 1, type: "text", messageId: "a1", partId: "t1", delta: "café" },
      { v: 1, type: "run", run: { status: "completed" }, seq: 2, segment: "s1" },
    ]);
  });

  it("skips a frame that is not an event and keeps reading", async () => {
    const { fetch } = host(() =>
      sse(
        body([
          "data: not json\n\n",
          'data: {"v":2,"type":"run","run":{"status":"running"}}\n\n',
          'data: {"v":1,"type":"run","run":{"status":"sleeping"}}\n\n',
          `data: ${runEvent("completed", 3)}\n\n`,
        ]),
      ),
    );
    const transport = createSseTransport({ observe: () => "https://host.test/events", fetch });
    expect(await collect(need(transport.observe, "observe")({ signal }))).toEqual([
      { v: 1, type: "run", run: { status: "completed" }, seq: 3, segment: "s1" },
    ]);
  });

  it("posts a message as JSON and reads the reply stream", async () => {
    const { fetch, sent } = host(() => sse(body([`data: ${runEvent("running", 1)}\n\n`])));
    const transport = createSseTransport({ send: () => "https://host.test/messages", fetch });
    const reply = await need(transport.send, "send")({ clientId: "c1", text: "Hi" }, { signal });
    expect(sent[0]).toMatchObject({ method: "POST", body: { clientId: "c1", text: "Hi" } });
    expect(sent[0]?.headers.get("content-type")).toBe("application/json");
    expect(sent[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(await collect(need(reply ?? undefined, "reply").events)).toHaveLength(1);
  });

  it("reads any other success as the host taking the command, and sends each default body", async () => {
    const { fetch, sent } = host(
      () => json({ accepted: true }, 202),
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 200 }),
    );
    const transport: ChatTransport = createSseTransport({
      send: (input) => ({
        url: "https://host.test/messages",
        headers: { "x-chat": "42" },
        body: { message: input },
      }),
      respond: () => "https://host.test/answers",
      stop: (run) => `https://host.test/runs/${run.id}/stop`,
      fetch,
    });
    expect(
      await need(transport.send, "send")({ clientId: "c1", text: "Hi" }, { signal }),
    ).toBeUndefined();
    const answers = [{ requestId: "op1", response: { type: "approve" as const } }];
    expect(await need(transport.respond, "respond")(answers, { signal })).toBeUndefined();
    await need(transport.stop, "stop")({ id: "run-7", status: "running" });
    expect(
      sent.map(({ url, method, body: sentBody }) => ({ url, method, body: sentBody })),
    ).toEqual([
      {
        url: "https://host.test/messages",
        method: "POST",
        body: { message: { clientId: "c1", text: "Hi" } },
      },
      { url: "https://host.test/answers", method: "POST", body: { answers } },
      {
        url: "https://host.test/runs/run-7/stop",
        method: "POST",
        body: { run: { id: "run-7", status: "running" } },
      },
    ]);
    expect(sent[0]?.headers.get("x-chat")).toBe("42");
  });

  it("calls a 4xx refused, in the host's own words when it sends them", async () => {
    const { fetch } = host(
      () => json({ error: { code: "busy", message: "A run is already going." } }, 409),
      () =>
        new Response("<h1>Forbidden</h1>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
      () => json({ code: "slow_down", message: "Too many messages." }, 429),
    );
    const transport = createSseTransport({ send: () => "https://host.test/messages", fetch });
    const send = need(transport.send, "send");
    const input = { clientId: "c1", text: "Hi" };

    const busy = await failureOf(send(input, { signal }));
    expect(busy).toBeInstanceOf(TransportError);
    expect(busy).toMatchObject({
      outcome: "refused",
      error: { code: "busy", message: "A run is already going." },
    });
    expect(await failureOf(send(input, { signal }))).toMatchObject({
      outcome: "refused",
      error: { code: "http_403", message: "The server turned down the request (error 403)." },
    });
    // A throttle refused before doing anything, so a later try can work.
    expect(await failureOf(send(input, { signal }))).toMatchObject({
      outcome: "refused",
      error: { code: "slow_down", retryable: true },
    });
  });

  it("calls a 5xx or a lost connection unknown, and lets the client's own abort through", async () => {
    const offline = new TypeError("Failed to fetch");
    const aborted = new AbortController();
    const { fetch } = host(
      () => new Response("upstream down", { status: 503 }),
      () => {
        throw offline;
      },
      () => {
        aborted.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    );
    const transport = createSseTransport({ send: () => "https://host.test/messages", fetch });
    const send = need(transport.send, "send");
    const input = { clientId: "c1", text: "Hi" };
    expect(await failureOf(send(input, { signal }))).toMatchObject({
      outcome: "unknown",
      error: { code: "http_503" },
    });
    expect(await failureOf(send(input, { signal }))).toMatchObject({
      outcome: "unknown",
      error: { code: "network" },
      cause: offline,
    });
    const abort = await failureOf(send(input, { signal: aborted.signal }));
    expect(abort).not.toBeInstanceOf(TransportError);
    expect(abort).toMatchObject({ name: "AbortError" });
  });

  it("refuses an observation that is not an event stream, and takes a 204 as nothing to send", async () => {
    const { fetch } = host(
      () =>
        new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response(null, { status: 204 }),
    );
    const transport = createSseTransport({ observe: () => "https://host.test/events", fetch });
    const observe = need(transport.observe, "observe");
    expect(await failureOf(collect(observe({ signal })))).toMatchObject({
      outcome: "refused",
      error: { code: "not_event_stream" },
    });
    expect(await collect(observe({ signal }))).toEqual([]);
  });

  it("stops reading when the client aborts", async () => {
    const reading = new AbortController();
    const { fetch } = host((requestSignal) =>
      sse(body([`data: ${runEvent("running", 1)}\n\n`], { open: requestSignal })),
    );
    const transport = createSseTransport({ observe: () => "https://host.test/events", fetch });
    const events = need(
      transport.observe,
      "observe",
    )({ signal: reading.signal })[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ type: "run", seq: 1 });
    const next = events.next();
    reading.abort();
    expect(await failureOf(next)).toMatchObject({ name: "AbortError" });
  });

  it("offers only the commands it has a request for, and reads the global fetch when called", async () => {
    const transport = createSseTransport({ observe: () => "https://host.test/events" });
    expect(Object.keys(transport)).toEqual(["observe"]);
    const fetch = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    expect(await collect(need(transport.observe, "observe")({ signal }))).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads a stream's error frame as a lost connection, never as the run's verdict", async () => {
    // A host can write `event: error` when its own read of the run fails, and the run keeps going.
    // So the client reattaches after its cursor, and the run's status stays the host's last word.
    vi.useFakeTimers();
    try {
      const { fetch, sent } = host(
        () =>
          sse(
            body([
              `data: ${runEvent("running", 1)}\n\n`,
              'event: error\ndata: {"message":"The read failed."}\n\n',
            ]),
          ),
        () => sse(body([`data: ${runEvent("completed", 2)}\n\n`])),
      );
      const client = createChatClient({
        transport: createSseTransport({
          observe: (cursor) => `https://host.test/events?after=${cursor?.seq ?? ""}`,
          fetch,
        }),
      });
      client.attach();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getState()).toMatchObject({
        run: { status: "running" },
        status: "running",
        connection: "reconnecting",
      });
      expect(client.getState().run.error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent[1]?.url).toBe("https://host.test/events?after=1");
      expect(client.getState()).toMatchObject({ run: { status: "completed" }, connection: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });
});
