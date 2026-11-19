import {
  createChatClient,
  TransportError,
  type ChatClient,
  type ChatTransport,
  type Cursor,
  type RequestAnswer,
} from "@providerkit/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSseTransport, type SendCommand } from "../src/transport.ts";
import { at, delta, drain, need, noCommand, reader, run, status, writing } from "./fakes.ts";

const signal = new AbortController().signal;

describe("createSseTransport", () => {
  it("builds each request the way @providerkit/react/sse does", async () => {
    const host = reader();
    const command = vi.fn<SendCommand>(async () => ({ received: true }));
    const transport = createSseTransport({
      observe: (cursor) => `https://host.test/chats/42/events?after=${cursor?.seq ?? ""}`,
      send: () => new URL("https://host.test/chats/42/messages"),
      respond: () => ({
        url: "https://host.test/chats/42/answers",
        headers: { Authorization: "Bearer token" },
      }),
      stop: () => ({
        url: "https://host.test/chats/42/stop",
        method: "put",
        headers: { Accept: "text/plain" },
        body: { reason: "person" },
      }),
      open: host.open,
      command,
    });
    const reading = drain(need(transport.observe, "observe")({ cursor: { seq: 7 }, signal }));
    host.latest().handlers.onClose();
    await reading;
    expect(host.latest().request).toEqual({
      url: "https://host.test/chats/42/events?after=7",
      method: "GET",
      headers: { accept: "text/event-stream" },
    });

    const json = { accept: "application/json", "content-type": "application/json" };
    const input = { clientId: "c1", text: "Hello" };
    expect(await need(transport.send, "send")(input, { signal })).toBeUndefined();
    expect(command).toHaveBeenLastCalledWith(
      { url: "https://host.test/chats/42/messages", method: "POST", headers: json, body: input },
      { signal },
    );
    const answers: RequestAnswer[] = [{ requestId: "q1", response: { type: "approve" } }];
    await need(transport.respond, "respond")(answers, { signal });
    expect(command).toHaveBeenLastCalledWith(
      {
        url: "https://host.test/chats/42/answers",
        method: "POST",
        headers: { ...json, authorization: "Bearer token" },
        body: { answers },
      },
      { signal },
    );
    await need(transport.stop, "stop")(run("running"));
    expect(command).toHaveBeenLastCalledWith(
      {
        url: "https://host.test/chats/42/stop",
        method: "PUT",
        headers: { accept: "text/plain", "content-type": "application/json" },
        body: { reason: "person" },
      },
      { signal: undefined },
    );
  });

  it("sends no body with a GET, even one the builder set", async () => {
    const host = reader();
    const transport = createSseTransport({
      observe: () => ({ url: "https://host.test/events", method: "get", body: { ignored: true } }),
      open: host.open,
      command: noCommand,
    });
    const reading = drain(need(transport.observe, "observe")({ signal }));
    host.latest().handlers.onClose();
    await reading;
    expect(host.latest().request).toEqual({
      url: "https://host.test/events",
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
  });

  it("offers only the commands it has a builder for", () => {
    const transport = createSseTransport({
      observe: () => "https://host.test/events",
      open: reader().open,
      command: noCommand,
    });
    expect(Object.keys(transport)).toEqual(["observe"]);
  });

  it("hands the client each frame that is an event, and skips the rest", async () => {
    const host = reader();
    const transport = createSseTransport({
      observe: () => "https://host.test/events",
      open: host.open,
      command: noCommand,
    });
    const reading = drain(need(transport.observe, "observe")({ signal }));
    const { handlers } = host.latest();
    handlers.onData(JSON.stringify(status(run("running"), at(1))));
    // A heartbeat, bad JSON, the data of an `event: error` frame, and a newer protocol version.
    handlers.onData('{"type":"heartbeat"}');
    handlers.onData("not json");
    handlers.onData('{"message":"The read failed."}');
    handlers.onData(JSON.stringify({ ...status(run("running"), at(2)), v: 2 }));
    handlers.onData(JSON.stringify(status(run("completed"), at(3))));
    handlers.onClose();
    expect(await reading).toEqual({
      delivered: [status(run("running"), at(1)), status(run("completed"), at(3))],
      error: undefined,
    });
    // It ended on its own, so there was nothing to abort.
    expect(host.latest().aborted).toBe(false);
  });

  it("passes a refusal through unchanged, after the frames that came before it", async () => {
    const host = reader();
    const transport = createSseTransport({
      observe: () => "https://host.test/events",
      open: host.open,
      command: noCommand,
    });
    const refusal = new TransportError("refused", {
      code: "gone",
      message: "This conversation was deleted.",
    });
    const reading = drain(need(transport.observe, "observe")({ signal }));
    host.push(status(run("running"), at(1)));
    // The reader reports a failure and then the close, as a reader over XMLHttpRequest does.
    host.latest().handlers.onError(refusal);
    host.latest().handlers.onClose();
    expect(await reading).toEqual({ delivered: [status(run("running"), at(1))], error: refusal });
  });

  it("passes any other failure through for the client to read as a lost connection", async () => {
    const lost = new Error("The stream lost its connection");
    const host = reader();
    const transport = createSseTransport({
      observe: () => "https://host.test/events",
      open: host.open,
      command: noCommand,
    });
    const reading = drain(need(transport.observe, "observe")({ signal }));
    host.latest().handlers.onError(lost);
    expect((await reading).error).toBe(lost);

    const throwing = createSseTransport({
      observe: () => "https://host.test/events",
      open: () => {
        throw lost;
      },
      command: noCommand,
    });
    expect((await drain(need(throwing.observe, "observe")({ signal }))).error).toBe(lost);
  });

  it("closes the stream when the client stops reading, and delivers nothing after", async () => {
    const host = reader();
    const transport = createSseTransport({
      observe: () => "https://host.test/events",
      open: host.open,
      command: noCommand,
    });
    const reading = new AbortController();
    const events = need(transport.observe, "observe")({ signal: reading.signal });
    const iterator = events[Symbol.asyncIterator]();
    const first = iterator.next();
    host.push(status(run("running"), at(1)));
    expect((await first).value).toMatchObject({ type: "run", seq: 1 });
    const waiting = iterator.next();
    reading.abort();
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(host.latest().aborted).toBe(true);
    host.push(status(run("completed"), at(2)));
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("opens nothing for a client that already stopped reading", async () => {
    const host = reader();
    const transport = createSseTransport({
      observe: () => "https://host.test/events",
      open: host.open,
      command: noCommand,
    });
    const stopped = new AbortController();
    stopped.abort();
    expect(await drain(need(transport.observe, "observe")({ signal: stopped.signal }))).toEqual({
      delivered: [],
      error: undefined,
    });
    expect(host.open).not.toHaveBeenCalled();
  });

  it("ends a stream once its frames reach maxStreamChars", async () => {
    const host = reader();
    const first = JSON.stringify(writing("Hel", at(1)));
    const second = JSON.stringify(status(run("running"), at(2)));
    const transport = createSseTransport({
      observe: () => "https://host.test/events",
      open: host.open,
      command: noCommand,
      maxStreamChars: first.length + second.length,
    });
    const reading = drain(need(transport.observe, "observe")({ signal }));
    const { handlers } = host.latest();
    handlers.onData(first);
    handlers.onData(second);
    handlers.onData(JSON.stringify(delta("lo", at(3))));
    expect((await reading).delivered).toEqual([
      writing("Hel", at(1)),
      status(run("running"), at(2)),
    ]);
    expect(host.latest().aborted).toBe(true);
  });

  it("refuses a stream budget that is not a number above zero", () => {
    for (const maxStreamChars of [0, -1, Number.NaN])
      expect(() =>
        createSseTransport({ open: reader().open, command: noCommand, maxStreamChars }),
      ).toThrow(RangeError);
  });
});

describe("createSseTransport with the client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs everything already due: promise callbacks, and timers at zero. */
  const flush = () => vi.advanceTimersByTimeAsync(0);

  const events = (cursor: Cursor | undefined) =>
    `https://host.test/events?segment=${cursor?.segment ?? ""}&after=${cursor?.seq ?? ""}`;

  function textOf(client: ChatClient): string | undefined {
    const message = client.getState().messages.find((item) => item.id === "a1");
    const part = message?.parts.find((item) => item.id === "t1");
    return part?.type === "text" ? part.text : undefined;
  }

  function chat(transport: ChatTransport, options: { allowSendWhileRunning?: boolean } = {}) {
    const client = createChatClient({ transport, ...options });
    const detach = client.attach();
    return { client, detach };
  }

  it("ends a long stream at maxStreamChars, and the client picks up from its cursor", async () => {
    const host = reader();
    const first = JSON.stringify(writing("Hel", at(1)));
    const second = JSON.stringify(status(run("running"), at(2)));
    const { client, detach } = chat(
      createSseTransport({
        observe: events,
        open: host.open,
        command: noCommand,
        maxStreamChars: first.length + second.length,
      }),
    );
    await flush();
    host.latest().handlers.onData(first);
    host.latest().handlers.onData(second);
    await flush();
    expect(host.opened[0]?.aborted).toBe(true);
    expect(client.getState()).toMatchObject({ status: "running", connection: "reconnecting" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.opened).toHaveLength(2);
    expect(host.latest().request.url).toBe("https://host.test/events?segment=s1&after=2");
    host.push(delta("lo", at(3)));
    await flush();
    expect(textOf(client)).toBe("Hello");
    detach();
  });

  it("takes a refused message back, and keeps one whose outcome is unknown", async () => {
    const command = vi
      .fn<SendCommand>()
      .mockRejectedValueOnce(
        new TransportError("refused", { code: "too_long", message: "This message is too long." }),
      )
      .mockRejectedValueOnce(new Error("Network request failed"));
    const { client, detach } = chat(
      createSseTransport({
        send: () => "https://host.test/messages",
        open: reader().open,
        command,
      }),
    );
    expect(await client.send("First")).toMatchObject({
      ok: false,
      error: { code: "too_long" },
      input: { text: "First" },
    });
    expect(await client.send("Second")).toMatchObject({ ok: true, outcome: "unknown" });
    detach();
  });

  // The four rules a phone app learned on its own event stream (the client's own tests pin them),
  // through this transport: none of them may depend on the stream being a fetch body.
  it("resumes a conversation with a past after its saved position, never from the start", async () => {
    const host = reader();
    const client = createChatClient({
      transport: createSseTransport({ observe: events, open: host.open, command: noCommand }),
      initialMessages: [{ id: "a0", role: "assistant", state: "settled", parts: [] }],
      initialCursor: { segment: "s0", seq: 41 },
    });
    const detach = client.attach();
    await flush();
    expect(host.latest().request.url).toBe("https://host.test/events?segment=s0&after=41");
    detach();
  });

  it("keeps watching for the run a message started when the stream ends on an earlier run's end", async () => {
    const host = reader();
    const command = vi.fn<SendCommand>(async () => ({ received: true }));
    const { client, detach } = chat(
      createSseTransport({
        observe: events,
        send: () => "https://host.test/messages",
        open: host.open,
        command,
      }),
      { allowSendWhileRunning: true },
    );
    await flush();
    host.push(writing("Hel", at(1)), status(run("running"), at(2)));
    await flush();
    expect(await client.send("And then?")).toMatchObject({ ok: true, outcome: "accepted" });
    // The run before it ends, and the stream closes before the new run says a word.
    host.push(status(run("completed"), at(3)));
    host.latest().handlers.onClose();
    await flush();
    expect(client.getState()).toMatchObject({ status: "sending", connection: "reconnecting" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.latest().request.url).toBe("https://host.test/events?segment=s1&after=3");
    host.push(status(run("running", "run-2"), at(1, "s2")));
    await flush();
    expect(client.getState()).toMatchObject({ status: "running", run: { id: "run-2" } });
    detach();
  });

  it("reads a stream's error frame as a lost connection, never as the run's verdict", async () => {
    const host = reader();
    const { client, detach } = chat(
      createSseTransport({ observe: events, open: host.open, command: noCommand }),
    );
    await flush();
    host.push(writing("Hel", at(1)), status(run("running"), at(2)));
    // A host writes `event: error` when its own read of the run fails, and the run keeps going.
    // The reader hands over that frame's data like any other.
    host.latest().handlers.onData('{"message":"The read failed."}');
    host.latest().handlers.onClose();
    await flush();
    expect(client.getState()).toMatchObject({ status: "running", connection: "reconnecting" });
    expect(client.getState().run.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.latest().request.url).toBe("https://host.test/events?segment=s1&after=2");
    host.push(status(run("completed"), at(3)));
    await flush();
    expect(client.getState().run.status).toBe("completed");
    detach();
  });

  it("offers Retry for an unconfirmed message only once the run it may have started ends", async () => {
    const host = reader();
    const command = vi
      .fn<SendCommand>()
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValue({ received: true });
    const { client, detach } = chat(
      createSseTransport({
        observe: events,
        send: () => "https://host.test/messages",
        open: host.open,
        command,
      }),
    );
    await flush();
    const first = await client.send("Did this arrive?");
    if (!first.ok) throw new Error("An unknown outcome keeps the message.");
    expect(first.outcome).toBe("unknown");
    await flush();
    // The lost reply may have started a run, so the client reads the host again before Retry.
    host.push(status(run("running", "run-2"), at(1)));
    await flush();
    expect(client.getState().canRetry).toBe(false);
    host.push(status(run("completed", "run-2"), at(2)));
    await flush();
    expect(client.getState().canRetry).toBe(true);
    expect(await client.retry(first.messageId)).toMatchObject({ ok: true, outcome: "accepted" });
    expect(command.mock.calls[1]?.[0].body).toEqual(command.mock.calls[0]?.[0].body);
    detach();
  });
});
