import type {
  ChatEnvelope,
  ChatEvent,
  DisplayError,
  DisplayPart,
  RequestPart,
  ToolPart,
} from "../protocol.ts";

/** Structural AG-UI 1.0 shapes, not a dependency on an AG-UI client runtime.
 * Field names checked against TanStack AI's spec-event-keys.ts (MIT,
 * Copyright (c) 2025 Tanner Linsley). No TanStack implementation code is included. */
export interface AgUiBase {
  timestamp?: number;
  metadata?: Record<string, unknown>;
  rawEvent?: unknown;
  subagentRunId?: string;
}

export interface AgUiInterrupt {
  id: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  responseSchema?: Record<string, unknown>;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  subagentRunId?: string;
}

export type AgUiOutcome =
  | { type: "success"; pendingToolCallIds?: readonly string[] }
  | { type: "interrupt"; interrupts: readonly AgUiInterrupt[] }
  | { type: "cancelled" };

export interface AgUiMessage {
  id: string;
  role: string;
  content?: unknown;
  name?: string;
  toolCallId?: string;
  toolCalls?: readonly {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  error?: unknown;
  activityType?: string;
  subagentRunId?: string;
}

export type AgUiEvent = AgUiBase &
  (
    | {
        type: "RUN_STARTED";
        threadId: string;
        runId: string;
        parentRunId?: string;
        protocolVersion?: string;
        input?: unknown;
      }
    | {
        type: "RUN_FINISHED";
        threadId: string;
        runId: string;
        outcome?: AgUiOutcome;
        result?: unknown;
        usage?: unknown;
      }
    | { type: "RUN_ERROR"; message: string; code?: string; usage?: unknown }
    | { type: "TEXT_MESSAGE_START"; messageId: string; role?: string; name?: string }
    | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
    | { type: "TEXT_MESSAGE_END"; messageId: string }
    | {
        type: "TEXT_MESSAGE_CHUNK";
        messageId?: string;
        role?: string;
        delta?: string;
        name?: string;
      }
    | {
        type: "TOOL_CALL_START";
        toolCallId: string;
        toolCallName: string;
        parentMessageId?: string;
      }
    | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
    | { type: "TOOL_CALL_END"; toolCallId: string }
    | {
        type: "TOOL_CALL_CHUNK";
        toolCallId?: string;
        toolCallName?: string;
        parentMessageId?: string;
        delta?: string;
      }
    | {
        type: "TOOL_CALL_RESULT";
        messageId: string;
        toolCallId: string;
        content: string;
        role?: "tool";
      }
    | { type: "STEP_STARTED" | "STEP_FINISHED"; stepName: string }
    | { type: "MESSAGES_SNAPSHOT"; messages: readonly AgUiMessage[] }
    | { type: "STATE_SNAPSHOT"; snapshot: unknown }
    | { type: "STATE_DELTA"; delta: readonly unknown[] }
    | {
        type: "ACTIVITY_SNAPSHOT";
        messageId: string;
        activityType: string;
        content: unknown;
        replace?: boolean;
      }
    | { type: "ACTIVITY_DELTA"; messageId: string; activityType: string; patch: readonly unknown[] }
    | {
        type: "SUBAGENT_STARTED";
        subagentRunId: string;
        name: string;
        description?: string;
        parentSubagentRunId?: string;
        parentToolCallId?: string;
        parentMessageId?: string;
      }
    | {
        type: "SUBAGENT_FINISHED";
        subagentRunId: string;
        result?: unknown;
        outcome?: { type: "suspended"; interruptIds: readonly string[] };
      }
    | { type: "SUBAGENT_ERROR"; subagentRunId: string; message: string; code?: string }
    | { type: "CUSTOM"; name: string; value: unknown }
    | { type: "RAW"; event: unknown; source?: string }
    | { type: "REASONING_START" | "REASONING_END" | "REASONING_MESSAGE_END"; messageId: string }
    | { type: "REASONING_MESSAGE_START"; messageId: string; role: "reasoning" }
    | { type: "REASONING_MESSAGE_CONTENT"; messageId: string; delta: string }
    | { type: "REASONING_MESSAGE_CHUNK"; messageId?: string; delta?: string }
    | {
        type: "REASONING_ENCRYPTED_VALUE";
        subtype: "message" | "tool-call";
        entityId: string;
        encryptedValue: string;
      }
  );

/** All four identities are host-owned. Never derive them from wire ids or each other.
 * Make a new mapper for a new execution segment; hydrate it with a display snapshot. */
export interface AgUiBinding {
  threadId: string;
  runId: string;
  segment: string;
  agUiRunId: string;
}

export interface AgUiIssue {
  code: "invalid" | "unsupported" | "hidden" | "namespace" | "framing" | "limit" | "incomplete";
  /** Fixed text only. Never includes an untrusted payload or vendor error. */
  message: string;
}

export interface AgUiMapping<T> {
  events: T[];
  issues: AgUiIssue[];
}

export interface AgUiLimits {
  /** Total messages, parts and frame identities held by one mapper. Default 2,048. */
  maxItems?: number;
  /** Maximum JSON characters per input and retained display view. Default 1,048,576. */
  maxChars?: number;
}

export interface AgUiOptions {
  binding: AgUiBinding;
  limits?: AgUiLimits;
  /** Explicitly project opaque fields (data, input, forms and edits). Return a rebuilt part,
   * not a spread of raw data. Without this callback these fields stay hidden.
   * Functions, capabilities and reserved credential fields are refused even here. */
  projectPart?: (part: DisplayPart) => DisplayPart | undefined;
}

export interface AgUiReaderOptions extends AgUiOptions {
  label?: (toolName: string) => string;
  tool?: (result: {
    toolCallId: string;
    name: string;
    content: string;
  }) => Pick<ToolPart, "summary" | "detail" | "data"> | undefined;
  request?: (interrupt: AgUiInterrupt) => RequestPart | undefined;
  error?: (failure: { message: string; code?: string }) => DisplayError;
  /** Native child text is private unless this host callback selects it. */
  text?: (source: { messageId: string; subagentRunId?: string; role: string }) => boolean;
  /** No shared state is retained without this callback. Patch failures leave it unchanged. */
  state?: (snapshot: unknown) => readonly DisplayPart[];
  /** Explicit safe projection for activity, reasoning, RAW and non-providerkit CUSTOM events. */
  project?: (event: AgUiEvent) => readonly ChatEvent[] | undefined;
}

export interface AgUiReader {
  read(value: unknown, cursor?: Pick<ChatEnvelope, "seq" | "segment">): AgUiMapping<ChatEvent>;
  /** A disconnected stream never proves completion or settles partial text. */
  end(): AgUiMapping<ChatEvent>;
}

export interface AgUiWriter {
  write(value: unknown): AgUiMapping<AgUiEvent>;
  end(): AgUiMapping<AgUiEvent>;
}

/** Evidence for a host, never permission to execute a tool or resume a run. */
export interface AgUiResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}
