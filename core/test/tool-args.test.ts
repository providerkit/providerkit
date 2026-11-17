import { describe, expect, it } from "vitest";
import {
  findLastValidJsonObject,
  isCompleteJson,
  normalizeToolId,
  parseToolArgs,
} from "../src/tool-args.ts";

describe("parseToolArgs — the intact case", () => {
  it("parses ordinary arguments", () => {
    expect(parseToolArgs('{"query":"hello","limit":5}')).toEqual({ query: "hello", limit: 5 });
  });

  it.each(["__proto__", "\\u005f_proto__"])(
    "keeps %s as an own data property in complete JSON",
    (key) => {
      const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
      const parsed = parseToolArgs(
        `{"${key}":{"inherited":true},"constructor":"ctor","toString":"label","text":"ok"}`,
      );
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")).toEqual({
        value: { inherited: true },
        writable: true,
        enumerable: true,
        configurable: true,
      });
      expect(parsed.inherited).toBeUndefined();
      expect(Object.hasOwn(parsed, "constructor")).toBe(true);
      expect(Object.hasOwn(parsed, "toString")).toBe(true);
      expect(JSON.stringify(parsed)).toBe(
        '{"__proto__":{"inherited":true},"constructor":"ctor","toString":"label","text":"ok"}',
      );
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
    },
  );

  it("keeps special keys in nested objects and arrays", () => {
    const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
    const parsed = parseToolArgs(
      '{"nested":{"__proto__":null},"items":[{"__proto__":["caf\\\\u00e9"]}]}',
    );
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(parsed.nested)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(parsed.nested, "__proto__")).toEqual({
      value: null,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Array.isArray(parsed.items)).toBe(true);
    if (!Array.isArray(parsed.items)) throw new Error("Expected items to be an array");
    expect(Object.getPrototypeOf(parsed.items[0])).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(parsed.items[0], "__proto__")).toEqual({
      value: ["café"],
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(JSON.stringify(parsed)).toBe(
      '{"nested":{"__proto__":null},"items":[{"__proto__":["café"]}]}',
    );
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
  });

  it("returns {} for empty or whitespace input", () => {
    expect(parseToolArgs("")).toEqual({});
    expect(parseToolArgs("   ")).toEqual({});
  });

  it("rejects a non-object payload as the protocol violation it is", () => {
    expect(parseToolArgs('"just a string"')).toEqual({});
    expect(parseToolArgs("[1,2,3]")).toEqual({});
    expect(parseToolArgs("42")).toEqual({});
  });

  it("never throws, whatever the model emitted", () => {
    for (const raw of ["{", "}{", "not json at all", '{"a":'])
      expect(() => parseToolArgs(raw)).not.toThrow();
  });
});

describe("parseToolArgs — double-escaped text", () => {
  it("heals text a model escaped twice", () => {
    // `\\u00e7` survives JSON.parse as six literal characters and reaches the
    // user as `atenção` instead of `atenção`.
    const parsed = parseToolArgs(JSON.stringify({ text: "aten\\u00e7\\u00e3o" }));
    expect(parsed.text).toBe("atenção");
  });

  it("heals nested strings, in objects and arrays alike", () => {
    const raw = JSON.stringify({
      items: ["caf\\u00e9", { note: "\\u00e1gua" }],
      deep: { deeper: { s: "\\u00f1" } },
    });
    expect(parseToolArgs(raw)).toEqual({
      items: ["café", { note: "água" }],
      deep: { deeper: { s: "ñ" } },
    });
  });

  it("leaves ordinary escapes alone — code talk mentions \\n constantly", () => {
    const parsed = parseToolArgs(JSON.stringify({ code: "line\\nbreak" }));
    expect(parsed.code).toBe("line\\nbreak");
  });

  it("leaves non-string values untouched", () => {
    expect(parseToolArgs('{"n":1,"b":true,"nil":null}')).toEqual({ n: 1, b: true, nil: null });
  });
});

describe("parseToolArgs — truncation salvage", () => {
  it("keeps the fields that closed before the cut", () => {
    const raw = '{"title":"Quarterly report","author":"Ana","summary":"It began';
    expect(parseToolArgs(raw)).toMatchObject({ title: "Quarterly report", author: "Ana" });
  });

  it("keeps the half-written field the cut landed in — better than nothing", () => {
    const raw = '{"title":"Report","summary":"The quarter went well and the team';
    expect(parseToolArgs(raw).summary).toBe("The quarter went well and the team");
  });

  it("drops a fragment cut inside a unicode escape rather than emitting garbage", () => {
    const raw = '{"summary":"aten\\u00';
    expect(parseToolArgs(raw).summary ?? "").not.toContain("\\u00");
  });

  it("drops non-string values instead of salvaging half of one", () => {
    const raw = '{"name":"ok","count":12';
    const parsed = parseToolArgs(raw);
    expect(parsed.name).toBe("ok");
    expect(parsed.count).toBeUndefined();
  });

  it("unescapes quotes inside a salvaged value", () => {
    const raw = '{"quote":"she said \\"yes\\" and left';
    expect(parseToolArgs(raw).quote).toBe('she said "yes" and left');
  });

  it.each([
    ["__proto__", '","count":'],
    ["\\u005f_proto__", '","count":'],
    ["__proto__", "\\u00"],
    ["\\u005f_proto__", "\\u00"],
  ])("keeps salvaged %s fields before %s", (key, tail) => {
    const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
    const parsed = parseToolArgs(
      `{"constructor":"ctor","toString":"label","${key}":"caf\\\\u00e9${tail}`,
    );
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")).toEqual({
      value: "café",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.hasOwn(parsed, "constructor")).toBe(true);
    expect(Object.hasOwn(parsed, "toString")).toBe(true);
    expect(JSON.stringify(parsed)).toBe(
      '{"constructor":"ctor","toString":"label","__proto__":"café"}',
    );
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
  });

  it("returns {} when there is nothing recoverable", () => {
    expect(parseToolArgs("{{{{")).toEqual({});
  });
});

describe("isCompleteJson", () => {
  it("separates an intact tool call from a truncated one", () => {
    expect(isCompleteJson('{"a":1}')).toBe(true);
    expect(isCompleteJson('{"a":')).toBe(false);
    expect(isCompleteJson("")).toBe(false);
  });
});

describe("findLastValidJsonObject — concatenated JSON", () => {
  it("recovers the valid payload when prepended with empty object or garbage", () => {
    const raw = '{}{"query":"hello world","limit":10}';
    expect(findLastValidJsonObject(raw)).toEqual({ query: "hello world", limit: 10 });
    expect(parseToolArgs(raw)).toEqual({ query: "hello world", limit: 10 });
  });

  it("recovers from multiple concatenated objects", () => {
    const raw = '{"skip":1}{"keep":"yes"}';
    expect(findLastValidJsonObject(raw)).toEqual({ keep: "yes" });
    expect(parseToolArgs(raw)).toEqual({ keep: "yes" });
  });
});

describe("normalizeToolId", () => {
  it("synthesizes a non-empty fallback id when given empty or whitespace id", () => {
    const id1 = normalizeToolId("");
    expect(id1).toMatch(/^call_pk_[a-z0-9]+/);

    const id2 = normalizeToolId("   ");
    expect(id2).toMatch(/^call_pk_[a-z0-9]+/);

    const id3 = normalizeToolId(undefined);
    expect(id3).toMatch(/^call_pk_[a-z0-9]+/);
  });

  it("preserves valid tool ids under 64 chars", () => {
    expect(normalizeToolId("call_123456789")).toBe("call_123456789");
    expect(normalizeToolId("toolu_01Abc")).toBe("toolu_01Abc");
  });

  it("clamps and hashes tool ids exceeding 64 chars for ChatGPT Responses compatibility", () => {
    const longId = "call_" + "a".repeat(70);
    const normalized = normalizeToolId(longId);
    expect(normalized.length).toBeLessThanOrEqual(64);
    expect(normalized).toContain("_");
  });
});
