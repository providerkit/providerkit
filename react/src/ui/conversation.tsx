"use client";

import {
  MessageScroller,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@shadcn/react/message-scroller";
import { type ComponentProps, type ReactNode } from "react";
import type { DisplayError, DisplayMessage } from "../protocol.ts";
import {
  ConversationContext,
  uiClass,
  useConversationData,
  useConversationLabels,
  type ConversationData,
  type ConversationLabelOverrides,
} from "./context.tsx";
import { Message, type MessageRenderers } from "./message.tsx";
import { ConnectionStatusDisplay, RunStatusDisplay } from "./status.tsx";

export interface ConversationProps extends ComponentProps<"section"> {
  /** A useChat/useAgentRun value, or equivalent host-owned data and callbacks. */
  chat: ConversationData;
  labels?: ConversationLabelOverrides;
}

/** The host composes its header, message list and optional composer through children. */
export function Conversation({
  chat,
  labels: overrides,
  children,
  className,
  ...props
}: ConversationProps) {
  const labels = useConversationLabels(overrides);
  return (
    <ConversationContext.Provider value={{ data: chat, labels }}>
      <section
        aria-label={labels.conversation}
        {...props}
        className={uiClass("pk-conversation", className)}
        data-part="conversation"
        data-state={chat.run?.status ?? "idle"}
      >
        {children ?? <MessageList />}
      </section>
    </ConversationContext.Provider>
  );
}

export interface MessageListProps
  extends Omit<ComponentProps<"div">, "children">, MessageRenderers {
  messages?: readonly DisplayMessage[];
  loading?: boolean;
  error?: DisplayError;
  readOnly?: boolean;
  emptyAction?: ReactNode;
  errorAction?: ReactNode;
  /** Replaces a message, while retaining the measured scroller item around it. */
  renderMessage?: (message: DisplayMessage) => ReactNode;
  /** Native props, including a ref for host measurement. No virtualizer is installed. */
  itemProps?: (message: DisplayMessage) => Omit<ComponentProps<"div">, "children">;
  viewportProps?: Omit<
    ComponentProps<typeof MessageScroller.Viewport>,
    "children" | "preserveScrollOnPrepend"
  >;
  contentProps?: Omit<ComponentProps<typeof MessageScroller.Content>, "children">;
  autoScroll?: boolean;
  showJumpToLatest?: boolean;
}

/** The published scroller owns follow, pause and prepend. No send or run change asks it to jump. */
export function MessageList({
  messages: suppliedMessages,
  loading: suppliedLoading,
  error: suppliedError,
  readOnly: suppliedReadOnly,
  emptyAction,
  errorAction,
  renderMessage,
  itemProps,
  viewportProps,
  contentProps,
  autoScroll = true,
  showJumpToLatest = true,
  renderText,
  renderPart,
  renderApproval,
  renderRequest,
  renderForm,
  onStartClientTool,
  toolLabels,
  specialistLabels,
  onSource,
  onRespond,
  requests,
  labels: overrides,
  className,
  ...props
}: MessageListProps) {
  const data = useConversationData();
  const labels = useConversationLabels(overrides);
  const messages = suppliedMessages ?? data?.messages ?? [];
  const error = suppliedError ?? data?.error;
  const failed = Boolean(error) || data?.connection === "lost";
  const loading =
    suppliedLoading ?? (data?.connection === "connecting" || data?.connection === "reconnecting");
  const readOnly = suppliedReadOnly ?? data?.canSend === undefined;
  const hasRun =
    (data?.run && data.run.status !== "idle") ||
    data?.status === "sending" ||
    data?.status === "stopping";
  let state = "empty";
  if (messages.length) state = "ready";
  else if (failed) state = "error";
  else if (loading) state = "loading";
  else if (hasRun) state = "run";
  let latestAssistant: DisplayMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "assistant") {
      latestAssistant = messages[index];
      break;
    }
  }
  return (
    <div
      {...props}
      className={uiClass("pk-message-list", className)}
      data-part="message-list"
      data-state={state}
    >
      {failed && (
        <div className="pk-conversation-notice" data-part="load-error" data-state="error">
          {!messages.length && !error && <p>{labels.loadFailed}</p>}
          <ConnectionStatusDisplay error={error} labels={overrides}>
            {errorAction}
          </ConnectionStatusDisplay>
        </div>
      )}
      {state === "loading" && (
        <p className="pk-conversation-notice" data-part="loading" role="status">
          {labels.loading}
        </p>
      )}
      {state === "run" && <RunStatusDisplay labels={overrides} />}
      {state === "empty" && (
        <div className="pk-conversation-notice" data-part="empty" data-state="empty">
          <p>{readOnly ? labels.emptyReadOnly : labels.empty}</p>
          {emptyAction}
        </div>
      )}
      <MessageScroller.Provider
        autoScroll={autoScroll}
        defaultScrollPosition="end"
        scrollPreviousItemPeek={0}
      >
        <MessageScroller.Root className="pk-scroll-root" data-part="scroll-root">
          <MessageScroller.Viewport
            aria-label={labels.messages}
            {...viewportProps}
            preserveScrollOnPrepend
            className={uiClass("pk-scroll-viewport", viewportProps?.className)}
            data-part="scroll-viewport"
          >
            <MessageScroller.Content
              {...contentProps}
              role="list"
              aria-live="off"
              aria-label={labels.messages}
              className={uiClass("pk-scroll-content", contentProps?.className)}
              data-part="scroll-content"
            >
              {messages.map((message) => {
                const native = itemProps?.(message);
                return (
                  <MessageScroller.Item
                    {...native}
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={false}
                    data-scroll-anchor="false"
                    role="listitem"
                    className={uiClass("pk-scroll-item", native?.className)}
                    data-part="scroll-item"
                    data-state={message.state}
                  >
                    {renderMessage ? (
                      renderMessage(message)
                    ) : (
                      <Message
                        message={message}
                        renderText={renderText}
                        renderPart={renderPart}
                        renderApproval={renderApproval}
                        renderRequest={renderRequest}
                        renderForm={renderForm}
                        onStartClientTool={onStartClientTool}
                        toolLabels={toolLabels}
                        specialistLabels={specialistLabels}
                        onSource={onSource}
                        onRespond={onRespond}
                        requests={requests}
                        labels={overrides}
                      />
                    )}
                  </MessageScroller.Item>
                );
              })}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          {showJumpToLatest && messages.length > 0 && <JumpToLatest labels={overrides} />}
        </MessageScroller.Root>
      </MessageScroller.Provider>
      {/* The list is not a live log: changing a token must not read the whole answer aloud. */}
      <div
        className="pk-conversation-announcement"
        data-part="message-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span key={latestAssistant?.id}>
          {latestAssistant?.state === "settled" ? labels.messageReady : ""}
        </span>
      </div>
    </div>
  );
}

export interface JumpToLatestProps extends ComponentProps<"button"> {
  labels?: ConversationLabelOverrides;
}

/** May also be composed inside the installed MessageScroller.Provider. */
export function JumpToLatest({
  labels: overrides,
  children,
  onClick,
  disabled,
  className,
  ...props
}: JumpToLatestProps) {
  const labels = useConversationLabels(overrides);
  const { end } = useMessageScrollerScrollable();
  const { scrollToEnd } = useMessageScroller();
  return (
    <button
      type="button"
      {...props}
      className={uiClass("pk-jump-to-latest", className)}
      data-part="jump-to-latest"
      data-state={end ? "available" : "latest"}
      aria-disabled={disabled || !end}
      onClick={(event) => {
        if (disabled || !end) return;
        onClick?.(event);
        if (event.defaultPrevented) return;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        scrollToEnd({ behavior: reduced ? "instant" : "smooth" });
      }}
    >
      {children ?? labels.jumpToLatest}
    </button>
  );
}
