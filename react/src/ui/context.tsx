"use client";

import { createContext, useContext } from "react";
import type { ChatState, CommandResult, ConnectionStatus, RequestResponse } from "../client.ts";
import type {
  ApprovalState,
  DisplayError,
  DisplayMessage,
  MessageRole,
  MessageState,
  RunInfo,
  RunStatus,
  ToolState,
} from "../protocol.ts";

/** A hook result or the same values from the host's own state owner. No client or store. */
export interface ConversationData extends Partial<Omit<ChatState, "messages" | "run">> {
  messages: readonly DisplayMessage[];
  run?: RunInfo;
  stop?: () => void | CommandResult | Promise<void | CommandResult>;
  respond?: RespondToRequest;
  reconnect?: () => void | Promise<void>;
}

export type RespondToRequest = (
  requestId: string,
  response: RequestResponse,
) => void | CommandResult | Promise<void | CommandResult>;

export type ApprovalDisplayState = ApprovalState | "submitting" | "unconfirmed" | "failed";

/** Every default word in these components can be replaced, including accessible labels. */
export interface ConversationLabels {
  conversation: string;
  messages: string;
  loading: string;
  empty: string;
  emptyReadOnly: string;
  loadFailed: string;
  jumpToLatest: string;
  messageReady: string;
  role: Record<MessageRole, string>;
  message: Record<MessageState, string>;
  run: Record<RunStatus, string>;
  tool: Record<ToolState, string>;
  connection: Record<ConnectionStatus, string>;
  approval: Record<ApprovalDisplayState, string>;
  sources: string;
  details: string;
  approve: string;
  deny: string;
  approvalReadOnly: string;
  approvalFailed: string;
  stop: string;
  stopping: string;
  stopFailed: string;
  reconnect: string;
  reconnectFailed: string;
  reconnectHelp: string;
  limitedHelp: string;
  failedHelp: string;
  error: (error: DisplayError) => string;
}

export type ConversationLabelOverrides = {
  [Key in keyof ConversationLabels]?: ConversationLabels[Key] extends Record<string, string>
    ? Partial<ConversationLabels[Key]>
    : ConversationLabels[Key];
};

export const defaultConversationLabels: ConversationLabels = {
  conversation: "Conversation",
  messages: "Messages",
  loading: "Loading messages...",
  empty: "Send a message to start the conversation.",
  emptyReadOnly: "No messages yet. Updates will appear here when work starts.",
  loadFailed: "Messages could not be loaded. Check your connection.",
  jumpToLatest: "Jump to latest",
  messageReady: "Message ready.",
  role: { user: "You", assistant: "Assistant" },
  message: {
    sending: "Sending...",
    live: "Writing...",
    settled: "",
    failed: "Message failed",
    stopped: "Stopped",
  },
  run: {
    idle: "Not started",
    running: "Working",
    waiting: "Waiting for your answer",
    completed: "Completed",
    stopped: "Stopped",
    limited: "Stopped at a limit",
    failed: "Failed",
  },
  tool: { running: "Working", done: "Completed", failed: "Failed" },
  connection: {
    idle: "",
    connecting: "Connecting...",
    open: "Connected",
    reconnecting: "Reconnecting...",
    lost: "Connection lost. Updates may be missing.",
  },
  approval: {
    pending: "Your approval is needed.",
    approved: "Approved",
    denied: "Denied",
    expired: "This request expired. Ask for a new request if you still want to continue.",
    submitting: "Sending your decision. Waiting for confirmation...",
    unconfirmed: "Your decision may have arrived. Check for updates before you answer again.",
    failed: "Your decision was not accepted. Review the request and try again.",
  },
  sources: "Sources",
  details: "Details",
  approve: "Approve",
  deny: "Deny",
  approvalReadOnly: "This view cannot send a decision. Open the request where you can answer it.",
  approvalFailed: "Your decision may have arrived. Check for updates before you answer again.",
  stop: "Stop",
  stopping: "Stopping...",
  stopFailed: "The stop was not confirmed. Check for updates or try again.",
  reconnect: "Reconnect",
  reconnectFailed: "Could not reconnect. Check your connection and try again.",
  reconnectHelp: "Check your connection, then open this view again for updates.",
  limitedHelp: "The run reached a limit. Review the result before starting more work.",
  failedHelp: "The run could not finish. Review the available result before trying again.",
  error: (error) => error.message,
};

export const ConversationContext = createContext<{
  data?: ConversationData;
  labels?: ConversationLabelOverrides;
}>({});

/** Optional context for host composition. Standalone parts take the same values as props. */
export function useConversationData(): ConversationData | undefined {
  return useContext(ConversationContext).data;
}

export function useConversationLabels(overrides?: ConversationLabelOverrides): ConversationLabels {
  const { labels } = useContext(ConversationContext);
  return {
    ...defaultConversationLabels,
    ...labels,
    ...overrides,
    role: { ...defaultConversationLabels.role, ...labels?.role, ...overrides?.role },
    message: { ...defaultConversationLabels.message, ...labels?.message, ...overrides?.message },
    run: { ...defaultConversationLabels.run, ...labels?.run, ...overrides?.run },
    tool: { ...defaultConversationLabels.tool, ...labels?.tool, ...overrides?.tool },
    connection: {
      ...defaultConversationLabels.connection,
      ...labels?.connection,
      ...overrides?.connection,
    },
    approval: {
      ...defaultConversationLabels.approval,
      ...labels?.approval,
      ...overrides?.approval,
    },
  };
}

export function uiClass(base: string, className?: string): string {
  return className ? `${base} ${className}` : base;
}
