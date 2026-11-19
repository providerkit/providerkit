// MCP servers as a source of core tools. This entry is the only file that imports the official
// SDK, an optional peer, so an app that never imports `@providerkit/agents/mcp` never loads it.
//
// The supported mode records each tool in the app: its name, the words the model reads and its
// input schema. Nothing connects until the model first calls one of them inside a run, so boot
// never waits on a sibling service, and a server that changes its list cannot change what the
// model sees. The live list is read once per connection for three checks only: the tool still
// exists, it still takes every argument the app pins, and it is still read-only when the app
// relies on that. Server text (descriptions, schemas, results, errors) is untrusted throughout.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ErrorCode,
  ListToolsResultSchema,
  McpError,
  ResultSchema,
  type Tool as ListedTool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  defineTool,
  ToolTimeoutError,
  type JsonObjectSchema,
  type Tool,
  type ToolContext,
} from "@providerkit/core";

/** One tool as its server described it. `listMcpTools` returns these: save them in the app. */
export interface McpToolRecord {
  /** The tool's name on the server. */
  name: string;
  description?: string;
  inputSchema: JsonObjectSchema;
  /** Only `readOnlyHint` is read. A tool without it is treated as one that can change data. */
  annotations?: { readOnlyHint?: boolean };
}

/** Where the server is. Streamable HTTP only. */
export interface McpServerOptions {
  /** The server's Streamable HTTP endpoint, such as `https://docs.example.com/mcp`. */
  url: string;
  /**
   * Sent as `Authorization: Bearer <key>`, with surrounding spaces removed before sending and
   * redacting. Tool metadata containing the key is refused.
   */
  key?: string;
  /** Replaces the global fetch: a proxy, a service binding, a test. */
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** How long one call may take, connecting included, in ms. Default 60000. */
  timeoutMs?: number;
}

/** What the app decides about one allowed tool. */
export interface McpToolPolicy {
  /** What the model reads instead of the recorded description. */
  description?: string;
  /**
   * Arguments the app fixes. They leave the schema the model sees and are always sent; a model
   * that sends one anyway gets the call refused as invalid input.
   */
  pin?: Record<string, unknown>;
  /**
   * Ask a person before each call. A tool the server does not mark read-only must set this:
   * true to ask, or false to let it run without asking.
   */
  needsApproval?: boolean;
  /**
   * Treat a tool its server marks read-only as one that can change data. There is no `true`:
   * only the server's `readOnlyHint` makes a tool read-only.
   */
  readOnly?: false;
  /** Replaces the server-wide `timeoutMs` for this tool. */
  timeoutMs?: number;
}

export interface McpToolsOptions extends McpServerOptions {
  /** The server's tools as `listMcpTools` returned them. */
  recorded: readonly McpToolRecord[];
  /** The tools the model may call, by their name on the server. No other tool reaches it. */
  allow: Readonly<Record<string, McpToolPolicy>>;
  /** Goes before every name with `_`: prefix "docs" turns "search" into "docs_search". */
  prefix?: string;
  /** Rewrites server text before the model reads it, for example to fence it as untrusted data. */
  wrap?: (text: string, tool: string) => string;
}

export interface McpTools {
  /** Core tools for `defineAgent`, in the order of `allow`. */
  readonly tools: readonly Tool[];
  /** Ends every open session. A later call connects again. */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
// Core's own ceiling sits past ours. Our deadline fires first and says whether the call may have
// run; core's only catches a call that ignores its signal.
const BACKSTOP_MS = 1_000;
const GOODBYE_MS = 2_000;
const MAX_LIST_PAGES = 100;
// The agents SDK reserves this name for an output contract. Kept here rather than imported from
// run.ts, so this entry never loads the agent loop.
const RESULT_TOOL_NAME = "submit_result";
// Servers log this. Keep the version in step with package.json: a release bumps both, and
// mcp.test.ts fails while they differ.
const CLIENT_INFO = { name: "@providerkit/agents", version: "0.3.0" };
// A runtime that refuses a header quotes the whole value in its error, key included.
const HEADER_SAFE = /^[\x20-\x7e]+$/;
// What every provider accepts: OpenAI and Anthropic allow letters, digits, _ and - up to 64, and
// Gemini also wants a letter or _ first. MCP names may hold dots and more.
const PROVIDER_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;
const SAFE_AGAIN = "It changed nothing, so it is safe to call again.";
const MAYBE_RAN = "It may have run on the server, so check its effect before calling it again.";

interface Server {
  url: URL;
  origin: string;
  key?: string;
  fetch?: McpServerOptions["fetch"];
  timeoutMs: number;
}

interface Plan {
  /** The tool's name on the server. */
  remote: string;
  /** The name the model calls. */
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  pin: Record<string, unknown>;
  readOnly: boolean;
  needsApproval: boolean;
  timeoutMs: number;
}

/** What the live list says about one tool, read at connect. */
interface Listed {
  readOnly: boolean;
  takes: ReadonlySet<string>;
}

interface Live {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: Map<string, Listed>;
  calls: number;
  /** A transport failure retired it: no new call uses it, and it closes once the last one ends. */
  stale: boolean;
}

/** A failure whose message we wrote or cleaned, so the model and the journal may read it. */
class McpToolError extends Error {
  constructor(message: string) {
    // Core's messageOf reduces a message holding <title> to that title, which would drop a host's
    // fence around server text along with everything else.
    super(message.replace(/<title>/gi, "&lt;title>"));
    this.name = "McpToolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new TypeError(`${label} must be a number of milliseconds above 0.`);
  return value;
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

function readServer(options: McpServerOptions): Server {
  let url: URL | undefined;
  try {
    url = new URL(options.url);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:"))
    throw new TypeError(
      "url must be an http or https address, such as https://docs.example.com/mcp.",
    );
  if (
    options.key !== undefined &&
    (typeof options.key !== "string" || !HEADER_SAFE.test(options.key) || !options.key.trim())
  )
    throw new TypeError(
      "The key is empty or holds a character that cannot be sent in a header (a line break or a character outside plain ASCII). Paste the key again.",
    );
  if (options.fetch !== undefined && typeof options.fetch !== "function")
    throw new TypeError("fetch must be a function.");
  return {
    url,
    // The origin alone names the server in messages: a path or query string can carry a token,
    // and a URL can carry a user name and password.
    origin: url.origin,
    // Headers trims trailing spaces. Authentication and scrubbing must use the same credential.
    key: options.key?.trim(),
    fetch: options.fetch,
    timeoutMs: positive(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),
  };
}

function newClient(server: Server): { client: Client; transport: StreamableHTTPClientTransport } {
  // The SDK follows a redirect only inside the same origin by default, so the key never travels
  // to another host.
  const transport = new StreamableHTTPClientTransport(server.url, {
    ...(server.key ? { requestInit: { headers: { Authorization: `Bearer ${server.key}` } } } : {}),
    ...(server.fetch ? { fetch: server.fetch } : {}),
  });
  return { client: new Client(CLIENT_INFO), transport };
}

// Ported from TanStack AI's listPages (packages/ai-mcp/src/list-pages.ts, MIT, Copyright (c) 2025
// Tanner Linsley): read every page, refuse a cursor that repeats and cap the page count, so a
// server cannot keep a connect busy forever. The raw request also keeps the SDK from compiling
// each tool's output schema, which this entry never uses and which is server text.
async function listAll(client: Client, options: RequestOptions): Promise<ListedTool[]> {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await client.request(
      { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema,
      options,
    );
    tools.push(...result.tools);
    if (!result.nextCursor) return tools;
    if (result.nextCursor === cursor)
      throw new Error("The server sent the same page of tools twice.");
    cursor = result.nextCursor;
  }
  throw new Error(`The server listed more than ${MAX_LIST_PAGES} pages of tools.`);
}

/** Resolves when `promise` settles or after `ms`, whichever comes first. Never rejects. */
function settled(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

async function goodbye(client: Client, transport: StreamableHTTPClientTransport): Promise<void> {
  // Ending the session lets the server free it at once. A server that is down must not hold up a
  // host's shutdown, so the goodbye gets two seconds before the transport closes anyway.
  await settled(transport.terminateSession(), GOODBYE_MS);
  await client.close().catch(() => {});
}

/** Rejects with the signal's reason when it aborts first. */
function raced<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

async function connectAndList(
  client: Client,
  transport: StreamableHTTPClientTransport,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ListedTool[]> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const request = { timeout: timeoutMs + BACKSTOP_MS, signal: both };
  try {
    both.throwIfAborted();
    // The SDK's request timeout does not cover notifications/initialized. Bound the entire
    // handshake and every page together, and close the transport to stop a pending notification.
    return await raced(
      client.connect(transport, request).then(() => {
        both.throwIfAborted();
        return listAll(client, request);
      }),
      both,
    );
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

function httpStatus(err: unknown): string {
  return err instanceof StreamableHTTPError && typeof err.code === "number"
    ? ` (HTTP ${err.code})`
    : "";
}

/** A JSON-RPC error's own words: the SDK adds "MCP error <code>: " on each side of the wire. */
function serverWords(err: McpError): string {
  return err.message.replace(/^(?:MCP error -?\d+: )+/, "");
}

/** The model's copy of a recorded schema, without the pinned arguments. */
function modelSchema(schema: Record<string, unknown>, pinned: readonly string[]): JsonObjectSchema {
  // The dialect URI goes, as in core's zod entry: OpenAI's strict mode and Gemini reject a whole
  // tool over that one key. A server can also leave out `properties`, which some providers need.
  const { $schema: _dialect, ...copy } = structuredClone(schema);
  const properties = isRecord(copy.properties) ? { ...copy.properties } : {};
  for (const key of pinned) delete properties[key];
  const required = Array.isArray(copy.required)
    ? copy.required.filter((key): key is string => typeof key === "string" && !pinned.includes(key))
    : undefined;
  return { ...copy, type: "object", properties, ...(required ? { required } : {}) };
}

/** Reject rather than rewrite metadata: changing a name or schema can change what a call does. */
function checkMetadata(value: unknown, key: string | undefined): void {
  if (!key) return;
  if (typeof value === "string" && value.includes(key))
    throw new McpToolError(
      "The MCP tool metadata contains the server's key. Remove the key from tool names, descriptions and schemas before using these tools.",
    );
  if (typeof value === "object" && value !== null) {
    for (const [name, item] of Object.entries(value)) {
      checkMetadata(name, key);
      checkMetadata(item, key);
    }
  }
}

function plan(options: McpToolsOptions, server: Server): Plan[] {
  if (!Array.isArray(options.recorded))
    throw new TypeError("recorded must be the list that listMcpTools returned.");
  if (!isRecord(options.allow))
    throw new TypeError("allow must name the tools the model may call, such as { search: {} }.");
  if (options.prefix !== undefined && (typeof options.prefix !== "string" || !options.prefix))
    throw new TypeError("prefix must be a non-empty string, such as docs.");
  checkMetadata([options.recorded, Object.keys(options.allow), options.prefix], server.key);
  const records = new Map<string, McpToolRecord>();
  for (const record of options.recorded) {
    // Records usually come from a saved JSON file, which no compiler checked.
    if (typeof record?.name !== "string")
      throw new TypeError("Every recorded tool needs a name. Record the server's tools again.");
    if (records.has(record.name))
      throw new TypeError(`The recorded tools hold "${record.name}" twice. Record them again.`);
    records.set(record.name, record);
  }
  const names = new Map<string, string>();
  return Object.entries(options.allow).map(([remote, policy]) => {
    const record = records.get(remote);
    if (!record)
      throw new TypeError(
        `"${remote}" is in allow but not in the recorded tools. Record the server's tools again with listMcpTools, or remove it from allow.`,
      );
    if (!isRecord(policy)) throw new TypeError(`allow.${remote} must be an object, such as {}.`);
    const schema: unknown = record.inputSchema;
    if (!isRecord(schema) || schema.type !== "object")
      throw new TypeError(`The recorded inputSchema of "${remote}" is not a JSON object schema.`);
    const takes = isRecord(schema.properties) ? schema.properties : {};

    const pin = policy.pin === undefined ? {} : policy.pin;
    if (!isRecord(pin)) throw new TypeError(`allow.${remote}.pin must be an object of arguments.`);
    checkMetadata(Object.keys(pin), server.key);
    const unknown = Object.keys(pin).filter((key) => !Object.hasOwn(takes, key));
    // A typo here would leave the real argument in the model's hands while the app believes it
    // is fixed, so a pin must name an argument the recorded schema declares.
    if (unknown.length)
      throw new TypeError(
        `allow.${remote}.pin sets ${quoted(unknown)}, which "${remote}" does not take. Check the names against its recorded inputSchema.`,
      );

    if (policy.readOnly !== undefined && policy.readOnly !== false)
      throw new TypeError(
        `allow.${remote}.readOnly can only be false. Whether "${remote}" is read-only comes from the server's readOnlyHint.`,
      );
    // Only the server's own hint makes a tool read-only. The host can take that away, never add it.
    const readOnly = record.annotations?.readOnlyHint === true && policy.readOnly !== false;
    if (policy.needsApproval !== undefined && typeof policy.needsApproval !== "boolean")
      throw new TypeError(`allow.${remote}.needsApproval must be true or false.`);
    if (!readOnly && policy.needsApproval === undefined)
      throw new TypeError(
        `"${remote}" may change data on the server. Set needsApproval: true to ask a person before each call, or needsApproval: false to let it run without asking.`,
      );

    const description = policy.description ?? record.description ?? "";
    if (typeof description !== "string")
      throw new TypeError(`allow.${remote}.description must be a string.`);

    const name = (options.prefix ? `${options.prefix}_${remote}` : remote).replace(
      /[^A-Za-z0-9_-]/g,
      "_",
    );
    checkMetadata([name, description], server.key);
    if (!PROVIDER_NAME.test(name))
      throw new TypeError(
        `"${name}" cannot be a tool name: providers accept up to 64 letters, digits, _ and -, starting with a letter or _. Set a shorter prefix, or one that starts with a letter.`,
      );
    if (name === RESULT_TOOL_NAME)
      throw new TypeError(
        `"${RESULT_TOOL_NAME}" is reserved by @providerkit/agents for an agent's result. Set a prefix.`,
      );
    const clash = names.get(name);
    if (clash !== undefined)
      throw new TypeError(
        `"${clash}" and "${remote}" would both reach the model as "${name}". Allow only one of them.`,
      );
    names.set(name, remote);

    return {
      remote,
      name,
      description,
      inputSchema: modelSchema(schema, Object.keys(pin)),
      pin: structuredClone(pin),
      readOnly,
      needsApproval: policy.needsApproval ?? false,
      timeoutMs: positive(policy.timeoutMs ?? server.timeoutMs, `allow.${remote}.timeoutMs`),
    };
  });
}

/** Why a call must not go out, judged against the list the server sent at connect. */
function refusal(plan: Plan, listed: Listed | undefined): string | undefined {
  if (!listed)
    return `${plan.name} did not run: the server no longer has a tool named "${plan.remote}".`;
  if (plan.readOnly && !listed.readOnly)
    return `${plan.name} did not run: the server no longer marks "${plan.remote}" read-only, and this app allowed it only as a read-only tool.`;
  // A pinned argument usually scopes the call. If the server renamed it, sending the call would
  // drop that scope without anyone noticing.
  const dropped = Object.keys(plan.pin).filter((key) => !listed.takes.has(key));
  if (dropped.length)
    return `${plan.name} did not run: "${plan.remote}" on the server no longer takes ${quoted(dropped)}, which this app sets.`;
  return undefined;
}

/** A call result as text. Read loosely, so a content type newer than this SDK still shows up. */
function textOf(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length === 0 && result.structuredContent !== undefined)
    return JSON.stringify(result.structuredContent) ?? "";
  return content.map(partText).join("\n");
}

const PART_WORDS: Record<string, string> = {
  image: "image",
  audio: "audio",
  resource_link: "link",
  resource: "file",
};

function partText(part: unknown): string {
  if (!isRecord(part)) return "[content not shown]";
  if (part.type === "text" && typeof part.text === "string") return part.text;
  const resource = isRecord(part.resource) ? part.resource : undefined;
  if (part.type === "resource" && typeof resource?.text === "string") return resource.text;
  // Something that cannot be shown still says it was there: a model told nothing assumes nothing
  // came back.
  const word = (typeof part.type === "string" && PART_WORDS[part.type]) || "content";
  const media = resource ? resource.mimeType : part.mimeType;
  return typeof media === "string" && MEDIA_TYPE.test(media)
    ? `[${word} not shown: ${media}]`
    : `[${word} not shown]`;
}

/**
 * Lists a server's tools once, so a developer can save them in the app and pass them to
 * `mcpTools` as `recorded`. Run it when you add a server or want to take its changes.
 */
export async function listMcpTools(
  options: McpServerOptions & { signal?: AbortSignal },
): Promise<McpToolRecord[]> {
  const server = readServer(options);
  const { client, transport } = newClient(server);
  const scrub = scrubber(server.key);
  try {
    const listed = await connectAndList(client, transport, server.timeoutMs, options.signal);
    const records = listed.map((tool): McpToolRecord => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
      ...(tool.annotations?.readOnlyHint === undefined
        ? {}
        : { annotations: { readOnlyHint: tool.annotations.readOnlyHint } }),
    }));
    checkMetadata(records, server.key);
    return records;
  } catch (err) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (err instanceof McpToolError) throw err;
    const said =
      err instanceof McpError && err.code !== ErrorCode.ConnectionClosed
        ? scrub(serverWords(err))
        : "";
    throw new Error(
      `Could not list the tools of the MCP server at ${server.origin}${httpStatus(err)}.${said ? ` The server said: ${said}` : ""}`,
    );
  } finally {
    await goodbye(client, transport);
  }
}

function scrubber(key: string | undefined): (text: string) => string {
  // A server can echo the request back, headers included.
  return key ? (text) => text.replaceAll(key, "[key removed]") : (text) => text;
}

/**
 * Core tools for the tools an app allows on one MCP server. Building them does no I/O; the first
 * call connects, and a call after a failure or `close()` connects again.
 */
export function mcpTools(options: McpToolsOptions): McpTools {
  const server = readServer(options);
  const plans = plan(options, server);
  if (options.wrap !== undefined && typeof options.wrap !== "function")
    throw new TypeError("wrap must be a function that returns the text the model reads.");
  const wrap = options.wrap ?? ((text: string) => text);
  const scrub = scrubber(server.key);

  let current: Promise<Live> | undefined;
  const open = new Set<Live>();

  async function shut(live: Live): Promise<void> {
    if (!open.delete(live)) return;
    await goodbye(live.client, live.transport);
  }

  // One connection serves every tool of this server. It is not tied to any one call's signal: a
  // call that gives up stops waiting, and the connection stays for the next one.
  function connect(): Promise<Live> {
    const live: Live = { ...newClient(server), tools: new Map(), calls: 0, stale: false };
    open.add(live);
    const pending = (async () => {
      for (const tool of await connectAndList(live.client, live.transport, server.timeoutMs)) {
        live.tools.set(tool.name, {
          readOnly: tool.annotations?.readOnlyHint === true,
          takes: new Set(Object.keys(tool.inputSchema.properties ?? {})),
        });
      }
      return live;
    })();
    // A failed connect is not kept: the next call tries again.
    pending.catch(() => {
      if (current === pending) current = undefined;
      void shut(live);
    });
    return pending;
  }

  async function acquire(pending: Promise<Live>, signal: AbortSignal) {
    const live = await raced(pending, signal);
    live.calls++;
    return {
      live,
      retire() {
        live.stale = true;
        if (current === pending) current = undefined;
      },
      release() {
        live.calls--;
        if (live.stale && live.calls === 0) void shut(live);
      },
    };
  }

  function timedOut(plan: Plan, sent: boolean, ms = plan.timeoutMs): ToolTimeoutError {
    const error = new ToolTimeoutError(plan.name, ms);
    error.message = sent
      ? `${plan.name} timed out after ${ms} ms. ${plan.readOnly ? SAFE_AGAIN : MAYBE_RAN}`
      : `${plan.name} did not run: connecting to the MCP server at ${server.origin} took longer than ${ms} ms.`;
    return error;
  }

  /** The call went out and no answer came back, so only a refusal proves it did not run. */
  function lost(plan: Plan, err: unknown): string {
    const status = err instanceof StreamableHTTPError ? err.code : undefined;
    // Streamable HTTP answers a request it ran with 200. A 4xx is the transport turning it away
    // first: a session the server forgot after a restart, a refused key, a full queue.
    if (typeof status === "number" && status >= 400 && status < 500)
      return `${plan.name} did not run: the MCP server at ${server.origin} refused the request (HTTP ${status}).`;
    return `The connection to the MCP server at ${server.origin} failed before ${plan.name} returned${httpStatus(err)}. ${plan.readOnly ? SAFE_AGAIN : MAYBE_RAN}`;
  }

  function build(plan: Plan): Tool<Record<string, unknown>, string> {
    const pinned = Object.keys(plan.pin);

    function validate(raw: unknown): Record<string, unknown> {
      const args = raw === undefined || raw === null ? {} : raw;
      if (!isRecord(args)) throw new Error("send the arguments as one JSON object.");
      const sent = pinned.filter((key) => Object.hasOwn(args, key));
      // The model never saw these keys, so sending one is a guess or an injection. Refusing it
      // shows the attempt; quietly overwriting it would hide it.
      if (sent.length)
        throw new Error(
          `do not send ${quoted(sent)}. The app sets ${sent.length === 1 ? "it" : "them"}.`,
        );
      return args;
    }

    async function run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      // Core's typed call skips validate. Check both paths, and inject pins only here so invoke's
      // validated input does not look like an override when it reaches this boundary.
      const input = { ...validate(args), ...structuredClone(plan.pin) };
      // Core hands every run its own signal: the caller's abort and core's ceiling, bridged.
      const signal = ctx.signal ?? new AbortController().signal;
      let deadline: AbortSignal | undefined;
      let sent = false;
      let lease: Awaited<ReturnType<typeof acquire>> | undefined;
      let result: Record<string, unknown>;
      // Only the connection and the request sit in this try, so a host's wrap that throws is
      // reported as its own failure, never as a lost connection.
      try {
        // Start the connection's clock first. With equal budgets it must retire before this
        // call's deadline lets the next caller reuse the still-pending connection.
        const pending = (current ??= connect());
        deadline = AbortSignal.timeout(plan.timeoutMs);
        const both = AbortSignal.any([signal, deadline]);
        lease = await acquire(pending, both);
        const why = refusal(plan, lease.live.tools.get(plan.remote));
        if (why) throw new McpToolError(why);
        sent = true;
        result = await lease.live.client.request(
          { method: "tools/call", params: { name: plan.remote, arguments: input } },
          ResultSchema,
          // The SDK's own clock gets the backstop too, so our deadline is the one that speaks.
          { signal: both, timeout: plan.timeoutMs + BACKSTOP_MS },
        );
      } catch (err) {
        // The caller's abort, or core's ceiling, leaves untouched: core reports it as such.
        if (signal.aborted) throw signal.reason;
        if (err instanceof McpToolError) throw err;
        // Never sent again from here, by this entry or after a reconnect: a call that may have
        // changed data is the model's to check, with the words below.
        if (deadline?.aborted) throw timedOut(plan, sent);
        if (!sent && err instanceof DOMException && err.name === "TimeoutError")
          throw timedOut(plan, false, server.timeoutMs);
        // A failed connect is never the server's words: only the status names what went wrong.
        if (!sent)
          throw new McpToolError(
            `${plan.name} did not run: connecting to the MCP server at ${server.origin} failed${httpStatus(err)}.`,
          );
        // The server answered with a JSON-RPC error. The connection is fine.
        if (err instanceof McpError && err.code !== ErrorCode.ConnectionClosed) {
          const said = scrub(serverWords(err));
          throw new McpToolError(
            said ? wrap(said, plan.name) : `${plan.name} failed and the server gave no reason.`,
          );
        }
        lease?.retire();
        throw new McpToolError(lost(plan, err));
      } finally {
        lease?.release();
      }
      const text = scrub(textOf(result));
      if (result.isError === true)
        throw new McpToolError(
          text ? wrap(text, plan.name) : `${plan.name} failed and the server gave no reason.`,
        );
      return text ? wrap(text, plan.name) : `${plan.name} finished and returned no content.`;
    }

    return defineTool<Record<string, unknown>, string>({
      name: plan.name,
      description: plan.description,
      inputSchema: plan.inputSchema,
      validate,
      run,
      summarize: (text) => text,
      timeoutMs: plan.timeoutMs + BACKSTOP_MS,
      isReadOnly: plan.readOnly,
      needsApproval: plan.needsApproval,
      isConcurrencySafe: plan.readOnly,
    });
  }

  return {
    tools: plans.map(build),
    async close() {
      current = undefined;
      await Promise.all([...open].map(shut));
    },
  };
}
