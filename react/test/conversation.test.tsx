// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRun, useChat } from "../src/hooks.ts";
import type { DisplayMessage, DisplayPart } from "../src/protocol.ts";
import { Conversation, MessageList } from "../src/ui/conversation.tsx";
import type { ConversationData } from "../src/ui/context.tsx";
import { Message, type MessageRenderers } from "../src/ui/message.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// This fake checks composition and explicit commands, not layout. Real follow/pause, resize and
// prepend behavior still require the standalone browser example against the unpatched dependency.
const scroller = vi.hoisted(() => ({
  end: true,
  jump: vi.fn(),
  provider: vi.fn(),
  viewport: vi.fn(),
  item: vi.fn(),
}));
vi.mock("@shadcn/react/message-scroller", () => ({
  MessageScroller: {
    Provider: ({ children, ...props }: { children?: ReactNode }) => {
      scroller.provider(props);
      return <>{children}</>;
    },
    Root: (props: ComponentProps<"div">) => <div {...props} />,
    Viewport: ({
      preserveScrollOnPrepend,
      ...props
    }: ComponentProps<"div"> & { preserveScrollOnPrepend?: boolean }) => {
      scroller.viewport({ preserveScrollOnPrepend });
      return <div {...props} />;
    },
    Content: (props: ComponentProps<"div">) => <div {...props} />,
    Item: ({
      messageId,
      scrollAnchor,
      ...props
    }: ComponentProps<"div"> & { messageId?: string; scrollAnchor?: boolean }) => {
      scroller.item({ messageId, scrollAnchor });
      return <div data-message-id={messageId} {...props} />;
    },
  },
  useMessageScrollerScrollable: () => ({ start: true, end: scroller.end }),
  useMessageScroller: () => ({ scrollToEnd: scroller.jump }),
}));
vi.mock("../src/markdown.tsx", () => {
  throw new Error("The UI must not load Markdown.");
});
vi.mock("react-markdown", () => {
  throw new Error("The UI must not load a Markdown parser.");
});

const text = (value: string, settled = false): DisplayPart => ({
  type: "text",
  id: "text",
  text: value,
  settled,
});
const message = (
  parts: readonly DisplayPart[] = [text("Hello")],
  state: DisplayMessage["state"] = "live",
): DisplayMessage => ({ id: "answer", role: "assistant", state, parts });
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  scroller.end = true;
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => root.unmount());
  container.remove();
});
const draw = async (node: ReactNode) => {
  await act(async () => root.render(node));
};

function button(part: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[data-part="${part}"]`);
  if (!found) throw new Error(`Missing button: ${part}`);
  return found;
}

describe("conversation data and rendering", () => {
  it("renders plain host data and accepts both actual hook outputs", async () => {
    const plain: ConversationData = { messages: [message()], run: { status: "running" } };
    await draw(
      <Conversation chat={plain}>
        <header>Host header</header>
        <MessageList />
      </Conversation>,
    );
    expect(container.textContent).toContain("Host header");
    expect(container.textContent).toContain("Hello");
    function Chat() {
      const chat = useChat({ transport: {}, initialMessages: [message([text("Chat hook")])] });
      return (
        <Conversation chat={chat}>
          <MessageList />
        </Conversation>
      );
    }
    function Panel() {
      const run = useAgentRun({ transport: {}, initialMessages: [message([text("Run hook")])] });
      return (
        <Conversation chat={run}>
          <MessageList />
        </Conversation>
      );
    }
    await draw(<Chat />);
    expect(container.textContent).toContain("Chat hook");
    await draw(<Panel />);
    expect(container.textContent).toContain("Run hook");
    expect(container.querySelector("textarea, input, [data-part='send']")).toBeNull();
  });

  it("keeps loading and failed reads distinct from an empty conversation", async () => {
    const start = vi.fn();
    await draw(
      <MessageList
        messages={[]}
        readOnly={false}
        emptyAction={<button onClick={start}>Start</button>}
      />,
    );
    expect(container.textContent).toContain("Send a message");
    await act(async () => container.querySelector("button")?.click());
    expect(start).toHaveBeenCalledOnce();
    await draw(<MessageList messages={[]} loading />);
    expect(container.querySelector("[data-part='empty']")).toBeNull();
    expect(container.textContent).toContain("Loading messages");
    await draw(
      <MessageList
        messages={[]}
        error={{ code: "forbidden", message: "Ask an admin for access." }}
        errorAction={<a href="/access">Request access</a>}
      />,
    );
    expect(container.querySelector("[data-part='empty']")).toBeNull();
    expect(container.textContent).toContain("Ask an admin for access.");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/access");
    await draw(<MessageList messages={[]} />);
    expect(container.textContent).toContain("No messages yet");
  });

  it("shows a run failure with no messages instead of claiming work has not started", async () => {
    await draw(<Conversation chat={{ messages: [], run: { status: "failed" } }} />);
    expect(container.textContent).toContain("The run could not finish");
    expect(container.querySelector("[data-part='empty']")).toBeNull();
  });

  it("retains the current message and open tool details on disconnect", async () => {
    const tool: DisplayPart = {
      type: "tool",
      id: "tool",
      label: "Search",
      state: "running",
      detail: "Safe detail",
    };
    const data: ConversationData = {
      messages: [message([text("Partial reply"), tool])],
      connection: "open",
      run: { status: "running" },
    };
    await draw(<Conversation chat={data} />);
    const article = container.querySelector("article");
    const details = container.querySelector("details");
    if (!details) throw new Error("Missing details");
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    await draw(<Conversation chat={{ ...data, connection: "lost" }} />);
    expect(container.querySelector("article")).toBe(article);
    expect(container.querySelector("details")?.open).toBe(true);
    expect(container.textContent).toContain("Partial reply");
    expect(container.textContent).toContain("Updates may be missing");
    expect(container.textContent).not.toContain("Completed");
  });

  it("escapes plain text, keeps its spaces and hides unknown host data", async () => {
    const value = "<script>bad()</script>\n  indented";
    await draw(
      <Message
        message={message([
          text(value),
          {
            type: "data",
            id: "card",
            kind: "unknown",
            data: { secret: "not-for-default-rendering" },
          },
          {
            type: "tool",
            id: "tool",
            label: "Lookup",
            state: "failed",
            data: { private: "raw-tool-data" },
          },
        ])}
      />,
    );
    const rendered = container.querySelector<HTMLElement>("[data-part='text']");
    expect(rendered?.textContent).toBe(value);
    expect(rendered?.style.whiteSpace).toBe("pre-wrap");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("not-for-default-rendering");
    expect(container.textContent).not.toContain("raw-tool-data");
    expect(container.textContent).toContain("Failed");
  });

  it("accepts text and per-part renderers without importing Markdown", async () => {
    const source: DisplayPart = {
      type: "source",
      id: "source",
      marker: "1",
      title: "Host source",
      url: "https://example.com",
    };
    const renderText = vi.fn<NonNullable<MessageRenderers["renderText"]>>((part, context) => (
      <strong>
        {part.text}: {context.sources[0]?.title}
      </strong>
    ));
    await draw(
      <Message
        message={message([
          text("Custom"),
          source,
          { type: "data", id: "card", kind: "receipt", data: { total: 4 } },
        ])}
        renderText={renderText}
        renderPart={(part) => (part.type === "data" ? <aside>Receipt</aside> : undefined)}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("Custom: Host source");
    expect(container.querySelector("aside")?.textContent).toBe("Receipt");
    expect(renderText).toHaveBeenCalledOnce();
  });

  it("groups specialist children by explicit ids, not matching names or id syntax", async () => {
    await draw(
      <Message
        message={message([
          { type: "agent", id: "one", label: "Same name", state: "running" },
          {
            type: "agent",
            id: "unrelated/key",
            label: "Same name",
            state: "waiting",
            parentId: "one",
          },
          {
            type: "tool",
            id: "not-a-child-path",
            label: "Lookup",
            name: "lookup",
            state: "failed",
            agentId: "unrelated/key",
          },
          {
            type: "text",
            id: "child-text",
            text: "Specialist words",
            settled: true,
            agentId: "unrelated/key",
          },
        ])}
        toolLabels={{ lookup: "Find records" }}
        specialistLabels={{ "unrelated/key": "Reviewer" }}
      />,
    );
    const child = container.querySelector(
      "[data-part='specialist'][data-agent-id='unrelated/key']",
    );
    expect(child?.parentElement?.closest("[data-agent-id='one']")).not.toBeNull();
    expect(child?.textContent).toContain("Reviewer");
    expect(child?.textContent).toContain("Find records");
    expect(child?.textContent).toContain("Specialist words");
    expect(child?.querySelector("button")).toBeNull();
  });

  it("does not recurse forever or lose rows for cyclic parent records", async () => {
    await draw(
      <Message
        message={message([
          { type: "agent", id: "a", parentId: "b", label: "A", state: "running" },
          { type: "agent", id: "b", parentId: "a", label: "B", state: "running" },
        ])}
      />,
    );
    expect(container.querySelectorAll("[data-part='specialist']")).toHaveLength(2);
  });

  it("merges host labels with local overrides and supports native props", async () => {
    await draw(
      <Conversation
        chat={{ messages: [message()] }}
        labels={{ role: { assistant: "Helper" }, messages: "Thread" }}
        className="host"
        style={{ color: "red" }}
      >
        <MessageList labels={{ message: { live: "Writing now" } }} />
      </Conversation>,
    );
    expect(container.querySelector(".host")?.getAttribute("style")).toContain("red");
    expect(container.textContent).toContain("Helper");
    expect(container.textContent).toContain("Writing now");
    expect(
      container.querySelector("[data-part='scroll-viewport']")?.getAttribute("aria-label"),
    ).toBe("Thread");
  });

  it("renders without browser globals on the server", () => {
    vi.stubGlobal("window", undefined);
    expect(
      renderToString(
        <Conversation chat={{ messages: [message([text("Server view", true)], "settled")] }} />,
      ),
    ).toContain("Server view");
  });
});

describe("scroller composition and announcements", () => {
  it("uses end history and prepend preservation with every turn anchor disabled", async () => {
    const measure = vi.fn();
    await draw(
      <MessageList
        messages={[message()]}
        itemProps={() => ({ ref: measure, className: "measured" })}
        viewportProps={{ className: "viewport" }}
      />,
    );
    expect(scroller.provider).toHaveBeenLastCalledWith({
      autoScroll: true,
      defaultScrollPosition: "end",
      scrollPreviousItemPeek: 0,
    });
    expect(scroller.viewport).toHaveBeenLastCalledWith({
      preserveScrollOnPrepend: !CSS.supports("overflow-anchor", "auto"),
    });
    expect(scroller.item).toHaveBeenLastCalledWith({ messageId: "answer", scrollAnchor: false });
    expect(container.querySelector(".measured")?.getAttribute("data-scroll-anchor")).toBe("false");
    expect(measure).toHaveBeenCalled();
    expect(container.querySelector(".viewport")).not.toBeNull();
    expect(scroller.jump).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses exactly one prepend owner (native anchoring: %s)",
    async (native) => {
      const supports = vi.fn(() => native);
      vi.stubGlobal("CSS", { supports });
      await draw(
        <MessageList messages={[message()]} viewportProps={{ style: { color: "red" } }} />,
      );
      expect(supports).toHaveBeenCalledWith("overflow-anchor", "auto");
      expect(scroller.viewport).toHaveBeenLastCalledWith({ preserveScrollOnPrepend: !native });
      const viewport = container.querySelector<HTMLElement>('[data-part="scroll-viewport"]')!;
      expect(viewport.style.overflowAnchor).toBe(native ? "auto" : "none");
      expect(viewport.style.color).toBe("red");
      expect(scroller.jump).not.toHaveBeenCalled();
    },
  );

  it("only jumps after an explicit press, including when a new message is sent", async () => {
    const messages = [message()];
    await draw(<MessageList messages={messages} />);
    await draw(
      <MessageList
        messages={[
          ...messages,
          { id: "sent", role: "user", state: "sending", parts: [text("New message", true)] },
        ]}
      />,
    );
    expect(scroller.jump).not.toHaveBeenCalled();
    await act(async () => button("jump-to-latest").click());
    expect(scroller.jump).toHaveBeenCalledWith({ behavior: "smooth" });
    scroller.end = false;
    await draw(<MessageList messages={messages} />);
    expect(button("jump-to-latest").getAttribute("aria-disabled")).toBe("true");
    await act(async () => button("jump-to-latest").click());
    expect(scroller.jump).toHaveBeenCalledOnce();
  });

  it("uses an immediate explicit jump for reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    await draw(<MessageList messages={[message()]} />);
    await act(async () => button("jump-to-latest").click());
    expect(scroller.jump).toHaveBeenCalledWith({ behavior: "instant" });
  });

  it("announces settlement, not streamed tokens or tool changes", async () => {
    await draw(<MessageList messages={[message()]} />);
    const live = container.querySelector("[data-part='message-announcement']");
    expect(live?.textContent).toBe("");
    expect(container.querySelector("[data-part='scroll-content']")?.getAttribute("aria-live")).toBe(
      "off",
    );
    await draw(<MessageList messages={[message([text("Hello again")])]} />);
    expect(live?.textContent).toBe("");
    await draw(<MessageList messages={[message([text("Hello again", true)], "settled")]} />);
    expect(live?.textContent).toBe("Message ready.");
    const announcement = live?.firstChild;
    await draw(
      <MessageList
        messages={[
          message(
            [
              text("Hello again", true),
              { type: "tool", id: "tool", label: "Lookup", state: "done" },
            ],
            "settled",
          ),
        ]}
      />,
    );
    expect(live?.firstChild).toBe(announcement);
    expect(live?.textContent).toBe("Message ready.");
  });
});
