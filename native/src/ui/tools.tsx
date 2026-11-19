/**
 * Tool calls, the line that folds quiet ones, and thinking. Each call reads in your app's words
 * from its tool table (`toolView`), so the host only ever sends a label and a hint, never the
 * call's arguments.
 */
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { ThinkingPart, ToolPart } from "@providerkit/react/protocol";
import { part, root, useSkin, type Appearance } from "./classes.tsx";
import { useLabels, type ChatLabelOverrides } from "./labels.ts";
import { foldWords, isRunning, toolView, type ToolTable } from "./layout.ts";

/** Icons the activity rows draw, already tinted. The package ships none. */
export interface ActivityIcons {
  /** Beside a call that finished. */
  done?: ReactNode;
  /** Beside a call that failed. Its word shows too, so a failure never rests on an icon alone. */
  failed?: ReactNode;
  /** On a folded line while it is closed. */
  closed?: ReactNode;
  /** On a folded line while it is open. */
  open?: ReactNode;
}

export interface ToolRowProps extends Appearance {
  tool: ToolPart;
  tools?: ToolTable;
  /** The running call a screen reader follows: its words are read out as they change. */
  live?: boolean;
  icons?: ActivityIcons;
  labels?: ChatLabelOverrides;
}

/** One call: a spinner while it runs, the icon from your table, its words and the host's hint. A
 * call that waits for the person is still, and says so. */
export function ToolRow({
  tool: call,
  tools,
  live = false,
  icons,
  labels: overrides,
  className,
  style,
}: ToolRowProps) {
  const skin = useSkin();
  const labels = useLabels(overrides).activity;
  const tool = toolView(call, tools);
  const { state, detail } = call;
  const word = labels.state[state];
  let mark: ReactNode;
  if (state === "running")
    mark = (
      <ActivityIndicator
        {...part(skin, "tool", "spinner")}
        size="small"
        color={skin.colors?.spinner}
      />
    );
  else if (state === "failed") mark = icons?.failed;
  else if (state === "done") mark = icons?.done;
  return (
    <View
      {...root(part(skin, "tool", "row", { state, quiet: String(tool.quiet) }), {
        className,
        style,
      })}
      accessible
      accessibilityLabel={[tool.label, tool.hint, word, state === "failed" ? detail : undefined]
        .filter(Boolean)
        .join(", ")}
      accessibilityLiveRegion={live ? "polite" : "none"}
    >
      {mark}
      {tool.icon !== undefined ? <View {...part(skin, "tool", "icon")}>{tool.icon}</View> : null}
      <Text {...part(skin, "tool", "label")}>{tool.label}</Text>
      {tool.hint ? (
        <Text numberOfLines={1} {...part(skin, "tool", "hint")}>
          {tool.hint}
        </Text>
      ) : null}
      {state === "failed" || state === "waiting" ? (
        <Text {...part(skin, "tool", "state")}>{word}</Text>
      ) : null}
      {state === "failed" && detail ? (
        <Text {...part(skin, "tool", "detail")}>{detail}</Text>
      ) : null}
    </View>
  );
}

export interface ToolGroupProps extends Appearance {
  /** The quiet calls, in reading order. */
  items: readonly ToolPart[];
  tools?: ToolTable;
  icons?: ActivityIcons;
  labels?: ChatLabelOverrides;
}

/** A run of quiet calls as one line that opens to show each call. It starts closed: the person
 * reads the answer, and the steps behind it are one press away. */
export function ToolGroup({
  items,
  tools,
  icons,
  labels: overrides,
  className,
  style,
}: ToolGroupProps) {
  const skin = useSkin();
  const labels = useLabels(overrides).activity;
  const [open, setOpen] = useState(false);
  const { names, more } = foldWords(items, tools);
  const words = more > 0 ? `${names.join(", ")} ${labels.more(more)}` : names.join(", ");
  const running = items.some(isRunning);
  return (
    <>
      <Pressable
        {...root(
          part(skin, "group", "row", {
            state: open ? "open" : "closed",
            running: String(running),
          }),
          { className, style },
        )}
        accessibilityRole="button"
        accessibilityLabel={words}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        {open ? icons?.open : icons?.closed}
        <Text {...part(skin, "group", "label")}>{words}</Text>
      </Pressable>
      {open ? (
        <View {...part(skin, "group", "items")}>
          {items.map((item) => (
            <ToolRow key={item.id} tool={item} tools={tools} icons={icons} labels={overrides} />
          ))}
        </View>
      ) : null}
    </>
  );
}

export interface ThinkingRowProps extends Appearance {
  thinking: ThinkingPart;
  labels?: ChatLabelOverrides;
}

/** How long the model thought, never what it thought: by default a host sends only the time.
 * Nothing while it still thinks, because the live line at the end of the answer says so. */
export function ThinkingRow({ thinking, labels: overrides, className, style }: ThinkingRowProps) {
  const skin = useSkin();
  const labels = useLabels(overrides).activity;
  if (!thinking.settled) return null;
  return (
    <View {...root(part(skin, "thinking", "row", { state: "settled" }), { className, style })}>
      <Text {...part(skin, "thinking", "label")}>
        {thinking.durationMs === undefined
          ? labels.thoughtUntimed
          : labels.thought(thinking.durationMs)}
      </Text>
    </View>
  );
}

/** The end of a live answer while no text arrives: the running step, or Thinking. It is the one
 * part of a streaming answer a screen reader follows, in a polite live region, so it hears the
 * work move without the answer read again on every word. */
export function LiveStatus({ label }: { label: string }) {
  const skin = useSkin();
  return (
    <View {...part(skin, "status", "row")} accessibilityLiveRegion="polite">
      <ActivityIndicator
        {...part(skin, "status", "spinner")}
        size="small"
        color={skin.colors?.spinner}
      />
      <Text {...part(skin, "status", "label")}>{label}</Text>
    </View>
  );
}
