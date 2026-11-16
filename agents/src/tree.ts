import { EMPTY_USAGE, addUsage, createGate, messageOf, type TokenUsage } from "@providerkit/core";
import { immutableCopy } from "./snapshot.ts";
import type { AgentEvent, AgentHost, RunOptions, RunSnapshot, RunState } from "./types.ts";

export type StopState = Exclude<RunState, { status: "running" | "completed" }>;

export class Halt extends Error {
  constructor(readonly state: StopState) {
    super(state.status);
  }
}

export function fail(code: string, message: string, operationId?: string): never {
  throw new Halt({ status: "failed", error: { code, message, operationId } });
}

/** Progress is not the durable journal, and an observer cannot stop execution. It gets a
 * frozen copy, is never awaited, and whatever it throws or rejects with is dropped. */
export function emitEvent(options: RunOptions, event: AgentEvent): void {
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

export function* snapshots(root: RunSnapshot): Generator<RunSnapshot> {
  yield root;
  for (const delegation of root.delegations)
    for (const child of delegation.children) yield* snapshots(child.snapshot);
}

/** Count local receipts once. Never add a child's already aggregated total. */
export function treeUsage(root: RunSnapshot): TokenUsage {
  let usage = { ...EMPTY_USAGE };
  const seen = new Set<string>();
  for (const snapshot of snapshots(root)) {
    for (const model of snapshot.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      usage = addUsage(usage, model.usage);
    }
  }
  return usage;
}

export async function authorizeTree(root: RunSnapshot, host: AgentHost): Promise<void> {
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
    readonly root: RunSnapshot,
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

  active(): void {
    if (this.checkpointFailure) throw new Halt(this.checkpointFailure);
    if (this.options.signal?.aborted) throw new Halt({ status: "cancelled" });
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
    for (const snapshot of snapshots(this.root)) models += snapshot.models.length;
    if (models >= this.root.tree.limits.modelCalls)
      throw new Halt({ status: "limited", limit: "modelCalls" });
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
    this.writes = this.writes.then(async () => {
      await this.options.host?.checkpoint?.(saved);
    });
    try {
      await this.writes;
    } catch (error) {
      this.checkpointFailure ??= {
        status: "failed",
        error: {
          code: "checkpoint_failed",
          message: `Checkpoint failed: ${messageOf(error)}. Reconcile stored state before resuming.`,
        },
      };
      this.broken.abort(error);
      throw new Halt(this.checkpointFailure);
    }
  }

  close(): void {
    clearTimeout(this.timer);
  }
}

export interface ExecutionScope {
  tree: ExecutionTree;
  depth: number;
}
