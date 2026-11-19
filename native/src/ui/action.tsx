import { useState, type ReactNode } from "react";
import { Pressable, Text, type AccessibilityRole } from "react-native";
import type { PartProps } from "./classes.tsx";

export interface ActionProps {
  box: PartProps<"view">;
  text: PartProps<"text">;
  /** The words, and the name a screen reader says when `icon` stands in for them. */
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  /** On its way: the button keeps its words, says it is busy, and takes no second press. */
  busy?: boolean;
  icon?: ReactNode;
  role?: AccessibilityRole;
  checked?: boolean;
}

/** A button with the app's look on its box and its words, and its state in `data-state`. */
export function Action({
  box,
  text,
  label,
  onPress,
  disabled = false,
  busy = false,
  icon,
  role = "button",
  checked,
}: ActionProps) {
  const [pressed, setPressed] = useState(false);
  const props = {
    ...box,
    dataSet: {
      ...box.dataSet,
      pressed: String(pressed),
      state: busy ? "pending" : disabled ? "disabled" : "ready",
    },
  };
  return (
    <Pressable
      {...props}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy, checked }}
      disabled={disabled || busy}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={onPress}
    >
      {icon ?? <Text {...text}>{label}</Text>}
    </Pressable>
  );
}
