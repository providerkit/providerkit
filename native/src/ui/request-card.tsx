/** The host owns the decision. The card echoes the request id, and where supplied the reviewed
 * version; its own clock only closes the controls. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import {
  TransportError,
  type RequestResponse,
  type RequestView,
  type RespondResult,
} from "@providerkit/react";
import { checkResponse } from "@providerkit/react/protocol";
import { Action } from "./action.tsx";
import { part, root, useSkin, type Appearance } from "./classes.tsx";
import { useLabels, type ChatLabelOverrides, type ChatLabels } from "./labels.ts";
import { approvalAnswer, questionAnswer, requestCard, type RequestCardView } from "./rules.ts";

export interface RequestCardProps extends Appearance {
  /** One of `chat.requests`. A request in a message that ended can come as `{ part, messageId }`:
   * it then shows how it ended, with nothing to press. */
  request: RequestView;
  /** `chat.respond`. Without it the card shows the request and cannot answer it. */
  respond?: (requestId: string, response: RequestResponse) => Promise<RespondResult>;
  /** For a host that versions the material being reviewed. Echo this exact version with the id,
   * never a later version read just before sending. The server must verify both. */
  review?: {
    version: string | number;
    respond: (
      requestId: string,
      response: RequestResponse,
      version: string | number,
    ) => Promise<RespondResult>;
  };
  scopeKey?: string;
  labels?: ChatLabelOverrides;
}

/** A different person, request or reviewed version gets a fresh draft and fresh buttons. */
export function RequestCard(props: RequestCardProps) {
  return (
    <RequestContent
      key={JSON.stringify([
        props.scopeKey,
        props.request.messageId,
        props.request.part.id,
        props.review?.version,
      ])}
      {...props}
    />
  );
}

function RequestContent({
  request,
  respond,
  review,
  labels: overrides,
  className,
  style,
}: RequestCardProps) {
  const skin = useSkin();
  const words = useLabels(overrides);
  const labels = words.request;
  const { part: ask } = request;
  const [now, setNow] = useState(Date.now);
  const [feedback, setFeedback] = useState<RequestView["local"]>();
  const shown = { ...request, local: request.local ?? feedback };
  const view = requestCard(shown, now, Boolean(review || respond));
  const lock = useRef(false);
  const current = useRef<RequestView | null>(null);
  useLayoutEffect(() => {
    current.current = request;
    return () => {
      current.current = null;
    };
  }, [request]);

  const { expiresAt } = ask;
  useEffect(() => {
    if (expiresAt === undefined || ask.state !== "pending" || now >= expiresAt) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, ask.state, now]);

  async function send(response: RequestResponse): Promise<void> {
    if (
      current.current !== request ||
      lock.current ||
      !view.allowed ||
      (view.state !== "pending" && view.state !== "failed")
    )
      return;
    if (!view.supported && response.type !== "cancel") return;
    const invalid = checkResponse(ask, response); // Recheck expiry at the press, even if a timer slept.
    if (invalid) {
      setFeedback({ status: "failed", response, error: invalid });
      setNow(Date.now());
      return;
    }
    lock.current = true;
    setFeedback({ status: "submitting", response });
    try {
      const result = review
        ? await review.respond(ask.id, response, review.version)
        : await respond?.(ask.id, response);
      if (result && !result.ok) setFeedback({ status: "failed", response, error: result.error });
      else if (result?.outcome === "unknown") setFeedback({ status: "unconfirmed", response });
      // A receipt alone never reopens the buttons. The host confirms the result on the request.
    } catch (error) {
      if (error instanceof TransportError && error.outcome === "refused")
        setFeedback({ status: "failed", response, error: error.error });
      else setFeedback({ status: "unconfirmed", response });
    } finally {
      lock.current = false;
    }
  }

  let status = labels.state[view.state];
  if (view.state === "pending") {
    if (!view.allowed) status = labels.readOnly;
    else if (!view.supported)
      status = ask.type === "client-tool" ? labels.actionUnavailable : labels.unsupported;
    else if (ask.type !== "approval") status = labels.answerNeeded;
  }
  const error = view.error;
  const open =
    view.allowed && view.supported && ask.state === "pending" && view.state !== "expired";
  return (
    <View
      {...root(part(skin, "request", "root", { state: view.state, kind: ask.type }), {
        className,
        style,
      })}
    >
      <Text selectable {...part(skin, "request", "title")}>
        {ask.title}
      </Text>
      {ask.summary ? (
        <Text selectable {...part(skin, "request", "summary")}>
          {ask.summary}
        </Text>
      ) : null}
      <Text accessibilityLiveRegion="polite" {...part(skin, "request", "status")}>
        {status}
      </Text>
      {error && ask.state === "pending" ? (
        <Text {...part(skin, "request", "error")}>{words.notice.error(error)}</Text>
      ) : null}
      {open && ask.type === "approval" && typeof ask.approveForm?.title === "string" ? (
        <Text {...part(skin, "request", "summary")}>{ask.approveForm.title}</Text>
      ) : null}
      {open && ask.type === "approval" && typeof ask.approveForm?.description === "string" ? (
        <Text {...part(skin, "request", "summary")}>{ask.approveForm.description}</Text>
      ) : null}
      {open && ask.type === "approval" ? (
        <Approval view={view} labels={labels} send={send} />
      ) : null}
      {open && ask.type === "question" ? (
        <Question request={request} view={view} labels={labels} send={send} />
      ) : null}
      {view.allowed && !view.supported && (view.state === "pending" || view.state === "failed") ? (
        <Action
          box={part(skin, "request", "button", { kind: "secondary" })}
          text={part(skin, "request", "buttonText")}
          label={labels.skip}
          onPress={() => void send({ type: "cancel" })}
        />
      ) : null}
    </View>
  );
}

interface BodyProps {
  view: RequestCardView;
  labels: ChatLabels["request"];
  send: (response: RequestResponse) => Promise<void>;
}

/** Approve, or Deny with a note. The note is what the model reads instead, so it can try another
 * way. */
function Approval({ view, labels, send }: BodyProps) {
  const skin = useSkin();
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const [values, setValues] = useState<Record<string, boolean>>({});
  const busy = view.state === "submitting";
  const disabled = !view.enabled;
  const button = (kind: "primary" | "secondary") => part(skin, "request", "button", { kind });
  const words = part(skin, "request", "buttonText");
  if (denying)
    return (
      <View {...part(skin, "request", "actions")}>
        <TextInput
          {...part(skin, "request", "input")}
          multiline
          value={note}
          onChangeText={setNote}
          editable={!busy}
          accessibilityLabel={labels.denyNote}
          accessibilityHint={labels.denyHint}
          placeholder={labels.denyHint}
          placeholderTextColor={skin.colors?.placeholder}
          selectionColor={skin.colors?.cursor}
        />
        <Action
          box={button("primary")}
          text={words}
          label={labels.denySend}
          disabled={disabled}
          busy={busy}
          onPress={() => void send(approvalAnswer(false, note, view.options, values))}
        />
        <Action
          box={button("secondary")}
          text={words}
          label={labels.back}
          disabled={busy}
          onPress={() => setDenying(false)}
        />
      </View>
    );
  return (
    <View {...part(skin, "request", "actions")}>
      {view.options.map((option) => (
        <View key={option.name} {...part(skin, "request", "option")}>
          <Switch
            {...part(skin, "request", "switch", { state: values[option.name] ? "on" : "off" })}
            value={values[option.name] === true}
            onValueChange={(on) => setValues((held) => ({ ...held, [option.name]: on }))}
            disabled={disabled || busy}
            trackColor={skin.colors?.switchOn ? { true: skin.colors.switchOn } : undefined}
            accessibilityLabel={option.label}
          />
          <Text {...part(skin, "request", "optionText")}>{option.label}</Text>
        </View>
      ))}
      <Action
        box={button("primary")}
        text={words}
        label={labels.approve}
        disabled={disabled}
        busy={busy}
        onPress={() => void send(approvalAnswer(true, "", view.options, values))}
      />
      <Action
        box={button("secondary")}
        text={words}
        label={labels.deny}
        disabled={disabled || busy}
        onPress={() => setDenying(true)}
      />
    </View>
  );
}

/** A question's choices and its own words. One choice from a list answers at once, as the phones
 * that ask today do; several are picked, then sent. */
function Question({ request, view, labels, send }: BodyProps & { request: RequestView }) {
  const skin = useSkin();
  const ask = request.part.type === "question" ? request.part : undefined;
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [text, setText] = useState("");
  if (!ask) return null;
  const busy = view.state === "submitting";
  const disabled = !view.enabled;
  const choices = ask.choices ?? [];
  const allowsText = ask.freeText ?? choices.length === 0;
  const button = (kind: "primary" | "secondary") => part(skin, "request", "button", { kind });
  const words = part(skin, "request", "buttonText");
  const toggle = (id: string) =>
    setPicked((held) => (held.includes(id) ? held.filter((item) => item !== id) : [...held, id]));
  const ready = (ask.multiple ? picked.length > 0 : false) || text.trim().length > 0;
  return (
    <View {...part(skin, "request", "actions")}>
      {choices.map((choice) => {
        const selected = picked.includes(choice.id);
        return (
          <Action
            key={choice.id}
            box={part(skin, "request", "choice", { selected: String(selected) })}
            text={part(skin, "request", "choiceText")}
            label={choice.description ? `${choice.label}. ${choice.description}` : choice.label}
            role={ask.multiple ? "checkbox" : "button"}
            checked={ask.multiple ? selected : undefined}
            disabled={disabled || busy}
            onPress={() =>
              ask.multiple ? toggle(choice.id) : void send(questionAnswer([choice.id], ""))
            }
          />
        );
      })}
      {allowsText ? (
        <TextInput
          {...part(skin, "request", "input")}
          multiline
          value={text}
          onChangeText={setText}
          editable={!busy}
          accessibilityLabel={labels.answer}
          placeholder={labels.answer}
          placeholderTextColor={skin.colors?.placeholder}
          selectionColor={skin.colors?.cursor}
        />
      ) : null}
      {ask.multiple || allowsText ? (
        <Action
          box={button("primary")}
          text={words}
          label={labels.sendAnswer}
          disabled={disabled || !ready}
          busy={busy}
          onPress={() => void send(questionAnswer(ask.multiple ? picked : [], text))}
        />
      ) : null}
      <Action
        box={button("secondary")}
        text={words}
        label={labels.skip}
        disabled={disabled || busy}
        onPress={() => void send({ type: "cancel" })}
      />
    </View>
  );
}
