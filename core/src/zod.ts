// The optional zod ergonomics — `providerkit/zod`.
//
// Kept behind its own entry point so the core stays dependency-free for
// consumers that have no zod (a browser extension counting every byte, for
// one). Import this and tools become typed end to end.
import { z } from "zod";
import { defineTool, type Tool, type ToolContext } from "./tools.ts";
import { clampToSchema } from "./schema.ts";
import type { JsonObjectSchema } from "./types.ts";

/** A zod schema as the JSON Schema every provider's tool contract wants. */
export function toJsonObjectSchema(schema: z.ZodType, label = "schema"): JsonObjectSchema {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  if (json.type !== "object") {
    // Every provider requires an object at the top level of a tool's
    // parameters; a bare string or array is rejected at the wire, far from
    // here, with a message that names none of this.
    throw new Error(`providerkit: ${label} must be an object schema, got ${String(json.type)}`);
  }
  return json as JsonObjectSchema;
}

export interface ZodToolSpec<I, O> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  run: (input: I, ctx: ToolContext) => Promise<O>;
  summarize?: (output: O) => string;
  timeoutMs?: number;
  isReadOnly?: boolean;
  needsApproval?: boolean;
  isConcurrencySafe?: boolean;
  isTerminal?: boolean;
  /**
   * Clamp overflow to the bounds the schema already advertised instead of
   * rejecting the call. Worth it for a TERMINAL tool, which gets no second
   * chance: a forced-submit salvage turn runs exactly once, and discarding an
   * otherwise-valid answer over a few extra characters loses the whole run.
   * Off by default — an ordinary tool can simply be called again.
   */
  clampOverflow?: boolean;
}

/**
 * A tool whose arguments are validated by zod, with the failure reported to
 * the MODEL in words it can act on — `topic: expected string, received number`
 * beats a stack trace it cannot read.
 */
export function zodTool<I, O>(spec: ZodToolSpec<I, O>): Tool<I, O> {
  const inputSchema = toJsonObjectSchema(spec.input, `Tool "${spec.name}" input`);

  return defineTool<I, O>({
    name: spec.name,
    description: spec.description,
    inputSchema,
    ...(spec.summarize ? { summarize: spec.summarize } : {}),
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.isReadOnly !== undefined ? { isReadOnly: spec.isReadOnly } : {}),
    ...(spec.needsApproval !== undefined ? { needsApproval: spec.needsApproval } : {}),
    ...(spec.isConcurrencySafe !== undefined ? { isConcurrencySafe: spec.isConcurrencySafe } : {}),
    ...(spec.isTerminal !== undefined ? { isTerminal: spec.isTerminal } : {}),
    validate: (raw) => {
      const candidate = spec.clampOverflow ? clampToSchema(raw, inputSchema) : raw;
      const parsed = spec.input.safeParse(candidate);
      if (parsed.success) return parsed.data;
      throw new Error(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
          .join("; "),
      );
    },
    run: spec.run,
  });
}
