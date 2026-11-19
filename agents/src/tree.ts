import { EMPTY_USAGE, addUsage, createGate, messageOf, type TokenUsage } from "@providerkit/core";
import type { RemoteSend } from "./a2a/remote.ts";
import { allModels } from "./compaction.ts";
import { modelUsage } from "./recovery.ts";
import { copyData, immutableCopy, isRecord } from "./snapshot.ts";
import type { StepExecution } from "./workflow-types.ts";
import type {
  AgentEvent,
  AgentHost,
  AskRecord,
  ChildPathStep,
  RunOptions,
  RunLimits,
  TreeNode,
  RunState,
  ToolExecution,
  UserContent,
} from "./types.ts";

export type StopState = Exclude<RunState, { status: "running" | "completed" }>;

export class Halt extends Error {
  constructor(readonly state: StopState) {
    super(state.status);
  }
}

/** Only known specialist-local outcomes can become tool data. Unknown codes fail closed. */
export function isLocalStop(state: RunState): boolean {
  return (
    (state.status === "limited" &&
      ["turns", "toolCalls", "elapsedMs", "outputTokens", "steps", "costUsd"].includes(
        state.limit,
      )) ||
    (state.status === "failed" &&
      [
        "model_failed",
        "step_failed",
        "workflow_failed",
        "invalid_model_output",
        "content_filtered",
        "incomplete_turn",
        "missing_result",
        "empty_output",
        "memory_missing",
        "memory_unavailable",
        "remote_failed",
        "remote_invalid_output",
        "remote_auth_required",
        "remote_input_required",
        "remote_request_unsupported",
        "remote_result_too_large",
        "remote_cancelled",
      ].includes(state.error.code))
  );
}

export function fail(code: string, message: string, operationId?: string): never {
  throw new Halt({ status: "failed", error: { code, message, operationId } });
}

/** Progress is not the durable journal, and an observer cannot stop execution. It gets a
 * frozen copy, is never awaited, and whatever it throws or rejects with is dropped. */
export function emitEvent(options: RunOptions, event: AgentEvent): void {
  // Storage is not an observer. Its failures must reach execution and the checkpoint barrier.
  options.host?.progress?.push(immutableCopy(event));
  try {
    void Promise.resolve(options.onEvent?.(immutableCopy(event))).catch(() => {});
  } catch {
    // Dropped on purpose: see above.
  }
}

/** Cancellation stops SDK work, not external effects which ignore their signal. */
export async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function childJournals(root: TreeNode) {
  return root.kind === "agent"
    ? root.delegations
    : root.kind === "remote"
      ? []
      : root.steps.map((step) => ({
          operationId: step.id,
          children: step.children,
        }));
}

export function nodeId(node: TreeNode): string {
  return node.kind === "workflow" ? node.workflowId : node.agentId;
}

export function* snapshots(root: TreeNode): Generator<TreeNode> {
  yield root;
  for (const journal of childJournals(root))
    for (const child of journal.children) yield* snapshots(child.snapshot);
}

export function wakeAt(root: TreeNode): number | undefined {
  const wakes = [...snapshots(root)].flatMap((node) => {
    if (node.state.status !== "running" && node.state.status !== "suspended") return [];
    if (node.kind === "remote") return node.remote.wakeAt === undefined ? [] : [node.remote.wakeAt];
    return node.kind === "workflow"
      ? node.steps.flatMap((step) =>
          (step.status === "waiting" || step.status === "retrying") && step.wakeAt !== undefined
            ? [step.wakeAt]
            : [],
        )
      : [];
  });
  return wakes.length ? Math.min(...wakes) : undefined;
}

/** Requests come from the effect journal, in tool and child admission order. */
export function* requestRecords(root: TreeNode): Generator<{
  record: AskRecord;
  execution: ToolExecution | StepExecution | RemoteSend;
  snapshot: TreeNode;
}> {
  if (root.kind === "remote") {
    for (const execution of root.remote.sends)
      for (const record of execution.asks ?? []) yield { record, execution, snapshot: root };
    return;
  }
  if (root.kind === "workflow") {
    for (const execution of root.steps) {
      for (const record of execution.asks ?? []) yield { record, execution, snapshot: root };
      for (const child of execution.children) yield* requestRecords(child.snapshot);
    }
    return;
  }
  for (const model of root.models) {
    if (model.status !== "completed") continue;
    for (const execution of model.tools) {
      for (const record of execution.asks ?? []) yield { record, execution, snapshot: root };
      for (const call of execution.calls ?? [])
        for (const record of call.asks ?? []) yield { record, execution: call, snapshot: root };
      const delegation = root.delegations.find((journal) => journal.operationId === execution.id);
      for (const child of delegation?.children ?? []) yield* requestRecords(child.snapshot);
    }
  }
}

export function openRequests(root: TreeNode) {
  if (root.state.status !== "running" && root.state.status !== "suspended") return [];
  return [...requestRecords(root)]
    .filter(
      ({ record, execution, snapshot }) =>
        (snapshot.state.status === "running" || snapshot.state.status === "suspended") &&
        execution.status !== "completed" &&
        !record.request.call?.parentOperationId &&
        !record.decision &&
        !record.closed,
    )
    .map(({ record }) => ({
      ...copyData(record.request),
      ...(record.problem ? { problem: copyData(record.problem) } : {}),
    }));
}

/** Do this before authorization callbacks. A JSON object cannot contain duplicate keys after
 * parsing; HTTP hosts must reject duplicate raw JSON members before constructing this map. */
export function readAnswers(root: TreeNode, value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Object.values(value).some((evidence) => evidence === undefined))
    throw new TypeError("Provide JSON evidence by request id.");
  const pending = new Set(openRequests(root).map((request) => request.id));
  for (const id of Object.keys(value))
    if (!pending.has(id))
      throw new TypeError("An answer names an unknown, closed or already-decided request.");
  return copyData(value);
}

export function stopRequests(root: TreeNode): void {
  for (const { record } of requestRecords(root))
    if (!record.closed && !record.decision) record.closed = "stopped";
  for (const snapshot of snapshots(root))
    if (snapshot.state.status === "running" || snapshot.state.status === "suspended")
      snapshot.state = { status: "cancelled" };
}

/** Count local receipts once. Never add a child's already aggregated total. */
export function treeUsage(root: TreeNode): TokenUsage {
  let usage = { ...EMPTY_USAGE };
  const seen = new Set<string>();
  for (const snapshot of snapshots(root)) {
    if (snapshot.kind !== "agent") continue;
    for (const model of allModels(snapshot)) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      usage = addUsage(usage, modelUsage(model));
    }
  }
  return usage;
}

/** USD of the known calls under this node, from the prices saved with them, never priced
 * again. Counted the way treeUsage counts usage. */
export function knownCostUsd(root: TreeNode): number {
  let cost = 0;
  const seen = new Set<string>();
  for (const snapshot of snapshots(root)) {
    if (snapshot.kind !== "agent") continue;
    for (const model of allModels(snapshot)) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      cost += model.interrupted.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0);
      cost += model.costUsd ?? 0;
    }
  }
  return cost;
}

/** A cost limit counts prices only the host knows. Without them no call would ever count, so
 * the limit would never stop anything: refuse it before anything is saved or resumed. */
export function requirePricing(limits: RunLimits, host: AgentHost | undefined): void {
  if (limits.costUsd !== undefined && !host?.priceModelCall)
    throw new TypeError(
      "limits.costUsd needs host.priceModelCall, which prices each model call in USD.",
    );
}

/** requirePricing for every agent in a restored tree. */
export function checkPricing(root: TreeNode, host: AgentHost | undefined): void {
  for (const node of snapshots(root)) if (node.kind === "agent") requirePricing(node.limits, host);
}

export async function authorizeTree(root: TreeNode, host: AgentHost): Promise<void> {
  if (!host.authorizeResume)
    throw new TypeError("Resume requires a trusted host.authorizeResume callback.");
  // A parent's ownership is not authority over a descendant's tools or approvals.
  for (const snapshot of snapshots(root)) await host.authorizeResume(immutableCopy(snapshot));
}

/** One root lease belongs to the host. This scope only coordinates its in-process tree. */
export class ExecutionTree {
  readonly signal: AbortSignal;
  readonly gate;
  private readonly timeout = new AbortController();
  private readonly broken = new AbortController();
  private readonly timer;
  private writes = Promise.resolve();
  private toolBarrier = Promise.resolve();
  private toolsSettled = Promise.resolve();
  private checkpointFailure: Extract<RunState, { status: "failed" }> | undefined;

  constructor(
    readonly root: TreeNode,
    private readonly options: RunOptions,
  ) {
    this.gate = createGate(root.tree.limits.maxParallel);
    this.signal = AbortSignal.any([
      this.timeout.signal,
      this.broken.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    this.timer = setTimeout(
      () => this.timeout.abort(new Error("The agent tree reached its time limit.")),
      Math.max(0, root.tree.startedAt + root.tree.limits.elapsedMs - Date.now()),
    );
  }

  /** A failed checkpoint fails every later one, so the host's saved journal stops at the last
   * write that succeeded and the returned state was never stored. */
  get checkpointFailed(): boolean {
    return this.checkpointFailure !== undefined;
  }

  active(): void {
    if (this.checkpointFailure) throw new Halt(this.checkpointFailure);
    if (this.options.signal?.aborted || this.root.state.status === "cancelled")
      throw new Halt({ status: "cancelled" });
    if (
      this.timeout.signal.aborted ||
      Date.now() >= this.root.tree.startedAt + this.root.tree.limits.elapsedMs
    )
      throw new Halt({ status: "limited", limit: "treeElapsedMs" });
  }

  reserveModel(): void {
    this.active();
    // ponytail: a bounded tree is small. Deriving counters from the journal also
    // preserves every reservation across resume without a second mutable ledger.
    let models = 0;
    for (const snapshot of snapshots(this.root))
      if (snapshot.kind === "agent")
        for (const model of allModels(snapshot)) models += 1 + model.interrupted.length;
    if (models >= this.root.tree.limits.modelCalls)
      throw new Halt({ status: "limited", limit: "modelCalls" });
  }

  /** Checks the caller and every agent above it, found by the caller's scope path, against
   * its own cost limit, so a helper stops once its creator's budget is spent. Synchronous like
   * reserveModel, so the check and the receipt it admits never straddle an await. */
  reserveCost(path: readonly ChildPathStep[]): void {
    let node: TreeNode = this.root;
    const lineage = [node];
    for (const step of path) {
      const child = childJournals(node)
        .find((journal) => journal.operationId === step.operationId)
        ?.children.find((entry) => entry.key === step.key);
      if (!child) fail("invalid_journal", "A run's place in its tree is missing from the journal.");
      node = child.snapshot;
      lineage.push(node);
    }
    // ponytail: each check walks the bounded subtree again, as reserveModel does, so the
    // saved prices stay the only ledger across resume.
    for (const holder of lineage)
      if (
        holder.kind === "agent" &&
        holder.limits.costUsd !== undefined &&
        knownCostUsd(holder) >= holder.limits.costUsd
      )
        throw new Halt({ status: "limited", limit: "costUsd" });
  }

  /** Preflight only. reserveChild rechecks against the live journal at each admission. */
  childRoom(depth: number): number {
    this.active();
    return depth > this.root.tree.limits.maxDepth
      ? 0
      : this.root.tree.limits.maxChildren - ([...snapshots(this.root)].length - 1);
  }

  reserveChild(depth: number): void {
    this.active();
    if (depth > this.root.tree.limits.maxDepth)
      throw new Halt({ status: "limited", limit: "maxDepth" });
    if ([...snapshots(this.root)].length - 1 >= this.root.tree.limits.maxChildren)
      throw new Halt({ status: "limited", limit: "maxChildren" });
  }

  async invokeTool<T>(
    parallel: boolean,
    signal: AbortSignal,
    invoke: () => Promise<T>,
  ): Promise<T> {
    // Safe calls share a barrier. A serial call waits for all prior calls and
    // becomes the barrier for later ones, across every specialist in this tree.
    const previous = parallel ? this.toolBarrier : this.toolsSettled;
    const work = previous.then(() => {
      signal.throwIfAborted();
      return untilAbort(invoke(), signal);
    });
    const settled = work.then(
      () => {},
      () => {},
    );
    this.toolsSettled = Promise.all([this.toolsSettled, settled]).then(() => {});
    if (!parallel) this.toolBarrier = this.toolsSettled;
    // Cancelling a queued call must return without waiting for another child.
    // This cannot stop external effects that ignore their signal.
    return untilAbort(work, signal);
  }

  async save(): Promise<void> {
    const saved = immutableCopy(this.root);
    // Every descendant writes the whole root through this one queue. Capturing at
    // enqueue time keeps a slow earlier save from erasing a newer child's receipt.
    // Seal progress at the same boundary as the snapshot, not when a queued write eventually
    // runs. Handle its rejection now even if an older checkpoint is still pending.
    const progress = (async () => {
      try {
        await this.options.host?.progress?.flush();
        return { ok: true as const };
      } catch (cause) {
        return { ok: false as const, cause };
      }
    })();
    const write = this.writes.then(async () => {
      if (this.checkpointFailure) throw new Halt(this.checkpointFailure);
      try {
        const flushed = await progress;
        if (!flushed.ok) throw flushed.cause;
        await this.options.host?.checkpoint?.(saved);
      } catch (error) {
        this.checkpointFailure = {
          status: "failed",
          error: {
            code: "checkpoint_failed",
            message: `Checkpoint failed: ${messageOf(error)}. Reconcile stored state before resuming.`,
          },
        };
        this.broken.abort(error);
        throw new Halt(this.checkpointFailure);
      }
    });
    // Fail closed through checkpointFailure, not a poisoned promise chain.
    this.writes = write.then(
      () => {},
      () => {},
    );
    await write;
  }

  stop(): void {
    stopRequests(this.root);
    this.broken.abort(new Halt({ status: "cancelled" }));
  }

  close(): void {
    clearTimeout(this.timer);
  }
}

export interface ExecutionScope {
  tree: ExecutionTree;
  depth: number;
  path: ChildPathStep[];
  /** Latest real user input along this handoff chain, rebuilt from the source journals.
   * A handoff's own input is an SDK transfer notice, not a recall query. */
  handoffInput?: UserContent;
}
