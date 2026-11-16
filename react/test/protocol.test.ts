import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, emptyChatView, parseChatEvent, reduceChat } from "../src/protocol.ts";

type Json = Record<string, unknown>;

/** Any write to the input throws from here on, so a parser that edits what it reads fails. */
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

/** One complete part of every kind, with every optional field set. */
const parts: Record<string, Json> = {
  text: { type: "text", id: "t", text: "Hello", settled: false, agentId: "g" },
  attachment: {
    type: "attachment",
    id: "a",
    name: "notes.pdf",
    mediaType: "application/pdf",
    size: 1200,
    url: "https://files.example/notes.pdf",
  },
  source: {
    type: "source",
    id: "s",
    marker: "1",
    title: "Indexing guide",
    url: "https://example.com/guide",
    snippet: "An index is a sorted copy of one column.",
  },
  tool: {
    type: "tool",
    id: "c",
    name: "search",
    label: "Searching the docs",
    state: "running",
    summary: "3 results",
    detail: "Query: database index",
    data: { rows: [1, 2] },
    agentId: "g",
  },
  agent: { type: "agent", id: "g", parentId: "p", label: "Researcher", state: "running" },
  approval: {
    type: "approval",
    id: "q",
    title: "Send the email?",
    summary: "To 3 people",
    state: "pending",
    expiresAt: 1_800_000_000_000,
  },
  data: { type: "data", id: "d", kind: "invoice", data: { total: 12, lines: [{ sku: "a" }] } },
};

const message: Json = {
  id: "m",
  clientId: "client-1",
  role: "assistant",
  state: "live",
  createdAt: 1_700_000_000_000,
  parts: Object.values(parts),
};

const run: Json = {
  id: "run-1",
  status: "failed",
  messageId: "m",
  error: {
    code: "rate_limited",
    message: "Too many requests. Try again in a minute.",
    retryable: true,
  },
};

const events: Record<string, Json> = {
  snapshot: { v: 1, type: "snapshot", messages: [message], run },
  message: { v: 1, type: "message", message },
  part: { v: 1, type: "part", messageId: "m", part: parts.text },
  text: { v: 1, type: "text", messageId: "m", partId: "t", delta: " world" },
  run: { v: 1, type: "run", run },
};

const partEvent = (part: unknown) => parseChatEvent({ v: 1, type: "part", messageId: "m", part });
const messageEvent = (value: unknown) => parseChatEvent({ v: 1, type: "message", message: value });
const runEvent = (value: unknown) => parseChatEvent({ v: 1, type: "run", run: value });

function without(value: Json, key: string): Json {
  const { [key]: _removed, ...rest } = value;
  return rest;
}

describe("parseChatEvent", () => {
  it("speaks version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it.each(Object.entries(events))("reads a complete %s event field for field", (_type, event) => {
    const input = frozen(structuredClone({ ...event, seq: 4, segment: "segment-1" }));
    expect(parseChatEvent(input)).toEqual(input);
  });

  it("builds new objects, so the caller's value is never the one in state", () => {
    const part = { ...parts.text };
    const sent = { ...message, parts: [part] };
    const parsed = parseChatEvent(frozen({ v: 1, type: "message", message: sent }));
    if (parsed?.type !== "message") throw new Error("Expected a message event");
    expect(parsed.message).toEqual(sent);
    expect(parsed.message).not.toBe(sent);
    expect(parsed.message.parts[0]).not.toBe(part);
  });

  // A bare array in an `each` table is spread into arguments, so array cases are wrapped.
  it.each([[null], [undefined], ["snapshot"], [1], [true], [[]], [[events.run]]])(
    "returns null for %j, which is not an event object",
    (value) => {
      expect(parseChatEvent(value)).toBeNull();
    },
  );

  it.each([2, 0, "1", null, undefined])("returns null for version %j", (v) => {
    expect(parseChatEvent({ ...events.run, v })).toBeNull();
    expect(parseChatEvent(without(events.run ?? {}, "v"))).toBeNull();
  });

  it.each(["typing", "", 7, null, undefined])(
    "skips an event of type %j, so a newer host does not break this client",
    (type) => {
      expect(parseChatEvent({ ...events.run, type })).toBeNull();
    },
  );

  describe("the envelope", () => {
    it.each([-1, 1.5, "3", Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, true, {}])(
      "refuses seq %j",
      (seq) => {
        expect(parseChatEvent({ ...events.run, seq })).toBeNull();
      },
    );

    it.each(["", 5, true, {}])("refuses segment %j", (segment) => {
      expect(parseChatEvent({ ...events.run, segment })).toBeNull();
    });

    it("accepts seq 0, and reads a null seq or segment as absent", () => {
      expect(parseChatEvent({ ...events.run, seq: 0 })).toMatchObject({ seq: 0 });
      const bare = parseChatEvent({ ...events.run, seq: null, segment: null });
      expect(bare).toEqual(events.run);
      expect(Object.keys(bare ?? {})).not.toContain("seq");
      expect(Object.keys(bare ?? {})).not.toContain("segment");
    });
  });

  describe("parts", () => {
    it.each(Object.entries(parts))("reads a complete %s part", (_type, part) => {
      expect(partEvent(part)).toEqual({ v: 1, type: "part", messageId: "m", part });
    });

    it.each([
      ["text", { type: "text", id: "t", text: "", settled: true }],
      ["attachment", { type: "attachment", id: "a", name: "notes.pdf", mediaType: "" }],
      ["source", { type: "source", id: "s", title: "Indexing guide" }],
      ["tool", { type: "tool", id: "c", label: "Searching", state: "done" }],
      ["agent", { type: "agent", id: "g", label: "Researcher", state: "completed" }],
      ["approval", { type: "approval", id: "q", title: "Send the email?", state: "denied" }],
      ["data", { type: "data", id: "d", kind: "invoice", data: null }],
    ])("reads a %s part with only its required fields", (_type, part) => {
      const parsed = partEvent(part);
      expect(parsed).toEqual({ v: 1, type: "part", messageId: "m", part });
      if (parsed?.type !== "part") throw new Error("Expected a part event");
      expect(Object.keys(parsed.part).sort()).toEqual(Object.keys(part).sort());
    });

    // [part type, field, a value of the wrong type]. A required field is also tried missing.
    const required: [string, string, unknown][] = [
      ["text", "id", ""],
      ["text", "id", 7],
      ["text", "text", 7],
      ["text", "settled", "yes"],
      ["attachment", "id", null],
      ["attachment", "name", 7],
      ["attachment", "mediaType", null],
      ["source", "id", {}],
      ["source", "title", ["Guide"]],
      ["tool", "id", ""],
      ["tool", "label", 7],
      ["tool", "state", "pending"],
      ["tool", "state", 1],
      ["agent", "id", ""],
      ["agent", "label", null],
      ["agent", "state", "idle"],
      ["agent", "state", "done"],
      ["approval", "id", 0],
      ["approval", "title", {}],
      ["approval", "state", "running"],
      ["data", "id", ""],
      ["data", "kind", ""],
      ["data", "kind", 7],
    ];
    it.each(required)("refuses a %s part whose %s is %j, or missing", (type, field, value) => {
      const part = parts[type] ?? {};
      expect(partEvent({ ...part, [field]: value })).toBeNull();
      expect(partEvent(without(part, field))).toBeNull();
    });

    const optionals: [string, string, unknown][] = [
      ["text", "agentId", ""],
      ["text", "agentId", 7],
      ["attachment", "size", -1],
      ["attachment", "size", "1200"],
      ["attachment", "size", Number.NaN],
      ["attachment", "url", 7],
      ["source", "marker", 1],
      ["source", "url", {}],
      ["source", "snippet", false],
      ["tool", "name", 7],
      ["tool", "summary", {}],
      ["tool", "detail", []],
      ["tool", "agentId", ""],
      ["tool", "agentId", 7],
      ["agent", "parentId", ""],
      ["agent", "parentId", 7],
      ["approval", "summary", 7],
      ["approval", "expiresAt", "soon"],
      ["approval", "expiresAt", Number.POSITIVE_INFINITY],
    ];
    it.each(optionals)(
      "refuses a %s part whose optional %s is %j, and reads null as absent",
      (type, field, value) => {
        const part = parts[type] ?? {};
        expect(partEvent({ ...part, [field]: value })).toBeNull();
        const parsed = partEvent({ ...part, [field]: null });
        if (parsed?.type !== "part") throw new Error("Expected a part event");
        expect(parsed.part).toEqual(without(part, field));
        expect(Object.keys(parsed.part)).not.toContain(field);
      },
    );

    it.each(["idle", "running", "waiting", "completed", "stopped", "limited", "failed"])(
      "takes agent state %s only when a specialist run can be in it",
      (state) => {
        const parsed = partEvent({ ...parts.agent, state });
        if (state === "idle") expect(parsed).toBeNull();
        else expect(parsed).toMatchObject({ part: { state } });
      },
    );

    it.each([[null], ["text"], [7], [[]], [{ id: "x" }], [{ type: 7, id: "x" }]])(
      "refuses %j as a part",
      (part) => {
        expect(partEvent(part)).toBeNull();
      },
    );

    it("skips a part event whose part type it does not know", () => {
      expect(partEvent({ type: "chart", id: "x", points: [1, 2] })).toBeNull();
    });

    it("refuses a part event without a message id", () => {
      for (const messageId of ["", 7, null, undefined])
        expect(parseChatEvent({ ...events.part, messageId })).toBeNull();
    });

    it.each(["tool", "data"] as const)(
      "passes %s data through as it is, the same object and not a copy",
      (type) => {
        const data = { rows: [{ id: 1, extra: { deep: true } }], note: null };
        const parsed = partEvent({ ...parts[type], data });
        if (parsed?.type !== "part" || (parsed.part.type !== "tool" && parsed.part.type !== "data"))
          throw new Error("Expected a part with data");
        expect(parsed.part.data).toBe(data);
      },
    );

    it("reads a host part whose data is missing or any JSON value", () => {
      for (const data of [undefined, null, 0, "", false, [], { a: 1 }]) {
        const parsed = partEvent({ type: "data", id: "d", kind: "divider", data });
        if (parsed?.type !== "part" || parsed.part.type !== "data")
          throw new Error("Expected a data part");
        expect(parsed.part).toEqual({ type: "data", id: "d", kind: "divider", data });
      }
    });

    it.each([[null], [0], [""], [false], [[]]])(
      "keeps tool data %j, which is still JSON",
      (data) => {
        const parsed = partEvent({ ...parts.tool, data });
        if (parsed?.type !== "part" || parsed.part.type !== "tool")
          throw new Error("Expected a tool");
        expect(parsed.part.data).toBe(data);
        expect(Object.keys(parsed.part)).toContain("data");
      },
    );

    it("leaves data out when the host sent none", () => {
      const parsed = partEvent(without(parts.tool ?? {}, "data"));
      if (parsed?.type !== "part") throw new Error("Expected a part event");
      expect(Object.keys(parsed.part)).not.toContain("data");
    });
  });

  describe("messages", () => {
    it.each([
      ["id", ""],
      ["id", 7],
      ["role", "system"],
      ["role", "tool"],
      // A name every object inherits is still not a role or a state, and neither is a list
      // that would read as one if it were turned into text.
      ["role", "toString"],
      ["role", ["user"]],
      ["state", "constructor"],
      ["state", "streaming"],
      ["state", null],
      ["parts", "Hello"],
      ["parts", { 0: parts.text }],
      ["parts", null],
    ])("refuses a message whose %s is %j, or missing", (field, value) => {
      expect(messageEvent({ ...message, [field]: value })).toBeNull();
      expect(messageEvent(without(message, field))).toBeNull();
    });

    it.each([
      ["clientId", ""],
      ["clientId", 7],
      ["createdAt", "today"],
      ["createdAt", Number.NaN],
    ])("refuses a message whose optional %s is %j, and reads null as absent", (field, value) => {
      expect(messageEvent({ ...message, [field]: value })).toBeNull();
      const parsed = messageEvent({ ...message, [field]: null });
      if (parsed?.type !== "message") throw new Error("Expected a message event");
      expect(parsed.message).toEqual(without(message, field));
    });

    it.each([[null], ["m"], [7], [[]]])("refuses %j as a message", (value) => {
      expect(messageEvent(value)).toBeNull();
    });

    it.each(["user", "assistant"])("reads role %s", (role) => {
      expect(messageEvent({ ...message, role })).toMatchObject({ message: { role } });
    });

    it.each(["sending", "live", "settled", "failed", "stopped"])("reads state %s", (state) => {
      expect(messageEvent({ ...message, state })).toMatchObject({ message: { state } });
    });

    it("reads a message with no parts", () => {
      expect(messageEvent({ id: "m", role: "user", state: "settled", parts: [] })).toEqual({
        v: 1,
        type: "message",
        message: { id: "m", role: "user", state: "settled", parts: [] },
      });
    });

    it("refuses the whole message when one known part is malformed", () => {
      expect(
        messageEvent({ ...message, parts: [parts.text, { ...parts.tool, state: 1 }] }),
      ).toBeNull();
      expect(messageEvent({ ...message, parts: [parts.text, null] })).toBeNull();
      // A type that is not even a string is broken, not new. Only an unknown name is skipped.
      expect(messageEvent({ ...message, parts: [parts.text, { type: 7, id: "x" }] })).toBeNull();
      expect(messageEvent({ ...message, parts: [parts.text, { id: "x" }] })).toBeNull();
    });

    it("refuses two parts with one id, which could not be told apart", () => {
      expect(
        messageEvent({ ...message, parts: [parts.text, { ...parts.tool, id: "t" }] }),
      ).toBeNull();
    });

    it("leaves out a part type it does not know and keeps the rest of the message", () => {
      const parsed = messageEvent({
        ...message,
        parts: [parts.text, { type: "chart", id: "x", points: [1, 2] }, parts.source],
      });
      if (parsed?.type !== "message") throw new Error("Expected a message event");
      expect(parsed.message.parts).toEqual([parts.text, parts.source]);
    });
  });

  describe("runs", () => {
    it.each(["idle", "running", "waiting", "completed", "stopped", "limited", "failed"])(
      "reads status %s",
      (status) => {
        expect(runEvent({ status })).toEqual({ v: 1, type: "run", run: { status } });
      },
    );

    it.each([
      ["status", "suspended"],
      ["status", undefined],
      ["status", 1],
      ["status", ["running"]],
      ["id", ""],
      ["id", 7],
      ["messageId", ""],
      ["messageId", {}],
      ["error", "It failed"],
      ["error", []],
      ["error", { message: "No code" }],
      ["error", { code: "", message: "Empty code" }],
      ["error", { code: 7, message: "Numeric code" }],
      ["error", { code: "no_message" }],
      ["error", { code: "bad_message", message: 7 }],
      ["error", { code: "bad_flag", message: "Try again.", retryable: "yes" }],
    ])("refuses a run whose %s is %j", (field, value) => {
      expect(runEvent({ ...run, [field]: value })).toBeNull();
    });

    it.each([[null], ["running"], [7], [[]]])("refuses %j as a run", (value) => {
      expect(runEvent(value)).toBeNull();
    });

    it("reads a null id, message id, error or retryable as absent", () => {
      expect(runEvent({ status: "running", id: null, messageId: null, error: null })).toEqual({
        v: 1,
        type: "run",
        run: { status: "running" },
      });
      expect(
        runEvent({ status: "failed", error: { code: "x", message: "", retryable: null } }),
      ).toEqual({
        v: 1,
        type: "run",
        run: { status: "failed", error: { code: "x", message: "" } },
      });
    });
  });

  describe("snapshots", () => {
    it("reads an empty conversation", () => {
      const event = { v: 1, type: "snapshot", messages: [], run: { status: "idle" } };
      expect(parseChatEvent(event)).toEqual(event);
    });

    it.each([
      ["messages", undefined],
      ["messages", null],
      ["messages", { m: message }],
      ["messages", [message, null]],
      ["messages", [message, { ...message, id: "other", role: "system" }]],
      ["run", undefined],
      ["run", { status: "done" }],
    ])("refuses a snapshot whose %s is %j", (field, value) => {
      expect(parseChatEvent({ ...events.snapshot, [field]: value })).toBeNull();
    });

    it("refuses two messages with one id", () => {
      expect(parseChatEvent({ ...events.snapshot, messages: [message, message] })).toBeNull();
    });
  });

  describe("text deltas", () => {
    it.each([
      ["messageId", ""],
      ["messageId", 7],
      ["partId", ""],
      ["partId", null],
      ["delta", 7],
      ["delta", null],
      ["delta", ["a"]],
    ])("refuses a delta whose %s is %j, or missing", (field, value) => {
      expect(parseChatEvent({ ...events.text, [field]: value })).toBeNull();
      expect(parseChatEvent(without(events.text ?? {}, field))).toBeNull();
    });

    it("reads an empty delta", () => {
      expect(parseChatEvent({ ...events.text, delta: "" })).toMatchObject({ delta: "" });
    });
  });

  it("drops every field it does not know, at every depth", () => {
    const extra = { secret: "do not show", input: { prompt: "private" } };
    const loud = (value: Json): Json => ({ ...value, ...extra });
    const loudMessage = loud({ ...message, parts: Object.values(parts).map(loud) });
    const loudRun = loud({ ...run, error: loud({ code: "rate_limited", message: "Slow down." }) });
    const inputs = [
      loud({ v: 1, type: "snapshot", messages: [loudMessage], run: loudRun }),
      loud({ v: 1, type: "message", message: loudMessage }),
      loud({ v: 1, type: "part", messageId: "m", part: loud(parts.approval ?? {}) }),
      loud({ v: 1, type: "text", messageId: "m", partId: "t", delta: "x" }),
      loud({ v: 1, type: "run", run: loudRun }),
    ];
    for (const input of inputs) {
      const parsed = parseChatEvent(input);
      expect(parsed).not.toBeNull();
      const wire = JSON.stringify(parsed);
      expect(wire).not.toContain("secret");
      expect(wire).not.toContain("private");
    }
    // A tool's own named fields are still an allowlist: only what sits inside `data` passes.
    const tool = partEvent(loud({ ...parts.tool, data: { secret: "host chose to send this" } }));
    if (tool?.type !== "part" || tool.part.type !== "tool") throw new Error("Expected a tool");
    expect(Object.keys(tool.part)).not.toContain("secret");
    expect(Object.keys(tool.part)).not.toContain("input");
    expect(tool.part.data).toEqual({ secret: "host chose to send this" });
  });

  it("feeds the reducer from the same entry", () => {
    const wire = [
      { v: 1, type: "message", message: { id: "m", role: "assistant", state: "live", parts: [] } },
      {
        v: 1,
        type: "part",
        messageId: "m",
        part: { type: "text", id: "t", text: "", settled: false },
      },
      { v: 1, type: "text", messageId: "m", partId: "t", delta: "Hello" },
      { v: 2, type: "text", messageId: "m", partId: "t", delta: " from another version" },
      { v: 1, type: "text", messageId: "m", partId: "t", delta: 7 },
      { v: 1, type: "typing", messageId: "m" },
      { v: 1, type: "text", messageId: "m", partId: "t", delta: " world" },
    ];
    let view = emptyChatView();
    for (const line of wire) {
      const event = parseChatEvent(JSON.parse(JSON.stringify(line)));
      if (event) view = reduceChat(view, event);
    }
    expect(view.messages).toEqual([
      {
        id: "m",
        role: "assistant",
        state: "live",
        parts: [{ type: "text", id: "t", text: "Hello world", settled: false }],
      },
    ]);
  });
});
