"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { AttachmentItem } from "../attachments.ts";
import type { DraftState } from "../drafts.ts";
import type { DisplayError } from "../protocol.ts";
import { AttachmentList, type AttachmentLabels } from "./attachments.tsx";

export interface ComposerLabels {
  message: string;
  hint: string;
  send: string;
  sending: string;
  retrySend: string;
  addFiles: string;
  uploading: string;
  empty: string;
  unavailable: string;
  resolveAttachments: string;
  unconfirmed: string;
  draftLoading: string;
  draftUnsaved: string;
  draftSaving: string;
  draftSaved: string;
  draftLoadFailed: string;
  draftSaveFailed: string;
  retryDraft: string;
  missingFiles: (count: number) => string;
  dismissMissingFiles: string;
  error: (error: DisplayError) => ReactNode;
}

const defaults: ComposerLabels = {
  message: "Message",
  hint: "Enter to send. Shift+Enter for a new line.",
  send: "Send",
  sending: "Sending... You can keep writing.",
  retrySend: "Try sending again",
  addFiles: "Add files",
  uploading: "Uploading files. You can keep writing.",
  empty: "Write a message or add a file first.",
  unavailable:
    "Sending is not available yet. Keep your draft and try when the conversation is ready.",
  resolveAttachments:
    "Wait for uploads to finish. Remove or retry any failed files before sending.",
  unconfirmed: "Delivery is not confirmed. Check the conversation before sending again.",
  draftLoading: "Loading your draft... You can start writing.",
  draftUnsaved: "Draft not saved yet.",
  draftSaving: "Saving draft...",
  draftSaved: "Draft saved.",
  draftLoadFailed: "Your saved draft could not be loaded. Try again, or start a new message.",
  draftSaveFailed: "Your draft was not saved. Keep this page open and try saving again.",
  retryDraft: "Try again",
  missingFiles: (count) =>
    `${count} ${count === 1 ? "file needs" : "files need"} to be selected again. Files that had not finished uploading cannot be restored.`,
  dismissMissingFiles: "Continue without those files",
  error: (error) => error.message,
};

export interface ComposerProps extends Omit<ComponentProps<"form">, "onSubmit" | "onChange"> {
  text: string;
  onTextChange: (text: string) => void;
  /** The host owns delivery and errors. This component never clears or retries a draft. */
  onSubmit: () => void | Promise<unknown>;
  submitting?: boolean;
  canSubmit?: boolean;
  error?: DisplayError;
  /** A host-supported action, such as checking delivery after an unknown outcome. */
  recoveryAction?: ReactNode;
  attachments?: readonly AttachmentItem[];
  onFiles?: (files: readonly File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onRetryAttachment?: (id: string) => void;
  accept?: string;
  multiple?: boolean;
  draft?: DraftState;
  onRetryDraft?: () => void;
  onDismissMissingFiles?: () => void;
  labels?: Partial<ComposerLabels>;
  attachmentLabels?: Partial<AttachmentLabels>;
  textareaProps?: Omit<
    ComponentProps<"textarea">,
    "value" | "defaultValue" | "onChange" | "children" | "ref"
  >;
}

/** Controlled HTML, independent of useComposer. Key this component by principal/conversation when
 * reusing it across scopes, so local focus, IME state and pending UI belong to that scope too. */
export function Composer({
  text,
  onTextChange,
  onSubmit,
  submitting = false,
  canSubmit = true,
  error,
  recoveryAction,
  attachments = [],
  onFiles,
  onRemoveAttachment,
  onRetryAttachment,
  accept,
  multiple = true,
  draft,
  onRetryDraft,
  onDismissMissingFiles,
  labels: overrides,
  attachmentLabels,
  textareaProps = {},
  children,
  className,
  onDragOver,
  onDrop,
  ...props
}: ComposerProps) {
  const labels = { ...defaults, ...overrides };
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const caret = useRef<number | undefined>(undefined);
  const sending = useRef(false);
  const lifetime = useRef(0);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string>();
  useEffect(
    () => () => {
      lifetime.current += 1;
    },
    [],
  );
  const busy = submitting || pending;
  const uploading = attachments.some(
    (item) => item.state === "queued" || item.state === "uploading",
  );
  const textId = textareaProps.id ?? `${id}-message`;
  const errorId = `${id}-error`;

  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    resizeTextarea(node);
    if (caret.current !== undefined) {
      node.setSelectionRange(caret.current, caret.current);
      caret.current = undefined;
    }
  }, [text]);
  useEffect(() => {
    const node = textarea.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let width = node.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        resizeTextarea(node);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  async function submit(): Promise<void> {
    if (busy || sending.current) return;
    if (!canSubmit) {
      setLocalError(
        attachments.some((item) => item.state !== "ready")
          ? labels.resolveAttachments
          : !text.trim() && !attachments.length
            ? labels.empty
            : labels.unavailable,
      );
      textarea.current?.focus();
      return;
    }
    sending.current = true;
    setPending(true);
    setLocalError(undefined);
    // Focus now, not when the reply arrives: a late reply must not steal focus from another field.
    textarea.current?.focus();
    const mine = lifetime.current;
    try {
      await onSubmit();
    } catch {
      if (mine === lifetime.current) setLocalError(labels.unconfirmed);
    } finally {
      if (mine === lifetime.current) {
        sending.current = false;
        setPending(false);
      }
    }
  }

  const shownError = error ? labels.error(error) : localError;
  const draftText = !draft
    ? undefined
    : draft.status === "failed"
      ? draft.problem === "load"
        ? labels.draftLoadFailed
        : labels.draftSaveFailed
      : draft.status === "loading"
        ? labels.draftLoading
        : draft.status === "saving"
          ? labels.draftSaving
          : draft.status === "saved"
            ? labels.draftSaved
            : draft.status === "unsaved"
              ? labels.draftUnsaved
              : undefined;

  return (
    <form
      {...props}
      className={["pk-composer", className].filter(Boolean).join(" ")}
      data-part="composer"
      data-state={busy ? "sending" : shownError ? "failed" : uploading ? "uploading" : "ready"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        onDragOver?.(event);
        if (!event.defaultPrevented && onFiles && event.dataTransfer.types.includes("Files"))
          event.preventDefault();
      }}
      onDrop={(event) => {
        onDrop?.(event);
        if (event.defaultPrevented || !onFiles || !event.dataTransfer.files.length) return;
        event.preventDefault();
        onFiles(Array.from(event.dataTransfer.files));
        textarea.current?.focus();
      }}
    >
      <label className="pk-composer-label" data-part="composer-label" htmlFor={textId}>
        {labels.message}
      </label>
      <textarea
        rows={2}
        {...textareaProps}
        id={textId}
        ref={textarea}
        className={["pk-composer-input", textareaProps.className].filter(Boolean).join(" ")}
        data-part="composer-input"
        data-state={busy ? "sending" : "ready"}
        value={text}
        aria-describedby={[
          textareaProps["aria-describedby"],
          `${id}-hint`,
          shownError ? errorId : undefined,
        ]
          .filter(Boolean)
          .join(" ")}
        onChange={(event) => {
          setLocalError(undefined);
          onTextChange(event.currentTarget.value);
        }}
        onInput={(event) => {
          textareaProps.onInput?.(event);
          resizeTextarea(event.currentTarget);
        }}
        onCompositionStart={(event) => {
          composing.current = true;
          textareaProps.onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          textareaProps.onCompositionEnd?.(event);
        }}
        onKeyDown={(event) => {
          textareaProps.onKeyDown?.(event);
          if (
            event.defaultPrevented ||
            event.key !== "Enter" ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            composing.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
        onPaste={(event) => {
          textareaProps.onPaste?.(event);
          if (event.defaultPrevented || !onFiles || !event.clipboardData.files.length) return;
          event.preventDefault();
          const inserted = event.clipboardData.getData("text/plain");
          if (inserted) {
            const { value, selectionStart, selectionEnd } = event.currentTarget;
            caret.current = selectionStart + inserted.length;
            onTextChange(value.slice(0, selectionStart) + inserted + value.slice(selectionEnd));
          }
          onFiles(Array.from(event.clipboardData.files));
        }}
      />
      <p id={`${id}-hint`} className="pk-composer-hint" data-part="composer-hint">
        {labels.hint}
      </p>
      <AttachmentList
        items={attachments}
        labels={attachmentLabels}
        onRetry={
          onRetryAttachment
            ? (attachmentId) => {
                onRetryAttachment(attachmentId);
                textarea.current?.focus();
              }
            : undefined
        }
        onRemove={
          onRemoveAttachment
            ? (attachmentId) => {
                onRemoveAttachment(attachmentId);
                textarea.current?.focus();
              }
            : undefined
        }
      />
      <div className="pk-composer-actions" data-part="composer-actions">
        {onFiles && (
          <>
            <input
              ref={picker}
              type="file"
              hidden
              accept={accept}
              multiple={multiple}
              onChange={(event) => {
                if (event.currentTarget.files?.length)
                  onFiles(Array.from(event.currentTarget.files));
                event.currentTarget.value = "";
                textarea.current?.focus();
              }}
            />
            <button
              className="pk-composer-action"
              data-part="composer-attach"
              data-state="ready"
              type="button"
              onClick={() => picker.current?.click()}
            >
              {labels.addFiles}
            </button>
          </>
        )}
        {children}
        <button
          className="pk-composer-action pk-composer-send"
          data-part="composer-send"
          data-state={busy ? "pending" : "ready"}
          type="submit"
          aria-disabled={busy || !canSubmit}
          aria-busy={busy}
        >
          {error?.retryable ? labels.retrySend : labels.send}
        </button>
      </div>
      <p
        className="pk-composer-status"
        data-part="composer-status"
        role="status"
        aria-live="polite"
      >
        {busy ? labels.sending : uploading ? labels.uploading : null}
      </p>
      {shownError && (
        <div id={errorId} className="pk-composer-error" data-part="composer-error" role="status">
          {shownError}
          {recoveryAction}
        </div>
      )}
      {draftText && (
        <p
          className="pk-composer-draft"
          data-part="composer-draft"
          data-state={draft?.status}
          role="status"
        >
          {draftText}
        </p>
      )}
      {draft?.status === "failed" && onRetryDraft && (
        <button
          className="pk-composer-action"
          data-part="draft-retry"
          data-state="ready"
          type="button"
          onClick={onRetryDraft}
        >
          {labels.retryDraft}
        </button>
      )}
      {draft && draft.missingFiles > 0 && (
        <div
          className="pk-composer-missing"
          data-part="draft-missing"
          data-state="missing"
          role="status"
        >
          <p>{labels.missingFiles(draft.missingFiles)}</p>
          {onDismissMissingFiles && (
            <button
              className="pk-composer-action"
              data-part="draft-dismiss-missing"
              data-state="ready"
              type="button"
              onClick={onDismissMissingFiles}
            >
              {labels.dismissMissingFiles}
            </button>
          )}
        </div>
      )}
    </form>
  );
}

/** Only effects and events call this. Importing or server-rendering the component measures nothing. */
function resizeTextarea(node: HTMLTextAreaElement): void {
  const css = node.ownerDocument.defaultView?.getComputedStyle(node);
  if (!css) return;
  const px = (value: string) => Number.parseFloat(value) || 0;
  node.style.height = "auto";
  const adjustment =
    css.boxSizing === "border-box"
      ? px(css.borderTopWidth) + px(css.borderBottomWidth)
      : -px(css.paddingTop) - px(css.paddingBottom);
  node.style.height = `${node.scrollHeight + adjustment}px`;
}
