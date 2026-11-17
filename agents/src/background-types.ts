import type { AgentHost, RunOptions, RunState, TreeNode } from "./types.ts";

/** Portable host policy contracts. No optional server package is imported here. */
export type Continuation = {
  /** Authorization claim, distinct from both the logical run and the host row. */
  id: string;
  sourceId: string;
} & (
  | { kind: "answers"; answers: Readonly<Record<string, unknown>>; wakeAt?: number }
  /** Control command, never an answer, approval or scheduled wake. */
  | { kind: "cancel"; answers: Readonly<Record<string, never>>; wakeAt?: never }
);

/** Portable input to the host's atomic continuation admission. The host must authenticate
 * owner, lock the current source and create OR reconcile (owner, sourceId, continuation.id).
 * Save this exact input and commit before returning. A repeated claim returns the same
 * physical id, including after a lost reply. A different input for that claim must fail. */
export interface BackgroundContinuationInput {
  kind: string;
  owner: string;
  restart: "resume";
  input: { format: 1; snapshot: TreeNode; continuation: Continuation };
}
export interface BackgroundContinuationResult {
  id: string;
}

/** Queue acceptance is not cancellation proof. Observe id, which can be a fresh segment. */
export interface BackgroundCancelResult {
  id: string;
  requested: boolean;
}

export interface BackgroundContext {
  /** From the authenticated caller, or from the stored worker owner. */
  owner: string;
  /** Logical execution identity, retained across physical segments. Not ownership proof. */
  runId: string;
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
  /** Worker-only values for tools. Never serialized; the SDK supplies reserved IDs/signals. */
  context?: RunOptions["context"];
  /** Check that the current owner may read each media reference. */
  loadMedia?: AgentHost["loadMedia"];
  /** Under the worker's lease, authenticate every answer and atomically reserve each exact
   * request for continuation.id AND context.segmentId. Repeating that claim succeeds; another
   * claim or segment fails. Empty answers must claim the exact due wake, except an explicit
   * cancel command: claim that command against the current logical segment without granting
   * any pending request. The host owns the durable state. authorizeResume rechecks ownership,
   * and resolveRequest may reuse a consumed
   * answer only within this same claim and segment. */
  claimContinuation(snapshot: TreeNode, continuation: Continuation): void | Promise<void>;
}

/** Awaited root-segment boundary. Snapshot data is private, never a browser or peer response.
 * End means the SDK journal settled, NOT that the host marked its worker row successful.
 * A worker restart can repeat a hook. Persist/reconcile external effects before sending them. */
export type SegmentHook = (event: {
  phase: "start" | "end";
  owner: string;
  /** Physical host segment. */
  id: string;
  runId: string;
  /** Worker lifetime. Observe it when waiting or making an external request. */
  signal: AbortSignal;
  state: RunState;
  snapshot: TreeNode;
}) => void | Promise<void>;
