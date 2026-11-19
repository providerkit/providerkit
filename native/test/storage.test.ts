import {
  createChatClient,
  createComposer,
  type ChatTransport,
  type DraftScope,
  type SendResult,
  type StoredDraft,
  type StoredSend,
} from "@providerkit/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDraftStorage,
  createPendingSendStorage,
  type KeyValueStorage,
} from "../src/storage.ts";

const DAY = 86_400_000;
const scope: DraftScope = { principalId: "person-1", conversationId: "chat-1" };
const signal = new AbortController().signal;

/** AsyncStorage as a test sees it: strings in a map. */
function memory() {
  const items = new Map<string, string>();
  const storage = {
    getItem: vi.fn(async (key: string) => items.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      items.delete(key);
    }),
  } satisfies KeyValueStorage;
  return { items, storage };
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function draft(text: string, now = Date.now()): StoredDraft {
  return {
    v: 1,
    scope,
    text,
    attachments: [],
    pendingFiles: 0,
    savedAt: now,
    expiresAt: now + DAY,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Runs everything already due: promise callbacks, and timers at zero. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("createDraftStorage", () => {
  it("keeps a draft under its person and conversation, and shows it to no one else", async () => {
    const { items, storage } = memory();
    const drafts = createDraftStorage(storage);
    const saved = draft("Half a thought");
    await drafts.save(scope, saved, { signal });
    expect([...items.keys()]).toEqual(['providerkit.draft:["person-1","chat-1"]']);
    expect(await drafts.load(scope, { signal })).toEqual(saved);
    expect(await drafts.load({ ...scope, principalId: "person-2" }, { signal })).toBeNull();
    expect(await drafts.load({ ...scope, conversationId: "chat-2" }, { signal })).toBeNull();
  });

  it("reads after the last save, even one that has not finished", async () => {
    const { items, storage } = memory();
    const landed = deferred();
    storage.setItem.mockImplementationOnce(async (key, value) => {
      await landed.promise;
      items.set(key, value);
    });
    const drafts = createDraftStorage(storage);
    const saving = drafts.save(scope, draft("The last edit"), { signal });
    const loading = drafts.load(scope, { signal });
    await flush();
    expect(storage.getItem).not.toHaveBeenCalled();
    landed.resolve();
    await saving;
    expect(await loading).toMatchObject({ text: "The last edit" });
  });

  it("brings back the edit a closed screen saved on its way out when the screen opens again", async () => {
    // Nothing in AsyncStorage stops a write from finishing after a read that started later.
    const { items, storage } = memory();
    storage.setItem.mockImplementation(async (key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      items.set(key, value);
    });
    const drafts = createDraftStorage(storage);
    const accepted: SendResult = { ok: true, messageId: "m1", outcome: "accepted" };
    const options = {
      scope,
      send: async () => accepted,
      draft: { storage: drafts, retentionMs: DAY },
    };
    const before = createComposer(options);
    const leave = before.attach();
    await flush();
    before.setText("Half a thought");
    // Closing the screen saves the edit, and nobody waits for that save.
    leave();
    const after = createComposer(options);
    after.attach();
    await vi.advanceTimersByTimeAsync(100);
    expect(after.getState()).toMatchObject({ text: "Half a thought", draft: { status: "saved" } });
  });

  it("does not write a save the composer cancelled", async () => {
    const { storage } = memory();
    const cancelled = new AbortController();
    cancelled.abort();
    await createDraftStorage(storage).save(scope, draft("Old"), { signal: cancelled.signal });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("deletes a copy past its expiry when it reads it", async () => {
    const { items, storage } = memory();
    const now = Date.now();
    const key = 'providerkit.draft:["person-1","chat-1"]';
    items.set(key, JSON.stringify({ ...draft("Stale", now - 2 * DAY), expiresAt: now - DAY }));
    expect(await createDraftStorage(storage).load(scope, { signal })).toBeNull();
    expect(items.has(key)).toBe(false);
  });

  it("reads text that is not JSON as nothing saved", async () => {
    const { items, storage } = memory();
    items.set('providerkit.draft:["person-1","chat-1"]', "{not json");
    expect(await createDraftStorage(storage).load(scope, { signal })).toBeNull();
  });

  it("keeps two parts of an app apart with their own prefix", async () => {
    const { items, storage } = memory();
    await createDraftStorage(storage, { prefix: "app.ask" }).save(scope, draft("Ask"), { signal });
    expect([...items.keys()]).toEqual(['app.ask:["person-1","chat-1"]']);
    expect(await createDraftStorage(storage).load(scope, { signal })).toBeNull();
  });

  it("refuses a scope without a person or a conversation, before touching storage", async () => {
    const { storage } = memory();
    const drafts = createDraftStorage(storage);
    await expect(drafts.load({ ...scope, principalId: " " }, { signal })).rejects.toThrow(
      TypeError,
    );
    await expect(
      drafts.save({ ...scope, conversationId: "" }, draft("x"), { signal }),
    ).rejects.toThrow(TypeError);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

describe("createPendingSendStorage", () => {
  it("keeps the unsent message, and removes it when the client saves null", async () => {
    const { items, storage } = memory();
    const unsent = createPendingSendStorage(storage);
    const now = Date.now();
    const stored: StoredSend = {
      v: 1,
      scope,
      input: { clientId: "c1", text: "Hello" },
      savedAt: now,
      expiresAt: now + DAY,
    };
    await unsent.save(scope, stored);
    expect([...items.keys()]).toEqual(['providerkit.unsent:["person-1","chat-1"]']);
    expect(await unsent.load(scope)).toEqual(stored);
    await unsent.save(scope, null);
    expect(items.size).toBe(0);
    expect(await unsent.load(scope)).toBeNull();
  });

  it("brings a message whose reply was lost back after a restart, for the person to send again", async () => {
    const { items, storage } = memory();
    const pendingSend = { storage: createPendingSendStorage(storage), scope, retentionMs: DAY };
    const send = vi
      .fn<NonNullable<ChatTransport["send"]>>()
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValue(undefined);
    const before = createChatClient({ transport: { send }, pendingSend });
    expect(await before.send("Did this arrive?")).toMatchObject({ ok: true, outcome: "unknown" });
    const input = send.mock.calls[0]?.[0];
    if (!input) throw new Error("The send did not go out.");
    // The app restarts: a new client on the same storage.
    const after = createChatClient({ transport: { send }, pendingSend });
    const detach = after.attach();
    await flush();
    expect(after.getState().messages).toMatchObject([
      { id: input.clientId, role: "user", state: "failed" },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await after.retry(input.clientId)).toMatchObject({ ok: true, outcome: "accepted" });
    expect(send.mock.calls[1]?.[0]).toEqual(input);
    await flush();
    expect(items.size).toBe(0);
    detach();
  });
});
