// A run's input: checked and normalized once, before anything is saved, loaded or sent.
//
// Every entry point (run, a background start, a specialist child) turns what it was given into
// the same frozen pair, the history and the new user turn, and the snapshot keeps that pair
// for the run's whole life. Nothing here re-reads a session or rebuilds a history later: one
// earlier byte that changes between requests re-bills the provider's whole prompt cache.
import {
  repairHistory,
  type ChatMessage,
  type ContentPart,
  type ToolCall,
} from "@providerkit/core";
import {
  copyData,
  isAgentMessage,
  isFileMime,
  isId,
  isImageMime,
  isPart,
  isRecord,
  nudgeAfter,
} from "./snapshot.ts";
import type {
  AgentInput,
  AgentMessage,
  InputPart,
  MediaRef,
  RunSnapshot,
  UserContent,
} from "./types.ts";

/** `caller`: it may come from a browser, so only the fields a model needs are kept.
 * `trusted`: coordinator code wrote it, so provider-owned fields ride along. */
export type Trust = "caller" | "trusted";

function partProblem(part: unknown): string {
  if (!isRecord(part)) return "A content part must be an object with a type.";
  switch (part.type) {
    case "text":
      return "A text part needs its text as a string.";
    case "image":
      return isImageMime(part.mimeType)
        ? "An image needs its bytes as base64 text, padded with = to a multiple of 4."
        : "An image must be image/jpeg, image/png, image/webp or image/gif. Send other files as a file part.";
    case "file":
      return isFileMime(part.mimeType)
        ? "A file needs its bytes as base64 text, padded with = to a multiple of 4."
        : "A file needs an application/, audio/, video/ or text/ media type, with no parameters.";
    case "media":
      return isId(part.id)
        ? "A media reference needs an image type (JPEG, PNG, WebP or GIF) or an application/, audio/, video/ or text/ type."
        : "A media reference needs the id your host stores its bytes under.";
    default:
      return "Use text, image, file or media content parts.";
  }
}

// Use the same field allow-list on input and on browser output. Trusted stores may attach
// server-only upload metadata to otherwise valid parts.
function clientPart(part: InputPart): InputPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "media":
      return { type: "media", id: part.id, mimeType: part.mimeType };
    case "image":
      return { type: "image", mimeType: part.mimeType, data: part.data };
    case "file":
      return { type: "file", mimeType: part.mimeType, data: part.data };
  }
}

/** A user turn with each part rebuilt from the fields core reads. A blank text part is
 * dropped: providers refuse an empty text block, and a composer often sends one beside an
 * attachment. Nothing left is an error. */
export function readContent(value: unknown, what: string): UserContent {
  const empty = `${what} needs some text, an image or a file.`;
  if (typeof value === "string") {
    if (!value.trim()) throw new TypeError(empty);
    return value;
  }
  if (!Array.isArray(value))
    throw new TypeError(`${what} must be text or an array of content parts.`);
  const parts: InputPart[] = [];
  for (const part of value) {
    if (!isPart(part)) throw new TypeError(partProblem(part));
    if (part.type !== "text" || part.text.trim()) parts.push(clientPart(part));
  }
  if (parts.length === 0) throw new TypeError(empty);
  return parts;
}

function readMessage(value: unknown, trust: Trust): AgentMessage {
  if (!isRecord(value)) throw new TypeError("Each message must be an object with a role.");
  if (value.role === "system")
    throw new TypeError(
      "A conversation cannot carry a system message. The agent's instructions are its system prompt.",
    );
  if (value.role === "user")
    return { role: "user", content: readContent(value.content, "A user message") };
  if (!isAgentMessage(value))
    throw new TypeError(
      value.role === "assistant"
        ? "An assistant message needs text content, and tool calls with an id, a name and arguments."
        : value.role === "tool"
          ? "A tool message needs the toolCallId and name of the call it answers, and text content."
          : "A message role must be user, assistant or tool.",
    );
  return trust === "trusted" ? copyData(value) : clientCopy(value);
}

/** A tool result in a caller's history must answer an open call of the assistant message before
 * it, the pairing core's repairHistory keeps. Client tool results and approvals never enter
 * through the history, so a result with no call is refused rather than turned into a note. */
function checkRounds(history: readonly AgentMessage[]): void {
  let open: string[] = [];
  for (const message of history) {
    if (message.role === "assistant") {
      // repairHistory drops a blank message with no calls, so it does not close a round.
      if (!message.toolCalls?.length && !message.content.trim()) continue;
      open = (message.toolCalls ?? []).map((call) => call.id);
    } else if (message.role === "tool") {
      const index = open.indexOf(message.toolCallId);
      if (index === -1)
        throw new TypeError(
          "A tool result in the history must answer a call from the assistant message before it.",
        );
      open.splice(index, 1);
    }
  }
}

/** Turn an AgentInput into the history and the new turn. Throws a TypeError for anything a run
 * cannot use, before any snapshot, checkpoint or session call. */
export function readInput(
  input: unknown,
  trust: Trust,
): { history: AgentMessage[]; input: UserContent } {
  if (typeof input === "string" || Array.isArray(input))
    return { history: [], input: readContent(input, "The new turn") };
  if (
    !isRecord(input) ||
    !Array.isArray(input.messages) ||
    Object.keys(input).some((key) => key !== "messages")
  )
    throw new TypeError("Give the agent text, content parts or { messages }.");
  const messages = input.messages.map((message) => readMessage(message, trust));
  const last = messages.pop();
  if (!last) throw new TypeError("Pass at least one message: the new user turn.");
  if (last.role !== "user")
    throw new TypeError(
      "The last message must be the new user turn. Tool results and approvals never enter through the history.",
    );
  checkRounds(messages);
  return { history: messages, input: last.content };
}

/** Trusted history from a session or prepareHistory, kept as it is: shape checked, system
 * refused. A window may start inside a tool round; repair at creation handles that. */
export function readStored(value: unknown, source: string): AgentMessage[] {
  if (!Array.isArray(value)) throw new TypeError(`${source} must give an array of messages.`);
  if (value.some((message) => isRecord(message) && message.role === "system"))
    throw new TypeError(
      `${source} gave a system message. A conversation never carries one: the agent's instructions are its system prompt.`,
    );
  if (!value.every(isAgentMessage))
    throw new TypeError(`${source} gave a message that is not a user, assistant or tool message.`);
  return copyData(value);
}

/** A message rebuilt from the fields a model reads, so provider-owned fields and anything
 * unknown stay behind. */
function clientCopy(message: AgentMessage): AgentMessage {
  if (message.role === "user")
    return {
      role: "user",
      content:
        typeof message.content === "string" ? message.content : message.content.map(clientPart),
    };
  if (message.role === "tool")
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      name: message.name,
      content: message.content,
      ...(message.images
        ? { images: message.images.map(({ type, mimeType, data }) => ({ type, mimeType, data })) }
        : {}),
    };
  const calls = message.toolCalls?.map((call): ToolCall => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  }));
  return {
    role: "assistant",
    content: message.content,
    ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
    ...(calls ? { toolCalls: calls } : {}),
  };
}

/**
 * Copies of the messages without the fields a provider owns: `reasoningDetails`,
 * `reasoningItems` and each call's `thoughtSignature`. Use it before history reaches a
 * browser. Reasoning text and tool rounds stay: DeepSeek needs the reasoning of a tool-call
 * turn sent back. The run applies the same rule to history a caller passes in, because a
 * browser could forge those fields.
 */
export function toClientMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map(clientCopy);
}

/**
 * Core's repairHistory, run once when a run is created. Core types a user message without
 * media references, so each user message crosses as a stand-in and comes back as itself:
 * repair moves user messages, it never reads or rewrites them. Its orphan-result notes are
 * new user messages with core content, which an AgentMessage can hold as they are.
 */
export function repairConversation(
  history: readonly AgentMessage[],
  isReadOnly: (name: string) => boolean,
): AgentMessage[] {
  const users = new Map<ChatMessage, AgentMessage>();
  const wire = history.map((message): ChatMessage => {
    if (message.role !== "user") return message;
    const stand: ChatMessage = { role: "user", content: "" };
    users.set(stand, message);
    return stand;
  });
  return repairHistory(wire, { isReadOnly }).messages.map((message): AgentMessage => {
    const user = users.get(message);
    if (user) return user;
    if (message.role === "system") throw new TypeError("History repair returned a system message.");
    return message;
  });
}

/** The history, the new turn and whole settled rounds. Never half a tool round: the journal
 * keeps unfinished work, and a provider refuses a call without its result. `upcoming` builds
 * the next request's conversation, which carries the nudge answering the last turn; a finished
 * run's history leaves that nudge out, since no request sent it. */
export function conversationOf(
  snapshot: RunSnapshot,
  beforeModel = snapshot.models.length,
  upcoming = false,
): AgentMessage[] {
  const messages: AgentMessage[] = [...snapshot.history, { role: "user", content: snapshot.input }];
  for (let position = 0; position <= beforeModel; position++) {
    // A turn that wrote text and called no tool, under stopOnlyAtTools, is answered with the
    // nudge, ahead of any steer that joins at the same boundary.
    const nudge = nudgeAfter(snapshot.definition, snapshot.models[position - 1]);
    if (nudge !== undefined && (position < snapshot.models.length || upcoming))
      messages.push({ role: "user", content: nudge });
    // Steering joins only between whole rounds. Its saved position survives attempts and
    // preserves the exact prefix even when the host later offers more input.
    for (const input of snapshot.inputs)
      if (input.beforeModel === position) messages.push({ role: "user", content: input.content });
    const model = position < beforeModel ? snapshot.models[position] : undefined;
    if (
      !model ||
      model.status !== "completed" ||
      model.tools.some((tool) => tool.status !== "completed")
    )
      break;
    messages.push(model.turn.message);
    for (const [index, tool] of model.tools.entries()) {
      const call = model.turn.message.toolCalls?.[index];
      if (call && tool.status === "completed") {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: tool.result.content,
          ...(tool.result.ok && tool.result.images ? { images: tool.result.images } : {}),
        });
      }
    }
  }
  return copyData(messages);
}

/** A saved run's frozen input in the form child() takes, to admit it again unchanged. */
export function inputOf(snapshot: RunSnapshot): AgentInput {
  return snapshot.history.length === 0
    ? snapshot.input
    : { messages: [...snapshot.history, { role: "user", content: snapshot.input }] };
}

// Ported from TanStack AI (MIT), packages/ai-harness/src/media.ts: the transcript keeps the
// reference and only the provider request gets the bytes. Ours fails on a missing file
// instead of sending a note in its place, so the model never answers about a file it did not
// see.
/** The provider request: the system prompt, then the conversation with each media reference
 * swapped for its bytes. Only this copy ever holds them. */
export async function requestOf(
  instructions: string,
  conversation: readonly AgentMessage[],
  load: (ref: MediaRef) => Promise<string>,
): Promise<ChatMessage[]> {
  const request: ChatMessage[] = [{ role: "system", content: instructions }];
  for (const message of conversation) {
    if (message.role !== "user") {
      request.push(message);
      continue;
    }
    if (typeof message.content === "string") {
      request.push({ role: "user", content: message.content });
      continue;
    }
    const content: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type !== "media") {
        content.push(part);
        continue;
      }
      const data = await load(part);
      const mimeType = part.mimeType;
      content.push(
        isImageMime(mimeType)
          ? { type: "image", mimeType, data }
          : { type: "file", mimeType, data },
      );
    }
    request.push({ role: "user", content });
  }
  return request;
}
