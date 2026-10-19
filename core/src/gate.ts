// How many calls run at once on one connection.
//
// A flat-rate plan caps concurrent requests, and says so only by failing: six
// calls at once on one Z.ai Coding Plan key came back with some 429s (measured
// 2026-09-25, `capability.ts`). Behind a fallback chain the overflow is
// answered by the NEXT model, so the cap shows up as a quietly different
// answer, not as an error. The capability probe runs one call at a time for
// that reason, and one adopter runs its batches one item at a time on purpose.
// A gate holds the overflow in a queue instead, and lets each call in as a
// slot frees.
//
// The hard part is giving the slot back. A slot leaked by an abandoned stream
// is gone for the life of the process, with no error anywhere: the connection
// just serves one call fewer, until it serves none. So the slot is taken on the
// first read (a stream nobody reads holds nothing) and released exactly once,
// on whichever comes first: the stream ends, throws or is returned, or its
// signal aborts. That last one matters when the consumer holds a stream and
// stops reading it. Nothing else would ever free that slot.
//
// ponytail: three known ceilings.
// - It counts one process only. Two replicas each let `max` calls through. The
//   upgrade path is a shared counter (one adopter already keeps one in Redis).
// - A full gate makes callers wait instead of moving on to the next candidate
//   in a fallback chain. The upgrade is a bounded wait that fails as transient,
//   so the pool tries the next one.
// - A fallback probe stuck waiting here has no first chunk, so once it goes
//   stale (`probeStaleMs`) the pool can let one extra probe in beside it.
import type {
  ChatMessage,
  Provider,
  ProviderChunk,
  StreamOptions,
  ToolDefinition,
} from "./types.ts";

export interface Gate {
  /** How many calls may hold a slot at once. */
  readonly max: number;
  /** How many slots are held right now. */
  readonly held: number;
  /** How many calls are queued for a slot. */
  readonly waiting: number;
  /**
   * Wait for a slot, first in, first out. Resolves to its release, which is
   * safe to call more than once. The signal covers the whole life of the slot:
   * an abort while waiting leaves the queue and rejects with `signal.reason`,
   * and an abort while held releases it.
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
}

/** A gate with `max` slots. Keep one alive per connection, so every call on
 *  it shares the count. */
export function createGate(max: number): Gate {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`[providerkit] A gate needs a whole number of slots, 1 or more. Got ${max}.`);
  }

  let held = 0;
  const queue: Array<() => void> = [];

  function acquire(signal?: AbortSignal): Promise<() => void> {
    // Rejected before it queues: a caller already gone must not take a place
    // in line, or a slot, even for a moment.
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise((resolve, reject) => {
      let state: "waiting" | "held" | "released" = "waiting";

      const release = () => {
        if (state !== "held") return;
        state = "released";
        signal?.removeEventListener("abort", onAbort);
        // Handed straight to the next waiter, so `held` never dips and a
        // newcomer arriving now finds the gate full and queues behind them.
        const next = queue.shift();
        if (next) next();
        else held--;
      };

      const grant = () => {
        state = "held";
        resolve(release);
      };

      function onAbort() {
        if (state === "held") {
          release();
        } else if (state === "waiting") {
          state = "released";
          queue.splice(queue.indexOf(grant), 1);
          reject(signal?.reason);
        }
      }

      if (held < max) {
        held++;
        grant();
      } else {
        queue.push(grant);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  return {
    max,
    get held() {
      return held;
    },
    get waiting() {
      return queue.length;
    },
    acquire,
  };
}

/**
 * Let a provider run at most `gate.max` calls at once.
 *
 * Put it outside the watchdog. The watchdog arms on its first read, and this
 * reads it only once a slot is held, so a call queued here never spends its
 * deadlines waiting. Inside it, a call that stood in line for five minutes
 * would time out as a silent provider before it ever sent a byte.
 */
export function withGate(provider: Provider, gate: Gate): Provider {
  return {
    ...provider,
    createStream(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      // A generator, so nothing runs (the wait included) until the first read.
      async function* gated(): AsyncGenerator<ProviderChunk> {
        const release = await gate.acquire(opts.signal);
        try {
          // The slot can be granted and released by the same abort before this
          // line runs (two calls sharing one signal). Such a call is over, and
          // must not reach the wire without a slot.
          opts.signal?.throwIfAborted();
          yield* provider.createStream(messages, tools, opts);
        } finally {
          // Covers the end, a throw and a consumer's `break`. An abort may
          // have released it already, and a second call is a no-op.
          release();
        }
      }
      return gated();
    },
  };
}
