import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createChatClient,
  TransportError,
  type ChatClient,
  type ChatTransport,
  type EventReply,
  type ClientToolHandler,
  type ClientToolClaim,
  type ClientToolClaimRequest,
  type EnqueueInput,
} from "../src/client.ts";
import { useChat } from "../src/hooks.ts";
import {
  draftScopeKey,
  type DraftScope,
  type PendingSendStorage,
  type StoredSend,
} from "../src/drafts.ts";
import type {
  ApprovalPart,
  ChatEvent,
  DisplayMessage,
  DisplayInput,
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
    expect(result.outcome).toBe("unknown");
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

    expect(await client.retry(first.messageId)).toEqual({
      ok: true,
      outcome: "accepted",
      messageId: first.messageId,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    expect(find(client, first.messageId)?.state).toBe("settled");
    expect(client.getState().messageErrors).toEqual({});
  });

  it.each(["running", "waiting"] as const)(
    "blocks ordinary retries during a %s run even when steering is available",
    async (state) => {
      const host = tail();
      const send = vi
        .fn<Send>()
        .mockRejectedValueOnce(new Error("Lost reply"))
        .mockResolvedValue(undefined);
      const enqueue = vi.fn<NonNullable<ChatTransport["enqueue"]>>(async (input) => ({
        id: input.clientId,
        rootRunId: input.rootRunId,
        status: "queued",
      }));
      const transport = { send, enqueue, observe: host.observe };
      const client = createChatClient({ transport });
      const detach = client.attach();
      const first = await client.send("Unconfirmed message");
      if (!first.ok) throw new Error("An unknown outcome keeps the message.");
      host.latest().push(status(run(state, "another-run"), at(1)));
      await flush();

      expect(client.getState().canSend).toBe(true);
      expect(await client.retry(first.messageId)).toMatchObject({
        ok: false,
        error: { code: "busy" },
      });
      expect(find(client, first.messageId)?.state).toBe("failed");
      expect(send).toHaveBeenCalledOnce();
      expect(enqueue).not.toHaveBeenCalled();
      expect(await client.send("Steer the current run")).toMatchObject({ outcome: "accepted" });
      expect(enqueue).toHaveBeenCalledOnce();

      client.setOptions({ transport, allowSendWhileRunning: true });
      expect(await client.retry(first.messageId)).toMatchObject({ outcome: "accepted" });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
      expect(enqueue).toHaveBeenCalledOnce();
      detach();
    },
  );

  it("reports acceptance when the host's copy arrives before a transport failure", async () => {
    const host = tail();
    const call = deferred<void>();
    const send = vi.fn<Send>(() => call.promise);
    const client = createChatClient({ transport: { send, observe: host.observe } });
    client.attach();
    const pending = client.send("Hello");
    const input = send.mock.calls[0]?.[0];
    if (!input) throw new Error("The send did not start.");
    host.latest().push(put(user("m1", input.text, input.clientId)));
    await flush();
    call.reject(new Error("Lost acknowledgement"));
    expect(await pending).toEqual({
      ok: true,
      outcome: "accepted",
      messageId: input.clientId,
    });
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
    expect(await client.send("Hi")).toMatchObject({ ok: true, outcome: "accepted" });
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
    expect(await pending).toMatchObject({ ok: true, outcome: "unknown" });
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

  it("without transport.stop, settles a thinking row the stop cut short, with no length", async () => {
    // A stopped message is final, so nothing later could settle the row, and a renderer that draws
    // Thinking while it is open would draw it forever.
    const send = vi.fn<Send>(async () => ({
      events: new Feed().push(
        put(assistant("a1"), at(1)),
        status(run("running"), at(2)),
        patch(
          "a1",
          { type: "thinking", id: "a1-thinking", settled: false, startedAt: 1_000 },
          at(3),
        ),
      ),
    }));
    const client = createChatClient({ transport: { send } });
    await client.send("Hi");
    await flush();
    expect(await client.stop()).toEqual({ ok: true });
    expect(find(client, "a1")).toMatchObject({
      state: "stopped",
      parts: [{ type: "thinking", id: "a1-thinking", settled: true, startedAt: 1_000 }],
    });
    expect(find(client, "a1")?.parts[0]).not.toHaveProperty("durationMs");
  });

  it("without transport.stop, offers Retry at once for a send the stop cut off", async () => {
    // Closing the stream was the stop, and the client drew the run as stopped, so there is no run
    // left to wait for.
    const host = tail();
    const send = vi.fn<Send>(
      (_input, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const client = createChatClient({ transport: { send, observe: host.observe } });
    client.attach();
    host.latest().push(status(run("completed", "run-0"), at(1)));
    await flush();
    const pending = client.send("Hello");
    expect(await client.stop()).toEqual({ ok: true });
    expect(await pending).toMatchObject({ ok: true, outcome: "unknown" });
    expect(client.getState()).toMatchObject({ status: "ready", canRetry: true });
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
    expect(await pending).toEqual({ ok: true, outcome: "accepted" });
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
    expect(await client.respond("op1", { type: "approve" })).toEqual({
      ok: true,
      outcome: "accepted",
    });
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

  it.each(["stream", "observation"] as const)(
    "keeps the continuation %s after observation closes the answered request",
    async (delivery) => {
      const host = tail();
      const call = deferred<void | EventReply>();
      const respond = vi.fn<Respond>(() => call.promise);
      const client = createChatClient({ transport: { observe: host.observe, respond } });
      client.attach();
      host.latest().push(snapshot([assistant("a1", [approval("q")])], run("waiting"), at(1)));
      await flush();
      const pending = client.respond("q", { type: "approve" });
      host
        .latest()
        .push(patch("a1", approval("q", "approved"), at(1, "continued")))
        .end();
      await flush();
      expect(client.getState().requests).toEqual([]);
      const completed = snapshot(
        [assistant("a1", [text("t1", "Continued answer", true)], "settled")],
        run("completed"),
        at(2, "continued"),
      );
      call.resolve(
        delivery === "stream" ? { events: new Feed().push(completed).end() } : undefined,
      );
      expect(await pending).toEqual({ ok: true, outcome: "accepted" });
      if (delivery === "observation") {
        expect(host.opened).toHaveLength(2);
        host.latest().push(completed).end();
      }
      await flush();
      expect(textOf(client, "a1", "t1")).toBe("Continued answer");
      expect(client.getState()).toMatchObject({ status: "ready", connection: "idle" });
      expect(respond).toHaveBeenCalledOnce();
    },
  );

  it("drains an answer reply without replacing another logical run", async () => {
    const host = tail();
    const call = deferred<EventReply>();
    const client = createChatClient({
      transport: { observe: host.observe, respond: () => call.promise },
    });
    client.attach();
    host.latest().push(snapshot([assistant("a1", [approval("q")])], run("waiting"), at(1)));
    await flush();
    const pending = client.respond("q", { type: "approve" });
    host.latest().push(snapshot([], run("waiting", "other-run"), at(1, "other")));
    await flush();
    call.resolve({
      events: new Feed().push(snapshot([], run("completed"), at(1, "old-continuation"))).end(),
    });
    await pending;
    await flush();
    expect(client.getState().run).toEqual(run("waiting", "other-run"));
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
    expect(await client.respond("op1", { type: "approve" })).toEqual({
      ok: true,
      outcome: "accepted",
    });
    expect(client.getState().requests[0]?.local?.status).toBe("submitting");
  });

  it("marks an answer with an unknown outcome unconfirmed, watches, and never sends it again", async () => {
    const respond = vi.fn<Respond>(async () => {
      throw new Error("socket hang up");
    });
    const { host, client } = await waitingClient(respond);
    expect(await client.respond("op1", { type: "approve" })).toEqual({
      ok: true,
      outcome: "unknown",
    });
    expect(client.getState().requests[0]?.local?.status).toBe("unconfirmed");
    expect(host.opened).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("submits batches and partial answers without losing refused values", async () => {
    const respond = vi
      .fn<Respond>()
      .mockRejectedValueOnce(
        new TransportError("refused", { code: "invalid_answer", message: "Review your answer." }),
      )
      .mockResolvedValue(undefined);
    const question = {
      type: "question" as const,
      id: "q",
      title: "Which one?",
      state: "pending" as const,
      choices: [{ id: "a", label: "A" }],
    };
    const client = createChatClient({
      transport: { respond },
      initialMessages: [assistant("a1", [question, approval("a")])],
    });
    const batch = [
      { requestId: "q", response: { type: "answer" as const, answer: { choices: ["a"] } } },
      { requestId: "a", response: { type: "approve" as const } },
    ];
    expect(await client.respond(batch)).toMatchObject({ ok: false });
    expect(respond.mock.calls[0]?.[0]).toEqual(batch);
    expect(client.getState().requests.map((request) => request.local?.response)).toEqual(
      batch.map((answer) => answer.response),
    );
    expect(await client.respond([batch[0]!])).toEqual({ ok: true, outcome: "accepted" });
    expect(respond.mock.calls[1]?.[0]).toEqual([batch[0]]);
    expect(client.getState().requests[1]?.local?.status).toBe("failed");
  });

  it.each(["replacement", "segment"])("drops late answer failures after %s", async (change) => {
    const call = deferred<void>();
    const host = tail();
    const client = createChatClient({
      transport: { observe: host.observe, respond: () => call.promise },
    });
    client.attach();
    host.latest().push(put(assistant("a1", [approval("q")]), at(1)), status(run("waiting"), at(2)));
    await flush();
    const pending = client.respond("q", { type: "approve" });
    if (change === "replacement")
      host.latest().push(snapshot([assistant("a1", [approval("q2")])], run("waiting"), at(3)));
    else host.latest().push(status(run("running"), at(1, "new")));
    await flush();
    const held = client.getState().requests;
    call.reject(new TransportError("refused", { code: "old", message: "Old refusal" }));
    await pending;
    expect(client.getState().requests).toBe(held);
    expect(JSON.stringify(client.getState())).not.toContain("Old refusal");
  });

  it("never dispatches a client tool on observation and only retries its saved result", async () => {
    // Pure read-only sample: transforms a host-approved string, with no browser or network effects.
    const run = vi.fn((input: unknown) => {
      if (typeof input !== "string") throw new TypeError("Expected text");
      return { length: input.length };
    });
    const respond = vi
      .fn<Respond>()
      .mockRejectedValueOnce(new Error("Lost reply"))
      .mockResolvedValue(undefined);
    const part = {
      type: "client-tool" as const,
      id: "device",
      title: "Count sample text",
      state: "pending" as const,
      name: "count",
      input: "sample",
    };
    const client = createChatClient({
      transport: { respond },
      initialMessages: [assistant("a1", [part])],
      clientTools: { count: { safety: "read-only", run } },
    });
    const detach = client.attach();
    detach();
    client.attach();
    expect(run).not.toHaveBeenCalled();
    expect(await client.startClientTool("device")).toEqual({ ok: true, outcome: "unknown" });
    expect(client.getState().requests[0]?.local?.response).toEqual({
      type: "result",
      value: { length: 6 },
    });
    expect(await client.startClientTool("device")).toEqual({ ok: true, outcome: "accepted" });
    expect(run).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1]?.[0]).toEqual(respond.mock.calls[0]?.[0]);
  });

  it.each(["result", "failure"] as const)(
    "unlocks a detached device action without rerunning it after a late %s",
    async (completion) => {
      const value = deferred<unknown>();
      const handler = vi.fn(() => value.promise);
      const respond = vi.fn<Respond>(async () => {});
      const client = createChatClient({
        transport: { respond },
        initialMessages: [
          assistant("a1", [
            { type: "client-tool", id: "device", title: "Read", state: "pending", name: "read" },
          ]),
        ],
        clientTools: { read: { safety: "read-only", run: handler } },
      });
      const detach = client.attach();
      const pending = client.startClientTool("device");
      detach();
      expect(client.getState().requests[0]?.local?.status).toBe("unconfirmed");
      client.attach();
      expect(await client.startClientTool("device")).toEqual({ ok: true, outcome: "unknown" });
      if (completion === "result") value.resolve({ text: "Saved result" });
      else value.reject(new Error("Private handler error"));
      expect(await pending).toEqual({ ok: true, outcome: "unknown" });
      expect(respond).not.toHaveBeenCalled();
      expect(JSON.stringify(client.getState())).not.toContain("Private handler error");
      if (completion === "result") {
        expect(await client.startClientTool("device")).toEqual({ ok: true, outcome: "accepted" });
        expect(respond.mock.calls[0]?.[0]).toEqual([
          { requestId: "device", response: { type: "result", value: { text: "Saved result" } } },
        ]);
      } else {
        expect(await client.startClientTool("device")).toEqual({ ok: true, outcome: "unknown" });
        expect(await client.respond("device", { type: "cancel" })).toEqual({
          ok: true,
          outcome: "accepted",
        });
      }
      expect(handler).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledOnce();
    },
  );

  it("can cancel detached device work before its handler settles", async () => {
    const value = deferred<unknown>();
    const respond = vi.fn<Respond>(async () => {});
    const client = createChatClient({
      transport: { respond },
      initialMessages: [
        assistant("a1", [
          { type: "client-tool", id: "device", title: "Read", state: "pending", name: "read" },
        ]),
      ],
      clientTools: { read: { safety: "read-only", run: () => value.promise } },
    });
    const detach = client.attach();
    const pending = client.startClientTool("device");
    detach();
    client.attach();
    expect(await client.respond("device", { type: "cancel" })).toEqual({
      ok: true,
      outcome: "accepted",
    });
    value.resolve("Late result");
    await pending;
    expect(respond).toHaveBeenCalledOnce();
    expect(client.getState().requests[0]?.local).toEqual({
      status: "submitting",
      response: { type: "cancel" },
    });
  });

  it("does not send a delayed device result after detaching", async () => {
    const value = deferred<unknown>();
    const respond = vi.fn<Respond>(async () => {});
    const client = createChatClient({
      transport: { respond },
      initialMessages: [
        assistant("a1", [
          {
            type: "client-tool",
            id: "device",
            title: "Read",
            state: "pending",
            name: "read",
            input: {},
          },
        ]),
      ],
      clientTools: { read: { safety: "read-only", run: () => value.promise } },
    });
    const detach = client.attach();
    const pending = client.startClientTool("device");
    detach();
    value.resolve({ text: "Late result" });
    expect(await pending).toEqual({ ok: true, outcome: "unknown" });
    expect(respond).not.toHaveBeenCalled();
  });

  it("refuses expired, display-only and mismatched responses before transport", async () => {
    const respond = vi.fn<Respond>(async () => {});
    const client = createChatClient({
      transport: { respond },
      initialMessages: [
        assistant("a1", [
          { ...approval("expired"), expiresAt: 0 },
          { type: "question", id: "hidden", title: "Waiting", state: "pending", canAnswer: false },
          {
            type: "question",
            id: "question",
            title: "Choose",
            state: "pending",
            choices: [{ id: "one", label: "One" }],
          },
        ]),
      ],
    });
    expect((await client.respond("expired", { type: "approve" })).ok).toBe(false);
    expect((await client.respond("hidden", { type: "answer", answer: { text: "Draft" } })).ok).toBe(
      false,
    );
    expect((await client.respond("question", { type: "approve" })).ok).toBe(false);
    expect(
      (await client.respond("question", { type: "answer", answer: { choices: ["missing"] } })).ok,
    ).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });

  it("keeps submitted values when an authoritative read rejects the answer", async () => {
    const host = tail();
    const call = deferred<void>();
    const respond = vi.fn<Respond>(() => call.promise);
    const question = {
      type: "question" as const,
      id: "q",
      title: "Your name",
      state: "pending" as const,
    };
    const client = createChatClient({ transport: { observe: host.observe, respond } });
    client.attach();
    host.latest().push(put(assistant("a1", [question]), at(1)), status(run("waiting"), at(2)));
    await flush();
    const response = { type: "answer" as const, answer: { text: "Keep this answer" } };
    const sending = client.respond("q", response);
    const problem = { code: "invalid_answer", message: "Review your answer and try again." };
    host
      .latest()
      .push(
        snapshot([assistant("a1", [{ ...question, problem }])], run("waiting"), at(1, "continued")),
      );
    await flush();
    call.resolve();
    await sending;
    expect(client.getState().requests[0]?.local).toEqual({
      status: "failed",
      response,
      error: problem,
    });
    expect(respond).toHaveBeenCalledOnce();
  });

  it.each(["snapshot", "part", "message", "unnumbered snapshot"] as const)(
    "unlocks a repeated rejection from a fresh %s and ignores unrelated progress",
    async (update) => {
      const host = tail();
      const problem = { code: "invalid_answer", message: "Review your answer and try again." };
      const question = {
        type: "question" as const,
        id: "q",
        title: "Your name",
        state: "pending" as const,
        problem,
      };
      const call = deferred<void>();
      const respond = vi
        .fn<Respond>()
        .mockImplementationOnce(() => call.promise)
        .mockResolvedValue(undefined);
      const client = createChatClient({ transport: { observe: host.observe, respond } });
      client.attach();
      host.latest().push(snapshot([assistant("a1", [question])], run("waiting"), at(1)));
      await flush();
      const response = { type: "answer" as const, answer: { text: "Keep this answer" } };
      const pending = client.respond("q", response);
      host
        .latest()
        .push(
          snapshot([assistant("a1", [question])], run("waiting"), at(1)),
          status(run("waiting"), at(2)),
          patch("a1", text("other", "Unrelated output"), at(3)),
        );
      await flush();
      expect(client.getState().requests[0]?.local?.status).toBe("submitting");
      const held = client.getState().requests[0]?.part;
      let event: ChatEvent;
      switch (update) {
        case "part":
          event = patch("a1", { ...question }, at(4));
          break;
        case "message":
          event = put(assistant("a1", [{ ...question }]), at(4));
          break;
        default:
          event = snapshot(
            [assistant("a1", [{ ...question }])],
            run("waiting"),
            update === "snapshot" ? at(4) : {},
          );
      }
      host.latest().push(event);
      await flush();
      expect(client.getState().requests[0]?.part).toBe(held);
      expect(client.getState().requests[0]?.local).toEqual({
        status: "failed",
        response,
        error: problem,
      });
      call.resolve();
      await pending;
      host
        .latest()
        .push(snapshot([assistant("a1", [question])], run("waiting"), at(5)))
        .end();
      await flush();
      expect(client.getState().connection).toBe("idle");
      expect(
        await client.respond("q", { type: "answer", answer: { text: "Corrected answer" } }),
      ).toEqual({ ok: true, outcome: "accepted" });
      expect(respond).toHaveBeenCalledTimes(2);
    },
  );

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

describe("host action claims", () => {
  // One simulated authority shared by independent clients. This proves the binding and ordering,
  // not distributed storage, real authentication, fencing or crash-safe persistence.
  function authority() {
    let state: "free" | "busy" | "unknown" | "completed" = "free";
    let result: unknown;
    const claim = vi.fn((request: ClientToolClaimRequest): ClientToolClaim => {
      expect(request).toMatchObject({
        runId: "run-1",
        requestId: "device",
        name: "write",
        input: "approved input",
      });
      if (state === "completed") return { status: "completed", value: result };
      if (state !== "free") return { status: state };
      state = "busy";
      return {
        status: "granted",
        complete(value) {
          result = value;
          state = "completed";
        },
      };
    });
    return {
      claim,
      uncertain() {
        state = "unknown";
      },
      reconcile(value: unknown) {
        result = value;
        state = "completed";
      },
    };
  }
  async function device(handler: ClientToolHandler, respond: Respond = async () => {}) {
    const host = tail();
    const client = createChatClient({
      transport: { observe: host.observe, respond },
      clientTools: { write: handler },
    });
    const detach = client.attach();
    host.latest().push(
      snapshot(
        [
          assistant("a1", [
            {
              type: "client-tool",
              id: "device",
              name: "write",
              title: "Write",
              input: "approved input",
              state: "pending",
            },
          ]),
        ],
        run("waiting"),
        at(1),
      ),
    );
    await flush();
    return { client, host, detach };
  }

  it("requires one authoritative grant across two concurrent tabs", async () => {
    const service = authority();
    const work = deferred<unknown>();
    const execute = vi.fn(() => work.promise);
    const handler: ClientToolHandler = { safety: "claimed", claim: service.claim, run: execute };
    const first = await device(handler);
    const second = await device(handler);
    expect(execute).not.toHaveBeenCalled();
    const pending = first.client.startClientTool("device");
    expect(await second.client.startClientTool("device")).toMatchObject({
      ok: false,
      error: { code: "claim_busy" },
    });
    expect(execute).toHaveBeenCalledOnce();
    work.resolve("saved result");
    expect(await pending).toMatchObject({ ok: true, outcome: "accepted" });
    expect(await second.client.startClientTool("device")).toMatchObject({
      ok: true,
      outcome: "accepted",
    });
    expect(execute).toHaveBeenCalledOnce();
    first.detach();
    second.detach();
  });

  it.each(["execution", "delivery"] as const)(
    "reconciles a fresh client after lost %s without executing twice",
    async (failure) => {
      const service = authority();
      const execute = vi.fn(() => {
        if (failure === "execution") {
          service.uncertain();
          throw new Error("Effect may have happened");
        }
        return "stored result";
      });
      const handler: ClientToolHandler = { safety: "claimed", claim: service.claim, run: execute };
      const first = await device(handler, async () => {
        throw new Error("Lost result delivery");
      });
      expect(await first.client.startClientTool("device")).toMatchObject({ outcome: "unknown" });
      first.detach();
      const deliver = vi.fn<Respond>(async () => {});
      const fresh = await device(handler, deliver);
      if (failure === "execution") {
        expect(await fresh.client.startClientTool("device")).toMatchObject({ outcome: "unknown" });
        expect(deliver).not.toHaveBeenCalled();
        service.reconcile("stored result");
      }
      expect(await fresh.client.startClientTool("device")).toMatchObject({ outcome: "accepted" });
      expect(deliver.mock.calls[0]?.[0]).toEqual([
        { requestId: "device", response: { type: "result", value: "stored result" } },
      ]);
      expect(execute).toHaveBeenCalledOnce();
      fresh.detach();
    },
  );

  it("records a late execution result without delivering it from a detached view", async () => {
    const service = authority();
    const work = deferred<unknown>();
    const execute = vi.fn(() => work.promise);
    const handler: ClientToolHandler = { safety: "claimed", claim: service.claim, run: execute };
    const deliver = vi.fn<Respond>(async () => {});
    const first = await device(handler, deliver);
    const pending = first.client.startClientTool("device");
    await flush();
    first.detach();
    work.resolve("persist after detaching");
    expect(await pending).toMatchObject({ outcome: "unknown" });
    expect(deliver).not.toHaveBeenCalled();
    const fresh = await device(handler, deliver);
    expect(await fresh.client.startClientTool("device")).toMatchObject({ outcome: "accepted" });
    expect(execute).toHaveBeenCalledOnce();
    fresh.detach();
  });

  it("refuses a handler with no repeat-safety declaration", async () => {
    const execute = vi.fn();
    // A JavaScript consumer can omit this field. Pin both the type error and runtime refusal.
    // @ts-expect-error A handler requires explicit safety or a durable claim.
    const handler: ClientToolHandler = { run: execute };
    const item = await device(handler);
    expect(await item.client.startClientTool("device")).toMatchObject({ ok: false });
    expect(execute).not.toHaveBeenCalled();
    item.detach();
  });

  it.each(["denied", "busy", "unknown"] as const)("does not execute a %s claim", async (status) => {
    const execute = vi.fn();
    const item = await device({ safety: "claimed", claim: () => ({ status }), run: execute });
    const result = await item.client.startClientTool("device");
    expect(result).toMatchObject(
      status === "unknown"
        ? { ok: true, outcome: "unknown" }
        : { ok: false, error: { code: `claim_${status}` } },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(item.client.getState().requests[0]?.local?.status).not.toBe("submitting");
    item.detach();
  });

  it.each(["detach", "run", "segment", "expiry"])(
    "does not execute after the claim awaited a stale %s",
    async (change) => {
      const claim = deferred<ClientToolClaim>();
      const execute = vi.fn();
      const item = await device({ safety: "claimed", claim: () => claim.promise, run: execute });
      if (change === "expiry") {
        const message = item.client.getState().messages[0]!;
        item.host.latest().push(
          snapshot(
            [
              {
                ...message,
                parts: message.parts.map((part) => ({ ...part, expiresAt: Date.now() + 1 })),
              },
            ],
            run("waiting"),
            at(2),
          ),
        );
        await flush();
      }
      const pending = item.client.startClientTool("device");
      if (change === "detach") item.detach();
      else if (change === "expiry") await vi.advanceTimersByTimeAsync(2);
      else
        item.host
          .latest()
          .push(status(run("waiting", change === "run" ? "other" : "run-1"), at(1, "new")));
      await flush();
      claim.resolve({ status: "granted", complete() {} });
      expect(await pending).toMatchObject({ outcome: "unknown" });
      expect(execute).not.toHaveBeenCalled();
      item.detach();
    },
  );

  it.each(["completed", "granted", "skip"] as const)(
    "unlocks a stale segment claim for explicit %s recovery without using its grant",
    async (recovery) => {
      const stale = deferred<ClientToolClaim>();
      const fresh = deferred<ClientToolClaim>();
      const claim = vi
        .fn<(request: ClientToolClaimRequest) => Promise<ClientToolClaim>>()
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(fresh.promise);
      const execute = vi.fn();
      const complete = vi.fn();
      const deliver = vi.fn<Respond>(async () => {});
      const item = await device({ safety: "claimed", claim, run: execute }, deliver);
      const pending = item.client.startClientTool("device");
      item.host.latest().push(status(run("waiting"), at(1, "continued")));
      await flush();
      expect(claim.mock.calls[0]?.[0].signal.aborted).toBe(true);
      expect(item.client.getState().requests[0]).toMatchObject({
        canReconcile: true,
        local: { status: "unconfirmed" },
      });

      const checking =
        recovery === "skip"
          ? item.client.respond("device", { type: "cancel" })
          : item.client.startClientTool("device");
      expect(item.client.getState().requests[0]?.local?.status).toBe("submitting");
      stale.resolve({ status: "granted", complete });
      expect(await pending).toMatchObject({ outcome: "unknown" });
      // The old grant must not clear the newer check or Skip submission.
      expect(item.client.getState().requests[0]?.local?.status).toBe("submitting");
      if (recovery !== "skip") {
        expect(claim).toHaveBeenCalledTimes(2);
        expect(claim.mock.calls[1]?.[0]).toMatchObject({
          requestId: "device",
          runId: "run-1",
          segment: "continued",
          name: "write",
          input: "approved input",
        });
        fresh.resolve(
          recovery === "completed"
            ? { status: "completed", value: "Host-reconciled result" }
            : { status: "granted", complete },
        );
      }
      expect(await checking).toEqual({
        ok: true,
        outcome: recovery === "granted" ? "unknown" : "accepted",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      if (recovery === "granted") expect(deliver).not.toHaveBeenCalled();
      else {
        expect(deliver).toHaveBeenCalledOnce();
        expect(deliver.mock.calls[0]?.[0]).toEqual([
          {
            requestId: "device",
            response:
              recovery === "skip"
                ? { type: "cancel" }
                : { type: "result", value: "Host-reconciled result" },
          },
        ]);
      }
      item.detach();
    },
  );

  it("rechecks the host before delivering a retained result in a new segment", async () => {
    const service = authority();
    const execute = vi.fn(() => "Stored result");
    const deliver = vi
      .fn<Respond>()
      .mockRejectedValueOnce(new Error("Lost delivery"))
      .mockResolvedValue(undefined);
    const item = await device({ safety: "claimed", claim: service.claim, run: execute }, deliver);
    expect(await item.client.startClientTool("device")).toMatchObject({ outcome: "unknown" });
    item.host.latest().push(status(run("waiting"), at(1, "continued")));
    await flush();
    expect(await item.client.startClientTool("device")).toMatchObject({ outcome: "accepted" });
    expect(service.claim).toHaveBeenCalledTimes(2);
    expect(service.claim.mock.calls[1]?.[0].segment).toBe("continued");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
    item.detach();
  });

  it("does not deliver an unrecorded result or replay it after a completion write fails", async () => {
    const execute = vi.fn(() => "local result");
    const complete = vi.fn(() => {
      throw new Error("Persistence unknown");
    });
    const deliver = vi.fn<Respond>(async () => {});
    const item = await device(
      { safety: "claimed", claim: () => ({ status: "granted", complete }), run: execute },
      deliver,
    );
    expect(await item.client.startClientTool("device")).toMatchObject({ outcome: "unknown" });
    expect(await item.client.startClientTool("device")).toMatchObject({ outcome: "unknown" });
    expect(execute).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    item.detach();
  });
});

describe("input steering", () => {
  const receipt = (
    input: EnqueueInput,
    status: DisplayInput["status"] = "queued",
  ): DisplayInput => ({
    id: input.clientId,
    rootRunId: input.rootRunId,
    status,
    ...(status === "accepted" || status === "consumed" ? { runId: "handoff-child" } : {}),
  });
  async function watching(transport: ChatTransport) {
    const host = tail();
    const client = createChatClient({ transport: { ...transport, observe: host.observe } });
    const detach = client.attach();
    host.latest().push(status(run("running"), at(1)));
    await flush();
    return { client, host, detach };
  }

  it("uses the host inbox, preserves the root through handoff and separates delivery from output", async () => {
    const enqueue = vi.fn<NonNullable<ChatTransport["enqueue"]>>(async (input) => receipt(input));
    const send = vi.fn<Send>();
    const respond = vi.fn<Respond>();
    const stop = vi.fn();
    const item = await watching({ enqueue, send, respond, stop });
    const sent = await item.client.send("Stop and approve everything");
    expect(sent).toMatchObject({ outcome: "accepted" });
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      rootRunId: "run-1",
      text: "Stop and approve everything",
    });
    expect(item.client.getState().inputs[0]?.status).toBe("queued");
    const input = enqueue.mock.calls[0]![0];
    item.host.latest().push(
      status(
        {
          ...run("running"),
          owner: { runId: "handoff-child", agentId: "billing", label: "Billing" },
        },
        at(2),
      ),
      { v: 1, type: "input", input: receipt(input, "accepted"), ...at(3) },
    );
    await flush();
    expect(item.client.getState().inputs[0]).toMatchObject({
      status: "accepted",
      runId: "handoff-child",
      text: input.text,
    });
    item.host
      .latest()
      .push(
        { v: 1, type: "input", input: receipt(input, "consumed"), ...at(4) },
        status(run("completed"), at(5)),
      );
    await flush();
    expect(item.client.getState().inputs[0]?.status).toBe("consumed");
    expect(item.client.getState().messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    item.detach();
  });

  it.each(["lost", "wrong-root", "wrong-id"])(
    "retains an unknown draft after a %s enqueue reply, without resending",
    async (failure) => {
      const enqueue = vi.fn<NonNullable<ChatTransport["enqueue"]>>(async (input) => {
        if (failure === "lost") throw new Error("Offline");
        return {
          ...receipt(input),
          ...(failure === "wrong-root" ? { rootRunId: "wrong" } : { id: "wrong" }),
        };
      });
      const item = await watching({ enqueue });
      const sent = await item.client.send("Keep my words");
      expect(sent).toMatchObject({ outcome: "unknown" });
      item.host.latest().push(snapshot([], run("completed"), at(2)));
      await flush();
      expect(item.client.getState().inputs[0]).toMatchObject({
        text: "Keep my words",
        status: "unconfirmed",
      });
      if (sent.ok) expect(await item.client.retry(sent.messageId)).toMatchObject({ ok: false });
      expect(enqueue).toHaveBeenCalledOnce();
      item.detach();
    },
  );

  it("preserves refused text and unknown attachment-only input", async () => {
    const enqueue = vi
      .fn<NonNullable<ChatTransport["enqueue"]>>()
      .mockRejectedValueOnce(
        new TransportError("refused", { code: "full", message: "Wait before sending more." }),
      )
      .mockRejectedValueOnce(new Error("Unknown delivery"));
    const item = await watching({ enqueue });
    expect(await item.client.send("Keep my draft")).toMatchObject({
      ok: false,
      input: { text: "Keep my draft" },
    });
    expect(item.client.getState().inputs).toEqual([]);
    const attachments = [{ id: "file", name: "Draft.txt", mediaType: "text/plain" }];
    expect(await item.client.send({ attachments })).toMatchObject({ outcome: "unknown" });
    expect(item.client.getState().inputs[0]).toMatchObject({ attachments, status: "unconfirmed" });
    item.detach();
  });

  it("keeps a queued-at-completion message and asks the host, not the queued label, about recall", async () => {
    let claimed = false;
    const recallInput = vi.fn<NonNullable<ChatTransport["recallInput"]>>(async (input) => {
      if (claimed)
        throw new TransportError("refused", {
          code: "claimed",
          message: "Already claimed. Check the answer.",
        });
      return { ...input, status: "recalled" };
    });
    const item = await watching({ enqueue: async (input) => receipt(input), recallInput });
    await item.client.send("Arrived too late");
    const id = item.client.getState().inputs[0]!.id;
    item.host.latest().push(snapshot([], run("completed"), at(2)));
    await flush();
    expect(item.client.getState().inputs[0]).toMatchObject({ status: "queued", canRecall: true });
    // Simulates poll reserving the input before checkpoint/acknowledge. The UI is still queued.
    claimed = true;
    expect(await item.client.recallInput(id)).toMatchObject({
      ok: false,
      error: { code: "claimed" },
    });
    expect(item.client.getState().inputs[0]?.status).toBe("queued");
    claimed = false;
    expect(await item.client.recallInput(id)).toEqual({ ok: true });
    expect(item.client.getState().inputs[0]).toMatchObject({
      status: "recalled",
      canRecall: false,
    });
    item.detach();
  });

  it.each(["detach", "root"])("drops a late enqueue callback after %s changes", async (change) => {
    const result = deferred<DisplayInput>();
    const enqueue = vi.fn<NonNullable<ChatTransport["enqueue"]>>(() => result.promise);
    const item = await watching({ enqueue });
    const pending = item.client.send("Old scope");
    if (change === "detach") item.detach();
    else {
      item.host.latest().push(status(run("running", "new-root"), at(2)));
      await flush();
    }
    result.resolve(receipt(enqueue.mock.calls[0]![0]));
    expect(await pending).toMatchObject({ outcome: "unknown" });
    expect(item.client.getState().inputs[0]?.status).toBe("unconfirmed");
    item.detach();
  });
});

// Four rules a phone app learned on its own event stream before it moved to this client. Each one
// fixed a screen, so every app on this client keeps them.
describe("stream rules from a phone app", () => {
  it("resumes a conversation with a past after its saved position, never from the start", async () => {
    // From the start, a conversation with a past replays its whole log.
    const host = tail();
    const client = createChatClient({
      transport: { observe: host.observe },
      initialMessages: [user("m0", "Earlier question"), assistant("a0", [], "settled")],
      initialCursor: { segment: "s0", seq: 41 },
    });
    client.attach();
    expect(host.opened[0]?.cursor).toEqual({ segment: "s0", seq: 41 });
    // An event the saved position already holds is not taken again.
    host.latest().push(patch("a0", text("t0", "Replayed", true), at(41, "s0")));
    await flush();
    expect(find(client, "a0")?.parts).toEqual([]);
    host
      .latest()
      .push(status(run("running", "run-1"), at(1, "s1")))
      .end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.opened[1]?.cursor).toEqual({ segment: "s1", seq: 1 });
  });

  it("refuses a saved position that is not one", () => {
    for (const initialCursor of [{ seq: -1 }, { seq: 1.5 }, { seq: 1, segment: "" }])
      expect(() => createChatClient({ transport: {}, initialCursor })).toThrow(TypeError);
  });

  it("keeps watching for the run a message started when the stream ends on an earlier run's end", async () => {
    // Only the end of the run a message started ends the watch. A replay can carry the end of the
    // run before it ahead of the new run's first event.
    const host = tail();
    const send = vi.fn<Send>(async () => {});
    const client = createChatClient({
      transport: { send, observe: host.observe },
      allowSendWhileRunning: true,
    });
    client.attach();
    host.latest().push(...writingRun());
    await flush();
    expect(await client.send("And then?")).toMatchObject({ ok: true, outcome: "accepted" });
    // The run before it ends, and the stream closes before the new run says a word.
    host
      .latest()
      .push(status(run("completed"), at(4)))
      .end();
    await flush();
    expect(client.getState()).toMatchObject({ status: "sending", connection: "reconnecting" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.opened).toHaveLength(2);
    host.latest().push(status(run("running", "run-2"), at(1, "s2")));
    await flush();
    expect(client.getState()).toMatchObject({ status: "running", run: { id: "run-2" } });
  });

  it("keeps watching when the first read after a send still holds the earlier run's end", async () => {
    // The same rule for a host that opens every observation with a snapshot: one read before it
    // saved the new run reports the earlier run again, here with its owner filled in.
    const host = tail();
    const send = vi.fn<Send>(async () => {});
    const client = createChatClient({ transport: { send, observe: host.observe } });
    client.attach();
    host
      .latest()
      .push(snapshot([assistant("a0", [], "settled")], run("completed", "run-0")))
      .end();
    await flush();
    await client.send("Next question");
    const owner = { runId: "run-0", agentId: "writer", label: "Writer" };
    host
      .latest()
      .push(snapshot([assistant("a0", [], "settled")], { ...run("completed", "run-0"), owner }))
      .end();
    await flush();
    expect(client.getState()).toMatchObject({ status: "sending", connection: "reconnecting" });
    await vi.advanceTimersByTimeAsync(1_000);
    host.latest().push(status(run("running", "run-1")));
    await flush();
    expect(client.getState().status).toBe("running");
  });

  it("counts a failed read as a lost connection, never as the run's verdict", async () => {
    // The host's own read failing is not the run failing: the run keeps going, so the client
    // reattaches and never shows the failure as the run's. A host whose reads keep failing still
    // runs out of tries.
    const readFailed = () =>
      new TransportError("unknown", {
        code: "read_failed",
        message: "The server could not read the run's progress.",
      });
    const host = tail();
    const stop = vi.fn(async () => {});
    const client = createChatClient({ transport: { observe: host.observe, stop } });
    client.attach();
    host
      .latest()
      .push(...writingRun())
      .fail(readFailed());
    await flush();
    const going = {
      status: "running",
      run: run("running"),
      canStop: true,
      canSend: false,
    };
    expect(client.getState()).toMatchObject({ ...going, connection: "reconnecting" });
    expect(client.getState().run.error).toBeUndefined();
    expect(find(client, "a1")?.state).toBe("live");
    for (const wait of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await vi.advanceTimersByTimeAsync(wait);
      host
        .latest()
        .push(delta("a1", "t1", "lo", at(3)))
        .fail(readFailed());
      await flush();
    }
    expect(client.getState()).toMatchObject({
      ...going,
      connection: "lost",
      error: { code: "read_failed" },
    });
    expect(client.getState().run.error).toBeUndefined();
    expect(textOf(client, "a1", "t1")).toBe("Hello");
    expect(host.opened.slice(1).map((item) => item.cursor)).toEqual(
      Array.from({ length: 5 }, () => ({ segment: "s1", seq: 3 })),
    );
  });

  it.each(["running", "waiting"] as const)(
    "offers Retry for an unconfirmed message only once a %s run ends",
    async (state) => {
      // Retry sends the message again, so it waits for the run to end: sent into a running one,
      // it could ask for the same work twice.
      const host = tail();
      const send = vi
        .fn<Send>()
        .mockRejectedValueOnce(new Error("Lost reply"))
        .mockResolvedValue(undefined);
      const enqueue = vi.fn<NonNullable<ChatTransport["enqueue"]>>(async (input) => ({
        id: input.clientId,
        rootRunId: input.rootRunId,
        status: "queued",
      }));
      const client = createChatClient({ transport: { send, enqueue, observe: host.observe } });
      client.attach();
      expect(client.getState().canRetry).toBe(false);
      const first = await client.send("Unconfirmed message");
      if (!first.ok) throw new Error("An unknown outcome keeps the message.");
      host.latest().push(status(run(state, "another-run"), at(1)));
      await flush();
      // Steering keeps Send available, and still the unconfirmed message cannot go again.
      expect(client.getState()).toMatchObject({ canSend: true, canRetry: false });
      expect(await client.retry(first.messageId)).toMatchObject({ ok: false });
      host.latest().push(status(run("completed", "another-run"), at(2)));
      await flush();
      expect(client.getState().canRetry).toBe(true);
      expect(await client.retry(first.messageId)).toMatchObject({ ok: true, outcome: "accepted" });
      expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
      expect(client.getState().canRetry).toBe(false);
    },
  );

  it("offers Retry only once the host has said where the run stands", async () => {
    // Until the host answers, the message may have started a run that nobody reported yet, and a
    // retry would send it into that run.
    const host = tail();
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error("Lost reply"))
      .mockResolvedValue(undefined);
    const client = createChatClient({ transport: { send, observe: host.observe } });
    client.attach();
    host.latest().push(status(run("completed", "run-0"), at(1)));
    await flush();
    const first = await client.send("Hello");
    if (!first.ok) throw new Error("An unknown outcome keeps the message.");
    expect(client.getState()).toMatchObject({ status: "ready", canRetry: false });
    expect(await client.retry(first.messageId)).toMatchObject({
      ok: false,
      error: { code: "checking" },
    });
    // The client asks the host again, and the host answers with the run as it stands now.
    expect(host.opened).toHaveLength(2);
    expect(host.opened[1]?.cursor).toEqual({ segment: "s1", seq: 1 });
    host.latest().push(status(run("completed", "run-0")));
    await flush();
    expect(client.getState().canRetry).toBe(true);
    expect(await client.retry(first.messageId)).toMatchObject({ ok: true, outcome: "accepted" });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

// A message whose delivery is unknown used to live only in memory, so a reload lost it, and the
// person could only type it again as a new message, which the host cannot tell from the first.
describe("an unconfirmed message across a reload", () => {
  const scope: DraftScope = { principalId: "person-1", conversationId: "chat-1" };

  /** The app's storage, read and written as JSON, the way AsyncStorage or sessionStorage are. */
  function device() {
    const items = new Map<string, string>();
    const storage = {
      load: vi.fn(async (at: DraftScope): Promise<unknown> => {
        const raw = items.get(draftScopeKey(at));
        return raw === undefined ? null : JSON.parse(raw);
      }),
      save: vi.fn(async (at: DraftScope, value: StoredSend | null): Promise<void> => {
        if (value === null) items.delete(draftScopeKey(at));
        else items.set(draftScopeKey(at), JSON.stringify(value));
      }),
    } satisfies PendingSendStorage;
    return { storage, saved: () => items.get(draftScopeKey(scope)) };
  }

  /** Sends one message whose outcome is unknown, then "reloads": a new client on the same storage. */
  async function reloadAfterLostReply(send: Mock<Send>) {
    const box = device();
    const pendingSend = { storage: box.storage, scope, retentionMs: 60_000 };
    const before = createChatClient({ transport: { send }, pendingSend });
    const result = await before.send("Hello");
    const input = send.mock.calls[0]?.[0];
    if (!input || !result.ok) throw new Error("The send did not go out.");
    const host = tail();
    const after = createChatClient({ transport: { send, observe: host.observe }, pendingSend });
    after.attach();
    await flush();
    return { box, before, after, host, input, result };
  }

  it("brings the message back unconfirmed, and sends it again with the same id only when asked", async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(undefined);
    const { box, before, after, host, input, result } = await reloadAfterLostReply(send);
    expect(result).toEqual({ ok: true, messageId: input.clientId, outcome: "unknown" });
    expect(find(after, input.clientId)).toMatchObject({
      role: "user",
      state: "failed",
      createdAt: find(before, input.clientId)?.createdAt,
    });
    // Retry waits for the host to say where the run stands: the lost reply may have started one.
    expect(after.getState()).toMatchObject({
      canSend: false,
      canRetry: false,
      messageErrors: { [input.clientId]: { code: "unconfirmed" } },
    });
    host.latest().push(status(run("completed", "run-0")));
    await flush();
    expect(after.getState()).toMatchObject({ canSend: false, canRetry: true });
    // One at a time: a second message could not be sent again safely after another reload.
    expect(await after.send("Something else")).toMatchObject({
      ok: false,
      error: { code: "unconfirmed_send" },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await after.retry(input.clientId)).toMatchObject({ ok: true, outcome: "accepted" });
    expect(send.mock.calls[1]?.[0]).toEqual(input);
    await flush();
    expect(box.saved()).toBeUndefined();
  });

  it("lets the saved copy go once the host's copy of the message arrives", async () => {
    const send = vi.fn<Send>().mockRejectedValueOnce(new Error("timeout"));
    const { box, after, host, input } = await reloadAfterLostReply(send);
    host.latest().push(snapshot([user("m1", "Hello", input.clientId)], run("completed")));
    await flush();
    expect(after.getState().messages.map((message) => message.id)).toEqual(["m1"]);
    expect(after.getState()).toMatchObject({ canSend: true, canRetry: false, messageErrors: {} });
    expect(box.saved()).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not bring it back when the host's copy is already on screen", async () => {
    const box = device();
    const send = vi.fn<Send>().mockRejectedValueOnce(new Error("timeout"));
    const pendingSend = { storage: box.storage, scope, retentionMs: 60_000 };
    await createChatClient({ transport: { send }, pendingSend }).send("Hello");
    const clientId = send.mock.calls[0]?.[0].clientId;
    const after = createChatClient({
      transport: { send },
      pendingSend,
      initialMessages: [user("m1", "Hello", clientId)],
    });
    after.attach();
    await flush();
    expect(after.getState().messages.map((message) => message.id)).toEqual(["m1"]);
    expect(box.saved()).toBeUndefined();
  });

  it("forgets the copy when the host refuses the message, and gives the words back", async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(
        new TransportError("refused", { code: "closed", message: "This chat is closed." }),
      );
    const { box, after, host, input } = await reloadAfterLostReply(send);
    host.latest().push(status(run("completed", "run-0")));
    await flush();
    expect(await after.retry(input.clientId)).toEqual({
      ok: false,
      error: { code: "closed", message: "This chat is closed." },
      input,
    });
    expect(after.getState().messages).toEqual([]);
    await flush();
    expect(box.saved()).toBeUndefined();
  });

  it("lets the person drop a message that never gets through, so the next one can go", async () => {
    // Without a way to drop it, a message whose every send ends as unknown holds the conversation
    // until its copy expires, a reload included.
    const gateway = () =>
      new TransportError("unknown", { code: "http_502", message: "The server did not answer." });
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(gateway())
      .mockRejectedValueOnce(gateway())
      .mockResolvedValue(undefined);
    const { box, after, host, input } = await reloadAfterLostReply(send);
    host.latest().push(status(run("completed", "run-0")));
    await flush();
    expect(await after.retry(input.clientId)).toMatchObject({ ok: true, outcome: "unknown" });
    expect(after.getState().canSend).toBe(false);
    expect(after.discard(input.clientId)).toEqual({ ok: true });
    expect(after.getState()).toMatchObject({
      messages: [],
      canSend: true,
      canRetry: false,
      messageErrors: {},
    });
    expect(after.discard(input.clientId)).toMatchObject({
      ok: false,
      error: { code: "not_unconfirmed" },
    });
    await flush();
    expect(box.saved()).toBeUndefined();
    expect(await after.send("Something else")).toMatchObject({ ok: true, outcome: "accepted" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])(
    "keeps a message from going out when Stop comes while its copy saves (transport.stop: %s)",
    async (hasStop) => {
      // It has not gone out, so the stop is the client's to keep. Sent after the stop, it would
      // start a run that nobody stopped, while the client waited for the host to stop it.
      const box = device();
      const write = deferred<void>();
      const save = box.storage.save.getMockImplementation();
      box.storage.save.mockImplementationOnce(async (...args) => {
        await write.promise;
        await save?.(...args);
      });
      const send = vi.fn<Send>(async () => {});
      const stop = vi.fn(async () => {});
      const client = createChatClient({
        transport: hasStop ? { send, stop } : { send },
        pendingSend: { storage: box.storage, scope, retentionMs: 60_000 },
      });
      const pending = client.send("Hello");
      await flush();
      expect(client.getState()).toMatchObject({ status: "sending", canStop: true });
      expect(await client.stop()).toEqual({ ok: true });
      expect(client.getState()).toMatchObject({ status: "ready", messages: [] });
      write.resolve();
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: "send_stopped" },
        input: { text: "Hello" },
      });
      await flush();
      expect(send).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(client.getState()).toMatchObject({ status: "ready", canSend: true, messages: [] });
      // The copy that landed after the stop goes too: a reload would bring back a message nobody
      // sent, with Retry on it.
      expect(box.saved()).toBeUndefined();
    },
  );

  it("saves the copy before the message goes out, and sends nothing it could not save", async () => {
    const box = device();
    const write = deferred<void>();
    box.storage.save.mockImplementationOnce(() => write.promise);
    const send = vi.fn<Send>(async () => {});
    const client = createChatClient({
      transport: { send },
      pendingSend: { storage: box.storage, scope, retentionMs: 60_000 },
    });
    const pending = client.send("Hello");
    await flush();
    // It shows at once, and waits for its copy before it goes.
    expect(client.getState().messages).toMatchObject([{ role: "user", state: "sending" }]);
    expect(send).not.toHaveBeenCalled();
    write.reject(new Error("Quota exceeded"));
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "not_stored" },
      input: { text: "Hello" },
    });
    expect(send).not.toHaveBeenCalled();
    expect(client.getState().messages).toEqual([]);
  });

  it("refuses settings it could not keep safely", () => {
    const { storage } = device();
    for (const pendingSend of [
      { storage, scope, retentionMs: 0 },
      { storage, scope, retentionMs: Number.POSITIVE_INFINITY },
      { storage, scope: { principalId: " ", conversationId: "chat-1" }, retentionMs: 1 },
    ])
      expect(() => createChatClient({ transport: {}, pendingSend })).toThrow();
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
