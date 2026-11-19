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
  TreeNode,
  StepExecution,
  StepKind,
  StepError,
  RunState,
  ToolResult,
} from "@providerkit/agents";
import { isRecord, sameData, type Cursor } from "./state.ts";
import {
  PROTOCOL_VERSION,
  REMOTE_STATUS_UNKNOWN,
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
  type ThinkingPart,
  type ToolPart,
  type ToolState,
} from "./protocol.ts";

/** One tool call as the host's callbacks see it. Live events and saved runs give the same
 * values, so a callback that reads only these draws the same row both ways. */
export interface ToolActivity {
  /** The SDK's id for this call, and the row's id. */
  operationId: string;
  /** Actual program operation for an inner call. No child agent was started. */
  parentOperationId?: string;
  /** The run that made the call, and the id of that run's agent. */
  runId: string;
  agentId: string;
  /** Original call, before approval edits. `arguments` is raw JSON from the model or program,
   * often the user's own data: copy out only what this viewer may see. */
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

/** Server-only step data. Inputs, results, errors and progress require explicit projection. */
export interface StepActivity {
  runId: string;
  workflowId?: string;
  operationId: string;
  key: string;
  kind: StepKind;
  status: StepExecution["status"];
  attemptId?: string;
  input?: unknown;
  result?: unknown;
  error?: StepError;
  progress?: unknown;
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

/** Where an agent event sits in the host's log, and when the host recorded it. */
export interface EventMeta extends Pick<ChatEnvelope, "seq" | "segment"> {
  /** Epoch milliseconds, from the host's log. A thinking row takes when it started and how long
   * it ran from these times, so a replay of the log draws the same numbers the live stream did.
   * Without them the row says only that the model thought. */
  at?: number;
}

export interface AgentProjectorOptions {
  /** The assistant message this run writes into. */
  messageId: string;
  /** The run this projector draws: the `runId` you gave `agent.run`, or the `runId` of its
   * saved snapshot. It stays the same across approval segments. Another run's events are drawn
   * only after a child event named it as a specialist of this one. */
  runId: string;
  /** Registered root agent, when known before a snapshot or handoff event. */
  agentId?: string;
  /** Registered workflow root, instead of agentId. Workflows have no conversation owner. */
  workflowId?: string;
  /** Words for rows, keyed by tool name and by registered definition id. */
  labels?: {
    tool?: Readonly<Record<string, string>>;
    agent?: Readonly<Record<string, string>>;
    workflow?: Readonly<Record<string, string>>;
    /** Explicit safe labels keyed by step key. Unmapped steps have a generic label. */
    step?: Readonly<Record<string, string>>;
    /** Optional overrides for a particular run, before the registered-agent label. */
    run?: Readonly<Record<string, string>>;
  };
  /** Return `null` to hide a call. That is decided from the call before it has a result, so a
   * call is shown for its whole life or never. Called again with the result for the final row. */
  tool?: (activity: ToolActivity) => ToolDisplay | null | undefined;
  /** Viewer-safe step details only. Raw step data stays on the server without this callback. */
  step?: (activity: StepActivity) => Omit<ToolDisplay, "name"> | null | undefined;
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
  /** Which runs' reasoning words are sent, on their thinking rows. Defaults to none. Reasoning can
   * quote the instructions, a tool's output or private data, so by default a thinking row says
   * only that the model thought and for how long. A run gets thinking rows only where `text`
   * shows its text. */
  reasoning?: (source: TextSource) => boolean;
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
  event(event: AgentEvent, meta?: EventMeta): ChatEvent[];
  /** Call for host RunEvent records agent.gap or agent.resync, then read the journal.
   * Text remains checkpoint-only for this projector after a gap. Never invent an attempt. */
  gap(meta?: Pick<ChatEnvelope, "seq" | "segment">): ChatEvent[];
  /** The message as the saved run has it, with the same row ids the live events use. */
  snapshot(snapshot: TreeNode): DisplayMessage;
  /** The run as the saved run has it. */
  run(snapshot: TreeNode): RunInfo;
  /** Accepted/consumed receipts only. The host adds still-queued inbox entries to snapshots. */
  inputs(snapshot: TreeNode): readonly DisplayInput[];
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
    ? {
        code: state.error.code,
        message: "The run could not finish. Check its saved result before trying again.",
      }
    : {
        code: state.limit,
        message: "The run reached a limit. Review the result before starting more work.",
      };
}

type RemoteState = NonNullable<AgentPart["remoteState"]>;
function remoteState(state: RemoteState | undefined, detached = false): AgentState {
  if (state === "completed") return "completed";
  if (state === "canceled") return "stopped";
  if (state === "failed" || state === "rejected") return "failed";
  if (detached) return "unknown";
  return state === "input_required" || state === "auth_required" || state === "unknown"
    ? "waiting"
    : "running";
}

function stepState(status: StepExecution["status"], ended: boolean): ToolState {
  if (status === "completed") return "done";
  if (status === "failed" || ended) return "failed";
  return status === "running" ? "running" : "waiting";
}

function isOver(state: RunState): boolean {
  return state.status !== "running" && state.status !== "suspended";
}

/** A stretch of thinking open when the run reports this state did not end, it was cut: by a
 * failure, a stop, a limit, or the run starting again after an interruption. A turn that
 * finished or paused for an answer ended its thinking first. */
function cutsThinking(state: RunState): boolean {
  return state.status !== "completed" && state.status !== "suspended";
}

/** A model call's thinking row sits beside its text row, whose id is the call's operation id.
 * SDK operation ids end in `/model/N`, `/tool/N` or `/child/key`, never in this. */
function thinkingId(operationId: string): string {
  return `${operationId}/thinking`;
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
  parentOperationId?: string;
  runId: string;
  agentId: string;
  call: ToolCall;
}): ToolActivity {
  const { operationId, parentOperationId, runId, agentId, call } = request;
  return { operationId, ...(parentOperationId && { parentOperationId }), runId, agentId, call };
}

function requestOrigin(request: PendingRequest) {
  return request.call ?? request.step;
}

/** The two journals share children, not model history or execution inputs. */
function childrenOf(node: TreeNode): TreeNode[] {
  if (node.kind === "remote") return [];
  const journals = node.kind === "workflow" ? node.steps : node.delegations;
  return journals.flatMap((entry) => entry.children.map((child) => child.snapshot));
}

function savedWaiting(node: TreeNode): Pick<RunInfo, "waitingFor" | "wakeAt"> {
  if (isOver(node.state)) return {};
  if (node.kind === "remote")
    return {
      waitingFor: node.remote.sends.some((send) =>
        send.asks?.some((record) => !record.decision && !record.closed),
      )
        ? "response"
        : "continuation",
      ...(node.remote.wakeAt !== undefined && { wakeAt: node.remote.wakeAt }),
    };
  const executions =
    node.kind === "workflow"
      ? node.steps
      : node.models.flatMap((model) => (model.status === "completed" ? model.tools : []));
  let response = executions.some(
    (entry) =>
      entry.status !== "completed" &&
      entry.status !== "failed" &&
      entry.asks?.some((record) => !record.decision && !record.closed),
  );
  const wakes =
    node.kind === "workflow"
      ? node.steps.flatMap((step) =>
          (step.status === "waiting" || step.status === "retrying") && step.wakeAt !== undefined
            ? [step.wakeAt]
            : [],
        )
      : [];
  for (const child of childrenOf(node)) {
    const waiting = savedWaiting(child);
    response ||= waiting.waitingFor === "response";
    if (waiting.wakeAt !== undefined) wakes.push(waiting.wakeAt);
  }
  return {
    waitingFor: response ? "response" : "continuation",
    ...(wakes.length && { wakeAt: Math.min(...wakes) }),
  };
}

/** The run an event speaks for. A child event is its parent speaking. */
function speakerOf(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "model_chunk":
    case "operation_restart":
    case "handoff":
    case "state":
    case "step_start":
    case "step_progress":
    case "step_result":
    case "remote_status":
      return event.runId;
    case "input":
      return event.receipt.runId;
    case "request":
      return requestOrigin(event.request).runId;
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
 * its code and a plain sentence, a thinking row is when the model thought and for how long, and
 * the reserved `submit_result` call is never a row.
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
  let rootWorkflowId = options.workflowId;
  let rootRemote = false;
  const remoteStates = new Map<string, RemoteState>();
  if (rootAgentId && rootWorkflowId)
    throw new TypeError("Choose an agent or workflow root, not both.");

  function agentLabel(runId: string, definitionId: string, workflow = false): string {
    const labels = workflow ? options.labels?.workflow : options.labels?.agent;
    return options.labels?.run && Object.hasOwn(options.labels.run, runId)
      ? (options.labels.run[runId] ?? lookup(labels, definitionId))
      : lookup(labels, definitionId);
  }

  function owner(): ConversationOwner | undefined {
    let runId = root;
    const visited = new Set<string>();
    while (handoffs.has(runId) && !visited.has(runId)) {
      visited.add(runId);
      runId = handoffs.get(runId)!;
    }
    const specialist = specialists.get(runId);
    if (rootRemote || specialist?.kind === "workflow" || specialist?.kind === "remote")
      return undefined;
    const agentId = runId === root ? rootAgentId : specialist?.definitionId;
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
    attempt = operations.get(activity.operationId)?.attempt ?? 1,
  ): ToolPart | null {
    const display = describeTool(activity);
    if (!display) return null;
    const { label, name, summary, detail, data } = display;
    const madeUp = isMadeUp(activity.result);
    const part: ToolPart = {
      type: "tool",
      id: activity.operationId,
      ...(activity.parentOperationId && { parentOperationId: activity.parentOperationId }),
      ...(attempt > 1 && { attempt }),
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

  function stepPart(activity: StepActivity, state: ToolState, attempt?: number): ToolPart | null {
    const display = options.step?.(activity);
    if (display === null) return null;
    const label =
      options.labels?.step && Object.hasOwn(options.labels.step, activity.key)
        ? options.labels.step[activity.key]
        : undefined;
    return {
      type: "tool",
      kind: "step",
      id: activity.operationId,
      label:
        display?.label ?? label ?? (activity.kind === "sleep" ? "Waiting to continue" : "Step"),
      state,
      ...(attempt !== undefined && { attempt }),
      ...(activity.runId !== root && { agentId: activity.runId }),
      ...(display?.summary !== undefined && { summary: display.summary }),
      ...(display?.detail !== undefined && { detail: display.detail }),
      ...(display?.data !== undefined && { data: display.data }),
    };
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
    const origin = requestOrigin(request);
    const approvalTitle = request.call
      ? lookup(options.labels?.tool, request.call.call.name)
      : "Approval needed";
    const base = {
      id: request.id,
      toolId: origin.operationId,
      ...(origin.runId !== root && { agentId: origin.runId }),
      title:
        display?.title ??
        (request.ask.type === "approval" ? approvalTitle : "Waiting for a response"),
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
        // Programs cannot suspend for a browser answer. These are immediate-decision receipts.
        ...(request.call?.parentOperationId && { canAnswer: false }),
        ...(display?.edit !== undefined && { edit: display.edit }),
        ...(display?.approveForm !== undefined && { approveForm: display.approveForm }),
        ...(display?.denyForm !== undefined && { denyForm: display.denyForm }),
      };
    }
    const state = ending ?? (decision ? "answered" : ended ? "stopped" : "pending");
    if (request.ask.type === "client") {
      const name = request.call?.call.name;
      const project =
        name && options.clientTools && Object.hasOwn(options.clientTools, name)
          ? options.clientTools[name]
          : undefined;
      return {
        ...base,
        type: "client-tool",
        state,
        canAnswer: Boolean(project) && display?.canAnswer !== false && display !== null,
        ...(project && request.call && { name, input: project(request.call.arguments, request) }),
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
    const workflow = specialists.get(runId)?.kind === "workflow";
    const part: AgentPart = {
      type: "agent",
      id: runId,
      ...(workflow ? { workflowId: agentId } : { agentId }),
      label: agentLabel(runId, agentId, workflow),
      state,
      ...(specialists.get(runId)?.kind && { kind: specialists.get(runId)?.kind }),
      ...(specialists.get(runId)?.toolId && { toolId: specialists.get(runId)?.toolId }),
      ...(specialists.get(runId)?.kind === "remote" && {
        ...(remoteStates.has(runId) && { remoteState: remoteStates.get(runId) }),
        ...(state === "unknown" && { summary: REMOTE_STATUS_UNKNOWN }),
      }),
    };
    if (parentId !== undefined) part.parentId = parentId;
    return part;
  }

  function runInfo(runId: string, state: RunState): RunInfo {
    const info: RunInfo = { id: runId, status: STATUS[state.status], messageId, owner: owner() };
    if (state.status === "failed" || state.status === "limited")
      info.error = (options.error ?? defaultError)(state);
    if (rootRemote) {
      info.owner = undefined;
      info.remoteState = remoteStates.get(runId);
      if (isOver(state) && remoteState(info.remoteState, true) === "unknown")
        info.error = { code: "remote_status_unknown", message: REMOTE_STATUS_UNKNOWN };
    }
    if (state.status === "suspended") {
      info.waitingFor = [...requests.values()].some((record) => !record.decision && !record.closed)
        ? "response"
        : "continuation";
    }
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
      definitionId: string;
      parentId: string | undefined;
      over: boolean;
      kind?: AgentPart["kind"];
      toolId?: string;
    }
  >();
  const textShown = new Map<string, boolean>();
  const wordsShown = new Map<string, boolean>();
  const streaming = new Map<string, TextPart>();
  // A run's thinking row while the model thinks, by run like `streaming`, and each model call's
  // row as last sent, by row id, so a snapshot draws the same row with the same numbers.
  const thinking = new Map<string, ThinkingPart>();
  const thoughts = new Map<string, ThinkingPart>();
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
    // The missing progress may hold where a stretch of thinking ended, so its length is unknown.
    for (const runId of [...thinking.keys()])
      closeThinking(runId, undefined, true, (part) =>
        out.push({ v, type: "part", messageId, part }),
      );
    const last = out.at(-1);
    if (last) out[out.length - 1] = { ...last, ...meta };
    return out;
  }

  /** Ends a run's stretch of thinking at `at`. A stretch that a failure, a stop, a restart or
   * missing progress cut short keeps no length: it did not end, the turn did, so the number would
   * measure the failure and not the thinking. */
  function closeThinking(
    runId: string,
    at: number | undefined,
    cut: boolean,
    part: (value: DisplayPart) => void,
  ): void {
    const row = thinking.get(runId);
    if (!row) return;
    thinking.delete(runId);
    row.settled = true;
    if (!cut && row.startedAt !== undefined && at !== undefined)
      row.durationMs = Math.max(0, at - row.startedAt);
    part({ ...row });
  }
  const running = new Map<string, { runId: string; part: ToolPart }>();
  const closedCalls = new Set<string>();
  const stepActivities = new Map<string, StepActivity>();
  const requests = new Map<string, AskRecord>();
  function rememberRequest(incoming: AskRecord): AskRecord {
    const held = requests.get(incoming.request.id);
    // A pending checkpoint may precede an observed decision. A changed scope, closure or
    // problem is authoritative, so only an exact, still-pending copy keeps settled evidence.
    const record =
      held &&
      (held.decision || held.closed) &&
      !incoming.decision &&
      !incoming.closed &&
      !incoming.problem &&
      sameData(held.request, incoming.request)
        ? held
        : incoming;
    requests.set(record.request.id, record);
    return record;
  }
  const operations = new Map<
    string,
    { attemptId: string; attempt: number; old: Set<string>; completed: boolean }
  >();
  const endedRuns = new Set<string>();
  const runAttempts = new Map<string, { current: string; old: Set<string> }>();

  function attemptOf(
    id: string,
    attemptId: string,
    previous?: string,
    number?: number,
  ): number | undefined {
    let held = operations.get(id);
    if (!held) {
      held = {
        attemptId,
        attempt: number ?? (previous ? 2 : 1),
        old: new Set(previous ? [previous] : []),
        completed: false,
      };
      operations.set(id, held);
    } else if (
      held.old.has(attemptId) ||
      (held.completed && !(previous === held.attemptId && previous !== attemptId)) ||
      (number !== undefined && number < held.attempt)
    )
      return undefined;
    else if (held.attemptId !== attemptId) {
      held.old.add(held.attemptId);
      if (previous) held.old.add(previous);
      held.attemptId = attemptId;
      held.attempt = number ?? held.attempt + 1;
      held.completed = false;
    }
    return held.attempt;
  }

  function toolAttempt(operationId: string, attemptId: string): void {
    const held = operations.get(operationId);
    // A delegation continuation changes the run epoch without retrying the tool. Advance only
    // for a recorded pending replacement here; live retries already have operation_restart.
    const number = held
      ? held.attempt + Number(held.old.has(held.attemptId) && held.attemptId !== attemptId)
      : 1;
    attemptOf(operationId, attemptId, undefined, Math.max(1, number));
  }

  function sourceOf(runId: string): TextSource {
    const specialist = specialists.get(runId);
    return specialist
      ? {
          root: false,
          runId,
          agentId: specialist.definitionId,
          handoff: conversationRuns.has(runId),
        }
      : { root: true, runId };
  }

  function shows(runId: string): boolean {
    let shown = textShown.get(runId);
    if (shown === undefined) {
      const specialist = specialists.get(runId);
      if (specialist?.kind === "workflow" || (runId === root && rootWorkflowId !== undefined))
        return false;
      shown = showsText(sourceOf(runId));
      textShown.set(runId, shown);
    }
    return shown;
  }

  /** Whether a run's thinking rows carry its reasoning words. Only where its text shows, and only
   * when the host said yes in so many words. */
  function showsWords(runId: string): boolean {
    if (!options.reasoning || !shows(runId)) return false;
    let shown = wordsShown.get(runId);
    if (shown === undefined) {
      shown = options.reasoning(sourceOf(runId)) === true;
      wordsShown.set(runId, shown);
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
      if (record.decision || record.closed || !within(requestOrigin(record.request).runId, ended))
        continue;
      const closed: AskRecord = { ...record, closed: "stopped" };
      requests.set(id, closed);
      part(requestPart(closed));
    }
    for (const [id, entry] of running) {
      if (!within(entry.runId, ended)) continue;
      running.delete(id);
      part({ ...entry.part, state: "failed" });
    }
    for (const runId of [...thinking.keys()])
      if (within(runId, ended)) closeThinking(runId, undefined, true, part);
    for (const [runId, specialist] of specialists) {
      if (runId === ended || specialist.over || !within(runId, ended)) continue;
      specialist.over = true;
      endedRuns.add(runId);
      part(
        agentPart(
          runId,
          specialist.definitionId,
          specialist.parentId,
          specialist.kind === "remote" ? remoteState(remoteStates.get(runId), true) : "stopped",
        ),
      );
    }
  }

  /** A restarted or finished VM cannot keep an earlier inner call open. */
  function endProgram(part: (value: DisplayPart) => void, operationId: string): void {
    for (const [id, entry] of running) {
      if (entry.part.parentOperationId !== operationId) continue;
      closedCalls.add(id);
      running.delete(id);
      part({ ...entry.part, state: "failed" });
    }
    for (const [id, record] of requests) {
      if (
        record.request.call?.parentOperationId !== operationId ||
        record.decision ||
        record.closed
      )
        continue;
      const closed: AskRecord = { ...record, closed: "stopped" };
      requests.set(id, closed);
      part(requestPart(closed));
    }
  }

  function pauseUnder(part: (value: DisplayPart) => void, paused: string): void {
    for (const entry of running.values()) {
      if (entry.part.kind !== "step" || !within(entry.runId, paused)) continue;
      entry.part = { ...entry.part, state: "waiting" };
      const activity = stepActivities.get(entry.part.id);
      if (activity?.status === "running") activity.status = "waiting";
      part(entry.part);
    }
  }

  function event(agentEvent: AgentEvent, meta: EventMeta = {}): ChatEvent[] {
    const { seq, segment, at } = meta;
    // A number the client refuses would drop every event silently, so it fails here instead.
    if (seq !== undefined && !(Number.isSafeInteger(seq) && seq >= 0))
      throw new TypeError("A sequence number is a whole number, 0 or more.");
    if (segment !== undefined && (typeof segment !== "string" || !segment))
      throw new TypeError("A segment is a non-empty string.");
    if (at !== undefined && !Number.isFinite(at))
      throw new TypeError("A time is a finite number of epoch milliseconds.");
    if (agentEvent.type === "input") {
      if (agentEvent.receipt.rootRunId !== root) return [];
      return [
        {
          v,
          type: "input",
          input: projectInputReceipt(agentEvent.receipt),
          ...(seq !== undefined && { seq }),
          ...(segment !== undefined && { segment }),
        },
      ];
    }
    const decidedRequest =
      agentEvent.type === "decision" ? requests.get(agentEvent.requestId)?.request : undefined;
    const speaker =
      agentEvent.type === "decision"
        ? decidedRequest && requestOrigin(decidedRequest).runId
        : speakerOf(agentEvent);
    // A run no child event named here (a log read from the middle, or a child event that was
    // lost) has no row to file under, and it is never taken for the root. The next snapshot
    // draws it.
    if (speaker === undefined || (speaker !== root && !specialists.has(speaker))) return [];
    if (endedRuns.has(root) || endedRuns.has(speaker)) return [];
    if (agentEvent.type === "request") {
      if (closedCalls.has(requestOrigin(agentEvent.request).operationId)) return [];
      const held = requests.get(agentEvent.request.id);
      if (held?.decision || held?.closed) return [];
    }
    // Tool retries have their own attempt ids; they do not replace the run's model/state epoch.
    const executionAttempt =
      agentEvent.type === "state" ||
      agentEvent.type === "remote_status" ||
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
    if (agentEvent.type === "operation_restart" && closedCalls.has(agentEvent.operationId))
      return [];
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
      if (closedCalls.has(agentEvent.request.operationId)) return [];
      const operation = operations.get(agentEvent.request.operationId);
      if (operation?.completed || operation?.old.has(agentEvent.request.attemptId)) return [];
    }
    if (
      agentEvent.type === "step_start" ||
      agentEvent.type === "step_progress" ||
      agentEvent.type === "step_result"
    ) {
      const held = operations.get(agentEvent.operationId);
      if (held?.completed || held?.old.has(agentEvent.attemptId)) return [];
      if (agentEvent.type === "step_start") {
        if (held && agentEvent.kind === "step" && agentEvent.attempt < held.attempt) return [];
        if (
          held?.attemptId === agentEvent.attemptId &&
          stepActivities.get(agentEvent.operationId)?.status !== "running"
        )
          return [];
      } else if (held && held.attemptId !== agentEvent.attemptId) return [];
      if (
        agentEvent.type === "step_progress" &&
        (!held || stepActivities.get(agentEvent.operationId)?.status !== "running")
      )
        return [];
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
    // So does its stretch of thinking. Another attempt of the call, a restart or a failure cuts it
    // short instead.
    const thought = thinking.get(speaker);
    const sameCall =
      agentEvent.type === "model_chunk" &&
      thought?.id === thinkingId(agentEvent.operationId) &&
      (thought.attempt ?? 1) === attempt;
    const cut =
      agentEvent.type === "model_chunk" ||
      agentEvent.type === "operation_restart" ||
      (agentEvent.type === "state" && cutsThinking(agentEvent.state));
    if (thought && !sameCall) closeThinking(speaker, at, cut, part);

    switch (agentEvent.type) {
      case "remote_status": {
        remoteStates.set(speaker, agentEvent.state);
        const specialist = specialists.get(speaker);
        if (speaker === root) {
          rootRemote = true;
          out.push({ v, type: "run", run: runInfo(root, { status: "running" }) });
        }
        if (specialist?.kind === "remote")
          part(
            agentPart(
              speaker,
              specialist.definitionId,
              specialist.parentId,
              remoteState(agentEvent.state),
            ),
          );
        break;
      }
      case "step_start":
      case "step_progress":
      case "step_result": {
        const { operationId, attemptId, runId, key } = agentEvent;
        const previous = stepActivities.get(operationId);
        if (agentEvent.type === "step_progress" && !previous) break;
        const kind = agentEvent.type === "step_progress" ? previous!.kind : agentEvent.kind;
        let stepStatus: StepExecution["status"] = "running";
        if (agentEvent.type === "step_result") stepStatus = agentEvent.status;
        const activity: StepActivity = {
          runId,
          operationId,
          attemptId,
          key,
          kind,
          status: stepStatus,
          workflowId: runId === root ? rootWorkflowId : specialists.get(runId)?.definitionId,
          ...(agentEvent.type === "step_progress" && { progress: agentEvent.data }),
          ...(agentEvent.type === "step_result" && agentEvent.error && { error: agentEvent.error }),
        };
        const attempt = attemptOf(
          operationId,
          attemptId,
          undefined,
          agentEvent.type === "step_start" ? (kind === "step" ? agentEvent.attempt : 1) : undefined,
        );
        if (attempt === undefined) break;
        stepActivities.set(operationId, activity);
        const state = stepState(stepStatus, false);
        const row = stepPart(activity, state, attempt);
        if (state === "done" || state === "failed") {
          const operation = operations.get(operationId);
          if (operation) operation.completed = true;
          running.delete(operationId);
        } else if (row) running.set(operationId, { runId, part: row });
        if (row) part(row);
        break;
      }
      case "operation_restart":
      case "model_chunk": {
        if (agentEvent.type === "operation_restart" && agentEvent.kind !== "model") {
          endProgram(part, agentEvent.operationId);
          break;
        }
        const content =
          !checkpointOnly && agentEvent.type === "model_chunk"
            ? (agentEvent.chunk.content ?? "")
            : "";
        if (!shows(speaker)) break;
        if (agentEvent.type === "model_chunk") {
          const { chunk } = agentEvent;
          const id = thinkingId(agentEvent.operationId);
          const number = attempt ?? 1;
          if (chunk.reasoning) {
            const stretch = thinking.get(speaker);
            const held = thoughts.get(id);
            // The check above closed any other call's row, so an open one is this call's.
            if (stretch) {
              if (stretch.text !== undefined && !checkpointOnly) {
                stretch.text += chunk.reasoning;
                out.push({
                  v,
                  type: "text",
                  messageId,
                  partId: id,
                  delta: chunk.reasoning,
                  ...(number > 1 && { attempt: number }),
                });
              }
              // ponytail: one row per call attempt, so thinking that resumes after the answer
              // began shows no second row, and its words arrive with the saved turn. Give the
              // row an ordinal if a model is ever seen doing that.
            } else if (!held || (held.attempt ?? 1) < number) {
              const owner = ownerOf(speaker);
              const row: ThinkingPart = {
                type: "thinking",
                id,
                settled: false,
                ...(at !== undefined && { startedAt: at }),
                ...(showsWords(speaker) && { text: checkpointOnly ? "" : chunk.reasoning }),
                ...(number > 1 && { attempt: number }),
                ...(owner !== undefined && { agentId: owner }),
              };
              thinking.set(speaker, row);
              thoughts.set(id, row);
              part({ ...row });
            }
          }
          // Anything the reader sees, or the call's own end, ends the stretch.
          if (
            chunk.content ||
            chunk.toolCalls?.length ||
            chunk.hosted?.length ||
            chunk.type === "finish"
          )
            closeThinking(speaker, at, false, part);
        }
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
            requestOrigin(record.request).operationId !== requestOrigin(request).operationId ||
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
        const active = running.get(requestOrigin(request).operationId);
        if (active) {
          active.part = { ...active.part, state: "waiting" };
          part(active.part);
        } else if (request.call?.parentOperationId) {
          const row = toolPart(activityOf(request.call), ownerOf(speaker), "waiting");
          if (row) {
            running.set(row.id, { runId: speaker, part: row });
            part(row);
          }
        } else if (request.step) {
          const activity: StepActivity = { ...request.step, status: "waiting" };
          if (speaker === root) rootWorkflowId = request.step.workflowId;
          stepActivities.set(activity.operationId, activity);
          const row = stepPart(
            activity,
            "waiting",
            operations.get(activity.operationId)?.attempt ?? 1,
          );
          if (row) {
            running.set(row.id, { runId: speaker, part: row });
            part(row);
          }
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
        toolAttempt(request.operationId, request.attemptId);
        const row = toolPart(activityOf(request), ownerOf(request.runId), "running");
        if (row) {
          running.set(row.id, { runId: request.runId, part: row });
          part(row);
        }
        break;
      }
      case "tool_result": {
        const { request, result } = agentEvent;
        toolAttempt(request.operationId, request.attemptId);
        const operation = operations.get(request.operationId);
        if (operation) operation.completed = true;
        running.delete(request.operationId);
        endProgram(part, request.operationId);
        for (const [id, record] of requests) {
          if (
            requestOrigin(record.request).operationId !== request.operationId ||
            record.decision ||
            record.closed
          )
            continue;
          const closed: AskRecord = { ...record, closed: "stopped" };
          requests.set(id, closed);
          part(requestPart(closed));
        }
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
          definitionId: to.id,
          parentId: ownerOf(speaker),
          over: false,
          kind: "handoff",
          toolId: operationId,
        });
        textShown.delete(childRunId);
        wordsShown.delete(childRunId);
        part(agentPart(childRunId, to.id, ownerOf(speaker), "running"));
        out.push({ v, type: "run", run: { id: root, status, messageId, owner: owner() } });
        break;
      }
      case "child": {
        const { runId } = agentEvent;
        const definitionId =
          agentEvent.kind === "workflow" ? agentEvent.workflowId : agentEvent.agentId;
        // A run is never filed under itself or under one of its own specialists, so the walk
        // in `within` always ends.
        if (runId === root || within(speaker, runId) || endedRuns.has(runId)) break;
        const parentId = ownerOf(speaker);
        let kind: AgentPart["kind"] = specialists.get(runId)?.kind ?? "delegation";
        if (agentEvent.kind === "workflow") kind = "workflow";
        else if (agentEvent.kind === "remote") kind = "remote";
        specialists.set(runId, {
          kind,
          toolId: agentEvent.operationId,
          definitionId,
          parentId,
          over: false,
        });
        part(agentPart(runId, definitionId, parentId, "running"));
        break;
      }
      case "state": {
        const { state } = agentEvent;
        const specialist = specialists.get(speaker);
        if (state.status === "suspended") pauseUnder(part, speaker);
        if (specialist) {
          specialist.over = isOver(state);
          if (specialist.over) endUnder(part, speaker);
          part(
            agentPart(
              speaker,
              specialist.definitionId,
              specialist.parentId,
              specialist.kind === "remote"
                ? remoteState(
                    remoteStates.get(speaker),
                    state.status !== "completed" && isOver(state),
                  )
                : STATUS[state.status],
            ),
          );
          break;
        }
        for (const text of streaming.values()) {
          text.settled = true;
          part({ ...text });
        }
        streaming.clear();
        // The root's own row closed above. A specialist still thinking now did not finish.
        for (const runId of [...thinking.keys()]) closeThinking(runId, at, true, part);
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

  /** The thinking row a saved model call shows: the row the live stream drew for it, with the
   * save's words when they are shown, or else a row from the save alone, which has no times to
   * give. A stretch the save shows is over closes here, short of a length, so no client keeps
   * showing it as still thinking. */
  function savedThought(
    runId: string,
    model: RunSnapshot["models"][number],
    attempt: number,
    ended: boolean,
    owner: string | undefined,
    words: boolean,
  ): ThinkingPart | undefined {
    const id = thinkingId(model.id);
    const thought = thoughts.get(id);
    const current = thought !== undefined && (thought.attempt ?? 1) === attempt;
    if (
      thought &&
      thinking.get(runId) === thought &&
      (!current || ended || model.status === "completed")
    ) {
      thinking.delete(runId);
      thought.settled = true;
    }
    const reasoning = model.status === "completed" ? model.turn.message.reasoning : undefined;
    let row = thought && { ...thought };
    if (reasoning && !current)
      row = {
        type: "thinking",
        id,
        settled: true,
        ...(attempt > 1 && { attempt }),
        ...(owner !== undefined && { agentId: owner }),
      };
    if (row && words && reasoning !== undefined) row.text = reasoning;
    return row;
  }

  /** The tree in reading order: each model turn's text, then its calls, and a delegation's
   * specialists right after the call that started them, each followed by its own rows. Live
   * rows arrive in the order things happened, so two specialists that ran at once interleave
   * there and not here. The rows and each agent's own order are the same. */
  function snapshot(saved: TreeNode): DisplayMessage {
    if (saved.runId !== root) throw new TypeError("The snapshot belongs to another run.");
    rootAgentId = saved.kind === "agent" ? saved.agentId : undefined;
    rootWorkflowId = saved.kind === "workflow" ? saved.workflowId : undefined;
    rootRemote = saved.kind === "remote";
    handoffs.clear();
    conversationRuns.clear();
    conversationRuns.add(root);
    textShown.clear();
    wordsShown.clear();
    const parts: DisplayPart[] = [];
    status = STATUS[saved.state.status];
    announced = true;

    function visitChild(
      child: TreeNode,
      parentRunId: string,
      owner: string | undefined,
      ended: boolean,
      operationId: string,
      kind: "delegation" | "handoff" = "delegation",
    ): void {
      const { runId, state } = child;
      const definitionId = child.kind === "workflow" ? child.workflowId : child.agentId;
      if (child.kind === "remote" && child.remote.state !== undefined)
        remoteStates.set(runId, child.remote.state);
      if (kind === "handoff" && child.kind === "agent") {
        handoffs.set(parentRunId, runId);
        if (conversationRuns.has(parentRunId)) conversationRuns.add(runId);
      }
      specialists.set(runId, {
        definitionId,
        parentId: owner,
        over: ended || isOver(state),
        kind: child.kind === "workflow" ? "workflow" : child.kind === "remote" ? "remote" : kind,
        toolId: operationId,
      });
      const shownState =
        child.kind === "remote"
          ? remoteState(
              child.remote.state,
              (ended && !isOver(state)) || (state.status !== "completed" && isOver(state)),
            )
          : ended && !isOver(state)
            ? "stopped"
            : STATUS[state.status];
      parts.push(agentPart(runId, definitionId, owner, shownState));
      visit(child, runId, ended);
    }

    function visit(node: TreeNode, owner: string | undefined, over: boolean): void {
      const ended = over || isOver(node.state);
      if (node.kind === "remote") {
        if (node.remote.state !== undefined) remoteStates.set(node.runId, node.remote.state);
        const held = runAttempts.get(node.runId);
        if (!held?.old.has(node.attemptId)) {
          const old = new Set(held?.old);
          if (held && held.current !== node.attemptId) old.add(held.current);
          runAttempts.set(node.runId, { current: node.attemptId, old });
        }
        if (ended) endedRuns.add(node.runId);
        for (const send of node.remote.sends)
          for (const record of (send.asks ?? []).map(rememberRequest))
            parts.push(requestPart(record, ended));
        if (shows(node.runId)) {
          const content = node.remote.artifacts.length
            ? node.remote.artifacts.flatMap((artifact) => artifact.parts)
            : node.remote.state === "completed"
              ? node.remote.fallback
              : [];
          const text = content
            .flatMap((part) => (part.kind === "text" ? [part.text] : []))
            .join("");
          // A checkpoint contains the whole current artifact, never a model token delta.
          // Settled parts already support replacement; no fabricated attempt or revision is needed.
          if (text) parts.push(textPart(`${node.runId}/remote-output`, text, true, owner));
        }
        return;
      }
      if (node.kind === "workflow") {
        const held = runAttempts.get(node.runId);
        const old = new Set(held?.old);
        if (!held?.old.has(node.attemptId)) {
          if (held && held.current !== node.attemptId) old.add(held.current);
          runAttempts.set(node.runId, { current: node.attemptId, old });
        }
        if (ended) endedRuns.add(node.runId);
        for (const step of node.steps) {
          const latest = step.attempts.at(-1);
          const attemptId = latest?.attemptId ?? node.attemptId;
          const held = stepActivities.get(step.id);
          const current = operations.get(step.id);
          // Child retries have distinct child rows. Only effect attempts are journaled here;
          // resuming an ask or sleep does not create another operation attempt.
          const savedAttempt = Math.max(1, step.attempts.length);
          const retain =
            current &&
            (current.attempt > savedAttempt ||
              current.old.has(attemptId) ||
              (current.completed && step.status !== "completed" && step.status !== "failed"));
          const attempt = retain ? current.attempt : savedAttempt;
          const activity: StepActivity =
            retain && held
              ? held
              : {
                  runId: node.runId,
                  workflowId: node.workflowId,
                  operationId: step.id,
                  key: step.key,
                  kind: step.kind,
                  status: step.status,
                  attemptId,
                  input: step.definition.input,
                  result: step.result,
                  error: step.error,
                };
          stepActivities.set(step.id, activity);
          const oldAttempts = new Set([
            ...(current?.old ?? []),
            ...step.attempts.slice(0, -1).map((item) => item.attemptId),
          ]);
          if (current && current.attemptId !== attemptId) oldAttempts.add(current.attemptId);
          // A denial can end a step before its first effect. The workflow epoch is not an
          // effect attempt, so it must not reject a result emitted by the next continuation.
          if (!retain && latest)
            operations.set(step.id, {
              attemptId,
              attempt,
              old: oldAttempts,
              completed: ended || activity.status === "completed" || activity.status === "failed",
            });
          let state = stepState(activity.status, ended);
          if (!retain && !ended && node.state.status === "suspended" && state === "running")
            state = "waiting";
          const row = stepPart(activity, state, attempt);
          if (row) parts.push(row);
          if (row && (state === "running" || state === "waiting")) {
            running.set(step.id, { runId: node.runId, part: row });
          } else running.delete(step.id);
          for (const record of (step.asks ?? []).map(rememberRequest)) {
            parts.push(
              requestPart(record, ended || step.status === "completed" || step.status === "failed"),
            );
          }
          for (const child of step.children)
            visitChild(child.snapshot, node.runId, owner, ended, step.id);
        }
        return;
      }
      const old = new Set(runAttempts.get(node.runId)?.old);
      for (const model of node.models) {
        for (const item of model.interrupted) old.add(item.attemptId);
        if (model.attemptId !== node.attemptId) old.add(model.attemptId);
      }
      old.delete(node.attemptId);
      runAttempts.set(node.runId, { current: node.attemptId, old });
      if (ended) endedRuns.add(node.runId);
      const source: TextSource =
        owner === undefined
          ? { root: true, runId: node.runId }
          : {
              root: false,
              runId: node.runId,
              agentId: node.agentId,
              handoff: conversationRuns.has(node.runId),
            };
      const shown = showsText(source);
      const words = shown && options.reasoning?.(source) === true;
      for (const model of node.models) {
        const attempt = model.interrupted.length + 1;
        operations.set(model.id, {
          attemptId: model.attemptId,
          attempt,
          old: new Set(model.interrupted.map((item) => item.attemptId)),
          completed: model.status === "completed" || ended,
        });
        const thought = savedThought(node.runId, model, attempt, ended, owner, words);
        // Above the text it came before.
        if (shown && thought) parts.push(thought);
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
        for (const [index, outer] of model.tools.entries()) {
          const entries = [
            { tool: outer, call: toolCalls[index], parentOperationId: undefined },
            ...(outer.calls ?? []).map((tool) => ({
              tool,
              call: { id: tool.id, name: tool.name, arguments: JSON.stringify(tool.arguments) },
              parentOperationId: outer.id,
            })),
          ];
          for (const { tool, call, parentOperationId } of entries) {
            const current = operations.get(tool.id);
            const attemptId = tool.status === "pending" ? tool.previousAttemptId : tool.attemptId;
            const old = new Set([
              ...tool.interrupted.map((item) => item.attemptId),
              ...tool.retries.map((item) => item.attemptId),
            ]);
            const savedAttempt = old.size + (tool.status === "pending" ? 0 : 1);
            const retain =
              current &&
              (current.attempt > savedAttempt ||
                (attemptId !== undefined && current.old.has(attemptId)) ||
                (current.completed && tool.status !== "completed"));
            if (!retain && (ended || tool.status === "completed")) running.delete(tool.id);
            const asks = (tool.asks ?? []).map(rememberRequest);
            const questions = asks.filter((record) => record.request.ask.type === "question");
            for (const record of asks) {
              if (record.request.ask.type !== "question")
                parts.push(requestPart(record, ended || tool.status === "completed"));
            }
            if (attemptId && !retain) {
              operations.set(tool.id, {
                attemptId,
                // A pending replacement has no new attempt yet. Its next start advances this count.
                attempt: savedAttempt,
                old,
                completed: tool.status === "completed" || ended,
              });
            }
            if (call && (tool.status !== "pending" || questions.length || parentOperationId)) {
              const activity = activityOf({
                operationId: tool.id,
                parentOperationId,
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
                      savedAttempt,
                    )
                  : toolPart(
                      activity,
                      owner,
                      ended
                        ? "failed"
                        : tool.status === "pending" ||
                            asks.some((record) => !record.decision && !record.closed)
                          ? "waiting"
                          : "running",
                      savedAttempt,
                    );
              if (row) {
                parts.push(row);
                if (!retain && (row.state === "running" || row.state === "waiting"))
                  running.set(row.id, { runId: node.runId, part: row });
              }
            }
            for (const record of questions)
              parts.push(requestPart(record, ended || tool.status === "completed"));
          }
          const journal = node.delegations.find((entry) => entry.operationId === outer.id);
          for (const child of journal?.children ?? [])
            visitChild(child.snapshot, node.runId, owner, ended, outer.id, journal?.kind);
        }
      }
    }

    visit(saved, undefined, false);
    if (saved.state.status === "completed")
      parts.push(...(options.output?.(saved.state.candidate) ?? []));
    return { id: messageId, role: "assistant", parts, state: MESSAGE[saved.state.status] };
  }

  function savedOwner(saved: TreeNode): ConversationOwner | undefined {
    if (saved.runId !== root) throw new TypeError("The snapshot belongs to another run.");
    let node = saved;
    while (node.kind === "agent") {
      const journal = node.delegations.find(
        (entry) => entry.kind === "handoff" && entry.children.length > 0,
      );
      const child = journal?.children[0]?.snapshot;
      if (!child)
        return {
          runId: node.runId,
          agentId: node.agentId,
          label: agentLabel(node.runId, node.agentId),
        };
      node = child;
    }
    return undefined;
  }

  function inputs(saved: TreeNode): DisplayInput[] {
    if (saved.runId !== root) throw new TypeError("The snapshot belongs to another run.");
    const result: DisplayInput[] = [];
    function visit(node: TreeNode): void {
      if (node.kind === "agent")
        for (const input of node.inputs) {
          const display = options.input?.(input, { rootRunId: root, runId: node.runId });
          result.push({
            id: input.id,
            rootRunId: root,
            runId: node.runId,
            status:
              node.models[input.beforeModel]?.status === "completed" ? "consumed" : "accepted",
            ...(display?.text !== undefined && { text: display.text }),
          });
        }
      for (const child of childrenOf(node)) visit(child);
    }
    visit(saved);
    return result;
  }

  return Object.freeze({
    event,
    gap,
    snapshot,
    inputs,
    run(saved: TreeNode) {
      rootRemote = saved.kind === "remote";
      if (saved.kind === "remote" && saved.remote.state !== undefined)
        remoteStates.set(saved.runId, saved.remote.state);
      return {
        ...runInfo(saved.runId, saved.state),
        owner: savedOwner(saved),
        ...(saved.state.status === "suspended" && savedWaiting(saved)),
      };
    },
  });
}

/** One progress record of a stored run, as the SDK's background `observe` hands it out. */
export interface RunRecord {
  seq: number;
  type: string;
  data: unknown;
  /** When the host stored it. `@gusnips/server/runs` gives a `Date`. */
  at?: Date | number;
}

/** One stored row of a run, whose `id` numbers its records: a display event's `segment`. */
export interface RunSegment {
  id: string;
  /** Every record of the row from its first, like `background.observe(owner, id, 0, signal)`. */
  records: AsyncIterable<RunRecord>;
}

export interface FollowRunOptions {
  /** A fresh projector is made from these for each viewer, because only one that saw the log
   * from the run's first record draws the rows after the viewer's cursor as the live stream did. */
  projector: AgentProjectorOptions;
  /** The run's rows in order: the first, then one for each approval that continued it. Only the
   * last can still grow. */
  segments: readonly RunSegment[];
  /** The viewer's cursor. Without one, or with one from another run, the viewer gets the run from
   * its start, opening with a snapshot of the conversation. */
  cursor?: Cursor;
  /** The saved run, read after a gap in the log and when the last row ends. It holds private
   * journals: check that this viewer may see the run before calling `followRun`. */
  read: () => Promise<TreeNode>;
  /** The whole conversation for a snapshot: the host's own messages with `reply`, this run's
   * message as the projector draws it, in its place. A snapshot replaces the whole list. */
  conversation: (
    reply: DisplayMessage,
  ) => readonly DisplayMessage[] | Promise<readonly DisplayMessage[]>;
}

/** The SDK's own progress sink wrote this into the host's log; a browser never did. Only the type
 * is checked, because the projector skips a type it does not know. */
function isAgentEvent(value: unknown): value is AgentEvent {
  return isRecord(value) && typeof value.type === "string";
}

/**
 * The display events for one viewer of a stored run: what the live stream would have sent after
 * the viewer's cursor, then the saved run once the log ends.
 *
 * It replays the run's log from its first record through a fresh projector and sends only what
 * comes after the cursor. At a gap in the log it sends the projector's marker, then a snapshot of
 * the saved run read then, while that run is still going in the last row. When the last row ends
 * it sends that snapshot again, with the final state. A viewer already past the end still gets it,
 * unnumbered, so its client knows the host answered.
 *
 * ```ts
 * for await (const event of followRun({ projector, segments, cursor, read, conversation }))
 *   write(`data: ${JSON.stringify(event)}\n\n`);
 * ```
 */
export async function* followRun(options: FollowRunOptions): AsyncGenerator<ChatEvent> {
  const { segments, cursor, read, conversation } = options;
  const first = segments[0];
  if (!first || segments.some((segment) => typeof segment.id !== "string" || !segment.id))
    throw new TypeError("Give followRun the run's rows, each with its id.");
  const projector = createAgentProjector(options.projector);
  const { messageId, runId } = options.projector;
  const reached = cursor ? segments.findIndex((segment) => segment.id === cursor.segment) : -1;
  const last = segments.length - 1;

  async function snapshot(
    reply: DisplayMessage,
    run: RunInfo,
    inputs?: readonly DisplayInput[],
  ): Promise<ChatEvent> {
    const messages = await conversation(reply);
    return { v: PROTOCOL_VERSION, type: "snapshot", messages, run, ...(inputs && { inputs }) };
  }

  function saved(tree: TreeNode): Promise<ChatEvent> {
    return snapshot(projector.snapshot(tree), projector.run(tree), projector.inputs(tree));
  }

  // A new viewer has nothing on screen to lose, so it opens with the conversation around an empty
  // reply. Numbered 0 in the first row, so a viewer that already has it does not take it again.
  if (reached < 0)
    yield {
      ...(await snapshot(
        { id: messageId, role: "assistant", parts: [], state: "live" },
        { id: runId, status: "running", messageId },
      )),
      segment: first.id,
      seq: 0,
    };
  for (const [index, segment] of segments.entries()) {
    for await (const record of segment.records) {
      const where = { segment: segment.id, seq: record.seq };
      const unseen = index > reached || (index === reached && record.seq > (cursor?.seq ?? 0));
      if (record.type === "agent" && isAgentEvent(record.data)) {
        const at = record.at instanceof Date ? record.at.getTime() : record.at;
        const out = projector.event(record.data, { ...where, ...(at !== undefined && { at }) });
        if (unseen) yield* out;
      } else if (record.type === "agent.gap" || record.type === "agent.resync") {
        const marker = projector.gap();
        if (!unseen) continue;
        yield* marker;
        // The log is fed before the journal is read, never after, or older progress lands on a
        // newer save: a waiting run would show as running again. A gap the viewer passed, or one in
        // a row the run moved on from, is replayed without a read, and a save that already paused
        // or ended the run waits for the end, because every record left is older than it.
        // ponytail: rows a gap hid can then stay as the viewer last saw them until a later gap or
        // the end, and a running save read at a gap far back in the log can still be ahead of the
        // records after it. A log position on each save would end both.
        if (index < last) continue;
        const tree = await read();
        if (tree.state.status === "running") yield { ...(await saved(tree)), ...where };
      } else if (record.type === "end" && index === last) {
        const final = await saved(await read());
        yield unseen ? { ...final, ...where } : final;
        return;
      }
    }
  }
}
