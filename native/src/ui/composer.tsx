/**
 * The box at the foot of the conversation, ported from the three phones' composers. One button is
 * Send, or Stop while the agent works and the box is empty, or Queue once there are words, for a
 * host that reads messages during a run. A paste over the limit stays whole, and a line says how
 * far over it is. Send is off while the phone is offline or a file uploads, and says why.
 *
 * Files come from your picker and go to your uploader: pass the picker here, and the uploader to
 * `useComposer`, so the composer holds your picker's own file objects.
 */
import { useState, type ReactNode } from "react";
import { Text, TextInput, View, type TextInputProps } from "react-native";
import type {
  AttachmentFile,
  AttachmentItem,
  ChatStatus,
  CommandResult,
  ComposerValue,
} from "@providerkit/react";
import type { RunInfo } from "@providerkit/react/protocol";
import { Action } from "./action.tsx";
import { part, root, useSkin, type Appearance } from "./classes.tsx";
import { useLabels, type ChatLabelOverrides, type ChatLabels } from "./labels.ts";
import { composerButton, type ComposerNote } from "./rules.ts";

/** What the composer reads from `useChat`. */
export interface ComposerChat {
  status: ChatStatus;
  run: RunInfo;
  canSend: boolean;
  canStop: boolean;
  stop: () => Promise<CommandResult>;
}

/** Icons for the composer's buttons, already tinted. Each button still has its words for a screen
 * reader. */
export interface ComposerIcons {
  send?: ReactNode;
  queue?: ReactNode;
  stop?: ReactNode;
  attach?: ReactNode;
  /** On each file, to take it off the message. */
  remove?: ReactNode;
}

export interface ComposerProps<F extends AttachmentFile> extends Appearance {
  /** From `useComposer`, whose `send` is `chat.send` and whose `canSend` is `chat.canSend`. */
  composer: ComposerValue<F>;
  /** From `useChat`, for Stop and Queue. Without it the button only sends. */
  chat?: ComposerChat;
  /** The most characters a message may have. Longer text is kept whole, and Send waits until the
   * person shortens it. */
  maxLength?: number;
  /** Turns Send off while the phone has no connection, and says why. */
  offline?: boolean;
  /** Opens your app's file or photo picker and resolves with what the person chose. Without it
   * there is no attach button. */
  pick?: () => Promise<readonly F[] | null | undefined>;
  placeholder?: string;
  labels?: ChatLabelOverrides;
  icons?: ComposerIcons;
  /** More props for the `TextInput`, such as `autoFocus`. */
  inputProps?: Omit<
    TextInputProps,
    "value" | "defaultValue" | "onChangeText" | "multiline" | "maxLength"
  >;
}

function noteWords(note: ComposerNote, labels: ChatLabels["composer"]): string {
  switch (note.kind) {
    case "tooLong":
      return labels.tooLong(note.length, note.limit);
    case "offline":
      return labels.offline;
    case "uploading":
      return labels.uploading;
  }
}

export function Composer<F extends AttachmentFile>({
  composer,
  chat,
  maxLength,
  offline = false,
  pick,
  placeholder,
  labels: overrides,
  icons,
  inputProps,
  className,
  style,
}: ComposerProps<F>) {
  const skin = useSkin();
  const words = useLabels(overrides);
  const labels = words.composer;
  const [picking, setPicking] = useState(false);
  const [pickFailed, setPickFailed] = useState(false);
  const [stopIssue, setStopIssue] = useState<{ run?: string; message: string }>();
  const [unconfirmedRevision, setUnconfirmedRevision] = useState<number>();
  const unconfirmed =
    composer.error?.code === "unconfirmed" &&
    (unconfirmedRevision === undefined || composer.revision === unconfirmedRevision);
  if (composer.error?.code === "unconfirmed" && unconfirmedRevision === undefined)
    setUnconfirmedRevision(composer.revision);
  else if (composer.error?.code !== "unconfirmed" && unconfirmedRevision !== undefined)
    setUnconfirmedRevision(undefined);
  const uploading = composer.attachments.some(
    (item) => item.state === "queued" || item.state === "uploading",
  );
  const button = composerButton({
    text: composer.text,
    hasFiles: composer.attachments.length > 0,
    uploading,
    submitting: composer.submitting,
    canSubmit: composer.canSubmit,
    unconfirmed,
    status: chat?.status,
    canSend: chat?.canSend,
    canStop: chat?.canStop,
    offline,
    maxLength,
  });
  const working = button.action !== "send";

  async function attach(): Promise<void> {
    if (!pick || picking) return;
    setPicking(true);
    setPickFailed(false);
    try {
      const files = await pick();
      if (files?.length) composer.addFiles(files);
    } catch {
      setPickFailed(true);
    } finally {
      setPicking(false);
    }
  }

  async function press(): Promise<void> {
    if (!button.enabled) return;
    if (button.action !== "stop") {
      await composer.submit();
      return;
    }
    if (!chat) return;
    setStopIssue(undefined);
    const run = chat.run.id ?? chat.run.messageId;
    try {
      const result = await chat.stop();
      if (!result.ok) setStopIssue({ run, message: words.notice.error(result.error) });
    } catch {
      setStopIssue({ run, message: words.band.stopFailed });
    }
  }

  const { draft } = composer;
  return (
    <View
      {...root(part(skin, "composer", "root", { action: button.action }), { className, style })}
    >
      {composer.attachments.length > 0 ? (
        <View {...part(skin, "composer", "files")}>
          {composer.attachments.map((item) => (
            <FileRow
              key={item.id}
              item={item}
              labels={words}
              offline={offline}
              icon={icons?.remove}
              onRetry={() => composer.retryAttachment(item.id)}
              onRemove={() => composer.removeAttachment(item.id)}
            />
          ))}
        </View>
      ) : null}
      <View {...part(skin, "composer", "field")}>
        {/* Attaching is a step before sending, so it steps aside while a run works and the box
            belongs to the queue. */}
        {pick && !working ? (
          <Action
            box={part(skin, "composer", "attach")}
            text={part(skin, "composer", "attachText")}
            label={labels.attach}
            icon={icons?.attach}
            disabled={offline || composer.submitting}
            busy={picking}
            onPress={() => void attach()}
          />
        ) : null}
        <TextInput
          {...part(skin, "composer", "input", { state: composer.submitting ? "sending" : "ready" })}
          multiline
          textAlignVertical="top"
          value={composer.text}
          onChangeText={composer.setText}
          placeholder={placeholder ?? labels.placeholder}
          placeholderTextColor={skin.colors?.placeholder}
          selectionColor={skin.colors?.cursor}
          cursorColor={skin.colors?.cursor}
          accessibilityLabel={labels.message}
          {...inputProps}
        />
        <Action
          box={part(skin, "composer", "button", { action: button.action })}
          text={part(skin, "composer", "buttonText")}
          label={
            button.pending && button.action !== "stop" ? labels.sending : labels[button.action]
          }
          icon={icons?.[button.action]}
          disabled={!button.enabled && !button.pending}
          busy={button.pending}
          onPress={press}
        />
      </View>
      {button.note ? (
        <Text
          accessibilityRole={button.note.kind === "tooLong" ? "alert" : undefined}
          accessibilityLiveRegion="polite"
          {...part(skin, "composer", "note", { kind: button.note.kind })}
        >
          {noteWords(button.note, labels)}
        </Text>
      ) : null}
      {stopIssue && working && stopIssue.run === (chat?.run.id ?? chat?.run.messageId) ? (
        <Text accessibilityRole="alert" {...part(skin, "composer", "note", { kind: "stop" })}>
          {stopIssue.message}
        </Text>
      ) : null}
      {composer.error ? (
        <Text accessibilityRole="alert" {...part(skin, "composer", "note", { kind: "error" })}>
          {words.notice.error(composer.error)}
        </Text>
      ) : null}
      {pickFailed ? (
        <Text accessibilityRole="alert" {...part(skin, "composer", "note", { kind: "pick" })}>
          {labels.pickFailed}
        </Text>
      ) : null}
      {draft.status === "failed" ? (
        <>
          <Text accessibilityRole="alert" {...part(skin, "composer", "note", { kind: "draft" })}>
            {draft.problem === "load" ? labels.draftLoadFailed : labels.draftSaveFailed}
          </Text>
          <Action
            box={part(skin, "composer", "fileAction")}
            text={part(skin, "composer", "fileActionText")}
            label={labels.retryDraft}
            onPress={composer.retryDraft}
          />
        </>
      ) : null}
      {draft.missingFiles > 0 ? (
        <>
          <Text {...part(skin, "composer", "note", { kind: "missingFiles" })}>
            {labels.missingFiles(draft.missingFiles)}
          </Text>
          <Action
            box={part(skin, "composer", "fileAction")}
            text={part(skin, "composer", "fileActionText")}
            label={labels.dismissMissingFiles}
            onPress={composer.dismissMissingFiles}
          />
        </>
      ) : null}
    </View>
  );
}

/** One file on the message, with its own state, because a file the agent never got must not look
 * like one it read. */
function FileRow<F extends AttachmentFile>({
  item,
  labels: words,
  offline,
  icon,
  onRetry,
  onRemove,
}: {
  item: AttachmentItem<F>;
  labels: ChatLabels;
  offline: boolean;
  icon?: ReactNode;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const skin = useSkin();
  const labels = words.composer;
  let state: string | undefined;
  if (item.state === "queued") state = labels.fileQueued;
  else if (item.state === "uploading") state = labels.fileUploading(item.progress);
  else if (item.state === "failed") state = words.notice.error(item.error);
  return (
    <View {...part(skin, "composer", "file", { state: item.state })}>
      <Text numberOfLines={1} {...part(skin, "composer", "fileName")}>
        {item.name}
      </Text>
      {state ? <Text {...part(skin, "composer", "fileState")}>{state}</Text> : null}
      {item.state === "failed" && item.canRetry ? (
        <Action
          box={part(skin, "composer", "fileAction")}
          text={part(skin, "composer", "fileActionText")}
          label={labels.retryFile}
          disabled={offline}
          onPress={onRetry}
        />
      ) : null}
      <Action
        box={part(skin, "composer", "fileAction")}
        text={part(skin, "composer", "fileActionText")}
        label={labels.removeFile(item.name)}
        icon={icon}
        onPress={onRemove}
      />
    </View>
  );
}
