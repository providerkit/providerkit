import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatClient,
  TransportError,
  type ChatClient,
  type ChatTransport,
  type EventReply,
} from "../src/client.ts";
import { useChat } from "../src/hooks.ts";
import type {
  ApprovalPart,
  ChatEvent,
  DisplayMessage,
  DisplayPart,
  RunInfo,
  RunStatus,
  TextPart,
  ToolPart,
} from "../src/protocol.ts";
import type { Cursor } from "../src/state.ts";

type Item = { event: ChatEvent } | { end: true } | { error: unknown };

/** An event stream the test writes by hand. Opened with a signal, it fails once the client aborts
 * it, the way a fetch body does. Opened without one, it keeps delivering, the way a transport
 * that ignores its signal would. */
class Feed implements AsyncIterable<ChatEvent> {
  readonly #items: Item[] = [];
  #wake: (() => void) | undefined;
  aborted = false;

  constructor(signal?: AbortSignal) {
    signal?.addEventListener("abort", () => {
      this.aborted = true;
      this.fail(new DOMException("The client stopped reading.", "AbortError"));
    });
  }

  #add(item: Item): this {
    this.#items.push(item);
    this.#wake?.();
    return this;
  }

  push(...events: ChatEvent[]): this {
    for (const event of events) this.#add({ event });
    return this;
  }

  end(): this {
    return this.#add({ end: true });
  }

  fail(error: unknown): this {
    return this.#add({ error });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ChatEvent> {
    for (;;) {
      const item = this.#items.shift();
      if (!item) {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        continue;
      }
      if ("error" in item) throw item.error;
      if ("end" in item) return;
      yield item.event;
    }
  }
}

/** A host's tail: every observation the client opens, newest last. */
function tail(options: { honorsAbort?: boolean } = {}) {
  const opened: { cursor: Cursor | undefined; feed: Feed }[] = [];
  const observe = vi.fn((request: { cursor?: Cursor; signal: AbortSignal }) => {
    const feed = new Feed(options.honorsAbort === false ? undefined : request.signal);
    opened.push({ cursor: request.cursor, feed });
    return feed;
  });
  function latest(): Feed {
    const last = opened.at(-1);
    if (!last) throw new Error("The client opened no observation.");
    return last.feed;
  }
  return { observe, opened, latest };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Runs everything already due: promise callbacks, and timers at zero. */
const flush = () => vi.advanceTimersByTimeAsync(0);

type Where = { seq?: number; segment?: string };
const at = (seq: number, segment = "s1"): Where => ({ seq, segment });

const text = (id: string, value: string, settled = false): TextPart => ({
  type: "text",
  id,
  text: value,
  settled,
});
const tool = (id: string, state: ToolPart["state"] = "running"): ToolPart => ({
  type: "tool",
  id,
  label: "Searching the docs",
  state,
});
const approval = (id: string, state: ApprovalPart["state"] = "pending"): ApprovalPart => ({
  type: "approval",
  id,
  title: "Send the email?",
  state,
});
const assistant = (
  id: string,
  parts: DisplayPart[] = [],
  state: DisplayMessage["state"] = "live",
): DisplayMessage => ({ id, role: "assistant", parts, state });
const user = (id: string, value: string, clientId?: string): DisplayMessage => ({
  id,
  role: "user",
  parts: [text(`${id}-text`, value, true)],
  state: "settled",
  ...(clientId === undefined ? {} : { clientId }),
});
const run = (status: RunStatus, id = "run-1"): RunInfo => ({ id, status, messageId: "a1" });

const put = (message: DisplayMessage, where: Where = {}): ChatEvent => ({
  v: 1,
  type: "message",
  message,
  ...where,
});
const patch = (messageId: string, part: DisplayPart, where: Where = {}): ChatEvent => ({
  v: 1,
  type: "part",
  messageId,
  part,
  ...where,
});
const delta = (messageId: string, partId: string, value: string, where: Where = {}): ChatEvent => ({
  v: 1,
  type: "text",
  messageId,
  partId,
  delta: value,
  ...where,
});
const status = (info: RunInfo, where: Where = {}): ChatEvent => ({
  v: 1,
  type: "run",
  run: info,
  ...where,
});
const snapshot = (messages: DisplayMessage[], info: RunInfo, where: Where = {}): ChatEvent => ({
  v: 1,
  type: "snapshot",
  messages,
  run: info,
  ...where,
});

/** The opening of a run that is writing: seq 1 to 3 in segment s1. */
const writingRun = (): ChatEvent[] => [
  put(assistant("a1", [text("t1", "Hel")]), at(1)),
  status(run("running"), at(2)),
  delta("a1", "t1", "lo", at(3)),
];

function find(client: ChatClient, id: string): DisplayMessage | undefined {
  return client.getState().messages.find((message) => message.id === id);
}

function textOf(client: ChatClient, messageId: string, partId: string): string | undefined {
  const part = find(client, messageId)?.parts.find((item) => item.id === partId);
  return part?.type === "text" ? part.text : undefined;
}

type Send = NonNullable<ChatTransport["send"]>;
type Respond = NonNullable<ChatTransport["respond"]>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("observing", () => {
  it("takes an event the host sends twice only once", async () => {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe } });
    client.attach();
    host.latest().push(...writingRun(), delta("a1", "t1", "lo", at(3)));
    await flush();
    expect(textOf(client, "a1", "t1")).toBe("Hello");
    expect(client.getState().connection).toBe("open");
    // React compares snapshots by identity: an event that changes nothing must hand out the same one.
    const before = client.getState();
    host.latest().push(delta("a1", "t1", "lo", at(2)), status(run("running")));
    await flush();
    expect(client.getState()).toBe(before);
  });

  it("reattaches after its cursor when a stream ends while the run is going", async () => {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe } });
    client.attach();
    host
      .latest()
      .push(...writingRun())
      .end();
    await flush();
    expect(client.getState().connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(host.opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.opened).toHaveLength(2);
    expect(host.opened[1]?.cursor).toEqual({ segment: "s1", seq: 3 });
    // What arrived before the cut stays on screen while the client reattaches.
    expect(textOf(client, "a1", "t1")).toBe("Hello");
  });

  it("backs off 1, 2, 4, 8 and 15 seconds, then counts the connection as lost", async () => {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe } });
    client.attach();
    host
      .latest()
      .push(...writingRun())
      .end();
    await flush();
    for (const wait of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      const before = host.opened.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(host.opened).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(host.opened).toHaveLength(before + 1);
      // A host that accepts the connection and closes it again, with nothing to say.
      host.latest().end();
      await flush();
    }
    const state = client.getState();
    expect(state.connection).toBe("lost");
    expect(state.error?.code).toBe("connection_lost");
    expect(state.canReconnect).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.opened).toHaveLength(6);

    client.reconnect();
    expect(host.opened).toHaveLength(7);
    expect(client.getState().connection).toBe("connecting");
    expect(client.getState().error).toBeUndefined();
  });

  it("does not refill the budget for a connection that only repeats what the client has", async () => {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe } });
    client.attach();
    host
      .latest()
      .push(...writingRun())
      .end();
    await flush();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      host
        .latest()
        .push(delta("a1", "t1", "lo", at(3)))
        .end();
      await flush();
    }
    expect(client.getState().connection).toBe("lost");
    expect(textOf(client, "a1", "t1")).toBe("Hello");
  });

  it("advances the cursor without refilling the budget for unchanged run events", async () => {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe } });
    client.attach();
    host
      .latest()
      .push(status(run("running"), at(1)))
      .end();
    await flush();
    for (const [index, wait] of [1_000, 2_000, 4_000, 8_000, 15_000].entries()) {
      await vi.advanceTimersByTimeAsync(wait);
      expect(host.opened[index + 1]?.cursor).toEqual({ segment: "s1", seq: index + 1 });
      host
        .latest()
        .push(status(run("running"), at(index + 2)))
        .end();
      await flush();
    }
    expect(client.getState().connection).toBe("lost");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.opened).toHaveLength(6);
    client.reconnect();
    expect(host.opened[6]?.cursor).toEqual({ segment: "s1", seq: 6 });
  });

  it.each(["end", "fail"] as const)(
    "releases every observation's signal and port listener on %s",
    async (ending) => {
      const host = tail();
      const port = new EventTarget();
      const listener = vi.fn();
      const signals: AbortSignal[] = [];
      const client = createChatClient({
        transport: {
          observe(options) {
            const onMessage = () => listener();
            signals.push(options.signal);
            port.addEventListener("message", onMessage);
            options.signal.addEventListener("abort", () =>
              port.removeEventListener("message", onMessage),
            );
            return host.observe(options);
          },
        },
      });
      const detach = client.attach();
      host.latest().push(status(run("running")));
      for (const wait of [0, 1_000, 2_000, 4_000, 8_000, 15_000]) {
        await vi.advanceTimersByTimeAsync(wait);
        if (ending === "end") host.latest().end();
        else host.latest().fail(new Error("Connection closed."));
        await flush();
      }
      expect(client.getState().connection).toBe("lost");
      detach();
      port.dispatchEvent(new Event("message"));
      expect(signals).toHaveLength(6);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(listener).not.toHaveBeenCalled();
    },
  );

  it("retries an empty first observation, then offers manual recovery", async () => {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe } });
    client.attach();
    host.latest().end();
    await flush();
    expect(client.getState().connection).toBe("reconnecting");
    for (const wait of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await vi.advanceTimersByTimeAsync(wait);
      host.latest().end();
      await flush();
    }
    expect(client.getState()).toMatchObject({ connection: "lost", canReconnect: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.opened).toHaveLength(6);
    client.reconnect();
    host
      .latest()
      .push(snapshot([], run("completed")))
      .end();
    await flush();
    expect(client.getState()).toMatchObject({ connection: "idle", run: { status: "completed" } });
  });

  it.each(["idle", "completed"] as const)(
    "does not retry an authoritative %s snapshot with no messages",
    async (state) => {
      const host = tail();
      const client = createChatClient({ transport: { observe: host.observe } });
      client.attach();
      // An idle snapshot can equal the initial view, but it still confirms the host was read.
      host
        .latest()
        .push(snapshot([], { status: state }))
        .end();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.getState().connection).toBe("idle");
      expect(host.opened).toHaveLength(1);
      expect(host.latest().aborted).toBe(true);
    },
  );

  it("refills the budget when a try brings something new", async () => {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe } });
    client.attach();
    host
      .latest()
      .push(...writingRun())
      .end();
    await flush();
    // Three empty tries: the next wait would be 8 seconds.
    for (const wait of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(wait);
      host.latest().end();
      await flush();
    }
    await vi.advanceTimersByTimeAsync(8_000);
    host
      .latest()
      .push(delta("a1", "t1", "!", at(4)))
      .end();
    await flush();
    const before = host.opened.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.opened).toHaveLength(before + 1);
    expect(textOf(client, "a1", "t1")).toBe("Hello!");
  });

  it("does not reattach a stream that ended because the run waits for the person", async () => {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe } });
    client.attach();
    host
      .latest()
      .push(put(assistant("a1", [approval("op1")]), at(1)), status(run("waiting"), at(2)))
      .end();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.opened).toHaveLength(1);
    expect(client.getState()).toMatchObject({ connection: "idle", status: "waiting" });
  });

  it("gives up at once on an observation the host refuses, and retries one it throttles", async () => {
    const refused = tail();
    refused.observe.mockImplementationOnce(() => {
      throw new TransportError("refused", { code: "forbidden", message: "Sign in again." });
    });
    const client = createChatClient({ transport: { observe: refused.observe } });
    client.attach();
    await flush();
    expect(client.getState()).toMatchObject({
      connection: "lost",
      error: { code: "forbidden", message: "Sign in again." },
      canReconnect: true,
    });

    const throttled = tail();
    throttled.observe.mockImplementationOnce(() => {
      throw new TransportError("refused", {
        code: "http_429",
        message: "Slow down.",
        retryable: true,
      });
    });
    const other = createChatClient({ transport: { observe: throttled.observe } });
    other.attach();
    await flush();
    expect(other.getState().connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(throttled.observe).toHaveBeenCalledTimes(2);
  });

  it("drops a late event from a segment the view moved on from", async () => {
    const host = tail();
    const respond = vi.fn<Respond>(async () => {});
    const client = createChatClient({ transport: { observe: host.observe, respond } });
    client.attach();
    host
      .latest()
      .push(
        put(assistant("a1", [text("t1", "Before.", true), approval("op1")]), at(1)),
        status(run("waiting"), at(2)),
      )
      .end();
    await flush();
    const before = find(client, "a1")?.parts[0];

    await client.respond("op1", { type: "approve" });
    expect(host.opened[1]?.cursor).toEqual({ segment: "s1", seq: 2 });
    // The approval continued the run in a new segment: the count starts again, the view stays.
    host
      .latest()
      .push(
        patch("a1", tool("op1"), at(1, "s2")),
        status(run("running"), at(2, "s2")),
        patch("a1", text("t2", "After"), at(3, "s2")),
      );
    await flush();
    expect(find(client, "a1")?.parts[0]).toBe(before);
    expect(client.getState().status).toBe("running");

    // The rest of a stream from before the approval, still on its way.
    host.latest().push(status(run("completed"), at(7, "s1")), delta("a1", "t2", "!", at(8, "s1")));
    await flush();
    expect(client.getState().run.status).toBe("running");
    expect(textOf(client, "a1", "t2")).toBe("After");

    host.latest().end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.opened[2]?.cursor).toEqual({ segment: "s2", seq: 3 });
  });

  it("drops whatever a detached client's stream still sends, and the next client never sees it", async () => {
    const host = tail({ honorsAbort: false });
    const transport: ChatTransport = { observe: host.observe };
    const first = createChatClient({ transport });
    const detach = first.attach();
    host.latest().push(put(assistant("a1", [text("t1", "First chat")])), status(run("running")));
    await flush();
    detach();

    const second = createChatClient({ transport });
    second.attach();
    host.opened[0]?.feed.push(put(assistant("late", [text("t9", "Late")])));
    host
      .latest()
      .push(
        snapshot(
          [assistant("b1", [text("t2", "Second chat", true)], "settled")],
          run("completed", "run-2"),
        ),
      );
    await flush();
    expect(first.getState().messages.map((message) => message.id)).toEqual(["a1"]);
    expect(second.getState().messages.map((message) => message.id)).toEqual(["b1"]);
  });

  it("tells listeners once per frame, however many deltas arrive in it", async () => {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe } });
    const listener = vi.fn();
    client.subscribe(listener);
    client.attach();
    host.latest().push(...writingRun());
    for (let index = 0; index < 50; index += 1)
      host.latest().push(delta("a1", "t1", ".", at(4 + index)));
    await flush();
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(textOf(client, "a1", "t1")).toBe(`Hello${".".repeat(50)}`);
  });
});

describe("sending", () => {
  it("shows the message at once, and removes it with its text given back when the host refuses", async () => {
    const call = deferred<void>();
    const send = vi.fn<Send>(() => call.promise);
    const client = createChatClient({ transport: { send } });
    const pending = client.send("Hello");
    expect(client.getState().messages).toMatchObject([{ role: "user", state: "sending" }]);
    expect(client.getState().status).toBe("sending");
    call.reject(new TransportError("refused", { code: "too_long", message: "That is too long." }));
    const result = await pending;
    expect(result).toEqual({
      ok: false,
      error: { code: "too_long", message: "That is too long." },
      input: { clientId: send.mock.calls[0]?.[0].clientId, text: "Hello" },
    });
    expect(client.getState()).toMatchObject({ messages: [], status: "ready" });
  });

  it("keeps a send whose outcome is unknown, marked failed, and never sends it again on its own", async () => {
    const host = tail();
    const send = vi.fn<Send>(async () => {
      throw new Error("socket hang up");
    });
    const client = createChatClient({ transport: { send, observe: host.observe } });
    client.attach();
    host
      .latest()
      .push(snapshot([], run("completed", "run-0")))
      .end();
    await flush();

    const result = await client.send("Hello");
    if (!result.ok) throw new Error("An unknown outcome keeps the message.");
    const { messageId } = result;
    expect(find(client, messageId)?.state).toBe("failed");
    expect(client.getState().messageErrors[messageId]?.code).toBe("unconfirmed");
    // The host's word on it arrives on an observation.
    expect(host.opened).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);

    // A read from before the host had it does not make it vanish.
    host.latest().push(snapshot([], run("completed", "run-0")));
    await flush();
    expect(find(client, messageId)?.state).toBe("failed");

    // The host's copy carries the id the client made: it arrived.
    const clientId = send.mock.calls[0]?.[0].clientId;
    host.latest().push(snapshot([user("m1", "Hello", clientId)], run("running", "run-1")));
    await flush();
    expect(client.getState().messages.map((message) => message.id)).toEqual(["m1"]);
    expect(client.getState().messageErrors).toEqual({});
  });

  it("sends an unconfirmed message again, with the same client id, only when asked", async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(undefined);
    const client = createChatClient({ transport: { send } });
    const first = await client.send({ text: "Hello" });
    if (!first.ok) throw new Error("An unknown outcome keeps the message.");
    expect(await client.retry("someone-else")).toMatchObject({
      ok: false,
      error: { code: "not_unconfirmed" },
    });

    expect(await client.retry(first.messageId)).toEqual({ ok: true, messageId: first.messageId });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    expect(find(client, first.messageId)?.state).toBe("settled");
    expect(client.getState().messageErrors).toEqual({});
  });

  it("switches to observing when the reply stream ends before its run did", async () => {
    const host = tail();
    const send = vi.fn<Send>(async (_input, { signal }) => {
      const reply = new Feed(signal);
      reply.push(...writingRun()).end();
      return { events: reply };
    });
    const client = createChatClient({ transport: { send, observe: host.observe } });
    client.attach();
    host.latest().end();
    await flush();
    await client.send("Hi");
    await flush();
    expect(host.opened).toHaveLength(2);
    expect(host.opened[1]?.cursor).toEqual({ segment: "s1", seq: 3 });
    expect(textOf(client, "a1", "t1")).toBe("Hello");
  });

  it("without observe, keeps the text of a cut reply and says the connection is lost", async () => {
    const send = vi.fn<Send>(async (_input, { signal }) => {
      const reply = new Feed(signal);
      reply.push(...writingRun()).end();
      return { events: reply };
    });
    const client = createChatClient({ transport: { send } });
    await client.send("Hi");
    await flush();
    expect(client.getState()).toMatchObject({
      connection: "lost",
      error: { code: "connection_lost" },
      canReconnect: false,
      // A lost connection says nothing about whether the host stopped the run.
      canSend: false,
    });
    expect(textOf(client, "a1", "t1")).toBe("Hello");
  });

  it("counts a reply that never said a word about its run as cut", async () => {
    const host = tail();
    const send = vi.fn<Send>(async (input, { signal }) => {
      const reply = new Feed(signal);
      reply.push(put(user("m1", input.text, input.clientId))).end();
      return { events: reply };
    });
    const client = createChatClient({ transport: { send, observe: host.observe } });
    client.attach();
    host
      .latest()
      .push(snapshot([], run("completed", "run-0")))
      .end();
    await flush();
    await client.send("Hi");
    await flush();
    expect(host.opened).toHaveLength(2);
    expect(client.getState().messages.map((message) => message.id)).toEqual(["m1"]);
  });

  it("refuses a send while the run is going, unless the app lets it through", async () => {
    const host = tail();
    const send = vi.fn<Send>(async () => {});
    const client = createChatClient({ transport: { send, observe: host.observe } });
    client.attach();
    host.latest().push(...writingRun());
    await flush();
    expect(client.getState().canSend).toBe(false);
    expect(await client.send("And another thing")).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
    expect(send).not.toHaveBeenCalled();

    client.setOptions({
      transport: { send, observe: host.observe },
      allowSendWhileRunning: true,
    });
    expect(client.getState().canSend).toBe(true);
    expect((await client.send("And another thing")).ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not let a late command reply replace or abort a newer reply stream", async () => {
    const first = deferred<EventReply>();
    const signals: AbortSignal[] = [];
    const older = new Feed();
    const newer = new Feed();
    const send = vi.fn<Send>(async (_input, { signal }) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : { events: newer };
    });
    const client = createChatClient({ transport: { send }, allowSendWhileRunning: true });
    const pending = client.send("First");
    await client.send("Second");
    newer.push(status(run("running", "run-2")));
    await flush();

    first.resolve({ events: older });
    await pending;
    older.push(status(run("running", "run-1")));
    await flush();
    expect(signals[1]?.aborted).toBe(false);
    expect(client.getState().run.id).toBe("run-2");
    // The old POST may still be executing: drain it, but never apply it or stop it implicitly.
    expect(signals[0]?.aborted).toBe(false);
    older.end();
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    newer.push(status(run("completed", "run-2"))).end();
    await flush();
    expect(client.getState().status).toBe("ready");
  });

  it("keeps a superseded command stream draining without applying its events", async () => {
    const replies: Feed[] = [];
    const send = vi.fn<Send>(async (_input, { signal }) => {
      const reply = new Feed(signal);
      replies.push(reply);
      return { events: reply };
    });
    const client = createChatClient({ transport: { send }, allowSendWhileRunning: true });
    await client.send("First");
    replies[0]?.push(status(run("running", "run-1")));
    await flush();
    await client.send("Second");
    replies[1]?.push(status(run("running", "run-2")));
    await flush();
    expect(replies[0]?.aborted).toBe(false);
    replies[0]?.push(status(run("completed", "run-1"))).end();
    await flush();
    expect(client.getState().run.id).toBe("run-2");
    expect(replies[0]?.aborted).toBe(true);
    expect(replies[1]?.aborted).toBe(false);
  });

  it("keeps the active-run send guard when observation is lost", async () => {
    const host = tail();
    const send = vi.fn<Send>(async () => {});
    const transport = { send, observe: host.observe };
    const client = createChatClient({ transport, reconnect: { attempts: 0 } });
    client.attach();
    host
      .latest()
      .push(...writingRun())
      .end();
    await flush();
    expect(client.getState()).toMatchObject({ connection: "lost", canSend: false });
    expect(await client.send("Another message")).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
    expect(send).not.toHaveBeenCalled();
    client.setOptions({ transport, allowSendWhileRunning: true });
    expect((await client.send("Another message")).ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not wait again for a run the host reported before the send returned", async () => {
    const host = tail();
    const send = vi.fn<Send>(async (input) => {
      // The whole run arrives on the open observation while the call is still out.
      host
        .latest()
        .push(
          put(user("m1", input.text, input.clientId)),
          put(assistant("a1", [text("t1", "Done.", true)], "settled")),
          status(run("completed")),
        );
      await flush();
    });
    const client = createChatClient({ transport: { send, observe: host.observe } });
    client.attach();
    await flush();
    expect((await client.send("Hi")).ok).toBe(true);
    await flush();
    expect(client.getState()).toMatchObject({ status: "ready", canSend: true });
    expect(host.opened).toHaveLength(1);
  });

  it("refuses an empty message without calling the host", async () => {
    const send = vi.fn<Send>(async () => {});
    const client = createChatClient({ transport: { send } });
    expect(await client.send("   ")).toMatchObject({ ok: false, error: { code: "empty" } });
    expect(send).not.toHaveBeenCalled();
    const files = await client.send({
      attachments: [{ id: "f1", name: "plan.pdf", mediaType: "application/pdf" }],
    });
    expect(files.ok).toBe(true);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ text: "", attachments: [{ id: "f1" }] });
  });
});

describe("stopping", () => {
  it.each(["pending", "accepted"] as const)(
    "asks the host to stop a %s send before its first run event",
    async (phase) => {
      const host = tail();
      const call = deferred<void>();
      const send = vi.fn<Send>(() => call.promise);
      const stop = vi.fn(async () => {});
      const client = createChatClient({ transport: { send, observe: host.observe, stop } });
      client.attach();
      const pending = client.send("Hello");
      if (phase === "accepted") {
        call.resolve();
        await pending;
      }
      expect(client.getState()).toMatchObject({ status: "sending", canStop: true });
      expect(await client.stop()).toEqual({ ok: true });
      expect(stop).toHaveBeenCalledWith({ status: "idle" });
      expect(client.getState().status).toBe("stopping");
      expect(host.latest().aborted).toBe(false);
      expect(send.mock.calls[0]?.[1].signal.aborted).toBe(false);
      call.resolve();
      await pending;
      host.latest().push(status(run("stopped")));
      await flush();
      expect(client.getState()).toMatchObject({ status: "ready", run: { status: "stopped" } });
    },
  );

  it("without transport.stop, aborts a pending send and drops its late reply", async () => {
    const call = deferred<EventReply>();
    const send = vi.fn<Send>(() => call.promise);
    const host = tail();
    const client = createChatClient({ transport: { send, observe: host.observe } });
    client.attach();
    const pending = client.send("Hello");
    expect(client.getState().canStop).toBe(true);
    expect(await client.stop()).toEqual({ ok: true });
    expect(send.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(client.getState()).toMatchObject({ status: "ready", run: { status: "stopped" } });
    // Some transports ignore abort while waiting for headers. Their reply cannot revive the run.
    call.resolve({ events: new Feed().push(...writingRun()).end() });
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getState()).toMatchObject({ status: "ready", run: { status: "stopped" } });
    expect(find(client, "a1")).toBeUndefined();
    expect(host.opened).toHaveLength(1);
  });

  it("asks the host, then waits for it to say the run stopped, with the observation open", async () => {
    const host = tail();
    const call = deferred<void>();
    const stop = vi.fn(() => call.promise);
    const client = createChatClient({ transport: { observe: host.observe, stop } });
    client.attach();
    host.latest().push(...writingRun());
    await flush();
    expect(client.getState().canStop).toBe(true);

    const pending = client.stop();
    expect(client.getState().status).toBe("stopping");
    expect(stop).toHaveBeenCalledWith(run("running"));
    call.resolve();
    expect(await pending).toEqual({ ok: true });
    expect(client.getState().status).toBe("stopping");
    expect(host.latest().aborted).toBe(false);

    host.latest().push(status(run("stopped"), at(4)));
    await flush();
    expect(client.getState()).toMatchObject({ status: "ready", run: { status: "stopped" } });
  });

  it("says so when the stop does not go through, and the run goes on", async () => {
    const host = tail();
    const stop = vi.fn(async () => {
      throw new Error("offline");
    });
    const client = createChatClient({ transport: { observe: host.observe, stop } });
    client.attach();
    host.latest().push(...writingRun());
    await flush();
    expect(await client.stop()).toMatchObject({ ok: false, error: { code: "stop_failed" } });
    expect(client.getState()).toMatchObject({ status: "running", error: { code: "stop_failed" } });

    host.latest().push(status(run("completed"), at(4)));
    await flush();
    expect(client.getState().error).toBeUndefined();
  });

  it("without transport.stop, closes the reply stream and shows the run as stopped", async () => {
    let reply: Feed | undefined;
    const send = vi.fn<Send>(async () => {
      // A transport that ignores its signal: whatever it still delivers must be dropped.
      reply = new Feed();
      reply.push(...writingRun(), patch("a1", tool("op1")));
      return { events: reply };
    });
    const client = createChatClient({ transport: { send } });
    await client.send("Hi");
    await flush();
    expect(client.getState().canStop).toBe(true);

    expect(await client.stop()).toEqual({ ok: true });
    reply?.push(delta("a1", "t1", " there", at(5)), status(run("completed"), at(6)));
    await flush();
    const state = client.getState();
    expect(state).toMatchObject({
      status: "ready",
      connection: "idle",
      run: { status: "stopped" },
    });
    expect(find(client, "a1")).toMatchObject({
      state: "stopped",
      parts: [
        { id: "t1", text: "Hello", settled: true },
        { id: "op1", state: "failed" },
      ],
    });
  });

  it("will not claim to stop a run it only watches", async () => {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe } });
    client.attach();
    host.latest().push(...writingRun());
    await flush();
    expect(client.getState().canStop).toBe(false);
    expect(await client.stop()).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(client.getState().run.status).toBe("running");
    expect(host.latest().aborted).toBe(false);
  });
});

describe("answering", () => {
  async function waitingClient(respond: Respond) {
    const host = tail();
    const client = createChatClient({ transport: { observe: host.observe, respond } });
    client.attach();
    host
      .latest()
      .push(put(assistant("a1", [approval("op1")]), at(1)), status(run("waiting"), at(2)))
      .end();
    await flush();
    return { host, client };
  }

  it("shows an answer as submitting until a host event changes the request", async () => {
    const call = deferred<void | EventReply>();
    const respond = vi.fn<Respond>(() => call.promise);
    const { host, client } = await waitingClient(respond);
    expect(client.getState().requests).toMatchObject([{ messageId: "a1", part: { id: "op1" } }]);

    const pending = client.respond("op1", { type: "approve" });
    expect(client.getState().requests[0]?.local?.status).toBe("submitting");
    expect(await client.respond("op1", { type: "approve" })).toMatchObject({
      ok: false,
      error: { code: "answering" },
    });
    call.resolve();
    expect(await pending).toEqual({ ok: true });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toEqual([
      { requestId: "op1", response: { type: "approve" } },
    ]);
    // Accepted is not done: the mark stays until the host itself moves.
    expect(client.getState().requests[0]?.local?.status).toBe("submitting");
    expect(host.opened).toHaveLength(2);

    host.latest().push(patch("a1", tool("op1"), at(1, "s2")), status(run("running"), at(2, "s2")));
    await flush();
    expect(client.getState()).toMatchObject({ requests: [], status: "running" });
  });

  it("refreshes an open observation after approval to find the new segment", async () => {
    const host = tail({ honorsAbort: false });
    const respond = vi.fn<Respond>(async () => {});
    const client = createChatClient({ transport: { observe: host.observe, respond } });
    client.attach();
    const previous = host.latest();
    previous.push(
      put(assistant("a1", [text("t1", "Before.", true), approval("op1")]), at(9)),
      status(run("waiting"), at(10)),
    );
    await flush();
    const held = find(client, "a1")?.parts[0];
    expect(await client.respond("op1", { type: "approve" })).toEqual({ ok: true });
    expect(host.opened).toHaveLength(2);
    expect(host.observe.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(host.opened[1]?.cursor).toEqual({ segment: "s1", seq: 10 });
    expect(client.getState().requests[0]?.local?.status).toBe("submitting");
    host
      .latest()
      .push(patch("a1", tool("op1"), at(1, "s2")), status(run("running", "run-2"), at(2, "s2")));
    await flush();
    previous.push(status(run("waiting"), at(11)));
    await flush();
    expect(client.getState()).toMatchObject({
      requests: [],
      run: { id: "run-2", status: "running" },
    });
    expect(find(client, "a1")?.parts[0]).toBe(held);
    host.latest().end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.opened[2]?.cursor).toEqual({ segment: "s2", seq: 2 });
  });

  it("brings the buttons back with the error when the host refuses the answer", async () => {
    const respond = vi
      .fn<Respond>()
      .mockRejectedValueOnce(
        new TransportError("refused", { code: "expired", message: "This request expired." }),
      )
      .mockResolvedValueOnce(undefined);
    const { client } = await waitingClient(respond);
    expect(await client.respond("op1", { type: "deny", message: "Not this one" })).toMatchObject({
      ok: false,
      error: { code: "expired" },
    });
    expect(client.getState().requests[0]?.local).toEqual({
      status: "failed",
      response: { type: "deny", message: "Not this one" },
      error: { code: "expired", message: "This request expired." },
    });
    expect(await client.respond("op1", { type: "approve" })).toEqual({ ok: true });
    expect(client.getState().requests[0]?.local?.status).toBe("submitting");
  });

  it("marks an answer with an unknown outcome unconfirmed, watches, and never sends it again", async () => {
    const respond = vi.fn<Respond>(async () => {
      throw new Error("socket hang up");
    });
    const { host, client } = await waitingClient(respond);
    expect(await client.respond("op1", { type: "approve" })).toMatchObject({
      ok: false,
      error: { code: "unconfirmed" },
    });
    expect(client.getState().requests[0]?.local?.status).toBe("unconfirmed");
    expect(host.opened).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("refuses an answer to a request that no longer waits", async () => {
    const respond = vi.fn<Respond>(async () => {});
    const { client } = await waitingClient(respond);
    expect(await client.respond("op9", { type: "approve" })).toMatchObject({
      ok: false,
      error: { code: "not_waiting" },
    });
    expect(respond).not.toHaveBeenCalled();
  });
});

describe("rendering", () => {
  it("renders on a server, where there is no window or document", () => {
    expect(typeof globalThis.window).toBe("undefined");
    function App() {
      const chat = useChat({
        transport: {},
        initialMessages: [user("m1", "Hello from the server")],
      });
      return createElement(
        "ol",
        null,
        chat.messages.map((message) => createElement("li", { key: message.id }, message.id)),
      );
    }
    expect(renderToString(createElement(App))).toContain("m1");
  });
});
