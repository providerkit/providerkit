import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { DisplayError } from "@providerkit/react";
import { Action } from "./action.tsx";
import { part, root, useSkin, type Appearance } from "./classes.tsx";
import { useLabels, type ChatLabelOverrides } from "./labels.ts";
import { noticeView, type DescribedError } from "./rules.ts";

export interface ErrorNoticeProps extends Appearance {
  error: DisplayError;
  /** What failed, such as "Your message may not have arrived". */
  title?: string;
  /** Your app's error describer. Its cause and fix replace the host's
   * words, its `recover` decides whether Retry can help, and its reference is shown for support. */
  describe?: (error: DisplayError) => DescribedError;
  /** Offers Retry. It shows only when a retry can work: not when the describer or the host says it
   * cannot. */
  onRetry?: () => unknown;
  /** Retry stays in view but turned off, because a retry cannot reach the server. */
  offline?: boolean;
  /** Retry's words, such as "Reconnect". */
  retryLabel?: string;
  labels?: ChatLabelOverrides;
  /** Your own actions, such as See usage beside a payment error. */
  children?: ReactNode;
}

/** What failed, why and what to do, with Retry only when a retry can work. */
export function ErrorNotice({
  error,
  title,
  describe,
  onRetry,
  offline = false,
  retryLabel,
  labels: overrides,
  children,
  className,
  style,
}: ErrorNoticeProps) {
  const skin = useSkin();
  const labels = useLabels(overrides).notice;
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const view = noticeView(
    { ...error, message: labels.error(error) },
    describe?.(error),
    onRetry !== undefined,
    offline,
  );
  async function retry(): Promise<void> {
    if (!onRetry || pending) return;
    setPending(true);
    setUncertain(false);
    try {
      await onRetry();
    } catch {
      setUncertain(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <View
      {...root(part(skin, "notice", "root", { code: error.code }), { className, style })}
      accessibilityRole="alert"
    >
      {title ? <Text {...part(skin, "notice", "title")}>{title}</Text> : null}
      <Text selectable {...part(skin, "notice", "message")}>
        {view.message}
      </Text>
      {uncertain ? <Text {...part(skin, "notice", "message")}>{labels.retryFailed}</Text> : null}
      {view.reference ? (
        <Text selectable {...part(skin, "notice", "reference")}>
          {labels.reference(view.reference)}
        </Text>
      ) : null}
      {view.retry !== "hidden" || children ? (
        <View {...part(skin, "notice", "actions")}>
          {view.retry !== "hidden" ? (
            <Action
              box={part(skin, "notice", "retry")}
              text={part(skin, "notice", "retryText")}
              label={retryLabel ?? labels.retry}
              disabled={view.retry === "off"}
              busy={pending}
              onPress={() => void retry()}
            />
          ) : null}
          {children}
        </View>
      ) : null}
    </View>
  );
}
