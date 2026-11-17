// Lifecycle adapted from Mastra's code-mode/quickjs/src/transport.ts (Apache-2.0),
// Copyright (c) 2025 Kepler Software, Inc. Error classification and deferred bridges
// also draw on TanStack AI's ai-isolate-quickjs (MIT), Copyright (c) 2025 Tanner Linsley.
// Changes: one-job string contract, cumulative CPU budget, bounded job pumping,
// cancellable admission, no host promise-result handles, lazy sync-only loading.
// See THIRD_PARTY_NOTICES.md and LICENSE-APACHE-2.0.
import { createGate } from "@providerkit/core";
import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
import type { CodeDriver, CodeJob, CodeJobResult } from "./code-driver.ts";

export interface QuickJsDriverOptions {
  /** A precompiled release-sync module for Workers that cannot compile fetched Wasm. */
  wasmModule?: WebAssembly.Module;
  /** Host-owned Wasm URL or path for browsers and extensions. Never take this from a program. */
  wasmLocation?: string;
  /** Jobs admitted at once by this driver. Share the driver across runs. Default: 4. */
  maxActive?: number;
}

type Failure = Extract<CodeJobResult, { ok: false }>;
const fail = (name: Failure["error"]["name"], message: string): Failure => ({
  ok: false,
  error: { name, message },
});
const engineFailure = () =>
  fail(
    "EngineError",
    "The JavaScript engine failed. Check which tool calls finished before running more code.",
  );
const memoryFailure = () => fail("MemoryLimitError", "The program exceeded its memory limit.");
const stackFailure = () => fail("StackLimitError", "The program exceeded its stack limit.");
const MAX_STACK_BYTES = 256 * 1024;
const MAX_WASM_BYTES = 0x7fff_ffff;
const JOBS_PER_PUMP = 64;

// Capture these before guest code can change builtins. Never dump a guest object on
// the host: getters, toJSON and coercion can execute more guest code, even on errors.
const ERROR_READER = `(() => {
  const stringify = JSON.stringify;
  const create = Object.create;
  const slice = Function.prototype.call.bind(String.prototype.slice);
  return (error) => {
    const result = create(null);
    for (const key of ["name", "message", "stack"]) {
      try {
        const value = error == null ? undefined : error[key];
        result[key] = typeof value === "string" ? slice(value, 0, 2048) : "";
      } catch {
        result[key] = "";
      }
    }
    return stringify(result);
  };
})()`;

/**
 * An in-process, sync-Wasm driver with no guest network, files, imports or timers.
 * ponytail: a synchronous guest blocks this thread until an interrupt check. Use
 * a worker-backed CodeDriver if the host must stay responsive during that time.
 * Synchronous host callbacks and Wasm string copies cannot be preempted. Their
 * elapsed time is charged, but hosts must keep callbacks short and cap payloads.
 * The Wasm module keeps its peak allocation even after each runtime is freed.
 */
export function createQuickJsDriver(options: QuickJsDriverOptions = {}): CodeDriver {
  const { wasmModule, wasmLocation, maxActive = 4 } = options;
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new TypeError("maxActive must be a positive whole number.");
  }
  if (wasmModule !== undefined && wasmLocation !== undefined) {
    throw new TypeError("Set wasmModule or wasmLocation, not both.");
  }
  const gate = createGate(maxActive);
  let cached: { promise: Promise<QuickJSWASMModule>; broken: AbortController } | undefined;
  const load = () => {
    if (!cached) {
      const entry = {
        broken: new AbortController(),
        promise: (async () => {
          const [core, variant] = await Promise.all([
            import("quickjs-emscripten-core"),
            import("@jitl/quickjs-wasmfile-release-sync"),
          ]);
          return core.newQuickJSWASMModuleFromVariant(
            core.newVariant(variant.default, { wasmModule, wasmLocation }),
          );
        })(),
      };
      cached = entry;
      void entry.promise.catch(() => {
        if (cached === entry) cached = undefined;
      });
    }
    return cached;
  };

  return {
    async run(job) {
      if (job.signal.aborted) return fail("AbortError", "The program was stopped.");
      if (
        !Number.isSafeInteger(job.memoryBytes) ||
        job.memoryBytes < 1 ||
        job.memoryBytes > MAX_WASM_BYTES ||
        !Number.isSafeInteger(job.stackBytes) ||
        job.stackBytes < 1 ||
        job.stackBytes > MAX_STACK_BYTES ||
        !Number.isFinite(job.cpuMs) ||
        job.cpuMs <= 0 ||
        !Number.isSafeInteger(job.deadline)
      ) {
        return fail(
          "EngineError",
          "Set finite positive limits: memory up to 2147483647 bytes, stack up to 262144 bytes, CPU milliseconds and an epoch-millisecond deadline.",
        );
      }

      let failure: Failure | undefined;
      let wake = () => {};
      let waitingForSlot = true;
      const admission = new AbortController();
      const stop = (reason: Failure) => {
        failure ??= reason;
        if (waitingForSlot) admission.abort();
        wake();
      };
      const check = () => {
        if (job.signal.aborted) stop(fail("AbortError", "The program was stopped."));
        else if (Date.now() >= job.deadline) {
          stop(fail("TimeoutError", "The program reached its wall-time deadline."));
        }
        return failure;
      };
      const onAbort = () => check();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const armDeadline = () => {
        if (!check()) {
          timer = setTimeout(armDeadline, Math.min(MAX_WASM_BYTES, job.deadline - Date.now()));
        }
      };
      job.signal.addEventListener("abort", onAbort, { once: true });
      armDeadline();
      let release: (() => void) | undefined;
      try {
        release = await gate.acquire(admission.signal);
        // The gate's signal releases held slots on abort. Stop using that signal
        // after admission, so another runtime cannot start before this one is freed.
        waitingForSlot = false;
        if (check()) return failure!;
        const entry = load();
        const onBroken = () => stop(engineFailure());
        entry.broken.signal.addEventListener("abort", onBroken, { once: true });
        try {
          const ended = new Promise<undefined>((resolve) => {
            wake = () => resolve(undefined);
          });
          const wasm = await Promise.race([entry.promise, ended]);
          if (check()) return failure!;
          if (!wasm) return engineFailure();
          return await execute(
            job,
            wasm,
            check,
            stop,
            (listener) => (wake = listener),
            () => {
              if (cached === entry) cached = undefined;
              entry.broken.abort();
            },
          );
        } finally {
          entry.broken.signal.removeEventListener("abort", onBroken);
        }
      } catch {
        return failure ?? engineFailure();
      } finally {
        release?.();
        clearTimeout(timer);
        job.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function execute(
  job: CodeJob,
  wasm: QuickJSWASMModule,
  checkWall: () => Failure | undefined,
  stop: (failure: Failure) => void,
  onWake: (listener: () => void) => void,
  breakModule: () => void,
): Promise<CodeJobResult> {
  let runtime: QuickJSRuntime | undefined;
  let context: QuickJSContext | undefined;
  const owned: QuickJSHandle[] = [];
  const pending = new Set<QuickJSDeferredPromise>();
  const replies: Array<{ deferred: QuickJSDeferredPromise; text: string }> = [];
  let finished = false;
  let notify = () => {};
  let cpuUsed = 0;
  let sliceStart: number | undefined;
  let result: CodeJobResult = engineFailure();
  let cleanupFailed = false;
  const check = () => {
    const stopped = checkWall();
    if (stopped) return stopped;
    if (cpuUsed + (sliceStart === undefined ? 0 : performance.now() - sliceStart) >= job.cpuMs) {
      const limit = fail("CpuLimitError", "The program exceeded its CPU time limit.");
      stop(limit);
      return limit;
    }
    return undefined;
  };
  const timed = <T>(action: () => T): T => {
    sliceStart = performance.now();
    try {
      return action();
    } finally {
      cpuUsed += performance.now() - sliceStart;
      sliceStart = undefined;
    }
  };
  const failEngine = () => {
    stop(engineFailure());
    breakModule();
  };
  onWake(() => notify());

  try {
    runtime = wasm.newRuntime();
    const rt = runtime;
    // Initialize only trusted builtins before applying tiny memory/stack limits.
    // QuickJS 0.32 does not check a null context pointer when initialization OOMs.
    context = rt.newContext();
    const vm = context;
    const initialize = (source: string) => {
      const value = vm.evalCode(source, "driver.js", { type: "global" });
      if (value.error) {
        value.dispose();
        throw new Error("Could not initialize the driver");
      }
      owned.push(value.value);
      return value.value;
    };
    const reader = initialize(ERROR_READER);
    const messageKey = initialize('"message"');
    const stackOverflow = initialize('"stack overflow"');
    const outOfMemory = initialize('"out of memory"');
    const encode = initialize("JSON.stringify");
    const decode = initialize("JSON.parse");

    // QuickJS 0.32's C-string API truncates at NUL and loses lone surrogates.
    // Encode primitive strings inside the guest, then copy only their JSON text.
    // The caller times this whole conversion and the guest keeps its heap cap.
    const readString = (handle: QuickJSHandle): string | undefined => {
      const encoded = vm.callFunction(encode, vm.undefined, handle);
      try {
        if (encoded.error) {
          stop(check() ?? memoryFailure());
          return undefined;
        }
        const text: unknown = JSON.parse(vm.getString(encoded.value));
        if (typeof text === "string") return text;
        stop(engineFailure());
        return undefined;
      } finally {
        encoded.dispose();
      }
    };

    const readError = (handle: QuickJSHandle): Failure => {
      // A terminal error's getters may run code, but must not start more host work.
      finished = true;
      const stopped = check();
      if (stopped) return stopped;
      const detail = timed(() => vm.callFunction(reader, vm.undefined, handle));
      try {
        const interrupted = check();
        if (interrupted) return interrupted;
        // Keep both ceilings while formatting: a hostile getter still runs guest code.
        const diagnosticError = detail.error;
        if (diagnosticError) {
          // QuickJS throws null when it cannot allocate its own OOM error.
          if (vm.eq(diagnosticError, vm.null)) return memoryFailure();
          // The reader can itself overflow a tiny stack. Compare native error text
          // without another guest function call or copying arbitrary strings out.
          const message = timed(() => vm.getProp(diagnosticError, messageKey));
          try {
            const stopped = check();
            if (stopped) return stopped;
            if (vm.eq(message, stackOverflow)) return stackFailure();
            if (vm.eq(message, outOfMemory)) return memoryFailure();
            return engineFailure();
          } finally {
            message.dispose();
          }
        }
        const raw: unknown = timed(() => JSON.parse(vm.getString(detail.value)));
        const expired = check();
        if (expired) return expired;
        if (typeof raw !== "object" || raw === null) return engineFailure();
        const name = "name" in raw && typeof raw.name === "string" ? raw.name : "";
        const message =
          "message" in raw && typeof raw.message === "string" && raw.message
            ? raw.message
            : "The program threw an error.";
        const stack = "stack" in raw && typeof raw.stack === "string" ? raw.stack : "";
        if (name === "InternalError" && /out of memory|memory alloc/i.test(message)) {
          return memoryFailure();
        }
        if (name === "InternalError" && /stack overflow/i.test(message)) {
          return stackFailure();
        }
        const error = fail(name === "SyntaxError" ? "SyntaxError" : "ProgramError", message);
        const line = /program\.js:(\d+)/.exec(stack)?.[1];
        if (line) error.error.line = Number(line);
        return error;
      } finally {
        detail.dispose();
      }
    };

    const hostCall = vm.newFunction("__pk_call", (nameHandle, inputHandle) => {
      if (finished || check()) return vm.undefined;
      if (
        !nameHandle ||
        !inputHandle ||
        vm.typeof(nameHandle) !== "string" ||
        vm.typeof(inputHandle) !== "string"
      ) {
        stop(fail("ProgramError", "The call bridge needs a tool name and JSON input as strings."));
        return vm.undefined;
      }
      const name = readString(nameHandle);
      const input = readString(inputHandle);
      if (check() || name === undefined || input === undefined) return vm.undefined;
      const deferred = vm.newPromise();
      pending.add(deferred);
      // A callback only queues strings. No late completion can touch a VM handle
      // or pump jobs after cleanup, and a host failure never repeats a call.
      try {
        void Promise.resolve(job.call(name, input)).then(
          (text) => {
            if (finished || check()) return;
            if (typeof text !== "string") {
              stop(engineFailure());
              return;
            }
            replies.push({ deferred, text });
            notify();
          },
          () => {
            if (!finished) stop(engineFailure());
          },
        );
      } catch {
        stop(engineFailure());
      }
      return deferred.handle;
    });
    try {
      vm.setProp(vm.global, "__pk_call", hostCall);
    } finally {
      hostCall.dispose();
    }
    const hostLog = vm.newFunction("__pk_log", (text) => {
      if (finished || check()) return;
      if (!text || vm.typeof(text) !== "string") {
        stop(fail("ProgramError", "The log bridge needs a string."));
        return;
      }
      const message = readString(text);
      if (!check() && message !== undefined) {
        try {
          job.log(message);
        } catch {
          stop(engineFailure());
        }
      }
    });
    try {
      vm.setProp(vm.global, "__pk_log", hostLog);
    } finally {
      hostLog.dispose();
    }

    rt.setMemoryLimit(job.memoryBytes);
    rt.setMaxStackSize(job.stackBytes);
    rt.setInterruptHandler(() => Boolean(check()));
    const evaluated = timed(() => vm.evalCode(job.script, "program.js", { type: "global" }));
    if (evaluated.error) {
      try {
        result = readError(evaluated.error);
      } finally {
        evaluated.dispose();
      }
    } else {
      owned.push(evaluated.value);
      let jobsSinceYield = 0;
      while (true) {
        const stopped = check();
        if (stopped) {
          result = stopped;
          break;
        }
        // Inspect the real promise directly, rather than installing host result
        // callbacks which can retain a result handle when cancellation wins.
        const state = timed(() => vm.getPromiseState(evaluated.value));
        if (state.type !== "pending") {
          finished = true;
          try {
            if (state.type === "rejected") result = readError(state.error);
            else if (vm.typeof(state.value) !== "string") {
              result = fail("ProgramError", "The SDK script must return a JSON envelope string.");
            } else {
              const envelope = timed(() => readString(state.value));
              result =
                check() ?? (envelope === undefined ? engineFailure() : { ok: true, envelope });
            }
          } finally {
            // For non-promises getPromiseState returns the original handle.
            if (state.type === "rejected") state.error.dispose();
            else if (!state.notAPromise) state.value.dispose();
          }
          break;
        }
        // Check settlement before yielding, too: detached jobs cannot change a
        // completed result or start host work during the cleanup drain.
        if (jobsSinceYield === JOBS_PER_PUMP) {
          jobsSinceYield = 0;
          // Short jobs may never reach the VM interrupt counter. Give host aborts
          // and deadline timers a turn after each bounded batch.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          continue;
        }
        const awakened = new Promise<void>((resolve) => (notify = resolve));
        const ready = replies.splice(0);
        for (const { deferred, text } of ready) {
          if (check()) break;
          timed(() => {
            const encoded = vm.newString(JSON.stringify(text));
            try {
              if (vm.typeof(encoded) !== "string") {
                stop(memoryFailure());
                return;
              }
              const value = vm.callFunction(decode, vm.undefined, encoded);
              try {
                if (value.error) {
                  stop(check() ?? memoryFailure());
                  return;
                }
                deferred.resolve(value.value);
              } finally {
                value.dispose();
              }
            } finally {
              encoded.dispose();
            }
            deferred.dispose();
            pending.delete(deferred);
          });
        }
        if (check() || ready.length) continue;
        if (rt.hasPendingJob()) {
          // A single job can settle the root and leave detached work behind it.
          const jobs = timed(() => rt.executePendingJobs(1));
          jobsSinceYield++;
          try {
            if (jobs.error) {
              result = readError(jobs.error);
              break;
            }
          } finally {
            jobs.dispose();
          }
        } else {
          await awakened;
        }
      }
    }
  } catch {
    failEngine();
    result = checkWall() ?? engineFailure();
  } finally {
    finished = true;
    onWake(() => {});
    replies.length = 0;
    const free = (action: () => void) => {
      try {
        action();
      } catch {
        cleanupFailed = true;
        breakModule();
      }
    };
    for (const deferred of pending) free(() => deferred.dispose());
    pending.clear();
    for (const handle of owned.reverse()) free(() => handle.dispose());
    owned.length = 0;
    if (runtime) {
      const rt = runtime;
      free(() => {
        const deadline = performance.now() + 50;
        rt.setInterruptHandler(() => performance.now() >= deadline);
        for (let pass = 0; pass < 10 && performance.now() < deadline; pass++) {
          const jobs = rt.executePendingJobs(JOBS_PER_PUMP);
          const empty = !jobs.error && jobs.value === 0;
          jobs.dispose();
          if (empty) break;
        }
      });
      // No guest code runs after this point. Freeing an OOM heap may allocate.
      free(() => rt.setMemoryLimit(-1));
      free(() => context?.dispose());
      free(() => rt.dispose());
    }
  }
  return cleanupFailed ? engineFailure() : result;
}
