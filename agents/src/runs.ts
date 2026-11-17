import type {
  createRuns,
  ChildResult,
  ChildSpec,
  Run,
  RunEvent,
  StoredRun,
} from "@gusnips/server/runs";
import { createProgress, type EventDurability } from "./progress.ts";
export type { EventDurability, ProgressGap } from "./progress.ts";
import { checkMemoryBinding, readMemoryBinding, type MemoryBinding } from "./memory.ts";
import type { NodeOutcome } from "./delegation.ts";
import type { Workflow, WorkflowOutcome } from "./workflow-types.ts";
import { AGENT_RUNTIME } from "./delegation.ts";
import {
  checkOptions,
  checkChildProgress,
  copyData,
  immutableCopy,
  isId,
  isRecord,
  isSession,
  isSessionStatus,
  readModelSettings,
} from "./snapshot.ts";
import { openRequests, readAnswers, untilAbort, wakeAt } from "./tree.ts";
import type {
  Agent,
  AgentHost,
  AgentInput,
  ChildEnvelope,
  RecordedModelSettings,
  RunOptions,
  RunOutcome,
  TreeNode,
  ResumeOptions,
  Session,
  SessionStatus,
} from "./types.ts";

export type BackgroundRuns = Pick<
  ReturnType<typeof createRuns>,
  "create" | "read" | "tail" | "cancel"
>;

/** Minimum worker capabilities. Server 0.19/0.20 remain valid in best-effort mode,
 * including their child callbacks; only awaited mode needs append. */
export interface BackgroundWorker extends Pick<
  Run,
  "id" | "owner" | "input" | "checkpoint" | "resumed" | "crashes" | "signal" | "save" | "emit"
> {
  append?: (events: readonly { type: string; data?: unknown }[]) => Promise<void>;
  child<T>(
    key: string,
    spec: ChildSpec,
    fn: (run: BackgroundWorker) => Promise<T>,
  ): Promise<ChildResult<T>>;
}

export interface Continuation {
  /** Unique authorization claim, distinct from both the logical run and the host row. */
  id: string;
  sourceId: string;
  /** Empty-answer continuations must atomically claim this wake for this logical run. */
  wakeAt?: number;
  answers: Readonly<Record<string, unknown>>;
}

export interface BackgroundContext {
  /** From the authenticated caller, or from Run.owner inside a worker. */
  owner: string;
  segmentId: string;
  continuation?: Continuation;
}

export interface BackgroundPolicy
  extends
    Pick<RunOptions, "onEvent" | "onLifecycle" | "bindModelProvider">,
    Required<
      Pick<AgentHost, "authorizeResume" | "prepareRequest" | "resolveRequest" | "beforeTool">
    >,
    Pick<
      AgentHost,
      | "canRunConcurrently"
      | "needsApproval"
      | "answerNow"
      | "inbox"
      | "reconcileToolRetry"
      | "beforeStep"
      | "reconcileStep"
    > {
  /** Worker-only values for tools, such as the authenticated actor or a database handle.
   * Never serialized. The SDK supplies reserved operation IDs and cancellation signals. */
  context?: RunOptions["context"];
  /** Reads media references for this owner's run. Check that the owner may read each id. */
  loadMedia?: AgentHost["loadMedia"];
  /** Called under the worker's lease, after its row exists. Authenticate every answer,
   * recheck resource version/expiry and atomically reserve each exact request for continuation.id
   * AND context.segmentId. Repeating that exact claim must succeed; any other claim or segment
   * must fail. authorizeResume checks ownership on every attempt. resolveRequest may reuse a
   * consumed answer only for this same claim/segment. These guarantees need durable host state. */
  claimContinuation: (snapshot: TreeNode, continuation: Continuation) => void | Promise<void>;
}

export interface BackgroundOptions<T> extends BackgroundBase {
  agent: Agent<T>;
}
export interface BackgroundWorkflowOptions<I, O> extends Omit<
  BackgroundBase,
  "session" | "historyLimit" | "prepareHistory"
> {
  workflow: Workflow<I, O>;
}
interface BackgroundBase {
  /** Dedicated handler key for this agent version. */
  kind: string;
  /** Injected create must resolve after its transaction commits. Only then is enqueue called. */
  runs: BackgroundRuns;
  /** Coalesced progress uses emit by default. Awaited mode needs Run.append (server 0.21+). */
  events?: EventDurability;
  /** Await durable queue acceptance. A worker calls runs.drive(id, background.handlers).
   * The host must also run runs.sweep on boot and periodically, and drain on shutdown. */
  enqueue: (id: string) => Promise<void>;
  policy: (context: BackgroundContext) => BackgroundPolicy | Promise<BackgroundPolicy>;
  /** Trusted. Return the session `id` names, after checking that `owner` may use it: an id
   * from a request is not authorization. `start` reads its history inside the authenticated
   * request; the worker gets it again, with the stored owner, to append the turn. */
  session?: (owner: string, id: string) => Session | Promise<Session>;
  /** Authenticate scopes in start and again in the worker. A changed erasure revision refuses
   * resume; this factory never recalls notes or ingests a completed run automatically. */
  memory?: (owner: string) => MemoryBinding | Promise<MemoryBinding>;
  /** How many of the session's newest messages `start` loads. */
  historyLimit?: number;
  /** Runs once in `start`, before the run is saved. See RunOptions.prepareHistory. */
  prepareHistory?: RunOptions["prepareHistory"];
}

/** Server-side: the snapshot holds the whole conversation, prompts and tool data. Send a
 * browser a projection, never this object. */
export interface BackgroundRun<T, R extends NodeOutcome<T> = RunOutcome<T>> {
  id: string;
  /** Host completion is not SDK completion: a successful segment can be suspended or failed. */
  status: StoredRun["status"];
  snapshot: R["snapshot"];
  /** outcome.session says whether the worker's append saved the turn. */
  outcome: R | null;
  /** Earliest pending wake in the tree. The host schedules continuation. */
  wakeAt?: number;
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

interface Segment<N extends TreeNode = TreeNode> {
  format: 1;
  snapshot: N;
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

/** Background work uses the host's lease, queue and cancellation. Children stay in-process.
 * Usage remains in stable SDK receipts; this binding never calls additive Run.spend. */
export function createBackgroundAgent<T>(
  options: BackgroundOptions<T>,
): ReturnType<typeof bindBackground<AgentInput, RunOutcome<T>>>;
export function createBackgroundAgent<I, O>(
  options: BackgroundWorkflowOptions<I, O>,
): ReturnType<typeof bindBackground<I, WorkflowOutcome<O>>>;
export function createBackgroundAgent<I, O>(
  options: BackgroundOptions<O> | BackgroundWorkflowOptions<I, O>,
) {
  if ("workflow" in options) {
    const workflow = options.workflow;
    return bindBackground<I, WorkflowOutcome<O>>(options, {
      ...workflow[AGENT_RUNTIME],
      resume: (raw, opts) => workflow.resume(raw, opts),
    });
  }
  const agent = options.agent;
  const runtime = agent[AGENT_RUNTIME];
  return bindBackground<AgentInput, RunOutcome<O>>(options, {
    open: (input, opts, id) => runtime.open(input, opts, id),
    restore: (raw) => runtime.restore(raw),
    hydrate: (snapshot) => runtime.node.hydrate(snapshot),
    resume: (raw, opts) => agent.resume(raw, opts),
  });
}
function bindBackground<I, R extends NodeOutcome>(
  options: BackgroundBase,
  runtime: {
    open(input: I, options: RunOptions, runId: string): Promise<R["snapshot"]>;
    restore(raw: unknown): R["snapshot"];
    hydrate(snapshot: TreeNode): R;
    resume(raw: unknown, options: ResumeOptions): Promise<R>;
  },
) {
  const { kind, runs, enqueue, historyLimit, prepareHistory, events = "best-effort" } = options;
  if (events !== "best-effort" && events !== "awaited")
    throw new TypeError('events must be "best-effort" or "awaited".');
  if (!isId(kind) || typeof enqueue !== "function" || typeof options.policy !== "function")
    throw new TypeError(
      "Provide a run kind, a durable enqueue callback and a trusted policy factory.",
    );
  if (options.session !== undefined && typeof options.session !== "function")
    throw new TypeError("The session option must be a factory: (owner, id) => Session.");
  checkOptions({ historyLimit, prepareHistory });
  if (options.memory !== undefined && typeof options.memory !== "function")
    throw new TypeError("The memory option must be a trusted owner-to-binding factory.");
  async function memoryFor(owner: string, signal: AbortSignal) {
    return options.memory
      ? readMemoryBinding(await untilAbort(Promise.resolve(options.memory(owner)), signal))
      : undefined;
  }
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
      "prepareRequest",
      "resolveRequest",
      "beforeTool",
      "claimContinuation",
    ] as const)
      if (typeof value?.[key] !== "function")
        throw new TypeError(`Background policy must implement ${key}.`);
    return value;
  }

  function segment(raw: unknown): Segment<R["snapshot"]> {
    if (!isRecord(raw) || raw.format !== 1)
      throw new TypeError("This row is not an agent background segment.");
    const snapshot = runtime.restore(raw.snapshot);
    if (raw.continuation === undefined) return { format: 1, snapshot };
    const continuation = raw.continuation;
    if (
      !isRecord(continuation) ||
      !isId(continuation.id) ||
      !isId(continuation.sourceId) ||
      !isRecord(continuation.answers) ||
      (continuation.wakeAt !== undefined &&
        (typeof continuation.wakeAt !== "number" || continuation.wakeAt !== wakeAt(snapshot)))
    )
      throw new TypeError("The saved continuation is invalid.");
    return {
      format: 1,
      snapshot,
      continuation: {
        id: continuation.id,
        sourceId: continuation.sourceId,
        ...(typeof continuation.wakeAt === "number" ? { wakeAt: continuation.wakeAt } : {}),
        answers: readAnswers(snapshot, continuation.answers),
      },
    };
  }

  function restore(raw: unknown, initial: TreeNode): R["snapshot"] {
    const saved = runtime.restore(raw);
    checkChildProgress(initial, saved);
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

  async function read(owner: string, id: string): Promise<BackgroundRun<unknown, R>> {
    const { row, snapshot, session } = await load(owner, id);
    return {
      id: row.id,
      status: row.status,
      snapshot,
      wakeAt: wakeAt(snapshot),
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

  async function drive(run: BackgroundWorker): Promise<Settled> {
    run.signal.throwIfAborted();
    // Capability refusal happens before policy, model or tool work. No timer survives drive.
    const progress = createProgress(run, events);
    try {
      return await execute(run, progress);
    } finally {
      try {
        await progress.flush();
      } finally {
        await progress.dispose();
      }
    }
  }

  async function execute(
    run: BackgroundWorker,
    progress: ReturnType<typeof createProgress>,
  ): Promise<Settled> {
    const signal = AbortSignal.any([run.signal, progress.signal]);
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
    const session =
      snapshot.kind === "agent" && snapshot.session
        ? await sessionFor(run.owner, snapshot.session.id, run.signal)
        : undefined;
    const memory = await memoryFor(run.owner, signal);
    checkMemoryBinding(snapshot, memory);
    run.signal.throwIfAborted();
    if (initial.continuation?.wakeAt !== undefined && Date.now() < initial.continuation.wakeAt)
      throw new Error("The saved workflow wake is not due yet.");
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
    if (run.resumed) await progress.resync(run.crashes);
    const parents = new Map<string, BackgroundWorker>([[snapshot.runId, run]]);
    const host: AgentHost & { authorizeResume: BackgroundPolicy["authorizeResume"] } = {
      progress,
      authorizeResume(saved) {
        run.signal.throwIfAborted();
        return untilAbort(Promise.resolve(trusted.authorizeResume(saved)), run.signal);
      },
      prepareRequest: (request) => trusted.prepareRequest(request),
      resolveRequest: (request, evidence) => trusted.resolveRequest(request, evidence),
      beforeTool: (request, decided) => trusted.beforeTool(request, decided),
      ...(trusted.beforeStep ? { beforeStep: trusted.beforeStep } : {}),
      ...(trusted.reconcileStep ? { reconcileStep: trusted.reconcileStep } : {}),
      ...(trusted.reconcileToolRetry ? { reconcileToolRetry: trusted.reconcileToolRetry } : {}),
      ...(trusted.needsApproval ? { needsApproval: trusted.needsApproval } : {}),
      ...(trusted.answerNow ? { answerNow: trusted.answerNow } : {}),
      canRunConcurrently: (request) => trusted.canRunConcurrently?.(request) === true,
      ...(trusted.loadMedia ? { loadMedia: trusted.loadMedia } : {}),
      ...(trusted.inbox ? { inbox: trusted.inbox } : {}),
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
    // A recovered segment may already have saved some decisions. Reuse only still-open
    // ids from this exact claim; never apply the old evidence to a replacement request.
    const pending = new Set(openRequests(snapshot).map((request) => request.id));
    const answers = Object.fromEntries(
      Object.entries(initial.continuation?.answers ?? {}).filter(([id]) => pending.has(id)),
    );
    const result = await runtime.resume(snapshot, {
      signal,
      context: trusted.context,
      onEvent: trusted.onEvent,
      onLifecycle: trusted.onLifecycle,
      bindModelProvider: trusted.bindModelProvider,
      memory,
      host,
      ...(session ? { session } : {}),
      answers,
    });
    // The portable loop reports cancellation as data. The run service needs its control
    // exception back, or a cancelled/lost/draining worker could record a successful job.
    run.signal.throwIfAborted();
    return {
      format: 1,
      snapshot: result.snapshot,
      ...("session" in result && result.session ? { session: result.session } : {}),
    };
  }

  const handlers: Readonly<Record<string, (run: BackgroundWorker) => Promise<unknown>>> =
    Object.freeze({ [kind]: drive });
  return Object.freeze({
    handlers,
    /** Saves the run before returning its id. With `sessionId`, the session's history is read
     * here, inside the authenticated request, and frozen into the run. `context` is only for
     * resolving instructions and tools here; worker tools use policy.context. `signal` stops
     * creation; it does not cancel the run once it is saved. */
    async start(
      owner: string,
      input: I,
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
      const memory = await memoryFor(owner, signal);
      const snapshot = await runtime.open(
        input,
        { ...start, memory, session, historyLimit, prepareHistory, signal },
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
    async wait(
      owner: string,
      id: string,
      signal?: AbortSignal,
    ): Promise<BackgroundRun<unknown, R>> {
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
    async resume(
      owner: string,
      id: string,
      answers: Readonly<Record<string, unknown>>,
    ): Promise<{ id: string }> {
      const { row, snapshot } = await load(owner, id);
      if (row.status !== "succeeded" || snapshot.state.status !== "suspended")
        throw new Error("Only a settled, suspended agent segment can accept a decision.");
      const submitted = readAnswers(snapshot, answers);
      if (!Object.keys(submitted).length) {
        const at = wakeAt(snapshot);
        if (at === undefined || at > Date.now())
          throw new TypeError(
            at === undefined
              ? "Provide at least one answer by request id."
              : `This workflow wakes at ${at}. Continue at or after that time.`,
          );
      }
      if (
        openRequests(snapshot).some(
          (request) =>
            Object.hasOwn(submitted, request.id) && request.scope.expiresAt <= Date.now(),
        )
      )
        throw new Error("A request expired. Ask the host to renew it before continuing.");
      const continuation = copyData({
        id: crypto.randomUUID(),
        sourceId: id,
        answers: submitted,
        ...(!Object.keys(submitted).length ? { wakeAt: wakeAt(snapshot) } : {}),
      });
      return create(owner, { format: 1, snapshot, continuation });
    },
  });
}
