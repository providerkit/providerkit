/**
 * Drafts and unsent messages in the app's AsyncStorage, which the app passes in, so this package
 * depends on no storage library. Each is what `@providerkit/react` asks for: `DraftStorage` for the
 * composer's `draft`, and `PendingSendStorage` for the client's `pendingSend`.
 *
 * Every copy is kept under its scope, the person and the conversation, so a draft is never shown
 * to another account on the same phone.
 *
 * One queue runs every read and write here, in the order they were asked for. A screen that closes
 * saves its last edit without waiting for it, and when it opens again its first read must see that
 * edit, not the one before it. Nothing promises that AsyncStorage finishes calls in the order they
 * were made, so this queue does.
 */
import {
  draftScopeKey,
  type DraftScope,
  type DraftStorage,
  type PendingSendStorage,
  type StoredDraft,
  type StoredSend,
} from "@providerkit/react";

/** The three AsyncStorage calls this file makes. Versions 1 to 3 of AsyncStorage have all three. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
}

export interface StorageOptions {
  /** The start of every key, so two parts of an app keep their copies apart. Default
   * `providerkit`. Drafts go under `<prefix>.draft` and unsent messages under `<prefix>.unsent`,
   * so one part of an app can pass the same prefix to both. */
  prefix?: string;
}

const DEFAULT_PREFIX = "providerkit";

/** Which store a key belongs to. It is always part of the key: under one key, the client's
 * removal of an unsent message would delete the person's draft. */
type Store = "draft" | "unsent";

// ponytail: one queue for every key, so a slow write also holds up reads of other conversations.
// Upgrade: one queue per key, if that wait ever shows.
let queue: Promise<unknown> = Promise.resolve();

function inOrder<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task);
  // A call that fails fails for its caller, and the queue goes on.
  queue = next.catch(() => {});
  return next;
}

function keyOf(prefix: string, store: Store, scope: DraftScope): string {
  return `${prefix}.${store}:${draftScopeKey(scope)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The saved value, for the client to check, or null when nothing usable is saved. */
async function read(storage: KeyValueStorage, key: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return null;
  const raw = await storage.getItem(key);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Text that is not JSON can never be read back. The next save replaces it.
    return null;
  }
  // The client never restores a copy past its `expiresAt`, and deleting it is the storage's job.
  if (isRecord(value) && typeof value.expiresAt === "number" && value.expiresAt <= Date.now()) {
    await storage.removeItem(key);
    return null;
  }
  return value;
}

async function write(
  storage: KeyValueStorage,
  key: string,
  value: StoredDraft | StoredSend | null,
  signal?: AbortSignal,
): Promise<void> {
  // A save the composer cancelled while it waited its turn would overwrite a newer one.
  if (signal?.aborted) return;
  if (value === null) await storage.removeItem(key);
  else await storage.setItem(key, JSON.stringify(value));
}

/**
 * The composer's drafts, kept in AsyncStorage. Make it once, outside your components.
 *
 * ```ts
 * const drafts = createDraftStorage(AsyncStorage);
 * ```
 */
export function createDraftStorage(
  storage: KeyValueStorage,
  options: StorageOptions = {},
): DraftStorage {
  const { prefix = DEFAULT_PREFIX } = options;
  return {
    load: (scope, { signal }) =>
      inOrder(() => read(storage, keyOf(prefix, "draft", scope), signal)),
    save: (scope, draft, { signal }) =>
      inOrder(() => write(storage, keyOf(prefix, "draft", scope), draft, signal)),
  };
}

/**
 * The client's unsent message, kept in AsyncStorage so it survives a restart. Make it once,
 * outside your components.
 *
 * ```ts
 * const unsent = createPendingSendStorage(AsyncStorage);
 * ```
 */
export function createPendingSendStorage(
  storage: KeyValueStorage,
  options: StorageOptions = {},
): PendingSendStorage {
  const { prefix = DEFAULT_PREFIX } = options;
  return {
    load: (scope) => inOrder(() => read(storage, keyOf(prefix, "unsent", scope))),
    save: (scope, value) => inOrder(() => write(storage, keyOf(prefix, "unsent", scope), value)),
  };
}
