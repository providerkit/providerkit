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
  PendingApproval,
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
  type ApprovalState,
  type ChatEnvelope,
  type ChatEvent,
  type DisplayError,
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

export interface ApprovalActivity extends ToolActivity {
  /** Present while the call waits for a decision. Its scope is what your host handed the SDK:
   * the actor and the resource leave only if you copy them out. */
  pending?: PendingApproval;
}

export interface ApprovalDisplay {
  /** What the client sends back with the decision. Defaults to `operationId`, which keeps the
   * request and its call in one row: once the call runs, its tool row takes the request's
   * place, and a saved run draws the same thing. An id of your own gives the request a row of
   * its own, which a saved run no longer has once the call ran. Make it depend on the call
   * alone: a denied call is drawn again from the saved run.
   *
   * A request whose call never runs (the run hit a limit or was stopped first, or your `tool`
   * callback hides the call) is closed only by the projector that drew it, or by the next
   * snapshot. */
  id?: string;
  title: string;
  summary?: string;
  /** Epoch milliseconds. Defaults to the expiry in the approval scope. */
  expiresAt?: number;
}

/** A run whose model text could be shown: the one this projector draws, or a specialist. */
export type TextSource =
  | { root: true; runId: string }
  | { root: false; runId: string; agentId: string };

export interface AgentProjectorOptions {
  /** The assistant message this run writes into. */
  messageId: string;
  /** The run this projector draws: the `runId` you gave `agent.run`, or the `runId` of its
   * saved snapshot. It stays the same across approval segments. Another run's events are drawn
   * only after a child event named it as a specialist of this one. */
  runId: string;
  /** Words for rows, keyed by tool name and by agent id. A missing key shows the name itself. */
  labels?: {
    tool?: Readonly<Record<string, string>>;
    agent?: Readonly<Record<string, string>>;
  };
  /** Return `null` to hide a call. That is decided from the call before it has a result, so a
   * call is shown for its whole life or never. Called again with the result for the final row. */
  tool?: (activity: ToolActivity) => ToolDisplay | null | undefined;
  /** Draws a request for a decision, and the same request once it is denied (then `pending` is
   * absent and `result` holds the denial). Without it the title is the tool's label. */
  approval?: (activity: ApprovalActivity) => ApprovalDisplay;
  /** Without it a failure shows its code and a sentence that says nothing private. */
  error?: (state: Extract<RunState, { status: "failed" | "limited" }>) => DisplayError;
  /** Which runs' model text is shown. The default shows the root's only. */
  text?: (source: TextSource) => boolean;
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
  /** The message as the saved run has it, with the same row ids the live events use. */
  snapshot(snapshot: RunSnapshot): DisplayMessage;
  /** The run as the saved run has it. */
  run(snapshot: RunSnapshot): RunInfo;
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

/** A denial comes back as the call's result, and it is the request's outcome, not a tool that
 * failed, so it keeps the request's row. */
function isDenied(result: ToolResult): boolean {
  return !result.ok && result.kind === "denied";
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
    case "state":
      return event.runId;
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
  const showsText = options.text ?? ((source: TextSource) => source.root);
  const v = PROTOCOL_VERSION;

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

  function approvalPart(activity: ApprovalActivity, state: ApprovalState): ApprovalPart {
    const display = options.approval?.(activity);
    const part: ApprovalPart = {
      type: "approval",
      id: display?.id ?? activity.operationId,
      title: display?.title ?? lookup(options.labels?.tool, activity.call.name),
      state,
    };
    if (display?.summary !== undefined) part.summary = display.summary;
    const expiresAt = display?.expiresAt ?? activity.pending?.scope.expiresAt;
    if (state === "pending" && expiresAt !== undefined) part.expiresAt = expiresAt;
    return part;
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
      label: lookup(options.labels?.agent, agentId),
      state,
    };
    if (parentId !== undefined) part.parentId = parentId;
    return part;
  }

  function runInfo(runId: string, state: RunState): RunInfo {
    const info: RunInfo = { id: runId, status: STATUS[state.status], messageId };
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
    { agentId: string; parentId: string | undefined; over: boolean }
  >();
  const textShown = new Map<string, boolean>();
  const streaming = new Map<string, TextPart>();
  const running = new Map<string, { runId: string; part: ToolPart }>();
  const requests = new Map<string, ApprovalPart>();

  function shows(runId: string): boolean {
    let shown = textShown.get(runId);
    if (shown === undefined) {
      const specialist = specialists.get(runId);
      shown = showsText(
        specialist ? { root: false, runId, agentId: specialist.agentId } : { root: true, runId },
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
    for (const [id, entry] of running) {
      if (!within(entry.runId, ended)) continue;
      running.delete(id);
      part({ ...entry.part, state: "failed" });
    }
    for (const [runId, specialist] of specialists) {
      if (runId === ended || specialist.over || !within(runId, ended)) continue;
      specialist.over = true;
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
    const speaker = speakerOf(agentEvent);
    // A run no child event named here (a log read from the middle, or a child event that was
    // lost) has no row to file under, and it is never taken for the root. The next snapshot
    // draws it.
    if (speaker === undefined || (speaker !== root && !specialists.has(speaker))) return [];
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
    if (!rootState && status !== "running") {
      status = "running";
      out.push({ v, type: "run", run: { id: root, status, messageId } });
    }
    // A run does one thing at a time, so anything else it reports means its last model turn
    // has ended. The text row closes with all of its text, which a client that missed a delta
    // takes whole.
    const open = streaming.get(speaker);
    if (open && !(agentEvent.type === "model_chunk" && agentEvent.operationId === open.id)) {
      streaming.delete(speaker);
      part({ ...open, settled: true });
    }

    switch (agentEvent.type) {
      case "model_chunk": {
        const { content } = agentEvent.chunk;
        if (!content || !shows(speaker)) break;
        const current = streaming.get(speaker);
        if (current) {
          current.text += content;
          out.push({ v, type: "text", messageId, partId: current.id, delta: content });
        } else {
          // The first chunk creates the row with its own text, so the creation is the
          // numbered event: a client never holds a row that a delta could not reach.
          const created = textPart(agentEvent.operationId, content, false, ownerOf(speaker));
          streaming.set(speaker, { ...created });
          part(created);
        }
        break;
      }
      case "tool_start": {
        const { request } = agentEvent;
        const row = toolPart(activityOf(request), ownerOf(request.runId), "running");
        const ask = requests.get(request.operationId);
        if (ask) {
          requests.delete(request.operationId);
          // With the default id the tool row below replaces the request, the same way a saved
          // run draws it. Only a request with a row of its own needs closing.
          if (!row || ask.id !== row.id) part({ ...ask, state: "approved" });
        }
        if (row) {
          running.set(row.id, { runId: request.runId, part: row });
          part(row);
        }
        break;
      }
      case "tool_result": {
        // A call can end without starting: an unknown tool, arguments that are not one JSON
        // object, or a denial. The row is drawn whole from the result.
        const { request, result } = agentEvent;
        running.delete(request.operationId);
        const activity = { ...activityOf(request), result };
        const ask = requests.get(request.operationId);
        requests.delete(request.operationId);
        if (isDenied(result)) {
          const denied = approvalPart(activity, "denied");
          if (ask && ask.id !== denied.id) part({ ...ask, state: "denied" });
          part(denied);
          break;
        }
        if (ask) part({ ...ask, state: "approved" });
        const row = toolPart(activity, ownerOf(request.runId), result.ok ? "done" : "failed");
        if (row) part(row);
        break;
      }
      case "child": {
        const { runId, agentId } = agentEvent;
        // A run is never filed under itself or under one of its own specialists, so the walk
        // in `within` always ends.
        if (runId === root || within(speaker, runId)) break;
        // Sent again when the child resumes, with the same identity: one row, updated.
        const parentId = ownerOf(speaker);
        specialists.set(runId, { agentId, parentId, over: false });
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
        for (const text of streaming.values()) part({ ...text, settled: true });
        streaming.clear();
        if (state.status === "running") {
          if (status !== "running") {
            status = "running";
            out.push({ v, type: "run", run: runInfo(root, state) });
          }
          break;
        }
        if (state.status === "suspended") {
          const { approval } = state;
          const ask = approvalPart(
            { ...activityOf(approval.request), pending: approval },
            "pending",
          );
          requests.set(approval.request.operationId, ask);
          part(ask);
        } else {
          // Nothing still going will finish now, and a request can no longer be answered. A
          // saved run draws the same rows the same way, except the request, which it no longer
          // has.
          endUnder(part, root);
          for (const ask of requests.values()) part({ ...ask, state: "expired" });
          requests.clear();
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
    const parts: DisplayPart[] = [];
    const waiting = saved.state.status === "suspended" ? saved.state.approval : undefined;

    /** `over` is true under a run that ended: nothing there goes on either. */
    function visit(node: RunSnapshot, owner: string | undefined, over: boolean): void {
      const ended = over || isOver(node.state);
      const shown = showsText(
        owner === undefined
          ? { root: true, runId: node.runId }
          : { root: false, runId: node.runId, agentId: node.agentId },
      );
      for (const model of node.models) {
        // A model turn still running has no text saved yet: live events carry it.
        if (model.status !== "completed") continue;
        const { content, toolCalls = [] } = model.turn.message;
        if (shown && content) parts.push(textPart(model.id, content, true, owner));
        for (const [index, tool] of model.tools.entries()) {
          const call = toolCalls[index];
          if (!call) continue;
          const activity = activityOf({
            operationId: tool.id,
            runId: node.runId,
            agentId: node.agentId,
            call,
          });
          if (tool.status === "pending") {
            // Not started, so not drawn, unless it is the call the run waits on.
            if (waiting?.request.operationId === tool.id)
              parts.push(approvalPart({ ...activity, pending: waiting }, "pending"));
            continue;
          }
          let row: DisplayPart | null;
          if (tool.status === "completed") {
            const finished = { ...activity, result: tool.result };
            row = isDenied(tool.result)
              ? approvalPart(finished, "denied")
              : toolPart(finished, owner, tool.result.ok ? "done" : "failed");
          } else row = toolPart(activity, owner, ended ? "failed" : "running");
          if (row) parts.push(row);
          const journal = node.delegations.find((entry) => entry.operationId === tool.id);
          for (const child of journal?.children ?? []) {
            const { runId, agentId, state } = child.snapshot;
            // A specialist still going when a run above it ended will not go on. The live side
            // stops it at that moment.
            const shownState = ended && !isOver(state) ? "stopped" : STATUS[state.status];
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

  return Object.freeze({
    event,
    snapshot,
    run: (saved: RunSnapshot) => runInfo(saved.runId, saved.state),
  });
}
