// The pool's rules, on an injected clock — a 12-hour cooldown and its expiry
// cost the suite nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors.ts";
import type { ErrorKind } from "../src/errors.ts";
import { FallbackPool } from "../src/fallback.ts";
import { KeyPool, NoAvailableKeyError, withKeyPool } from "../src/key-pool.ts";
import type { KeyTier } from "../src/key-pool.ts";
import type {
  ChatMessage,
  Provider,
  ProviderChunk,
  StreamOptions,
  ToolDefinition,
} from "../src/types.ts";

const START = 1_700_000_000_000;

const unexpectedFetch = vi.fn(() => {
  throw new Error("Unexpected network request in key-pool test");
});
beforeEach(() => {
  unexpectedFetch.mockClear();
  vi.stubGlobal("fetch", unexpectedFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(unexpectedFetch).not.toHaveBeenCalled();
});

/** A clock the test moves by hand. */
function clock(at = START) {
  let now = at;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const failure = (kind: ErrorKind, retryAfterMs?: number) =>
  new ProviderError("gemini", kind, `${kind} failure`, { retryAfterMs });

const rateLimited = (retryAfterMs?: number) => failure("rate", retryAfterMs);

/** How long a two-key pool benches the key that threw `err`. */
async function benchedFor(err: ProviderError): Promise<number | undefined> {
  const seen: number[] = [];
  const pool = new KeyPool("test", {
    keys: ["a", "b"],
    onEvict: ({ forMs }) => seen.push(forMs),
  });
  await pool.with(() => Promise.reject(err)).catch(() => undefined);
  return seen[0];
}

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("KeyPool — candidate order", () => {
  it("walks the free keys round-robin so no single key carries the pool", async () => {
    const pool = new KeyPool("test", { keys: ["a", "b", "c"] });
    const first: string[] = [];
    for (let i = 0; i < 4; i++) await pool.with(async (key) => first.push(key));
    expect(first).toEqual(["a", "b", "c", "a"]);
  });

  it("spends free quota before money — the paid key is the last candidate", async () => {
    const evicted: KeyTier[] = [];
    const pool = new KeyPool("test", {
      keys: ["free-1", "free-2"],
      paidKey: "paid",
      onEvict: ({ tier }) => evicted.push(tier),
    });
    const seen: string[] = [];
    await expect(
      pool.with(async (key) => {
        seen.push(key);
        throw rateLimited();
      }),
    ).rejects.toBeInstanceOf(NoAvailableKeyError);
    expect(seen).toEqual(["free-1", "free-2", "paid"]);
    expect(evicted).toEqual(["free", "free", "paid"]);
  });

  it("ignores blank keys — an unset slot in the caller's config is not a key", () => {
    expect(new KeyPool("test", { keys: ["", "a"], paidKey: "" }).size).toBe(1);
  });

  it("refuses to exist with nothing to serve", () => {
    expect(() => new KeyPool("test", { keys: [] })).toThrow(/needs at least one key/);
  });
});

describe("KeyPool — eviction", () => {
  it("benches a rate-limited key for the delay the provider named, and takes it back", async () => {
    const time = clock();
    const pool = new KeyPool("test", { keys: ["free"], paidKey: "paid", now: time.now });
    const seen: string[] = [];

    await pool.with(async (key) => {
      seen.push(key);
      if (key === "free") throw rateLimited(30_000);
      return key;
    });
    expect(seen).toEqual(["free", "paid"]);

    // Still benched: the next call is never even offered it.
    await pool.with(async (key) => seen.push(key));
    expect(seen).toEqual(["free", "paid", "paid"]);

    time.advance(30_001);
    await pool.with(async (key) => seen.push(key));
    expect(seen).toEqual(["free", "paid", "paid", "free"]);
  });

  it("sizes the bench to what the failure actually is", async () => {
    expect(await benchedFor(failure("rate"))).toBe(60_000);
    expect(await benchedFor(failure("quota"))).toBe(60 * 60_000);
    expect(await benchedFor(failure("auth"))).toBe(12 * 60 * 60_000);
    // `overload` is the vendor having a bad time — a different project's key
    // may route to a backend that is not.
    expect(await benchedFor(failure("overload"))).toBe(60_000);
    expect(await benchedFor(failure("timeout"))).toBe(60_000);
  });

  it("clamps the provider's own figure into a bench worth taking", async () => {
    // 5 ms is not a rotation, and a week is not a bench — a key benched past
    // the end of the incident is a key the pool never gets back.
    expect(await benchedFor(failure("rate", 5))).toBe(1_000);
    expect(await benchedFor(failure("quota", 7 * 24 * 60 * 60_000))).toBe(12 * 60 * 60_000);
  });

  it("benches a spent quota until the reset it names, not for the Retry-After beside it", async () => {
    const time = clock();
    const seen: number[] = [];
    const pool = new KeyPool("test", {
      keys: ["a", "b"],
      now: time.now,
      onEvict: ({ forMs }) => seen.push(forMs),
    });
    await pool.with(async (key) => {
      if (key === "a") {
        throw new ProviderError("gemini", "quota", "daily limit", {
          retryAfterMs: 60_000,
          resetAtMs: START + 3 * 60 * 60_000,
        });
      }
      return key;
    });
    expect(seen).toEqual([3 * 60 * 60_000]);
  });

  it("reports every eviction to onEvict — the pool's only voice", async () => {
    const evictions: { tier: KeyTier; kind: ErrorKind; forMs: number }[] = [];
    const pool = new KeyPool("test", {
      keys: ["a", "b"],
      onEvict: (info) => evictions.push(info),
    });
    await pool.with(async (key) => {
      if (key === "a") throw failure("quota", 90_000);
      return key;
    });
    expect(evictions).toEqual([{ tier: "free", kind: "quota", forMs: 90_000 }]);
  });

  it("shows each key's tier and bench in status, and never the key", async () => {
    const time = clock();
    const pool = new KeyPool("test", { keys: ["a", "b"], paidKey: "p", now: time.now });
    await pool.with(async (key) => {
      if (key === "a") throw rateLimited(90_000);
      return key;
    });
    expect(pool.status()).toEqual([
      { tier: "free", evictedUntil: START + 90_000 },
      { tier: "free", evictedUntil: 0 },
      { tier: "paid", evictedUntil: 0 },
    ]);
    expect(JSON.stringify(pool.status())).not.toMatch(/"a"|"b"|"p"/);

    // A bench that ran out reads as serving, not as a time in the past.
    time.advance(90_000);
    expect(pool.status()[0]).toEqual({ tier: "free", evictedUntil: 0 });
  });
});

describe("KeyPool — the single-key rule", () => {
  it("evicts nothing when there is nothing to rotate to", async () => {
    const evictions: unknown[] = [];
    const pool = new KeyPool("test", {
      keys: [],
      paidKey: "only",
      onEvict: (info) => evictions.push(info),
    });
    await expect(pool.with(() => Promise.reject(rateLimited()))).rejects.toBeInstanceOf(
      ProviderError,
    );
    // The key is still there for the caller's own retry, which is the whole
    // recovery a single-key deployment has.
    await expect(pool.with(async (key) => key)).resolves.toBe("only");
    expect(evictions).toEqual([]);
  });
});

describe("KeyPool — a dark pool", () => {
  it("names when the soonest key is back, and serves again once it is", async () => {
    const time = clock();
    const pool = new KeyPool("test", { keys: ["a", "b"], now: time.now });
    const err = await pool
      .with(async (key) => {
        throw rateLimited(key === "a" ? 90_000 : 20_000);
      })
      .catch((e: unknown) => e);

    if (!(err instanceof NoAvailableKeyError)) throw err;
    expect(err.retryAtMs).toBe(START + 20_000);
    // A classified error, so retry and fallback read the deadline instead of
    // guessing one from the wording.
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "rate", resetAtMs: START + 20_000, retryAfterMs: 20_000 });

    await expect(pool.with(async (key) => key)).rejects.toBeInstanceOf(NoAvailableKeyError);
    time.advance(20_001);
    await expect(pool.with(async (key) => key)).resolves.toBe("b");
  });

  it("benches the pool in an outer FallbackPool until its soonest key is back, not for a minute", async () => {
    const time = clock();
    const keys = new KeyPool("gemini", { keys: ["a", "b"], now: time.now });
    const chain = new FallbackPool(["gemini", "backup"], { now: time.now });
    const answer = await chain.with((id) =>
      id === "gemini"
        ? keys.with(async () => {
            throw rateLimited(10 * 60_000);
          })
        : Promise.resolve(id),
    );
    expect(answer).toBe("backup");
    expect(chain.status()[0]).toMatchObject({ kind: "rate", retryAtMs: START + 10 * 60_000 });
  });
});

describe("KeyPool — what it refuses to rotate on", () => {
  /** Runs a pool of two keys against `err` and reports which keys it dialled. */
  async function tried(err: unknown): Promise<string[]> {
    const seen: string[] = [];
    const pool = new KeyPool("test", { keys: ["a", "b"] });
    await pool
      .with(async (key) => {
        seen.push(key);
        throw err;
      })
      .catch(() => undefined);
    return seen;
  }

  it("propagates a request that would fail identically on every key", async () => {
    const seen: string[] = [];
    const pool = new KeyPool("test", { keys: ["a", "b"] });
    await expect(
      pool.with(async (key) => {
        seen.push(key);
        throw failure("invalid");
      }),
    ).rejects.toThrow("invalid failure");
    expect(seen).toEqual(["a"]);
  });

  it("propagates a dead socket rather than benching the pool for it", async () => {
    // `network` means the request never left our side. Benching every key for
    // it answers NoAvailableKeyError to what is really "no internet".
    expect(await tried(failure("network"))).toEqual(["a"]);
  });

  it("propagates a content block and a stop", async () => {
    expect(await tried(failure("content"))).toEqual(["a"]);
    expect(await tried(failure("aborted"))).toEqual(["a"]);
  });

  it("propagates anything that is not a ProviderError — that is a bug of ours", async () => {
    expect(await tried(new Error("boom"))).toEqual(["a"]);
  });
});

describe("KeyPool call attempt limit", () => {
  it.each(["timeout", "network", "auth", "rate", "quota", "overload"] as const)(
    "calls once on %s, without trying another free or paid key",
    async (kind) => {
      const pool = new KeyPool("test", { keys: ["a", "b"], paidKey: "paid" });
      const err = failure(kind);
      const call = vi.fn(async () => {
        throw err;
      });

      await expect(pool.with(call, { maxAttempts: 1 })).rejects.toBe(err);
      expect(call).toHaveBeenCalledExactlyOnceWith("a", "free");
    },
  );

  it.each(["timeout", "auth", "overload"] as const)(
    "still rotates on %s when no limit was set",
    async (kind) => {
      const pool = new KeyPool("test", { keys: ["a", "b"], paidKey: "paid" });
      const call = vi.fn(async (key: string) => {
        if (key === "a") throw failure(kind);
        return key;
      });

      await expect(pool.with(call)).resolves.toBe("b");
      expect(call.mock.calls).toEqual([
        ["a", "free"],
        ["b", "free"],
      ]);
    },
  );

  it("stops at two actual requests and rethrows the second failure", async () => {
    const pool = new KeyPool("test", { keys: ["a", "b", "c"], paidKey: "paid" });
    const first = failure("timeout");
    const last = failure("auth");
    const call = vi.fn(async (key: string) => {
      throw key === "a" ? first : last;
    });

    await expect(pool.with(call, { maxAttempts: 2 })).rejects.toBe(last);
    expect(call.mock.calls).toEqual([
      ["a", "free"],
      ["b", "free"],
    ]);
  });

  it("returns a success within the allowance", async () => {
    const pool = new KeyPool("test", { keys: ["a", "b"], paidKey: "paid" });
    const call = vi.fn(async (key: string) => {
      if (key === "a") throw failure("timeout");
      return { image: key };
    });

    await expect(pool.with(call, { maxAttempts: 2 })).resolves.toEqual({ image: "b" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("skips benched keys without spending attempts, keeps cooldowns and returns the original error", async () => {
    const time = clock();
    const evictions: { tier: KeyTier; kind: ErrorKind; forMs: number }[] = [];
    const pool = new KeyPool("test", {
      keys: ["free"],
      paidKey: "paid",
      now: time.now,
      onEvict: (info) => evictions.push(info),
    });
    await expect(
      pool.with(() => Promise.reject(rateLimited(30_000)), { maxAttempts: 1 }),
    ).rejects.toBeInstanceOf(ProviderError);
    const call = vi.fn(async (key: string) => key);
    await expect(pool.with(call, { maxAttempts: 1 })).resolves.toBe("paid");
    expect(call).toHaveBeenCalledExactlyOnceWith("paid", "paid");

    const metadata = {
      status: 429,
      code: "daily_limit",
      retryAfterMs: 60_000,
      resetAtMs: START + 120_000,
      window: "monthly" as const,
      shouldRetry: false,
      body: "original provider response",
      cause: new Error("original transport error"),
    };
    const err = new ProviderError("test", "quota", "daily limit", metadata);
    await expect(pool.with(() => Promise.reject(err), { maxAttempts: 1 })).rejects.toBe(err);
    expect(err).toMatchObject(metadata);
    expect(evictions).toEqual([
      { tier: "free", kind: "rate", forMs: 30_000 },
      { tier: "paid", kind: "quota", forMs: 120_000 },
    ]);
    expect(pool.status()).toEqual([
      { tier: "free", evictedUntil: START + 30_000 },
      { tier: "paid", evictedUntil: START + 120_000 },
    ]);

    call.mockClear();
    await expect(pool.with(call, { maxAttempts: 1 })).rejects.toMatchObject({
      retryAtMs: START + 30_000,
    });
    expect(call).not.toHaveBeenCalled();
    time.advance(30_000);
    await expect(pool.with(call, { maxAttempts: 1 })).resolves.toBe("free");
  });

  it("keeps an unclassified transport failure untouched", async () => {
    const pool = new KeyPool("test", { keys: ["a", "b"], paidKey: "paid" });
    const err = new TypeError("fetch failed", { cause: new Error("socket closed") });
    const call = vi.fn(() => Promise.reject(err));
    await expect(pool.with(call, { maxAttempts: 1 })).rejects.toBe(err);
    expect(call).toHaveBeenCalledExactlyOnceWith("a", "free");
  });

  it("does not share an attempt limit with a concurrent ordinary call", async () => {
    const pool = new KeyPool("test", { keys: ["a", "b", "c"] });
    const pending = Promise.withResolvers<void>();
    const err = failure("timeout");
    const once = vi.fn(async () => {
      await pending.promise;
      throw err;
    });
    const capped = expect(pool.with(once, { maxAttempts: 1 })).rejects.toBe(err);
    const ordinary = vi.fn(async (key: string) => {
      if (key === "b") throw failure("auth");
      return key;
    });

    await expect(pool.with(ordinary)).resolves.toBe("c");
    pending.resolve();
    await capped;
    expect(once).toHaveBeenCalledExactlyOnceWith("a", "free");
    expect(ordinary.mock.calls).toEqual([
      ["b", "free"],
      ["c", "free"],
    ]);
    // The same pool keeps its cursor and its ordinary behavior after both calls.
    await expect(pool.with(async (key) => key)).resolves.toBe("c");
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
    "rejects maxAttempts=%s before calling the clock or callback, without moving the cursor",
    async (maxAttempts) => {
      const now = vi.fn(() => START);
      const pool = new KeyPool("test", { keys: ["a", "b"], now });
      const call = vi.fn(async (key: string) => key);
      await expect(pool.with(call, { maxAttempts })).rejects.toThrow(
        "maxAttempts must be a positive integer",
      );
      expect(call).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
      await expect(pool.with(call)).resolves.toBe("a");
    },
  );
});

// ── withKeyPool ───────────────────────────────────────────────────────────

type Script = "ok" | "on-request" | "mid-stream" | "empty";

/** A provider whose stream fails where the test says. `opened` records which
 *  keys ran; `closed` records the streams that were actually finalized;
 *  `signals` records the signal each attempt was handed, which is the only
 *  evidence that an abandoned request was cancelled rather than merely
 *  unreferenced. */
function scripted(script: Record<string, Script>) {
  const opened: string[] = [];
  const closed: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const factory = (apiKey: string): Provider => ({
    id: "scripted",
    model: "test-model",
    async *createStream(
      _messages: ChatMessage[],
      _tools: ToolDefinition[],
      opts: StreamOptions = {},
    ): AsyncIterable<ProviderChunk> {
      opened.push(apiKey);
      signals.push(opts.signal);
      try {
        const mode = script[apiKey] ?? "ok";
        if (mode === "on-request") throw rateLimited();
        if (mode === "empty") return;
        yield { type: "delta", content: `${apiKey}:1` };
        if (mode === "mid-stream") throw rateLimited();
        yield { type: "delta", content: `${apiKey}:2` };
      } finally {
        closed.push(apiKey);
      }
    },
  });
  return { factory, opened, closed, signals };
}

const HELLO: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("withKeyPool", () => {
  it("forwards a per-stream cap, keeps eviction and cancels the one failed attempt", async () => {
    const { factory, opened, closed, signals } = scripted({ a: "on-request" });
    const evictions: KeyTier[] = [];
    const pool = new KeyPool("test", {
      keys: ["a", "b"],
      paidKey: "paid",
      onEvict: ({ tier }) => evictions.push(tier),
    });
    const provider = withKeyPool(pool, factory);
    await expect(
      collect(provider.createStream(HELLO, [], { maxAttempts: 1 })),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(opened).toEqual(["a"]);
    expect(closed).toEqual(["a"]);
    expect(signals[0]?.aborted).toBe(true);
    expect(evictions).toEqual(["free"]);
    await expect(collect(provider.createStream(HELLO, []))).resolves.toHaveLength(2);
    expect(opened).toEqual(["a", "b"]);
  });

  it("rotates when the REQUEST fails, because the first chunk is pulled under the pool", async () => {
    const { factory, opened } = scripted({ a: "on-request" });
    const provider = withKeyPool(new KeyPool("test", { keys: ["a", "b"] }), factory);

    const chunks = await collect(provider.createStream(HELLO, []));
    expect(chunks.map((chunk) => chunk.content)).toEqual(["b:1", "b:2"]);
    expect(opened).toEqual(["a", "b"]);
  });

  it("does no I/O until the consumer pulls — the reason the pool wraps the pull", async () => {
    const { factory, opened } = scripted({ a: "on-request", b: "on-request" });
    const pool = new KeyPool("test", { keys: ["a", "b"] });
    const stream = withKeyPool(pool, factory).createStream(HELLO, []);
    expect(opened).toEqual([]);
    await expect(collect(stream)).rejects.toBeInstanceOf(NoAvailableKeyError);
  });

  it("does NOT rotate once a chunk has reached the consumer", async () => {
    // Past the first chunk the answer is committed to one key: a second key
    // would restart it on top of text the caller already rendered.
    const { factory, opened } = scripted({ a: "mid-stream" });
    const evictions: unknown[] = [];
    const pool = new KeyPool("test", { keys: ["a", "b"], onEvict: (i) => evictions.push(i) });
    const seen: (string | undefined)[] = [];

    await expect(
      (async () => {
        for await (const chunk of withKeyPool(pool, factory).createStream(HELLO, [])) {
          seen.push(chunk.content);
        }
      })(),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(seen).toEqual(["a:1"]);
    expect(opened).toEqual(["a"]);
    expect(evictions).toEqual([]);
  });

  it("finalizes AND aborts the upstream when the consumer breaks out early", async () => {
    // `return()` on its own is not cancellation: it unwinds the adapter down to
    // streamSse's finalizer, which only releases the reader's lock. The body
    // stays live, so without the abort the provider keeps streaming the rest of
    // the answer on this key's connection.
    const { factory, closed, signals } = scripted({});
    const provider = withKeyPool(new KeyPool("test", { keys: ["a"] }), factory);
    for await (const _chunk of provider.createStream(HELLO, [])) break;
    expect(closed).toEqual(["a"]);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("cancels the abandoned attempt BEFORE the next key opens", async () => {
    // Otherwise the rotation stacks a second live stream on the same account
    // while the rotated-away key still holds a connection for the whole answer.
    const { factory, signals } = scripted({ a: "on-request" });
    const abortedWhenNextOpened: boolean[] = [];
    const provider = withKeyPool(new KeyPool("test", { keys: ["a", "b"] }), (apiKey) => {
      if (signals.length > 0) abortedWhenNextOpened.push(signals[0]?.aborted === true);
      return factory(apiKey);
    });

    const chunks = await collect(provider.createStream(HELLO, []));
    expect(chunks.map((chunk) => chunk.content)).toEqual(["b:1", "b:2"]);
    expect(abortedWhenNextOpened).toEqual([true]);
  });

  it("chains the caller's own Stop into the attempt, reason and all", async () => {
    // The attempt runs on its own controller, so a Stop that is not forwarded
    // through it would leave the key streaming an answer nobody reads.
    const { factory, signals } = scripted({});
    const outer = new AbortController();
    const provider = withKeyPool(new KeyPool("test", { keys: ["a"] }), factory);
    const stream = provider.createStream(HELLO, [], { signal: outer.signal });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    const reason = new Error("stopped");
    outer.abort(reason);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toBe(reason);
    await iterator.return?.();
  });

  it("carries an ALREADY-aborted Stop into the attempt it opens", async () => {
    // The chaining listener can only fire on a future abort; a signal aborted
    // before the first pull would otherwise open a request the caller stopped.
    const { factory, signals } = scripted({});
    const provider = withKeyPool(new KeyPool("test", { keys: ["a"] }), factory);
    await collect(provider.createStream(HELLO, [], { signal: AbortSignal.abort() }));
    expect(signals[0]?.aborted).toBe(true);
  });

  it("ends cleanly on a stream that yields nothing", async () => {
    const { factory, closed } = scripted({ a: "empty" });
    const provider = withKeyPool(new KeyPool("test", { keys: ["a"] }), factory);
    expect(await collect(provider.createStream(HELLO, []))).toEqual([]);
    expect(closed).toEqual(["a"]);
  });

  it("takes its id and model from a factory instance", () => {
    const { factory } = scripted({});
    const provider = withKeyPool(new KeyPool("test", { keys: ["a"] }), factory);
    expect(provider.id).toBe("scripted");
    expect(provider.model).toBe("test-model");
  });
});
