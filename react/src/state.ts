/**
 * The reducer: one conversation view, moved forward one event at a time.
 *
 * Two kinds of host feed it. One streams patches and can replay them from a cursor. The other
 * can only send its saved transcript again, as snapshots. Both go through this one function, and
 * the six rules below are what keep a replay, a reconnect or a stale read from duplicating text,
 * reviving a finished run or re-rendering messages that did not move.
 *
 * Pure: it never changes its input, and it returns the same object when nothing changed.
 */
import {
  isRequestPart,
  type ChatEvent,
  type DisplayMessage,
  type DisplayPart,
  type DisplayInput,
  type RunInfo,
  type RunStatus,
} from "./protocol.ts";

/** Where a client stands in the host's event log. Hand it back to resume after it. */
export interface Cursor {
  /** The numbering space `seq` counts in. */
  segment?: string;
  /** The last sequence number this view took in. */
  seq: number;
}

export interface ChatView {
  messages: readonly DisplayMessage[];
  run: RunInfo;
  inputs: readonly DisplayInput[];
  /** Absent until an event with a `seq` was taken in. */
  cursor?: Cursor;
}

export function emptyChatView(): ChatView {
  return { messages: [], run: { status: "idle" }, inputs: [] };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Equality for plain JSON-shaped values. A missing key equals an undefined one. */
function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((item, index) => sameData(item, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
    if (!sameData(left[key], right[key])) return false;
  return true;
}

/** Rule 6. Equal content keeps the object the view already holds, so a component that takes it
 * as a prop does not render again. A host that polls sends the whole transcript every time, and
 * without this every message would be new on every poll.
 *
 * ponytail: this reads every field of what it compares, so a snapshot costs about what parsing
 * it did. That holds for transcripts a poll can carry. If one outgrows it, have the host stamp
 * each message with a revision and compare that instead. */
function keep<T>(held: T, next: T): T {
  return sameData(held, next) ? held : next;
}

export function keepList<T>(held: readonly T[], next: readonly T[]): readonly T[] {
  return held.length === next.length && next.every((item, index) => item === held[index])
    ? held
    : next;
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const next = [...items];
  next[index] = item;
  return next;
}

/** From the end, because the message and the part being written are the newest ones. */
function indexOfId(items: readonly { id: string }[], id: string): number {
  for (let index = items.length - 1; index >= 0; index--) if (items[index]?.id === id) return index;
  return -1;
}

export function isActive(status: RunStatus): boolean {
  return status === "running" || status === "waiting";
}

/** `idle` is no run at all, so it is neither active nor over. */
function isOver(status: RunStatus): boolean {
  return status !== "idle" && !isActive(status);
}

export function isFinal(message: DisplayMessage): boolean {
  return message.state !== "sending" && message.state !== "live";
}

/** Whether a part can still change through patches. Each kind says it in its own field; an
 * attachment and a source have no live phase at all. */
function isSettled(part: DisplayPart): boolean {
  switch (part.type) {
    case "text":
      return part.settled;
    case "tool":
      return part.state !== "running" && part.state !== "waiting";
    case "agent":
      return !isActive(part.state);
    case "approval":
    case "question":
    case "client-tool":
      return part.state !== "pending";
    default:
      return true;
  }
}

/** Rule 2 for parts, shared by the `part` and `message` patches. A settled part is the host's
 * final word on it, so a live copy with the same id is older and is dropped. A settled copy
 * still replaces a settled one: the host can correct what it sealed.
 *
 * ponytail: one scan of the held parts per part, so a `message` update that lists every part
 * is quadratic in them. A turn has tens of parts. Index them by id here if that changes. */
function upsertPart(parts: readonly DisplayPart[], part: DisplayPart): readonly DisplayPart[] {
  const index = indexOfId(parts, part.id);
  const held = parts[index];
  if (!held) return [...parts, part];
  if (held.type === "text" && part.type === "text") {
    if ((part.attempt ?? 1) < (held.attempt ?? 1)) return parts;
    if ((part.attempt ?? 1) > (held.attempt ?? 1)) return replaceAt(parts, index, part);
    if (held.incomplete && !part.incomplete) return parts;
  }
  if (
    held.type === "tool" &&
    part.type === "tool" &&
    held.kind === "step" &&
    part.kind === "step"
  ) {
    if ((part.attempt ?? 1) < (held.attempt ?? 1)) return parts;
    if ((part.attempt ?? 1) > (held.attempt ?? 1)) return replaceAt(parts, index, part);
  }
  if (isSettled(held) && !isSettled(part)) return parts;
  return sameData(held, part) ? parts : replaceAt(parts, index, part);
}

/** Rule 3's middle case. The snapshot was taken mid-stream and this view already received more
 * of the same text. A text that does not continue the snapshot's is not ahead, it is wrong, and
 * the snapshot wins. So does a snapshot that settled the part: that text is complete. "Longer"
 * needs no check of its own: a text that starts with another is at least as long, and at the
 * same length the two are the same text. */
function isAhead(held: DisplayPart, incoming: DisplayPart): boolean {
  if (
    held.type === "tool" &&
    incoming.type === "tool" &&
    held.kind === "step" &&
    incoming.kind === "step"
  )
    return (
      (held.attempt ?? 1) > (incoming.attempt ?? 1) ||
      ((held.attempt ?? 1) === (incoming.attempt ?? 1) && isSettled(held) && !isSettled(incoming))
    );
  if (held.type === "agent" && incoming.type === "agent")
    return isSettled(held) && !isSettled(incoming);
  return (
    held.type === "text" &&
    incoming.type === "text" &&
    !held.settled &&
    !incoming.settled &&
    (held.attempt ?? 1) === (incoming.attempt ?? 1) &&
    held.text.startsWith(incoming.text)
  );
}

/** One message as the host has it, laid over the copy the view holds. With `keepLive`, live
 * output the host's copy does not have yet stays. Without it the host's copy wins outright. */
function reconcile(
  held: DisplayMessage,
  incoming: DisplayMessage,
  keepLive: boolean,
): DisplayMessage {
  const local = new Map(held.parts.map((part) => [part.id, part]));
  const parts = incoming.parts.map((part) => {
    const mine = local.get(part.id);
    if (!mine) return part;
    if (
      mine.type === "text" &&
      part.type === "text" &&
      part.incomplete &&
      (mine.attempt ?? 1) === (part.attempt ?? 1) &&
      mine.text.startsWith(part.text)
    )
      return keep(mine, { ...part, text: mine.text });
    return keepLive && isAhead(mine, part) ? mine : keep(mine, part);
  });
  if (keepLive) {
    const known = new Set(incoming.parts.map((part) => part.id));
    // Requests are authoritative records, not streamed text the save might lack.
    for (const mine of held.parts)
      if (!isSettled(mine) && !isRequestPart(mine) && !known.has(mine.id)) parts.push(mine);
  }
  return keep(held, { ...incoming, parts: keepList(held.parts, parts) });
}

/** Rule 3. The snapshot is the host's saved truth, so it replaces the list. But a host saves
 * less often than it streams, and a snapshot read while the run is still going is behind the
 * stream. Dropping what it lacks would make text vanish and come back. Once the run is over
 * there is nothing left to be behind on, and whatever the snapshot lacks is not real.
 *
 * A message the client is still sending is not output the host is behind on: it is a send the
 * host may not have received yet, read by a poll that started first or by the first read after
 * a send whose outcome is unknown. So it stays, whatever the run is doing, until the host's copy
 * arrives with its id or its `clientId`. */
function applySnapshot(
  view: ChatView,
  incoming: readonly DisplayMessage[],
  run: RunInfo,
): Pick<ChatView, "messages" | "run"> {
  const keepLive = isActive(run.status);
  const local = new Map(view.messages.map((message) => [message.id, message]));
  const messages = incoming.map((message) => {
    const held = local.get(message.id);
    return held ? reconcile(held, message, keepLive) : message;
  });
  const ids = new Set(incoming.map((message) => message.id));
  const echoes = new Set(
    incoming.flatMap(({ clientId }) => (clientId === undefined ? [] : [clientId])),
  );
  for (const held of view.messages) {
    if (ids.has(held.id)) continue;
    const unsent =
      held.state === "sending" && (held.clientId === undefined || !echoes.has(held.clientId));
    if (unsent || (keepLive && held.state === "live")) messages.push(held);
  }
  return { messages: keepList(view.messages, messages), run: keep(view.run, run) };
}

function applyMessage(
  messages: readonly DisplayMessage[],
  incoming: DisplayMessage,
): readonly DisplayMessage[] {
  let index = indexOfId(messages, incoming.id);
  // Rule 5. The host gives a sent message its own id and echoes the id the client made, which
  // is the only thing the two copies share.
  if (index < 0 && incoming.clientId !== undefined)
    index = messages.findIndex((message) => message.clientId === incoming.clientId);
  const held = messages[index];
  if (!held) return [...messages, incoming];
  // Rule 2. A patch that would reopen a finished message is older than what the view holds, so
  // all of it is dropped: adding its parts would put live output in a finished message.
  if (isFinal(held) && !isFinal(incoming)) return messages;
  // A message the client sent (it is still sending, or it carries the id the client gave it)
  // never streams, and the copy the client drew has part ids the host never saw. Merging the
  // host's parts into it would show the text twice, so the host's copy replaces it whole.
  const sent = held.state === "sending" || held.clientId !== undefined;
  // Anything else is an update to a message the host is writing. Patches only add: a part the
  // update does not list stays, because the same event replayed from the start of a stream
  // lists none, and replacing would blank the text until the replay caught up.
  const next = sent
    ? reconcile(held, incoming, false)
    : keep(held, {
        ...held,
        ...incoming,
        parts: incoming.parts.reduce(upsertPart, held.parts),
      });
  return next === held ? messages : replaceAt(messages, index, next);
}

/** A part for a message the view does not hold is dropped: there is no role or state to draw
 * it under. The host sends the message first.
 *
 * Rule 2 for messages, as `applyMessage` has it: live output aimed at a finished message is
 * older than the message's end. Let in, a replayed request would wait for a decision nobody can
 * make. A settled part still lands, so a host can seal, expire and correct after the end. */
function applyPart(
  messages: readonly DisplayMessage[],
  messageId: string,
  part: DisplayPart,
): readonly DisplayMessage[] {
  const index = indexOfId(messages, messageId);
  const message = messages[index];
  if (!message || (isFinal(message) && !isSettled(part))) return messages;
  const parts = upsertPart(message.parts, part);
  return parts === message.parts ? messages : replaceAt(messages, index, { ...message, parts });
}

/** Rule 2 for deltas: nothing streams into a settled part or a finished message. A delta also
 * never creates its part: a client that joined mid-stream would show the tail of a sentence
 * with no head. The part arrives whole when the host seals it. */
function applyText(
  messages: readonly DisplayMessage[],
  messageId: string,
  partId: string,
  delta: string,
  attempt = 1,
): readonly DisplayMessage[] {
  const index = indexOfId(messages, messageId);
  const message = messages[index];
  if (!message || !delta || isFinal(message)) return messages;
  const at = indexOfId(message.parts, partId);
  const part = message.parts[at];
  if (
    !part ||
    part.type !== "text" ||
    part.settled ||
    part.incomplete ||
    (part.attempt ?? 1) !== attempt
  )
    return messages;
  const parts = replaceAt(message.parts, at, { ...part, text: part.text + delta });
  return replaceAt(messages, index, { ...message, parts });
}

/** Rule 4. A run that ended does not start again because an old event showed up late. The
 * contract names `running`; `waiting` is held to the same rule, or a replayed approval would
 * reopen the run and let every event after it through. Without a run id there is nothing to
 * say it is the same run, so a host that sends none is never blocked. */
function applyRun(held: RunInfo, incoming: RunInfo, continued: boolean): RunInfo {
  const late =
    !continued &&
    isOver(held.status) &&
    isActive(incoming.status) &&
    held.id !== undefined &&
    held.id === incoming.id;
  return late ? held : keep(held, incoming);
}

function applyEvent(
  view: ChatView,
  event: ChatEvent,
  continued: boolean,
): Pick<ChatView, "messages" | "run"> {
  const { messages, run } = view;
  switch (event.type) {
    case "snapshot":
      return applySnapshot(view, event.messages, event.run);
    case "message":
      return { messages: applyMessage(messages, event.message), run };
    case "part":
      return { messages: applyPart(messages, event.messageId, event.part), run };
    case "text":
      return {
        messages: applyText(messages, event.messageId, event.partId, event.delta, event.attempt),
        run,
      };
    case "input":
      return { messages, run };
    case "run":
      return { messages, run: applyRun(run, event.run, continued) };
  }
}

/**
 * Applies one event and returns the next view. The rules:
 *
 * 1. Same segment and a `seq` not above the cursor: a duplicate, ignored. Another segment
 *    resets the cursor. An event without `seq` always applies and leaves the cursor alone.
 * 2. A `text` delta never changes a settled part. A `part` or `message` patch never turns
 *    settled back into live, and nothing live lands in a finished message. Only a snapshot can
 *    do either.
 * 3. A snapshot replaces the message list. While its run is running or waiting, live output it
 *    does not have yet stays: unsettled parts whose ids it lacks, an unsettled text that is
 *    longer and starts with the snapshot's text, and a live message whose id it lacks. Once its
 *    run is over, no live output is kept. A message the client is still sending is not output:
 *    it stays until the host's copy arrives, whatever the run is doing.
 * 4. A finished run stays finished: a later `running` for the same run id is ignored unless it
 *    comes in a snapshot or a new segment (an approval continuing).
 * 5. `message` matches by `id`, then by `clientId`, so a host echo replaces the client's copy.
 * 6. Messages that did not change keep their object identity.
 *
 * An event that changes nothing but is new still moves the cursor, so the result is a new view
 * whose `messages` and `run` are the old objects. Compare those two to know if anything a
 * person sees has moved.
 */
/** An old queued view cannot undo acceptance or prove that recall is safe. */
function upsertInput(
  inputs: readonly DisplayInput[],
  incoming: DisplayInput,
): readonly DisplayInput[] {
  const index = inputs.findIndex(
    (item) => item.id === incoming.id && item.rootRunId === incoming.rootRunId,
  );
  const held = inputs[index];
  if (!held) return [...inputs, incoming];
  if (
    (held.runId && incoming.runId && held.runId !== incoming.runId) ||
    (held.status === "recalled" &&
      incoming.status !== "recalled" &&
      incoming.status !== "queued") ||
    (incoming.status === "recalled" && held.status !== "recalled" && held.status !== "queued")
  )
    return inputs;
  const status =
    held.status === "consumed" ||
    held.status === "recalled" ||
    (held.status === "accepted" && incoming.status !== "consumed")
      ? held.status
      : incoming.status;
  // Live SDK receipts omit text. A compatible snapshot can fill it in without undoing delivery.
  const runId = held.runId ?? incoming.runId;
  const text = incoming.text ?? held.text;
  const next = keep(held, {
    id: held.id,
    rootRunId: held.rootRunId,
    status,
    ...(runId !== undefined && { runId }),
    ...(text !== undefined && { text }),
  });
  return next === held ? inputs : replaceAt(inputs, index, next);
}

export function reduceChat(view: ChatView, event: ChatEvent): ChatView {
  const { cursor } = view;
  const { seq, segment } = event;
  const sameSegment = cursor !== undefined && cursor.segment === segment;
  if (seq !== undefined && sameSegment && seq <= cursor.seq) return view;
  // "A new segment" for rule 4 is this event leaving the segment the cursor was in. With no
  // cursor there is no segment to leave, so the first numbered event a view sees never counts:
  // it is usually the start of a replay, and its `running` is as old as the rest of it.
  const continued = seq !== undefined && cursor !== undefined && !sameSegment;
  const { messages, run } = applyEvent(view, event, continued);
  let inputs =
    run.id === view.run.id
      ? view.inputs
      : view.inputs.filter((input) => input.rootRunId === run.id);
  const incoming =
    event.type === "snapshot" ? (event.inputs ?? []) : event.type === "input" ? [event.input] : [];
  for (const input of incoming) if (input.rootRunId === run.id) inputs = upsertInput(inputs, input);
  inputs = keepList(view.inputs, inputs);
  const next = seq === undefined ? cursor : segment === undefined ? { seq } : { segment, seq };
  if (messages === view.messages && run === view.run && inputs === view.inputs && next === cursor)
    return view;
  return next ? { messages, run, inputs, cursor: next } : { messages, run, inputs };
}
