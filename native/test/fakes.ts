// Fakes shared by the transport and app-state tests: the app's stream reader, driven by hand, and
// the few display events the tests write.
import type { ChatEvent, RunInfo, RunStatus } from "@providerkit/react";
import { vi } from "vitest";
import type { NativeRequest, OpenStream, SendCommand, StreamHandlers } from "../src/transport.ts";

export interface Stream {
  request: NativeRequest;
  handlers: StreamHandlers;
  aborted: boolean;
}

/** The app's stream reader, driven by hand: every stream it opened, newest last. */
export function reader() {
  const opened: Stream[] = [];
  const open = vi.fn<OpenStream>((request, handlers) => {
    const stream: Stream = { request, handlers, aborted: false };
    opened.push(stream);
    return {
      abort() {
        stream.aborted = true;
      },
    };
  });
  function latest(): Stream {
    const last = opened.at(-1);
    if (!last) throw new Error("No stream was opened.");
    return last;
  }
  /** One frame per event, on the newest stream. */
  function push(...events: ChatEvent[]): void {
    for (const event of events) latest().handlers.onData(JSON.stringify(event));
  }
  return { open, opened, latest, push };
}

export const noCommand: SendCommand = async () => {
  throw new Error("This test sends no command.");
};

export function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`The transport has no ${name}.`);
  return value;
}

/** What a stream delivered, and how it ended. */
export async function drain(events: AsyncIterable<ChatEvent>) {
  const delivered: ChatEvent[] = [];
  try {
    for await (const event of events) delivered.push(event);
  } catch (error) {
    return { delivered, error };
  }
  return { delivered, error: undefined };
}

type Where = { seq?: number; segment?: string };
export const at = (seq: number, segment = "s1"): Where => ({ seq, segment });
export const run = (status: RunStatus, id = "run-1"): RunInfo => ({
  id,
  status,
  messageId: "a1",
});
export const status = (info: RunInfo, where: Where = {}): ChatEvent => ({
  v: 1,
  type: "run",
  run: info,
  ...where,
});
export const writing = (text: string, where: Where = {}): ChatEvent => ({
  v: 1,
  type: "message",
  message: {
    id: "a1",
    role: "assistant",
    state: "live",
    parts: [{ type: "text", id: "t1", text, settled: false }],
  },
  ...where,
});
export const delta = (value: string, where: Where = {}): ChatEvent => ({
  v: 1,
  type: "text",
  messageId: "a1",
  partId: "t1",
  delta: value,
  ...where,
});
