// The optional zod ergonomics — `@providerkit/core/zod`.
//
// Kept behind its own entry point so the core stays dependency-free for
// consumers that have no zod (a browser extension counting every byte, for
// one). Import this and tools become typed end to end.
import { z } from "zod";
import { defineTool, type Tool, type ToolContext } from "./tools.ts";
import { clampToSchema } from "./schema.ts";
import type { JsonObjectSchema } from "./types.ts";

type Issues = readonly z.core.$ZodIssue[];

/** zod's JSON Schema without the dialect URI it puts at the root. */
function jsonSchemaOf(
  schema: z.ZodType,
  params: z.core.ToJSONSchemaParams,
): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, params) as Record<string, unknown>;
  return json;
}

/**
 * A zod schema as the JSON Schema every provider's tool contract wants.
 *
 * `$schema` is dropped. zod emits the dialect URI at the root, and a provider
 * validating a tool's `parameters` against its own supported subset (OpenAI
 * under `strict: true`, Gemini's `parametersJsonSchema`) rejects the whole
 * tool over that one key, with a message that names neither zod nor the field.
 */
export function toJsonObjectSchema(schema: z.ZodType, label = "schema"): JsonObjectSchema {
  const json = jsonSchemaOf(schema, { io: "input" });
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
  /**
   * Checks every result before the model or your code reads it, and fills `outputSchema` for
   * generated result types. A result that fails is a `failed` outcome the model reads, and its
   * value is dropped. A result that passes is the parsed value, so unknown keys are dropped and
   * defaults are filled in before the model sees it.
   */
  output?: z.ZodType<O>;
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
   * Off by default: an ordinary tool can simply be called again.
   */
  clampOverflow?: boolean;
}

/** How many problems the model reads back: a 1,000-row sheet can fail on every cell. */
const MAX_ISSUES = 5;

/**
 * Where each problem is and what to change, in zod's words. The message names the fix
 * ("expected array, received string"); the bare code sent a model back to resend the same
 * call. The rest are counted, so a model that fixes five does not take them for all of it.
 * `root` names a problem with the whole value: the model's arguments, or the tool's result.
 */
function describeIssues(issues: Issues, root: "input" | "result"): string {
  const lines = issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `${issue.path.map(String).join(".") || root}: ${issue.message}`);
  if (issues.length > MAX_ISSUES) lines.push(`and ${issues.length - MAX_ISSUES} more`);
  return lines.join("; ");
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

/** A JSON array or object, or undefined: `"42"`, `"null"` and prose stay strings. */
function jsonContainer(text: string): object | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The fix for a value the schema rejected for its type, or undefined when there is none.
 * Both slips cost production runs:
 *
 * - An array or object sent as a JSON string, `{"sheets":"[{...}]"}`. 13 of 16 spreadsheet
 *   calls in one day failed this way, each resent unchanged.
 * - A string sent as `{ text }`, copying a sibling field whose items are objects. A research
 *   run lost its brief this way on its last step. Only an object holding exactly one string
 *   `text`: an extra key or a non-string `text` stays the model's error to fix.
 */
function slipFix(value: unknown, expected: string): unknown {
  if (typeof value === "string") return jsonContainer(value);
  const wrapped =
    expected === "string" &&
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.text === "string";
  return wrapped ? value.text : undefined;
}

/**
 * `raw` with each slip fixed, only where zod rejected a value for its type: a string the
 * schema took is never decoded, however much it looks like JSON. Returns `raw` itself when
 * nothing applies, and never changes the caller's arguments.
 */
function repairSlips(raw: unknown, issues: Issues): unknown {
  const copy = structuredClone(raw);
  let changed = false;
  for (const issue of issues) {
    if (issue.code !== "invalid_type") continue;
    const key = issue.path.at(-1);
    let parent: unknown = copy;
    for (const step of issue.path.slice(0, -1)) parent = isRecord(parent) ? parent[step] : null;
    if (key === undefined || !isRecord(parent)) continue;
    const fixed = slipFix(parent[key], issue.expected);
    if (fixed === undefined) continue;
    parent[key] = fixed;
    changed = true;
  }
  return changed ? copy : raw;
}

/** `spec.run` with each result checked against `output` before the model or your code reads it. */
function checkedRun<I, O>(spec: ZodToolSpec<I, O>, output: z.ZodType<O>): ZodToolSpec<I, O>["run"] {
  return async (input, ctx) => {
    const parsed = output.safeParse(await spec.run(input, ctx));
    if (parsed.success) return parsed.data;
    // The call ran, so a write may already have happened. The model decides whether to
    // call again from this, as it does from `repairHistory`'s interrupted-call note.
    const effect = spec.isReadOnly ? "" : " Check its effect before calling it again.";
    throw new Error(
      `${spec.name} ran, but its result does not match its output schema.${effect} Problems: ${describeIssues(parsed.error.issues, "result")}`,
    );
  };
}

/**
 * A tool whose arguments are validated by zod, with the failure reported to
 * the model in words it can act on. `topic: expected string, received number`
 * beats a stack trace it cannot read.
 */
export function zodTool<I, O>(spec: ZodToolSpec<I, O>): Tool<I, O> {
  const inputSchema = toJsonObjectSchema(spec.input, `Tool "${spec.name}" input`);
  const { output } = spec;

  function clamp(value: unknown): unknown {
    return spec.clampOverflow ? clampToSchema(value, inputSchema) : value;
  }

  // One repair, one more parse, and the error is the second parse's: a real mistake inside
  // a decoded string, or beside a fixed wrapper, still reaches the model. The repaired
  // value is clamped too, since a string unwrapped from `{ text }` can be the one too long.
  function parseInput(raw: unknown): I {
    const candidate = clamp(raw);
    const first = spec.input.safeParse(candidate);
    if (first.success) return first.data;
    const repaired = repairSlips(candidate, first.error.issues);
    const parsed = repaired === candidate ? first : spec.input.safeParse(clamp(repaired));
    if (parsed.success) return parsed.data;
    throw new Error(describeIssues(parsed.error.issues, "input"));
  }

  return defineTool<I, O>({
    name: spec.name,
    description: spec.description,
    inputSchema,
    // Metadata only, never sent to a provider. A type JSON Schema cannot express (a Date, a
    // transform) reads as any value here rather than refusing the tool; the check runs on zod.
    ...(output
      ? { outputSchema: jsonSchemaOf(output, { io: "output", unrepresentable: "any" }) }
      : {}),
    ...(spec.summarize ? { summarize: spec.summarize } : {}),
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.isReadOnly !== undefined ? { isReadOnly: spec.isReadOnly } : {}),
    ...(spec.needsApproval !== undefined ? { needsApproval: spec.needsApproval } : {}),
    ...(spec.isConcurrencySafe !== undefined ? { isConcurrencySafe: spec.isConcurrencySafe } : {}),
    ...(spec.isTerminal !== undefined ? { isTerminal: spec.isTerminal } : {}),
    validate: parseInput,
    run: output ? checkedRun(spec, output) : spec.run,
  });
}
