// Adapted from TanStack AI (MIT), ai-memory/internal/store.ts and testkit/contract.ts.
// Copyright (c) 2025 Tanner Linsley. Changed: Unicode words, every scope dimension,
// atomic version checks, erasure generations and ingestion receipts; no vector calls.
import {
  MEMORY_LIMITS,
  MemoryConflictError,
  MemoryErasedError,
  isMemoryAccess,
  isMemoryScope,
  memoryKey,
  memoryScopeKey,
  readMemoryDeletions,
  readMemoryIngest,
  readMemoryNotes,
  sameMemoryScope,
  type MemoryAccess,
  type MemoryCall,
  type MemoryIngestReceipt,
  type MemoryInput,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
} from "./memory.ts";
import { requestHash } from "./request.ts";
import { copyData, equalData, isId } from "./snapshot.ts";

/** Process-lifetime reference only: no persistence, database, embedding calls or scheduler. */
export function createMemoryStore(options: { now?: () => number } = {}): MemoryStore {
  const now = options.now ?? Date.now;
  const records = new Map<string, MemoryRecord>();
  const revisions = new Map<string, string>();
  const receipts = new Map<string, { access: MemoryAccess; receipt: MemoryIngestReceipt }>();
  const personKey = (scope: MemoryScope) => JSON.stringify([scope.tenantId, scope.userId ?? null]);
  const recordKey = (scope: MemoryScope, key: string) =>
    JSON.stringify([memoryScopeKey(scope), key]);
  const receiptKey = (access: MemoryAccess, runId: string) =>
    JSON.stringify([memoryScopeKey(access.scope), access.revision, runId]);
  function revision(scope: MemoryScope): string {
    const key = personKey(scope);
    let value = revisions.get(key);
    if (!value) {
      value = crypto.randomUUID();
      revisions.set(key, value);
    }
    return value;
  }
  function check(access: MemoryAccess, call: MemoryCall): void {
    call.signal.throwIfAborted();
    if (!isMemoryAccess(access))
      throw new TypeError("Memory needs an exact scope and erasure revision.");
    if (revision(access.scope) !== access.revision) throw new MemoryErasedError();
  }
  function live(record?: MemoryRecord): record is MemoryRecord {
    return !!record && (record.expiresAt === undefined || record.expiresAt > now());
  }
  function current(access: MemoryAccess, key: string): MemoryRecord | undefined {
    const record = records.get(recordKey(access.scope, key));
    return live(record) ? record : undefined;
  }
  function prepare(
    access: MemoryAccess,
    raw: readonly MemoryInput[],
    call: MemoryCall,
  ): MemoryRecord[] {
    const notes = readMemoryNotes(raw);
    check(access, call);
    const at = now();
    return notes.map((note) => {
      const before = current(access, note.key);
      if ((before?.version ?? null) !== note.version) throw new MemoryConflictError();
      return {
        ...copyData(note),
        scope: copyData(access.scope),
        version: crypto.randomUUID(),
        createdAt: before?.createdAt ?? at,
        updatedAt: at,
      };
    });
  }
  function commit(notes: MemoryRecord[]): void {
    for (const note of notes) records.set(recordKey(note.scope, note.key), note);
  }
  function keys(raw: readonly string[]): void {
    if (
      !Array.isArray(raw) ||
      raw.length < 1 ||
      raw.length > MEMORY_LIMITS.batch ||
      !raw.every(memoryKey) ||
      new Set(raw).size !== raw.length
    )
      throw new TypeError("Read 1 to 20 unique note keys.");
  }
  const words = (text: string) =>
    new Set(
      text
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    );
  return {
    async access(scope, call) {
      call.signal.throwIfAborted();
      if (!isMemoryScope(scope))
        throw new TypeError("Supply an explicit tenant and valid memory scope.");
      return { scope: copyData(scope), revision: revision(scope) };
    },
    async get({ access, keys: names }, call) {
      check(access, call);
      keys(names);
      return copyData(
        names.flatMap((key) => {
          const note = current(access, key);
          return note ? [note] : [];
        }),
      );
    },
    async search({ scopes, query, limit }, call) {
      if (
        !Array.isArray(scopes) ||
        !scopes.length ||
        scopes.length > MEMORY_LIMITS.scopes ||
        typeof query !== "string" ||
        query.length > MEMORY_LIMITS.queryChars ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MEMORY_LIMITS.matches
      )
        throw new TypeError("Search needs bounded scopes, query and limit.");
      for (const access of scopes) check(access, call);
      if (new Set(scopes.map((access) => memoryScopeKey(access.scope))).size !== scopes.length)
        throw new TypeError("Search each scope once.");
      const tokens = words(query);
      // ponytail: linear scan for offline examples. Use a host database index for production.
      return copyData(
        [...records.values()]
          .filter(
            (note) =>
              live(note) && scopes.some((access) => sameMemoryScope(access.scope, note.scope)),
          )
          .map((note) => {
            const text = words(note.text);
            const score =
              [...tokens].filter((token) => text.has(token)).length / (tokens.size || 1);
            return { note, score };
          })
          .filter(({ score }) => score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.note.updatedAt - a.note.updatedAt ||
              a.note.key.localeCompare(b.note.key),
          )
          .slice(0, limit)
          .map(({ note }) => note),
      );
    },
    async save({ access, notes }, call) {
      const prepared = prepare(access, notes, call);
      commit(prepared);
      return copyData(prepared);
    },
    async delete({ access, notes: raw }, call) {
      const notes = readMemoryDeletions(raw);
      check(access, call);
      if (notes.some((note) => current(access, note.key)?.version !== note.version))
        throw new MemoryConflictError();
      for (const note of notes) records.delete(recordKey(access.scope, note.key));
      return { deleted: notes.length };
    },
    async erase(person, call) {
      call.signal.throwIfAborted();
      if (
        !isMemoryScope(person) ||
        !person.userId ||
        Object.keys(person).some((key) => key !== "tenantId" && key !== "userId")
      )
        throw new TypeError("Erasure needs exactly one tenant and one person.");
      const key = personKey(person);
      // Fence every namespace, including one with no records yet. No wall-clock race or skew.
      revisions.set(key, crypto.randomUUID());
      for (const [id, note] of records) if (personKey(note.scope) === key) records.delete(id);
      for (const [id, entry] of receipts)
        if (personKey(entry.access.scope) === key) receipts.delete(id);
    },
    async ingest(raw, call) {
      const request = readMemoryIngest(raw);
      check(request.access, call);
      const fingerprint = await requestHash(request);
      // Hashing yields. Recheck after it, in the same synchronous section as CAS and commit.
      check(request.access, call);
      const key = receiptKey(request.access, request.runId);
      const prior = receipts.get(key);
      if (prior) {
        if (prior.receipt.fingerprint !== fingerprint) throw new MemoryConflictError();
        return copyData(prior.receipt);
      }
      const notes = prepare(request.access, request.notes, call);
      const receipt = {
        runId: request.runId,
        fingerprint,
        saved: notes.map(({ key, version }) => ({ key, version })),
      };
      commit(notes);
      receipts.set(key, { access: copyData(request.access), receipt });
      return copyData(receipt);
    },
    async receipt({ access, runId }, call) {
      check(access, call);
      if (!isId(runId)) throw new TypeError("A receipt needs its run id.");
      return copyData(receipts.get(receiptKey(access, runId))?.receipt ?? null);
    },
  };
}

/** DESTRUCTIVE check. The caller explicitly supplies a disposable store, never a live one.
 * Adapted from TanStack's contract suite without depending on a test runner. */
export async function checkMemoryStore(options: { disposable: MemoryStore }): Promise<void> {
  const store = options.disposable;
  const call = { signal: new AbortController().signal };
  const tenantId = `memory-check-${crypto.randomUUID()}`;
  const scope = { tenantId, userId: "4", sessionId: "__proto__", namespace: "notes" };
  function assert(ok: boolean, rule: string): asserts ok {
    if (!ok) throw new Error(`MemoryStore failed: ${rule}.`);
  }
  async function conflict(work: Promise<unknown>, name: string) {
    try {
      await work;
    } catch (error) {
      assert(error instanceof Error && error.name === name, name);
      return;
    }
    throw new Error(`MemoryStore failed: expected ${name}.`);
  }
  const access = await store.access(scope, call);
  assert(equalData(access.scope, scope), "access keeps the exact scope");
  assert(
    (await store.search({ scopes: [access], query: "coffee", limit: 1 }, call)).length === 0,
    "empty store",
  );
  const saved = await store.save(
    { access, notes: [{ key: "preference", text: "coffee", version: null }] },
    call,
  );
  const note = saved[0];
  assert(!!note && note.text === "coffee" && isId(note.version), "save receipt");
  const version = note.version;
  note.text = "changed copy";
  const found = await store.search({ scopes: [access], query: "coffee", limit: 1 }, call);
  assert(found.length === 1 && found[0]?.text === "coffee", "round trip and write cloning");
  if (found[0]) found[0].text = "changed read";
  assert(
    (await store.get({ access, keys: ["preference"] }, call))[0]?.text === "coffee",
    "read cloning",
  );
  const others = [
    { ...scope, tenantId: `${tenantId}-other` },
    { ...scope, userId: "42" },
    { ...scope, sessionId: "other" },
    { ...scope, namespace: "other" },
    { tenantId, userId: "4" },
    { tenantId },
  ];
  for (const other of others) {
    const otherAccess = await store.access(other, call);
    assert(
      (await store.get({ access: otherAccess, keys: ["preference"] }, call)).length === 0,
      "exact get isolation",
    );
    assert(
      (await store.search({ scopes: [otherAccess], query: "coffee", limit: 1 }, call)).length === 0,
      "exact search isolation",
    );
  }
  const results = await Promise.allSettled(
    ["a", "b"].map((text) =>
      store.save({ access, notes: [{ key: "preference", text, version }] }, call),
    ),
  );
  assert(
    results.filter((result) => result.status === "fulfilled").length === 1,
    "one winner for a version race",
  );
  await conflict(
    store.delete({ access, notes: [{ key: "preference", version }] }, call),
    "MemoryConflictError",
  );
  const current = (await store.get({ access, keys: ["preference"] }, call))[0];
  assert(!!current && current.version !== version, "versions change");
  await store.delete({ access, notes: [{ key: "preference", version: current.version }] }, call);
  assert(
    (await store.get({ access, keys: ["preference"] }, call)).length === 0,
    "delete by version",
  );
  await store.save(
    {
      access,
      notes: [
        { key: "extra1", text: "coffee", version: null },
        { key: "extra2", text: "coffee", version: null },
      ],
    },
    call,
  );
  assert(
    (await store.search({ scopes: [access], query: "coffee", limit: 1 }, call)).length === 1,
    "search limit",
  );
  await store.save(
    { access, notes: [{ key: "expired", text: "coffee", version: null, expiresAt: 0 }] },
    call,
  );
  assert((await store.get({ access, keys: ["expired"] }, call)).length === 0, "expiry");
  const sibling = await store.access({ ...scope, userId: "42" }, call);
  const tenant = await store.access({ ...scope, tenantId: `${tenantId}-other` }, call);
  for (const other of [sibling, tenant])
    await store.save(
      { access: other, notes: [{ key: "kept", text: "coffee", version: null }] },
      call,
    );
  if (store.ingest && store.receipt) {
    const request = {
      access,
      runId: "run",
      agent: { id: "agent", version: "1" },
      messages: [],
      notes: [{ key: "fact", text: "coffee", version: null }],
    };
    const first = await store.ingest(request, call);
    assert(
      equalData(first, await store.ingest(request, call)),
      "atomic duplicate ingestion receipt",
    );
    assert(
      equalData(first, await store.receipt({ access, runId: "run" }, call)),
      "read-only ingestion reconciliation",
    );
    await conflict(
      store.ingest({ ...request, notes: [{ key: "fact", text: "other", version: null }] }, call),
      "MemoryConflictError",
    );
  }
  await store.erase({ tenantId, userId: "4" }, call);
  await conflict(
    store.save({ access, notes: [{ key: "late", text: "coffee", version: null }] }, call),
    "MemoryErasedError",
  );
  for (const other of [sibling, tenant])
    assert(
      (await store.get({ access: other, keys: ["kept"] }, call)).length === 1,
      "erasure isolates tenant and person",
    );
  const fresh = await store.access(scope, call);
  assert(
    fresh.revision !== access.revision &&
      (await store.get({ access: fresh, keys: ["fact"] }, call)).length === 0,
    "erase removes data and rotates revision",
  );
  if (store.receipt)
    assert(
      (await store.receipt({ access: fresh, runId: "run" }, call)) === null,
      "erase removes ingestion receipts",
    );
  await store.erase({ tenantId, userId: "42" }, call);
  await store.erase({ tenantId: `${tenantId}-other`, userId: "4" }, call);
}
