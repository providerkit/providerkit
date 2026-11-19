import { createChatClient, TransportError, type Cursor, type DraftScope } from "@providerkit/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchDevice, type AppStateLike, type NetInfoLike } from "../src/device.ts";
import { createPendingSendStorage } from "../src/storage.ts";
import { createSseTransport, type SendCommand } from "../src/transport.ts";
import { at, drain, need, noCommand, reader, run, status } from "./fakes.ts";

const scope: DraftScope = { principalId: "person-1", conversationId: "chat-1" };

/** React Native's AppState, moved by hand. */
function appState(initial: string | null = "active") {
  const listeners = new Set<(state: string) => void>();
  const fake = {
    currentState: initial,
    addEventListener(_type: "change", listener: (state: string) => void) {
      listeners.add(listener);
      return {
        remove() {
          listeners.delete(listener);
        },
      };
    },
  } satisfies AppStateLike;
  function move(state: string): void {
    fake.currentState = state;
    for (const listener of [...listeners]) listener(state);
  }
  return { fake, move, listeners };
}

/** NetInfo, reporting by hand. Until the test reports, it has said nothing, as at launch. */
function netInfo() {
  const listeners = new Set<(state: { isConnected: boolean | null }) => void>();
  const fake = {
    addEventListener(listener: (state: { isConnected: boolean | null }) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies NetInfoLike;
  function report(isConnected: boolean | null): void {
    for (const listener of [...listeners]) listener({ isConnected });
  }
  return { fake, report, listeners };
}

const signal = new AbortController().signal;

describe("watchDevice", () => {
  it("counts the app as away only while it is in the background", () => {
    const app = appState();
    const device = watchDevice({ appState: app.fake });
    expect(device.active).toBe(true);
    // A call or Control Center over the app: the app and its stream keep running.
    app.move("inactive");
    expect(device.active).toBe(true);
    app.move("background");
    expect(device.active).toBe(false);
    app.move("active");
    expect(device.active).toBe(true);
    expect(watchDevice({ appState: appState("background").fake }).active).toBe(false);
    expect(watchDevice({ appState: appState(null).fake }).active).toBe(true);
  });

  it("counts the phone as offline only when NetInfo says there is no connection", () => {
    const net = netInfo();
    const device = watchDevice({ appState: appState().fake, netInfo: net.fake });
    expect(device.offline).toBe(false);
    // What NetInfo says at launch, before it knows.
    net.report(null);
    expect(device.offline).toBe(false);
    net.report(false);
    expect(device.offline).toBe(true);
    net.report(true);
    expect(device.offline).toBe(false);
    expect(watchDevice({ appState: appState().fake }).offline).toBe(false);
  });

  it("tells subscribers only about a change, and stops listening when stopped", () => {
    const app = appState();
    const net = netInfo();
    const device = watchDevice({ appState: app.fake, netInfo: net.fake });
    const changed = vi.fn();
    const off = device.subscribe(changed);
    app.move("inactive");
    net.report(true);
    net.report(null);
    expect(changed).not.toHaveBeenCalled();
    app.move("background");
    net.report(false);
    expect(changed).toHaveBeenCalledTimes(2);
    off();
    app.move("active");
    expect(changed).toHaveBeenCalledTimes(2);
    device.stop();
    expect(app.listeners.size).toBe(0);
    expect(net.listeners.size).toBe(0);
  });
});

describe("createSseTransport with the app's state", () => {
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

  it("waits to reconnect until the app is on screen and online, spending none of the client's tries", async () => {
    const app = appState();
    const net = netInfo();
    const host = reader();
    const device = watchDevice({ appState: app.fake, netInfo: net.fake });
    net.report(false);
    const client = createChatClient({
      transport: createSseTransport({
        observe: events,
        open: host.open,
        command: noCommand,
        device,
      }),
    });
    const detach = client.attach();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.open).not.toHaveBeenCalled();
    expect(client.getState().connection).toBe("connecting");
    net.report(true);
    await flush();
    expect(host.open).toHaveBeenCalledTimes(1);

    host.push(status(run("running"), at(1)));
    await flush();
    app.move("background");
    host.latest().handlers.onClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.open).toHaveBeenCalledTimes(1);
    expect(client.getState().connection).toBe("reconnecting");
    app.move("active");
    await flush();
    expect(host.open).toHaveBeenCalledTimes(2);
    expect(host.latest().request.url).toBe("https://host.test/events?segment=s1&after=1");
    detach();
  });

  it("lets a waiting reconnect go, opening nothing, once the client stops watching", async () => {
    const net = netInfo();
    const host = reader();
    const device = watchDevice({ appState: appState().fake, netInfo: net.fake });
    net.report(false);
    const client = createChatClient({
      transport: createSseTransport({
        observe: events,
        open: host.open,
        command: noCommand,
        device,
      }),
    });
    const detach = client.attach();
    await flush();
    detach();
    net.report(true);
    await flush();
    expect(host.open).not.toHaveBeenCalled();
  });

  it("keeps a message that may have arrived when Retry is pressed offline", async () => {
    // A refusal here would make the client forget the message and its saved copy, though the first
    // send may have reached the host. Sent again with a new clientId, it could run twice.
    const net = netInfo();
    const host = reader();
    const device = watchDevice({ appState: appState().fake, netInfo: net.fake });
    const items = new Map<string, string>();
    const storage = createPendingSendStorage({
      getItem: async (key) => items.get(key) ?? null,
      setItem: async (key, value) => items.set(key, value),
      removeItem: async (key) => items.delete(key),
    });
    const command = vi
      .fn<SendCommand>()
      // The first reply is lost, and the Retry made offline fails the way a phone's fetch does.
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValue({ received: true });
    const client = createChatClient({
      transport: createSseTransport({
        observe: events,
        send: () => "https://host.test/messages",
        open: host.open,
        command,
        device,
      }),
      pendingSend: { storage, scope, retentionMs: 86_400_000 },
    });
    const detach = client.attach();
    await flush();
    const sent = await client.send("Book the 9am flight");
    if (!sent.ok) throw new Error("An unknown outcome keeps the message.");
    await flush();
    host.push(status(run("completed"), at(1)));
    await flush();
    expect(client.getState().canRetry).toBe(true);

    net.report(false);
    expect(await client.retry(sent.messageId)).toMatchObject({ ok: true, outcome: "unknown" });
    expect(client.getState().messages).toMatchObject([{ id: sent.messageId, state: "failed" }]);
    expect(client.getState().messageErrors).toHaveProperty(sent.messageId);
    expect(items.size).toBe(1);

    net.report(true);
    await flush();
    host.push(status(run("completed"), at(2)));
    await flush();
    expect(await client.retry(sent.messageId)).toMatchObject({ ok: true, outcome: "accepted" });
    const [first, ...again] = command.mock.calls.map(([request]) => request.body);
    expect(again).toEqual([first, first]);
    await flush();
    expect(items.size).toBe(0);
    detach();
  });

  it("ends a stream that goes silent as a lost connection", async () => {
    const host = reader();
    const transport = createSseTransport({
      observe: () => "https://host.test/events",
      open: host.open,
      command: noCommand,
      silenceMs: 30_000,
    });
    const reading = drain(need(transport.observe, "observe")({ signal }));
    host.push(status(run("running"), at(1)));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(host.latest().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.latest().aborted).toBe(true);
    const { delivered, error } = await reading;
    expect(delivered).toEqual([status(run("running"), at(1))]);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({
      outcome: "unknown",
      error: {
        code: "stream_silent",
        message: "The server sent nothing for 30 seconds, so the connection was closed.",
      },
    });
  });

  it("counts every frame as a sign of life, a heartbeat too", async () => {
    const host = reader();
    const transport = createSseTransport({
      observe: () => "https://host.test/events",
      open: host.open,
      command: noCommand,
      silenceMs: 30_000,
    });
    const reading = drain(need(transport.observe, "observe")({ signal }));
    for (let beat = 0; beat < 5; beat += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      host.latest().handlers.onData('{"type":"heartbeat"}');
    }
    expect(host.latest().aborted).toBe(false);
    host.latest().handlers.onClose();
    expect(await reading).toEqual({ delivered: [], error: undefined });
  });

  it("judges silence only while the app is on screen, with a fresh window when it comes back", async () => {
    const app = appState();
    const host = reader();
    const transport = createSseTransport({
      observe: () => "https://host.test/events",
      open: host.open,
      command: noCommand,
      silenceMs: 30_000,
      device: watchDevice({ appState: app.fake }),
    });
    const reading = drain(need(transport.observe, "observe")({ signal }));
    await vi.advanceTimersByTimeAsync(10_000);
    app.move("background");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.latest().aborted).toBe(false);
    app.move("active");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(host.latest().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.latest().aborted).toBe(true);
    expect((await reading).error).toMatchObject({ error: { code: "stream_silent" } });
  });

  it("reconnects from the cursor after a silent stream, through the client", async () => {
    const host = reader();
    const client = createChatClient({
      transport: createSseTransport({
        observe: events,
        open: host.open,
        command: noCommand,
        silenceMs: 30_000,
      }),
    });
    const detach = client.attach();
    await flush();
    host.push(status(run("running"), at(1)));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.getState()).toMatchObject({ status: "running", connection: "reconnecting" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.opened).toHaveLength(2);
    expect(host.latest().request.url).toBe("https://host.test/events?segment=s1&after=1");
    detach();
  });

  it("refuses a silence limit that is not a finite number above zero", () => {
    for (const silenceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() =>
        createSseTransport({ open: reader().open, command: noCommand, silenceMs }),
      ).toThrow(RangeError);
  });
});
