import { setTimeout as delay } from "node:timers/promises";
import type { AttachmentRef, SendInput } from "@providerkit/react";
import {
  emptyChatView,
  reduceChat,
  type ChatEvent,
  type ChatView,
  type Cursor,
  type DisplayPart,
} from "@providerkit/react/protocol";
import {
  isRecord,
  maxFileBytes,
  fileTypes,
  Refusal,
  type ApprovalMode,
  type DemoStats,
} from "./shared.ts";
import { DemoRun } from "./runtime.ts";
import { requestAgent } from "./flow.ts";
import { earlierMessages, fixtureMessageId, historyPageSize, sampleFixtures } from "./samples.ts";
import { scriptedAgent, sources } from "./scripted.ts";

interface Conversation {
  principalId: string;
  resourceId: string;
  segment: string;
  view: ChatView;
  events: ChatEvent[];
  observers: Set<{ event: (event: ChatEvent) => void; close: () => void }>;
  paused: boolean;
  sends: Map<string, { payload: string; ack: Promise<void> }>;
  files: Map<string, AttachmentRef>;
  work?: DemoRun;
  stats: DemoStats;
}

const conversations = new Map<string, Conversation>();
const tickMs = argument("--tick-ms", 90);
const port = argument("--port", 4317);
if (tickMs < 1 || tickMs > 1000 || port < 0 || port > 65535)
  throw new Error("Use a port from 0 to 65535 and a tick from 1 to 1000 milliseconds.");

function argument(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(Bun.argv[index + 1]);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} needs a whole number.`);
  return value;
}

function conversation(key: string): Conversation {
  let value = conversations.get(key);
  if (!value) {
    value = {
      principalId: key.split("/")[0]!,
      resourceId: key,
      segment: crypto.randomUUID(),
      view: emptyChatView(),
      events: [],
      observers: new Set(),
      paused: false,
      sends: new Map(),
      files: new Map(),
      stats: {
        runs: 0,
        modelCalls: 0,
        toolCalls: 0,
        decisions: 0,
        observers: 0,
        events: 0,
        continuations: 0,
        clientEffects: 0,
        clientCompletions: 0,
        reservations: 0,
        gaps: 0,
      },
    };
    conversations.set(key, value);
  }
  return value;
}

/** The public reducer is also our in-memory display store. No execution data is stored here. */
function publish(chat: Conversation, value: ChatEvent): void {
  const event = { ...value, segment: chat.segment, seq: chat.events.length + 1 };
  chat.view = reduceChat(chat.view, event);
  chat.events.push(event);
  chat.stats.events = chat.events.length;
  for (const observer of chat.observers) observer.event(event);
}

function snapshot(chat: Conversation): ChatEvent {
  return {
    v: 1,
    type: "snapshot",
    messages: chat.view.messages,
    run: chat.view.run,
    inputs: chat.view.inputs,
  };
}

function busy(chat: Conversation): boolean {
  return chat.view.run.status === "running" || chat.view.run.status === "waiting";
}

function pause(chat: Conversation): void {
  chat.paused = true;
  for (const observer of [...chat.observers]) observer.close();
}

function cursorFrom(url: URL): Cursor | undefined {
  const raw = url.searchParams.get("after");
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Refuse below, never silently replay from zero. */
  }
  if (
    !isRecord(value) ||
    typeof value.segment !== "string" ||
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0
  )
    throw new Refusal(400, "cursor", "The saved position is invalid. Reload this demo.");
  return { segment: value.segment, seq: value.seq };
}

function observe(chat: Conversation, request: Request, url: URL): Response {
  if (chat.paused)
    throw new Refusal(
      503,
      "paused",
      "Live updates are paused in this demo. Choose Reconnect to catch up.",
    );
  const cursor = cursorFrom(url);
  if (cursor && (cursor.segment !== chat.segment || cursor.seq > chat.events.length))
    throw new Refusal(
      409,
      "history_reset",
      "This server restarted and its sample history was cleared. Reload the page.",
    );
  const encoder = new TextEncoder();
  let dispose = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        chat.observers.delete(observer);
        chat.stats.observers = chat.observers.size;
        request.signal.removeEventListener("abort", observer.close);
      };
      const observer = {
        event(event: ChatEvent) {
          if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        },
        close() {
          if (closed) return;
          cleanup();
          controller.close();
        },
      };
      dispose = cleanup;
      // The retained log contains already-projected display events, each with its own cursor.
      for (const event of chat.events) {
        if ((event.seq ?? 0) > (cursor?.seq ?? 0)) observer.event(event);
      }
      observer.event(snapshot(chat));
      if (url.searchParams.get("once") === "1" || request.signal.aborted) observer.close();
      else {
        chat.observers.add(observer);
        chat.stats.observers = chat.observers.size;
        request.signal.addEventListener("abort", observer.close, { once: true });
      }
    },
    cancel() {
      dispose();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

function parseInput(value: unknown, chat: Conversation): SendInput {
  if (
    !isRecord(value) ||
    typeof value.clientId !== "string" ||
    !/^[\w-]{1,100}$/.test(value.clientId) ||
    typeof value.text !== "string" ||
    value.text.length > 4000
  )
    throw new Refusal(400, "message", "Use a message of up to 4,000 characters.");
  if (
    value.attachments !== undefined &&
    (!Array.isArray(value.attachments) || value.attachments.length > 3)
  )
    throw new Refusal(400, "files", "Choose up to three files.");
  const attachments: AttachmentRef[] = [];
  for (const ref of value.attachments ?? []) {
    if (!isRecord(ref) || typeof ref.id !== "string")
      throw new Refusal(400, "file", "Remove this file and upload it again.");
    const saved = chat.files.get(ref.id);
    if (
      !saved ||
      ref.name !== saved.name ||
      ref.mediaType !== saved.mediaType ||
      ref.size !== saved.size ||
      ref.url !== undefined
    )
      throw new Refusal(
        400,
        "file_missing",
        "This upload is no longer available. Remove it and choose the file again.",
      );
    attachments.push(saved);
  }
  if (!value.text.trim() && !attachments.length)
    throw new Refusal(400, "empty", "Write a message or add a file first.");
  return { clientId: value.clientId, text: value.text, attachments };
}

function startRun(chat: Conversation, input: SendInput, flow?: ApprovalMode, gap = false): void {
  const agent = flow ? requestAgent(chat.stats, tickMs) : scriptedAgent(chat.stats, tickMs);
  const work = new DemoRun(
    chat.principalId,
    chat.resourceId,
    agent,
    chat.stats,
    (event) => {
      if (chat.work === work) publish(chat, event);
    },
    (run) => {
      if (chat.work !== run || !run.snapshot) return;
      const projected = run.projector.snapshot(run.snapshot);
      const parts: DisplayPart[] = [...(flow ? [] : sources), ...projected.parts];
      if (run.snapshot.state.status === "completed")
        parts.push({
          type: "data",
          id: "sample-result",
          kind: "sample-summary",
          data: {
            title: "Sample finished",
            text: flow
              ? "The request journal and handoff finished. No external service was called."
              : "Both fictional records agree. No booking was made.",
          },
        });
      publish(chat, {
        v: 1,
        type: "snapshot",
        messages: chat.view.messages.map((message) =>
          message.id === run.messageId ? { ...projected, parts } : message,
        ),
        run: run.projector.run(run.snapshot),
        inputs: run.inputs(),
      });
    },
    () => pause(chat),
    flow,
    gap,
  );
  chat.work = work;
  publish(chat, {
    v: 1,
    type: "message",
    message: {
      id: crypto.randomUUID(),
      clientId: input.clientId,
      role: "user",
      state: "settled",
      parts: [
        ...(input.text
          ? [{ type: "text" as const, id: "text", text: input.text, settled: true }]
          : []),
        ...(input.attachments ?? []).map((file) => ({ type: "attachment" as const, ...file })),
      ],
    },
  });
  publish(chat, {
    v: 1,
    type: "message",
    message: {
      id: work.messageId,
      role: "assistant",
      state: "live",
      parts: flow ? [] : sources,
    },
  });
  publish(chat, {
    v: 1,
    type: "run",
    run: { id: work.id, messageId: work.messageId, status: "running" },
  });
  work.start();
}

async function send(chat: Conversation, request: Request, url: URL): Promise<Response> {
  const input = parseInput(await json(request), chat);
  const payload = JSON.stringify(input);
  const prior = chat.sends.get(input.clientId);
  if (prior) {
    if (prior.payload !== payload)
      throw new Refusal(
        409,
        "duplicate_id",
        "That message ID already belongs to different content. Reload the conversation.",
      );
    await prior.ack;
    return new Response(null, { status: 204 });
  }
  if (busy(chat))
    throw new Refusal(
      409,
      "busy",
      "Wait for this reply to finish, or stop it before sending another.",
    );
  if (chat.sends.size >= 20)
    throw new Refusal(
      409,
      "full",
      "This demo keeps 20 messages per conversation. Restart the local server to clear them.",
    );
  const mode = url.searchParams.get("mode") ?? "normal";
  if (!["normal", "delay", "refuse", "unknown"].includes(mode))
    throw new Refusal(400, "mode", "Choose a listed send mode.");
  if (mode === "refuse")
    throw new Refusal(
      422,
      "demo_refusal",
      "The demo refused this send. Your draft is safe. Choose Normal and send again.",
    );
  if (mode === "unknown") pause(chat);
  // Reserve the clientId before the first await, so concurrent duplicates share one acceptance.
  startRun(chat, input, undefined, url.searchParams.get("gap") === "1");
  const ack = mode === "delay" ? delay(1800) : Promise.resolve();
  chat.sends.set(input.clientId, { payload, ack });
  await ack;
  if (mode === "unknown")
    throw new Refusal(
      503,
      "lost_ack",
      "The send reply was lost in this demo. Check the saved conversation before sending again.",
    );
  return new Response(null, { status: 204 });
}

async function loadHistory(chat: Conversation, url: URL): Promise<void> {
  const page = Number(url.searchParams.get("page"));
  const mode = url.searchParams.get("mode") ?? "normal";
  if (![1, 2, 3].includes(page) || !["normal", "fail"].includes(mode))
    throw new Refusal(400, "history_page", "Use Load earlier messages to choose a sample page.");
  await delay(700);
  if (mode === "fail")
    throw new Refusal(
      503,
      "history_failed",
      "The demo refused this history load. Your messages are unchanged. Choose Retry earlier messages.",
    );
  if (page > 1 && !chat.view.messages.some((message) => message.id === "sample-history-5"))
    throw new Refusal(409, "history_order", "Load the newest sample history page first.");
  const end = earlierMessages.length - (page - 1) * historyPageSize;
  const messages = earlierMessages.slice(Math.max(0, end - historyPageSize), end);
  const missing = messages.filter(
    (message) => !chat.view.messages.some((item) => item.id === message.id),
  );
  if (!missing.length) return;
  // The snapshot keeps every current message and its IDs. The public scroller owns PREPEND.
  publish(chat, {
    v: 1,
    type: "snapshot",
    messages: [...missing, ...chat.view.messages],
    run: chat.view.run,
  });
}

function approvalMode(url: URL): ApprovalMode {
  const mode = url.searchParams.get("mode") ?? "pending";
  if (mode === "pending" || mode === "expire" || mode === "unknown") return mode;
  throw new Refusal(400, "request_mode", "Choose a listed request mode.");
}

function requestApproval(chat: Conversation, mode: ApprovalMode): void {
  if (busy(chat)) throw new Refusal(409, "busy", "Finish or stop the current reply first.");
  if (chat.stats.runs >= 20)
    throw new Refusal(409, "run_limit", "Restart the local server to clear its 20 sample replies.");
  startRun(
    chat,
    { clientId: crypto.randomUUID(), text: "Try questions, an approved card and a handoff." },
    mode,
  );
}

async function stop(chat: Conversation): Promise<void> {
  if (busy(chat)) await chat.work?.stop();
  await delay(350);
}

async function upload(chat: Conversation, request: Request): Promise<Response> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!fileTypes.includes(type))
    throw new Refusal(415, "file_type", "Choose a PNG, JPEG or plain text file.");
  const mode = request.headers.get("X-Demo-Upload") ?? "normal";
  if (!["normal", "slow", "late", "fail"].includes(mode))
    throw new Refusal(400, "upload_mode", "Choose a listed upload mode.");
  if (mode === "fail")
    throw new Refusal(
      503,
      "upload_failed",
      "The demo refused this upload before saving it. Choose Retry to try again.",
    );
  if (chat.files.size >= 60)
    throw new Refusal(
      409,
      "uploads_full",
      "The demo upload limit is reached. Restart the local server to clear it.",
    );
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > maxFileBytes)
    throw new Refusal(413, "size", "Choose a nonempty file of 1 MB or less.");
  await delay(mode === "slow" || mode === "late" ? 3500 : 400, undefined, {
    signal: request.signal,
  });
  request.signal.throwIfAborted();
  if (chat.files.size >= 60)
    throw new Refusal(
      409,
      "uploads_full",
      "The demo upload limit is reached. Restart the local server to clear it.",
    );
  // Discard the bytes. Never serve user content or trust a filename as a filesystem path.
  const reference: AttachmentRef = {
    id: crypto.randomUUID(),
    name: type === "text/plain" ? "Sample note.txt" : "Sample image",
    mediaType: type,
    size: bytes.byteLength,
  };
  chat.files.set(reference.id, reference);
  return Response.json(reference);
}

async function json(request: Request): Promise<unknown> {
  if (request.headers.get("content-type") !== "application/json")
    throw new Refusal(415, "json", "Send this command as JSON.");
  try {
    return await request.json();
  } catch {
    throw new Refusal(400, "json", "The command was incomplete. Try again.");
  }
}

const build = await Bun.build({
  entrypoints: [new URL("./app.tsx", import.meta.url).pathname],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!build.success) throw new AggregateError(build.logs, "The demo browser build failed.");
const assets = new Map(build.outputs.map((file) => [`/${file.path.split("/").at(-1)}`, file]));
const html = await Bun.file(new URL("./index.html", import.meta.url)).text();
// One generated PNG, never a path or URL supplied by an upload, model or request.
const sampleImage = await Bun.file(new URL("./sample-image.png", import.meta.url)).arrayBuffer();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  maxRequestBodySize: maxFileBytes + 16384,
  async fetch(request) {
    const url = new URL(request.url);
    let response: Response;
    try {
      // Local demo, not authentication. Prevent other websites and DNS rebinding from using it.
      if (
        url.host !== server.url.host ||
        (request.headers.get("origin") && request.headers.get("origin") !== server.url.origin)
      )
        throw new Refusal(403, "origin", "Open the demo at its printed loopback address.");
      if (request.method === "GET" && url.pathname === "/") {
        const page =
          url.searchParams.get("theme") === "dark"
            ? html.replace('data-theme="light"', 'data-theme="dark"').replace("#f2f5f4", "#17211d")
            : html;
        response = new Response(page, { headers: { "Content-Type": "text/html" } });
      } else if (request.method === "GET" && url.pathname === "/sample-link")
        response = new Response(
          "Local sample link opened.\n\nThis page belongs to the demo. No external site was contacted. Close this tab to return to your conversation and draft.",
          { headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      else if (request.method === "GET" && assets.has(url.pathname))
        response = new Response(assets.get(url.pathname));
      else {
        if (request.headers.get("X-Demo-Request") !== "1")
          throw new Refusal(403, "local_only", "Use the local demo page to make this request.");
        const match =
          /^\/api\/(alex|sam)\/(visit|notes)\/(events|state|stats|send|respond|stop|upload|approval|claim|execute|complete|enqueue|recall|disconnect|connect|history|fixtures|sample-image)$/.exec(
            url.pathname,
          );
        if (!match)
          throw new Refusal(404, "not_found", "This demo page does not exist. Open the home page.");
        // Synthetic profile selection, not authentication. A production host reads its session.
        if (request.headers.get("X-Demo-Profile") !== match[1])
          throw new Refusal(
            403,
            "profile",
            "This request does not match the selected demo profile.",
          );
        const chat = conversation(`${match[1]}/${match[2]}`);
        const action = match[3];
        if (request.method === "GET" && action === "events") response = observe(chat, request, url);
        else if (request.method === "GET" && action === "state")
          response = Response.json(snapshot(chat));
        else if (request.method === "GET" && action === "stats")
          response = Response.json(chat.stats);
        else if (request.method === "GET" && action === "sample-image") {
          const mode = url.searchParams.get("mode") ?? "normal";
          if (
            !["normal", "slow"].includes(mode) ||
            [...url.searchParams.keys()].some((key) => key !== "mode")
          )
            throw new Refusal(
              400,
              "image_mode",
              "Choose the generated sample image, with an optional 3-second delay.",
            );
          await delay(mode === "slow" ? 3000 : 1, undefined, { signal: request.signal });
          response = new Response(sampleImage, { headers: { "Content-Type": "image/png" } });
        } else if (request.method !== "POST")
          throw new Refusal(405, "method", "Use the demo controls for this action.");
        else if (action === "send") response = await send(chat, request, url);
        else if (action === "upload") response = await upload(chat, request);
        else if (
          ["claim", "execute", "complete", "enqueue", "recall", "respond"].includes(action ?? "")
        ) {
          const value = await json(request);
          const work = chat.work;
          if (!work) throw new Refusal(409, "run", "Start a sample reply first.");
          if (action === "respond") {
            await work.respond(value);
            response = new Response(null, { status: 204 });
          } else if (action === "claim") {
            if (!isRecord(value) || value.segment !== chat.segment)
              throw new Refusal(409, "segment", "This action view is stale. Check for updates.");
            response = Response.json(work.claim(value));
          } else if (action === "enqueue") {
            const input = parseInput(value, chat);
            // Upload bytes remain discarded. Only their already-validated synthetic names are input.
            const text = [input.text, ...(input.attachments ?? []).map((file) => `[${file.name}]`)]
              .filter(Boolean)
              .join("\n");
            response = Response.json(
              work.enqueue(input.clientId, text, isRecord(value) ? value.rootRunId : undefined),
            );
          } else if (action === "recall") {
            response = Response.json(
              work.recall(
                isRecord(value) ? value.id : undefined,
                isRecord(value) ? value.rootRunId : undefined,
              ),
            );
          } else
            response = Response.json(
              work.action(value, action === "complete", url.searchParams.get("lose") === "1"),
            );
        } else {
          if (action === "stop") await stop(chat);
          else if (action === "approval") requestApproval(chat, approvalMode(url));
          else if (action === "history") await loadHistory(chat, url);
          else if (action === "fixtures") {
            if (!chat.view.messages.some((message) => message.id === fixtureMessageId))
              publish(chat, { v: 1, type: "message", message: sampleFixtures(server.url.origin) });
          } else if (action === "disconnect") pause(chat);
          else if (action === "connect") chat.paused = false;
          else throw new Refusal(405, "method", "Use the demo controls for this action.");
          response = new Response(null, { status: 204 });
        }
      }
    } catch (error) {
      response =
        error instanceof Refusal
          ? Response.json({ code: error.code, message: error.message }, { status: error.status })
          : Response.json(
              {
                code: "local_error",
                message:
                  "The local request did not finish. Check the conversation before trying again.",
              },
              { status: 500 },
            );
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return response;
  },
});
console.log(JSON.stringify({ url: server.url.href, pid: process.pid }));
