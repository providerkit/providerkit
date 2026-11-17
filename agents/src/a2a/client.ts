// EOF handling follows google-adk-python's A2A remote agent, Apache-2.0, Google LLC.
// REST paths/legacy protobuf JSON checked against a2aproject/A2A release schemas
// and a2aproject/a2a-js src/compat/v0_3/client/transports/rest_transport.ts.
import { parseSseStream, type FetchLike } from "@providerkit/core";
import {
  a2aCardUrl,
  checkA2ACardEndpoints,
  checkA2AEndpoint,
  type A2AEndpointPolicy,
} from "./policy.ts";
import {
  A2AError,
  a2aIsMutation,
  a2aLimits,
  a2aMethodName,
  createA2AStreamTracker,
  decodeA2AAgentCard,
  decodeA2AHttpError,
  decodeA2ARequest,
  decodeA2AResult,
  decodeA2ARpcResponse,
  encodeA2ARequest,
  parseA2AJson,
  type A2AAgentCard,
  type A2ADialect,
  type A2AEvent,
  type A2AJson,
  type A2ALimits,
  type A2AMethod,
  type A2AObject,
  type A2AOutcome,
  type A2ARequest,
  type A2ARequests,
  type A2AResults,
  type A2ARpcId,
  type A2AVersion,
} from "./wire.ts";

/** Cancels/releases the local body even when a host fetch does not connect its signal to the reader. */
function observedBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const finish = (cancel: boolean) => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener("abort", abort);
    if (cancel) void reader.cancel().catch(() => {});
    reader.releaseLock();
  };
  const abort = () => {
    output.error(signal?.reason);
    finish(true);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      },
      async pull(controller) {
        try {
          const read = await reader.read();
          if (ended) return;
          if (read.done) {
            finish(false);
            controller.close();
          } else controller.enqueue(read.value);
        } catch (error) {
          if (!ended) {
            finish(true);
            controller.error(error);
          }
        }
      },
      cancel() {
        finish(true);
      },
    },
    { highWaterMark: 0 },
  );
}

function jsonType(source: Request | Response): void {
  const type = source.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json" && type !== "application/a2a+json") {
    void source.body?.cancel().catch(() => {});
    throw new A2AError("protocol", {
      code: -32005,
      status: source instanceof Request ? 415 : source.status,
    });
  }
}

/** Bounded body reader for later server routes too. No form parsing or error-body retention. */
export async function readA2AJson(
  source: Request | Response,
  options: { signal?: AbortSignal; limits?: Partial<A2ALimits> } = {},
): Promise<A2AJson> {
  const l = a2aLimits(options.limits);
  const signal = options.signal ?? (source instanceof Request ? source.signal : undefined);
  if (signal?.aborted) {
    void source.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  jsonType(source);
  const length = source.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > l.bodyBytes) {
    void source.body?.cancel().catch(() => {});
    throw new A2AError("limit", { status: source instanceof Request ? 413 : source.status });
  }
  if (!source.body) throw new A2AError("invalid");
  const reader = observedBody(source.body, signal).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let drained = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch {
        signal?.throwIfAborted();
        throw new A2AError("network");
      }
      signal?.throwIfAborted();
      if (read.done) {
        drained = true;
        break;
      }
      bytes += read.value.byteLength;
      if (bytes > l.bodyBytes)
        throw new A2AError("limit", { status: source instanceof Request ? 413 : source.status });
      text += decoder.decode(read.value, { stream: true });
    }
    return parseA2AJson(text + decoder.decode(), l);
  } catch (error) {
    signal?.throwIfAborted();
    throw error instanceof A2AError ? error : new A2AError("invalid");
  } finally {
    if (!drained) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

interface RequestHooks {
  fetch?: FetchLike;
  /** Host-only hook for credentials, trace headers and request IDs. Never populated from messages. */
  headers?: (request: { url: string; method: string }) => HeadersInit | Promise<HeadersInit>;
  /** Read once per request. A rejected token never causes a mutation to be sent again. */
  token?: { getToken(): Promise<{ accessToken: string }> };
}
export interface A2AClientOptions extends A2ADialect, RequestHooks {
  endpoint: string;
  tenant?: string;
  cardUrl?: string;
  policy: A2AEndpointPolicy;
  extensions?: readonly string[];
  limits?: Partial<A2ALimits>;
  maxResultBytes?: number;
  /** Preparation, headers and unary-body deadline. Streaming bodies have their own idle deadline. */
  timeoutMs?: number;
  idleMs?: number;
}
export interface A2ACallOptions {
  signal?: AbortSignal;
  requestId?: A2ARpcId;
}
export interface A2AObservation extends AsyncIterableIterator<A2AEvent> {
  close(): Promise<void>;
}
type StreamingMethod = "SendStreamingMessage" | "SubscribeToTask";
type UnaryMethod = Exclude<A2AMethod, StreamingMethod>;
export interface A2AClient {
  call<M extends UnaryMethod>(
    method: M,
    params: A2ARequests[M],
    options?: A2ACallOptions,
  ): Promise<A2AResults[M]>;
  observe<M extends StreamingMethod>(
    method: M,
    params: A2ARequests[M],
    options?: A2ACallOptions,
  ): A2AObservation;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new A2AError("invalid");
  return value;
}
function segment(value: string | undefined): string {
  if (!value || value === "." || value === "..") throw new A2AError("invalid");
  return encodeURIComponent(value);
}

/** Base URL is the advertised binding endpoint; 0.3 adds /v1, as its REST schema requires. */
export function encodeA2AHttpRequest(
  endpoint: string,
  request: A2ARequest,
  version: A2AVersion,
  overrides?: Partial<A2ALimits>,
): { url: string; method: string; body?: A2AObject } {
  const d = { version, binding: "HTTP+JSON" } as const;
  const wire = encodeA2ARequest(request, d, overrides).params;
  const url = new URL(endpoint);
  const root = `${url.pathname.replace(/\/+$/, "")}${version === "0.3" ? "/v1" : request.params.tenant ? `/${segment(request.params.tenant)}` : ""}`;
  let path: string;
  let method = "GET";
  let body: A2AObject | undefined;
  switch (request.method) {
    case "SendMessage":
    case "SendStreamingMessage":
      path = `/message:${request.method === "SendMessage" ? "send" : "stream"}`;
      method = "POST";
      body = wire;
      break;
    case "GetTask":
    case "CancelTask":
    case "SubscribeToTask": {
      path = `/tasks/${segment(request.params.id)}${request.method === "GetTask" ? "" : request.method === "CancelTask" ? ":cancel" : ":subscribe"}`;
      if (request.method === "CancelTask") {
        method = "POST";
        body = wire;
      } else if (request.params.historyLength !== undefined)
        url.searchParams.set("historyLength", String(request.params.historyLength));
      break;
    }
    case "ListTasks":
      path = "/tasks";
      for (const [key, value] of Object.entries(wire))
        if (key !== "tenant") url.searchParams.set(key, String(value));
      break;
    case "CreateTaskPushNotificationConfig":
      path = `/tasks/${segment(request.params.taskId)}/pushNotificationConfigs`;
      method = "POST";
      body = wire;
      break;
    case "GetTaskPushNotificationConfig":
    case "DeleteTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs": {
      path = `/tasks/${segment(request.params.taskId)}/pushNotificationConfigs${request.method === "ListTaskPushNotificationConfigs" ? "" : `/${segment(request.params.id)}`}`;
      if (request.method === "DeleteTaskPushNotificationConfig") method = "DELETE";
      if (request.params.pageSize !== undefined)
        url.searchParams.set("pageSize", String(request.params.pageSize));
      if (request.params.pageToken !== undefined)
        url.searchParams.set("pageToken", request.params.pageToken);
      break;
    }
    case "GetExtendedAgentCard":
      path = version === "1.0" ? "/extendedAgentCard" : "/card";
      break;
  }
  url.pathname = root + path;
  return { url: url.href, method, body };
}

/** Authenticate first. This only decodes a Request and never starts, stores or cancels a task. */
export async function decodeA2AHttpRequest(
  request: Request,
  options: { baseUrl: string; version: A2AVersion; tenant?: string; limits?: Partial<A2ALimits> },
): Promise<A2ARequest> {
  const { version } = options;
  const url = new URL(request.url);
  const prefix = `${new URL(options.baseUrl).pathname.replace(/\/+$/, "")}${version === "0.3" ? "/v1" : options.tenant ? `/${segment(options.tenant)}` : ""}`;
  if (!url.pathname.startsWith(`${prefix}/`)) throw new A2AError("protocol", { code: -32601 });
  const path = url.pathname.slice(prefix.length);
  let method: A2AMethod;
  let taskId: string | undefined;
  let configId: string | undefined;
  let verb = "GET";
  if (path === "/message:send" || path === "/message:stream") {
    method = path.endsWith(":send") ? "SendMessage" : "SendStreamingMessage";
    verb = "POST";
  } else if (path === "/tasks") method = "ListTasks";
  else if (path === (version === "1.0" ? "/extendedAgentCard" : "/card"))
    method = "GetExtendedAgentCard";
  else {
    const match =
      /^\/tasks\/([^/:]+)(?:(:cancel|:subscribe)|\/pushNotificationConfigs(?:\/([^/]+))?)?$/.exec(
        path,
      );
    if (!match) throw new A2AError("protocol", { code: -32601 });
    try {
      taskId = decodeURIComponent(match[1]!);
      configId = match[3] && decodeURIComponent(match[3]);
    } catch {
      throw new A2AError("invalid");
    }
    if (match[2]) {
      method = match[2] === ":cancel" ? "CancelTask" : "SubscribeToTask";
      if (method === "CancelTask") verb = "POST";
    } else if (path.includes("/pushNotificationConfigs")) {
      method = configId
        ? request.method === "DELETE"
          ? "DeleteTaskPushNotificationConfig"
          : "GetTaskPushNotificationConfig"
        : request.method === "POST"
          ? "CreateTaskPushNotificationConfig"
          : "ListTaskPushNotificationConfigs";
      if (method === "DeleteTaskPushNotificationConfig") verb = "DELETE";
      if (method === "CreateTaskPushNotificationConfig") verb = "POST";
    } else method = "GetTask";
  }
  if (request.method !== verb) throw new A2AError("protocol", { code: -32600, status: 405 });
  let params: A2AObject = {};
  if (verb === "POST") {
    if (request.body) {
      const value = await readA2AJson(request, { limits: options.limits });
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new A2AError("invalid");
      params = value;
    } else if (method !== "CancelTask") throw new A2AError("invalid");
  }
  url.searchParams.forEach((value, key) => {
    if (Object.hasOwn(params, key) || url.searchParams.getAll(key).length !== 1)
      throw new A2AError("invalid");
    if (["historyLength", "pageSize"].includes(key)) {
      if (!/^\d+$/.test(value)) throw new A2AError("invalid");
      params[key] = Number(value);
    } else if (key === "includeArtifacts") {
      if (!["true", "false"].includes(value)) throw new A2AError("invalid");
      params[key] = value === "true";
    } else params[key] = value;
  });
  const put = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    if (Object.hasOwn(params, key) && params[key] !== value) throw new A2AError("invalid");
    params[key] = value;
  };
  put("tenant", options.tenant);
  if (version === "0.3" && taskId) {
    const resource = `tasks/${segment(taskId)}`;
    if (method === "CreateTaskPushNotificationConfig") {
      const name = params.name;
      if (typeof name !== "string" || !name.startsWith(`${resource}/pushNotificationConfigs/`))
        throw new A2AError("invalid");
    } else
      put(
        method === "ListTaskPushNotificationConfigs" ? "parent" : "name",
        `${resource}${configId ? `/pushNotificationConfigs/${segment(configId)}` : ""}`,
      );
  } else {
    const push = method.includes("PushNotification");
    put(push ? "taskId" : "id", taskId);
    if (push) put("id", configId);
  }
  return decodeA2ARequest(
    a2aMethodName(method, version),
    params,
    { version, binding: "HTTP+JSON" },
    options.limits,
  );
}

/** Host hooks need not honor a signal. Stop waiting and never start the next hook after abort. */
function untilAbort<T>(
  signal: AbortSignal,
  work: () => T | Promise<T>,
  discard?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            discard?.(value);
            reject(signal.reason);
          } else resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(signal.aborted ? signal.reason : error);
        },
      );
  });
}

async function sendOnce(
  url: string,
  init: RequestInit,
  hooks: RequestHooks,
  signal: AbortSignal,
  onSend?: () => void,
): Promise<Response> {
  const headers = new Headers(
    await untilAbort(signal, () => hooks.headers?.({ url, method: init.method ?? "GET" })),
  );
  const source = hooks.token;
  if (source) {
    const token = (await untilAbort(signal, () => source.getToken())).accessToken;
    if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) throw new A2AError("invalid");
    headers.set("authorization", `Bearer ${token}`);
  }
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const response = await untilAbort(
    signal,
    () => {
      onSend?.();
      return (hooks.fetch ?? globalThis.fetch)(url, {
        ...init,
        headers,
        signal,
        redirect: "error",
        credentials: "omit",
      });
    },
    (late) => {
      void late.body?.cancel().catch(() => {});
    },
  );
  if (
    response.redirected ||
    response.type === "opaqueredirect" ||
    response.status === 0 ||
    (response.status >= 300 && response.status < 400)
  ) {
    void response.body?.cancel().catch(() => {});
    throw new A2AError("endpoint", { status: response.status });
  }
  return response;
}
function remap(error: unknown, outcome: A2AOutcome, signal?: AbortSignal, timedOut = false): never {
  signal?.throwIfAborted();
  if (timedOut) throw new A2AError("timeout", { outcome });
  throw error instanceof A2AError
    ? new A2AError(error.kind, { code: error.code, status: error.status, outcome })
    : new A2AError("network", { outcome });
}
async function responseError(
  response: Response,
  signal: AbortSignal,
  limits: A2ALimits,
): Promise<never> {
  try {
    const value = await readA2AJson(response, { signal, limits });
    throw decodeA2AHttpError(value, response.status, limits);
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof A2AError &&
      error.kind === "protocol" &&
      error.code !== -32700 &&
      error.code !== -32005
    )
      throw error;
    throw new A2AError("http", { status: response.status });
  }
}

export async function fetchA2AAgentCard(
  source: string,
  options: RequestHooks & {
    version: A2AVersion;
    policy: A2AEndpointPolicy;
    signal?: AbortSignal;
    timeoutMs?: number;
    limits?: Partial<A2ALimits>;
    verifyCard?: (
      card: A2AAgentCard,
      context: { url: string; fetchedAt: number },
    ) => void | Promise<void>;
  },
): Promise<A2AAgentCard> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), positive(options.timeoutMs ?? 10_000));
  try {
    signal.throwIfAborted();
    const url = await untilAbort(signal, () =>
      checkA2AEndpoint(a2aCardUrl(source), "card", options.policy),
    );
    const response = await sendOnce(
      url.href,
      { method: "GET", headers: { accept: "application/json", "A2A-Version": options.version } },
      options,
      signal,
    );
    const limits = a2aLimits({ bodyBytes: 1024 * 1024, ...options.limits });
    if (!response.ok) return await responseError(response, signal, limits);
    const card = decodeA2AAgentCard(
      await readA2AJson(response, { signal, limits }),
      options.version,
      limits,
    );
    await untilAbort(signal, () =>
      options.verifyCard?.(card, { url: url.href, fetchedAt: Date.now() }),
    );
    await untilAbort(signal, () => checkA2ACardEndpoints(card, url.href, options.policy));
    signal.throwIfAborted();
    return card;
  } catch (error) {
    return remap(error, "read", options.signal, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

export function createA2AClient(options: A2AClientOptions): A2AClient {
  if (
    !["1.0", "0.3"].includes(options.version) ||
    !["JSONRPC", "HTTP+JSON"].includes(options.binding)
  )
    throw new A2AError("protocol", { code: -32009 });
  const d: A2ADialect = { version: options.version, binding: options.binding };
  const limits = a2aLimits(options.limits);
  const timeoutMs = positive(options.timeoutMs ?? 60_000);
  const idleMs = positive(options.idleMs ?? 120_000);
  const maxResultBytes = positive(options.maxResultBytes ?? 1024 * 1024);
  const prepare = async (
    request: A2ARequest,
    requestId: A2ARpcId,
    streaming: boolean,
    signal: AbortSignal,
  ) => {
    if (options.tenant && request.params.tenant && options.tenant !== request.params.tenant)
      throw new A2AError("invalid");
    request = {
      ...request,
      params: { ...request.params, tenant: options.tenant ?? request.params.tenant },
    } as A2ARequest;
    await untilAbort(signal, () =>
      checkA2AEndpoint(options.endpoint, "rpc", options.policy, options.cardUrl),
    );
    const spec =
      d.binding === "JSONRPC"
        ? {
            url: options.endpoint,
            method: "POST",
            body: { jsonrpc: "2.0", id: requestId, ...encodeA2ARequest(request, d, limits) },
          }
        : encodeA2AHttpRequest(options.endpoint, request, d.version, limits);
    await untilAbort(signal, () =>
      checkA2AEndpoint(spec.url, "rpc", options.policy, options.cardUrl),
    );
    const headers = new Headers({
      accept: streaming ? "text/event-stream" : "application/a2a+json, application/json",
      "A2A-Version": d.version,
    });
    if (spec.body)
      headers.set(
        "content-type",
        d.version === "1.0" ? "application/a2a+json" : "application/json",
      );
    if (options.extensions?.length) headers.set("A2A-Extensions", options.extensions.join(","));
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    if (body !== undefined) parseA2AJson(body, limits);
    return { url: spec.url, init: { method: spec.method, headers, body }, request };
  };
  const expected = (request: A2ARequest): { taskId?: string; contextId?: string } => {
    if (request.method === "SendMessage" || request.method === "SendStreamingMessage")
      return { taskId: request.params.message.taskId, contextId: request.params.message.contextId };
    if (
      request.method === "GetTask" ||
      request.method === "CancelTask" ||
      request.method === "SubscribeToTask"
    )
      return { taskId: request.params.id };
    return {};
  };
  return {
    async call(method, params, callOptions = {}) {
      const controller = new AbortController();
      const signal = callOptions.signal
        ? AbortSignal.any([controller.signal, callOptions.signal])
        : controller.signal;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let outcome: A2AOutcome = "not-sent";
      try {
        signal.throwIfAborted();
        const requestId = callOptions.requestId ?? crypto.randomUUID();
        // The generic method and params are correlated at the public call boundary.
        const request = { method, params } as A2ARequest;
        const spec = await prepare(request, requestId, false, signal);
        signal.throwIfAborted();
        const response = await sendOnce(spec.url, spec.init, options, signal, () => {
          outcome = a2aIsMutation(method) ? "unknown" : "read";
        });
        if (!response.ok) return await responseError(response, signal, limits);
        const value =
          method === "DeleteTaskPushNotificationConfig" &&
          response.status === 204 &&
          d.binding === "HTTP+JSON"
            ? {}
            : await readA2AJson(response, { signal, limits });
        const payload =
          d.binding === "JSONRPC" ? decodeA2ARpcResponse(value, requestId, limits) : value;
        const result = decodeA2AResult(method, payload, d, limits);
        if (result && "kind" in result)
          createA2AStreamTracker(expected(request), maxResultBytes).accept(result);
        if (result && "taskId" in params && params.taskId) {
          const configs = "url" in result ? [result] : "configs" in result ? result.configs : [];
          for (const config of configs) {
            if (
              !("taskId" in config) ||
              config.taskId !== params.taskId ||
              ("id" in params &&
                params.id !== undefined &&
                (!("id" in config) || config.id !== params.id))
            )
              throw new A2AError("invalid");
          }
        }
        return result;
      } catch (error) {
        return remap(error, outcome, callOptions.signal, controller.signal.aborted);
      } finally {
        clearTimeout(timer);
      }
    },
    observe(method, params, callOptions = {}) {
      const stop = new AbortController();
      const deadline = new AbortController();
      const signal = AbortSignal.any([
        stop.signal,
        deadline.signal,
        ...(callOptions.signal ? [callOptions.signal] : []),
      ]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let outcome: A2AOutcome = "not-sent";
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => deadline.abort(), ms);
      };
      const iterator = (async function* (): AsyncGenerator<A2AEvent> {
        try {
          signal.throwIfAborted();
          arm(timeoutMs);
          const requestId = callOptions.requestId ?? crypto.randomUUID();
          const request = { method, params } as A2ARequest;
          const spec = await prepare(request, requestId, true, signal);
          signal.throwIfAborted();
          const response = await sendOnce(spec.url, spec.init, options, signal, () => {
            outcome = a2aIsMutation(method) ? "unknown" : "read";
          });
          if (!response.ok) return await responseError(response, signal, limits);
          if (
            !response.body ||
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
              "text/event-stream"
          ) {
            if (d.binding === "JSONRPC" && response.body) {
              // A refused streaming method may return an ordinary JSON-RPC error with HTTP200.
              // Decode its bounded envelope first; a non-stream success is still invalid here.
              decodeA2ARpcResponse(
                await readA2AJson(response, { signal, limits }),
                requestId,
                limits,
              );
            }
            void response.body?.cancel().catch(() => {});
            throw new A2AError("invalid");
          }
          arm(idleMs);
          const tracker = createA2AStreamTracker(expected(request), maxResultBytes, {
            method,
            version: d.version,
          });
          const frames = parseSseStream(observedBody(response.body, signal), {
            signal,
            maxFrameChars: limits.bodyBytes,
            onActivity: () => arm(idleMs),
          });
          for await (const frame of frames) {
            signal.throwIfAborted();
            const value = parseA2AJson(frame, limits);
            const payload =
              d.binding === "JSONRPC" ? decodeA2ARpcResponse(value, requestId, limits) : value;
            if (
              d.binding === "HTTP+JSON" &&
              payload &&
              typeof payload === "object" &&
              !Array.isArray(payload) &&
              ("error" in payload ||
                (d.version === "0.3" && typeof payload.code === "number" && payload.code < 0))
            )
              throw decodeA2AHttpError(payload, 200, limits);
            const event = decodeA2AResult(method, payload, d, limits);
            const closed = tracker.accept(event);
            if (closed) await frames.return(undefined);
            yield event;
            if (closed) return;
          }
          signal.throwIfAborted();
          throw new A2AError("stream-cut");
        } catch (error) {
          if (stop.signal.aborted && !callOptions.signal?.aborted) return;
          remap(error, outcome, callOptions.signal, deadline.signal.aborted);
        } finally {
          clearTimeout(timer);
        }
      })();
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          return iterator.next();
        },
        async return() {
          stop.abort();
          return iterator.return(undefined);
        },
        async throw(error: unknown) {
          stop.abort();
          return iterator.throw(error);
        },
        async close() {
          stop.abort();
          await iterator.return(undefined);
        },
      };
    },
  };
}
