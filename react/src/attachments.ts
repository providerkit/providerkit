import type { AttachmentRef } from "./client.ts";
import type { DisplayError } from "./protocol.ts";
import { isRecord } from "./state.ts";

/** Client-side hints only. The host must validate bytes, permissions and limits again. */
export interface AttachmentRules {
  /** MIME types, MIME wildcards or extensions, like the native file input's accept list. */
  accept?: readonly string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

export type AttachmentUploader = (
  file: File,
  options: { signal: AbortSignal; onProgress: (fraction: number) => void },
) => Promise<AttachmentRef>;

export interface AttachmentOptions {
  upload: AttachmentUploader;
  rules?: AttachmentRules;
  /** Omitted means no retry. Return true only if repeating this failed upload is safe. */
  canRetry?: (error: unknown, file: File) => boolean;
  /** Safe, host-authored words only. The default never exposes a thrown server error. */
  error?: (error: unknown, file: File) => DisplayError;
}

interface AttachmentBase {
  /** Local row id, not the server's file id. */
  id: string;
  name: string;
  mediaType: string;
  size?: number;
  /** In-memory only. Never write this to draft storage. */
  file?: File;
}

export type AttachmentItem = AttachmentBase &
  (
    | { state: "queued" }
    | { state: "uploading"; progress?: number }
    | { state: "ready"; reference: AttachmentRef }
    | { state: "failed"; error: DisplayError; canRetry: boolean }
  );

/** Links to host files, not inline bytes or temporary object URLs. Relative paths must start
 * with one slash; scheme-relative URLs, backslashes and control characters are refused. */
export function attachmentUrl(value: string): string | undefined {
  if (!value || /[\p{Cc}\s\\]/u.test(value)) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password)
      return value;
  } catch {
    // A malformed address stays plain text.
  }
  return undefined;
}

/** Copies only a confirmed server reference's public fields. Used at both trust boundaries:
 * an upload reply and a stored draft. This does not authorize access to that file. */
export function normalizeAttachmentRef(value: unknown): AttachmentRef | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.mediaType !== "string" ||
    !value.mediaType.trim()
  )
    return null;
  const reference: AttachmentRef = { id: value.id, name: value.name, mediaType: value.mediaType };
  if (value.size !== undefined) {
    if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0)
      return null;
    reference.size = value.size;
  }
  if (value.url !== undefined) {
    if (typeof value.url !== "string" || !attachmentUrl(value.url)) return null;
    reference.url = value.url;
  }
  return reference;
}

/** Checks metadata for quick feedback; it never claims to inspect the file's bytes. */
export function validateAttachment(
  file: Pick<File, "name" | "type" | "size">,
  rules: AttachmentRules = {},
  count = 0,
): DisplayError | undefined {
  if (rules.maxFiles !== undefined && count >= rules.maxFiles)
    return {
      code: "attachment_count",
      message: `You can attach up to ${rules.maxFiles} files. Remove a file before adding another.`,
    };
  if (rules.maxFileBytes !== undefined && file.size > rules.maxFileBytes)
    return {
      code: "attachment_size",
      message: `This file is ${file.size} bytes. The limit is ${rules.maxFileBytes} bytes. Choose a smaller file.`,
    };
  if (
    rules.accept?.length &&
    !rules.accept.some((entry) => {
      const accept = entry.trim().toLowerCase();
      const type = file.type.toLowerCase();
      if (accept.startsWith(".")) return file.name.toLowerCase().endsWith(accept);
      if (accept.endsWith("/*")) return type.startsWith(accept.slice(0, -1));
      return type === accept;
    })
  )
    return {
      code: "attachment_type",
      message: `Choose a file of one of these types: ${rules.accept.join(", ")}.`,
    };
  return undefined;
}
