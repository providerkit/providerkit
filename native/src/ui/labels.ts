/**
 * Every word the chat components show or read out, with English defaults. Pass one object per
 * language to each component's `labels`, with only the words you change: the rest stay English.
 *
 * Imports nothing from React Native, so it runs under Node.
 */
import { useMemo } from "react";
import type { DisplayError, InputView } from "@providerkit/react";
import type { ToolState } from "@providerkit/react/protocol";
import { formatDuration, type RequestDisplay, type RunResult } from "./rules.ts";

export interface ChatLabels {
  /** The message list and what it shows around messages. */
  list: {
    /** No messages yet, in a chat the person writes in. */
    empty: string;
    /** No messages yet, in a run the person only watches. */
    emptyReadOnly: string;
    loading: string;
    /** The title when messages did not load. */
    loadFailed: string;
    /** The title when the connection dropped. */
    lost: string;
    reconnect: string;
    jumpToLatest: string;
    /** The jump button's words when an answer finished while the person read further up. */
    answerReady: string;
    /** Under a message on its way. */
    sending: string;
    /** The title over a message whose delivery is not confirmed. */
    unconfirmed: string;
    /** Takes such a message out of the conversation. */
    remove: string;
    /** Under a reply the host marked incomplete. */
    incomplete: string;
  };
  /** Tool calls, the lines that fold them, and thinking. */
  activity: {
    thinking: string;
    thought: (ms: number) => string;
    /** Thinking whose length the host did not measure. */
    thoughtUntimed: string;
    /** After the first two names in a folded line. */
    more: (count: number) => string;
    /** Read out with each call, and shown for one that failed. */
    state: Record<ToolState, string>;
  };
  band: {
    sending: string;
    working: string;
    stopping: string;
    approval: string;
    answer: string;
    continuation: string;
    stop: string;
    stopFailed: string;
    result: Record<RunResult, string>;
    duration: (ms: number) => string;
  };
  composer: {
    /** What a screen reader calls the text box. */
    message: string;
    placeholder: string;
    send: string;
    queue: string;
    stop: string;
    sending: string;
    attach: string;
    tooLong: (length: number, limit: number) => string;
    offline: string;
    uploading: string;
    draftLoadFailed: string;
    draftSaveFailed: string;
    retryDraft: string;
    missingFiles: (count: number) => string;
    dismissMissingFiles: string;
    fileQueued: string;
    fileUploading: (fraction: number | undefined) => string;
    retryFile: string;
    removeFile: (name: string) => string;
    pickFailed: string;
  };
  queued: {
    /** The delivery of a message the person sent while the agent works. */
    state: Record<Exclude<InputView["status"], "consumed" | "recalled">, string>;
    /** Before the state, when more than one message waits. */
    position: (position: number) => string;
    recall: string;
    recalling: string;
    recallFailed: string;
  };
  request: {
    state: Record<RequestDisplay, string>;
    /** A question's pending state. `state.pending` is an approval's. */
    answerNeeded: string;
    readOnly: string;
    unsupported: string;
    approve: string;
    deny: string;
    /** The label of the note a denial can carry. */
    denyNote: string;
    denyHint: string;
    /** Sends the denial. */
    denySend: string;
    back: string;
    answer: string;
    sendAnswer: string;
    skip: string;
    actionUnavailable: string;
  };
  notice: {
    error: (error: DisplayError) => string;
    retry: string;
    retryFailed: string;
    reference: (code: string) => string;
  };
  markdown: {
    /** Shown for an image with no alt text. */
    image: string;
    /** Shown under the text when a link could not be opened. */
    linkFailed: (url: string) => string;
    /** What a screen reader says for a citation. */
    source: (marker: string, title: string) => string;
  };
}

type Section<T> = {
  [Key in keyof T]?: T[Key] extends (...args: never[]) => unknown
    ? T[Key]
    : T[Key] extends object
      ? Partial<T[Key]>
      : T[Key];
};

/** Only the words you change, by section. */
export type ChatLabelOverrides = { [Key in keyof ChatLabels]?: Section<ChatLabels[Key]> };

const count = (value: number) => value.toLocaleString("en-US");

export const defaultChatLabels: ChatLabels = {
  list: {
    empty: "Send a message to start the conversation.",
    emptyReadOnly: "No messages yet. They show up here when the work starts.",
    loading: "Loading messages...",
    loadFailed: "Messages did not load",
    lost: "Connection lost. Check your internet connection, then open the chat again to see the latest reply.",
    reconnect: "Reconnect",
    jumpToLatest: "Jump to latest",
    answerReady: "Answer ready",
    sending: "Sending...",
    unconfirmed: "Your message may not have arrived",
    remove: "Remove",
    incomplete: "Part of this reply is missing. Check for updates to get the saved answer.",
  },
  activity: {
    thinking: "Thinking",
    thought: (ms) => `Thought for ${formatDuration(ms)}`,
    thoughtUntimed: "Thought",
    more: (more) => `and ${count(more)} more`,
    state: {
      running: "Working",
      waiting: "Waiting for your answer",
      done: "Done",
      failed: "Failed",
    },
  },
  band: {
    sending: "Sending",
    working: "Working",
    stopping: "Stopping",
    approval: "Waiting for your approval",
    answer: "Waiting for your answer",
    continuation: "Waiting to continue",
    stop: "Stop",
    stopFailed: "The stop did not go through. Try again.",
    result: {
      completed: "Done",
      stopped: "Stopped",
      limited: "Stopped at a limit",
      failed: "Couldn't finish",
    },
    duration: formatDuration,
  },
  composer: {
    message: "Message",
    placeholder: "Write a message",
    send: "Send",
    queue: "Queue",
    stop: "Stop",
    sending: "Sending",
    attach: "Add files",
    tooLong: (length, limit) => `That's ${count(length)} characters. The limit is ${count(limit)}.`,
    offline: "You're offline. What you wrote stays here. Send it when you're back online.",
    uploading: "Uploading files. You can keep writing.",
    draftLoadFailed: "Your saved draft did not load. Try again, or start a new message.",
    draftSaveFailed: "Your draft was not saved. Try again before you leave this screen.",
    retryDraft: "Try again",
    missingFiles: (files) =>
      files === 1
        ? "1 file had not finished uploading, so it was not kept. Add it again."
        : `${count(files)} files had not finished uploading, so they were not kept. Add them again.`,
    dismissMissingFiles: "Continue without them",
    fileQueued: "Waiting to upload",
    fileUploading: (fraction) =>
      fraction === undefined ? "Uploading..." : `Uploading ${Math.round(fraction * 100)}%`,
    retryFile: "Try again",
    removeFile: (name) => `Remove ${name}`,
    pickFailed: "The files could not be added. Try again.",
  },
  queued: {
    state: {
      sending: "Sending...",
      unconfirmed: "Delivery not confirmed. Check the conversation before you send it again.",
      queued: "Waiting for the agent",
      accepted: "Received. The agent reads it next.",
    },
    position: (position) => `#${count(position)} in line`,
    recall: "Take back",
    recalling: "Taking back...",
    recallFailed: "Could not confirm the recall. Check the conversation before sending this again.",
  },
  request: {
    state: {
      pending: "Your approval is needed.",
      approved: "Approved",
      denied: "Denied",
      answered: "Answered",
      cancelled: "Skipped",
      stopped: "Stopped. This request no longer needs an answer.",
      stale: "This request was replaced. Answer the newer one.",
      invalid: "This request was replaced after an answer it could not use. See the newer one.",
      expired: "This request expired, so nothing was done. Write a message to carry on.",
      submitting: "Sending your answer...",
      unconfirmed: "Your answer may not have arrived. Check for updates before you answer again.",
      failed: "Your answer was not accepted. Check the request and try again.",
    },
    answerNeeded: "Your answer is needed.",
    readOnly: "This request can't be answered here. Updates show up here.",
    unsupported:
      "This request needs a form this app can't show. Answer it where it started, or skip it.",
    approve: "Approve",
    deny: "Deny",
    denyNote: "What should it do instead?",
    denyHint: "Leave it blank to deny without a note.",
    denySend: "Deny",
    back: "Back",
    answer: "Your answer",
    sendAnswer: "Send answer",
    skip: "Skip",
    actionUnavailable: "This app can't run this action. Open it where it started, or skip it.",
  },
  notice: {
    error: (error) => error.message,
    retry: "Try again",
    retryFailed: "Could not confirm the retry. Check for updates before trying again.",
    reference: (code) => `Reference: ${code}`,
  },
  markdown: {
    image: "Image",
    linkFailed: (url) =>
      `This link did not open on this phone. Copy the address into your browser: ${url}`,
    source: (marker, title) => `Source ${marker}: ${title}`,
  },
};

/** The defaults with `overrides` laid over them, section by section. */
export function mergeLabels(overrides: ChatLabelOverrides | undefined): ChatLabels {
  if (!overrides) return defaultChatLabels;
  const base = defaultChatLabels;
  return {
    list: { ...base.list, ...overrides.list },
    activity: {
      ...base.activity,
      ...overrides.activity,
      state: { ...base.activity.state, ...overrides.activity?.state },
    },
    band: {
      ...base.band,
      ...overrides.band,
      result: { ...base.band.result, ...overrides.band?.result },
    },
    composer: { ...base.composer, ...overrides.composer },
    queued: {
      ...base.queued,
      ...overrides.queued,
      state: { ...base.queued.state, ...overrides.queued?.state },
    },
    request: {
      ...base.request,
      ...overrides.request,
      state: { ...base.request.state, ...overrides.request?.state },
    },
    notice: { ...base.notice, ...overrides.notice },
    markdown: { ...base.markdown, ...overrides.markdown },
  };
}

/** The labels for one render. Keep `overrides` the same object between renders. */
export function useLabels(overrides: ChatLabelOverrides | undefined): ChatLabels {
  return useMemo(() => mergeLabels(overrides), [overrides]);
}
