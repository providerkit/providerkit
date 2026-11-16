"use client";

import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { attachmentUrl, type AttachmentItem } from "../attachments.ts";
import type { DisplayError } from "../protocol.ts";

export interface AttachmentLabels {
  list: string;
  queued: string;
  uploading: string;
  ready: string;
  failed: string;
  progress: (name: string) => string;
  remove: (name: string) => string;
  retry: (name: string) => string;
  error: (error: DisplayError, item: AttachmentItem) => ReactNode;
}

const defaults: AttachmentLabels = {
  list: "Attachments",
  queued: "Waiting to upload",
  uploading: "Uploading...",
  ready: "Ready to send",
  failed: "Upload failed",
  progress: (name) => `Uploading ${name}`,
  remove: (name) => `Remove ${name}`,
  retry: (name) => `Retry ${name}`,
  error: (error) => error.message,
};

export interface AttachmentListProps extends ComponentProps<"ul"> {
  items: readonly AttachmentItem[];
  onRemove?: (id: string) => void;
  /** Shown only for a failed item whose uploader explicitly permits a safe retry. */
  onRetry?: (id: string) => void;
  labels?: Partial<AttachmentLabels>;
  /** Local image previews only. Server URLs are links, not automatic image requests. */
  previews?: boolean;
}

/** Plain rows for selected files. No upload, storage or conversation context lives here. */
export function AttachmentList({
  items,
  onRemove,
  onRetry,
  labels: overrides,
  previews = true,
  className,
  children,
  ...props
}: AttachmentListProps) {
  const labels = { ...defaults, ...overrides };
  if (!items.length) return null;
  return (
    <ul
      aria-label={labels.list}
      {...props}
      className={["pk-attachment-list", className].filter(Boolean).join(" ")}
      data-part="attachment-list"
      data-state={items.some((item) => item.state === "failed") ? "failed" : "ready"}
    >
      {items.map((item) => (
        <AttachmentRow
          key={item.id}
          item={item}
          labels={labels}
          onRemove={onRemove}
          onRetry={onRetry}
          previews={previews}
        />
      ))}
      {children}
    </ul>
  );
}

function AttachmentRow({
  item,
  labels,
  onRemove,
  onRetry,
  previews,
}: {
  item: AttachmentItem;
  labels: AttachmentLabels;
  onRemove: AttachmentListProps["onRemove"];
  onRetry: AttachmentListProps["onRetry"];
  previews: boolean;
}) {
  const file =
    previews && /^(image\/(png|jpeg|gif|webp|avif))$/iu.test(item.file?.type ?? "")
      ? item.file
      : undefined;
  const preview = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const node = preview.current;
    if (!node || !file || typeof URL.createObjectURL !== "function") return;
    // An object URL belongs to this effect, never to a draft or a render. Strict Mode's next
    // effect gets its own URL; each cleanup revokes exactly the URL that effect created.
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      return;
    }
    node.src = url;
    node.hidden = false;
    return () => {
      node.hidden = true;
      node.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [file]);
  const href =
    item.state === "ready" && item.reference.url ? attachmentUrl(item.reference.url) : undefined;
  return (
    <li className="pk-attachment" data-part="attachment" data-state={item.state}>
      {file && (
        <img
          ref={preview}
          hidden
          className="pk-attachment-preview"
          data-part="attachment-preview"
          alt=""
        />
      )}
      <div className="pk-attachment-content" data-part="attachment-content">
        {href ? (
          <a
            className="pk-attachment-name"
            data-part="attachment-name"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {item.name}
          </a>
        ) : (
          <span className="pk-attachment-name" data-part="attachment-name">
            {item.name}
          </span>
        )}
        <span className="pk-attachment-status" data-part="attachment-status" role="status">
          {labels[item.state]}
        </span>
        {item.state === "uploading" && item.progress !== undefined && (
          <progress
            className="pk-attachment-progress"
            data-part="attachment-progress"
            max={1}
            value={item.progress}
            aria-label={labels.progress(item.name)}
          />
        )}
        {item.state === "failed" && (
          <p className="pk-attachment-error" data-part="attachment-error">
            {labels.error(item.error, item)}
          </p>
        )}
      </div>
      <div className="pk-attachment-actions" data-part="attachment-actions">
        {item.state === "failed" && item.canRetry && onRetry && (
          <button
            className="pk-attachment-action"
            data-part="attachment-retry"
            data-state="ready"
            type="button"
            onClick={() => onRetry(item.id)}
          >
            {labels.retry(item.name)}
          </button>
        )}
        {onRemove && (
          <button
            className="pk-attachment-action"
            data-part="attachment-remove"
            data-state="ready"
            type="button"
            onClick={() => onRemove(item.id)}
          >
            {labels.remove(item.name)}
          </button>
        )}
      </div>
    </li>
  );
}
