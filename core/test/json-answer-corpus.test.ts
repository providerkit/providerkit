import { describe, expect, it } from "vitest";
import { JsonAnswerError, parseJsonAnswer } from "../src/index.ts";

// 37 answer shapes a consumer collected on 2026-09-27, and what the current
// release reads out of each, or that it throws. The contract is every shape
// the last release read: 0.13.1 threw on three that 0.12.3 read
// (fenceLineProse, titleAttr, braceAttr), and this table fails on 0.13.1 for
// exactly those three. The rows are the consumer's, verbatim, names included,
// so its runs and these tests stay comparable. bracketProseBefore and
// braceProse record bracketed()'s first-opener ponytail as it stands; change
// them together with it.
const READS: [name: string, text: string, expected: unknown][] = [
  ["plain", '{"a":1}', { a: 1 }],
  ["fencedJson", '```json\n{"a":1}\n```', { a: 1 }],
  ["fencedBare", '```\n{"a":1}\n```', { a: 1 }],
  ["notesAfter", '```json\n{"a":1}\n```\n\nNote: done.', { a: 1 }],
  ["proseBefore", 'Here it is:\n```json\n{"a":1}\n```', { a: 1 }],
  ["jsonOnFenceLine", '```json {"a":1}\n```', { a: 1 }],
  ["jsonOnFenceLineNoSpace", '```{"a":1}\n```', { a: 1 }],
  ["closeSameLine", '```json\n{"a":1}```', { a: 1 }],
  ["oneLine", '```json{"a":1}```', { a: 1 }],
  ["oneLineSpaced", '```json {"a":1} ```', { a: 1 }],
  ["bracketProseBefore", 'See [1]: {"a":1}', [1]],
  ["objThenProse", '{"a":1}\nThat is all.', { a: 1 }],
  ["proseThenObj", 'Sure! {"a":1}', { a: 1 }],
  ["jsFence", '```js\n{"a":1}\n```', { a: 1 }],
  ["htmlThenJson", '```html\n<p>x</p>\n```\n```json\n{"a":1}\n```', { a: 1 }],
  ["crlf", '```json\r\n{"a":1}\r\n```', { a: 1 }],
  ["indented", '  ```json\n  {"a":1}\n  ```', { a: 1 }],
  ["array", '[{"a":1}]', [{ a: 1 }]],
  ["fenceInString", '```json\n{"code":"```x```"}\n```', { code: "```x```" }],
  ["pretty", '```json\n{\n  "a": 1,\n  "b": [1, 2]\n}\n```', { a: 1, b: [1, 2] }],
  ["twoJsonBlocks", '```json\n{"a":1}\n```\n```json\n{"b":2}\n```', { a: 1 }],
  ["inlineOpener", 'Sure: ```json\n{"a":1}\n```', { a: 1 }],
  ["blankLines", '```json\n\n{"a":1}\n\n```', { a: 1 }],
  ["trailingSpaceInfo", '```json   \n{"a":1}\n```', { a: 1 }],
  ["upperJson", '```JSON\n{"a":1}\n```', { a: 1 }],
  ["leadingWs", '\n\n  {"a":1}  \n', { a: 1 }],
  ["fenceLineMulti", '```json {\n  "a": 1\n}\n```', { a: 1 }],
  ["fenceLineMultiNotes", 'Result:\n```json {"a": 1,\n"b": 2}\n```\nDone.', { a: 1, b: 2 }],
  ["fenceLineArray", "```json [1,\n2]\n```", [1, 2]],
  ["fenceLineUnmarked", '``` {"a":1}\n```', { a: 1 }],
  ["fenceLineProse", '```json here you go\n{"a":1}\n```', { a: 1 }],
  ["titleAttr", '```json title="report.json"\n{"a":1}\n```', { a: 1 }],
  ["braceAttr", '```json {.report}\n{"a":1}\n```', { a: 1 }],
  ["trailingColon", '```json:\n{"a":1}\n```', { a: 1 }],
];

const THROWS: [name: string, text: string][] = [
  ["braceProse", 'Use {name}: {"a":1}'],
  ["truncated", '```json\n{"a":1'],
  ["empty", ""],
];

describe("parseJsonAnswer over the answer-shape corpus", () => {
  it.each(READS)("reads %s", (_name, text, expected) => {
    expect(parseJsonAnswer(text)).toEqual(expected);
  });

  it.each(THROWS)("throws on %s", (_name, text) => {
    expect(() => parseJsonAnswer(text)).toThrow(JsonAnswerError);
  });
});
