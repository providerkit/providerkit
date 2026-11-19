/**
 * The display protocol: what a host sends so a client can draw one conversation.
 *
 * It is its own small model on purpose. Provider history and agent snapshots hold prompts, tool
 * arguments and tool results, so neither is safe to hand to a browser as it is. A host copies
 * what it wants shown into these types, and nothing else crosses.
 *
 * No React, no dependencies, no DOM: a server, a worker and a React Native app import this file.
 */
import { isRecord } from "./state.ts";

/** Bumped only for a change an older client cannot skip. A new event type or part type needs no
 * bump, because an unknown one is skipped. */
export const PROTOCOL_VERSION = 1;

export type MessageRole = "user" | "assistant";

/** `sending` is the client's own copy, before the host confirmed it. `live` is still being
 * written. The other three are final. */
export type MessageState = "sending" | "live" | "settled" | "failed" | "stopped";

export type ToolState = "running" | "waiting" | "done" | "failed";

export type ApprovalState =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled"
  | "expired"
  | "stale"
  | "invalid"
  | "stopped";
export type RequestState = ApprovalState | "answered";

/** `waiting` means execution is paused for a response or a scheduled continuation. `limited`
 * means a turn, tool, step, time or output limit ended it. */
export type RunStatus =
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "stopped"
  | "limited"
  | "failed";

export const REMOTE_STATUS_UNKNOWN =
  "This remote agent may still be working. Check its status before starting again.";

/** A specialist's row follows its own run, so it uses the run's words. */
export type AgentState = Exclude<RunStatus, "idle"> | "unknown";

// Every part has an `id` that is stable and unique inside its message. Replay, snapshots and
// React keys all match on it, so a host must give the same part the same id every time.

export interface TextPart {
  type: "text";
  id: string;
  text: string;
  /** False while it streams. Once true, a delta no longer adds to it and a patch cannot make it
   * stream again. Only a snapshot can. */
  settled: boolean;
  /** Monotone attempt number from the host's operation journal. Absent means the first. */
  attempt?: number;
  /** Progress is known to be missing. Keep the prefix visible, but do not append deltas.
   * Only an authoritative snapshot or a genuinely new attempt can clear this flag. */
  incomplete?: boolean;
  /** The id of the `agent` part for the specialist that wrote this text, for a host that shows
   * a specialist's words. Absent for the main assistant's own text. */
  agentId?: string;
}

/** The model thought before it answered. By default a host sends only that it thought and for how
 * long, never what it thought: reasoning can quote the instructions, a tool's output or private
 * data. */
export interface ThinkingPart {
  type: "thinking";
  id: string;
  /** False while the model is still thinking. Once true, a delta no longer adds to it. */
  settled: boolean;
  /** When it started thinking, in epoch milliseconds on the host's clock. Absent when the host
   * did not record it. */
  startedAt?: number;
  /** How long it thought, in milliseconds. Present once settled, and only when the host saw both
   * ends. Measured on the host, so a device whose clock is off still shows the right length. */
  durationMs?: number;
  /** What it thought. Present only when the host chose to send it, and then it streams like a
   * text part's text. */
  text?: string;
  /** Monotone attempt number, as on the text part of the same model call. Absent means the
   * first. */
  attempt?: number;
  /** The id of the `agent` part for the specialist that thought. Absent for the main assistant. */
  agentId?: string;
}

/** A file shown in the conversation. Showing it does not make the model read it: how a file
 * reaches the model is the host's decision. */
export interface AttachmentPart {
  type: "attachment";
  id: string;
  name: string;
  mediaType: string;
  /** Bytes. */
  size?: number;
  /** Kept exactly as the host sent it. A renderer checks the scheme before it makes a link or
   * an image out of it. */
  url?: string;
}

/** A source record the host supplies. Text cites it by `marker`, as in `[1]`. */
export interface SourcePart {
  type: "source";
  id: string;
  marker?: string;
  title: string;
  /** Kept exactly as the host sent it. A renderer checks the scheme before it makes a link. */
  url?: string;
  snippet?: string;
}

export interface ToolPart {
  type: "tool";
  id: string;
  /** A workflow step uses the same activity row, but is not a model tool call. */
  kind?: "step";
  /** The program tool operation that admitted this call. Never an agent or permission. */
  parentOperationId?: string;
  /** Monotone operation attempt, independent of the run's model attempt. */
  attempt?: number;
  /** The tool's own name, when the host chooses to show it. Two calls of one tool still differ
   * by `id`. */
  name?: string;
  label: string;
  state: ToolState;
  summary?: string;
  detail?: string;
  /** Host-authored JSON for a custom renderer. Passed through as it is: never validated here,
   * never copied. */
  data?: unknown;
  /** The id of the `agent` part for the specialist that made this call. Absent when the root
   * run made it. */
  agentId?: string;
}

/** One row per specialist run. */
export interface AgentPart {
  type: "agent";
  /** The specialist run, also referenced by its child tool/text parts. */
  id: string;
  /** The registered agent definition, for host-owned label maps. Not execution authority. */
  agentId?: string;
  /** The id of the `agent` part for the specialist that started this one. Absent when the root
   * run started it. */
  parentId?: string;
  label: string;
  state: AgentState;
  kind?: "delegation" | "handoff" | "workflow" | "remote";
  /** Last confirmed peer state. A local stop does not cancel remote work. */
  remoteState?:
    | "unknown"
    | "submitted"
    | "working"
    | "input_required"
    | "auth_required"
    | "completed"
    | "failed"
    | "canceled"
    | "rejected";
  summary?: string;
  /** Present for a workflow specialist instead of a registered agentId. */
  workflowId?: string;
  toolId?: string;
}

/** The registered agent now responsible for this conversation, not an execution route. */
export interface ConversationOwner {
  runId: string;
  agentId: string;
  label: string;
}

export type InputStatus = "queued" | "accepted" | "consumed" | "recalled";

/** Delivery only. Consumed means a model call finished with this input, not that it obeyed it. */
export interface DisplayInput {
  id: string;
  rootRunId: string;
  /** Actual recipient, which can change through handoff. Required after acceptance. */
  runId?: string;
  status: InputStatus;
  /** Only viewer-safe text explicitly supplied by the host or typed on this client. */
  text?: string;
}

/** Request ids are opaque answer keys, never tool operation ids or browser-supplied routes. */
export interface RequestBase {
  id: string;
  toolId?: string;
  agentId?: string;
  title: string;
  summary?: string;
  expiresAt?: number;
  /** False means display-only. Server authorization is still required when true. */
  canAnswer?: boolean;
  problem?: DisplayError;
}

/** Host-approved schema. Built-in controls refuse unsupported requirements. */
export type FormSchema = Readonly<Record<string, unknown>>;

export interface ApprovalPart extends RequestBase {
  type: "approval";
  state: ApprovalState;
  edit?: { schema: FormSchema; value: Record<string, unknown> };
  approveForm?: FormSchema;
  denyForm?: FormSchema;
}

export interface RequestChoice {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionPart extends RequestBase {
  type: "question";
  state: Exclude<RequestState, "approved" | "denied">;
  choices?: readonly RequestChoice[];
  multiple?: boolean;
  freeText?: boolean;
  schema?: FormSchema;
}

/** Merely receiving this part never authorizes a browser action. */
export interface ClientToolPart extends RequestBase {
  type: "client-tool";
  state: Exclude<RequestState, "approved" | "denied">;
  /** Only present when the host authorizes this handler and its input for the viewer. */
  name?: string;
  input?: unknown;
}

export type RequestPart = ApprovalPart | QuestionPart | ClientToolPart;

export function isRequestPart(part: DisplayPart): part is RequestPart {
  return part.type === "approval" || part.type === "question" || part.type === "client-tool";
}

/** A card of the app's own, in reading order. The client draws it with the renderer the app
 * registered for `kind`, and draws nothing for a kind it has no renderer for. */
export interface DataPart {
  type: "data";
  id: string;
  kind: string;
  /** Host-authored JSON. Passed through as it is: never validated here, never copied. */
  data: unknown;
}

export type DisplayPart =
  | TextPart
  | ThinkingPart
  | AttachmentPart
  | SourcePart
  | ToolPart
  | AgentPart
  | RequestPart
  | DataPart;

/** Named apart from core's `ChatMessage`, which is provider history and not something to draw. */
export interface DisplayMessage {
  id: string;
  /** The id the client made when it sent this message. A host that echoes it lets the client
   * swap its own copy for the host's. Set it only on a message a client sent: such a message
   * never streams, so an update replaces it whole. */
  clientId?: string;
  role: MessageRole;
  parts: readonly DisplayPart[];
  state: MessageState;
  /** Epoch milliseconds. */
  createdAt?: number;
}

export interface DisplayError {
  code: string;
  /** Written by the host for the person reading it, so it is safe to show. */
  message: string;
  retryable?: boolean;
}

export interface RunInfo {
  /** The logical run. It stays the same when an approval continues the run in a new segment,
   * and it is never reused for the next run: once a run ended, a client ignores a later
   * `running` under the same id. Leave it out when the host has no such id. */
  id?: string;
  status: RunStatus;
  /** The message this run is writing. */
  messageId?: string;
  owner?: ConversationOwner;
  /** A paused run may need no human answer. No client timer starts or resumes execution. */
  waitingFor?: "response" | "continuation";
  /** Last confirmed peer state when the root itself is remote. */
  remoteState?: AgentPart["remoteState"];
  /** Earliest saved wake time, when the host supplies an authoritative snapshot. */
  wakeAt?: number;
  error?: DisplayError;
}

/** What every event carries besides its own fields. */
export interface ChatEnvelope {
  v: typeof PROTOCOL_VERSION;
  /** The event's position inside `segment`: a whole number, 0 or more, that only goes up. A
   * client drops any number it has already reached and resumes after the last one.
   *
   * Give every numbered event a number of its own. Two events with one number are one event
   * sent twice, and the second is dropped. When one thing on the host becomes several events,
   * number the last and leave the others without. An event without a number always applies, so
   * leave it out only where applying twice is harmless: a settled part, a message, a run. A
   * `text` delta is never that. */
  seq?: number;
  /** One numbering space for `seq`: a host run, or the continuation after an approval. A new
   * segment starts the count again. It means nothing without a `seq`. */
  segment?: string;
}

export type ChatEvent = ChatEnvelope &
  (
    | {
        /** The host's saved truth: replaces the message list and the run. While its run is
         * still going, live output it does not have yet stays on screen, and a message the
         * client is still sending stays until the host has it. Number it when it holds text
         * that also streams, so the deltas it already includes are dropped. */
        type: "snapshot";
        messages: readonly DisplayMessage[];
        run: RunInfo;
        inputs?: readonly DisplayInput[];
      }
    | { type: "input"; input: DisplayInput }
    | {
        /** Adds a message, or updates the one with the same `id` (for an echo, the same
         * `clientId`). An update only adds: parts it does not list stay. It cannot reopen a
         * message that is settled, failed or stopped. Only a snapshot can. */
        type: "message";
        message: DisplayMessage;
      }
    | {
        /** Adds a part to a message the client already holds, or replaces the part with the
         * same `id`. A part that is settled does not go back to live, and a message that is
         * settled, failed or stopped takes only settled parts. */
        type: "part";
        messageId: string;
        part: DisplayPart;
      }
    | {
        /** Appends to a text part that a `part` event already created and has not settled, in a
         * message that has not finished. Also to a thinking part, when that part carries `text`:
         * one that came without words never gains them from a delta. */
        type: "text";
        messageId: string;
        partId: string;
        delta: string;
        /** Must match the current text part. Absent means the first attempt. */
        attempt?: number;
      }
    | {
        /** A run that ended does not start again under the same `id`, except in a snapshot or
         * a new segment. */
        type: "run";
        run: RunInfo;
      }
  );

function isText(value: unknown): value is string {
  return typeof value === "string";
}

/** An empty id cannot be matched or used as a key, so it is refused like a missing one. */
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFlag(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return isTime(value) && value >= 0;
}

function isSeq(value: unknown): value is number {
  return Number.isSafeInteger(value) && isCount(value);
}

/** The table must name every value of `T` and nothing else, or it does not compile. So a value
 * added to a union above cannot be forgotten here, where forgetting it would make the parser
 * refuse events that are valid. */
function oneOf<T extends string>(values: Record<T, true>): (value: unknown) => value is T {
  return (value): value is T => typeof value === "string" && Object.hasOwn(values, value);
}

const isRole = oneOf<MessageRole>({ user: true, assistant: true });
const isMessageState = oneOf<MessageState>({
  sending: true,
  live: true,
  settled: true,
  failed: true,
  stopped: true,
});
const isToolState = oneOf<ToolState>({ running: true, waiting: true, done: true, failed: true });
const isRequestState = oneOf<RequestState>({
  pending: true,
  approved: true,
  denied: true,
  answered: true,
  cancelled: true,
  expired: true,
  stale: true,
  invalid: true,
  stopped: true,
});
function isApprovalState(value: unknown): value is ApprovalState {
  return isRequestState(value) && value !== "answered";
}
function isAttempt(value: unknown): value is number {
  return isSeq(value) && value >= 1;
}
const isRunStatus = oneOf<RunStatus>({
  idle: true,
  running: true,
  waiting: true,
  completed: true,
  stopped: true,
  limited: true,
  failed: true,
});

function isAgentState(value: unknown): value is AgentState {
  return value === "unknown" || (isRunStatus(value) && value !== "idle");
}
const isRemoteState = oneOf<NonNullable<AgentPart["remoteState"]>>({
  unknown: true,
  submitted: true,
  working: true,
  input_required: true,
  auth_required: true,
  completed: true,
  failed: true,
  canceled: true,
  rejected: true,
});

/** Copies one optional field onto `target` when the host sent it. False when it came with the
 * wrong type. `null` counts as absent, because hosts not written in JavaScript serialize a
 * missing field that way. */
function optional<T, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  guard: (value: unknown) => value is NonNullable<T[K]>,
): boolean {
  if (value === undefined || value === null) return true;
  if (!guard(value)) return false;
  target[key] = value;
  return true;
}

// Every reader below builds its result from the fields it knows, one by one. Nothing is spread
// from the input, so a field this version does not know never reaches state.

type Fields = Record<string, unknown>;

function readText(id: string, fields: Fields): TextPart | null {
  if (!isText(fields.text) || !isFlag(fields.settled)) return null;
  const part: TextPart = { type: "text", id, text: fields.text, settled: fields.settled };
  return optional(part, "agentId", fields.agentId, isId) &&
    optional(part, "attempt", fields.attempt, isAttempt) &&
    optional(part, "incomplete", fields.incomplete, isFlag)
    ? part
    : null;
}

function readThinking(id: string, fields: Fields): ThinkingPart | null {
  if (!isFlag(fields.settled)) return null;
  const part: ThinkingPart = { type: "thinking", id, settled: fields.settled };
  return optional(part, "startedAt", fields.startedAt, isTime) &&
    optional(part, "durationMs", fields.durationMs, isCount) &&
    optional(part, "text", fields.text, isText) &&
    optional(part, "attempt", fields.attempt, isAttempt) &&
    optional(part, "agentId", fields.agentId, isId)
    ? part
    : null;
}

function readAttachment(id: string, fields: Fields): AttachmentPart | null {
  if (!isText(fields.name) || !isText(fields.mediaType)) return null;
  const part: AttachmentPart = {
    type: "attachment",
    id,
    name: fields.name,
    mediaType: fields.mediaType,
  };
  return optional(part, "size", fields.size, isCount) && optional(part, "url", fields.url, isText)
    ? part
    : null;
}

function readSource(id: string, fields: Fields): SourcePart | null {
  if (!isText(fields.title)) return null;
  const part: SourcePart = { type: "source", id, title: fields.title };
  return optional(part, "marker", fields.marker, isText) &&
    optional(part, "url", fields.url, isText) &&
    optional(part, "snippet", fields.snippet, isText)
    ? part
    : null;
}

function readTool(id: string, fields: Fields): ToolPart | null {
  if (!isText(fields.label) || !isToolState(fields.state)) return null;
  const part: ToolPart = { type: "tool", id, label: fields.label, state: fields.state };
  // The one field with no shape of its own: whatever JSON the host wrote, `null` included.
  if (fields.data !== undefined) part.data = fields.data;
  if (
    fields.parentOperationId === id ||
    (fields.kind === "step" && fields.parentOperationId != null)
  )
    return null;
  return optional(part, "kind", fields.kind, oneOf({ step: true })) &&
    optional(part, "parentOperationId", fields.parentOperationId, isId) &&
    optional(part, "attempt", fields.attempt, isAttempt) &&
    optional(part, "name", fields.name, isText) &&
    optional(part, "summary", fields.summary, isText) &&
    optional(part, "detail", fields.detail, isText) &&
    optional(part, "agentId", fields.agentId, isId)
    ? part
    : null;
}

function readAgent(id: string, fields: Fields): AgentPart | null {
  if (!isText(fields.label) || !isAgentState(fields.state)) return null;
  const part: AgentPart = { type: "agent", id, label: fields.label, state: fields.state };
  if (fields.kind === "workflow" && (fields.agentId != null || !isId(fields.workflowId)))
    return null;
  if (fields.workflowId != null && fields.kind !== "workflow") return null;
  if ((fields.remoteState != null || fields.state === "unknown") && fields.kind !== "remote")
    return null;
  if (fields.kind === "remote" && !isId(fields.agentId)) return null;
  return optional(part, "parentId", fields.parentId, isId) &&
    optional(part, "remoteState", fields.remoteState, isRemoteState) &&
    optional(part, "summary", fields.summary, isText) &&
    optional(part, "agentId", fields.agentId, isId) &&
    optional(part, "workflowId", fields.workflowId, isId) &&
    optional(part, "toolId", fields.toolId, isId) &&
    optional(
      part,
      "kind",
      fields.kind,
      oneOf({ delegation: true, handoff: true, workflow: true, remote: true }),
    )
    ? part
    : null;
}

function requestFields<T extends RequestPart>(part: T, fields: Fields): T | null {
  if (fields.problem != null) {
    const problem = readError(fields.problem);
    if (!problem) return null;
    part.problem = problem;
  }
  return optional(part, "summary", fields.summary, isText) &&
    optional(part, "toolId", fields.toolId, isId) &&
    optional(part, "agentId", fields.agentId, isId) &&
    optional(part, "canAnswer", fields.canAnswer, isFlag) &&
    optional(part, "expiresAt", fields.expiresAt, isTime)
    ? part
    : null;
}

function readApproval(id: string, fields: Fields): ApprovalPart | null {
  if (!isText(fields.title) || !isApprovalState(fields.state)) return null;
  const part: ApprovalPart = { type: "approval", id, title: fields.title, state: fields.state };
  if (fields.edit != null) {
    if (!isRecord(fields.edit) || !isRecord(fields.edit.schema) || !isRecord(fields.edit.value))
      return null;
    part.edit = { schema: fields.edit.schema, value: fields.edit.value };
  }
  return optional(part, "approveForm", fields.approveForm, isRecord) &&
    optional(part, "denyForm", fields.denyForm, isRecord)
    ? requestFields(part, fields)
    : null;
}

function readQuestion(id: string, fields: Fields): QuestionPart | null {
  if (
    !isText(fields.title) ||
    !isRequestState(fields.state) ||
    fields.state === "approved" ||
    fields.state === "denied"
  )
    return null;
  const part: QuestionPart = { type: "question", id, title: fields.title, state: fields.state };
  if (fields.choices != null) {
    if (!Array.isArray(fields.choices) || fields.choices.length > 100) return null;
    const choices: RequestChoice[] = [];
    const ids = new Set<string>();
    for (const value of fields.choices) {
      if (!isRecord(value) || !isId(value.id) || !isText(value.label) || ids.has(value.id))
        return null;
      const choice: RequestChoice = { id: value.id, label: value.label };
      if (!optional(choice, "description", value.description, isText)) return null;
      choices.push(choice);
      ids.add(choice.id);
    }
    part.choices = choices;
  }
  return optional(part, "multiple", fields.multiple, isFlag) &&
    optional(part, "freeText", fields.freeText, isFlag) &&
    optional(part, "schema", fields.schema, isRecord)
    ? requestFields(part, fields)
    : null;
}

function readClientTool(id: string, fields: Fields): ClientToolPart | null {
  if (
    !isText(fields.title) ||
    !isRequestState(fields.state) ||
    fields.state === "approved" ||
    fields.state === "denied"
  )
    return null;
  const part: ClientToolPart = {
    type: "client-tool",
    id,
    title: fields.title,
    state: fields.state,
  };
  if (fields.input !== undefined) part.input = fields.input;
  return optional(part, "name", fields.name, isId) ? requestFields(part, fields) : null;
}

/** `kind` picks the app's renderer, so it is an id. `data` has no shape of its own, like a
 * tool's: whatever JSON the host wrote, or nothing. */
function readData(id: string, fields: Fields): DataPart | null {
  return isId(fields.kind) ? { type: "data", id, kind: fields.kind, data: fields.data } : null;
}

/** A part, `null` for a malformed one, or `undefined` for a type this version does not know. */
function readPart(value: unknown): DisplayPart | null | undefined {
  if (!isRecord(value) || !isText(value.type)) return null;
  const known = (reader: (id: string, fields: Fields) => DisplayPart | null) =>
    isId(value.id) ? reader(value.id, value) : null;
  switch (value.type) {
    case "text":
      return known(readText);
    case "thinking":
      return known(readThinking);
    case "attachment":
      return known(readAttachment);
    case "source":
      return known(readSource);
    case "tool":
      return known(readTool);
    case "agent":
      return known(readAgent);
    case "approval":
      return known(readApproval);
    case "question":
      return known(readQuestion);
    case "client-tool":
      return known(readClientTool);
    case "data":
      return known(readData);
    default:
      return undefined;
  }
}

function readParts(value: unknown): DisplayPart[] | null {
  if (!Array.isArray(value)) return null;
  const parts: DisplayPart[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const part = readPart(item);
    if (part === null) return null;
    // A part type from a newer host: leave it out and keep the rest of the message, so one new
    // kind of part does not blank a whole conversation on an older client.
    if (part === undefined) continue;
    if (ids.has(part.id)) return null;
    ids.add(part.id);
    parts.push(part);
  }
  return parts;
}

function readMessage(value: unknown): DisplayMessage | null {
  if (!isRecord(value) || !isId(value.id) || !isRole(value.role) || !isMessageState(value.state))
    return null;
  const parts = readParts(value.parts);
  if (!parts) return null;
  const message: DisplayMessage = { id: value.id, role: value.role, parts, state: value.state };
  return optional(message, "clientId", value.clientId, isId) &&
    optional(message, "createdAt", value.createdAt, isTime)
    ? message
    : null;
}

function readMessages(value: unknown): DisplayMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: DisplayMessage[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const message = readMessage(item);
    if (!message || ids.has(message.id)) return null;
    ids.add(message.id);
    messages.push(message);
  }
  return messages;
}

function readError(value: unknown): DisplayError | null {
  if (!isRecord(value) || !isId(value.code) || !isText(value.message)) return null;
  const error: DisplayError = { code: value.code, message: value.message };
  return optional(error, "retryable", value.retryable, isFlag) ? error : null;
}

function readInput(value: unknown): DisplayInput | null {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.rootRunId) ||
    !oneOf<InputStatus>({ queued: true, accepted: true, consumed: true, recalled: true })(
      value.status,
    )
  )
    return null;
  if ((value.status === "accepted" || value.status === "consumed") && !isId(value.runId))
    return null;
  const input: DisplayInput = { id: value.id, rootRunId: value.rootRunId, status: value.status };
  return optional(input, "runId", value.runId, isId) && optional(input, "text", value.text, isText)
    ? input
    : null;
}

function readRun(value: unknown): RunInfo | null {
  if (!isRecord(value) || !isRunStatus(value.status)) return null;
  const run: RunInfo = { status: value.status };
  if (
    !optional(run, "id", value.id, isId) ||
    !optional(run, "messageId", value.messageId, isId) ||
    !optional(run, "waitingFor", value.waitingFor, oneOf({ response: true, continuation: true })) ||
    !optional(run, "wakeAt", value.wakeAt, isTime) ||
    !optional(run, "remoteState", value.remoteState, isRemoteState)
  )
    return null;
  if (value.owner != null) {
    const owner = value.owner;
    if (!isRecord(owner) || !isId(owner.runId) || !isId(owner.agentId) || !isText(owner.label))
      return null;
    run.owner = { runId: owner.runId, agentId: owner.agentId, label: owner.label };
  }
  if (value.error !== undefined && value.error !== null) {
    const error = readError(value.error);
    if (!error) return null;
    run.error = error;
  }
  return run;
}

/**
 * Checks one value from the wire and returns the event it describes, or `null`.
 *
 * `null` covers three cases, and all three mean "apply nothing": another protocol version, a
 * known event that is malformed, and an event type this version does not know. The last is
 * skipped and not an error, so an older client keeps working against a newer host.
 */
export function parseChatEvent(value: unknown): ChatEvent | null {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION) return null;
  const envelope: ChatEnvelope = { v: PROTOCOL_VERSION };
  if (
    !optional(envelope, "seq", value.seq, isSeq) ||
    !optional(envelope, "segment", value.segment, isId)
  )
    return null;
  switch (value.type) {
    case "snapshot": {
      const messages = readMessages(value.messages);
      const run = readRun(value.run);
      if (!messages || !run) return null;
      if (value.inputs == null) return { ...envelope, type: "snapshot", messages, run };
      if (!Array.isArray(value.inputs)) return null;
      const inputs: DisplayInput[] = [];
      for (const raw of value.inputs) {
        const input = readInput(raw);
        if (
          !input ||
          inputs.some((held) => held.id === input.id && held.rootRunId === input.rootRunId)
        )
          return null;
        inputs.push(input);
      }
      return { ...envelope, type: "snapshot", messages, run, inputs };
    }
    case "input": {
      const input = readInput(value.input);
      return input ? { ...envelope, type: "input", input } : null;
    }
    case "message": {
      const message = readMessage(value.message);
      return message ? { ...envelope, type: "message", message } : null;
    }
    case "part": {
      const { messageId } = value;
      // An unknown part type comes back undefined and is skipped with its event.
      const part = readPart(value.part);
      return isId(messageId) && part ? { ...envelope, type: "part", messageId, part } : null;
    }
    case "text": {
      const { messageId, partId, delta } = value;
      if (!isId(messageId) || !isId(partId) || !isText(delta)) return null;
      const event: Extract<ChatEvent, { type: "text" }> = {
        ...envelope,
        type: "text",
        messageId,
        partId,
        delta,
      };
      return optional(event, "attempt", value.attempt, isAttempt) ? event : null;
    }
    case "run": {
      const run = readRun(value.run);
      return run ? { ...envelope, type: "run", run } : null;
    }
    default:
      return null;
  }
}

export { checkResponse, parseRequestAnswers } from "./requests.ts";
export type { QuestionAnswer, RequestResponse, RequestAnswer } from "./requests.ts";
export { emptyChatView, reduceChat } from "./state.ts";
export type { ChatView, Cursor } from "./state.ts";
