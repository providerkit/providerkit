/**
 * The decisions the run band, the composer, the error notice and the request card make, apart from
 * how they draw, so Node can test them: this file imports nothing from React Native.
 */
import type { ChatStatus, DisplayError, RequestResponse, RequestView } from "@providerkit/react";
import type { FormSchema, RequestState, RunInfo, RunStatus } from "@providerkit/react/protocol";

// ---- The run band ----

/** How a run ended, as the band says it. */
export type RunResult = "completed" | "stopped" | "limited" | "failed";

export type BandView =
  | {
      phase: "working" | "waiting";
      /** What the band says: a send on its way, work, a stop on its way, or what the run waits
       * for. */
      label: "sending" | "working" | "stopping" | "approval" | "answer" | "continuation";
      /** `pending` while a stop is on its way. */
      stop: "ready" | "pending" | "none";
    }
  | { phase: "ended"; result: RunResult }
  | { phase: "hidden" };

/** What the band remembers between renders. Start with `{}`. */
export interface BandMemory {
  /** Last busy state. When a send is still naming its run, `from` can be the previous result. */
  from?: RunInfo;
}

export interface BandInput {
  run: RunInfo;
  status: ChatStatus;
  canStop: boolean;
  requests: readonly RequestView[];
}

function isBusy({ run, status }: BandInput): boolean {
  return (
    run.status === "running" ||
    run.status === "waiting" ||
    status === "sending" ||
    status === "running" ||
    status === "stopping"
  );
}

function workView(input: BandInput): BandView {
  const { run, status, canStop } = input;
  if (status === "stopping") return { phase: "working", label: "stopping", stop: "pending" };
  if (run.status !== "waiting")
    return {
      phase: "working",
      label: run.status === "running" || status === "running" ? "working" : "sending",
      stop: canStop ? "ready" : "none",
    };
  if (run.waitingFor === "continuation")
    return { phase: "waiting", label: "continuation", stop: canStop ? "ready" : "none" };
  // Parked on the person: the card's own buttons answer it, so Stop steps aside, unless no request
  // here can be answered, and then Stop is the one way on.
  const answerable = input.requests.filter(
    (request) => request.canRespond !== false && request.part.canAnswer !== false,
  );
  return {
    phase: "waiting",
    label: answerable.some((request) => request.part.type === "approval") ? "approval" : "answer",
    stop: answerable.length === 0 && canStop ? "ready" : "none",
  };
}

/**
 * What the band shows, and the result to announce, once per run. A reply streams with no live
 * region, because a screen reader would read it again on every word, so the band says once that
 * the run ended, and the reply is there to read.
 *
 * A saved result is visible when the screen opens but is not announced. A refused send leaves
 * the previous result in place; that is not another run ending either.
 */
export function bandState(
  input: BandInput,
  memory: BandMemory,
): { view: BandView; memory: BandMemory; announce?: RunResult } {
  const { run } = input;
  if (isBusy(input))
    return { view: workView(input), memory: memory.from === run ? memory : { from: run } };
  const result = resultOf(run.status);
  const before = memory.from;
  const next = before ? {} : memory;
  if (!result) return { view: { phase: "hidden" }, memory: next };
  const sameRun = (run.id ?? run.messageId) === (before?.id ?? before?.messageId);
  const ended =
    before &&
    (sameRun
      ? resultOf(before.status) === undefined
      : resultOf(before.status) !== undefined || before.status === "idle");
  return { view: { phase: "ended", result }, memory: next, announce: ended ? result : undefined };
}

function resultOf(status: RunStatus): RunResult | undefined {
  return status === "completed" ||
    status === "stopped" ||
    status === "limited" ||
    status === "failed"
    ? status
    : undefined;
}

/** A run's own clock, in the shortest shape that still reads as one: `9s`, `1m05s`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

// ---- The composer ----

/** The one button's job. Queue is Send while a run works, for an app whose host takes messages
 * during a run. */
export type ComposerAction = "send" | "queue" | "stop";

/** Why Send is off, said under the box. The text is never cut to fit: a long paste stays whole,
 * and the note says how far over it is. */
export type ComposerNote =
  | { kind: "tooLong"; length: number; limit: number }
  | { kind: "offline" }
  | { kind: "uploading" };

export interface ComposerInput {
  text: string;
  /** Files are attached. */
  hasFiles: boolean;
  /** A file is still uploading. */
  uploading: boolean;
  submitting: boolean;
  /** The composer's own `canSubmit`. */
  canSubmit: boolean;
  status?: ChatStatus;
  /** The run waits for the person: an approval or a question. A message is an answer then. */
  parked?: boolean;
  /** The client's `canSend`: true during a run when its host takes messages while it works. */
  canSend?: boolean;
  canStop?: boolean;
  offline: boolean;
  maxLength?: number;
}

export interface ComposerButton {
  action: ComposerAction;
  enabled: boolean;
  /** On its way: a send, a queued message or a stop. */
  pending: boolean;
  note?: ComposerNote;
}

/**
 * The one button. While a run works, it is Stop while the box is empty and Queue the moment there
 * are words, so the two never share a tap; a host that takes
 * no messages during a run keeps Stop. While the run waits for the person it is Send,
 * because a message answers too. Send and Queue are off while the phone is offline,
 * while a file uploads, and while the text is over `maxLength`. Stop stays on: it is the way out.
 */
export function composerButton(input: ComposerInput): ComposerButton {
  const { text, status = "ready", canStop = false } = input;
  const parked = status === "waiting" && input.parked === true;
  const working =
    !parked &&
    (status === "running" || status === "waiting" || status === "sending" || status === "stopping");
  const filled = text.trim().length > 0 || input.hasFiles;
  let note: ComposerNote | undefined;
  if (input.maxLength !== undefined && text.length > input.maxLength)
    note = { kind: "tooLong", length: text.length, limit: input.maxLength };
  else if (input.offline) note = { kind: "offline" };
  else if (input.uploading) note = { kind: "uploading" };
  const queues = working && input.canSend === true;
  if (status === "stopping") return { action: "stop", enabled: false, pending: true, note };
  if (working && !(queues && filled) && canStop)
    return { action: "stop", enabled: true, pending: false, note };
  const ready = filled && input.canSubmit && !input.submitting && note === undefined;
  return {
    action: queues ? "queue" : "send",
    enabled: ready && input.canSend !== false && (!working || queues),
    pending: input.submitting,
    note,
  };
}

// ---- The error notice ----

/** What an app's error describer says about an error. */
export interface DescribedError {
  /** What happened, in words the person reads. */
  cause?: string;
  /** What to do about it. */
  fix?: string;
  /** The code support asks for. */
  reference?: string;
  /** Which button can help. Retry shows only for `retry` and `wait`. */
  recover?: "retry" | "wait" | "signin" | "none";
}

export interface NoticeView {
  message: string;
  reference?: string;
  /** `off` shows Retry turned off, because the phone is offline. */
  retry: "on" | "off" | "hidden";
}

/** The notice's words and its Retry. Retry shows only when one can work: a retry was offered, and
 * neither the describer (`recover`) nor the host (`retryable: false`) says it cannot. */
export function noticeView(
  error: DisplayError,
  described: DescribedError | undefined,
  canRetry: boolean,
  offline: boolean,
): NoticeView {
  const cause = described?.cause ?? error.message;
  const view: NoticeView = {
    message: described?.fix ? `${cause} ${described.fix}` : cause,
    retry: "hidden",
  };
  if (described?.reference) view.reference = described.reference;
  const works = described?.recover
    ? described.recover === "retry" || described.recover === "wait"
    : error.retryable !== false;
  if (canRetry && works && error.retryable !== false) view.retry = offline ? "off" : "on";
  return view;
}

// ---- The request card ----

/** A request's state as the card shows it: the host's word, or what this client did about it. */
export type RequestDisplay = RequestState | "submitting" | "unconfirmed" | "failed";

/** A switch the host asked for beside Approve, such as Remember. */
export interface ApproveOption {
  name: string;
  label: string;
}

export interface RequestCardView {
  state: RequestDisplay;
  /** This view may answer: the host allows it and the client can send answers. */
  allowed: boolean;
  /** The buttons work right now. */
  enabled: boolean;
  /** False when the request needs a form this card cannot draw. */
  supported: boolean;
  options: readonly ApproveOption[];
  error?: DisplayError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FORM_KEYS = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "title",
  "description",
];
const SWITCH_KEYS = ["type", "title", "description"];

/**
 * The switches an approval form asks for, or null for a form this card cannot fill. Only a flat
 * form of true-or-false fields is drawn, which is how a host offers Remember: an `approveForm` with
 * one boolean field. As on the web, a key this card does not know refuses the whole form instead of
 * disappearing, so nothing the host asked for is dropped on the way back.
 */
export function approveOptions(form: FormSchema | undefined): ApproveOption[] | null {
  if (form === undefined) return [];
  const { properties } = form;
  if (
    form.type !== "object" ||
    !isRecord(properties) ||
    Object.keys(form).some((key) => !FORM_KEYS.includes(key)) ||
    (form.required !== undefined &&
      (!Array.isArray(form.required) ||
        form.required.some(
          (name) => typeof name !== "string" || !Object.hasOwn(properties, name),
        ))) ||
    (form.additionalProperties !== undefined && form.additionalProperties !== false)
  )
    return null;
  const options: ApproveOption[] = [];
  for (const [name, spec] of Object.entries(properties)) {
    if (
      ["__proto__", "prototype", "constructor"].includes(name) ||
      !isRecord(spec) ||
      spec.type !== "boolean" ||
      (spec.title !== undefined && typeof spec.title !== "string") ||
      (spec.description !== undefined && typeof spec.description !== "string") ||
      Object.keys(spec).some((key) => !SWITCH_KEYS.includes(key))
    )
      return null;
    const title = typeof spec.title === "string" ? spec.title : name;
    options.push({ name, label: spec.description ? `${title}. ${spec.description}` : title });
  }
  return options.length > 0 && options.length <= 5 ? options : null;
}

/** The card's state and what it may offer. Answers go to the request id the host sent, so an
 * answer to a request the host has since replaced is turned down there, and this card then shows
 * the newer request. */
export function requestCard(
  request: RequestView,
  now: number,
  canRespond: boolean,
): RequestCardView {
  const { part } = request;
  const expired = part.expiresAt !== undefined && now >= part.expiresAt;
  const state: RequestDisplay =
    part.state !== "pending"
      ? part.state
      : expired
        ? "expired"
        : (request.local?.status ?? "pending");
  const allowed = canRespond && part.canAnswer !== false && request.canRespond !== false;
  let options: ApproveOption[] | null = [];
  let supported = true;
  if (part.type === "approval") {
    options = part.edit || part.denyForm ? null : approveOptions(part.approveForm);
    supported = options !== null;
  } else if (part.type === "question")
    supported = !part.schema && (Boolean(part.choices?.length) || part.freeText !== false);
  else supported = false; // Client actions go through the app's own renderPart.
  const view: RequestCardView = {
    state,
    allowed,
    enabled: allowed && supported && (state === "pending" || state === "failed"),
    supported,
    options: options ?? [],
  };
  const error = request.local?.error ?? part.problem;
  if (error && part.state === "pending" && !expired) view.error = error;
  return view;
}

/** The answer an approval sends. A note on a denial is what the model reads. */
export function approvalAnswer(
  approve: boolean,
  note: string,
  options: readonly ApproveOption[],
  values: Readonly<Record<string, boolean>>,
): RequestResponse {
  if (!approve) return note.trim() ? { type: "deny", message: note.trim() } : { type: "deny" };
  if (options.length === 0) return { type: "approve" };
  const data: Record<string, boolean> = {};
  for (const option of options) data[option.name] = values[option.name] === true;
  return { type: "approve", data };
}

/** The answer a question sends: the picked choices, the typed words, or both. */
export function questionAnswer(choices: readonly string[], text: string): RequestResponse {
  const answer: { choices?: string[]; text?: string } = {};
  if (choices.length) answer.choices = [...choices];
  if (text.trim()) answer.text = text.trim();
  return { type: "answer", answer };
}
