/** Stateful A2A specialists use the SDK child and request journals, never a model adapter.
 * Input-required mapping follows Microsoft Agent Framework (MIT); artifact replacement and
 * parent continuation follow Mastra and CrewAI (Apache-2.0/MIT). See THIRD_PARTY_NOTICES.md.
 */
import { parseJsonAnswer, sleep } from "@providerkit/core";
import {
  AGENT_RUNTIME,
  defineDelegation,
  specialistFailures,
  type Delegation,
  type NodeRuntime,
  type SpecialistToolOptions,
} from "../delegation.ts";
import { readInput, readContent } from "../input.ts";
import { RequestJournal, isAsk, requestHash } from "../request.ts";
import {
  checkOptions,
  checkTree,
  copyData,
  equalData,
  immutableCopy,
  inlineBytes,
  isAskRecord,
  isId,
  isImageMime,
  isRecord,
  isState,
  isTreeInfo,
  isTurnContent,
  readTreeLimits,
} from "../snapshot.ts";
import {
  authorizeTree,
  emitEvent,
  ExecutionTree,
  fail,
  Halt,
  openRequests,
  readAnswers,
  snapshots,
  stopRequests,
  treeUsage,
  untilAbort,
  type ExecutionScope,
} from "../tree.ts";
import type {
  AgentInput,
  AskRecord,
  Decision,
  PendingRequest,
  QuestionAsk,
  RequestProblem,
  ResultSchema,
  ResumeOptions,
  RunOptions,
  RunSnapshot,
  RunState,
  ToolRequest,
  TreeLimits,
  TreeNode,
  UserContent,
} from "../types.ts";
import { createA2AClient, fetchA2AAgentCard, type A2AClientOptions } from "./client.ts";
import { checkA2ACardEndpoints, selectA2AInterface } from "./policy.ts";
import {
  A2AError,
  a2aStateClosed,
  decodeA2AAgentCard,
  decodeA2AMessage,
  encodeA2AMessage,
  parseA2AJson,
  type A2AAgentCard,
  type A2AEvent,
  type A2AMessage,
  type A2APart,
  type A2AState,
} from "./wire.ts";

export interface RemoteLimits {
  /** Outbound messages, not model calls. */
  turns: number;
  elapsedMs: number;
  inlineBytes: number;
  resultBytes: number;
}
export interface RemoteAgentOptions<T = string> extends Pick<
  A2AClientOptions,
  | "version"
  | "binding"
  | "policy"
  | "headers"
  | "token"
  | "fetch"
  | "extensions"
  | "timeoutMs"
  | "idleMs"
> {
  id: string;
  /** Change when hidden endpoint/auth policy or output validation changes. */
  agentVersion: string;
  card: string | A2AAgentCard;
  verifyCard?: Parameters<typeof fetchA2AAgentCard>[1]["verifyCard"];
  updates?: "stream" | "poll";
  inputRequired?: "ask" | "parent" | "fail";
  /** Opt in to inline image output. Requires output to validate { content: UserContent }.
   * Return text/image parts from the validator to forward images through asTool.
   * URLs and other files stay labels; no peer URL is fetched. */
  includeImages?: boolean;
  output?: ResultSchema<T>;
  limits?: Partial<RemoteLimits>;
  treeLimits?: Partial<TreeLimits>;
}
export interface RemoteInput {
  input: UserContent;
  /** Root-scoped handle from a prior parent-routed question, not a peer task id. */
  continue?: string;
}
export interface RemotePending {
  kind: "input_required";
  handle: string;
  /** Untrusted peer question. Never an approval or capability grant. */
  question: string;
}
export interface RemoteSend {
  id: string;
  attemptId: string;
  status: "running" | "accepted";
  /** Exact intent, recorded before dispatch. Never replayed, even if delivery is unknown. */
  message: A2AMessage;
  answers: string[];
  asks?: AskRecord[];
}
export interface RemoteJournal {
  endpoint: {
    url: string;
    version: A2AClientOptions["version"];
    binding: A2AClientOptions["binding"];
    streaming: boolean;
    tenant?: string;
  };
  taskId?: string;
  contextId?: string;
  sends: RemoteSend[];
  /** Earlier messages in this parent-continuation chain, counted against turns. */
  priorTurns: number;
  /** A bounded read retry, scheduled by the existing host wake/continuation path. */
  wakeAt?: number;
  state?: A2AState;
  /** Allowlisted response parts only. No peer history, metadata or error body. */
  artifacts: { artifactId: string; parts: A2APart[] }[];
  question?: { messageId: string; structured: boolean; asks: QuestionAsk[] };
  fallback: A2APart[];
  cancel?: { id: string; attemptId: string; status: "running" | "accepted"; state?: A2AState };
}
export interface RemoteSnapshot {
  kind: "remote";
  format: 3;
  agentId: string;
  version: string;
  runId: string;
  attemptId: string;
  startedAt: number;
  definition: Record<string, unknown>;
  input: RemoteInput;
  limits: RemoteLimits;
  tree: RunSnapshot["tree"];
  remote: RemoteJournal;
  state: RunState;
}
export interface RemoteReceipt {
  kind: "remote";
  action: "send" | "cancel";
  id: string;
  attemptId: string;
  status: "running" | "accepted";
  billing: "unknown";
  taskId?: string;
  contextId?: string;
}
export type RemoteOutcome<T = string> = {
  runId: string;
  attemptId: string;
  treeUsage: ReturnType<typeof treeUsage>;
  receipts: RemoteReceipt[];
  snapshot: RemoteSnapshot;
} & (
  | Exclude<RunState, { status: "running" | "completed" | "suspended" }>
  | { status: "completed"; output: T | RemotePending }
  | {
      status: "suspended";
      requests: (PendingRequest & { problem?: RequestProblem })[];
      wakeAt?: number;
    }
);
export interface RemoteRuntime<T> extends NodeRuntime<RemoteOutcome<T>> {
  configuration(): Record<string, unknown>;
  prepare(input: unknown): RemoteInput;
  open(input: AgentInput, options: RunOptions, runId: string): Promise<RemoteSnapshot>;
  create(
    input: RemoteInput,
    runId: string,
    tree?: RunSnapshot["tree"],
    options?: RunOptions,
    root?: TreeNode,
  ): Promise<RemoteSnapshot>;
  restore(raw: unknown, tree?: RunSnapshot["tree"]): RemoteSnapshot;
}
export interface RemoteAgent<T = string> {
  readonly kind: "remote";
  readonly id: string;
  readonly version: string;
  run(input: AgentInput, options?: RunOptions): Promise<RemoteOutcome<T>>;
  resume(snapshot: unknown, options: ResumeOptions): Promise<RemoteOutcome<T>>;
  /** Explicit host command. AbortSignal only detaches local work, never sends CancelTask.
   * Inspect snapshot.remote.cancel.state: acceptance alone does not prove cancellation. */
  cancel(snapshot: unknown, options: ResumeOptions): Promise<RemoteSnapshot>;
  asTool(options: SpecialistToolOptions<T | RemotePending>): Delegation;
  readonly [AGENT_RUNTIME]: RemoteRuntime<T>;
}

const dialect = { version: "1.0", binding: "JSONRPC" } as const;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function node(value: TreeNode): RemoteSnapshot {
  if (value.kind !== "remote") throw new TypeError("Expected a remote node.");
  return value;
}
function content(input: unknown): UserContent {
  const read = readInput(input, "caller");
  if (read.history.length)
    throw new TypeError(
      "A2A accepts one user message, not local conversation history. Pass only the text or media you intend to share.",
    );
  return read.input;
}
function remoteInput(value: unknown): RemoteInput {
  if (
    !isRecord(value) ||
    !isTurnContent(value.input) ||
    Object.keys(value).some((key) => key !== "input" && key !== "continue") ||
    (value.continue !== undefined && !isId(value.continue))
  )
    throw new TypeError("Pass remote input and an optional continuation handle.");
  return copyData({
    input: readContent(value.input, "The remote message"),
    ...(value.continue ? { continue: value.continue } : {}),
  });
}
function readLimits(value: Partial<RemoteLimits> = {}): RemoteLimits {
  if (
    Object.keys(value).some(
      (key) => !["turns", "elapsedMs", "inlineBytes", "resultBytes"].includes(key),
    )
  )
    throw new TypeError("Remote limits are turns, elapsedMs, inlineBytes and resultBytes.");
  const limits = {
    turns: 12,
    elapsedMs: 300_000,
    inlineBytes: 5_000_000,
    resultBytes: 1_048_576,
    ...value,
  };
  if (
    Object.entries(limits).some(
      ([key, n]) => !Number.isSafeInteger(n) || n < (key === "inlineBytes" ? 0 : 1),
    ) ||
    limits.elapsedMs > 2_147_483_647
  )
    throw new TypeError("Use bounded whole-number remote limits.");
  return limits;
}
function checkRunOptions(options: RunOptions, resume = false): void {
  checkOptions(options, resume ? "resume" : "run");
  if (
    options.session ||
    options.historyLimit !== undefined ||
    options.prepareHistory ||
    options.enabledTools ||
    options.modelSettings ||
    options.memory ||
    options.providerSessionId !== undefined
  )
    throw new TypeError(
      "Remote agents do not accept local sessions, memory, model settings, provider sessions or tool selection.",
    );
}
function safeParts(parts: A2APart[], includeImages = false): A2APart[] {
  return parts.map((part) => {
    switch (part.kind) {
      case "text":
        return { kind: "text", text: part.text };
      case "data":
        return { kind: "data", data: copyData(part.data) };
      // Inline images require a host output contract. Peer URLs are never fetched.
      case "raw":
        if (includeImages && isImageMime(part.mediaType))
          return {
            kind: "raw",
            raw: part.raw
              .replaceAll("-", "+")
              .replaceAll("_", "/")
              .padEnd(Math.ceil(part.raw.length / 4) * 4, "="),
            mediaType: part.mediaType,
          };
        return { kind: "text", text: `[File: ${part.filename ?? part.mediaType ?? "attachment"}]` };
      case "url":
        return { kind: "text", text: `[File: ${part.filename ?? part.mediaType ?? "attachment"}]` };
    }
  });
}
function imageBytes(parts: A2APart[]): number {
  return inlineBytes(
    [],
    parts.flatMap((part) =>
      part.kind === "raw" && isImageMime(part.mediaType)
        ? [{ type: "image" as const, mimeType: part.mediaType, data: part.raw }]
        : [],
    ),
  );
}
function text(parts: A2APart[]): string {
  return parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("");
}
function resultParts(snapshot: RemoteSnapshot): A2APart[] {
  return snapshot.remote.artifacts.length
    ? snapshot.remote.artifacts.flatMap((artifact) => artifact.parts)
    : snapshot.remote.fallback;
}
function candidate(snapshot: RemoteSnapshot): unknown {
  if (snapshot.remote.state === "input_required" && snapshot.definition.inputRequired === "parent")
    return {
      kind: "input_required",
      handle: snapshot.runId,
      question:
        snapshot.remote.question?.asks.map((ask) => ask.message).join("\n") ??
        "The remote agent needs an answer.",
    };
  const parts = resultParts(snapshot);
  if (snapshot.definition.includeImages)
    return {
      content: readContent(
        parts.flatMap<unknown>((part) =>
          part.kind === "text"
            ? [{ type: "text", text: part.text }]
            : part.kind === "raw"
              ? [{ type: "image", mimeType: part.mediaType, data: part.raw }]
              : [],
        ),
        "The remote output",
      ),
    };
  return snapshot.definition.output
    ? (parts.find((part) => part.kind === "data")?.data ?? parseJsonAnswer(text(parts)))
    : text(parts);
}
function question(message: A2AMessage | undefined): RemoteJournal["question"] {
  if (!message)
    return {
      messageId: "input",
      structured: false,
      asks: [
        {
          type: "question",
          key: "input",
          message: "The remote agent needs an answer.",
          freeText: true,
        },
      ],
    };
  const data = message.parts.find(
    (part) => part.kind === "data" && isRecord(part.data) && Array.isArray(part.data.requests),
  );
  if (data?.kind === "data" && isRecord(data.data) && Array.isArray(data.data.requests)) {
    const asks = data.data.requests.map((request) => {
      if (!isRecord(request) || request.type !== "question" || !isId(request.id))
        fail(
          "remote_request_unsupported",
          "The remote service requested an action this host cannot authorize. Ask its operator to continue it.",
        );
      const ask = {
        type: "question",
        key: request.id,
        message: request.message,
        ...(request.choices !== undefined ? { choices: request.choices } : {}),
        ...(request.multiple !== undefined ? { multiple: request.multiple } : {}),
        ...(request.freeText !== undefined ? { freeText: request.freeText } : {}),
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
      };
      if (!isAsk(ask) || ask.type !== "question") throw new A2AError("invalid");
      return ask;
    });
    if (!asks.length || new Set(asks.map((ask) => ask.key)).size !== asks.length)
      throw new A2AError("invalid");
    return { messageId: message.messageId, structured: true, asks };
  }
  return {
    messageId: message.messageId,
    structured: false,
    asks: [
      {
        type: "question",
        key: message.messageId,
        message:
          text(safeParts(message.parts)).slice(0, 4096) || "The remote agent needs an answer.",
        freeText: true,
      },
    ],
  };
}

function answerParts(records: AskRecord[], structured: boolean): A2APart[] {
  const answers = Object.fromEntries(
    records.map((record) => {
      if (record.decision?.type !== "answer" || record.request.ask.type !== "question")
        throw new TypeError("Expected an authenticated remote answer.");
      return [record.request.ask.key, { type: "answer", answer: record.decision.answer }];
    }),
  );
  const parts: A2APart[] = structured
    ? [{ kind: "data", data: parseA2AJson(JSON.stringify({ answers })) }]
    : [];
  const plain = records
    .flatMap((record) =>
      record.decision?.type === "answer" && record.decision.answer.text
        ? [record.decision.answer.text]
        : [],
    )
    .join("\n");
  if (plain) parts.unshift({ kind: "text", text: plain });
  return parts;
}

/** Structural checks are not authorization. A host must compare authoritative snapshots. */
export function isRemoteSnapshot(raw: unknown): raw is RemoteSnapshot {
  if (
    !isRecord(raw) ||
    raw.kind !== "remote" ||
    raw.format !== 3 ||
    ![raw.agentId, raw.version, raw.runId, raw.attemptId].every(isId) ||
    typeof raw.startedAt !== "number" ||
    !Number.isSafeInteger(raw.startedAt) ||
    raw.startedAt <= 0 ||
    !isRecord(raw.definition) ||
    !isRecord(raw.limits) ||
    !isTreeInfo(raw.tree) ||
    !isState(raw.state) ||
    !isRecord(raw.remote) ||
    !isRecord(raw.remote.endpoint) ||
    !isId(raw.remote.endpoint.url) ||
    !["1.0", "0.3"].includes(String(raw.remote.endpoint.version)) ||
    !["JSONRPC", "HTTP+JSON"].includes(String(raw.remote.endpoint.binding)) ||
    Object.keys(raw.remote.endpoint).some(
      (key) => !["url", "version", "binding", "streaming", "tenant"].includes(key),
    ) ||
    typeof raw.remote.endpoint.streaming !== "boolean" ||
    (raw.remote.endpoint.tenant !== undefined && !isId(raw.remote.endpoint.tenant)) ||
    typeof raw.remote.priorTurns !== "number" ||
    !Number.isSafeInteger(raw.remote.priorTurns) ||
    raw.remote.priorTurns < 0 ||
    (raw.remote.wakeAt !== undefined &&
      (typeof raw.remote.wakeAt !== "number" ||
        !Number.isSafeInteger(raw.remote.wakeAt) ||
        raw.remote.wakeAt < raw.startedAt ||
        !isId(raw.remote.taskId))) ||
    !Array.isArray(raw.remote.sends) ||
    !Array.isArray(raw.remote.artifacts) ||
    !Array.isArray(raw.remote.fallback)
  )
    return false;
  try {
    remoteInput(raw.input);
    const { turns, elapsedMs, inlineBytes, resultBytes } = raw.limits;
    if (
      typeof turns !== "number" ||
      typeof elapsedMs !== "number" ||
      typeof inlineBytes !== "number" ||
      typeof resultBytes !== "number"
    )
      return false;
    readLimits({ turns, elapsedMs, inlineBytes, resultBytes });
    for (const send of raw.remote.sends) {
      if (
        !isRecord(send) ||
        !isId(send.id) ||
        !isId(send.attemptId) ||
        !["running", "accepted"].includes(String(send.status)) ||
        !Array.isArray(send.answers) ||
        !send.answers.every(isId) ||
        new Set(send.answers).size !== send.answers.length ||
        (send.asks !== undefined && (!Array.isArray(send.asks) || !send.asks.every(isAskRecord)))
      )
        return false;
      checkedMessage(send.message);
    }
    const includeImages = raw.definition.includeImages === true;
    const parts = (value: unknown) => {
      if (Array.isArray(value) && !value.length) return true;
      const message = checkedMessage({
        kind: "message",
        messageId: "check",
        role: "agent",
        parts: value,
      });
      return equalData(message.parts, safeParts(message.parts, includeImages));
    };
    if (!parts(raw.remote.fallback)) return false;
    const ids = new Set<string>();
    for (const artifact of raw.remote.artifacts) {
      if (
        !isRecord(artifact) ||
        !isId(artifact.artifactId) ||
        ids.has(artifact.artifactId) ||
        !parts(artifact.parts)
      )
        return false;
      ids.add(artifact.artifactId);
    }
    if (raw.remote.taskId !== undefined && !isId(raw.remote.taskId)) return false;
    if (raw.remote.contextId !== undefined && !isId(raw.remote.contextId)) return false;
    if (
      raw.remote.question !== undefined &&
      (!isRecord(raw.remote.question) ||
        !isId(raw.remote.question.messageId) ||
        typeof raw.remote.question.structured !== "boolean" ||
        !Array.isArray(raw.remote.question.asks) ||
        !raw.remote.question.asks.length ||
        !raw.remote.question.asks.every((ask) => isAsk(ask) && ask.type === "question"))
    )
      return false;
    if (
      raw.remote.cancel !== undefined &&
      (!isRecord(raw.remote.cancel) ||
        !isId(raw.remote.cancel.id) ||
        !isId(raw.remote.cancel.attemptId) ||
        !["running", "accepted"].includes(String(raw.remote.cancel.status)) ||
        (raw.remote.cancel.state !== undefined && !isRemoteState(raw.remote.cancel.state)))
    )
      return false;
    if (raw.remote.state !== undefined && !isRemoteState(raw.remote.state)) return false;
    return true;
  } catch {
    return false;
  }
}
function isRemoteState(value: unknown): value is A2AState {
  return [
    "unknown",
    "submitted",
    "working",
    "input_required",
    "auth_required",
    "completed",
    "failed",
    "canceled",
    "rejected",
  ].includes(String(value));
}
// Canonical messages are rebuilt at a typed trust boundary instead of asserted into wire types.
function checkedMessage(raw: unknown): A2AMessage {
  if (!isRecord(raw) || !Array.isArray(raw.parts)) throw new TypeError("Invalid remote message.");
  const message = decodeA2AMessage(
    parseA2AJson(
      JSON.stringify({
        ...raw,
        role: raw.role === "user" ? "ROLE_USER" : raw.role === "agent" ? "ROLE_AGENT" : raw.role,
        parts: raw.parts.map((part) => {
          if (!isRecord(part)) throw new TypeError("Invalid remote part.");
          const fields = {
            mediaType: part.mediaType,
            filename: part.filename,
            metadata: part.metadata,
          };
          if (part.kind === "text") return { ...fields, text: part.text };
          if (part.kind === "data") return { ...fields, data: part.data };
          if (part.kind === "raw") return { ...fields, raw: part.raw };
          throw new TypeError("Saved remote messages cannot carry peer URLs.");
        }),
      }),
    ),
    dialect,
  );
  if (!equalData(raw, message)) throw new TypeError("Invalid canonical remote message.");
  return message;
}
export function checkRemoteSnapshot(snapshot: RemoteSnapshot): void {
  if (!isRemoteSnapshot(snapshot)) throw new TypeError("Invalid remote snapshot.");
  const journal = snapshot.remote;
  if (
    (!snapshot.input.continue && journal.priorTurns !== 0) ||
    journal.sends.length + journal.priorTurns > snapshot.limits.turns ||
    inlineBytes([], snapshot.input.input) > snapshot.limits.inlineBytes ||
    bytes([journal.artifacts, journal.fallback, journal.question]) > snapshot.limits.resultBytes ||
    imageBytes([...journal.fallback, ...journal.artifacts.flatMap((artifact) => artifact.parts)]) >
      snapshot.limits.inlineBytes
  )
    throw new TypeError("The remote journal exceeds its limits.");
  if (
    journal.state !== undefined &&
    ![
      "unknown",
      "submitted",
      "working",
      "input_required",
      "auth_required",
      "completed",
      "failed",
      "canceled",
      "rejected",
    ].includes(journal.state)
  )
    throw new TypeError("Invalid remote state.");
  for (const [index, send] of journal.sends.entries()) {
    if (
      send.id !== `${snapshot.runId}/send/${index + 1}` ||
      send.message.messageId !== `${send.attemptId}/send/${index + 1}` ||
      send.message.role !== "user" ||
      (index > 0 &&
        (send.message.taskId !== journal.taskId || send.message.contextId !== journal.contextId)) ||
      send.message.metadata !== undefined ||
      send.message.extensions !== undefined ||
      send.message.referenceTaskIds !== undefined ||
      (send.message.taskId !== undefined && send.message.taskId !== journal.taskId) ||
      (send.message.contextId !== undefined && send.message.contextId !== journal.contextId) ||
      (index > 0 && journal.sends[index - 1]?.status !== "accepted")
    )
      throw new TypeError("Invalid remote send identity or order.");
    for (const [i, record] of (send.asks ?? []).entries()) {
      const call = record.request.call;
      if (
        !call ||
        record.request.step ||
        record.request.ask.type !== "question" ||
        record.request.id !== `${send.id}/ask/${i + 1}` ||
        call.operationId !== send.id ||
        call.runId !== snapshot.runId ||
        call.agentId !== snapshot.agentId ||
        call.version !== snapshot.version ||
        call.attemptId !== send.attemptId ||
        call.call.name !== "remote_input" ||
        call.call.id !== send.id ||
        record.request.createdAt < snapshot.startedAt
      )
        throw new TypeError("Invalid remote question receipt.");
    }
    if (index === 0 && send.answers.length)
      throw new TypeError("The first remote send cannot answer a local request.");
    if (index > 0) {
      const prior = journal.sends[index - 1]?.asks ?? [];
      const records = send.answers.map((id) => {
        const record = prior.find((ask) => ask.request.id === id);
        if (!record || record.decision?.type !== "answer")
          throw new TypeError("A remote answer has no authenticated request receipt.");
        return record;
      });
      if (
        !records.length ||
        !equalData(
          send.message.parts,
          answerParts(
            records,
            send.message.parts.some((part) => part.kind === "data"),
          ),
        ) ||
        (send.status === "accepted" &&
          !equalData(
            send.answers,
            prior.filter((record) => !record.closed).map((record) => record.request.id),
          ))
      )
        throw new TypeError("The remote message does not match its answer receipts.");
    }
  }
  if (
    journal.question &&
    (journal.state !== "input_required" ||
      !journal.taskId ||
      new Set(journal.question.asks.map((ask) => ask.key)).size !== journal.question.asks.length)
  )
    throw new TypeError("Invalid remote question state.");
  if (journal.state === "input_required" && !journal.question)
    throw new TypeError("The remote question is missing.");
  if (
    journal.cancel &&
    (journal.cancel.id !== `${snapshot.runId}/cancel` ||
      !journal.taskId ||
      (journal.cancel.status === "accepted" && journal.cancel.state === undefined))
  )
    throw new TypeError("Invalid remote cancellation receipt.");
  if (
    snapshot.state.status === "completed" &&
    (!journal.sends.length ||
      journal.sends.at(-1)?.status !== "accepted" ||
      (journal.state !== "completed" &&
        !(journal.state === "input_required" && snapshot.definition.inputRequired === "parent")) ||
      !equalData(snapshot.state.candidate, candidate(snapshot)))
  )
    throw new TypeError("The remote result does not match its journal.");
}
export function checkRemoteProgress(previous: RemoteSnapshot, next: RemoteSnapshot): void {
  if (
    previous.agentId !== next.agentId ||
    previous.remote.priorTurns !== next.remote.priorTurns ||
    !equalData(previous.remote.endpoint, next.remote.endpoint) ||
    (previous.remote.taskId !== undefined && previous.remote.taskId !== next.remote.taskId) ||
    (previous.remote.contextId !== undefined && previous.remote.contextId !== next.remote.contextId)
  )
    throw new TypeError("The host changed a remote endpoint, task or context.");
  for (const [i, send] of previous.remote.sends.entries()) {
    const saved = next.remote.sends[i];
    if (
      !saved ||
      saved.id !== send.id ||
      saved.attemptId !== send.attemptId ||
      !equalData(saved.message, send.message) ||
      !equalData(saved.answers, send.answers) ||
      (send.status === "accepted" && saved.status !== "accepted")
    )
      throw new TypeError("The host erased or replaced a remote send.");
    for (const [j, record] of (send.asks ?? []).entries()) {
      const later = saved.asks?.[j];
      if (
        !later ||
        !equalData(record.request, later.request) ||
        (record.decision && !equalData(record.decision, later.decision)) ||
        (record.closed && record.closed !== later.closed)
      )
        throw new TypeError("The host erased or replaced a remote request.");
    }
  }
  const cancel = previous.remote.cancel;
  if (
    cancel &&
    (!next.remote.cancel ||
      !equalData(
        { ...cancel, status: next.remote.cancel.status, state: next.remote.cancel.state },
        next.remote.cancel,
      ) ||
      (cancel.status === "accepted" && !equalData(cancel, next.remote.cancel)))
  )
    throw new TypeError("The host erased or replaced a remote cancellation.");
  if (
    previous.state.status === "completed" &&
    !equalData({ ...previous.remote, cancel: next.remote.cancel }, next.remote)
  )
    throw new TypeError("The host changed a completed remote result.");
}

export function defineRemoteAgent<T>(
  options: RemoteAgentOptions<T> & { output: ResultSchema<T> },
): RemoteAgent<T>;
export function defineRemoteAgent(
  options: RemoteAgentOptions<string> & { output?: undefined },
): RemoteAgent<string>;
export function defineRemoteAgent<T>(config: RemoteAgentOptions<T>): RemoteAgent<T | string> {
  if (
    !isId(config.id) ||
    !isId(config.agentVersion) ||
    typeof config.policy?.allow !== "function" ||
    !["1.0", "0.3"].includes(config.version) ||
    !["JSONRPC", "HTTP+JSON"].includes(config.binding) ||
    (config.inputRequired !== undefined &&
      !["ask", "parent", "fail"].includes(config.inputRequired)) ||
    (config.updates !== undefined && !["stream", "poll"].includes(config.updates))
  )
    throw new TypeError(
      "A remote agent needs host-owned identity, card, dialect and endpoint policy.",
    );
  if (
    Object.keys(config).some(
      (key) =>
        ![
          "id",
          "agentVersion",
          "card",
          "version",
          "binding",
          "policy",
          "headers",
          "token",
          "fetch",
          "extensions",
          "timeoutMs",
          "idleMs",
          "verifyCard",
          "updates",
          "inputRequired",
          "output",
          "includeImages",
          "limits",
          "treeLimits",
        ].includes(key),
    )
  )
    throw new TypeError(
      "An unsupported remote option was supplied. Remote sends never retry and endpoints must be selected explicitly.",
    );
  if (
    (config.includeImages !== undefined && typeof config.includeImages !== "boolean") ||
    (config.includeImages && !config.output)
  )
    throw new TypeError("Inline images require an explicit output validator.");
  if (
    config.output &&
    (!isRecord(config.output.schema) ||
      config.output.schema.type !== "object" ||
      typeof config.output.validate !== "function")
  )
    throw new TypeError("Remote output needs an object schema and a validator.");
  const { limits: _limits, treeLimits: _treeLimits, ...configuration } = config;
  const options = {
    ...configuration,
    policy: { ...config.policy },
    extensions: config.extensions && Object.freeze([...config.extensions]),
    card: typeof config.card === "string" ? config.card : immutableCopy(config.card),
  };
  const id = config.id,
    version = config.agentVersion;
  const limits = readLimits(config.limits),
    treeLimits = readTreeLimits(config.treeLimits);
  const output = config.output && {
    schema: immutableCopy(config.output.schema),
    validate: config.output.validate,
  };
  const definition = immutableCopy({
    id,
    version,
    card: options.card,
    protocol: config.version,
    binding: config.binding,
    inputRequired: config.inputRequired ?? "ask",
    updates: config.updates ?? "poll",
    includeImages: config.includeImages ?? false,
    extensions: config.extensions ?? [],
    output: output?.schema ?? null,
  });
  const validate = (value: unknown) =>
    output
      ? output.validate(copyData(value))
      : typeof value === "string"
        ? value
        : (() => {
            throw new TypeError("Expected a text remote result.");
          })();
  function client(snapshot: RemoteSnapshot) {
    return createA2AClient({
      ...options,
      endpoint: snapshot.remote.endpoint.url,
      ...snapshot.remote.endpoint,
      cardUrl: typeof options.card === "string" ? options.card : undefined,
      maxResultBytes: limits.resultBytes,
    });
  }
  function request(snapshot: RemoteSnapshot, send: RemoteSend, name = "remote_input"): ToolRequest {
    const args =
      name === "remote_send"
        ? {
            agentId: id,
            endpoint: snapshot.remote.endpoint.url,
            message: send.message,
            continuation: snapshot.input.continue ?? null,
          }
        : {
            agentId: id,
            taskId: snapshot.remote.taskId ?? null,
            continuation: snapshot.input.continue ?? null,
          };
    return {
      agentId: id,
      version,
      runId: snapshot.runId,
      attemptId: send.attemptId,
      operationId: send.id,
      call: { id: send.id, name, arguments: JSON.stringify(args) },
      arguments: args,
    };
  }
  function journal(
    snapshot: RemoteSnapshot,
    send: RemoteSend,
    opts: RunOptions,
    scope: ExecutionScope,
    signal: AbortSignal,
  ) {
    return new RequestJournal(
      send,
      request(snapshot, send),
      {
        ...opts,
        host: {
          ...opts.host,
          beforeTool: (call, decided) => authority(opts, signal, call, decided),
        },
      },
      scope,
      signal,
      () => requestHash({ id, version, endpoint: snapshot.remote.endpoint }),
    );
  }
  async function authority(
    opts: RunOptions,
    signal: AbortSignal,
    call: ToolRequest,
    decided?: { request: PendingRequest; decision: Decision },
  ): Promise<void> {
    if (!opts.host?.beforeTool)
      fail(
        "remote_authority_missing",
        "Provide host.beforeTool to authorize remote messages and cancellation.",
      );
    try {
      await untilAbort(
        Promise.resolve(
          opts.host.beforeTool(immutableCopy(call), decided && immutableCopy(decided)),
        ),
        signal,
      );
    } catch {
      signal.throwIfAborted();
      fail(
        "remote_authority_denied",
        "The host did not authorize this remote operation. Check access before continuing.",
      );
    }
    signal.throwIfAborted();
  }
  async function accept(
    snapshot: RemoteSnapshot,
    event: A2AEvent,
    scope: ExecutionScope,
    opts: RunOptions,
    sent = false,
  ) {
    const receipt = snapshot.remote;
    const taskId = event.kind === "task" ? event.id : event.taskId;
    if (receipt.taskId !== undefined && taskId !== undefined && receipt.taskId !== taskId)
      throw new A2AError("invalid");
    if (
      receipt.contextId !== undefined &&
      event.contextId !== undefined &&
      receipt.contextId !== event.contextId
    )
      throw new A2AError("invalid");
    if (event.kind === "message" && event.role !== "agent") throw new A2AError("invalid");
    const last = receipt.sends.at(-1);
    const confirmed =
      (receipt.taskId === undefined && taskId !== undefined) ||
      (receipt.contextId === undefined && event.contextId !== undefined) ||
      (last?.status === "running" && sent);
    receipt.taskId ??= taskId;
    receipt.contextId ??= event.contextId;
    if (last && sent) last.status = "accepted";
    // Semantic refusal must not erase an accepted send or the task needed to cancel it.
    if (confirmed) await scope.tree.save();
    const r = copyData(receipt);
    if (event.kind === "task" || event.kind === "status-update") {
      r.state = event.status.state;
      r.fallback = ["completed", "input_required"].includes(r.state)
        ? safeParts(event.status.message?.parts ?? [], definition.includeImages)
        : [];
      if (r.state === "input_required") r.question = question(event.status.message);
      else delete r.question;
      if (event.kind === "task")
        r.artifacts = (event.artifacts ?? []).map((a) => ({
          artifactId: a.artifactId,
          parts: safeParts(a.parts, definition.includeImages),
        }));
    } else if (event.kind === "message") {
      r.state = "completed";
      r.fallback = safeParts(event.parts, definition.includeImages);
      delete r.question;
    } else {
      const parts = safeParts(event.artifact.parts, definition.includeImages);
      const prior = r.artifacts.find((a) => a.artifactId === event.artifact.artifactId);
      if (prior) prior.parts = event.append ? [...prior.parts, ...parts] : parts;
      else r.artifacts.push({ artifactId: event.artifact.artifactId, parts });
    }
    if (bytes([r.artifacts, r.fallback, r.question]) > limits.resultBytes)
      fail(
        "remote_result_too_large",
        "The remote response exceeds this agent's byte limit. Ask for a smaller result.",
      );
    if (imageBytes([...r.fallback, ...r.artifacts.flatMap((a) => a.parts)]) > limits.inlineBytes)
      fail(
        "remote_result_too_large",
        "The remote images exceed this agent's byte limit. Ask for smaller images.",
      );
    if (!r.question) delete snapshot.remote.question;
    Object.assign(snapshot.remote, r);
    // Task/context identity is saved before any more observation or follow-up.
    await scope.tree.save();
    emitEvent(opts, {
      type: "remote_status",
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      operationId: last?.id ?? snapshot.runId,
      state: r.state ?? "working",
    });
  }
  async function answerRequests(
    raw: TreeNode,
    opts: RunOptions,
    scope: ExecutionScope,
    answers: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) {
    const snapshot = node(raw);
    if (!["running", "suspended"].includes(snapshot.state.status)) return;
    for (const send of snapshot.remote.sends) {
      const requests = journal(snapshot, send, opts, scope, signal);
      for (const record of [...(send.asks ?? [])]) {
        if (record.closed) continue;
        if (!record.decision && Object.hasOwn(answers, record.request.id))
          await requests.resolve(record, answers[record.request.id]);
        else if (!snapshot.remote.sends.some((later) => later.answers.includes(record.request.id)))
          await requests.refresh(record);
      }
    }
  }
  async function partsOf(
    input: UserContent,
    snapshot: RemoteSnapshot,
    opts: RunOptions,
    signal: AbortSignal,
  ): Promise<A2APart[]> {
    if (typeof input === "string") return [{ kind: "text", text: input }];
    const loaded = [];
    for (const part of input) {
      if (part.type !== "media") loaded.push(part);
      else {
        if (!opts.host?.loadMedia)
          fail(
            "media_host_missing",
            "Provide host.loadMedia to authorize and read this attachment.",
          );
        const data = await untilAbort(
          Promise.resolve(
            opts.host.loadMedia(immutableCopy(part), { runId: snapshot.runId, signal }),
          ),
          signal,
        );
        const mimeType = part.mimeType;
        loaded.push(
          isImageMime(mimeType)
            ? { type: "image" as const, mimeType, data }
            : { type: "file" as const, mimeType, data },
        );
      }
    }
    const checked = readContent(loaded, "The remote message");
    if (inlineBytes([], checked) > limits.inlineBytes) throw new A2AError("limit");
    return loaded.map((part) =>
      part.type === "text"
        ? { kind: "text", text: part.text }
        : { kind: "raw", raw: part.data, mediaType: part.mimeType },
    );
  }
  async function cancelTask(
    snapshot: RemoteSnapshot,
    opts: RunOptions,
    scope: ExecutionScope,
    signal: AbortSignal,
    requests?: RequestJournal,
  ): Promise<void> {
    const r = snapshot.remote;
    if (
      !r.taskId ||
      (r.state && ["completed", "failed", "canceled", "rejected"].includes(r.state)) ||
      r.cancel
    )
      return;
    const operation = {
      id: `${snapshot.runId}/cancel`,
      attemptId: snapshot.attemptId,
      status: "running" as const,
    };
    const call: ToolRequest = {
      agentId: id,
      version,
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      operationId: operation.id,
      call: {
        id: operation.id,
        name: "remote_cancel",
        arguments: JSON.stringify({ taskId: r.taskId }),
      },
      arguments: { taskId: r.taskId },
    };
    await authority(opts, signal, call);
    r.cancel = operation;
    await scope.tree.save();
    await authority(opts, signal, call);
    await requests?.recheck(requests.call);
    await requests?.assertFresh();
    signal.throwIfAborted();
    try {
      const result = await client(snapshot).call("CancelTask", { id: r.taskId }, { signal });
      if (
        result.id !== r.taskId ||
        (r.contextId !== undefined &&
          result.contextId !== undefined &&
          result.contextId !== r.contextId)
      )
        throw new A2AError("invalid");
      // A parent-routed question is a completed child result. Keep that historical result
      // immutable; the separate cancel receipt closes its continuation handle.
      if (snapshot.state.status !== "completed") await accept(snapshot, result, scope, opts);
      r.cancel = { ...operation, status: "accepted", state: result.status.state };
      await scope.tree.save();
    } catch (error) {
      if (error instanceof Halt || !(error instanceof A2AError)) throw error;
      signal.throwIfAborted();
      // Unknown cancellation stays unknown and is never sent a second time.
    }
  }
  function hydrate(raw: TreeNode): RemoteOutcome<T | string> {
    const snapshot = copyData(node(raw));
    const state = snapshot.state;
    if (state.status === "running") throw new TypeError("The remote attempt has not settled.");
    const r = snapshot.remote;
    const receipts: RemoteReceipt[] = [
      ...r.sends.map((send): RemoteReceipt => ({
        kind: "remote",
        action: "send",
        id: send.id,
        attemptId: send.attemptId,
        status: send.status,
        billing: "unknown",
        taskId: r.taskId,
        contextId: r.contextId,
      })),
      ...(r.cancel
        ? [
            {
              kind: "remote" as const,
              action: "cancel" as const,
              ...r.cancel,
              billing: "unknown" as const,
              taskId: r.taskId,
              contextId: r.contextId,
            },
          ]
        : []),
    ];
    const record = {
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      treeUsage: treeUsage(snapshot),
      receipts,
      snapshot,
    };
    if (state.status === "completed") {
      const pending = r.state === "input_required" && definition.inputRequired === "parent";
      const result: RemotePending = {
        kind: "input_required",
        handle: snapshot.runId,
        question:
          r.question?.asks.map((ask) => ask.message).join("\n") ??
          "The remote agent needs an answer.",
      };
      return {
        ...record,
        status: "completed",
        output: pending ? result : validate(state.candidate),
      };
    }
    return state.status === "suspended"
      ? { ...record, ...state, requests: openRequests(snapshot), wakeAt: r.wakeAt }
      : { ...record, ...state };
  }
  async function execute(
    raw: TreeNode,
    opts: RunOptions,
    scope: ExecutionScope,
    answers?: Readonly<Record<string, unknown>>,
  ): Promise<RemoteOutcome<T | string>> {
    const snapshot = node(raw),
      r = snapshot.remote;
    if (!["running", "suspended"].includes(snapshot.state.status)) return hydrate(snapshot);
    const timeout = new AbortController();
    const signal = AbortSignal.any([
      scope.tree.signal,
      timeout.signal,
      ...(opts.signal ? [opts.signal] : []),
    ]);
    const deadline = snapshot.startedAt + limits.elapsedMs;
    const timer = setTimeout(() => timeout.abort(), Math.max(0, deadline - Date.now()));
    let release = () => {};
    function active() {
      scope.tree.active();
      if (timeout.signal.aborted || Date.now() >= deadline)
        throw new Halt({ status: "limited", limit: "elapsedMs" });
      signal.throwIfAborted();
    }
    async function send(parts: A2APart[], answered: string[], prior?: RequestJournal) {
      active();
      if (r.sends.length + r.priorTurns >= limits.turns)
        throw new Halt({ status: "limited", limit: "turns" });
      const sendId = `${snapshot.runId}/send/${r.sends.length + 1}`;
      const entry: RemoteSend = {
        id: sendId,
        attemptId: snapshot.attemptId,
        status: "running",
        answers: answered,
        // A2A message IDs have a 128-character ceiling; nested logical run paths do not.
        message: {
          kind: "message",
          messageId: `${snapshot.attemptId}/send/${r.sends.length + 1}`,
          role: "user",
          parts,
          ...(r.taskId ? { taskId: r.taskId } : {}),
          ...(r.contextId ? { contextId: r.contextId } : {}),
        },
      };
      encodeA2AMessage(entry.message, r.endpoint);
      await authority(opts, signal, request(snapshot, entry, "remote_send"));
      await prior?.recheck(prior.call);
      r.sends.push(entry);
      delete r.question;
      r.state = "working";
      await scope.tree.save();
      active();
      await authority(opts, signal, request(snapshot, entry, "remote_send"));
      await prior?.recheck(prior.call);
      await prior?.assertFresh();
      active();
      try {
        if (definition.updates === "stream") {
          for await (const event of client(snapshot).observe(
            "SendStreamingMessage",
            { message: entry.message },
            { signal },
          ))
            await accept(snapshot, event, scope, opts, true);
        } else {
          await accept(
            snapshot,
            await client(snapshot).call(
              "SendMessage",
              { message: entry.message, configuration: { returnImmediately: true } },
              { signal },
            ),
            scope,
            opts,
            true,
          );
        }
      } catch (error) {
        if (error instanceof Halt || !(error instanceof A2AError)) throw error;
        active();
        if (!r.taskId)
          fail(
            "remote_unconfirmed",
            "The remote message may have been delivered. Reconcile it with the remote service; it will not be sent again.",
            entry.id,
          );
        // A task id permits reads, never a second send.
      }
    }
    try {
      emitEvent(opts, {
        type: "execution_start",
        kind: "remote",
        nodeId: id,
        version,
        runId: snapshot.runId,
        attemptId: snapshot.attemptId,
      });
      active();
      if (r.wakeAt !== undefined) {
        if (Date.now() < r.wakeAt) throw new Halt({ status: "suspended" });
        delete r.wakeAt;
      }
      if (scope.depth === 0 && answers)
        await answerRequests(snapshot, opts, scope, answers, signal);
      snapshot.state = { status: "running" };
      await scope.tree.save();
      release = await scope.tree.gate.acquire(signal);
      if (!r.sends.length)
        await send(await partsOf(snapshot.input.input, snapshot, opts, signal), []);
      else if (!r.taskId && r.sends.at(-1)?.status === "running")
        fail(
          "remote_unconfirmed",
          "The remote message has no confirmed task. Reconcile it; this run cannot resend it.",
        );
      let polls = 0,
        reconnects = 0;
      for (;;) {
        active();
        if (r.state && a2aStateClosed(r.state) && r.sends.at(-1)?.status === "running")
          fail(
            "remote_unconfirmed",
            "The last message may not have reached this task. Reconcile it with the remote service; it will not be sent again.",
          );
        if (r.state === "completed") {
          try {
            const value = candidate(snapshot);
            validate(value);
            snapshot.state = { status: "completed", candidate: value };
          } catch {
            fail(
              "remote_invalid_output",
              "The remote result does not match the configured output. Check its format before using it.",
            );
          }
          break;
        }
        if (r.state === "input_required") {
          if (!r.taskId) throw new A2AError("invalid");
          if (definition.inputRequired === "fail")
            fail(
              "remote_input_required",
              "The remote agent needs an answer. Enable request routing to continue.",
            );
          if (definition.inputRequired === "parent") {
            const asks = r.question?.asks ?? [];
            if (
              asks.length !== 1 ||
              asks[0]?.schema ||
              asks[0]?.choices ||
              asks[0]?.freeText === false
            )
              fail(
                "remote_request_unsupported",
                "This remote task needs multiple answers or a form. Use inputRequired: ask to answer each request.",
              );
            snapshot.state = { status: "completed", candidate: candidate(snapshot) };
            break;
          }
          const last = r.sends.at(-1);
          if (!last || !r.question) throw new A2AError("invalid");
          const requests = journal(snapshot, last, opts, scope, signal);
          const records: AskRecord[] = [];
          for (const ask of r.question.asks) records.push(await requests.ensure(ask));
          await requests.recheck(requests.call);
          await requests.assertFresh();
          if (records.some((record) => record.decision?.type === "cancel")) {
            await cancelTask(snapshot, opts, scope, signal, requests);
            fail(
              "remote_cancelled",
              "This remote question was cancelled. The remote service may still be working.",
            );
          }
          if (records.some((record) => !record.decision)) throw new Halt({ status: "suspended" });
          await send(
            answerParts(records, r.question.structured),
            records.map((record) => record.request.id),
            requests,
          );
          continue;
        }
        if (r.state === "auth_required")
          fail(
            "remote_auth_required",
            "The remote service needs sign-in. Sign in through its host, then reconnect to this task.",
          );
        if (r.state && ["failed", "rejected", "canceled"].includes(r.state))
          fail(
            "remote_failed",
            "The remote service did not complete this task. Check its status with its operator.",
          );
        if (!r.taskId)
          fail(
            "remote_unconfirmed",
            "No task identity was confirmed. Reconcile the remote message; it will not be sent again.",
          );
        const subscribing = definition.updates === "stream" && reconnects++ < 5;
        try {
          if (subscribing) {
            for await (const event of client(snapshot).observe(
              "SubscribeToTask",
              { id: r.taskId },
              { signal },
            ))
              await accept(snapshot, event, scope, opts);
          } else {
            if (polls++) await sleep(Math.min(1000 * 2 ** Math.min(polls - 2, 4), 15_000), signal);
            await accept(
              snapshot,
              await client(snapshot).call("GetTask", { id: r.taskId }, { signal }),
              scope,
              opts,
            );
          }
        } catch (error) {
          if (error instanceof Halt || !(error instanceof A2AError)) throw error;
          active();
          if (subscribing && error.kind === "protocol" && error.code === -32004) {
            // A peer can finish between observations. Terminal tasks refuse subscriptions,
            // but GetTask still returns their result. Poll without replaying any message.
            reconnects = 5;
            continue;
          }
          if (["protocol", "http", "endpoint", "limit", "invalid"].includes(error.kind))
            throw error;
          if (polls >= 3) {
            // Reuse the host's existing due-wake claims. An empty requestless suspension
            // otherwise cannot be continued by the background binding.
            r.wakeAt = Date.now() + 15_000;
            throw new Halt({ status: "suspended" });
          }
        }
      }
    } catch (error) {
      let failure = error;
      try {
        active();
      } catch (stopped) {
        failure = stopped instanceof Halt ? stopped : new Halt({ status: "cancelled" });
      }
      snapshot.state =
        failure instanceof Halt
          ? failure.state
          : {
              status: "failed",
              error: {
                code: failure instanceof A2AError ? "remote_unconfirmed" : "remote_host_failed",
                message:
                  "The remote service could not be observed safely. Reconcile its task before starting new work.",
              },
            };
      if (snapshot.state.status === "cancelled") stopRequests(snapshot);
    } finally {
      release();
      clearTimeout(timer);
    }
    try {
      await scope.tree.save();
    } catch (error) {
      snapshot.state =
        error instanceof Halt
          ? error.state
          : {
              status: "failed",
              error: {
                code: "checkpoint_failed",
                message:
                  "The remote journal could not be saved. Reconcile stored state before continuing.",
              },
            };
    }
    emitEvent(opts, {
      type: "state",
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      state: snapshot.state,
    });
    await opts.host?.progress?.flush();
    return hydrate(snapshot);
  }
  async function create(
    input: RemoteInput,
    runId: string,
    tree?: RunSnapshot["tree"],
    opts: RunOptions = {},
    root?: TreeNode,
  ): Promise<RemoteSnapshot> {
    const signal = opts.signal ?? new AbortController().signal;
    let source: RemoteSnapshot | undefined;
    if (input.continue) {
      source =
        root &&
        [...snapshots(root)].find(
          (saved): saved is RemoteSnapshot =>
            saved.kind === "remote" && saved.runId === input.continue,
        );
      if (
        !source ||
        source.agentId !== id ||
        source.version !== version ||
        !equalData(source.definition, definition) ||
        source.state.status !== "completed" ||
        source.remote.state !== "input_required" ||
        source.remote.cancel ||
        [...snapshots(root!)].some(
          (saved) =>
            saved.kind === "remote" &&
            saved.runId !== runId &&
            saved.input.continue === input.continue,
        )
      )
        throw new TypeError(
          "This remote continuation is not open in this root and specialist scope.",
        );
    }
    const card =
      typeof options.card === "string"
        ? await fetchA2AAgentCard(options.card, { ...options, signal })
        : decodeA2AAgentCard(options.card.document, options.card.version);
    if (typeof options.card !== "string") {
      await untilAbort(
        Promise.resolve(
          options.verifyCard?.(immutableCopy(card), {
            url: card.interfaces[0]?.url ?? "",
            fetchedAt: Date.now(),
          }),
        ),
        signal,
      );
      await untilAbort(
        checkA2ACardEndpoints(card, card.interfaces[0]?.url ?? "", options.policy),
        signal,
      );
    }
    const selected = selectA2AInterface(card, options.version, options.binding, options.extensions);
    if (definition.updates === "stream" && !card.capabilities.streaming)
      throw new TypeError("This card does not support streaming. Select poll updates.");
    const endpoint = {
      url: selected.url,
      version: options.version,
      binding: options.binding,
      streaming: card.capabilities.streaming === true,
      ...(selected.tenant ? { tenant: selected.tenant } : {}),
    };
    if (source && !equalData(source.remote.endpoint, endpoint))
      throw new TypeError("The remote endpoint changed. Restore the original specialist version.");
    if (inlineBytes([], input.input) > limits.inlineBytes)
      throw new TypeError("The remote input exceeds its inline byte limit.");
    const startedAt = Date.now();
    return {
      kind: "remote",
      format: 3,
      agentId: id,
      version,
      runId,
      attemptId: crypto.randomUUID(),
      startedAt,
      input: copyData(input),
      definition: copyData(definition),
      limits: copyData(limits),
      tree: tree ? copyData(tree) : { runId, startedAt, limits: copyData(treeLimits) },
      remote: {
        endpoint,
        priorTurns: source ? source.remote.priorTurns + source.remote.sends.length : 0,
        sends: [],
        artifacts: [],
        fallback: [],
        ...(source?.remote.taskId ? { taskId: source.remote.taskId } : {}),
        ...(source?.remote.contextId ? { contextId: source.remote.contextId } : {}),
      },
      state: { status: "running" },
    };
  }
  const runtime: RemoteRuntime<T | string> = {
    create,
    execute,
    hydrate,
    answerRequests,
    prepare: remoteInput,
    configuration: () => copyData({ ...definition, limits }),
    open(input, opts, runId) {
      checkRunOptions(opts);
      return create({ input: content(input) }, runId, undefined, opts);
    },
    restore(raw, tree) {
      if (!isRemoteSnapshot(raw)) throw new TypeError("Invalid remote snapshot.");
      const snapshot = copyData(raw);
      if (
        snapshot.agentId !== id ||
        snapshot.version !== version ||
        !equalData(snapshot.definition, definition) ||
        !equalData(snapshot.limits, limits) ||
        (tree
          ? !equalData(snapshot.tree, tree)
          : snapshot.tree.runId !== snapshot.runId || !equalData(snapshot.tree.limits, treeLimits))
      )
        throw new TypeError("Restore the same remote definition, limits and tree.");
      checkRemoteSnapshot(snapshot);
      checkTree(snapshot);
      if (snapshot.state.status === "completed" && snapshot.remote.state === "completed")
        validate(snapshot.state.candidate);
      return snapshot;
    },
  };
  async function root(
    snapshot: RemoteSnapshot,
    opts: RunOptions,
    answers?: Readonly<Record<string, unknown>>,
  ) {
    const tree = new ExecutionTree(snapshot, opts);
    try {
      return await execute(snapshot, opts, { tree, depth: 0, path: [] }, answers);
    } finally {
      tree.close();
    }
  }
  const remote: RemoteAgent<T | string> = Object.freeze({
    kind: "remote",
    id,
    version,
    [AGENT_RUNTIME]: runtime,
    async run(input: AgentInput, opts: RunOptions = {}) {
      return root(await runtime.open(input, opts, opts.runId ?? crypto.randomUUID()), opts);
    },
    async resume(raw: unknown, opts: ResumeOptions) {
      checkRunOptions(opts, true);
      const snapshot = runtime.restore(raw),
        answers = readAnswers(snapshot, opts.answers ?? {});
      await authorizeTree(snapshot, opts.host);
      snapshot.attemptId = crypto.randomUUID();
      return root(snapshot, opts, answers);
    },
    async cancel(raw: unknown, opts: ResumeOptions) {
      checkRunOptions(opts, true);
      if (opts.answers && Object.keys(opts.answers).length)
        throw new TypeError("Cancellation is not an answer.");
      const snapshot = runtime.restore(raw);
      await authorizeTree(snapshot, opts.host);
      const tree = new ExecutionTree(snapshot, opts);
      try {
        await cancelTask(
          snapshot,
          opts,
          { tree, depth: 0, path: [] },
          opts.signal ?? new AbortController().signal,
        );
        return copyData(snapshot);
      } finally {
        tree.close();
      }
    },
    asTool(tool: SpecialistToolOptions<T | string | RemotePending>) {
      return specialistFailures(
        defineDelegation({
          ...tool,
          inputSchema: {
            type: "object",
            properties: {
              input: { type: "string" },
              ...(definition.inputRequired === "parent" ? { continue: { type: "string" } } : {}),
            },
            required: ["input"],
            additionalProperties: false,
          },
          specialists: [remote],
          validate: remoteInput,
          async run(input, context) {
            if (input.continue && definition.inputRequired !== "parent")
              throw new TypeError("This specialist does not route questions through its parent.");
            const result = await context.child("result", remote, input).join();
            if (result.status !== "completed") {
              const state = result.snapshot.state;
              if (state.status === "running" || state.status === "completed")
                throw new TypeError("Invalid remote outcome.");
              throw new Halt(state);
            }
            return result.output;
          },
        }),
      );
    },
  });
  return remote;
}
