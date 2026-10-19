// The gate's one promise: a slot is taken on the first read and given back
// exactly once. Every way a stream can end is here, because each one that
// forgot to release would leak a slot for the life of the process.
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors.ts";
import { createGate, withGate } from "../src/gate.ts";
import { sleep } from "../src/retry.ts";
import type { ChatMessage, Provider, ProviderChunk } from "../src/types.ts";
import { withWatchdog } from "../src/watchdog.ts";

const user = (text: string): ChatMessage[] => [{ role: "user", content: text }];

/** Let every pending promise settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** A provider whose calls the test ends by hand. Each call yields one chunk
 *  as it starts, then waits for `end()` or `fail()`. */
function scripted() {
  const calls: Array<{ name: string; end(): void; fail(err: unknown): void }> = [];
  let running = 0;
  let peak = 0;
  const provider: Provider = {
    id: "scripted",
    model: "scripted-1",
    async *createStream(messages) {
      const content = messages[0]?.content;
      const name = typeof content === "string" ? content : "";
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      calls.push({ name, end: resolve, fail: reject });
      running++;
      peak = Math.max(peak, running);
      try {
        yield { type: "delta", content: name };
        await promise;
        yield { type: "finish", finishReason: "stop" };
      } finally {
        running--;
      }
    },
  };
  return { provider, calls, running: () => running, peak: () => peak };
}

const call = (fake: ReturnType<typeof scripted>, name: string) => {
  const found = fake.calls.find((c) => c.name === name);
  if (!found) throw new Error(`call ${name} never started`);
  return found;
};

describe("createGate", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses %s slots", (max) => {
    expect(() => createGate(max)).toThrow(/\[providerkit\]/);
  });

  it("ignores a second release, so it never frees someone else's slot", async () => {
    const gate = createGate(2);
    const first = await gate.acquire();
    await gate.acquire();
    const third = gate.acquire();
    first();
    await third; // the freed slot went to the waiter
    first();
    expect(gate.held).toBe(2);
    void gate.acquire();
    expect(gate.waiting).toBe(1);
  });
});

describe("withGate", () => {
  it("keeps the provider's id, model and the rest of its fields", () => {
    const source = { ...scripted().provider, extra: 1 };
    const gated = withGate(source, createGate(1));
    expect(gated.id).toBe("scripted");
    expect(gated.model).toBe("scripted-1");
    expect(gated).toHaveProperty("extra", 1);
  });

  it("runs 10 parallel streams two at a time, in arrival order", async () => {
    const gate = createGate(2);
    const fake = scripted();
    const provider = withGate(fake.provider, gate);
    const names = Array.from({ length: 10 }, (_, i) => `call-${i}`);
    const runs = names.map((name) => collect(provider.createStream(user(name), [])));
    await tick();
    expect(gate.held).toBe(2);
    expect(gate.waiting).toBe(8);

    // End the NEWEST running call each time. A gate that let a newcomer barge
    // in, or skipped a waiter, would start them out of order.
    const ended = new Set<string>();
    for (const _ of names) {
      expect(fake.running()).toBeLessThanOrEqual(2);
      const newest = fake.calls.filter((c) => !ended.has(c.name)).at(-1);
      if (!newest) throw new Error("no call is running");
      ended.add(newest.name);
      newest.end();
      await tick();
    }

    await Promise.all(runs);
    expect(fake.peak()).toBe(2);
    expect(fake.calls.map((c) => c.name)).toEqual(names);
    expect(gate.held).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it("holds no slot for a stream nobody reads", async () => {
    const gate = createGate(1);
    const fake = scripted();
    const provider = withGate(fake.provider, gate);
    provider.createStream(user("ignored"), []);
    expect(gate.held).toBe(0);

    const read = collect(provider.createStream(user("read"), []));
    await tick();
    call(fake, "read").end();
    await expect(read).resolves.toHaveLength(2);
    expect(fake.calls.map((c) => c.name)).toEqual(["read"]);
  });

  it("releases when the stream ends", async () => {
    const gate = createGate(1);
    const fake = scripted();
    const run = collect(withGate(fake.provider, gate).createStream(user("a"), []));
    await tick();
    expect(gate.held).toBe(1);
    call(fake, "a").end();
    await run;
    expect(gate.held).toBe(0);
  });

  it("releases when the stream throws", async () => {
    const gate = createGate(1);
    const fake = scripted();
    const run = collect(withGate(fake.provider, gate).createStream(user("a"), []));
    await tick();
    const failure = new ProviderError("scripted", "overload", "busy");
    call(fake, "a").fail(failure);
    await expect(run).rejects.toBe(failure);
    expect(gate.held).toBe(0);
  });

  it("releases when the consumer breaks out of its loop", async () => {
    const gate = createGate(1);
    const fake = scripted();
    for await (const chunk of withGate(fake.provider, gate).createStream(user("a"), [])) {
      expect(gate.held).toBe(1);
      if (chunk.content) break;
    }
    expect(gate.held).toBe(0);
    expect(fake.running()).toBe(0);
  });

  it("releases on abort while the consumer holds the stream and stops reading", async () => {
    const gate = createGate(1);
    const fake = scripted();
    const provider = withGate(fake.provider, gate);
    const controller = new AbortController();
    const held = provider.createStream(user("a"), [], { signal: controller.signal });
    const iterator = held[Symbol.asyncIterator]();
    await iterator.next(); // reads once, then never again

    const next = collect(provider.createStream(user("b"), []));
    await tick();
    expect(gate.waiting).toBe(1);

    controller.abort(new Error("stopped"));
    await tick();
    expect(fake.calls.map((c) => c.name)).toEqual(["a", "b"]);
    expect(gate.held).toBe(1);
    call(fake, "b").end();
    await next;
    expect(gate.held).toBe(0);
  });

  it("releases once when an abort is followed by return()", async () => {
    const gate = createGate(1);
    const fake = scripted();
    const provider = withGate(fake.provider, gate);
    const controller = new AbortController();
    const first = provider.createStream(user("a"), [], { signal: controller.signal });
    const iterator = first[Symbol.asyncIterator]();
    await iterator.next();

    const second = collect(provider.createStream(user("b"), []));
    const third = collect(provider.createStream(user("c"), []));
    await tick();
    expect(gate.waiting).toBe(2);

    controller.abort(new Error("stopped"));
    await iterator.return?.();
    await tick();
    // The abort handed the slot to "b". A second release from return() would
    // have let "c" in beside it.
    expect(fake.calls.map((c) => c.name)).toEqual(["a", "b"]);
    expect(gate.held).toBe(1);
    expect(gate.waiting).toBe(1);

    call(fake, "b").end();
    await second;
    await tick();
    call(fake, "c").end();
    await third;
    expect(gate.held).toBe(0);
  });

  it("drops an aborted waiter from the queue and serves the next one", async () => {
    const gate = createGate(1);
    const fake = scripted();
    const provider = withGate(fake.provider, gate);
    const first = collect(provider.createStream(user("a"), []));
    const controller = new AbortController();
    const quitter = collect(provider.createStream(user("b"), [], { signal: controller.signal }));
    const patient = collect(provider.createStream(user("c"), []));
    await tick();
    expect(gate.waiting).toBe(2);

    const reason = new Error("gave up");
    controller.abort(reason);
    await expect(quitter).rejects.toBe(reason);
    expect(gate.waiting).toBe(1);

    call(fake, "a").end();
    await first;
    await tick();
    call(fake, "c").end();
    await patient;
    expect(fake.calls.map((c) => c.name)).toEqual(["a", "c"]);
    expect(gate.held).toBe(0);
  });

  it("rejects an already-aborted call at once, without queueing it", async () => {
    const gate = createGate(1);
    const fake = scripted();
    const provider = withGate(fake.provider, gate);
    const first = collect(provider.createStream(user("a"), []));
    await tick();

    const reason = new Error("already gone");
    const late = collect(
      provider.createStream(user("b"), [], { signal: AbortSignal.abort(reason) }),
    );
    expect(gate.waiting).toBe(0);
    await expect(late).rejects.toBe(reason);

    call(fake, "a").end();
    await first;
    expect(gate.held).toBe(0);
    expect(fake.calls.map((c) => c.name)).toEqual(["a"]);
  });

  it("leaks nothing when one abort ends a holder and the waiter it hands the slot to", async () => {
    // Two calls on one signal: the holder's release grants the waiter, and the
    // same abort then reaches the waiter. It must give the slot back, and
    // must not reach the provider.
    const gate = createGate(1);
    const fake = scripted();
    const provider = withGate(fake.provider, gate);
    const controller = new AbortController();
    const holder = provider.createStream(user("a"), [], { signal: controller.signal });
    await holder[Symbol.asyncIterator]().next();
    const waiter = collect(provider.createStream(user("b"), [], { signal: controller.signal }));
    await tick();

    const reason = new Error("stopped");
    controller.abort(reason);
    await expect(waiter).rejects.toBe(reason);
    expect(gate.held).toBe(0);
    expect(fake.calls.map((c) => c.name)).toEqual(["a"]);
  });

  it("never runs the watchdog's clocks while a call waits for its slot", async () => {
    vi.useFakeTimers();
    try {
      // Healthy and slow: a chunk every 500 ms, ten of them, on a 1 s watchdog.
      const slow: Provider = {
        id: "slow",
        model: "slow-1",
        async *createStream(_messages, _tools, opts) {
          for (let i = 0; i < 10; i++) {
            await sleep(500, opts?.signal);
            yield { type: "delta", content: `${i}` };
          }
          yield { type: "finish", finishReason: "stop" };
        },
      };
      const gate = createGate(1);
      const provider = withGate(withWatchdog(slow, { idleMs: 1_000, progressMs: 1_000 }), gate);
      const first = collect(provider.createStream(user("a"), []));
      const second = collect(provider.createStream(user("b"), []));
      // "b" waits 5 s for its slot, five of its own progress windows.
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(first).resolves.toHaveLength(11);
      await expect(second).resolves.toHaveLength(11);
    } finally {
      vi.useRealTimers();
    }
  });
});
