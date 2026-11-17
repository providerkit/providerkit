import { describe, expect, it, vi } from "vitest";
import type { CodeJob } from "../src/code-driver.ts";
import { codeScript } from "../src/code-script.ts";
import { createQuickJsDriver } from "../src/quickjs.ts";

const driver = createQuickJsDriver();

async function run(
  code: string,
  options: { names?: string[]; call?: CodeJob["call"]; expression?: string } = {},
) {
  const call = vi.fn(options.call ?? (async () => '{"ok":true,"value":7}'));
  const log = vi.fn();
  const result = await driver.run({
    script: codeScript(
      options.expression ?? `(async () => {\n${code}\n})`,
      options.names ?? ["read"],
    ),
    call,
    log,
    memoryBytes: 8 * 1024 * 1024,
    stackBytes: 256 * 1024,
    cpuMs: 500,
    deadline: Date.now() + 2_000,
    signal: new AbortController().signal,
  });
  if (!result.ok) throw new Error(`${result.error.name}: ${result.error.message}`);
  const envelope: unknown = JSON.parse(result.envelope);
  return { envelope, call, log };
}

describe("code-mode guest wrapper", () => {
  it("uses the string bridge, preserves values and supports parallel calls", async () => {
    const { envelope, call, log } = await run(`
      const values = await Promise.all([tools.read({ n: 1 }), tools.read({ n: 2 })]);
      console.log("values", values);
      return { values, text: "a\\0b\\ud800" };
    `);
    expect(envelope).toEqual({ ok: true, value: { values: [7, 7], text: "a\0b\ud800" } });
    expect(call.mock.calls.map(([name, input]) => [name, JSON.parse(input)])).toEqual([
      ["read", { n: 1 }],
      ["read", { n: 2 }],
    ]);
    expect(log).toHaveBeenCalledWith("values [7,7]");
  });

  it("hides the raw host functions and wrapper closure from guest code", async () => {
    const { envelope, call } = await run(`return [
      typeof __pk_call, typeof __pk_log, typeof call, typeof log,
      eval("typeof call"), (new Function("return typeof call"))(),
      typeof fetch, typeof process, typeof setTimeout
    ];`);
    expect(envelope).toEqual({ ok: true, value: Array(9).fill("undefined") });
    expect(call).not.toHaveBeenCalled();
  });

  it("preserves arbitrary names and refuses unknown or non-object calls", async () => {
    const { envelope, call } = await run('return await tools["__proto__"]({});', {
      names: ["__proto__"],
    });
    expect(envelope).toEqual({ ok: true, value: 7 });
    expect(call).toHaveBeenCalledWith("__proto__", "{}");
    for (const code of [
      "return await tools.missing({});",
      "return await tools.read([]);",
      "return await tools.read(null);",
    ]) {
      const result = await run(code);
      expect(result.envelope).toMatchObject({ ok: false, error: { name: "ProgramError" } });
      expect(result.call).not.toHaveBeenCalled();
    }
  });

  it("turns failed host calls into catchable ToolErrors without rerunning", async () => {
    const { envelope, call } = await run(
      `
      try { await tools.read({}); }
      catch (error) { return { name: error.name, kind: error.kind, tool: error.tool, message: error.message }; }
    `,
      {
        call: async () =>
          JSON.stringify({ ok: false, error: { kind: "denied", message: "Ask for permission." } }),
      },
    );
    expect(envelope).toEqual({
      ok: true,
      value: { name: "ToolError", kind: "denied", tool: "read", message: "Ask for permission." },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("accepts undefined and a transpiler's trailing semicolon", async () => {
    expect((await run("return undefined;")).envelope).toEqual({ ok: true });
    expect((await run("", { expression: "(async () => { return 4; });" })).envelope).toEqual({
      ok: true,
      value: 4,
    });
    expect((await run("return (; ")).envelope).toMatchObject({
      ok: false,
      error: { name: "SyntaxError" },
    });
  });

  it.each([
    "return NaN;",
    "return Infinity;",
    "return 1n;",
    "return () => 1;",
    "return { bad: undefined };",
    "return new Date();",
    "return [, 1];",
    "const value = {}; value.self = value; return value;",
    "return { [Symbol('x')]: 1 };",
    "const value = []; value.extra = 1; return value;",
    "return { get value() { return 1; } };",
  ])("rejects a non-JSON result: %s", async (code) => {
    expect((await run(code)).envelope).toMatchObject({
      ok: false,
      error: { name: "ProgramError" },
    });
  });

  it("does not let result or error inspection start new host work", async () => {
    for (const code of [
      "return { get value() { tools.read({}); return 1; } };",
      "throw { get message() { tools.read({}); return 'late'; } };",
      "return { toJSON() { tools.read({}); return 1; } };",
    ]) {
      const result = await run(code);
      expect(result.envelope).toMatchObject({ ok: false });
      expect(result.call).not.toHaveBeenCalled();
    }
  });

  it("keeps encoding independent of guest changes to JSON and inherited toJSON", async () => {
    const { envelope, call } = await run(`
      JSON.stringify = () => "wrong";
      JSON.parse = () => ({ wrong: true });
      Object.prototype.toJSON = () => "wrong";
      Array.prototype.toJSON = () => "wrong";
      Object.hasOwn = () => false;
      const value = await tools.read({ nested: [1, { n: 2 }] });
      return { value, list: [3] };
    `);
    expect(call).toHaveBeenCalledWith("read", '{"nested":[1,{"n":2}]}');
    expect(envelope).toEqual({ ok: true, value: { value: 7, list: [3] } });
  });
});
