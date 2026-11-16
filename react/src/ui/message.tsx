"use client";

import { Fragment, useId, type ComponentProps, type ReactNode } from "react";
import type { RequestView } from "../client.ts";
import type {
  DisplayError,
  DisplayMessage,
  DisplayPart,
  SourcePart,
  TextPart,
} from "../protocol.ts";
import { SpecialistActivity, ToolCall } from "./activity.tsx";
import { RequestCard, type ApprovalCardProps, type RequestCardProps } from "./approval.tsx";
import {
  uiClass,
  useConversationData,
  useConversationLabels,
  type ConversationLabelOverrides,
  type RespondToRequest,
} from "./context.tsx";
import { Sources } from "./sources.tsx";

export interface PartRenderContext {
  message: DisplayMessage;
  sources: readonly SourcePart[];
  /** A specialist's children, grouped by the explicit parent and agent ids. */
  children?: ReactNode;
}

export interface MessageRenderers {
  /** Import Markdown separately and pass it here. Plain text is the default. */
  renderText?: (part: TextPart, context: PartRenderContext) => ReactNode;
  /** Return undefined for the default, null to hide a part. Unknown data draws nothing. */
  renderPart?: (part: DisplayPart, context: PartRenderContext) => ReactNode;
  renderApproval?: ApprovalCardProps["renderActions"];
  renderRequest?: RequestCardProps["renderActions"];
  renderForm?: RequestCardProps["renderForm"];
  onStartClientTool?: RequestCardProps["onStartClientTool"];
  toolLabels?: Readonly<Record<string, string>>;
  /** Keyed by run id or registered agentId; never parsed from an opaque run id. */
  specialistLabels?: Readonly<Record<string, string>>;
  onSource?: (source: SourcePart) => void;
  onRespond?: RespondToRequest;
  requests?: readonly RequestView[];
  labels?: ConversationLabelOverrides;
}

export interface MessageProps
  extends Omit<ComponentProps<"article">, "children">, MessageRenderers {
  message: DisplayMessage;
  error?: DisplayError;
  /** Host actions, such as an explicitly confirmed retry of an uncertain send. */
  actions?: ReactNode;
}

/** A reading block, not a transcript of internal run state. Only display parts reach this view. */
export function Message({
  message,
  error,
  actions,
  renderText,
  renderPart,
  renderApproval,
  renderRequest,
  renderForm,
  onStartClientTool,
  toolLabels,
  specialistLabels,
  onSource,
  onRespond,
  requests: suppliedRequests,
  labels: overrides,
  className,
  ...props
}: MessageProps) {
  const data = useConversationData();
  const labels = useConversationLabels(overrides);
  const requests = suppliedRequests ?? data?.requests;
  const headingId = useId();
  const sources = message.parts.filter((part) => part.type === "source");
  const agents = new Set(
    message.parts.filter((part) => part.type === "agent").map((part) => part.id),
  );
  const children = new Map<string, DisplayPart[]>();
  const roots: DisplayPart[] = [];
  for (const part of message.parts) {
    const parent =
      part.type === "agent" ? part.parentId : "agentId" in part ? part.agentId : undefined;
    if (parent && parent !== part.id && agents.has(parent)) {
      const group = children.get(parent) ?? [];
      group.push(part);
      children.set(parent, group);
    } else roots.push(part);
  }
  const rendered = new Set<string>();
  function draw(part: DisplayPart): ReactNode {
    // A malformed parent cycle must not recurse forever or hide its rows.
    if (rendered.has(part.id)) return null;
    rendered.add(part.id);
    const nested = children.get(part.id)?.map(draw);
    const context: PartRenderContext = { message, sources, children: nested };
    let content = renderPart?.(part, context);
    if (content === undefined) {
      switch (part.type) {
        case "text":
          content = renderText ? (
            renderText(part, context)
          ) : (
            <div
              className="pk-message-text"
              data-part="text"
              data-state={part.settled ? "settled" : "live"}
              style={{ whiteSpace: "pre-wrap" }}
            >
              {part.text}
            </div>
          );
          break;
        case "tool":
          content = <ToolCall tool={part} toolLabels={toolLabels} labels={overrides} />;
          break;
        case "agent":
          content = (
            <SpecialistActivity agent={part} specialistLabels={specialistLabels} labels={overrides}>
              {nested}
            </SpecialistActivity>
          );
          break;
        case "question":
        case "client-tool":
        case "approval": {
          const request = requests?.find(
            (request) => request.part.id === part.id && request.messageId === message.id,
          );
          content = (
            <RequestCard
              request={{
                ...request,
                part,
                messageId: message.id,
                canRespond: message.state === "live" ? request?.canRespond : false,
              }}
              onRespond={onRespond}
              onStartClientTool={onStartClientTool}
              renderForm={renderForm}
              renderActions={
                part.type === "approval" ? (renderApproval ?? renderRequest) : renderRequest
              }
              labels={overrides}
            />
          );
          break;
        }
        case "source":
          content = <Sources sources={[part]} onSource={onSource} labels={overrides} />;
          break;
        case "attachment":
          // Hosts can provide previews, downloads or their own attachment component via renderPart.
          content = (
            <span className="pk-message-attachment" data-part="attachment" data-state="ready">
              {part.name}
            </span>
          );
          break;
        case "data":
          content = null;
      }
    }
    return <Fragment key={part.id}>{content}</Fragment>;
  }
  const parts = roots.map(draw);
  for (const part of message.parts) if (!rendered.has(part.id)) parts.push(draw(part));
  const problem = error ?? data?.messageErrors?.[message.id];
  return (
    <article
      aria-labelledby={headingId}
      {...props}
      className={uiClass("pk-message", className)}
      data-part="message"
      data-state={message.state}
      data-role={message.role}
      data-message-id={message.id}
    >
      <div className="pk-message-heading" data-part="message-heading">
        <span id={headingId} className="pk-message-author" data-part="message-author">
          {labels.role[message.role]}
        </span>
        {labels.message[message.state] && (
          <span className="pk-message-state" data-part="message-state">
            {labels.message[message.state]}
          </span>
        )}
      </div>
      <div className="pk-message-body" data-part="message-body">
        {parts}
      </div>
      {problem && (
        <p className="pk-message-error" data-part="message-error">
          {labels.error(problem)}
        </p>
      )}
      {actions && (
        <div className="pk-message-actions" data-part="message-actions">
          {actions}
        </div>
      )}
    </article>
  );
}
