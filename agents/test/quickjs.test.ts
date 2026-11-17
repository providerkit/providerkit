// Real-Wasm cases adapted from Mastra's code-mode/quickjs/src/transport.test.ts
// (Apache-2.0, Copyright (c) 2025 Kepler Software, Inc.) and TanStack AI's
// ai-isolate-quickjs tests (MIT, Copyright (c) 2025 Tanner Linsley).
// Adds cumulative CPU, admission, hostile conversion and loader recovery checks.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import DEBUG_SYNC from "@jitl/quickjs-wasmfile-debug-sync";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import * as quickjs from "quickjs-emscripten-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodeDriver, CodeJob, CodeJobResult } from "../src/code-driver.ts";
import { createQuickJsDriver } from "../src/quickjs.ts";

vi.mock("quickjs-emscripten-core", async (importOriginal) => {
  const actual = await importOriginal<typeof quickjs>();
  return {
    ...actual,
    newQuickJSWASMModuleFromVariant: vi.fn(actual.newQuickJSWASMModuleFromVariant),
  };
});
const loadModule = vi.mocked(quickjs.newQuickJSWASMModuleFromVariant);

const driver = createQuickJsDriver();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const success = (value: unknown): CodeJobResult => ({ ok: true, envelope: JSON.stringify(value) });
const failed = (name: string) => ({ ok: false, error: { name } });

// The SDK builds the real tool wrapper. This small fixture exercises the driver's
// string-only contract without depending on unfinished code-mode integration.
function job(body: string, overrides: Partial<CodeJob> = {}): CodeJob {
  return {
    script: `(async () => {
      const call = globalThis.__pk_call;
      const log = globalThis.__pk_log;
      delete globalThis.__pk_call;
      delete globalThis.__pk_log;
      const stringify = JSON.stringify;
      const result = await (async () => { ${body}\n })();
      return stringify(result);
    })()`,
    call: async (_name, input) => input,
    log: () => {},
    memoryBytes: 8 * 1024 * 1024,
    stackBytes: 256 * 1024,
    cpuMs: 500,
    deadline: Date.now() + 5_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeAll(async () => {
  expect(await driver.run(job("return 1;"))).toEqual(success(1));
});
afterEach(() => {
  vi.restoreAllMocks();
  loadModule.mockReset();
});

describe("QuickJS jobs", () => {
  it("returns strings without an unchecked generic result", async () => {
    expect(await driver.run(job("return { total: 1 + 2 };"))).toEqual(success({ total: 3 }));
    expect(await driver.run(job("", { script: "'null'" }))).toEqual(success(null));
    expect(await driver.run(job("", { script: "({ value: 1 })" }))).toMatchObject(
      failed("ProgramError"),
    );
  });

  it("starts empty, isolates prototypes and exposes no host capabilities", async () => {
    const program = `
      const before = typeof Object.prototype.guestOnly;
      Object.prototype.guestOnly = true;
      globalThis.secret = 123;
      return [before, typeof process, typeof require, typeof fetch, typeof setTimeout,
        typeof importScripts, typeof module, typeof WebAssembly, typeof __pk_call,
        typeof __pk_log, Function('return typeof process')()];
    `;
    expect(await driver.run(job(program))).toEqual(success(Array(11).fill("undefined")));
    expect(await driver.run(job("return [typeof secret, typeof ({}).guestOnly];"))).toEqual(
      success(["undefined", "undefined"]),
    );
    expect(Object.prototype).not.toHaveProperty("guestOnly");
    const denied = await driver.run(job("await import('node:fs'); return 1;"));
    expect(denied).toMatchObject(failed("ProgramError"));
  });

  it("resolves parallel calls independently and preserves call order", async () => {
    const started: string[] = [];
    const completed: string[] = [];
    const releases = new Map<string, (text: string) => void>();
    const ready = Promise.withResolvers<void>();
    const running = driver.run(
      job(`return await Promise.all(['one', 'two', 'three'].map(name => call(name, '{}')));`, {
        call: (name, input) => {
          expect(input).toBe("{}");
          started.push(name);
          if (started.length === 3) ready.resolve();
          return new Promise<string>((resolve) => releases.set(name, resolve));
        },
        log: (text) => completed.push(text),
      }),
    );
    await ready.promise;
    for (const name of ["three", "two", "one"]) {
      releases.get(name)!(name);
      await pause(0);
    }
    expect(await running).toEqual(success(["one", "two", "three"]));
    expect(started).toEqual(["one", "two", "three"]);
    expect(completed).toEqual([]);
  });

  it("handles a bridge promise as the entire script result", async () => {
    expect(await driver.run(job("", { script: `__pk_call('echo', '{"ok":true}')` }))).toEqual({
      ok: true,
      envelope: '{"ok":true}',
    });
  });

  it("preserves null characters and lone surrogates across every string bridge", async () => {
    const text = "before\0after\ud800";
    const call = vi.fn(async (_name: string, input: string) => input);
    const log = vi.fn();
    expect(
      await driver.run(
        job(`const text = ${JSON.stringify(text)}; log(text); return await call(text, text);`, {
          call,
          log,
        }),
      ),
    ).toEqual(success(text));
    expect(call).toHaveBeenCalledExactlyOnceWith(text, text);
    expect(log).toHaveBeenCalledExactlyOnceWith(text);
    expect(await driver.run(job("", { script: JSON.stringify(text) }))).toEqual({
      ok: true,
      envelope: text,
    });
  });

  it("leaves tool failures as envelope data without retrying", async () => {
    const call = vi.fn(async () => '{"ok":false,"error":"not allowed"}');
    const result = await driver.run(
      job(`const reply = JSON.parse(await call('change', '{}')); return reply.error;`, { call }),
    );
    expect(result).toEqual(success("not allowed"));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reports broken host bridges without leaking host errors", async () => {
    const call = vi.fn(async () => {
      throw new Error("private host details");
    });
    const result = await driver.run(job("return await call('once', '{}');", { call }));
    expect(result).toMatchObject(failed("EngineError"));
    expect(JSON.stringify(result)).not.toContain("private host details");
    expect(call).toHaveBeenCalledTimes(1);
    expect(
      await driver.run(
        job("log('hello'); return 1;", {
          log: () => {
            throw new Error("private host details");
          },
        }),
      ),
    ).toMatchObject(failed("EngineError"));
  });

  it("refuses non-string bridge input without coercing guest objects", async () => {
    const call = vi.fn(async () => "null");
    const log = vi.fn();
    for (const body of [
      `call({ toString() { while (true) {} } }, '{}'); return 1;`,
      `call('echo', {}); return 1;`,
      `log({ toString() { while (true) {} } }); return 1;`,
      `call(); return 1;`,
    ]) {
      expect(await driver.run(job(body, { call, log }))).toMatchObject(failed("ProgramError"));
    }
    expect(call).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    { ending: "return 'done';", expected: { ok: true, envelope: "done" } },
    { ending: "throw new Error('ended');", expected: failed("ProgramError") },
  ])(
    "stops detached host effects after root settlement ($ending)",
    async ({ ending, expected }) => {
      const call = vi.fn(async () => "null");
      const log = vi.fn();
      const script = `(async () => {
      await Promise.resolve();
      Promise.resolve().then(() => { __pk_call('late', '{}'); __pk_log('late'); });
      ${ending}
    })()`;
      expect(await driver.run(job("", { script, call, log }))).toMatchObject(expected);
      expect(call).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );

  it.each(["return 'done';", "throw new Error('ended');"])(
    "stops detached host effects after the SDK wrapper settles (%s)",
    async (ending) => {
      const call = vi.fn(async () => "null");
      const log = vi.fn();
      const result = await driver.run(
        job(
          `await Promise.resolve();
          Promise.resolve().then(() => {}).then(() => { call('late', '{}'); log('late'); });
          ${ending}`,
          { call, log },
        ),
      );
      if (ending.startsWith("return")) expect(result).toEqual(success("done"));
      else expect(result).toMatchObject(failed("ProgramError"));
      expect(call).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("stops charging a completed program for detached busy jobs", async () => {
    const script = `(async () => {
      await Promise.resolve();
      Promise.resolve().then(() => { while (true) {} });
      return 'done';
    })()`;
    expect(await driver.run(job("", { script, cpuMs: 20 }))).toEqual({
      ok: true,
      envelope: "done",
    });
    expect(await driver.run(job("return 2;"))).toEqual(success(2));
  });

  it("stops host effects before reading a thrown error's getters", async () => {
    const body = `throw {
      get message() { __pk_call('late', '{}'); __pk_log('late'); return 'ended'; }
    };`;
    for (const script of [body, `(async () => { await Promise.resolve(); ${body} })()`]) {
      const call = vi.fn(async () => "null");
      const log = vi.fn();
      expect(await driver.run(job("", { script, call, log }))).toMatchObject({
        ok: false,
        error: { name: "ProgramError", message: "ended" },
      });
      expect(call).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    }
  });

  it("reports syntax and runtime errors and preserves earlier logs", async () => {
    expect(await driver.run(job("const = ;"))).toMatchObject(failed("SyntaxError"));
    const log = vi.fn();
    const result = await driver.run(
      job(`log('step done'); throw new TypeError('bad input');`, { log }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { name: "ProgramError", message: "bad input", line: expect.any(Number) },
    });
    expect(log).toHaveBeenCalledWith("step done");
    expect(
      await driver.run(
        job(`throw Object.assign(new Error('guest abort'), { name: 'AbortError' });`),
      ),
    ).toMatchObject(failed("ProgramError"));
  });
});

describe("limits and cancellation", () => {
  it.each([
    ["memoryBytes", 0],
    ["memoryBytes", -1],
    ["memoryBytes", 2 ** 32],
    ["memoryBytes", 1.5],
    ["stackBytes", 0],
    ["stackBytes", 2 ** 32],
    ["stackBytes", 512 * 1024],
    ["cpuMs", 0],
    ["cpuMs", Number.NaN],
    ["cpuMs", Infinity],
    ["deadline", Infinity],
    ["deadline", Number.NaN],
  ])("refuses an unsafe %s limit (%s)", async (key, value) => {
    const call = vi.fn(async () => "null");
    expect(
      await driver.run(job("return await call('never', '{}');", { [key]: value, call })),
    ).toMatchObject(failed("EngineError"));
    expect(call).not.toHaveBeenCalled();
  });

  it("interrupts a busy loop on CPU time, not the wall deadline", async () => {
    expect(await driver.run(job("while (true) {}", { cpuMs: 20 }))).toMatchObject(
      failed("CpuLimitError"),
    );
    expect(await driver.run(job("return 2;"))).toEqual(success(2));
  });

  it("charges CPU across short promise jobs and serialization", async () => {
    for (const body of [
      "for (;;) await Promise.resolve();",
      "for (;;) await call('next', '{}');",
      "return { toJSON() { while (true) {} } };",
      "throw { get message() { while (true) {} } };",
    ]) {
      expect(await driver.run(job(body, { cpuMs: 20 }))).toMatchObject(failed("CpuLimitError"));
    }
  });

  it("charges many short host-call continuations without starving aborts", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const result = driver.run(
      job("for (;;) await call('next', '{}');", {
        cpuMs: 2_000,
        signal: controller.signal,
        call: async () => {
          calls++;
          started.resolve();
          return "null";
        },
      }),
    );
    await started.promise;
    await pause(10);
    controller.abort();
    expect(await result).toMatchObject(failed("AbortError"));
    expect(calls).toBeGreaterThan(0);
  });

  it("excludes tool waits from CPU but includes them in wall time", async () => {
    const call = async () => {
      await pause(70);
      return "done";
    };
    expect(await driver.run(job("return await call('wait', '{}');", { cpuMs: 30, call }))).toEqual(
      success("done"),
    );
    expect(
      await driver.run(
        job("return await call('wait', '{}');", { deadline: Date.now() + 30, call }),
      ),
    ).toMatchObject(failed("TimeoutError"));
  });

  it("enforces wall time on busy loops and promises with no host call", async () => {
    for (const body of ["while (true) {}", "await new Promise(() => {});"]) {
      expect(
        await driver.run(job(body, { cpuMs: 1_000, deadline: Date.now() + 30 })),
      ).toMatchObject(failed("TimeoutError"));
    }
  });

  it("rejects an expired or already-aborted job before loading Wasm", async () => {
    const load = loadModule;
    const fresh = createQuickJsDriver();
    expect(await fresh.run(job("return 1;", { deadline: Date.now() - 1 }))).toMatchObject(
      failed("TimeoutError"),
    );
    expect(await fresh.run(job("return 1;", { signal: AbortSignal.abort() }))).toMatchObject(
      failed("AbortError"),
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("aborts during a host wait, including a synchronous abort inside the bridge", async () => {
    for (const immediate of [true, false]) {
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const result = driver.run(
        job("await call('wait', '{}'); while (true) {}", {
          signal: controller.signal,
          call: () => {
            started.resolve();
            if (immediate) controller.abort();
            return new Promise(() => {});
          },
        }),
      );
      await started.promise;
      if (!immediate) controller.abort();
      expect(await result).toMatchObject(failed("AbortError"));
    }
  });

  it("interrupts a busy loop after a synchronous bridge abort", async () => {
    const controller = new AbortController();
    expect(
      await driver.run(
        job("call('stop', '{}'); while (true) {}", {
          signal: controller.signal,
          call: async () => {
            controller.abort();
            return "null";
          },
        }),
      ),
    ).toMatchObject(failed("AbortError"));
  });

  it("enforces the real Wasm heap limit, including with a call in flight", async () => {
    for (const prefix of ["", "call('pending', '{}');"]) {
      expect(
        await driver.run(
          job(`${prefix} new Uint8Array(4 * 1024 * 1024);`, {
            memoryBytes: 2 * 1024 * 1024,
            call: () => new Promise(() => {}),
          }),
        ),
      ).toMatchObject(failed("MemoryLimitError"));
    }
    expect(await driver.run(job("return 3;", { memoryBytes: 1 }))).toMatchObject(
      failed("MemoryLimitError"),
    );
    expect(await driver.run(job("return 3;"))).toEqual(success(3));
  });

  it("keeps host-reply conversion under the guest memory limit", async () => {
    const call = vi.fn(async () => "x".repeat(4 * 1024 * 1024));
    expect(
      await driver.run(
        job("return await call('large', '{}');", { memoryBytes: 1024 * 1024, call }),
      ),
    ).toMatchObject(failed("MemoryLimitError"));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([1, 64, 256])(
    "keeps a tiny stack diagnostic separate from memory (%s bytes)",
    async (stackBytes) => {
      expect(await driver.run(job("", { script: "'ok'", stackBytes }))).toMatchObject(
        failed("StackLimitError"),
      );
    },
  );

  it("does not label an unrelated diagnostic failure as memory exhaustion", async () => {
    expect(
      await driver.run(
        job(`Array.prototype[Symbol.iterator] = () => { throw new Error('reader failed'); };
          throw new Error('original failure');`),
      ),
    ).toMatchObject(failed("EngineError"));
  });

  it("enforces the real stack limit after an await", async () => {
    expect(
      await driver.run(
        job(
          `await call('ping', '{}'); function recurse(n) { return recurse(n + 1) + 1; } return recurse(0);`,
        ),
      ),
    ).toMatchObject(failed("StackLimitError"));
  });

  it("drops late results and never starts cleanup continuations", async () => {
    const pending = Promise.withResolvers<string>();
    const call = vi.fn(() => pending.promise);
    const log = vi.fn();
    expect(
      await driver.run(
        job(`call('late', '{}').then(() => { log('too late'); call('again', '{}'); }); return 7;`, {
          call,
          log,
        }),
      ),
    ).toEqual(success(7));
    pending.resolve("null");
    await pause(0);
    expect(call).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(await driver.run(job("return 8;"))).toEqual(success(8));
  });
});

describe("admission and module loading", () => {
  it("bounds active jobs and removes aborted and expired waiters", async () => {
    const serial = createQuickJsDriver({ maxActive: 1 });
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<string>();
    const first = serial.run(
      job("return await call('first', '{}');", {
        call: () => {
          entered.resolve();
          return blocked.promise;
        },
      }),
    );
    await entered.promise;
    const calls = vi.fn(async (name: string) => name);
    const controller = new AbortController();
    const aborted = serial.run(
      job("return await call('aborted', '{}');", { call: calls, signal: controller.signal }),
    );
    const expired = serial.run(
      job("return await call('expired', '{}');", { call: calls, deadline: Date.now() + 20 }),
    );
    const second = serial.run(job("return await call('second', '{}');", { call: calls }));
    controller.abort();
    expect(await aborted).toMatchObject(failed("AbortError"));
    expect(await expired).toMatchObject(failed("TimeoutError"));
    expect(calls).not.toHaveBeenCalled();
    blocked.resolve("first");
    expect(await first).toEqual(success("first"));
    expect(await second).toEqual(success("second"));
    expect(calls).toHaveBeenCalledExactlyOnceWith("second", "{}");
  });

  it.each([0, -1, 1.5, Infinity, Number.NaN])("refuses maxActive=%s", (maxActive) => {
    expect(() => createQuickJsDriver({ maxActive })).toThrow(TypeError);
  });

  it("loads a compiled module or an explicit host-owned Wasm path", async () => {
    const wasmLocation = createRequire(import.meta.url).resolve(
      "@jitl/quickjs-wasmfile-release-sync/wasm",
    );
    const wasmModule = await WebAssembly.compile(readFileSync(wasmLocation));
    expect(await createQuickJsDriver({ wasmModule }).run(job("return 11;"))).toEqual(success(11));
    expect(await createQuickJsDriver({ wasmLocation }).run(job("return 12;"))).toEqual(success(12));
    expect(() => createQuickJsDriver({ wasmModule, wasmLocation })).toThrow(TypeError);
  });

  it("times out while loading without creating an abandoned runtime", async () => {
    const wasm = await quickjs.newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
    loadModule.mockClear();
    const loading = Promise.withResolvers<quickjs.QuickJSWASMModule>();
    const load = loadModule.mockReturnValueOnce(loading.promise);
    const newRuntime = vi.spyOn(wasm, "newRuntime");
    const fresh = createQuickJsDriver();
    expect(await fresh.run(job("return 1;", { deadline: Date.now() + 25 }))).toMatchObject(
      failed("TimeoutError"),
    );
    loading.resolve(wasm);
    await pause(0);
    expect(newRuntime).not.toHaveBeenCalled();
    expect(await fresh.run(job("return 2;"))).toEqual(success(2));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries module loading for the next job, never a failed job", async () => {
    const load = loadModule.mockRejectedValueOnce(new Error("loader failed"));
    const fresh = createQuickJsDriver();
    expect(await fresh.run(job("return 1;"))).toMatchObject(failed("EngineError"));
    expect(await fresh.run(job("return 2;"))).toEqual(success(2));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops a module after an engine trap and still frees the real runtime", async () => {
    const wasm = await quickjs.newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
    loadModule.mockClear();
    const createRuntime = wasm.newRuntime.bind(wasm);
    let runtime: quickjs.QuickJSRuntime | undefined;
    vi.spyOn(wasm, "newRuntime").mockImplementationOnce(() => {
      runtime = createRuntime();
      const createContext = runtime.newContext.bind(runtime);
      vi.spyOn(runtime, "newContext").mockImplementationOnce(() => {
        const vm = createContext();
        const evaluate = vm.evalCode.bind(vm);
        vi.spyOn(vm, "evalCode").mockImplementation((source, filename, options) => {
          if (filename === "program.js") throw new WebAssembly.RuntimeError("unreachable");
          return evaluate(source, filename, options);
        });
        return vm;
      });
      return runtime;
    });
    const load = loadModule.mockResolvedValueOnce(wasm);
    const fresh = createQuickJsDriver();
    expect(await fresh.run(job("return 1;"))).toMatchObject(failed("EngineError"));
    expect(runtime?.alive).toBe(false);
    expect(await fresh.run(job("return 2;"))).toEqual(success(2));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reports cleanup failures and replaces the module", async () => {
    const wasm = await quickjs.newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
    loadModule.mockClear();
    const createRuntime = wasm.newRuntime.bind(wasm);
    vi.spyOn(wasm, "newRuntime").mockImplementationOnce(() => {
      const runtime = createRuntime();
      const dispose = runtime.dispose.bind(runtime);
      vi.spyOn(runtime, "dispose").mockImplementationOnce(() => {
        dispose();
        throw new Error("free failed");
      });
      return runtime;
    });
    const load = loadModule.mockResolvedValueOnce(wasm);
    const fresh = createQuickJsDriver();
    expect(await fresh.run(job("return 1;"))).toMatchObject(failed("EngineError"));
    expect(await fresh.run(job("return 2;"))).toEqual(success(2));
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("debug-Wasm cleanup", () => {
  it("leaves no native allocations after success, failure, limits or cancellation", async () => {
    const wasm = await quickjs.newQuickJSWASMModuleFromVariant(DEBUG_SYNC);
    const sanitizer = new quickjs.TestQuickJSWASMModule(wasm);
    loadModule.mockResolvedValue(wasm);
    const runtimes = vi.spyOn(wasm, "newRuntime");
    const debug: CodeDriver = createQuickJsDriver();
    const pending = Promise.withResolvers<string>();
    const cases: Array<[string, Partial<CodeJob>, string | undefined]> = [
      ["return await call('ping', '{}');", {}, undefined],
      ["const = ;", {}, "SyntaxError"],
      ["throw new Error('nope');", {}, "ProgramError"],
      ["while (true) {}", { cpuMs: 10 }, "CpuLimitError"],
      ["for (;;) await Promise.resolve();", { cpuMs: 10 }, "CpuLimitError"],
      ["return await call('wait', '{}');", { call: () => pending.promise }, "TimeoutError"],
      ["call('wait', '{}'); return 1;", { call: () => pending.promise }, undefined],
      [
        "call('wait', '{}'); new Uint8Array(4 * 1024 * 1024);",
        { memoryBytes: 1024 * 1024, call: () => pending.promise },
        "MemoryLimitError",
      ],
      ["function recurse() { return recurse() + 1; } recurse();", {}, "StackLimitError"],
    ];
    for (const [body, overrides, error] of cases) {
      const result = await debug.run(
        job(body, {
          deadline: Date.now() + (error === "TimeoutError" ? 250 : 5_000),
          cpuMs: 2_000,
          ...overrides,
        }),
      );
      if (error) expect(result, body).toMatchObject(failed(error));
      else expect(result, body).toHaveProperty("ok", true);
      expect(() => sanitizer.assertNoMemoryAllocated()).not.toThrow();
      for (const entry of runtimes.mock.results) {
        if (entry.type === "return") expect(entry.value.alive).toBe(false);
      }
    }
    const controller = new AbortController();
    expect(
      await debug.run(
        job("await call('stop', '{}');", {
          signal: controller.signal,
          call: () => {
            controller.abort();
            return pending.promise;
          },
        }),
      ),
    ).toMatchObject(failed("AbortError"));
    pending.resolve("null");
    await pause(0);
    expect(() => sanitizer.assertNoMemoryAllocated()).not.toThrow();
    expect(await debug.run(job("return 42;"))).toEqual(success(42));
    expect(() => sanitizer.assertNoMemoryAllocated()).not.toThrow();
  });
});
