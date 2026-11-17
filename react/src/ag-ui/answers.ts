import {
  checkResponse,
  parseRequestAnswers,
  type RequestAnswer,
  type RequestPart,
  type RequestResponse,
} from "../protocol.ts";
import { isRecord } from "../state.ts";
import { ANSWER_PAYLOAD, checkOptions, copyJson, jsonSafe, sameBinding } from "./common.ts";
import type { AgUiBinding, AgUiResumeEntry } from "./types.ts";

export interface AgUiAnswerContext {
  /** Resolve this from the host's saved request, not from the submitted payload. */
  request: RequestPart;
  binding: AgUiBinding;
}

/** Encodes native approval evidence for AG-UI peers such as PydanticAI.
 * Other answers, form data and stop need toProviderkitResumeEntry; they are never dropped.
 * Native entries carry no binding metadata. The host must resolve the saved request. */
export function toResumeEntry(
  response: RequestResponse,
  context: AgUiAnswerContext,
): AgUiResumeEntry | null {
  checkOptions(context);
  if (!jsonSafe(response, undefined, true) || checkResponse(context.request, response)) return null;
  const interruptId = context.request.id;
  switch (response.type) {
    case "approve":
      if (response.data !== undefined) return null;
      return {
        interruptId,
        status: "resolved",
        payload: {
          approved: true,
          ...(response.arguments !== undefined && { editedArgs: copyJson(response.arguments) }),
        },
      };
    case "deny":
      if (response.data !== undefined) return null;
      return {
        interruptId,
        status: "resolved",
        payload: {
          approved: false,
          ...(response.message !== undefined && { reason: response.message }),
        },
      };
    case "cancel":
      return { interruptId, status: "cancelled" };
    default:
      return null;
  }
}

/** Encodes richer answers for a peer that understands providerkit.answer.v1.
 * This is evidence only. It cannot claim a client action, approve a tool or start a run. */
export function toProviderkitResumeEntry(
  response: RequestResponse,
  context: AgUiAnswerContext,
): AgUiResumeEntry | null {
  checkOptions(context);
  if (!jsonSafe(response, undefined, true) || checkResponse(context.request, response)) return null;
  return {
    interruptId: context.request.id,
    status: response.type === "cancel" || response.type === "stop" ? "cancelled" : "resolved",
    payload: {
      [ANSWER_PAYLOAD]: { v: 1, binding: { ...context.binding }, response: copyJson(response) },
    },
  };
}

/** Shape and request-fit checks only. The host must authenticate, check its saved request and
 * validate schemas before passing evidence to the SDK. No default approval or execution. */
export function readResumeEntry(value: unknown, context: AgUiAnswerContext): RequestAnswer | null {
  checkOptions(context);
  if (
    !jsonSafe(value) ||
    !isRecord(value) ||
    Object.keys(value).some((key) => !["interruptId", "status", "payload"].includes(key)) ||
    value.interruptId !== context.request.id ||
    (value.status !== "resolved" && value.status !== "cancelled")
  )
    return null;
  let response: unknown;
  if (isRecord(value.payload) && Object.hasOwn(value.payload, ANSWER_PAYLOAD)) {
    const envelope = value.payload[ANSWER_PAYLOAD];
    if (
      Object.keys(value.payload).length !== 1 ||
      !isRecord(envelope) ||
      envelope.v !== 1 ||
      !sameBinding(envelope.binding, context.binding) ||
      Object.keys(envelope).some((key) => !["v", "binding", "response"].includes(key))
    )
      return null;
    response = envelope.response;
    if (
      !isRecord(response) ||
      (response.type === "cancel" || response.type === "stop") !== (value.status === "cancelled")
    )
      return null;
  } else if (value.status === "cancelled" && value.payload === undefined)
    response = { type: "cancel" };
  else if (
    context.request.type === "approval" &&
    value.status === "resolved" &&
    isRecord(value.payload) &&
    typeof value.payload.approved === "boolean" &&
    Object.keys(value.payload).every((key) => ["approved", "reason", "editedArgs"].includes(key)) &&
    (value.payload.reason === undefined ||
      (value.payload.approved === false &&
        typeof value.payload.reason === "string" &&
        value.payload.reason.length > 0)) &&
    (value.payload.editedArgs === undefined ||
      (value.payload.approved === true && isRecord(value.payload.editedArgs)))
  ) {
    // Native approval convention used by PydanticAI. Real booleans only; malformed is not deny.
    response = value.payload.approved
      ? {
          type: "approve",
          ...(value.payload.editedArgs !== undefined && { arguments: value.payload.editedArgs }),
        }
      : {
          type: "deny",
          ...(value.payload.reason !== undefined && { message: value.payload.reason }),
        };
  } else return null;
  if (!jsonSafe(response, undefined, true)) return null;
  const answer = parseRequestAnswers([{ requestId: context.request.id, response }])?.[0];
  return answer && !checkResponse(context.request, answer.response)
    ? (parseRequestAnswers(copyJson([answer]))?.[0] ?? null)
    : null;
}
