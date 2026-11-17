import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { createRuns } from "@gusnips/server/runs";
import { defineAgent } from "../../src/run.ts";
import { defineWorkflow } from "../../src/workflow.ts";
import { createBackgroundAgent } from "../../src/runs.ts";
import { isRecord } from "../../src/snapshot.ts";
import { answer, checkSchema, closedPolicy, localDatabase } from "./runs-worker.ts";

export function recoveryWorkflow(pool: Pool, schema: string, task: string, effectPause = false) {
  checkSchema(schema);
  const count = (kind: string) =>
    pool.query(`INSERT INTO ${schema}.invocations (task, kind) VALUES ($1, $2)`, [task, kind]);
  const child = defineAgent({
    id: "kept",
    version: "1",
    instructions: "Offline test",
    provider: {
      id: "fake",
      model: "fake",
      async *createStream() {
        await count("model");
        yield answer("child result");
      },
    },
  });
  return defineWorkflow({
    id: "recovery-workflow",
    version: "1",
    input: {
      schema: { type: "object" },
      validate(raw) {
        if (!isRecord(raw)) throw new TypeError("Pass an object.");
        return raw;
      },
    },
    agents: [child],
    treeLimits: { maxParallel: 1 },
    async run(_, ctx) {
      const kept = await ctx.agent("kept", child, "Offline work");
      if (kept.status !== "completed") throw new Error("Child did not complete");
      await ctx.step("write", async () => {
        await count("write");
        if (effectPause) {
          process.stdout.write("parked\n");
          await new Promise<never>(() => {});
        }
        return "saved";
      });
      return kept.output;
    },
  });
}
async function main() {
  const [schema, task, id, mode] = process.argv.slice(2);
  if (!schema || !task || !id || !["checkpoint", "effect", "recover"].includes(mode ?? ""))
    throw new Error("Pass owned schema, task, run and mode.");
  const pool = new Pool({ connectionString: localDatabase() });
  const runs = createRuns(pool, {
    table: `${checkSchema(schema)}.runs`,
    events: `${schema}.run_events`,
    leaseSecs: 0.6,
    onError: (error) => console.error(error),
  });
  const workflow = recoveryWorkflow(pool, schema, task, mode === "effect");
  const jobs = createBackgroundAgent({
    workflow,
    kind: "workflow",
    runs,
    enqueue: async () => {},
    policy: (context) => ({
      ...closedPolicy(context),
      beforeStep() {
        if (context.owner !== "alice") throw new Error("Wrong owner");
      },
    }),
  });
  const handler = jobs.handlers.workflow;
  if (!handler) throw new Error("Missing handler");
  try {
    const result = await runs.drive(id, {
      workflow: (run) =>
        handler({
          ...run,
          async save(value) {
            await run.save(value);
            if (
              mode === "checkpoint" &&
              isRecord(value) &&
              value.kind === "workflow" &&
              Array.isArray(value.steps) &&
              value.steps.some(
                (step) => isRecord(step) && step.key === "write" && step.status === "completed",
              )
            ) {
              process.stdout.write("parked\n");
              await new Promise<never>(() => {});
            }
          },
        }),
    });
    process.stdout.write(`${result}\n`);
  } finally {
    await runs.drain(0);
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
