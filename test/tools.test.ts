import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineTool, ToolRegistry, ToolTimeoutError } from "../src/tools.ts";
import { zodTool, toJsonObjectSchema } from "../src/zod.ts";
import { clampToSchema } from "../src/schema.ts";
import type { JsonObjectSchema } from "../src/types.ts";

const schema: JsonObjectSchema = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};

describe("defineTool", () => {
  it("runs and summarizes", async () => {
    const tool = defineTool<{ q: string }, { hits: number }>({
      name: "search",
      description: "search",
      inputSchema: schema,
      run: async ({ q }) => ({ hits: q.length }),
      summarize: (out) => `${out.hits} hits`,
    });
    const outcome = await tool.invoke({ q: "cats" });
    expect(outcome).toMatchObject({ ok: true, summary: "4 hits" });
  });

  it("reports a failure instead of throwing — a broken tool is data for the model", async () => {
    const tool = defineTool({
      name: "boom",
      description: "throws",
      inputSchema: schema,
      run: async () => {
        throw new Error("upstream is down");
      },
    });
    const outcome = await tool.invoke({ q: "x" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("failed");
      expect(outcome.error).toBe("upstream is down");
    }
  });

  it("reports invalid input separately — the model can fix that one itself", async () => {
    const tool = defineTool<{ q: string }, string>({
      name: "search",
      description: "search",
      inputSchema: schema,
      validate: (raw) => {
        if (typeof (raw as { q?: unknown })?.q !== "string") throw new Error("q must be a string");
        return raw as { q: string };
      },
      run: async ({ q }) => q,
    });
    const outcome = await tool.invoke({ q: 42 });
    expect(outcome).toMatchObject({ ok: false, kind: "invalid_input" });
    if (!outcome.ok) expect(outcome.error).toContain("q must be a string");
  });

  it("times out a tool that would hang the run", async () => {
    vi.useFakeTimers();
    try {
      const tool = defineTool({
        name: "slow",
        description: "never returns",
        inputSchema: schema,
        timeoutMs: 1_000,
        run: () => new Promise(() => {}),
      });
      const pending = tool.invoke({ q: "x" });
      await vi.advanceTimersByTimeAsync(1_000);
      const outcome = await pending;
      expect(outcome).toMatchObject({ ok: false, kind: "timeout" });
      if (!outcome.ok) expect(outcome.cause).toBeInstanceOf(ToolTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands `run` a signal that fires on the caller's abort", async () => {
    const controller = new AbortController();
    const tool = defineTool({
      name: "watch",
      description: "honours its signal",
      inputSchema: schema,
      run: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
    });
    const pending = tool.invoke({ q: "x" }, { signal: controller.signal });
    controller.abort(new Error("stop"));
    expect(await pending).toMatchObject({ ok: false, kind: "aborted" });
  });

  it("keeps the model's own call id so the tool message keys correctly", async () => {
    const tool = defineTool({
      name: "echo",
      description: "echo",
      inputSchema: schema,
      run: async () => "ok",
    });
    const outcome = await tool.invoke({ q: "x" }, { callId: "call_abc" });
    expect(outcome.callId).toBe("call_abc");
  });

  it("mints a call id when the provider gave none", async () => {
    const tool = defineTool({
      name: "echo",
      description: "echo",
      inputSchema: schema,
      run: async () => "ok",
    });
    expect((await tool.invoke({ q: "x" })).callId).toBeTruthy();
  });
});

describe("ToolRegistry", () => {
  const make = (name: string) =>
    defineTool({ name, description: name, inputSchema: schema, run: async () => name });

  it("returns definitions in the order asked for — it is part of the cached prefix", () => {
    const registry = new ToolRegistry([make("a"), make("b"), make("c")]);
    expect(registry.definitions(["c", "a"]).map((d) => d.name)).toEqual(["c", "a"]);
  });

  it("silently skips an unknown name rather than failing a whole turn", () => {
    const registry = new ToolRegistry([make("a")]);
    expect(registry.definitions(["a", "ghost"]).map((d) => d.name)).toEqual(["a"]);
  });

  it("looks tools up by name", () => {
    const registry = new ToolRegistry([make("a")]);
    expect(registry.has("a")).toBe(true);
    expect(registry.get("ghost")).toBeUndefined();
  });
});

describe("zodTool", () => {
  it("validates and types the input", async () => {
    const tool = zodTool({
      name: "search",
      description: "search",
      input: z.object({ q: z.string(), limit: z.number().default(10) }),
      run: async ({ q, limit }) => `${q}:${limit}`,
    });
    expect(await tool.invoke({ q: "cats" })).toMatchObject({ ok: true, output: "cats:10" });
  });

  it("reports validation failures in words the MODEL can act on", async () => {
    const tool = zodTool({
      name: "search",
      description: "search",
      input: z.object({ q: z.string() }),
      run: async () => "ok",
    });
    const outcome = await tool.invoke({ q: 42 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("invalid_input");
      expect(outcome.error).toContain("q");
    }
  });

  it("advertises the schema to the model", () => {
    const tool = zodTool({
      name: "search",
      description: "search",
      input: z.object({ q: z.string().describe("what to look for") }),
      run: async () => "ok",
    });
    const definition = tool.definition();
    expect(definition.inputSchema.type).toBe("object");
    expect(JSON.stringify(definition.inputSchema)).toContain("what to look for");
  });

  it("refuses a non-object schema here rather than at the wire", () => {
    expect(() => toJsonObjectSchema(z.string())).toThrow(/must be an object schema/);
  });

  it("clamps overflow when asked — a terminal tool gets no second chance", async () => {
    const tool = zodTool({
      name: "submit",
      description: "submit",
      isTerminal: true,
      clampOverflow: true,
      input: z.object({ summary: z.string().max(10) }),
      run: async (input) => input.summary,
    });
    const outcome = await tool.invoke({ summary: "way past the advertised limit" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.output).toHaveLength(10);
      expect(outcome.output.endsWith("…")).toBe(true);
    }
  });

  it("still rejects a STRUCTURAL problem while clamping — that is not overflow", async () => {
    const tool = zodTool({
      name: "submit",
      description: "submit",
      clampOverflow: true,
      input: z.object({ summary: z.string().max(10) }),
      run: async (input) => input.summary,
    });
    expect(await tool.invoke({ wrong: "field" })).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });
  });
});

describe("clampToSchema", () => {
  it("truncates an over-long string to exactly maxLength, visibly", () => {
    const clamped = clampToSchema("abcdefghij", { type: "string", maxLength: 5 });
    expect(clamped).toBe("abcd…");
    expect((clamped as string).length).toBe(5);
  });

  it("caps an over-full array and clamps its items", () => {
    const node = { type: "array", maxItems: 2, items: { type: "string", maxLength: 3 } };
    expect(clampToSchema(["aaaa", "bbbb", "cccc"], node)).toEqual(["aa…", "bb…"]);
  });

  it("pins numbers into range", () => {
    expect(clampToSchema(99, { type: "number", maximum: 10 })).toBe(10);
    expect(clampToSchema(-5, { type: "number", minimum: 0 })).toBe(0);
  });

  it("walks nested objects", () => {
    const node = {
      type: "object",
      properties: {
        inner: { type: "object", properties: { s: { type: "string", maxLength: 2 } } },
      },
    };
    expect(clampToSchema({ inner: { s: "xyz" } }, node)).toEqual({ inner: { s: "x…" } });
  });

  it("folds through anyOf so nullable fields still clamp", () => {
    const node = { anyOf: [{ type: "string", maxLength: 3 }, { type: "null" }] };
    expect(clampToSchema("abcdef", node)).toBe("ab…");
    expect(clampToSchema(null, node)).toBeNull();
  });

  it("leaves structural problems alone for the real validator", () => {
    // A wrong type is the model misunderstanding the contract, not overrunning it.
    expect(clampToSchema(42, { type: "string", maxLength: 2 })).toBe(42);
    expect(clampToSchema({ unknown: "x" }, { type: "object", properties: {} })).toEqual({
      unknown: "x",
    });
  });
});
