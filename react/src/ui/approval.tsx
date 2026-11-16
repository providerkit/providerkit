"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { RequestResponse, RequestView } from "../client.ts";
import {
  uiClass,
  useConversationData,
  useConversationLabels,
  type ApprovalDisplayState,
  type ConversationLabelOverrides,
  type RespondToRequest,
} from "./context.tsx";

export interface ApprovalActions {
  request: RequestView;
  state: ApprovalDisplayState;
  disabled: boolean;
  /** The same guarded callback as the default buttons, suitable for a host dialog. */
  onRespond?: (response: RequestResponse) => Promise<void>;
}

export interface ApprovalCardProps extends Omit<ComponentProps<"section">, "children"> {
  request: RequestView;
  onRespond?: RespondToRequest;
  labels?: ConversationLabelOverrides;
  /** Overrides the clock, for a host's authoritative expiry or deterministic rendering. */
  expired?: boolean;
  renderActions?: (actions: ApprovalActions) => ReactNode;
}

export function ApprovalCard(props: ApprovalCardProps) {
  // A different request never inherits a previous request's pending decision or expiry timer.
  return (
    <ApprovalContent
      key={JSON.stringify([props.request.messageId, props.request.part.id])}
      {...props}
    />
  );
}

interface DecisionFeedback {
  external: RequestView["local"];
  local?: RequestView["local"];
}

function sameDecision(left: RequestView["local"], right: RequestView["local"]): boolean {
  return (
    left?.status === right?.status &&
    left?.response.type === right?.response.type &&
    (left?.response.type === "deny" ? left.response.message : undefined) ===
      (right?.response.type === "deny" ? right.response.message : undefined) &&
    left?.error?.code === right?.error?.code &&
    left?.error?.message === right?.error?.message
  );
}

function ApprovalActionSlot({
  render,
  actions,
}: {
  render: NonNullable<ApprovalCardProps["renderActions"]>;
  actions: ApprovalActions;
}) {
  return render(actions);
}

function ApprovalContent({
  request,
  onRespond: suppliedRespond,
  labels: overrides,
  expired,
  renderActions,
  className,
  ...props
}: ApprovalCardProps) {
  const data = useConversationData();
  const labels = useConversationLabels(overrides);
  const onRespond = suppliedRespond ?? data?.respond;
  const { part } = request;
  const [clock, setClock] = useState(Date.now);
  const [feedback, setFeedback] = useState<DecisionFeedback>({ external: request.local });
  // Host feedback supersedes immediate feedback. Plain-data hosts may rebuild unchanged objects.
  const sameExternal = sameDecision(feedback.external, request.local);
  if (!sameExternal) setFeedback({ external: request.local });
  const sending = useRef(false);
  const titleId = useId();
  const summaryId = useId();
  const isExpired = expired ?? (part.expiresAt !== undefined && clock >= part.expiresAt);
  const decision = sameExternal ? (feedback.local ?? request.local) : request.local;
  const state: ApprovalDisplayState =
    part.state !== "pending" ? part.state : isExpired ? "expired" : (decision?.status ?? "pending");
  const disabled = !onRespond || (state !== "pending" && state !== "failed");

  useEffect(() => {
    if (
      expired !== undefined ||
      part.state !== "pending" ||
      part.expiresAt === undefined ||
      isExpired
    )
      return;
    // One wake at expiry, not an announcing countdown. Long deadlines respect the timer limit.
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.min(Math.max(0, part.expiresAt - Date.now()), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [expired, part.state, part.expiresAt, isExpired, clock]);

  // A host dialog may retain its callback. Use the latest committed eligibility, and invalidate
  // that callback when this keyed request leaves the view.
  const currentRespond = useRef<ApprovalActions["onRespond"]>(undefined);
  useLayoutEffect(() => {
    currentRespond.current = async (response: RequestResponse) => {
      const expiredNow = expired ?? (part.expiresAt !== undefined && Date.now() >= part.expiresAt);
      if (disabled || sending.current || expiredNow || !onRespond) return;
      sending.current = true;
      const attempt: DecisionFeedback = {
        external: request.local,
        local: { status: "submitting", response },
      };
      setFeedback(attempt);
      function finish(local: NonNullable<RequestView["local"]>) {
        // A late callback cannot overwrite a more recent reply from the host.
        setFeedback((current) => (current === attempt ? { ...current, local } : current));
      }
      try {
        const result = await onRespond(part.id, response);
        // A successful delivery is not approval. Only the host can change the request's state.
        if (!result || result.ok) return;
        const status = result.error.code === "unconfirmed" ? "unconfirmed" : "failed";
        finish({ status, response, error: result.error });
      } catch {
        // An unknown outcome must never quietly turn back into an answerable request.
        finish({
          status: "unconfirmed",
          response,
          error: { code: "unconfirmed", message: labels.approvalFailed },
        });
      } finally {
        sending.current = false;
      }
    };
    return () => {
      currentRespond.current = undefined;
    };
  }, [disabled, expired, part.id, part.expiresAt, onRespond, request.local, labels.approvalFailed]);
  const respond = useCallback(async (response: RequestResponse) => {
    await currentRespond.current?.(response);
  }, []);

  const shownRequest = decision ? { ...request, local: decision } : request;
  const actions: ApprovalActions = {
    request: shownRequest,
    state,
    disabled,
    onRespond: onRespond ? respond : undefined,
  };
  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={part.summary ? summaryId : undefined}
      {...props}
      className={uiClass("pk-approval", className)}
      data-part="approval"
      data-state={state}
      data-request-id={part.id}
    >
      <p id={titleId} className="pk-approval-title" data-part="approval-title">
        {part.title}
      </p>
      {part.summary && (
        <p
          id={summaryId}
          className="pk-approval-summary"
          data-part="approval-summary"
          style={{ whiteSpace: "pre-wrap" }}
        >
          {part.summary}
        </p>
      )}
      <p
        className="pk-approval-status"
        data-part="approval-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {labels.approval[state]}
      </p>
      {decision?.error && part.state === "pending" && !isExpired && (
        <p className="pk-approval-error" data-part="approval-error">
          {labels.error(decision.error)}
        </p>
      )}
      {!onRespond && state === "pending" && (
        <p className="pk-approval-help" data-part="approval-help">
          {labels.approvalReadOnly}
        </p>
      )}
      {renderActions ? (
        <ApprovalActionSlot render={renderActions} actions={actions} />
      ) : (
        <div className="pk-approval-actions" data-part="approval-actions">
          <button
            className="pk-approval-action"
            data-part="approve"
            data-state={state}
            type="button"
            disabled={disabled}
            aria-busy={state === "submitting"}
            onClick={() => void respond({ type: "approve" })}
          >
            {labels.approve}
          </button>
          <button
            className="pk-approval-action"
            data-part="deny"
            data-state={state}
            type="button"
            disabled={disabled}
            aria-busy={state === "submitting"}
            onClick={() => void respond({ type: "deny" })}
          >
            {labels.deny}
          </button>
        </div>
      )}
    </section>
  );
}
