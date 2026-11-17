import { describe, expect, it, vi } from "vitest";
import { defineAgent, type TreeNode } from "../src/index.ts";
import { createBackgroundAgent, type BackgroundWorker } from "../src/runs.ts";
import { AGENT_RUNTIME } from "../src/delegation.ts";
import type { BackgroundContext, SegmentHook } from "../src/background-types.ts";

async function fixture(onSegment?: SegmentHook, authorize = () => {}) {
  const called = vi.fn();
  const agent = defineAgent({
    id: "fixture",
    version: "1",
    instructions: "Answer.",
    provider: {
      id: "offline",
      model: "fixture",
      async *createStream() {
        called();
        yield { type: "finish", content: "Done", finishReason: "stop" };
      },
    },
  });
  let input: unknown;
  let checkpoint: TreeNode | undefined;
  const contexts: BackgroundContext[] = [];
  const jobs = createBackgroundAgent({
    agent,
    kind: "segment-test",
    onSegment,
    policy(context) {
      contexts.push(context);
      return {
        authorizeResume: authorize,
        beforeTool() {},
        claimContinuation() {},
        prepareRequest: () => ({
          scope: {
            actorId: "owner",
            resource: { id: "fixture", version: "1" },
            expiresAt: Date.now() + 60_000,
          },
        }),
        resolveRequest: () => ({ type: "approve" }),
      };
    },
    runs: {
      async create(spec) {
        input = spec.input;
        return { id: "physical" };
      },
      read: async () => null,
      cancel: async () => true,
      async *tail() {},
    },
    enqueue: async () => {},
  });
  await jobs.start("owner", "Work", { runId: "logical" });
  const controller = new AbortController();
  const worker: BackgroundWorker = {
    id: "physical",
    owner: "owner",
    input,
    checkpoint: null,
    resumed: false,
    crashes: 0,
    signal: controller.signal,
    async save(value) {
      checkpoint = agent[AGENT_RUNTIME].restore(value);
    },
    emit() {},
    async child(_key, _spec, execute) {
      return { ok: true, value: await execute(worker) };
    },
  };
  const handler = jobs.handlers["segment-test"];
  if (!handler) throw new Error("Missing handler");
  return { jobs, worker, controller, contexts, called, handler, saved: () => checkpoint };
}

describe("portable background segment boundaries", () => {
  it("keeps logical identity and awaits start before dispatch, then reports the saved end", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const phases: string[] = [];
    const fixtureRun = await fixture(async (event) => {
      expect(event).toMatchObject({ owner: "owner", id: "physical", runId: "logical" });
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.snapshot)).toBe(true);
      expect(event.state).toBe(event.snapshot.state);
      expect(event.signal.aborted).toBe(false);
      phases.push(event.phase);
      if (event.phase === "start") {
        expect(event.snapshot.state.status).toBe("running");
        entered.resolve();
        await release.promise;
      } else {
        expect(event.snapshot.state.status).toBe("completed");
        expect(fixtureRun.saved()).toEqual(event.snapshot);
      }
    });
    const running = fixtureRun.handler(fixtureRun.worker);
    await entered.promise;
    expect(fixtureRun.called).not.toHaveBeenCalled();
    release.resolve();
    await running;
    expect(phases).toEqual(["start", "end"]);
    expect(fixtureRun.called).toHaveBeenCalledTimes(1);
    expect(fixtureRun.contexts).toEqual([
      { owner: "owner", runId: "logical", segmentId: "physical", continuation: undefined },
    ]);
  });

  it("authorizes before disclosing a segment and refuses invalid caller run IDs", async () => {
    const hook = vi.fn();
    const fixtureRun = await fixture(hook, () => {
      throw new Error("Not this owner");
    });
    await expect(fixtureRun.handler(fixtureRun.worker)).rejects.toThrow("Not this owner");
    expect(hook).not.toHaveBeenCalled();
    expect(fixtureRun.called).not.toHaveBeenCalled();
    await expect(fixtureRun.jobs.start("owner", "Work", { runId: "" })).rejects.toThrow();
  });

  it("does not dispatch after a start-hook failure and does not replay after an end-hook failure", async () => {
    const start = await fixture(() => {
      throw new Error("Start was not recorded");
    });
    await expect(start.handler(start.worker)).rejects.toThrow("Start was not recorded");
    expect(start.called).not.toHaveBeenCalled();

    let fail = true;
    const end = await fixture((event) => {
      if (event.phase === "end" && fail) throw new Error("End delivery is unknown");
    });
    await expect(end.handler(end.worker)).rejects.toThrow("End delivery is unknown");
    expect(end.called).toHaveBeenCalledTimes(1);
    expect(end.saved()?.state.status).toBe("completed");
    fail = false;
    await end.handler({ ...end.worker, checkpoint: end.saved(), resumed: true, crashes: 1 });
    expect(end.called).toHaveBeenCalledTimes(1);
  });

  it("stops waiting on a hook when its worker is cancelled, without late dispatch", async () => {
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const fixtureRun = await fixture(async (event) => {
      if (event.phase === "start") {
        entered.resolve();
        await late.promise;
      }
    });
    const stopped = new Error("Worker stopped");
    const running = fixtureRun.handler(fixtureRun.worker);
    const rejected = expect(running).rejects.toBe(stopped);
    await entered.promise;
    fixtureRun.controller.abort(stopped);
    await rejected;
    late.resolve();
    await Promise.resolve();
    expect(fixtureRun.called).not.toHaveBeenCalled();
  });
});
