// Adapted from TanStack AI (MIT), ai-harness/src/log.ts: adjacent delta folding,
// one timed buffer and one writer. The host owns sequence allocation and write reconciliation.
import type { BackgroundWorker } from "./runs.ts";
import { copyData, equalData } from "./snapshot.ts";
import type { AgentEvent } from "./types.ts";

export type EventDurability = "best-effort" | "awaited";

/** Counts original events, before folding. A rejected append may already be stored. */
export interface ProgressGap {
  dropped: number;
  unconfirmed: number;
}

const WAIT_MS = 100;
const MAX_RECORDS = 64;
const MAX_BYTES = 256 * 1024;
const encoder = new TextEncoder();
type ChunkEvent = Extract<AgentEvent, { type: "model_chunk" }>;
type RecordEntry = { type: string; data: unknown; count: number };

function textField(event: AgentEvent): "content" | "reasoning" | undefined {
  if (event.type !== "model_chunk" || event.chunk.type !== "delta") return undefined;
  for (const field of ["content", "reasoning"] as const)
    if (
      typeof event.chunk[field] === "string" &&
      Object.keys(event.chunk).every((key) => key === "type" || key === field || key === "source")
    )
      return field;
  return undefined;
}

/** Internal, bounded storage sink. Raw onEvent observers never pass through this buffer. */
export function createProgress(
  run: Pick<BackgroundWorker, "emit" | "signal" | "append">,
  mode: EventDurability,
) {
  const append = run.append?.bind(run);
  if (mode === "awaited" && !append)
    throw new TypeError(
      'events: "awaited" needs Run.append from @gusnips/server 0.21 or later. Upgrade the host or use best-effort events.',
    );
  const broken = new AbortController();
  let queue: RecordEntry[] = [];
  let bytes = 0;
  let dropped = 0;
  let pushed = 0;
  let kept = 0;
  let last: ChunkEvent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;
  let failure: { cause: unknown } | undefined;
  let closed = false;

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  async function store(batch: RecordEntry[], omitted: number) {
    const events = batch.map(({ type, data }) => ({ type, data }));
    const gap: ProgressGap = { dropped: omitted, unconfirmed: 0 };
    if (mode === "best-effort") {
      for (const event of events) run.emit(event.type, event.data);
      if (omitted) run.emit("agent.gap", gap);
      return;
    }
    if (!append) throw new TypeError("Missing Run.append.");
    try {
      if (events.length) await append(events);
    } catch (error) {
      run.signal.throwIfAborted();
      // A host control exception is never a storage gap, even if a custom host has not
      // aborted its signal yet. Older server copies have their own RunStopped class.
      if (error instanceof Error && error.name === "RunStopped") throw error;
      gap.unconfirmed = batch.reduce((count, event) => count + event.count, 0);
    }
    if (gap.dropped || gap.unconfirmed) {
      run.signal.throwIfAborted();
      // Never replay the rejected batch. append reconciles its own uncertain range before
      // assigning positions to this NEW record. No durable marker means no successful barrier.
      try {
        await append([{ type: "agent.gap", data: gap }]);
      } catch (cause) {
        run.signal.throwIfAborted();
        if (cause instanceof Error && cause.name === "RunStopped") throw cause;
        throw new Error(
          "Progress could not be saved or marked incomplete. Reconcile stored state before resuming.",
          { cause },
        );
      }
    }
  }

  function start(): void {
    if (writing || closed || failure || run.signal.aborted || (!queue.length && !dropped)) return;
    clearTimer();
    const batch = queue;
    const omitted = dropped;
    const through = pushed;
    queue = [];
    bytes = 0;
    dropped = 0;
    last = undefined;
    // The chain always settles. Failure is retained explicitly, not as a rejected tail that
    // skips later cleanup or causes an unhandled rejection from a timer.
    writing = store(batch, omitted)
      .then(
        () => {
          kept = through;
        },
        (cause: unknown) => {
          failure = { cause };
          broken.abort(cause);
        },
      )
      .finally(() => {
        writing = undefined;
        start();
      });
  }

  function schedule(): void {
    if (timer === undefined && !writing) timer = setTimeout(start, WAIT_MS);
  }

  function push(event: AgentEvent): void {
    if (closed || run.signal.aborted || failure) return;
    const data = copyData(event);
    const size = encoder.encode(JSON.stringify(data)).byteLength;
    const field = textField(data);
    const previous = queue.at(-1);
    pushed++;
    // Once a prefix overflows, keep dropping until that gap is detached for writing. This
    // avoids moving later events in front of the missing ones, including boundary events.
    if (dropped || size > MAX_BYTES || bytes + size > MAX_BYTES) {
      dropped++;
      last = undefined;
      start();
      return;
    }
    if (
      field &&
      last &&
      data.type === "model_chunk" &&
      previous &&
      textField(last) === field &&
      last.runId === data.runId &&
      last.operationId === data.operationId &&
      last.attemptId === data.attemptId &&
      equalData(last.chunk.source, data.chunk.source)
    ) {
      last.chunk[field] = (last.chunk[field] ?? "") + data.chunk[field];
      previous.count++;
      bytes += size;
    } else {
      if (queue.length === MAX_RECORDS) {
        dropped++;
        last = undefined;
        start();
        return;
      }
      queue.push({ type: "agent", data, count: 1 });
      bytes += size;
      last = field && data.type === "model_chunk" ? data : undefined;
    }
    if (!field || queue.length === MAX_RECORDS || bytes === MAX_BYTES) start();
    else schedule();
  }

  async function flush(): Promise<void> {
    const through = pushed;
    // A journal boundary also seals the last delta, even while an older append is pending.
    last = undefined;
    clearTimer();
    if (closed && kept < through && !run.signal.aborted && !failure)
      throw new Error("The progress buffer was disposed before it was flushed.");
    while (kept < through && !failure && !run.signal.aborted) {
      start();
      await writing;
    }
    run.signal.throwIfAborted();
    if (failure) throw failure.cause;
  }

  function stopTimer() {
    clearTimer();
  }
  run.signal.addEventListener("abort", stopTimer, { once: true });
  return {
    push,
    flush,
    signal: broken.signal,
    async resync(crashes: number) {
      await flush();
      if (mode === "awaited") {
        if (!append) throw new TypeError("Missing Run.append.");
        // Before agent.resume, so no producer can overtake this marker.
        await append([{ type: "agent.resync", data: { crashes } }]);
      }
    },
    async dispose() {
      closed = true;
      clearTimer();
      run.signal.removeEventListener("abort", stopTimer);
      // Do not abandon an append on Stop or lease loss. It may still be committing.
      await writing;
      queue = [];
      bytes = 0;
      dropped = 0;
      last = undefined;
    },
  };
}
