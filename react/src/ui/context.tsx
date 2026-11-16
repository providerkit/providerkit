"use client";

import { createContext, useContext } from "react";
import type {
  ChatClient,
  ChatState,
  CommandResult,
  ConnectionStatus,
  RequestResponse,
  InputView,
  RespondResult,
} from "../client.ts";
import type {
  ApprovalState,
  RequestState,
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
  /** Change with the authenticated principal or conversation, even when message ids repeat. */
  scopeKey?: string;
  messages: readonly DisplayMessage[];
  run?: RunInfo;
  stop?: () => void | CommandResult | Promise<void | CommandResult>;
  respond?: RespondToRequest;
  startClientTool?: ChatClient["startClientTool"];
  recallInput?: ChatClient["recallInput"];
  reconnect?: () => void | Promise<void>;
}

export type RespondToRequest = (
  requestId: string,
  response: RequestResponse,
) => void | CommandResult | RespondResult | Promise<void | CommandResult | RespondResult>;

export type RequestDisplayState = RequestState | "submitting" | "unconfirmed" | "failed";
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
  incompleteText: string;
  role: Record<MessageRole, string>;
  message: Record<MessageState, string>;
  run: Record<RunStatus, string>;
  tool: Record<ToolState, string>;
  connection: Record<ConnectionStatus, string>;
  approval: Record<RequestDisplayState, string>;
  requestPending: string;
  requestWaiting: string;
  unsupportedForm: string;
  choose: string;
  chooseOne: string;
  chooseMany: string;
  yes: string;
  no: string;
  answerText: string;
  sendAnswer: string;
  skipRequest: string;
  runClientAction: string;
  checkClientAction: string;
  handoff: string;
  conversationOwner: (label: string) => string;
  inputs: string;
  input: Record<InputView["status"], string>;
  queuedAfterCompletion: string;
  recallInput: string;
  recallingInput: string;
  recallFailed: string;
  clientActionWarning: string;
  clientActionUnavailable: string;
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
  incompleteText: "Part of this reply is missing. Check for updates to recover the saved answer.",
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
  tool: {
    running: "Working",
    waiting: "Waiting for a response",
    done: "Completed",
    failed: "Failed",
  },
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
    answered: "Answered",
    cancelled: "Skipped",
    stopped: "Stopped. This request no longer needs an answer.",
    stale: "This request was replaced. Answer the newer request instead.",
    invalid: "This request was replaced after an invalid answer. Review the newer request.",
    expired: "This request expired. Ask for a new request if you still want to continue.",
    submitting: "Sending your response. Waiting for confirmation...",
    unconfirmed: "Your response may have arrived. Check for updates before you answer again.",
    failed: "Your response was not accepted. Review the request and try again.",
  },
  requestPending: "Your response is needed.",
  requestWaiting: "This view cannot answer this request. Updates will appear here.",
  unsupportedForm:
    "This form cannot be filled in here. Open it in the app that started it, or choose Skip.",
  choose: "Choose an option",
  chooseOne: "Choose one",
  chooseMany: "Choose one or more",
  yes: "Yes",
  no: "No",
  answerText: "Your answer",
  sendAnswer: "Send answer",
  skipRequest: "Skip",
  runClientAction: "Run action",
  checkClientAction: "Check action result",
  handoff: "Took over the conversation",
  conversationOwner: (label) => `Conversation with ${label}`,
  inputs: "Messages sent during this answer",
  input: {
    sending: "Sending...",
    unconfirmed: "Delivery is not confirmed. Check for updates before sending again.",
    queued: "Waiting for the agent to receive this message.",
    accepted: "Received. It may not have been used in an answer yet.",
    consumed: "Included in the agent's work. Check the answer to see how it was used.",
    recalled: "Recalled. The agent will not receive this message.",
  },
  queuedAfterCompletion:
    "The answer ended. Check for updates before sending this waiting message again.",
  recallInput: "Recall message",
  recallingInput: "Recalling...",
  recallFailed: "Recall was not confirmed. Check for updates before sending this message again.",
  clientActionWarning: "This action runs on this device. Closing the page does not undo it.",
  clientActionUnavailable:
    "This app cannot run this action. Open it in the app that supports it, or skip this request.",
  sources: "Sources",
  details: "Details",
  approve: "Approve",
  deny: "Deny",
  approvalReadOnly: "This view cannot send a response. Open the request where you can answer it.",
  approvalFailed: "Your response may have arrived. Check for updates before you answer again.",
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
    input: { ...defaultConversationLabels.input, ...labels?.input, ...overrides?.input },
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
