import { describe, expect, it } from "vitest";
import {
  clampToSchema,
  isStrictSchema,
  toAnthropicToolSchema,
  toGeminiToolSchema,
  withoutPatterns,
} from "../src/schema.ts";

// Each case below is a shape sent to gemini-3.8-flash on 2026-10-21, in a tool and as a
// response schema. The 400 it got, or its acceptance, is why the test expects what it does.
describe("toGeminiToolSchema", () => {
  it("sends what Gemini accepts exactly as written", () => {
    const accepted = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: true,
      properties: {
        level: { type: "integer", enum: [1, 2, 3] },
        action: { const: "send_message" },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        count: { type: ["integer", "null"] },
        tags: { type: "array", description: "any kind of item" },
        pick: { $ref: "#/$defs/Pick" },
        either: { oneOf: [{ type: "string" }, { type: "integer" }] },
        word: { type: "string", pattern: "^[a-z]+$", format: "uri" },
      },
      required: ["level"],
      $defs: { Pick: { type: "string" } },
    };
    expect(toGeminiToolSchema(accepted)).toEqual(accepted);
  });

  it("does not touch the input", () => {
    const input = { type: "object", properties: { a: { type: "array", items: [{}] } } };
    const before = structuredClone(input);
    toGeminiToolSchema(input);
    expect(input).toEqual(before);
  });

  it("drops required names that have no property, at any depth", () => {
    expect(
      toGeminiToolSchema({
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: { b: { type: "string" } },
            required: ["b", "ghost"],
          },
          list: {
            type: "array",
            items: { type: "object", required: ["ghost"] },
          },
        },
        required: ["inner", "ghost"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        inner: { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
        list: { type: "array", items: { type: "object", required: [] } },
      },
      required: ["inner"],
    });
  });

  it("turns Draft-04 exclusive bounds into the numeric form", () => {
    const { properties } = toGeminiToolSchema({
      type: "object",
      properties: {
        over: { type: "number", minimum: 0, exclusiveMinimum: true },
        under: { type: "number", maximum: 9, exclusiveMaximum: true },
        inclusive: { type: "number", minimum: 1, exclusiveMinimum: false },
        already: { type: "number", exclusiveMinimum: 0 },
      },
    });
    expect(properties).toEqual({
      over: { type: "number", exclusiveMinimum: 0 },
      under: { type: "number", exclusiveMaximum: 9 },
      inclusive: { type: "number", minimum: 1 },
      already: { type: "number", exclusiveMinimum: 0 },
    });
  });

  it("turns a tuple into prefixItems, and additionalItems into items", () => {
    const { properties } = toGeminiToolSchema({
      type: "object",
      properties: {
        open: { type: "array", items: [{ type: "string" }, { type: "number" }] },
        closed: { type: "array", items: [{ type: "string" }], additionalItems: false },
        rest: { type: "array", items: [{ type: "string" }], additionalItems: { type: "number" } },
      },
    });
    expect(properties).toEqual({
      open: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
      closed: { type: "array", prefixItems: [{ type: "string" }], items: false },
      rest: { type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } },
    });
  });

  it("cuts a recursive $ref only where Gemini refuses the loop", () => {
    const node = (extra: Record<string, unknown>) => ({
      type: "object",
      properties: { n: { $ref: "#/$defs/Node" } },
      $defs: { Node: { type: "object", ...extra } },
    });
    const self = { $ref: "#/$defs/Node" };
    const defOf = (schema: Record<string, unknown>) =>
      (schema.$defs as Record<string, unknown>).Node;

    // 400 "ref loops are only supported if they include optional ..." on all three:
    expect(
      defOf(toGeminiToolSchema(node({ properties: { next: self }, required: ["next"] }))),
    ).toEqual({ type: "object", properties: { next: {} }, required: ["next"] });
    expect(
      defOf(
        toGeminiToolSchema(
          node({
            properties: { kids: { type: "array", minItems: 1, items: self } },
            required: ["kids"],
          }),
        ),
      ),
    ).toEqual({
      type: "object",
      properties: { kids: { type: "array", minItems: 1, items: {} } },
      required: ["kids"],
    });
    expect(
      toGeminiToolSchema({
        type: "object",
        properties: { child: { $ref: "#" } },
        required: ["child"],
      }).properties,
    ).toEqual({ child: {} });

    // Accepted: through an optional property, and through an array that may be empty.
    const optional = node({ properties: { next: self } });
    expect(toGeminiToolSchema(optional)).toEqual(optional);
    const list = node({
      properties: { kids: { type: "array", items: self } },
      required: ["kids"],
    });
    expect(toGeminiToolSchema(list)).toEqual(list);
  });

  it("leaves data alone: defaults, consts, and properties named like keywords", () => {
    const input = {
      type: "object",
      properties: {
        required: { type: "array", items: { type: "string" } },
        exclusiveMinimum: true,
        items: { type: "string", default: { items: [1, 2], required: ["ghost"] } },
        mode: { const: { exclusiveMaximum: true, minimum: 3 } },
      },
      required: ["required", "items"],
    };
    expect(toGeminiToolSchema(input)).toEqual(input);
  });

  it("gives a non-object an empty object schema", () => {
    expect(toGeminiToolSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(toGeminiToolSchema([])).toEqual({ type: "object", properties: {} });
  });
});

describe("toAnthropicToolSchema", () => {
  it("merges root anyOf / oneOf branches into a unified object schema", () => {
    const input = {
      anyOf: [
        {
          type: "object",
          properties: { mode: { type: "string" } },
          required: ["mode"],
        },
        {
          type: "object",
          properties: { timeout: { type: "number" } },
        },
      ],
    };
    const sanitized = toAnthropicToolSchema(input);
    expect(sanitized.type).toBe("object");
    expect(sanitized.anyOf).toBeUndefined();
    const props = sanitized.properties as Record<string, unknown>;
    expect(props.mode).toBeDefined();
    expect(props.timeout).toBeDefined();
    expect(sanitized.required).toEqual(["mode"]);
  });

  it("ensures root object type is present", () => {
    const input = { properties: { foo: { type: "string" } } };
    const sanitized = toAnthropicToolSchema(input);
    expect(sanitized.type).toBe("object");
  });
});

describe("clampToSchema", () => {
  it("clamps string to maxLength with ellipsis", () => {
    const schema = { type: "string", maxLength: 5 };
    expect(clampToSchema("hello world", schema)).toBe("hell…");
    expect(clampToSchema("hi", schema)).toBe("hi");
  });

  it("clamps number to maximum and minimum", () => {
    const schema = { type: "number", minimum: 0, maximum: 100 };
    expect(clampToSchema(150, schema)).toBe(100);
    expect(clampToSchema(-10, schema)).toBe(0);
    expect(clampToSchema(50, schema)).toBe(50);
  });
});

describe("isStrictSchema", () => {
  it("returns true for strict objects with required properties and additionalProperties: false", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    };
    expect(isStrictSchema(schema)).toBe(true);
  });

  it("returns false if optional properties exist", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
      additionalProperties: false,
    };
    expect(isStrictSchema(schema)).toBe(false);
  });
});

describe("withoutPatterns", () => {
  it("strips every regex constraint, wherever a schema can nest one", () => {
    const pattern = "^[a-z]+$";
    expect(
      withoutPatterns({
        type: "object",
        pattern,
        properties: { slug: { type: "string", pattern } },
        patternProperties: { "^x-": { type: "string", pattern } },
        anyOf: [{ type: "string", pattern }],
        items: [{ type: "string", pattern }],
        $defs: { id: { type: "string", pattern } },
      }),
    ).toEqual({
      type: "object",
      properties: { slug: { type: "string" } },
      patternProperties: { "^x-": { type: "string" } },
      anyOf: [{ type: "string" }],
      items: [{ type: "string" }],
      $defs: { id: { type: "string" } },
    });
  });

  it("leaves data alone — a default or enum may hold a key named pattern", () => {
    const schema = {
      type: "object",
      default: { pattern: "keep" },
      enum: [{ pattern: "keep" }],
      properties: { pattern: { type: "string" } },
    };
    expect(withoutPatterns(schema)).toEqual(schema);
  });
});
