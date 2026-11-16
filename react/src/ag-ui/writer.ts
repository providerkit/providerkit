import {
  emptyChatView,
  isRequestPart,
  reduceChat,
  type ChatEvent,
  type DisplayMessage,
  type RequestPart,
} from "../protocol.ts";
import type { ChatView } from "../state.ts";
import {
  checkOptions,
  DEFAULT_ITEMS,
  DISPLAY_EVENT,
  displayEvent,
  issue,
  NAMESPACE,
  step,
  wireId,
  withinView,
} from "./common.ts";
import type {
  AgUiEvent,
  AgUiInterrupt,
  AgUiIssue,
  AgUiMessage,
  AgUiOptions,
  AgUiWriter,
} from "./types.ts";

const textId = (messageId: string, partId: string) => wireId("text", messageId, partId);
const toolId = (messageId: string, partId: string) => wireId("tool", messageId, partId);
const anchorId = (messageId: string) => wireId("message", messageId);
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Snapshots contain public text and tool labels/summaries only, never call arguments. */
function messages(view: ChatView): AgUiMessage[] {
  const output: AgUiMessage[] = [];
  for (const message of view.messages) {
    let parent: AgUiMessage | undefined;
    for (const part of message.parts) {
      if (part.type === "text") {
        parent = {
          id: textId(message.id, part.id),
          role: message.role,
          content: part.text,
          ...(part.agentId && { subagentRunId: part.agentId }),
        };
        output.push(parent);
      } else if (part.type === "tool") {
        if (!parent || parent.role !== "assistant") {
          parent = { id: anchorId(message.id), role: "assistant", content: "" };
          output.push(parent);
        }
        const callId = toolId(message.id, part.id);
        parent.toolCalls = [
          ...(parent.toolCalls ?? []),
          {
            id: callId,
            type: "function",
            function: { name: part.name ?? part.label, arguments: "" },
          },
        ];
        if (part.state === "done" || part.state === "failed")
          output.push({
            id: wireId("result", message.id, part.id),
            role: "tool",
            toolCallId: callId,
            content: part.summary ?? "",
            ...(part.state === "failed" && { error: true }),
          });
      }
    }
    if (!parent) output.push({ id: anchorId(message.id), role: message.role, content: "" });
  }
  return output;
}

function interrupts(view: ChatView): AgUiInterrupt[] {
  const result: AgUiInterrupt[] = [];
  for (const message of view.messages)
    for (const part of message.parts) {
      if (!isRequestPart(part) || part.state !== "pending") continue;
      const request: AgUiInterrupt = {
        id: part.id,
        reason:
          part.type === "approval"
            ? "tool_call"
            : part.type === "client-tool"
              ? "client_tool"
              : "input",
        message: part.title,
        metadata: { kind: part.type },
      };
      if (part.toolId) request.toolCallId = toolId(message.id, part.toolId);
      if (part.agentId) request.subagentRunId = part.agentId;
      if (part.expiresAt !== undefined && Math.abs(part.expiresAt) <= 8.64e15)
        request.expiresAt = new Date(part.expiresAt).toISOString();
      if (part.type === "question" && part.schema) request.responseSchema = { ...part.schema };
      result.push(request);
    }
  return result;
}

/** Native AG-UI remains useful to a client that ignores CUSTOM. Each group ends with one
 * providerkit display commit so a matching reader can preserve richer display semantics,
 * atomically, without double-applying the native projection. No namespace grants authority. */
export function createAgUiWriter(options: AgUiOptions): AgUiWriter {
  checkOptions(options);
  options = { ...options, binding: { ...options.binding }, limits: { ...options.limits } };
  const { binding } = options;
  let view = emptyChatView();
  let opened = new Set<string>();
  let snapshotText = new Set<string>();
  let anchors = new Set<string>();
  let frame = 0;
  let started = false;
  let finished = false;
  let closed = false;

  return {
    write(value) {
      const issues: AgUiIssue[] = [];
      const output: AgUiEvent[] = [];
      if (closed)
        return {
          events: output,
          issues: [
            issue("framing", "This writer is closed. Create a writer for the new connection."),
          ],
        };
      let event: ChatEvent | null;
      try {
        event = displayEvent(value, options, issues);
      } catch {
        return {
          events: output,
          issues: [issue("invalid", "The safe part projection failed. Nothing was written.")],
        };
      }
      if (!event) return { events: output, issues };
      if (event.type === "text" && event.seq === undefined)
        return {
          events: output,
          issues: [
            ...issues,
            issue("framing", "A display text delta needs a host cursor for replay."),
          ],
        };
      // A numbered replay is discarded before opening or closing any native lane.
      const next = reduceChat(view, event);
      if (next === view) return { events: output, issues };
      if (!withinView(next, options))
        return {
          events: output,
          issues: [
            ...issues,
            issue(
              "limit",
              "The display view exceeds this writer's limit. Load a smaller snapshot.",
            ),
          ],
        };
      if (finished && ["running", "idle"].includes(next.run.status))
        return {
          events: output,
          issues: [
            ...issues,
            issue("framing", "Reopening an execution needs a new host segment binding."),
          ],
        };
      const before = { opened, snapshotText, anchors, started, finished };
      opened = new Set(opened);
      snapshotText = new Set(snapshotText);
      anchors = new Set(anchors);
      const close = () => {
        for (const messageId of opened) output.push({ type: "TEXT_MESSAGE_END", messageId });
        opened.clear();
      };
      const ensureAnchor = (message: DisplayMessage): string => {
        const messageId = anchorId(message.id);
        if (!anchors.has(messageId)) {
          output.push(
            { type: "TEXT_MESSAGE_START", messageId, role: message.role },
            { type: "TEXT_MESSAGE_END", messageId },
          );
          anchors.add(messageId);
        }
        return messageId;
      };
      const snapshot = () => {
        close();
        output.push({ type: "MESSAGES_SNAPSHOT", messages: messages(next) });
        snapshotText.clear();
        anchors.clear();
        for (const message of next.messages) {
          for (const part of message.parts)
            if (part.type === "text") snapshotText.add(textId(message.id, part.id));
          // The flattened snapshot already contains an anchor when there is no text.
          if (!message.parts.some((part) => part.type === "text"))
            anchors.add(anchorId(message.id));
        }
      };
      if (!started && !(event.type === "run" && event.run.status === "idle")) {
        output.push({
          type: "RUN_STARTED",
          threadId: binding.threadId,
          runId: binding.agUiRunId,
          protocolVersion: "1.0",
        });
        started = true;
      }
      let replace = event.type === "snapshot" || (finished && next.messages !== view.messages);
      for (const message of next.messages) {
        const held = view.messages.find((item) => item.id === message.id);
        if (message.role === "user" && !equal(message, held)) replace = true;
        for (const part of message.parts) {
          const prior = held?.parts.find((item) => item.id === part.id);
          if (
            part.type === "text" &&
            prior?.type === "text" &&
            !equal(part, prior) &&
            (snapshotText.has(textId(message.id, part.id)) ||
              part.attempt !== prior.attempt ||
              !part.text.startsWith(prior.text) ||
              (prior.settled && !equal(part, prior)))
          )
            replace = true;
        }
      }
      if (replace) snapshot();
      for (const message of next.messages) {
        const held = view.messages.find((item) => item.id === message.id);
        for (const part of message.parts) {
          const prior = held?.parts.find((item) => item.id === part.id);
          if (equal(part, prior) || before.finished) continue;
          if (part.type === "text" && !replace && message.role === "assistant") {
            const messageId = textId(message.id, part.id);
            const agent = part.agentId
              ? next.messages
                  .flatMap((item) => item.parts)
                  .find((item) => item.type === "agent" && item.id === part.agentId)
              : undefined;
            const scope = part.agentId ? { subagentRunId: part.agentId } : {};
            if (!prior) {
              output.push({
                type: "TEXT_MESSAGE_START",
                messageId,
                role: "assistant",
                ...(agent?.type === "agent" && { name: agent.label }),
                ...scope,
              });
              opened.add(messageId);
            }
            const delta = part.text.slice(prior?.type === "text" ? prior.text.length : 0);
            if (delta) output.push({ type: "TEXT_MESSAGE_CONTENT", messageId, delta, ...scope });
            if ((part.settled || message.state !== "live") && opened.delete(messageId))
              output.push({ type: "TEXT_MESSAGE_END", messageId, ...scope });
          } else if (part.type === "tool" && !replace) {
            const callId = toolId(message.id, part.id);
            if (!prior) {
              output.push(
                {
                  type: "TOOL_CALL_START",
                  toolCallId: callId,
                  toolCallName: part.name ?? part.label,
                  parentMessageId: ensureAnchor(message),
                  ...(part.agentId && { subagentRunId: part.agentId }),
                },
                { type: "TOOL_CALL_END", toolCallId: callId },
              );
            }
            if (part.state === "done" || part.state === "failed")
              output.push({
                type: "TOOL_CALL_RESULT",
                messageId: wireId("result", message.id, part.id),
                toolCallId: callId,
                role: "tool",
                content: part.summary ?? "",
                ...(part.state === "failed" && {
                  metadata: { tanstack: { state: "output-error" } },
                }),
              });
          } else if (part.type === "agent") {
            const child = { subagentRunId: part.id };
            if (!prior)
              output.push({
                type: "SUBAGENT_STARTED",
                ...child,
                name: part.label,
                parentMessageId: replace ? undefined : ensureAnchor(message),
                ...(part.parentId && { parentSubagentRunId: part.parentId }),
                ...(part.toolId && { parentToolCallId: toolId(message.id, part.toolId) }),
              });
            if (part.state === "failed" || part.state === "limited")
              output.push({
                type: "SUBAGENT_ERROR",
                ...child,
                message: "The specialist could not finish.",
              });
            else if (part.state === "completed" || part.state === "stopped")
              output.push({ type: "SUBAGENT_FINISHED", ...child });
            else if (part.state === "waiting")
              output.push({
                type: "SUBAGENT_FINISHED",
                ...child,
                outcome: {
                  type: "suspended",
                  interruptIds: message.parts
                    .filter(
                      (item): item is RequestPart =>
                        isRequestPart(item) && item.agentId === part.id && item.state === "pending",
                    )
                    .map((item) => item.id),
                },
              });
          } else if (part.type === "data") {
            const info = step(part);
            if (info) {
              if (!prior) output.push({ type: "STEP_STARTED", stepName: info.name });
              if (info.state === "finished")
                output.push({ type: "STEP_FINISHED", stepName: info.name });
            } else
              output.push({
                type: "ACTIVITY_SNAPSHOT",
                messageId: wireId("data", message.id, part.id),
                activityType: part.kind,
                content: part.data,
                replace: true,
              });
          }
        }
        if (message.state !== "live" && message.state !== "sending")
          for (const part of message.parts)
            if (part.type === "text" && opened.delete(textId(message.id, part.id)))
              output.push({ type: "TEXT_MESSAGE_END", messageId: textId(message.id, part.id) });
      }
      const runChanged =
        (event.type === "run" || event.type === "snapshot") && !equal(view.run, next.run);
      if (
        started &&
        (runChanged || event.type === "snapshot") &&
        !["idle", "running"].includes(next.run.status) &&
        !finished
      ) {
        close();
        const run = next.run;
        if (run.status === "failed" || run.status === "limited")
          output.push({
            type: "RUN_ERROR",
            code: run.error?.code ?? run.status,
            message:
              run.error?.message ??
              "The run could not finish. Check its saved state before trying again.",
          });
        else
          output.push({
            type: "RUN_FINISHED",
            threadId: binding.threadId,
            runId: binding.agUiRunId,
            outcome:
              run.status === "waiting"
                ? { type: "interrupt", interrupts: interrupts(next) }
                : run.status === "stopped"
                  ? { type: "cancelled" }
                  : { type: "success" },
          });
        finished = true;
      }
      if (output.length > (options.limits?.maxItems ?? DEFAULT_ITEMS)) {
        ({ opened, snapshotText, anchors, started, finished } = before);
        return {
          events: [],
          issues: [
            ...issues,
            issue("limit", "The native projection has too many events. Load a smaller snapshot."),
          ],
        };
      }
      const count = output.length;
      const marker = (index: number) => ({ v: 1, binding: { ...binding }, frame, index, count });
      const events = output.map((native, index): AgUiEvent => ({
        ...native,
        metadata: { ...native.metadata, [NAMESPACE]: marker(index) },
      }));
      events.push({
        type: "CUSTOM",
        name: DISPLAY_EVENT,
        metadata: { [NAMESPACE]: marker(count) },
        value: { event },
      });
      frame++;
      view = next;
      return { events, issues };
    },
    end() {
      closed = true;
      return {
        events: [],
        issues:
          started && !finished
            ? [
                issue(
                  "incomplete",
                  "The stream closed before a run outcome. Reload its saved snapshot; no completion was invented.",
                ),
              ]
            : [],
      };
    },
  };
}
