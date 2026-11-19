/**
 * Only a confirmed recall hands the words and file references back to the app. The app owns
 * the draft, so nothing typed while waiting is overwritten here.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { CommandResult, InputView } from "@providerkit/react";
import { Action } from "./action.tsx";
import { part, root, useSkin, type Appearance } from "./classes.tsx";
import { useLabels, type ChatLabelOverrides } from "./labels.ts";

/** What the list reads from `useChat`. */
export interface QueuedChat {
  scopeKey?: string;
  inputs: readonly InputView[];
  recallInput: (inputId: string) => Promise<CommandResult>;
}

export interface QueuedMessagesProps extends Appearance {
  chat: QueuedChat;
  /** Restore the confirmed recall to its owner's draft here, including its attachments. Without
   * this callback, taking a message back just removes it from the queue. */
  onRecalled?: (input: InputView) => void;
  labels?: ChatLabelOverrides;
  icons?: { recall?: ReactNode };
}

type Waiting = InputView & { status: "sending" | "unconfirmed" | "queued" | "accepted" };

function isWaiting(input: InputView): input is Waiting {
  return (
    input.status === "sending" ||
    input.status === "unconfirmed" ||
    input.status === "queued" ||
    input.status === "accepted"
  );
}

export function QueuedMessages({
  chat,
  onRecalled,
  labels: overrides,
  icons,
  className,
  style,
}: QueuedMessagesProps) {
  const skin = useSkin();
  const words = useLabels(overrides);
  const labels = words.queued;
  const scope = useRef<symbol | null>(null);
  const [problem, setProblem] = useState<{
    scope: string | undefined;
    run: string;
    id: string;
    message: string;
  }>();
  useLayoutEffect(() => {
    scope.current = Symbol();
    return () => {
      scope.current = null;
    };
  }, [chat.scopeKey]);
  const waiting = chat.inputs.filter(isWaiting);
  if (waiting.length === 0) return null;

  async function recall(input: Waiting): Promise<void> {
    const owner = scope.current;
    if (!owner) return;
    setProblem(undefined);
    let result: CommandResult;
    try {
      result = await chat.recallInput(input.id);
    } catch {
      result = { ok: false, error: { code: "recall_unconfirmed", message: labels.recallFailed } };
    }
    if (scope.current !== owner) return; // Never put recalled words in another chat's draft.
    if (result.ok) onRecalled?.(input);
    else
      setProblem({
        scope: chat.scopeKey,
        run: input.rootRunId,
        id: input.id,
        message: words.notice.error(result.error),
      });
  }

  return (
    <View {...root(part(skin, "queued", "root"), { className, style })}>
      {waiting.map((input, index) => {
        let error: string | undefined;
        if (input.error) error = words.notice.error(input.error);
        else if (
          problem &&
          problem.scope === chat.scopeKey &&
          problem.id === input.id &&
          problem.run === input.rootRunId
        )
          error = problem.message;
        return (
          <View
            key={JSON.stringify([input.rootRunId, input.id])}
            {...part(skin, "queued", "item", { state: input.status })}
          >
            {/* Numbered only once there is a line to be in. */}
            <Text {...part(skin, "queued", "state")}>
              {waiting.length > 1
                ? `${labels.position(index + 1)} · ${labels.state[input.status]}`
                : labels.state[input.status]}
            </Text>
            {input.text ? (
              <Text numberOfLines={4} {...part(skin, "queued", "text")}>
                {input.text}
              </Text>
            ) : null}
            {input.attachments?.map((file) => (
              <Text key={file.id} {...part(skin, "queued", "text")}>
                {file.name}
              </Text>
            ))}
            {error ? (
              <Text accessibilityRole="alert" {...part(skin, "queued", "state")}>
                {error}
              </Text>
            ) : null}
            {input.canRecall || input.recalling ? (
              <Action
                box={part(skin, "queued", "recall")}
                text={part(skin, "queued", "recallText")}
                label={input.recalling ? labels.recalling : labels.recall}
                icon={icons?.recall}
                busy={input.recalling === true}
                onPress={() => void recall(input)}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
