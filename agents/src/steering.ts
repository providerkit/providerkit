// Adapted from TanStack AI (MIT), session/turn-parts.ts: joinSteers and steering.
// See THIRD_PARTY_NOTICES.md. Journal before acknowledgement; only the conversation owner polls.
import { conversationOf, readContent } from "./input.ts";
import {
  copyData,
  equalData,
  immutableCopy,
  inlineBytes,
  isId,
  isRecord,
  modelId,
} from "./snapshot.ts";
import { emitEvent, fail, snapshots, untilAbort, type ExecutionScope } from "./tree.ts";
import type { AgentRef, RunOptions, RunSnapshot, UserContent } from "./types.ts";

/** Fixed ceilings per logical run, including all its handoffs. Bytes are UTF-8 JSON bytes of
 * normalized { id, content } records, not decoded attachment bytes. Hosts must bound enqueue too. */
export const INPUT_LIMITS = Object.freeze({ pending: 32, count: 128, bytes: 5_000_000 });

/** New user content only. An id names one immutable payload within the logical root run. */
export interface QueuedInput {
  id: string;
  content: UserContent;
}

/** Private journal entry. Insert after this many settled model/tool rounds. */
export interface RunInput extends QueuedInput {
  beforeModel: number;
}

/** A completed call proves consumption here, not that the model followed the message. A
 * running or interrupted call may have seen it, but remains accepted with consumption unknown. */
export interface InputReceipt {
  id: string;
  rootRunId: string;
  runId: string;
  beforeModel: number;
  modelId: string;
  status: "accepted" | "consumed";
  /** Present only for the completed model attempt that first included this input. */
  attemptId?: string;
}

export interface InputScope {
  /** Stable logical identity, not a background segment id or a session id. */
  rootRunId: string;
  /** Current conversation owner. Never infer a route by parsing these ids. */
  runId: string;
  agent: AgentRef;
}

/** Trusted host storage. Authenticate enqueue, poll and acknowledgement against the logical
 * run's owner and fence writes under its lease. These functions never grant tool authority. */
export interface InputInbox {
  /** Non-destructive, ordered prefix. Return at most limit.count records fitting limit.bytes.
   * Keep an offered record immutable and available until acknowledge accepts it. No long poll. */
  poll(
    request: InputScope & {
      limit: { count: number; bytes: number };
      signal: AbortSignal;
    },
  ): readonly QueuedInput[] | Promise<readonly QueuedInput[]>;
  /** Called only after checkpoint. Idempotent and monotonic: accepted may become consumed,
   * never the reverse. Keep accepted-but-unconsumed content for recall after the run settles.
   * A crash after this write must allow the same receipt again. Do not start another run. */
  acknowledge(
    receipts: readonly InputReceipt[],
    options: { signal: AbortSignal },
  ): void | Promise<void>;
}

export interface InboxEntry extends QueuedInput {
  status: "queued" | "accepted" | "consumed";
  receipt?: InputReceipt;
}

export class InputConflictError extends Error {
  constructor() {
    super(
      "This input id already has different content or a different delivery position. Use its original content, or a new id for a new message.",
    );
    this.name = "InputConflictError";
  }
}

export function readQueuedInput(value: unknown): QueuedInput {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    value.id.length > 256 ||
    Object.keys(value).some((key) => key !== "id" && key !== "content")
  )
    throw new TypeError("An input needs an id of 1 to 256 characters and user content only.");
  return { id: value.id, content: readContent(value.content, "The queued input") };
}

export function inputBytes(input: QueuedInput): number {
  return new TextEncoder().encode(JSON.stringify({ id: input.id, content: input.content })).length;
}

/** Reference host for one process, not durable storage or authentication. All records, including
 * consumed ones, stay for deduplication until this inbox is discarded. No automatic follow-up. */
export function createMemoryInbox(rootRunId: string): InputInbox & {
  enqueue(input: QueuedInput): InboxEntry;
  list(): InboxEntry[];
} {
  if (!isId(rootRunId)) throw new TypeError("An inbox needs its logical root run id.");
  const entries = new Map<string, InboxEntry>();
  let bytes = 0;
  return {
    enqueue(value) {
      const input = readQueuedInput(value);
      const previous = entries.get(input.id);
      if (previous) {
        if (!equalData(previous.content, input.content)) throw new InputConflictError();
        return copyData(previous);
      }
      const size = inputBytes(input);
      if (
        entries.size >= INPUT_LIMITS.count ||
        bytes + size > INPUT_LIMITS.bytes ||
        [...entries.values()].filter((entry) => entry.status === "queued").length >=
          INPUT_LIMITS.pending
      )
        throw new TypeError(
          "The inbox is full. Recall unconsumed messages after this run ends instead of sending more.",
        );
      const entry: InboxEntry = { ...input, status: "queued" };
      entries.set(input.id, entry);
      bytes += size;
      return copyData(entry);
    },
    list: () => copyData([...entries.values()]),
    poll({ rootRunId: requested, limit, signal }) {
      signal.throwIfAborted();
      if (requested !== rootRunId) throw new TypeError("This inbox belongs to another run.");
      const result: QueuedInput[] = [];
      let size = 0;
      for (const entry of entries.values()) {
        if (entry.status !== "queued") continue;
        size += inputBytes(entry);
        if (result.length >= limit.count || size > limit.bytes) break;
        result.push({ id: entry.id, content: copyData(entry.content) });
      }
      return result;
    },
    acknowledge(receipts, { signal }) {
      signal.throwIfAborted();
      // Check the whole batch before changing it, so a bad later receipt writes nothing.
      const checked = new Map<string, InputReceipt>();
      for (const receipt of receipts) {
        const entry = entries.get(receipt.id);
        if (
          receipt.rootRunId !== rootRunId ||
          !entry ||
          !isId(receipt.runId) ||
          !Number.isSafeInteger(receipt.beforeModel) ||
          receipt.beforeModel < 0 ||
          receipt.modelId !== modelId(receipt.runId, receipt.beforeModel) ||
          (receipt.status !== "accepted" && receipt.status !== "consumed") ||
          (receipt.status === "consumed"
            ? !isId(receipt.attemptId)
            : receipt.attemptId !== undefined)
        )
          throw new TypeError("The input receipt does not belong to this inbox or model call.");
        const previous = checked.get(receipt.id) ?? entry.receipt;
        if (
          previous &&
          (previous.runId !== receipt.runId ||
            previous.beforeModel !== receipt.beforeModel ||
            (previous.status === "consumed" &&
              receipt.status === "consumed" &&
              previous.attemptId !== receipt.attemptId))
        )
          throw new InputConflictError();
        checked.set(receipt.id, previous?.status === "consumed" ? previous : receipt);
      }
      for (const receipt of receipts) {
        const entry = entries.get(receipt.id);
        if (!entry || entry.status === "consumed") continue;
        entry.receipt = copyData(receipt);
        entry.status = receipt.status;
      }
    },
  };
}

export function inputReceipts(root: RunSnapshot): InputReceipt[] {
  return [...snapshots(root)].flatMap((snapshot) =>
    snapshot.inputs.map((input): InputReceipt => {
      const model = snapshot.models[input.beforeModel];
      return {
        id: input.id,
        rootRunId: snapshot.tree.runId,
        runId: snapshot.runId,
        beforeModel: input.beforeModel,
        modelId: modelId(snapshot.runId, input.beforeModel),
        status: model?.status === "completed" ? "consumed" : "accepted",
        ...(model?.status === "completed" ? { attemptId: model.attemptId } : {}),
      };
    }),
  );
}

export async function acknowledgeInputs(
  snapshot: RunSnapshot,
  options: RunOptions,
  signal: AbortSignal,
): Promise<void> {
  const receipts = inputReceipts(snapshot);
  if (!receipts.length) return;
  const inbox = options.host?.inbox;
  if (!inbox)
    fail(
      "input_host_missing",
      "Restore this run's host inbox before continuing its recorded inputs.",
    );
  try {
    await untilAbort(
      Promise.resolve(inbox.acknowledge(immutableCopy(receipts), { signal })),
      signal,
    );
  } catch {
    signal.throwIfAborted();
    fail(
      "input_acknowledge_failed",
      "The inbox did not confirm delivery. Reconcile its receipts with the saved run before recalling or resuming these messages.",
    );
  }
}

/** Only the root's handoff chain owns conversation input. A delegated child's own handoffs
 * cannot opt it into the parent's inbox. No parsed ids, broadcast or mutable owner pointer. */
function conversationOwner(root: RunSnapshot): RunSnapshot {
  let owner = root;
  for (;;) {
    const next = owner.delegations.find(
      (entry) => entry.kind === "handoff" && entry.children.length,
    )?.children[0]?.snapshot;
    if (!next) return owner;
    owner = next;
  }
}

export async function acceptInputs(
  snapshot: RunSnapshot,
  scope: ExecutionScope,
  options: RunOptions,
  signal: AbortSignal,
): Promise<void> {
  const inbox = options.host?.inbox;
  if (!inbox || conversationOwner(scope.tree.root).runId !== snapshot.runId) return;
  const recorded = [...snapshots(scope.tree.root)].flatMap((node) => node.inputs);
  const limit = {
    count: Math.min(INPUT_LIMITS.pending, INPUT_LIMITS.count - recorded.length),
    bytes: INPUT_LIMITS.bytes - recorded.reduce((total, input) => total + inputBytes(input), 0),
  };
  if (limit.count <= 0 || limit.bytes <= 0) return;
  let offered: unknown;
  try {
    offered = await untilAbort(
      Promise.resolve(
        inbox.poll({
          ...immutableCopy({
            rootRunId: snapshot.tree.runId,
            runId: snapshot.runId,
            agent: { id: snapshot.agentId, version: snapshot.version },
            limit,
          }),
          signal,
        }),
      ),
      signal,
    );
  } catch {
    signal.throwIfAborted();
    fail(
      "input_poll_failed",
      "The run could not read its inbox. Check the host inbox before continuing.",
    );
  }
  signal.throwIfAborted();
  scope.tree.active();
  if (!Array.isArray(offered) || offered.length > limit.count)
    fail("invalid_inbox", "The host inbox returned more messages than the requested limit.");
  const accepted: RunInput[] = [];
  let bytes = 0;
  for (const raw of offered) {
    const input = readQueuedInput(raw);
    const previous = [...recorded, ...accepted].find((entry) => entry.id === input.id);
    if (previous) {
      if (!equalData(previous.content, input.content))
        fail("input_conflict", new InputConflictError().message);
      continue;
    }
    bytes += inputBytes(input);
    if (bytes > limit.bytes)
      fail("invalid_inbox", "The host inbox returned more bytes than the requested limit.");
    accepted.push({ ...input, beforeModel: snapshot.models.length });
  }
  if (!accepted.length) return;
  const history = [
    ...conversationOf(snapshot),
    ...accepted.map((input) => ({ role: "user" as const, content: input.content })),
  ];
  if (inlineBytes(history, "") > snapshot.limits.inlineBytes)
    fail(
      "input_media_limit",
      "The queued images and files exceed this agent's inline byte limit. Recall them after this run ends and use media references.",
    );
  // No mutation until the whole offered prefix passes. A failed save leaves host delivery queued.
  snapshot.inputs.push(...accepted);
  await scope.tree.save();
  for (const receipt of inputReceipts(snapshot).filter((receipt) =>
    accepted.some((input) => input.id === receipt.id),
  ))
    emitEvent(options, { type: "input", receipt });
  await acknowledgeInputs(snapshot, options, signal);
}
