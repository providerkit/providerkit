"use client";

import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import type { ChatClient, InputView } from "../client.ts";
import type { RunInfo } from "../protocol.ts";
import {
  uiClass,
  useConversationData,
  useConversationLabels,
  type ConversationLabelOverrides,
} from "./context.tsx";

export interface InputStatusListProps extends ComponentProps<"section"> {
  inputs?: readonly InputView[];
  run?: RunInfo;
  scopeKey?: string;
  onRecall?: ChatClient["recallInput"];
  labels?: ConversationLabelOverrides;
}

/** Delivery receipts stay apart from the answer. No button resends text or starts another run. */
export function InputStatusList({
  inputs: supplied,
  run: suppliedRun,
  scopeKey,
  onRecall: suppliedRecall,
  labels: overrides,
  className,
  ...props
}: InputStatusListProps) {
  const data = useConversationData();
  const labels = useConversationLabels(overrides);
  const inputs = supplied ?? data?.inputs ?? [];
  const run = suppliedRun ?? data?.run;
  const onRecall = suppliedRecall ?? data?.recallInput;
  if (!inputs.length) return null;
  return (
    <section
      {...props}
      className={uiClass("pk-inputs", className)}
      data-part="inputs"
      aria-label={labels.inputs}
    >
      {inputs.map((input) => (
        <div
          key={JSON.stringify([scopeKey ?? data?.scopeKey, input.rootRunId, input.id])}
          className="pk-input"
          data-part="input"
          data-state={input.status}
        >
          {input.text && (
            <p className="pk-activity-summary" style={{ whiteSpace: "pre-wrap" }}>
              {input.text}
            </p>
          )}
          {input.attachments?.map((file) => (
            <p key={file.id} className="pk-activity-summary">
              {file.name}
            </p>
          ))}
          <p className="pk-status-text" role="status">
            {labels.input[input.status]}
          </p>
          {input.status === "queued" &&
            run?.id === input.rootRunId &&
            run.status !== "running" &&
            run.status !== "waiting" && (
              <p className="pk-status-help">{labels.queuedAfterCompletion}</p>
            )}
          {input.error && (
            <p className="pk-status-error" role="status">
              {labels.error(input.error)}
            </p>
          )}
          {input.canRecall && onRecall && (
            <Recall key={input.status} input={input} onRecall={onRecall} labels={overrides} />
          )}
        </div>
      ))}
    </section>
  );
}

function Recall({
  input,
  onRecall,
  labels: overrides,
}: {
  input: InputView;
  onRecall: ChatClient["recallInput"];
  labels?: ConversationLabelOverrides;
}) {
  const labels = useConversationLabels(overrides);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const current = useRef<InputView | undefined>(input);
  useLayoutEffect(() => {
    current.current = input;
    return () => {
      current.current = undefined;
    };
  }, [input]);
  async function recall() {
    if (busy.current || input.recalling || current.current !== input) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    let failure: string | undefined;
    try {
      const result = await onRecall(input.id);
      if (!result.ok) failure = labels.error(result.error);
    } catch {
      failure = labels.recallFailed;
    }
    busy.current = false;
    if (!current.current) return;
    setPending(false);
    if (current.current === input) setError(failure);
  }
  return (
    <>
      <button
        type="button"
        className="pk-status-action"
        data-part="recall-input"
        data-state={pending || input.recalling ? "pending" : "ready"}
        disabled={pending || input.recalling}
        aria-disabled={pending || input.recalling}
        aria-busy={pending || input.recalling}
        onClick={() => void recall()}
      >
        {pending || input.recalling ? labels.recallingInput : labels.recallInput}
      </button>
      {error && (
        <p className="pk-status-error" role="status">
          {error}
        </p>
      )}
    </>
  );
}
