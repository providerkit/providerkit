// @vitest-environment happy-dom
// Real React updates over tiny host controls. No React Native runtime, network or device.
import { act, createElement, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DisplayMessage, DisplayPart, RequestResponse } from "@providerkit/react/protocol";
import { useComposer } from "@providerkit/react";
import {
  ChatClasses,
  Composer,
  ErrorNotice,
  QueuedMessages,
  Markdown,
  MessageList,
  RequestCard,
  RunBand,
  type MessageListChat,
} from "../src/ui/index.ts";

const { lists, announce, scroll } = vi.hoisted(() => ({
  lists: vi.fn(),
  announce: vi.fn(),
  scroll: vi.fn(),
}));
interface HostProps {
  children?: ReactNode;
  className?: string;
  style?: unknown;
  dataSet?: Record<string, string>;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityLiveRegion?: string;
  accessibilityRole?: string;
  disabled?: boolean;
}
function host(kind: string) {
  return ({
    children,
    className,
    style,
    dataSet,
    onPress,
    accessibilityLabel,
    accessibilityLiveRegion,
    accessibilityRole,
    disabled,
  }: HostProps) =>
    createElement(
      kind,
      {
        className,
        "data-style": style && JSON.stringify(style),
        "data-state": dataSet?.state,
        "data-action": dataSet?.action,
        onClick: onPress,
        "aria-label": accessibilityLabel,
        "aria-live": accessibilityLiveRegion,
        role: accessibilityRole,
        disabled,
      },
      children,
    );
}
vi.mock("react-native", () => ({
  View: host("div"),
  Text: host("span"),
  Pressable: host("button"),
  ActivityIndicator: host("i"),
  Switch: ({ onValueChange, value }: { onValueChange: (on: boolean) => void; value: boolean }) => (
    <input type="checkbox" checked={value} onChange={() => onValueChange(!value)} />
  ),
  TextInput: ({ value, onChangeText }: { value: string; onChangeText: (text: string) => void }) => (
    <textarea value={value} onChange={(e) => onChangeText(e.currentTarget.value)} />
  ),
  AccessibilityInfo: {
    announceForAccessibility: announce,
    isReduceMotionEnabled: async () => true,
    addEventListener: () => ({ remove() {} }),
  },
  FlatList: ({
    data,
    renderItem,
    ListEmptyComponent,
    ListFooterComponent,
    ref,
  }: {
    data: readonly DisplayMessage[];
    renderItem: (item: { item: DisplayMessage; index: number }) => ReactNode;
    ListEmptyComponent: ReactNode;
    ListFooterComponent: ReactNode;
    ref: Ref<{ scrollToEnd: typeof scroll }>;
  }) => {
    lists();
    useImperativeHandle(ref, () => ({ scrollToEnd: scroll }), []);
    return (
      <>
        {data.length
          ? data.map((item, index) => <div key={item.id}>{renderItem({ item, index })}</div>)
          : ListEmptyComponent}
        {ListFooterComponent}
      </>
    );
  },
}));

let root: Root;
let node: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  node = document.createElement("div");
  root = createRoot(node);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
const draw = (element: ReactNode) => act(() => root.render(element));
const press = async (name: string) => {
  const button = [...node.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === name,
  );
  if (!button) throw new Error(`No button named ${name}`);
  await act(() => button.click());
};
function reply(id: string, text: string, live = false): DisplayMessage {
  return {
    id,
    role: "assistant",
    state: live ? "live" : "settled",
    parts: [{ id: "words", type: "text", text, settled: !live }],
  };
}

it("updates only the live row, then lets the list replace it with the saved answer", async () => {
  const past = reply("past", "Saved reply");
  const read = vi.fn((_part: DisplayPart, context: { message: DisplayMessage }) => {
    void context;
    return undefined;
  });
  const base: MessageListChat = {
    messages: [],
    status: "running",
    run: { status: "running", id: "r" },
    connection: "open",
    requests: [],
  };
  const show = (live: DisplayMessage) =>
    draw(<MessageList chat={{ ...base, messages: [past, live] }} renderPart={read} />);
  await show(reply("live", "Hel", true));
  const first = lists.mock.calls.length;
  read.mockClear();
  await show(reply("live", "Hello", true));
  expect(lists).toHaveBeenCalledTimes(first);
  expect(read.mock.calls.map(([, ctx]) => ctx.message.id)).toEqual(["live"]);
  expect(node.textContent).toContain("Hello");
  await show(reply("live", "Saved final answer"));
  expect(node.textContent).toContain("Saved final answer");
  expect(lists.mock.calls.length).toBeGreaterThan(first);
});

it("calls the host for every part before folding, replacing or hiding rows", async () => {
  const parts: DisplayPart[] = [
    { type: "tool", id: "one", name: "read", label: "Read", state: "done", summary: "first file" },
    { type: "tool", id: "two", name: "read", label: "Read", state: "done", summary: "second file" },
    {
      type: "tool",
      id: "filed",
      name: "file",
      label: "Filed",
      state: "done",
      data: { title: "A ticket" },
    },
    { type: "thinking", id: "think", settled: true, text: "not for display", durationMs: 2000 },
    { type: "data", id: "card", kind: "plan", data: null },
    { type: "text", id: "words", text: "The answer", settled: true },
    { type: "source", id: "src", title: "A source" },
    { type: "attachment", id: "att", name: "notes.txt", mediaType: "text/plain" },
    { type: "agent", id: "child", label: "Helper", state: "completed" },
    { type: "approval", id: "ask", title: "Send?", state: "approved" },
    { type: "question", id: "q", title: "Which one?", state: "answered" },
    { type: "client-tool", id: "device", title: "Open", state: "stale" },
  ];
  const render = vi.fn((p: DisplayPart) =>
    p.id === "filed" ? <span>Ticket filed</span> : p.id === "card" ? null : undefined,
  );
  await draw(
    <ChatClasses value={{ tool: { hint: "app-hint" } }}>
      <MessageList
        renderPart={render}
        tools={{ byName: { read: { done: "Read a file" } } }}
        chat={{
          messages: [{ ...reply("a", ""), parts }],
          status: "ready",
          run: { status: "completed" },
          connection: "open",
          requests: [],
        }}
      />
    </ChatClasses>,
  );
  expect(render.mock.calls.map(([p]) => p.id)).toEqual(parts.map((p) => p.id));
  expect(node.textContent).toContain("Ticket filed");
  expect(node.textContent).not.toContain("not for display");
  expect(node.textContent).toContain("Thought for 2s");
  await press("Read a file and 1 more");
  expect([...node.querySelectorAll(".app-hint")].map((el) => el.textContent)).toEqual([
    "first file",
    "second file",
  ]);
});

it("draws an image only by opt-in and sends only allowed links to the app", async () => {
  const open = vi.fn();
  const image = vi.fn(() => <span>Image drawn</span>);
  const text =
    "[Mail](mailto:me@example.com) [Read](https://site.example) ![Map](https://site.example/map.png)";
  await draw(<Markdown text={text} onLink={open} />);
  expect(node.querySelectorAll('[role="link"]')).toHaveLength(0);
  await draw(<Markdown text={text} linkSchemes={["https"]} onLink={open} />);
  const links = node.querySelectorAll<HTMLElement>('[role="link"]');
  expect(links).toHaveLength(1);
  await act(() => links[0]?.click());
  expect(open).toHaveBeenCalledExactlyOnceWith("https://site.example");
  expect(node.textContent).toContain("Map");
  await draw(<Markdown text={text} renderImage={image} />);
  expect(image).toHaveBeenCalledExactlyOnceWith({
    src: "https://site.example/map.png",
    alt: "Map",
  });
});

it("announces one result, never the saved result on mount or a ticking clock", async () => {
  const requests: never[] = [];
  const stop = async () => ({ ok: true as const });
  const show = (status: "completed" | "running", id: string) =>
    draw(
      <RunBand
        startedAt={1000}
        endedAt={4000}
        chat={{
          run: { status, id },
          status: status === "running" ? "running" : "ready",
          requests,
          stop,
          canStop: true,
        }}
      />,
    );
  await show("completed", "old");
  expect(announce).not.toHaveBeenCalled();
  await show("running", "new");
  await show("running", "new");
  expect(node.querySelector('[aria-live="polite"]')?.textContent).toBe("Working");
  await show("completed", "new");
  await show("completed", "new");
  expect(announce).toHaveBeenCalledExactlyOnceWith("Done");
  expect(node.textContent).toContain("Done · 3s");
});

it("does not carry a decision across reviewed versions and waits for confirmation after a receipt", async () => {
  const respond = vi.fn(
    async (_id: string, _response: RequestResponse, _version: number | string) => ({
      ok: true as const,
      outcome: "accepted" as const,
    }),
  );
  const approveForm = {
    type: "object",
    properties: { remember: { type: "boolean", title: "Remember here" } },
  };
  const show = (version: number) =>
    draw(
      <RequestCard
        request={{
          messageId: "m",
          part: {
            type: "approval",
            id: "ask",
            title: "Send the change?",
            state: "pending",
            approveForm,
          },
        }}
        review={{ version, respond }}
      />,
    );
  await show(42);
  await act(() => node.querySelector("input")?.click());
  await show(43);
  expect(node.querySelector("input")?.checked).toBe(false);
  await press("Approve");
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    "ask",
    { type: "approve", data: { remember: false } },
    43,
  );
  await press("Approve");
  expect(respond).toHaveBeenCalledTimes(1);
});

it("hands a recalled message and its files back only after the host confirms", async () => {
  const input = {
    id: "line",
    rootRunId: "r",
    status: "queued" as const,
    canRecall: true,
    text: "Add this",
    attachments: [{ id: "file", name: "notes.txt", mediaType: "text/plain" }],
  };
  const recalled = vi.fn();
  const recallInput = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: { code: "taken", message: "Already read" } })
    .mockResolvedValueOnce({ ok: true });
  await draw(<QueuedMessages chat={{ inputs: [input], recallInput }} onRecalled={recalled} />);
  expect(node.textContent).toContain("notes.txt");
  await press("Take back");
  expect(recalled).not.toHaveBeenCalled();
  await press("Take back");
  expect(recalled).toHaveBeenCalledExactlyOnceWith(input);
});

it("shows the fix and app action instead of Retry for a refusal, preserving the style slots", async () => {
  const retry = vi.fn();
  await draw(
    <ChatClasses
      styles={{ notice: { root: { padding: 1 } } }}
      value={{ notice: { root: "app-notice", title: "app-title" } }}
    >
      <ErrorNotice
        style={{ margin: 2 }}
        title="Could not send"
        error={{ code: "credits", message: "Not enough credit", retryable: false }}
        describe={() => ({
          cause: "Your balance is zero.",
          fix: "Add credit to continue.",
          recover: "none",
        })}
        onRetry={retry}
      >
        <button>See usage</button>
      </ErrorNotice>
    </ChatClasses>,
  );
  expect(node.querySelector(".app-notice")?.getAttribute("data-style")).toBe(
    '[{"padding":1},{"margin":2}]',
  );
  expect(node.querySelector(".app-title")?.textContent).toBe("Could not send");
  expect(node.textContent).toContain("Your balance is zero. Add credit to continue.");
  expect([...node.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["See usage"]);
});

it("keeps an oversized paste and sends the phone picker's file through the app uploader", async () => {
  const photo = { name: "desk.jpg", type: "image/jpeg", uri: "content://picked" };
  const upload = vi.fn(async (file: typeof photo) => ({
    id: "server-file",
    name: file.name,
    mediaType: file.type,
  }));
  const pick = vi.fn(async () => [photo]);
  function Screen() {
    const composer = useComposer({
      scope: { principalId: "person", conversationId: "room" },
      initialText: "a whole pasted note",
      attachments: { upload },
      send: async () => ({ ok: true as const, messageId: "m", outcome: "accepted" as const }),
    });
    return <Composer composer={composer} maxLength={5} pick={pick} />;
  }
  await draw(<Screen />);
  expect(node.querySelector("textarea")?.value).toBe("a whole pasted note");
  expect(node.textContent).toContain("19 characters. The limit is 5.");
  expect(node.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(true);
  await press("Add files");
  expect(upload.mock.calls[0]?.[0]).toBe(photo);
  expect(node.textContent).toContain(photo.name);
});
