import { draftScopeKey, type DraftScope, type DraftStorage } from "@providerkit/react";
import { isRecord } from "./shared.ts";

const prefix = "providerkit-chat-example:";
function key(scope: DraftScope): string {
  return `${prefix}${draftScopeKey(scope)}`;
}

export function remembersDraft(scope: DraftScope): boolean {
  try {
    return localStorage.getItem(`${key(scope)}:consent`) === "yes";
  } catch {
    return false;
  }
}

export function rememberDraft(scope: DraftScope, remember: boolean): void {
  if (remember) localStorage.setItem(`${key(scope)}:consent`, "yes");
  else {
    // Revoke consent before deleting: an old scheduled write must not put the draft back.
    localStorage.removeItem(`${key(scope)}:consent`);
    localStorage.removeItem(key(scope));
  }
}

/** The composer serializes revisions, including the empty revision after an accepted send.
 * These synchronous commits check the signal and consent immediately before writing. No File,
 * preview URL or transcript is stored. Expired drafts are removed on the next local access. */
export const browserDrafts: DraftStorage = {
  async load(scope, { signal }) {
    signal.throwIfAborted();
    if (!remembersDraft(scope)) return null;
    const raw = localStorage.getItem(key(scope));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) {
      localStorage.removeItem(key(scope));
      return null;
    }
    return value; // The package validates the exact scope and confirmed attachment references.
  },
  async save(scope, draft, { signal }) {
    signal.throwIfAborted();
    if (!remembersDraft(scope)) return;
    localStorage.setItem(key(scope), JSON.stringify(draft));
  },
};
