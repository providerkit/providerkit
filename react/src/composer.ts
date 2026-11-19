"use client";

import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  normalizeAttachmentRef,
  validateAttachment,
  type AttachmentFile,
  type AttachmentItem,
  type AttachmentOptions,
} from "./attachments.ts";
import type { AttachmentRef, MessageInput, SendResult } from "./client.ts";
import {
  createStoredDraft,
  draftScopeKey,
  parseDraft,
  type DraftOptions,
  type DraftScope,
  type DraftState,
} from "./drafts.ts";
import type { DisplayError } from "./protocol.ts";

/** `F` is the file type `addFiles` takes: a web `File` whenever `attachments.upload` can take one,
 * or else the phone picker's type that `upload` takes (see `AttachmentFile`). */
export interface ComposerOptions<F extends AttachmentFile = File> {
  /** A change to either id starts an isolated composer, even without persistence. */
  scope: DraftScope;
  send: (input: MessageInput) => Promise<SendResult>;
  canSend?: boolean;
  initialText?: string;
  initialAttachments?: readonly AttachmentRef[];
  attachments?: AttachmentOptions<F>;
  draft?: DraftOptions;
}

export interface ComposerState<F extends AttachmentFile = File> {
  text: string;
  attachments: readonly AttachmentItem<F>[];
  revision: number;
  submitting: boolean;
  canSubmit: boolean;
  result?: SendResult;
  error?: DisplayError;
  draft: DraftState;
}

export interface ComposerController<F extends AttachmentFile = File> {
  getState(): ComposerState<F>;
  subscribe(listener: () => void): () => void;
  /** Starts opt-in draft loading. Cleanup cancels uploads and loading, then flushes pending saves.
   * Await flushDraft before navigation or reload when the save must finish first. */
  attach(): () => void;
  /** Same scope only. Make a new controller for another principal or conversation. */
  setOptions(options: ComposerOptions<F>): void;
  setText(text: string): void;
  addFiles(files: readonly F[]): void;
  removeAttachment(id: string): void;
  retryAttachment(id: string): void;
  /** No automatic retries. A duplicate call while sending returns undefined. */
  submit(): Promise<SendResult | undefined>;
  /** Save pending edits now and wait for ordered writes. False means the draft is not saved;
   * keep it open and offer retryDraft. No pending edits or persistence off returns true. */
  flushDraft(): Promise<boolean>;
  retryDraft(): void;
  dismissMissingFiles(): void;
}

export interface ComposerValue<F extends AttachmentFile = File> extends ComposerState<F> {
  setText: ComposerController<F>["setText"];
  addFiles: ComposerController<F>["addFiles"];
  removeAttachment: ComposerController<F>["removeAttachment"];
  retryAttachment: ComposerController<F>["retryAttachment"];
  submit: ComposerController<F>["submit"];
  flushDraft: ComposerController<F>["flushDraft"];
  retryDraft: ComposerController<F>["retryDraft"];
  dismissMissingFiles: ComposerController<F>["dismissMissingFiles"];
}

const unconfirmed: DisplayError = {
  code: "unconfirmed",
  message: "Delivery is not confirmed. Check the conversation before sending again.",
};

function checkOptions<F extends AttachmentFile>(options: ComposerOptions<F>): void {
  draftScopeKey(options.scope);
  if (
    options.draft &&
    (!Number.isFinite(options.draft.retentionMs) ||
      options.draft.retentionMs <= 0 ||
      !Number.isFinite(Date.now() + options.draft.retentionMs))
  )
    throw new Error("Draft retentionMs must be a finite positive number.");
  if (
    options.draft?.debounceMs !== undefined &&
    (!Number.isFinite(options.draft.debounceMs) || options.draft.debounceMs < 0)
  )
    throw new Error("Draft debounceMs must be a nonnegative number.");
  for (const value of [
    options.attachments?.rules?.maxFiles,
    options.attachments?.rules?.maxFileBytes,
  ])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("Attachment limits must be nonnegative whole numbers.");
}

// The web signature comes first, and it is the one these functions had before `F` existed, so any
// call that compiled then keeps a `File`. With only the generic one, an uploader typed for a wider
// type, like `(file: Blob) => ...`, makes TypeScript infer `F` as `Blob`, which fails the
// `AttachmentFile` constraint, so `F` falls back to `AttachmentFile` and the call stops compiling.
/** Local composition only: no transport, conversation store, auth or upload storage. All async
 * acknowledgements belong to this scope and the revision that started them. */
export function createComposer(options: ComposerOptions): ComposerController;
/** A phone picker's file: `F` is the type `attachments.upload` takes. */
export function createComposer<F extends AttachmentFile>(
  options: ComposerOptions<F>,
): ComposerController<F>;
export function createComposer<F extends AttachmentFile>(
  options: ComposerOptions<F>,
): ComposerController<F> {
  checkOptions(options);
  const scope = Object.freeze({ ...options.scope });
  let settings = options;
  let nextId = 0;
  let textRevision = 0;
  let generation = 0;
  let active = true;
  let attached = 0;
  const listeners = new Set<() => void>();
  const uploads = new Map<string, AbortController>();
  let load: AbortController | undefined;
  let write: AbortController | undefined;
  let saveTask: Promise<void> = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveWanted = false;

  function ready(reference: AttachmentRef): AttachmentItem<F> {
    const normalized = normalizeAttachmentRef(reference);
    if (!normalized) throw new Error("Initial attachments must be confirmed server references.");
    return { ...normalized, id: `attachment-${++nextId}`, state: "ready", reference: normalized };
  }

  const initialAttachments = (options.initialAttachments ?? []).map(ready);
  if (
    new Set(options.initialAttachments?.map((reference) => reference.id)).size !==
    initialAttachments.length
  )
    throw new Error("Initial attachment ids must be unique.");
  let state: ComposerState<F> = {
    text: options.initialText ?? "",
    attachments: initialAttachments,
    revision: options.initialText || initialAttachments.length ? 1 : 0,
    submitting: false,
    canSubmit: false,
    draft: { status: options.draft ? "idle" : "off", missingFiles: 0 },
  };
  state = { ...state, canSubmit: canSubmit() };

  function canSubmit(): boolean {
    return (
      !state.submitting &&
      settings.canSend !== false &&
      (state.text.trim().length > 0 || state.attachments.length > 0) &&
      state.attachments.every((item) => item.state === "ready")
    );
  }

  function publish(patch: Partial<ComposerState<F>> = {}): void {
    state = { ...state, ...patch };
    state.canSubmit = canSubmit();
    for (const listener of listeners) listener();
  }

  function edit(patch: Partial<ComposerState<F>>): void {
    publish({ ...patch, revision: state.revision + 1 });
    scheduleSave();
  }

  function scheduleSave(): void {
    if (!active || !settings.draft) return;
    saveWanted = true;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    publish({ draft: { ...state.draft, status: "unsaved", problem: undefined } });
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void saveDraft();
    }, settings.draft.debounceMs ?? 300);
  }

  /** Serial writes prevent an older save from landing after a newer one. An accepted send writes
   * an empty revision, not a delayed remove that could erase text typed during that await. */
  function saveDraft(): Promise<void> {
    const config = settings.draft;
    if (!config || write || !saveWanted) return saveTask;
    saveWanted = false;
    const controller = new AbortController();
    write = controller;
    const revision = state.revision;
    const stored = createStoredDraft(
      scope,
      {
        text: state.text,
        attachments: state.attachments.flatMap((item) =>
          item.state === "ready" ? [item.reference] : [],
        ),
        pendingFiles:
          state.draft.missingFiles +
          state.attachments.filter((item) => item.state !== "ready").length,
      },
      config.retentionMs,
    );
    publish({ draft: { ...state.draft, status: "saving", problem: undefined } });
    saveTask = (async () => {
      try {
        await config.storage.save(scope, stored, { signal: controller.signal });
        if (write === controller && state.revision === revision)
          publish({ draft: { ...state.draft, status: "saved", problem: undefined } });
      } catch {
        if (write === controller && state.revision === revision)
          publish({ draft: { ...state.draft, status: "failed", problem: "save" } });
      } finally {
        if (write === controller) {
          write = undefined;
          if (saveWanted && saveTimer === undefined) void saveDraft();
        }
      }
    })();
    return saveTask;
  }

  async function flushDraft(): Promise<boolean> {
    while (write || saveWanted) {
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = undefined;
      await saveDraft();
    }
    return !settings.draft || state.revision === 0 || state.draft.status === "saved";
  }

  async function loadDraft(): Promise<void> {
    const config = settings.draft;
    if (!config || !active) return;
    // Initial or freshly typed content is active work, never a placeholder to overwrite.
    if (state.revision !== 0) {
      scheduleSave();
      return;
    }
    load?.abort();
    const controller = new AbortController();
    load = controller;
    const revision = state.revision;
    publish({ draft: { ...state.draft, status: "loading", problem: undefined } });
    try {
      const value = await config.storage.load(scope, { signal: controller.signal });
      if (load !== controller || !active || state.revision !== revision) return;
      const parsed = parseDraft(value, scope);
      // A shorter retention policy also applies to drafts written under an older policy.
      if (parsed && parsed.savedAt + config.retentionMs > Date.now()) {
        textRevision += 1;
        publish({
          text: parsed.text,
          attachments: parsed.attachments.map(ready),
          revision: state.revision + 1,
          draft: { status: "saved", missingFiles: parsed.pendingFiles },
        });
      } else publish({ draft: { ...state.draft, status: "idle", problem: undefined } });
    } catch {
      if (load === controller && active && state.revision === revision)
        publish({ draft: { ...state.draft, status: "failed", problem: "load" } });
    } finally {
      if (load === controller) load = undefined;
    }
  }

  function cancelDraftIO(): void {
    load?.abort();
    load = undefined;
    write?.abort();
    write = undefined;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
    saveWanted = false;
  }

  function attach(): () => void {
    attached += 1;
    if (attached === 1) {
      active = true;
      void loadDraft();
    }
    let here = true;
    return () => {
      if (!here) return;
      here = false;
      attached -= 1;
      if (attached !== 0) return;
      active = false;
      generation += 1;
      load?.abort();
      load = undefined;
      // Debounced edits still belong to this scope after navigation. Finish them in order instead
      // of cancelling a write that may be the only saved copy of the person's latest work.
      void flushDraft();
      for (const controller of uploads.values()) controller.abort();
      uploads.clear();
      // A remount cannot pretend an aborted upload is still running or silently replay it.
      publish({
        submitting: false,
        attachments: state.attachments.map((item) =>
          item.state === "queued" || item.state === "uploading"
            ? {
                ...item,
                state: "failed",
                canRetry: false,
                error: {
                  code: "upload_cancelled",
                  message:
                    "Upload cancelled. Remove this file and select it again when you are ready.",
                },
              }
            : item,
        ),
      });
    };
  }

  function setOptions(next: ComposerOptions<F>): void {
    checkOptions(next);
    if (draftScopeKey(scope) !== draftScopeKey(next.scope))
      throw new Error("Make a new composer for a new scope.");
    const storageChanged =
      settings.draft?.storage !== next.draft?.storage ||
      settings.draft?.retentionMs !== next.draft?.retentionMs;
    settings = next;
    if (storageChanged) {
      cancelDraftIO();
      if (next.draft && attached) void loadDraft();
      else
        publish({
          draft: { ...state.draft, status: next.draft ? "unsaved" : "off", problem: undefined },
        });
    }
    const allowed = canSubmit();
    if (state.canSubmit !== allowed) publish();
  }

  function setText(text: string): void {
    if (!active || state.text === text) return;
    textRevision += 1;
    edit({ text });
  }

  function replaceItem(id: string, item: AttachmentItem<F>, changed = false): void {
    const attachments = state.attachments.map((current) => (current.id === id ? item : current));
    if (changed) edit({ attachments });
    else publish({ attachments });
  }

  async function upload(item: AttachmentItem<F>, config: AttachmentOptions<F>): Promise<void> {
    if (!item.file || !active) return;
    const file = item.file;
    const controller = new AbortController();
    uploads.set(item.id, controller);
    const current = () =>
      active && uploads.get(item.id) === controller && !controller.signal.aborted;
    replaceItem(item.id, { ...item, state: "uploading" });
    try {
      const reference = await config.upload(file, {
        signal: controller.signal,
        onProgress(fraction) {
          if (current() && Number.isFinite(fraction))
            replaceItem(item.id, {
              ...item,
              state: "uploading",
              progress: Math.max(0, Math.min(1, fraction)),
            });
        },
      });
      if (!current()) return;
      const normalized = normalizeAttachmentRef(reference);
      if (
        !normalized ||
        state.attachments.some(
          (other) =>
            other.id !== item.id && other.state === "ready" && other.reference.id === normalized.id,
        )
      ) {
        replaceItem(item.id, {
          ...item,
          state: "failed",
          canRetry: false,
          error: {
            code: "attachment_reference",
            message:
              "This file could not be attached. Remove it and check the upload with the app.",
          },
        });
        return;
      }
      replaceItem(item.id, { ...item, state: "ready", reference: normalized }, true);
    } catch (error) {
      if (!current()) return;
      let canRetry = false;
      let shown: DisplayError | undefined;
      try {
        canRetry = config.canRetry?.(error, file) === true;
        shown = config.error?.(error, file);
      } catch {
        // An error formatter cannot strand a row in the uploading state.
      }
      replaceItem(item.id, {
        ...item,
        state: "failed",
        canRetry,
        error: shown ?? {
          code: "upload_failed",
          message: canRetry
            ? "Upload failed. Try again or remove the file."
            : "Could not confirm this upload. Remove the file or check its status with the app.",
        },
      });
    } finally {
      if (uploads.get(item.id) === controller) uploads.delete(item.id);
    }
  }

  function addFiles(files: readonly F[]): void {
    if (!active || !files.length) return;
    const config = settings.attachments;
    const added: AttachmentItem<F>[] = [];
    let count = state.attachments.filter((item) => item.state !== "failed").length;
    for (const file of files) {
      const error = config
        ? validateAttachment(file, config.rules, count)
        : {
            code: "upload_unsupported",
            message: "This chat cannot upload files. Remove the file and send text instead.",
          };
      const item: AttachmentItem<F> = {
        id: `attachment-${++nextId}`,
        name: file.name,
        mediaType: file.type,
        size: file.size,
        file,
        ...(error
          ? ({ state: "failed", error, canRetry: false } as const)
          : ({ state: "queued" } as const)),
      };
      added.push(item);
      if (!error) count += 1;
    }
    edit({ attachments: [...state.attachments, ...added] });
    // A microtask exposes queued state without introducing a scheduler or a concurrency limit.
    for (const item of added)
      if (item.state === "queued" && config) {
        const mine = generation;
        void Promise.resolve().then(() => {
          if (active && generation === mine && state.attachments.includes(item))
            void upload(item, config);
        });
      }
  }

  function removeAttachment(id: string): void {
    if (!active || !state.attachments.some((item) => item.id === id)) return;
    uploads.get(id)?.abort();
    uploads.delete(id);
    edit({ attachments: state.attachments.filter((item) => item.id !== id) });
  }

  function retryAttachment(id: string): void {
    const item = state.attachments.find((entry) => entry.id === id);
    const config = settings.attachments;
    if (!active || !config || item?.state !== "failed" || !item.canRetry || !item.file) return;
    const error = validateAttachment(
      item.file,
      config.rules,
      state.attachments.filter((entry) => entry.id !== id && entry.state !== "failed").length,
    );
    if (error) replaceItem(id, { ...item, error, canRetry: false });
    else void upload(item, config);
  }

  async function submit(): Promise<SendResult | undefined> {
    if (!active || state.submitting) return undefined;
    const blocked =
      settings.canSend === false
        ? {
            code: "busy",
            message:
              "Sending is not available yet. Keep your draft and try when the conversation is ready.",
          }
        : state.attachments.some((item) => item.state !== "ready")
          ? {
              code: "attachments_pending",
              message:
                "Wait for uploads to finish. Remove or retry any failed files before sending.",
            }
          : !state.text.trim() && state.attachments.length === 0
            ? { code: "empty", message: "Write a message or add a file first." }
            : undefined;
    if (blocked) {
      const result: SendResult = { ok: false, error: blocked };
      publish({ error: blocked, result });
      return result;
    }
    const text = state.text;
    const revision = textRevision;
    const items = state.attachments;
    const mine = generation;
    const input: MessageInput = {
      text,
      attachments: items.flatMap((item) => (item.state === "ready" ? [{ ...item.reference }] : [])),
    };
    // Before calling the host: even a second submit in the same event sees the lock.
    publish({ submitting: true, error: undefined, result: undefined });
    let result: SendResult;
    try {
      result = await settings.send(input);
    } catch {
      // The host send contract reports outcomes. A thrown exception confirms nothing.
      if (active && generation === mine) publish({ submitting: false, error: unconfirmed });
      return undefined;
    }
    if (!active || generation !== mine) return result;
    // A stored message stays in the conversation, saved for a reload, with Retry on it. A second
    // copy here could only go as a new message, so the composer lets go of it as if accepted.
    if (result.ok && (result.outcome === "accepted" || result.stored)) {
      const submitted = new Set(items);
      edit({
        text: textRevision === revision ? "" : state.text,
        attachments: state.attachments.filter((item) => !submitted.has(item)),
        submitting: false,
        result,
        error: undefined,
      });
      // Saved now, not after the pause: a reload in between would bring the words back beside
      // the stored message.
      if (result.stored) void flushDraft();
    } else publish({ submitting: false, result, error: result.ok ? unconfirmed : result.error });
    return result;
  }

  function retryDraft(): void {
    if (!active || !settings.draft || load || write) return;
    if (state.draft.problem === "load" && state.revision === 0) void loadDraft();
    else {
      saveWanted = true;
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = undefined;
      void saveDraft();
    }
  }

  function dismissMissingFiles(): void {
    if (active && state.draft.missingFiles) edit({ draft: { ...state.draft, missingFiles: 0 } });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach,
    setOptions,
    setText,
    addFiles,
    removeAttachment,
    retryAttachment,
    submit,
    flushDraft,
    retryDraft,
    dismissMissingFiles,
  };
}

// Web signature first, for the same reason as createComposer's.
/** Optional React ownership. Components can instead receive values and callbacks from any host. */
export function useComposer(options: ComposerOptions): ComposerValue;
/** A phone picker's file: `F` is the type `attachments.upload` takes. */
export function useComposer<F extends AttachmentFile>(
  options: ComposerOptions<F>,
): ComposerValue<F>;
export function useComposer<F extends AttachmentFile>(
  options: ComposerOptions<F>,
): ComposerValue<F> {
  const [held, setHeld] = useState(() => ({
    scope: { ...options.scope },
    controller: createComposer(options),
  }));
  let { controller } = held;
  if (draftScopeKey(held.scope) !== draftScopeKey(options.scope)) {
    const next = { scope: { ...options.scope }, controller: createComposer(options) };
    setHeld(next);
    controller = next.controller;
  }
  useLayoutEffect(() => {
    controller.setOptions(options);
  });
  useEffect(() => controller.attach(), [controller]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  return useMemo(
    () => ({
      ...state,
      setText: controller.setText,
      addFiles: controller.addFiles,
      removeAttachment: controller.removeAttachment,
      retryAttachment: controller.retryAttachment,
      submit: controller.submit,
      flushDraft: controller.flushDraft,
      retryDraft: controller.retryDraft,
      dismissMissingFiles: controller.dismissMissingFiles,
    }),
    [controller, state],
  );
}
