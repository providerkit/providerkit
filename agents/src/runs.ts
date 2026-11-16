import type { createRuns, Run, RunEvent, RunHandler, StoredRun } from "@gusnips/server/runs";
import { AGENT_RUNTIME } from "./delegation.ts";
import {
  checkOptions,
  copyData,
  equalData,
  immutableCopy,
  isId,
  isRecord,
  isSession,
  isSessionStatus,
  readModelSettings,
} from "./snapshot.ts";
import { untilAbort } from "./tree.ts";
import type {
  Agent,
  AgentHost,
  AgentInput,
  ChildEnvelope,
  RecordedModelSettings,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  Session,
  SessionStatus,
} from "./types.ts";

export type BackgroundRuns = Pick<
  ReturnType<typeof createRuns>,
  "create" | "read" | "tail" | "cancel"
>;

export interface Continuation {
  /** Unique authorization claim, distinct from both the logical run and the host row. */
  id: string;
  sourceId: string;
  decision: unknown;
}

export interface BackgroundContext {
  /** From the authenticated caller, or from Run.owner inside a worker. */
  owner: string;
  segmentId: string;
  continuation?: Continuation;
}

export interface BackgroundPolicy
  extends
    Required<
      Pick<AgentHost, "authorizeResume" | "approvalContext" | "resolveApproval" | "beforeTool">
    >,
    Pick<AgentHost, "canRunConcurrently"> {
  /** Worker-only values for tools, such as the authenticated actor or a database handle.
   * Never serialized. The SDK supplies reserved operation IDs and cancellation signals. */
  context?: RunOptions["context"];
  /** Reads media references for this owner's run. Check that the owner may read each id. */
  loadMedia?: AgentHost["loadMedia"];
  /** Called under the worker's lease, after its row exists. Authenticate the decision,
   * recheck resource version/expiry and atomically reserve this approval for continuation.id
   * AND context.segmentId. Repeating that exact claim must succeed; any other claim or segment
   * must fail. authorizeResume checks ownership on every attempt. resolveApproval may reuse a
   * consumed decision only for this same claim/segment. These guarantees need durable host state. */
  claimContinuation: (snapshot: RunSnapshot, continuation: Continuation) => void | Promise<void>;
}

export interface BackgroundOptions<T> {
  agent: Agent<T>;
  /** Dedicated handler key for this agent version. */
  kind: string;
  runs: BackgroundRuns;
  /** Await durable queue acceptance. A worker calls runs.drive(id, background.handlers).
   * The host must also run runs.sweep on boot and periodically, and drain on shutdown. */
  enqueue: (id: string) => Promise<void>;
  policy: (context: BackgroundContext) => BackgroundPolicy | Promise<BackgroundPolicy>;
  /** Trusted. Return the session `id` names, after checking that `owner` may use it: an id
   * from a request is not authorization. `start` reads its history inside the authenticated
   * request; the worker gets it again, with the stored owner, to append the turn. */
  session?: (owner: string, id: string) => Session | Promise<Session>;
  /** How many of the session's newest messages `start` loads. */
  historyLimit?: number;
  /** Runs once in `start`, before the run is saved. See RunOptions.prepareHistory. */
  prepareHistory?: RunOptions["prepareHistory"];
}

/** Server-side: the snapshot holds the whole conversation, prompts and tool data. Send a
 * browser a projection, never this object. */
export interface BackgroundRun<T> {
  id: string;
  /** Host completion is not SDK completion: a successful segment can be suspended or failed. */
  status: StoredRun["status"];
  snapshot: RunSnapshot;
  /** outcome.session says whether the worker's append saved the turn. */
  outcome: RunOutcome<T> | null;
  error: StoredRun["error"];
}

/** The row exists. Retry queueing this id, or let the host sweep find it; do not start again. */
export class BackgroundEnqueueError extends Error {
  constructor(
    readonly id: string,
    cause: unknown,
  ) {
    super(
      `Run ${id} was saved, but queueing failed. Enqueue this id again; do not create another run.`,
      { cause },
    );
    this.name = "BackgroundEnqueueError";
  }
}

interface Segment {
  format: 1;
  snapshot: RunSnapshot;
  continuation?: Continuation;
}

/** A root segment's stored result. The session status is only known to the worker that
 * appended, so it is kept beside the snapshot rather than derived from it. */
interface Settled {
  format: 1;
  snapshot: unknown;
  session?: SessionStatus;
}

function settled(raw: unknown): Settled {
  const invalid = () => new TypeError("This row's result is not an agent segment result.");
  if (!isRecord(raw) || raw.format !== 1) throw invalid();
  const session = raw.session;
  if (session === undefined) return { format: 1, snapshot: raw.snapshot };
  if (!isSessionStatus(session)) throw invalid();
  return { format: 1, snapshot: raw.snapshot, session };
}

/** Restore only the original pending route, using the latest receipts throughout.
 * Ancestors become running during coordination, before the leaf consumes its decision. */
function restoreApprovalRoute(snapshot: RunSnapshot, initial: RunSnapshot): boolean {
  const pending = initial.state;
  if (pending.status !== "suspended") return false;
  const route = [snapshot];
  let node = snapshot;
  for (const step of pending.path) {
    const child = node.delegations
      .find((journal) => journal.operationId === step.operationId)
      ?.children.find((child) => child.key === step.key && child.snapshot.runId === step.runId);
    if (!child) return false;
    node = child.snapshot;
    route.push(node);
  }
  if (node.state.status !== "suspended" || !equalData(node.state.approval, pending.approval))
    return false;
  for (const [index, ancestor] of route.entries()) {
    const state = ancestor.state;
    if (
      state.status !== "running" &&
      !(
        state.status === "suspended" &&
        equalData(state.approval, pending.approval) &&
        equalData(state.path, pending.path.slice(index))
      )
    )
      return false;
  }
  for (const [index, ancestor] of route.entries())
    ancestor.state = { ...copyData(pending), path: pending.path.slice(index) };
  return true;
}

/** Background work uses the host's lease, queue and cancellation. Children stay in-process.
 * Usage remains in stable SDK receipts; this binding never calls additive Run.spend. */
export function createBackgroundAgent<T>(options: BackgroundOptions<T>) {
  const { agent, kind, runs, enqueue, historyLimit, prepareHistory } = options;
  if (!isId(kind) || typeof enqueue !== "function" || typeof options.policy !== "function")
    throw new TypeError(
      "Provide a run kind, a durable enqueue callback and a trusted policy factory.",
    );
  if (options.session !== undefined && typeof options.session !== "function")
    throw new TypeError("The session option must be a factory: (owner, id) => Session.");
  checkOptions({ historyLimit, prepareHistory });
  const runtime = agent[AGENT_RUNTIME];

  async function sessionFor(owner: string, id: string, signal: AbortSignal): Promise<Session> {
    const factory = options.session;
    if (!factory)
      throw new TypeError(
        "This run uses a session. Pass a session factory to createBackgroundAgent.",
      );
    const session: unknown = await untilAbort(Promise.resolve(factory(owner, id)), signal);
    if (!isSession(session) || session.id !== id)
      throw new TypeError("The session factory must return the session with that id.");
    return session;
  }

  async function policy(context: BackgroundContext): Promise<BackgroundPolicy> {
    const value = await options.policy(immutableCopy(context));
    for (const key of [
      "authorizeResume",
      "approvalContext",
      "resolveApproval",
      "beforeTool",
      "claimContinuation",
    ] as const)
      if (typeof value?.[key] !== "function")
        throw new TypeError(`Background policy must implement ${key}.`);
    return value;
  }

  function segment(raw: unknown): Segment {
    if (!isRecord(raw) || raw.format !== 1)
      throw new TypeError("This row is not an agent background segment.");
    const snapshot = runtime.restore(raw.snapshot);
    if (raw.continuation === undefined) return { format: 1, snapshot };
    const continuation = raw.continuation;
    if (
      !isRecord(continuation) ||
      !isId(continuation.id) ||
      !isId(continuation.sourceId) ||
      continuation.decision === undefined
    )
      throw new TypeError("The saved continuation is invalid.");
    return {
      format: 1,
      snapshot,
      continuation: {
        id: continuation.id,
        sourceId: continuation.sourceId,
        decision: copyData(continuation.decision),
      },
    };
  }

  function restore(raw: unknown, initial: RunSnapshot): RunSnapshot {
    const saved = runtime.restore(raw);
    if (
      saved.runId !== initial.runId ||
      !equalData(saved.definition, initial.definition) ||
      !equalData(saved.history, initial.history) ||
      !equalData(saved.input, initial.input) ||
      !equalData(saved.session, initial.session) ||
      !equalData(saved.tree, initial.tree)
    )
      throw new TypeError("The saved journal belongs to another logical run.");
    return saved;
  }

  async function load(owner: string, id: string) {
    if (!isId(owner) || !isId(id))
      throw new TypeError("Provide an authenticated owner and run id.");
    const row = await runs.read(id, owner);
    if (!row || row.owner !== owner || row.kind !== kind)
      throw new Error("This background run was not found for this owner and agent.");
    const initial = segment(row.input);
    const result = row.status === "succeeded" ? settled(row.result) : undefined;
    const snapshot = restore(
      result ? result.snapshot : (row.checkpoint ?? initial.snapshot),
      initial.snapshot,
    );
    if (row.status === "succeeded" && snapshot.state.status === "running")
      throw new TypeError("The host segment ended without a settled agent journal.");
    return { row, initial, snapshot, session: result?.session };
  }

  async function read(owner: string, id: string): Promise<BackgroundRun<T>> {
    const { row, snapshot, session } = await load(owner, id);
    return {
      id: row.id,
      status: row.status,
      snapshot,
      outcome:
        snapshot.state.status === "running"
          ? null
          : { ...runtime.hydrate(snapshot), ...(session ? { session } : {}) },
      error: row.error,
    };
  }

  async function create(owner: string, initial: Segment): Promise<{ id: string }> {
    // Input is stored in the create transaction, before any id is acknowledged or queued.
    const created = await runs.create({ kind, owner, restart: "resume", input: copyData(initial) });
    try {
      await enqueue(created.id);
    } catch (cause) {
      throw new BackgroundEnqueueError(created.id, cause);
    }
    return created;
  }

  async function drive(run: Run): Promise<Settled> {
    run.signal.throwIfAborted();
    const initial = segment(run.input);
    const snapshot = restore(run.checkpoint ?? initial.snapshot, initial.snapshot);
    const trusted = await untilAbort(
      policy({
        owner: run.owner,
        segmentId: run.id,
        continuation: initial.continuation,
      }),
      run.signal,
    );
    run.signal.throwIfAborted();
    // From the stored owner, never from the request that queued this segment.
    const session = snapshot.session
      ? await sessionFor(run.owner, snapshot.session.id, run.signal)
      : undefined;
    run.signal.throwIfAborted();
    if (initial.continuation)
      await untilAbort(
        Promise.resolve(
          trusted.claimContinuation(
            immutableCopy(initial.snapshot),
            immutableCopy(initial.continuation),
          ),
        ),
        run.signal,
      );
    const parents = new Map<string, Run>([[snapshot.runId, run]]);
    const host: AgentHost & { authorizeResume: BackgroundPolicy["authorizeResume"] } = {
      authorizeResume(saved) {
        run.signal.throwIfAborted();
        return untilAbort(Promise.resolve(trusted.authorizeResume(saved)), run.signal);
      },
      approvalContext: (request) => trusted.approvalContext(request),
      resolveApproval: (approval, decision) => trusted.resolveApproval(approval, decision),
      beforeTool: (request, approval) => trusted.beforeTool(request, approval),
      canRunConcurrently: (request) => trusted.canRunConcurrently?.(request) === true,
      ...(trusted.loadMedia ? { loadMedia: trusted.loadMedia } : {}),
      async checkpoint(saved) {
        run.signal.throwIfAborted();
        await run.save(saved);
      },
      async child(request, execute) {
        const parent = parents.get(request.parentRunId);
        if (!parent) throw new Error("The child's active host parent is missing.");
        let key = request.snapshot.runId;
        for (;;) {
          let executed = false;
          const result = await parent.child<ChildEnvelope>(
            key,
            {
              kind,
              input: { format: 1, snapshot: request.snapshot },
              restart: "resume",
            },
            async (child) => {
              executed = true;
              parents.set(request.snapshot.runId, child);
              try {
                const envelope = await execute();
                run.signal.throwIfAborted();
                return { ...envelope, reference: child.id };
              } finally {
                parents.delete(request.snapshot.runId);
              }
            },
          );
          run.signal.throwIfAborted();
          if (!result.ok) throw new Error(`The host child failed: ${result.error.code}.`);
          const envelope = result.value;
          if (executed || envelope.snapshot.state.status !== "suspended") return envelope;
          // A successful host row cannot reopen. Walk past cached suspensions to a new
          // keyed segment. Completed receipts still return without invoking execute.
          if (!isId(envelope.reference))
            throw new Error("The suspended child has no host reference.");
          key = JSON.stringify([request.snapshot.runId, "after", envelope.reference]);
        }
      },
    };
    const continuation = initial.continuation;
    // Never reapply old evidence to a later approval or roll back a running effect marker.
    const pending = initial.snapshot.state;
    const decision =
      continuation && restoreApprovalRoute(snapshot, initial.snapshot)
        ? continuation.decision
        : undefined;
    const result = await agent.resume(snapshot, {
      signal: run.signal,
      context: trusted.context,
      host,
      ...(session ? { session } : {}),
      ...(decision !== undefined
        ? { decision, approvalPath: pending.status === "suspended" ? pending.path : [] }
        : {}),
      onEvent: (event) => run.emit("agent", event),
    });
    // The portable loop reports cancellation as data. The run service needs its control
    // exception back, or a cancelled/lost/draining worker could record a successful job.
    run.signal.throwIfAborted();
    return {
      format: 1,
      snapshot: result.snapshot,
      ...(result.session ? { session: result.session } : {}),
    };
  }

  const handlers: Readonly<Record<string, RunHandler>> = Object.freeze({ [kind]: drive });
  return Object.freeze({
    handlers,
    /** Saves the run before returning its id. With `sessionId`, the session's history is read
     * here, inside the authenticated request, and frozen into the run. `context` is only for
     * resolving instructions and tools here; worker tools use policy.context. `signal` stops
     * creation; it does not cancel the run once it is saved. */
    async start(
      owner: string,
      input: AgentInput,
      start: Pick<RunOptions, "signal" | "context" | "enabledTools"> & {
        sessionId?: string;
        modelSettings?: RecordedModelSettings;
      } = {},
    ): Promise<{ id: string }> {
      if (!isId(owner)) throw new TypeError("Provide an authenticated owner.");
      if (
        !isRecord(start) ||
        (start.sessionId !== undefined && !isId(start.sessionId)) ||
        (start.signal !== undefined && !(start.signal instanceof AbortSignal))
      )
        throw new TypeError("Start options take a sessionId and a signal.");
      checkOptions(start);
      const modelSettings = readModelSettings(start.modelSettings);
      if (modelSettings.onActivity || modelSettings.onRateLimit)
        throw new TypeError(
          "Background modelSettings cannot keep observers. Set onActivity and onRateLimit on the agent instead.",
        );
      const signal = start.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const session =
        start.sessionId === undefined
          ? undefined
          : await sessionFor(owner, start.sessionId, signal);
      const snapshot = await runtime.open(
        input,
        { ...start, session, historyLimit, prepareHistory, signal },
        crypto.randomUUID(),
      );
      signal.throwIfAborted();
      return create(owner, { format: 1, snapshot: runtime.restore(snapshot) });
    },
    read,
    async *observe(
      owner: string,
      id: string,
      afterSeq = 0,
      signal?: AbortSignal,
    ): AsyncGenerator<RunEvent> {
      await load(owner, id);
      for await (const event of runs.tail(id, afterSeq, signal)) {
        if (signal?.aborted) return;
        yield event;
      }
    },
    async wait(owner: string, id: string, signal?: AbortSignal): Promise<BackgroundRun<T>> {
      await load(owner, id);
      for await (const _event of runs.tail(id, 0, signal)) signal?.throwIfAborted();
      signal?.throwIfAborted();
      return read(owner, id);
    },
    async cancel(owner: string, id: string): Promise<boolean> {
      await load(owner, id);
      return runs.cancel(id);
    },
    /** Queues decision evidence, not permission. The leased worker claims it; read or wait
     * for that segment's outcome to learn whether the host accepted it. */
    async resume(owner: string, id: string, decision: unknown): Promise<{ id: string }> {
      const { row, snapshot } = await load(owner, id);
      if (row.status !== "succeeded" || snapshot.state.status !== "suspended")
        throw new Error("Only a settled, suspended agent segment can accept a decision.");
      if (snapshot.state.approval.scope.expiresAt <= Date.now())
        throw new Error("The approval expired. Request a new decision before continuing.");
      if (decision === undefined)
        throw new TypeError("Provide decision evidence from the authenticated caller.");
      const continuation = copyData({ id: crypto.randomUUID(), sourceId: id, decision });
      return create(owner, { format: 1, snapshot, continuation });
    },
  });
}
