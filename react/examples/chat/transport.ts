import type { FetchLike } from "@providerkit/core";
import {
  TransportError,
  type AttachmentOptions,
  type ChatTransport,
  type DraftScope,
  type EventReply,
} from "@providerkit/react";
import { parseChatEvent, type ChatEvent } from "@providerkit/react/protocol";
import { createSseTransport } from "@providerkit/react/sse";
import {
  apiPath,
  fileTypes,
  isRecord,
  maxFileBytes,
  type SendMode,
  type UploadMode,
} from "./shared.ts";

/** All routes are loopback-only; the header prevents a foreign website using the local demo. */
export const demoFetch: FetchLike = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("X-Demo-Request", "1");
  return fetch(input, { ...init, headers });
};

export function sseTransport(scope: DraftScope, mode: SendMode): ChatTransport {
  const base = apiPath(scope);
  return createSseTransport({
    fetch: demoFetch,
    send: () => `${base}/send?mode=${mode}`,
    observe: (cursor) =>
      `${base}/events${cursor ? `?after=${encodeURIComponent(JSON.stringify(cursor))}` : ""}`,
    respond: () => `${base}/respond`,
    stop: () => `${base}/stop`,
  });
}

export async function command(
  scope: DraftScope,
  action: "connect" | "disconnect" | "approval",
): Promise<void> {
  const response = await demoFetch(`${apiPath(scope)}/${action}`, { method: "POST" });
  if (!response.ok) throw new Error(await errorMessage(response));
}

async function errorMessage(response: Response): Promise<string> {
  const value: unknown = await response.json().catch(() => null);
  return isRecord(value) && typeof value.message === "string"
    ? value.message
    : "The local server did not answer. Check that it is running, then try again.";
}

export function attachmentOptions(scope: DraftScope, mode: UploadMode): AttachmentOptions {
  const attempted = new WeakSet<File>();
  return {
    rules: { maxFileBytes, maxFiles: 3, accept: fileTypes },
    // The host never stores bytes or charges for uploads, so an explicit retry is safe.
    canRetry: () => true,
    error: (error) => ({
      code: "demo_upload",
      message:
        error instanceof Error
          ? error.message
          : "The upload did not finish. Choose Retry or remove the file.",
    }),
    async upload(file, { signal, onProgress }) {
      onProgress(0);
      const uploadMode = mode === "fail" && attempted.has(file) ? "normal" : mode;
      attempted.add(file);
      let response: Response;
      try {
        response = await demoFetch(`${apiPath(scope)}/upload`, {
          method: "POST",
          body: file,
          signal,
          headers: { "Content-Type": file.type, "X-Demo-Upload": uploadMode },
        });
      } catch {
        throw new Error(
          "The upload lost its connection. Check the local server, then choose Retry.",
        );
      }
      if (!response.ok) throw new Error(await errorMessage(response));
      const value: unknown = await response.json();
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        typeof value.mediaType !== "string" ||
        typeof value.size !== "number"
      )
        throw new Error("The upload reply was incomplete. Choose Retry.");
      signal.throwIfAborted();
      onProgress(1);
      return { id: value.id, name: value.name, mediaType: value.mediaType, size: value.size };
    },
  };
}

type PortReply =
  | { type: "event"; value: ChatEvent }
  | { type: "done" }
  | { type: "error"; outcome: "refused" | "unknown"; message: string };

/** A real MessageChannel, with no Chrome APIs. Its other end wraps the SAME local HTTP host.
 * Only transport changes; createChatClient still owns all conversation and command state. */
export function portTransport(http: ChatTransport): ChatTransport {
  const { observe, send, respond, stop } = http;
  if (!observe || !send || !respond || !stop)
    throw new Error("The demo port requires all four local HTTP methods.");
  async function* exchange(
    run: (signal: AbortSignal) => AsyncIterable<ChatEvent> | Promise<void | EventReply>,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const channel = new MessageChannel();
    const controller = new AbortController();
    const queue: PortReply[] = [];
    let wake = () => {};
    let started = false;
    const abort = () => {
      controller.abort();
      wake();
    };
    channel.port1.onmessage = (event: MessageEvent<PortReply>) => {
      queue.push(event.data);
      wake();
    };
    channel.port2.onmessage = () => {
      if (started) return;
      started = true;
      void (async () => {
        try {
          const reply = await run(controller.signal);
          const events = reply && "events" in reply ? reply.events : reply;
          if (events)
            for await (const event of events)
              channel.port2.postMessage({ type: "event", value: event } satisfies PortReply);
          channel.port2.postMessage({ type: "done" } satisfies PortReply);
        } catch (error) {
          channel.port2.postMessage({
            type: "error",
            outcome: error instanceof TransportError ? error.outcome : "unknown",
            message:
              error instanceof TransportError
                ? error.error.message
                : "The local connection closed. Reconnect to check the saved conversation.",
          } satisfies PortReply);
        }
      })();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      channel.port1.postMessage({ type: "start" });
      while (true) {
        signal?.throwIfAborted();
        const reply = queue.shift();
        if (!reply) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (reply.type === "done") return;
        if (reply.type === "error")
          throw new TransportError(reply.outcome, { code: "demo_port", message: reply.message });
        const event = parseChatEvent(reply.value);
        if (event) yield event;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      controller.abort();
      channel.port1.close();
      channel.port2.close();
    }
  }

  async function drain(events: AsyncIterable<ChatEvent>): Promise<void> {
    for await (const _event of events) {
      /* Commands in this host return an empty acknowledgement. */
    }
  }
  return {
    observe: (options) => exchange((signal) => observe({ ...options, signal }), options.signal),
    send: (input, options) => drain(exchange((signal) => send(input, { signal }), options.signal)),
    respond: (answers, options) =>
      drain(exchange((signal) => respond(answers, { signal }), options.signal)),
    stop: (run) => drain(exchange(() => stop(run))),
  };
}
