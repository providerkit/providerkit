// Fail-closed serving policy follows Google ADK (Apache-2.0, Google LLC).
// Generic failures/owner scoping follow Microsoft Agent Framework (MIT, Microsoft Corporation).
// Public cards and version selection follow Mastra (Apache-2.0, Kepler Software, Inc.).
import { sleep } from "@providerkit/core";
import type { BackgroundContext, BackgroundPolicy } from "../background-types.ts";
import type { NodeOutcome } from "../delegation.ts";
import {
  copyData,
  equalData,
  immutableCopy,
  isRecord,
  isImageMime,
  isFileMime,
} from "../snapshot.ts";
import { openRequests, requestRecords, untilAbort } from "../tree.ts";
import type { AgentInput, InputPart, PendingRequest, RunFailure } from "../types.ts";
import { authenticateA2A, type A2AAuthenticate, type A2APrincipal } from "./auth.ts";
import { decodeA2AHttpRequest, readA2AJson } from "./client.ts";
import type { A2ARun, A2ARuns, A2AStoredEvent } from "./memory-runs.ts";
import { checkA2APushConfig, deliverA2APush, type A2APushPolicy } from "./push.ts";
import { canonicalA2AJson, hashA2AJson, signAgentCard, type A2ACardSigner } from "./signing.ts";
import {
  a2aTerminal,
  A2ATaskConflict,
  taskScope,
  type A2AMessageReceipt,
  type A2ATaskPatch,
  type A2ATaskRecord,
  type A2ATaskScope,
  type A2ATaskStore,
} from "./tasks.ts";
import {
  A2AError,
  a2aLimits,
  a2aStateClosed,
  decodeA2AAgentCard,
  decodeA2ARpcRequest,
  encodeA2AError,
  encodeA2AEvent,
  encodeA2AResult,
  parseA2AJson,
  parseA2AVersion,
  type A2AAgentCard,
  type A2ADialect,
  type A2AEvent,
  type A2AJson,
  type A2ALimits,
  type A2AMessage,
  type A2AObject,
  type A2APart,
  type A2APushConfig,
  type A2ARequest,
  type A2AResponse,
  type A2ARpcId,
  type A2ASendParams,
  type A2ATask,
  type A2AVersion,
} from "./wire.ts";

export interface A2AProjectionContext {
  principal: A2APrincipal;
  tenant?: string;
  taskId: string;
  contextId: string;
}
export interface A2AServerBase<O> {
  tasks: A2ATaskStore;
  card: {
    url: string;
    name: string;
    description: string;
    version?: string;
    skills?: A2AObject[];
    security?: Partial<Record<A2AVersion, { schemes: A2AObject; requirements: A2AObject[] }>>;
    extensions?: A2AObject[];
    provider?: { organization: string; url: string };
  };
  authenticate?: A2AAuthenticate;
  /** Development only. One fixed anonymous partition; never fall back after failed auth. */
  allowAnonymous?: boolean;
  /** Only the discovery card may bypass authentication. Defaults to false. */
  publicCard?: boolean;
  /** Host-selected tenant for this handler. Request tenant fields cannot change it. */
  tenant?: string;
  /** Opt in only when runs has an owner-checked session factory. Otherwise context IDs group
   * tasks without loading conversation history. Never infer session access from the ID. */
  sessions?: boolean;
  /** Current access check, also called for each emitted stream frame and background push.
   * Authentication still runs first. False is indistinguishable from a missing task. */
  authorize?: (context: {
    principal: A2APrincipal;
    tenant?: string;
    operation: string;
    taskId?: string;
  }) => boolean | Promise<boolean>;
  remoteApprovals?: boolean;
  remoteClientTools?: boolean;
  /** Trusted output allowlist. Omitted means no result content leaves the process. */
  projectOutput?: (
    outcome: Extract<NodeOutcome<O>, { status: "completed" }>,
    context: A2AProjectionContext,
  ) => A2APart[] | Promise<A2APart[]>;
  /** Root text only, no reasoning/tools/children. Omitted means no transient text is exposed. */
  projectText?: (
    text: string,
    context: A2AProjectionContext,
  ) => string | undefined | Promise<string | undefined>;
  /** May narrow request visibility, never expand actor ownership or approval policy. */
  exposeRequest?: (request: PendingRequest, context: A2AProjectionContext) => boolean;
  extendedCard?: (
    principal: A2APrincipal,
    version: A2AVersion,
  ) => A2AAgentCard | Promise<A2AAgentCard>;
  push?: A2APushPolicy;
  sign?: A2ACardSigner;
  describeFailure?: (failure: RunFailure | { limit: string }) => string;
  limits?: Partial<A2ALimits> & {
    blockMs?: number;
    inlineBytes?: number;
    pushConfigs?: number;
    hops?: number;
  };
}
export type A2AServerOptions<I = AgentInput, O = unknown> = A2AServerBase<O> &
  (
    | { runs: A2ARuns<AgentInput, O>; prepare?: undefined }
    | {
        runs: A2ARuns<I, O>;
        prepare: (
          message: A2AMessage,
          context: { principal: A2APrincipal; request: Request },
        ) => I | Promise<I>;
      }
  );
export class A2ATaskRejected extends Error {
  constructor() {
    super("The host refused this task.");
    this.name = "A2ATaskRejected";
  }
}

/** Maps content only, never settings, instructions or tools. URL parts require the host's
 * prepare callback; this function never fetches them. JSON parts are untrusted input text. */
export function a2aInput(message: A2AMessage, inlineBytes = 10 * 1024 * 1024): AgentInput {
  let bytes = 0;
  const parts: InputPart[] = message.parts.map((part): InputPart => {
    if (part.kind === "text") return { type: "text", text: part.text };
    if (part.kind === "data")
      return { type: "text", text: `Untrusted message data:\n${canonicalA2AJson(part.data)}` };
    if (part.kind === "url") throw new A2AError("protocol", { code: -32005 });
    const raw = part.raw.replaceAll("-", "+").replaceAll("_", "/");
    let decoded: string;
    try {
      decoded = atob(raw);
    } catch {
      throw new A2AError("invalid");
    }
    bytes += decoded.length;
    if (bytes > inlineBytes) throw new A2AError("limit");
    const data = btoa(decoded);
    if (isImageMime(part.mediaType)) return { type: "image", data, mimeType: part.mediaType };
    if (isFileMime(part.mediaType)) return { type: "file", data, mimeType: part.mediaType };
    throw new A2AError("protocol", { code: -32005 });
  });
  return parts;
}
function json(value: unknown): A2AJson {
  return parseA2AJson(JSON.stringify(value));
}
function object(value: unknown): A2AObject {
  const result = json(value);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new A2AError("invalid");
  return result;
}
function protocol(code: number): never {
  throw new A2AError("protocol", { code });
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new A2AError("invalid");
  return value;
}
function historyMessage(message: A2AMessage, task: A2ATaskRecord): A2AMessage | undefined {
  const parts = message.parts
    .filter((part) => part.kind === "text")
    .map((part) => ({ kind: "text" as const, text: part.text }));
  return parts.length
    ? {
        kind: "message",
        messageId: message.messageId,
        role: message.role,
        parts,
        taskId: task.id,
        contextId: task.contextId,
      }
    : undefined;
}
function context(record: A2ATaskRecord): A2AProjectionContext {
  return {
    principal: { owner: record.owner, actorId: record.actorId },
    tenant: record.tenant,
    taskId: record.id,
    contextId: record.contextId,
  };
}

/** CAS retries only pure record updates, never start/resume/send/cancel or network writes. */
async function patchTask(
  tasks: A2ATaskStore,
  scope: A2ATaskScope,
  id: string,
  update: (record: A2ATaskRecord) => A2ATaskPatch | undefined,
) {
  for (let attempt = 0; ; attempt++) {
    const record = await tasks.get(scope, id);
    if (!record) protocol(-32001);
    const changes = update(record);
    if (!changes) return record;
    try {
      return await tasks.update(scope, id, changes, record.revision);
    } catch (error) {
      if (!(error instanceof A2ATaskConflict) || attempt === 3) throw error;
    }
  }
}
async function receipt(
  tasks: A2ATaskStore,
  scope: A2ATaskScope,
  id: string,
  messageId: string,
  acceptance: A2AMessageReceipt["acceptance"],
  segment?: string,
) {
  return patchTask(tasks, scope, id, (current) => {
    const message = current.messages.find((m) => m.id === messageId);
    if (!message) throw new A2AError("invalid");
    // A host claim may finish before the queue reply fails. Never downgrade that evidence.
    if (message.acceptance === "accepted") {
      if (segment && message.segment !== segment) throw new A2ATaskConflict();
      return undefined;
    }
    return {
      messages: current.messages.map((m) =>
        m.id === messageId ? { ...m, acceptance, ...(segment ? { segment } : {}) } : m,
      ),
      ...(segment && (!current.segment || current.segment === message.source) ? { segment } : {}),
    };
  });
}

/** Web-standard handler. Work belongs to runs, not to the request or a stream reader. The
 * host must retain the process for memory runs; production uses a durable run-service binding. */
export function createA2AServer<I = AgentInput, O = unknown>(options: A2AServerOptions<I, O>) {
  if (!options.authenticate && !options.allowAnonymous)
    throw new TypeError(
      "Provide authenticate before serving tasks. Use allowAnonymous only for local development.",
    );
  const { tasks, runs } = options;
  const {
    blockMs: block = 60_000,
    inlineBytes = 10 * 1024 * 1024,
    pushConfigs = 10,
    hops: maxHops = 16,
    ...wireLimits
  } = options.limits ?? {};
  const limits = a2aLimits(wireLimits);
  const blockMs = positive(block);
  positive(inlineBytes);
  positive(pushConfigs);
  positive(maxHops);
  const base = new URL(options.card.url);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !["https:", "http:"].includes(base.protocol)
  )
    throw new A2AError("invalid");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const rpcUrl = new URL("jsonrpc", base);
  const restUrl = new URL("rest", base);
  const cardPath = new URL(".well-known/agent-card.json", base).pathname;
  const stopped = new AbortController();
  const watchers = new Map<string, Promise<void>>();
  async function principal(request: Request): Promise<A2APrincipal | null> {
    return options.authenticate
      ? authenticateA2A(request, options.authenticate)
      : options.allowAnonymous
        ? { owner: "anonymous", actorId: "anonymous" }
        : null;
  }
  function scope(p: A2APrincipal): A2ATaskScope {
    return { ...p, ...(options.tenant ? { tenant: options.tenant } : {}) };
  }
  async function access(s: A2ATaskScope, operation: string, taskId?: string, request?: Request) {
    if (request) {
      const current = await principal(request);
      if (!current || current.owner !== s.owner || current.actorId !== s.actorId) protocol(-32001);
    }
    if (
      options.authorize &&
      !(await options.authorize({
        principal: { owner: s.owner, actorId: s.actorId },
        tenant: s.tenant,
        operation,
        taskId,
      }))
    )
      protocol(-32001);
  }
  async function get(s: A2ATaskScope, id: string, operation: string, request?: Request) {
    await access(s, operation, id, request);
    const record = await tasks.get(s, id);
    if (!record) protocol(-32001);
    return record;
  }
  function visibleRequest(request: PendingRequest, record: A2ATaskRecord): boolean {
    return (
      request.scope.actorId === record.actorId &&
      (request.ask.type === "question" ||
        (request.ask.type === "approval" && options.remoteApprovals === true) ||
        (request.ask.type === "client" && options.remoteClientTools === true)) &&
      (!options.exposeRequest || options.exposeRequest(immutableCopy(request), context(record)))
    );
  }
  function offered(row: A2ARun<O>, record: A2ATaskRecord): ReturnType<typeof openRequests> {
    return openRequests(row.snapshot).filter(
      (request) => request.scope.expiresAt > Date.now() && visibleRequest(request, record),
    );
  }
  function requestMessage(
    record: A2ATaskRecord,
    messageId: string,
    requests: ReturnType<typeof openRequests>,
  ): A2AMessage {
    const data = requests.map((r) => ({
      id: r.id,
      type: r.ask.type,
      ...(r.ask.type === "client" ? { schema: r.ask.resultSchema } : { message: r.ask.message }),
      ...(r.ask.type === "question"
        ? {
            choices: r.ask.choices,
            multiple: r.ask.multiple,
            freeText: r.ask.freeText,
            schema: r.ask.schema,
          }
        : {}),
      expiresAt: r.scope.expiresAt,
      ...(r.problem
        ? {
            problem: {
              code: r.problem.code,
              message: "That answer was not accepted. Check the question and send a new answer.",
            },
          }
        : {}),
    }));
    return {
      kind: "message",
      role: "agent",
      taskId: record.id,
      contextId: record.contextId,
      messageId,
      parts: [
        {
          kind: "text",
          text: requests
            .map((r) =>
              r.ask.type === "client"
                ? "The host needs a client result."
                : (r.ask.message ?? "An action needs approval."),
            )
            .join("\n"),
        },
        { kind: "data", data: object({ requests: data }) },
      ],
    };
  }
  async function project(record: A2ATaskRecord, row?: A2ARun<O>): Promise<A2ATask> {
    let state = record.state;
    let message: A2AMessage | undefined;
    let parts: A2APart[] = [];
    const say = (text: string) => {
      message = {
        kind: "message",
        role: "agent",
        taskId: record.id,
        contextId: record.contextId,
        messageId: `${record.id}:status`,
        parts: [{ kind: "text", text }],
      };
    };
    if (!row) {
      if (
        record.messages.some((m) => m.acceptance === "unknown") ||
        (record.state !== "rejected" && Date.now() - record.createdAt >= 60_000)
      ) {
        state = "unknown";
        say("The task may have started. Check its status before sending more work.");
      }
    } else if (row.status === "cancelled" && row.outcome?.status !== "completed")
      state = "canceled";
    else if (row.status === "failed" && row.outcome?.status !== "completed") {
      state = "failed";
      say("The task could not finish. Check with the host before starting it again.");
    } else if (
      (row.status === "queued" || row.status === "running") &&
      row.outcome?.status !== "completed"
    )
      state = row.status === "queued" && record.messages.length === 1 ? "submitted" : "working";
    else if (row.outcome) {
      const result = row.outcome;
      switch (result.status) {
        case "completed":
          state = "completed";
          parts = structuredClone((await options.projectOutput?.(result, context(record))) ?? []);
          if (parts.length)
            message = {
              kind: "message",
              role: "agent",
              messageId: `${record.id}:answer`,
              taskId: record.id,
              contextId: record.contextId,
              parts: structuredClone(parts),
            };
          break;
        case "cancelled":
          state = "canceled";
          say("The task stopped. Work already sent to another service may still finish.");
          break;
        case "limited":
          state = "failed";
          say(
            options.describeFailure?.({ limit: result.limit }) ??
              "The task reached its limit. Check its saved result before starting more work.",
          );
          break;
        case "failed":
          state = "failed";
          say(
            options.describeFailure?.(result.error) ??
              "The task could not finish. Check with the host before starting it again.",
          );
          break;
        case "suspended": {
          const requests = offered(row, record);
          state = requests.length ? "input_required" : "working";
          if (Date.now() >= row.snapshot.tree.startedAt + row.snapshot.tree.limits.elapsedMs) {
            state = "failed";
            say("The task waited too long for an answer. Start a new task.");
            break;
          }
          if (requests.length)
            message = requestMessage(
              record,
              `${record.id}:request:${row.snapshot.attemptId}`,
              requests,
            );
          else
            say(
              row.wakeAt === undefined
                ? "Waiting for the operator to continue this task."
                : "Waiting for the scheduled continuation.",
            );
          break;
        }
      }
    }
    const publicTask: A2ATask = {
      kind: "task",
      id: record.id,
      contextId: record.contextId,
      status: {
        state,
        ...(message ? { message } : {}),
        timestamp: new Date(record.updatedAt).toISOString(),
      },
      ...(parts.length ? { artifacts: [{ artifactId: "answer", parts }] } : {}),
    };
    // Validate all host projections before putting them on the wire or in public history.
    encodeA2AEvent(publicTask, { version: "1.0", binding: "JSONRPC" });
    return publicTask;
  }
  async function view(
    s: A2ATaskScope,
    id: string,
    operation = "GetTask",
    request?: Request,
    historyLength = 100,
  ): Promise<{ task: A2ATask; record: A2ATaskRecord; row?: A2ARun<O> }> {
    let record = await get(s, id, operation, request);
    const row = record.segment ? await runs.read(s.owner, record.segment) : undefined;
    if (row && row.snapshot.runId !== id) throw new A2AError("invalid");
    const task = await project(record, row);
    const publicMessage = task.status.message;
    record = await patchTask(tasks, s, id, (current) => {
      // A continuation can win while this read projects an older segment. Never regress it.
      if (current.segment !== record.segment) return undefined;
      const history =
        publicMessage && !current.history.some((m) => m.messageId === publicMessage.messageId)
          ? [...current.history, publicMessage].slice(-100)
          : current.history;
      if (current.state === task.status.state && history === current.history) return undefined;
      if (a2aTerminal(current.state) && current.state !== task.status.state) return undefined;
      return { state: task.status.state, history };
    });
    if (row && record.segment !== row.id) return view(s, id, operation, request, historyLength);
    task.status.timestamp = new Date(record.updatedAt).toISOString();
    if (historyLength > 0) {
      const requests = new Map(
        row
          ? [...requestRecords(row.snapshot)].map(({ record: r }) => [r.request.id, r.request])
          : [],
      );
      // Stored projections are a cache, not continuing permission. Rebuild agent content from
      // the current output/request policy; obsolete statuses have no independent disclosure.
      const history = record.history.flatMap((message): A2AMessage[] => {
        if (message.role === "user") return [message];
        if (message.messageId === publicMessage?.messageId) return [publicMessage];
        if (!message.messageId.startsWith(`${id}:request:`)) return [];
        const visible = message.parts.flatMap((part) => {
          if (part.kind !== "data" || !isRecord(part.data) || !Array.isArray(part.data.requests))
            return [];
          return part.data.requests.flatMap((value) => {
            const request =
              isRecord(value) && typeof value.id === "string" ? requests.get(value.id) : undefined;
            return request && visibleRequest(request, record) ? [request] : [];
          });
        });
        return visible.length ? [requestMessage(record, message.messageId, visible)] : [];
      });
      task.history = structuredClone(history.slice(-Math.min(historyLength, 100)));
    }
    await access(s, operation, id, request);
    return { task, record, row };
  }
  async function notify(s: A2ATaskScope, id: string) {
    if (!options.push) return;
    const current = await view(s, id, "Push");
    await deliverA2APush({
      tasks,
      scope: s,
      taskId: id,
      event: current.task,
      policy: options.push,
    });
  }
  function watch(s: A2ATaskScope, id: string) {
    if (!options.push) return;
    const key = JSON.stringify([s, id]);
    if (watchers.has(key) || stopped.signal.aborted) return;
    const watching = (async () => {
      for (;;) {
        stopped.signal.throwIfAborted();
        const current = await view(s, id, "Push");
        await notify(s, id);
        if (a2aStateClosed(current.task.status.state)) return;
        await sleep(250, stopped.signal);
      }
    })()
      .catch(() => {
        /* No replay after uncertain writes or revoked access. Host can refresh. */
      })
      .finally(() => {
        watchers.delete(key);
      });
    watchers.set(key, watching);
  }
  async function pushConfig(s: A2ATaskScope, config: A2APushConfig, d: A2ADialect) {
    if (!options.push) protocol(-32003);
    const validated = structuredClone({
      ...config,
      id: config.id ?? crypto.randomUUID(),
      ...(s.tenant ? { tenant: s.tenant } : {}),
    });
    await checkA2APushConfig(validated, s, options.push);
    return { config: validated, dialect: d };
  }
  async function accept(
    s: A2ATaskScope,
    params: A2ASendParams,
    request: Request,
    dialect: A2ADialect,
  ): Promise<string> {
    const message = params.message;
    const fingerprint = await hashA2AJson(object(params));
    const existing = await tasks.findMessage(s, message.messageId);
    if (existing) {
      await access(s, "SendMessage", existing.id, request);
      if (existing.messages.find((m) => m.id === message.messageId)?.fingerprint !== fingerprint)
        protocol(-32602);
      return existing.id;
    }
    if (message.referenceTaskIds?.length) protocol(-32004);
    if (message.taskId) {
      const current = await view(s, message.taskId, "SendMessage", request);
      if (message.contextId && message.contextId !== current.record.contextId) protocol(-32602);
      if (
        a2aTerminal(current.task.status.state) ||
        (current.record.cancel && current.record.cancel !== "refused") ||
        current.record.messages.some(
          (receipt) => receipt.kind !== "start" && receipt.acceptance !== "accepted",
        )
      )
        protocol(-32004);
      if (!current.record.segment || !current.row) protocol(-32004);
      if (params.configuration?.pushNotificationConfig) protocol(-32004);
      const open = offered(current.row, current.record);
      let answers: Record<string, unknown> | undefined;
      let input: AgentInput | undefined;
      const kind = current.task.status.state === "input_required" ? "resume" : "steer";
      if (kind === "resume") {
        const maps = message.parts.filter(
          (part) =>
            part.kind === "data" && isRecord(part.data) && Object.hasOwn(part.data, "answers"),
        );
        let values: Record<string, unknown>;
        if (
          maps.length === 1 &&
          maps[0]?.kind === "data" &&
          isRecord(maps[0].data) &&
          isRecord(maps[0].data.answers)
        )
          values = maps[0].data.answers;
        else if (
          !maps.length &&
          message.parts.every((part) => part.kind === "text") &&
          open.length === 1 &&
          open[0]?.ask.type === "question" &&
          open[0].ask.freeText === true
        )
          values = {
            [open[0].id]: {
              type: "answer",
              answer: {
                text: message.parts
                  .map((part) => (part.kind === "text" ? part.text : ""))
                  .join("\n"),
              },
            },
          };
        else protocol(-32602);
        if (
          !Object.keys(values).length ||
          Object.keys(values).some((id) => !open.some((r) => r.id === id))
        )
          protocol(-32602);
        answers = Object.fromEntries(
          Object.entries(values).map(([id, answer]) => [
            id,
            {
              via: "a2a",
              ...taskScope(s),
              taskId: current.record.id,
              messageId: message.messageId,
              requestId: id,
              answer: copyData(answer),
            },
          ]),
        );
      } else {
        if (
          !runs.send ||
          current.row.status !== "running" ||
          !message.parts.every((p) => p.kind === "text")
        )
          protocol(-32004);
        input = a2aInput(message, inlineBytes);
      }
      const publicMessage = historyMessage(message, current.record);
      const claim: A2AMessageReceipt = {
        id: message.messageId,
        fingerprint,
        kind,
        acceptance: "pending",
        source: current.record.segment,
        ...(answers ? { answers } : {}),
      };
      // One CAS before the effect. A competing continuation is refused, not retried.
      await tasks.update(
        s,
        current.record.id,
        {
          messages: [...current.record.messages, claim],
          history: [...current.record.history, ...(publicMessage ? [publicMessage] : [])].slice(
            -100,
          ),
          state: "working",
        },
        current.record.revision,
      );
      let next: string | undefined;
      try {
        await access(s, kind, current.record.id, request);
        if (answers) next = (await runs.resume(s.owner, current.record.segment, answers)).id;
        else {
          if (
            !runs.send ||
            input === undefined ||
            (typeof input === "object" && "messages" in input)
          )
            protocol(-32004);
          await runs.send(s.owner, current.record.segment, {
            id: message.messageId,
            content: typeof input === "string" ? input : [...input],
          });
        }
        await receipt(tasks, s, current.record.id, message.messageId, "accepted", next);
      } catch (error) {
        await receipt(tasks, s, current.record.id, message.messageId, "unknown", next);
        throw error;
      }
      watch(s, current.record.id);
      return current.record.id;
    }
    if (message.contextId && !(await tasks.hasContext(s, message.contextId))) protocol(-32602);
    const hops = params.metadata?.["providerkit.hops"] ?? 0;
    if (typeof hops !== "number" || !Number.isSafeInteger(hops) || hops < 0 || hops > maxHops)
      protocol(-32602);
    const preparedInput = options.prepare ? undefined : a2aInput(message, inlineBytes);
    const id = crypto.randomUUID();
    const record: A2ATaskRecord = {
      ...s,
      id,
      contextId: message.contextId ?? crypto.randomUUID(),
      hops,
      state: "submitted",
      messages: [{ id: message.messageId, fingerprint, kind: "start", acceptance: "pending" }],
      history: [],
      push: [],
      deliveries: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: "",
    };
    const publicMessage = historyMessage(message, record);
    if (publicMessage) record.history.push(publicMessage);
    if (params.configuration?.pushNotificationConfig)
      record.push.push(
        await pushConfig(
          s,
          { ...params.configuration.pushNotificationConfig, taskId: id },
          dialect,
        ),
      );
    const created = await tasks.create(record);
    if (!created.created) return created.record.id;
    let segment: string | undefined;
    try {
      await access(s, "start", id, request);
      const start = { runId: id, ...(options.sessions ? { sessionId: record.contextId } : {}) };
      // The request's abort only detaches after reservation. No uncertain start is repeated.
      if (options.prepare) {
        const input = await options.prepare(immutableCopy(message), {
          principal: { owner: s.owner, actorId: s.actorId },
          request,
        });
        await access(s, "start", id, request);
        segment = (await options.runs.start(s.owner, input, start)).id;
      } else {
        if (preparedInput === undefined) throw new A2AError("invalid");
        segment = (await options.runs.start(s.owner, preparedInput, start)).id;
      }
      await receipt(tasks, s, id, message.messageId, "accepted", segment);
    } catch (error) {
      await receipt(
        tasks,
        s,
        id,
        message.messageId,
        error instanceof A2ATaskRejected ? "accepted" : "unknown",
        segment,
      );
      if (error instanceof A2ATaskRejected) {
        await patchTask(tasks, s, id, () => ({ state: "rejected" }));
        return id;
      }
      throw error;
    }
    watch(s, id);
    return id;
  }
  async function wait(s: A2ATaskScope, id: string, request: Request, historyLength?: number) {
    const deadline = Date.now() + blockMs;
    for (;;) {
      const current = await view(s, id, "SendMessage", request, historyLength);
      if (a2aStateClosed(current.task.status.state) || Date.now() >= deadline) return current.task;
      await sleep(Math.min(25, Math.max(1, deadline - Date.now())), request.signal);
    }
  }
  async function* events(
    s: A2ATaskScope,
    id: string,
    request: Request,
    signal: AbortSignal,
    historyLength?: number,
  ): AsyncGenerator<A2AEvent> {
    let current = await view(s, id, "SubscribeToTask", request, historyLength);
    yield current.task;
    let previous = canonicalA2AJson(object(current.task));
    let operation: string | undefined;
    let hasArtifact = !!current.task.artifacts?.length;
    while (!a2aStateClosed(current.task.status.state)) {
      signal.throwIfAborted();
      if (!current.record.segment) throw new A2AError("stream-cut");
      const segment = current.record.segment;
      for await (const stored of runs.observe(s.owner, segment, 0, signal)) {
        signal.throwIfAborted();
        await access(s, "SubscribeToTask", id, request);
        if (stored.type === "agent.gap" || stored.type === "agent.resync") {
          current = await view(s, id, "SubscribeToTask", request, historyLength);
          yield current.task;
          previous = canonicalA2AJson(object(current.task));
          operation = undefined;
          hasArtifact = !!current.task.artifacts?.length;
          if (a2aStateClosed(current.task.status.state)) return;
          continue;
        }
        const delta = await text(stored, current.record);
        if (delta) {
          const append = operation === delta.operation && hasArtifact;
          yield {
            kind: "artifact-update",
            taskId: id,
            contextId: current.record.contextId,
            artifact: { artifactId: "answer", parts: [{ kind: "text", text: delta.text }] },
            append,
            lastChunk: false,
          };
          operation = delta.operation;
          hasArtifact = true;
        }
      }
      // Every authoritative read goes through emission before closure, including a continuation
      // that finishes entirely between polls of an operator-only suspension.
      for (;;) {
        current = await view(s, id, "SubscribeToTask", request, historyLength);
        const value = canonicalA2AJson(object(current.task));
        if (value !== previous) {
          if (current.task.artifacts?.length)
            for (const artifact of current.task.artifacts)
              yield {
                kind: "artifact-update",
                taskId: id,
                contextId: current.record.contextId,
                artifact,
                append: false,
                lastChunk: true,
              };
          else if (hasArtifact)
            yield {
              kind: "artifact-update",
              taskId: id,
              contextId: current.record.contextId,
              artifact: { artifactId: "answer", parts: [{ kind: "text", text: "" }] },
              append: false,
              lastChunk: true,
            };
          yield {
            kind: "status-update",
            taskId: id,
            contextId: current.record.contextId,
            status: current.task.status,
          };
          previous = value;
          hasArtifact = !!current.task.artifacts?.length;
        }
        if (a2aStateClosed(current.task.status.state)) return;
        if (current.record.segment !== segment) break;
        if (current.row && ["queued", "running"].includes(current.row.status))
          throw new A2AError("stream-cut");
        await sleep(250, signal);
      }
    }
  }
  async function text(stored: A2AStoredEvent, record: A2ATaskRecord) {
    const data = stored.data;
    if (
      !options.projectText ||
      stored.type !== "agent" ||
      !isRecord(data) ||
      data.type !== "model_chunk" ||
      data.runId !== record.id ||
      typeof data.operationId !== "string" ||
      typeof data.attemptId !== "string" ||
      !isRecord(data.chunk) ||
      data.chunk.type !== "delta" ||
      typeof data.chunk.content !== "string"
    )
      return undefined;
    const value = await options.projectText(data.chunk.content, context(record));
    return value
      ? { text: value, operation: JSON.stringify([data.operationId, data.attemptId]) }
      : undefined;
  }
  function stream(
    s: A2ATaskScope,
    id: string,
    request: Request,
    d: A2ADialect,
    rpcId: A2ARpcId | null,
    historyLength?: number,
  ) {
    const detached = new AbortController();
    const signal = AbortSignal.any([detached.signal, request.signal, stopped.signal]);
    const iterator = events(s, id, request, signal, historyLength);
    let pending: Promise<IteratorResult<A2AEvent>> | undefined;
    let ended = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (ended) return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            pending ??= iterator.next();
            const next = await untilAbort(
              Promise.race([
                pending,
                new Promise<null>((resolve) => {
                  timer = setTimeout(() => resolve(null), 15_000);
                }),
              ]),
              signal,
            );
            if (next === null) {
              await access(s, "SubscribeToTask", id, request);
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
              return;
            }
            pending = undefined;
            if (next.done) {
              ended = true;
              controller.close();
              return;
            }
            await access(s, "SubscribeToTask", id, request);
            const value = encodeA2AEvent(next.value, d);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(d.binding === "JSONRPC" ? { jsonrpc: "2.0", id: rpcId, result: value } : value)}\n\n`,
              ),
            );
          } catch (error) {
            ended = true;
            if (!signal.aborted) {
              const failure = encodeA2AError(
                error instanceof A2AError ? (error.code ?? -32603) : -32603,
                d,
                rpcId,
              );
              controller.enqueue(
                encoder.encode(`event: error\ndata: ${JSON.stringify(failure.body)}\n\n`),
              );
            }
            controller.close();
            detached.abort();
            void iterator.return(undefined).catch(() => {});
          } finally {
            clearTimeout(timer);
          }
        },
        cancel() {
          ended = true;
          detached.abort();
          void iterator.return(undefined).catch(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "A2A-Version": d.version,
      },
    });
  }
  async function card(version: A2AVersion = "1.0"): Promise<A2AAgentCard> {
    const host = options.card;
    const security = host.security?.[version];
    const capabilities = {
      streaming: true,
      pushNotifications: !!options.push,
      ...(version === "1.0" ? { extendedAgentCard: !!options.extendedCard } : {}),
      extensions: host.extensions ?? [],
    };
    const common = {
      name: host.name,
      description: host.description,
      version: host.version ?? "1",
      skills: host.skills ?? [],
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "application/json"],
      capabilities,
      ...(security
        ? {
            securitySchemes: security.schemes,
            [version === "1.0" ? "securityRequirements" : "security"]: security.requirements,
          }
        : {}),
      ...(host.provider ? { provider: host.provider } : {}),
    };
    const document =
      version === "1.0"
        ? {
            ...common,
            supportedInterfaces: (["1.0", "0.3"] as const).flatMap((v) =>
              (["JSONRPC", "HTTP+JSON"] as const).map((binding) => ({
                url: binding === "JSONRPC" ? rpcUrl.href : restUrl.href,
                protocolBinding: binding,
                protocolVersion: v,
                ...(v === "1.0" && options.tenant ? { tenant: options.tenant } : {}),
              })),
            ),
          }
        : {
            ...common,
            protocolVersion: "0.3.0",
            url: rpcUrl.href,
            preferredTransport: "JSONRPC",
            additionalInterfaces: [{ url: restUrl.href, transport: "HTTP+JSON" }],
            supportsAuthenticatedExtendedCard: !!options.extendedCard,
          };
    const decoded = decodeA2AAgentCard(document, version);
    return options.sign ? signAgentCard(decoded, options.sign) : decoded;
  }
  async function operation(
    s: A2ATaskScope,
    decoded: A2ARequest,
    request: Request,
    d: A2ADialect,
    rpcId: A2ARpcId | null,
  ): Promise<A2AResponse | Response> {
    if (decoded.params.tenant !== undefined && decoded.params.tenant !== s.tenant) protocol(-32001);
    await access(s, decoded.method, undefined, request);
    switch (decoded.method) {
      case "SendMessage":
      case "SendStreamingMessage": {
        const id = await accept(s, decoded.params, request, d);
        if (decoded.method === "SendStreamingMessage")
          return stream(s, id, request, d, rpcId, decoded.params.configuration?.historyLength);
        const task = decoded.params.configuration?.returnImmediately
          ? (await view(s, id, decoded.method, request, decoded.params.configuration.historyLength))
              .task
          : await wait(s, id, request, decoded.params.configuration?.historyLength);
        return { method: "SendMessage", result: task };
      }
      case "GetTask":
        return {
          method: "GetTask",
          result: (
            await view(s, decoded.params.id, decoded.method, request, decoded.params.historyLength)
          ).task,
        };
      case "SubscribeToTask": {
        const current = await view(s, decoded.params.id, decoded.method, request);
        if (a2aTerminal(current.task.status.state)) protocol(-32004);
        return stream(s, decoded.params.id, request, d, rpcId);
      }
      case "CancelTask": {
        const current = await view(s, decoded.params.id, decoded.method, request);
        if (a2aTerminal(current.task.status.state) || !current.record.segment) protocol(-32002);
        if (current.record.cancel === "refused") protocol(-32002);
        if (!current.record.cancel) {
          await tasks.update(s, current.record.id, { cancel: "pending" }, current.record.revision);
          try {
            const result = await runs.cancel(s.owner, current.record.segment);
            await patchTask(tasks, s, current.record.id, (record) => {
              // Follow the physical segment even without onSegment. A newer continuation
              // may have won meanwhile; an old acknowledgement cannot overwrite its ID.
              if (record.segment !== current.record.segment && record.segment !== result.id)
                throw new A2ATaskConflict();
              return { segment: result.id, cancel: result.requested ? "accepted" : "refused" };
            });
            if (!result.requested) protocol(-32002);
          } catch (error) {
            await patchTask(tasks, s, current.record.id, (r) =>
              r.cancel === "pending" ? { cancel: "unknown" } : undefined,
            );
            throw error;
          }
        }
        watch(s, current.record.id);
        return {
          method: "CancelTask",
          result: (await view(s, current.record.id, decoded.method, request)).task,
        };
      }
      case "ListTasks": {
        const p = decoded.params;
        if (p.contextId && !(await tasks.hasContext(s, p.contextId))) protocol(-32001);
        const size = p.pageSize ?? 50;
        let cursor: string | undefined;
        let pastCursor = !p.pageToken;
        let foundCursor = !p.pageToken;
        let nextPageToken = "";
        let totalSize = 0;
        const result: A2ATask[] = [];
        const after = p.statusTimestampAfter ? Date.parse(p.statusTimestampAfter) : undefined;
        if (after !== undefined && !Number.isFinite(after)) protocol(-32602);
        // Count fresh authorized matches, including those outside this response page.
        do {
          const page = await tasks.list(s, {
            contextId: p.contextId,
            pageSize: 100,
            pageToken: cursor,
          });
          for (const record of page.tasks) {
            if (record.id === p.pageToken) {
              foundCursor = true;
              pastCursor = true;
            }
            let current: Awaited<ReturnType<typeof view>>;
            try {
              current = await view(s, record.id, decoded.method, request, p.historyLength ?? 0);
            } catch (error) {
              if (error instanceof A2AError && error.code === -32001) continue;
              throw error;
            }
            if (
              (p.status && current.task.status.state !== p.status) ||
              (after !== undefined && current.record.updatedAt < after)
            )
              continue;
            totalSize++;
            if (!pastCursor || record.id === p.pageToken) continue;
            if (result.length < size) {
              if (!p.includeArtifacts) delete current.task.artifacts;
              result.push(current.task);
            } else if (!nextPageToken) nextPageToken = result.at(-1)!.id;
          }
          cursor = page.nextPageToken;
        } while (cursor);
        if (!foundCursor) protocol(-32602);
        return {
          method: "ListTasks",
          result: { tasks: result, nextPageToken, pageSize: size, totalSize },
        };
      }
      case "CreateTaskPushNotificationConfig": {
        if (!decoded.params.taskId) protocol(-32602);
        const current = await get(s, decoded.params.taskId, decoded.method, request);
        const configured = await pushConfig(s, decoded.params, d);
        const previous = current.push.find((p) => p.config.id === configured.config.id);
        if (previous && d.version === "1.0") protocol(-32602);
        if (!previous && current.push.length >= Math.min(10, pushConfigs))
          throw new A2AError("limit");
        await tasks.update(
          s,
          current.id,
          {
            push: [...current.push.filter((p) => p.config.id !== configured.config.id), configured],
          },
          current.revision,
        );
        watch(s, current.id);
        return { method: decoded.method, result: configured.config };
      }
      case "GetTaskPushNotificationConfig":
      case "ListTaskPushNotificationConfigs":
      case "DeleteTaskPushNotificationConfig": {
        const current = await get(s, decoded.params.taskId, decoded.method, request);
        if (!options.push) protocol(-32003);
        if (decoded.method === "ListTaskPushNotificationConfigs") {
          const configs = current.push.map((p) => p.config);
          const start = decoded.params.pageToken
            ? configs.findIndex((p) => p.id === decoded.params.pageToken) + 1
            : 0;
          if (decoded.params.pageToken && start === 0) protocol(-32602);
          const end = start + (decoded.params.pageSize ?? 10);
          const page = configs.slice(start, end);
          return {
            method: decoded.method,
            result: { configs: page, nextPageToken: end < configs.length ? page.at(-1)!.id : "" },
          };
        }
        const config =
          current.push.find((p) => p.config.id === decoded.params.id) ??
          (decoded.params.id === undefined && current.push.length === 1
            ? current.push[0]
            : undefined);
        if (!config) protocol(-32001);
        if (decoded.method === "GetTaskPushNotificationConfig")
          return { method: decoded.method, result: config.config };
        await tasks.update(
          s,
          current.id,
          { push: current.push.filter((p) => p.config.id !== config.config.id) },
          current.revision,
        );
        return { method: decoded.method, result: null };
      }
      case "GetExtendedAgentCard": {
        if (!options.extendedCard) protocol(-32007);
        return {
          method: decoded.method,
          result: await options.extendedCard({ owner: s.owner, actorId: s.actorId }, d.version),
        };
      }
    }
  }
  return {
    card,
    /** Explicit host reconciliation/read, also useful after an out-of-band segment completes. */
    async refresh(principal: A2APrincipal, id: string) {
      const s = scope(principal);
      const current = await view(s, id);
      await notify(s, id);
      return current.task;
    },
    /** Detaches this handler's observers, never cancels work held by runs. */
    async close() {
      stopped.abort();
      await Promise.all(watchers.values());
    },
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      let d: A2ADialect = {
        version: "0.3",
        binding: path === rpcUrl.pathname ? "JSONRPC" : "HTTP+JSON",
      };
      let rpcId: A2ARpcId | null = null;
      try {
        // No body read, version parsing, store query or model work before authentication.
        const p = await principal(request);
        const publicCard = options.publicCard && path === cardPath && request.method === "GET";
        if (!p && !publicCard)
          return Response.json(
            { error: "Authentication is required." },
            { status: 401, headers: { "WWW-Authenticate": "Bearer", "cache-control": "no-store" } },
          );
        d = { ...d, version: parseA2AVersion(request.headers.get("A2A-Version")) };
        if (path === cardPath && request.method === "GET") {
          if (p) await access(scope(p), "AgentCard", undefined, request);
          return Response.json((await card(d.version)).document, {
            headers: { Vary: "A2A-Version", "cache-control": "no-store" },
          });
        }
        if (!p) protocol(-32001);
        const extensions =
          request.headers
            .get("A2A-Extensions")
            ?.split(",")
            .map((v) => v.trim()) ?? [];
        if (
          options.card.extensions?.some(
            (ext) =>
              ext.required === true &&
              (typeof ext.uri !== "string" || !extensions.includes(ext.uri)),
          )
        )
          protocol(-32008);
        // Empty REST cancellations are valid protocol requests, but still need a JSON media
        // type here. Otherwise a cross-site form can reach a cookie-authenticated command.
        const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (
          request.method === "POST" &&
          mediaType !== "application/json" &&
          mediaType !== "application/a2a+json"
        )
          throw new A2AError("protocol", { code: -32005, status: 415 });
        let decoded: A2ARequest;
        if (d.binding === "JSONRPC") {
          if (request.method !== "POST") throw new A2AError("invalid", { status: 405 });
          const value = await readA2AJson(request, { limits });
          // Keep a valid correlation id even when decoding the operation fails.
          if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            (typeof value.id === "string" || typeof value.id === "number")
          )
            rpcId = value.id;
          const rpc = decodeA2ARpcRequest(value, d.version, limits);
          rpcId = rpc.id;
          decoded = rpc.request;
        } else
          decoded = await decodeA2AHttpRequest(request, {
            baseUrl: restUrl.href,
            version: d.version,
            tenant: options.tenant,
            limits,
          });
        const result = await operation(scope(p), decoded, request, d, rpcId);
        if (result instanceof Response) return result;
        await access(scope(p), decoded.method, undefined, request);
        const encoded = encodeA2AResult(result, d);
        return Response.json(
          d.binding === "JSONRPC" ? { jsonrpc: "2.0", id: rpcId, result: encoded } : encoded,
          { headers: { "cache-control": "no-store", "A2A-Version": d.version } },
        );
      } catch (error) {
        const encoded = encodeA2AError(
          error instanceof A2AError
            ? (error.code ?? (error.kind === "invalid" || error.kind === "limit" ? -32602 : -32603))
            : -32603,
          d,
          rpcId,
        );
        return Response.json(encoded.body, {
          status:
            error instanceof A2AError && [413, 415, 405].includes(error.status ?? 0)
              ? error.status
              : encoded.status,
          headers: { "cache-control": "no-store" },
        });
      }
    },
  };
}

/** Gate A2A evidence before handing it to the real host resolver/claim. Does not grant
 * approvals, invent scopes, consume requests or replace the host's lease checks. */
export function a2aPolicy(
  policy: BackgroundPolicy,
  options: {
    tasks: A2ATaskStore;
    scope: A2ATaskScope;
    context: BackgroundContext;
    remoteApprovals?: boolean;
    remoteClientTools?: boolean;
  },
): BackgroundPolicy {
  async function evidence(requestId: string, value: unknown) {
    if (
      !isRecord(value) ||
      value.via !== "a2a" ||
      value.owner !== options.scope.owner ||
      value.actorId !== options.scope.actorId ||
      value.tenant !== options.scope.tenant ||
      value.taskId !== options.context.runId ||
      value.requestId !== requestId ||
      typeof value.messageId !== "string"
    )
      throw new A2AError("invalid");
    const task = await options.tasks.get(options.scope, options.context.runId);
    const message = task?.messages.find((m) => m.id === value.messageId && m.kind === "resume");
    if (
      !message ||
      message.source !== options.context.continuation?.sourceId ||
      !equalData(message.answers?.[requestId], value)
    )
      throw new A2AError("invalid");
    return message;
  }
  return {
    ...policy,
    async claimContinuation(snapshot, continuation) {
      const messages = new Map<string, A2AMessageReceipt>();
      for (const [id, value] of Object.entries(continuation.answers)) {
        if (!isRecord(value) || value.via !== "a2a") continue;
        const message = await evidence(id, value);
        if (
          !Object.entries(message.answers ?? {}).every(([requestId, answer]) =>
            equalData(continuation.answers[requestId], answer),
          )
        )
          throw new A2AError("invalid");
        messages.set(message.id, message);
      }
      // Scheduled wakes and explicit cancellations are checked by the binding and claimed by
      // the real host. A cancellation contains no answers and grants no pending request.
      await policy.claimContinuation(snapshot, continuation);
      // The host's exact claim and physical segment establish acceptance even if resume's
      // acknowledgement was lost. A later message may continue, but this one is never replayed.
      for (const message of messages.values())
        await receipt(
          options.tasks,
          options.scope,
          options.context.runId,
          message.id,
          "accepted",
          options.context.segmentId,
        );
    },
    async resolveRequest(request, value) {
      if (!isRecord(value) || value.via !== "a2a") return policy.resolveRequest(request, value);
      await evidence(request.id, value);
      if (
        request.scope.actorId !== options.scope.actorId ||
        request.scope.expiresAt <= Date.now() ||
        (request.ask.type === "approval" && !options.remoteApprovals) ||
        (request.ask.type === "client" && !options.remoteClientTools)
      )
        return { type: "pending" };
      return policy.resolveRequest(request, value);
    },
  };
}
