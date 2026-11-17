"use client";

import { type ComponentProps } from "react";
import type { SourcePart } from "../protocol.ts";
import { uiClass, useConversationLabels, type ConversationLabelOverrides } from "./context.tsx";

export interface SourcesProps extends Omit<ComponentProps<"ul">, "children"> {
  sources: readonly SourcePart[];
  labels?: ConversationLabelOverrides;
  /** Replaces links with buttons. The host owns navigation, including non-web destinations. */
  onSource?: (source: SourcePart) => void;
}

function webAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Only the source records the host supplied become links. Text never creates a source. */
export function Sources({
  sources,
  labels: overrides,
  onSource,
  className,
  ...props
}: SourcesProps) {
  const labels = useConversationLabels(overrides);
  if (sources.length === 0) return null;
  return (
    <ul
      aria-label={labels.sources}
      {...props}
      className={uiClass("pk-sources", className)}
      data-part="sources"
      data-state="ready"
    >
      {sources.map((source) => {
        const href = webAddress(source.url);
        const title = (
          <>
            {source.marker && (
              <span className="pk-source-marker" data-part="source-marker">
                {source.marker}
              </span>
            )}
            <span className="pk-source-title" data-part="source-title">
              {source.title}
            </span>
          </>
        );
        return (
          <li
            key={source.id}
            className="pk-source"
            data-part="source"
            data-state={onSource || href ? "available" : "text"}
            data-source-id={source.id}
          >
            {onSource ? (
              <button
                className="pk-source-link"
                data-part="source-link"
                type="button"
                onClick={() => onSource(source)}
              >
                {title}
              </button>
            ) : href ? (
              <a
                className="pk-source-link"
                data-part="source-link"
                href={href}
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                {title}
              </a>
            ) : (
              <span className="pk-source-label" data-part="source-label">
                {title}
              </span>
            )}
            {source.snippet && (
              <p className="pk-source-snippet" data-part="source-snippet">
                {source.snippet}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
