/**
 * The client: one conversation as a person sees it, the commands they give it, and the
 * observation that keeps it current.
 *
 * A plain store with no React in it, so the hooks, a test or another framework drive the same
 * object. It holds what only the browser can know: a message it sent that the host has not
 * confirmed, an answer on its way, a stop it asked for, and whether it can still hear the host.
 * Everything the host says goes through `reduceChat`, the one reducer, unchanged.
 *
 * Two rules shape the rest. A command goes out once per thing the person did, and never again on
 * its own: when its outcome is unknown, the client keeps what the person did, marks it
 * unconfirmed and watches the host, and only the person can send it again. And watching is only
 * watching: unmounting, switching conversation or losing the connection never stops a run. Stop
 * is a command.
 *
 * No React, no DOM at import: a server renders with it and a React Native app runs it.
 */
import {
  PROTOCOL_VERSION,
  parseChatEvent,
  isRequestPart,
  type RequestPart,
  type AttachmentPart,
  type ChatEvent,
  type DisplayError,
  type DisplayInput,
  type DisplayMessage,
  type DisplayPart,
  type MessageState,
  type RunInfo,
  type TextPart,
} from "./protocol.ts";
import {
  emptyChatView,
  isActive,
  isFinal,
  keepList,
  reduceChat,
  type ChatView,
  type Cursor,
} from "./state.ts";

/** A file the host already holds, sent with a message. Upload it first: the host gets this
 * reference, never the bytes. */
export interface AttachmentRef {
  /** The host's own id for the file. */
  id: string;
  name: string;
  mediaType: string;
  /** Bytes. */
  size?: number;
  /** Shown as the file's link or preview until the host's copy of the message arrives. */
  url?: string;
}

/** What a person sends: text, files, or both. */
export interface MessageInput {
  text?: string;
  attachments?: readonly AttachmentRef[];
}

/** One message as the transport hands it to the host. */
export interface SendInput {
  /** Made by the client once per message, and sent unchanged by `retry`. A host that keeps it
   * can tell a second delivery of one message from a new one, and echoes it on its own copy so
   * the client swaps its copy for the host's. */
  clientId: string;
  /** Empty for a message that is only files. */
  text: string;
  attachments?: readonly AttachmentRef[];
}

import {
  checkResponse,
  parseRequestAnswers,
  type RequestAnswer,
  type RequestResponse,
} from "./requests.ts";
export type { RequestAnswer, RequestResponse, QuestionAnswer } from "./requests.ts";

export interface ClientToolClaimRequest {
  requestId: string;
  runId: string;
  segment?: string;
  name: string;
  input: unknown;
  signal: AbortSignal;
}

/** Host authority, not a local lock. A grant must exclude every other device and survive reload.
 * complete must persist the result idempotently before delivery. Reconcile uncertain work in claim;
 * never grant it again merely because a lease expired. Authenticate and validate on the host. */
export type ClientToolClaim =
  | { status: "granted"; complete(value: unknown): void | Promise<void> }
  | { status: "completed"; value: unknown }
  | { status: "denied" | "busy" | "unknown" };

export type ClientToolHandler = {
  /** Manual dispatch only. Validate input and respect cancellation; abort is not rollback. */
  run(
    input: unknown,
    context: { signal: AbortSignal; requestId: string },
  ): unknown | Promise<unknown>;
} & (
  | { safety: "read-only" | "repeatable" }
  | {
      safety: "claimed";
      claim(request: ClientToolClaimRequest): ClientToolClaim | Promise<ClientToolClaim>;
    }
);

export type RespondResult =
  | { ok: true; outcome: "accepted" | "unknown" }
  | { ok: false; error: DisplayError };

export interface Respond {
  (requestId: string, response: RequestResponse): Promise<RespondResult>;
  (answers: readonly RequestAnswer[]): Promise<RespondResult>;
}

/** A reply that is itself the event stream, like the response of a POST. */
export interface EventReply {
  events: AsyncIterable<ChatEvent>;
}

/**
 * How a client talks to a host. Every method is optional, and the client offers only what its
 * transport can do.
 *
 * Three shapes of host fit it. A POST whose response is the stream: `send` returns `events`. A
 * start call plus a separate tail: `send` resolves and `observe` streams. A message port: both
 * wrap the port. A host that cannot resume after a cursor opens every observation with a
 * snapshot.
 *
 * Hand the client only events that `parseChatEvent` returned. To say what became of a command,
 * throw a `TransportError`. Anything else thrown counts as an unknown outcome.
 */
export interface EnqueueInput extends SendInput {
  /** A requested destination, never permission. The host checks the principal and saved run. */
  rootRunId: string;
}

export interface InputView extends Omit<DisplayInput, "status"> {
  status: DisplayInput["status"] | "sending" | "unconfirmed";
  canRecall: boolean;
  /** Confirmed upload references from this client's submitted draft, never local File objects. */
  attachments?: readonly AttachmentRef[];
  recalling?: boolean;
  error?: DisplayError;
}

export interface ChatTransport {
  /** Active-run sends use this instead of send. Authorize and persist immutable user content in
   * the run's InputInbox. Receipt id must equal clientId. Never create a new run or grant tool authority. */
  enqueue?(input: EnqueueInput, options: { signal: AbortSignal }): Promise<DisplayInput>;
  /** Optional host capability. Reserve/reconcile against inbox poll + checkpoint, not just its
   * queued label. Refuse after claim/acceptance. createMemoryInbox alone cannot implement this. */
  recallInput?(
    input: { id: string; rootRunId: string },
    options: { signal: AbortSignal },
  ): Promise<DisplayInput>;
  /** Called once per message the person sends, and once more only when they ask (`retry`). */
  send?(input: SendInput, options: { signal: AbortSignal }): Promise<void | EventReply>;
  /** The host's events after `cursor`, or from the start without one. The client opens one at a
   * time, and aborts `signal` once it stops reading. */
  observe?(options: { cursor?: Cursor; signal: AbortSignal }): AsyncIterable<ChatEvent>;
  /** Asks the host to stop `run`. The client then waits for the host to say it stopped. `run` is
   * the run as the client holds it: until the host names the run a message started, that is the
   * run before it, so a host that stops by conversation can ignore it. */
  stop?(run: RunInfo): Promise<void>;
  /** Answers one request or an explicit batch. Partial batches leave other requests open. */
  respond?(
    answers: readonly RequestAnswer[],
    options: { signal: AbortSignal },
  ): Promise<void | EventReply>;
}

/**
 * What a transport throws to say what became of a command.
 *
 * `refused`: the host said no and did nothing, like a 4xx. The client takes the command back: a
 * message leaves the conversation and its text goes back to the person, the buttons of an answer
 * come back, and an observation stops trying unless `error.retryable` says a later try can
 * work. `unknown`: anything else, like a 5xx, a dropped connection or a timeout. The host may
 * have acted, so the client never repeats it on its own.
 */
export class TransportError extends Error {
  readonly outcome: "refused" | "unknown";
  /** Safe to show: the host wrote it, or the transport did. */
  readonly error: DisplayError;

  constructor(outcome: "refused" | "unknown", error: DisplayError, options?: { cause?: unknown }) {
    super(error.message, options);
    this.name = "TransportError";
    this.outcome = outcome;
    this.error = error;
  }
}

/** What the person can do now: the host's word on the run, plus what only the client knows, a
 * send or a stop it is still waiting on. `ready` means a message can go. */
export type ChatStatus = "ready" | "sending" | "running" | "waiting" | "stopping";

/** Whether the client can hear the host. Kept apart from the run on purpose: a run goes on when
 * the connection drops, and a lost connection says nothing about the run. */
export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "lost";

/** A request the run waits on, with what this client did about it. */
export interface RequestView {
  part: RequestPart;
  /** Capabilities of this client, not execution permission. Absent for plain-data hosts. */
  canRespond?: boolean;
  canRun?: boolean;
  /** A manual check can reconcile a durable claim or deliver a retained result, without rerunning. */
  canReconcile?: boolean;
  /** The message the request sits in. */
  messageId: string;
  /** An answer from this client that the host has not acted on yet. */
  local?: {
    /** `submitting`: on its way, so the buttons wait. `unconfirmed`: it may or may not have
     * arrived. The client watches the host, and sends it again only when the person does.
     * `failed`: the host turned it down, and the person can answer again. */
    status: "submitting" | "unconfirmed" | "failed";
    response: RequestResponse;
    error?: DisplayError;
  };
}

/** Everything a view of the conversation draws. A new object only when something in it moved. */
export interface ChatState {
  /** The host's messages and this client's own, in order. A message this client sent shows as
   * `sending` while its call is out, `settled` once the host took it, and `failed` when that is
   * unknown (see `messageErrors`), until the host's own copy takes its place. */
  messages: readonly DisplayMessage[];
  run: RunInfo;
  status: ChatStatus;
  connection: ConnectionStatus;
  /** What went wrong that is not about one message or one request: the connection, or a stop
   * that did not go through. */
  error?: DisplayError;
  /** Every request that is waiting, in reading order. */
  requests: readonly RequestView[];
  /** User input delivery, never completed assistant output. */
  inputs: readonly InputView[];
  /** By message id: why a message this client sent shows as failed. `unconfirmed` means it may
   * not have arrived, and `retry` sends it again. */
  messageErrors: Readonly<Record<string, DisplayError>>;
  canSend: boolean;
  /** A stop can reach the run: the transport has `stop`, or the client can abort its pending
   * command or reply stream. */
  canStop: boolean;
  /** The connection is lost and the transport can observe, so `reconnect` can work. */
  canReconnect: boolean;
}

export type CommandResult = { ok: true } | { ok: false; error: DisplayError };

/** `ok` means the message stays in the conversation, not that delivery is confirmed. Clear
 * a submitted draft only when `outcome` is `accepted`. An `unknown` outcome stays visible while
 * observation checks the host. Otherwise `input` is what was taken back, so the draft can keep it. */
export type SendResult =
  | { ok: true; messageId: string; outcome: "accepted" | "unknown" }
  | { ok: false; error: DisplayError; input?: SendInput };

/** How the client reattaches when a stream ends or fails while a run is going. */
export interface ReconnectOptions {
  /** Tries in a row that bring nothing new before the connection counts as lost. An event that
   * changes the view starts the count again. A connection that opens and says nothing does not,
   * or a host that accepts and closes would be retried forever. Default 5, and 0 turns
   * reattaching off. */
  attempts?: number;
  /** Wait before the first try, doubled for each one after it. Default 1,000. */
  baseDelayMs?: number;
  /** Longest wait between tries. Default 15,000. */
  maxDelayMs?: number;
}

export interface ChatClientOptions {
  transport: ChatTransport;
  /** What to show before the host says anything, such as a transcript rendered on the server. */
  initialMessages?: readonly DisplayMessage[];
  /** Permits overlapping ordinary sends and retries. Off by default. A host with `enqueue`
   * can accept steering input during a run without enabling this option. */
  allowSendWhileRunning?: boolean;
  reconnect?: ReconnectOptions;
  /** App-owned handlers with an explicit repeat-safety declaration or a durable host claim.
   * All dispatch is manual. Disclosure or a browser key alone never authorizes a write. */
  clientTools?: Readonly<Record<string, ClientToolHandler>>;
}

export interface ChatClient {
  /** The current state. The same object until something in it changed. */
  getState(): ChatState;
  /** Called after the state changed. What the host streams is batched to one call per frame. */
  subscribe(listener: () => void): () => void;
  /**
   * Starts observing, and returns the function that stops. Commands work without it, but only an
   * attached client opens observations and reattaches them.
   *
   * Calls nest: the client observes while anyone is attached. Detaching closes the observation
   * and nothing else. A stream that is the reply to a command stays open to its end, because for
   * many hosts closing it stops the run, and only Stop may stop a run.
   */
  attach(): () => void;
  send(input: string | MessageInput): Promise<SendResult>;
  /** Sends a message whose outcome is unknown again, with the same `clientId`. Nothing else ever
   * sends a message twice. */
  retry(messageId: string): Promise<SendResult>;
  /** Asks the host to stop the run, then waits for it to say so, with the observation still
   * open. Without `transport.stop`, closes the stream the run lives in and marks it stopped here. */
  stop(): Promise<CommandResult>;
  /** Answers a request. It shows as submitting until the host changes the request or the run. */
  respond: Respond;
  /** Explicit user action only. Never wire this to an effect or a replay listener. After a result
   * delivery failure, this resubmits the saved result, never reruns the handler. */
  startClientTool(requestId: string): Promise<RespondResult>;
  /** Manual recall through a host that can fence the race with input acceptance. */
  recallInput(inputId: string): Promise<CommandResult>;
  /** Opens a fresh observation, with a full budget of tries, after the connection was lost. */
  reconnect(): void;
  /** A new transport or changed settings, for what comes next. `initialMessages` is read once,
   * when the client is made. */
  setOptions(options: ChatClientOptions): void;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 15_000;
/** Where nothing paints frames: a server, a test, a worker. */
const FRAME_MS = 16;
/** A hidden tab paints no frames, but an app may watch the store to tell the person an answer is
 * ready, so a notification never waits on a frame longer than this. */
const HIDDEN_FRAME_MS = 250;

function fixed(code: string, message: string): DisplayError {
  return Object.freeze({ code, message });
}

// The client's own errors. A `code` never changes, so an app can show its own words for it, in its
// own language.
const EMPTY = fixed("empty", "Write a message or add a file first.");
const BUSY = fixed(
  "busy",
  "Wait for the answer to finish, or stop it, before you send another message.",
);
const CANNOT_SEND = fixed("unsupported", "This chat cannot send messages.");
const CANNOT_ANSWER = fixed("unsupported", "This chat cannot send answers.");
const CANNOT_STOP = fixed("unsupported", "This chat cannot stop the answer.");
const NOT_WAITING = fixed("not_waiting", "This request is no longer waiting for an answer.");
const ANSWERING = fixed("answering", "Your answer is still on its way.");
const NOTHING_TO_RETRY = fixed("not_unconfirmed", "This message does not need to be sent again.");
const UNCONFIRMED_SEND = fixed("unconfirmed", "This message may not have been sent.");
const UNCONFIRMED_ANSWER = fixed("unconfirmed", "Your answer may not have arrived.");
const STOP_FAILED = fixed("stop_failed", "Could not stop the answer. Try again.");
const LOST = fixed("connection_lost", "The connection to the server was lost.");

interface Send {
  input: SendInput;
  /** `sending`: the call is out. `accepted`: the host took it, and its own copy has not arrived
   * yet. `unconfirmed`: the call failed in a way that says nothing about whether the host has it. */
  phase: "sending" | "accepted" | "unconfirmed";
  /** The copy shown in its place, kept so a rebuild that changed nothing hands out the same
   * object. */
  shown?: { from: DisplayMessage; message: DisplayMessage };
}

/** How each phase shows. The view itself keeps every message this client sent as `sending`. */
const SHOWN = {
  sending: undefined,
  accepted: "settled",
  unconfirmed: "failed",
} as const satisfies Record<Send["phase"], MessageState | undefined>;

interface Answer {
  /** The request as it was when the answer went out. A host event can close it or reject the answer. */
  part: RequestPart;
  local: NonNullable<RequestView["local"]>;
}

interface DeviceRun {
  part: RequestPart;
  controller: AbortController;
  runId: string | undefined;
  segment: string | undefined;
  response?: Extract<RequestResponse, { type: "result" }>;
  outcome: "running" | "result" | "unknown";
}

interface InputSend {
  input: EnqueueInput;
  phase: "sending" | "unconfirmed" | "accepted";
  receipt?: DisplayInput;
}

interface Stream {
  /** `command`: the reply to a send or an answer, which may be the run itself. */
  kind: "observe" | "command";
  controller: AbortController;
}

let made = 0;

/** Unique within the page, and nothing more is asked of it: the host enforces idempotency and
 * authorization, never an id a browser made. `randomUUID` exists only on secure pages, and not in
 * React Native. */
function createId(): string {
  const { crypto } = globalThis;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  made += 1;
  return `${Date.now().toString(36)}-${made.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Calls back on the next frame. Read at call time, never at import, so a server and React Native
 * load this file as it is. */
function nextFrame(callback: () => void): () => void {
  const paints = typeof globalThis.requestAnimationFrame === "function";
  const timer = setTimeout(run, paints ? HIDDEN_FRAME_MS : FRAME_MS);
  const frame = paints ? globalThis.requestAnimationFrame(run) : undefined;
  function cancel(): void {
    clearTimeout(timer);
    if (frame !== undefined) globalThis.cancelAnimationFrame(frame);
  }
  function run(): void {
    cancel();
    callback();
  }
  return cancel;
}

function textPart(text: string): TextPart {
  return { type: "text", id: "text", text, settled: true };
}

function attachmentPart(file: AttachmentRef, index: number): AttachmentPart {
  const part: AttachmentPart = {
    type: "attachment",
    id: `file-${index}`,
    name: file.name,
    mediaType: file.mediaType,
  };
  if (file.size !== undefined) part.size = file.size;
  if (file.url !== undefined) part.url = file.url;
  return part;
}

/** Whether the client's own copy of a message is still in the view, waiting for the host's. */
function stillSending(messages: readonly DisplayMessage[], id: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.id === id) return message.state === "sending";
  }
  return false;
}

/** The request with this id, while it still waits. From the end: requests are recent. */
function openRequest(messages: readonly DisplayMessage[], id: string): RequestPart | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || isFinal(message)) continue;
    for (const part of message.parts)
      if (isRequestPart(part) && part.id === id) return part.state === "pending" ? part : undefined;
  }
  return undefined;
}

/** The message a run writes: the one it names, or else the newest assistant message still live. */
function writing(messages: readonly DisplayMessage[], id?: string): DisplayMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || isFinal(message)) continue;
    if (id === undefined ? message.role === "assistant" : message.id === id) return message;
  }
  return undefined;
}

/** A part as a host draws it once its run ended: nothing goes on, and a request can no longer be
 * answered. */
function seal(part: DisplayPart): DisplayPart {
  switch (part.type) {
    case "text":
      return part.settled ? part : { ...part, settled: true };
    case "tool":
      return part.state === "running" || part.state === "waiting"
        ? { ...part, state: "failed" }
        : part;
    case "agent":
      return isActive(part.state) ? { ...part, state: "stopped" } : part;
    case "approval":
    case "question":
    case "client-tool":
      // An aborted connection cannot decide a server request.
      return part;
    default:
      return part;
  }
}

function sameState(left: ChatState, right: ChatState): boolean {
  return (
    left.messages === right.messages &&
    left.run === right.run &&
    left.status === right.status &&
    left.connection === right.connection &&
    left.error === right.error &&
    left.requests === right.requests &&
    left.inputs === right.inputs &&
    left.messageErrors === right.messageErrors &&
    left.canSend === right.canSend &&
    left.canStop === right.canStop &&
    left.canReconnect === right.canReconnect
  );
}

/** A host with no segments numbers in one space, and an id is never empty, so "" stands for it. */
function segmentKey(segment: string | undefined): string {
  return segment ?? "";
}

/**
 * Makes the store for one conversation. For another conversation, or another person signed in,
 * make another: nothing a client holds can then reach the next one, however late it arrives.
 */
export function createChatClient(options: ChatClientOptions): ChatClient {
  let settings = options;
  let view: ChatView = { ...emptyChatView(), messages: options.initialMessages ?? [] };
  /** Segments the cursor moved on from. A numbered event from one of them is late: the rest of a
   * stream from before the approval that started the segment the view is in now. */
  const left = new Set<string>();
  const sends = new Map<string, Send>();
  const answers = new Map<string, Answer>();
  const deviceRuns = new Map<string, DeviceRun>();
  const inputSends = new Map<string, InputSend>();
  const inputCommands = new Map<AbortController, string>();
  const recalls = new Map<string, { pending: boolean; error?: DisplayError }>();
  const commands = new Set<AbortController>();
  // Controller identity is the command generation: an older reply cannot replace newer work.
  let latestCommand: AbortController | undefined;
  const listeners = new Set<{ listener: () => void }>();
  let stream: Stream | undefined;
  let initialized = false;
  let connection: ConnectionStatus = "idle";
  /** Tries since the last event that changed the view. */
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attached = 0;
  /** The run as it was when the host took a command, until the host says anything new about it.
   * Until then the run the person asked for has not shown up, and a stream that ends then ended
   * before its run did. */
  let starting: RunInfo | undefined;
  let stopping = false;
  let problem: { source: "connection" | "stop"; error: DisplayError } | undefined;
  let stale = false;
  let cancelFrame: (() => void) | undefined;
  // What the last build handed out, so the next one can hand out the same objects.
  let shown: readonly DisplayMessage[] = view.messages;
  let waiting: readonly RequestView[] = [];
  let inputs: readonly InputView[] = [];
  let failures: Readonly<Record<string, DisplayError>> = {};
  let state = build(undefined);
  let notified = state;

  function getState(): ChatState {
    if (stale) {
      stale = false;
      state = build(state);
    }
    return state;
  }

  function subscribe(listener: () => void): () => void {
    const entry = { listener };
    listeners.add(entry);
    return () => {
      listeners.delete(entry);
    };
  }

  function notify(): void {
    if (getState() === notified) return;
    notified = state;
    for (const { listener } of [...listeners]) listener();
  }

  /** Tells listeners at once: the person just did something, and every action shows at once. */
  function now(): void {
    stale = true;
    cancelFrame?.();
    cancelFrame = undefined;
    notify();
  }

  /** Tells listeners on the next frame. A host streams text a few characters at a time, and one
   * render per delta spends the frame on text nobody can read that fast. */
  function soon(): void {
    stale = true;
    if (cancelFrame || listeners.size === 0) return;
    cancelFrame = nextFrame(() => {
      cancelFrame = undefined;
      notify();
    });
  }

  function build(previous: ChatState | undefined): ChatState {
    const { transport } = settings;
    const status = statusOf();
    const lost = connection === "lost";
    const next: ChatState = {
      messages: present(),
      run: view.run,
      status,
      connection,
      requests: listRequests(),
      inputs: listInputs(),
      messageErrors: errorsOf(),
      canSend:
        canSendOrdinary(status) ||
        (!stopping &&
          isActive(view.run.status) &&
          Boolean(view.run.id) &&
          transport.enqueue !== undefined),
      canStop:
        status !== "ready" &&
        status !== "stopping" &&
        (transport.stop !== undefined || commands.size > 0),
      canReconnect: lost && transport.observe !== undefined,
    };
    if (problem) next.error = problem.error;
    return previous && sameState(previous, next) ? previous : next;
  }

  // An ordinary retry can start work. The ability to steer an active run does not permit it.
  function canSendOrdinary(status = statusOf()): boolean {
    return (
      !stopping &&
      settings.transport.send !== undefined &&
      (settings.allowSendWhileRunning === true || status === "ready")
    );
  }

  function statusOf(): ChatStatus {
    if (stopping) return "stopping";
    const { status } = view.run;
    if (status === "running" || status === "waiting") return status;
    if (starting) return stream?.kind === "command" ? "running" : "sending";
    for (const send of sends.values()) if (send.phase === "sending") return "sending";
    return "ready";
  }

  /** The view's messages, with this client's own shown as what it knows about them. The view
   * keeps each one as `sending`, whatever became of it, because that is what the reducer holds
   * on to until the host's copy arrives: a read that started before the host had it must not
   * make it vanish. */
  function present(): readonly DisplayMessage[] {
    const { messages } = view;
    if (sends.size === 0) return (shown = messages);
    let overlaid = false;
    const next = messages.map((message) => {
      const send = message.state === "sending" ? sends.get(message.id) : undefined;
      const phase = send && SHOWN[send.phase];
      if (!send || !phase) return message;
      overlaid = true;
      if (send.shown?.from !== message || send.shown.message.state !== phase)
        send.shown = { from: message, message: { ...message, state: phase } };
      return send.shown.message;
    });
    shown = keepList(shown, overlaid ? next : messages);
    return shown;
  }

  function listRequests(): readonly RequestView[] {
    const next: RequestView[] = [];
    for (const message of view.messages)
      for (const part of message.parts) {
        if (isFinal(message) || !isRequestPart(part) || part.state !== "pending") continue;
        const local = answers.get(part.id)?.local;
        const canRespond = settings.transport.respond !== undefined;
        const canRun =
          canRespond &&
          part.type === "client-tool" &&
          part.name !== undefined &&
          settings.clientTools !== undefined &&
          Object.hasOwn(settings.clientTools, part.name);
        const canReconcile =
          canRun &&
          part.type === "client-tool" &&
          part.name !== undefined &&
          (settings.clientTools?.[part.name]?.safety === "claimed" ||
            Boolean(deviceRuns.get(part.id)?.response));
        const held = waiting[next.length];
        next.push(
          held &&
            held.part === part &&
            held.messageId === message.id &&
            held.local === local &&
            held.canRespond === canRespond &&
            held.canRun === canRun &&
            held.canReconcile === canReconcile
            ? held
            : {
                part,
                messageId: message.id,
                canRespond,
                canRun,
                canReconcile,
                ...(local && { local }),
              },
        );
      }
    waiting = keepList(waiting, next);
    return waiting;
  }

  function listInputs(): readonly InputView[] {
    const records: InputView[] = view.inputs.map((input) => ({ ...input, canRecall: false }));
    for (const [id, entry] of inputSends) {
      const index = records.findIndex(
        (input) => input.id === id && input.rootRunId === entry.input.rootRunId,
      );
      const receipt = records[index] ?? entry.receipt;
      const value: InputView = {
        id,
        rootRunId: entry.input.rootRunId,
        text: entry.input.text,
        attachments: entry.input.attachments,
        status: entry.phase === "sending" ? "sending" : "unconfirmed",
        canRecall: false,
        ...receipt,
      };
      if (index < 0) records.push(value);
      else records[index] = value;
    }
    const next = records.map((input, index) => {
      const recall = recalls.get(input.id);
      const value = {
        ...input,
        canRecall:
          input.status === "queued" &&
          input.rootRunId === view.run.id &&
          Boolean(settings.transport.recallInput),
        ...(recall && { recalling: recall.pending, error: recall.error }),
      };
      const held = inputs[index];
      return held &&
        Object.keys(value).length === Object.keys(held).length &&
        Object.entries(value).every(([key, item]) => Reflect.get(held, key) === item)
        ? held
        : value;
    });
    inputs = keepList(inputs, next);
    return inputs;
  }

  function errorsOf(): Readonly<Record<string, DisplayError>> {
    const next: Record<string, DisplayError> = {};
    let count = 0;
    for (const [id, send] of sends) {
      if (send.phase !== "unconfirmed") continue;
      next[id] = UNCONFIRMED_SEND;
      count += 1;
    }
    const held = Object.keys(failures);
    if (held.length === count && held.every((id) => next[id] === failures[id])) return failures;
    failures = next;
    return next;
  }

  /** One event through the reducer. Cursor-only advances are not progress for the retry budget. */
  function take(event: ChatEvent): boolean {
    if (event.seq !== undefined && left.has(segmentKey(event.segment))) return false;
    const next = reduceChat(view, event);
    // Even an unchanged idle snapshot confirms the host was read. EOF alone cannot do that.
    if (event.type === "snapshot" || event.type === "run") initialized = true;
    // A numbered no-op is a duplicate. An unnumbered snapshot can still report a new refusal
    // with identical display fields, so it must reconcile this submission's local feedback.
    if (next === view && event.seq !== undefined) return false;
    const changed =
      next.messages !== view.messages || next.run !== view.run || next.inputs !== view.inputs;
    const from = view.cursor;
    if (from && next.cursor && next.cursor.segment !== from.segment)
      left.add(segmentKey(from.segment));
    view = next;
    let reported: readonly DisplayPart[] = [];
    switch (event.type) {
      case "snapshot":
        reported = event.messages.flatMap((message) => message.parts);
        break;
      case "message":
        reported = event.message.parts;
        break;
      case "part":
        reported = [event.part];
        break;
    }
    return settle(reported) || changed;
  }

  /** Only fresh host events reach here. Unrelated progress cannot repeat an earlier refusal. */
  function settle(reported: readonly DisplayPart[] = []): boolean {
    let changed = false;
    for (const input of view.inputs) {
      const entry = inputSends.get(input.id);
      if (entry && entry.input.rootRunId === input.rootRunId) {
        entry.receipt = input;
        entry.phase = "accepted";
      }
    }
    for (const [controller, rootRunId] of inputCommands)
      if (view.run.id !== rootRunId) controller.abort();
    for (const id of sends.keys()) if (!stillSending(view.messages, id)) sends.delete(id);
    for (const [id, answer] of answers) {
      const part = openRequest(view.messages, id);
      if (!part) {
        answers.delete(id);
        changed = true;
      } else if (
        part !== answer.part ||
        (part.problem &&
          answer.local.status !== "failed" &&
          reported.some((item) => item.id === id))
      ) {
        // A saved rejection is authoritative feedback, not confirmation of the earlier POST.
        // Keep the submitted value while detaching its now-stale delivery callback.
        if (part.problem)
          answers.set(id, {
            part,
            local: { status: "failed", response: answer.local.response, error: part.problem },
          });
        else answers.delete(id);
        changed = true;
      }
    }
    for (const [id, device] of deviceRuns)
      if (
        openRequest(view.messages, id) !== device.part ||
        view.run.id !== device.runId ||
        view.cursor?.segment !== device.segment
      )
        device.controller.abort();
    if (starting && view.run !== starting) starting = undefined;
    const going = isActive(view.run.status) || starting !== undefined;
    if (!going) stopping = false;
    if (!going && problem?.source === "stop") problem = undefined;
    stale = true;
    return changed;
  }

  function cancelRetry(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function close(): void {
    const previous = stream;
    stream = undefined;
    previous?.controller.abort();
  }

  /** Only the current stream changes the view. Superseded command replies still drain: closing a
   * POST body can stop execution, which only an explicit Stop may do. */
  async function read(
    events: AsyncIterable<ChatEvent>,
    kind: Stream["kind"],
    controller: AbortController,
    applyEvents = true,
  ): Promise<void> {
    const mine: Stream = { kind, controller };
    if (applyEvents && !controller.signal.aborted) {
      if (stream?.kind === "observe") close();
      cancelRetry();
      stream = mine;
      connection = tries > 0 ? "reconnecting" : "connecting";
      soon();
    }
    let heard = false;
    let failure: unknown;
    try {
      for await (const event of events) {
        if (controller.signal.aborted) return;
        if (stream !== mine) {
          if (kind === "command") continue;
          return;
        }
        if (!heard) {
          heard = true;
          connection = "open";
          soon();
        }
        // Only an event that moved the view counts as getting somewhere. A host that replays what
        // the client already holds is not.
        if (take(event)) {
          tries = 0;
          soon();
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      // Port transports use this signal to release listeners even after a natural EOF or error.
      commands.delete(controller);
      controller.abort();
      soon();
    }
    if (stream !== mine) return;
    stream = undefined;
    ended(kind, heard, failure);
  }

  /** A stream ended or failed. Whether that is the end of the story depends on the run, not on the
   * stream: a host may close it at any point, and the end of a stream is not the end of a run. */
  function ended(kind: Stream["kind"], heard: boolean, failure: unknown): void {
    const { transport } = settings;
    if (
      failure instanceof TransportError &&
      failure.outcome === "refused" &&
      failure.error.retryable !== true
    ) {
      lose(failure.error);
      return;
    }
    const early = !initialized || view.run.status === "running" || starting !== undefined;
    // A stream that failed before it said anything may have left the view with nothing. One that
    // said something and then broke, on a run that is not going, left nothing out.
    if (!early && (failure === undefined || heard)) {
      connection = "idle";
      soon();
    } else if (!transport.observe) lose(LOST);
    else if (!attached) {
      connection = "idle";
      soon();
    } else if (kind === "command") openObservation();
    else retryLater(failure);
  }

  function retryLater(failure: unknown): void {
    const {
      attempts = DEFAULT_ATTEMPTS,
      baseDelayMs = DEFAULT_BASE_DELAY_MS,
      maxDelayMs = DEFAULT_MAX_DELAY_MS,
    } = settings.reconnect ?? {};
    if (tries >= attempts) {
      lose(failure instanceof TransportError ? failure.error : LOST);
      return;
    }
    const delay = Math.min(baseDelayMs * 2 ** tries, maxDelayMs);
    tries += 1;
    connection = "reconnecting";
    soon();
    cancelRetry();
    timer = setTimeout(() => {
      timer = undefined;
      if (attached && !stream) openObservation();
    }, delay);
  }

  function lose(error: DisplayError): void {
    cancelRetry();
    connection = "lost";
    problem = { source: "connection", error };
    // Losing observation cannot say an accepted command ended. Keep its send guard and Stop.
    stopping = false;
    soon();
  }

  function openObservation(): void {
    const { transport } = settings;
    if (!transport.observe) return;
    if (problem?.source === "connection") problem = undefined;
    const controller = new AbortController();
    const { cursor } = view;
    // A transport that throws instead of returning a stream fails like a stream that broke.
    async function* events(): AsyncGenerator<ChatEvent> {
      if (transport.observe) yield* transport.observe({ cursor, signal: controller.signal });
    }
    void read(events(), "observe", controller);
  }

  /** After a command the host took, or whose outcome is unknown: the host's word on it arrives on
   * an observation. An approval refreshes the tail so the host can find its new physical segment. */
  function watch(refresh = false): void {
    if (!settings.transport.observe || !attached || stream?.kind === "command") return;
    if (stream && !refresh) return;
    cancelRetry();
    tries = 0;
    openObservation();
  }

  function beginCommand(): AbortController {
    const controller = new AbortController();
    latestCommand = controller;
    commands.add(controller);
    return controller;
  }

  /** The host took a command. Its reply is the stream it returned, or comes on an observation. */
  function accepted(
    before: RunInfo | undefined,
    reply: void | EventReply,
    controller: AbortController,
    refresh = false,
  ): void {
    const current = latestCommand === controller && !controller.signal.aborted;
    if (current) {
      // A host quick enough to report on the run before the call returned already said its word.
      if (view.run === before) starting = view.run;
      if (reply) tries = 0;
    }
    if (reply) void read(reply.events, "command", controller, current);
    else {
      commands.delete(controller);
      if (current) watch(refresh);
    }
  }

  function attach(): () => void {
    attached += 1;
    if (attached === 1 && !stream) {
      tries = 0;
      openObservation();
    }
    let here = true;
    return () => {
      if (!here) return;
      here = false;
      attached -= 1;
      if (attached > 0) return;
      for (const device of deviceRuns.values()) device.controller.abort();
      for (const controller of inputCommands.keys()) controller.abort();
      cancelRetry();
      if (stream?.kind === "observe") close();
      if (!stream && connection !== "lost") connection = "idle";
      soon();
    };
  }

  async function send(input: string | MessageInput): Promise<SendResult> {
    const message: MessageInput = typeof input === "string" ? { text: input } : input;
    const { text = "", attachments = [] } = message;
    // Whitespace alone says nothing, so it is dropped. Any other text goes as typed.
    const body = text.trim() ? text : "";
    if (!body && attachments.length === 0) return { ok: false, error: EMPTY };
    if (isActive(view.run.status) && view.run.id && settings.transport.enqueue)
      return enqueue({
        clientId: createId(),
        text: body,
        ...(attachments.length && { attachments }),
        rootRunId: view.run.id,
      });
    if (!settings.transport.send) return { ok: false, error: CANNOT_SEND };
    if (!canSendOrdinary()) return { ok: false, error: BUSY };
    const clientId = createId();
    take({
      v: PROTOCOL_VERSION,
      type: "message",
      message: {
        id: clientId,
        clientId,
        role: "user",
        parts: [...(body ? [textPart(body)] : []), ...attachments.map(attachmentPart)],
        state: "sending",
        createdAt: Date.now(),
      },
    });
    const entry: Send = {
      input: attachments.length ? { clientId, text: body, attachments } : { clientId, text: body },
      phase: "sending",
    };
    sends.set(clientId, entry);
    return deliver(clientId, entry);
  }

  function checkedInput(value: unknown, id: string, rootRunId: string): DisplayInput {
    const event = parseChatEvent({ v: PROTOCOL_VERSION, type: "input", input: value });
    if (event?.type !== "input" || event.input.id !== id || event.input.rootRunId !== rootRunId)
      throw new Error("The input receipt does not match this send.");
    return event.input;
  }

  async function enqueue(input: EnqueueInput): Promise<SendResult> {
    const submit = settings.transport.enqueue;
    if (!submit || stopping) return { ok: false, error: BUSY };
    const entry: InputSend = { input, phase: "sending" };
    inputSends.set(input.clientId, entry);
    const controller = new AbortController();
    inputCommands.set(controller, input.rootRunId);
    controller.signal.addEventListener(
      "abort",
      () => {
        if (!entry.receipt) entry.phase = "unconfirmed";
        now();
      },
      { once: true },
    );
    now();
    try {
      const receipt = checkedInput(
        await submit(input, { signal: controller.signal }),
        input.clientId,
        input.rootRunId,
      );
      if (receipt.status === "recalled") throw new Error("This send has no enqueue receipt.");
      if (!controller.signal.aborted && view.run.id === input.rootRunId)
        take({ v: PROTOCOL_VERSION, type: "input", input: receipt });
    } catch (error) {
      if (
        !entry.receipt &&
        !controller.signal.aborted &&
        view.run.id === input.rootRunId &&
        error instanceof TransportError &&
        error.outcome === "refused"
      ) {
        inputSends.delete(input.clientId);
        now();
        return { ok: false, error: error.error, input };
      }
    } finally {
      inputCommands.delete(controller);
    }
    if (!entry.receipt) entry.phase = "unconfirmed";
    now();
    if (!controller.signal.aborted && view.run.id === input.rootRunId) watch();
    return { ok: true, messageId: input.clientId, outcome: entry.receipt ? "accepted" : "unknown" };
  }

  async function recallInput(id: string): Promise<CommandResult> {
    const input = getState().inputs.find((item) => item.id === id);
    const recall = settings.transport.recallInput;
    if (!input?.canRecall || !recall || recalls.get(id)?.pending)
      return {
        ok: false,
        error: fixed(
          "cannot_recall",
          "This message cannot be recalled here. Check its delivery before sending more.",
        ),
      };
    const controller = new AbortController();
    inputCommands.set(controller, input.rootRunId);
    const unknown = fixed(
      "recall_unknown",
      "Recall was not confirmed. Check for updates before sending this message again.",
    );
    const current = () => !controller.signal.aborted && view.run.id === input.rootRunId;
    recalls.set(id, { pending: true });
    controller.signal.addEventListener(
      "abort",
      () => {
        recalls.set(id, { pending: false, error: unknown });
        now();
      },
      { once: true },
    );
    now();
    try {
      const receipt = checkedInput(
        await recall({ id, rootRunId: input.rootRunId }, { signal: controller.signal }),
        id,
        input.rootRunId,
      );
      if (!current()) return { ok: false, error: unknown };
      take({ v: PROTOCOL_VERSION, type: "input", input: receipt });
      const recalled = view.inputs.find((item) => item.id === id)?.status === "recalled";
      const error = recalled
        ? undefined
        : fixed("recall_refused", "The agent may already have this message. It was not recalled.");
      recalls.set(id, { pending: false, ...(error && { error }) });
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      const shown = error instanceof TransportError ? error.error : unknown;
      if (current()) recalls.set(id, { pending: false, error: shown });
      return { ok: false, error: shown };
    } finally {
      inputCommands.delete(controller);
      now();
    }
  }

  async function deliver(id: string, entry: Send): Promise<SendResult> {
    const { transport } = settings;
    const before = view.run;
    const controller = beginCommand();
    now();
    let reply: void | EventReply;
    try {
      if (!transport.send) throw new TransportError("refused", CANNOT_SEND);
      reply = await transport.send(entry.input, { signal: controller.signal });
    } catch (error) {
      commands.delete(controller);
      // The host's own copy arrived while the call was out: it has the message, whatever the call
      // says.
      if (sends.get(id) !== entry) return { ok: true, messageId: id, outcome: "accepted" };
      if (error instanceof TransportError && error.outcome === "refused") {
        sends.delete(id);
        view = { ...view, messages: view.messages.filter((message) => message.id !== id) };
        settle();
        now();
        return { ok: false, error: error.error, input: entry.input };
      }
      entry.phase = "unconfirmed";
      now();
      if (latestCommand === controller && !controller.signal.aborted) watch();
      return { ok: true, messageId: id, outcome: "unknown" };
    }
    if (sends.get(id) === entry && !controller.signal.aborted) entry.phase = "accepted";
    accepted(before, reply, controller);
    now();
    const outcome = sends.get(id) === entry && entry.phase !== "accepted" ? "unknown" : "accepted";
    return { ok: true, messageId: id, outcome };
  }

  async function retry(messageId: string): Promise<SendResult> {
    const entry = sends.get(messageId);
    if (!entry || entry.phase !== "unconfirmed") return { ok: false, error: NOTHING_TO_RETRY };
    if (!settings.transport.send) return { ok: false, error: CANNOT_SEND };
    if (!canSendOrdinary()) return { ok: false, error: BUSY };
    entry.phase = "sending";
    return deliver(messageId, entry);
  }

  /** Stop without a host to ask: the run lives in the stream this client reads, so closing it is
   * the stop. What was still going shows as over, the way a host draws a run that ended. */
  function stopHere(): void {
    latestCommand = undefined;
    for (const controller of commands) controller.abort();
    commands.clear();
    for (const send of sends.values()) if (send.phase === "sending") send.phase = "unconfirmed";
    close();
    cancelRetry();
    connection = "idle";
    starting = undefined;
    stopping = false;
    const { run } = view;
    const message = writing(view.messages, run.messageId);
    if (message)
      take({
        v: PROTOCOL_VERSION,
        type: "message",
        message: { ...message, state: "stopped", parts: message.parts.map(seal) },
      });
    take({
      v: PROTOCOL_VERSION,
      type: "run",
      // Before the first run event, the held id may belong to the previous answer.
      run: isActive(run.status) ? { ...run, status: "stopped" } : { status: "stopped" },
    });
    now();
  }

  async function stop(): Promise<CommandResult> {
    for (const device of deviceRuns.values()) device.controller.abort();
    const { transport } = settings;
    const { status, canStop } = getState();
    // Pressed as the run ended, or pressed twice: there is nothing left to stop.
    if (status === "ready" || status === "stopping") return { ok: true };
    // Closing an observation stops nothing on the host, so without `stop` or a stream the run
    // lives in, saying it stopped would be false.
    if (!canStop) return { ok: false, error: CANNOT_STOP };
    if (problem?.source === "stop") problem = undefined;
    if (!transport.stop) {
      stopHere();
      return { ok: true };
    }
    const { run } = view;
    stopping = true;
    now();
    try {
      await transport.stop(run);
    } catch (error) {
      stopping = false;
      const shown = error instanceof TransportError ? error.error : STOP_FAILED;
      // The run may have ended while the call was out, and then there is nothing to report.
      if (isActive(view.run.status) || starting) problem = { source: "stop", error: shown };
      now();
      return { ok: false, error: shown };
    }
    watch();
    return { ok: true };
  }

  const respond: Respond = async (
    idOrAnswers: string | readonly RequestAnswer[],
    response?: RequestResponse,
  ): Promise<RespondResult> => {
    const { transport } = settings;
    if (!transport.respond) return { ok: false, error: CANNOT_ANSWER };
    const batch = parseRequestAnswers(
      typeof idOrAnswers === "string" ? [{ requestId: idOrAnswers, response }] : idOrAnswers,
    );
    if (!batch)
      return {
        ok: false,
        error: { code: "invalid_answer", message: "Send one answer per request." },
      };
    const before = view.run;
    const segment = view.cursor?.segment;
    const entries: [string, Answer][] = [];
    for (const answer of batch) {
      const part = openRequest(view.messages, answer.requestId);
      if (!part) return { ok: false, error: NOT_WAITING };
      const error = checkResponse(part, answer.response);
      if (error) return { ok: false, error };
      if (answers.get(part.id)?.local.status === "submitting")
        return { ok: false, error: ANSWERING };
      entries.push([part.id, { part, local: { status: "submitting", response: answer.response } }]);
    }
    if (batch.length > 1 && batch.some((answer) => answer.response.type === "stop"))
      return { ok: false, error: { code: "invalid_answer", message: "Send Stop on its own." } };
    for (const [id, entry] of entries) answers.set(id, entry);
    const controller = beginCommand();
    const current = () =>
      !controller.signal.aborted &&
      view.cursor?.segment === segment &&
      view.run.id === before.id &&
      entries.some(
        ([id, entry]) => answers.get(id) === entry && openRequest(view.messages, id) === entry.part,
      );
    now();
    let reply: void | EventReply;
    try {
      reply = await transport.respond(batch, { signal: controller.signal });
    } catch (error) {
      commands.delete(controller);
      const refusal = error instanceof TransportError && error.outcome === "refused";
      const shown = refusal ? error.error : UNCONFIRMED_ANSWER;
      if (current())
        for (const [id, entry] of entries) {
          if (answers.get(id) !== entry || openRequest(view.messages, id) !== entry.part) continue;
          answers.set(id, {
            ...entry,
            local: {
              status: refusal ? "failed" : "unconfirmed",
              response: entry.local.response,
              error: shown,
            },
          });
        }
      now();
      if (!refusal && latestCommand === controller && !controller.signal.aborted) watch(true);
      return refusal ? { ok: false, error: shown } : { ok: true, outcome: "unknown" };
    }
    // Observation can close the request or advance its segment before this reply arrives.
    // The latest command still owns its continuation, but not a different logical run.
    // Request feedback already received must not create a new wait for the run to start.
    if (view.run.id === before.id)
      accepted(current() ? before : undefined, reply, controller, true);
    else if (reply) void read(reply.events, "command", controller, false);
    else commands.delete(controller);
    now();
    return { ok: true, outcome: "accepted" };
  };

  async function startClientTool(requestId: string): Promise<RespondResult> {
    const part = openRequest(view.messages, requestId);
    if (!part || part.type !== "client-tool") return { ok: false, error: NOT_WAITING };
    const error = checkResponse(part, { type: "result", value: null });
    if (error) return { ok: false, error };
    const handler =
      part.name && settings.clientTools && Object.hasOwn(settings.clientTools, part.name)
        ? settings.clientTools[part.name]
        : undefined;
    if (
      !handler ||
      !settings.transport.respond ||
      !(
        handler.safety === "read-only" ||
        handler.safety === "repeatable" ||
        (handler.safety === "claimed" && typeof handler.claim === "function")
      )
    )
      return { ok: false, error: CANNOT_ANSWER };
    const held = deviceRuns.get(requestId);
    if (held) {
      const sameSegment = held.segment === view.cursor?.segment;
      if (
        held.part !== part ||
        held.runId !== view.run.id ||
        (!sameSegment && handler.safety !== "claimed")
      )
        return { ok: false, error: NOT_WAITING };
      // Crossing a segment needs a fresh host check, even when a result is retained locally.
      if (sameSegment && held.response) return respond(requestId, held.response);
      if (held.outcome === "running") return { ok: false, error: ANSWERING };
      if (handler.safety !== "claimed") return { ok: true, outcome: "unknown" };
    }
    if (handler.safety === "claimed" && !view.run.id)
      return {
        ok: false,
        error: fixed("claim_scope", "Reload this request before running the action."),
      };
    const controller = new AbortController();
    const segment = view.cursor?.segment;
    const before = view.run;
    const device: DeviceRun = { part, controller, runId: before.id, segment, outcome: "running" };
    deviceRuns.set(requestId, device);
    const mine: Answer = {
      part,
      local: { status: "submitting", response: { type: "result", value: null } },
    };
    answers.set(requestId, mine);
    function unconfirm(): void {
      if (device.outcome === "running") device.outcome = "unknown";
      // Clear only this submission's lock. A segment change invalidates its grant, not the
      // still-pending logical request's ability to be skipped or checked with the host.
      if (
        answers.get(requestId) !== mine ||
        openRequest(view.messages, requestId) !== part ||
        view.run.id !== before.id
      )
        return;
      answers.set(requestId, {
        ...mine,
        local: {
          ...mine.local,
          status: "unconfirmed",
          error: {
            code: "unconfirmed",
            message: "The action may have finished. Check its result before doing it again.",
          },
        },
      });
      now();
    }
    // A handler can ignore abort or never settle. Release its submission lock when this
    // execution scope closes, without assuming its effects stopped or allowing it to run again.
    controller.signal.addEventListener("abort", unconfirm, { once: true });
    now();
    const current = () =>
      !controller.signal.aborted &&
      openRequest(view.messages, requestId) === part &&
      view.run.id === before.id &&
      view.cursor?.segment === segment &&
      !checkResponse(part, { type: "result", value: null });
    try {
      if (handler.safety === "claimed") {
        if (!before.id || !part.name) return { ok: false, error: NOT_WAITING };
        const claim = await handler.claim({
          requestId,
          runId: before.id,
          segment,
          name: part.name,
          input: part.input,
          signal: controller.signal,
        });
        // A successful host claim is not permission to run in a view that closed while it awaited.
        if (!current()) {
          unconfirm();
          return { ok: true, outcome: "unknown" };
        }
        if (claim.status === "denied" || claim.status === "busy") {
          const error = fixed(
            `claim_${claim.status}`,
            claim.status === "denied"
              ? "This action is not permitted. Ask the app owner for access, or skip it."
              : "This action is already claimed. Check for updates before trying again.",
          );
          // No local execution began. A later manual action may check the host again.
          if (!held) deviceRuns.delete(requestId);
          else device.outcome = "unknown";
          answers.set(requestId, { part, local: { ...mine.local, status: "failed", error } });
          now();
          return { ok: false, error };
        }
        if (claim.status === "completed") device.response = { type: "result", value: claim.value };
        else if (claim.status === "granted" && !held) {
          if (typeof claim.complete !== "function")
            throw new TypeError("A claim needs durable completion.");
          const value = await handler.run(part.input, { signal: controller.signal, requestId });
          // Persist even if this view detached during execution. The bound host completion checks
          // its principal/request again. No late result is delivered by this client.
          await claim.complete(value);
          device.response = { type: "result", value };
        }
        // Unknown work, including a surprising second grant, is never dispatched again here.
        device.outcome = device.response ? "result" : "unknown";
      } else {
        const value = await handler.run(part.input, { signal: controller.signal, requestId });
        device.response = { type: "result", value };
        device.outcome = "result";
      }
    } catch {
      // Neither a failed claim nor failed completion proves that nothing happened.
      device.outcome = "unknown";
    }
    if (!current()) {
      unconfirm();
      return { ok: true, outcome: "unknown" };
    }
    if (device.response) {
      if (answers.get(requestId) === mine) answers.delete(requestId);
      return respond(requestId, device.response);
    }
    unconfirm();
    return { ok: true, outcome: "unknown" };
  }

  function reconnect(): void {
    // A command's reply stream is the run itself, and closing it could stop the run.
    if (!settings.transport.observe || !attached || stream?.kind === "command") return;
    close();
    cancelRetry();
    tries = 0;
    openObservation();
    now();
  }

  function setOptions(next: ChatClientOptions): void {
    settings = next;
    now();
  }

  return Object.freeze({
    getState,
    subscribe,
    attach,
    send,
    retry,
    stop,
    respond,
    startClientTool,
    recallInput,
    reconnect,
    setOptions,
  });
}
