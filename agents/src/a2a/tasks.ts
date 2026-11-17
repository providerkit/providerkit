// Owner partitioning follows Microsoft's IsolationKeyScopedTaskStore (MIT).
// Copyright (c) Microsoft Corporation. Message claims and bounded retention are providerkit's.
import { equalData } from "../snapshot.ts";
import type { SegmentHook } from "../background-types.ts";
import type { A2APrincipal } from "./auth.ts";
import {
  A2AError,
  type A2ADialect,
  type A2AMessage,
  type A2APushConfig,
  type A2AState,
} from "./wire.ts";

/** Tenant is selected by trusted host configuration, not by a request's tenant field. */
export interface A2ATaskScope extends A2APrincipal {
  tenant?: string;
}
export interface A2AMessageReceipt {
  id: string;
  fingerprint: string;
  kind: "start" | "resume" | "steer";
  /** pending is already a reservation: never repeat the effect, even after a lost reply. */
  acceptance: "pending" | "accepted" | "unknown";
  segment?: string;
  source?: string;
  /** Exact evidence reserved before resume. Private, never projected as A2A history. */
  answers?: Readonly<Record<string, unknown>>;
}
export interface A2APushRecord {
  config: A2APushConfig;
  dialect: A2ADialect;
}
export interface A2APushAttempt {
  id: string;
  configId: string;
  revision: string;
  at: number;
  outcome: "pending" | "delivered" | "refused" | "unknown";
}
export interface A2ATaskRecord extends A2ATaskScope {
  id: string;
  contextId: string;
  hops: number;
  segment?: string;
  state: A2AState;
  messages: A2AMessageReceipt[];
  /** Only peer messages and explicitly projected public messages, never the run journal. */
  history: A2AMessage[];
  push: A2APushRecord[];
  deliveries: A2APushAttempt[];
  cancel?: "pending" | "accepted" | "unknown" | "refused";
  createdAt: number;
  updatedAt: number;
  revision: string;
}
export type A2ATaskPatch = Partial<
  Pick<
    A2ATaskRecord,
    "segment" | "state" | "messages" | "history" | "push" | "deliveries" | "cancel"
  >
>;
export interface A2ATaskStore {
  /** Atomic on both (scope,id) and (scope,messageId). Changed duplicate content must throw. */
  create(record: A2ATaskRecord): Promise<{ created: boolean; record: A2ATaskRecord }>;
  get(scope: A2ATaskScope, id: string): Promise<A2ATaskRecord | null>;
  findMessage(scope: A2ATaskScope, id: string): Promise<A2ATaskRecord | null>;
  /** CAS also claims every newly added messageId across the scope. No writes on conflict. */
  update(
    scope: A2ATaskScope,
    id: string,
    patch: A2ATaskPatch,
    revision: string,
  ): Promise<A2ATaskRecord>;
  list(
    scope: A2ATaskScope,
    filter: { contextId?: string; pageSize: number; pageToken?: string },
  ): Promise<{ tasks: A2ATaskRecord[]; nextPageToken: string }>;
  hasContext(scope: A2ATaskScope, contextId: string): Promise<boolean>;
}
export class A2ATaskConflict extends A2AError {
  constructor() {
    super("invalid", { code: -32602 });
  }
}
export function a2aTerminal(state: A2AState): boolean {
  return ["completed", "failed", "canceled", "rejected"].includes(state);
}
export function taskScope(record: A2ATaskScope): A2ATaskScope {
  return {
    owner: record.owner,
    actorId: record.actorId,
    ...(record.tenant ? { tenant: record.tenant } : {}),
  };
}
function scopeKey(scope: A2ATaskScope): string {
  if (!scope.owner || !scope.actorId) throw new A2AError("invalid");
  return JSON.stringify([scope.owner, scope.actorId, scope.tenant ?? null]);
}

/** Process-local, not crash durable. Full stores refuse additional data, never evict dedupe
 * receipts. Discarding this store also discards its no-replay window. Hosts own retention.
 * ponytail: context/list queries scan at most maxTasks (1,000 by default). Use an indexed host
 * store when that bounded scan is too large; this reference store is not a database. */
export function createMemoryTaskStore(
  options: { maxTasks?: number; maxRecordBytes?: number; maxMessages?: number } = {},
): A2ATaskStore {
  const { maxTasks = 1000, maxRecordBytes = 1024 * 1024, maxMessages = 256 } = options;
  if ([maxTasks, maxRecordBytes, maxMessages].some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new A2AError("invalid");
  const records = new Map<string, A2ATaskRecord>();
  const messages = new Map<string, string>();
  const key = (scope: A2ATaskScope, id: string) => JSON.stringify([scopeKey(scope), id]);
  function save(record: A2ATaskRecord) {
    if (
      record.messages.length > maxMessages ||
      record.history.length > 100 ||
      record.push.length > 10 ||
      record.deliveries.length > 256 ||
      new TextEncoder().encode(JSON.stringify(record)).byteLength > maxRecordBytes
    )
      throw new A2AError("limit");
    const seen = new Set<string>();
    for (const message of record.messages) {
      const existing = messages.get(key(record, message.id));
      if (seen.has(message.id) || (existing && existing !== record.id)) throw new A2ATaskConflict();
      seen.add(message.id);
    }
    records.set(key(record, record.id), structuredClone(record));
    for (const message of record.messages) messages.set(key(record, message.id), record.id);
    return structuredClone(record);
  }
  return {
    async create(record) {
      if (record.messages.length !== 1 || record.messages[0]?.kind !== "start")
        throw new A2AError("invalid");
      const receipt = record.messages[0];
      const existingId = messages.get(key(record, receipt.id));
      const existing = records.get(key(record, existingId ?? record.id));
      if (existing) {
        const old = existing.messages.find((m) => m.id === receipt.id);
        if (!old || old.fingerprint !== receipt.fingerprint) throw new A2ATaskConflict();
        return { created: false, record: structuredClone(existing) };
      }
      if (records.size >= maxTasks) throw new A2AError("limit");
      return { created: true, record: save({ ...record, revision: crypto.randomUUID() }) };
    },
    async get(scope, id) {
      return structuredClone(records.get(key(scope, id)) ?? null);
    },
    async findMessage(scope, id) {
      const taskId = messages.get(key(scope, id));
      return structuredClone(taskId ? (records.get(key(scope, taskId)) ?? null) : null);
    },
    async update(scope, id, patch, revision) {
      const old = records.get(key(scope, id));
      if (!old) throw new A2AError("protocol", { code: -32001 });
      if (old.revision !== revision) throw new A2ATaskConflict();
      if (
        Object.keys(patch).some(
          (field) =>
            !["segment", "state", "messages", "history", "push", "deliveries", "cancel"].includes(
              field,
            ),
        )
      )
        throw new A2AError("invalid");
      if (patch.messages) {
        for (const [index, receipt] of old.messages.entries()) {
          const next = patch.messages[index];
          if (
            !next ||
            next.id !== receipt.id ||
            next.fingerprint !== receipt.fingerprint ||
            next.kind !== receipt.kind ||
            next.source !== receipt.source ||
            !equalData(next.answers, receipt.answers) ||
            (receipt.acceptance === "unknown" && next.acceptance === "pending") ||
            (receipt.acceptance === "accepted" && !equalData(next, receipt))
          )
            throw new A2ATaskConflict();
        }
      }
      if (a2aTerminal(old.state) && patch.state && patch.state !== old.state)
        throw new A2ATaskConflict();
      const changed =
        (patch.state !== undefined && patch.state !== old.state) ||
        (patch.segment !== undefined && patch.segment !== old.segment) ||
        (patch.history !== undefined && !equalData(patch.history, old.history));
      return save({
        ...old,
        ...structuredClone(patch),
        revision: crypto.randomUUID(),
        updatedAt: changed ? Date.now() : old.updatedAt,
      });
    },
    async list(scope, filter) {
      if (!Number.isSafeInteger(filter.pageSize) || filter.pageSize < 1 || filter.pageSize > 100)
        throw new A2AError("invalid");
      const prefix = scopeKey(scope);
      const found = [...records.values()].filter(
        (r) => scopeKey(r) === prefix && (!filter.contextId || r.contextId === filter.contextId),
      );
      const index = filter.pageToken ? found.findIndex((r) => r.id === filter.pageToken) + 1 : 0;
      if (filter.pageToken && index === 0) throw new A2AError("invalid");
      const tasks = found.slice(index, index + filter.pageSize);
      return {
        tasks: structuredClone(tasks),
        nextPageToken: index + tasks.length < found.length ? tasks.at(-1)!.id : "",
      };
    },
    async hasContext(scope, id) {
      const prefix = scopeKey(scope);
      return [...records.values()].some((r) => scopeKey(r) === prefix && r.contextId === id);
    },
  };
}

/** Install in every worker. scope must recover the original authenticated partition from host
 * storage. onChange is awaited; an end failure never changes the runtime's completed journal. */
export function a2aSegments(options: {
  tasks: A2ATaskStore;
  scope(owner: string, runId: string): A2ATaskScope | Promise<A2ATaskScope>;
  onChange?: (record: A2ATaskRecord, segment: Parameters<SegmentHook>[0]) => void | Promise<void>;
}): SegmentHook {
  return async (segment) => {
    const scope = await options.scope(segment.owner, segment.runId);
    if (scope.owner !== segment.owner) throw new A2AError("invalid");
    for (let attempt = 0; attempt < 4; attempt++) {
      const record = await options.tasks.get(scope, segment.runId);
      if (!record) throw new A2AError("protocol", { code: -32001 });
      if (a2aTerminal(record.state) || (segment.phase === "end" && record.segment !== segment.id))
        return;
      const state: A2AState =
        segment.phase === "start"
          ? "working"
          : segment.state.status === "completed"
            ? "completed"
            : segment.state.status === "cancelled"
              ? "canceled"
              : ["failed", "limited"].includes(segment.state.status)
                ? "failed"
                : "working";
      let updated: A2ATaskRecord;
      try {
        updated = await options.tasks.update(
          scope,
          record.id,
          { segment: segment.id, state },
          record.revision,
        );
      } catch (error) {
        if (!(error instanceof A2ATaskConflict) || attempt === 3) throw error;
        continue;
      }
      // Never retry a host callback: it may have sent a notification before throwing.
      await options.onChange?.(updated, segment);
      return;
    }
  };
}
