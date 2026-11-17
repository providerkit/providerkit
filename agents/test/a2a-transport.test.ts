import { describe, expect, it, vi } from "vitest";
import { type FetchLike } from "@providerkit/core";
import { authenticateA2A, bearerToken } from "../src/a2a/auth.ts";
import {
  createA2AClient,
  decodeA2AHttpRequest,
  encodeA2AHttpRequest,
  fetchA2AAgentCard,
  readA2AJson,
} from "../src/a2a/client.ts";
import {
  a2aCardUrl,
  checkA2AEndpoint,
  selectA2AInterface,
  type A2AEndpointPolicy,
} from "../src/a2a/policy.ts";
import {
  A2AError,
  createA2AStreamTracker,
  decodeA2AAgentCard,
  decodeA2AEvent,
  decodeA2AMessage,
  decodeA2ARequest,
  decodeA2AResult,
  decodeA2ARpcRequest,
  decodeA2ARpcResponse,
  decodeA2ATask,
  encodeA2AError,
  encodeA2AEvent,
  encodeA2AMessage,
  encodeA2ARequest,
  encodeA2AResult,
  encodeA2ATask,
  parseA2AJson,
  type A2ADialect,
  type A2AEvent,
  type A2AMessage,
  type A2AObject,
  type A2ARequest,
  type A2ATask,
  type A2AVersion,
} from "../src/a2a/wire.ts";

const dialects: A2ADialect[] = [
  { version: "1.0", binding: "JSONRPC" },
  { version: "1.0", binding: "HTTP+JSON" },
  { version: "0.3", binding: "JSONRPC" },
  { version: "0.3", binding: "HTTP+JSON" },
];
const policy: A2AEndpointPolicy = { allow: () => true };
const endpoint = "https://peer.example/a2a";
const user: A2AMessage = {
  kind: "message",
  role: "user",
  messageId: "message-1",
  parts: [{ kind: "text", text: "Hello" }],
};
const working: A2ATask = {
  kind: "task",
  id: "task-1",
  contextId: "context-1",
  status: { state: "working" },
};
const complete: A2AEvent = {
  kind: "status-update",
  taskId: "task-1",
  contextId: "context-1",
  status: { state: "completed" },
  final: true,
};
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
function card(version: A2AVersion, url = endpoint): A2AObject {
  return {
    name: "Peer",
    description: "Answers questions.",
    version: "1",
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    ...(version === "1.0"
      ? { supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] }
      : { protocolVersion: "0.3.0", url, preferredTransport: "JSONRPC" }),
  };
}
function sse(
  events: A2AEvent[],
  d: A2ADialect,
  options: { end?: boolean; suffix?: string; id?: string; split?: boolean } = {},
) {
  let canceled = 0;
  let source: ReadableStreamDefaultController<Uint8Array>;
  const text =
    events
      .map((event) => {
        const result = encodeA2AEvent(event, d);
        const data =
          d.binding === "JSONRPC" ? { jsonrpc: "2.0", id: options.id ?? "rpc-1", result } : result;
        return `data: ${JSON.stringify(data)}\r\n\r\n`;
      })
      .join("") + (options.suffix ?? "");
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      if (options.split)
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      else if (bytes.length) controller.enqueue(bytes);
      if (options.end) controller.close();
    },
    cancel() {
      canceled++;
    },
  });
  return {
    body,
    canceled: () => canceled,
    fail: () => source.error(new Error("SECRET socket details")),
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
  };
}

function peer(d: A2ADialect, result: A2ATask = working): FetchLike {
  return async (url, init) => {
    const request = new Request(url, init);
    const decoded =
      d.binding === "JSONRPC"
        ? decodeA2ARpcRequest(await readA2AJson(request), d.version)
        : {
            id: "",
            request: await decodeA2AHttpRequest(request, { baseUrl: endpoint, version: d.version }),
          };
    const payload =
      decoded.request.method === "SendMessage"
        ? encodeA2AResult({ method: "SendMessage", result }, d)
        : encodeA2ATask(result, d);
    return json(
      d.binding === "JSONRPC" ? { jsonrpc: "2.0", id: decoded.id, result: payload } : payload,
    );
  };
}

describe.each(dialects)("A2A $version $binding", (d) => {
  it("uses the exact wire dialect, including legacy REST content and enum names", () => {
    const message: A2AMessage = {
      ...user,
      parts: [
        { kind: "text", text: "Hello" },
        { kind: "data", data: { answer: 42 } },
        { kind: "raw", raw: "YQ==", mediaType: "text/plain" },
      ],
    };
    const wire = encodeA2AMessage(message, d);
    if (d.version === "0.3" && d.binding === "JSONRPC") {
      expect(wire).toEqual({
        kind: "message",
        messageId: "message-1",
        role: "user",
        parts: [
          { kind: "text", text: "Hello" },
          { kind: "data", data: { answer: 42 } },
          { kind: "file", file: { bytes: "YQ==", mimeType: "text/plain" } },
        ],
      });
    } else if (d.version === "0.3") {
      expect(wire).toEqual({
        messageId: "message-1",
        role: "ROLE_USER",
        content: [
          { text: "Hello" },
          { data: { data: { answer: 42 } } },
          { file: { fileWithBytes: "YQ==", mimeType: "text/plain" } },
        ],
      });
    } else {
      expect(wire).toEqual({
        messageId: "message-1",
        role: "ROLE_USER",
        parts: [
          { text: "Hello" },
          { data: { answer: 42 } },
          { raw: "YQ==", mediaType: "text/plain" },
        ],
      });
    }
    expect(decodeA2AMessage(wire, d)).toMatchObject(message);
    const status = encodeA2ATask({ ...working, status: { state: "canceled" } }, d).status;
    expect(status).toEqual({
      state:
        d.version === "1.0"
          ? "TASK_STATE_CANCELED"
          : d.binding === "JSONRPC"
            ? "canceled"
            : "TASK_STATE_CANCELLED",
    });
    const params = encodeA2ARequest(
      {
        method: "SendMessage",
        params: { message: user, configuration: { returnImmediately: true, historyLength: 1 } },
      },
      d,
    );
    expect(params.params.configuration).toEqual(
      d.version === "1.0"
        ? { returnImmediately: true, historyLength: 1 }
        : { blocking: false, historyLength: 1 },
    );
    expect(decodeA2ARequest(params.method, params.params, d).params).toMatchObject({
      message: user,
      configuration: { returnImmediately: true, historyLength: 1 },
    });
  });

  it("exchanges offline Requests and Responses without a runtime dependency", async () => {
    const fetcher = vi.fn(peer(d));
    const client = createA2AClient({
      ...d,
      endpoint,
      policy,
      fetch: fetcher,
      headers: () => ({ authorization: "Bearer SECRET", traceparent: "host-trace" }),
    });
    expect(await client.call("SendMessage", { message: user })).toMatchObject(working);
    expect(await client.call("GetTask", { id: working.id, historyLength: 1 })).toMatchObject(
      working,
    );
    expect(await client.call("CancelTask", { id: working.id })).toMatchObject(working);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", credentials: "omit" });
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("a2a-version")).toBe(d.version);
    expect(headers.get("traceparent")).toBe("host-trace");
    expect(headers.get("authorization")).toBe("Bearer SECRET");
  });

  it("applies outgoing part and text limits before fetching", async () => {
    for (const limits of [{ parts: 1 }, { textChars: 1 }]) {
      const fetcher = vi.fn(peer(d));
      const client = createA2AClient({ ...d, endpoint, policy, fetch: fetcher, limits });
      const message: A2AMessage = { ...user, parts: [...user.parts, ...user.parts] };
      await expect(client.call("SendMessage", { message })).rejects.toMatchObject({
        kind: "invalid",
        outcome: "not-sent",
      });
      await expect(
        client.observe("SendStreamingMessage", { message }).next(),
      ).rejects.toMatchObject({ kind: "invalid", outcome: "not-sent" });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("allows update-first subscriptions only in 0.3, never update-first sends", async () => {
    const stream = sse([complete], d);
    const observation = createA2AClient({
      ...d,
      endpoint,
      policy,
      fetch: async () => stream.response,
    }).observe("SubscribeToTask", { id: working.id }, { requestId: "rpc-1" });
    if (d.version === "0.3") {
      expect((await observation.next()).value).toMatchObject(complete);
      expect(await observation.next()).toMatchObject({ done: true });
    } else await expect(observation.next()).rejects.toMatchObject({ kind: "invalid" });
    expect(stream.body.locked).toBe(false);
    expect(stream.canceled()).toBe(1);

    const send = sse([complete], d);
    const sending = createA2AClient({
      ...d,
      endpoint,
      policy,
      fetch: async () => send.response,
    }).observe("SendStreamingMessage", { message: user }, { requestId: "rpc-1" });
    await expect(sending.next()).rejects.toMatchObject({ kind: "invalid" });
    expect(send.canceled()).toBe(1);
  });

  it("encodes errors in the selected wire dialect", () => {
    const encoded = encodeA2AError(-32001, d, "rpc-1");
    if (d.binding === "JSONRPC") {
      expect(encoded).toEqual({
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: "rpc-1",
          error: { code: -32001, message: "Task not found" },
        },
      });
    } else if (d.version === "0.3") {
      expect(encoded).toEqual({ status: 404, body: { code: -32001, message: "Task not found" } });
    } else {
      expect(encoded).toEqual({
        status: 404,
        body: {
          error: {
            code: 404,
            message: "Task not found",
            status: "NOT_FOUND",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                domain: "a2a-protocol.org",
                reason: "TASK_NOT_FOUND",
              },
            ],
          },
        },
      });
    }
  });

  it("streams split CRLF frames and releases the reader at completion", async () => {
    const stream = sse(
      [
        working,
        {
          kind: "artifact-update",
          taskId: working.id,
          contextId: working.contextId!,
          artifact: { artifactId: "answer", parts: [{ kind: "text", text: "One" }] },
          append: false,
        },
        {
          kind: "artifact-update",
          taskId: working.id,
          contextId: working.contextId!,
          artifact: { artifactId: "answer", parts: [{ kind: "text", text: " two" }] },
          append: true,
          lastChunk: true,
        },
        complete,
      ],
      d,
      { split: true },
    );
    const fetcher = vi.fn(async () => stream.response);
    const client = createA2AClient({ ...d, endpoint, policy, fetch: fetcher });
    const events = [];
    for await (const event of client.observe(
      "SendStreamingMessage",
      { message: user },
      { requestId: "rpc-1" },
    ))
      events.push(event);
    expect(events.map((e) => e.kind)).toEqual([
      "task",
      "artifact-update",
      "artifact-update",
      "status-update",
    ]);
    expect(stream.body.locked).toBe(false);
    expect(stream.canceled()).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats EOF and malformed frames as an unknown mutation outcome without replay", async () => {
    for (const suffix of ["", "data: not-json\n\n", "data: [DONE]\n\n"]) {
      const stream = sse([working], d, { suffix, end: true });
      const fetcher = vi.fn(async () => stream.response);
      const observation = createA2AClient({ ...d, endpoint, policy, fetch: fetcher }).observe(
        "SendStreamingMessage",
        { message: user },
        { requestId: "rpc-1" },
      );
      expect((await observation.next()).value).toMatchObject(working);
      await expect(observation.next()).rejects.toMatchObject({
        outcome: "unknown",
        retryable: false,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(stream.body.locked).toBe(false);
    }
  });

  it("ends at interrupted states, not at lastChunk, and refuses changed identities", async () => {
    const interrupted = {
      ...complete,
      kind: "status-update",
      status: { state: "input_required" },
      final: true,
    } satisfies A2AEvent;
    const stream = sse([working, interrupted], d);
    const client = createA2AClient({ ...d, endpoint, policy, fetch: async () => stream.response });
    const events = [];
    for await (const event of client.observe(
      "SubscribeToTask",
      { id: working.id },
      { requestId: "rpc-1" },
    ))
      events.push(event);
    expect(events).toHaveLength(2);
    expect(stream.canceled()).toBe(1);
    const wrong = sse([working, { ...interrupted, contextId: "other" }], d);
    const observer = createA2AClient({
      ...d,
      endpoint,
      policy,
      fetch: async () => wrong.response,
    }).observe("SubscribeToTask", { id: working.id }, { requestId: "rpc-1" });
    await observer.next();
    await expect(observer.next()).rejects.toMatchObject({ kind: "invalid", outcome: "read" });
    expect(wrong.body.locked).toBe(false);
    expect(wrong.canceled()).toBe(1);
  });

  it("closes a pending read without canceling the remote task", async () => {
    const stream = sse([working], d);
    const fetcher = vi.fn(async () => stream.response);
    const observation = createA2AClient({ ...d, endpoint, policy, fetch: fetcher }).observe(
      "SubscribeToTask",
      { id: working.id },
      { requestId: "rpc-1" },
    );
    await observation.next();
    const pending = observation.next();
    await observation.close();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(stream.canceled()).toBe(1);
    expect(stream.body.locked).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves the exact caller abort and cancels the body once", async () => {
    const controller = new AbortController();
    const reason = new Error("Caller stopped observing");
    const stream = sse([working], d);
    const fetcher = vi.fn(async () => stream.response);
    const observation = createA2AClient({ ...d, endpoint, policy, fetch: fetcher }).observe(
      "SubscribeToTask",
      { id: working.id },
      { signal: controller.signal, requestId: "rpc-1" },
    );
    await observation.next();
    const next = observation.next();
    controller.abort(reason);
    await expect(next).rejects.toBe(reason);
    expect(stream.body.locked).toBe(false);
    expect(stream.canceled()).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never retries mutations on HTTP failures, malformed responses or socket errors", async () => {
    const responses = [
      () => json({ error: { message: "SECRET" } }, 401),
      () => json({}, 429),
      () => json({}, 503),
      () => json({ bad: "SECRET" }),
      () => {
        throw new Error("SECRET socket URL and credentials");
      },
    ];
    const operations: Extract<
      A2ARequest,
      {
        method:
          | "SendMessage"
          | "CancelTask"
          | "CreateTaskPushNotificationConfig"
          | "DeleteTaskPushNotificationConfig";
      }
    >[] = [
      { method: "SendMessage", params: { message: user } },
      { method: "CancelTask", params: { id: working.id } },
      {
        method: "CreateTaskPushNotificationConfig",
        params: { taskId: working.id, id: "push-1", url: "https://receiver.example/hook" },
      },
      { method: "DeleteTaskPushNotificationConfig", params: { taskId: working.id, id: "push-1" } },
    ];
    for (const reply of responses)
      for (const operation of operations) {
        const fetcher = vi.fn(async () => reply());
        const client = createA2AClient({ ...d, endpoint, policy, fetch: fetcher });
        const error = await client
          .call(operation.method, operation.params)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(A2AError);
        expect(error).toMatchObject({ outcome: "unknown", retryable: false });
        expect(String(error) + JSON.stringify(error)).not.toContain("SECRET");
        expect(fetcher).toHaveBeenCalledTimes(1);
      }
  });

  it("accepts a message-only answer and closes on the first event", async () => {
    const answer: A2AMessage = {
      ...user,
      role: "agent",
      contextId: "context-1",
      parts: [{ kind: "text", text: "Answer" }],
    };
    const stream = sse([answer], d);
    const observer = createA2AClient({
      ...d,
      endpoint,
      policy,
      fetch: async () => stream.response,
    }).observe("SendStreamingMessage", { message: user }, { requestId: "rpc-1" });
    expect((await observer.next()).value).toMatchObject(answer);
    expect(stream.canceled()).toBe(1);
    expect(stream.body.locked).toBe(false);
    expect(await observer.next()).toMatchObject({ done: true });
  });

  it("keeps protocol errors arriving over SSE secret-safe", async () => {
    const error = encodeA2AError(-32001, d, "rpc-1").body;
    const stream = sse([working], d, { suffix: `data: ${JSON.stringify(error)}\n\n` });
    const observer = createA2AClient({
      ...d,
      endpoint,
      policy,
      fetch: async () => stream.response,
    }).observe("SubscribeToTask", { id: working.id }, { requestId: "rpc-1" });
    await observer.next();
    await expect(observer.next()).rejects.toMatchObject({ code: -32001, outcome: "read" });
    expect(stream.body.locked).toBe(false);
    expect(stream.canceled()).toBe(1);
  });

  it("refuses responses for a different task or push configuration", async () => {
    const wrongTask = createA2AClient({
      ...d,
      endpoint,
      policy,
      fetch: peer(d, { ...working, id: "other" }),
    });
    await expect(wrongTask.call("GetTask", { id: working.id })).rejects.toMatchObject({
      kind: "invalid",
    });
    const config = encodeA2AResult(
      {
        method: "GetTaskPushNotificationConfig",
        result: { taskId: working.id, id: "other", url: "https://receiver.example/hook" },
      },
      d,
    );
    const client = createA2AClient({
      ...d,
      endpoint,
      policy,
      fetch: async () =>
        json(d.binding === "JSONRPC" ? { jsonrpc: "2.0", id: "rpc-1", result: config } : config),
    });
    await expect(
      client.call(
        "GetTaskPushNotificationConfig",
        { taskId: working.id, id: "push-1" },
        { requestId: "rpc-1" },
      ),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("reports structured RPC/REST errors without the peer's words", async () => {
    const encoded = encodeA2AError(-32001, d, "rpc-1");
    const fetcher = vi.fn(async () => json(encoded.body, encoded.status));
    await expect(
      createA2AClient({ ...d, endpoint, policy, fetch: fetcher }).call(
        "GetTask",
        { id: working.id },
        { requestId: "rpc-1" },
      ),
    ).rejects.toMatchObject({ code: -32001, outcome: "read" });
    const value = encodeA2AResult(
      {
        method: "GetTaskPushNotificationConfig",
        result: {
          taskId: "task-1",
          id: "push-1",
          url: "https://receiver.example/hook",
          token: "SECRET",
          authentication: { schemes: ["Bearer"], credentials: "SECRET" },
        },
      },
      d,
    );
    expect(decodeA2AResult("GetTaskPushNotificationConfig", value, d)).toMatchObject({
      taskId: "task-1",
      id: "push-1",
      authentication: { schemes: ["Bearer"] },
    });
  });
});

describe("wire validation", () => {
  const d = dialects[0]!;
  it("keeps all public message and artifact fields, including scalar data in 1.0", () => {
    const message: A2AMessage = {
      ...user,
      metadata: { public: true },
      extensions: ["https://example.test/ext"],
      referenceTaskIds: ["referenced"],
      parts: [
        { kind: "data", data: null, mediaType: "application/json", metadata: { public: true } },
        { kind: "url", url: "https://files.example/a", filename: "a.txt" },
      ],
    };
    expect(decodeA2AMessage(encodeA2AMessage(message, d), d)).toMatchObject(message);
    expect(() => encodeA2AMessage(message, dialects[2]!)).toThrow(A2AError);
    expect(() =>
      encodeA2AMessage(
        { ...user, parts: [{ kind: "raw", raw: "YQ==", filename: "a.txt" }] },
        dialects[3]!,
      ),
    ).toThrow(A2AError);
  });
  it("rejects malformed oneofs, roles, identities, metadata and state", () => {
    const message = { messageId: "m", role: "ROLE_USER", parts: [{ text: "ok" }] };
    for (const bad of [
      { ...message, role: "ROLE_UNSPECIFIED" },
      { ...message, messageId: "" },
      { ...message, metadata: [] },
      { ...message, parts: [{ text: "ok", data: {} }] },
      { ...message, parts: [{ raw: "!notbase64" }] },
      { ...message, parts: [] },
    ])
      expect(() => decodeA2AMessage(bad, d)).toThrow(A2AError);
    expect(() => decodeA2ATask({ id: "task", status: { state: "done" } }, d)).toThrow(A2AError);
    expect(() => decodeA2AEvent({ task: {}, message }, d)).toThrow(A2AError);
    expect(() =>
      decodeA2ATask(
        {
          id: "task",
          contextId: "one",
          status: { state: "TASK_STATE_WORKING", message: { ...message, contextId: "two" } },
        },
        d,
      ),
    ).toThrow(A2AError);
    expect(() =>
      decodeA2ARequest("SendMessage", { message: { ...message, role: "ROLE_AGENT" } }, d),
    ).toThrow(A2AError);
    expect(() => decodeA2ARequest("ListTasks", { pageSize: 101 }, d)).toThrow(A2AError);
    expect(() => encodeA2ARequest({ method: "ListTasks", params: {} }, dialects[2]!)).toThrow(
      A2AError,
    );
    expect(() => decodeA2ARpcRequest([{ jsonrpc: "2.0" }], "1.0")).toThrow(A2AError);
    expect(() =>
      decodeA2ARpcResponse({ jsonrpc: "2.0", id: "wrong", result: {} }, "right"),
    ).toThrow(A2AError);
    expect(() =>
      decodeA2ARpcResponse({ jsonrpc: "2.0", id: "right", result: {}, error: null }, "right"),
    ).toThrow(A2AError);
  });
  it("does not translate a request for no history into unlimited legacy REST history", () => {
    const request = {
      method: "GetTask",
      params: { id: "task-1", historyLength: 0 },
    } satisfies A2ARequest;
    expect(() => encodeA2ARequest(request, dialects[3]!)).toThrow(A2AError);
    expect(encodeA2ARequest(request, dialects[0]!).params.historyLength).toBe(0);
    expect(
      decodeA2ARequest("tasks/get", { name: "tasks/task-1", historyLength: 0 }, dialects[3]!)
        .params,
    ).toMatchObject({ id: "task-1", historyLength: undefined });
  });
  it("refuses metadata on legacy REST push-configuration requests instead of dropping it", () => {
    for (const method of [
      "GetTaskPushNotificationConfig",
      "DeleteTaskPushNotificationConfig",
      "ListTaskPushNotificationConfigs",
    ] as const) {
      const request: A2ARequest = {
        method,
        params: {
          taskId: "task-1",
          id: method === "ListTaskPushNotificationConfigs" ? undefined : "push-1",
          metadata: { extension: "caller-set" },
        },
      };
      expect(() => encodeA2ARequest(request, dialects[3]!)).toThrow(
        expect.objectContaining({ kind: "protocol", code: -32004 }),
      );
      expect(encodeA2ARequest(request, dialects[2]!).params.metadata).toEqual({
        extension: "caller-set",
      });
    }
  });
  it("checks task and context identity when a legacy subscription starts with an update", () => {
    const observation = { method: "SubscribeToTask", version: "0.3" } as const;
    const tracker = createA2AStreamTracker({ taskId: working.id }, 1024, observation);
    expect(() => tracker.accept({ ...complete, taskId: "other" })).toThrow(A2AError);
    const artifact: A2AEvent = {
      kind: "artifact-update",
      taskId: working.id,
      contextId: working.contextId!,
      artifact: { artifactId: "answer", parts: [{ kind: "text", text: "one" }] },
    };
    expect(tracker.accept(artifact)).toBe(false);
    expect(() => tracker.accept({ ...complete, contextId: "other" })).toThrow(A2AError);
    expect(tracker.accept(complete)).toBe(true);
    expect(() => createA2AStreamTracker({}, 1024, observation).accept(complete)).toThrow(A2AError);
  });
  it("refuses duplicate JSON members before an answer map loses its original meaning", async () => {
    const escapedKey = String.fromCharCode(92) + "u0069d";
    for (const body of [
      '{"id":"first","id":"last"}',
      `{"id":"first","${escapedKey}":"last"}`,
      '{"metadata":{"answers":{"request":{"type":"deny","type":"approve"}}}}',
    ]) {
      expect(() => parseA2AJson(body)).toThrow(A2AError);
      await expect(
        readA2AJson(
          new Request(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        ),
      ).rejects.toBeInstanceOf(A2AError);
    }
    const value = { text: '{"id":1,"id":2}', items: [{ id: 1 }, { id: 2 }], other: { id: 3 } };
    expect(parseA2AJson(JSON.stringify(value))).toEqual(value);
  });
  it("bounds UTF-8 bytes, nesting, nodes and part counts", () => {
    expect(() => parseA2AJson('"éé"', { bodyBytes: 5 })).toThrow(A2AError);
    expect(() => parseA2AJson("[[[[]]]]", { depth: 2 })).toThrow(A2AError);
    expect(() => parseA2AJson("[1,2,3]", { nodes: 3 })).toThrow(A2AError);
    expect(() =>
      decodeA2AMessage(
        { messageId: "m", role: "ROLE_USER", parts: [{ text: "a" }, { text: "b" }] },
        d,
        { parts: 1 },
      ),
    ).toThrow(A2AError);
  });
  it("tracks artifact identity, append, lastChunk and replacement without closing the task", () => {
    const tracker = createA2AStreamTracker();
    tracker.accept(working);
    const update: A2AEvent = {
      kind: "artifact-update",
      taskId: working.id,
      contextId: working.contextId!,
      artifact: { artifactId: "answer", parts: [{ kind: "text", text: "one" }] },
    };
    expect(() => tracker.accept({ ...update, append: true })).toThrow(A2AError);
    expect(tracker.accept(update)).toBe(false);
    expect(tracker.accept({ ...update, append: true, lastChunk: true })).toBe(false);
    expect(() => tracker.accept({ ...update, append: true })).toThrow(A2AError);
    expect(tracker.accept({ ...update, append: false })).toBe(false);
    expect(tracker.accept(complete)).toBe(true);
    expect(() => tracker.accept(update)).toThrow(A2AError);
    const small = createA2AStreamTracker({}, 100);
    small.accept(working);
    expect(() =>
      small.accept({
        ...update,
        artifact: { artifactId: "answer", parts: [{ kind: "text", text: "a".repeat(100) }] },
      }),
    ).toThrow(A2AError);
  });
  it("uses GET subscriptions and safely encodes path identifiers", async () => {
    for (const version of ["1.0", "0.3"] as const) {
      const spec = encodeA2AHttpRequest(
        endpoint,
        {
          method: "SubscribeToTask",
          params: { id: "task/one", tenant: version === "1.0" ? "tenant one" : undefined },
        },
        version,
      );
      expect(spec.method).toBe("GET");
      expect(new URL(spec.url).pathname).toBe(
        `/a2a/${version === "0.3" ? "v1" : "tenant%20one"}/tasks/task%2Fone:subscribe`,
      );
      expect(
        await decodeA2AHttpRequest(new Request(spec.url), {
          baseUrl: endpoint,
          version,
          tenant: version === "1.0" ? "tenant one" : undefined,
        }),
      ).toMatchObject({ method: "SubscribeToTask", params: { id: "task/one" } });
    }
    expect(() =>
      encodeA2AHttpRequest(endpoint, { method: "GetTask", params: { id: ".." } }, "1.0"),
    ).toThrow(A2AError);
    await expect(
      decodeA2AHttpRequest(
        new Request(`${endpoint}/tasks/one:cancel`, {
          method: "POST",
          body: JSON.stringify({ id: "two" }),
          headers: { "content-type": "application/json" },
        }),
        { baseUrl: endpoint, version: "1.0" },
      ),
    ).rejects.toBeInstanceOf(A2AError);
  });
});

describe("endpoint and auth boundaries", () => {
  it("refuses malicious endpoints before any fetch", async () => {
    for (const url of [
      "http://peer.example",
      "https://user:SECRET@peer.example",
      "file:///secrets",
      "https://169.254.169.254",
      "https://0xa9fea9fe",
      "https://[fe80::1]",
      "https://[::ffff:169.254.169.254]",
      "https://100.100.100.200",
      "https://metadata.google.internal",
      "https://peer.example/#SECRET",
    ]) {
      const fetcher = vi.fn(async () => json({}));
      const client = createA2AClient({ ...dialects[0]!, endpoint: url, policy, fetch: fetcher });
      await expect(client.call("SendMessage", { message: user })).rejects.toMatchObject({
        kind: "endpoint",
        outcome: "not-sent",
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
    await expect(checkA2AEndpoint(endpoint, "rpc", { allow: () => false })).rejects.toMatchObject({
      kind: "endpoint",
    });
    await expect(checkA2AEndpoint("https://10.0.0.1/hook", "push", policy)).rejects.toMatchObject({
      kind: "endpoint",
    });
    await expect(
      checkA2AEndpoint("http://127.0.0.1:80/rpc", "rpc", policy, "http://localhost/card"),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      checkA2AEndpoint("http://127.0.0.1:81/rpc", "rpc", policy, "http://localhost/card"),
    ).rejects.toBeInstanceOf(A2AError);
    await expect(
      checkA2AEndpoint("http://private.example", "rpc", { ...policy, allowInsecure: true }),
    ).resolves.toBeInstanceOf(URL);
  });
  it("checks every card interface and required extension without trusting card prose", async () => {
    const bad = {
      ...card("1.0"),
      supportedInterfaces: [
        { url: endpoint, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: "https://evil.example", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
      ],
    };
    const fetcher = vi.fn(async () => json(bad));
    await expect(
      fetchA2AAgentCard("https://peer.example", { version: "1.0", policy, fetch: fetcher }),
    ).rejects.toMatchObject({ kind: "endpoint" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const decoded = decodeA2AAgentCard(
      {
        ...card("1.0"),
        capabilities: {
          extensions: [
            { uri: "https://example.test/ext", required: true, params: { public: true } },
          ],
        },
        securityRequirements: [{ schemes: { bearer: { list: [] } } }],
        signatures: [{ protected: "abc", signature: "xyz" }],
      },
      "1.0",
    );
    expect(() => selectA2AInterface(decoded, "1.0", "JSONRPC")).toThrow(A2AError);
    expect(selectA2AInterface(decoded, "1.0", "JSONRPC", ["https://example.test/ext"]).url).toBe(
      endpoint,
    );
    expect(decoded.document.signatures).toEqual([{ protected: "abc", signature: "xyz" }]);
    expect(a2aCardUrl("https://peer.example/base")).toBe(
      "https://peer.example/base/.well-known/agent-card.json",
    );
    expect(a2aCardUrl("https://peer.example/custom/agent-card.json")).toBe(
      "https://peer.example/custom/agent-card.json",
    );
  });
  it("refuses redirects with credentials and never retains Location or header errors", async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/?SECRET" },
      });
    }) satisfies FetchLike;
    const client = createA2AClient({
      ...dialects[0]!,
      endpoint,
      policy,
      fetch: fetcher,
      headers: () => ({ "x-api-key": "SECRET" }),
    });
    const error = await client.call("SendMessage", { message: user }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "endpoint", outcome: "unknown" });
    expect(JSON.stringify(error) + String(error)).not.toContain("SECRET");
    const badHeaders = createA2AClient({
      ...dialects[0]!,
      endpoint,
      policy,
      fetch: fetcher,
      headers: () => ({ authorization: "SECRET\ninvalid" }),
    });
    const bad = await badHeaders.call("SendMessage", { message: user }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ outcome: "not-sent" });
    expect(String(bad) + JSON.stringify(bad)).not.toContain("SECRET");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("checks cards for both versions and does not renew credentials on a refused send", async () => {
    for (const version of ["1.0", "0.3"] as const) {
      const verify = vi.fn(() => {});
      const result = await fetchA2AAgentCard("https://peer.example", {
        version,
        policy,
        fetch: async () => json(card(version)),
        verifyCard: verify,
      });
      expect(result.document.name).toBe("Peer");
      expect(verify).toHaveBeenCalledTimes(1);
    }
    const getToken = vi.fn(async () => ({ accessToken: "SECRET" }));
    const fetcher = vi.fn(async () => json({}, 401));
    const client = createA2AClient({
      ...dialects[0]!,
      endpoint,
      policy,
      token: { getToken },
      fetch: fetcher,
    });
    await expect(client.call("SendMessage", { message: user })).rejects.toMatchObject({
      status: 401,
      outcome: "unknown",
    });
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("requires a host secret and principal and defaults to refusal", async () => {
    const principal = { owner: "owner", actorId: "actor" };
    const authenticate = bearerToken("my-secret", principal);
    principal.owner = "changed";
    expect(await authenticateA2A(new Request(endpoint))).toBeNull();
    for (const authorization of [
      undefined,
      "Bearer wrong",
      "Basic my-secret",
      "Bearer my-secret other",
    ]) {
      expect(
        await authenticateA2A(
          new Request(endpoint, { headers: authorization ? { authorization } : {} }),
          authenticate,
        ),
      ).toBeNull();
    }
    expect(
      await authenticateA2A(
        new Request(endpoint, { headers: { authorization: "bEaReR my-secret" } }),
        authenticate,
      ),
    ).toEqual({ owner: "owner", actorId: "actor" });
    expect(
      await authenticateA2A(new Request(endpoint), () => {
        throw new Error("SECRET");
      }),
    ).toBeNull();
    expect(() => bearerToken("", principal)).toThrow(A2AError);
  });
});

describe("body and observation lifetime", () => {
  it("preserves bare legacy REST stream error codes without peer text", async () => {
    const stream = sse([], dialects[3]!, {
      suffix: 'event: error\ndata: {"code":-32001,"message":"SECRET task details"}\n\n',
    });
    const observer = createA2AClient({
      ...dialects[3]!,
      endpoint,
      policy,
      fetch: async () => stream.response,
    }).observe("SubscribeToTask", { id: working.id });
    const error = await observer.next().catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "protocol", code: -32001, status: 200, outcome: "read" });
    expect(String(error) + JSON.stringify(error)).not.toContain("SECRET");
    expect(stream.body.locked).toBe(false);
    expect(stream.canceled()).toBe(1);
  });
  it.each([1, 2])(
    "times out pending endpoint policy check %i without sending late",
    async (step) => {
      vi.useFakeTimers();
      const gate = Promise.withResolvers<boolean>();
      try {
        const started = Promise.withResolvers<void>();
        const allow = vi.fn(() => {
          if (allow.mock.calls.length !== step) return true;
          started.resolve();
          return gate.promise;
        });
        const fetcher = vi.fn(peer(dialects[0]!));
        const settled = vi.fn();
        const pending = createA2AClient({
          ...dialects[0]!,
          endpoint,
          policy: { allow },
          fetch: fetcher,
          timeoutMs: 5,
        }).call("SendMessage", { message: user });
        void pending.then(settled, settled);
        await started.promise;
        await vi.advanceTimersByTimeAsync(5);
        expect(settled).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "timeout",
            outcome: "not-sent",
          }),
        );
        gate.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).not.toHaveBeenCalled();
        expect(allow).toHaveBeenCalledTimes(step);
      } finally {
        gate.resolve(false);
        vi.useRealTimers();
      }
    },
  );
  it.each(["abort", "close"] as const)(
    "settles %s during endpoint policy evaluation",
    async (action) => {
      vi.useFakeTimers();
      const gate = Promise.withResolvers<boolean>();
      try {
        const started = Promise.withResolvers<void>();
        const allow = vi.fn(() => {
          started.resolve();
          return gate.promise;
        });
        const fetcher = vi.fn(peer(dialects[0]!));
        const controller = new AbortController();
        const reason = new Error("Caller stopped observing");
        const observation = createA2AClient({
          ...dialects[0]!,
          endpoint,
          policy: { allow },
          fetch: fetcher,
        }).observe("SubscribeToTask", { id: working.id }, { signal: controller.signal });
        const settled = vi.fn();
        void observation.next().then(settled, settled);
        await started.promise;
        const closed = vi.fn();
        if (action === "abort") controller.abort(reason);
        else void observation.close().then(closed);
        await vi.advanceTimersByTimeAsync(0);
        if (action === "abort") expect(settled).toHaveBeenCalledWith(reason);
        else {
          expect(settled).toHaveBeenCalledWith({ done: true, value: undefined });
          expect(closed).toHaveBeenCalledOnce();
        }
        gate.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).not.toHaveBeenCalled();
        expect(allow).toHaveBeenCalledOnce();
      } finally {
        gate.resolve(false);
        vi.useRealTimers();
      }
    },
  );
  it.each(["card policy", "verification", "interface policy"])(
    "bounds pending card %s hooks",
    async (step) => {
      vi.useFakeTimers();
      const gate = Promise.withResolvers<void>();
      try {
        const started = Promise.withResolvers<void>();
        const wait = () => {
          started.resolve();
          return gate.promise;
        };
        const allow = vi.fn(async (_url: URL, use: string) => {
          if (
            (step === "card policy" && use === "card") ||
            (step === "interface policy" && use === "rpc")
          )
            await wait();
          return true;
        });
        const verifyCard = vi.fn(() => (step === "verification" ? wait() : undefined));
        const fetcher = vi.fn(async () => json(card("1.0")));
        const settled = vi.fn();
        void fetchA2AAgentCard("https://peer.example", {
          version: "1.0",
          policy: { allow },
          verifyCard,
          fetch: fetcher,
          timeoutMs: 5,
        }).then(settled, settled);
        await started.promise;
        await vi.advanceTimersByTimeAsync(5);
        expect(settled).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "timeout", outcome: "read" }),
        );
        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(step === "card policy" ? 0 : 1);
        expect(verifyCard).toHaveBeenCalledTimes(step === "card policy" ? 0 : 1);
        expect(allow).toHaveBeenCalledTimes(step === "interface policy" ? 2 : 1);
      } finally {
        gate.resolve();
        vi.useRealTimers();
      }
    },
  );
  it("bounds declared and chunked bodies and refuses form data", async () => {
    for (const declared of [false, true]) {
      let cancels = 0;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"text":"too long"}'));
        },
        cancel() {
          cancels++;
        },
      });
      const response = new Response(body, {
        headers: {
          "content-type": "application/json",
          ...(declared ? { "content-length": "1000" } : {}),
        },
      });
      await expect(readA2AJson(response, { limits: { bodyBytes: 8 } })).rejects.toMatchObject({
        kind: "limit",
      });
      expect(cancels).toBe(1);
      expect(body.locked).toBe(false);
    }
    await expect(
      readA2AJson(
        new Request(endpoint, {
          method: "POST",
          body: "x=1",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
      ),
    ).rejects.toMatchObject({ code: -32005 });
  });
  it("aborts a pending unary body and a pending fetch, disposing a late response", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    let canceled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled++;
      },
    });
    const promise = readA2AJson(
      new Response(body, { headers: { "content-type": "application/json" } }),
      { signal: controller.signal },
    );
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(body.locked).toBe(false);
    expect(canceled).toBe(1);

    let resolve!: (response: Response) => void;
    const started = Promise.withResolvers<void>();
    const fetcher: FetchLike = () => {
      started.resolve();
      return new Promise((r) => {
        resolve = r;
      });
    };
    const abort = new AbortController();
    const client = createA2AClient({ ...dialects[0]!, endpoint, policy, fetch: fetcher });
    const request = client.call("SendMessage", { message: user }, { signal: abort.signal });
    await started.promise;
    abort.abort(reason);
    await expect(request).rejects.toBe(reason);
    const late = sse([], dialects[0]!);
    resolve(late.response);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.canceled()).toBe(1);
  });
  it("does not fetch when aborted or closed before the first read", async () => {
    const fetcher = vi.fn(async () => json({}));
    const client = createA2AClient({ ...dialects[0]!, endpoint, policy, fetch: fetcher });
    const controller = new AbortController();
    controller.abort("stop");
    await expect(
      client.call("SendMessage", { message: user }, { signal: controller.signal }),
    ).rejects.toBe("stop");
    const observation = client.observe("SendStreamingMessage", { message: user });
    await observation.close();
    expect(await observation.next()).toMatchObject({ done: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("stops a paused or early-returned observation and treats socket failure as incomplete", async () => {
    const d = dialects[0]!;
    const paused = sse([working], d);
    const controller = new AbortController();
    const reason = new Error("stop");
    const observer = createA2AClient({
      ...d,
      endpoint,
      policy,
      fetch: async () => paused.response,
    }).observe(
      "SubscribeToTask",
      { id: working.id },
      { signal: controller.signal, requestId: "rpc-1" },
    );
    await observer.next();
    controller.abort(reason);
    expect(paused.body.locked).toBe(false);
    expect(paused.canceled()).toBe(1);
    await expect(observer.next()).rejects.toBe(reason);

    const early = sse([working], d);
    const client = createA2AClient({ ...d, endpoint, policy, fetch: async () => early.response });
    for await (const event of client.observe(
      "SubscribeToTask",
      { id: working.id },
      { requestId: "rpc-1" },
    )) {
      expect(event.kind).toBe("task");
      break;
    }
    expect(early.body.locked).toBe(false);
    expect(early.canceled()).toBe(1);

    const failed = sse([working], d);
    const observation = createA2AClient({
      ...d,
      endpoint,
      policy,
      fetch: async () => failed.response,
    }).observe("SendStreamingMessage", { message: user }, { requestId: "rpc-1" });
    await observation.next();
    failed.fail();
    const error = await observation.next().catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "network", outcome: "unknown" });
    expect(String(error) + JSON.stringify(error)).not.toContain("SECRET");
    expect(failed.body.locked).toBe(false);
  });
  it("times out a send once and releases an idle SSE reader", async () => {
    vi.useFakeTimers();
    try {
      const started = Promise.withResolvers<void>();
      const fetcher = vi.fn(async () => {
        started.resolve();
        return new Promise<Response>(() => {});
      });
      const request = createA2AClient({
        ...dialects[0]!,
        endpoint,
        policy,
        fetch: fetcher,
        timeoutMs: 10,
      }).call("SendMessage", { message: user });
      const assertion = expect(request).rejects.toMatchObject({
        kind: "timeout",
        outcome: "unknown",
        retryable: false,
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(1);
      const stream = sse([working], dialects[0]!);
      const observer = createA2AClient({
        ...dialects[0]!,
        endpoint,
        policy,
        fetch: async () => stream.response,
        idleMs: 10,
      }).observe("SubscribeToTask", { id: working.id }, { requestId: "rpc-1" });
      await observer.next();
      const pending = observer.next();
      const idleAssertion = expect(pending).rejects.toMatchObject({
        kind: "timeout",
        outcome: "read",
      });
      await vi.advanceTimersByTimeAsync(10);
      await idleAssertion;
      expect(stream.body.locked).toBe(false);
      expect(stream.canceled()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects an oversized complete SSE frame, not only partial frames", async () => {
    const stream = sse([working], dialects[0]!, {
      suffix: `data: ${JSON.stringify({ text: "a".repeat(2000) })}\n\n`,
    });
    const observer = createA2AClient({
      ...dialects[0]!,
      endpoint,
      policy,
      fetch: async () => stream.response,
      limits: { bodyBytes: 1000 },
    }).observe("SubscribeToTask", { id: working.id }, { requestId: "rpc-1" });
    await observer.next();
    await expect(observer.next()).rejects.toMatchObject({ kind: "limit" });
    expect(stream.canceled()).toBe(1);
    expect(stream.body.locked).toBe(false);
  });
});
