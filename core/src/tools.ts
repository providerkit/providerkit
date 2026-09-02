// The tool kernel: a validated, cancellable, time-bounded call.
//
// JSON Schema first, on purpose. A zod dependency would be dead weight for a
// consumer that has none — and one of the codebases this came from is exactly
// that. `providerkit/zod` adds the ergonomic wrapper for everyone else, and
// stays an optional peer.
//
// The one rule worth stating: a tool FAILING is not an exception here. A model
// that called a tool wrong, or a tool that timed out, is data the loop feeds
// back so the model can correct itself. `invoke` therefore returns an outcome
// rather than throwing, and only a caller's abort escapes.
import type { JsonObjectSchema, ToolDefinition } from "./types.ts";
import { messageOf } from "./errors.ts";

export interface ToolContext {
  /** The model's own call id when there is one — the event, any approval row
   *  and the tool message must all key on what the provider expects back. */
  callId?: string;
  signal?: AbortSignal;
  /** Anything the host wants to hand its tools (a db handle, the actor). */
  [key: string]: unknown;
}

export type ToolFailure = "invalid_input" | "timeout" | "aborted" | "failed";

export type ToolOutcome<O> =
  | { ok: true; callId: string; output: O; summary: string; durationMs: number }
  | {
      ok: false;
      callId: string;
      kind: ToolFailure;
      /** Fed back to the model verbatim — so it must read as an instruction to
       *  a reader who cannot see our stack trace. */
      error: string;
      durationMs: number;
      cause?: unknown;
    };

export interface ToolSpec<I, O> {
  name: string;
  description: string;
  /** Advertised to the model verbatim. */
  inputSchema: JsonObjectSchema;
  /**
   * Turn raw arguments into `I`, or throw with a message the MODEL can act on.
   * Omit to accept whatever arrived (the schema is then only a hint).
   */
  validate?: (raw: unknown) => I;
  run: (input: I, ctx: ToolContext) => Promise<O>;
  /** How the result reads back to the model. Defaults to JSON. */
  summarize?: (output: O) => string;
  /** Default 60s. A tool with no ceiling can hang a whole run. */
  timeoutMs?: number;
  isReadOnly?: boolean;
  needsApproval?: boolean;
  isConcurrencySafe?: boolean;
  /** A terminal tool ends the run; its validated input is the run's output. */
  isTerminal?: boolean;
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  readonly timeoutMs: number;
  readonly isReadOnly: boolean;
  readonly needsApproval: boolean;
  readonly isConcurrencySafe: boolean;
  readonly isTerminal: boolean;
  definition(): ToolDefinition;
  /** Validate, run, and report the outcome. Never throws except on abort. */
  invoke(rawArgs: unknown, ctx?: ToolContext): Promise<ToolOutcome<O>>;
  /** The typed path for internal callers: throws on failure. */
  call(input: I, ctx?: ToolContext): Promise<O>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class ToolTimeoutError extends Error {
  constructor(tool: string, ms: number) {
    super(`Tool "${tool}" timed out after ${ms}ms`);
    this.name = "ToolTimeoutError";
  }
}

/** Rejects when `signal` aborts — races a `run` that ignores its own signal. */
function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `call_${Math.random().toString(36).slice(2, 12)}`;
}

export function defineTool<I = unknown, O = unknown>(spec: ToolSpec<I, O>): Tool<I, O> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const summarize = spec.summarize ?? ((output: O) => JSON.stringify(output) ?? "");
  let cached: ToolDefinition | null = null;

  async function execute(input: I, ctx: ToolContext): Promise<{ output: O; durationMs: number }> {
    const started = Date.now();
    // Two deadlines compose into the one signal `run` sees: our timeout and
    // the caller's abort. `run` gets a signal it can honour; the race is there
    // for the ones that do not.
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(ctx.signal?.reason);
    ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new ToolTimeoutError(spec.name, timeoutMs));
    }, timeoutMs);
    try {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      const output = await Promise.race([
        spec.run(input, { ...ctx, signal: controller.signal }),
        abortion(controller.signal),
      ]);
      return { output, durationMs: Date.now() - started };
    } catch (err) {
      throw timedOut ? new ToolTimeoutError(spec.name, timeoutMs) : err;
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  function classifyFailure(err: unknown, ctx: ToolContext): ToolFailure {
    if (err instanceof ToolTimeoutError) return "timeout";
    // The caller's own abort — distinct from our timeout, and never something
    // to report back to the model as a tool that "failed".
    if (ctx.signal?.aborted) return "aborted";
    const name = err instanceof Error ? err.name : undefined;
    return name === "AbortError" ? "aborted" : "failed";
  }

  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    timeoutMs,
    isReadOnly: spec.isReadOnly ?? true,
    needsApproval: spec.needsApproval ?? false,
    isConcurrencySafe: spec.isConcurrencySafe ?? true,
    isTerminal: spec.isTerminal ?? false,

    definition() {
      cached ??= {
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
      };
      return cached;
    },

    async call(input, ctx = {}) {
      return (await execute(input, ctx)).output;
    },

    async invoke(rawArgs, ctx = {}) {
      const callId = ctx.callId ?? newId();
      const started = Date.now();

      let input: I;
      try {
        input = spec.validate ? spec.validate(rawArgs) : (rawArgs as I);
      } catch (err) {
        return {
          ok: false,
          callId,
          kind: "invalid_input",
          error: `Invalid arguments for ${spec.name}: ${messageOf(err)}`,
          durationMs: 0,
          cause: err,
        };
      }

      try {
        const { output, durationMs } = await execute(input, { ...ctx, callId });
        return { ok: true, callId, output, summary: summarize(output), durationMs };
      } catch (err) {
        return {
          ok: false,
          callId,
          kind: classifyFailure(err, ctx),
          error: messageOf(err),
          durationMs: Date.now() - started,
          cause: err,
        };
      }
    },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Definitions for an allow-list, in the order given — which is the order the
   * model reads them in, and it is part of the cached prompt prefix. Reordering
   * or appending mid-conversation invalidates that prefix, so a caller that
   * cares should freeze the list when the session opens.
   */
  definitions(allow?: readonly string[]): ToolDefinition[] {
    const names = allow ?? this.names;
    const out: ToolDefinition[] = [];
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) out.push(tool.definition());
    }
    return out;
  }
}
