import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStopped, type ChildResult, type ChildSpec, type Run } from "@gusnips/server/runs";
import { collectTurn, defineTool, EMPTY_USAGE, type ProviderChunk } from "@providerkit/core";
import { defineAgent, type Agent, type AgentEvent, type RunSnapshot } from "../src/index.ts";
import { createProgress, type EventDurability } from "../src/progress.ts";
import { createBackgroundAgent, type BackgroundWorker } from "../src/runs.ts";
import { AGENT_RUNTIME } from "../src/delegation.ts";
import { emitEvent, ExecutionTree } from "../src/tree.ts";

// The 0.19/0.20 callback is recursive too: its children have no append capability.
interface OlderWorker extends Omit<Run, "append" | "child"> {
  child<T>(
    key: string,
    spec: ChildSpec,
    execute: (run: OlderWorker) => Promise<T>,
  ): Promise<ChildResult<T>>;
}

type Event = { type: string; data?: unknown };
const delta = (
  chunk: ProviderChunk,
  patch: Partial<Extract<AgentEvent, { type: "model_chunk" }>> = {},
): AgentEvent => ({
  type: "model_chunk",
  runId: "root",
  operationId: "model-1",
  attemptId: "attempt-1",
  chunk,
  ...patch,
});
const text = (content: string) => delta({ type: "delta", content });
const state: AgentEvent = {
  type: "state",
  runId: "root",
  attemptId: "attempt-1",
  state: { status: "completed", candidate: "done" },
};
const finish: ProviderChunk = { type: "finish", finishReason: "stop" };
const policy = () => ({
  authorizeResume() {},
  beforeTool() {},
  claimContinuation() {},
  prepareRequest: () => ({
    scope: {
      actorId: "owner",
      resource: { id: "resource", version: "1" },
      expiresAt: Date.now() + 60_000,
    },
  }),
  resolveRequest: () => ({ type: "approve" as const }),
});
function sink(mode: EventDurability = "awaited", write?: Run["append"]) {
  const records: Event[] = [];
  const controller = new AbortController();
  const append = vi.fn(
    write ??
      (async (events) => {
        records.push(...structuredClone(events));
      }),
  );
  const emit = vi.fn((type: string, data?: unknown) => {
    records.push(structuredClone({ type, data }));
  });
  const progress = createProgress({ append, emit, signal: controller.signal }, mode);
  return { progress, append, emit, records, controller };
}
async function fold(events: AgentEvent[]) {
  return collectTurn(
    (async function* () {
      for (const event of events) if (event.type === "model_chunk") yield event.chunk;
    })(),
  );
}
function stored(records: Event[]): AgentEvent[] {
  // Test data is produced only by the typed sink. No external payload enters this assertion.
  return records.filter((event) => event.type === "agent").map((event) => event.data as AgentEvent);
}
afterEach(() => vi.useRealTimers());

describe("background progress buffer", () => {
  it.each(["best-effort", "awaited"] as const)(
    "folds adjacent deltas without changing collectTurn in %s mode",
    async (mode) => {
      const events: AgentEvent[] = [
        text("Hello"),
        text(" world"),
        delta({ type: "delta", reasoning: "First" }),
        delta({ type: "delta", reasoning: ", think." }),
        delta({ type: "delta", content: "!", source: { provider: "fake", model: "one" } }),
        delta({ type: "delta", content: " More", source: { provider: "fake", model: "one" } }),
        delta({ type: "delta", content: " Other", source: { provider: "fake", model: "two" } }),
        delta({ type: "delta", reasoningDetails: [{ signature: "keep-me" }] }),
        delta({
          type: "delta",
          toolCalls: [{ index: 0, id: "call", name: "read", arguments: "{" }],
        }),
        delta({ type: "delta", toolCalls: [{ index: 0, arguments: "}" }] }),
        delta({ type: "usage", usage: { ...EMPTY_USAGE, inputTokens: 4, outputTokens: 3 } }),
        delta(finish),
      ];
      const test = sink(mode);
      events.forEach(test.progress.push);
      await test.progress.flush();
      const persisted = stored(test.records);
      expect(await fold(persisted)).toEqual(await fold(events));
      expect(persisted).toHaveLength(events.length - 3);
      expect(persisted.filter((e) => e.type === "model_chunk" && e.chunk.toolCalls)).toHaveLength(
        2,
      );
      if (mode === "best-effort") expect(test.append).not.toHaveBeenCalled();
      await test.progress.dispose();
    },
  );

  it("never folds across boundaries, attempts, operations, children or mixed chunk fields", async () => {
    const events = [
      text("a"),
      { ...state, state: { status: "running" as const } },
      text("b"),
      delta({ type: "delta", content: "c" }, { attemptId: "attempt-2" }),
      delta({ type: "delta", content: "d" }, { operationId: "model-2" }),
      delta({ type: "delta", content: "e" }, { runId: "child" }),
      delta({ type: "delta", content: "f", reasoning: "g" }),
      delta({ type: "delta", content: "h", usage: EMPTY_USAGE }),
      delta({ type: "delta", content: "i", reasoningDetails: [{ signature: "signature" }] }),
    ];
    const test = sink();
    events.forEach(test.progress.push);
    await test.progress.flush();
    expect(stored(test.records)).toEqual(events);
    await test.progress.dispose();
  });

  it("flushes a quiet model after 100 ms and removes its timer on dispose", async () => {
    vi.useFakeTimers();
    const test = sink();
    test.progress.push(text("a"));
    await vi.advanceTimersByTimeAsync(99);
    expect(test.append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stored(test.records)).toEqual([text("a")]);
    test.progress.push(text("not due"));
    await test.progress.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.append).toHaveBeenCalledTimes(1);
  });

  it("serializes asynchronous writes, seals flush boundaries and does not extend an earlier barrier", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const third = Promise.withResolvers<void>();
    const test = sink(
      "awaited",
      vi
        .fn<Run["append"]>()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
        .mockImplementationOnce(() => third.promise),
    );
    test.progress.push(text("a"));
    const barrier = test.progress.flush();
    test.progress.push(text("b"));
    test.progress.push(text("c"));
    const next = test.progress.flush();
    test.progress.push(text("d"));
    expect(test.append).toHaveBeenCalledTimes(1);
    first.resolve();
    await barrier;
    expect(test.append).toHaveBeenCalledTimes(2);
    expect(test.append.mock.calls[1]?.[0]).toEqual([
      { type: "agent", data: text("bc") },
      { type: "agent", data: text("d") },
    ]);
    test.progress.push(text("e"));
    second.resolve();
    await next;
    expect(test.append).toHaveBeenCalledTimes(3);
    third.resolve();
    await test.progress.flush();
    await test.progress.dispose();
  });

  it("records uncertainty once without replaying an append that may have landed", async () => {
    const records: Event[] = [];
    let calls = 0;
    const test = sink("awaited", async (events) => {
      records.push(...structuredClone(events));
      if (calls++ === 0) throw new Error("Lost acknowledgement after commit");
    });
    test.progress.push(text("once"));
    await test.progress.flush();
    expect(records).toEqual([
      { type: "agent", data: text("once") },
      { type: "agent.gap", data: { dropped: 0, unconfirmed: 1 } },
    ]);
    test.progress.push(state);
    await test.progress.flush();
    expect(records.at(-1)).toEqual({ type: "agent", data: state });
    expect(test.append).toHaveBeenCalledTimes(3);
    await test.progress.dispose();
  });

  it("refuses a successful barrier when even the gap record cannot be stored", async () => {
    vi.useFakeTimers();
    const test = sink("awaited", async () => {
      throw new Error("Database unavailable");
    });
    test.progress.push(text("lost"));
    await vi.advanceTimersByTimeAsync(100);
    expect(test.progress.signal.aborted).toBe(true);
    await expect(test.progress.flush()).rejects.toThrow("could not be saved or marked incomplete");
    await expect(test.progress.flush()).rejects.toThrow("could not be saved or marked incomplete");
    expect(test.append).toHaveBeenCalledTimes(2);
    await test.progress.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["lost", "cancelled", "shutdown"] as const)(
    "does not write a gap or abandon an in-flight append on %s",
    async (code) => {
      vi.useFakeTimers();
      const pending = Promise.withResolvers<void>();
      const test = sink("awaited", () => pending.promise);
      test.progress.push(state);
      test.progress.push(text("queued"));
      const reason = new RunStopped(code);
      test.controller.abort(reason);
      let disposed = false;
      const disposal = test.progress.dispose().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);
      pending.reject(reason);
      await disposal;
      await expect(test.progress.flush()).rejects.toBe(reason);
      expect(test.append).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds queued records and bytes and persists overflow before later events", async () => {
    const held = Promise.withResolvers<void>();
    const batches: Event[][] = [];
    const test = sink("awaited", async (events) => {
      batches.push(structuredClone([...events]));
      if (batches.length === 1) await held.promise;
    });
    test.progress.push(state);
    for (let n = 0; n < 200; n++) test.progress.push(delta({ type: "usage", usage: EMPTY_USAGE }));
    held.resolve();
    await test.progress.flush();
    expect(batches.map((batch) => batch.length)).toEqual([1, 64, 1]);
    expect(batches[2]).toEqual([{ type: "agent.gap", data: { dropped: 136, unconfirmed: 0 } }]);
    test.progress.push(text("x".repeat(256 * 1024)));
    await test.progress.flush();
    expect(batches.at(-1)).toEqual([{ type: "agent.gap", data: { dropped: 1, unconfirmed: 0 } }]);
    test.progress.push(text("after"));
    await test.progress.flush();
    expect(batches.at(-1)).toEqual([{ type: "agent", data: text("after") }]);
    await test.progress.dispose();
  });

  it("leaves raw observers synchronous, unmerged and best-effort", async () => {
    const test = sink();
    const raw: AgentEvent[] = [];
    const options = {
      host: { progress: test.progress },
      onEvent(event: AgentEvent) {
        raw.push(event);
        throw new Error("Observer only");
      },
    };
    emitEvent(options, text("a"));
    emitEvent(options, text("b"));
    expect(raw).toEqual([text("a"), text("b")]);
    await test.progress.flush();
    expect(stored(test.records)).toEqual([text("ab")]);
    expect(() =>
      emitEvent(
        {
          host: {
            progress: {
              push() {
                throw new Error("Required");
              },
              flush: async () => {},
            },
          },
        },
        state,
      ),
    ).toThrow("Required");
    await test.progress.dispose();
  });
});

async function background(agent: Agent<string>, mode: EventDurability = "awaited") {
  let input: unknown;
  const jobs = createBackgroundAgent({
    agent,
    kind: "test",
    events: mode,
    policy,
    runs: {
      async create(spec) {
        input = spec.input;
        return { id: "segment" };
      },
      read: async () => null,
      cancel: async () => true,
      async *tail() {},
    },
    enqueue: async () => {},
  });
  await jobs.start("owner", "Work");
  const saves: RunSnapshot[] = [];
  const records: Event[] = [];
  const controller = new AbortController();
  const worker: BackgroundWorker = {
    id: "segment",
    owner: "owner",
    input,
    checkpoint: null,
    resumed: false,
    crashes: 0,
    signal: controller.signal,
    async save(snapshot) {
      saves.push(agent[AGENT_RUNTIME].restore(snapshot));
    },
    emit(type, data) {
      records.push({ type, data });
    },
    async append(events) {
      records.push(...structuredClone(events));
    },
    async child(_key, _spec, execute) {
      return { ok: true, value: await execute(worker) };
    },
  };
  const handler = jobs.handlers.test;
  if (!handler) throw new Error("Missing handler");
  return { handler, worker, records, saves, controller };
}
const base = { id: "agent", version: "1", instructions: "Test" };

describe("progress journal barriers", () => {
  it.each(["best-effort", "awaited"] as const)(
    "accepts an older host only in %s mode",
    async (mode) => {
      let calls = 0;
      const test = await background(
        defineAgent({
          ...base,
          provider: {
            id: "fake",
            model: "one",
            async *createStream() {
              calls++;
              yield { type: "delta", content: "a" };
              yield { type: "delta", content: "b" };
              yield finish;
            },
          },
        }),
        mode,
      );
      const oldHostHandler: (run: OlderWorker) => Promise<unknown> = test.handler;
      expect(oldHostHandler).toBe(test.handler);
      const { append: _append, ...older } = test.worker;
      if (mode === "awaited") {
        await expect(test.handler(older)).rejects.toThrow("needs Run.append");
        expect(calls).toBe(0);
        expect(test.saves).toEqual([]);
      } else {
        await test.handler(older);
        expect(calls).toBe(1);
        expect(stored(test.records)).toContainEqual(
          expect.objectContaining({ chunk: { type: "delta", content: "ab" } }),
        );
      }
    },
  );

  it("flushes before completed journal saves and the final outcome", async () => {
    const test = await background(
      defineAgent({
        ...base,
        provider: {
          id: "fake",
          model: "one",
          async *createStream() {
            yield { type: "delta", content: "done" };
            yield finish;
          },
        },
      }),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const final = Promise.withResolvers<void>();
    const finalRelease = Promise.withResolvers<void>();
    const append = test.worker.append;
    if (!append) throw new Error("Missing append");
    test.worker.append = async (events) => {
      if (stored([...events]).some((event) => event.type === "state")) {
        final.resolve();
        await finalRelease.promise;
      } else {
        entered.resolve();
        await release.promise;
      }
      await append(events);
    };
    let finished = false;
    const running = test.handler(test.worker).then(() => {
      finished = true;
    });
    await entered.promise;
    expect(
      test.saves.every((snapshot) =>
        snapshot.models.every((model) => model.status !== "completed"),
      ),
    ).toBe(true);
    release.resolve();
    await final.promise;
    expect(test.saves.at(-1)?.state.status).toBe("completed");
    expect(finished).toBe(false);
    finalRelease.resolve();
    await running;
    expect(stored(test.records).at(-1)?.type).toBe("state");
  });

  it("cannot execute a tool after an unrecorded progress failure", async () => {
    const effect = vi.fn(async () => "written");
    const tool = defineTool({
      name: "write",
      description: "Write",
      inputSchema: { type: "object" },
      run: effect,
    });
    const test = await background(
      defineAgent({
        ...base,
        tools: [tool],
        provider: {
          id: "fake",
          model: "one",
          async *createStream() {
            yield {
              type: "delta",
              content: "work",
              toolCalls: [{ index: 0, id: "c", name: "write", arguments: "{}" }],
            };
            yield { type: "finish", finishReason: "tool_calls" };
          },
        },
      }),
    );
    test.worker.append = async () => {
      throw new Error("Storage unavailable");
    };
    await expect(test.handler(test.worker)).rejects.toThrow(
      "could not be saved or marked incomplete",
    );
    expect(effect).not.toHaveBeenCalled();
    expect(test.saves.at(-1)?.models.at(-1)?.status).toBe("running");
  });

  it("seals progress when a journal save queues, even behind a slow checkpoint", async () => {
    const agent = defineAgent({
      ...base,
      provider: {
        id: "fake",
        model: "one",
        async *createStream() {
          yield finish;
        },
      },
    });
    const snapshot = await agent[AGENT_RUNTIME].open("Work", {}, "root");
    const test = sink();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const checkpoint = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const tree = new ExecutionTree(snapshot, { host: { progress: test.progress, checkpoint } });
    try {
      test.progress.push(text("a"));
      const first = tree.save();
      await entered.promise;
      test.progress.push(text("b"));
      const second = tree.save();
      test.progress.push(text("c"));
      await test.progress.flush();
      expect(stored(test.records)).toEqual([text("a"), text("b"), text("c")]);
      expect(checkpoint).toHaveBeenCalledTimes(1);
      release.resolve();
      await Promise.all([first, second]);
      expect(checkpoint).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      tree.close();
      await test.progress.dispose();
    }
  });

  it("reports a final-state storage failure and resumes its saved outcome without replaying effects", async () => {
    const effect = vi.fn(async () => "written");
    let calls = 0;
    const test = await background(
      defineAgent({
        ...base,
        tools: [
          defineTool({
            name: "write",
            description: "Write",
            inputSchema: { type: "object" },
            run: effect,
          }),
        ],
        provider: {
          id: "fake",
          model: "one",
          async *createStream() {
            if (calls++ === 0)
              yield {
                type: "finish",
                finishReason: "tool_calls",
                toolCalls: [{ index: 0, id: "c", name: "write", arguments: "{}" }],
              };
            else yield { ...finish, content: "done" };
          },
        },
      }),
    );
    const append = test.worker.append;
    if (!append) throw new Error("Missing append");
    test.worker.append = async (events) => {
      if (
        events.some((event) => event.type === "agent.gap") ||
        stored([...events]).some((event) => event.type === "state")
      )
        throw new Error("Final event storage unavailable");
      await append(events);
    };
    await expect(test.handler(test.worker)).rejects.toThrow(
      "could not be saved or marked incomplete",
    );
    expect(test.saves.at(-1)?.state.status).toBe("completed");
    await test.handler({ ...test.worker, checkpoint: test.saves.at(-1), resumed: true, append });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(stored(test.records).at(-1)).toMatchObject({
      type: "state",
      state: { status: "completed" },
    });
  });

  it("persists resync before replacement-attempt events", async () => {
    const test = await background(
      defineAgent({
        ...base,
        provider: {
          id: "fake",
          model: "one",
          async *createStream() {
            yield { type: "delta", content: "done" };
            yield finish;
          },
        },
      }),
    );
    await test.handler({ ...test.worker, resumed: true, crashes: 2 });
    expect(test.records[0]).toEqual({ type: "agent.resync", data: { crashes: 2 } });
  });
});
