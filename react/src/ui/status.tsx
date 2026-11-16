"use client";

import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { ChatStatus, ConnectionStatus as ConnectionState } from "../client.ts";
import type { DisplayError, RunInfo } from "../protocol.ts";
import {
  uiClass,
  useConversationData,
  useConversationLabels,
  type ConversationData,
  type ConversationLabelOverrides,
  type ConversationLabels,
} from "./context.tsx";

export interface RunStatusDisplayProps extends ComponentProps<"div"> {
  run?: RunInfo;
  status?: ChatStatus;
  canStop?: boolean;
  onStop?: ConversationData["stop"];
  labels?: ConversationLabelOverrides;
  /** A host action for a limit or a run failure, such as changing a budget. */
  recoveryAction?: ReactNode;
}

/** Connection state never changes the run's status. A disconnected run may still be working. */
export function RunStatusDisplay({
  run: suppliedRun,
  status: suppliedStatus,
  canStop: suppliedCanStop,
  onStop: suppliedStop,
  labels: overrides,
  recoveryAction,
  children,
  className,
  ...props
}: RunStatusDisplayProps) {
  const data = useConversationData();
  const labels = useConversationLabels(overrides);
  const run = suppliedRun ?? data?.run ?? { status: "idle" };
  const status = suppliedStatus ?? data?.status;
  const onStop = suppliedStop ?? data?.stop;
  const canStop = suppliedCanStop ?? data?.canStop ?? Boolean(onStop);
  const state = status && status !== "ready" ? status : run.status;
  const active =
    state === "running" || state === "waiting" || state === "sending" || state === "stopping";
  const title =
    state === "stopping"
      ? labels.stopping
      : state === "sending"
        ? labels.message.sending
        : labels.run[state];
  const help =
    state !== run.status
      ? undefined
      : run.error
        ? labels.error(run.error)
        : state === "limited"
          ? labels.limitedHelp
          : state === "failed"
            ? labels.failedHelp
            : undefined;
  return (
    <div
      {...props}
      className={uiClass("pk-run-status", className)}
      data-part="run-status"
      data-state={state}
    >
      <span
        className="pk-status-text"
        data-part="status-text"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {title}
      </span>
      {run.owner && (
        <p className="pk-status-text" data-part="conversation-owner">
          {labels.conversationOwner(run.owner.label)}
        </p>
      )}
      {help && (
        <p className="pk-status-help" data-part="status-help">
          {help}
        </p>
      )}
      {active && onStop && (canStop || status === "stopping") && (
        <StopAction
          key={run.id ?? run.messageId}
          onStop={onStop}
          pending={status === "stopping"}
          labels={labels}
        />
      )}
      {recoveryAction}
      {children}
    </div>
  );
}

function StopAction({
  onStop,
  pending,
  labels,
}: {
  onStop: NonNullable<ConversationData["stop"]>;
  pending: boolean;
  labels: ConversationLabels;
}) {
  const busy = useRef(false);
  const [feedback, setFeedback] = useState({ external: pending, sending: false });
  // Observation may toggle pending before the command returns. Its refusal belongs to this
  // keyed run, not to one render of the external pending state.
  const [error, setError] = useState<string>();
  if (feedback.external !== pending) setFeedback({ external: pending, sending: false });
  const waiting = pending || (feedback.external === pending && feedback.sending);
  async function stop() {
    if (waiting || busy.current) return;
    busy.current = true;
    setFeedback({ external: pending, sending: true });
    setError(undefined);
    let failure: string | undefined;
    try {
      const result = await onStop();
      if (!result || result.ok) return;
      failure = labels.error(result.error);
    } catch {
      failure = labels.stopFailed;
    } finally {
      busy.current = false;
    }
    setFeedback((current) => ({ ...current, sending: false }));
    setError(failure);
  }
  return (
    <>
      <button
        className="pk-status-action"
        data-part="stop"
        data-state={waiting ? "pending" : "ready"}
        type="button"
        aria-disabled={waiting}
        aria-busy={waiting}
        onClick={() => void stop()}
      >
        {waiting ? labels.stopping : labels.stop}
      </button>
      {error && (
        <p className="pk-status-error" data-part="status-error" role="status">
          {error}
        </p>
      )}
    </>
  );
}

export interface ConnectionStatusDisplayProps extends ComponentProps<"div"> {
  connection?: ConnectionState;
  error?: DisplayError;
  canReconnect?: boolean;
  onReconnect?: ConversationData["reconnect"];
  labels?: ConversationLabelOverrides;
}

export function ConnectionStatusDisplay({
  connection: suppliedConnection,
  error: suppliedError,
  canReconnect: suppliedCanReconnect,
  onReconnect: suppliedReconnect,
  labels: overrides,
  children,
  className,
  ...props
}: ConnectionStatusDisplayProps) {
  const data = useConversationData();
  const labels = useConversationLabels(overrides);
  const connection = suppliedConnection ?? data?.connection ?? "idle";
  const error = suppliedError ?? data?.error;
  const onReconnect = suppliedReconnect ?? data?.reconnect;
  const canReconnect = suppliedCanReconnect ?? data?.canReconnect ?? Boolean(onReconnect);
  return (
    <div
      {...props}
      className={uiClass("pk-connection-status", className)}
      data-part="connection-status"
      data-state={connection}
    >
      <span
        className="pk-status-text"
        data-part="status-text"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {labels.connection[connection]}
      </span>
      {error && (
        <p className="pk-status-error" data-part="status-error">
          {labels.error(error)}
        </p>
      )}
      {connection === "lost" &&
        (canReconnect && onReconnect ? (
          <ReconnectAction onReconnect={onReconnect} labels={labels} />
        ) : (
          <p className="pk-status-help" data-part="status-help">
            {labels.reconnectHelp}
          </p>
        ))}
      {children}
    </div>
  );
}

function ReconnectAction({
  onReconnect,
  labels,
}: {
  onReconnect: NonNullable<ConversationData["reconnect"]>;
  labels: ConversationLabels;
}) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function reconnect() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailed(false);
    try {
      await onReconnect();
      // An opened connection is confirmed by host data, not by the callback returning.
    } catch {
      busy.current = false;
      setPending(false);
      setFailed(true);
    }
  }
  return (
    <>
      <button
        className="pk-status-action"
        data-part="reconnect"
        data-state={pending ? "pending" : "ready"}
        type="button"
        aria-disabled={pending}
        aria-busy={pending}
        onClick={() => void reconnect()}
      >
        {pending ? labels.connection.reconnecting : labels.reconnect}
      </button>
      {failed && (
        <p className="pk-status-error" data-part="status-error" role="status">
          {labels.reconnectFailed}
        </p>
      )}
    </>
  );
}
