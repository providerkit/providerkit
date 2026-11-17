import { describe, expect, it, vi } from "vitest";
import { EMPTY_USAGE, type Provider } from "@providerkit/core";
import { defineAgent } from "../src/index.ts";
import { AGENT_RUNTIME, defineDelegation } from "../src/delegation.ts";
import { defineWorkflow } from "../src/workflow.ts";
import { checkChildProgress, checkTree, isRecord } from "../src/snapshot.ts";
import { readContent } from "../src/input.ts";
import { snapshots, wakeAt } from "../src/tree.ts";
import {
  defineRemoteAgent,
  type RemoteAgentOptions,
  type RemoteSnapshot,
} from "../src/a2a/remote.ts";
import { decodeA2AHttpRequest } from "../src/a2a/client.ts";
import { createMemoryRuns } from "../src/a2a/memory-runs.ts";
import { a2aPolicy, createA2AServer } from "../src/a2a/server.ts";
import { a2aSegments, createMemoryTaskStore } from "../src/a2a/tasks.ts";
import {
  A2AError,
  decodeA2AAgentCard,
  decodeA2ARpcRequest,
  encodeA2AError,
  encodeA2AResult,
  encodeA2AEvent,
  type A2ADialect,
  type A2ARequest,
  type A2ATask,
  type A2AMessage,
  type A2AEvent,
} from "../src/a2a/wire.ts";
import type { AgentHost, Decision, TreeNode } from "../src/types.ts";

const endpoint = "https://peer.test/a2a";
const dialects: A2ADialect[] = [
  { version: "1.0", binding: "JSONRPC" },
  { version: "0.3", binding: "JSONRPC" },
  { version: "1.0", binding: "HTTP+JSON" },
  { version: "0.3", binding: "HTTP+JSON" },
];
const completed: A2ATask = {
  kind: "task",
  id: "task",
  contextId: "context",
  status: { state: "completed" },
  artifacts: [{ artifactId: "answer", parts: [{ kind: "text", text: "Done" }] }],
};
const working: A2ATask = {
  kind: "task",
  id: "task",
  contextId: "context",
  status: { state: "working" },
};
function waiting(structured = false): A2ATask {
  return {
    ...working,
    status: {
      state: "input_required",
      message: {
        kind: "message",
        role: "agent",
        messageId: "question",
        taskId: "task",
        contextId: "context",
        parts: structured
          ? [
              {
                kind: "data",
                data: {
                  requests: ["first", "second"].map((id) => ({
                    id,
                    type: "question",
                    message: id,
                    freeText: true,
                  })),
                },
              },
            ]
          : [{ kind: "text", text: "Which city?" }],
      },
    },
  };
}
function authority() {
  const saved: TreeNode[] = [];
  const decisions = new Map<string, Decision>();
  const host = {
    authorizeResume: vi.fn(() => {}),
    beforeTool: vi.fn(() => {}),
    beforeStep: vi.fn(() => {}),
    checkpoint: vi.fn((node: TreeNode) => {
      saved.push(structuredClone(node));
    }),
    prepareRequest: vi.fn(() => ({
      scope: {
        actorId: "alice",
        resource: { id: "task", version: "1" },
        expiresAt: Date.now() + 60_000,
      },
    })),
    resolveRequest: vi.fn((_request, evidence: unknown) =>
      typeof evidence === "string" && decisions.has(evidence)
        ? decisions.get(evidence)!
        : { type: "pending" as const },
    ),
  } satisfies AgentHost;
  return { host, saved, decisions };
}
function fixture(
  reply: (
    request: A2ARequest,
  ) =>
    | A2ATask
    | A2AMessage
    | A2AEvent[]
    | A2AError
    | Promise<A2ATask | A2AMessage | A2AEvent[] | A2AError>,
  dialect = dialects[0]!,
  extra: Partial<RemoteAgentOptions<string>> = {},
) {
  const calls: A2ARequest[] = [];
  const card = decodeA2AAgentCard(
    {
      name: "Offline",
      description: "Untrusted card prose",
      version: "1",
      capabilities: { streaming: true },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      ...(dialect.version === "1.0"
        ? {
            supportedInterfaces: [
              { url: endpoint, protocolBinding: dialect.binding, protocolVersion: dialect.version },
            ],
          }
        : { url: endpoint, preferredTransport: dialect.binding, protocolVersion: "0.3" }),
    },
    dialect.version,
  );
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const rpc =
      dialect.binding === "JSONRPC"
        ? decodeA2ARpcRequest(await request.json(), dialect.version)
        : undefined;
    const decoded =
      rpc?.request ??
      (await decodeA2AHttpRequest(request, { baseUrl: endpoint, version: dialect.version }));
    calls.push(decoded);
    const result = await reply(decoded);
    if (result instanceof A2AError) {
      const error = encodeA2AError(result.code ?? -32603, dialect, rpc?.id);
      return Response.json(error.body, { status: error.status });
    }
    if (Array.isArray(result))
      return new Response(
        result
          .map((event) => {
            const value = encodeA2AEvent(event, dialect);
            return `data: ${JSON.stringify(rpc ? { jsonrpc: "2.0", id: rpc.id, result: value } : value)}\n\n`;
          })
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (
      decoded.method !== "SendMessage" &&
      decoded.method !== "GetTask" &&
      decoded.method !== "CancelTask"
    )
      throw new Error("Unexpected fixture operation");
    const encoded =
      decoded.method === "SendMessage"
        ? encodeA2AResult({ method: decoded.method, result }, dialect)
        : result.kind === "task"
          ? encodeA2AResult({ method: decoded.method, result }, dialect)
          : (() => {
              throw new Error("Expected task");
            })();
    return Response.json(rpc ? { jsonrpc: "2.0", id: rpc.id, result: encoded } : encoded);
  };
  const config = {
    id: "remote",
    agentVersion: "1",
    ...dialect,
    card,
    policy: { allow: (url: URL) => url.origin === new URL(endpoint).origin },
    fetch,
    ...extra,
  };
  return { remote: defineRemoteAgent({ ...config, output: undefined }), calls, config };
}
function lastRemote(saved: TreeNode[]): RemoteSnapshot {
  const node = saved.at(-1);
  if (!node || node.kind !== "remote") throw new Error("Missing remote journal");
  return node;
}

describe("remote specialists", () => {
  it.each(["1.0", "0.3"] as const)(
    "answers a real in-process %s server question through both request journals",
    async (version) => {
      const scope = { owner: "alice", actorId: "alice" };
      const tasks = createMemoryTaskStore();
      const claims = new Map<string, string>();
      const workflow = defineWorkflow({
        id: "served-question",
        version: "1",
        input: { schema: { type: "object" }, validate: () => null },
        async run(_, ctx) {
          return ctx.ask({ key: "city", message: "Which city?", freeText: true }, (answer) => {
            if (!answer.text) throw new Error("Choose a city");
            return answer.text;
          });
        },
      });
      const runs = createMemoryRuns({
        workflow,
        onSegment: a2aSegments({ tasks, scope: () => scope }),
        policy(context) {
          const authorize = () => {
            if (context.owner !== scope.owner) throw new Error("Wrong owner");
          };
          return a2aPolicy(
            {
              authorizeResume: authorize,
              beforeStep: authorize,
              beforeTool: authorize,
              prepareRequest: () => ({
                scope: {
                  actorId: "alice",
                  resource: { id: "city", version: "1" },
                  expiresAt: Date.now() + 60_000,
                },
              }),
              claimContinuation(_snapshot, continuation) {
                authorize();
                const key = `${context.owner}/${continuation.sourceId}`;
                const claim = `${continuation.id}/${context.segmentId}`;
                if (claims.has(key) && claims.get(key) !== claim)
                  throw new Error("Already claimed");
                claims.set(key, claim);
              },
              resolveRequest(_request, evidence) {
                if (
                  isRecord(evidence) &&
                  isRecord(evidence.answer) &&
                  evidence.answer.type === "answer" &&
                  isRecord(evidence.answer.answer) &&
                  typeof evidence.answer.answer.text === "string"
                )
                  return { type: "answer", answer: { text: evidence.answer.answer.text } };
                return { type: "pending" };
              },
            },
            { tasks, scope, context },
          );
        },
      });
      const server = createA2AServer({
        runs,
        tasks,
        prepare: () => null,
        card: {
          url: "https://server.test/a2a/",
          name: "Offline",
          description: "Asks one question.",
        },
        authenticate: (request) =>
          request.headers.get("authorization") === "Bearer fixture" ? scope : null,
        projectOutput: (result) =>
          typeof result.output === "string" ? [{ kind: "text", text: result.output }] : [],
      });
      try {
        const remote = defineRemoteAgent({
          id: "served",
          agentVersion: "1",
          version,
          binding: "JSONRPC",
          updates: "stream",
          card: "https://server.test/a2a/",
          headers: () => ({ authorization: "Bearer fixture" }),
          policy: { allow: (url) => url.origin === "https://server.test" },
          fetch: (input, init) => server.fetch(new Request(input, init)),
        });
        const { host, decisions } = authority();
        const first = await remote.run("Hello", { host });
        if (first.status !== "suspended" || !first.requests[0])
          throw new Error(JSON.stringify(first));
        decisions.set("city", { type: "answer", answer: { text: "Paris" } });
        const result = await remote.resume(first.snapshot, {
          host,
          answers: { [first.requests[0].id]: "city" },
        });
        expect(result).toMatchObject({ status: "completed", output: "Paris" });
        expect(result.receipts).toHaveLength(2);
        expect(JSON.stringify(result.snapshot)).not.toContain("Bearer fixture");
      } finally {
        await server.close();
      }
    },
  );

  it.each(dialects)(
    "journals before sending and caches $version $binding results without fake model fields",
    async (dialect) => {
      const { host, saved } = authority();
      const { remote, calls } = fixture(() => {
        const journal = lastRemote(saved);
        expect(journal.remote.sends[0]).toMatchObject({
          id: "root/send/1",
          status: "running",
          message: { messageId: `${journal.attemptId}/send/1` },
        });
        return completed;
      }, dialect);
      const result = await remote.run("Hello", { host, runId: "root" });
      expect(result).toMatchObject({
        status: "completed",
        output: "Done",
        receipts: [{ kind: "remote", billing: "unknown", action: "send", status: "accepted" }],
      });
      expect(result).not.toHaveProperty("usage");
      expect(result.snapshot).not.toHaveProperty("models");
      expect(result.treeUsage).toEqual(EMPTY_USAGE);
      expect(
        (await remote.resume(JSON.parse(JSON.stringify(result.snapshot)), { host })).status,
      ).toBe("completed");
      expect(calls).toHaveLength(1);
    },
  );

  it("never replays an unknown send on recovery or from a terminal failure", async () => {
    const { host, saved } = authority();
    const { remote, calls } = fixture(() => {
      throw new Error("private peer/key text");
    });
    const result = await remote.run("Hello", { host });
    expect(result).toMatchObject({ status: "failed", error: { code: "remote_unconfirmed" } });
    const intent = saved.find(
      (node) =>
        node.kind === "remote" && node.remote.sends.length === 1 && node.state.status === "running",
    );
    expect(intent).toBeDefined();
    await remote.resume(intent, { host });
    await remote.resume(result.snapshot, { host });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private peer");
  });

  it("reattaches a committed stream through real task IDs after observation loss", async () => {
    const { host, saved } = authority();
    const { remote, calls } = fixture(
      (request) => (request.method === "SendStreamingMessage" ? [working] : [completed]),
      dialects[0],
      { updates: "stream" },
    );
    const result = await remote.run("Hello", { host });
    expect(result.status).toBe("completed");
    expect(calls.map((call) => call.method)).toEqual(["SendStreamingMessage", "SubscribeToTask"]);
    const checkpoint = saved.find(
      (node) => node.kind === "remote" && node.remote.state === "working" && node.remote.taskId,
    );
    const resumed = await remote.resume(checkpoint, { host });
    expect(resumed.status).toBe("completed");
    expect(calls.at(-1)).toMatchObject({ method: "SubscribeToTask", params: { id: "task" } });
    expect(calls.filter((call) => call.method === "SendStreamingMessage")).toHaveLength(1);
  });

  it.each(dialects)(
    "reads a settled $version $binding task when reattachment cannot subscribe",
    async (dialect) => {
      const { host, saved } = authority();
      const { remote, calls } = fixture(
        (request) => {
          if (request.method === "SendStreamingMessage") return [working];
          if (request.method === "SubscribeToTask")
            return new A2AError("protocol", { code: -32004 });
          return completed;
        },
        dialect,
        { updates: "stream" },
      );
      const result = await remote.run("Hello", { host });
      expect(result).toMatchObject({ status: "completed", output: "Done" });
      expect(calls.map((call) => call.method)).toEqual([
        "SendStreamingMessage",
        "SubscribeToTask",
        "GetTask",
      ]);
      const checkpoint = saved.find(
        (node) => node.kind === "remote" && node.remote.taskId && node.remote.state === "working",
      );
      expect(await remote.resume(checkpoint, { host })).toMatchObject({
        status: "completed",
        output: "Done",
      });
      expect(calls.slice(-2).map((call) => call.method)).toEqual(["SubscribeToTask", "GetTask"]);
      expect(calls.filter((call) => call.method === "SendStreamingMessage")).toHaveLength(1);
      checkTree(result.snapshot);
    },
  );

  it("uses the host wake path to reattach after repeated read failures, without another send", async () => {
    vi.useFakeTimers();
    try {
      const { host } = authority();
      let readable = false;
      const { remote, calls } = fixture((request) => {
        if (request.method === "SendMessage") return working;
        if (!readable) throw new Error("Connection lost");
        return completed;
      });
      const running = remote.run("Hi", { host });
      await vi.advanceTimersByTimeAsync(3100);
      const waiting = await running;
      if (waiting.status !== "suspended" || waiting.wakeAt === undefined)
        throw new Error("Missing observation wake");
      expect(waiting.requests).toHaveLength(0);
      expect(wakeAt(waiting.snapshot)).toBe(waiting.wakeAt);
      checkTree(waiting.snapshot);
      const before = calls.length;
      expect((await remote.resume(waiting.snapshot, { host })).status).toBe("suspended");
      expect(calls).toHaveLength(before);
      vi.setSystemTime(waiting.wakeAt);
      readable = true;
      expect(await remote.resume(waiting.snapshot, { host })).toMatchObject({
        status: "completed",
        output: "Done",
      });
      expect(calls.filter((call) => call.method === "SendMessage")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps partial and denied evidence to request-keyed asks before one structured follow-up", async () => {
    const { host, decisions } = authority();
    const { remote, calls } = fixture((request) =>
      request.method === "SendMessage" && calls.length > 1 ? completed : waiting(true),
    );
    const first = await remote.run("Hello", { host });
    if (first.status !== "suspended") throw new Error(JSON.stringify(first));
    expect(first.requests).toHaveLength(2);
    const [a, b] = first.requests;
    if (!a || !b) throw new Error("Missing questions");
    const denied = await remote.resume(first.snapshot, {
      host,
      answers: { [a.id]: "wrong-owner" },
    });
    expect(denied.status).toBe("suspended");
    decisions.set("one", { type: "answer", answer: { text: "Paris" } });
    decisions.set("two", { type: "answer", answer: { text: "Tomorrow" } });
    const partial = await remote.resume(denied.snapshot, { host, answers: { [a.id]: "one" } });
    expect(partial.status).toBe("suspended");
    expect(calls).toHaveLength(1);
    const done = await remote.resume(partial.snapshot, { host, answers: { [b.id]: "two" } });
    expect(done.status).toBe("completed");
    expect(calls[1]).toMatchObject({
      method: "SendMessage",
      params: {
        message: {
          taskId: "task",
          contextId: "context",
          parts: [
            { kind: "text", text: "Paris\nTomorrow" },
            {
              kind: "data",
              data: {
                answers: {
                  first: { type: "answer", answer: { text: "Paris" } },
                  second: { type: "answer", answer: { text: "Tomorrow" } },
                },
              },
            },
          ],
        },
      },
    });
  });

  it("does not call an unconfirmed follow-up accepted just because GetTask succeeds", async () => {
    const { host, decisions, saved } = authority();
    const { remote, calls } = fixture((request) => {
      if (request.method === "SendMessage" && calls.length > 1) throw new Error("lost reply");
      return waiting();
    });
    const first = await remote.run("Hello", { host });
    if (first.status !== "suspended" || !first.requests[0]) throw new Error("Missing question");
    decisions.set("yes", { type: "answer", answer: { text: "Paris" } });
    const result = await remote.resume(first.snapshot, {
      host,
      answers: { [first.requests[0].id]: "yes" },
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "remote_unconfirmed" } });
    expect(result.receipts[1]?.status).toBe("running");
    const intent = saved.find(
      (node) =>
        node.kind === "remote" && node.remote.sends.length === 2 && node.remote.state === "working",
    );
    await remote.resume(intent, { host });
    expect(calls.filter((call) => call.method === "SendMessage")).toHaveLength(2);
  });

  it("uses root-scoped continuation handles and a shared message budget across children", async () => {
    const { host } = authority();
    const { remote, calls } = fixture(() => waiting(), dialects[0], {
      inputRequired: "parent",
      limits: { turns: 2 },
    });
    const flow = defineWorkflow({
      id: "flow",
      version: "1",
      input: { schema: { type: "object" }, validate: () => null },
      agents: [remote],
      async run(_, ctx) {
        const first = await ctx.agent("one", remote, { input: "Start" });
        if (first.status !== "completed" || typeof first.output === "string")
          throw new Error("Missing handle");
        const second = await ctx.agent("two", remote, {
          input: "Paris",
          continue: first.output.handle,
        });
        if (second.status !== "completed" || typeof second.output === "string")
          throw new Error("Missing second handle");
        return (
          await ctx.agent("three", remote, { input: "Again", continue: second.output.handle })
        ).status;
      },
    });
    const result = await flow.run(null, { host });
    expect(result).toMatchObject({ status: "completed", output: "limited" });
    checkTree(result.snapshot);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      params: { message: { taskId: "task", contextId: "context" } },
    });
    await flow.resume(result.snapshot, { host });
    expect(calls).toHaveLength(2);
    await expect(
      remote[AGENT_RUNTIME].create(
        { input: "Wrong", continue: "foreign" },
        "child",
        result.snapshot.tree,
        { host },
        result.snapshot,
      ),
    ).rejects.toThrow(/not open/);
  });

  it.each(["workflow", "delegation"] as const)(
    "admits a parent continuation only once across parallel %s children",
    async (route) => {
      const { host, saved } = authority();
      const bothVerifying = Promise.withResolvers<void>();
      const followupSent = Promise.withResolvers<void>();
      let verifications = 0;
      const { remote, calls } = fixture(
        () => {
          if (calls.length === 1) return waiting();
          followupSent.resolve();
          return completed;
        },
        dialects[0],
        {
          inputRequired: "parent",
          async verifyCard() {
            const visit = ++verifications;
            if (visit === 2) await bothVerifying.promise;
            if (visit === 3) {
              bothVerifying.resolve();
              // Both creates passed preflight; let one dispatch before the other is inserted.
              await followupSent.promise;
            }
          },
        },
      );
      const tool = remote.asTool({ name: "forward", description: "Answer the remote question." });
      const forward = defineAgent({
        id: "forward",
        version: "1",
        instructions: "Forward the supplied remote input.",
        tools: [tool],
        provider: {
          id: "offline",
          model: "fixture",
          async *createStream(messages) {
            const input = messages.find((message) => message.role === "user")?.content;
            if (typeof input !== "string") throw new Error("Missing fixture input");
            yield messages.some((message) => message.role === "tool")
              ? { type: "finish", content: "Done", finishReason: "stop", usage: EMPTY_USAGE }
              : {
                  type: "finish",
                  toolCalls: [{ index: 0, id: "forward", name: tool.name, arguments: input }],
                  finishReason: "tool_calls",
                  usage: EMPTY_USAGE,
                };
          },
        },
      });
      const flow = defineWorkflow({
        id: "parallel-continuation",
        version: "1",
        input: { schema: { type: "object" }, validate: () => null },
        agents: [remote, forward],
        async run(_, ctx) {
          const first = await ctx.agent("start", remote, { input: "Start" });
          if (first.status !== "completed" || typeof first.output === "string")
            throw new Error("Missing continuation handle");
          const input = { input: "Paris", continue: first.output.handle };
          await Promise.all(
            ["left", "right"].map((key) =>
              route === "workflow"
                ? ctx.agent(key, remote, input)
                : ctx.agent(key, forward, JSON.stringify(input)),
            ),
          );
          return "Done";
        },
      });
      const result = await flow.run(null, { host });
      expect(result.status).toBe("failed");
      expect(calls.map((call) => call.method)).toEqual(["SendMessage", "SendMessage"]);
      expect(
        [...snapshots(result.snapshot)].filter(
          (node) => node.kind === "remote" && node.input.continue,
        ),
      ).toHaveLength(1);
      for (const checkpoint of saved) checkTree(checkpoint);
      await expect(flow.resume(result.snapshot, { host })).resolves.toMatchObject({
        status: "failed",
      });
      expect(calls).toHaveLength(2);
    },
  );

  it("requires registered remote children and keeps mixed workflow/local/remote identity", async () => {
    const { host } = authority();
    const { remote, calls } = fixture(() => completed);
    const provider: Provider = {
      id: "offline",
      model: "fixture",
      async *createStream() {
        yield { type: "finish", content: "Local", finishReason: "stop", usage: EMPTY_USAGE };
      },
    };
    const local = defineAgent({
      id: "local",
      version: "1",
      provider,
      instructions: "Return fixture text.",
    });
    const nested = defineWorkflow({
      id: "nested",
      version: "1",
      input: { schema: { type: "object" }, validate: () => null },
      async run() {
        return "Nested";
      },
    });
    const flow = defineWorkflow({
      id: "mixed",
      version: "1",
      input: { schema: { type: "object" }, validate: () => null },
      agents: [local, remote],
      workflows: [nested],
      async run(_, ctx) {
        return [
          (await ctx.agent("a", local, "Hi")).status,
          (await ctx.agent("r", remote, { input: "Hi" })).status,
          (await ctx.workflow("w", nested, null)).status,
        ];
      },
    });
    const result = await flow.run(null, { host });
    expect(result.status).toBe("completed");
    expect(result.snapshot.steps.flatMap((s) => s.children.map((c) => c.snapshot.kind))).toEqual([
      "agent",
      "remote",
      "workflow",
    ]);
    expect(calls).toHaveLength(1);
    const tool = remote.asTool({ name: "remote_tool", description: "Host-written purpose." });
    expect(tool.definition().description).not.toContain("card prose");
    const parentProvider: Provider = {
      ...provider,
      async *createStream(messages) {
        yield messages.some((m) => m.role === "tool")
          ? { type: "finish", content: "Parent", finishReason: "stop", usage: EMPTY_USAGE }
          : {
              type: "finish",
              toolCalls: [
                { index: 0, id: "remote-call", name: tool.name, arguments: '{"input":"Hi"}' },
              ],
              finishReason: "tool_calls",
              usage: EMPTY_USAGE,
            };
      },
    };
    const parent = defineAgent({
      id: "parent",
      version: "1",
      provider: parentProvider,
      instructions: "Call the specialist.",
      treeLimits: { maxParallel: 1 },
      tools: [tool],
    });
    const done = await parent.run("Hi", { host });
    expect(done.status).toBe("completed");
    checkTree(done.snapshot);
    const unregistered = defineDelegation({
      name: "bad",
      description: "Not granted.",
      inputSchema: { type: "object" },
      validate: () => null,
      specialists: [],
      async run(_, ctx) {
        return ctx.child("r", remote, { input: "Hi" }).join();
      },
    });
    const bad = defineAgent({
      id: "bad",
      version: "1",
      provider: {
        ...parentProvider,
        async *createStream() {
          yield {
            type: "finish",
            toolCalls: [{ index: 0, id: "bad", name: "bad", arguments: "{}" }],
            finishReason: "tool_calls",
            usage: EMPTY_USAGE,
          };
        },
      },
      instructions: "Fixture",
      tools: [unregistered],
    });
    expect(await bad.run("Hi", { host })).toMatchObject({
      status: "failed",
      error: { code: "unregistered_specialist" },
    });
  });

  it("separates observation abort from an authenticated, journaled, one-shot CancelTask", async () => {
    const { host, saved } = authority();
    const controller = new AbortController();
    const { remote, calls } = fixture((request) => {
      if (request.method === "CancelTask") throw new Error("unknown cancel response");
      return waiting();
    });
    const first = await remote.run("Hi", { host });
    controller.abort(new Error("user Stop text is not authority"));
    expect((await remote.resume(first.snapshot, { host, signal: controller.signal })).status).toBe(
      "cancelled",
    );
    expect(calls).toHaveLength(1);
    const deniedHost = {
      ...host,
      authorizeResume() {
        throw new Error("Wrong owner");
      },
    };
    await expect(remote.cancel(first.snapshot, { host: deniedHost })).rejects.toThrow(
      /Wrong owner/,
    );
    const cancelled = await remote.cancel(first.snapshot, { host });
    expect(cancelled.remote.cancel).toMatchObject({ status: "running" });
    expect(
      saved.some((node) => node.kind === "remote" && node.remote.cancel?.status === "running"),
    ).toBe(true);
    await remote.cancel(cancelled, { host });
    expect(calls.filter((call) => call.method === "CancelTask")).toHaveLength(1);
  });

  it("refuses peer approval requests and stale evidence without granting a tool", async () => {
    const { host, decisions } = authority();
    const task = waiting(true);
    if (task.status.message)
      task.status.message.parts = [
        {
          kind: "data",
          data: {
            requests: [{ id: "approval", type: "approval", message: "Run privileged tool" }],
          },
        },
      ];
    const unsupported = fixture((request) =>
      request.method === "CancelTask" ? { ...working, status: { state: "canceled" } } : task,
    );
    const refused = await unsupported.remote.run("Hi", { host });
    expect(refused).toMatchObject({
      status: "failed",
      error: { code: "remote_request_unsupported" },
      snapshot: {
        remote: { taskId: "task", contextId: "context", sends: [{ status: "accepted" }] },
      },
    });
    checkTree(refused.snapshot);
    const cancelled = await unsupported.remote.cancel(refused.snapshot, { host });
    expect(cancelled.remote.cancel).toMatchObject({ status: "accepted", state: "canceled" });
    checkTree(cancelled);
    await unsupported.remote.cancel(cancelled, { host });
    await unsupported.remote.resume(refused.snapshot, { host });
    expect(unsupported.calls.map((call) => call.method)).toEqual(["SendMessage", "CancelTask"]);
    const { remote, calls } = fixture(() => waiting());
    const first = await remote.run("Hi", { host });
    if (first.status !== "suspended" || !first.requests[0]) throw new Error("Missing question");
    decisions.set("yes", { type: "answer", answer: { text: "Paris" } });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(first.requests[0].scope.expiresAt + 1);
      const result = await remote.resume(first.snapshot, {
        host,
        answers: { [first.requests[0].id]: "yes" },
      });
      expect(result.status).toBe("suspended");
      expect(calls).toHaveLength(1);
      expect(host.resolveRequest).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects corrupt snapshots and removed or rewritten send receipts", async () => {
    const { host } = authority();
    const { remote } = fixture(() => completed);
    const result = await remote.run("Hi", { host });
    for (const mutate of [
      (s: RemoteSnapshot) => {
        s.remote.sends = [];
      },
      (s: RemoteSnapshot) => {
        s.remote.taskId = "other";
        s.remote.sends[0]!.message.taskId = "other";
      },
      (s: RemoteSnapshot) => {
        if (s.state.status === "completed") s.state.candidate = "forged";
      },
      (s: RemoteSnapshot) => {
        s.remote.artifacts[0]!.parts = [{ kind: "url", url: "http://127.0.0.1/private" }];
      },
    ]) {
      const corrupt = structuredClone(result.snapshot);
      mutate(corrupt);
      expect(() => checkChildProgress(result.snapshot, corrupt)).toThrow();
    }
    const corrupt = structuredClone(result.snapshot);
    corrupt.remote.sends = [];
    await expect(remote.resume(corrupt, { host })).rejects.toThrow();
  });

  it("requires current host authority and a successful pre-send checkpoint", async () => {
    const { host, saved } = authority();
    const { remote, calls } = fixture(() => completed);
    const noAuthority = await remote.run("Hi");
    expect(noAuthority).toMatchObject({
      status: "failed",
      error: { code: "remote_authority_missing" },
    });
    const revoked = await remote.run("Hi", {
      host: {
        ...host,
        beforeTool() {
          throw new Error("revoked secret");
        },
      },
    });
    expect(revoked).toMatchObject({ status: "failed", error: { code: "remote_authority_denied" } });
    expect(JSON.stringify(revoked)).not.toContain("revoked secret");
    const failed = await remote.run("Hi", {
      host: {
        ...host,
        checkpoint(snapshot) {
          saved.push(structuredClone(snapshot));
          if (snapshot.kind === "remote" && snapshot.remote.sends.length)
            throw new Error("commit reply lost");
        },
      },
    });
    expect(failed).toMatchObject({ status: "failed", error: { code: "checkpoint_failed" } });
    expect(calls).toHaveLength(0);
    await remote.resume(lastRemote(saved), { host });
    expect(calls).toHaveLength(0);
  });

  it("cancels one unanswered batch only from a current authenticated decision", async () => {
    const { host, decisions } = authority();
    const { remote, calls } = fixture((request) =>
      request.method === "CancelTask"
        ? { ...working, status: { state: "canceled" } }
        : waiting(true),
    );
    const first = await remote.run("Hi", { host });
    if (first.status !== "suspended" || !first.requests[0]) throw new Error("Missing question");
    decisions.set("cancel", { type: "cancel" });
    const stopped = await remote.resume(first.snapshot, {
      host,
      answers: { [first.requests[0].id]: "cancel" },
    });
    expect(stopped.snapshot.remote.cancel).toMatchObject({ status: "accepted", state: "canceled" });
    expect(calls.map((call) => call.method)).toEqual(["SendMessage", "CancelTask"]);
    await remote.cancel(stopped.snapshot, { host });
    expect(calls).toHaveLength(2);
  });

  it("keeps one-shot cancellation separate from an immutable parent result", async () => {
    const { host } = authority();
    const { remote, calls } = fixture(
      (request) =>
        request.method === "CancelTask" ? { ...working, status: { state: "canceled" } } : waiting(),
      dialects[0],
      { inputRequired: "parent" },
    );
    const first = await remote.run("Hi", { host });
    const next = await remote.cancel(first.snapshot, { host });
    checkChildProgress(first.snapshot, next);
    checkTree(next);
    expect(next.remote.cancel?.state).toBe("canceled");
    await remote.cancel(next, { host });
    expect(calls).toHaveLength(2);
  });

  it("keeps wire message IDs bounded even for deeply nested logical IDs", async () => {
    const { host } = authority();
    const { remote, calls } = fixture(() => completed);
    const result = await remote.run("Hi", { host, runId: "nested/".repeat(80) });
    expect(result.status).toBe("completed");
    const call = calls[0];
    if (call?.method !== "SendMessage") throw new Error("Missing send");
    expect(call.params.message.messageId.length).toBeLessThanOrEqual(128);
    await remote.resume(result.snapshot, { host });
    expect(calls).toHaveLength(1);
  });

  it("supports host-validated inline image output and refuses a lower image byte limit", async () => {
    const { host } = authority();
    const { config } = fixture(() => ({
      ...completed,
      artifacts: [
        { artifactId: "image", parts: [{ kind: "raw", raw: "YQ", mediaType: "image/png" }] },
      ],
    }));
    const output = {
      schema: { type: "object" as const, properties: { content: { type: "array" } } },
      validate(value: unknown) {
        if (!isRecord(value)) throw new Error("Expected content");
        return readContent(value.content, "Output");
      },
    };
    const remote = defineRemoteAgent({ ...config, includeImages: true, output });
    const result = await remote.run("Hi", { host });
    expect(result).toMatchObject({
      status: "completed",
      output: [{ type: "image", mimeType: "image/png", data: "YQ==" }],
    });
    await remote.resume(result.snapshot, { host });
    const small = defineRemoteAgent({
      ...config,
      includeImages: true,
      output,
      limits: { inlineBytes: 0 },
    });
    expect(await small.run("Hi", { host })).toMatchObject({
      status: "failed",
      error: { code: "remote_result_too_large" },
    });
  });

  it("authorizes media, bounds bytes and keeps peer URLs and metadata out of results", async () => {
    const { host } = authority();
    const { remote, calls } = fixture(() => ({
      ...completed,
      metadata: { secret: "hidden" },
      artifacts: [
        {
          artifactId: "files",
          parts: [
            { kind: "url", url: "http://127.0.0.1/private", filename: "map.png" },
            { kind: "text", text: "Safe", metadata: { secret: "hidden" } },
          ],
        },
      ],
    }));
    const result = await remote.run([{ type: "media", id: "owned", mimeType: "image/png" }], {
      host: { ...host, loadMedia: () => "YQ==" },
    });
    expect(result).toMatchObject({ status: "completed", output: "[File: map.png]Safe" });
    expect(calls[0]).toMatchObject({
      params: { message: { parts: [{ kind: "raw", raw: "YQ==", mediaType: "image/png" }] } },
    });
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    const small = fixture(() => completed, dialects[0], { limits: { inlineBytes: 0 } });
    await expect(
      small.remote.run([{ type: "image", mimeType: "image/png", data: "YQ==" }], { host }),
    ).rejects.toThrow(/byte limit/);
    expect(small.calls).toHaveLength(0);
    const large = fixture(
      () => ({
        ...completed,
        artifacts: [{ artifactId: "big", parts: [{ kind: "text", text: "x".repeat(3000) }] }],
      }),
      dialects[0],
      { limits: { resultBytes: 100 } },
    );
    expect((await large.remote.run("Hi", { host })).status).toBe("failed");
  });
});
