import {
  emptyChatView,
  reduceChat,
  type ChatEvent,
  type DisplayMessage,
  type DisplayPart,
  type RequestPart,
  type RunInfo,
  type TextPart,
  type ToolPart,
} from "../protocol.ts";
import { isRecord } from "../state.ts";
import {
  checkOptions,
  copyJson,
  DEFAULT_CHARS,
  DEFAULT_ITEMS,
  DISPLAY_EVENT,
  displayEvent,
  issue,
  nativeEvent,
  NAMESPACE,
  patchState,
  safePatch,
  sameBinding,
  wireId,
  withinView,
} from "./common.ts";
import type { AgUiEvent, AgUiIssue, AgUiMapping, AgUiReader, AgUiReaderOptions } from "./types.ts";

type TextFrame = { visible: boolean; ended: boolean; role: string; agentId?: string };
type ToolFrame = { messageId: string; part: ToolPart; ended: boolean; result: boolean };
type ChunkFrame = { kind: "text" | "tool"; id: string };
type ExtensionFrame = { frame: number; count: number; next: number };

/** A mapper for one host-bound execution segment. No transport, storage or execution authority. */
export function createAgUiReader(options: AgUiReaderOptions): AgUiReader {
  checkOptions(options);
  options = { ...options, binding: { ...options.binding }, limits: { ...options.limits } };
  const { binding } = options;
  const maxChars = options.limits?.maxChars ?? DEFAULT_CHARS;
  const maxItems = options.limits?.maxItems ?? DEFAULT_ITEMS;
  let view = emptyChatView();
  let texts = new Map<string, TextFrame>();
  let tools = new Map<string, ToolFrame>();
  let steps = new Map<string, boolean>();
  let children = new Map<
    string,
    { messageId: string; part: Extract<DisplayPart, { type: "agent" }> }
  >();
  let shared: unknown;
  let hasShared = false;
  // Each child has its own shorthand lane. An omitted id never selects another run's frame.
  let chunks = new Map<string | undefined, ChunkFrame>();
  let extension: ExtensionFrame | undefined;
  let mode: "native" | "display" | undefined;
  let started = false;
  let finished = false;
  let closed = false;

  return {
    read(value, cursor) {
      const issues: AgUiIssue[] = [];
      const events: ChatEvent[] = [];
      const result = () => ({ events, issues });
      if (closed) {
        issues.push(
          issue("framing", "This reader is closed. Create a reader for the new connection."),
        );
        return result();
      }
      const event = nativeEvent(value, maxChars, issues);
      if (!event) return result();
      if (
        cursor &&
        ((cursor.seq !== undefined && (!Number.isSafeInteger(cursor.seq) || cursor.seq < 0)) ||
          (cursor.segment !== undefined && cursor.segment !== binding.segment))
      ) {
        issues.push(issue("namespace", "The host cursor does not match this segment."));
        return result();
      }
      if (
        (event.type === "RUN_STARTED" || event.type === "RUN_FINISHED") &&
        (event.threadId !== binding.threadId || event.runId !== binding.agUiRunId)
      ) {
        issues.push(issue("namespace", "The AG-UI event belongs to another thread or execution."));
        extension = undefined;
        return result();
      }
      const marker = event.metadata?.[NAMESPACE];
      if (
        marker !== undefined ||
        (event.type === "CUSTOM" && event.name.startsWith("providerkit."))
      ) {
        if (
          !isRecord(marker) ||
          marker.v !== 1 ||
          !sameBinding(marker.binding, binding) ||
          !Number.isSafeInteger(marker.frame) ||
          typeof marker.frame !== "number" ||
          marker.frame < 0 ||
          !Number.isSafeInteger(marker.index) ||
          typeof marker.index !== "number" ||
          marker.index < 0 ||
          !Number.isSafeInteger(marker.count) ||
          typeof marker.count !== "number" ||
          marker.count < 0 ||
          marker.count > maxItems ||
          marker.index > marker.count ||
          mode === "native"
        ) {
          issues.push(
            issue(
              "namespace",
              "The providerkit namespace is unsupported or belongs to another execution.",
            ),
          );
          extension = undefined;
          return result();
        }
        mode = "display";
        if (marker.index === 0) {
          if (extension) {
            issues.push(
              issue(
                "incomplete",
                "A display frame ended before its final event. Reload a snapshot.",
              ),
            );
            extension = undefined;
            return result();
          }
          extension = { frame: marker.frame, count: marker.count, next: 0 };
        }
        if (
          !extension ||
          extension.frame !== marker.frame ||
          extension.count !== marker.count ||
          extension.next !== marker.index
        ) {
          issues.push(
            issue("framing", "A display frame is duplicated or out of order. Reload a snapshot."),
          );
          extension = undefined;
          return result();
        }
        if (marker.index < marker.count) {
          if (event.type === "CUSTOM" && event.name === DISPLAY_EVENT) {
            issues.push(issue("framing", "The display commit arrived before its native events."));
            extension = undefined;
            return result();
          }
          extension.next++;
          return result();
        }
        extension = undefined;
        if (event.type !== "CUSTOM" || event.name !== DISPLAY_EVENT || !isRecord(event.value)) {
          issues.push(issue("framing", "The frame has no display commit. Reload a snapshot."));
          return result();
        }
        let clean: ChatEvent | null;
        try {
          clean = displayEvent(event.value.event, options, issues);
        } catch {
          issues.push(issue("invalid", "The safe part projection failed. Nothing was applied."));
          return result();
        }
        if (!clean) return result();
        if (clean.type === "text" && clean.seq === undefined) {
          issues.push(issue("framing", "A display text delta needs a host cursor for replay."));
          return result();
        }
        if (
          cursor &&
          (cursor.seq !== clean.seq ||
            (cursor.segment ?? binding.segment) !== (clean.segment ?? binding.segment))
        ) {
          issues.push(issue("namespace", "The transport cursor and display cursor disagree."));
          return result();
        }
        const next = reduceChat(view, clean);
        if (!withinView(next, options)) {
          issues.push(
            issue(
              "limit",
              "The display view exceeds this reader's limit. Load a smaller snapshot.",
            ),
          );
          return result();
        }
        started = true;
        if (clean.type === "run" || clean.type === "snapshot")
          finished = !["running", "idle"].includes(next.run.status);
        if (next !== view) events.push(clean);
        view = next;
        return result();
      }
      if (mode === "display") {
        issues.push(
          issue("namespace", "Native events cannot be mixed with providerkit display frames."),
        );
        return result();
      }
      if (
        cursor?.seq !== undefined &&
        view.cursor?.segment === binding.segment &&
        cursor.seq <= view.cursor.seq
      )
        return result();
      if (event.type !== "RUN_STARTED" && !started) {
        issues.push(issue("framing", "RUN_STARTED must arrive before native progress."));
        return result();
      }
      if (finished && event.type !== "MESSAGES_SNAPSHOT") {
        issues.push(
          issue("framing", "This execution already ended. Use a new reader for a new segment."),
        );
        return result();
      }
      if (event.subagentRunId && !event.type.startsWith("SUBAGENT_")) {
        const child = children.get(event.subagentRunId);
        if (!child || ["failed", "stopped", "limited"].includes(child.part.state)) {
          issues.push(issue("framing", "Progress refers to an unknown or failed child run."));
          return result();
        }
      }
      const chunk = chunks.get(event.subagentRunId);
      const textId =
        "messageId" in event && typeof event.messageId === "string"
          ? event.messageId
          : event.type === "TEXT_MESSAGE_CHUNK" && chunk?.kind === "text"
            ? chunk.id
            : undefined;
      const toolId =
        "toolCallId" in event && typeof event.toolCallId === "string"
          ? event.toolCallId
          : event.type === "TOOL_CALL_CHUNK" && chunk?.kind === "tool"
            ? chunk.id
            : undefined;
      const textFrame = textId === undefined ? undefined : texts.get(textId);
      const toolFrame = toolId === undefined ? undefined : tools.get(toolId);
      if (
        (event.type.startsWith("TEXT_") &&
          textFrame &&
          event.subagentRunId !== textFrame.agentId) ||
        (event.type.startsWith("TOOL_") &&
          toolFrame &&
          event.subagentRunId !== toolFrame.part.agentId)
      ) {
        issues.push(issue("framing", "Progress does not match the child that opened its frame."));
        return result();
      }
      mode = "native";
      // Commit framing and projected display data together. A failed callback or over-limit
      // event cannot leave a half-open lane that changes the next event's interpretation.
      const before = {
        texts,
        tools,
        steps,
        children,
        shared,
        hasShared,
        chunks,
        started,
        finished,
      };
      texts = new Map(texts);
      tools = new Map(tools);
      steps = new Map(steps);
      children = new Map(children);
      chunks = new Map(chunks);
      const pending: ChatEvent[] = [];
      let snapshotTools: Map<string, ToolFrame> | undefined;
      const failureTerminal =
        event.type === "RUN_ERROR" ||
        (event.type === "RUN_FINISHED" && event.outcome?.type === "cancelled");
      const emit = (item: ChatEvent) => pending.push(item);
      const problem = (message: string) => {
        issues.push(issue("framing", message));
      };
      const messageOf = (messageId: string) =>
        view.messages.find((message) => message.id === messageId);
      const ensure = (messageId: string, role: "user" | "assistant" = "assistant") => {
        if (
          !messageOf(messageId) &&
          !pending.some((item) => item.type === "message" && item.message.id === messageId)
        )
          emit({
            v: 1,
            type: "message",
            message: { id: messageId, role, state: "live", parts: [] },
          });
      };
      const put = (messageId: string, part: DisplayPart) => {
        ensure(messageId);
        emit({ v: 1, type: "part", messageId, part });
      };
      const textPart = (messageId: string): TextPart | undefined => {
        const part = messageOf(messageId)?.parts.find(
          (item) => item.id === messageId && item.type === "text",
        );
        return part?.type === "text" ? part : undefined;
      };
      const endText = (messageId: string) => {
        const frame = texts.get(messageId);
        if (!frame || frame.ended) {
          problem("Text ended without an open frame.");
          return;
        }
        texts.set(messageId, { ...frame, ended: true });
        const part = textPart(messageId);
        if (frame.visible && part) put(messageId, { ...part, settled: true });
      };
      const endTool = (toolId: string) => {
        const frame = tools.get(toolId);
        if (!frame || frame.ended) {
          problem("Tool arguments ended without an open frame.");
          return;
        }
        tools.set(toolId, { ...frame, ended: true });
      };
      const closeChunk = (subagentRunId: string | undefined) => {
        const lane = chunks.get(subagentRunId);
        if (!lane) return;
        if (lane.kind === "text") endText(lane.id);
        else endTool(lane.id);
        chunks.delete(subagentRunId);
      };
      const projection = (source: AgUiEvent) => {
        const selected = options.project?.(source);
        if (!selected) {
          issues.push(issue("hidden", "This payload has no default display projection."));
          return;
        }
        for (const item of selected) {
          const clean = displayEvent(item, options, issues, true);
          if (clean) emit(clean);
        }
      };
      const run = (run: RunInfo) => emit({ v: 1, type: "run", run: { ...run, id: binding.runId } });
      const textVisible = (source: { messageId: string; subagentRunId?: string; role: string }) =>
        (source.role === "user" || source.role === "assistant") &&
        (options.text?.(source) ?? !source.subagentRunId);
      const startText = (source: Extract<AgUiEvent, { type: "TEXT_MESSAGE_START" }>) => {
        if (texts.has(source.messageId) || tools.has(source.messageId)) {
          problem("A message frame with this id already exists.");
          return;
        }
        const role = source.role ?? "assistant";
        const visible = textVisible({
          messageId: source.messageId,
          subagentRunId: source.subagentRunId,
          role,
        });
        if (source.subagentRunId && !children.has(source.subagentRunId)) {
          problem("Text refers to an unknown child run.");
          return;
        }
        texts.set(source.messageId, { visible, role, ended: false, agentId: source.subagentRunId });
        if (!visible) {
          issues.push(issue("hidden", "System, developer and unselected child text stays hidden."));
          return;
        }
        ensure(source.messageId, role === "user" ? "user" : "assistant");
        put(source.messageId, {
          type: "text",
          id: source.messageId,
          text: "",
          settled: false,
          ...(source.subagentRunId && { agentId: source.subagentRunId }),
        });
      };
      const startTool = (source: Extract<AgUiEvent, { type: "TOOL_CALL_START" }>) => {
        if (tools.has(source.toolCallId)) {
          problem("A tool frame with this id already exists.");
          return;
        }
        if (source.subagentRunId && !children.has(source.subagentRunId)) {
          problem("The tool refers to an unknown child run.");
          return;
        }
        const messageId = source.parentMessageId ?? wireId("tools", binding.agUiRunId);
        if (source.parentMessageId && !messageOf(messageId) && !texts.get(messageId)?.visible) {
          problem("The tool's parent message is missing or hidden.");
          return;
        }
        const part: ToolPart = {
          type: "tool",
          id: source.toolCallId,
          name: source.toolCallName,
          label: options.label?.(source.toolCallName) ?? source.toolCallName,
          state: "running",
          ...(source.subagentRunId && { agentId: source.subagentRunId }),
        };
        tools.set(source.toolCallId, { messageId, part, ended: false, result: false });
        put(messageId, part);
      };
      try {
        const continuation =
          (event.type === "TEXT_MESSAGE_CHUNK" &&
            chunk?.kind === "text" &&
            (!event.messageId || event.messageId === chunk.id)) ||
          (event.type === "TOOL_CALL_CHUNK" &&
            chunk?.kind === "tool" &&
            (!event.toolCallId || event.toolCallId === chunk.id));
        const passThrough =
          event.type === "RAW" ||
          event.type.startsWith("ACTIVITY_") ||
          event.type.startsWith("SUBAGENT_") ||
          event.type === "REASONING_ENCRYPTED_VALUE";
        if (!failureTerminal) {
          if (event.type === "RUN_FINISHED" || event.type === "MESSAGES_SNAPSHOT") {
            for (const scope of chunks.keys()) closeChunk(scope);
          } else if (chunk && !continuation && !passThrough) closeChunk(event.subagentRunId);
        }
        switch (event.type) {
          case "RUN_STARTED":
            if (started) problem("This execution already started.");
            else {
              started = true;
              run({ status: "running" });
            }
            break;
          case "TEXT_MESSAGE_START":
            startText(event);
            break;
          case "TEXT_MESSAGE_CONTENT": {
            const frame = texts.get(event.messageId);
            if (!frame || frame.ended) problem("Text content arrived without an open frame.");
            else if (frame.visible)
              emit({
                v: 1,
                type: "text",
                messageId: event.messageId,
                partId: event.messageId,
                delta: event.delta,
              });
            break;
          }
          case "TEXT_MESSAGE_END":
            endText(event.messageId);
            break;
          case "TEXT_MESSAGE_CHUNK": {
            const messageId = event.messageId ?? (continuation ? textId : undefined);
            if (!messageId) {
              problem("The first text chunk needs a stable message id.");
              break;
            }
            if (!chunks.has(event.subagentRunId)) {
              startText({ ...event, type: "TEXT_MESSAGE_START", messageId });
              chunks.set(event.subagentRunId, { kind: "text", id: messageId });
            }
            const frame = texts.get(messageId);
            if (
              !frame ||
              frame.ended ||
              event.subagentRunId !== frame.agentId ||
              (event.role && event.role !== frame.role)
            ) {
              problem("The text chunk does not match its open frame.");
              break;
            }
            if (frame.visible && event.delta)
              emit({ v: 1, type: "text", messageId, partId: messageId, delta: event.delta });
            break;
          }
          case "TOOL_CALL_START":
            startTool(event);
            break;
          case "TOOL_CALL_ARGS": {
            const frame = tools.get(event.toolCallId);
            if (!frame || frame.ended) problem("Tool arguments arrived without an open frame.");
            else issues.push(issue("hidden", "Tool arguments are not retained or displayed."));
            break;
          }
          case "TOOL_CALL_END":
            endTool(event.toolCallId);
            break;
          case "TOOL_CALL_CHUNK": {
            const toolCallId = event.toolCallId ?? (continuation ? toolId : undefined);
            if (!toolCallId || (!chunks.has(event.subagentRunId) && !event.toolCallName)) {
              problem("The first tool chunk needs a stable id and name.");
              break;
            }
            if (!chunks.has(event.subagentRunId) && event.toolCallName) {
              startTool({
                ...event,
                type: "TOOL_CALL_START",
                toolCallId,
                toolCallName: event.toolCallName,
              });
              chunks.set(event.subagentRunId, { kind: "tool", id: toolCallId });
            }
            const frame = tools.get(toolCallId);
            if (
              !frame ||
              frame.ended ||
              event.subagentRunId !== frame.part.agentId ||
              (event.toolCallName && event.toolCallName !== frame.part.name)
            )
              problem("The tool chunk does not match its open frame.");
            else if (event.delta)
              issues.push(issue("hidden", "Tool arguments are not retained or displayed."));
            break;
          }
          case "TOOL_CALL_RESULT": {
            const frame = tools.get(event.toolCallId);
            if (!frame || !frame.ended || frame.result) {
              problem("A tool result needs one known, ended argument frame.");
              break;
            }
            const shown = options.tool?.({
              toolCallId: event.toolCallId,
              name: frame.part.name ?? "",
              content: event.content,
            });
            const tanstack = event.metadata?.tanstack;
            const failed =
              isRecord(tanstack) &&
              (tanstack.state === "output-error" || tanstack.state === "output-denied");
            const part: ToolPart = { ...frame.part, ...shown, state: failed ? "failed" : "done" };
            tools.set(event.toolCallId, { ...frame, part, result: true });
            const clean = displayEvent(
              { v: 1, type: "part", messageId: frame.messageId, part },
              options,
              issues,
              !!shown,
            );
            if (clean) emit(clean);
            if (!shown) issues.push(issue("hidden", "The raw tool result stays hidden."));
            break;
          }
          case "STEP_STARTED":
          case "STEP_FINISHED": {
            const done = event.type === "STEP_FINISHED";
            if (
              (!done && steps.has(event.stepName)) ||
              (done && steps.get(event.stepName) !== false)
            ) {
              problem("The step is duplicated or ended before it started.");
              break;
            }
            steps.set(event.stepName, done);
            put(wireId("steps", binding.agUiRunId), {
              type: "data",
              id: wireId("step", event.stepName),
              kind: "ag-ui.step",
              data: { name: event.stepName, state: done ? "finished" : "started" },
            });
            break;
          }
          case "SUBAGENT_STARTED": {
            if (
              children.has(event.subagentRunId) ||
              (event.parentSubagentRunId && !children.has(event.parentSubagentRunId))
            ) {
              problem("The child run is duplicated or its parent is unknown.");
              break;
            }
            const messageId = event.parentMessageId ?? wireId("agents", binding.agUiRunId);
            const part: Extract<DisplayPart, { type: "agent" }> = {
              type: "agent",
              id: event.subagentRunId,
              label: event.name,
              state: "running",
              ...(event.parentSubagentRunId && { parentId: event.parentSubagentRunId }),
              ...(event.parentToolCallId && { toolId: event.parentToolCallId }),
            };
            children.set(event.subagentRunId, { messageId, part });
            put(messageId, part);
            break;
          }
          case "SUBAGENT_FINISHED":
          case "SUBAGENT_ERROR": {
            const child = children.get(event.subagentRunId);
            if (!child || !["running", "waiting"].includes(child.part.state)) {
              problem("The child run ended without an active frame.");
              break;
            }
            const part = {
              ...child.part,
              state:
                event.type === "SUBAGENT_ERROR"
                  ? ("failed" as const)
                  : event.outcome
                    ? ("waiting" as const)
                    : ("completed" as const),
            };
            children.set(event.subagentRunId, { ...child, part });
            put(child.messageId, part);
            break;
          }
          case "MESSAGES_SNAPSHOT": {
            if (!finished)
              issues.push(
                issue(
                  "unsupported",
                  "Native snapshots have no settled or attempt flags. Saved text is sealed; use a providerkit snapshot to resume live text.",
                ),
              );
            const messages: DisplayMessage[] = [];
            texts.clear();
            snapshotTools = tools;
            tools = new Map();
            chunks.clear();
            for (const item of event.messages) {
              if (item.role === "tool") {
                const call = item.toolCallId ? tools.get(item.toolCallId) : undefined;
                if (!call) {
                  issues.push(issue("unsupported", "A snapshot tool result has no matching call."));
                  continue;
                }
                const shown =
                  typeof item.content === "string"
                    ? options.tool?.({
                        toolCallId: call.part.id,
                        name: call.part.name ?? "",
                        content: item.content,
                      })
                    : undefined;
                const part: ToolPart = {
                  ...call.part,
                  ...shown,
                  state: item.error ? "failed" : "done",
                };
                tools.set(part.id, { ...call, part, result: true });
                const parent = messages.find((message) => message.id === call.messageId);
                if (parent)
                  parent.parts = parent.parts.map((held) => (held.id === part.id ? part : held));
                continue;
              }
              if (
                (item.role !== "user" && item.role !== "assistant") ||
                !textVisible({
                  messageId: item.id,
                  subagentRunId: item.subagentRunId,
                  role: item.role,
                })
              ) {
                issues.push(issue("hidden", "Private snapshot messages were omitted."));
                continue;
              }
              const parts: DisplayPart[] = [];
              if (typeof item.content === "string")
                parts.push({
                  type: "text",
                  id: item.id,
                  text: item.content,
                  settled: true,
                  ...(item.subagentRunId && { agentId: item.subagentRunId }),
                });
              else if (item.content !== undefined)
                issues.push(
                  issue(
                    "unsupported",
                    "Multimodal native snapshots need a host display projection.",
                  ),
                );
              texts.set(item.id, {
                visible: true,
                ended: true,
                role: item.role,
                agentId: item.subagentRunId,
              });
              for (const call of item.toolCalls ?? []) {
                if (tools.has(call.id)) {
                  problem("The snapshot repeats a tool call id.");
                  break;
                }
                const part: ToolPart = {
                  type: "tool",
                  id: call.id,
                  name: call.function.name,
                  label: options.label?.(call.function.name) ?? call.function.name,
                  state: "running",
                  ...(item.subagentRunId && { agentId: item.subagentRunId }),
                };
                tools.set(call.id, { messageId: item.id, part, ended: true, result: false });
                parts.push(part);
              }
              messages.push({
                id: item.id,
                role: item.role,
                state: parts.some((part) => part.type === "tool" && part.state === "running")
                  ? "live"
                  : "settled",
                parts,
              });
            }
            // Request and child rows have no native message equivalent. Keep the known rows.
            for (const held of view.messages) {
              const keep = held.parts.filter(
                (part) =>
                  part.type === "approval" ||
                  part.type === "question" ||
                  part.type === "client-tool" ||
                  part.type === "agent",
              );
              if (!keep.length) continue;
              const existing = messages.find((item) => item.id === held.id);
              if (existing)
                existing.parts = [
                  ...existing.parts,
                  ...keep.filter((part) => !existing.parts.some((item) => item.id === part.id)),
                ];
              else messages.push({ ...held, parts: keep });
            }
            const clean = displayEvent(
              { v: 1, type: "snapshot", messages, run: view.run, inputs: view.inputs },
              options,
              issues,
              !!options.tool,
            );
            if (clean) emit(clean);
            break;
          }
          case "STATE_SNAPSHOT":
          case "STATE_DELTA": {
            if (!options.state) {
              issues.push(
                issue("hidden", "Shared application state stays hidden and is not retained."),
              );
              break;
            }
            const next =
              event.type === "STATE_SNAPSHOT"
                ? { value: copyJson(event.snapshot) }
                : hasShared
                  ? patchState(shared, event.delta, maxChars)
                  : null;
            if (!next) {
              issues.push(
                issue(
                  "unsupported",
                  "The state patch is unsupported or invalid. The previous state was kept.",
                ),
              );
              break;
            }
            const projected = options.state(copyJson(next.value));
            for (const part of projected) {
              const messageId = wireId("state", binding.agUiRunId);
              const clean = displayEvent(
                { v: 1, type: "part", messageId, part },
                options,
                issues,
                true,
              );
              if (clean) {
                ensure(messageId);
                emit(clean);
              }
            }
            shared = next.value;
            hasShared = true;
            break;
          }
          case "RUN_FINISHED":
          case "RUN_ERROR": {
            if (
              [...texts.values()].some((frame) => !frame.ended) ||
              [...tools.values()].some((frame) => !frame.ended) ||
              [...steps.values()].some((done) => !done)
            ) {
              issues.push(
                issue("incomplete", "The run ended with open frames. Reload its saved snapshot."),
              );
              if (!failureTerminal) break;
              for (const [messageId, frame] of texts) {
                if (!frame.ended) {
                  const part = textPart(messageId);
                  if (frame.visible && part) put(messageId, { ...part, incomplete: true });
                  texts.set(messageId, { ...frame, ended: true });
                }
              }
              for (const [toolId, frame] of tools) tools.set(toolId, { ...frame, ended: true });
              chunks.clear();
            }
            let status: RunInfo["status"] = "completed";
            let error: RunInfo["error"];
            if (event.type === "RUN_ERROR") {
              status = "failed";
              error = options.error?.({ message: event.message, code: event.code }) ?? {
                code: "run_error",
                message: "The run failed. Check its saved state before trying again.",
              };
            } else if (event.outcome?.type === "cancelled") status = "stopped";
            else if (event.outcome?.type === "interrupt") {
              status = "waiting";
              for (const interrupt of event.outcome.interrupts) {
                const call = interrupt.toolCallId ? tools.get(interrupt.toolCallId) : undefined;
                const metadata = interrupt.metadata;
                const fallback: RequestPart =
                  isRecord(metadata) && metadata.kind === "approval"
                    ? {
                        type: "approval",
                        id: interrupt.id,
                        title: "Approval needed",
                        state: "pending",
                        canAnswer: false,
                      }
                    : {
                        type: "question",
                        id: interrupt.id,
                        title: "An answer is needed",
                        state: "pending",
                        canAnswer: false,
                      };
                const selected = options.request?.(interrupt);
                const part: RequestPart = selected ?? {
                  ...fallback,
                  ...(call && { toolId: call.part.id }),
                  ...(interrupt.expiresAt && { expiresAt: Date.parse(interrupt.expiresAt) }),
                };
                if (part.id !== interrupt.id) {
                  problem("The request projection changed its answer key.");
                  break;
                }
                const messageId = call?.messageId ?? wireId("requests", binding.agUiRunId);
                const clean = displayEvent(
                  { v: 1, type: "part", messageId, part },
                  options,
                  issues,
                  !!selected,
                );
                if (clean) {
                  ensure(messageId);
                  emit(clean);
                }
                if (call) {
                  const tool = { ...call.part, state: "waiting" as const };
                  tools.set(tool.id, { ...call, part: tool });
                  put(call.messageId, tool);
                }
              }
            } else if (
              event.outcome?.type === "success" &&
              event.outcome.pendingToolCallIds?.length
            ) {
              status = "waiting";
              issues.push(
                issue(
                  "unsupported",
                  "Pending tool ids do not identify answerable requests. The host must supply request ids and safe input.",
                ),
              );
            }
            if (status !== "waiting")
              for (const message of view.messages)
                if (message.state === "live")
                  emit({
                    v: 1,
                    type: "message",
                    message: {
                      ...message,
                      state:
                        status === "failed"
                          ? "failed"
                          : status === "stopped"
                            ? "stopped"
                            : "settled",
                      parts: [],
                    },
                  });
            run({ status, ...(error && { error }) });
            finished = true;
            break;
          }
          case "ACTIVITY_DELTA":
            if (!safePatch(event.patch))
              issues.push(
                issue(
                  "unsupported",
                  "The activity patch contains unsupported operations or unsafe paths.",
                ),
              );
            else projection(event);
            break;
          default:
            projection(event);
        }
        if (!pending.length && cursor?.seq !== undefined)
          emit({ v: 1, type: "run", run: view.run });
        if (texts.size + tools.size + steps.size + children.size > maxItems)
          issues.push(
            issue("limit", "This stream has too many frame identities. Load a smaller snapshot."),
          );
        if (
          !issues.some(
            (item) =>
              item.code === "framing" ||
              item.code === "limit" ||
              item.code === "invalid" ||
              item.code === "namespace" ||
              (item.code === "incomplete" && !failureTerminal),
          )
        ) {
          let next = view;
          const validated: ChatEvent[] = [];
          for (let index = 0; index < pending.length; index++) {
            const item = pending[index];
            const parsed = displayEvent(item, options, issues, true);
            if (!parsed) break;
            // Only the last output advances a source cursor. Earlier output is an upsert.
            const numbered: ChatEvent =
              index === pending.length - 1 && cursor?.seq !== undefined
                ? { ...parsed, seq: cursor.seq, segment: binding.segment }
                : parsed;
            next = reduceChat(next, numbered);
            validated.push(numbered);
          }
          if (
            validated.length === pending.length &&
            withinView(next, options) &&
            !issues.some((item) => item.code === "invalid" || item.code === "limit")
          ) {
            if (snapshotTools) {
              // Active snapshots can lag live tool rows. Keep exactly the frames the reducer
              // retained, so their eventual results still have a parent and an argument state.
              const reconciled = new Map<string, ToolFrame>();
              for (const message of next.messages) {
                for (const part of message.parts) {
                  if (part.type !== "tool") continue;
                  const frame = tools.get(part.id) ?? snapshotTools.get(part.id);
                  if (frame?.messageId === message.id) reconciled.set(part.id, { ...frame, part });
                }
              }
              tools = reconciled;
            }
            view = next;
            events.push(...validated);
            return result();
          }
          issues.push(
            issue(
              "limit",
              "The projected display exceeds this reader's limit. Nothing was applied.",
            ),
          );
        }
      } catch {
        issues.push(issue("invalid", "The safe projection failed. Nothing was applied."));
      }
      ({ texts, tools, steps, children, shared, hasShared, chunks, started, finished } = before);
      return result();
    },
    end(): AgUiMapping<ChatEvent> {
      closed = true;
      const incomplete =
        extension ||
        (started && !finished) ||
        [...texts.values()].some((frame) => !frame.ended) ||
        [...tools.values()].some((frame) => !frame.ended);
      return {
        events: [],
        issues: incomplete
          ? [
              issue(
                "incomplete",
                "The stream closed before its final event. Reload the saved snapshot; do not resend the run.",
              ),
            ]
          : [],
      };
    },
  };
}
