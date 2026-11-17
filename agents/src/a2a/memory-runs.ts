import { AGENT_RUNTIME, type NodeOutcome } from "../delegation.ts";
import type {
  BackgroundCancelResult,
  BackgroundContext,
  BackgroundPolicy,
  Continuation,
  SegmentHook,
} from "../background-types.ts";
import { checkChildProgress, copyData, equalData, immutableCopy, isId } from "../snapshot.ts";
import { openRequests, readAnswers, snapshots, untilAbort, wakeAt } from "../tree.ts";
import { createProgress } from "../progress.ts";
import { createMemoryInbox, type QueuedInput } from "../steering.ts";
import type {
  Agent,
  AgentHost,
  AgentInput,
  ResumeOptions,
  RunOptions,
  Session,
  TreeNode,
} from "../types.ts";
import type { Workflow } from "../workflow-types.ts";
import { A2AError } from "./wire.ts";

/** Structural public contract. Does not import the optional host run-service peer. */
export interface A2AStoredEvent {
  seq: number;
  type: string;
  data: unknown;
}
export interface A2ARun<T = unknown> {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  snapshot: TreeNode;
  outcome: NodeOutcome<T> | null;
  wakeAt?: number;
}
export interface A2ARuns<I = AgentInput, O = unknown> {
  start(
    owner: string,
    input: I,
    options: { runId: string; sessionId?: string; signal?: AbortSignal },
  ): Promise<{ id: string }>;
  /** Return independent snapshots and hydrated outcomes. A caller or projector must not be
   * able to change stored results by mutating a read. Completed checkpoints are authoritative. */
  read(owner: string, id: string): Promise<A2ARun<O>>;
  observe(
    owner: string,
    id: string,
    afterSeq?: number,
    signal?: AbortSignal,
  ): AsyncIterable<A2AStoredEvent>;
  /** Follow the returned physical segment. Queue acceptance is not a cancelled outcome. */
  cancel(owner: string, id: string): Promise<BackgroundCancelResult>;
  resume(
    owner: string,
    id: string,
    answers: Readonly<Record<string, unknown>>,
  ): Promise<{ id: string }>;
  /** Optional, explicit capability. Enqueue is not a promise that a model consumed the input. */
  send?: (owner: string, id: string, input: QueuedInput) => Promise<void>;
}
export interface MemoryRunsOptions {
  /** Required host policy, run again for every physical segment. Claims and authorization are
   * still real host decisions; this binding does not infer approval from evidence or text. */
  policy(context: BackgroundContext): BackgroundPolicy | Promise<BackgroundPolicy>;
  /** Required to track out-of-band segments in the task store. */
  onSegment?: SegmentHook;
  session?: (owner: string, id: string) => Session | Promise<Session>;
  maxSegments?: number;
  maxSnapshotBytes?: number;
  maxEvents?: number;
  maxEventBytes?: number;
  /** Uses the SDK's bounded memory inbox. Without this opt-in, active messages are refused. */
  steering?: boolean;
}
interface Row<O> extends A2ARun<O> {
  owner: string;
  continuation?: Continuation;
  controller: AbortController;
  events: A2AStoredEvent[];
  bytes: number;
  seq: number;
  listeners: Set<() => void>;
  settled: Promise<void>;
}

/** Process-local and not crash durable. Composes the real runtime, checkpoint and request
 * claim path. No new agent loop, scheduler or automatic wake. Full stores refuse admissions;
 * dropping this binding drops snapshots, inboxes and continuation claims. */
export function createMemoryRuns<T>(
  options: MemoryRunsOptions & { agent: Agent<T> },
): A2ARuns<AgentInput, T>;
export function createMemoryRuns<I, O>(
  options: MemoryRunsOptions & { workflow: Workflow<I, O> },
): A2ARuns<I, O>;
export function createMemoryRuns<I, O>(
  options: MemoryRunsOptions & ({ agent: Agent<O> } | { workflow: Workflow<I, O> }),
): A2ARuns<I, O> | A2ARuns<AgentInput, O> {
  if ("workflow" in options) {
    const workflow = options.workflow;
    return bindMemory<I, O>(options, {
      open: (input, opts, id) => workflow[AGENT_RUNTIME].open(input, opts, id),
      resume: (snapshot, opts) => workflow.resume(snapshot, opts),
      hydrate: (snapshot) => workflow[AGENT_RUNTIME].hydrate(snapshot),
    });
  }
  const agent = options.agent;
  return bindMemory<AgentInput, O>(options, {
    open: (input, opts, id) => agent[AGENT_RUNTIME].open(input, opts, id),
    resume: (snapshot, opts) => agent.resume(snapshot, opts),
    hydrate: (snapshot) => agent[AGENT_RUNTIME].node.hydrate(snapshot),
  });
}
function bindMemory<I, O>(
  options: MemoryRunsOptions,
  runtime: {
    open(input: I, options: RunOptions, runId: string): Promise<TreeNode>;
    resume(snapshot: TreeNode, options: ResumeOptions): Promise<NodeOutcome<O>>;
    hydrate(snapshot: TreeNode): NodeOutcome<O>;
  },
): A2ARuns<I, O> {
  const {
    maxSegments = 1000,
    maxSnapshotBytes = 8 * 1024 * 1024,
    maxEvents = 256,
    maxEventBytes = 1024 * 1024,
  } = options;
  if (
    typeof options.policy !== "function" ||
    [maxSegments, maxSnapshotBytes, maxEvents, maxEventBytes].some(
      (n) => !Number.isSafeInteger(n) || n < 1,
    )
  )
    throw new A2AError("invalid");
  const rows = new Map<string, Row<O>>();
  const current = new Map<string, string>();
  const starts = new Set<string>();
  const reserved = new Set<string>();
  const inboxes = new Map<string, ReturnType<typeof createMemoryInbox>>();
  const key = (owner: string, id: string) => JSON.stringify([owner, id]);
  function load(owner: string, id: string): Row<O> {
    const row = rows.get(id);
    if (!row || row.owner !== owner) throw new A2AError("protocol", { code: -32001 });
    return row;
  }
  function checkpoint(row: Row<O>, snapshot: TreeNode) {
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > maxSnapshotBytes)
      throw new A2AError("limit");
    checkChildProgress(row.snapshot, snapshot);
    row.snapshot = copyData(snapshot);
  }
  function emit(row: Row<O>, type: string, data: unknown) {
    const event = { seq: ++row.seq, type, data: copyData(data) };
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (bytes <= maxEventBytes) {
      row.events.push(event);
      row.bytes += bytes;
    }
    while (row.events.length > maxEvents || row.bytes > maxEventBytes) {
      const removed = row.events.shift();
      row.bytes -= new TextEncoder().encode(JSON.stringify(removed)).byteLength;
    }
    for (const wake of row.listeners) wake();
  }
  async function policy(context: BackgroundContext) {
    const trusted = await options.policy(immutableCopy(context));
    for (const name of [
      "authorizeResume",
      "prepareRequest",
      "resolveRequest",
      "beforeTool",
      "claimContinuation",
    ] as const)
      if (typeof trusted?.[name] !== "function") throw new A2AError("invalid");
    return trusted;
  }
  function admission() {
    if (rows.size + reserved.size >= maxSegments) throw new A2AError("limit");
    const id = crypto.randomUUID();
    reserved.add(id);
    return id;
  }
  async function execute(row: Row<O>) {
    const { continuation } = row;
    const initial = copyData(row.snapshot);
    const logical = key(row.owner, initial.runId);
    const progress = createProgress(
      { signal: row.controller.signal, emit: (type, data) => emit(row, type, data) },
      "best-effort",
    );
    try {
      row.status = "running";
      const trusted = await policy({
        owner: row.owner,
        segmentId: row.id,
        runId: initial.runId,
        continuation,
      });
      // These checks are not substitutes for the host's current authorization or claim.
      if (current.get(logical) !== row.id) throw new A2AError("invalid");
      await trusted.authorizeResume(immutableCopy(initial));
      if (
        continuation?.wakeAt !== undefined &&
        (wakeAt(initial) !== continuation.wakeAt || Date.now() < continuation.wakeAt)
      )
        throw new A2AError("invalid");
      if (continuation)
        await trusted.claimContinuation(immutableCopy(initial), immutableCopy(continuation));
      await options.onSegment?.({
        phase: "start",
        signal: row.controller.signal,
        owner: row.owner,
        id: row.id,
        runId: initial.runId,
        state: initial.state,
        snapshot: immutableCopy(initial),
      });
      const session =
        initial.kind === "agent" && initial.session
          ? await options.session?.(row.owner, initial.session.id)
          : undefined;
      if (initial.kind === "agent" && initial.session && session?.id !== initial.session.id)
        throw new A2AError("invalid");
      const host: AgentHost & { authorizeResume: BackgroundPolicy["authorizeResume"] } = {
        ...trusted,
        ...(options.steering ? { inbox: inboxes.get(logical) } : {}),
        progress,
        authorizeResume: async (snapshot) => {
          if (
            current.get(logical) !== row.id ||
            ![...snapshots(row.snapshot)].some((node) => equalData(node, snapshot))
          )
            throw new A2AError("invalid");
          await trusted.authorizeResume(snapshot);
        },
        checkpoint: (snapshot) => checkpoint(row, snapshot),
      };
      const outcome = await runtime.resume(initial, {
        host,
        // Keep the worker lifetime live for claims, checkpoints and hooks. Cancellation is
        // a separate runtime signal, never an answer or a scheduled continuation.
        signal:
          continuation?.kind === "cancel"
            ? AbortSignal.any([row.controller.signal, AbortSignal.abort()])
            : row.controller.signal,
        session,
        answers: continuation?.answers,
        context: trusted.context,
        onEvent: trusted.onEvent,
        onLifecycle: trusted.onLifecycle,
        bindModelProvider: trusted.bindModelProvider,
      });
      checkpoint(row, outcome.snapshot);
      row.outcome = outcome;
      row.status = "succeeded";
      row.wakeAt = wakeAt(outcome.snapshot);
    } catch {
      // Unknown host failure is not a fabricated SDK outcome. Keep the last real checkpoint.
      row.status = row.controller.signal.aborted ? "cancelled" : "failed";
    } finally {
      try {
        await progress.flush();
      } catch {
        /* The real cancellation/outcome remains authoritative. */
      }
      await progress.dispose();
      try {
        await options.onSegment?.({
          phase: "end",
          signal: row.controller.signal,
          owner: row.owner,
          id: row.id,
          runId: row.snapshot.runId,
          state: row.snapshot.state,
          snapshot: immutableCopy(row.snapshot),
        });
      } catch {
        /* End-hook failure must not replace a settled journal or replay its effects. */
      }
      emit(row, "end", { status: row.status });
      if (row.outcome && row.outcome.status !== "suspended") inboxes.delete(logical);
    }
  }
  function launch(owner: string, id: string, snapshot: TreeNode, continuation?: Continuation) {
    const row: Row<O> = {
      owner,
      id,
      continuation,
      snapshot: copyData(snapshot),
      status: "queued",
      outcome: null,
      controller: new AbortController(),
      events: [],
      bytes: 0,
      seq: 0,
      listeners: new Set(),
      settled: Promise.resolve(),
    };
    reserved.delete(id);
    rows.set(id, row);
    current.set(key(owner, snapshot.runId), id);
    row.settled = execute(row);
    return { id };
  }
  return {
    async start(owner, input, start) {
      if (!isId(owner) || !isId(start.runId)) throw new A2AError("invalid");
      const logical = key(owner, start.runId);
      if (starts.has(logical)) throw new A2AError("invalid");
      if (starts.size >= maxSegments) throw new A2AError("limit");
      const id = admission();
      starts.add(logical);
      try {
        start.signal?.throwIfAborted();
        if (start.sessionId !== undefined && !options.session) throw new A2AError("invalid");
        const session =
          start.sessionId && options.session
            ? await options.session(owner, start.sessionId)
            : undefined;
        if (session && session.id !== start.sessionId) throw new A2AError("invalid");
        const snapshot = await runtime.open(input, { session, signal: start.signal }, start.runId);
        start.signal?.throwIfAborted();
        if (options.steering) inboxes.set(logical, createMemoryInbox(start.runId));
        return launch(owner, id, snapshot);
      } catch (error) {
        reserved.delete(id);
        throw error;
      }
    },
    async read(owner, id) {
      const row = load(owner, id);
      // Rehydrate from the real journal, like the durable binding. A validator may return a
      // Date or another non-JSON value; only its candidate is required to be stored as JSON.
      const hydrated = row.outcome ? runtime.hydrate(copyData(row.snapshot)) : null;
      const outcome =
        hydrated && row.outcome && "session" in row.outcome && row.outcome.session
          ? { ...hydrated, session: copyData(row.outcome.session) }
          : hydrated;
      return {
        id,
        status: row.status,
        snapshot: copyData(row.snapshot),
        outcome,
        ...(row.wakeAt === undefined ? {} : { wakeAt: row.wakeAt }),
      };
    },
    async *observe(owner, id, afterSeq = 0, signal) {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new A2AError("invalid");
      const row = load(owner, id);
      let after = afterSeq;
      while (!signal?.aborted) {
        let wake = () => {};
        const changed = new Promise<void>((resolve) => {
          wake = resolve;
        });
        row.listeners.add(wake);
        try {
          const first = row.events[0]?.seq ?? row.seq + 1;
          if (after < first - 1) {
            const dropped = first - after - 1;
            after = first - 1;
            yield { seq: after, type: "agent.gap", data: { dropped, unconfirmed: 0 } };
          }
          const events = row.events.filter((event) => event.seq > after);
          for (const event of events) {
            after = event.seq;
            yield copyData(event);
          }
          if (["succeeded", "failed", "cancelled"].includes(row.status) && after >= row.seq) return;
          if (!events.length) await (signal ? untilAbort(changed, signal) : changed);
        } catch (error) {
          if (!signal?.aborted) throw error;
        } finally {
          row.listeners.delete(wake);
        }
      }
    },
    async cancel(owner, id) {
      const row = load(owner, id);
      const currentId = current.get(key(owner, row.snapshot.runId)) ?? id;
      const active = load(owner, currentId);
      // A second Stop follows the existing command. Aborting its worker would prevent the
      // claimed cancellation from saving its real outcome and running its end hook.
      if (active.continuation?.kind === "cancel") return { id: currentId, requested: true };
      if (currentId !== id) return { id: currentId, requested: false };
      if (row.status === "succeeded" && row.outcome?.status === "suspended") {
        const next = admission();
        launch(owner, next, row.snapshot, {
          id: `cancel/${id}`,
          sourceId: id,
          kind: "cancel",
          answers: {},
        });
        return { id: next, requested: true };
      }
      if (row.status !== "running" && row.status !== "queued") return { id, requested: false };
      row.controller.abort();
      return { id, requested: true };
    },
    async resume(owner, id, evidence) {
      const row = load(owner, id);
      const logical = key(owner, row.snapshot.runId);
      if (
        current.get(logical) !== id ||
        row.status !== "succeeded" ||
        row.outcome?.status !== "suspended"
      )
        throw new A2AError("invalid");
      const answers = readAnswers(row.snapshot, evidence);
      const at = Object.keys(answers).length ? undefined : wakeAt(row.snapshot);
      if (!Object.keys(answers).length && (at === undefined || at > Date.now()))
        throw new A2AError("invalid");
      if (
        openRequests(row.snapshot).some(
          (request) => Object.hasOwn(answers, request.id) && request.scope.expiresAt <= Date.now(),
        )
      )
        throw new A2AError("invalid");
      const next = admission();
      const continuation: Continuation = {
        id: crypto.randomUUID(),
        sourceId: id,
        kind: "answers",
        answers,
        ...(at === undefined ? {} : { wakeAt: at }),
      };
      return launch(owner, next, row.snapshot, continuation);
    },
    ...(options.steering
      ? {
          async send(owner: string, id: string, input: QueuedInput) {
            const row = load(owner, id);
            const logical = key(owner, row.snapshot.runId);
            if (
              current.get(logical) !== id ||
              !["queued", "running"].includes(row.status) ||
              row.snapshot.kind !== "agent"
            )
              throw new A2AError("protocol", { code: -32004 });
            const inbox = inboxes.get(logical);
            if (!inbox) throw new A2AError("protocol", { code: -32004 });
            inbox.enqueue(input);
          },
        }
      : {}),
  };
}
