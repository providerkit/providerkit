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
 * worth having — but it demands more than JSON Schema does: every property an
 * object lists must ALSO be required, and every object must close itself with
 * `additionalProperties: false`, all the way down. A schema with one optional
 * field is not "mostly strict"; it is a flat 400 naming a nested path rather
 * than the rule it broke.
 *
 * That trap is the reason this exists. An agent's response schema grows
 * optional fields naturally — a `data` block only some flows fill, the fields
 * one step collects — and a caller who adds one wants their answer, not a
 * lecture about a mode they never asked for. So the OpenAI-shape adapters ask
 * this and drop to plain (unenforced) schema mode instead of failing the turn.
 *
 * Anything it cannot verify — a `$ref`, a composed `allOf` — answers false:
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
 * plain JSON mode on every gateway — `json_object` asks for valid JSON and says
 * nothing whatsoever about its shape.
 */
export function schemaPrompt(schema: unknown): string {
  return (
    "Respond with a single JSON object matching this schema. No prose, no code fence:\n" +
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
