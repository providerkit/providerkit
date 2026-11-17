"use client";

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  TransportError,
  type RequestResponse,
  type RequestView,
  type RespondResult,
} from "../client.ts";
import { checkResponse, type QuestionAnswer } from "../requests.ts";
import { QuestionFields, type QuestionFieldsProps } from "./question.tsx";
import { formFields } from "./schema-form.tsx";
import {
  uiClass,
  useConversationData,
  useConversationLabels,
  type RequestDisplayState,
  type ConversationLabelOverrides,
  type RespondToRequest,
} from "./context.tsx";

export interface RequestActions {
  request: RequestView;
  state: RequestDisplayState;
  disabled: boolean;
  /** Guarded even when a host dialog retains it after expiry, replacement or unmount. */
  onRespond?: (response: RequestResponse) => Promise<void>;
  onStart?: () => Promise<void>;
  value: QuestionAnswer;
  onValueChange(value: QuestionAnswer): void;
}

export interface RequestCardProps extends Omit<ComponentProps<"section">, "children"> {
  /** Local principal/conversation key. Defaults to Conversation's scopeKey. Never rendered. */
  scopeKey?: string;
  request: RequestView;
  onRespond?: RespondToRequest;
  onStartClientTool?: (requestId: string) => Promise<RespondResult>;
  labels?: ConversationLabelOverrides;
  expired?: boolean;
  renderActions?: (actions: RequestActions) => ReactNode;
  /** Controlled drafts let the host keep values when a card leaves the transcript. No storage is implicit. */
  value?: QuestionAnswer;
  onValueChange?: (value: QuestionAnswer) => void;
  renderForm?: QuestionFieldsProps["renderForm"];
}

export type ApprovalActions = RequestActions;
export type ApprovalCardProps = RequestCardProps;

/** Existing approve/deny composition remains a subset of the request card. */
export function ApprovalCard(props: ApprovalCardProps) {
  return <RequestCard {...props} />;
}

export function RequestCard({ scopeKey, ...props }: RequestCardProps) {
  const data = useConversationData();
  return (
    <RequestContent
      key={JSON.stringify([
        scopeKey ?? data?.scopeKey,
        props.request.messageId,
        props.request.part.id,
      ])}
      {...props}
    />
  );
}

interface Feedback {
  part: RequestView["part"];
  external: RequestView["local"];
  local?: RequestView["local"];
}

function sameFeedback(left: RequestView["local"], right: RequestView["local"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ActionSlot({
  render,
  actions,
}: {
  render: NonNullable<RequestCardProps["renderActions"]>;
  actions: RequestActions;
}) {
  return render(actions);
}

function RequestContent({
  request,
  onRespond: suppliedRespond,
  onStartClientTool: suppliedStart,
  labels: overrides,
  expired,
  renderActions,
  value: suppliedValue,
  onValueChange,
  renderForm,
  className,
  ref,
  onBlur,
  ...props
}: RequestCardProps) {
  const data = useConversationData();
  const labels = useConversationLabels(overrides);
  const onRespond = suppliedRespond ?? data?.respond;
  const onStart = suppliedStart ?? data?.startClientTool;
  const { part } = request;
  const [clock, setClock] = useState(Date.now);
  const [draft, setDraft] = useState<QuestionAnswer>(() =>
    request.local?.response.type === "answer" ? request.local.response.answer : {},
  );
  const value = suppliedValue ?? draft;
  const [feedback, setFeedback] = useState<Feedback>({ part, external: request.local });
  const sameExternal = sameFeedback(feedback.external, request.local);
  if (!sameExternal) setFeedback({ part, external: request.local });
  else if (
    !request.local &&
    feedback.part !== part &&
    part.state === "pending" &&
    part.problem &&
    feedback.local
  ) {
    // Plain-data hosts report rejection through the part, without the client store's local state.
    setFeedback({
      part,
      external: request.local,
      local: { ...feedback.local, status: "failed", error: part.problem },
    });
  }
  const sending = useRef<Feedback | undefined>(undefined);
  const region = useRef<HTMLElement>(null);
  const focusHeld = useRef(false);
  useImperativeHandle(ref, () => region.current!, []);
  const titleId = useId();
  const summaryId = useId();
  const isExpired = expired ?? (part.expiresAt !== undefined && clock >= part.expiresAt);
  const decision = sameExternal ? (feedback.local ?? request.local) : request.local;
  const state: RequestDisplayState =
    part.state !== "pending" ? part.state : isExpired ? "expired" : (decision?.status ?? "pending");
  const allowed = part.canAnswer !== false && request.canRespond !== false;
  const reconcilable =
    part.type === "client-tool" && request.canReconcile === true && state === "unconfirmed";
  const disabled =
    !allowed || !onRespond || (state !== "pending" && state !== "failed" && !reconcilable);
  const customApproval =
    part.type === "approval" && !!(part.edit || part.approveForm || part.denyForm);
  const unsupported =
    (part.type === "question" &&
      ((part.schema && !renderForm && !formFields(part.schema)) ||
        (!part.schema && !part.choices?.length && part.freeText === false))) ||
    customApproval;

  useEffect(() => {
    if (
      expired !== undefined ||
      part.state !== "pending" ||
      part.expiresAt === undefined ||
      isExpired
    )
      return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.min(Math.max(0, part.expiresAt - Date.now()), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [expired, part.state, part.expiresAt, isExpired, clock]);

  useLayoutEffect(() => {
    if (!focusHeld.current || state === "submitting") return;
    focusHeld.current = false;
    const node = region.current;
    // The region holds focus before controls are disabled. Leaving it cancels restoration;
    // a keyed scope/request replacement also discards this ref, so late replies cannot steal focus.
    if (!node || node.ownerDocument.activeElement !== node) return;
    const field = node.querySelector<HTMLElement>(
      'input:not(:disabled):not([readonly]):not([type="hidden"]), textarea:not(:disabled):not([readonly]), select:not(:disabled)',
    );
    const control = node.querySelector<HTMLElement>(
      'button:not(:disabled):not([aria-disabled="true"])',
    );
    (field ?? control ?? node).focus({ preventScroll: true });
  }, [state, decision]);

  const current = useRef<
    | {
        respond(response: RequestResponse): Promise<void>;
        start(): Promise<void>;
        change(value: QuestionAnswer): void;
      }
    | undefined
  >(undefined);
  const latestPart = useRef(part);
  useLayoutEffect(() => {
    latestPart.current = part;
    if (sending.current !== feedback) sending.current = undefined;
    const eligible = () =>
      !disabled &&
      !sending.current &&
      !(expired ?? (part.expiresAt !== undefined && Date.now() >= part.expiresAt));
    const actions = {
      async respond(response: RequestResponse) {
        if (!eligible() || !onRespond) return;
        const error = checkResponse(
          expired === false ? { ...part, expiresAt: undefined } : part,
          response,
        );
        if (error) {
          setFeedback({
            part,
            external: request.local,
            local: { status: "failed", response, error },
          });
          return;
        }
        await execute(response, () => onRespond(part.id, response));
      },
      async start() {
        if (
          !eligible() ||
          request.canRun === false ||
          !onStart ||
          part.type !== "client-tool" ||
          !part.name
        )
          return;
        await execute({ type: "result", value: null }, () => onStart(part.id));
      },
      change(next: QuestionAnswer) {
        if (!eligible()) return;
        setDraft(next);
        onValueChange?.(next);
      },
    };
    async function execute(response: RequestResponse, command: () => ReturnType<RespondToRequest>) {
      const attempt: Feedback = {
        part,
        external: request.local,
        local: { status: "submitting", response },
      };
      sending.current = attempt;
      const node = region.current;
      focusHeld.current = Boolean(node?.contains(node.ownerDocument.activeElement));
      if (focusHeld.current) node?.focus({ preventScroll: true });
      setFeedback(attempt);
      function finish(
        status: "failed" | "unconfirmed",
        error: NonNullable<RequestView["local"]>["error"],
      ) {
        if (!current.current || latestPart.current !== part) return;
        setFeedback((held) =>
          held === attempt ? { ...held, local: { status, response, error } } : held,
        );
      }
      try {
        const result = await command();
        if (result && !result.ok)
          finish(result.error.code === "unconfirmed" ? "unconfirmed" : "failed", result.error);
        else if (result && "outcome" in result && result.outcome === "unknown")
          finish("unconfirmed", { code: "unconfirmed", message: labels.approvalFailed });
      } catch (error) {
        finish(
          error instanceof TransportError && error.outcome === "refused" ? "failed" : "unconfirmed",
          error instanceof TransportError
            ? error.error
            : { code: "unconfirmed", message: labels.approvalFailed },
        );
      } finally {
        if (sending.current === attempt) sending.current = undefined;
      }
    }
    current.current = actions;
    return () => {
      current.current = undefined;
    };
  }, [
    disabled,
    feedback,
    expired,
    part,
    onRespond,
    onStart,
    onValueChange,
    request.local,
    request.canRun,
    labels.approvalFailed,
  ]);
  const respond = useCallback(async (response: RequestResponse) => {
    await current.current?.respond(response);
  }, []);
  const start = useCallback(async () => {
    await current.current?.start();
  }, []);
  const change = useCallback((next: QuestionAnswer) => {
    current.current?.change(next);
  }, []);
  const canStart =
    allowed &&
    request.canRun !== false &&
    onStart !== undefined &&
    part.type === "client-tool" &&
    Boolean(part.name);
  const actions: RequestActions = {
    request: decision ? { ...request, local: decision } : request,
    state,
    disabled,
    onRespond: allowed && onRespond ? respond : undefined,
    onStart: canStart ? start : undefined,
    value,
    onValueChange: change,
  };
  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={part.summary ? summaryId : undefined}
      tabIndex={-1}
      {...props}
      ref={region}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusHeld.current = false;
        onBlur?.(event);
      }}
      className={uiClass("pk-approval", className)}
      data-part={part.type}
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
        {state === "pending" && !allowed
          ? labels.requestWaiting
          : state === "pending" && part.type !== "approval"
            ? labels.requestPending
            : labels.approval[state]}
      </p>
      {(decision?.error ?? part.problem) && part.state === "pending" && !isExpired && (
        <p className="pk-approval-error" data-part="approval-error">
          {labels.error((decision?.error ?? part.problem)!)}
        </p>
      )}
      {!onRespond && allowed && state === "pending" && (
        <p className="pk-approval-help" data-part="approval-help">
          {labels.approvalReadOnly}
        </p>
      )}
      {renderActions ? (
        <ActionSlot render={renderActions} actions={actions} />
      ) : !allowed ? null : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (part.type === "question" && !unsupported) {
              const answer = { ...value };
              // Native validation already checked required fields. An untouched optional form
              // displays {}, so send that same value instead of a missing answer.
              if (part.schema && !renderForm && answer.data === undefined) answer.data = {};
              if (!answer.text?.trim()) delete answer.text;
              void respond({ type: "answer", answer });
            }
          }}
        >
          {part.type === "question" && (
            <QuestionFields
              question={part}
              value={value}
              onChange={change}
              disabled={disabled}
              labels={overrides}
              renderForm={renderForm}
            />
          )}
          {(customApproval || (unsupported && part.type === "question" && !part.schema)) && (
            <p>{labels.unsupportedForm}</p>
          )}
          {part.type === "client-tool" && (
            <p>{canStart ? labels.clientActionWarning : labels.clientActionUnavailable}</p>
          )}
          <div className="pk-approval-actions" data-part="approval-actions">
            {part.type === "approval" && !unsupported ? (
              <>
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
              </>
            ) : (
              <>
                {part.type === "question" && !unsupported && (
                  <button
                    className="pk-approval-action"
                    type="submit"
                    disabled={disabled}
                    aria-busy={state === "submitting"}
                  >
                    {labels.sendAnswer}
                  </button>
                )}
                {canStart && (
                  <button
                    className="pk-approval-action"
                    type="button"
                    disabled={disabled}
                    aria-busy={state === "submitting"}
                    onClick={() => void start()}
                  >
                    {reconcilable ? labels.checkClientAction : labels.runClientAction}
                  </button>
                )}
                <button
                  className="pk-approval-action"
                  type="button"
                  disabled={disabled}
                  onClick={() => void respond({ type: "cancel" })}
                >
                  {labels.skipRequest}
                </button>
              </>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
