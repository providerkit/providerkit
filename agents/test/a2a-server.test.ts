import { afterEach, describe, expect, it, vi } from "vitest";
import { defineTool, type Provider } from "@providerkit/core";
import {
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  SendMessageRequest,
  SubscribeToTaskRequest,
  TaskState,
} from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory, RestTransportFactory } from "@a2a-js/sdk/client";
import { defineWorkflow } from "../src/workflow.ts";
import { defineAgent } from "../src/run.ts";
import { isRecord } from "../src/snapshot.ts";
import type { BackgroundContext, BackgroundPolicy } from "../src/background-types.ts";
import type { Workflow } from "../src/workflow-types.ts";
import { createA2AClient } from "../src/a2a/client.ts";
import { createMemoryRuns, type A2ARuns, type MemoryRunsOptions } from "../src/a2a/memory-runs.ts";
import { a2aPolicy, createA2AServer, type A2AServerBase } from "../src/a2a/server.ts";
import {
  a2aSegments,
  createMemoryTaskStore,
  type A2ATaskRecord,
  type A2ATaskScope,
} from "../src/a2a/tasks.ts";
import {
  A2AError,
  type A2ADialect,
  type A2AMessage,
  type A2ATask,
  type A2AVersion,
} from "../src/a2a/wire.ts";

const baseUrl = "https://agent.test/a2a/";
const alice = { owner: "team", actorId: "alice" };
const input = {
  schema: { type: "object" as const },
  validate(value: unknown) {
    if (typeof value !== "string") throw new Error("Pass text");
    return value;
  },
};
const plain = () =>
  defineWorkflow({
    id: "echo",
    version: "1",
    input,
    run: (text, ctx) => ctx.step("echo", () => text),
  });
const message = (id: string = crypto.randomUUID(), text = "Hello"): A2AMessage => ({
  kind: "message",
  role: "user",
  messageId: id,
  parts: [{ kind: "text", text }],
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.useRealTimers();
});

function fixture(
  workflow: Workflow<string, string> = plain(),
  settings: Partial<A2AServerBase<string>> = {},
  memory: Pick<MemoryRunsOptions, "onSegment"> = {},
) {
  const tasks = settings.tasks ?? createMemoryTaskStore();
  const scope: A2ATaskScope = { ...alice, ...(settings.tenant ? { tenant: settings.tenant } : {}) };
  let allowed = true;
  const claims = new Map<string, string>();
  const claim = vi.fn<BackgroundPolicy["claimContinuation"]>();
  const resolved = vi.fn<BackgroundPolicy["resolveRequest"]>();
  const check = () => {
    if (!allowed) throw new Error("Private host authorization failure");
  };
  function policy(context: BackgroundContext): BackgroundPolicy {
    const raw: BackgroundPolicy = {
      authorizeResume: check,
      beforeTool: check,
      beforeStep: check,
      prepareRequest: () => ({
        scope: {
          actorId: "alice",
          resource: { id: "fixture", version: "1" },
          expiresAt: Date.now() + 60_000,
        },
      }),
      async claimContinuation(snapshot, continuation) {
        check();
        await claim(snapshot, continuation);
        check();
        for (const id of continuation.kind === "cancel"
          ? [`cancel:${continuation.sourceId}`]
          : Object.keys(continuation.answers).length
            ? Object.keys(continuation.answers)
            : [`wake:${continuation.wakeAt}`]) {
          const identity = `${continuation.id}:${context.segmentId}`;
          if (claims.has(id) && claims.get(id) !== identity) throw new Error("Already claimed");
          claims.set(id, identity);
        }
      },
      resolveRequest(request, evidence) {
        check();
        resolved(request, evidence);
        if (!isRecord(evidence) || !isRecord(evidence.answer)) return { type: "pending" };
        if (
          evidence.answer.type === "answer" &&
          isRecord(evidence.answer.answer) &&
          typeof evidence.answer.answer.text === "string"
        )
          return { type: "answer", answer: { text: evidence.answer.answer.text } };
        if (evidence.answer.type === "approve") return { type: "approve" };
        if (evidence.answer.type === "stop") return { type: "stop" };
        return { type: "pending", problem: "Choose an answer." };
      },
    };
    return a2aPolicy(raw, {
      tasks,
      scope,
      context,
      remoteApprovals: settings.remoteApprovals,
      remoteClientTools: settings.remoteClientTools,
    });
  }
  const runs = createMemoryRuns({
    workflow,
    policy,
    onSegment: a2aSegments({ tasks, scope: () => scope }),
    ...memory,
  });
  const server = createA2AServer({
    runs,
    tasks,
    prepare: (m) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("\n"),
    card: { url: baseUrl, name: "Offline workflow", description: "Echoes one message." },
    authenticate: (request) => {
      if (!allowed) return null;
      const actor = request.headers.get("authorization");
      if (actor === "Bearer alice") return alice;
      if (actor === "Bearer bob") return { owner: "other-team", actorId: "bob" };
      if (actor === "Bearer eve") return { owner: "team", actorId: "eve" };
      return null;
    },
    projectOutput: (outcome) =>
      typeof outcome.output === "string" ? [{ kind: "text", text: outcome.output }] : [],
    ...settings,
  });
  cleanups.push(server.close);
  const fetchImpl: typeof fetch = (url, init) => server.fetch(new Request(url, init));
  const client = (actor = "alice", dialect: A2ADialect = { version: "1.0", binding: "JSONRPC" }) =>
    createA2AClient({
      endpoint: `${baseUrl}${dialect.binding === "JSONRPC" ? "jsonrpc" : "rest"}`,
      ...dialect,
      tenant: settings.tenant,
      headers: () => ({ authorization: `Bearer ${actor}` }),
      policy: { allow: () => true },
      fetch: fetchImpl,
    });
  return {
    tasks,
    runs,
    server,
    client,
    scope,
    fetchImpl,
    claim,
    resolved,
    policy,
    revoke: () => {
      allowed = false;
    },
  };
}
function task(value: A2ATask | A2AMessage): A2ATask {
  if (value.kind !== "task") throw new Error("Expected task");
  return value;
}
async function complete(client: ReturnType<ReturnType<typeof fixture>["client"]>, id: string) {
  let result = await client.call("GetTask", { id });
  await vi.waitFor(async () => {
    result = await client.call("GetTask", { id });
    expect(["submitted", "working", "unknown"]).not.toContain(result.status.state);
  });
  return result;
}
async function official(f: ReturnType<typeof fixture>, dialect: A2ADialect) {
  const card = AgentCard.fromJSON({
    name: "Fixture",
    description: "Offline",
    version: "1",
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    capabilities: { streaming: true },
    supportedInterfaces: [
      {
        url: `${baseUrl}${dialect.binding === "JSONRPC" ? "jsonrpc" : "rest"}`,
        protocolBinding: dialect.binding,
        protocolVersion: dialect.version,
      },
    ],
  });
  const fetchImpl: typeof fetch = (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", "Bearer alice");
    return f.fetchImpl(url, { ...init, headers });
  };
  return new ClientFactory({
    transports: [
      dialect.binding === "JSONRPC"
        ? new JsonRpcTransportFactory({ fetchImpl, legacyCompat: { enabled: true } })
        : new RestTransportFactory({ fetchImpl, legacyCompat: { enabled: true } }),
    ],
  }).createFromAgentCard(card);
}

describe("A2A serving with real portable runtimes", () => {
  it("fails closed and authenticates before reading a body", async () => {
    const f = fixture();
    expect(() =>
      createA2AServer({
        runs: f.runs,
        prepare: () => "",
        tasks: f.tasks,
        card: { url: baseUrl, name: "x", description: "x" },
      }),
    ).toThrow(/authenticate/);
    const request = new Request(`${baseUrl}jsonrpc`, {
      method: "POST",
      body: "not JSON",
      headers: { "content-type": "application/json" },
    });
    expect((await f.server.fetch(request)).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(
      (await f.server.fetch(new Request(`${baseUrl}.well-known/agent-card.json`))).status,
    ).toBe(401);
    const publicServer = fixture(undefined, { publicCard: true });
    expect(
      (await publicServer.server.fetch(new Request(`${baseUrl}.well-known/agent-card.json`)))
        .status,
    ).toBe(200);
    expect((await publicServer.server.fetch(new Request(`${baseUrl}rest/tasks`))).status).toBe(401);
  });

  it.each(["1.0", "0.3"] as A2AVersion[])(
    "serves official %s clients over both bindings",
    async (version) => {
      for (const binding of ["JSONRPC", "HTTP+JSON"] as const) {
        const f = fixture();
        const client = await official(f, { version, binding });
        const sent = await client.sendMessage(
          SendMessageRequest.fromJSON({
            message: {
              messageId: `${version}-${binding}`,
              role: "ROLE_USER",
              parts: [{ text: "Hello" }],
            },
          }),
        );
        if (!("id" in sent)) throw new Error("Expected SDK task");
        expect(sent.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
        expect(sent.artifacts[0]?.parts[0]?.content).toEqual({ $case: "text", value: "Hello" });
        expect(
          (await client.getTask(GetTaskRequest.fromJSON({ id: sent.id, historyLength: 1 }))).id,
        ).toBe(sent.id);
        await expect(
          client.getTask(GetTaskRequest.fromJSON({ id: "missing" })),
        ).rejects.toMatchObject({ reason: "TASK_NOT_FOUND" });
        const streamed = [];
        for await (const event of client.sendMessageStream(
          SendMessageRequest.fromJSON({
            message: {
              messageId: `stream-${version}-${binding}`,
              role: "ROLE_USER",
              parts: [{ text: "Streamed" }],
            },
          }),
        ))
          streamed.push(event);
        expect(streamed.length).toBeGreaterThan(0);
      }
    },
  );

  it("isolates tasks, history, contexts, streams, cancel and push by owner and actor", async () => {
    const f = fixture();
    const owned = task(await f.client().call("SendMessage", { message: message() }));
    for (const actor of ["bob", "eve"]) {
      const foreign = f.client(actor);
      await expect(foreign.call("GetTask", { id: owned.id })).rejects.toMatchObject({
        code: -32001,
      });
      await expect(foreign.call("CancelTask", { id: owned.id })).rejects.toMatchObject({
        code: -32001,
      });
      const refusedStream = await f.server.fetch(
        new Request(`${baseUrl}jsonrpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${actor}`,
            "A2A-Version": "1.0",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "read",
            method: "SubscribeToTask",
            params: { id: owned.id },
          }),
        }),
      );
      expect(await refusedStream.json()).toMatchObject({ error: { code: -32001 } });
      await expect(
        foreign.call("SendMessage", { message: { ...message(), taskId: owned.id } }),
      ).rejects.toMatchObject({ code: -32001 });
      await expect(
        foreign.call("GetTaskPushNotificationConfig", { taskId: owned.id, id: "p" }),
      ).rejects.toMatchObject({ code: -32001 });
      await expect(
        foreign.call("SendMessage", { message: { ...message(), contextId: owned.contextId } }),
      ).rejects.toMatchObject({ code: -32602 });
      expect((await foreign.call("ListTasks", {})).tasks).toEqual([]);
    }
    expect(
      (await f.client().call("GetTask", { id: owned.id, historyLength: 0 })).history,
    ).toBeUndefined();
  });

  it("groups a context without silently requesting a conversation session", async () => {
    const f = fixture();
    const start = vi.spyOn(f.runs, "start");
    const first = task(await f.client().call("SendMessage", { message: message() }));
    const second = task(
      await f
        .client()
        .call("SendMessage", { message: { ...message(), contextId: first.contextId } }),
    );
    expect(second.contextId).toBe(first.contextId);
    expect(second.id).not.toBe(first.id);
    for (const call of start.mock.calls) expect(call[2]).not.toHaveProperty("sessionId");
    await expect(
      f.runs.start("team", "text", { runId: "explicit-session", sessionId: "missing-store" }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("does not treat tenant identifiers as authority", async () => {
    const tasks = createMemoryTaskStore();
    const first = fixture(undefined, { tasks, tenant: "tenant-a" });
    const second = fixture(undefined, { tasks, tenant: "tenant-b" });
    const owned = task(await first.client().call("SendMessage", { message: message() }));
    await expect(second.client().call("GetTask", { id: owned.id })).rejects.toMatchObject({
      code: -32001,
    });
    await expect(
      second
        .client()
        .call("SendMessage", { message: { ...message(), contextId: owned.contextId } }),
    ).rejects.toMatchObject({ code: -32602 });
    expect((await second.client().call("ListTasks", {})).tasks).toEqual([]);
  });

  it("deduplicates identical messages and refuses changed contents", async () => {
    const effect = vi.fn((value: string) => value);
    const flow = defineWorkflow({
      id: "once",
      version: "1",
      input,
      run: (value, ctx) => ctx.step("once", () => effect(value)),
    });
    const f = fixture(flow);
    const sent = message("same");
    const [a, b] = await Promise.all([
      f.client().call("SendMessage", { message: sent }),
      f.client().call("SendMessage", { message: sent }),
    ]);
    expect(task(a).id).toBe(task(b).id);
    expect(effect).toHaveBeenCalledOnce();
    await expect(
      f.client().call("SendMessage", { message: message("same", "Changed") }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("does not replay an uncertain start or publish its host exception", async () => {
    const f = fixture();
    const start = vi.fn(async () => {
      throw new Error("Private database password");
    });
    const runs: A2ARuns<string, string> = { ...f.runs, start };
    const server = createA2AServer({
      runs,
      tasks: f.tasks,
      prepare: () => "text",
      authenticate: () => alice,
      card: { url: baseUrl, name: "Test", description: "Test" },
    });
    cleanups.push(server.close);
    const client = createA2AClient({
      endpoint: `${baseUrl}jsonrpc`,
      version: "1.0",
      binding: "JSONRPC",
      policy: { allow: () => true },
      fetch: (url, init) => server.fetch(new Request(url, init)),
    });
    const params = { message: message("uncertain"), configuration: { returnImmediately: true } };
    await expect(client.call("SendMessage", params)).rejects.toMatchObject({ code: -32603 });
    const duplicate = task(await client.call("SendMessage", params));
    expect(duplicate.status.state).toBe("unknown");
    expect(JSON.stringify(duplicate)).not.toContain("password");
    expect(start).toHaveBeenCalledOnce();
  });

  it("resumes a real SDK question through the real host claim path", async () => {
    const effect = vi.fn(() => "kept");
    const flow = defineWorkflow({
      id: "ask",
      version: "1",
      input,
      async run(_, ctx) {
        await ctx.step("once", effect);
        return ctx.ask({ key: "name", message: "What is your name?", freeText: true }, (answer) => {
          if (!answer.text) throw new Error("Text required");
          return answer.text;
        });
      },
    });
    const f = fixture(flow);
    const sdk = await official(f, { version: "1.0", binding: "JSONRPC" });
    const waiting = await sdk.sendMessage(
      SendMessageRequest.fromJSON({
        message: { messageId: "ask", role: "ROLE_USER", parts: [{ text: "Ask" }] },
      }),
    );
    if (!("id" in waiting)) throw new Error("Expected task");
    expect(waiting.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const before = await f.tasks.get(f.scope, waiting.id);
    const done = await sdk.sendMessage(
      SendMessageRequest.fromJSON({
        message: {
          messageId: "answer",
          role: "ROLE_USER",
          taskId: waiting.id,
          contextId: waiting.contextId,
          parts: [{ text: "Ana" }],
        },
      }),
    );
    if (!("id" in done)) throw new Error("Expected task");
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(done.artifacts[0]?.parts[0]?.content).toEqual({ $case: "text", value: "Ana" });
    expect(done.id).toBe(waiting.id);
    expect((await f.tasks.get(f.scope, waiting.id))?.segment).not.toBe(before?.segment);
    expect(f.claim).toHaveBeenCalledOnce();
    expect(f.resolved).toHaveBeenCalledOnce();
    expect(effect).toHaveBeenCalledOnce();
    const row = await f.runs.read("team", (await f.tasks.get(f.scope, waiting.id))!.segment!);
    expect(row.snapshot.kind).toBe("workflow");
    expect("models" in row.snapshot).toBe(false);
  });

  it("never repeats a continuation whose queue acknowledgement was lost", async () => {
    const flow = defineWorkflow({
      id: "uncertain-resume",
      version: "1",
      input,
      run: (_, ctx) =>
        ctx.ask({ key: "name", message: "Name?", freeText: true }, (answer) => answer.text ?? ""),
    });
    const f = fixture(flow);
    const waiting = task(await f.client().call("SendMessage", { message: message() }));
    const resume = f.runs.resume;
    const invoked = vi.spyOn(f.runs, "resume").mockImplementation(async (...args) => {
      await resume(...args);
      throw new Error("Queue reply lost");
    });
    const params = {
      message: { ...message("answer-once", "Ana"), taskId: waiting.id },
      configuration: { returnImmediately: true },
    };
    await expect(f.client().call("SendMessage", params)).rejects.toMatchObject({ code: -32603 });
    expect(task(await f.client().call("SendMessage", params)).id).toBe(waiting.id);
    expect((await complete(f.client(), waiting.id)).status.state).toBe("completed");
    expect(invoked).toHaveBeenCalledOnce();
    expect(f.claim).toHaveBeenCalledOnce();
  });

  it("accepts a later answer after a claimed continuation loses its acknowledgement", async () => {
    const effect = vi.fn(() => "once");
    const flow = defineWorkflow({
      id: "two-questions",
      version: "1",
      input,
      async run(_, ctx) {
        await ctx.step("effect", effect);
        const name = await ctx.ask(
          { key: "name", message: "Name?", freeText: true },
          (a) => a.text,
        );
        const city = await ctx.ask(
          { key: "city", message: "City?", freeText: true },
          (a) => a.text,
        );
        return `${name}, ${city}`;
      },
    });
    const f = fixture(flow);
    const waiting = task(await f.client().call("SendMessage", { message: message() }));
    const resume = f.runs.resume;
    const invoked = vi.spyOn(f.runs, "resume").mockImplementationOnce(async (...args) => {
      const next = await resume(...args);
      await vi.waitFor(async () => {
        expect((await f.runs.read("team", next.id)).outcome?.status).toBe("suspended");
      });
      throw new Error("Queue reply lost after consumption");
    });
    const first = {
      message: { ...message("first-answer", "Ana"), taskId: waiting.id },
      configuration: { returnImmediately: true },
    };
    await expect(f.client().call("SendMessage", first)).rejects.toMatchObject({ code: -32603 });
    expect((await f.server.refresh(alice, waiting.id)).status.message?.parts[0]).toMatchObject({
      text: "City?",
    });
    expect(task(await f.client().call("SendMessage", first)).id).toBe(waiting.id);
    const done = task(
      await f.client().call("SendMessage", {
        message: { ...message("second-answer", "Recife"), taskId: waiting.id },
      }),
    );
    expect(done.status.state).toBe("completed");
    expect(done.artifacts?.[0]?.parts[0]).toMatchObject({ text: "Ana, Recife" });
    expect(
      (await f.tasks.get(f.scope, done.id))?.messages.every((m) => m.acceptance === "accepted"),
    ).toBe(true);
    expect(invoked).toHaveBeenCalledTimes(2);
    expect(f.claim).toHaveBeenCalledTimes(2);
    expect(effect).toHaveBeenCalledOnce();
  });

  it("does not reconcile an uncertain answer without a matching host claim", async () => {
    const flow = defineWorkflow({
      id: "unclaimed",
      version: "1",
      input,
      run: (_, ctx) =>
        ctx.ask({ key: "name", message: "Name?", freeText: true }, (a) => a.text ?? ""),
    });
    const f = fixture(flow);
    const waiting = task(await f.client().call("SendMessage", { message: message() }));
    const resume = vi.spyOn(f.runs, "resume").mockRejectedValueOnce(new Error("Queue reply lost"));
    const params = { message: { ...message("uncertain-answer", "Ana"), taskId: waiting.id } };
    await expect(f.client().call("SendMessage", params)).rejects.toMatchObject({ code: -32603 });
    expect(task(await f.client().call("SendMessage", params)).status.state).toBe("input_required");
    await expect(
      f.client().call("SendMessage", {
        message: { ...message("new-answer", "Ana"), taskId: waiting.id },
      }),
    ).rejects.toMatchObject({ code: -32004 });
    expect((await f.tasks.get(f.scope, waiting.id))?.messages.at(-1)?.acceptance).toBe("unknown");
    expect(resume).toHaveBeenCalledOnce();
    expect(f.claim).not.toHaveBeenCalled();
  });

  it("keeps operator approval private and never interprets prose as approval", async () => {
    const effect = vi.fn(() => "done");
    const flow = defineWorkflow({
      id: "approval",
      version: "1",
      input,
      run: (_, ctx) => ctx.step("private-tool-name", effect, { needsApproval: true }),
    });
    const f = fixture(flow, { limits: { blockMs: 25 } });
    const waiting = task(await f.client().call("SendMessage", { message: message() }));
    expect(waiting.status.state).toBe("working");
    expect(JSON.stringify(waiting)).not.toContain("private-tool-name");
    await expect(
      f.client().call("SendMessage", {
        message: { ...message("approve", "Approved"), taskId: waiting.id },
      }),
    ).rejects.toMatchObject({ code: -32004 });
    expect(effect).not.toHaveBeenCalled();
    const enabled = fixture(flow, { remoteApprovals: true });
    const exposed = task(await enabled.client().call("SendMessage", { message: message() }));
    expect(exposed.status.state).toBe("input_required");
    await expect(
      enabled
        .client()
        .call("SendMessage", { message: { ...message("prose", "Approved"), taskId: exposed.id } }),
    ).rejects.toMatchObject({ code: -32602 });
    const part = exposed.status.message?.parts.find((p) => p.kind === "data");
    if (
      part?.kind !== "data" ||
      !isRecord(part.data) ||
      !Array.isArray(part.data.requests) ||
      !isRecord(part.data.requests[0])
    )
      throw new Error("Missing request");
    const requestId = String(part.data.requests[0].id);
    const done = task(
      await enabled.client().call("SendMessage", {
        message: {
          ...message("explicit"),
          taskId: exposed.id,
          parts: [{ kind: "data", data: { answers: { [requestId]: { type: "approve" } } } }],
        },
      }),
    );
    expect(done.status.state).toBe("completed");
    expect(effect).toHaveBeenCalledOnce();
  });

  it("keeps raw results private without an output projection", async () => {
    const f = fixture(undefined, { projectOutput: undefined });
    const done = task(
      await f.client().call("SendMessage", {
        message: message("private", "Private output"),
        configuration: { historyLength: 0 },
      }),
    );
    expect(done.status.state).toBe("completed");
    expect(done.artifacts).toBeUndefined();
    expect(JSON.stringify(done)).not.toContain("Private output");
    expect(JSON.stringify(await f.server.card())).not.toMatch(/instructions|private-tool/);
  });

  it("reapplies output disclosure to stored history on every read", async () => {
    let output: string | undefined = "Previously allowed result";
    const f = fixture(undefined, {
      projectOutput: () => (output === undefined ? [] : [{ kind: "text", text: output }]),
    });
    const done = task(await f.client().call("SendMessage", { message: message() }));
    expect(JSON.stringify(done.history)).toContain("Previously allowed result");
    output = "Redacted result";
    const redacted = await f.client().call("GetTask", { id: done.id });
    expect(JSON.stringify(redacted)).not.toContain("Previously allowed result");
    expect(JSON.stringify(redacted.history)).toContain("Redacted result");
    output = undefined;
    for (const result of [
      await f.client().call("GetTask", { id: done.id }),
      await f.server.refresh(alice, done.id),
      (await f.client().call("ListTasks", { historyLength: 100, includeArtifacts: true }))
        .tasks[0]!,
    ]) {
      expect(result.artifacts).toBeUndefined();
      expect(result.status.message).toBeUndefined();
      expect(result.history?.every((m) => m.role === "user")).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/Previously allowed result|Redacted result/);
    }
  });

  it("reapplies request disclosure to past questions without losing allowed history", async () => {
    let expose = true;
    const flow = defineWorkflow({
      id: "private-question",
      version: "1",
      input,
      async run(_, ctx) {
        await ctx.ask(
          { key: "private", message: "Previously allowed question?", freeText: true },
          (a) => a.text,
        );
        return "Done";
      },
    });
    const f = fixture(flow, { exposeRequest: () => expose });
    const waiting = task(await f.client().call("SendMessage", { message: message() }));
    const done = task(
      await f.client().call("SendMessage", {
        message: { ...message("answer", "Yes"), taskId: waiting.id },
      }),
    );
    expect(JSON.stringify(done.history)).toContain("Previously allowed question?");
    expose = false;
    const hidden = await f.client().call("GetTask", { id: done.id });
    expect(JSON.stringify(hidden)).not.toContain("Previously allowed question?");
    expect(hidden.history?.filter((m) => m.role === "user")).toHaveLength(2);
    expect(hidden.artifacts?.[0]?.parts[0]).toMatchObject({ text: "Done" });
  });

  it("detaches without canceling work and cancels only on an authenticated command", async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const flow = defineWorkflow({
      id: "slow",
      version: "1",
      input,
      run: (_, ctx) =>
        ctx.step("wait", async ({ signal }) => {
          entered.resolve();
          await Promise.race([
            release.promise,
            new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
          return signal.aborted ? "stopped" : "done";
        }),
    });
    const f = fixture(flow);
    const observe = f.client().observe("SendStreamingMessage", { message: message() });
    const first = await observe.next();
    if (!first.value || first.value.kind !== "task") throw new Error("Missing initial identity");
    await entered.promise;
    await observe.close();
    expect((await f.client().call("GetTask", { id: first.value.id })).status.state).toBe("working");
    const sdk = await official(f, { version: "1.0", binding: "HTTP+JSON" });
    await sdk.cancelTask(CancelTaskRequest.fromJSON({ id: first.value.id }));
    expect((await complete(f.client(), first.value.id)).status.state).toBe("canceled");
    release.resolve();
  });

  it("rejects truncated observation without changing server-held work", async () => {
    const release = Promise.withResolvers<void>();
    const flow = defineWorkflow({
      id: "slow",
      version: "1",
      input,
      run: (_, ctx) =>
        ctx.step("wait", async () => {
          await release.promise;
          return "done";
        }),
    });
    const f = fixture(flow);
    const runs: A2ARuns<string, string> = {
      ...f.runs,
      async *observe() {
        yield { seq: 1, type: "agent.gap", data: { dropped: 1 } };
      },
    };
    const server = createA2AServer({
      runs,
      tasks: f.tasks,
      prepare: () => "",
      authenticate: () => alice,
      card: { url: baseUrl, name: "Test", description: "Test" },
    });
    cleanups.push(server.close);
    const client = createA2AClient({
      endpoint: `${baseUrl}jsonrpc`,
      version: "1.0",
      binding: "JSONRPC",
      policy: { allow: () => true },
      fetch: (url, init) => server.fetch(new Request(url, init)),
    });
    const stream = client.observe("SendStreamingMessage", { message: message() });
    const first = await stream.next();
    expect((await stream.next()).value?.kind).toBe("task");
    await expect(stream.next()).rejects.toMatchObject({ code: -32603 });
    if (first.value?.kind !== "task") throw new Error("Missing task");
    expect((await client.call("GetTask", { id: first.value.id })).status.state).toBe("working");
    release.resolve();
    expect((await complete(client, first.value.id)).status.state).toBe("completed");
  });

  it("rechecks authorization when an existing reader pulls again", async () => {
    const f = fixture();
    const reader = f.client().observe("SendStreamingMessage", { message: message() });
    await reader.next();
    f.revoke();
    await expect(reader.next()).rejects.toMatchObject({ code: -32001 });
  });

  it("keeps due wakes host-claimed and rejects early or concurrent continuations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const flow = defineWorkflow({
      id: "wake",
      version: "1",
      input,
      async run(_, ctx) {
        await ctx.sleep("wait", 1000);
        return "awake";
      },
    });
    const f = fixture(flow, { limits: { blockMs: 10 } });
    const runs = createMemoryRuns({ workflow: flow, policy: f.policy });
    const started = await runs.start("team", "", { runId: "wake" });
    await vi.waitFor(async () => {
      expect((await runs.read("team", started.id)).outcome?.status).toBe("suspended");
    });
    const waiting = await runs.read("team", started.id);
    await expect(runs.resume("other", started.id, {})).rejects.toMatchObject({ code: -32001 });
    await expect(runs.resume("team", started.id, {})).rejects.toMatchObject({ kind: "invalid" });
    vi.setSystemTime(waiting.wakeAt! + 1);
    const continued = await runs.resume("team", started.id, {});
    await expect(runs.resume("team", started.id, {})).rejects.toMatchObject({ kind: "invalid" });
    await vi.waitFor(async () => {
      expect((await runs.read("team", continued.id)).outcome?.status).toBe("completed");
    });
    expect(f.claim).toHaveBeenCalledOnce();
    expect(f.claim.mock.calls[0]?.[1].wakeAt).toBe(waiting.wakeAt);
  });

  it("rehydrates transformed outputs without requiring the validator result to be JSON", async () => {
    const f = fixture();
    const agent = defineAgent({
      id: "date",
      version: "1",
      instructions: "Return a date.",
      output: { schema: { type: "object" }, validate: () => new Date("2026-11-17T00:00:00Z") },
      provider: {
        id: "offline",
        model: "scripted",
        async *createStream() {
          yield {
            type: "delta",
            finishReason: "tool_calls",
            toolCalls: [{ index: 0, id: "result", name: "submit_result", arguments: "{}" }],
          };
        },
      },
    });
    const runs = createMemoryRuns({
      agent,
      policy: f.policy,
      onSegment: a2aSegments({ tasks: f.tasks, scope: () => f.scope }),
    });
    const server = createA2AServer({
      runs,
      tasks: f.tasks,
      authenticate: () => alice,
      card: { url: baseUrl, name: "Date", description: "Returns a date." },
      projectOutput: (outcome) =>
        outcome.output instanceof Date
          ? [{ kind: "text", text: outcome.output.toISOString() }]
          : [],
    });
    cleanups.push(server.close);
    const client = createA2AClient({
      endpoint: `${baseUrl}jsonrpc`,
      version: "1.0",
      binding: "JSONRPC",
      policy: { allow: () => true },
      fetch: (url, init) => server.fetch(new Request(url, init)),
    });
    const done = task(await client.call("SendMessage", { message: message() }));
    expect(done.artifacts?.[0]?.parts[0]).toMatchObject({ text: "2026-11-17T00:00:00.000Z" });
    const record = (await f.tasks.get(f.scope, done.id))!;
    const first = await runs.read("team", record.segment!);
    if (first.outcome?.status !== "completed" || !(first.outcome.output instanceof Date))
      throw new Error("Missing date output");
    first.outcome.output.setTime(0);
    const second = await runs.read("team", record.segment!);
    if (second.outcome?.status !== "completed" || !(second.outcome.output instanceof Date))
      throw new Error("Missing date output");
    expect(second.outcome.output.toISOString()).toBe("2026-11-17T00:00:00.000Z");
  });

  it("streams only authorized root text and accepts one steering message at a safe boundary", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen: unknown[] = [];
    let calls = 0;
    const provider: Provider = {
      id: "offline",
      model: "scripted",
      async *createStream(history) {
        seen.push(structuredClone(history));
        if (++calls === 1) {
          entered.resolve();
          yield { type: "delta", content: "Visible", reasoning: "private reasoning" };
          await release.promise;
          yield {
            type: "delta",
            finishReason: "tool_calls",
            toolCalls: [{ index: 0, id: "read", name: "private_tool", arguments: "{}" }],
          };
        } else yield { type: "delta", content: "Final", finishReason: "stop" };
      },
    };
    const agent = defineAgent({
      id: "agent",
      version: "1",
      instructions: "Private instructions",
      provider,
      tools: [
        defineTool({
          name: "private_tool",
          description: "Private tool",
          inputSchema: { type: "object" },
          run: async () => "private result",
        }),
      ],
    });
    const runs = createMemoryRuns({
      agent,
      steering: true,
      policy: f.policy,
      onSegment: a2aSegments({ tasks: f.tasks, scope: () => f.scope }),
    });
    const server = createA2AServer({
      runs,
      tasks: f.tasks,
      authenticate: () => alice,
      card: { url: baseUrl, name: "Agent", description: "Answers input." },
      projectOutput: (outcome) =>
        typeof outcome.output === "string" ? [{ kind: "text", text: outcome.output }] : [],
      projectText: (text) => text,
    });
    cleanups.push(server.close);
    const client = createA2AClient({
      endpoint: `${baseUrl}jsonrpc`,
      version: "1.0",
      binding: "JSONRPC",
      policy: { allow: () => true },
      fetch: (url, init) => server.fetch(new Request(url, init)),
    });
    const stream = client.observe("SendStreamingMessage", { message: message() });
    const first = await stream.next();
    if (first.value?.kind !== "task") throw new Error("Missing identity");
    await entered.promise;
    const delta = await stream.next();
    expect(delta.value).toMatchObject({
      kind: "artifact-update",
      append: false,
      artifact: { parts: [{ text: "Visible" }] },
    });
    expect(JSON.stringify(delta.value)).not.toContain("private");
    const steering = {
      message: { ...message("steer", "New instruction"), taskId: first.value.id },
      configuration: { returnImmediately: true },
    };
    await client.call("SendMessage", steering);
    await client.call("SendMessage", steering);
    await expect(
      client.call("SendMessage", {
        ...steering,
        message: { ...steering.message, parts: [{ kind: "text", text: "Changed" }] },
      }),
    ).rejects.toMatchObject({ code: -32602 });
    release.resolve();
    const rest = [];
    for await (const event of stream) rest.push(event);
    expect(rest.at(-1)).toMatchObject({ kind: "status-update", status: { state: "completed" } });
    expect(JSON.stringify(rest)).not.toMatch(
      /private_tool|private result|Private instructions|private reasoning/,
    );
    expect(JSON.stringify(seen[1])).toContain("New instruction");
    const record = (await f.tasks.get(f.scope, first.value.id))!;
    expect(record.messages.filter((receipt) => receipt.id === "steer")).toHaveLength(1);
    expect((await runs.read("team", record.segment!)).outcome).toMatchObject({
      status: "completed",
      output: "Final",
    });
  });

  it("follows an operator continuation created outside A2A", async () => {
    const flow = defineWorkflow({
      id: "operator",
      version: "1",
      input,
      run: (_, ctx) => ctx.step("write", () => "done", { needsApproval: true }),
    });
    const f = fixture(flow, { limits: { blockMs: 15 } });
    const waiting = task(await f.client().call("SendMessage", { message: message() }));
    const record = (await f.tasks.get(f.scope, waiting.id))!;
    const row = await f.runs.read("team", record.segment!);
    if (row.outcome?.status !== "suspended" || !row.outcome.requests[0])
      throw new Error("Missing operator request");
    const continuation = await f.runs.resume("team", record.segment!, {
      [row.outcome.requests[0].id]: { answer: { type: "approve" } },
    });
    expect((await complete(f.client(), waiting.id)).status.state).toBe("completed");
    expect((await f.tasks.get(f.scope, waiting.id))?.segment).toBe(continuation.id);
    expect((await f.tasks.get(f.scope, waiting.id))?.messages).toHaveLength(1);
  });

  it.each(["completed", "input_required"] as const)(
    "emits %s reached between operator-segment polls before closing",
    async (state) => {
      const flow = defineWorkflow({
        id: "operator-stream",
        version: "1",
        input,
        async run(_, ctx) {
          await ctx.step("approved", () => "done", { needsApproval: true });
          return state === "completed"
            ? "Done"
            : ctx.ask(
                { key: "next", message: "Next question?", freeText: true },
                (a) => a.text ?? "",
              );
        },
      });
      const f = fixture(flow, { limits: { blockMs: 15 } });
      const waiting = task(await f.client().call("SendMessage", { message: message() }));
      const record = (await f.tasks.get(f.scope, waiting.id))!;
      const row = await f.runs.read("team", record.segment!);
      if (row.outcome?.status !== "suspended" || !row.outcome.requests[0])
        throw new Error("Missing request");
      const stream = f.client().observe("SubscribeToTask", { id: waiting.id });
      expect((await stream.next()).value).toMatchObject({
        kind: "task",
        status: { state: "working" },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const collected = (async () => {
        const events = [];
        for await (const event of stream) events.push(event);
        return events;
      })().then(
        (events) => ({ events }),
        (error: unknown) => ({ error }),
      );
      // Drain observation of the old segment and enter its 250 ms polling wait.
      await vi.advanceTimersByTimeAsync(0);
      const next = await f.runs.resume("team", record.segment!, {
        [row.outcome.requests[0].id]: { answer: { type: "approve" } },
      });
      for await (const _event of f.runs.observe("team", next.id)) {
        // Finish the continuation without advancing the subscription's polling clock.
      }
      expect((await f.runs.read("team", next.id)).outcome?.status).toBe(
        state === "completed" ? "completed" : "suspended",
      );
      await vi.advanceTimersByTimeAsync(250);
      const result = await collected;
      expect(result).not.toHaveProperty("error");
      if (!("events" in result)) throw result.error;
      expect(result.events.at(-1)).toMatchObject({ kind: "status-update", status: { state } });
      if (state === "completed")
        expect(result.events).toContainEqual(
          expect.objectContaining({
            kind: "artifact-update",
            artifact: { artifactId: "answer", parts: [{ kind: "text", text: "Done" }] },
            lastChunk: true,
          }),
        );
    },
  );

  it.each([true, false])(
    "tracks suspended cancellation with a segment hook set to %s",
    async (tracked) => {
      const effect = vi.fn(() => "must not run");
      const flow = defineWorkflow({
        id: "cancel-wait",
        version: "1",
        input,
        run: (_, ctx) => ctx.step("write", effect, { needsApproval: true }),
      });
      const tasks = createMemoryTaskStore();
      const hook = vi.fn(a2aSegments({ tasks, scope: () => alice }));
      const f = fixture(
        flow,
        { tasks, limits: { blockMs: 15 } },
        {
          onSegment: tracked ? hook : undefined,
        },
      );
      const waiting = task(await f.client().call("SendMessage", { message: message() }));
      const source = (await tasks.get(f.scope, waiting.id))!.segment!;
      const cancel = vi.spyOn(f.runs, "cancel");
      await f.client().call("CancelTask", { id: waiting.id });
      const result = await cancel.mock.results[0]!.value;
      expect(result).toMatchObject({ requested: true });
      expect(result.id).not.toBe(source);
      expect((await complete(f.client(), waiting.id)).status.state).toBe("canceled");
      expect((await tasks.get(f.scope, waiting.id))?.segment).toBe(result.id);
      expect(f.claim).toHaveBeenCalledOnce();
      expect(f.claim.mock.calls[0]?.[1]).toEqual({
        id: `cancel/${source}`,
        sourceId: source,
        kind: "cancel",
        answers: {},
      });
      expect(effect).not.toHaveBeenCalled();
      expect(f.resolved).not.toHaveBeenCalled();
      if (tracked) {
        const hooks = hook.mock.calls
          .map(([event]) => event)
          .filter((event) => event.id === result.id);
        expect(hooks.map((event) => event.phase)).toEqual(["start", "end"]);
        expect(hooks.every((event) => !event.signal.aborted)).toBe(true);
      }
    },
  );

  it("does not abort or duplicate a pending cancellation segment on a second Stop", async () => {
    const flow = defineWorkflow({
      id: "stop-twice",
      version: "1",
      input,
      run: (_, ctx) => ctx.step("approval", () => "must not run", { needsApproval: true }),
    });
    const f = fixture(flow, { limits: { blockMs: 15 } }, { onSegment: undefined });
    const waiting = task(await f.client().call("SendMessage", { message: message() }));
    const source = (await f.tasks.get(f.scope, waiting.id))!.segment!;
    const claimed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.claim.mockImplementation(async () => {
      claimed.resolve();
      await release.promise;
    });
    const cancel = vi.spyOn(f.runs, "cancel");
    await f.client().call("CancelTask", { id: waiting.id });
    await claimed.promise;
    const next = (await f.tasks.get(f.scope, waiting.id))!.segment!;
    try {
      expect(next).not.toBe(source);
      expect((await f.client().call("CancelTask", { id: waiting.id })).status.state).toBe(
        "working",
      );
      expect(cancel).toHaveBeenCalledOnce();
      await expect(f.runs.cancel("other", next)).rejects.toMatchObject({ code: -32001 });
      await expect(f.runs.cancel("team", source)).resolves.toEqual({ id: next, requested: true });
      await expect(f.runs.cancel("team", next)).resolves.toEqual({ id: next, requested: true });
      expect((await f.runs.read("team", next)).outcome).toBeNull();
    } finally {
      release.resolve();
    }
    expect((await complete(f.client(), waiting.id)).status.state).toBe("canceled");
    expect(f.claim).toHaveBeenCalledOnce();
    expect((await f.tasks.get(f.scope, waiting.id))?.segment).toBe(next);
  });

  it("does not report a rejected cancellation claim as a cancelled task or a scheduled wake", async () => {
    const effect = vi.fn(() => "must not run");
    const flow = defineWorkflow({
      id: "cancel-sleep",
      version: "1",
      input,
      async run(_, ctx) {
        await ctx.sleep("later", 60_000);
        return ctx.step("effect", effect);
      },
    });
    const f = fixture(flow, { limits: { blockMs: 15 } }, { onSegment: undefined });
    const waiting = task(await f.client().call("SendMessage", { message: message() }));
    const source = (await f.tasks.get(f.scope, waiting.id))!.segment!;
    await expect(f.runs.resume("team", source, {})).rejects.toMatchObject({ kind: "invalid" });
    f.claim.mockRejectedValueOnce(new Error("The host refused the cancellation claim"));
    const cancel = vi.spyOn(f.runs, "cancel");
    await f.client().call("CancelTask", { id: waiting.id });
    expect((await cancel.mock.results[0]!.value).requested).toBe(true);
    expect((await complete(f.client(), waiting.id)).status.state).toBe("failed");
    expect(f.claim.mock.calls[0]?.[1]).toEqual({
      id: `cancel/${source}`,
      sourceId: source,
      kind: "cancel",
      answers: {},
    });
    expect(effect).not.toHaveBeenCalled();
    expect(f.resolved).not.toHaveBeenCalled();
  });

  it("does not repeat cancellation after an unknown queue acknowledgement", async () => {
    const flow = defineWorkflow({
      id: "cancel-unknown",
      version: "1",
      input,
      run: (_, ctx) => ctx.step("approval", () => "must not run", { needsApproval: true }),
    });
    const f = fixture(flow, { limits: { blockMs: 15 } });
    const waiting = task(await f.client().call("SendMessage", { message: message() }));
    const claimed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.claim.mockImplementation(async () => {
      claimed.resolve();
      await release.promise;
    });
    const cancel = f.runs.cancel;
    const invoked = vi.spyOn(f.runs, "cancel").mockImplementation(async (...args) => {
      await cancel(...args);
      throw new Error("Queue reply lost");
    });
    try {
      await expect(f.client().call("CancelTask", { id: waiting.id })).rejects.toMatchObject({
        code: -32603,
      });
      await claimed.promise;
      expect((await f.tasks.get(f.scope, waiting.id))?.cancel).toBe("unknown");
      expect((await f.client().call("CancelTask", { id: waiting.id })).status.state).toBe(
        "working",
      );
      expect(invoked).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
    }
    expect((await complete(f.client(), waiting.id)).status.state).toBe("canceled");
    expect(f.claim).toHaveBeenCalledOnce();
  });

  it("does not replace a newer segment with a late cancellation acknowledgement", async () => {
    const flow = defineWorkflow({
      id: "cancel-race",
      version: "1",
      input,
      async run(_, ctx) {
        await ctx.ask({ key: "first", message: "First?", freeText: true }, (a) => a.text);
        return ctx.ask({ key: "second", message: "Second?", freeText: true }, (a) => a.text ?? "");
      },
    });
    const f = fixture(flow);
    const waiting = task(await f.client().call("SendMessage", { message: message() }));
    const source = (await f.tasks.get(f.scope, waiting.id))!.segment!;
    const row = await f.runs.read("team", source);
    if (row.outcome?.status !== "suspended" || !row.outcome.requests[0])
      throw new Error("Missing request");
    const requestId = row.outcome.requests[0].id;
    let next: string | undefined;
    vi.spyOn(f.runs, "cancel").mockImplementation(async () => {
      next = (
        await f.runs.resume("team", source, {
          [requestId]: { answer: { type: "answer", answer: { text: "First answer" } } },
        })
      ).id;
      for await (const _event of f.runs.observe("team", next)) {
        /* Await the real checkpoint. */
      }
      return { id: source, requested: false };
    });
    await expect(f.client().call("CancelTask", { id: waiting.id })).rejects.toMatchObject({
      code: -32602,
    });
    expect((await f.tasks.get(f.scope, waiting.id))?.segment).toBe(next);
    const current = await f.client().call("GetTask", { id: waiting.id });
    expect(current.status.state).toBe("input_required");
    expect(current.status.message?.parts[0]).toMatchObject({ text: "Second?" });
  });

  it.each([
    { version: "1.0", binding: "JSONRPC" },
    { version: "1.0", binding: "HTTP+JSON" },
    { version: "0.3", binding: "JSONRPC" },
  ] as A2ADialect[])(
    "keeps streaming history limits on every snapshot: $version $binding",
    async (dialect) => {
      const flow = defineWorkflow({
        id: "history-limit",
        version: "1",
        input,
        run: (_, ctx) => ctx.step("wait", () => "done", { needsApproval: true }),
      });
      const f = fixture(flow, { limits: { blockMs: 15 } });
      const observe = f.runs.observe;
      vi.spyOn(f.runs, "observe").mockImplementation(async function* (...args) {
        yield { seq: 0, type: "agent.gap", data: { dropped: 1 } };
        yield { seq: 0, type: "agent.resync", data: {} };
        yield* observe(...args);
      });
      for (const historyLength of [0, 1]) {
        const params = { message: message(), configuration: { historyLength } };
        const waiting = task(await f.client("alice", dialect).call("SendMessage", params));
        const stream = f.client("alice", dialect).observe("SendStreamingMessage", params);
        try {
          for (let snapshot = 0; snapshot < 3; snapshot++) {
            const next = await stream.next();
            if (next.value?.kind !== "task") throw new Error("Missing task snapshot");
            expect(next.value.id).toBe(waiting.id);
            expect(next.value.history?.length ?? 0).toBe(historyLength);
          }
        } finally {
          await stream.close();
        }
      }
    },
  );

  it("supports SDK subscriptions and reports accurate list pages", async () => {
    const release = Promise.withResolvers<void>();
    const flow = defineWorkflow({
      id: "subscribe",
      version: "1",
      input,
      run: (_, ctx) =>
        ctx.step("wait", async () => {
          await release.promise;
          return "done";
        }),
    });
    const f = fixture(flow);
    const started = task(
      await f
        .client()
        .call("SendMessage", { message: message(), configuration: { returnImmediately: true } }),
    );
    const sdk = await official(f, { version: "0.3", binding: "HTTP+JSON" });
    const observed = sdk.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: started.id }));
    expect((await observed.next()).done).toBe(false);
    release.resolve();
    for await (const _event of observed) {
      /* Drain only this test's stream. */
    }
    await f.client().call("SendMessage", { message: message() });
    const page = await f.client().call("ListTasks", { pageSize: 1, status: "completed" });
    expect(page.totalSize).toBe(2);
    expect(page.tasks).toHaveLength(1);
    expect(page.nextPageToken).not.toBe("");
    const next = await f
      .client()
      .call("ListTasks", { pageSize: 1, status: "completed", pageToken: page.nextPageToken });
    expect(next.totalSize).toBe(2);
    expect(next.tasks[0]?.id).not.toBe(page.tasks[0]?.id);
    expect(next.nextPageToken).toBe("");
    const boundary = page.tasks[0]!;
    expect(boundary.status.timestamp).toBeDefined();
    const inclusive = await f
      .client()
      .call("ListTasks", { statusTimestampAfter: boundary.status.timestamp });
    expect(inclusive.tasks.some((task) => task.id === boundary.id)).toBe(true);
  });

  it("pages push configs, protects credentials and stops deleted callbacks", async () => {
    const send = vi.fn(async () => new Response(null, { status: 204 }));
    const f = fixture(undefined, {
      push: { authorize: () => true, allow: () => true, fetch: send },
    });
    const owned = task(await f.client().call("SendMessage", { message: message() }));
    for (const id of ["one", "two"])
      await f.client().call("CreateTaskPushNotificationConfig", {
        id,
        taskId: owned.id,
        url: `https://callback.test/${id}`,
        authentication: { schemes: ["Bearer"], credentials: `secret-${id}` },
      });
    const list = await f
      .client()
      .call("ListTaskPushNotificationConfigs", { taskId: owned.id, pageSize: 1 });
    expect(list.configs).toHaveLength(1);
    const next = await f.client().call("ListTaskPushNotificationConfigs", {
      taskId: owned.id,
      pageSize: 1,
      pageToken: list.nextPageToken,
    });
    expect(next.configs[0]?.id).toBe("two");
    expect(JSON.stringify(await f.client().call("GetTask", { id: owned.id }))).not.toContain(
      "secret",
    );
    await expect(
      f.client("bob").call("DeleteTaskPushNotificationConfig", { taskId: owned.id, id: "one" }),
    ).rejects.toMatchObject({ code: -32001 });
    await f.client().call("DeleteTaskPushNotificationConfig", { taskId: owned.id, id: "one" });
    await expect(
      f.client().call("GetTaskPushNotificationConfig", { taskId: owned.id, id: "one" }),
    ).rejects.toMatchObject({ code: -32001 });
  });

  it("rejects non-JSON bodies and oversized requests without starting work", async () => {
    const f = fixture(undefined, { limits: { bodyBytes: 64 } });
    const send = (body: string, type: string) =>
      f.server.fetch(
        new Request(`${baseUrl}jsonrpc`, {
          method: "POST",
          body,
          headers: { authorization: "Bearer alice", "content-type": type },
        }),
      );
    expect((await send("message=x", "application/x-www-form-urlencoded")).status).toBe(415);
    expect((await send("x".repeat(65), "application/json")).status).toBe(413);
    const emptyCancel = await f.server.fetch(
      new Request(`${baseUrl}rest/tasks/missing:cancel`, {
        method: "POST",
        headers: { authorization: "Bearer alice", "A2A-Version": "1.0" },
      }),
    );
    expect(emptyCancel.status).toBe(415);
  });
});

describe("memory task store conformance", () => {
  function record(id: string, scope = alice): A2ATaskRecord {
    return {
      ...scope,
      id,
      contextId: "context",
      hops: 0,
      state: "submitted",
      messages: [{ id: "message", fingerprint: "content", kind: "start", acceptance: "pending" }],
      history: [],
      push: [],
      deliveries: [],
      createdAt: 1,
      updatedAt: 1,
      revision: "",
    };
  }
  it("returns stable copies, scopes dedupe and fences updates", async () => {
    const store = createMemoryTaskStore();
    const first = await store.create(record("one"));
    first.record.messages[0]!.fingerprint = "mutated";
    expect((await store.get(alice, "one"))?.messages[0]?.fingerprint).toBe("content");
    expect((await store.create(record("two"))).record.id).toBe("one");
    const other = { owner: "other", actorId: "alice" };
    expect((await store.create(record("other", other))).created).toBe(true);
    expect(await store.get(other, "one")).toBeNull();
    expect(await store.hasContext({ ...alice, tenant: "foreign" }, "context")).toBe(false);
    const current = (await store.get(alice, "one"))!;
    await store.update(alice, "one", { state: "working" }, current.revision);
    await expect(
      store.update(alice, "one", { state: "failed" }, current.revision),
    ).rejects.toBeInstanceOf(A2AError);
  });
  it("refuses overflow without forgetting dedupe receipts", async () => {
    const store = createMemoryTaskStore({ maxTasks: 1 });
    await store.create(record("one"));
    const next = record("two");
    next.messages[0]!.id = "new";
    await expect(store.create(next)).rejects.toMatchObject({ kind: "limit" });
    expect((await store.create(record("three"))).record.id).toBe("one");
  });
});
