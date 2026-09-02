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
