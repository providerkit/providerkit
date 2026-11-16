import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  draftScopeKey,
  useAgentRun,
  useChat,
  useComposer,
  type DraftScope,
  type DraftStorage,
} from "@providerkit/react";
import {
  Composer,
  ConnectionStatusDisplay,
  Conversation,
  MessageList,
  RunStatusDisplay,
  type ApprovalActions,
  type ConversationLabelOverrides,
  type MessageRenderers,
} from "@providerkit/react/ui";
import { Markdown } from "@providerkit/react/markdown";
import type { SourcePart } from "@providerkit/react/protocol";
import "@providerkit/react/styles.css";
import "./host.css";
import { browserDrafts, rememberDraft, remembersDraft } from "./drafts.ts";
import { copyPasteSample, EarlierHistory, SampleImage, SampleTool } from "./fixtures.tsx";
import { fixtureMessageId, pasteText, sampleImageId, sampleToolId } from "./samples.ts";
import { attachmentOptions, command, demoFetch, portTransport, sseTransport } from "./transport.ts";
import {
  apiPath,
  draftRetentionMs,
  fileTypes,
  isRecord,
  type ApprovalMode,
  type SendMode,
  type TransportMode,
  type UploadMode,
} from "./shared.ts";

const labels: ConversationLabelOverrides = {
  conversation: "Scripted conversation",
  empty: "Try a message or attach a file. The local script will write a sample visit plan.",
  emptyReadOnly: "No replies yet. Send a message in the main view to see it here.",
  role: { user: "You", assistant: "Sample guide" },
  run: {
    idle: "Ready for a sample message",
    running: "Writing the sample reply",
    waiting: "Waiting for your choice",
    completed: "Sample finished",
    stopped: "Sample stopped",
  },
  connection: {
    idle: "Not watching yet",
    connecting: "Opening live updates...",
    open: "Live updates connected",
    reconnecting: "Catching up...",
    lost: "Live updates disconnected",
  },
  reconnect: "Reconnect",
  approve: "Show summary",
  deny: "Skip",
};
const toolLabels = {
  review_sample: "Compare sample records",
  read_sample: "Read the opening-time note",
  check_format: "Check the visit checklist",
};
const specialistLabels = { facts: "Fact checker", format: "Plan checker" };

function HostApproval({ disabled, onRespond, state }: ApprovalActions) {
  return (
    <div className="host-approval-actions">
      <p>This choice changes only the sample shown here.</p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onRespond?.({ type: "approve" })}
      >
        {state === "submitting" ? "Saving choice..." : "Show sample summary"}
      </button>
      <button type="button" disabled={disabled} onClick={() => void onRespond?.({ type: "deny" })}>
        Skip summary
      </button>
    </div>
  );
}

const renderSummary: NonNullable<MessageRenderers["renderPart"]> = (part) => {
  if (part.type !== "data" || part.kind !== "sample-summary") return undefined;
  if (
    !isRecord(part.data) ||
    typeof part.data.title !== "string" ||
    typeof part.data.text !== "string"
  )
    return null;
  return (
    <section className="sample-result" aria-label="Sample result">
      <strong>{part.data.title}</strong>
      <p>{part.data.text}</p>
    </section>
  );
};
const hostApproval: MessageRenderers["renderApproval"] = (actions) => <HostApproval {...actions} />;

function useRenderers(scope: DraftScope, hostStyled: boolean) {
  const renderPart = useCallback<NonNullable<MessageRenderers["renderPart"]>>(
    (part, context) => {
      if (context.message.id === fixtureMessageId) {
        if (part.type === "tool" && part.id === sampleToolId) return <SampleTool tool={part} />;
        if (part.type === "attachment" && part.id === sampleImageId)
          return <SampleImage scope={scope} />;
      }
      return renderSummary(part, context);
    },
    [scope],
  );
  const [source, setSource] = useState<SourcePart>();
  const sourceButton = useRef<HTMLElement | null>(null);
  const openSource = useCallback((next: SourcePart) => {
    sourceButton.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSource(next);
  }, []);
  const renderText = useCallback<NonNullable<MessageRenderers["renderText"]>>(
    (part, context) => (
      <Markdown
        text={part.text}
        streaming={!part.settled}
        sources={context.sources}
        onCitation={openSource}
      />
    ),
    [openSource],
  );
  return {
    source,
    closeSource: () => {
      setSource(undefined);
      sourceButton.current?.focus();
    },
    renderers: {
      renderText,
      renderPart,
      toolLabels,
      specialistLabels,
      onSource: openSource,
      renderApproval: hostStyled ? hostApproval : undefined,
    },
  };
}

function SourceDetail({ source, close }: { source?: SourcePart; close: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (source) heading.current?.focus();
  }, [source]);
  if (!source) return null;
  return (
    <aside className="source-detail" aria-label="Selected sample source">
      <h3 ref={heading} tabIndex={-1}>
        {source.title}
      </h3>
      <p>{source.snippet}</p>
      <button className="demo-button" type="button" onClick={close}>
        Close source
      </button>
    </aside>
  );
}

function Observer({
  scope,
  mode,
  hostStyled,
  close,
}: {
  scope: DraftScope;
  mode: TransportMode;
  hostStyled: boolean;
  close: () => void;
}) {
  const transport = useMemo(() => {
    const http = sseTransport(scope, "normal");
    const chosen = mode === "port" ? portTransport(http) : http;
    return { observe: chosen.observe }; // No command authority in this read-only transport.
  }, [scope, mode]);
  const run = useAgentRun({
    id: `${draftScopeKey(scope)}:observer`,
    transport,
    reconnect: { attempts: 0 },
  });
  const { source, closeSource, renderers } = useRenderers(scope, hostStyled);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const reconnect = async () => {
    await command(scope, "connect");
    run.reconnect();
  };
  return (
    <aside className="observer-panel" aria-label="Read-only view">
      <header className="panel-heading">
        <h2 ref={heading} tabIndex={-1}>
          Read-only view
        </h2>
        <button className="demo-button" type="button" onClick={close}>
          Close view
        </button>
      </header>
      <p className="hint">
        Closing this view does not stop the reply. Open it again after the reply finishes.
      </p>
      <Conversation
        chat={{ ...run, stop: undefined, respond: undefined, reconnect }}
        labels={labels}
      >
        <ConnectionStatusDisplay />
        <MessageList readOnly {...renderers} renderApproval={undefined} />
        <RunStatusDisplay />
      </Conversation>
      <SourceDetail source={source} close={closeSource} />
    </aside>
  );
}

function App() {
  const [settings] = useState(() => {
    const query = new URLSearchParams(location.search);
    return {
      scope: {
        principalId: query.get("profile") === "sam" ? "sam" : "alex",
        conversationId: query.get("chat") === "notes" ? "notes" : "visit",
      },
      mode: query.get("transport") === "port" ? ("port" as const) : ("sse" as const),
      hostStyled: query.get("style") === "host",
    };
  });
  const { scope, mode, hostStyled } = settings;
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "light");
  const [sendMode, setSendMode] = useState<SendMode>("normal");
  const [uploadMode, setUploadMode] = useState<UploadMode>("normal");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("pending");
  const [draftFailure, setDraftFailure] = useState(false);
  const failDraftSave = useRef(false);
  // Keep the adapter identity stable so changing a fixture does not replace the open draft.
  const draftStorage = useMemo<DraftStorage>(
    () => ({
      ...browserDrafts,
      async save(scope, draft, options) {
        if (failDraftSave.current) throw new Error("Synthetic draft write failure");
        await browserDrafts.save(scope, draft, options);
      },
    }),
    [],
  );
  const transport = useMemo(() => {
    const http = sseTransport(scope, sendMode);
    return mode === "port" ? portTransport(http) : http;
  }, [scope, mode, sendMode]);
  const attachments = useMemo(() => attachmentOptions(scope, uploadMode), [scope, uploadMode]);
  const chat = useChat({ id: draftScopeKey(scope), transport, reconnect: { attempts: 0 } });
  const [remember, setRemember] = useState(() => remembersDraft(scope));
  const composer = useComposer({
    scope,
    send: chat.send,
    canSend: chat.canSend,
    attachments,
    draft: remember ? { storage: draftStorage, retentionMs: draftRetentionMs } : undefined,
  });
  const [observerOpen, setObserverOpen] = useState(false);
  const observerButton = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const [stats, setStats] = useState<Record<string, number>>();
  const actionBusy = useRef(false);
  const leaving = useRef(false);
  const { source, closeSource, renderers } = useRenderers(scope, hostStyled);
  const hasDraft = Boolean(
    composer.text || composer.attachments.length || composer.draft.missingFiles,
  );
  const hasLocalFiles = composer.attachments.some((file) => file.state !== "ready");

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        leaving.current ||
        !hasDraft ||
        (remember && composer.draft.status === "saved" && !hasLocalFiles)
      )
        return;
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasDraft, remember, composer.draft.status, hasLocalFiles]);

  async function action(name: string, work: () => Promise<void>, result = "") {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setPending(name);
    setProblem("");
    setNotice("");
    try {
      await work();
      setNotice(result);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "The local action did not finish. Try it again.",
      );
    } finally {
      actionBusy.current = false;
      setPending(undefined);
    }
  }

  async function navigate(key?: string, value?: string) {
    if (
      hasDraft &&
      (!remember || hasLocalFiles) &&
      !window.confirm(
        hasLocalFiles
          ? "Files still uploading will need to be chosen again. Stay here to finish the upload, or continue?"
          : "Your draft is not saved. Cancel to keep it here and turn on Save drafts, or continue without it?",
      )
    )
      return;
    if (!(await composer.flushDraft()))
      throw new Error(
        "Your draft could not be saved. Choose Retry saving before leaving this page.",
      );
    leaving.current = true;
    const url = new URL(location.href);
    if (key && value) url.searchParams.set(key, value);
    location.assign(url.href);
  }

  async function reconnect() {
    setNotice("");
    setProblem("");
    await command(scope, "connect");
    chat.reconnect();
  }

  function changeTheme(value: string) {
    setTheme(value);
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
    const url = new URL(location.href);
    url.searchParams.set("theme", value);
    history.replaceState(null, "", url);
  }

  return (
    <main className={`demo ${hostStyled ? "host-view" : "default-view"}`}>
      <header className="page-heading">
        <a className="wordmark" href="/">
          providerkit <span>/ React example</span>
        </a>
        <h1>Try a chat without a model</h1>
        <p>
          Scripted replies and fictional records. Reload or close a view without starting the reply
          again.
        </p>
      </header>
      <div className="settings" aria-label="Example settings">
        <label>
          Demo profile
          <select
            value={scope.principalId}
            disabled={Boolean(pending)}
            onChange={(event) =>
              void action("Switching profile", () => navigate("profile", event.target.value))
            }
          >
            <option value="alex">Alex</option>
            <option value="sam">Sam</option>
          </select>
        </label>
        <label>
          Conversation
          <select
            value={scope.conversationId}
            disabled={Boolean(pending)}
            onChange={(event) =>
              void action("Switching conversation", () => navigate("chat", event.target.value))
            }
          >
            <option value="visit">Sample visit</option>
            <option value="notes">Sample notes</option>
          </select>
        </label>
        <label>
          Style
          <select
            value={hostStyled ? "host" : "default"}
            disabled={Boolean(pending)}
            onChange={(event) =>
              void action("Changing style", () => navigate("style", event.target.value))
            }
          >
            <option value="default">Package defaults</option>
            <option value="host">Host styles</option>
          </select>
        </label>
        <label>
          Transport
          <select
            value={mode}
            disabled={Boolean(pending)}
            onChange={(event) =>
              void action("Changing transport", () => navigate("transport", event.target.value))
            }
          >
            <option value="sse">HTTP / SSE</option>
            <option value="port">Message port</option>
          </select>
        </label>
        <label>
          Theme
          <select value={theme} onChange={(event) => changeTheme(event.target.value)}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>
      <details className="try-panel">
        <summary>Try connection, send and upload states</summary>
        <div className="try-content">
          <p>
            Send a message first, then drop live updates or open the read-only view. No control
            calls a model or an app service.
          </p>
          <div className="settings">
            <label>
              Send response
              <select
                value={sendMode}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    value === "normal" ||
                    value === "delay" ||
                    value === "refuse" ||
                    value === "unknown"
                  )
                    setSendMode(value);
                }}
              >
                <option value="normal">Normal</option>
                <option value="delay">Delay reply by 1.8 seconds</option>
                <option value="refuse">Refuse before starting</option>
                <option value="unknown">Lose acknowledgement</option>
              </select>
            </label>
            <label>
              Upload response
              <select
                value={uploadMode}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    value === "normal" ||
                    value === "slow" ||
                    value === "late" ||
                    value === "fail"
                  )
                    setUploadMode(value);
                }}
              >
                <option value="normal">Normal</option>
                <option value="slow">Slow (3.5 seconds)</option>
                <option value="late">Finish after cancellation (3.5 seconds)</option>
                <option value="fail">Fail once per file, then allow Retry</option>
              </select>
            </label>
            <label>
              Approval response
              <select
                value={approvalMode}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    value === "pending" ||
                    value === "expire" ||
                    value === "unknown" ||
                    value === "replace"
                  )
                    setApprovalMode(value);
                }}
              >
                <option value="pending">Pending, then show the saved choice</option>
                <option value="expire">Expire in 3 seconds</option>
                <option value="unknown">Lose decision acknowledgement</option>
                <option value="replace">Replace when answered</option>
              </select>
            </label>
          </div>
          <label className="remember">
            <input
              type="checkbox"
              checked={draftFailure}
              onChange={(event) => {
                failDraftSave.current = event.target.checked;
                setDraftFailure(event.target.checked);
              }}
            />
            Refuse draft saves
          </label>
          <p className="hint">
            Turn on Save drafts below, then type to try a failed save. Turn this refusal off and
            choose Retry saving before switching conversations or reloading.
          </p>
          <div className="actions">
            <button
              className="demo-button"
              type="button"
              disabled={Boolean(pending) || chat.connection !== "open" || !chat.canStop}
              onClick={() =>
                void action(
                  "Disconnecting",
                  () => command(scope, "disconnect"),
                  "Live updates were disconnected. The reply was not stopped.",
                )
              }
            >
              Drop live updates
            </button>
            <button
              className="demo-button"
              type="button"
              disabled={Boolean(pending)}
              onClick={() => void action("Reloading", () => navigate())}
            >
              Reload this page
            </button>
            <button
              className="demo-button"
              type="button"
              disabled={Boolean(pending) || !chat.canSend}
              onClick={() =>
                void action(
                  "Opening approval",
                  () => command(scope, "approval", { mode: approvalMode }),
                  "The sample request is ready in the conversation.",
                )
              }
            >
              Try a sample approval
            </button>
          </div>
          <p className="hint">
            Approvals here are host-only display requests, separate from the two-specialist SDK run.
            They do not prove SDK continuation.
          </p>
          <div className="actions">
            <button
              className="demo-button"
              type="button"
              disabled={
                Boolean(pending) ||
                chat.connection !== "open" ||
                chat.messages.some((message) => message.id === fixtureMessageId)
              }
              onClick={() =>
                void action(
                  "Adding display samples",
                  () => command(scope, "fixtures"),
                  "Tool, image and link samples were added. Use Jump to latest to find them.",
                )
              }
            >
              Add tool, image and link samples
            </button>
            <button
              className="demo-button"
              type="button"
              disabled={Boolean(pending) || composer.attachments.length >= 3}
              onClick={() =>
                void action(
                  "Adding generated file",
                  async () =>
                    composer.addFiles([
                      new File([pasteText], "generated-sample.txt", { type: "text/plain" }),
                    ]),
                  "Generated file selected. Check its upload status below.",
                )
              }
            >
              Add a generated text file
            </button>
            <button
              className="demo-button"
              type="button"
              disabled={Boolean(pending)}
              onClick={() =>
                void action(
                  "Copying paste sample",
                  () => copyPasteSample(scope),
                  "Text and a generated image were copied. Focus Your message and paste to add both.",
                )
              }
            >
              Copy text and generated image
            </button>
          </div>
          <p className="hint">
            Copy replaces your clipboard with sample text and a generated image; it never reads your
            clipboard. Paste into Your message to try mixed text and file input. For upload
            cancellation, choose Finish after cancellation, add a generated file, then remove it
            before 3.5 seconds. A late result must not bring it back.
          </p>
        </div>
      </details>
      <div className="host-feedback" role="status" aria-live="polite">
        {pending ? `${pending}...` : problem || notice}
      </div>
      <div className={`workspace ${observerOpen ? "with-observer" : ""}`}>
        <section className="main-panel" aria-label="Main conversation">
          <header className="panel-heading">
            <h2>{scope.conversationId === "visit" ? "Sample visit" : "Sample notes"}</h2>
            <button
              className="demo-button"
              ref={observerButton}
              type="button"
              aria-expanded={observerOpen}
              onClick={() => setObserverOpen(!observerOpen)}
            >
              {observerOpen ? "Close read-only view" : "Open read-only view"}
            </button>
          </header>
          <Conversation chat={{ ...chat, reconnect }} labels={labels}>
            <ConnectionStatusDisplay />
            <EarlierHistory
              scope={scope}
              messages={chat.messages}
              connected={chat.connection === "open"}
            />
            <MessageList
              {...renderers}
              loading={chat.connection === "connecting" && !chat.messages.length}
              emptyAction={
                <button
                  className="demo-button"
                  type="button"
                  onClick={() => composer.setText("Plan a visit to the sample reading room.")}
                >
                  Use a sample message
                </button>
              }
            />
            <RunStatusDisplay />
            <Composer
              key={draftScopeKey(scope)}
              text={composer.text}
              onTextChange={composer.setText}
              onSubmit={composer.submit}
              submitting={composer.submitting}
              canSubmit={composer.canSubmit}
              error={composer.error}
              attachments={composer.attachments}
              onFiles={composer.addFiles}
              onRemoveAttachment={composer.removeAttachment}
              onRetryAttachment={composer.retryAttachment}
              accept={fileTypes.join(",")}
              draft={composer.draft}
              onRetryDraft={composer.retryDraft}
              onDismissMissingFiles={composer.dismissMissingFiles}
              textareaProps={{
                maxLength: 4000,
                placeholder: "Try: Plan a visit to the sample reading room.",
              }}
              labels={{
                message: "Your message",
                hint: "Enter to send. Shift+Enter for a new line. Files can be sent without text.",
              }}
              recoveryAction={
                composer.error?.code === "unconfirmed" ? (
                  <button
                    className="demo-button"
                    type="button"
                    disabled={Boolean(pending)}
                    onClick={() =>
                      void action(
                        "Checking delivery",
                        reconnect,
                        "Asked the server for saved messages. Your draft is unchanged; nothing was sent again.",
                      )
                    }
                  >
                    Check saved conversation
                  </button>
                ) : undefined
              }
            />
          </Conversation>
          <div className="privacy">
            <p>
              Up to 3 PNG, JPEG or text files, 1 MB each. Uploads go only to this local server. It
              discards the contents and returns sample file labels. No model reads them.
            </p>
            <label className="remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => {
                  try {
                    rememberDraft(scope, event.target.checked);
                    setRemember(event.target.checked);
                    setProblem("");
                  } catch {
                    setProblem(
                      "This browser blocked draft storage. Keep the page open or allow local storage, then try again.",
                    );
                  }
                }}
              />
              Save drafts on this browser for 24 hours
            </label>
            <p>
              Optional. Stores text and confirmed file references for this demo profile and
              conversation. Anyone using this browser can read them. File contents and replies are
              not saved in the browser. Turning this off deletes this scope's saved draft.
            </p>
          </div>
          <SourceDetail source={source} close={closeSource} />
        </section>
        {observerOpen && (
          <Observer
            scope={scope}
            mode={mode}
            hostStyled={hostStyled}
            close={() => {
              setObserverOpen(false);
              observerButton.current?.focus();
            }}
          />
        )}
      </div>
      <details className="diagnostics">
        <summary>Demo counters and limits</summary>
        <p>
          These counters describe the local script, not live model usage. Reconnecting should not
          increase replies started or tool calls. Restarting the server clears all conversations and
          upload references. Demo profiles are not authentication.
        </p>
        <button
          className="demo-button"
          type="button"
          disabled={Boolean(pending)}
          onClick={() =>
            void action(
              "Reading counters",
              async () => {
                const response = await demoFetch(`${apiPath(scope)}/stats`);
                if (!response.ok)
                  throw new Error(
                    "Could not read the counters. Check the local server, then try again.",
                  );
                const value: unknown = await response.json();
                if (
                  !isRecord(value) ||
                  !Object.values(value).every((item) => typeof item === "number")
                )
                  throw new Error("The counter reply was incomplete. Try again.");
                const checked: Record<string, number> = {};
                for (const [key, item] of Object.entries(value))
                  if (typeof item === "number") checked[key] = item;
                setStats(checked);
              },
              "Counters updated.",
            )
          }
        >
          Refresh counters
        </button>
        {stats && (
          <dl>
            {Object.entries({
              runs: "Replies started",
              modelCalls: "Scripted provider calls",
              toolCalls: "Sample tool calls",
              decisions: "Choices applied",
              observers: "Open observers",
              events: "Stored display updates",
            }).map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{stats[key]}</dd>
              </div>
            ))}
          </dl>
        )}
        <p>
          The message-port option wraps the same local HTTP host in a browser MessageChannel. It
          uses no Chrome APIs and no second chat store.
        </p>
      </details>
    </main>
  );
}

const query = new URLSearchParams(location.search);
const initialTheme = query.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = initialTheme;
document.documentElement.style.colorScheme = initialTheme;
const root = document.getElementById("root");
if (!root) throw new Error("The example page is missing its root element.");
createRoot(root).render(<App />);
