/**
 * The class slots. The components ship no look: every part they draw takes a class name and a
 * style from one map the app sets once, so NativeWind's `className` and plain React Native styles
 * both work, and state reaches the app's classes through `dataSet`.
 *
 * Why no class strings live here: Tailwind skips `node_modules`, so a class written inside this
 * package would compile to nothing. Why no look in `style`: react-native-css merges a part's style
 * as `[classStyle, inlineStyle]`, so an inline style would beat the app's class.
 *
 * Imports nothing from React Native at runtime (its types only), so it runs under Node.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";

type V = "view";
type T = "text";

/**
 * Every part the components draw, by component. A `text` part is a `Text`: React Native has no
 * font that every text inherits, so each one needs its own class. A `view` part is a `View`, a
 * `Pressable`, a `TextInput` or a list.
 */
export interface ChatParts {
  list: {
    /** The `FlatList` itself. */
    root: V;
    /** The scroll viewport, inside the root that also holds the jump button. */
    scroll: V;
    /** The list's content, around every row. */
    content: V;
    /** What shows while there are no messages: empty, loading or failed. */
    empty: V;
    emptyText: T;
    /** The button that scrolls back to the newest message. */
    jump: V;
    jumpText: T;
  };
  message: {
    /** A row the person wrote. Its `data-role` is `user`. */
    user: V;
    /** A row the assistant wrote. Its `data-role` is `assistant`. */
    assistant: V;
    /** The person's own words, exactly as typed. */
    userText: T;
    /** "Sending..." under a message that is on its way. */
    state: T;
    /** A file shown in the conversation. */
    attachment: V;
    attachmentText: T;
    /** A source the answer used. */
    source: V;
    sourceText: T;
    /** Shown under a text part the host marked incomplete. */
    incomplete: T;
  };
  markdown: {
    root: V;
    paragraph: T;
    /** `data-level` is 1 to 6. */
    heading: T;
    list: V;
    item: V;
    /** The `•` or the `1.` before an item. */
    bullet: T;
    itemText: T;
    code: V;
    codeText: T;
    strong: T;
    em: T;
    codeSpan: T;
    link: T;
    /** A citation such as `[1]`, when the message has that source. */
    cite: T;
    /** An image the app does not draw, shown as its alt text. */
    image: T;
    imageBox: V;
    /** Shown when a link could not be opened. */
    linkFailed: T;
  };
  tool: {
    /** One call. `data-state` is `running`, `waiting`, `done` or `failed`. */
    row: V;
    spinner: V;
    /** Around the icon from your tool table. */
    icon: V;
    label: T;
    /** The hint the host sent, such as a search or a file name. */
    hint: T;
    /** The word for a failed call. */
    state: T;
    /** What the host said about a failed call. */
    detail: T;
  };
  group: {
    /** One line for a run of quiet calls. `data-state` is `open` or `closed`. */
    row: V;
    label: T;
    /** The calls, once the line is open. */
    items: V;
  };
  thinking: {
    /** How long the model thought. */
    row: V;
    label: T;
  };
  status: {
    spinner: V;
    /** The line at the end of an answer while no text arrives: the running step, or Thinking. */
    row: V;
    label: T;
  };
  band: {
    /** `data-state` is `working`, `waiting` or the result: `completed`, `stopped`, `limited` or
     * `failed`. */
    root: V;
    label: T;
    /** The elapsed time. */
    clock: T;
    stop: V;
    stopText: T;
    /** Why a stop did not go through. */
    error: T;
  };
  composer: {
    root: V;
    /** Around the text box and the button. */
    field: V;
    /** The `TextInput`. */
    input: T;
    /** The one button: Send, Queue or Stop. `data-action` says which. */
    button: V;
    buttonText: T;
    attach: V;
    attachText: T;
    /** A note under the box: too long, offline, uploading or an error. `data-kind` says which. */
    note: T;
    files: V;
    /** One file. `data-state` is `queued`, `uploading`, `ready` or `failed`. */
    file: V;
    fileName: T;
    fileState: T;
    fileAction: V;
    fileActionText: T;
  };
  queued: {
    root: V;
    /** One message waiting for the agent. `data-state` is its delivery state. */
    item: V;
    text: T;
    state: T;
    recall: V;
    recallText: T;
  };
  request: {
    /** `data-state` is the request's state, such as `pending`, `submitting` or `expired`. */
    root: V;
    title: T;
    summary: T;
    status: T;
    error: T;
    actions: V;
    /** `data-kind` is `primary` for Approve or Send, `secondary` otherwise. */
    button: V;
    buttonText: T;
    /** One of a question's choices. `data-selected` is `true` once picked. */
    choice: V;
    choiceText: T;
    /** A field for a note or an answer. */
    input: T;
    /** A row with a switch, such as Remember. */
    option: V;
    switch: V;
    optionText: T;
  };
  notice: {
    root: V;
    /** What failed. */
    title: T;
    /** Why, and what to do. */
    message: T;
    /** The reference support asks for. */
    reference: T;
    actions: V;
    retry: V;
    retryText: T;
  };
}

type StyleOf<Kind> = Kind extends T ? StyleProp<TextStyle> : StyleProp<ViewStyle>;

/** A class name for any part, by component. Make it once, outside your components, so every row
 * does not render again when your screen does. */
export type ChatClassNames = {
  [Group in keyof ChatParts]?: { [Part in keyof ChatParts[Group]]?: string };
};

/** A style for any part, for an app without NativeWind. The same keys as `ChatClassNames`. */
export type ChatStyles = {
  [Group in keyof ChatParts]?: {
    [Part in keyof ChatParts[Group]]?: StyleOf<ChatParts[Group][Part]>;
  };
};

/** Colours React Native takes as values, not classes. */
export interface ChatColors {
  /** Every activity indicator. */
  spinner?: string;
  /** The text box's placeholder. */
  placeholder?: string;
  /** The text box's caret and selection. */
  cursor?: string;
  /** A switch that is on. */
  switchOn?: string;
}

interface Skin {
  classNames?: ChatClassNames;
  styles?: ChatStyles;
  colors?: ChatColors;
}

const SkinContext = createContext<Skin>({});

export interface ChatClassesProps {
  /** The class names, by component and part. */
  value?: ChatClassNames;
  /** Styles by the same keys, for an app without NativeWind. */
  styles?: ChatStyles;
  colors?: ChatColors;
  children?: ReactNode;
}

/**
 * Sets the classes, styles and colours for every chat component inside it.
 *
 * ```tsx
 * <ChatClasses value={chatClasses}>
 * ```
 */
export function ChatClasses({ value, styles, colors, children }: ChatClassesProps) {
  const skin = useMemo(() => ({ classNames: value, styles, colors }), [value, styles, colors]);
  return <SkinContext value={skin}>{children}</SkinContext>;
}

export function useSkin(): Skin {
  return useContext(SkinContext);
}

/** What react-native-css reads for `data-[state=running]:` classes. Values are strings, because it
 * compares them with `==`. */
export type DataSet = Readonly<Record<string, string>>;

export interface PartProps<Kind> {
  className?: string;
  style?: StyleOf<Kind>;
  dataSet?: DataSet;
}

export interface Appearance {
  className?: string;
  style?: StyleProp<ViewStyle>;
}

/** An instance may replace its root class and add a style after the style from the map. */
export function root(base: PartProps<"view">, { className, style }: Appearance): PartProps<"view"> {
  return {
    ...base,
    className: className ?? base.className,
    style: style === undefined ? base.style : [base.style, style],
  };
}

/** The props for one part: spread them on its `View` or `Text`. */
export function part<Group extends keyof ChatParts, Part extends keyof ChatParts[Group]>(
  skin: Skin,
  group: Group,
  name: Part,
  dataSet?: DataSet,
): PartProps<ChatParts[Group][Part]> {
  const classes: { [P in keyof ChatParts[Group]]?: string } | undefined = skin.classNames?.[group];
  const styles: ChatStyles[Group] = skin.styles?.[group];
  const props: PartProps<ChatParts[Group][Part]> = {};
  const className = classes?.[name];
  if (className) props.className = className;
  const style = styles?.[name];
  if (style) props.style = style;
  if (dataSet) props.dataSet = dataSet;
  return props;
}
