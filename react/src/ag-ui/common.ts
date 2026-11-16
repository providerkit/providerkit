import { parseChatEvent, type ChatEvent, type DisplayPart } from "../protocol.ts";
import { isRecord, type ChatView } from "../state.ts";
import type { AgUiBinding, AgUiEvent, AgUiInterrupt, AgUiIssue, AgUiOptions } from "./types.ts";

export const DISPLAY_EVENT = "providerkit.display.v1";
export const ANSWER_PAYLOAD = "providerkit.answer.v1";
export const NAMESPACE = "providerkit";
export const DEFAULT_CHARS = 1_048_576;
export const DEFAULT_ITEMS = 2_048;

export const issue = (code: AgUiIssue["code"], message: string): AgUiIssue => ({ code, message });
export const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const text = (value: unknown): value is string => typeof value === "string";
const optional = (value: unknown, guard: (value: unknown) => boolean) =>
  value === undefined || guard(value);
const ids = (value: unknown) => Array.isArray(value) && value.every(id);

/** Generated wire ids are opaque tuples, never parsed as ancestry or execution authority. */
export const wireId = (...parts: string[]): string => JSON.stringify(["providerkit", ...parts]);

const privateKeys =
  /^(?:__proto__|prototype|constructor|claim.*|capability|capabilities|complete|.*token|tokens|apiKey|authorization|credentials|scope|scopes|actor|resource|snapshot)$/i;

/** JSON only, no getters/toJSON, prototypes, cycles or unbounded nesting. A character budget
 * bounds retained payloads as well as frames; JSON.stringify is safe only after this check. */
export function jsonSafe(value: unknown, maxChars = DEFAULT_CHARS, privateFields = false): boolean {
  let budget = maxChars;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (--budget < 0 || depth > 32) return false;
    if (item === null || item === undefined || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return (budget -= item.length) >= 0;
    if (typeof item !== "object" || ancestors.has(item)) return false;
    const proto: unknown = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return false;
    if (Object.getOwnPropertySymbols(item).length) return false;
    if (Array.isArray(item) && (item.length > budget || Object.keys(item).length !== item.length))
      return false;
    if (
      privateFields &&
      Object.hasOwn(item, "format") &&
      ["turns", "context", "delegations"].some((key) => Object.hasOwn(item, key))
    )
      return false;
    ancestors.add(item);
    for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === "length") continue;
      budget -= key.length;
      if (
        budget < 0 ||
        !("value" in field) ||
        (privateFields && privateKeys.test(key)) ||
        !visit(field.value, depth + 1)
      )
        return false;
    }
    ancestors.delete(item);
    return true;
  };
  return visit(value, 0);
}

export function copyJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function checkOptions(options: AgUiOptions): void {
  if (
    Object.keys(options.binding).some(
      (key) => !["threadId", "runId", "segment", "agUiRunId"].includes(key),
    ) ||
    !Object.values(options.binding).every(id) ||
    !id(options.binding.threadId) ||
    !id(options.binding.runId) ||
    !id(options.binding.segment) ||
    !id(options.binding.agUiRunId)
  )
    throw new TypeError("Supply the thread, logical run, segment and AG-UI run ids.");
  for (const limit of [options.limits?.maxItems, options.limits?.maxChars])
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new TypeError("AG-UI limits must be positive whole numbers.");
}

export function sameBinding(value: unknown, binding: AgUiBinding): boolean {
  return (
    isRecord(value) &&
    value.threadId === binding.threadId &&
    value.runId === binding.runId &&
    value.segment === binding.segment &&
    value.agUiRunId === binding.agUiRunId
  );
}

export function step(
  part: DisplayPart,
): { name: string; state: "started" | "finished" } | undefined {
  if (
    part.type !== "data" ||
    part.kind !== "ag-ui.step" ||
    !isRecord(part.data) ||
    typeof part.data.name !== "string" ||
    !part.data.name ||
    (part.data.state !== "started" && part.data.state !== "finished") ||
    Object.keys(part.data).some((key) => key !== "name" && key !== "state")
  )
    return undefined;
  return { name: part.data.name, state: part.data.state };
}

function opaque(part: DisplayPart): unknown[] {
  switch (part.type) {
    case "data":
      return [part.data];
    case "tool":
      return [part.data];
    case "client-tool":
      return [part.input];
    case "approval":
      return [part.edit, part.approveForm, part.denyForm];
    case "question":
      return [part.schema];
    default:
      return [];
  }
}

/** Reuse the display parser for all display extensions, including host callback results. */
export function displayEvent(
  value: unknown,
  options: AgUiOptions,
  issues: AgUiIssue[],
  projected = false,
): ChatEvent | null {
  if (!jsonSafe(value, options.limits?.maxChars)) {
    issues.push(issue("limit", "The event is not bounded plain JSON. Nothing was applied."));
    return null;
  }
  const event = parseChatEvent(value);
  if (!event) {
    issues.push(
      issue("invalid", "The display event is malformed or unsupported. Nothing was applied."),
    );
    return null;
  }
  if (isRecord(value)) {
    const rawMessages =
      event.type === "snapshot" && Array.isArray(value.messages)
        ? value.messages
        : event.type === "message"
          ? [value.message]
          : [];
    const parsedMessages =
      event.type === "snapshot" ? event.messages : event.type === "message" ? [event.message] : [];
    if (
      rawMessages.some(
        (raw, index) =>
          isRecord(raw) &&
          Array.isArray(raw.parts) &&
          raw.parts.length !== parsedMessages[index]?.parts.length,
      )
    )
      issues.push(issue("unsupported", "Unknown display part types were omitted."));
  }
  if (
    (event.segment !== undefined && event.segment !== options.binding.segment) ||
    ((event.type === "snapshot" || event.type === "run") &&
      event.run.id !== undefined &&
      event.run.id !== options.binding.runId)
  ) {
    issues.push(issue("namespace", "The display event belongs to another run or segment."));
    return null;
  }
  if (
    (event.type === "input" && event.input.rootRunId !== options.binding.runId) ||
    (event.type === "snapshot" &&
      event.inputs?.some((input) => input.rootRunId !== options.binding.runId))
  ) {
    issues.push(issue("namespace", "The input receipt belongs to another logical run."));
    return null;
  }
  const part = (incoming: DisplayPart): DisplayPart | undefined => {
    let result = incoming;
    const fields = opaque(incoming);
    if (fields.some((field) => field !== undefined)) {
      const selected = projected || step(incoming) ? incoming : options.projectPart?.(incoming);
      if (selected) {
        const parsed = parseChatEvent({
          v: 1,
          type: "part",
          messageId: "projection",
          part: selected,
        });
        if (
          !parsed ||
          parsed.type !== "part" ||
          parsed.part.id !== incoming.id ||
          parsed.part.type !== incoming.type ||
          !opaque(parsed.part).every((field) => jsonSafe(field, options.limits?.maxChars, true))
        ) {
          issues.push(
            issue(
              "invalid",
              "A safe projection must keep the part identity and contain only public JSON.",
            ),
          );
          return undefined;
        }
        result = parsed.part;
      } else {
        issues.push(
          issue(
            "hidden",
            "Opaque display data was hidden. Supply a safe part projection to include it.",
          ),
        );
        switch (incoming.type) {
          case "data":
            return undefined;
          case "tool": {
            const { data: _data, ...rest } = incoming;
            result = rest;
            break;
          }
          case "client-tool": {
            const { input: _input, ...rest } = incoming;
            result = { ...rest, canAnswer: false };
            break;
          }
          case "approval": {
            const { edit: _edit, approveForm: _approve, denyForm: _deny, ...rest } = incoming;
            result = { ...rest, canAnswer: false };
            break;
          }
          case "question": {
            const { schema: _schema, ...rest } = incoming;
            result = { ...rest, canAnswer: false };
            break;
          }
        }
      }
    }
    return result;
  };
  const parts = (values: readonly DisplayPart[]) =>
    values.flatMap((item) => {
      const clean = part(item);
      return clean ? [clean] : [];
    });
  let clean: ChatEvent;
  switch (event.type) {
    case "snapshot":
      clean = {
        ...event,
        messages: event.messages.map((message) => ({ ...message, parts: parts(message.parts) })),
      };
      break;
    case "message":
      clean = { ...event, message: { ...event.message, parts: parts(event.message.parts) } };
      break;
    case "part": {
      const next = part(event.part);
      if (!next) return null;
      clean = { ...event, part: next };
      break;
    }
    default:
      clean = event;
  }
  if (issues.some((entry) => entry.code === "invalid" || entry.code === "limit")) return null;
  if (!jsonSafe(clean, options.limits?.maxChars)) {
    issues.push(issue("limit", "The safe projection exceeds the event limit."));
    return null;
  }
  // The parser copies opaque fields by reference. Detach them before the caller can mutate them.
  return parseChatEvent(copyJson(clean));
}

export function withinView(view: ChatView, options: AgUiOptions): boolean {
  return (
    view.messages.length +
      view.inputs.length +
      view.messages.reduce((count, message) => count + message.parts.length, 0) <=
      (options.limits?.maxItems ?? DEFAULT_ITEMS) && jsonSafe(view, options.limits?.maxChars)
  );
}

function interrupt(value: unknown): boolean {
  return (
    isRecord(value) &&
    id(value.id) &&
    id(value.reason) &&
    optional(value.message, text) &&
    optional(value.toolCallId, id) &&
    optional(value.subagentRunId, id) &&
    optional(value.responseSchema, isRecord) &&
    optional(value.metadata, isRecord) &&
    optional(value.expiresAt, (time) => text(time) && Number.isFinite(Date.parse(time)))
  );
}
function outcome(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "success":
      return optional(value.pendingToolCallIds, ids);
    case "cancelled":
      return true;
    case "interrupt":
      return (
        Array.isArray(value.interrupts) &&
        value.interrupts.every(interrupt) &&
        new Set(value.interrupts.map((entry: AgUiInterrupt) => entry.id)).size ===
          value.interrupts.length
      );
    default:
      return false;
  }
}
function message(value: unknown): boolean {
  return (
    isRecord(value) &&
    id(value.id) &&
    id(value.role) &&
    optional(value.name, text) &&
    optional(value.subagentRunId, id) &&
    optional(value.toolCallId, id) &&
    optional(
      value.toolCalls,
      (calls) =>
        Array.isArray(calls) &&
        calls.every(
          (call: unknown) =>
            isRecord(call) &&
            id(call.id) &&
            call.type === "function" &&
            isRecord(call.function) &&
            id(call.function.name) &&
            text(call.function.arguments),
        ),
    )
  );
}

function knownEvent(value: Record<string, unknown>): value is Record<string, unknown> & AgUiEvent {
  if (
    !optional(value.timestamp, (time) => typeof time === "number" && Number.isFinite(time)) ||
    !optional(value.metadata, isRecord) ||
    !optional(value.subagentRunId, id)
  )
    return false;
  switch (value.type) {
    case "RUN_STARTED":
      return (
        id(value.threadId) &&
        id(value.runId) &&
        optional(value.parentRunId, id) &&
        optional(value.protocolVersion, text)
      );
    case "RUN_FINISHED":
      return id(value.threadId) && id(value.runId) && optional(value.outcome, outcome);
    case "RUN_ERROR":
      return text(value.message) && optional(value.code, text);
    case "TEXT_MESSAGE_START":
      return id(value.messageId) && optional(value.role, text) && optional(value.name, text);
    case "TEXT_MESSAGE_CONTENT":
    case "REASONING_MESSAGE_CONTENT":
      return id(value.messageId) && text(value.delta);
    case "TEXT_MESSAGE_END":
    case "REASONING_START":
    case "REASONING_END":
    case "REASONING_MESSAGE_END":
      return id(value.messageId);
    case "REASONING_MESSAGE_START":
      return id(value.messageId) && value.role === "reasoning";
    case "TEXT_MESSAGE_CHUNK":
    case "REASONING_MESSAGE_CHUNK":
      return (
        optional(value.messageId, id) &&
        optional(value.role, text) &&
        optional(value.delta, text) &&
        optional(value.name, text)
      );
    case "TOOL_CALL_START":
      return id(value.toolCallId) && id(value.toolCallName) && optional(value.parentMessageId, id);
    case "TOOL_CALL_ARGS":
      return id(value.toolCallId) && text(value.delta);
    case "TOOL_CALL_END":
      return id(value.toolCallId);
    case "TOOL_CALL_CHUNK":
      return (
        optional(value.toolCallId, id) &&
        optional(value.toolCallName, id) &&
        optional(value.parentMessageId, id) &&
        optional(value.delta, text)
      );
    case "TOOL_CALL_RESULT":
      return (
        id(value.messageId) &&
        id(value.toolCallId) &&
        text(value.content) &&
        optional(value.role, (role) => role === "tool")
      );
    case "STEP_STARTED":
    case "STEP_FINISHED":
      return id(value.stepName);
    case "MESSAGES_SNAPSHOT":
      return (
        Array.isArray(value.messages) &&
        value.messages.every(message) &&
        new Set(value.messages.map((entry: AgUiMessageId) => entry.id)).size ===
          value.messages.length
      );
    case "STATE_SNAPSHOT":
      return Object.hasOwn(value, "snapshot");
    case "STATE_DELTA":
      return Array.isArray(value.delta);
    case "ACTIVITY_SNAPSHOT":
      return (
        id(value.messageId) &&
        id(value.activityType) &&
        Object.hasOwn(value, "content") &&
        optional(value.replace, (flag) => typeof flag === "boolean")
      );
    case "ACTIVITY_DELTA":
      return id(value.messageId) && id(value.activityType) && Array.isArray(value.patch);
    case "SUBAGENT_STARTED":
      return (
        id(value.subagentRunId) &&
        text(value.name) &&
        optional(value.description, text) &&
        optional(value.parentSubagentRunId, id) &&
        optional(value.parentToolCallId, id) &&
        optional(value.parentMessageId, id)
      );
    case "SUBAGENT_FINISHED":
      return (
        id(value.subagentRunId) &&
        optional(
          value.outcome,
          (end) => isRecord(end) && end.type === "suspended" && ids(end.interruptIds),
        )
      );
    case "SUBAGENT_ERROR":
      return id(value.subagentRunId) && text(value.message) && optional(value.code, text);
    case "CUSTOM":
      return id(value.name) && Object.hasOwn(value, "value");
    case "RAW":
      return Object.hasOwn(value, "event") && optional(value.source, text);
    case "REASONING_ENCRYPTED_VALUE":
      return (
        (value.subtype === "message" || value.subtype === "tool-call") &&
        id(value.entityId) &&
        text(value.encryptedValue)
      );
    default:
      return false;
  }
}
interface AgUiMessageId {
  id: string;
}

export function nativeEvent(
  value: unknown,
  maxChars: number,
  issues: AgUiIssue[],
): AgUiEvent | null {
  if (!jsonSafe(value, maxChars)) {
    issues.push(issue("limit", "The AG-UI event is not bounded plain JSON."));
    return null;
  }
  if (!isRecord(value) || !knownEvent(value)) {
    issues.push(
      issue("unsupported", "The AG-UI event is malformed or uses unsupported semantics."),
    );
    return null;
  }
  return value;
}

export function safePatch(patch: readonly unknown[]): boolean {
  return patch.every((item) => {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      !["add", "replace", "remove", "test"].includes(String(item.op)) ||
      Object.keys(item).some((key) => !["op", "path", "value"].includes(key)) ||
      (item.op !== "remove" && !Object.hasOwn(item, "value"))
    )
      return false;
    if (item.path === "") return item.op !== "remove";
    return (
      item.path.startsWith("/") &&
      !/~(?![01])/u.test(item.path) &&
      !item.path
        .slice(1)
        .split("/")
        .some((part) =>
          /^(?:__proto__|prototype|constructor)$/u.test(
            part.replaceAll("~1", "/").replaceAll("~0", "~"),
          ),
        )
    );
  });
}

/** RFC 6902 tests compare JSON values, not object member serialization order. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((item, index) => sameJson(item, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  );
}

/** ponytail: only add, replace, remove and test. Move/copy require a host patch implementation.
 * Apply to a copy, reject dangerous pointer components and commit only the whole valid patch. */
export function patchState(
  current: unknown,
  patch: readonly unknown[],
  maxChars: number,
): { value: unknown } | null {
  if (!jsonSafe(patch, maxChars) || !safePatch(patch)) return null;
  let next = copyJson(current);
  for (const item of patch) {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      !["add", "replace", "remove", "test"].includes(String(item.op))
    )
      return null;
    if (Object.hasOwn(item, "from") || (item.op !== "remove" && !Object.hasOwn(item, "value")))
      return null;
    if (item.path === "") {
      if (item.op === "remove") return null;
      if (item.op === "test") {
        if (!sameJson(next, item.value)) return null;
      } else next = copyJson(item.value);
      continue;
    }
    if (!item.path.startsWith("/") || /~(?![01])/u.test(item.path)) return null;
    const path = item.path
      .slice(1)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (path.some((part) => /^(?:__proto__|prototype|constructor)$/u.test(part))) return null;
    let target = next;
    for (const key of path.slice(0, -1)) {
      if (!isRecord(target) && !Array.isArray(target)) return null;
      if (!Object.hasOwn(target, key)) return null;
      target = Reflect.get(target, key);
    }
    const key = path.at(-1);
    if (key === undefined || (!isRecord(target) && !Array.isArray(target))) return null;
    if (Array.isArray(target)) {
      const index =
        key === "-" && item.op === "add"
          ? target.length
          : /^(?:0|[1-9][0-9]*)$/u.test(key)
            ? Number(key)
            : -1;
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index > target.length ||
        (item.op !== "add" && index === target.length)
      )
        return null;
      if (item.op === "test") {
        if (!sameJson(target[index], item.value)) return null;
      } else if (item.op === "add") target.splice(index, 0, copyJson(item.value));
      else if (item.op === "remove") target.splice(index, 1);
      else target[index] = copyJson(item.value);
    } else {
      if (item.op !== "add" && !Object.hasOwn(target, key)) return null;
      if (item.op === "test") {
        if (!sameJson(target[key], item.value)) return null;
      } else if (item.op === "remove") delete target[key];
      else target[key] = copyJson(item.value);
    }
  }
  return jsonSafe(next, maxChars) ? { value: next } : null;
}
