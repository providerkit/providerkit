import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposer, type ComposerOptions } from "../src/composer.ts";
import {
  createStoredDraft,
  draftScopeKey,
  parseDraft,
  parseStoredSend,
  type DraftScope,
  type DraftStorage,
  type StoredDraft,
  type StoredSend,
} from "../src/drafts.ts";
import type { SendResult } from "../src/client.ts";

const scope: DraftScope = { principalId: "person-1", conversationId: "chat-1" };
const content = {
  text: "A saved message",
  attachments: [{ id: "server-1", name: "notes.txt", mediaType: "text/plain", url: "/files/1" }],
  pendingFiles: 2,
};
const accepted: SendResult = { ok: true, messageId: "message-1", outcome: "accepted" };
const send: ComposerOptions["send"] = async () => accepted;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

function mount(storage: DraftStorage, options: Partial<ComposerOptions> = {}) {
  const composer = createComposer({
    scope,
    send,
    draft: { storage, retentionMs: 60_000, debounceMs: 1 },
    ...options,
  });
  stops.push(composer.attach());
  return composer;
}

describe("draft data", () => {
  it("requires both principal and conversation and uses an unambiguous scope key", () => {
    expect(() => draftScopeKey({ ...scope, principalId: "" })).toThrow();
    expect(() => draftScopeKey({ ...scope, conversationId: " " })).toThrow();
    expect(draftScopeKey({ principalId: "a:b", conversationId: "c" })).not.toBe(
      draftScopeKey({ principalId: "a", conversationId: "b:c" }),
    );
  });

  it("versions references and rejects expired, cross-scope and malformed data", () => {
    const stored = createStoredDraft(scope, content, 100, 1_000);
    expect(parseDraft(stored, scope, 1_050)).toEqual(stored);
    expect(parseDraft(stored, scope, 1_100)).toBeNull();
    expect(parseDraft(stored, { ...scope, principalId: "person-2" }, 1_050)).toBeNull();
    expect(parseDraft({ ...stored, v: 2 }, scope, 1_050)).toBeNull();
    expect(parseDraft({ ...stored, savedAt: 1_060 }, scope, 1_050)).toBeNull();
    expect(parseDraft({ ...stored, pendingFiles: -1 }, scope, 1_050)).toBeNull();
    expect(
      parseDraft(
        { ...stored, attachments: [...content.attachments, ...content.attachments] },
        scope,
        1_050,
      ),
    ).toBeNull();
    for (const url of ["blob:old", "data:text/plain;base64,c2VjcmV0", "javascript:void(0)"]) {
      expect(
        parseDraft({ ...stored, attachments: [{ ...content.attachments[0], url }] }, scope, 1_050),
      ).toBeNull();
    }
    for (const retention of [0, -1, Infinity, NaN])
      expect(() => createStoredDraft(scope, content, retention)).toThrow();
  });

  it("restores a saved unconfirmed message only for its scope, within retention, as a valid send", () => {
    const saved: StoredSend = {
      v: 1,
      scope,
      input: { clientId: "client-1", text: "Hello", attachments: content.attachments },
      savedAt: 1_000,
      expiresAt: 1_100,
    };
    expect(parseStoredSend(saved, scope, 100, 1_050)).toEqual(saved);
    expect(parseStoredSend(saved, { ...scope, conversationId: "chat-2" }, 100, 1_050)).toBeNull();
    expect(parseStoredSend(saved, scope, 100, 1_100)).toBeNull();
    // A shorter retention also applies to a copy saved under a longer one.
    expect(parseStoredSend(saved, scope, 40, 1_050)).toBeNull();
    for (const input of [
      { text: "Hello" },
      { clientId: "", text: "Hello" },
      { clientId: "client-1", text: "   " },
      { clientId: "client-1", text: "Hi", attachments: [{ id: "file" }] },
    ])
      expect(parseStoredSend({ ...saved, input }, scope, 100, 1_050)).toBeNull();
  });
});

describe("scoped persistence", () => {
  it("loads uploaded references and reports files that need reselection, without sending", async () => {
    const stored = createStoredDraft(scope, content, 60_000);
    const sendMessage = vi.fn(send);
    const storage = { load: vi.fn(async () => stored), save: vi.fn(async () => {}) };
    const composer = mount(storage, { send: sendMessage });
    await Promise.resolve();
    expect(composer.getState().text).toBe(content.text);
    expect(composer.getState().attachments[0]).toMatchObject({
      state: "ready",
      reference: content.attachments[0],
    });
    expect(composer.getState().attachments[0]?.file).toBeUndefined();
    expect(composer.getState().draft).toEqual({ status: "saved", missingFiles: 2 });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("does not replace typing with a slow saved draft", async () => {
    vi.useFakeTimers();
    const load = deferred<unknown>();
    const storage = {
      load: vi.fn(() => load.promise),
      save: vi.fn<DraftStorage["save"]>(async () => {}),
    };
    const composer = mount(storage);
    composer.setText("Already writing");
    load.resolve(createStoredDraft(scope, content, 60_000));
    await Promise.resolve();
    expect(composer.getState().text).toBe("Already writing");
    await vi.runOnlyPendingTimersAsync();
    expect(storage.save.mock.calls[0]?.[1].text).toBe("Already writing");
    expect(composer.getState().draft.status).toBe("saved");
  });

  it("ignores expired drafts, including a now-shorter host retention policy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    for (const stored of [
      createStoredDraft(scope, content, 50, 9_000),
      createStoredDraft(scope, content, 5_000, 9_000),
    ]) {
      const storage: DraftStorage = { load: async () => stored, save: async () => {} };
      const composer = mount(storage, { draft: { storage, retentionMs: 100 } });
      await Promise.resolve();
      expect(composer.getState().text).toBe("");
      expect(composer.getState().draft.status).toBe("idle");
    }
  });

  it("saves the latest edit on detach before the default debounce, under its own scope", async () => {
    vi.useFakeTimers();
    const saved = new Map([[draftScopeKey(scope), createStoredDraft(scope, content, 60_000)]]);
    const storage: DraftStorage = {
      load: async (key) => saved.get(draftScopeKey(key)),
      save: vi.fn(async (key, draft) => {
        saved.set(draftScopeKey(key), draft);
      }),
    };
    const composer = mount(storage, { draft: { storage, retentionMs: 60_000 } });
    await Promise.resolve();
    expect(composer.getState().text).toBe(content.text);
    composer.setText("Latest edit");
    stops.pop()?.();
    const other = mount(storage, { scope: { ...scope, conversationId: "chat-2" } });
    await Promise.resolve();
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storage.save).mock.calls[0]?.[0]).toEqual(scope);
    expect(other.getState().text).toBe("");
    const restored = mount(storage);
    await Promise.resolve();
    expect(restored.getState().text).toBe("Latest edit");
    await vi.runOnlyPendingTimersAsync();
    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight save before flushing a detached scope's latest revision", async () => {
    vi.useFakeTimers();
    const firstSave = deferred<void>();
    const latestSave = deferred<void>();
    const written: StoredDraft[] = [];
    const storage: DraftStorage = {
      load: async () => null,
      save: vi.fn(async (_scope, value) => {
        written.push(value);
        await (written.length === 1 ? firstSave.promise : latestSave.promise);
      }),
    };
    const composer = mount(storage);
    composer.setText("Earlier edit");
    await vi.runOnlyPendingTimersAsync();
    composer.setText("Latest edit");
    stops.pop()?.();
    const flushed = vi.fn();
    const flushing = composer.flushDraft().then(flushed);
    const current = mount(storage, { scope: { ...scope, principalId: "person-2" } });
    current.setText("Other person's draft");
    expect(written.map((draft) => draft.text)).toEqual(["Earlier edit"]);
    expect(vi.mocked(storage.save).mock.calls[0]?.[2].signal.aborted).toBe(false);

    firstSave.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(written.map((draft) => draft.text)).toEqual(["Earlier edit", "Latest edit"]);
    expect(written.map((draft) => draft.scope)).toEqual([scope, scope]);
    expect(flushed).not.toHaveBeenCalled();
    latestSave.resolve();
    await flushing;
    expect(flushed).toHaveBeenCalledWith(true);
    expect(current.getState().text).toBe("Other person's draft");
    expect(current.getState().draft.status).toBe("unsaved");
  });

  it("serializes writes and saves only the revision left after an accepted send", async () => {
    vi.useFakeTimers();
    const firstSave = deferred<void>();
    const reply = deferred<SendResult>();
    const written: StoredDraft[] = [];
    const storage: DraftStorage = {
      load: async () => null,
      save: vi.fn(async (_scope, value) => {
        written.push(value);
        if (written.length === 1) await firstSave.promise;
      }),
    };
    const composer = mount(storage, { send: () => reply.promise });
    composer.setText("First message");
    await vi.runOnlyPendingTimersAsync();
    const sending = composer.submit();
    composer.setText("Next message");
    await vi.runOnlyPendingTimersAsync();
    expect(written.map((value) => value.text)).toEqual(["First message"]);
    reply.resolve(accepted);
    await sending;
    await vi.runOnlyPendingTimersAsync();
    firstSave.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(written.map((value) => value.text)).toEqual(["First message", "Next message"]);
    expect(composer.getState().text).toBe("Next message");
  });

  it("does not store local bytes, and accepted sends replace the stored text with an empty draft", async () => {
    vi.useFakeTimers();
    const written: StoredDraft[] = [];
    const storage: DraftStorage = {
      load: async () => null,
      save: async (_scope, value) => {
        written.push(value);
      },
    };
    const composer = mount(storage, { initialAttachments: content.attachments });
    composer.setText("Send this");
    await vi.runOnlyPendingTimersAsync();
    await composer.submit();
    await vi.runOnlyPendingTimersAsync();
    expect(written.at(-1)).toMatchObject({
      v: 1,
      scope,
      text: "",
      attachments: [],
      pendingFiles: 0,
    });
    expect(JSON.stringify(written)).not.toContain("blob:");
  });

  it("retains the in-memory draft after a save failure and offers an explicit retry", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn<DraftStorage["save"]>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const composer = mount({ load: async () => null, save });
    composer.setText("Keep this");
    await vi.runOnlyPendingTimersAsync();
    expect(composer.getState().text).toBe("Keep this");
    expect(composer.getState().draft).toMatchObject({ status: "failed", problem: "save" });
    expect(await composer.flushDraft()).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    composer.retryDraft();
    expect(await composer.flushDraft()).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(composer.getState().draft.status).toBe("saved");
  });

  it("reports a load failure and retries only on request", async () => {
    const stored = createStoredDraft(scope, content, 60_000);
    const load = vi
      .fn<DraftStorage["load"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(stored);
    const composer = mount({ load, save: async () => {} });
    await Promise.resolve();
    expect(composer.getState().draft).toMatchObject({ status: "failed", problem: "load" });
    expect(load).toHaveBeenCalledTimes(1);
    composer.retryDraft();
    await Promise.resolve();
    expect(composer.getState().text).toBe(content.text);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("persists only a count for pending local files", async () => {
    vi.useFakeTimers();
    const save = vi.fn<DraftStorage["save"]>(async () => {});
    const composer = mount(
      { load: async () => null, save },
      {
        attachments: { upload: () => new Promise(() => {}) },
      },
    );
    composer.addFiles([new File(["private bytes"], "photo.png", { type: "image/png" })]);
    await vi.runOnlyPendingTimersAsync();
    const stored = save.mock.calls[0]?.[1];
    expect(stored).toMatchObject({ attachments: [], pendingFiles: 1 });
    expect(JSON.stringify(stored)).not.toContain("private bytes");
    expect(JSON.stringify(stored)).not.toContain("photo.png");
  });

  it.each<SendResult>([
    { ok: false, error: { code: "refused", message: "Not sent." } },
    { ok: true, messageId: "message-1", outcome: "unknown" },
  ])("never clears a persisted draft without acceptance: %j", async (result) => {
    vi.useFakeTimers();
    const save = vi.fn<DraftStorage["save"]>(async () => {});
    const composer = mount({ load: async () => null, save }, { send: async () => result });
    composer.setText("Keep this");
    await vi.runOnlyPendingTimersAsync();
    await composer.submit();
    await vi.runOnlyPendingTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1].text).toBe("Keep this");
  });

  it("aborts old-scope loads but lets writes finish without changing the new scope", async () => {
    vi.useFakeTimers();
    const load = deferred<unknown>();
    const write = deferred<void>();
    const storage: DraftStorage = {
      load: vi.fn(() => load.promise),
      save: vi.fn(() => write.promise),
    };
    const old = mount(storage);
    old.setText("Old scope");
    await vi.runOnlyPendingTimersAsync();
    stops.pop()?.();
    const current = mount(storage, { scope: { ...scope, principalId: "person-2" } });
    current.setText("New scope");
    load.resolve(createStoredDraft(scope, content, 60_000));
    write.reject(new Error("late error"));
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(storage.load).mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(vi.mocked(storage.save).mock.calls[0]?.[2].signal.aborted).toBe(false);
    expect(current.getState().text).toBe("New scope");
    expect(current.getState().draft.problem).toBeUndefined();
  });
});
