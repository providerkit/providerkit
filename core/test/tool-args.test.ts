import { describe, expect, it } from "vitest";
import { isCompleteJson, parseToolArgs } from "../src/tool-args.ts";

describe("parseToolArgs — the intact case", () => {
  it("parses ordinary arguments", () => {
    expect(parseToolArgs('{"query":"hello","limit":5}')).toEqual({ query: "hello", limit: 5 });
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
