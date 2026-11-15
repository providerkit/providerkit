import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { createRuns } from "@gusnips/server/runs";
import { EMPTY_USAGE, defineTool, type Provider, type ProviderChunk } from "@providerkit/core";
import { defineAgent, defineDelegation } from "../../src/index.ts";
import {
  createBackgroundAgent,
  type BackgroundContext,
  type BackgroundPolicy,
} from "../../src/runs.ts";

export function localDatabase(raw = process.env.AGENTS_TEST_DATABASE_URL): string {
  if (!raw)
    throw new Error("Set AGENTS_TEST_DATABASE_URL to the disposable local Postgres database.");
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.search ||
    url.pathname !== "/providerkit_agents"
  )
    throw new Error(
      "Run tests only on the loopback providerkit_agents database, without URL options.",
    );
  return raw;
}

export function checkSchema(schema: string): string {
  if (!/^agents_runs_[a-f0-9]+$/.test(schema)) throw new Error("Not a task-owned test schema.");
  return schema;
}

export const testUsage = { ...EMPTY_USAGE, inputTokens: 3, outputTokens: 2 };
export function answer(content: string): ProviderChunk {
  return { type: "finish", content, finishReason: "stop", usage: testUsage };
}
export function call(name: string): ProviderChunk {
  return {
    type: "finish",
    toolCalls: [{ index: 0, id: name, name, arguments: "{}" }],
    finishReason: "tool_calls",
    usage: testUsage,
  };
}

/** No approvals in the process-kill fixture. Every worker checks its stored owner; approval
 * hooks fail closed instead of providing a pretend production authorization policy. */
export function closedPolicy(context: BackgroundContext): BackgroundPolicy {
  function owned() {
    if (context.owner !== "alice") throw new Error("Owner is not allowed in this fixture.");
  }
  function noApproval(): never {
    throw new Error("This fixture does not grant approvals.");
  }
  return {
    authorizeResume: owned,
    beforeTool: owned,
    approvalContext: noApproval,
    resolveApproval: noApproval,
    claimContinuation: noApproval,
  };
}

export function recoveryAgent(
  pool: Pool,
  schema: string,
  task: string,
  pause?: "checkpoint" | "effect",
) {
  checkSchema(schema);
  async function count(kind: string) {
    // Every invocation is inserted. There is deliberately no uniqueness/deduplication here.
    await pool.query(`INSERT INTO ${schema}.invocations (task, kind) VALUES ($1, $2)`, [
      task,
      kind,
    ]);
  }
  async function park(label: string): Promise<never> {
    process.stdout.write(`${label}\n`);
    return new Promise<never>(() => {});
  }
  const effect = defineTool({
    name: "effect",
    description: "Record one synthetic effect.",
    inputSchema: { type: "object" },
    async run() {
      await count("tool");
      if (pause === "effect") await park("effect");
      return "saved";
    },
  });
  const childProvider: Provider = {
    id: "child",
    model: "fake",
    async *createStream(history) {
      await count("child_model");
      yield history.at(-1)?.role === "tool" ? answer("child result") : call("effect");
    },
  };
  const child = defineAgent({
    id: "child",
    version: "1",
    instructions: "Test child.",
    provider: childProvider,
    tools: [effect],
  });
  const coordinate = defineDelegation({
    name: "coordinate",
    description: "Run one child.",
    inputSchema: { type: "object" },
    validate: () => null,
    specialists: [child],
    async run(_input, context) {
      const result = await context.child("one", child, "Do the work").join();
      if (pause === "checkpoint") await park("checkpoint");
      if (result.status !== "completed") throw new Error(`The child stopped: ${result.status}.`);
      return result.output;
    },
  });
  const provider: Provider = {
    id: "root",
    model: "fake",
    async *createStream(history) {
      await count("root_model");
      yield history.at(-1)?.role === "tool" ? answer("root result") : call("coordinate");
    },
  };
  return defineAgent({
    id: "recovery",
    version: "1",
    instructions: "Test recovery.",
    provider,
    tools: [coordinate],
    treeLimits: { maxParallel: 1 },
  });
}

async function main() {
  const [schema, task, id, mode] = process.argv.slice(2);
  if (!schema || !task || !id || !["checkpoint", "effect", "recover"].includes(mode ?? ""))
    throw new Error("Pass the test schema, task, run id and worker mode.");
  const pool = new Pool({ connectionString: localDatabase() });
  const runs = createRuns(pool, {
    table: `${checkSchema(schema)}.runs`,
    events: `${schema}.run_events`,
    leaseSecs: 0.6,
    onError: (error) => console.error(error),
  });
  const agent = recoveryAgent(
    pool,
    schema,
    task,
    mode === "checkpoint" || mode === "effect" ? mode : undefined,
  );
  const background = createBackgroundAgent({
    agent,
    kind: "recovery",
    runs,
    enqueue: async () => {
      throw new Error("The worker cannot enqueue.");
    },
    policy: closedPolicy,
  });
  try {
    const outcome = await runs.drive(id, background.handlers);
    process.stdout.write(`${outcome}\n`);
  } finally {
    await runs.drain(0);
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
