import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuns } from "@gusnips/server/runs";
import {
  BackgroundEnqueueError,
  createBackgroundAgent,
  type BackgroundContinuationInput,
  type BackgroundContext,
} from "../src/runs.ts";
import { equalData } from "../src/snapshot.ts";
import { defineWorkflow } from "../src/workflow.ts";
import { checkSchema, closedPolicy, localDatabase } from "./fixtures/runs-worker.ts";
import { recoveryWorkflow } from "./fixtures/workflow-worker.ts";

const url = localDatabase();
const schema = checkSchema(`agents_runs_${crypto.randomUUID().replaceAll("-", "")}`);
const pool = new Pool({ connectionString: url });
const runs = createRuns(pool, {
  table: `${schema}.runs`,
  events: `${schema}.run_events`,
  leaseSecs: 0.6,
  onError: () => {},
});
const workers = new Set<ChildProcess>();
let owned = false;
beforeAll(async () => {
  // Wait for a disposable loopback database before creating anything owned by this test.
  await vi.waitFor(
    async () => {
      await pool.query("SELECT 1");
    },
    { timeout: 10_000 },
  );
  await pool.query(`CREATE SCHEMA ${schema}`);
  owned = true;
  // Public run-service DDL, same columns as the existing runs.test.ts integration fixture.
  await pool.query(`CREATE TABLE ${schema}.runs (
    id uuid PRIMARY KEY, root_id uuid NOT NULL, parent_id uuid REFERENCES ${schema}.runs(id) ON DELETE CASCADE,
    child_key text, depth int NOT NULL DEFAULT 0, kind text NOT NULL, owner text NOT NULL,
    status text NOT NULL DEFAULT 'queued', restart text NOT NULL DEFAULT 'fail', input json NOT NULL,
    checkpoint json, result json, error json, limits json NOT NULL DEFAULT '{}', crashes int NOT NULL DEFAULT 0,
    max_crashes int NOT NULL DEFAULT 5, lease_token uuid, lease_until timestamptz, cancel_requested_at timestamptz,
    cost_usd numeric(14,6) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, UNIQUE(parent_id,child_key));
    CREATE TABLE ${schema}.run_events (run_id uuid NOT NULL REFERENCES ${schema}.runs(id) ON DELETE CASCADE,
      seq int NOT NULL, type text NOT NULL, data json, at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,seq));
    CREATE TABLE ${schema}.invocations (task text NOT NULL, kind text NOT NULL);
    CREATE TABLE ${schema}.continuations (owner text NOT NULL, source_id uuid NOT NULL, claim text NOT NULL, segment_id uuid NOT NULL, PRIMARY KEY(owner,source_id));
    CREATE TABLE ${schema}.wake_claims (run_id text NOT NULL, wake_at bigint NOT NULL, claim text NOT NULL, segment text NOT NULL, PRIMARY KEY(run_id,wake_at));`);
});
afterAll(async () => {
  for (const child of workers)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await runs.drain(0);
  if (owned) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});
const policy = (context: Parameters<typeof closedPolicy>[0]) => ({
  ...closedPolicy(context),
  beforeStep() {
    if (context.owner !== "alice") throw new Error("Wrong owner");
  },
});
function worker(task: string, id: string, mode: string) {
  const child = spawn(
    "bun",
    [
      fileURLToPath(new URL("./fixtures/workflow-worker.ts", import.meta.url)),
      schema,
      task,
      id,
      mode,
    ],
    { env: { ...process.env, AGENTS_TEST_DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"] },
  );
  workers.add(child);
  let output = "";
  let errors = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return { child, done, output: () => output, errors: () => errors };
}
async function counts(task: string) {
  const { rows } = await pool.query<{ kind: string; count: number }>(
    `SELECT kind, count(*)::int AS count FROM ${schema}.invocations WHERE task=$1 GROUP BY kind`,
    [task],
  );
  return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
}

// A real host transaction for the optional portable admission contract. The source-row
// lock serializes competing claims; a lost reply can reconcile without a second create.
async function admitContinuation(spec: BackgroundContinuationInput) {
  const client = await pool.connect();
  const { sourceId, id: claim } = spec.input.continuation;
  try {
    await client.query("BEGIN");
    const source = await client.query<{
      owner: string;
      kind: string;
      result: { snapshot: unknown };
      status: string;
    }>(`SELECT owner,kind,result,status FROM ${schema}.runs WHERE id=$1 FOR UPDATE`, [sourceId]);
    const row = source.rows[0];
    if (
      !row ||
      row.owner !== spec.owner ||
      row.kind !== spec.kind ||
      row.status !== "succeeded" ||
      !equalData(row.result.snapshot, spec.input.snapshot)
    )
      throw new Error("The source does not belong to this owner and snapshot");
    const saved = await client.query<{ claim: string; segment_id: string }>(
      `SELECT claim,segment_id FROM ${schema}.continuations WHERE owner=$1 AND source_id=$2`,
      [spec.owner, sourceId],
    );
    const prior = saved.rows[0];
    let id: string;
    if (prior) {
      const current = await client.query<{ input: unknown }>(
        `SELECT input FROM ${schema}.runs WHERE id=$1`,
        [prior.segment_id],
      );
      if (prior.claim !== claim || !equalData(current.rows[0]?.input, spec.input))
        throw new Error("The source already has another continuation");
      id = prior.segment_id;
    } else {
      id = (await runs.create(spec, client)).id;
      await client.query(`INSERT INTO ${schema}.continuations VALUES($1,$2,$3,$4)`, [
        spec.owner,
        sourceId,
        claim,
        id,
      ]);
    }
    await client.query("COMMIT");
    return { id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
function continuationPolicy(context: BackgroundContext) {
  return {
    ...policy(context),
    async claimContinuation(
      _snapshot: unknown,
      continuation: BackgroundContinuationInput["input"]["continuation"],
    ) {
      const claimed = await pool.query(
        `SELECT 1 FROM ${schema}.continuations WHERE owner=$1 AND source_id=$2 AND claim=$3 AND segment_id=$4`,
        [context.owner, continuation.sourceId, continuation.id, context.segmentId],
      );
      if (claimed.rowCount !== 1)
        throw new Error("The current worker does not own this continuation");
    },
  };
}

describe("workflow background integration on loopback PostgreSQL", () => {
  it.each(["checkpoint", "effect"])(
    "recovers from a killed %s worker without repeating completed effects",
    async (mode) => {
      const task = crypto.randomUUID();
      const workflow = recoveryWorkflow(pool, schema, task);
      const jobs = createBackgroundAgent({
        workflow,
        kind: "workflow",
        runs,
        enqueue: async () => {},
        policy,
        events: "awaited",
      });
      const { id } = await jobs.start("alice", {});
      const first = worker(task, id, mode);
      try {
        await vi.waitFor(() => expect(first.output(), first.errors()).toContain("parked"), {
          timeout: 10_000,
        });
        expect(await counts(task)).toEqual({ model: 1, write: 1 });
        first.child.kill("SIGKILL");
        await first.done;
        await vi.waitFor(
          async () => {
            const nudged: string[] = [];
            await runs.sweep({ olderThanSecs: 0, nudge: (key) => nudged.push(key) });
            expect(nudged).toContain(id);
          },
          { timeout: 10_000 },
        );
        const next = worker(task, id, "recover");
        await next.done;
        expect(next.output(), next.errors()).toContain("succeeded");
        const saved = await jobs.read("alice", id);
        expect(saved.outcome).toMatchObject(
          mode === "checkpoint"
            ? { status: "completed", output: "child result" }
            : { status: "failed", error: { code: "interrupted_operation" } },
        );
        expect(await counts(task)).toEqual({ model: 1, write: 1 });
        expect(saved.snapshot.steps[0]?.children[0]?.reference).toBeTypeOf("string");
      } finally {
        if (first.child.exitCode === null && first.child.signalCode === null)
          first.child.kill("SIGKILL");
      }
    },
    20_000,
  );

  it("reports wakes, refuses early continuation and claims a due wake once", async () => {
    let effects = 0;
    const workflow = defineWorkflow({
      id: "wake",
      version: "1",
      input: { schema: { type: "object" }, validate: () => null },
      async run(_, ctx) {
        await ctx.sleep("wait", 5_000);
        return ctx.step("after", () => ++effects);
      },
    });
    const jobs = createBackgroundAgent({
      workflow,
      kind: "wake",
      runs,
      enqueue: async () => {},
      policy(context) {
        return {
          ...policy(context),
          async claimContinuation(snapshot, continuation) {
            if (continuation.wakeAt === undefined) throw new Error("No wake claim");
            const { rowCount } = await pool.query(
              `INSERT INTO ${schema}.wake_claims AS c VALUES($1,$2,$3,$4)
          ON CONFLICT(run_id,wake_at) DO UPDATE SET claim=EXCLUDED.claim WHERE c.claim=EXCLUDED.claim AND c.segment=EXCLUDED.segment`,
              [snapshot.runId, continuation.wakeAt, continuation.id, context.segmentId],
            );
            if (rowCount !== 1) throw new Error("This wake already belongs to another segment");
          },
        };
      },
    });
    const initial = await jobs.start("alice", null);
    expect(await runs.drive(initial.id, jobs.handlers)).toBe("succeeded");
    const waiting = await jobs.read("alice", initial.id);
    expect(waiting.outcome?.status).toBe("suspended");
    await expect(jobs.resume("alice", initial.id, {})).rejects.toThrow(/wakes at/);
    if (waiting.wakeAt === undefined) throw new Error("Missing wake");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(waiting.wakeAt);
      const one = await jobs.resume("alice", initial.id, {});
      const two = await jobs.resume("alice", initial.id, {});
      expect(await runs.drive(one.id, jobs.handlers)).toBe("succeeded");
      expect(await runs.drive(two.id, jobs.handlers)).toBe("failed");
      expect((await jobs.read("alice", one.id)).outcome).toMatchObject({
        status: "completed",
        output: 1,
      });
      expect(effects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the injected create transaction to commit before enqueue", async () => {
    const workflow = defineWorkflow({
      id: "transaction",
      version: "1",
      input: { schema: { type: "object" }, validate: () => null },
      async run() {
        return null;
      },
    });
    let rollback = true;
    const enqueue = vi.fn(async (id: string) => {
      expect(await runs.read(id, "alice")).not.toBeNull();
    });
    const jobs = createBackgroundAgent({
      workflow,
      kind: "transaction",
      enqueue,
      policy,
      runs: {
        ...runs,
        async create(spec) {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const created = await runs.create(spec, client);
            expect(await runs.read(created.id, "alice")).toBeNull();
            expect(enqueue).not.toHaveBeenCalled();
            if (rollback) throw new Error("Rollback fixture");
            await client.query("COMMIT");
            return created;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
        },
      },
    });
    await expect(jobs.start("alice", null)).rejects.toThrow(/Rollback/);
    expect(enqueue).not.toHaveBeenCalled();
    rollback = false;
    const saved = await jobs.start("alice", null);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(saved.id);
  });

  it.each(["approval", "sleep"] as const)(
    "cancels a suspended %s in one durable segment, including uncertain admission and enqueue",
    async (mode) => {
      const effect = vi.fn(() => "should not run");
      const workflow = defineWorkflow({
        id: `cancel-${mode}`,
        version: "1",
        input: { schema: { type: "object" }, validate: () => null },
        async run(_, ctx) {
          if (mode === "sleep") await ctx.sleep("later", 60_000);
          return ctx.step("write", effect, { needsApproval: mode === "approval" });
        },
      });
      const seen: { phase: string; id: string; state: string; aborted: boolean }[] = [];
      const resolved = vi.fn();
      const physicalCancel = vi.fn(runs.cancel);
      let uncertainCreate = true;
      let uncertainEnqueue = false;
      const binding = () =>
        createBackgroundAgent({
          workflow,
          kind: `cancel-${mode}`,
          runs: { ...runs, cancel: physicalCancel },
          async createContinuation(spec) {
            const created = await admitContinuation(spec);
            if (uncertainCreate) {
              uncertainCreate = false;
              throw new Error("Committed but reply lost");
            }
            return created;
          },
          async enqueue(id) {
            expect(await runs.read(id, "alice")).not.toBeNull();
            if (uncertainEnqueue) {
              uncertainEnqueue = false;
              throw new Error("Queue reply lost");
            }
          },
          policy(context) {
            return {
              ...continuationPolicy(context),
              prepareRequest() {
                return {
                  scope: {
                    actorId: "alice",
                    resource: { id: "write", version: "1" },
                    expiresAt: Date.now() + 60_000,
                  },
                };
              },
              resolveRequest() {
                resolved();
                throw new Error("Cancellation cannot approve a request");
              },
            };
          },
          onSegment(event) {
            seen.push({
              phase: event.phase,
              id: event.id,
              state: event.state.status,
              aborted: event.signal.aborted,
            });
          },
        });
      const jobs = binding();
      const first = await jobs.start("alice", null);
      expect(await runs.drive(first.id, jobs.handlers)).toBe("succeeded");
      expect((await jobs.read("alice", first.id)).outcome?.status).toBe("suspended");
      await expect(jobs.cancel("bob", first.id)).rejects.toThrow(/not found/);
      await expect(jobs.cancel("alice", first.id)).rejects.toThrow(/reply lost/);
      // Recreate the binding: no process-local promise cache is what makes this safe.
      const recovered = binding();
      uncertainEnqueue = true;
      let savedId = "";
      try {
        await recovered.cancel("alice", first.id);
        throw new Error("Expected enqueue failure");
      } catch (error) {
        if (!(error instanceof BackgroundEnqueueError)) throw error;
        savedId = error.id;
      }
      const accepted = await recovered.cancel("alice", first.id);
      expect(accepted).toEqual({ id: savedId, requested: true });
      expect(accepted.id).not.toBe(first.id);
      expect(await recovered.cancel("alice", accepted.id)).toEqual(accepted);
      expect(physicalCancel).not.toHaveBeenCalled();
      expect((await recovered.read("alice", accepted.id)).outcome?.status).toBe("suspended");
      const original = await runs.read(accepted.id, "alice");
      if (!original) throw new Error("Missing cancellation segment");
      const unclaimed = await runs.create({
        kind: `cancel-${mode}`,
        owner: "alice",
        restart: "resume",
        input: original.input,
      });
      expect(await runs.drive(unclaimed.id, recovered.handlers)).toBe("failed");
      expect(seen.some((event) => event.id === unclaimed.id)).toBe(false);
      expect(await runs.drive(accepted.id, recovered.handlers)).toBe("succeeded");
      expect((await recovered.wait("alice", accepted.id)).outcome?.status).toBe("cancelled");
      expect(await recovered.cancel("alice", first.id)).toEqual(accepted);
      expect(await recovered.cancel("alice", accepted.id)).toEqual(accepted);
      expect(await runs.drive(accepted.id, recovered.handlers)).not.toBe("failed");
      expect(resolved).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
      expect(seen.filter((event) => event.id === accepted.id)).toEqual([
        { phase: "start", id: accepted.id, state: "suspended", aborted: false },
        { phase: "end", id: accepted.id, state: "cancelled", aborted: false },
      ]);
      const count = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${schema}.continuations WHERE source_id=$1`,
        [first.id],
      );
      expect(count.rows[0]?.count).toBe(1);
      await expect(recovered.resume("alice", first.id, {})).rejects.toThrow();
    },
  );

  it("refuses suspended cancellation without durable admission but still cancels physical rows", async () => {
    const workflow = defineWorkflow({
      id: "no-cancel-admission",
      version: "1",
      input: { schema: { type: "object" }, validate: () => null },
      async run(_, ctx) {
        await ctx.sleep("later", 60_000);
        return null;
      },
    });
    const create = vi.fn(runs.create);
    const jobs = createBackgroundAgent({
      workflow,
      kind: "no-cancel-admission",
      runs: { ...runs, create },
      enqueue: async () => {},
      policy,
    });
    const waiting = await jobs.start("alice", null);
    await runs.drive(waiting.id, jobs.handlers);
    await expect(jobs.cancel("alice", waiting.id)).rejects.toThrow(/createContinuation/);
    expect(create).toHaveBeenCalledTimes(1);
    const queued = await jobs.start("alice", null);
    expect(await jobs.cancel("alice", queued.id)).toEqual({ id: queued.id, requested: true });
    const row = await jobs.read("alice", queued.id);
    expect(row.status).toBe("cancelled");
    expect(row.outcome).toBeNull();
    expect(await jobs.cancel("alice", queued.id)).toEqual({ id: queued.id, requested: false });
  });

  it("reconciles answer continuations through the same committed host capability", async () => {
    const effect = vi.fn(() => "done");
    const workflow = defineWorkflow({
      id: "answer-admission",
      version: "1",
      input: { schema: { type: "object" }, validate: () => null },
      async run(_, ctx) {
        await ctx.sleep("wake", 200);
        return ctx.step("done", effect);
      },
    });
    const enqueue = vi.fn(async () => {});
    const jobs = createBackgroundAgent({
      workflow,
      kind: "answer-admission",
      runs,
      enqueue,
      policy: continuationPolicy,
      createContinuation: admitContinuation,
    });
    const first = await jobs.start("alice", null);
    await runs.drive(first.id, jobs.handlers);
    const pending = await jobs.read("alice", first.id);
    if (pending.wakeAt === undefined) throw new Error("Missing scheduled wake");
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(pending.wakeAt!));
    const one = await jobs.resume("alice", first.id, {});
    const two = await jobs.resume("alice", first.id, {});
    expect(two).toEqual(one);
    expect(await runs.drive(one.id, jobs.handlers)).toBe("succeeded");
    expect((await jobs.read("alice", one.id)).outcome).toMatchObject({
      status: "completed",
      output: "done",
    });
    expect(effect).toHaveBeenCalledTimes(1);
    await expect(jobs.cancel("alice", first.id)).rejects.toThrow(/another continuation/);
  });
});
