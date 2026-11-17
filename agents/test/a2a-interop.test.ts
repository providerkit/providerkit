import { describe, expect, it, vi } from "vitest";
import {
  AgentCard,
  GetTaskRequest,
  SendMessageRequest,
  Task,
  TaskState,
  TaskStatusUpdateEvent,
  formatSSEEvent,
} from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory, RestTransportFactory } from "@a2a-js/sdk/client";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import { LegacyJsonRpcTransportHandler } from "@a2a-js/sdk/compat/v0_3/server";
import { createA2AClient, decodeA2AHttpRequest } from "../src/a2a/client.ts";
import {
  decodeA2ARpcRequest,
  encodeA2AResult,
  encodeA2AError,
  type A2ADialect,
  type A2ARequest,
  type A2ATask,
  type A2AVersion,
} from "../src/a2a/wire.ts";

const endpoint = "https://peer.test/a2a";
const versions: A2AVersion[] = ["1.0", "0.3"];
const task: A2ATask = {
  kind: "task",
  id: "task",
  contextId: "context",
  status: { state: "completed" },
  artifacts: [{ artifactId: "answer", parts: [{ kind: "text", text: "Done" }] }],
};
function card(dialect: A2ADialect) {
  return AgentCard.fromJSON({
    name: "Offline fixture",
    description: "No provider calls.",
    version: "1",
    supportedInterfaces: [
      { url: endpoint, protocolBinding: dialect.binding, protocolVersion: dialect.version },
    ],
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "read", name: "Read", description: "Read fixture data.", tags: ["offline"] }],
  });
}

// This exercises real SDK serializers/handlers with an in-memory fetch. It is not a
// production server, authentication scheme or proof of the later run-store integration.
describe("official A2A SDK interoperability", () => {
  it.each(versions)(
    "calls the official %s JSON-RPC handler without adapting its response",
    async (version) => {
      const executed = vi.fn();
      const handler = new DefaultRequestHandler(
        card({ version, binding: "JSONRPC" }),
        new InMemoryTaskStore(),
        {
          async execute(context, bus) {
            executed(context.userMessage);
            bus.publish(
              AgentEvent.task(
                Task.fromJSON({
                  id: context.taskId,
                  contextId: context.contextId,
                  status: { state: "TASK_STATE_WORKING" },
                }),
              ),
            );
            bus.publish(
              AgentEvent.statusUpdate(
                TaskStatusUpdateEvent.fromJSON({
                  taskId: context.taskId,
                  contextId: context.contextId,
                  status: { state: "TASK_STATE_COMPLETED" },
                }),
              ),
            );
            bus.finished();
          },
          async cancelTask() {
            throw new Error("This fixture never cancels a task.");
          },
        },
      );
      const rpc =
        version === "1.0"
          ? new JsonRpcTransportHandler(handler)
          : new LegacyJsonRpcTransportHandler(handler);
      const fetchImpl: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const response = await rpc.handle(
          await request.text(),
          new ServerCallContext({
            requestedVersion: version,
            user: { isAuthenticated: true, userName: "fixture" },
          }),
        );
        if (Symbol.asyncIterator in response) {
          let frames = "";
          for await (const event of response) frames += formatSSEEvent(event);
          return new Response(frames, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json(response);
      };
      const client = createA2AClient({
        endpoint,
        version,
        binding: "JSONRPC",
        fetch: fetchImpl,
        policy: { allow: (url) => url.origin === new URL(endpoint).origin },
      });
      const message = {
        kind: "message" as const,
        messageId: "message",
        role: "user" as const,
        parts: [{ kind: "text" as const, text: "Work" }],
      };
      const result = await client.call("SendMessage", { message });
      expect(result).toMatchObject({ kind: "task", status: { state: "completed" } });
      if (result.kind !== "task") throw new Error("Expected a task");
      expect(await client.call("GetTask", { id: result.id, historyLength: 0 })).toMatchObject({
        id: result.id,
        status: { state: "completed" },
      });
      const events = [];
      for await (const event of client.observe("SendStreamingMessage", {
        message: { ...message, messageId: "stream" },
      }))
        events.push(event);
      expect(events[0]?.kind).toBe("task");
      expect(events.at(-1)).toMatchObject({
        kind: "status-update",
        status: { state: "completed" },
      });
      expect(executed).toHaveBeenCalledTimes(2);
      await expect(client.call("GetTask", { id: "missing" })).rejects.toMatchObject({
        code: -32001,
      });
    },
  );

  for (const version of versions) {
    for (const binding of ["JSONRPC", "HTTP+JSON"] as const) {
      it(`accepts official ${version} ${binding} requests and returns readable results/errors`, async () => {
        const dialect = { version, binding };
        const received: A2ARequest[] = [];
        const fetchImpl: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          let requestId: string | number | null = null;
          let decoded: A2ARequest;
          if (binding === "JSONRPC") {
            const rpc = decodeA2ARpcRequest(await request.json(), version);
            requestId = rpc.id;
            decoded = rpc.request;
          } else decoded = await decodeA2AHttpRequest(request, { baseUrl: endpoint, version });
          received.push(decoded);
          if (decoded.method === "GetTask" && decoded.params.id === "missing") {
            const error = encodeA2AError(-32001, dialect, requestId);
            return Response.json(error.body, { status: error.status });
          }
          if (decoded.method !== "SendMessage" && decoded.method !== "GetTask")
            throw new Error("Unexpected fixture method");
          const result = encodeA2AResult({ method: decoded.method, result: task }, dialect);
          return Response.json(
            binding === "JSONRPC" ? { jsonrpc: "2.0", id: requestId, result } : result,
          );
        };
        const transport =
          binding === "JSONRPC"
            ? new JsonRpcTransportFactory({ fetchImpl, legacyCompat: { enabled: true } })
            : new RestTransportFactory({ fetchImpl, legacyCompat: { enabled: true } });
        const official = await new ClientFactory({ transports: [transport] }).createFromAgentCard(
          card(dialect),
        );
        const result = await official.sendMessage(
          SendMessageRequest.fromJSON({
            message: { messageId: "message", role: "ROLE_USER", parts: [{ text: "Work" }] },
          }),
        );
        expect(result).toMatchObject({
          id: "task",
          status: { state: TaskState.TASK_STATE_COMPLETED },
        });
        expect(received[0]).toMatchObject({
          method: "SendMessage",
          params: { message: { role: "user", parts: [{ kind: "text", text: "Work" }] } },
        });
        expect(
          await official.getTask(GetTaskRequest.fromJSON({ id: "task", historyLength: 1 })),
        ).toMatchObject({ id: "task" });
        expect(received[1]).toMatchObject({
          method: "GetTask",
          params: { id: "task", historyLength: 1 },
        });
        await expect(
          official.getTask(GetTaskRequest.fromJSON({ id: "missing" })),
        ).rejects.toMatchObject({ name: "TaskNotFoundError", reason: "TASK_NOT_FOUND" });
        expect(received).toHaveLength(3);
      });
    }
  }
});
