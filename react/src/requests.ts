import type { DisplayError, RequestPart } from "./protocol.ts";
import { isRecord } from "./state.ts";

export interface QuestionAnswer {
  choices?: readonly string[];
  text?: string;
  data?: unknown;
}

/** Evidence only. The server authenticates, validates and resolves it against its saved request. */
export type RequestResponse =
  | { type: "approve"; arguments?: Record<string, unknown>; data?: unknown }
  | { type: "deny"; message?: string; data?: unknown }
  | { type: "answer"; answer: QuestionAnswer }
  | { type: "result"; value: unknown }
  | { type: "cancel" }
  | { type: "stop" };

export interface RequestAnswer {
  requestId: string;
  response: RequestResponse;
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isResponse(value: unknown): value is RequestResponse {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "approve":
      return (
        keys(value, ["type", "arguments", "data"]) &&
        (value.arguments === undefined || isRecord(value.arguments))
      );
    case "deny":
      return (
        keys(value, ["type", "message", "data"]) &&
        (value.message === undefined ||
          (typeof value.message === "string" && value.message.length > 0))
      );
    case "answer": {
      const answer = value.answer;
      return (
        keys(value, ["type", "answer"]) &&
        isRecord(answer) &&
        keys(answer, ["choices", "text", "data"]) &&
        (answer.text === undefined || typeof answer.text === "string") &&
        (answer.choices === undefined ||
          (Array.isArray(answer.choices) &&
            answer.choices.every((item) => typeof item === "string")))
      );
    }
    case "result":
      return keys(value, ["type", "value"]) && value.value !== undefined;
    case "cancel":
    case "stop":
      return keys(value, ["type"]);
    default:
      return false;
  }
}

/** Shape validation, not permission or schema validation. Duplicate ids refuse the whole batch. */
export function parseRequestAnswers(value: unknown): RequestAnswer[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const answers: RequestAnswer[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      !keys(item, ["requestId", "response"]) ||
      typeof item.requestId !== "string" ||
      !item.requestId ||
      ids.has(item.requestId) ||
      !isResponse(item.response)
    )
      return null;
    ids.add(item.requestId);
    answers.push({ requestId: item.requestId, response: item.response });
  }
  return answers;
}

/** Instant feedback only. The SDK and host must still validate every answer and result. */
export function checkResponse(part: RequestPart, response: RequestResponse): DisplayError | null {
  const invalid = (message: string): DisplayError => ({ code: "invalid_answer", message });
  if (
    part.state !== "pending" ||
    part.canAnswer === false ||
    (part.expiresAt !== undefined && Date.now() >= part.expiresAt)
  )
    return {
      code: "not_waiting",
      message: "This request cannot be answered here. Check for an updated request.",
    };
  if (!isResponse(response))
    return invalid("This answer has an unsupported format. Review it and try again.");
  if (response.type === "stop" || response.type === "cancel") return null;
  if (part.type === "approval") {
    if (response.type !== "approve" && response.type !== "deny")
      return invalid("Approve or deny this request.");
    if (response.type === "approve" && response.arguments !== undefined && !part.edit)
      return invalid("This request does not allow changes to its input.");
    if (
      response.data !== undefined &&
      (!isRecord(response.data) ||
        !(response.type === "approve" ? part.approveForm : part.denyForm))
    )
      return invalid("This request does not accept form data.");
    return null;
  }
  if (part.type === "client-tool")
    return response.type === "result" ? null : invalid("This request needs a result from the app.");
  if (response.type !== "answer") return invalid("Answer or skip this question.");
  const { choices = [], text, data } = response.answer;
  if (
    (response.answer.choices !== undefined && !part.choices) ||
    new Set(choices).size !== choices.length ||
    (!part.multiple && choices.length > 1) ||
    choices.some((id) => !part.choices?.some((choice) => choice.id === id))
  )
    return invalid("Choose from the options shown.");
  const allowsText = part.freeText ?? (!part.choices?.length && !part.schema);
  if (text !== undefined && (!allowsText || !text.trim()))
    return invalid("Enter an answer in the available fields.");
  if (data !== undefined && (!part.schema || !isRecord(data)))
    return invalid("This question needs form fields, not this value.");
  if (part.schema && data === undefined)
    return invalid("Fill in the form before sending your answer.");
  if (!choices.length && !text?.trim() && data === undefined)
    return invalid("Enter an answer or choose an option.");
  return null;
}
