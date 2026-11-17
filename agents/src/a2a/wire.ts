// Version mappings adapted from Mastra's packages/core/src/a2a/compat/v1.ts.
// Copyright (c) 2025 Kepler Software, Inc. SPDX-License-Identifier: Apache-2.0
// Wire fields checked against a2aproject/A2A v1.0.0 and v0.3.0 schemas.
// The legacy HTTP binding uses protobuf JSON, not the legacy JSON-RPC shapes.

export type A2AVersion = "1.0" | "0.3";
export type A2ABinding = "JSONRPC" | "HTTP+JSON";
export interface A2ADialect {
  version: A2AVersion;
  binding: A2ABinding;
}
/** The specification assigns an omitted version header to 0.3. No automatic fallback. */
export function parseA2AVersion(header?: string | null): A2AVersion {
  if (!header || header === "0.3") return "0.3";
  if (header === "1.0") return "1.0";
  throw new A2AError("protocol", { code: -32009 });
}
export type A2AJson = null | boolean | number | string | A2AJson[] | A2AObject;
export interface A2AObject {
  [key: string]: A2AJson;
}
export type A2AState =
  | "unknown"
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "input_required"
  | "rejected"
  | "auth_required";
export type A2AErrorKind =
  | "protocol"
  | "invalid"
  | "limit"
  | "endpoint"
  | "http"
  | "network"
  | "timeout"
  | "stream-cut";
export type A2AOutcome = "not-sent" | "unknown" | "read";

const errorText: Record<A2AErrorKind, string> = {
  protocol: "The peer refused the A2A request. Check the protocol error code.",
  invalid: "The A2A data is invalid. Check the selected version and binding.",
  limit: "The A2A data exceeds the configured limit. Use a smaller payload.",
  endpoint: "The A2A endpoint is not allowed. Check the host's endpoint policy.",
  http: "The A2A request failed. Check the HTTP status and server access.",
  network: "The A2A connection failed. Read the task state before sending more work.",
  timeout: "The A2A request timed out. Read the task state before sending more work.",
  "stream-cut":
    "The A2A stream ended before the task paused or finished. Read or subscribe to the task again.",
};

/** Never retains peer prose, a URL, a body, headers or an underlying exception. */
export class A2AError extends Error {
  readonly kind: A2AErrorKind;
  readonly code?: number;
  readonly status?: number;
  readonly outcome: A2AOutcome;
  readonly retryable = false;
  constructor(
    kind: A2AErrorKind,
    options: { code?: number; status?: number; outcome?: A2AOutcome } = {},
  ) {
    super(errorText[kind]);
    this.name = "A2AError";
    this.kind = kind;
    this.code = options.code;
    this.status = options.status;
    this.outcome = options.outcome ?? "not-sent";
  }
}

export interface A2ALimits {
  bodyBytes: number;
  depth: number;
  nodes: number;
  parts: number;
  items: number;
  textChars: number;
}
export const A2A_LIMITS: Readonly<A2ALimits> = Object.freeze({
  bodyBytes: 8 * 1024 * 1024,
  depth: 32,
  nodes: 100_000,
  parts: 64,
  items: 1000,
  textChars: 1024 * 1024,
});

export function a2aLimits(limits: Partial<A2ALimits> = {}): A2ALimits {
  const result = { ...A2A_LIMITS, ...limits };
  if (Object.values(result).some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new A2AError("invalid");
  return result;
}
function invalid(): never {
  throw new A2AError("invalid", { code: -32602 });
}
function unsupported(): never {
  throw new A2AError("protocol", { code: -32004 });
}
function obj(value: unknown): A2AObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  // All external entry points first run checkJson, so this assertion adds no trust.
  return value as A2AObject;
}
function str(value: unknown, max = 2048, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.length))
    return invalid();
  return value;
}
function optionalString(value: unknown, max = 2048): string | undefined {
  return value === undefined ? undefined : str(value, max, true);
}
function id(value: unknown): string {
  return str(value, 512);
}
function optionalId(value: unknown): string | undefined {
  return value === undefined || value === "" ? undefined : id(value);
}
function bool(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return invalid();
  return value;
}
function integer(value: unknown, min = 0, max = 2_147_483_647): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid();
  return value;
}
function list(value: unknown, max: number, nonempty = false): A2AJson[] {
  if (!Array.isArray(value) || value.length > max || (nonempty && !value.length)) return invalid();
  return value;
}
function strings(value: unknown, max: number): string[] {
  return list(value, max).map((s) => str(s));
}
function metadata(value: unknown): A2AObject | undefined {
  return value === undefined ? undefined : obj(value);
}
function optionalStrings(value: unknown, max: number): string[] | undefined {
  return value === undefined ? undefined : strings(value, max);
}
function oneOf(value: A2AObject, keys: readonly string[]): string {
  const present = keys.filter((key) => Object.hasOwn(value, key));
  if (present.length !== 1) return invalid();
  return present[0]!;
}
function clean(value: Record<string, A2AJson | undefined>): A2AObject {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, A2AJson] => entry[1] !== undefined),
  );
}
function checkJson(value: unknown, limits: A2ALimits): asserts value is A2AJson {
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > limits.nodes || current.depth > limits.depth) throw new A2AError("limit");
    const v = current.value;
    if (v === null || typeof v === "string" || typeof v === "boolean") continue;
    if (typeof v === "number" && Number.isFinite(v)) continue;
    if (
      !v ||
      typeof v !== "object" ||
      (!Array.isArray(v) &&
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null)
    )
      return invalid();
    for (const child of Object.values(v)) pending.push({ value: child, depth: current.depth + 1 });
    if (pending.length + count > limits.nodes) throw new A2AError("limit");
  }
}
/** JSON.parse validates grammar but discards duplicate members. Scan only the already-valid
 * tokens so conflicting approval fields cannot be silently reduced to the last value. */
function uniqueJsonMembers(text: string): void {
  const objects: (Set<string> | undefined)[] = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
    const token = match[0];
    if (token === "{") objects.push(new Set());
    else if (token === "[") objects.push(undefined);
    else if (token === "}" || token === "]") objects.pop();
    else {
      let next = match.index + token.length;
      while (
        text[next] === " " ||
        text[next] === "\t" ||
        text[next] === "\r" ||
        text[next] === "\n"
      )
        next++;
      if (text[next] !== ":") continue;
      const names = objects.at(-1);
      const name: unknown = JSON.parse(token);
      if (!names || typeof name !== "string" || names.has(name)) return invalid();
      names.add(name);
    }
  }
}

export function parseA2AJson(text: string, overrides?: Partial<A2ALimits>): A2AJson {
  const limits = a2aLimits(overrides);
  if (
    text.length > limits.bodyBytes ||
    new TextEncoder().encode(text).byteLength > limits.bodyBytes
  )
    throw new A2AError("limit");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new A2AError("protocol", { code: -32700 });
  }
  checkJson(value, limits);
  uniqueJsonMembers(text);
  return value;
}
function checked(value: unknown, limits: A2ALimits): A2AJson {
  checkJson(value, limits);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > limits.bodyBytes)
    throw new A2AError("limit");
  return value;
}
function input(value: unknown, limits: A2ALimits): A2AObject {
  return obj(checked(value, limits));
}
function legacyRpc(d: A2ADialect): boolean {
  return d.version === "0.3" && d.binding === "JSONRPC";
}
function legacyRest(d: A2ADialect): boolean {
  return d.version === "0.3" && d.binding === "HTTP+JSON";
}

interface PartFields {
  metadata?: A2AObject;
  filename?: string;
  mediaType?: string;
}
export type A2APart = PartFields &
  (
    | { kind: "text"; text: string }
    | { kind: "raw"; raw: string }
    | { kind: "url"; url: string }
    | { kind: "data"; data: A2AJson }
  );
export interface A2AMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: A2APart[];
  taskId?: string;
  contextId?: string;
  metadata?: A2AObject;
  extensions?: string[];
  referenceTaskIds?: string[];
}
export interface A2AArtifact {
  artifactId: string;
  parts: A2APart[];
  name?: string;
  description?: string;
  metadata?: A2AObject;
  extensions?: string[];
}
export interface A2AStatus {
  state: A2AState;
  message?: A2AMessage;
  timestamp?: string;
}
export interface A2ATask {
  kind: "task";
  id: string;
  contextId?: string;
  status: A2AStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: A2AObject;
}
export interface A2AStatusUpdate {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: A2AStatus;
  final?: boolean;
  metadata?: A2AObject;
}
export interface A2AArtifactUpdate {
  kind: "artifact-update";
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: A2AObject;
}
export type A2AEvent = A2ATask | A2AMessage | A2AStatusUpdate | A2AArtifactUpdate;
export interface A2APushConfig {
  taskId?: string;
  id?: string;
  url: string;
  token?: string;
  authentication?: { schemes: string[]; credentials?: string };
  tenant?: string;
}
export interface A2AInterface {
  url: string;
  binding: string;
  version: string;
  tenant?: string;
}
export interface A2AAgentCard {
  /** Original public fields, including security declarations and signatures. Untrusted, not authority. */
  document: A2AObject;
  version: A2AVersion;
  interfaces: A2AInterface[];
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    extendedAgentCard?: boolean;
    extensions?: { uri: string; required?: boolean }[];
  };
}

const states: A2AState[] = [
  "unknown",
  "submitted",
  "working",
  "completed",
  "failed",
  "canceled",
  "input_required",
  "rejected",
  "auth_required",
];
export function a2aStateClosed(state: A2AState): boolean {
  return !["unknown", "submitted", "working"].includes(state);
}
function stateFrom(value: unknown, d: A2ADialect): A2AState {
  const index = states.findIndex((state) => stateTo(state, d) === value);
  // Protobuf JSON parsers must also accept numeric enum values.
  if (!legacyRpc(d) && typeof value === "number" && Number.isInteger(value) && states[value])
    return states[value];
  if (index < 0) return invalid();
  return states[index]!;
}
function stateTo(state: A2AState, d: A2ADialect): string {
  if (legacyRpc(d)) return state.replaceAll("_", "-");
  return `TASK_STATE_${state === "unknown" ? "UNSPECIFIED" : state === "canceled" && legacyRest(d) ? "CANCELLED" : state.toUpperCase()}`;
}
function base64(value: unknown, limits: A2ALimits): string {
  const s = str(value, limits.bodyBytes, true);
  // Protobuf JSON permits URL-safe and unpadded base64 too. Do not decode or fetch media here.
  if (
    !/^[A-Za-z0-9+/_-]*={0,2}$/.test(s) ||
    s.replace(/=+$/, "").length % 4 === 1 ||
    (s.includes("=") && s.length % 4 !== 0)
  )
    return invalid();
  return s;
}
function partFrom(value: unknown, d: A2ADialect, limits: A2ALimits): A2APart {
  const p = obj(value);
  const fields = {
    metadata: metadata(p.metadata),
    filename: optionalString(p.filename),
    mediaType: optionalString(p.mediaType),
  };
  if (legacyRpc(d)) {
    if (p.kind === "text")
      return { ...fields, kind: "text", text: str(p.text, limits.textChars, true) };
    if (p.kind === "data") return { ...fields, kind: "data", data: obj(p.data) };
    if (p.kind !== "file") return invalid();
    const f = obj(p.file);
    const fileFields = {
      ...fields,
      filename: optionalString(f.name),
      mediaType: optionalString(f.mimeType),
    };
    return oneOf(f, ["bytes", "uri"]) === "bytes"
      ? { ...fileFields, kind: "raw", raw: base64(f.bytes, limits) }
      : { ...fileFields, kind: "url", url: str(f.uri) };
  }
  const kind = oneOf(p, legacyRest(d) ? ["text", "file", "data"] : ["text", "raw", "url", "data"]);
  if (kind === "text") return { ...fields, kind, text: str(p.text, limits.textChars, true) };
  if (kind === "raw") return { ...fields, kind, raw: base64(p.raw, limits) };
  if (kind === "url") return { ...fields, kind, url: str(p.url) };
  if (kind === "data")
    return { ...fields, kind, data: legacyRest(d) ? obj(obj(p.data).data) : p.data! };
  const f = obj(p.file);
  const fileFields = { mediaType: optionalString(f.mimeType) };
  return oneOf(f, ["fileWithBytes", "fileWithUri"]) === "fileWithBytes"
    ? { ...fileFields, kind: "raw", raw: base64(f.fileWithBytes, limits) }
    : { ...fileFields, kind: "url", url: str(f.fileWithUri) };
}
function partTo(p: A2APart, d: A2ADialect): A2AObject {
  const fields = clean({ metadata: p.metadata, filename: p.filename, mediaType: p.mediaType });
  if (legacyRest(d)) {
    if (p.metadata || p.filename || (p.mediaType && p.kind !== "raw" && p.kind !== "url"))
      return unsupported();
    if (p.kind === "text") return { text: p.text };
    if (p.kind === "data") return { data: { data: obj(p.data) } };
    return {
      file: clean({
        [p.kind === "raw" ? "fileWithBytes" : "fileWithUri"]: p.kind === "raw" ? p.raw : p.url,
        mimeType: p.mediaType,
      }),
    };
  }
  if (legacyRpc(d)) {
    if (p.kind === "text" || p.kind === "data") {
      if (p.filename || p.mediaType) return unsupported();
      return clean({
        kind: p.kind,
        [p.kind]: p.kind === "text" ? p.text : obj(p.data),
        metadata: p.metadata,
      });
    }
    return clean({
      kind: "file",
      file: clean({
        [p.kind === "raw" ? "bytes" : "uri"]: p.kind === "raw" ? p.raw : p.url,
        name: p.filename,
        mimeType: p.mediaType,
      }),
      metadata: p.metadata,
    });
  }
  return {
    ...fields,
    [p.kind]:
      p.kind === "text" ? p.text : p.kind === "raw" ? p.raw : p.kind === "url" ? p.url : p.data,
  };
}
function messageFrom(value: unknown, d: A2ADialect, l: A2ALimits): A2AMessage {
  const m = obj(value);
  if (legacyRpc(d) && m.kind !== "message") return invalid();
  const user = legacyRpc(d) ? m.role === "user" : m.role === "ROLE_USER" || m.role === 1;
  const agent = legacyRpc(d) ? m.role === "agent" : m.role === "ROLE_AGENT" || m.role === 2;
  if (!user && !agent) return invalid();
  return {
    kind: "message",
    messageId: str(m.messageId, 128),
    role: user ? "user" : "agent",
    parts: list(m[legacyRest(d) ? "content" : "parts"], l.parts, true).map((p) =>
      partFrom(p, d, l),
    ),
    taskId: optionalId(m.taskId),
    contextId: optionalId(m.contextId),
    metadata: metadata(m.metadata),
    extensions: optionalStrings(m.extensions, l.items),
    referenceTaskIds: optionalStrings(m.referenceTaskIds, l.items),
  };
}
function messageTo(m: A2AMessage, d: A2ADialect): A2AObject {
  if (legacyRest(d) && m.referenceTaskIds?.length) return unsupported();
  return clean({
    kind: legacyRpc(d) ? "message" : undefined,
    messageId: m.messageId,
    role: legacyRpc(d) ? m.role : m.role === "user" ? "ROLE_USER" : "ROLE_AGENT",
    [legacyRest(d) ? "content" : "parts"]: m.parts.map((p) => partTo(p, d)),
    taskId: m.taskId,
    contextId: m.contextId,
    metadata: m.metadata,
    extensions: m.extensions,
    referenceTaskIds: legacyRest(d) ? undefined : m.referenceTaskIds,
  });
}
function artifactFrom(value: unknown, d: A2ADialect, l: A2ALimits): A2AArtifact {
  const a = obj(value);
  return {
    artifactId: id(a.artifactId),
    parts: list(a.parts, l.parts, true).map((p) => partFrom(p, d, l)),
    name: optionalString(a.name),
    description: optionalString(a.description, l.textChars),
    metadata: metadata(a.metadata),
    extensions: optionalStrings(a.extensions, l.items),
  };
}
function artifactTo(a: A2AArtifact, d: A2ADialect): A2AObject {
  return clean({
    artifactId: a.artifactId,
    parts: a.parts.map((p) => partTo(p, d)),
    name: a.name,
    description: a.description,
    metadata: a.metadata,
    extensions: a.extensions,
  });
}
function statusFrom(value: unknown, d: A2ADialect, l: A2ALimits): A2AStatus {
  const s = obj(value);
  const timestamp = optionalString(s.timestamp, 128);
  if (
    timestamp &&
    (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp)))
  )
    return invalid();
  return {
    state: stateFrom(s.state, d),
    message: s.message === undefined ? undefined : messageFrom(s.message, d, l),
    timestamp,
  };
}
function statusTo(s: A2AStatus, d: A2ADialect): A2AObject {
  return clean({
    state: stateTo(s.state, d),
    message: s.message && messageTo(s.message, d),
    timestamp: s.timestamp,
  });
}
function matchMessage(m: A2AMessage | undefined, taskId: string, contextId?: string): void {
  if (
    m &&
    ((m.taskId && m.taskId !== taskId) || (m.contextId && contextId && m.contextId !== contextId))
  )
    return invalid();
}
function taskFrom(value: unknown, d: A2ADialect, l: A2ALimits): A2ATask {
  const t = obj(value);
  if (legacyRpc(d) && t.kind !== "task") return invalid();
  const task: A2ATask = {
    kind: "task",
    id: id(t.id),
    contextId: d.version === "0.3" ? id(t.contextId) : optionalId(t.contextId),
    status: statusFrom(t.status, d, l),
    artifacts:
      t.artifacts === undefined
        ? undefined
        : list(t.artifacts, l.items).map((a) => artifactFrom(a, d, l)),
    history:
      t.history === undefined
        ? undefined
        : list(t.history, l.items).map((m) => messageFrom(m, d, l)),
    metadata: metadata(t.metadata),
  };
  if (new Set(task.artifacts?.map((a) => a.artifactId)).size !== (task.artifacts?.length ?? 0))
    return invalid();
  matchMessage(task.status.message, task.id, task.contextId);
  for (const message of task.history ?? []) matchMessage(message, task.id, task.contextId);
  return task;
}
function taskTo(t: A2ATask, d: A2ADialect): A2AObject {
  return clean({
    kind: legacyRpc(d) ? "task" : undefined,
    id: t.id,
    contextId: t.contextId,
    status: statusTo(t.status, d),
    artifacts: t.artifacts?.map((a) => artifactTo(a, d)),
    history: t.history?.map((m) => messageTo(m, d)),
    metadata: t.metadata,
  });
}

export function decodeA2AMessage(
  value: unknown,
  dialect: A2ADialect,
  overrides?: Partial<A2ALimits>,
): A2AMessage {
  const l = a2aLimits(overrides);
  return messageFrom(input(value, l), dialect, l);
}
export function encodeA2AMessage(value: A2AMessage, dialect: A2ADialect): A2AObject {
  const wire = messageTo(value, dialect);
  decodeA2AMessage(wire, dialect);
  return wire;
}
export function decodeA2ATask(
  value: unknown,
  dialect: A2ADialect,
  overrides?: Partial<A2ALimits>,
): A2ATask {
  const l = a2aLimits(overrides);
  return taskFrom(input(value, l), dialect, l);
}
export function encodeA2ATask(value: A2ATask, dialect: A2ADialect): A2AObject {
  const wire = taskTo(value, dialect);
  decodeA2ATask(wire, dialect);
  return wire;
}
export function decodeA2AEvent(
  value: unknown,
  d: A2ADialect,
  overrides?: Partial<A2ALimits>,
): A2AEvent {
  const l = a2aLimits(overrides);
  let wire = input(value, l);
  const kind = legacyRpc(d)
    ? wire.kind
    : oneOf(wire, ["task", "message", "statusUpdate", "artifactUpdate"]);
  if (!legacyRpc(d)) wire = obj(wire[String(kind)]);
  if (kind === "task") return taskFrom(wire, d, l);
  if (kind === "message") {
    const message = messageFrom(wire, d, l);
    if (message.role !== "agent" || !message.contextId) return invalid();
    return message;
  }
  const fields = {
    taskId: id(wire.taskId),
    contextId: id(wire.contextId),
    metadata: metadata(wire.metadata),
  };
  if (kind === "status-update" || kind === "statusUpdate") {
    const status = statusFrom(wire.status, d, l);
    matchMessage(status.message, fields.taskId, fields.contextId);
    const final = d.version === "0.3" ? bool(wire.final) : undefined;
    if (legacyRpc(d) && final === undefined) return invalid();
    if (final === true && !a2aStateClosed(status.state)) return invalid();
    return { kind: "status-update", ...fields, status, final };
  }
  if (kind !== "artifact-update" && kind !== "artifactUpdate") return invalid();
  return {
    kind: "artifact-update",
    ...fields,
    artifact: artifactFrom(wire.artifact, d, l),
    append: bool(wire.append),
    lastChunk: bool(wire.lastChunk),
  };
}
export function encodeA2AEvent(event: A2AEvent, d: A2ADialect): A2AObject {
  let wire: A2AObject;
  let key: string;
  if (event.kind === "task") {
    wire = taskTo(event, d);
    key = "task";
  } else if (event.kind === "message") {
    wire = messageTo(event, d);
    key = "message";
  } else {
    key = event.kind === "status-update" ? "statusUpdate" : "artifactUpdate";
    wire = clean({
      kind: legacyRpc(d) ? event.kind : undefined,
      taskId: event.taskId,
      contextId: event.contextId,
      metadata: event.metadata,
      ...(event.kind === "status-update"
        ? {
            status: statusTo(event.status, d),
            final: d.version === "0.3" ? a2aStateClosed(event.status.state) : undefined,
          }
        : {
            artifact: artifactTo(event.artifact, d),
            append: event.append,
            lastChunk: event.lastChunk,
          }),
    });
  }
  const result = legacyRpc(d) ? wire : { [key]: wire };
  decodeA2AEvent(result, d);
  return result;
}

/** Keep public card fields verbatim. Signing and security interpretation belong to the host. */
export function decodeA2AAgentCard(
  value: unknown,
  version: A2AVersion,
  overrides?: Partial<A2ALimits>,
): A2AAgentCard {
  const l = a2aLimits(overrides);
  const card = input(value, l);
  // ProtoJSON omits empty repeated/scalar defaults. Legacy JSON Schema requires these fields.
  const repeated = (field: A2AJson | undefined) =>
    version === "1.0" && field == null ? [] : field;
  const description = (field: A2AJson | undefined) =>
    version === "1.0" && field == null ? "" : field;
  str(card.name);
  str(description(card.description), l.textChars, true);
  str(card.version);
  strings(repeated(card.defaultInputModes), l.items);
  strings(repeated(card.defaultOutputModes), l.items);
  for (const skill of list(repeated(card.skills), l.items)) {
    const s = obj(skill);
    id(s.id);
    str(s.name);
    str(description(s.description), l.textChars, true);
    strings(repeated(s.tags), l.items);
    optionalStrings(s.examples, l.items);
    optionalStrings(s.inputModes, l.items);
    optionalStrings(s.outputModes, l.items);
  }
  if (card.provider !== undefined) {
    const p = obj(card.provider);
    str(p.organization);
    str(p.url);
  }
  for (const key of ["documentationUrl", "iconUrl"]) optionalString(card[key]);
  if (card.securitySchemes !== undefined) obj(card.securitySchemes);
  for (const key of ["security", "securityRequirements"]) {
    if (card[key] !== undefined) for (const entry of list(card[key], l.items)) obj(entry);
  }
  if (card.signatures !== undefined)
    for (const entry of list(card.signatures, l.items)) {
      const signature = obj(entry);
      str(signature.protected, l.textChars);
      str(signature.signature, l.textChars);
      metadata(signature.header);
    }
  const c = obj(card.capabilities);
  const capabilities = {
    streaming: bool(c.streaming),
    pushNotifications: bool(c.pushNotifications),
    extendedAgentCard: bool(
      version === "1.0" ? c.extendedAgentCard : card.supportsAuthenticatedExtendedCard,
    ),
    extensions:
      c.extensions === undefined
        ? undefined
        : list(c.extensions, l.items).map((ext) => {
            const e = obj(ext);
            optionalString(e.description, l.textChars);
            metadata(e.params);
            return { uri: str(e.uri), required: bool(e.required) };
          }),
  };
  let interfaces: A2AInterface[];
  if (version === "1.0") {
    interfaces = list(card.supportedInterfaces, l.items, true).map((entry) => {
      const i = obj(entry);
      return {
        url: str(i.url),
        binding: str(i.protocolBinding),
        version: str(i.protocolVersion, 32),
        tenant: optionalId(i.tenant),
      };
    });
  } else {
    const protocolVersion = str(card.protocolVersion, 32);
    if (!/^0\.3(?:\.\d+)?$/.test(protocolVersion)) throw new A2AError("protocol", { code: -32009 });
    interfaces = [
      {
        url: str(card.url),
        binding: card.preferredTransport === undefined ? "JSONRPC" : str(card.preferredTransport),
        version: protocolVersion,
      },
      ...list(card.additionalInterfaces ?? [], l.items).map((entry) => {
        const i = obj(entry);
        return { url: str(i.url), binding: str(i.transport), version: protocolVersion };
      }),
    ];
  }
  return { document: card, version, interfaces, capabilities };
}

function pushFrom(value: unknown, d: A2ADialect, taskRequired = false): A2APushConfig {
  const outer = obj(value);
  let p = outer;
  let taskId = optionalId(outer.taskId);
  let configId: string | undefined;
  if (d.version === "0.3" && taskRequired) {
    p = obj(outer.pushNotificationConfig);
    if (legacyRest(d)) {
      const parts = str(outer.name).split("/");
      if (parts.length !== 4 || parts[0] !== "tasks" || parts[2] !== "pushNotificationConfigs")
        return invalid();
      try {
        taskId = id(decodeURIComponent(parts[1]!));
        configId = optionalId(decodeURIComponent(parts[3]!));
      } catch {
        return invalid();
      }
    }
  }
  if (taskRequired) id(taskId);
  const a = p.authentication === undefined ? undefined : obj(p.authentication);
  const schemes = a ? (d.version === "1.0" ? [str(a.scheme)] : strings(a.schemes, 16)) : undefined;
  if (schemes && !schemes.length) return invalid();
  if (configId && p.id !== undefined && p.id !== configId) return invalid();
  return {
    taskId,
    id: optionalId(p.id) ?? configId,
    url: str(p.url),
    token: optionalString(p.token, 8192),
    tenant: optionalId(outer.tenant),
    authentication:
      a && schemes ? { schemes, credentials: optionalString(a.credentials, 8192) } : undefined,
  };
}
function pushTo(p: A2APushConfig, d: A2ADialect, taskRequired = false): A2AObject {
  if (
    d.version === "1.0" &&
    p.authentication?.schemes.length !== undefined &&
    p.authentication.schemes.length !== 1
  )
    return unsupported();
  const config = clean({
    id: p.id,
    url: p.url,
    token: p.token,
    authentication: p.authentication
      ? clean({
          [d.version === "1.0" ? "scheme" : "schemes"]:
            d.version === "1.0" ? p.authentication.schemes[0] : p.authentication.schemes,
          credentials: p.authentication.credentials,
        })
      : undefined,
  });
  if (d.version === "1.0") return clean({ ...config, taskId: p.taskId, tenant: p.tenant });
  if (p.tenant) return unsupported();
  if (!taskRequired) return config;
  if (legacyRpc(d)) return clean({ taskId: p.taskId, pushNotificationConfig: config });
  return {
    name: `tasks/${encodeURIComponent(id(p.taskId))}/pushNotificationConfigs/${encodeURIComponent(p.id ?? "")}`,
    pushNotificationConfig: config,
  };
}

function historyFrom(value: unknown, d: A2ADialect): number | undefined {
  if (value === undefined) return undefined;
  const length = integer(value);
  // The 0.3 REST proto uses zero for unlimited history. 1.0 uses zero for none.
  return legacyRest(d) && length === 0 ? undefined : length;
}
function historyTo(value: number | undefined, d: A2ADialect): number | undefined {
  if (legacyRest(d) && value === 0) return unsupported();
  return value;
}

export interface A2ASendParams {
  message: A2AMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    returnImmediately?: boolean;
    historyLength?: number;
    pushNotificationConfig?: A2APushConfig;
  };
  metadata?: A2AObject;
  tenant?: string;
}
export interface A2ATaskParams {
  id: string;
  historyLength?: number;
  metadata?: A2AObject;
  tenant?: string;
}
export interface A2AListParams {
  contextId?: string;
  status?: A2AState;
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
  statusTimestampAfter?: string;
  includeArtifacts?: boolean;
  tenant?: string;
}
export interface A2APushParams {
  taskId: string;
  id?: string;
  pageSize?: number;
  pageToken?: string;
  metadata?: A2AObject;
  tenant?: string;
}
export interface A2ARequests {
  SendMessage: A2ASendParams;
  SendStreamingMessage: A2ASendParams;
  GetTask: A2ATaskParams;
  CancelTask: A2ATaskParams;
  SubscribeToTask: A2ATaskParams;
  ListTasks: A2AListParams;
  CreateTaskPushNotificationConfig: A2APushConfig;
  GetTaskPushNotificationConfig: A2APushParams;
  ListTaskPushNotificationConfigs: A2APushParams;
  DeleteTaskPushNotificationConfig: A2APushParams;
  GetExtendedAgentCard: { tenant?: string };
}
export interface A2AResults {
  SendMessage: A2ATask | A2AMessage;
  SendStreamingMessage: A2AEvent;
  GetTask: A2ATask;
  CancelTask: A2ATask;
  SubscribeToTask: A2AEvent;
  ListTasks: { tasks: A2ATask[]; nextPageToken: string; pageSize: number; totalSize: number };
  CreateTaskPushNotificationConfig: A2APushConfig;
  GetTaskPushNotificationConfig: A2APushConfig;
  ListTaskPushNotificationConfigs: { configs: A2APushConfig[]; nextPageToken?: string };
  DeleteTaskPushNotificationConfig: null;
  GetExtendedAgentCard: A2AAgentCard;
}
export type A2AMethod = keyof A2ARequests;
export type A2ARequest = { [M in A2AMethod]: { method: M; params: A2ARequests[M] } }[A2AMethod];
const legacyMethods: Record<A2AMethod, string> = {
  SendMessage: "message/send",
  SendStreamingMessage: "message/stream",
  GetTask: "tasks/get",
  CancelTask: "tasks/cancel",
  SubscribeToTask: "tasks/resubscribe",
  ListTasks: "tasks/list",
  CreateTaskPushNotificationConfig: "tasks/pushNotificationConfig/set",
  GetTaskPushNotificationConfig: "tasks/pushNotificationConfig/get",
  ListTaskPushNotificationConfigs: "tasks/pushNotificationConfig/list",
  DeleteTaskPushNotificationConfig: "tasks/pushNotificationConfig/delete",
  GetExtendedAgentCard: "agent/getAuthenticatedExtendedCard",
};
export function a2aMethodName(method: A2AMethod, version: A2AVersion): string {
  if (!Object.hasOwn(legacyMethods, method)) throw new A2AError("protocol", { code: -32601 });
  if (method === "ListTasks" && version === "0.3") return unsupported();
  return version === "1.0" ? method : legacyMethods[method];
}
export function a2aIsMutation(method: A2AMethod): boolean {
  return [
    "SendMessage",
    "SendStreamingMessage",
    "CancelTask",
    "CreateTaskPushNotificationConfig",
    "DeleteTaskPushNotificationConfig",
  ].includes(method);
}

/** The name selects a method, not a version. Callers must select the dialect first. */
export function decodeA2ARequest(
  methodName: string,
  value: unknown,
  d: A2ADialect,
  overrides?: Partial<A2ALimits>,
): A2ARequest {
  const l = a2aLimits(overrides);
  const p = input(value, l);
  const method = (Object.keys(legacyMethods) as A2AMethod[]).find(
    (m) => (d.version === "1.0" ? m : legacyMethods[m]) === methodName,
  );
  if (!method) throw new A2AError("protocol", { code: -32601 });
  a2aMethodName(method, d.version);
  const tenant = optionalId(p.tenant);
  if (tenant && d.version !== "1.0") return unsupported();
  switch (method) {
    case "SendMessage":
    case "SendStreamingMessage": {
      const message = messageFrom(p.message, d, l);
      if (message.role !== "user") return invalid();
      const c = p.configuration === undefined ? undefined : obj(p.configuration);
      const push =
        c?.[
          d.version === "1.0"
            ? "taskPushNotificationConfig"
            : legacyRest(d)
              ? "pushNotification"
              : "pushNotificationConfig"
        ];
      const blocking = c && bool(c[d.version === "1.0" ? "returnImmediately" : "blocking"]);
      const configuration = c
        ? {
            acceptedOutputModes: optionalStrings(c.acceptedOutputModes, l.items),
            returnImmediately:
              blocking === undefined ? undefined : d.version === "1.0" ? blocking : !blocking,
            historyLength: historyFrom(c.historyLength, d),
            pushNotificationConfig: push === undefined ? undefined : pushFrom(push, d),
          }
        : undefined;
      return { method, params: { message, configuration, metadata: metadata(p.metadata), tenant } };
    }
    case "GetTask":
    case "CancelTask":
    case "SubscribeToTask": {
      if (method !== "GetTask" && p.historyLength !== undefined) return invalid();
      if (
        p.metadata !== undefined &&
        (legacyRest(d) || (d.version === "1.0" && method !== "CancelTask"))
      )
        return unsupported();
      let taskId = p.id;
      if (legacyRest(d)) {
        const name = str(p.name);
        if (!name.startsWith("tasks/")) return invalid();
        try {
          taskId = decodeURIComponent(name.slice(6));
        } catch {
          return invalid();
        }
      }
      return {
        method,
        params: {
          id: id(taskId),
          historyLength: historyFrom(p.historyLength, d),
          metadata: metadata(p.metadata),
          tenant,
        },
      };
    }
    case "ListTasks":
      return {
        method,
        params: {
          contextId: optionalId(p.contextId),
          status: p.status === undefined ? undefined : stateFrom(p.status, d),
          pageSize: p.pageSize === undefined ? undefined : integer(p.pageSize, 1, 100),
          pageToken: optionalString(p.pageToken),
          historyLength: historyFrom(p.historyLength, d),
          statusTimestampAfter: optionalString(p.statusTimestampAfter, 128),
          includeArtifacts: bool(p.includeArtifacts),
          tenant,
        },
      };
    case "CreateTaskPushNotificationConfig":
      return { method, params: pushFrom(p, d, true) };
    case "GetTaskPushNotificationConfig":
    case "DeleteTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs": {
      if (!legacyRpc(d) && p.metadata !== undefined) return unsupported();
      if (
        method !== "ListTaskPushNotificationConfigs" &&
        (p.pageSize !== undefined || p.pageToken !== undefined)
      )
        return invalid();
      let taskId = legacyRpc(d) ? p.id : p.taskId;
      let configId = legacyRpc(d) ? p.pushNotificationConfigId : p.id;
      if (legacyRest(d)) {
        const name = str(p.name ?? p.parent).split("/");
        if (
          name[0] !== "tasks" ||
          (method === "ListTaskPushNotificationConfigs"
            ? name.length !== 2
            : name.length !== 4 || name[2] !== "pushNotificationConfigs")
        )
          return invalid();
        try {
          taskId = decodeURIComponent(name[1]!);
          configId = name[3] && decodeURIComponent(name[3]);
        } catch {
          return invalid();
        }
      }
      const config = optionalId(configId);
      if (
        method !== "ListTaskPushNotificationConfigs" &&
        (d.version === "1.0" || method === "DeleteTaskPushNotificationConfig") &&
        !config
      )
        return invalid();
      return {
        method,
        params: {
          taskId: id(taskId),
          id: config,
          pageSize: p.pageSize === undefined ? undefined : integer(p.pageSize, 1, 100),
          pageToken: optionalString(p.pageToken),
          metadata: metadata(p.metadata),
          tenant,
        },
      };
    }
    case "GetExtendedAgentCard":
      return { method, params: { tenant } };
  }
}
export function encodeA2ARequest(
  request: A2ARequest,
  d: A2ADialect,
  overrides?: Partial<A2ALimits>,
): { method: string; params: A2AObject } {
  const method = a2aMethodName(request.method, d.version);
  const p = request.params;
  if (d.version === "0.3" && p.tenant) return unsupported();
  let params: A2AObject;
  switch (request.method) {
    case "SendMessage":
    case "SendStreamingMessage": {
      const s = request.params;
      const c = s.configuration;
      params = clean({
        message: messageTo(s.message, d),
        metadata: s.metadata,
        tenant: s.tenant,
        configuration: c
          ? clean({
              acceptedOutputModes: c.acceptedOutputModes,
              [d.version === "1.0" ? "returnImmediately" : "blocking"]:
                c.returnImmediately === undefined
                  ? undefined
                  : d.version === "1.0"
                    ? c.returnImmediately
                    : !c.returnImmediately,
              historyLength: historyTo(c.historyLength, d),
              [d.version === "1.0"
                ? "taskPushNotificationConfig"
                : legacyRest(d)
                  ? "pushNotification"
                  : "pushNotificationConfig"]:
                c.pushNotificationConfig && pushTo(c.pushNotificationConfig, d),
            })
          : undefined,
      });
      break;
    }
    case "GetTask":
    case "CancelTask":
    case "SubscribeToTask": {
      const t = request.params;
      params = clean({
        [legacyRest(d) ? "name" : "id"]: legacyRest(d) ? `tasks/${encodeURIComponent(t.id)}` : t.id,
        tenant: t.tenant,
        historyLength: historyTo(t.historyLength, d),
        metadata: t.metadata,
      });
      break;
    }
    case "ListTasks": {
      const t = request.params;
      params = clean({ ...t, status: t.status && stateTo(t.status, d) });
      break;
    }
    case "CreateTaskPushNotificationConfig":
      params = pushTo(request.params, d, true);
      break;
    case "GetTaskPushNotificationConfig":
    case "DeleteTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs": {
      const t = request.params;
      if (legacyRest(d) && t.metadata !== undefined) return unsupported();
      if (legacyRpc(d) && (t.pageSize !== undefined || t.pageToken !== undefined))
        return unsupported();
      params = legacyRest(d)
        ? clean({
            [request.method === "ListTaskPushNotificationConfigs" ? "parent" : "name"]:
              `tasks/${encodeURIComponent(t.taskId)}${request.method === "ListTaskPushNotificationConfigs" ? "" : `/pushNotificationConfigs/${encodeURIComponent(id(t.id))}`}`,
            pageSize: t.pageSize,
            pageToken: t.pageToken,
          })
        : clean({
            [legacyRpc(d) ? "id" : "taskId"]: t.taskId,
            [legacyRpc(d) ? "pushNotificationConfigId" : "id"]: t.id,
            pageSize: t.pageSize,
            pageToken: t.pageToken,
            metadata: t.metadata,
            tenant: t.tenant,
          });
      break;
    }
    case "GetExtendedAgentCard":
      params = clean({ tenant: p.tenant });
      break;
  }
  decodeA2ARequest(method, params, d, overrides);
  return { method, params };
}

/** Validates a result against its operation before the typed boundary assertion. */
export function decodeA2AResult<M extends A2AMethod>(
  method: M,
  value: unknown,
  d: A2ADialect,
  overrides?: Partial<A2ALimits>,
): A2AResults[M] {
  const l = a2aLimits(overrides);
  a2aMethodName(method, d.version);
  checked(value, l);
  let result: A2AResults[A2AMethod];
  switch (method) {
    case "SendMessage": {
      const event = decodeA2AEvent(value, d, l);
      if (event.kind !== "task" && event.kind !== "message") return invalid();
      result = event;
      break;
    }
    case "SendStreamingMessage":
    case "SubscribeToTask":
      result = decodeA2AEvent(value, d, l);
      break;
    case "GetTask":
    case "CancelTask":
      result = taskFrom(value, d, l);
      break;
    case "ListTasks": {
      const p = obj(value);
      result = {
        tasks: list(p.tasks, l.items).map((t) => taskFrom(t, d, l)),
        nextPageToken: str(p.nextPageToken, 2048, true),
        pageSize: integer(p.pageSize, 0, 100),
        totalSize: integer(p.totalSize),
      };
      break;
    }
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
      result = pushFrom(value, d, true);
      break;
    case "ListTaskPushNotificationConfigs": {
      const p = legacyRpc(d) ? undefined : obj(value);
      result = {
        configs: list(p ? (p.configs ?? []) : value, l.items).map((c) => pushFrom(c, d, true)),
        nextPageToken: p && optionalString(p.nextPageToken),
      };
      break;
    }
    case "DeleteTaskPushNotificationConfig":
      if (value !== null && (legacyRpc(d) || Object.keys(obj(value)).length)) return invalid();
      result = null;
      break;
    case "GetExtendedAgentCard":
      result = decodeA2AAgentCard(value, d.version, l);
      break;
  }
  // Each switch branch above validates the matching result, without a generic JSON cast.
  return result as A2AResults[M];
}

export type A2AResponse = { [M in A2AMethod]: { method: M; result: A2AResults[M] } }[A2AMethod];
export function encodeA2AResult(response: A2AResponse, d: A2ADialect): A2AJson {
  let result: A2AJson;
  switch (response.method) {
    case "SendMessage":
    case "SendStreamingMessage":
    case "SubscribeToTask":
      result = encodeA2AEvent(response.result, d);
      break;
    case "GetTask":
    case "CancelTask":
      result = taskTo(response.result, d);
      break;
    case "ListTasks":
      result = { ...response.result, tasks: response.result.tasks.map((t) => taskTo(t, d)) };
      break;
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
      result = pushTo(response.result, d, true);
      break;
    case "ListTaskPushNotificationConfigs": {
      const configs = response.result.configs.map((p) => pushTo(p, d, true));
      result = legacyRpc(d)
        ? configs
        : clean({ configs, nextPageToken: response.result.nextPageToken });
      break;
    }
    case "DeleteTaskPushNotificationConfig":
      result = legacyRpc(d) ? null : {};
      break;
    case "GetExtendedAgentCard":
      if (response.result.version !== d.version) return unsupported();
      result = response.result.document;
      break;
  }
  decodeA2AResult(response.method, result, d);
  return result;
}

export type A2ARpcId = string | number;
function rpcId(value: unknown): A2ARpcId {
  if (typeof value === "string") return str(value, 512);
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return invalid();
}
export function decodeA2ARpcRequest(
  value: unknown,
  version: A2AVersion,
  overrides?: Partial<A2ALimits>,
): { id: A2ARpcId; request: A2ARequest } {
  const p = input(value, a2aLimits(overrides));
  if (p.jsonrpc !== "2.0") throw new A2AError("protocol", { code: -32600 });
  return {
    id: rpcId(p.id),
    request: decodeA2ARequest(
      str(p.method, 128),
      p.params ?? {},
      { version, binding: "JSONRPC" },
      overrides,
    ),
  };
}
export function decodeA2ARpcResponse(
  value: unknown,
  expectedId: A2ARpcId,
  overrides?: Partial<A2ALimits>,
): A2AJson {
  const p = input(value, a2aLimits(overrides));
  if (p.jsonrpc !== "2.0" || (p.id !== expectedId && !(p.id === null && Object.hasOwn(p, "error"))))
    return invalid();
  if (oneOf(p, ["result", "error"]) === "error") {
    const error = obj(p.error);
    const code = integer(error.code, -2_147_483_648);
    str(error.message, A2A_LIMITS.textChars, true);
    throw new A2AError("protocol", { code });
  }
  return p.result!;
}

const protocolErrors: Record<number, [string, string, number]> = {
  [-32700]: ["Invalid JSON payload", "JSON_PARSE_ERROR", 400],
  [-32600]: ["Invalid request", "INVALID_REQUEST", 400],
  [-32601]: ["Method not found", "METHOD_NOT_FOUND", 404],
  [-32602]: ["Invalid parameters", "INVALID_PARAMS", 400],
  [-32603]: ["Internal error", "INTERNAL_ERROR", 500],
  [-32001]: ["Task not found", "TASK_NOT_FOUND", 404],
  [-32002]: ["Task cannot be canceled", "TASK_NOT_CANCELABLE", 400],
  [-32003]: ["Push notifications are not supported", "PUSH_NOTIFICATION_NOT_SUPPORTED", 400],
  [-32004]: ["Operation is not supported", "UNSUPPORTED_OPERATION", 400],
  [-32005]: ["Content type is not supported", "CONTENT_TYPE_NOT_SUPPORTED", 400],
  [-32006]: ["Invalid agent response", "INVALID_AGENT_RESPONSE", 500],
  [-32007]: ["Extended agent card is not configured", "EXTENDED_AGENT_CARD_NOT_CONFIGURED", 400],
  [-32008]: ["Required extension is not supported", "EXTENSION_SUPPORT_REQUIRED", 400],
  [-32009]: ["Version is not supported", "VERSION_NOT_SUPPORTED", 400],
};
export function encodeA2AError(
  code: number,
  d: A2ADialect,
  requestId: A2ARpcId | null = null,
): { status: number; body: A2AObject } {
  code = protocolErrors[code] ? code : -32603;
  const [message, reason, status] = protocolErrors[code]!;
  if (d.binding === "JSONRPC")
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: requestId,
        error: { code, message },
      },
    };
  if (legacyRest(d)) return { status, body: { code, message } };
  return {
    status,
    body: {
      error: {
        code: status,
        message,
        status:
          status === 404
            ? "NOT_FOUND"
            : status === 500
              ? "INTERNAL"
              : [-32002, -32003, -32004, -32007, -32008, -32009].includes(code)
                ? "FAILED_PRECONDITION"
                : "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            domain: "a2a-protocol.org",
            reason,
          },
        ],
      },
    },
  };
}
export function decodeA2AHttpError(
  value: unknown,
  status: number,
  overrides?: Partial<A2ALimits>,
): A2AError {
  const p = input(value, a2aLimits(overrides));
  const e = obj(p.error ?? p);
  // Some legacy REST servers send a JSON-RPC error object without its envelope.
  if (typeof e.code === "number" && e.code < 0 && Number.isSafeInteger(e.code))
    return new A2AError("protocol", { code: e.code, status });
  for (const detail of Array.isArray(e.details) ? e.details : []) {
    const entry = obj(detail);
    if (
      entry["@type"] !== "type.googleapis.com/google.rpc.ErrorInfo" ||
      entry.domain !== "a2a-protocol.org"
    )
      continue;
    const found = Object.entries(protocolErrors).find(([, data]) => data[1] === entry.reason);
    if (found) return new A2AError("protocol", { code: Number(found[0]), status });
  }
  return new A2AError("http", { status });
}

/** One observation, not a durable run. Closing it never sends CancelTask. */
export function createA2AStreamTracker(
  expected: { taskId?: string; contextId?: string } = {},
  maxResultBytes = 1024 * 1024,
  observation?: { method: "SendStreamingMessage" | "SubscribeToTask"; version: A2AVersion },
): { accept(event: A2AEvent): boolean } {
  integer(maxResultBytes, 1);
  // A 0.3 resubscription may send only updates, without repeating the known task.
  const updatesFirst =
    observation?.method === "SubscribeToTask" && observation.version === "0.3" && !!expected.taskId;
  let taskId = expected.taskId;
  let contextId = expected.contextId;
  let started = false;
  let closed = false;
  // Keep sizes and identity, not another copy of all streamed output. Tiny deltas
  // must not repeatedly copy and serialize the entire answer.
  const artifacts = new Map<
    string,
    { header: A2AObject; partsBytes: number; bytes: number; closed: boolean }
  >();
  const encoder = new TextEncoder();
  let totalBytes = 0;
  function record(artifact: A2AArtifact, append = false, lastChunk = false): void {
    const old = artifacts.get(artifact.artifactId);
    if (append && (!old || old.closed)) return invalid();
    const header = {
      ...(append ? old?.header : undefined),
      ...clean({
        artifactId: artifact.artifactId,
        name: artifact.name,
        description: artifact.description,
        metadata: artifact.metadata,
        extensions: artifact.extensions,
      }),
    };
    const partsBytes =
      encoder.encode(JSON.stringify(artifact.parts)).byteLength -
      2 +
      (append && old ? old.partsBytes + 1 : 0);
    const bytes = encoder.encode(JSON.stringify({ ...header, parts: [] })).byteLength + partsBytes;
    totalBytes += bytes - (old?.bytes ?? 0);
    artifacts.set(artifact.artifactId, { header, partsBytes, bytes, closed: lastChunk });
  }
  function bound(): void {
    if (2 + totalBytes + Math.max(0, artifacts.size - 1) > maxResultBytes)
      throw new A2AError("limit");
  }
  return {
    accept(event) {
      if (closed) return invalid();
      if (!started && event.kind !== "task" && event.kind !== "message" && !updatesFirst)
        return invalid();
      if (event.kind === "message") {
        if (started || event.role !== "agent") return invalid();
        if ((taskId && event.taskId !== taskId) || (contextId && event.contextId !== contextId))
          return invalid();
        if (new TextEncoder().encode(JSON.stringify(event)).byteLength > maxResultBytes)
          throw new A2AError("limit");
        closed = true;
        return true;
      }
      const receivedId = event.kind === "task" ? event.id : event.taskId;
      if (
        (taskId && receivedId !== taskId) ||
        (contextId && event.contextId && contextId !== event.contextId)
      )
        return invalid();
      taskId = receivedId;
      contextId ??= event.contextId;
      started = true;
      if (event.kind === "task") {
        artifacts.clear();
        totalBytes = 0;
        for (const artifact of event.artifacts ?? []) record(artifact);
        closed = a2aStateClosed(event.status.state);
      } else if (event.kind === "status-update") {
        closed = a2aStateClosed(event.status.state);
      } else {
        record(event.artifact, event.append, event.lastChunk);
      }
      bound();
      return closed;
    },
  };
}
