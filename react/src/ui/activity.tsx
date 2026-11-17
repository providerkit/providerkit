"use client";

import { useId, useState, type ComponentProps, type ReactNode } from "react";
import type { AgentPart, ToolPart } from "../protocol.ts";
import { uiClass, useConversationLabels, type ConversationLabelOverrides } from "./context.tsx";

export interface ToolCallProps extends Omit<ComponentProps<"div">, "children"> {
  tool: ToolPart;
  /** A client-side label by the tool's public name; the server label is the fallback. */
  toolLabels?: Readonly<Record<string, string>>;
  label?: string;
  labels?: ConversationLabelOverrides;
  defaultOpen?: boolean;
  /** An explicit renderer for host-authorized data. Nothing stringifies `tool.data`. */
  children?: ReactNode;
  /** Actions never sit inside the disclosure's trigger. */
  actions?: ReactNode;
}

export function ToolCall({
  tool,
  toolLabels,
  label,
  labels: overrides,
  defaultOpen = false,
  children,
  actions,
  className,
  ...props
}: ToolCallProps) {
  const labels = useConversationLabels(overrides);
  const namedLabel =
    tool.name && toolLabels && Object.hasOwn(toolLabels, tool.name)
      ? toolLabels[tool.name]
      : undefined;
  const title = label ?? namedLabel ?? tool.label;
  const [open, setOpen] = useState(defaultOpen);
  const detailId = useId();
  return (
    <div
      {...props}
      className={uiClass("pk-tool", className)}
      data-part="tool"
      data-kind={tool.kind}
      data-state={tool.state}
      data-tool-id={tool.id}
      data-agent-id={tool.agentId}
    >
      <div className="pk-activity-heading" data-part="activity-heading">
        <span className="pk-activity-label" data-part="activity-label">
          {title}
        </span>
        <span className="pk-activity-state" data-part="activity-state">
          {tool.kind === "step" && tool.state === "waiting"
            ? labels.activityWaiting
            : labels.tool[tool.state]}
        </span>
      </div>
      {tool.summary && (
        <p className="pk-activity-summary" data-part="activity-summary">
          {tool.summary}
        </p>
      )}
      {tool.detail && (
        <details
          className="pk-activity-details"
          data-part="activity-details"
          data-state={open ? "open" : "closed"}
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary
            className="pk-activity-trigger"
            data-part="activity-trigger"
            aria-controls={detailId}
          >
            {labels.details}
          </summary>
          <div
            id={detailId}
            className="pk-activity-detail"
            data-part="activity-detail"
            style={{ whiteSpace: "pre-wrap" }}
          >
            {tool.detail}
          </div>
        </details>
      )}
      {children}
      {actions && (
        <div className="pk-activity-actions" data-part="activity-actions">
          {actions}
        </div>
      )}
    </div>
  );
}

export interface SpecialistActivityProps extends ComponentProps<"section"> {
  agent: AgentPart;
  /** Keyed by run id or registered agentId. A run-specific label takes precedence. */
  specialistLabels?: Readonly<Record<string, string>>;
  label?: string;
  labels?: ConversationLabelOverrides;
}

/** Child rows stay open when the specialist settles. Ending work never hides the reader's view. */
export function SpecialistActivity({
  agent,
  specialistLabels,
  label,
  labels: overrides,
  children,
  className,
  ...props
}: SpecialistActivityProps) {
  const labels = useConversationLabels(overrides);
  const headingId = useId();
  const definitionId = agent.kind === "workflow" ? agent.workflowId : agent.agentId;
  const definitionLabel =
    specialistLabels && definitionId && Object.hasOwn(specialistLabels, definitionId)
      ? specialistLabels[definitionId]
      : undefined;
  const namedLabel =
    specialistLabels && Object.hasOwn(specialistLabels, agent.id)
      ? specialistLabels[agent.id]
      : definitionLabel;
  return (
    <section
      aria-labelledby={headingId}
      {...props}
      className={uiClass("pk-specialist", className)}
      data-part="specialist"
      data-state={agent.state}
      data-agent-id={agent.id}
      data-parent-id={agent.parentId}
      data-kind={agent.kind}
    >
      <div id={headingId} className="pk-activity-heading" data-part="activity-heading">
        <span className="pk-activity-label" data-part="activity-label">
          {label ?? namedLabel ?? agent.label}
        </span>
        <span className="pk-activity-state" data-part="activity-state">
          {agent.state === "waiting" ? labels.activityWaiting : labels.run[agent.state]}
        </span>
      </div>
      {agent.kind === "handoff" && (
        <p className="pk-activity-summary" data-part="handoff">
          {labels.handoff}
        </p>
      )}
      {children && (
        <div className="pk-specialist-children" data-part="specialist-children">
          {children}
        </div>
      )}
    </section>
  );
}
