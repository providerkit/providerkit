// @vitest-environment happy-dom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTransport } from "../src/client.ts";
import { useAgentRun, useChat, type AgentRunValue, type ChatValue } from "../src/hooks.ts";
import type { ChatEvent, DisplayMessage, DisplayPart, RunInfo } from "../src/protocol.ts";
import type { Cursor } from "../src/state.ts";

// Tells React this file drives it through `act`, so it flushes every update before act returns.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** An event stream the test writes by hand. It ends with the client's signal unless told to
 * ignore it, the way a transport that does not honor its signal would. */
class Feed implements AsyncIterable<ChatEvent> {
  readonly #items: (ChatEvent | "end")[] = [];
  #wake: (() => void) | undefined;

  constructor(signal?: AbortSignal) {
    signal?.addEventListener("abort", () => this.end());
  }

  push(...events: ChatEvent[]): this {
    this.#items.push(...events);
    this.#wake?.();
    return this;
  }

  end(): this {
    this.#items.push("end");
    this.#wake?.();
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ChatEvent> {
    for (;;) {
      const item = this.#items.shift();
      if (item === "end") return;
      if (item) yield item;
      else
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
    }
  }
}

function tail(options: { honorsAbort?: boolean } = {}) {
  const opened: { cursor: Cursor | undefined; signal: AbortSignal; feed: Feed }[] = [];
  const observe = vi.fn((request: { cursor?: Cursor; signal: AbortSignal }) => {
    const feed = new Feed(options.honorsAbort === false ? undefined : request.signal);
    opened.push({ cursor: request.cursor, signal: request.signal, feed });
    return feed;
  });
  function latest(): Feed {
    const last = opened.at(-1);
    if (!last) throw new Error("The client opened no observation.");
    return last.feed;
  }
  return { observe, opened, latest };
}

const v = 1 as const;
const text = (id: string, value: string, settled = false): DisplayPart => ({
  type: "text",
  id,
  text: value,
  settled,
});
const assistant = (
  id: string,
  parts: DisplayPart[],
  state: DisplayMessage["state"] = "live",
): DisplayMessage => ({ id, role: "assistant", parts, state });
const run = (status: RunInfo["status"]): RunInfo => ({ id: "run-1", status, messageId: "a1" });
const put = (message: DisplayMessage): ChatEvent => ({ v, type: "message", message });

/** Lets streams deliver and the frame they were batched into paint. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

function words(message: DisplayMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function Chat(props: {
  transport: ChatTransport;
  id?: string;
  onValue?: (value: ChatValue) => void;
}) {
  const { transport, id, onValue } = props;
  const chat = useChat({ transport, id });
  useEffect(() => {
    onValue?.(chat);
  });
  return (
    <div>
      <ol>
        {chat.messages.map((message) => (
          <li key={message.id} data-state={message.state}>
            {words(message)}
          </li>
        ))}
      </ol>
      <button type="button" onClick={() => void chat.send("Hello")}>
        Send
      </button>
    </div>
  );
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useChat", () => {
  it("observes once under Strict Mode's double mount, and lets go on unmount", async () => {
    const host = tail();
    const transport: ChatTransport = { observe: host.observe };
    await act(async () =>
      root.render(
        <StrictMode>
          <Chat transport={transport} />
        </StrictMode>,
      ),
    );
    // Mounted, unmounted and mounted again: the first observation is closed, the second stays.
    expect(host.opened).toHaveLength(2);
    expect(host.opened[0]?.signal.aborted).toBe(true);
    expect(host.opened[1]?.signal.aborted).toBe(false);

    host.latest().push(put(assistant("a1", [text("t1", "Hello there")])), {
      v,
      type: "run",
      run: run("running"),
    });
    await settle();
    expect(container.querySelector("li")?.textContent).toBe("Hello there");

    await act(async () => root.unmount());
    expect(host.opened[1]?.signal.aborted).toBe(true);
    root = createRoot(container);
  });

  it("shows a message the moment the person sends it", async () => {
    const send = vi.fn<NonNullable<ChatTransport["send"]>>(() => new Promise(() => {}));
    let latest: ChatValue | undefined;
    await act(async () =>
      root.render(
        <Chat
          transport={{ send }}
          onValue={(value) => {
            latest = value;
          }}
        />,
      ),
    );
    expect(latest?.canSend).toBe(true);
    await act(async () => container.querySelector("button")?.click());
    const item = container.querySelector("li");
    expect(item?.textContent).toBe("Hello");
    expect(item?.dataset.state).toBe("sending");
    expect(latest?.status).toBe("sending");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects retained send and recall callbacks after a scope change and ignores a late enqueue receipt", async () => {
    const host = tail();
    const receipt = Promise.withResolvers<import("../src/protocol.ts").DisplayInput>();
    const enqueue = vi.fn<NonNullable<ChatTransport["enqueue"]>>(() => receipt.promise);
    const recallInput = vi.fn<NonNullable<ChatTransport["recallInput"]>>();
    const send = vi.fn<NonNullable<ChatTransport["send"]>>();
    const transport = { observe: host.observe, enqueue, recallInput, send };
    let latest: ChatValue | undefined;
    const onValue = (value: ChatValue) => {
      latest = value;
    };
    await act(async () =>
      root.render(<Chat transport={transport} id="first-person" onValue={onValue} />),
    );
    host.latest().push({ v, type: "run", run: run("running") });
    await settle();
    const old = latest!;
    let pending: ReturnType<ChatValue["send"]>;
    await act(async () => {
      pending = old.send("Private draft");
    });
    await act(async () =>
      root.render(<Chat transport={transport} id="second-person" onValue={onValue} />),
    );
    expect(await old.send("Late send")).toMatchObject({ ok: false });
    expect(await old.recallInput("old-input")).toMatchObject({ ok: false });
    const input = enqueue.mock.calls[0]![0];
    await act(async () => {
      receipt.resolve({ id: input.clientId, rootRunId: input.rootRunId, status: "queued" });
      await pending;
    });
    expect(latest?.inputs).toEqual([]);
    expect(latest?.messages).toEqual([]);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(recallInput).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("starts over for another conversation, and the last one's late events never show", async () => {
    const host = tail({ honorsAbort: false });
    const transport: ChatTransport = { observe: host.observe };
    await act(async () => root.render(<Chat transport={transport} id="chat-a" />));
    host.latest().push(put(assistant("a1", [text("t1", "From chat A")])));
    await settle();
    expect(container.textContent).toContain("From chat A");

    await act(async () => root.render(<Chat transport={transport} id="chat-b" />));
    expect(host.opened).toHaveLength(2);
    expect(host.opened[0]?.signal.aborted).toBe(true);
    // The first conversation's stream ignores its signal and keeps talking.
    host.opened[0]?.feed.push(put(assistant("a2", [text("t2", "Late from chat A")])));
    host.latest().push(put(assistant("b1", [text("t3", "From chat B")])));
    await settle();
    expect(container.textContent).toContain("From chat B");
    expect(container.textContent).not.toContain("chat A");
  });
});

describe("useAgentRun", () => {
  function Panel(props: { transport: ChatTransport; onValue: (value: AgentRunValue) => void }) {
    const { transport, onValue } = props;
    const panel = useAgentRun({ transport });
    useEffect(() => {
      onValue(panel);
    });
    const rows = panel.messages.flatMap((message) => message.parts);
    return (
      <section data-status={panel.run.status} data-connection={panel.connection}>
        {rows.map((part) =>
          part.type === "agent" || part.type === "tool" ? (
            <p key={part.id} data-state={part.state}>
              {part.label}
            </p>
          ) : null,
        )}
      </section>
    );
  }

  const researcher = (state: RunInfo["status"]): DisplayPart => ({
    type: "agent",
    id: "run-1/researcher",
    label: "Researcher",
    state: state === "idle" ? "running" : state,
  });
  const writer = (state: RunInfo["status"]): DisplayPart => ({
    type: "agent",
    id: "run-1/writer",
    label: "Writer",
    state: state === "idle" ? "running" : state,
  });
  const search = (state: "running" | "done"): DisplayPart => ({
    type: "tool",
    id: "op-search",
    label: "Searching the web",
    state,
    agentId: "run-1/researcher",
  });

  it("opens mid-run, closes, and reopens after the run finished", async () => {
    const host = tail();
    const transport: ChatTransport = { observe: host.observe };
    let latest: AgentRunValue | undefined;
    const onValue = (value: AgentRunValue) => {
      latest = value;
    };

    await act(async () => root.render(<Panel transport={transport} onValue={onValue} />));
    expect(host.opened[0]?.cursor).toBeUndefined();
    host.latest().push({
      v,
      type: "snapshot",
      messages: [assistant("a1", [researcher("running"), search("running"), writer("running")])],
      run: run("running"),
      seq: 5,
      segment: "s1",
    });
    await settle();
    const section = () => container.querySelector("section");
    expect(section()?.dataset.status).toBe("running");
    expect([...container.querySelectorAll("p")].map((row) => row.dataset.state)).toEqual([
      "running",
      "running",
      "running",
    ]);
    host
      .latest()
      .push(
        { v, type: "part", messageId: "a1", part: search("done"), seq: 6, segment: "s1" },
        { v, type: "part", messageId: "a1", part: researcher("completed"), seq: 7, segment: "s1" },
      );
    await settle();
    expect(container.querySelector("p")?.dataset.state).toBe("completed");
    expect(latest && "send" in latest).toBe(false);
    expect(typeof latest?.respond).toBe("function");

    // Closed: the panel stops watching, and the run goes on without it.
    await act(async () => root.unmount());
    expect(host.opened[0]?.signal.aborted).toBe(true);

    root = createRoot(container);
    await act(async () => root.render(<Panel transport={transport} onValue={onValue} />));
    expect(host.opened).toHaveLength(2);
    expect(host.opened[1]?.cursor).toBeUndefined();
    host
      .latest()
      .push({
        v,
        type: "snapshot",
        messages: [
          assistant(
            "a1",
            [
              researcher("completed"),
              search("done"),
              writer("completed"),
              text("t1", "Done.", true),
            ],
            "settled",
          ),
        ],
        run: run("completed"),
      })
      .end();
    await settle();
    expect(section()?.dataset.status).toBe("completed");
    expect(section()?.dataset.connection).toBe("idle");
    expect([...container.querySelectorAll("p")].map((row) => row.dataset.state)).toEqual([
      "completed",
      "done",
      "completed",
    ]);
    // A finished run is not watched again.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });
    expect(host.opened).toHaveLength(2);
  });
});
