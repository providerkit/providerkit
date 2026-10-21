// Clamping a model's output to the bounds its own schema advertised.
//
// Models treat `maxLength` and `maxItems` as soft hints and routinely overflow
// them when they have a lot to say. Rejecting the whole submission over a few
// extra characters is the worst available outcome — the run fails and the
// person gets nothing, when a perfectly good answer was sitting right there.
//
// So OVERFLOW is clamped to the very limit the schema told the model about.
// Structural problems — a missing required field, the wrong type, a bad enum —
// are deliberately left alone for the real validator to reject: those are the
// model misunderstanding the contract, not overrunning it.
//
// This walks the generated JSON Schema, a stable public shape, rather than any
// validator's internals.
type SchemaNode = Record<string, unknown>;

export function clampToSchema(value: unknown, node: unknown): unknown {
  if (!node || typeof node !== "object") return value;
  const schema = node as SchemaNode;

  // Nullable and union fields (`anyOf: [schema, {type: "null"}]`). Fold through
  // every branch: only the one whose type matches transforms, the rest no-op.
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    return union.reduce<unknown>((current, branch) => clampToSchema(current, branch), value);
  }

  if (typeof value === "string") {
    const max = schema.maxLength;
    // Ends in an ellipsis so the cut is visible rather than silent. "…" is one
    // UTF-16 unit — the same unit the validators count — so the result lands
    // at exactly `max`.
    if (typeof max === "number" && max >= 1 && value.length > max) {
      return `${value.slice(0, max - 1)}…`;
    }
    return value;
  }

  if (typeof value === "number") {
    let out = value;
    if (typeof schema.maximum === "number" && out > schema.maximum) out = schema.maximum;
    if (typeof schema.minimum === "number" && out < schema.minimum) out = schema.minimum;
    return out;
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => clampToSchema(item, schema.items));
    const max = schema.maxItems;
    return typeof max === "number" && items.length > max ? items.slice(0, max) : items;
  }

  if (
    value &&
    typeof value === "object" &&
    schema.properties &&
    typeof schema.properties === "object"
  ) {
    const properties = schema.properties as Record<string, unknown>;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const key of Object.keys(out)) {
      if (key in properties) out[key] = clampToSchema(out[key], properties[key]);
    }
    return out;
  }

  return value;
}

/**
 * Whether OpenAI's `strict` schema mode will accept this schema.
 *
 * Strict is the only JSON mode that actually guarantees the shape, so it is
 * worth having, but it demands more than JSON Schema does: every property an
 * object lists must ALSO be required, and every object must close itself with
 * `additionalProperties: false`, all the way down. A schema with one optional
 * field is not "mostly strict"; it is a flat 400 naming a nested path rather
 * than the rule it broke.
 *
 * That trap is the reason this exists. An agent's response schema grows
 * optional fields naturally (a `data` block only some flows fill, the fields
 * one step collects). A caller who adds one wants their answer, not a
 * lecture about a mode they never asked for. So the OpenAI-shape adapters ask
 * this and drop to plain (unenforced) schema mode instead of failing the turn.
 *
 * Anything it cannot verify (a `$ref`, a composed `allOf`) answers false:
 * the cost of guessing wrong that way is unenforced output, and the cost of
 * guessing wrong the other way is a request that cannot succeed at all.
 */
/**
 * The schema as prompt text, for a shape that cannot enforce one.
 *
 * The seam's promise is that a provider without native enforcement gets the
 * schema in the PROMPT instead. Skip it and an `opts.json` request goes out
 * carrying nothing about the shape at all: the model answers in whatever form
 * it likes, and the caller's `JSON.parse` throws on the happy path, where no
 * retry looks and no error is recorded.
 *
 * Two shapes need it, which is why the wording lives here rather than in one of
 * them. Anthropic has never had a schema mode. The OpenAI dialect falls back to
 * plain JSON mode on every gateway: `json_object` asks for valid JSON and says
 * nothing whatsoever about its shape.
 */
export function schemaPrompt(schema: unknown): string {
  return (
    "Respond with a single JSON object matching this schema. No prose, no code fence.\n" +
    // Nothing pins the decoder when the schema rides in the prompt, so the model
    // is free to pretty-print its reply — and it does, putting a real line break
    // inside a string value, which is invalid JSON and costs the whole response.
    // Saying so is not a guarantee (the caller still has to survive a violation)
    // but this is the only place the model is told at all.
    "Write a line break inside a string value as \\n. A real line break there is invalid JSON.\n" +
    JSON.stringify(schema)
  );
}

export function isStrictSchema(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const schema = node as SchemaNode;

  if (schema.$ref !== undefined || schema.allOf !== undefined) return false;

  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) return union.every(isStrictSchema);

  // A leaf (string, number, boolean, enum) carries no strict obligations.
  if (schema.type === "array") return schema.items === undefined || isStrictSchema(schema.items);
  if (schema.properties === undefined) return true;

  if (schema.additionalProperties !== false) return false;
  const properties = schema.properties as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties).every(
    ([key, value]) => required.has(key) && isStrictSchema(value),
  );
}

/** Keywords whose value is a schema, a list of schemas, or a map of them.
 *  These are the only places a `pattern` can mean a regex. Everything else (`default`,
 *  `examples`, `enum`, property NAMES) is data and is left alone. */
const SCHEMA_SLOTS = [
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

/**
 * A tool schema with every `pattern` constraint removed.
 *
 * The ChatGPT backend compiles tool schemas with OpenAI's own regex dialect and
 * answers a pattern it cannot read with a 400 for the whole request, strict
 * or not. Claude Code's Artifact tool carries one, and every request that
 * offered it failed (cc-proxy #141/#142). Losing the constraint costs a
 * validation the caller's tool runner repeats anyway; the 400 costs the turn.
 */
export function withoutPatterns(node: unknown): unknown {
  if (!isSchemaObject(node)) return node;
  const { pattern: _pattern, ...schema } = node;
  mapChildren(schema, withoutPatterns);
  return schema;
}

function isSchemaObject(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/** Replaces every child schema of `schema`, in place, with what `visit` returns for it. `slot`
 *  is the keyword it sits under and `name` is its property name, for the keywords that map
 *  names to schemas. */
function mapChildren(
  schema: Record<string, unknown>,
  visit: (child: unknown, slot: string, name?: string) => unknown,
): void {
  for (const slot of SCHEMA_SLOTS) {
    const value = schema[slot];
    if (value !== undefined) {
      schema[slot] = Array.isArray(value)
        ? value.map((child) => visit(child, slot))
        : visit(value, slot);
    }
  }
  for (const slot of SCHEMA_LISTS) {
    const value = schema[slot];
    if (Array.isArray(value)) schema[slot] = value.map((child) => visit(child, slot));
  }
  for (const slot of SCHEMA_MAPS) {
    const value = schema[slot];
    if (isSchemaObject(value)) {
      schema[slot] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, visit(child, slot, name)]),
      );
    }
  }
}

/**
 * A JSON Schema for Gemini's `parametersJsonSchema` and `responseJsonSchema`, which take
 * standard JSON Schema. It is sent as written except for the four shapes the API refuses.
 * Measured on `gemini-3.8-flash` on 2026-10-21, in a tool and as a response schema alike;
 * every other keyword tried (`$ref`, `$defs`, `oneOf`, `allOf`, `not`, `if`, `const`, numeric
 * `enum`, `type: [..., "null"]`, `patternProperties`, `additionalProperties`, arrays without
 * `items`) came back accepted:
 *
 * - `required` names a property that is not declared, at any depth: 400 "requires unspecified
 *   property". The names with no property are dropped.
 * - Draft-04 `exclusiveMinimum: true` (or `false`): 400 "must be a number". It becomes the
 *   number form, `exclusiveMinimum: <minimum>`, and `minimum` goes.
 * - A tuple, `items: [a, b]`: 400 "must be a boolean or an object". It becomes `prefixItems`,
 *   and `additionalItems` becomes `items`, as in 2020-12.
 * - A recursive `$ref` that is not behind an optional property or an array that may be empty:
 *   400 "ref loops are only supported if ...". The self-reference becomes `{}`.
 *
 * This replaced a sanitizer written for the older `parameters` field, which accepts a small
 * OpenAPI subset. Kept on `parametersJsonSchema`, it turned a numeric enum into a string enum
 * (the model then sent `"2"` for `2`), forced string items onto an array of anything, and
 * dropped every `$ref`, while still sending the 400s above.
 */
export function toGeminiToolSchema(node: unknown): Record<string, unknown> {
  if (!isSchemaObject(node)) return { type: "object", properties: {} };
  const root = geminiStandardForm(node);
  for (const defs of ["$defs", "definitions"]) {
    const entries = root[defs];
    if (isSchemaObject(entries)) {
      root[defs] = Object.fromEntries(
        Object.entries(entries).map(([name, def]) => [
          name,
          cutRefLoops(def, `#/${defs}/${name}`, false),
        ]),
      );
    }
  }
  const cut = cutRefLoops(root, "#", false);
  return isSchemaObject(cut) ? cut : root;
}

function geminiStandardForm(node: Record<string, unknown>): Record<string, unknown> {
  const schema = { ...node };
  mapChildren(schema, (child) => (isSchemaObject(child) ? geminiStandardForm(child) : child));

  if (Array.isArray(schema.required)) {
    const declared = isSchemaObject(schema.properties) ? schema.properties : {};
    schema.required = schema.required.filter(
      (name) => typeof name === "string" && Object.hasOwn(declared, name),
    );
  }

  for (const [flag, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ] as const) {
    if (typeof schema[flag] !== "boolean") continue;
    if (schema[flag] && typeof schema[bound] === "number") {
      schema[flag] = schema[bound];
      delete schema[bound];
    } else {
      delete schema[flag];
    }
  }

  if (Array.isArray(schema.items)) {
    schema.prefixItems = schema.items;
    delete schema.items;
    if ("additionalItems" in schema) {
      const extra = schema.additionalItems;
      schema.items = isSchemaObject(extra) ? geminiStandardForm(extra) : extra;
      delete schema.additionalItems;
    }
  }
  return schema;
}

/**
 * Gemini takes a recursive `$ref` only when the loop passes through a property that is not
 * required or an `items` that may be empty. Any other reference to `target` becomes `{}`.
 *
 * ponytail: this cuts a definition's reference to ITSELF. Two definitions that refer to each
 * other through required properties still get the 400; follow the ref graph if one shows up.
 */
function cutRefLoops(node: unknown, target: string, safe: boolean): unknown {
  if (!isSchemaObject(node)) return node;
  if (!safe && node.$ref === target) return {};
  const schema = { ...node };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const mayBeEmpty = !(typeof schema.minItems === "number" && schema.minItems > 0);
  mapChildren(schema, (child, slot, name) =>
    cutRefLoops(
      child,
      target,
      safe ||
        (slot === "items" && mayBeEmpty) ||
        (slot === "properties" && !required.includes(name)),
    ),
  );
  return schema;
}

/**
 * Sanitize a JSON Schema to the OpenAPI 3.0 subset Google's Cloud Code Assist
 * (`antigravity`) accepts in its `parameters` field (`type`, `nullable`,
 * `description`, `format`, `enum`, `properties`, `items`, `required`, `anyOf`).
 * Mirrors cc-proxy's `clean_json_schema`, including the `{ type: "string" }`
 * fallback when an array omits `items`.
 */
export function toAntigravityToolSchema(node: unknown): Record<string, unknown> {
  if (!isSchemaObject(node)) return { type: "object" };
  const out: Record<string, unknown> = {};
  let nullable = node.nullable === true;

  if (typeof node.type === "string") {
    if (node.type === "null") nullable = true;
    else out.type = node.type;
  } else if (Array.isArray(node.type)) {
    let picked: string | undefined;
    for (const item of node.type) {
      if (typeof item !== "string") continue;
      if (item === "null") nullable = true;
      else if (picked === undefined) picked = item;
    }
    if (picked !== undefined) out.type = picked;
  }
  if (nullable) out.nullable = true;
  if (typeof node.description === "string" && node.description.length > 0) {
    out.description = node.description;
  }
  if (node.format === "enum" || node.format === "date-time") {
    out.format = node.format;
  }
  if (Array.isArray(node.enum)) {
    const strings = node.enum.filter((v): v is string => typeof v === "string");
    if (strings.length > 0) out.enum = strings;
  } else if (typeof node.const === "string") {
    out.enum = [node.const];
  }
  if (isSchemaObject(node.properties)) {
    const cleanProps: Record<string, unknown> = {};
    for (const [propName, propSchema] of Object.entries(node.properties)) {
      cleanProps[propName] = toAntigravityToolSchema(propSchema);
    }
    if (Array.isArray(node.required)) {
      const validReq = node.required.filter(
        (k): k is string => typeof k === "string" && Object.hasOwn(cleanProps, k),
      );
      if (validReq.length > 0) out.required = validReq;
    }
    out.properties = cleanProps;
    if (!("type" in out)) out.type = "object";
  }
  if ("items" in node && node.items !== undefined) {
    out.items = Array.isArray(node.items)
      ? node.items.length > 0
        ? toAntigravityToolSchema(node.items[0])
        : { type: "string" }
      : toAntigravityToolSchema(node.items);
    if (!("type" in out)) out.type = "array";
  }
  const union = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : undefined;
  if (union) {
    const branches: Record<string, unknown>[] = [];
    for (const branch of union) {
      if (isSchemaObject(branch) && branch.type === "null") {
        out.nullable = true;
        continue;
      }
      branches.push(toAntigravityToolSchema(branch));
    }
    if (branches.length === 1) {
      for (const [k, v] of Object.entries(branches[0]!)) {
        if (!(k in out)) out[k] = v;
      }
    } else if (branches.length > 0) {
      out.anyOf = branches;
    }
  }
  if (!("type" in out) && !("anyOf" in out)) {
    out.type = "string";
  }
  if (out.type === "array" && !("items" in out)) {
    out.items = { type: "string" };
  }
  return out;
}

/**
 * Sanitize a tool's JSON Schema for Anthropic's Messages API.
 *
 * Anthropic rejects schemas where the root is an `anyOf` / `oneOf` / `allOf` union,
 * requiring a root object schema (`{ type: "object", properties: ... }`).
 */
export function toAnthropicToolSchema(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return { type: "object", properties: {} };
  }
  const schema = { ...(node as Record<string, unknown>) };

  delete schema.$schema;
  delete schema.$id;

  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const mergedProperties: Record<string, unknown> = {};
    const mergedRequired = new Set<string>();
    for (const branch of union) {
      if (typeof branch === "object" && branch !== null) {
        const b = branch as Record<string, unknown>;
        if (b.properties && typeof b.properties === "object") {
          Object.assign(mergedProperties, b.properties);
        }
        if (Array.isArray(b.required)) {
          for (const req of b.required) {
            if (typeof req === "string") mergedRequired.add(req);
          }
        }
      }
    }
    delete schema.anyOf;
    delete schema.oneOf;
    schema.type = "object";
    schema.properties = mergedProperties;
    if (mergedRequired.size > 0 && !schema.required) {
      schema.required = Array.from(mergedRequired);
    }
  }

  if (!schema.type) {
    schema.type = "object";
  }

  return schema;
}
