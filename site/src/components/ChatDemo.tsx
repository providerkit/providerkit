import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  createChatClient,
  useComposer,
  TransportError,
  type ChatTransport,
  type DraftStorage,
} from "@providerkit/react";
import {
  parseChatEvent,
  type ChatEvent,
  type DisplayMessage,
  type RunInfo,
} from "@providerkit/react/protocol";
import { Composer, Conversation, MessageList, RunStatusDisplay } from "@providerkit/react/ui";
import { Markdown } from "@providerkit/react/markdown";

const SCOPE = { principalId: "public-demo", conversationId: "chat" };
const DRAFT_KEY = "providerkit.demo.draft.v1";
const CHAT_KEY = "providerkit.demo.chat.v1";
const RETENTION_MS = 60 * 60_000;
const draftStorage: DraftStorage = {
  async load(_scope, { signal }) {
    signal.throwIfAborted();
    return readSaved(DRAFT_KEY);
  },
  async save(_scope, draft, { signal }) {
    signal.throwIfAborted();
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  },
};

type DemoStorage = Pick<Storage, "getItem" | "removeItem">;

function readSaved(key: string, store: DemoStorage = sessionStorage): unknown {
  const saved = store.getItem(key);
  if (saved === null) return undefined;
  const value: unknown = JSON.parse(saved);
  if (
    !value ||
    typeof value !== "object" ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  )
    throw new Error("Invalid saved demo");
  if (value.expiresAt <= Date.now()) {
    store.removeItem(key);
    return undefined;
  }
  return value;
}

export function restoreDemo(storage?: DemoStorage): {
  messages: readonly DisplayMessage[];
  run?: RunInfo;
  notice?: string;
} {
  try {
    const value = readSaved(CHAT_KEY, storage);
    if (value === undefined) return { messages: [] };
    if (!value || typeof value !== "object" || !("event" in value))
      throw new Error("Invalid saved demo");
    const event = parseChatEvent(value.event);
    if (event?.type !== "snapshot") throw new Error("Invalid saved demo");
    const interrupted =
      event.run.status === "running" ||
      event.run.status === "waiting" ||
      event.messages.some((message) => message.state === "live" || message.state === "sending");
    return {
      run: interrupted ? { ...event.run, status: "stopped" } : event.run,
      messages: event.messages.map((message) => ({
        ...message,
        state: message.state === "live" || message.state === "sending" ? "stopped" : message.state,
        parts: message.parts.map((part) =>
          part.type === "text" ? { ...part, settled: true } : part,
        ),
      })),
      ...(interrupted
        ? {
            notice:
              "The sample reply stopped when this page closed. Your text is still here; send a message to try again.",
          }
        : {}),
    };
  } catch {
    return {
      messages: [],
      notice:
        "The saved demo could not be opened. You can still write a message. Clear the demo to remove the unreadable copy.",
    };
  }
}

// The client accepts initial messages, but its run stays idle until the next reply starts.
function visibleRun(run: RunInfo, restored?: RunInfo): RunInfo {
  return run.status === "idle" && restored ? restored : run;
}

export function createSampleTransport(refuse: boolean): ChatTransport {
  return {
    async send(input, { signal }) {
      signal.throwIfAborted();
      if (refuse)
        throw new TransportError("refused", {
          code: "demo_refused",
          message:
            "This example refused the send. Choose Sample replies, then try again. Your draft is unchanged.",
        });
      if (input.text.length > 1200)
        throw new TransportError("refused", {
          code: "demo_length",
          message: `That message has ${input.text.length} characters. This demo allows 1,200. Shorten it and try again.`,
        });
      const id = `sample-${input.clientId}`;
      const messageId = `reply-${id}`;
      async function* events(): AsyncGenerator<ChatEvent> {
        if (signal.aborted) return;
        yield {
          v: 1,
          type: "message",
          message: {
            id: input.clientId,
            clientId: input.clientId,
            role: "user",
            state: "settled",
            parts: [{ id: "text", type: "text", text: input.text, settled: true }],
          },
        };
        yield { v: 1, type: "run", run: { id, status: "running", messageId } };
        yield {
          v: 1,
          type: "message",
          message: {
            id: messageId,
            role: "assistant",
            state: "live",
            parts: [{ id: "text", type: "text", text: "", settled: false }],
          },
        };
        const chunks = [
          "This is a **sample reply**. ",
          "The message list, composer and Stop control ",
          "come from `@providerkit/react`.\n\n",
          "Your app supplies the transport and decides what the person may see.",
        ];
        for (const delta of chunks) {
          // ponytail: a short local timer makes streaming visible; no request or work is replayed.
          await new Promise<void>((resolve) => setTimeout(resolve, 180));
          if (signal.aborted) return;
          yield { v: 1, type: "text", messageId, partId: "text", delta };
        }
        yield {
          v: 1,
          type: "message",
          message: {
            id: messageId,
            role: "assistant",
            state: "settled",
            parts: [{ id: "text", type: "text", text: chunks.join(""), settled: true }],
          },
        };
        yield { v: 1, type: "run", run: { id, status: "completed", messageId } };
      }
      return { events: events() };
    },
  };
}

function ChatSession({
  refuse,
  onClear,
  onScenario,
  focusComposer,
}: {
  refuse: boolean;
  onClear: () => void;
  onScenario: (refuse: boolean) => void;
  focusComposer: boolean;
}) {
  const [initial] = useState(restoreDemo);
  const [notice, setNotice] = useState(initial.notice);
  const [confirmClear, setConfirmClear] = useState(false);
  const erasing = useRef(false);
  const clearButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const transport = useMemo(() => createSampleTransport(refuse), [refuse]);
  const [client] = useState(() =>
    createChatClient({ transport, initialMessages: initial.messages }),
  );
  const chat = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  const composer = useComposer({
    scope: SCOPE,
    send: client.send,
    canSend: chat.canSend && !confirmClear,
    draft: { storage: draftStorage, retentionMs: RETENTION_MS, debounceMs: 0 },
  });
  const { flushDraft } = composer;
  useLayoutEffect(() => client.setOptions({ transport }), [client, transport]);

  useEffect(() => {
    const detach = client.attach();
    let last = client.getState();
    // Save the view the person sees, including Stop. The transport never owns a storage writer.
    function saveView() {
      const current = client.getState();
      if (erasing.current || (current.messages === last.messages && current.run === last.run))
        return;
      last = current;
      try {
        sessionStorage.setItem(
          CHAT_KEY,
          JSON.stringify({
            expiresAt: Date.now() + RETENTION_MS,
            event: {
              v: 1,
              type: "snapshot",
              messages: current.messages,
              run: visibleRun(current.run, initial.run),
            },
          }),
        );
        setNotice(undefined);
      } catch {
        setNotice(
          "This tab could not save the conversation. Copy any text you want to keep before leaving.",
        );
      }
    }
    const unsubscribe = client.subscribe(saveView);
    const beforeLeaving = () => {
      saveView();
      void flushDraft();
    };
    window.addEventListener("pagehide", beforeLeaving);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", beforeLeaving);
      detach();
      // Only this local demo's scripted reply is being stopped, never another host's work.
      void client.stop();
    };
  }, [client, initial.run, flushDraft]);

  useEffect(() => {
    if (confirmClear) keepButton.current?.focus();
  }, [confirmClear]);

  const unsavedDraft = Boolean(composer.text) && composer.draft.status === "failed";
  useEffect(() => {
    if (!unsavedDraft) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [unsavedDraft]);

  async function clear() {
    if (erasing.current) return;
    erasing.current = true;
    try {
      await client.stop();
      // Drain earlier draft writes. Even a full store can delete the unwanted draft.
      await flushDraft();
      sessionStorage.removeItem(DRAFT_KEY);
      sessionStorage.removeItem(CHAT_KEY);
      onClear();
    } catch {
      erasing.current = false;
      setNotice(
        "The demo could not be cleared. Check this browser's storage settings, then try again.",
      );
    }
  }

  return (
    <div className="chat-demo">
      <div className="example-choices" aria-label="Chat example">
        <button
          type="button"
          disabled={!chat.canSend}
          aria-pressed={!refuse}
          onClick={() => onScenario(false)}
        >
          Sample replies
        </button>
        <button
          type="button"
          disabled={!chat.canSend}
          aria-pressed={refuse}
          onClick={() => onScenario(true)}
        >
          Refused send
        </button>
      </div>
      {notice && (
        <p role="status" className="demo-notice">
          {notice}
        </p>
      )}
      <Conversation
        chat={{ ...chat, run: visibleRun(chat.run, initial.run), stop: client.stop }}
        labels={{ empty: "Write a message below to see a sample reply." }}
      >
        <MessageList
          renderText={(part, context) => (
            <Markdown text={part.text} streaming={!part.settled} sources={context.sources} />
          )}
        />
        <RunStatusDisplay />
        <Composer
          text={composer.text}
          onTextChange={composer.setText}
          onSubmit={composer.submit}
          submitting={composer.submitting}
          canSubmit={composer.canSubmit}
          error={composer.error}
          draft={composer.draft}
          onRetryDraft={composer.retryDraft}
          textareaProps={{ placeholder: "Show me a sample reply.", autoFocus: focusComposer }}
          labels={{ send: "Send message" }}
        />
      </Conversation>
      <div className="demo-actions">
        {confirmClear && (
          <p role="status">
            {chat.canStop
              ? "Stop this reply and clear the messages and draft?"
              : "Clear these messages and the saved draft?"}
          </p>
        )}
        <button
          type="button"
          ref={clearButton}
          aria-expanded={confirmClear}
          onClick={() => {
            if (confirmClear) void clear();
            else setConfirmClear(true);
          }}
        >
          {confirmClear ? "Confirm clear" : "Clear demo"}
        </button>
        {confirmClear && (
          <button
            type="button"
            ref={keepButton}
            onClick={() => {
              setConfirmClear(false);
              clearButton.current?.focus();
            }}
          >
            Keep them
          </button>
        )}
      </div>
    </div>
  );
}

export default function ChatDemo() {
  const [refuse, setRefuse] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("chat") === "refused",
  );
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const restoreScenario = () =>
      setRefuse(new URLSearchParams(window.location.search).get("chat") === "refused");
    window.addEventListener("popstate", restoreScenario);
    return () => window.removeEventListener("popstate", restoreScenario);
  }, []);
  function selectScenario(next: boolean) {
    if (refuse === next) return;
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("chat", "refused");
    else url.searchParams.delete("chat");
    window.history.pushState(null, "", url);
    setRefuse(next);
  }
  return (
    <div className="package-demo not-content">
      <p>
        Write a message to get a sample reply. Nothing you type goes to a server. When you reopen
        this demo in the same tab, it restores messages and drafts saved in the past hour and
        deletes older copies. Choose Clear demo to delete them now.
      </p>
      <ChatSession
        key={generation}
        focusComposer={generation > 0}
        refuse={refuse}
        onScenario={selectScenario}
        onClear={() => setGeneration((value) => value + 1)}
      />
      <p className="example-note">
        A real app supplies an authenticated transport.{" "}
        <a href="/react/getting-started/">See the setup</a>.
      </p>
    </div>
  );
}
