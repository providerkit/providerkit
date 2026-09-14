import { describe, expect, it } from "vitest";
import {
  clampToSchema,
  isStrictSchema,
  toAnthropicToolSchema,
  toGeminiToolSchema,
} from "../src/schema.ts";

describe("toGeminiToolSchema", () => {
  it("converts nullable union types to nullable: true", () => {
    const input = {
      type: "object",
      properties: {
        note: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
    };
    const sanitized = toGeminiToolSchema(input);
    const props = sanitized.properties as Record<string, Record<string, unknown>>;
    expect(props.note.type).toBe("string");
    expect(props.note.nullable).toBe(true);
  });

  it("converts type arrays with null to nullable: true", () => {
    const input = {
      type: "object",
      properties: {
        count: {
          type: ["integer", "null"],
        },
      },
    };
    const sanitized = toGeminiToolSchema(input);
    const props = sanitized.properties as Record<string, Record<string, unknown>>;
    expect(props.count.type).toBe("integer");
    expect(props.count.nullable).toBe(true);
  });

  it("converts const to enum", () => {
    const input = {
      type: "object",
      properties: {
        action: {
          const: "send_message",
        },
      },
    };
    const sanitized = toGeminiToolSchema(input);
    const props = sanitized.properties as Record<string, Record<string, unknown>>;
    expect(props.action.enum).toEqual(["send_message"]);
    expect(props.action.const).toBeUndefined();
  });

  it("converts numeric enums to string enums", () => {
    const input = {
      type: "object",
      properties: {
        level: {
          type: "number",
          enum: [1, 2, 3],
        },
      },
    };
    const sanitized = toGeminiToolSchema(input);
    const props = sanitized.properties as Record<string, Record<string, unknown>>;
    expect(props.level.enum).toEqual(["1", "2", "3"]);
  });

  it("ensures array schemas have items", () => {
    const input = {
      type: "object",
      properties: {
        tags: {
          type: "array",
        },
      },
    };
    const sanitized = toGeminiToolSchema(input);
    const props = sanitized.properties as Record<string, Record<string, unknown>>;
    expect(props.tags.items).toEqual({ type: "string" });
  });

  it("strips unsupported keywords ($schema, additionalProperties: true)", () => {
    const input = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: true,
      properties: {
        name: { type: "string" },
      },
    };
    const sanitized = toGeminiToolSchema(input);
    expect(sanitized.$schema).toBeUndefined();
    expect(sanitized.additionalProperties).toBeUndefined();
    expect(sanitized.properties).toBeDefined();
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
