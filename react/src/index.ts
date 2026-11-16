// The client store and the React hooks. No UI, no Markdown, no CSS and no transport here: each
// has its own entry, so an app that only uses the hooks loads only the hooks.
export { createChatClient, TransportError } from "./client.ts";
export type {
  AttachmentRef,
  ChatClient,
  ChatClientOptions,
  ChatState,
  ChatStatus,
  ChatTransport,
  CommandResult,
  ConnectionStatus,
  EventReply,
  MessageInput,
  ReconnectOptions,
  RequestAnswer,
  RequestResponse,
  RequestView,
  SendInput,
  SendResult,
} from "./client.ts";
export { useAgentRun, useChat } from "./hooks.ts";
export type { AgentRunValue, ChatValue, UseAgentRunOptions, UseChatOptions } from "./hooks.ts";
export { createComposer, useComposer } from "./composer.ts";
export type {
  ComposerOptions,
  ComposerState,
  ComposerController,
  ComposerValue,
} from "./composer.ts";
export type {
  AttachmentRules,
  AttachmentUploader,
  AttachmentOptions,
  AttachmentItem,
} from "./attachments.ts";
export { draftScopeKey } from "./drafts.ts";
export type {
  DraftScope,
  DraftContent,
  StoredDraft,
  DraftStorage,
  DraftOptions,
  DraftStatus,
  DraftState,
} from "./drafts.ts";
// The display types a hook hands out, so code that reads `chat.messages` needs one import. The
// parser and the reducer stay on `/protocol`.
export type {
  ApprovalPart,
  ChatEvent,
  Cursor,
  DisplayError,
  DisplayMessage,
  DisplayPart,
  RunInfo,
  RunStatus,
} from "./protocol.ts";
