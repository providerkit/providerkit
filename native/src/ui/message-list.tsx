/**
 * The conversation as a `FlatList`, ported from the three phones. Rows are memoized by message,
 * and the client keeps every message that did not change as the same object, so while an answer
 * streams only its own row draws again. The list follows the
 * answer while the reader is near the end, and keeps their place once they scroll up, with a
 * button back down.
 *
 * `renderPart` sees every part first, as on the web: return `undefined` for the default row, `null`
 * to hide the part, or your own card. One function over every part keeps one place that decides how
 * a part draws.
 */
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  Text,
  View,
  type FlatListProps,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type {
  ChatClient,
  ChatStatus,
  ConnectionStatus,
  DisplayError,
  MessageInput,
  RequestView,
} from "@providerkit/react";
import type {
  AgentPart,
  DisplayMessage,
  DisplayPart,
  RunInfo,
  SourcePart,
  TextPart,
} from "@providerkit/react/protocol";
import { allowedLink } from "../markdown.ts";
import { Action } from "./action.tsx";
import { part, root, useSkin, type Appearance } from "./classes.tsx";
import { ErrorNotice } from "./error-notice.tsx";
import { useLabels, type ChatLabelOverrides } from "./labels.ts";
import {
  awaitsReply,
  layoutMessage,
  listRows,
  nearEnd,
  type MessageRow,
  type ToolTable,
} from "./layout.ts";
import { Markdown, useOpenLink, type MarkdownSettings } from "./markdown.tsx";
import { RequestCard } from "./request-card.tsx";
import type { DescribedError } from "./rules.ts";
import { LiveStatus, ThinkingRow, ToolGroup, ToolRow, type ActivityIcons } from "./tools.tsx";

/** What the list reads from `useChat` or `useAgentRun`. */
export interface MessageListChat {
  /** Change with the person or conversation, even if message ids repeat. */
  scopeKey?: string;
  messages: readonly DisplayMessage[];
  run: RunInfo;
  status: ChatStatus;
  connection: ConnectionStatus;
  requests: readonly RequestView[];
  error?: DisplayError;
  respond?: ChatClient["respond"];
  reconnect?: () => void;
  canReconnect?: boolean;
  /** Only `useChat` has it: a conversation the person writes in. */
  canSend?: boolean;
  canRetry?: boolean;
  messageErrors?: Readonly<Record<string, DisplayError>>;
  retry?: ChatClient["retry"];
  discard?: ChatClient["discard"];
}

/** What `renderPart` and `renderText` know besides the part. */
export interface PartContext {
  message: DisplayMessage;
}

export interface MessageListIcons extends ActivityIcons {
  /** On the button back to the newest message. */
  jump?: ReactNode;
}

export interface MessageListProps extends Appearance {
  chat: MessageListChat;
  /** Draws a part your way: return `undefined` for the default row, or `null` to hide it. */
  renderPart?: (part: DisplayPart, context: PartContext) => ReactNode | undefined;
  /** Draws the assistant's text, to keep another Markdown renderer. */
  renderText?: (part: TextPart, context: PartContext) => ReactNode;
  /** Your words and icons for each tool. */
  tools?: ToolTable;
  /** How many quiet calls in a row fold into one line. Default 1, so every run of quiet calls
   * folds. */
  foldAt?: number;
  /** How close to the end, in points, still counts as reading the newest message, so the list
   * follows the answer. Default 48. */
  followDistance?: number;
  /** How the assistant's Markdown opens links, citations and images. */
  markdown?: MarkdownSettings;
  /** Your app's error describer, for the words under a failed message. */
  describeError?: (error: DisplayError) => DescribedError;
  /** Called when a retried message is refused by the host and taken back out of the list. Restore
   * the returned input to your composer here if you own the draft separately. */
  onRetryRefused?: (error: DisplayError, input?: MessageInput) => void;
  /** Turns Retry off while the phone has no connection. */
  offline?: boolean;
  labels?: ChatLabelOverrides;
  icons?: MessageListIcons;
  /** Above the first message. */
  header?: ReactNode;
  /** Below the last message, such as the `RunBand`. */
  footer?: ReactNode;
  /** Shown instead of the words for a conversation with no messages yet. */
  empty?: ReactNode;
  /** Shown instead of the words while the first messages load. */
  loading?: ReactNode;
  /** More props for the `FlatList`, such as `refreshControl` or `keyboardDismissMode`. */
  listProps?: Omit<
    FlatListProps<DisplayMessage>,
    | "data"
    | "renderItem"
    | "keyExtractor"
    | "onScroll"
    | "onContentSizeChange"
    | "onLayout"
    | "ListHeaderComponent"
    | "ListFooterComponent"
    | "ListEmptyComponent"
  >;
}

/** What every row reads. Each field is a prop the app passes, so keep them the same between
 * renders, as `useCallback` and `useMemo` do: a new one draws every message again. */
interface Shared {
  renderPart: MessageListProps["renderPart"];
  renderText: MessageListProps["renderText"];
  tools: ToolTable | undefined;
  foldAt: number | undefined;
  markdown: MarkdownSettings | undefined;
  describeError: MessageListProps["describeError"];
  offline: boolean;
  labels: ChatLabelOverrides | undefined;
  icons: MessageListIcons | undefined;
  respond: MessageListChat["respond"];
  retry: ((messageId: string) => Promise<void>) | undefined;
  discard: MessageListChat["discard"];
}

const SharedContext = createContext<Shared | undefined>(undefined);

function useShared(): Shared {
  const shared = useContext(SharedContext);
  if (!shared) throw new Error("A message row draws only inside MessageList.");
  return shared;
}

const LiveMessages = createContext<readonly DisplayMessage[]>([]);

/** React Native's reduced motion setting, read once and then followed. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let current = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (current) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      current = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** Only live cells subscribe to the text. Settled rows and FlatList see the same props on a
 * delta. The scope key also drops the previous conversation's scroll position and open controls. */
export function MessageList({ chat, ...props }: MessageListProps) {
  return <ScopedList key={chat.scopeKey} chat={chat} {...props} />;
}

function ScopedList({ chat, ...props }: MessageListProps) {
  const { messages, ...state } = chat;
  const [previous, setPrevious] = useState(messages);
  const rows = listRows(previous, messages);
  if (rows !== previous) setPrevious(rows);
  return (
    <LiveMessages value={messages}>
      <Transcript {...state} {...props} messages={rows} />
    </LiveMessages>
  );
}

const Transcript = memo(function Transcript({
  renderPart,
  renderText,
  tools,
  foldAt,
  followDistance = 48,
  markdown,
  describeError,
  onRetryRefused,
  offline = false,
  labels: overrides,
  icons,
  header,
  footer,
  empty,
  loading,
  listProps,
  className,
  style,
  ...chat
}: Omit<MessageListProps, "chat"> & MessageListChat) {
  const skin = useSkin();
  const labels = useLabels(overrides).list;
  const { messages, requests, messageErrors, respond, retry, discard } = chat;
  const [retryRefusal, setRetryRefusal] = useState<DisplayError>();
  const handleRetry = useCallback(
    async (messageId: string) => {
      if (!retry) return;
      setRetryRefusal(undefined);
      const result = await retry(messageId);
      if (!result.ok) {
        // When the host refuses a retry, the client removes the unconfirmed message and returns its
        // error and input. Surface the refusal here and hand the input back to the app if asked.
        setRetryRefusal(result.error);
        onRetryRefused?.(result.error, result.input);
      }
    },
    [retry, onRetryRefused],
  );
  // A Retry can start the work twice. Queueing is not permission to retry an active run.
  const canRetry = chat.canRetry === true && chat.status === "ready";
  const shared = useMemo<Shared>(
    () => ({
      renderPart,
      renderText,
      tools,
      foldAt,
      markdown,
      describeError,
      offline,
      labels: overrides,
      icons,
      respond,
      retry: retry ? handleRetry : undefined,
      discard,
    }),
    [
      renderPart,
      renderText,
      tools,
      foldAt,
      markdown,
      describeError,
      offline,
      overrides,
      icons,
      respond,
      retry,
      handleRetry,
      discard,
    ],
  );
  const working = chat.run.status === "running" || chat.status === "running";
  const awaiting = awaitsReply(messages, chat.status);

  // Follow the answer while the reader is at the end; leave them where they are once they scroll
  // up, and bring them back on a press.
  const list = useRef<FlatList<DisplayMessage>>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const reduceMotion = useReducedMotion();
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const atEnd = nearEnd(
        contentOffset.y,
        layoutMeasurement.height,
        contentSize.height,
        followDistance,
      );
      pinned.current = atEnd;
      setAway(!atEnd);
    },
    [followDistance],
  );
  const follow = useCallback(() => {
    if (pinned.current) list.current?.scrollToEnd({ animated: false });
  }, []);
  const jump = useCallback(() => {
    pinned.current = true;
    setAway(false);
    list.current?.scrollToEnd({ animated: !reduceMotion });
  }, [reduceMotion]);
  // A message the person just sent: they expect to see it, wherever they had scrolled.
  const last = messages.at(-1);
  const sent = last?.role === "user" && last.state === "sending" ? last.id : undefined;
  useEffect(() => {
    if (!sent) return;
    pinned.current = true;
    list.current?.scrollToEnd({ animated: !reduceMotion });
  }, [sent, reduceMotion]);

  // An answer that finished while the reader was further up: the button says so.
  const live = messages.some((message) => message.state === "live");
  const [missed, setMissed] = useState(false);
  if (away && live && !missed) setMissed(true);
  if (!away && missed) setMissed(false);

  const renderItem = useCallback<ListRenderItem<DisplayMessage>>(
    ({ item, index }) => {
      const props = {
        error: messageErrors?.[item.id],
        canRetry: canRetry === true,
        requests,
        working,
      };
      return item.state === "live" ? (
        <LiveCell index={index} {...props} />
      ) : (
        <MessageView message={item} {...props} />
      );
    },
    [messageErrors, canRetry, working, requests],
  );

  // Clear a previous retry refusal once the user starts a new send or run.
  if (retryRefusal && chat.status !== "ready") setRetryRefusal(undefined);

  const error =
    chat.error ??
    (chat.connection === "lost" ? { code: "connection_lost", message: labels.lost } : undefined);
  const noticeError = error ?? retryRefusal;
  const connecting = chat.connection === "connecting" || chat.connection === "reconnecting";
  let listState = "ready";
  if (error) listState = "error";
  else if (!messages.length) listState = connecting ? "loading" : "empty";
  let emptyNode: ReactNode;
  if (error || awaiting) emptyNode = null;
  else if (connecting)
    emptyNode = loading ?? (
      <View {...part(skin, "list", "empty", { state: "loading" })}>
        <Text {...part(skin, "list", "emptyText")}>{labels.loading}</Text>
      </View>
    );
  else
    emptyNode = empty ?? (
      <View {...part(skin, "list", "empty", { state: "empty" })}>
        <Text {...part(skin, "list", "emptyText")}>
          {chat.canSend === undefined ? labels.emptyReadOnly : labels.empty}
        </Text>
      </View>
    );

  const scroll = part(skin, "list", "scroll");
  const content = part(skin, "list", "content");
  // `contentContainerClassName` is read by react-native-css, and is not in React Native's types.
  const looks = {
    ...scroll,
    ...(content.className && { contentContainerClassName: content.className }),
    ...(content.style && { contentContainerStyle: content.style }),
  };
  return (
    <View
      {...root(part(skin, "list", "root", { state: listState }), {
        className,
        style,
      })}
    >
      <SharedContext value={shared}>
        <FlatList
          keyboardShouldPersistTaps="handled"
          {...listProps}
          {...looks}
          ref={list}
          data={messages}
          keyExtractor={keyOf}
          renderItem={renderItem}
          onScroll={onScroll}
          scrollEventThrottle={100}
          onContentSizeChange={follow}
          onLayout={follow}
          ListHeaderComponent={header ? <>{header}</> : null}
          ListEmptyComponent={<>{emptyNode}</>}
          ListFooterComponent={
            <>
              {awaiting && !error ? <Awaiting /> : null}
              {noticeError ? (
                <ErrorNotice
                  title={!messages.length && error ? labels.loadFailed : undefined}
                  error={noticeError}
                  describe={describeError}
                  offline={offline}
                  onRetry={error && chat.canReconnect ? chat.reconnect : undefined}
                  retryLabel={labels.reconnect}
                  labels={overrides}
                />
              ) : null}
              {footer}
            </>
          }
        />
      </SharedContext>
      {away && messages.length > 0 ? (
        <Action
          box={part(skin, "list", "jump", { kind: missed && !live ? "ready" : "latest" })}
          text={part(skin, "list", "jumpText")}
          label={missed && !live ? labels.answerReady : labels.jumpToLatest}
          icon={icons?.jump}
          onPress={jump}
        />
      ) : null}
    </View>
  );
});

function LiveCell({ index, ...props }: Omit<MessageViewProps, "message"> & { index: number }) {
  const message = useContext(LiveMessages)[index];
  return message ? <MessageView {...props} message={message} /> : null;
}

function keyOf(message: DisplayMessage): string {
  return message.id;
}

function Awaiting() {
  const skin = useSkin();
  const { labels } = useShared();
  const words = useLabels(labels).activity;
  return (
    <View {...part(skin, "message", "assistant", { role: "assistant", state: "live" })}>
      <LiveStatus label={words.thinking} />
    </View>
  );
}

interface MessageViewProps {
  message: DisplayMessage;
  /** Why a message this phone sent shows as not delivered. */
  error: DisplayError | undefined;
  canRetry: boolean;
  /** The run works, so a live answer may end in its status line. */
  working: boolean;
  requests: readonly RequestView[];
}

/** One message. It draws again only when one of these props changes, and the client keeps a
 * message that did not change as the same object. */
const MessageView = memo(function MessageView({
  message,
  error,
  canRetry,
  working,
  requests,
}: MessageViewProps) {
  const skin = useSkin();
  const shared = useShared();
  const labels = useLabels(shared.labels).list;
  const { renderPart, retry, discard } = shared;
  const context: PartContext = { message };
  const rows = layoutMessage(message, {
    tools: shared.tools,
    foldAt: shared.foldAt,
    working,
    renderPart: renderPart && ((entry) => renderPart(entry, context)),
  });
  return (
    <View {...part(skin, "message", message.role, { role: message.role, state: message.state })}>
      {rows.map((row) => (
        <RowView key={row.key} row={row} message={message} requests={requests} />
      ))}
      {message.role === "user" && message.state === "sending" ? (
        <Text {...part(skin, "message", "state")}>{labels.sending}</Text>
      ) : null}
      {error ? (
        <ErrorNotice
          title={labels.unconfirmed}
          error={error}
          describe={shared.describeError}
          offline={shared.offline}
          onRetry={canRetry && retry ? () => retry(message.id) : undefined}
          labels={shared.labels}
        >
          {discard ? (
            <Action
              box={part(skin, "notice", "retry")}
              text={part(skin, "notice", "retryText")}
              label={labels.remove}
              onPress={() => discard(message.id)}
            />
          ) : null}
        </ErrorNotice>
      ) : null}
    </View>
  );
});

function RowView({
  row,
  message,
  requests,
}: {
  row: MessageRow;
  message: DisplayMessage;
  requests: readonly RequestView[];
}) {
  const { icons, labels, tools } = useShared();
  const words = useLabels(labels).activity;
  switch (row.kind) {
    case "tool":
      return (
        <ToolRow tool={row.tool} tools={tools} live={row.live} icons={icons} labels={labels} />
      );
    case "group":
      return <ToolGroup items={row.items} tools={tools} icons={icons} labels={labels} />;
    case "status":
      return <LiveStatus label={row.label ?? words.thinking} />;
    case "part":
      return row.node !== undefined ? (
        <>{row.node}</>
      ) : (
        <DefaultPart entry={row.part} message={message} requests={requests} />
      );
  }
}

/** The row a part gets when `renderPart` leaves it to the list. */
function DefaultPart({
  entry,
  message,
  requests,
}: {
  entry: DisplayPart;
  message: DisplayMessage;
  requests: readonly RequestView[];
}) {
  const skin = useSkin();
  const shared = useShared();
  switch (entry.type) {
    case "tool":
      // A default tool is already a tool or group row. Custom tool rows draw their node above.
      return null;
    case "text":
      return (
        <MessageText
          part={entry}
          message={message}
          renderText={shared.renderText}
          markdown={shared.markdown}
          labels={shared.labels}
        />
      );
    case "thinking":
      return <ThinkingRow thinking={entry} labels={shared.labels} />;
    case "attachment":
      return (
        <View {...part(skin, "message", "attachment")}>
          <Text numberOfLines={1} {...part(skin, "message", "attachmentText")}>
            {entry.name}
          </Text>
        </View>
      );
    case "source":
      return <Source source={entry} />;
    case "agent":
      return <Specialist agent={entry} />;
    case "approval":
    case "question":
    case "client-tool": {
      // A request in a message that ended is no longer waiting: it shows how it ended.
      const request = requests.find(
        (held) => held.part.id === entry.id && held.messageId === message.id,
      ) ?? { part: entry, messageId: message.id, canRespond: false };
      return <RequestCard request={request} respond={shared.respond} labels={shared.labels} />;
    }
    case "data":
      // A card of the app's own. Without a `renderPart` for it, it draws nothing.
      return null;
  }
}

export interface MessageTextProps extends Appearance {
  part: TextPart;
  message: DisplayMessage;
  markdown?: MarkdownSettings;
  renderText?: MessageListProps["renderText"];
  labels?: ChatLabelOverrides;
}

/** The person's words as typed, or the assistant's Markdown. */
export function MessageText({
  part: text,
  message,
  renderText,
  markdown,
  labels: overrides,
  className,
  style,
}: MessageTextProps) {
  const skin = useSkin();
  const labels = useLabels(overrides).list;
  let body: ReactNode;
  if (message.role === "user")
    body = (
      <Text selectable {...root(part(skin, "message", "userText"), { className, style })}>
        {text.text}
      </Text>
    );
  else
    body = renderText ? (
      renderText(text, { message })
    ) : (
      <Markdown
        className={className}
        style={style}
        text={text.text}
        sources={message.parts}
        labels={overrides}
        {...markdown}
      />
    );
  return (
    <>
      {body}
      {text.incomplete ? (
        <Text {...part(skin, "message", "incomplete")}>{labels.incomplete}</Text>
      ) : null}
    </>
  );
}

/** A source the answer used. It opens through the app: `onCitation`, or `onLink` for an address
 * whose scheme the app allows. */
function Source({ source }: { source: SourcePart }) {
  const skin = useSkin();
  const { markdown, labels: overrides } = useShared();
  const labels = useLabels(overrides).markdown;
  const { open, failed } = useOpenLink(markdown?.onLink);
  const address = source.url && allowedLink(source.url, markdown);
  const onCitation = markdown?.onCitation;
  const press = onCitation
    ? () => onCitation(source)
    : open && address
      ? () => open(address)
      : undefined;
  return (
    <View {...part(skin, "message", "source")}>
      <Text
        accessibilityRole={press ? "link" : undefined}
        onPress={press}
        {...part(skin, "message", "sourceText")}
      >
        {source.marker ? `${source.marker} ${source.title}` : source.title}
      </Text>
      {failed ? (
        <Text selectable {...part(skin, "markdown", "linkFailed")}>
          {labels.linkFailed(failed)}
        </Text>
      ) : null}
    </View>
  );
}

/** A specialist the run handed work to, as one line with its state. */
function Specialist({ agent }: { agent: AgentPart }) {
  const skin = useSkin();
  return (
    <View
      {...part(skin, "tool", "row", { state: agent.state, kind: "agent" })}
      accessible
      accessibilityLabel={[agent.label, agent.summary].filter(Boolean).join(", ")}
    >
      {agent.state === "running" ? (
        <ActivityIndicator
          {...part(skin, "tool", "spinner")}
          size="small"
          color={skin.colors?.spinner}
        />
      ) : null}
      <Text {...part(skin, "tool", "label")}>{agent.label}</Text>
      {agent.summary ? (
        <Text numberOfLines={1} {...part(skin, "tool", "hint")}>
          {agent.summary}
        </Text>
      ) : null}
    </View>
  );
}
