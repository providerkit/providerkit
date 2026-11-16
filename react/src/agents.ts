/**
 * The server half of an agent chat: `@providerkit/agents` progress and saved runs, turned into
 * display events that are safe to hand to whoever watches the run.
 *
 * Agent events and snapshots carry the input, each tool's arguments and results, the model's
 * reasoning, every specialist's own transcript and raw error text, and a host's run log stores
 * them as they are. None of that may reach a browser by accident. So this file copies across the
 * fields it names below and nothing else, and anything private crosses only when a host callback
 * returns it.
 *
 * It runs no agent, owns no route, stores nothing and checks no caller: the host does all of
 * that, and calls this between its run log and the response. Types only from the SDK and core,
 * so loading this file loads neither.
 */
import type { ToolCall } from "@providerkit/core";
import type {
  AgentEvent,
  AskRecord,
  PendingRequest,
  InputReceipt,
  RunInput,
  RESULT_TOOL_NAME,
  RunSnapshot,
  RunState,
  ToolResult,
} from "@providerkit/agents";
import {
  PROTOCOL_VERSION,
  type AgentPart,
  type AgentState,
  type ApprovalPart,
  type RequestPart,
  type QuestionPart,
  type FormSchema,
  type ChatEnvelope,
  type ChatEvent,
  type DisplayError,
  type DisplayInput,
  type ConversationOwner,
  type DisplayMessage,
  type DisplayPart,
  type MessageState,
  type RunInfo,
  type RunStatus,
  type TextPart,
  type ToolPart,
  type ToolState,
} from "./protocol.ts";

/** One tool call as the host's callbacks see it. Live events and saved runs give the same
 * values, so a callback that reads only these draws the same row both ways. */
export interface ToolActivity {
  /** The SDK's id for this call, and the row's id. */
  operationId: string;
  /** The run that made the call, and the id of that run's agent. */
  runId: string;
  agentId: string;
  /** The call as the model wrote it. `arguments` is raw JSON text holding whatever the model
   * sent, often the user's own data: copy out only what this viewer may see. */
  call: ToolCall;
  /** How the call ended. Absent while it runs. Its `content` is private in the same way. */
  result?: ToolResult;
}

/** What a tool row shows besides its state. `undefined` or `{}` is the default row. */
export interface ToolDisplay {
  /** Defaults to `labels.tool[name]`, then to the tool's name. A call to a tool the agent does
   * not have defaults to "Unknown tool". */
  label?: string;
  /** The key a client looks its own label up by. Defaults to the tool's name, except for a call
   * to a tool the agent does not have: the model made that name up, and it can hold anything,
   * from words on a page it read to the arguments of a call it garbled. */
  name?: string;
  summary?: string;
  detail?: string;
  /** JSON for a custom renderer on the client. */
  data?: unknown;
}

/** Server-only journal data. Never spread this into a display part. */
export type RequestActivity = AskRecord;

export interface RequestDisplay {
  title?: string;
  summary?: string;
  canAnswer?: boolean;
  problem?: DisplayError;
  choices?: QuestionPart["choices"];
  multiple?: boolean;
  freeText?: boolean;
  schema?: FormSchema;
  edit?: ApprovalPart["edit"];
  approveForm?: FormSchema;
  denyForm?: FormSchema;
}

/** A run whose model text could be shown: the one this projector draws, or a specialist. */
export type TextSource =
  | { root: true; runId: string }
  | { root: false; runId: string; agentId: string; handoff: boolean };

export interface AgentProjectorOptions {
  /** The assistant message this run writes into. */
  messageId: string;
  /** The run this projector draws: the `runId` you gave `agent.run`, or the `runId` of its
   * saved snapshot. It stays the same across approval segments. Another run's events are drawn
   * only after a child event named it as a specialist of this one. */
  runId: string;
  /** Registered root agent, when known before a snapshot or handoff event. */
  agentId?: string;
  /** Words for rows, keyed by tool name and by agent id. A missing key shows the name itself. */
  labels?: {
    tool?: Readonly<Record<string, string>>;
    agent?: Readonly<Record<string, string>>;
    /** Optional overrides for a particular run, before the registered-agent label. */
    run?: Readonly<Record<string, string>>;
  };
  /** Return `null` to hide a call. That is decided from the call before it has a result, so a
   * call is shown for its whole life or never. Called again with the result for the final row. */
  tool?: (activity: ToolActivity) => ToolDisplay | null | undefined;
  /** Opts viewer-safe question fields, edited inputs and decision data into display. Without
   * it, questions and client actions show a generic, non-actionable waiting row. */
  request?: (activity: RequestActivity) => RequestDisplay | null | undefined;
  /** Explicitly authorize each device input. Receives effective, approved arguments, NOT the
   * model's original JSON string. The callback must validate and filter for this viewer. */
  clientTools?: Readonly<
    Record<string, (arguments_: Record<string, unknown>, request: PendingRequest) => unknown>
  >;
  /** Without it a failure shows its code and a sentence that says nothing private. */
  error?: (state: Extract<RunState, { status: "failed" | "limited" }>) => DisplayError;
  /** Which runs' model text is shown. Defaults to the root and its conversation handoffs only. */
  text?: (source: TextSource) => boolean;
  /** Viewer-safe text from saved steering input. Never copy raw history or media references. */
  input?: (
    input: RunInput,
    scope: { rootRunId: string; runId: string },
  ) => { text?: string } | undefined;
  /** Parts for a completed run's checked result (the `submit_result` arguments, or the final
   * text of a run without an output contract). Without it the result is not shown. Give the
   * parts ids no SDK operation id can take, and settle them: they are sent unnumbered. */
  output?: (candidate: unknown) => readonly DisplayPart[];
}

export interface AgentProjector {
  /**
   * The display events for one agent event, in order. `meta` is where the event sits in the
   * host's log; only the last event gets the number, and the ones before it are safe to apply
   * twice.
   *
   * What it sends depends on what came before: a text row is created by its first chunk and
   * closed with all of its text, and a request or a specialist that the run leaves behind is
   * closed only by the projector that drew it. So feed one projector every event of the run in
   * order, from the first event of its first segment through each approval segment after it.
   *
   * To resume a client after its cursor, run a fresh projector over the whole log and send only
   * what an entry above the cursor returned. A client with no cursor gets the log from the
   * start up to its last entry, then a `snapshot` read after that, then whatever the log adds.
   * Sent first, the snapshot would be followed by older events, and a run waiting for a
   * decision would look like it was running again.
   */
  event(event: AgentEvent, meta?: Pick<ChatEnvelope, "seq" | "segment">): ChatEvent[];
  /** Call for host RunEvent records agent.gap or agent.resync, then read the journal.
   * Text remains checkpoint-only for this projector after a gap. Never invent an attempt. */
  gap(meta?: Pick<ChatEnvelope, "seq" | "segment">): ChatEvent[];
  /** The message as the saved run has it, with the same row ids the live events use. */
  snapshot(snapshot: RunSnapshot): DisplayMessage;
  /** The run as the saved run has it. */
  run(snapshot: RunSnapshot): RunInfo;
  /** Accepted/consumed receipts only. The host adds still-queued inbox entries to snapshots. */
  inputs(snapshot: RunSnapshot): readonly DisplayInput[];
}

/** Copy only delivery identities; never input content or execution authority. */
export function projectInputReceipt(receipt: InputReceipt): DisplayInput {
  return {
    id: receipt.id,
    rootRunId: receipt.rootRunId,
    runId: receipt.runId,
    status: receipt.status,
  };
}

/** The SDK's reserved tool for a run with an output contract: its arguments are the result.
 * Typed from the SDK's own constant, so a rename there fails this build instead of drawing the
 * result as a tool row, and not imported as a value, so this file loads without the SDK. */
const RESULT_TOOL: typeof RESULT_TOOL_NAME = "submit_result";

const STATUS = {
  running: "running",
  suspended: "waiting",
  completed: "completed",
  cancelled: "stopped",
  limited: "limited",
  failed: "failed",
} as const satisfies Record<RunState["status"], AgentState>;

/** A limit cut the answer short, which reads as stopped rather than failed. */
const MESSAGE = {
  running: "live",
  suspended: "live",
  completed: "settled",
  cancelled: "stopped",
  limited: "stopped",
  failed: "failed",
} as const satisfies Record<RunState["status"], MessageState>;

/** A run's raw failure message can quote a prompt, a tool's output or a key, so the default
 * keeps only the code, which the SDK writes itself, and says nothing more. */
function defaultError(state: Extract<RunState, { status: "failed" | "limited" }>): DisplayError {
  return state.status === "failed"
    ? { code: state.error.code, message: "The agent stopped because of an error." }
    : { code: state.limit, message: "The agent stopped because it reached a limit." };
}

function isOver(state: RunState): boolean {
  return state.status !== "running" && state.status !== "suspended";
}

/** A call to a tool the agent does not have, whose name is the model's own text. Only the result
 * tells, so a save written between the SDK reserving such a call and refusing it still names
 * it. Closing that moment is the SDK's: it would check its tools before it reserves a call. */
function isMadeUp(result: ToolResult | undefined): boolean {
  return result !== undefined && !result.ok && result.kind === "unknown_tool";
}

/** A tool name can come from the model (a call to a tool that does not exist), and "toString"
 * must not find a function on the prototype. */
function lookup(table: Readonly<Record<string, string>> | undefined, key: string): string {
  const value = table && Object.hasOwn(table, key) ? table[key] : undefined;
  return typeof value === "string" ? value : key;
}

function activityOf(request: {
  operationId: string;
  runId: string;
  agentId: string;
  call: ToolCall;
}): ToolActivity {
  const { operationId, runId, agentId, call } = request;
  return { operationId, runId, agentId, call };
}

/** The run an event speaks for. A child event is its parent speaking. */
function speakerOf(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "model_chunk":
    case "operation_restart":
    case "handoff":
    case "state":
      return event.runId;
    case "input":
      return event.receipt.runId;
    case "request":
      return event.request.call.runId;
    case "tool_start":
    case "tool_result":
      return event.request.runId;
    case "child":
      return event.parentRunId;
    default:
      // A newer SDK's event type: skipped, like an unknown display event on the client.
      return undefined;
  }
}

/**
 * Draws one agent run, live and saved, into one assistant message.
 *
 * Rows use the SDK's own ids: a text row is its model operation, a tool row its tool operation,
 * a specialist row its run. A live event and a saved run name the same thing with the same
 * value, which is what lets a client lay a snapshot over replayed progress without doubling a
 * row. Those ids carry the root run id and each child's key, so neither should hold private
 * data.
 *
 * By default nothing private is sent: not the input, the instructions, reasoning, tool
 * arguments or results, a specialist's text, a tool name the model made up, a raw failure
 * message or an approval's actor and resource. A tool row is its label and state, a failure is
 * its code and a plain sentence, and the reserved `submit_result` call is never a row.
 */
export function createAgentProjector(options: AgentProjectorOptions): AgentProjector {
  const { messageId, runId: root } = options;
  if (typeof messageId !== "string" || !messageId)
    throw new TypeError("Give the projector the id of the message this run writes into.");
  // Never guessed from the events: a log read from the middle starts with whatever run spoke
  // there, often a specialist, whose words would then be shown as the answer.
  if (typeof root !== "string" || !root)
    throw new TypeError("Give the projector the id of the run it draws.");
  const showsText = options.text ?? ((source: TextSource) => source.root || source.handoff);
  const v = PROTOCOL_VERSION;
  const conversationRuns = new Set([root]);
  const handoffs = new Map<string, string>();
  let rootAgentId = options.agentId;

  function agentLabel(runId: string, agentId: string): string {
    return options.labels?.run && Object.hasOwn(options.labels.run, runId)
      ? (options.labels.run[runId] ?? lookup(options.labels.agent, agentId))
      : lookup(options.labels?.agent, agentId);
  }

  function owner(): ConversationOwner | undefined {
    let runId = root;
    const visited = new Set<string>();
    while (handoffs.has(runId) && !visited.has(runId)) {
      visited.add(runId);
      runId = handoffs.get(runId)!;
    }
    const agentId = runId === root ? rootAgentId : specialists.get(runId)?.agentId;
    return agentId ? { runId, agentId, label: agentLabel(runId, agentId) } : undefined;
  }

  /** Visibility is asked without the result so that the live row, which is drawn before the
   * call ends, and the saved row agree on it. */
  function describeTool(activity: ToolActivity): ToolDisplay | null {
    if (activity.call.name === RESULT_TOOL) return null;
    if (!options.tool) return {};
    const { result, ...started } = activity;
    const first = options.tool(started);
    if (first === null) return null;
    return (result === undefined ? first : options.tool(activity)) ?? {};
  }

  // `owner`, in the row builders below, is the row of the specialist the part belongs to,
  // absent for the root.

  function textPart(
    id: string,
    text: string,
    settled: boolean,
    owner: string | undefined,
  ): TextPart {
    const part: TextPart = { type: "text", id, text, settled };
    if (owner !== undefined) part.agentId = owner;
    return part;
  }

  function toolPart(
    activity: ToolActivity,
    owner: string | undefined,
    state: ToolState,
  ): ToolPart | null {
    const display = describeTool(activity);
    if (!display) return null;
    const { label, name, summary, detail, data } = display;
    const madeUp = isMadeUp(activity.result);
    const part: ToolPart = {
      type: "tool",
      id: activity.operationId,
      label: label ?? (madeUp ? "Unknown tool" : lookup(options.labels?.tool, activity.call.name)),
      state,
    };
    const key = name ?? (madeUp ? undefined : activity.call.name);
    if (key !== undefined) part.name = key;
    if (summary !== undefined) part.summary = summary;
    if (detail !== undefined) part.detail = detail;
    if (data !== undefined) part.data = data;
    if (owner !== undefined) part.agentId = owner;
    return part;
  }

  function requestPart(record: AskRecord, ended = false): RequestPart {
    const { request, decision, closed } = record;
    const display = options.request?.(record);
    const problem =
      display?.problem ??
      (record.problem
        ? {
            code: record.problem.code,
            message: "The answer was not accepted. Review this request and try again.",
          }
        : undefined);
    const base = {
      id: request.id,
      toolId: request.call.operationId,
      ...(request.call.runId !== root && { agentId: request.call.runId }),
      title:
        display?.title ??
        (request.ask.type === "approval"
          ? lookup(options.labels?.tool, request.call.call.name)
          : "Waiting for a response"),
      expiresAt: request.scope.expiresAt,
      ...(display?.summary !== undefined && { summary: display.summary }),
      ...(problem !== undefined && { problem }),
    };
    const ending =
      closed ??
      (decision?.type === "stop"
        ? "stopped"
        : decision?.type === "cancel"
          ? "cancelled"
          : undefined);
    if (request.ask.type === "approval") {
      return {
        ...base,
        type: "approval",
        state:
          ending ??
          (decision?.type === "approve"
            ? "approved"
            : decision?.type === "deny"
              ? "denied"
              : ended
                ? "stopped"
                : "pending"),
        ...(display === null && { canAnswer: false }),
        ...(display?.canAnswer !== undefined && { canAnswer: display.canAnswer }),
        ...(display?.edit !== undefined && { edit: display.edit }),
        ...(display?.approveForm !== undefined && { approveForm: display.approveForm }),
        ...(display?.denyForm !== undefined && { denyForm: display.denyForm }),
      };
    }
    const state = ending ?? (decision ? "answered" : ended ? "stopped" : "pending");
    if (request.ask.type === "client") {
      const name = request.call.call.name;
      const project =
        options.clientTools && Object.hasOwn(options.clientTools, name)
          ? options.clientTools[name]
          : undefined;
      return {
        ...base,
        type: "client-tool",
        state,
        canAnswer: Boolean(project) && display?.canAnswer !== false && display !== null,
        ...(project && { name, input: project(request.call.arguments, request) }),
      };
    }
    return {
      ...base,
      type: "question",
      state,
      canAnswer: Boolean(display?.title) && display?.canAnswer !== false,
      ...(display?.choices !== undefined && { choices: display.choices }),
      ...(display?.multiple !== undefined && { multiple: display.multiple }),
      ...(display?.freeText !== undefined && { freeText: display.freeText }),
      ...(display?.schema !== undefined && { schema: display.schema }),
    };
  }

  function agentPart(
    runId: string,
    agentId: string,
    parentId: string | undefined,
    state: AgentState,
  ): AgentPart {
    const part: AgentPart = {
      type: "agent",
      id: runId,
      agentId,
      label: agentLabel(runId, agentId),
      state,
      ...(specialists.get(runId)?.kind && { kind: specialists.get(runId)?.kind }),
      ...(specialists.get(runId)?.toolId && { toolId: specialists.get(runId)?.toolId }),
    };
    if (parentId !== undefined) part.parentId = parentId;
    return part;
  }

  function runInfo(runId: string, state: RunState): RunInfo {
    const info: RunInfo = { id: runId, status: STATUS[state.status], messageId, owner: owner() };
    if (state.status === "failed" || state.status === "limited")
      info.error = (options.error ?? defaultError)(state);
    return info;
  }

  // The live side keeps what a later event needs: which runs are specialists, under whom and
  // whether each is over, the text still streaming per run, tool rows still running, and
  // requests still waiting for a decision.
  let announced = false;
  let status: RunStatus = "idle";
  const specialists = new Map<
    string,
    {
      agentId: string;
      parentId: string | undefined;
      over: boolean;
      kind?: "delegation" | "handoff";
      toolId?: string;
    }
  >();
  const textShown = new Map<string, boolean>();
  const streaming = new Map<string, TextPart>();
  // Progress can seal a turn before its checkpoint. Only the journal removes it from this map.
  const uncheckpointed = new Map<string, TextPart>();
  let checkpointOnly = false;

  function gap(meta: Pick<ChatEnvelope, "seq" | "segment"> = {}): ChatEvent[] {
    checkpointOnly = true;
    const out: ChatEvent[] = [];
    for (const text of uncheckpointed.values()) {
      text.incomplete = true;
      out.push({ v, type: "part", messageId, part: { ...text } });
    }
    const last = out.at(-1);
    if (last) out[out.length - 1] = { ...last, ...meta };
    return out;
  }
  const running = new Map<string, { runId: string; part: ToolPart }>();
  const requests = new Map<string, AskRecord>();
  const operations = new Map<
    string,
    { attemptId: string; attempt: number; old: Set<string>; completed: boolean }
  >();
  const endedRuns = new Set<string>();
  const runAttempts = new Map<string, { current: string; old: Set<string> }>();

  function attemptOf(id: string, attemptId: string, previous?: string): number | undefined {
    let held = operations.get(id);
    if (!held) {
      held = {
        attemptId,
        attempt: previous ? 2 : 1,
        old: new Set(previous ? [previous] : []),
        completed: false,
      };
      operations.set(id, held);
    } else if (held.old.has(attemptId) || held.completed) return undefined;
    else if (held.attemptId !== attemptId) {
      held.old.add(held.attemptId);
      if (previous) held.old.add(previous);
      held.attemptId = attemptId;
      held.attempt += 1;
    }
    return held.attempt;
  }

  function shows(runId: string): boolean {
    let shown = textShown.get(runId);
    if (shown === undefined) {
      const specialist = specialists.get(runId);
      shown = showsText(
        specialist
          ? {
              root: false,
              runId,
              agentId: specialist.agentId,
              handoff: conversationRuns.has(runId),
            }
          : { root: true, runId },
      );
      textShown.set(runId, shown);
    }
    return shown;
  }

  function ownerOf(runId: string): string | undefined {
    return runId === root ? undefined : runId;
  }

  /** Whether `runId` is `ancestor` or a specialist under it, at any depth. */
  function within(runId: string, ancestor: string): boolean {
    if (ancestor === root) return true;
    for (let at: string | undefined = runId; at !== undefined; at = specialists.get(at)?.parentId)
      if (at === ancestor) return true;
    return false;
  }

  /** What a run leaves going when it ends stops with it, since nothing will resume it: its
   * calls still running fail, and its specialists still running or waiting stop. A saved run
   * draws them the same way. */
  function endUnder(part: (value: DisplayPart) => void, ended: string): void {
    endedRuns.add(ended);
    for (const [id, record] of requests) {
      if (record.decision || record.closed || !within(record.request.call.runId, ended)) continue;
      const closed: AskRecord = { ...record, closed: "stopped" };
      requests.set(id, closed);
      part(requestPart(closed));
    }
    for (const [id, entry] of running) {
      if (!within(entry.runId, ended)) continue;
      running.delete(id);
      part({ ...entry.part, state: "failed" });
    }
    for (const [runId, specialist] of specialists) {
      if (runId === ended || specialist.over || !within(runId, ended)) continue;
      specialist.over = true;
      endedRuns.add(runId);
      part(agentPart(runId, specialist.agentId, specialist.parentId, "stopped"));
    }
  }

  function event(
    agentEvent: AgentEvent,
    meta: Pick<ChatEnvelope, "seq" | "segment"> = {},
  ): ChatEvent[] {
    const { seq, segment } = meta;
    // A number the client refuses would drop every event silently, so it fails here instead.
    if (seq !== undefined && !(Number.isSafeInteger(seq) && seq >= 0))
      throw new TypeError("A sequence number is a whole number, 0 or more.");
    if (segment !== undefined && (typeof segment !== "string" || !segment))
      throw new TypeError("A segment is a non-empty string.");
    if (agentEvent.type === "input") {
      if (agentEvent.receipt.rootRunId !== root) return [];
      return [{ v, type: "input", input: projectInputReceipt(agentEvent.receipt), ...meta }];
    }
    const speaker =
      agentEvent.type === "decision"
        ? requests.get(agentEvent.requestId)?.request.call.runId
        : speakerOf(agentEvent);
    // A run no child event named here (a log read from the middle, or a child event that was
    // lost) has no row to file under, and it is never taken for the root. The next snapshot
    // draws it.
    if (speaker === undefined || (speaker !== root && !specialists.has(speaker))) return [];
    if (endedRuns.has(root) || endedRuns.has(speaker)) return [];
    if (agentEvent.type === "request") {
      const held = requests.get(agentEvent.request.id);
      if (held?.decision || held?.closed) return [];
    }
    // Tool retries have their own attempt ids; they do not replace the run's model/state epoch.
    const executionAttempt =
      agentEvent.type === "state" ||
      agentEvent.type === "model_chunk" ||
      agentEvent.type === "handoff" ||
      (agentEvent.type === "operation_restart" && agentEvent.kind === "model")
        ? agentEvent.attemptId
        : undefined;
    if (executionAttempt !== undefined) {
      let held = runAttempts.get(speaker);
      if (held?.old.has(executionAttempt)) return [];
      if (!held) {
        held = { current: executionAttempt, old: new Set() };
        runAttempts.set(speaker, held);
      } else if (held.current !== executionAttempt) {
        held.old.add(held.current);
        held.current = executionAttempt;
      }
      if (agentEvent.type === "operation_restart") held.old.add(agentEvent.previousAttemptId);
    }
    let attempt: number | undefined;
    if (agentEvent.type === "model_chunk" || agentEvent.type === "operation_restart") {
      attempt = attemptOf(
        agentEvent.operationId,
        agentEvent.attemptId,
        agentEvent.type === "operation_restart" ? agentEvent.previousAttemptId : undefined,
      );
      if (attempt === undefined) return [];
    }
    if (agentEvent.type === "tool_start" || agentEvent.type === "tool_result") {
      const operation = operations.get(agentEvent.request.operationId);
      if (operation?.completed || operation?.old.has(agentEvent.request.attemptId)) return [];
    }
    const out: ChatEvent[] = [];
    const part = (value: DisplayPart) => out.push({ v, type: "part", messageId, part: value });
    if (!announced) {
      announced = true;
      out.push({
        v,
        type: "message",
        message: { id: messageId, role: "assistant", parts: [], state: "live" },
      });
    }
    const rootState = agentEvent.type === "state" && speaker === root;
    if (!rootState && agentEvent.type !== "decision" && status !== "running") {
      status = "running";
      out.push({ v, type: "run", run: { id: root, status, messageId, owner: owner() } });
    }
    // A run does one thing at a time, so anything else it reports means its last model turn
    // has ended. The text row closes with all of its text, which a client that missed a delta
    // takes whole.
    const open = streaming.get(speaker);
    if (
      open &&
      !(
        (agentEvent.type === "model_chunk" || agentEvent.type === "operation_restart") &&
        agentEvent.operationId === open.id
      )
    ) {
      streaming.delete(speaker);
      const operation = operations.get(open.id);
      if (operation) operation.completed = true;
      open.settled = true;
      part({ ...open });
    }

    switch (agentEvent.type) {
      case "operation_restart":
      case "model_chunk": {
        if (agentEvent.type === "operation_restart" && agentEvent.kind !== "model") break;
        const content =
          !checkpointOnly && agentEvent.type === "model_chunk"
            ? (agentEvent.chunk.content ?? "")
            : "";
        if (!shows(speaker)) break;
        const current = streaming.get(speaker);
        if (
          current &&
          current.id === agentEvent.operationId &&
          (current.attempt ?? 1) === attempt
        ) {
          if (content) {
            current.text += content;
            out.push({
              v,
              type: "text",
              messageId,
              partId: current.id,
              delta: content,
              ...(attempt !== undefined && attempt > 1 && { attempt }),
            });
          }
        } else if (content || checkpointOnly || (attempt !== undefined && attempt > 1)) {
          const created = {
            ...textPart(agentEvent.operationId, content, false, ownerOf(speaker)),
            ...(attempt !== undefined && attempt > 1 && { attempt }),
            ...(checkpointOnly && { incomplete: true }),
          };
          streaming.set(speaker, created);
          uncheckpointed.set(created.id, created);
          part({ ...created });
        }
        break;
      }
      case "request": {
        const request = agentEvent.request;
        const held = requests.get(request.id);
        if (held?.decision || held?.closed) break;
        for (const [id, record] of requests) {
          if (
            id === request.id ||
            record.decision ||
            record.closed ||
            record.request.call.operationId !== request.call.operationId ||
            record.request.ask.type !== request.ask.type ||
            (record.request.ask.type === "question" &&
              request.ask.type === "question" &&
              record.request.ask.key !== request.ask.key)
          )
            continue;
          const closed: AskRecord = { ...record, closed: "stale" };
          requests.set(id, closed);
          part(requestPart(closed));
        }
        const active = running.get(request.call.operationId);
        if (active) {
          active.part = { ...active.part, state: "waiting" };
          part(active.part);
        }
        const record = { request };
        requests.set(request.id, record);
        part(requestPart(record));
        break;
      }
      case "decision": {
        const record = requests.get(agentEvent.requestId);
        if (!record || record.decision || record.closed) break;
        const decided = { ...record, decision: agentEvent.decision };
        requests.set(agentEvent.requestId, decided);
        part(requestPart(decided));
        break;
      }
      case "tool_start": {
        const { request } = agentEvent;
        attemptOf(request.operationId, request.attemptId);
        const row = toolPart(activityOf(request), ownerOf(request.runId), "running");
        if (row) {
          running.set(row.id, { runId: request.runId, part: row });
          part(row);
        }
        break;
      }
      case "tool_result": {
        const { request, result } = agentEvent;
        attemptOf(request.operationId, request.attemptId);
        const operation = operations.get(request.operationId);
        if (operation) operation.completed = true;
        running.delete(request.operationId);
        const row = toolPart(
          { ...activityOf(request), result },
          ownerOf(request.runId),
          result.ok ? "done" : "failed",
        );
        if (row) part(row);
        break;
      }
      case "handoff": {
        const { childRunId, to, from, operationId } = agentEvent;
        if (childRunId === root || within(speaker, childRunId) || endedRuns.has(childRunId)) break;
        if (speaker === root) rootAgentId = from.id;
        handoffs.set(speaker, childRunId);
        if (conversationRuns.has(speaker)) conversationRuns.add(childRunId);
        specialists.set(childRunId, {
          agentId: to.id,
          parentId: ownerOf(speaker),
          over: false,
          kind: "handoff",
          toolId: operationId,
        });
        textShown.delete(childRunId);
        part(agentPart(childRunId, to.id, ownerOf(speaker), "running"));
        out.push({ v, type: "run", run: { id: root, status, messageId, owner: owner() } });
        break;
      }
      case "child": {
        const { runId, agentId } = agentEvent;
        // A run is never filed under itself or under one of its own specialists, so the walk
        // in `within` always ends.
        if (runId === root || within(speaker, runId) || endedRuns.has(runId)) break;
        // Sent again when the child resumes, with the same identity: one row, updated.
        const parentId = ownerOf(speaker);
        specialists.set(runId, {
          kind: "delegation",
          toolId: agentEvent.operationId,
          ...specialists.get(runId),
          agentId,
          parentId,
          over: false,
        });
        part(agentPart(runId, agentId, parentId, "running"));
        break;
      }
      case "state": {
        const { state } = agentEvent;
        const specialist = specialists.get(speaker);
        if (specialist) {
          specialist.over = isOver(state);
          if (specialist.over) endUnder(part, speaker);
          part(agentPart(speaker, specialist.agentId, specialist.parentId, STATUS[state.status]));
          break;
        }
        for (const text of streaming.values()) {
          text.settled = true;
          part({ ...text });
        }
        streaming.clear();
        if (state.status === "running") {
          if (status !== "running") {
            status = "running";
            out.push({ v, type: "run", run: runInfo(root, state) });
          }
          break;
        }
        if (state.status !== "suspended") {
          endUnder(part, root);
          if (state.status === "completed")
            for (const value of options.output?.(state.candidate) ?? []) part(value);
          out.push({
            v,
            type: "message",
            message: { id: messageId, role: "assistant", parts: [], state: MESSAGE[state.status] },
          });
        }
        status = STATUS[state.status];
        out.push({ v, type: "run", run: runInfo(root, state) });
        break;
      }
    }
    const last = out.at(-1);
    if (last && seq !== undefined)
      out[out.length - 1] = segment === undefined ? { ...last, seq } : { ...last, seq, segment };
    return out;
  }

  /** The tree in reading order: each model turn's text, then its calls, and a delegation's
   * specialists right after the call that started them, each followed by its own rows. Live
   * rows arrive in the order things happened, so two specialists that ran at once interleave
   * there and not here. The rows and each agent's own order are the same. */
  function snapshot(saved: RunSnapshot): DisplayMessage {
    if (saved.runId !== root) throw new TypeError("The snapshot belongs to another run.");
    rootAgentId = saved.agentId;
    handoffs.clear();
    conversationRuns.clear();
    conversationRuns.add(root);
    textShown.clear();
    const parts: DisplayPart[] = [];
    status = STATUS[saved.state.status];
    announced = true;

    function visit(node: RunSnapshot, owner: string | undefined, over: boolean): void {
      const ended = over || isOver(node.state);
      const old = new Set(runAttempts.get(node.runId)?.old);
      for (const model of node.models) {
        for (const item of model.interrupted) old.add(item.attemptId);
        if (model.attemptId !== node.attemptId) old.add(model.attemptId);
      }
      old.delete(node.attemptId);
      runAttempts.set(node.runId, { current: node.attemptId, old });
      if (ended) endedRuns.add(node.runId);
      const shown = showsText(
        owner === undefined
          ? { root: true, runId: node.runId }
          : {
              root: false,
              runId: node.runId,
              agentId: node.agentId,
              handoff: conversationRuns.has(node.runId),
            },
      );
      for (const model of node.models) {
        const attempt = model.interrupted.length + 1;
        operations.set(model.id, {
          attemptId: model.attemptId,
          attempt,
          old: new Set(model.interrupted.map((item) => item.attemptId)),
          completed: model.status === "completed" || ended,
        });
        if (model.status === "running") {
          // Even empty text names the saved attempt, replacing partial output from an old one.
          if (shown && (attempt > 1 || checkpointOnly)) {
            const prefix = uncheckpointed.get(model.id);
            parts.push({
              ...textPart(
                model.id,
                checkpointOnly && (prefix?.attempt ?? 1) === attempt ? (prefix?.text ?? "") : "",
                ended,
                owner,
              ),
              ...(attempt > 1 && { attempt }),
              ...(checkpointOnly && { incomplete: true }),
            });
          }
          const live = streaming.get(node.runId);
          if (live && (live.id !== model.id || (live.attempt ?? 1) !== attempt))
            streaming.delete(node.runId);
          continue;
        }
        uncheckpointed.delete(model.id);
        if (streaming.get(node.runId)?.id === model.id) streaming.delete(node.runId);
        const { content, toolCalls = [] } = model.turn.message;
        // A tool-only turn must also settle a gap or restart placeholder while its tools wait.
        if (shown && (content || attempt > 1 || checkpointOnly))
          parts.push({
            ...textPart(model.id, content, true, owner),
            ...(attempt > 1 && { attempt }),
          });
        for (const [index, tool] of model.tools.entries()) {
          if (ended || tool.status === "completed") running.delete(tool.id);
          const questions = (tool.asks ?? []).filter(
            (record) => record.request.ask.type === "question",
          );
          for (const record of tool.asks ?? []) {
            requests.set(record.request.id, record);
            if (record.request.ask.type !== "question")
              parts.push(requestPart(record, ended || tool.status === "completed"));
          }
          const attemptId = tool.status === "pending" ? tool.previousAttemptId : tool.attemptId;
          if (attemptId) {
            const old = new Set([
              ...tool.interrupted.map((item) => item.attemptId),
              ...tool.retries.map((item) => item.attemptId),
            ]);
            operations.set(tool.id, {
              attemptId,
              // A pending replacement has no new attempt yet. Its next start advances this count.
              attempt: old.size + (tool.status === "pending" ? 0 : 1),
              old,
              completed: tool.status === "completed" || ended,
            });
          }
          const call = toolCalls[index];
          if (call && (tool.status !== "pending" || questions.length)) {
            const activity = activityOf({
              operationId: tool.id,
              runId: node.runId,
              agentId: node.agentId,
              call,
            });
            const row =
              tool.status === "completed"
                ? toolPart(
                    { ...activity, result: tool.result },
                    owner,
                    tool.result.ok ? "done" : "failed",
                  )
                : toolPart(
                    activity,
                    owner,
                    ended
                      ? "failed"
                      : questions.some((record) => !record.decision && !record.closed)
                        ? "waiting"
                        : "running",
                  );
            if (row) parts.push(row);
          }
          for (const record of questions)
            parts.push(requestPart(record, ended || tool.status === "completed"));
          const journal = node.delegations.find((entry) => entry.operationId === tool.id);
          for (const child of journal?.children ?? []) {
            const { runId, state } = child.snapshot;
            const agentId =
              journal?.kind === "handoff" ? journal.target.id : child.snapshot.agentId;
            if (journal?.kind === "handoff") {
              handoffs.set(node.runId, runId);
              if (conversationRuns.has(node.runId)) conversationRuns.add(runId);
            }
            const shownState = ended && !isOver(state) ? "stopped" : STATUS[state.status];
            specialists.set(runId, {
              agentId,
              parentId: owner,
              over: ended || isOver(state),
              kind: journal?.kind,
              toolId: journal?.operationId,
            });
            parts.push(agentPart(runId, agentId, owner, shownState));
            visit(child.snapshot, runId, ended);
          }
        }
      }
    }

    visit(saved, undefined, false);
    if (saved.state.status === "completed")
      parts.push(...(options.output?.(saved.state.candidate) ?? []));
    return { id: messageId, role: "assistant", parts, state: MESSAGE[saved.state.status] };
  }

  function savedOwner(saved: RunSnapshot): ConversationOwner {
    if (saved.runId !== root) throw new TypeError("The snapshot belongs to another run.");
    let node = saved;
    let agentId = node.agentId;
    for (;;) {
      const journal = node.delegations.find(
        (entry) => entry.kind === "handoff" && entry.children.length > 0,
      );
      const child = journal?.children[0]?.snapshot;
      if (journal?.kind !== "handoff" || !child) break;
      node = child;
      agentId = journal.target.id;
    }
    return { runId: node.runId, agentId, label: agentLabel(node.runId, agentId) };
  }

  function inputs(saved: RunSnapshot): DisplayInput[] {
    if (saved.runId !== root) throw new TypeError("The snapshot belongs to another run.");
    const result: DisplayInput[] = [];
    function visit(node: RunSnapshot): void {
      for (const input of node.inputs) {
        const display = options.input?.(input, { rootRunId: root, runId: node.runId });
        result.push({
          id: input.id,
          rootRunId: root,
          runId: node.runId,
          status: node.models[input.beforeModel]?.status === "completed" ? "consumed" : "accepted",
          ...(display?.text !== undefined && { text: display.text }),
        });
      }
      for (const entry of node.delegations)
        for (const child of entry.children) visit(child.snapshot);
    }
    visit(saved);
    return result;
  }

  return Object.freeze({
    event,
    gap,
    snapshot,
    inputs,
    run: (saved: RunSnapshot) => ({
      ...runInfo(saved.runId, saved.state),
      owner: savedOwner(saved),
    }),
  });
}
