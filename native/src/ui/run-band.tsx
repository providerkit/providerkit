/**
 * The run's one strip: while the agent works it says so, with
 * the elapsed time and a Stop that stays in reach; parked on the person it says what it waits for;
 * once the run ends it says how, until the next run starts.
 *
 * A screen reader hears the result once. The reply streams with no live region, because it would
 * be read again on every word, so the band announces the end and the reply is there to read. Only
 * the band's words are live while it works: the clock ticks every second and is hidden from the
 * screen reader, or it would read the band again each time.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, Text, View } from "react-native";
import type { ChatStatus, CommandResult, RequestView } from "@providerkit/react";
import type { RunInfo } from "@providerkit/react/protocol";
import { Action } from "./action.tsx";
import { part, root, useSkin, type Appearance } from "./classes.tsx";
import { useLabels, type ChatLabelOverrides, type ChatLabels } from "./labels.ts";
import { bandState, type BandMemory } from "./rules.ts";

/** What the band reads from `useChat` or `useAgentRun`. */
export interface RunBandChat {
  run: RunInfo;
  status: ChatStatus;
  canStop: boolean;
  requests: readonly RequestView[];
  stop: () => Promise<CommandResult>;
}

export interface RunBandProps extends Appearance {
  chat: RunBandChat;
  /** Host timestamps, in epoch milliseconds. Opening a conversation late must not restart its clock. */
  startedAt?: number;
  endedAt?: number;
  labels?: ChatLabelOverrides;
  icons?: { stop?: ReactNode };
}

/** One tick a second, only while there is something to tick. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    // A zero-delay timer moves the clock the moment the run starts, outside the effect itself.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
    };
  }, [active]);
  return now;
}

interface Held {
  memory: BandMemory;
  /** Counts the announcements, so the same result twice in a row is still said twice. */
  said: number;
  words?: string;
}

export function RunBand({
  chat,
  startedAt: start,
  endedAt: end,
  labels: overrides,
  icons,
  className,
  style,
}: RunBandProps) {
  const skin = useSkin();
  const words = useLabels(overrides);
  const labels = words.band;
  const [held, setHeld] = useState<Held>({ memory: {}, said: 0 });
  const { view, memory, announce } = bandState(
    { run: chat.run, status: chat.status, canStop: chat.canStop, requests: chat.requests },
    held.memory,
  );
  if (memory !== held.memory)
    setHeld({
      memory,
      said: announce ? held.said + 1 : held.said,
      words: announce ? labels.result[announce] : held.words,
    });
  useEffect(() => {
    if (held.said > 0 && held.words) AccessibilityInfo.announceForAccessibility(held.words);
  }, [held.said, held.words]);

  const busy = view.phase === "working" || view.phase === "waiting";
  const now = useNow(busy && start !== undefined);
  if (view.phase === "hidden") return null;
  if (view.phase === "ended") {
    const length = start !== undefined && end !== undefined ? end - start : undefined;
    return (
      <View {...root(part(skin, "band", "root", { state: view.result }), { className, style })}>
        <Text {...part(skin, "band", "label")}>
          {length !== undefined && length >= 0
            ? `${labels.result[view.result]} · ${labels.duration(length)}`
            : labels.result[view.result]}
        </Text>
      </View>
    );
  }
  return (
    <View
      {...root(part(skin, "band", "root", { state: view.phase }), { className, style })}
      accessibilityRole="summary"
    >
      <Text accessibilityLiveRegion="polite" numberOfLines={1} {...part(skin, "band", "label")}>
        {labels[view.label]}
      </Text>
      {start !== undefined ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          {...part(skin, "band", "clock")}
        >
          {labels.duration(now - start)}
        </Text>
      ) : null}
      {view.stop !== "none" ? (
        <Stop
          key={chat.run.id ?? chat.run.messageId}
          stop={chat.stop}
          pending={view.stop === "pending"}
          label={labels.stop}
          failed={labels.stopFailed}
          describe={words.notice.error}
          icon={icons?.stop}
        />
      ) : null}
    </View>
  );
}

/** Stop, and why it did not go through. Keyed by the run, so a refusal belongs to its run. */
function Stop({
  stop,
  pending,
  label,
  failed,
  describe,
  icon,
}: {
  stop: RunBandChat["stop"];
  pending: boolean;
  label: string;
  failed: string;
  describe: ChatLabels["notice"]["error"];
  icon?: ReactNode;
}) {
  const skin = useSkin();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  async function press(): Promise<void> {
    if (pending || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const result = await stop();
      if (!result.ok) setError(describe(result.error));
    } catch {
      setError(failed);
    } finally {
      setSending(false);
    }
  }
  return (
    <>
      <Action
        box={part(skin, "band", "stop")}
        text={part(skin, "band", "stopText")}
        label={label}
        icon={icon}
        busy={pending || sending}
        onPress={() => void press()}
      />
      {error ? (
        <Text accessibilityRole="alert" {...part(skin, "band", "error")}>
          {error}
        </Text>
      ) : null}
    </>
  );
}
