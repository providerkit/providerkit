// The optional zod ergonomics — `@providerkit/core/zod`.
//
// Kept behind its own entry point so the core stays dependency-free for
// consumers that have no zod (a browser extension counting every byte, for
// one). Import this and tools become typed end to end.
import { z } from "zod";
import { defineTool, type Tool, type ToolContext } from "./tools.ts";
import { clampToSchema } from "./schema.ts";
import { messageOf } from "./errors.ts";
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

/** `R` is what `run` returns. It is `O` unless `output` parses it into something else. */
export interface ZodToolSpec<I, O, R = O> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /**
   * Checks every result before the model or your code reads it, and fills `outputSchema` for
   * generated result types. `run` returns what the schema takes, `unknown` included, and the
   * tool returns what the schema parses that into, after any transform. A result that fails is
   * a `failed` outcome the model reads, and its value is dropped. A result that passes is the
   * parsed value, so unknown keys are dropped and defaults are filled in before the model sees it.
   */
  output?: z.ZodType<O, R>;
  run: (input: I, ctx: ToolContext) => Promise<R>;
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
  /**
   * Writes the problems zod found in your words instead of zod's, for the input check and the
   * `output` check. zod's sentence can list every value a field accepts and quote the caller's
   * key names, and an app that saves tool replies keeps that text: an adopter shows each reply
   * again in its studio for a week, so it words a problem from its path and code alone. That
   * tells the model less. A bare `invalid_type` at `sheets` once sent a model back to resend
   * the same call, which is why the default keeps zod's sentence.
   *
   * It gets zod's error, with every issue, and `checked`: `input` for the model's arguments,
   * `result` for what `run` returned. On input it words the same parse `invoke` and `accepts`
   * decide by, after the repairs. Only the default stops at five issues. A check that throws
   * reads as its own message. zod's error, or what the check threw, stays as the `cause` of the
   * error the tool throws, so `ToolOutcome.cause` leads to it in your logs. Defaults to zod's
   * message for each issue, after its path.
   */
  describeIssues?: (error: z.ZodError, checked: "input" | "result") => string;
}

/** How many problems the model reads back: a 1,000-row sheet can fail on every cell. */
const MAX_ISSUES = 5;

/**
 * Where each problem is and what to change, in zod's words. The message names the fix
 * ("expected array, received string"); the bare code sent a model back to resend the same
 * call. The rest are counted, so a model that fixes five does not take them for all of it.
 * `root` names a problem with the whole value: the model's arguments, or the tool's result.
 */
function describeIssues({ issues }: z.ZodError, root: "input" | "result"): string {
  const lines = issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `${issue.path.map(String).join(".") || root}: ${issue.message}`);
  if (issues.length > MAX_ISSUES) lines.push(`and ${issues.length - MAX_ISSUES} more`);
  return lines.join("; ");
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

/** Whether each zod type a JSON string can stand in for is a JSON list (true) or object (false). */
const JSON_CONTAINERS = new Map([
  ["array", true],
  ["tuple", true],
  ["object", false],
  ["record", false],
]);

/**
 * `text` decoded, only when it is the JSON container the schema `expected`. Anything else fails
 * the second parse too, and that parse's error would tell the model about a value it never
 * sent: `"[3]"` for a number would come back as "received array". `"42"`, `"null"` and prose
 * stay strings.
 */
function jsonContainer(text: string, expected: string): object | undefined {
  const isList = JSON_CONTAINERS.get(expected);
  if (isList === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    const fits = typeof value === "object" && value !== null && Array.isArray(value) === isList;
    return fits ? value : undefined;
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
  if (typeof value === "string") return jsonContainer(value, expected);
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

/**
 * `spec.run` with each result checked against `output` before the model or your code reads it.
 * The result is read as unknown: `output` decides its type, whatever `run` declared.
 */
function checkedRun<I, O>(
  spec: ZodToolSpec<I, O, unknown>,
  output: z.ZodType<O>,
  describe: typeof describeIssues,
): (input: I, ctx: ToolContext) => Promise<O> {
  return async (input, ctx) => {
    const result = await spec.run(input, ctx);
    let problems: string;
    let cause: unknown;
    try {
      // Async, because the sync parse throws on an async refine or transform.
      const parsed = await output.safeParseAsync(result);
      if (parsed.success) return parsed.data;
      cause = parsed.error;
      // Inside the try, so a wording that throws still tells the model the call ran.
      problems = describe(parsed.error, "result");
    } catch (err) {
      // zod does not catch a refine or transform that throws (`new URL` on a bad link). The
      // call ran all the same, and that is what the model must read.
      cause = err;
      problems = messageOf(err);
    }
    // The call ran, so a write may already have happened. The model decides whether to
    // call again from this, as it does from `repairHistory`'s interrupted-call note.
    const effect = spec.isReadOnly ? "" : " Check its effect before calling it again.";
    throw new Error(
      `${spec.name} ran, but its result does not match its output schema.${effect} Problems: ${problems}`,
      { cause },
    );
  };
}

/**
 * A zod tool that checks its results too. It returns what `output` makes of `run`'s result, so
 * `run` can return `unknown`, or the string a transform turns into a `Date`.
 */
export function zodTool<I, O, R>(
  spec: ZodToolSpec<I, O, R> & { output: z.ZodType<O, R> },
): Tool<I, O>;
/**
 * A tool whose arguments are validated by zod, with the failure reported to
 * the model in words it can act on. `topic: expected string, received number`
 * beats a stack trace it cannot read.
 */
export function zodTool<I, O>(spec: ZodToolSpec<I, O>): Tool<I, O>;
// Two signatures, so only a tool with `output` can return a type `run` does not. `output` comes
// first: the second signature takes an optional one too, for a wrapper that passes it through,
// and would type a `run` that returns `unknown` as a tool that returns `unknown`. The body is
// typed as the second. With `output`, `checkedRun` reads the result as unknown, so that holds
// for any `R`.
export function zodTool<I, O>(spec: ZodToolSpec<I, O>): Tool<I, O> {
  const inputSchema = toJsonObjectSchema(spec.input, `Tool "${spec.name}" input`);
  const { output } = spec;
  const describe = spec.describeIssues ?? describeIssues;

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
    // The model reads the message, which may be the app's words. zod's error stays as the
    // cause, and `invoke` keeps what was thrown, so logs still have all of it.
    throw new Error(describe(parsed.error, "input"), { cause: parsed.error });
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
    run: output ? checkedRun(spec, output, describe) : spec.run,
  });
}
