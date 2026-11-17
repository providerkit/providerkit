import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuns } from "@gusnips/server/runs";
import { createBackgroundAgent } from "../src/runs.ts";
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
});
