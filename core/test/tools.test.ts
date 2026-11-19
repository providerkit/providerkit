import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { defineTool, ToolRegistry, ToolTimeoutError } from "../src/tools.ts";
import { zodTool, toJsonObjectSchema } from "../src/zod.ts";
import { clampToSchema, isStrictSchema } from "../src/schema.ts";
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
    expect(tool.outputSchema).toBeUndefined();
    const outcome = await tool.invoke({ q: "cats" });
    expect(outcome).toMatchObject({ ok: true, summary: "4 hits" });
  });

  it("keeps output schemas as metadata, not validation or wire fields", async () => {
    const outputSchema = { type: "number" };
    const tool = defineTool<{ q: string }, string>({
      name: "search",
      description: "search",
      inputSchema: schema,
      outputSchema,
      // A mismatched result must still pass through unchanged.
      run: async ({ q }) => q,
    });
    expect(tool.outputSchema).toBe(outputSchema);
    expect(await tool.invoke({ q: "cats" })).toMatchObject({
      ok: true,
      output: "cats",
      summary: '"cats"',
    });
    expect(await tool.call({ q: "dogs" })).toBe("dogs");
    expect(tool.definition()).toStrictEqual({
      name: "search",
      description: "search",
      inputSchema: schema,
    });
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

  // A host asks before it opens an approval: nobody should say yes to a call
  // that comes back `invalid_input` the moment it runs.
  it("accepts() runs the same validate as invoke, and never the tool", async () => {
    const run = vi.fn(async ({ q }: { q: string }) => q);
    const tool = defineTool<{ q: string }, string>({
      name: "search",
      description: "search",
      inputSchema: schema,
      validate: (raw) => {
        if (typeof (raw as { q?: unknown })?.q !== "string") throw new Error("q must be a string");
        return raw as { q: string };
      },
      run,
    });
    expect([tool.accepts({ q: "cats" }), tool.accepts({ q: 42 })]).toEqual([true, false]);
    expect(run).not.toHaveBeenCalled();
    // With no validate, invoke takes anything, so accepts does too.
    const open = defineTool({ name: "open", description: "open", inputSchema: schema, run });
    expect(open.accepts(42)).toBe(true);
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

  it("promises nothing a tool did not state: every flag defaults to false", () => {
    // A write that left `isReadOnly` out was told, after a crash, that it
    // "changed nothing, so it is safe to call again".
    const spec = { name: "write", description: "w", inputSchema: schema, run: async () => "ok" };
    expect(defineTool(spec)).toMatchObject({
      isReadOnly: false,
      isConcurrencySafe: false,
      needsApproval: false,
      isTerminal: false,
    });
    const { inputSchema: _json, ...rest } = spec;
    expect(zodTool({ ...rest, input: z.object({ q: z.string() }) })).toMatchObject({
      isReadOnly: false,
      isConcurrencySafe: false,
    });
    expect(defineTool({ ...spec, isReadOnly: true, isConcurrencySafe: true })).toMatchObject({
      isReadOnly: true,
      isConcurrencySafe: true,
    });
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

  describe("slips it repairs", () => {
    const sheet = zodTool({
      name: "sheet",
      description: "sheet",
      input: z.object({ title: z.string(), rows: z.array(z.object({ qty: z.number() })).max(5) }),
      run: async (input) => input,
    });

    // Seen in production: 13 of 16 spreadsheet calls in a day sent `rows` this
    // way, and each was resent unchanged until the model gave up.
    it("decodes an array sent as a JSON string, and leaves strings the schema took", async () => {
      const outcome = await sheet.invoke({ title: "[1]", rows: JSON.stringify([{ qty: 2 }]) });
      expect(outcome.ok && outcome.output).toEqual({ title: "[1]", rows: [{ qty: 2 }] });
    });

    // Only into the container the schema wants: a decoded "[3]" can never be a number, and the
    // second parse would tell the model about an array it never sent.
    it("leaves a rejected string that is not the JSON array or object the schema wants", async () => {
      const count = zodTool({
        name: "count",
        description: "count",
        input: z.object({ n: z.number() }),
        run: async ({ n }) => n,
      });
      for (const n of ["not json", "42", "null", '"text"', "[3]", '{"n":3}']) {
        expect(await count.invoke({ n }), n).toMatchObject({
          kind: "invalid_input",
          error: "Invalid arguments for count: n: Invalid input: expected number, received string",
        });
      }
      const outcome = await sheet.invoke({ title: "t", rows: '{"qty":2}' });
      expect(!outcome.ok && outcome.error).toContain(
        "rows: Invalid input: expected array, received string",
      );
    });

    it("reports the real problem inside a decoded string", async () => {
      const outcome = await sheet.invoke({ title: "t", rows: JSON.stringify([{ qty: "two" }]) });
      expect(!outcome.ok && outcome.error).toBe(
        "Invalid arguments for sheet: rows.0.qty: Invalid input: expected number, received string",
      );
    });

    // Seen in production: `hooks` sent as `[{ text }]`, the shape of a sibling
    // field, on a research run's last step, which lost the run its brief.
    it("takes a string wrapped as { text }, and nothing looser", async () => {
      const brief = zodTool({
        name: "save_brief",
        description: "save",
        input: z.object({ hooks: z.array(z.string()), title: z.string() }),
        run: async (input) => input.hooks,
      });
      const args = { hooks: [{ text: "a" }, "b"], title: "t" };
      expect(await brief.invoke(args)).toMatchObject({ ok: true, output: ["a", "b"] });
      expect(args.hooks[0]).toEqual({ text: "a" });
      for (const hooks of [[{ text: "a", extra: 1 }], [{ text: 1 }], [{ body: "a" }]]) {
        expect((await brief.invoke({ hooks, title: "t" })).ok, JSON.stringify(hooks)).toBe(false);
      }
      // A wrapper fixed, a real mistake beside it still reported.
      const mixed = await brief.invoke({ hooks: [{ text: "a" }], title: 1 });
      expect(!mixed.ok && mixed.error).toBe(
        "Invalid arguments for save_brief: title: Invalid input: expected string, received number",
      );
    });

    it("clamps a value it repaired, for a terminal tool's one chance", async () => {
      const submit = zodTool({
        name: "submit",
        description: "submit",
        isTerminal: true,
        clampOverflow: true,
        input: z.object({ summary: z.string().max(10) }),
        run: async (input) => input.summary,
      });
      const outcome = await submit.invoke({ summary: { text: "way past the advertised limit" } });
      expect(outcome).toMatchObject({ ok: true, output: "way past …" });
    });

    it("accepts() answers by the same parse as invoke, without running the tool", async () => {
      const run = vi.fn(async () => "ok");
      const tool = zodTool({
        name: "sheet",
        description: "sheet",
        input: z.object({ rows: z.array(z.string()) }),
        run,
      });
      const cases = [
        { rows: ["a"] },
        { rows: '["a"]' },
        { rows: [{ text: "a" }] },
        { rows: [{ text: "a", extra: 1 }] },
        { rows: "a" },
      ];
      const accepted = cases.map((args) => tool.accepts(args));
      expect(run).not.toHaveBeenCalled();
      expect(accepted).toEqual([true, true, true, false, false]);
      for (const [i, args] of cases.entries()) {
        expect((await tool.invoke(args)).ok).toBe(accepted[i]);
      }
    });
  });

  // A 1,000-row sheet can fail on every cell. The count tells the model the
  // five it sees are not the whole problem.
  it("shows the model at most five problems, and counts the rest", async () => {
    const tool = zodTool({
      name: "values",
      description: "values",
      input: z.object({ values: z.array(z.number()) }),
      run: async () => "ok",
    });
    const outcome = await tool.invoke({ values: Array.from({ length: 40 }, () => "x") });
    const issue = (i: number) => `values.${i}: Invalid input: expected number, received string`;
    expect(!outcome.ok && outcome.error).toBe(
      `Invalid arguments for values: ${[0, 1, 2, 3, 4].map(issue).join("; ")}; and 35 more`,
    );
  });

  describe("output", () => {
    // Upstream JSON, typed by nothing until `output` checks it.
    let reply = "";
    const upstream = async (): Promise<unknown> => JSON.parse(reply);
    const lookup = (isReadOnly: boolean) =>
      zodTool({
        name: "lookup",
        description: "lookup",
        isReadOnly,
        input: z.object({ q: z.string() }),
        output: z.object({ hits: z.number() }),
        run: upstream,
      });

    it("hands back the parsed result, so the model never sees keys the schema left out", async () => {
      reply = '{"hits":3,"debug":"internal"}';
      const tool = lookup(true);
      // `run` returns unknown, and the result still has the schema's type.
      expectTypeOf(tool.call).returns.resolves.toEqualTypeOf<{ hits: number }>();
      const outcome = await tool.invoke({ q: "x" });
      expect(outcome.ok && [outcome.output, outcome.summary]).toEqual([{ hits: 3 }, '{"hits":3}']);
    });

    // `run` returns what the schema takes, and the tool returns what the schema makes of it.
    it("types `run` by what a transform takes, and the result by what it makes", async () => {
      const at = z.object({ at: z.string().transform((s) => new Date(s)) });
      const stamp = zodTool({
        name: "stamp",
        description: "stamp",
        input: z.object({}),
        output: at,
        run: async () => ({ at: "1970-01-01T00:00:00.000Z" }),
      });
      expectTypeOf(stamp.call).returns.resolves.toEqualTypeOf<{ at: Date }>();
      expect(await stamp.call({})).toEqual({ at: new Date(0) });
      // Returning the Date the transform makes would fail on every call, so it does not compile.
      const date = async () => ({ at: new Date(0) });
      // @ts-expect-error `run` returns the string the transform takes
      zodTool({ name: "stamp", description: "stamp", input: z.object({}), output: at, run: date });
    });

    // A bad result is the tool's failure, read by the model like any other.
    // A write already ran, so the model is told to check before calling again.
    it.each([
      [true, ""],
      [false, " Check its effect before calling it again."],
    ])("fails a result that breaks it, as data (read-only: %s)", async (isReadOnly, effect) => {
      reply = '{"hits":"3"}';
      const tool = lookup(isReadOnly);
      expect(await tool.invoke({ q: "x" })).toMatchObject({
        ok: false,
        kind: "failed",
        error: `lookup ran, but its result does not match its output schema.${effect} Problems: hits: Invalid input: expected number, received string`,
      });
      await expect(tool.call({ q: "x" })).rejects.toThrow("does not match its output schema");
    });

    // "input" there would send the model to fix its own arguments.
    it("names a result that is wrong as a whole `result`", async () => {
      const count = zodTool({
        name: "count",
        description: "count",
        isReadOnly: true,
        input: z.object({}),
        output: z.number(),
        run: async () => JSON.parse('"three"'),
      });
      const outcome = await count.invoke({});
      expect(!outcome.ok && outcome.error).toMatch(
        /Problems: result: Invalid input: expected number, received string$/,
      );
    });

    // zod's sync parse throws on an async refine, and no parse catches a transform that throws.
    // The call ran either way, so the model must still read that it did.
    it("runs an async refine, and reports a check that throws as a result that failed", async () => {
      const check = zodTool({
        name: "check",
        description: "check",
        isReadOnly: true,
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string() }).refine(async ({ id }) => id !== "", "id is empty"),
        run: async ({ id }) => ({ id }),
      });
      expect(await check.invoke({ id: "a" })).toMatchObject({ ok: true, output: { id: "a" } });
      expect(await check.invoke({ id: "" })).toMatchObject({
        ok: false,
        kind: "failed",
        error:
          "check ran, but its result does not match its output schema. Problems: result: id is empty",
      });
      const write = vi.fn(async () => ({ link: "not a url" }));
      const save = zodTool({
        name: "save",
        description: "save",
        input: z.object({}),
        output: z.object({ link: z.string().transform((s) => new URL(s).href) }),
        run: write,
      });
      expect(await save.invoke({})).toMatchObject({
        ok: false,
        kind: "failed",
        error:
          "save ran, but its result does not match its output schema. Check its effect before calling it again. Problems: Invalid URL",
      });
      expect(write).toHaveBeenCalledOnce();
    });

    it("fills outputSchema as metadata, and refuses no type JSON Schema lacks", () => {
      expect(lookup(true).outputSchema).toEqual({
        type: "object",
        properties: { hits: { type: "number" } },
        required: ["hits"],
        additionalProperties: false,
      });
      expect(lookup(true).definition()).not.toHaveProperty("outputSchema");
      const dated = zodTool({
        name: "dated",
        description: "dated",
        input: z.object({}),
        output: z.object({ at: z.date() }),
        run: async () => ({ at: new Date(0) }),
      });
      expect(dated.outputSchema).toMatchObject({ properties: { at: {} } });
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

describe("toJsonObjectSchema", () => {
  it("drops the dialect URI zod puts at the root", async () => {
    // A provider validating `parameters` against its own supported subset —
    // OpenAI under strict, Gemini's parametersJsonSchema — rejects the whole
    // tool over `$schema` and names neither zod nor the field.
    const { toJsonObjectSchema } = await import("../src/zod.ts");
    const { z } = await import("zod");
    const json = toJsonObjectSchema(z.object({ q: z.string() }));
    expect(json).not.toHaveProperty("$schema");
    expect(json).toMatchObject({ type: "object", properties: { q: { type: "string" } } });
  });
});

describe("isStrictSchema", () => {
  const strict = {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  };

  it("accepts a schema that closes itself and requires everything", () => {
    expect(isStrictSchema(strict)).toBe(true);
  });

  // The whole reason this exists: an agent's response schema grows an optional
  // field (a flow's `data` block, a step's collected values) and the turn stops
  // working. Enforcement is worth having, but never at the price of the answer.
  it("rejects a property that is present but not required", () => {
    expect(
      isStrictSchema({ ...strict, properties: { ...strict.properties, data: { type: "object" } } }),
    ).toBe(false);
  });

  it("rejects an open object", () => {
    expect(isStrictSchema({ ...strict, additionalProperties: undefined })).toBe(false);
  });

  it("reads all the way down, not just the root", () => {
    const nested = {
      ...strict,
      properties: {
        message: { type: "string" },
        inner: {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: false,
        },
      },
      required: ["message", "inner"],
    };
    expect(isStrictSchema(nested)).toBe(false);
  });

  it("follows arrays into their items", () => {
    const items = {
      ...strict,
      properties: { rows: { type: "array", items: strict } },
      required: ["rows"],
    };
    expect(isStrictSchema(items)).toBe(true);
  });

  // Unverifiable answers false: unenforced output still returns an answer,
  // while a wrongly-strict request cannot succeed at all.
  it("refuses what it cannot read", () => {
    expect(isStrictSchema({ $ref: "#/$defs/Thing" })).toBe(false);
    expect(isStrictSchema({})).toBe(true);
  });
});
