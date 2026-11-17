// Code-mode policy follows TanStack AI (MIT), Mastra and Vercel AI SDK (Apache-2.0).
// Changed: journal-owned dispatch, no VM replay, explicit bindings and bounded JSON receipts.
// See THIRD_PARTY_NOTICES.md. This entry never imports an engine.
import type { Tool, ToolDefinition } from "@providerkit/core";
import type { CodeDriver, CodeJobResult } from "./code-driver.ts";
import { codeScript } from "./code-script.ts";
import { isQuestionTool } from "./request.ts";
import { toolTypings } from "./schema-to-ts.ts";
import { copyData, immutableCopy, isId, isRecord } from "./snapshot.ts";
import { untilAbort } from "./tree.ts";
import type { ProgramCall, ToolResult } from "./types.ts";

export type { CodeDriver, CodeJob, CodeJobResult } from "./code-driver.ts";
export type { ProgramCall } from "./types.ts";
export { toolTypings } from "./schema-to-ts.ts";

export interface CodeLimits {
  calls: number;
  timeoutMs: number;
  cpuMs: number;
  memoryBytes: number;
  stackBytes: number;
  sourceBytes: number;
  resultBytes: number;
  logBytes: number;
  callInputBytes: number;
  callOutputBytes: number;
}

export const CODE_LIMITS: Readonly<CodeLimits> = Object.freeze({
  calls: 32,
  timeoutMs: 30_000,
  cpuMs: 2_000,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  sourceBytes: 64 * 1024,
  resultBytes: 32 * 1024,
  logBytes: 8 * 1024,
  callInputBytes: 256 * 1024,
  callOutputBytes: 1024 * 1024,
});

export interface CodeModeOptions {
  name?: string;
  tools: readonly Tool[];
  driver: CodeDriver;
  limits?: Partial<CodeLimits>;
  needsApproval?: boolean;
  /** Receives an async function expression, not a body. No compiler is bundled. */
  transpile?: (source: string) => string | Promise<string>;
  instructions?: string;
}

/** @internal The run owns admission, dispatch and settlement. Never call tools in a driver. */
export interface ProgramBridge {
  readonly tools: readonly Tool[];
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly calls: readonly ProgramCall[];
  call(name: string, input: string): Promise<string>;
  toolCallsLeft(): number;
  /** Abort queued/running calls, then await their recorded outcomes. */
  settle(): Promise<void>;
}

export interface ProgramOutcome {
  result: ToolResult;
}

export interface CodeTool {
  readonly kind: "code";
  readonly name: string;
  readonly tools: readonly Tool[];
  readonly limits: Readonly<CodeLimits>;
  readonly isReadOnly: boolean;
  readonly needsApproval: boolean;
  /** The loop supplies only the enabled subset; callers cannot add bindings. */
  definition(enabled?: readonly string[]): ToolDefinition;
  /** @internal Called only with the run's journal bridge. */
  execute(raw: unknown, bridge: ProgramBridge): Promise<ProgramOutcome>;
  /** @internal Close an interrupted program without evaluating its source. */
  close(calls: readonly ProgramCall[]): ToolResult;
}

export function isCodeTool(value: { readonly name: string }): value is CodeTool {
  return "kind" in value && value.kind === "code";
}

export function textBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Keep whole Unicode characters and count strings as UTF-8, not UTF-16 code units. */
export function bytePreview(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= limit) return text;
  let end = limit;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** JSON-only host boundary. JSON.stringify alone silently drops functions and undefined. */
export function programJson(value: unknown): string {
  const parents = new Set<object>();
  function check(item: unknown): void {
    if (item === undefined)
      throw new TypeError("Return JSON values only. Use null instead of undefined.");
    if (item === null || typeof item !== "object") return;
    if (parents.has(item)) throw new TypeError("Return JSON values without cycles.");
    parents.add(item);
    const array = Array.isArray(item);
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1)
      throw new TypeError("Return a JSON array without gaps or extra keys.");
    for (const key of keys) {
      if (array && key === "length") continue;
      const field = Object.getOwnPropertyDescriptor(item, key);
      if (
        typeof key !== "string" ||
        !field?.enumerable ||
        !("value" in field) ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
      )
        throw new TypeError(
          "Return plain JSON fields, without symbols, getters or extra array keys.",
        );
      check(field.value);
    }
    parents.delete(item);
  }
  // Check before cloning: structuredClone silently drops symbol keys and invokes getters.
  check(value);
  return JSON.stringify(copyData(value));
}

export function programReply(result: ToolResult, outputBytes: number): string {
  if (!result.ok)
    return JSON.stringify({
      ok: false,
      error: { kind: result.kind, message: bytePreview(result.content, 2048) },
    });
  try {
    const value = result.output === undefined ? undefined : programJson(result.output);
    const bytes = value === undefined ? 0 : textBytes(value);
    if (bytes > outputBytes)
      throw new TypeError(
        `The result is ${bytes} bytes; the limit is ${outputBytes}. Ask for less. The call already ran.`,
      );
    return value === undefined ? '{"ok":true}' : `{"ok":true,"value":${value}}`;
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: {
        kind: "invalid_output",
        message:
          error instanceof Error
            ? error.message
            : "The call ran but did not return JSON. Check its effect before calling it again.",
      },
    });
  }
}

/** Full values reach only the guest and output guard. Saved results/events keep this preview. */
export function programReceipt(result: ToolResult): { result: ToolResult; bytes: number } {
  const content = bytePreview(result.content, 1024);
  return {
    result: result.ok ? { ok: true, content } : { ok: false, kind: result.kind, content },
    bytes:
      result.ok && result.output !== undefined
        ? textBytes(programJson(result.output))
        : textBytes(result.content),
  };
}

function callNotes(calls: readonly ProgramCall[]) {
  return calls.slice(0, 20).map((call) => ({
    tool: call.name,
    status: !call.started
      ? "not started"
      : call.status !== "completed"
        ? "stopped"
        : call.result.ok
          ? "returned"
          : ["denied", "disabled_tool", "invalid_input"].includes(call.result.kind)
            ? "refused"
            : ["aborted", "cancelled", "interrupted"].includes(call.result.kind)
              ? "stopped"
              : "failed",
    note:
      call.status === "completed"
        ? call.result.content.slice(0, 200)
        : "The call may have partly run. Check its effect before repeating it.",
  }));
}

type ProgramError = { name: string; message: string; line?: number };
function errorKind(error: ProgramError): Extract<ToolResult, { ok: false }>["kind"] {
  if (["SyntaxError", "InvalidResultError", "InputError"].includes(error.name))
    return "invalid_input";
  if (["TimeoutError", "CpuLimitError"].includes(error.name)) return "timeout";
  if (error.name === "AbortError") return "aborted";
  return "failed";
}

export function codeMode(options: CodeModeOptions): CodeTool {
  const name = options.name ?? "run_code";
  const bound = [...options.tools];
  if (
    !isId(name) ||
    !options.driver ||
    typeof options.driver.run !== "function" ||
    (options.transpile !== undefined && typeof options.transpile !== "function") ||
    (options.needsApproval !== undefined && typeof options.needsApproval !== "boolean") ||
    (options.instructions !== undefined && typeof options.instructions !== "string")
  )
    throw new TypeError("Code mode needs a name, driver and optional transpile function.");
  if (!bound.length || new Set(bound.map((tool) => tool.name)).size !== bound.length)
    throw new TypeError("Code mode needs at least one tool, with a different name for each tool.");
  for (const tool of bound) {
    if (
      !isId(tool.name) ||
      "kind" in tool ||
      typeof tool.invoke !== "function" ||
      typeof tool.call !== "function" ||
      typeof tool.definition !== "function" ||
      tool.needsApproval ||
      tool.isTerminal ||
      isQuestionTool(tool)
    )
      throw new TypeError(
        `Code mode cannot bind ${tool.name}. Bind ordinary tools without approval, questions or terminal actions; keep control tools direct.`,
      );
  }
  const limits = Object.freeze({ ...CODE_LIMITS, ...options.limits });
  if (
    Object.keys(limits).some((key) => !Object.hasOwn(CODE_LIMITS, key)) ||
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    limits.timeoutMs > 2_147_483_647
  )
    throw new TypeError("Code limits must be positive whole numbers; timeoutMs must fit a timer.");
  const tools = Object.freeze(bound);
  const { driver, transpile } = options;
  const cache = new Map<string, ToolDefinition>();
  function definition(enabled = tools.map((tool) => tool.name)): ToolDefinition {
    const selected = tools.filter((tool) => enabled.includes(tool.name));
    const key = JSON.stringify(selected.map((tool) => tool.name));
    let value = cache.get(key);
    if (!value) {
      value = immutableCopy({
        name,
        description: [
          "Run a loop or combine tool results in code. For questions, approvals and control actions, call a direct tool instead.",
          `Write ${transpile ? "TypeScript or JavaScript" : "JavaScript"} as the body of an async function. Use await tools.name({}) or Promise.all. Use Promise.allSettled when one failed call must not lose the others. Return a small JSON value; only the return and bounded logs reach the model.`,
          "A failed tool throws ToolError with tool and kind. A failed change may have partly run. Check its effect before repeating it. Cancellation does not undo effects.",
          "Each program starts empty. JSON values only. No network, files, process, timers or imports.",
          `Limits: ${Object.entries(limits)
            .map(([key, value]) => `${key}=${value}`)
            .join(
              ", ",
            )}. Inner calls also spend the run's tool budget, except its final reserved call.`,
          options.instructions ?? "",
          toolTypings(selected),
        ]
          .filter(Boolean)
          .join("\n\n"),
        inputSchema: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
          additionalProperties: false,
        },
      });
      cache.set(key, value);
    }
    return copyData(value);
  }
  // Freeze the ordinary definition now, not after a tool author mutates a schema.
  definition();
  return Object.freeze({
    kind: "code",
    name,
    tools,
    limits,
    isReadOnly: tools.every((tool) => tool.isReadOnly),
    needsApproval: options.needsApproval ?? false,
    definition,
    async execute(raw: unknown, bridge: ProgramBridge): Promise<ProgramOutcome> {
      let error: ProgramError | undefined;
      let value: unknown;
      let logs = "";
      let droppedLogBytes = 0;
      try {
        if (!isRecord(raw) || typeof raw.code !== "string" || Object.keys(raw).length !== 1)
          throw new TypeError("Pass one code string containing the body of an async function.");
        if (textBytes(raw.code) > limits.sourceBytes)
          throw new TypeError(
            `The code exceeds ${limits.sourceBytes} bytes. Send a shorter program.`,
          );
        let expression = `(async () => {\n${raw.code}\n})`;
        if (transpile)
          expression = await untilAbort(Promise.resolve(transpile(expression)), bridge.signal);
        if (typeof expression !== "string" || textBytes(expression) > limits.sourceBytes + 32)
          throw new TypeError(
            `The compiled code exceeds ${limits.sourceBytes} bytes. Send a shorter program.`,
          );
        const result: CodeJobResult = await driver.run({
          script: codeScript(
            expression,
            bridge.tools.map((tool) => tool.name),
          ),
          call: bridge.call,
          log(text) {
            if (bridge.signal.aborted) return;
            const addition = `${logs ? "\n" : ""}${text}`;
            const kept = bytePreview(addition, limits.logBytes - textBytes(logs));
            logs += kept;
            droppedLogBytes += textBytes(addition) - textBytes(kept);
          },
          ...limits,
          deadline: bridge.deadline,
          signal: bridge.signal,
        });
        if (!result.ok)
          error = { ...result.error, message: bytePreview(result.error.message, 2048) };
        // Error text has its own 2 KiB ceiling; JSON escaping must not turn it into an
        // oversized successful return when the host chooses a tiny resultBytes allowance.
        else if (textBytes(result.envelope) > Math.max(limits.resultBytes + 64, 16 * 1024))
          error = {
            name: "InvalidResultError",
            message: `The returned JSON exceeds ${limits.resultBytes} bytes. Return less data. Completed tool calls are not undone.`,
          };
        else {
          const envelope: unknown = JSON.parse(result.envelope);
          if (!isRecord(envelope) || typeof envelope.ok !== "boolean")
            throw new TypeError("The code driver returned an invalid result envelope.");
          if (envelope.ok) {
            value = envelope.value;
            if (value !== undefined && textBytes(programJson(value)) > limits.resultBytes)
              error = {
                name: "InvalidResultError",
                message: `The returned JSON exceeds ${limits.resultBytes} bytes. Return less data.`,
              };
          } else {
            if (
              !isRecord(envelope.error) ||
              typeof envelope.error.name !== "string" ||
              typeof envelope.error.message !== "string"
            )
              throw new TypeError("The code driver returned an invalid error envelope.");
            error = {
              name:
                envelope.invalidResult === true
                  ? "InvalidResultError"
                  : envelope.error.name === "SyntaxError"
                    ? "SyntaxError"
                    : "ProgramError",
              message: bytePreview(envelope.error.message, 2048),
              ...(!transpile &&
              typeof envelope.error.line === "number" &&
              Number.isSafeInteger(envelope.error.line) &&
              envelope.error.line > 0
                ? { line: envelope.error.line }
                : {}),
            };
          }
        }
      } catch (cause) {
        error = {
          name: bridge.signal.aborted ? "AbortError" : "InputError",
          message:
            cause instanceof Error
              ? bytePreview(cause.message, 2048)
              : "The program could not run. Check its code and driver.",
        };
      } finally {
        await bridge.settle();
      }
      if (error?.name === "AbortError" && Date.now() >= bridge.deadline)
        error = {
          name: "TimeoutError",
          message:
            "The program reached its wall-time limit. Check the call receipts before repeating a change.",
        };
      const content = JSON.stringify({
        ...(value !== undefined && !error ? { result: value } : {}),
        logs,
        ...(droppedLogBytes ? { droppedLogBytes } : {}),
        toolCalls: bridge.calls.length,
        toolCallsLeft: bridge.toolCallsLeft(),
        ...(error ? { error, calls: callNotes(bridge.calls) } : {}),
      });
      return {
        result: error ? { ok: false, kind: errorKind(error), content } : { ok: true, content },
      };
    },
    close(calls: readonly ProgramCall[]): ToolResult {
      return {
        ok: false,
        kind: "interrupted",
        content: JSON.stringify({
          error: {
            name: "InterruptedError",
            message:
              "The program stopped before its result was saved. These receipts show which calls ran. Do not repeat them. Calls marked not started did not run.",
          },
          calls: callNotes(calls),
          toolCalls: calls.length,
        }),
      };
    },
  });
}
