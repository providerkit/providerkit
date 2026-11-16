import type { AttachmentRef } from "./client.ts";
import { normalizeAttachmentRef } from "./attachments.ts";
import { isRecord } from "./state.ts";

/** Both fields are required. A conversation id alone can expose one person's draft to another. */
export interface DraftScope {
  principalId: string;
  conversationId: string;
}

export interface DraftContent {
  text: string;
  attachments: readonly AttachmentRef[];
  /** Only a count survives reload. The person must choose these files again. */
  pendingFiles: number;
}

export interface StoredDraft extends DraftContent {
  v: 1;
  scope: DraftScope;
  savedAt: number;
  expiresAt: number;
}

export interface DraftStorage {
  load(scope: DraftScope, options: { signal: AbortSignal }): Promise<unknown>;
  /** Store only under this exact scope. Honor signal before committing an asynchronous write.
   * The host owns encryption, access control and deletion after expiresAt. */
  save(scope: DraftScope, draft: StoredDraft, options: { signal: AbortSignal }): Promise<void>;
}

export interface DraftOptions {
  storage: DraftStorage;
  /** Required and finite. Expired drafts are never restored; the host deletes stored data. */
  retentionMs: number;
  /** Delay after an edit before saving, in milliseconds. Defaults to 300. */
  debounceMs?: number;
}

export type DraftStatus = "off" | "idle" | "loading" | "unsaved" | "saving" | "saved" | "failed";

export interface DraftState {
  status: DraftStatus;
  /** A reload cannot recover local Files. This count is not a set of restored attachments. */
  missingFiles: number;
  problem?: "load" | "save";
}

/** An unambiguous identity for hook scope changes, not a storage location or authorization check. */
export function draftScopeKey(scope: DraftScope): string {
  if (!scope.principalId.trim() || !scope.conversationId.trim())
    throw new TypeError("Draft scope needs a principalId and a conversationId.");
  return JSON.stringify([scope.principalId, scope.conversationId]);
}

/** Validate saved data as untrusted input and copy only known fields. */
export function parseDraft(
  value: unknown,
  scope: DraftScope,
  now = Date.now(),
): StoredDraft | null {
  if (
    !scope.principalId.trim() ||
    !scope.conversationId.trim() ||
    !isRecord(value) ||
    value.v !== 1 ||
    !isRecord(value.scope) ||
    value.scope.principalId !== scope.principalId ||
    value.scope.conversationId !== scope.conversationId ||
    typeof value.text !== "string" ||
    !Array.isArray(value.attachments) ||
    typeof value.pendingFiles !== "number" ||
    !Number.isSafeInteger(value.pendingFiles) ||
    value.pendingFiles < 0 ||
    typeof value.savedAt !== "number" ||
    !Number.isFinite(value.savedAt) ||
    value.savedAt > now ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt <= value.savedAt
  )
    return null;
  const attachments: AttachmentRef[] = [];
  const ids = new Set<string>();
  for (const input of value.attachments) {
    const attachment = normalizeAttachmentRef(input);
    if (!attachment || ids.has(attachment.id)) return null;
    ids.add(attachment.id);
    attachments.push(attachment);
  }
  return {
    v: 1,
    scope: { ...scope },
    text: value.text,
    attachments,
    pendingFiles: value.pendingFiles,
    savedAt: value.savedAt,
    expiresAt: value.expiresAt,
  };
}

export function createStoredDraft(
  scope: DraftScope,
  content: DraftContent,
  retentionMs: number,
  now = Date.now(),
): StoredDraft {
  draftScopeKey(scope);
  if (!Number.isFinite(retentionMs) || retentionMs <= 0 || !Number.isFinite(now + retentionMs))
    throw new RangeError("Draft retentionMs must be a finite number greater than zero.");
  const draft = parseDraft(
    { ...content, v: 1, scope, savedAt: now, expiresAt: now + retentionMs },
    scope,
    now,
  );
  if (!draft) throw new TypeError("Invalid draft content.");
  return draft;
}
