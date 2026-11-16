import { evidenceFor, firstRequest } from "./fixtures/requests.ts";
import { openRequests } from "../src/tree.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuns } from "@gusnips/server/runs";
import { defineTool, type ChatMessage, type Provider, type ProviderChunk } from "@providerkit/core";
import {
  createMemorySession,
  defineAgent,
  defineDelegation,
  type Agent,
  type AgentMessage,
  type InputPart,
  type RunContext,
  type RunSnapshot,
  type Session,
} from "../src/index.ts";
import { AGENT_RUNTIME } from "../src/delegation.ts";
import {
  BackgroundEnqueueError,
  createBackgroundAgent,
  type BackgroundContext,
  type BackgroundPolicy,
} from "../src/runs.ts";
import { isRecord } from "../src/snapshot.ts";
import {
  answer,
  call,
  checkSchema,
  closedPolicy,
  localDatabase,
  recoveryAgent,
} from "./fixtures/runs-worker.ts";

const url = localDatabase();
const schema = checkSchema(`agents_runs_${crypto.randomUUID().replaceAll("-", "")}`);
const pool = new Pool({ connectionString: url });
const errors: unknown[] = [];
const services: ReturnType<typeof createRuns>[] = [];
function service() {
  const runs = createRuns(pool, {
    table: `${schema}.runs`,
    events: `${schema}.run_events`,
    leaseSecs: 0.6,
    onError: (error) => errors.push(error),
  });
  services.push(runs);
  return runs;
}
const runs = service();
const queue: string[] = [];
const enqueue = async (id: string) => {
  queue.push(id);
};

// Public @gusnips/server README DDL, with only the schema name changed.
beforeAll(async () => {
  await pool.query(`CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.runs (
      id uuid PRIMARY KEY, root_id uuid NOT NULL,
      parent_id uuid REFERENCES ${schema}.runs (id) ON DELETE CASCADE,
      child_key text, depth int NOT NULL DEFAULT 0, kind text NOT NULL, owner text NOT NULL,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      restart text NOT NULL DEFAULT 'fail' CHECK (restart IN ('fail', 'restart', 'resume')),
      input json NOT NULL, checkpoint json, result json, error json,
      limits json NOT NULL DEFAULT '{}', crashes int NOT NULL DEFAULT 0, max_crashes int NOT NULL DEFAULT 5,
      lease_token uuid, lease_until timestamptz, cancel_requested_at timestamptz,
      cost_usd numeric(14, 6) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
      CHECK ((parent_id IS NULL) = (child_key IS NULL)), UNIQUE (parent_id, child_key)
    );
    CREATE INDEX runs_queued_idx ON ${schema}.runs (updated_at) WHERE parent_id IS NULL AND status = 'queued';
    CREATE INDEX runs_leased_idx ON ${schema}.runs (lease_until) WHERE parent_id IS NULL AND status = 'running';
    CREATE INDEX runs_root_idx ON ${schema}.runs (root_id);
    CREATE INDEX runs_finished_idx ON ${schema}.runs (finished_at) WHERE parent_id IS NULL AND finished_at IS NOT NULL;
    CREATE TABLE ${schema}.run_events (
      run_id uuid NOT NULL REFERENCES ${schema}.runs (id) ON DELETE CASCADE,
      seq int NOT NULL, type text NOT NULL, data json, at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE ${schema}.invocations (task text NOT NULL, kind text NOT NULL);
    CREATE TABLE ${schema}.resources (id text PRIMARY KEY, owner text NOT NULL, version text NOT NULL);
    CREATE TABLE ${schema}.claims (
      operation text PRIMARY KEY, continuation text NOT NULL, source text NOT NULL,
      owner text NOT NULL, decision json NOT NULL, segment text, consumed boolean NOT NULL DEFAULT false
    );`);
});
afterAll(async () => {
  for (const child of workers)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(services.map((store) => store.drain(0)));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

function fake(turn: (count: number) => ProviderChunk) {
  let calls = 0;
  const provider: Provider = {
    id: "fake",
    model: "fake",
    async *createStream() {
      yield turn(calls++);
    },
  };
  return { provider, calls: () => calls };
}
function bind<T>(agent: Agent<T>, policy = closedPolicy, kind = "test") {
  return createBackgroundAgent({ agent, kind, runs, enqueue, policy });
}
const base = { id: "test", version: "1", instructions: "Test only." };

/** Test-only durable authority. Reservation binds an operation to one physical segment.
 * Authentication is synthetic evidence here, never an example production login system. */
async function approvalFixture(resource = crypto.randomUUID()) {
  await pool.query(`INSERT INTO ${schema}.resources VALUES ($1, 'alice', '1')`, [resource]);
  const expiresAt = Date.now() + 60_000;
  const evidence = { actor: "alice", approve: true, version: "1" };
  async function access(context: BackgroundContext, version?: string) {
    const { rows } = await pool.query<{ version: string }>(
      `SELECT version FROM ${schema}.resources WHERE id=$1 AND owner=$2`,
      [resource, context.owner],
    );
    if (!rows[0] || (version !== undefined && rows[0].version !== version))
      throw new Error("Resource access or version changed.");
  }
  function decision(raw: unknown) {
    if (!isRecord(raw) || raw.actor !== "alice" || raw.approve !== true || raw.version !== "1")
      throw new Error("Decision authentication failed.");
  }
  const policy = (context: BackgroundContext): BackgroundPolicy => ({
    async authorizeResume() {
      await access(context);
      const claim = context.continuation;
      if (!claim) return;
      const { rowCount } = await pool.query(
        `SELECT 1 FROM ${schema}.claims
        WHERE continuation=$2 AND source=$3 AND owner=$4 AND segment=$1`,
        [context.segmentId, claim.id, claim.sourceId, context.owner],
      );
      if (rowCount !== Object.keys(claim.answers).length)
        throw new Error("The continuation belongs to another host segment.");
    },
    async prepareRequest() {
      await access(context, "1");
      return {
        scope: { actorId: context.owner, resource: { id: resource, version: "1" }, expiresAt },
      };
    },
    async claimContinuation(snapshot, continuation) {
      if (snapshot.state.status !== "suspended") throw new Error("Not suspended.");
      const requests = new Map(openRequests(snapshot).map((request) => [request.id, request]));
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        for (const [id, evidence] of Object.entries(continuation.answers)) {
          decision(evidence);
          const request = requests.get(id);
          if (
            !request ||
            request.scope.actorId !== context.owner ||
            request.scope.resource.id !== resource ||
            request.scope.expiresAt <= Date.now()
          )
            throw new Error("Request scope expired or changed.");
          // Claim the entire submitted batch atomically, including the resource version check.
          const { rowCount } = await connection.query(
            `INSERT INTO ${schema}.claims AS claimed (operation, continuation, source, owner, decision, segment)
            SELECT $1,$2,$3,$4,$5::json,$8 FROM ${schema}.resources WHERE id=$6 AND owner=$4 AND version=$7
            ON CONFLICT (operation) DO UPDATE SET continuation=EXCLUDED.continuation
            WHERE claimed.continuation=EXCLUDED.continuation AND claimed.source=EXCLUDED.source
              AND claimed.owner=EXCLUDED.owner AND claimed.segment=EXCLUDED.segment
              AND claimed.decision::text=EXCLUDED.decision::text`,
            [
              id,
              continuation.id,
              continuation.sourceId,
              context.owner,
              JSON.stringify(evidence),
              resource,
              request.scope.resource.version,
              context.segmentId,
            ],
          );
          if (rowCount !== 1) throw new Error("The decision is stale or was already claimed.");
        }
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
    async resolveRequest(approval, raw) {
      decision(raw);
      await access(context, approval.scope.resource.version);
      if (approval.scope.expiresAt <= Date.now()) throw new Error("Approval expired.");
      const { rowCount } = await pool.query(
        `UPDATE ${schema}.claims SET consumed=true
        WHERE operation=$1 AND continuation=$2 AND owner=$3 AND segment=$4 AND decision::text=$5`,
        [
          approval.id,
          context.continuation?.id,
          context.owner,
          context.segmentId,
          JSON.stringify(raw),
        ],
      );
      if (rowCount !== 1) throw new Error("This segment has no matching decision claim.");
      return { type: "approve" };
    },
    async beforeTool(_request, approval) {
      await access(context, approval?.request.scope.resource.version);
      if (
        approval &&
        (approval.request.scope.actorId !== context.owner ||
          approval.request.scope.expiresAt <= Date.now())
      )
        throw new Error("Approval access expired.");
    },
  });
  return { policy, evidence, resource, expiresAt };
}

async function submittedAnswers(
  background: { read(owner: string, id: string): Promise<{ snapshot: RunSnapshot }> },
  id: string,
  evidence: unknown,
) {
  return evidenceFor((await background.read("alice", id)).snapshot, evidence);
}

function approvalAgent() {
  let effects = 0;
  const wire = fake((count) => (count === 0 ? call("write") : answer("approved result")));
  const tool = defineTool({
    name: "write",
    description: "Write a synthetic result.",
    inputSchema: { type: "object" },
    needsApproval: true,
    async run() {
      effects++;
      return "written";
    },
  });
  return {
    agent: defineAgent({ ...base, provider: wire.provider, tools: [tool] }),
    effects: () => effects,
    calls: wire.calls,
  };
}

function parent(id: string, child: Agent<string>) {
  const wire = fake((count) =>
    count === 0
      ? {
          ...call("specialist"),
          toolCalls: [{ index: 0, id: "c", name: "specialist", arguments: '{"input":"Write"}' }],
        }
      : answer(`${id} done`),
  );
  return {
    agent: defineAgent({
      ...base,
      id,
      provider: wire.provider,
      tools: [child.asTool({ name: "specialist", description: "Call specialist." })],
      treeLimits: { maxParallel: 1 },
    }),
    calls: wire.calls,
  };
}

async function pauseUntilStopped(signal: AbortSignal): Promise<never> {
  if (!signal.aborted)
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  throw signal.reason;
}

const workers = new Set<ChildProcess>();
function worker(
  task: string,
  id: string,
  mode: "checkpoint" | "effect" | "model" | "recover",
  profile: "off" | "inference" | "read" | "hosted" = "off",
) {
  const child = spawn(
    "bun",
    [
      fileURLToPath(new URL("./fixtures/runs-worker.ts", import.meta.url)),
      schema,
      task,
      id,
      mode,
      profile,
    ],
    {
      env: { ...process.env, AGENTS_TEST_DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  workers.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, done, stdout: () => stdout, stderr: () => stderr };
}
async function counts(task: string) {
  const { rows } = await pool.query<{ kind: string; count: number }>(
    `SELECT kind, count(*)::int AS count FROM ${schema}.invocations WHERE task=$1 GROUP BY kind`,
    [task],
  );
  return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
}

describe("background binding on local Postgres", () => {
  it("refuses remote database URLs and URL overrides", () => {
    expect(() => localDatabase("postgresql://postgres@example.com/providerkit_agents")).toThrow(
      /loopback/,
    );
    expect(() => localDatabase(`${url}?host=example.com`)).toThrow(/loopback/);
  });

  it("persists before enqueue, filters owners and restores typed output without model calls", async () => {
    const wire = fake(() => ({
      ...call("submit_result"),
      toolCalls: [
        { index: 0, id: "result", name: "submit_result", arguments: '{"date":"2026-01-01"}' },
      ],
    }));
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      output: {
        schema: { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
        validate(raw) {
          if (!isRecord(raw) || typeof raw.date !== "string") throw new Error("Need a date.");
          return new Date(raw.date);
        },
      },
    });
    const background = createBackgroundAgent({
      agent,
      kind: "typed",
      runs,
      policy: closedPolicy,
      enqueue: async (id) => {
        const saved = await runs.read(id, "alice");
        expect(saved).toMatchObject({
          status: "queued",
          checkpoint: null,
          input: {
            format: 1,
            snapshot: { format: 3, agentId: "test", version: "1", state: { status: "running" } },
          },
        });
        await enqueue(id);
      },
    });
    const { id } = await background.start("alice", "Return a date");
    expect(queue).toContain(id);
    await expect(background.read("bob", id)).rejects.toThrow(/not found/);
    await expect(background.cancel("bob", id)).rejects.toThrow(/not found/);
    await expect(background.resume("bob", id, {})).rejects.toThrow(/not found/);
    await expect(background.observe("bob", id).next()).rejects.toThrow(/not found/);
    await expect(background.wait("bob", id)).rejects.toThrow(/not found/);
    const wrongKind = bind(agent, closedPolicy, "other");
    await expect(wrongKind.cancel("alice", id)).rejects.toThrow(/not found/);
    const wrongVersion = bind(
      defineAgent({ ...base, version: "2", provider: wire.provider }),
      closedPolicy,
      "typed",
    );
    await expect(wrongVersion.read("alice", id)).rejects.toThrow();
    expect(await runs.drive(id, background.handlers)).toBe("succeeded");
    const restored = await background.wait("alice", id);
    expect(restored.status).toBe("succeeded");
    expect(restored.outcome).toMatchObject({ status: "completed", output: new Date("2026-01-01") });
    expect((await background.read("alice", id)).outcome).toEqual(restored.outcome);
    expect(wire.calls()).toBe(1);
    expect(await runs.drive(id, background.handlers)).toBe("skipped");
  });

  it.each(["before preparation", "after preparation"] as const)(
    "does not save or enqueue a start cancelled %s",
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error("Creation cancelled");
      const create = vi.fn(runs.create);
      const enqueue = vi.fn(async (_id: string) => {});
      const wire = fake(() => answer("must not run"));
      const instructions = vi.fn(() => {
        controller.abort(reason);
        return base.instructions;
      });
      const background = createBackgroundAgent({
        agent: defineAgent({
          ...base,
          instructions: stage === "before preparation" ? base.instructions : instructions,
          provider: wire.provider,
        }),
        kind: "cancelled-start",
        runs: { ...runs, create },
        enqueue,
        policy: closedPolicy,
      });
      if (stage === "before preparation") controller.abort(reason);
      await expect(background.start("alice", "Work", { signal: controller.signal })).rejects.toBe(
        reason,
      );
      expect(create).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(wire.calls()).toBe(0);
      expect(instructions).toHaveBeenCalledTimes(stage === "before preparation" ? 0 : 1);
    },
  );

  it("returns and queues the saved id when creation is cancelled after the row exists", async () => {
    const controller = new AbortController();
    const wire = fake(() => answer("done"));
    const enqueue = vi.fn(async (_id: string) => {});
    const background = createBackgroundAgent({
      agent: defineAgent({ ...base, provider: wire.provider }),
      kind: "saved-before-cancellation",
      runs: {
        ...runs,
        async create(spec) {
          const saved = await runs.create(spec);
          controller.abort(new Error("Request disconnected after save"));
          return saved;
        },
      },
      enqueue,
      policy: closedPolicy,
    });
    const { id } = await background.start("alice", "Work", { signal: controller.signal });
    expect(controller.signal.aborted).toBe(true);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(id);
    expect((await background.read("alice", id)).status).toBe("queued");
    expect(await runs.drive(id, background.handlers)).toBe("succeeded");
    expect((await background.read("alice", id)).outcome?.status).toBe("completed");
  });

  it("keeps media-loader credentials out of saved failures and state events", async () => {
    const credential = "Bearer synthetic-private-upload-key";
    const wire = fake(() => answer("must not run"));
    const background = bind(
      defineAgent({ ...base, provider: wire.provider }),
      (context) => ({
        ...closedPolicy(context),
        loadMedia() {
          // Header validation errors can quote the credential before any request is sent.
          throw new TypeError(`Invalid Authorization header: ${credential}`);
        },
      }),
      "media-loader-failure",
    );
    const { id } = await background.start("alice", [
      { type: "media", id: "photo", mimeType: "image/png" },
    ]);
    expect(await runs.drive(id, background.handlers)).toBe("succeeded");
    const result = await background.read("alice", id);
    expect(result.outcome).toMatchObject({
      status: "failed",
      error: {
        code: "media_unavailable",
        message: "The media could not be loaded. Check file access before trying again.",
      },
    });
    const row = await runs.read(id, "alice");
    expect(row?.checkpoint).toMatchObject({ state: { status: "failed" } });
    expect(JSON.stringify(row)).not.toContain(credential);
    const events = [];
    for await (const event of background.observe("alice", id)) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent", data: expect.objectContaining({ type: "state" }) }),
    );
    expect(JSON.stringify(events)).not.toContain(credential);
    expect(wire.calls()).toBe(0);
    expect(result.snapshot.models).toEqual([]);
  });

  it("starts in a session inside the request and appends the turn from the worker", async () => {
    const png = "iVBORw0KGgoAAAAN";
    const before: AgentMessage[] = [
      { role: "user", content: "My name is Ana." },
      { role: "assistant", content: "Hello, Ana." },
    ];
    const thread = createMemorySession({ id: "thread-1", messages: before });
    const asked: string[] = [];
    function session(owner: string, id: string): Session {
      asked.push(`${owner}:${id}`);
      if (owner !== "alice" || id !== thread.id) throw new Error("This conversation is not yours.");
      return thread;
    }
    const requests: ChatMessage[][] = [];
    const agent = defineAgent({
      ...base,
      provider: {
        id: "fake",
        model: "fake",
        async *createStream(history) {
          requests.push(structuredClone(history));
          yield answer("A photo of Ana.");
        },
      },
    });
    const background = createBackgroundAgent({
      agent,
      kind: "session",
      runs,
      enqueue,
      session,
      policy: (context) => ({
        ...closedPolicy(context),
        async loadMedia(ref) {
          if (context.owner !== "alice" || ref.id !== "photo") throw new Error("No such photo.");
          return png;
        },
      }),
    });
    const turn: InputPart[] = [
      { type: "text", text: "Who is in this photo?" },
      { type: "media", id: "photo", mimeType: "image/png" },
    ];
    await expect(background.start("bob", turn, { sessionId: "thread-1" })).rejects.toThrow(
      /not yours/,
    );
    const { id } = await background.start("alice", turn, { sessionId: "thread-1" });
    expect((await runs.read(id, "alice"))?.input).toMatchObject({
      snapshot: { history: before, input: turn, session: { id: "thread-1", revision: "1" } },
    });
    expect(await runs.drive(id, background.handlers)).toBe("succeeded");
    expect(requests[0]?.slice(1)).toEqual([
      ...before,
      {
        role: "user",
        content: [turn[0], { type: "image", mimeType: "image/png", data: png }],
      },
    ]);
    const saved = await background.read("alice", id);
    expect(saved.outcome).toMatchObject({
      status: "completed",
      session: { id: "thread-1", status: "saved", revision: "2" },
    });
    expect((await thread.load({ signal: new AbortController().signal })).messages).toEqual([
      ...before,
      ...(saved.outcome?.newMessages ?? []),
    ]);
    // The worker asked again with the stored owner, never the request's.
    expect(asked).toEqual(["bob:thread-1", "alice:thread-1", "alice:thread-1"]);
    expect(JSON.stringify(await runs.read(id, "alice"))).not.toContain(png);
    await expect(bind(agent).start("alice", "Hi", { sessionId: "thread-1" })).rejects.toThrow(
      /session factory/,
    );
  });

  it("freezes the definition in start with request context and per-run settings", async () => {
    const instructions = vi.fn((run: RunContext) => `Reply in ${run.context.locale}.`);
    const enabledTools = vi.fn(() => ["read"]);
    const requests: ChatMessage[][] = [];
    const agent = defineAgent({
      ...base,
      instructions,
      enabledTools,
      modelSettings: { maxTokens: 100 },
      tools: [
        defineTool({
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          run: async () => "read",
        }),
      ],
      provider: {
        id: "definition",
        model: "fake",
        async *createStream(history, tools, options) {
          requests.push(structuredClone(history));
          expect(options?.maxTokens).toBe(27);
          expect(tools.map((tool) => tool.name)).toEqual(["read"]);
          yield answer("done");
        },
      },
    });
    const background = bind(
      agent,
      (context) => ({ ...closedPolicy(context), context: { locale: "es" } }),
      "definition",
    );
    const transientSettings = { maxTokens: 50, onActivity: () => {} };
    await expect(
      background.start("alice", "Answer", { modelSettings: transientSettings }),
    ).rejects.toThrow("cannot keep observers");
    const { id } = await background.start("alice", "Answer", {
      context: { locale: "en", db: pool },
      modelSettings: { maxTokens: 27 },
      enabledTools: ["read"],
    });
    expect((await background.read("alice", id)).snapshot.definition).toMatchObject({
      instructions: "Reply in en.",
      modelSettings: { maxTokens: 27 },
      enabledTools: ["read"],
    });
    expect(instructions).toHaveBeenCalledOnce();
    expect(enabledTools).toHaveBeenCalledOnce();
    expect(await runs.drive(id, background.handlers)).toBe("succeeded");
    expect((await background.read("alice", id)).outcome?.status).toBe("completed");
    expect(requests[0]?.[0]).toEqual({ role: "system", content: "Reply in en." });
    expect(instructions).toHaveBeenCalledOnce();
    expect(enabledTools).toHaveBeenCalledOnce();
    expect(JSON.stringify(await runs.read(id, "alice"))).not.toContain('"db"');
  });

  it.each(["instructions", "modelSettings", "enabledTools"] as const)(
    "refuses a checkpoint whose resolved %s differ from its saved input",
    async (field) => {
      const wire = fake(() => answer("must not run"));
      const background = bind(
        defineAgent({
          ...base,
          provider: wire.provider,
          tools: [
            defineTool({
              name: "read",
              description: "Read",
              inputSchema: { type: "object" },
              run: async () => "read",
            }),
          ],
        }),
        closedPolicy,
        `changed-${field}`,
      );
      const { id } = await background.start("alice", "Answer");
      const changed = (await background.read("alice", id)).snapshot;
      if (field === "instructions") changed.definition.instructions = "Different text.";
      else if (field === "modelSettings") changed.definition.modelSettings.maxTokens = 5;
      else changed.definition.enabledTools = [];
      await pool.query(`UPDATE ${schema}.runs SET checkpoint=$2::json WHERE id=$1`, [
        id,
        JSON.stringify(changed),
      ]);
      await expect(background.read("alice", id)).rejects.toThrow("another logical run");
      expect(await runs.drive(id, background.handlers)).toBe("failed");
      expect(wire.calls()).toBe(0);
    },
  );

  it("reports the saved id when enqueue fails and lets the sweep recover it", async () => {
    const wire = fake(() => answer("done"));
    const background = createBackgroundAgent({
      agent: defineAgent({ ...base, provider: wire.provider }),
      kind: "queue-failure",
      runs,
      policy: closedPolicy,
      enqueue: async () => {
        throw new Error("Queue offline");
      },
    });
    let failure: unknown;
    try {
      await background.start("alice", "Work");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BackgroundEnqueueError);
    if (!(failure instanceof BackgroundEnqueueError)) throw new Error("Missing saved id.");
    expect((await background.read("alice", failure.id)).status).toBe("queued");
    const nudged: string[] = [];
    await runs.sweep({ olderThanSecs: 0, nudge: (id) => nudged.push(id) });
    expect(nudged).toContain(failure.id);
    expect(await runs.drive(failure.id, background.handlers)).toBe("succeeded");
    expect(wire.calls()).toBe(1);
  });

  it("does not reserve an approval if creating its host row fails", async () => {
    const authority = await approvalFixture();
    const synthetic = approvalAgent();
    const background = bind(synthetic.agent, authority.policy);
    const original = await background.start("alice", "Write");
    await runs.drive(original.id, background.handlers);
    const failing = createBackgroundAgent({
      agent: synthetic.agent,
      kind: "test",
      policy: authority.policy,
      enqueue,
      runs: {
        ...runs,
        async create() {
          throw new Error("Create unavailable");
        },
      },
    });
    await expect(
      failing.resume(
        "alice",
        original.id,
        await submittedAnswers(failing, original.id, authority.evidence),
      ),
    ).rejects.toThrow("Create unavailable");
    const claimed = await pool.query(`SELECT * FROM ${schema}.claims WHERE source=$1`, [
      original.id,
    ]);
    expect(claimed.rows).toEqual([]);
    const next = await background.resume(
      "alice",
      original.id,
      await submittedAnswers(background, original.id, authority.evidence),
    );
    expect(await runs.drive(next.id, background.handlers)).toBe("succeeded");
    expect((await background.read("alice", next.id)).outcome?.status).toBe("completed");
    expect(synthetic.effects()).toBe(1);
  });

  it.each(["create-reply", "enqueue"] as const)(
    "recovers a saved continuation after losing the %s without stranding its approval",
    async (failure) => {
      const authority = await approvalFixture();
      const synthetic = approvalAgent();
      const background = bind(synthetic.agent, authority.policy);
      const original = await background.start("alice", "Write");
      await runs.drive(original.id, background.handlers);
      let savedId: string | undefined;
      const failing = createBackgroundAgent({
        agent: synthetic.agent,
        kind: "test",
        policy: authority.policy,
        runs: {
          ...runs,
          async create(spec) {
            const created = await runs.create(spec);
            savedId = created.id;
            if (failure === "create-reply") throw new Error("Create reply lost");
            return created;
          },
        },
        async enqueue() {
          throw new Error("Queue unavailable");
        },
      });
      const submitted = failing.resume(
        "alice",
        original.id,
        await submittedAnswers(failing, original.id, authority.evidence),
      );
      if (failure === "create-reply") await expect(submitted).rejects.toThrow("Create reply lost");
      else await expect(submitted).rejects.toBeInstanceOf(BackgroundEnqueueError);
      if (!savedId) throw new Error("Missing created row.");
      const claimed = await pool.query(`SELECT * FROM ${schema}.claims WHERE source=$1`, [
        original.id,
      ]);
      expect(claimed.rows).toEqual([]);
      const nudged: string[] = [];
      await runs.sweep({ olderThanSecs: 0, nudge: (id) => nudged.push(id) });
      expect(nudged).toContain(savedId);
      expect(await runs.drive(savedId, background.handlers)).toBe("succeeded");
      expect((await background.read("alice", savedId)).outcome?.status).toBe("completed");
      expect(synthetic.effects()).toBe(1);
      expect(synthetic.calls()).toBe(2);
    },
  );

  it("stops yielding buffered events when the observer disconnects", async () => {
    const wire = fake(() => answer("done"));
    const background = bind(defineAgent({ ...base, provider: wire.provider }));
    const { id } = await background.start("alice", "Work");
    await runs.drive(id, background.handlers);
    const controller = new AbortController();
    const events = background.observe("alice", id, 0, controller.signal);
    expect((await events.next()).done).toBe(false);
    controller.abort();
    expect((await events.next()).done).toBe(true);
    expect((await background.read("alice", id)).outcome?.status).toBe("completed");
  });

  it.each(["policy", "authorize"] as const)(
    "returns cancellation while %s is still pending",
    async (stage) => {
      const store = service();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const wire = fake(() => answer("must not run"));
      const background = createBackgroundAgent({
        agent: defineAgent({ ...base, provider: wire.provider }),
        kind: "pending-policy",
        runs: store,
        enqueue,
        async policy(context) {
          if (stage === "policy") {
            entered.resolve();
            await release.promise;
          }
          return {
            ...closedPolicy(context),
            async authorizeResume() {
              if (stage === "authorize") {
                entered.resolve();
                await release.promise;
              }
            },
          };
        },
      });
      const { id } = await background.start("alice", "Wait for policy");
      let outcome: string | undefined;
      const driving = store.drive(id, background.handlers).then((value) => (outcome = value));
      try {
        await entered.promise;
        await background.cancel("alice", id);
        await vi.waitFor(() => expect(outcome).toBe("cancelled"));
        expect(wire.calls()).toBe(0);
      } finally {
        release.resolve();
        await driving;
      }
      expect(wire.calls()).toBe(0);
    },
  );

  it("passes worker-only tool context through specialists without persisting it", async () => {
    const contexts: unknown[] = [];
    let active = 0;
    let peak = 0;
    const effect = defineTool({
      name: "effect",
      description: "Read runtime context.",
      inputSchema: { type: "object" },
      isConcurrencySafe: false,
      async run(_input, context) {
        contexts.push(context);
        peak = Math.max(peak, ++active);
        await pool.query("SELECT 1");
        active--;
        return "read";
      },
    });
    const leaf = defineAgent({
      ...base,
      provider: {
        id: "context",
        model: "fake",
        async *createStream(history) {
          yield history.at(-1)?.role === "tool" ? answer("child result") : call("effect");
        },
      },
      tools: [effect],
    });
    const coordinate = defineDelegation({
      name: "coordinate",
      description: "Start two specialists.",
      inputSchema: { type: "object" },
      validate: () => null,
      specialists: [leaf],
      async run(_input, context) {
        return context.join([
          context.child("one", leaf, "Read context"),
          context.child("two", leaf, "Read context"),
        ]);
      },
      summarize: () => "Both specialists finished.",
    });
    const root = defineAgent({
      ...base,
      id: "context-root",
      provider: fake((count) => (count === 0 ? call("coordinate") : answer("done"))).provider,
      tools: [coordinate],
      treeLimits: { maxParallel: 2 },
    });
    const actor = { id: "alice" };
    const toolContext = {
      db: pool,
      actor,
      runId: "not trusted",
      signal: new AbortController().signal,
    };
    const background = bind(root, (context) => ({
      ...closedPolicy(context),
      context: toolContext,
      canRunConcurrently: () => true,
    }));
    const { id } = await background.start("alice", "Use the host context");
    expect(await runs.drive(id, background.handlers)).toBe("succeeded");
    const result = await background.read("alice", id);
    expect(result).toMatchObject({ outcome: { status: "completed" } });
    const childIds = result.snapshot.delegations[0]?.children.map((child) => child.snapshot.runId);
    expect(contexts).toHaveLength(2);
    expect(peak).toBe(1);
    for (const context of contexts) {
      if (!isRecord(context)) throw new Error("Missing tool context");
      expect(childIds).toContain(context.runId);
      expect(context.db).toBe(pool);
      expect(context.actor).toBe(actor);
      expect(context.signal).not.toBe(toolContext.signal);
      expect(context.operationId).toBeTypeOf("string");
    }
    expect(JSON.stringify(await runs.read(id, "alice"))).not.toContain('"db"');
  });

  it("does not cancel work when an observer disconnects; explicit cancellation stops the tree", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const provider: Provider = {
      id: "wait",
      model: "fake",
      async *createStream(_history, _tools, options) {
        signal = options?.signal;
        started.resolve();
        await release.promise;
        yield answer("finished");
      },
    };
    const background = bind(defineAgent({ ...base, provider }));
    const { id } = await background.start("alice", "Wait");
    const driving = runs.drive(id, background.handlers);
    await started.promise;
    const observer = new AbortController();
    const watching = background.observe("alice", id, 0, observer.signal);
    const next = watching.next();
    observer.abort();
    expect((await next).done).toBe(true);
    await expect(background.wait("alice", id, observer.signal)).rejects.toThrow();
    expect(signal?.aborted).toBe(false);
    expect((await background.read("alice", id)).status).toBe("running");
    release.resolve();
    expect(await driving).toBe("succeeded");

    const childStarted = Promise.withResolvers<void>();
    let childSignal: AbortSignal | undefined;
    const child = defineAgent({
      ...base,
      id: "cancel-child",
      provider: {
        id: "child",
        model: "fake",
        async *createStream(_h, _t, options) {
          childSignal = options?.signal;
          childStarted.resolve();
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield answer("too late");
        },
      },
    });
    const root = bind(
      defineAgent({
        ...base,
        provider: fake(() => ({
          ...call("child"),
          toolCalls: [{ index: 0, id: "c", name: "child", arguments: '{"input":"Wait"}' }],
        })).provider,
        tools: [child.asTool({ name: "child", description: "Start child." })],
      }),
    );
    const cancelling = await root.start("alice", "Wait with child");
    const active = runs.drive(cancelling.id, root.handlers);
    await childStarted.promise;
    expect(await root.cancel("alice", cancelling.id)).toBe(true);
    expect(await active).toBe("cancelled");
    expect(childSignal?.aborted).toBe(true);
    const rows = await pool.query<{ status: string }>(
      `SELECT status FROM ${schema}.runs WHERE root_id=$1`,
      [cancelling.id],
    );
    expect(rows.rows).toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
    expect((await root.read("alice", cancelling.id)).status).toBe("cancelled");
  });

  it("returns shutdown and lost-lease control to the host instead of successful SDK cancellation", async () => {
    const store = service();
    const ready = Promise.withResolvers<void>();
    const provider: Provider = {
      id: "wait",
      model: "fake",
      async *createStream(_h, _t, options) {
        ready.resolve();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield answer("late");
      },
    };
    const background = createBackgroundAgent({
      agent: defineAgent({ ...base, provider }),
      kind: "drain",
      runs: store,
      enqueue,
      policy: closedPolicy,
    });
    const { id } = await background.start("alice", "Wait for shutdown");
    const driving = store.drive(id, background.handlers);
    await ready.promise;
    await store.drain(0);
    expect(await driving).toBe("requeued");
    expect((await background.read("alice", id)).status).toBe("queued");
    expect(await runs.drive(id, background.handlers)).toBe("succeeded");
    expect((await background.read("alice", id)).outcome).toMatchObject({
      status: "failed",
      error: { code: "interrupted_operation" },
    });

    const lostStore = service();
    const waiting = Promise.withResolvers<void>();
    const slow = defineAgent({
      ...base,
      provider: {
        ...provider,
        async *createStream(_h, _t, options) {
          waiting.resolve();
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield answer("late");
        },
      },
    });
    const lost = createBackgroundAgent({
      agent: slow,
      kind: "lost",
      runs: lostStore,
      enqueue,
      policy: closedPolicy,
    });
    const next = await lost.start("alice", "Lose lease");
    const losing = lostStore.drive(next.id, lost.handlers);
    await waiting.promise;
    // Test-only fault injection: fence the owned worker exactly as a replacement lease does.
    await pool.query(`UPDATE ${schema}.runs SET lease_token=$2 WHERE id=$1`, [
      next.id,
      crypto.randomUUID(),
    ]);
    expect(await losing).toBe("lost");
    expect((await lost.read("alice", next.id)).status).toBe("running");
    await lost.cancel("alice", next.id);
  });

  it("claims approval continuations once, including concurrent requests, with a new host id", async () => {
    const authority = await approvalFixture();
    const synthetic = approvalAgent();
    const background = bind(synthetic.agent, authority.policy);
    const original = await background.start("alice", "Write");
    expect(await runs.drive(original.id, background.handlers)).toBe("succeeded");
    const suspended = await background.read("alice", original.id);
    expect(suspended.outcome?.status).toBe("suspended");
    expect(synthetic.effects()).toBe(0);
    const unauthorized = await background.resume(
      "alice",
      original.id,
      evidenceFor(suspended.snapshot, {
        ...authority.evidence,
        actor: "bob",
      }),
    );
    expect(await runs.drive(unauthorized.id, background.handlers)).toBe("failed");
    expect((await background.read("alice", unauthorized.id)).error?.message).toMatch(
      /authentication/,
    );
    const attempts = await Promise.all([
      background.resume(
        "alice",
        original.id,
        await submittedAnswers(background, original.id, authority.evidence),
      ),
      background.resume(
        "alice",
        original.id,
        await submittedAnswers(background, original.id, authority.evidence),
      ),
    ]);
    expect(synthetic.calls()).toBe(1);
    expect(synthetic.effects()).toBe(0);
    const outcomes = await Promise.all(
      attempts.map(({ id }) => runs.drive(id, background.handlers)),
    );
    expect(outcomes.toSorted()).toEqual(["failed", "succeeded"]);
    const next = attempts[outcomes.indexOf("succeeded")];
    if (!next) throw new Error("No continuation accepted.");
    expect(next.id).not.toBe(original.id);
    const completed = await background.wait("alice", next.id);
    expect(completed.outcome).toMatchObject({
      status: "completed",
      output: "approved result",
      runId: suspended.snapshot.runId,
    });
    expect(completed.snapshot.models[0]?.id).toBe(suspended.snapshot.models[0]?.id);
    expect(completed.outcome?.treeUsage).toMatchObject({ inputTokens: 6, outputTokens: 4 });
    expect(synthetic.effects()).toBe(1);
    expect(synthetic.calls()).toBe(2);
    const duplicateClaim = await background.resume(
      "alice",
      original.id,
      await submittedAnswers(background, original.id, authority.evidence),
    );
    expect(await runs.drive(duplicateClaim.id, background.handlers)).toBe("failed");
    expect((await background.read("alice", duplicateClaim.id)).error?.message).toMatch(
      /already claimed/,
    );
    // Even replaying trusted stored input into another physical row cannot reuse this approval.
    const saved = await runs.read(next.id, "alice");
    const duplicate = await runs.create({
      kind: "test",
      owner: "alice",
      input: saved?.input,
      restart: "resume",
    });
    expect(await runs.drive(duplicate.id, background.handlers)).toBe("failed");
    expect(synthetic.effects()).toBe(1);
    expect(synthetic.calls()).toBe(2);
  });

  it("recovers a partially consumed answer batch under the same lease claim", async () => {
    const authority = await approvalFixture();
    const effects: string[] = [];
    const wire = fake((count) =>
      count === 0
        ? {
            ...call("write"),
            toolCalls: [0, 1, 2].map((index) => ({
              index,
              id: `call-${index}`,
              name: "write",
              arguments: "{}",
            })),
          }
        : answer("done"),
    );
    const agent = defineAgent({
      ...base,
      provider: wire.provider,
      tools: [
        defineTool({
          name: "write",
          description: "Write one record.",
          inputSchema: { type: "object" },
          needsApproval: true,
          async run(_input, context) {
            effects.push(context.callId ?? "missing");
            return "written";
          },
        }),
      ],
    });
    const thread = createMemorySession();
    const background = createBackgroundAgent({
      agent,
      kind: "batch",
      runs,
      enqueue,
      policy: authority.policy,
      session: () => thread,
    });
    const initial = await background.start("alice", "Write three records", {
      sessionId: thread.id,
    });
    expect(await runs.drive(initial.id, background.handlers)).toBe("succeeded");
    const waiting = await background.read("alice", initial.id);
    const requests = openRequests(waiting.snapshot);
    expect(requests).toHaveLength(3);
    expect(waiting.outcome?.session?.status).toBe("pending");
    const answers = Object.fromEntries(
      requests.slice(0, 2).map((request) => [request.id, authority.evidence]),
    );
    const next = await background.resume("alice", initial.id, answers);
    const store = service();
    const parked = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    let consumed = 0;
    const interrupted = createBackgroundAgent({
      agent,
      kind: "batch",
      runs: store,
      enqueue,
      session: () => thread,
      policy(context) {
        const trusted = authority.policy(context);
        return {
          ...trusted,
          async resolveRequest(request, evidence) {
            const decision = await trusted.resolveRequest(request, evidence);
            if (++consumed === 2) {
              parked.resolve();
              if (!signal) throw new Error("Missing worker signal");
              await pauseUntilStopped(signal);
            }
            return decision;
          },
        };
      },
    });
    const handler = interrupted.handlers.batch;
    if (!handler) throw new Error("Missing batch handler");
    const driving = store.drive(next.id, {
      batch(run) {
        signal = run.signal;
        return handler(run);
      },
    });
    try {
      await Promise.race([
        parked.promise,
        driving.then((status) => {
          throw new Error(`Worker ended before checkpoint: ${status}`);
        }),
      ]);
      await store.drain(0);
      expect(await driving).toBe("requeued");
      expect(effects).toEqual([]);
      expect(await runs.drive(next.id, background.handlers)).toBe("succeeded");
      const partial = await background.read("alice", next.id);
      expect(partial.outcome?.status).toBe("suspended");
      expect(partial.outcome?.session?.status).toBe("pending");
      expect(openRequests(partial.snapshot).map((request) => request.id)).toEqual([
        requests[2]?.id,
      ]);
      expect(effects).toEqual(["call-0", "call-1"]);
      expect(wire.calls()).toBe(1);
      const claimed = await pool.query(
        `SELECT * FROM ${schema}.claims WHERE continuation=(SELECT continuation FROM ${schema}.claims WHERE source=$1 LIMIT 1)`,
        [initial.id],
      );
      expect(claimed.rows).toHaveLength(2);
      const last = await background.resume(
        "alice",
        next.id,
        evidenceFor(partial.snapshot, authority.evidence),
      );
      expect(await runs.drive(last.id, background.handlers)).toBe("succeeded");
      const done = await background.read("alice", last.id);
      expect(done.outcome).toMatchObject({
        status: "completed",
        session: { status: "saved" },
        treeUsage: { inputTokens: 6, outputTokens: 4 },
      });
      expect(effects).toEqual(["call-0", "call-1", "call-2"]);
      expect(wire.calls()).toBe(2);
    } finally {
      await store.drain(0);
      await driving;
    }
  });

  it("rejects expired submissions and checks resource access again in the worker", async () => {
    const authority = await approvalFixture();
    const synthetic = approvalAgent();
    const background = bind(synthetic.agent, authority.policy);
    const { id } = await background.start("alice", "Write");
    await runs.drive(id, background.handlers);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(authority.expiresAt + 1);
      await expect(
        background.resume("alice", id, await submittedAnswers(background, id, authority.evidence)),
      ).rejects.toThrow(/expired/);
    } finally {
      vi.useRealTimers();
    }
    await pool.query(`UPDATE ${schema}.resources SET version='2' WHERE id=$1`, [
      authority.resource,
    ]);
    const stale = await background.resume(
      "alice",
      id,
      await submittedAnswers(background, id, authority.evidence),
    );
    expect(await runs.drive(stale.id, background.handlers)).toBe("failed");
    expect((await background.read("alice", stale.id)).error?.message).toMatch(/stale/);
    expect(synthetic.effects()).toBe(0);
    expect(synthetic.calls()).toBe(1);
    await pool.query(`UPDATE ${schema}.resources SET version='1' WHERE id=$1`, [
      authority.resource,
    ]);
    const next = await background.resume(
      "alice",
      id,
      await submittedAnswers(background, id, authority.evidence),
    );
    await pool.query(`UPDATE ${schema}.resources SET version='2' WHERE id=$1`, [
      authority.resource,
    ]);
    expect(await runs.drive(next.id, background.handlers)).toBe("failed");
    expect((await background.read("alice", next.id)).error?.message).toMatch(/stale/);
    expect(synthetic.effects()).toBe(0);
    expect(synthetic.calls()).toBe(1);
  });

  it("binds nested single-slot children to physical parents and resumes suspended children in new segments", async () => {
    const authority = await approvalFixture();
    const leaf = approvalAgent();
    const middle = parent("middle", leaf.agent);
    const root = parent("root", middle.agent);
    const background = bind(root.agent, authority.policy, "nested");
    const initial = await background.start("alice", "Delegate");
    expect(await runs.drive(initial.id, background.handlers)).toBe("succeeded");
    const saved = await background.read("alice", initial.id);
    expect(saved.outcome).toMatchObject({
      status: "suspended",
      requests: [{ path: [{ key: "result" }, { key: "result" }] }],
    });
    const next = await background.resume(
      "alice",
      initial.id,
      await submittedAnswers(background, initial.id, authority.evidence),
    );
    expect(await runs.drive(next.id, background.handlers)).toBe("succeeded");
    const result = await background.read("alice", next.id);
    expect(result.outcome).toMatchObject({
      status: "completed",
      output: "root done",
      treeUsage: { inputTokens: 18, outputTokens: 12 },
    });
    expect(leaf.effects()).toBe(1);
    expect([root.calls(), middle.calls(), leaf.calls()]).toEqual([2, 2, 2]);
    for (const id of [initial.id, next.id]) {
      const { rows } = await pool.query<{ id: string; parent_id: string | null; depth: number }>(
        `SELECT id, parent_id, depth FROM ${schema}.runs WHERE root_id=$1 ORDER BY depth`,
        [id],
      );
      expect(rows.map((row) => row.depth)).toEqual([0, 1, 2]);
      expect(rows[1]?.parent_id).toBe(rows[0]?.id);
      expect(rows[2]?.parent_id).toBe(rows[1]?.id);
    }
  });

  it.each(["claim", "route", "consumed", "running-effect", "effect", "later-approval"] as const)(
    "recovers a nested continuation at the %s checkpoint without replaying work",
    async (point) => {
      const authority = await approvalFixture();
      let effects = 0;
      const leafWire = fake((count) =>
        count < (point === "later-approval" ? 2 : 1) ? call("write") : answer("leaf done"),
      );
      const leaf = defineAgent({
        ...base,
        provider: leafWire.provider,
        tools: [
          defineTool({
            name: "write",
            description: "Record an approved effect.",
            inputSchema: { type: "object" },
            needsApproval: true,
            async run(_input, context) {
              effects++;
              if (point === "running-effect" && pause) {
                pause = false;
                parked.resolve();
                if (!context.signal) throw new Error("Missing tool signal.");
                await pauseUntilStopped(context.signal);
              }
              return "written";
            },
          }),
        ],
      });
      const middle = parent("recover-middle", leaf);
      const root = parent("recover-root", middle.agent);
      const background = bind(root.agent, authority.policy, "recover-approval");
      const initial = await background.start("alice", "Delegate");
      expect(await runs.drive(initial.id, background.handlers)).toBe("succeeded");
      const saved = await background.read("alice", initial.id);
      expect(saved).toMatchObject({ snapshot: { state: { status: "suspended" } } });
      if (saved.snapshot.state.status !== "suspended") throw new Error("Missing approval.");
      const originalApproval = firstRequest(saved.snapshot);
      const next = await background.resume(
        "alice",
        initial.id,
        await submittedAnswers(background, initial.id, authority.evidence),
      );
      const store = service();
      const parked = Promise.withResolvers<void>();
      let pause = true;
      let signal: AbortSignal | undefined;
      const interrupted = createBackgroundAgent({
        agent: root.agent,
        kind: "recover-approval",
        runs: store,
        enqueue,
        policy(context) {
          const trusted = authority.policy(context);
          return {
            ...trusted,
            async claimContinuation(snapshot, continuation) {
              await trusted.claimContinuation(snapshot, continuation);
              if (point === "claim" && pause) {
                pause = false;
                parked.resolve();
                if (!signal) throw new Error("Missing worker signal.");
                await pauseUntilStopped(signal);
              }
            },
            async resolveRequest(approval, decision) {
              const result = await trusted.resolveRequest(approval, decision);
              if (point === "consumed" && pause) {
                pause = false;
                parked.resolve();
                if (!signal) throw new Error("Missing worker signal.");
                await pauseUntilStopped(signal);
              }
              return result;
            },
          };
        },
      });
      const handler = interrupted.handlers["recover-approval"];
      if (!handler) throw new Error("Missing handler.");
      const driving = store.drive(next.id, {
        "recover-approval": (run) => {
          signal = run.signal;
          return handler({
            ...run,
            async save(value) {
              await run.save(value);
              const current = root.agent[AGENT_RUNTIME].restore(value);
              const mid = current.delegations[0]?.children[0]?.snapshot;
              const child = mid?.delegations[0]?.children[0]?.snapshot;
              if (
                !pause ||
                current.state.status !== "running" ||
                mid?.state.status !== "running" ||
                !child
              )
                return;
              const shouldPause =
                (point === "route" && child.state.status === "suspended") ||
                (point === "effect" &&
                  effects === 1 &&
                  child.models.at(-1)?.status === "completed") ||
                (point === "later-approval" &&
                  child.state.status === "suspended" &&
                  openRequests(child).some(
                    (request) => request.call.operationId !== originalApproval.call.operationId,
                  ));
              if (shouldPause) {
                pause = false;
                parked.resolve();
                await pauseUntilStopped(run.signal);
              }
            },
          });
        },
      });
      try {
        await Promise.race([
          parked.promise,
          driving.then((outcome) => {
            throw new Error(`Worker ended before checkpoint: ${outcome}`);
          }),
        ]);
        await store.drain(0);
        expect(await driving).toBe("requeued");
        const interruptedState = await background.read("alice", next.id);
        expect(interruptedState.snapshot.state.status).toBe(
          point === "claim" || point === "consumed" ? "suspended" : "running",
        );
        const claimed = await pool.query<{ segment: string; consumed: boolean }>(
          `SELECT segment, consumed FROM ${schema}.claims WHERE source=$1`,
          [initial.id],
        );
        expect(claimed.rows).toEqual([
          {
            segment: next.id,
            consumed: point !== "claim",
          },
        ]);
        expect(await runs.drive(next.id, background.handlers)).toBe("succeeded");
        let result = await background.read("alice", next.id);
        if (point === "running-effect") {
          expect(result.outcome).toMatchObject({
            status: "failed",
            error: { code: "interrupted_operation" },
          });
          expect(effects).toBe(1);
          expect([root.calls(), middle.calls(), leafWire.calls()]).toEqual([1, 1, 1]);
          return;
        }
        if (point === "later-approval") {
          expect(result.outcome?.status).toBe("suspended");
          expect(effects).toBe(1);
          expect(leafWire.calls()).toBe(2);
          if (result.snapshot.state.status !== "suspended")
            throw new Error("Missing new approval.");
          expect(firstRequest(result.snapshot).call.operationId).not.toBe(
            originalApproval.call.operationId,
          );
          const last = await background.resume(
            "alice",
            next.id,
            await submittedAnswers(background, next.id, authority.evidence),
          );
          expect(await runs.drive(last.id, background.handlers)).toBe("succeeded");
          result = await background.read("alice", last.id);
        }
        expect(result.outcome).toMatchObject({ status: "completed", output: "recover-root done" });
        const expectedEffects = point === "later-approval" ? 2 : 1;
        expect(effects).toBe(expectedEffects);
        expect([root.calls(), middle.calls(), leafWire.calls()]).toEqual([
          2,
          2,
          expectedEffects + 1,
        ]);
        expect(result.outcome?.treeUsage).toMatchObject({
          inputTokens: 3 * (expectedEffects + 5),
          outputTokens: 2 * (expectedEffects + 5),
        });
      } finally {
        await store.drain(0);
        await driving;
      }
    },
  );

  it("does not mistake a cached suspended host child for a resumed SDK child", async () => {
    const authority = await approvalFixture();
    const leaf = approvalAgent();
    const wire = fake((count) =>
      count === 0
        ? {
            ...call("child"),
            toolCalls: [{ index: 0, id: "c", name: "child", arguments: '{"input":"Write"}' }],
          }
        : answer("root finished"),
    );
    const agent = defineAgent({
      ...base,
      id: "cache-root",
      provider: wire.provider,
      tools: [leaf.agent.asTool({ name: "child", description: "Run child." })],
      treeLimits: { maxParallel: 1, maxChildren: 1 },
    });
    const store = service();
    const background = createBackgroundAgent({
      agent,
      kind: "cached",
      runs: store,
      enqueue,
      policy: authority.policy,
    });
    const { id } = await background.start("alice", "Write through child");
    const parked = Promise.withResolvers<void>();
    const handler = background.handlers.cached;
    if (!handler) throw new Error("Missing handler.");
    let stopped = false;
    const driving = store.drive(id, {
      cached: (run) =>
        handler({
          ...run,
          async save(value) {
            await run.save(value);
            const saved = agent[AGENT_RUNTIME].restore(value);
            const child = saved.delegations[0]?.children[0];
            if (
              !stopped &&
              saved.state.status === "running" &&
              child?.reference &&
              child.snapshot.state.status === "suspended"
            ) {
              stopped = true;
              parked.resolve();
              await new Promise<void>((resolve) =>
                run.signal.addEventListener("abort", () => resolve(), { once: true }),
              );
              run.signal.throwIfAborted();
            }
          },
        }),
    });
    await parked.promise;
    await store.drain(0);
    expect(await driving).toBe("requeued");
    // The root's previous checkpoint has the first child's successful host receipt,
    // but the SDK child is still suspended. Recovery must execute a new child segment.
    expect(await runs.drive(id, background.handlers)).toBe("succeeded");
    const pending = await background.read("alice", id);
    expect(pending.outcome?.status).toBe("suspended");
    expect(leaf.effects()).toBe(0);
    expect([wire.calls(), leaf.calls()]).toEqual([1, 1]);
    const children = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${schema}.runs WHERE parent_id=$1`,
      [id],
    );
    expect(children.rows[0]?.count).toBe(2);
    const next = await background.resume(
      "alice",
      id,
      await submittedAnswers(background, id, authority.evidence),
    );
    expect(await runs.drive(next.id, background.handlers)).toBe("succeeded");
    expect((await background.read("alice", next.id)).outcome).toMatchObject({
      status: "completed",
      output: "root finished",
    });
    expect(leaf.effects()).toBe(1);
    expect([wire.calls(), leaf.calls()]).toEqual([2, 2]);
  });

  it("recovers after SIGKILL at a safe checkpoint without repeating child calls, tools or usage", async () => {
    const task = crypto.randomUUID();
    const agent = recoveryAgent(pool, schema, task);
    const background = bind(agent, closedPolicy, "recovery");
    const { id } = await background.start("alice", "Recover child");
    const first = worker(task, id, "checkpoint");
    try {
      await vi.waitFor(() => expect(first.stdout(), first.stderr()).toContain("checkpoint\n"));
      expect(await counts(task)).toEqual({ root_model: 1, child_model: 2, tool: 1 });
      const before = await background.read("alice", id);
      const receipt = before.snapshot.delegations[0]?.children[0];
      expect(receipt?.snapshot.state.status).toBe("completed");
      expect(receipt?.reference).toBeTypeOf("string");
      expect(first.child.kill("SIGKILL")).toBe(true);
      expect(await first.done).toEqual({ code: null, signal: "SIGKILL" });
      const nudged: string[] = [];
      await vi.waitFor(async () => {
        await runs.sweep({ olderThanSecs: 0, nudge: (runId) => nudged.push(runId) });
        expect(nudged).toContain(id);
      });
      const replacement = worker(task, id, "recover");
      expect(await replacement.done, replacement.stderr()).toEqual({ code: 0, signal: null });
      expect(replacement.stdout()).toContain("succeeded");
      const result = await background.read("alice", id);
      expect(result.outcome).toMatchObject({
        status: "completed",
        output: "root result",
        treeUsage: { inputTokens: 12, outputTokens: 8 },
      });
      expect(result.snapshot.delegations[0]?.children[0]).toEqual(receipt);
      expect(await counts(task)).toEqual({ root_model: 2, child_model: 2, tool: 1 });
      const spent = await pool.query<{ cost: number }>(
        `SELECT sum(cost_usd)::float8 AS cost FROM ${schema}.runs WHERE root_id=$1`,
        [id],
      );
      expect(spent.rows[0]?.cost).toBe(0);
    } finally {
      if (first.child.exitCode === null && first.child.signalCode === null)
        first.child.kill("SIGKILL");
    }
  });

  it.each(["inference", "read", "hosted"] as const)(
    "recovers only the configured %s profile after real worker loss",
    async (profile) => {
      const task = crypto.randomUUID();
      const agent = recoveryAgent(pool, schema, task, undefined, profile);
      const background = bind(agent, closedPolicy, "recovery");
      const { id } = await background.start("alice", "Recover interrupted work");
      const mode = profile === "read" ? "effect" : "model";
      let kept: unknown;
      const attempts: string[] = [];
      for (let crash = 0; crash < (profile === "inference" ? 2 : 1); crash++) {
        const running = worker(task, id, mode, profile);
        try {
          await vi.waitFor(() => expect(running.stdout(), running.stderr()).toContain(`${mode}\n`));
          const before = await background.read("alice", id);
          const children = before.snapshot.delegations[0]?.children;
          const child = children?.find((entry) => entry.key === "one")?.snapshot;
          if (!child) throw new Error("Missing running child");
          const operation = child.models.at(-1);
          if (!operation) throw new Error("Missing operation");
          attempts.push(
            profile === "read" &&
              operation.status === "completed" &&
              operation.tools[0]?.status === "running"
              ? operation.tools[0].attemptId
              : operation.attemptId,
          );
          if (profile === "inference") {
            kept ??= children?.find((entry) => entry.key === "kept");
            expect(children?.find((entry) => entry.key === "kept")).toEqual(kept);
            expect(operation.usage.inputTokens).toBe(3);
          }
          // Attaching twice cannot buy another execution attempt or cancel the producer.
          const observed = new AbortController();
          const stream = background.observe("alice", id, 0, observed.signal);
          expect((await stream.next()).done).toBe(false);
          observed.abort();
          expect((await stream.next()).done).toBe(true);
          expect((await background.read("alice", id)).status).toBe("running");
          expect(running.child.kill("SIGKILL")).toBe(true);
          expect((await running.done).signal).toBe("SIGKILL");
          const nudged: string[] = [];
          await vi.waitFor(async () => {
            await runs.sweep({ olderThanSecs: 0, nudge: (runId) => nudged.push(runId) });
            expect(nudged).toContain(id);
          });
        } finally {
          if (running.child.exitCode === null && running.child.signalCode === null)
            running.child.kill("SIGKILL");
        }
      }
      const replacement = worker(task, id, "recover", profile);
      expect(await replacement.done, replacement.stderr()).toEqual({ code: 0, signal: null });
      const result = await background.read("alice", id);
      expect(result.outcome?.status).toBe(profile === "hosted" ? "failed" : "completed");
      const child = result.snapshot.delegations[0]?.children.find(
        (entry) => entry.key === "one",
      )?.snapshot;
      if (!child) throw new Error("Missing saved child");
      if (profile === "hosted") {
        expect(child.state).toMatchObject({
          status: "failed",
          error: { code: "interrupted_operation" },
        });
        expect(await counts(task)).toEqual({
          root_model: 1,
          child_model: 2,
          tool: 1,
          hosted_effect: 1,
        });
      } else if (profile === "inference") {
        expect(await counts(task)).toEqual({
          root_model: 2,
          kept_model: 1,
          child_model: 4,
          tool: 1,
        });
        expect(
          result.snapshot.delegations[0]?.children.find((entry) => entry.key === "kept"),
        ).toEqual(kept);
        expect(child.models[1]?.interrupted.map((attempt) => attempt.attemptId)).toEqual(attempts);
        expect(result.outcome?.treeUsage).toMatchObject({ inputTokens: 21, outputTokens: 14 });
      } else {
        expect(await counts(task)).toEqual({ root_model: 2, child_model: 2, tool: 2 });
        const model = child.models[0];
        expect(
          model?.status === "completed"
            ? model.tools[0]?.interrupted.map((attempt) => attempt.attemptId)
            : [],
        ).toEqual(attempts);
        expect(result.outcome?.treeUsage).toMatchObject({ inputTokens: 12, outputTokens: 8 });
      }
      const events = [];
      for await (const event of background.observe("alice", id)) events.push(event);
      const restarts = events.filter(
        (event) =>
          event.type === "agent" && isRecord(event.data) && event.data.type === "operation_restart",
      );
      // A killed process may lose best-effort events. The surviving attempt's marker must
      // arrive, but this test does not promise durable progress from killed attempts.
      expect(restarts.length).toBeLessThanOrEqual(attempts.length);
      if (profile === "hosted") expect(restarts).toHaveLength(0);
      else expect(restarts.at(-1)?.data).toMatchObject({ previousAttemptId: attempts.at(-1) });
      const usageBeforeRead = result.outcome?.treeUsage;
      expect((await background.read("alice", id)).outcome?.treeUsage).toEqual(usageBeforeRead);
      expect(await runs.drive(id, background.handlers)).toBe("skipped");
    },
  );

  it("refuses an external effect interrupted by SIGKILL rather than invoking it again", async () => {
    const task = crypto.randomUUID();
    const background = bind(recoveryAgent(pool, schema, task), closedPolicy, "recovery");
    const { id } = await background.start("alice", "Interrupt effect");
    const first = worker(task, id, "effect");
    try {
      await vi.waitFor(() => expect(first.stdout(), first.stderr()).toContain("effect\n"));
      expect(await counts(task)).toEqual({ root_model: 1, child_model: 1, tool: 1 });
      first.child.kill("SIGKILL");
      expect((await first.done).signal).toBe("SIGKILL");
      const nudged: string[] = [];
      await vi.waitFor(async () => {
        await runs.sweep({ olderThanSecs: 0, nudge: (runId) => nudged.push(runId) });
        expect(nudged).toContain(id);
      });
      const replacement = worker(task, id, "recover");
      expect(await replacement.done, replacement.stderr()).toEqual({ code: 0, signal: null });
      const saved = await background.read("alice", id);
      expect(saved.snapshot.delegations[0]?.children[0]?.snapshot.state).toMatchObject({
        status: "failed",
        error: { code: "interrupted_operation" },
      });
      expect(saved.outcome?.status).toBe("failed");
      expect(await counts(task)).toEqual({ root_model: 1, child_model: 1, tool: 1 });
      expect(saved.outcome?.treeUsage).toMatchObject({ inputTokens: 6, outputTokens: 4 });
    } finally {
      if (first.child.exitCode === null && first.child.signalCode === null)
        first.child.kill("SIGKILL");
    }
  });
});
