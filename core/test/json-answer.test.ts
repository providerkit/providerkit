import { describe, expect, it } from "vitest";
import { JsonAnswerError, parseJsonAnswer } from "../src/index.ts";

const FENCE = "```";

describe("parseJsonAnswer", () => {
  it.each([
    ["a bare object", '{"a": 1, "b": [true, null]}', { a: 1, b: [true, null] }],
    ["a json fence", `${FENCE}json\n{"a": 1}\n${FENCE}`, { a: 1 }],
    ["a JSON fence, in capitals", `${FENCE}JSON\n{"a": 1}\n${FENCE}`, { a: 1 }],
    ["an unmarked fence", `${FENCE}\n{"a": 1}\n${FENCE}`, { a: 1 }],
    [
      "a fence followed by notes",
      `${FENCE}json\n{"a": 1}\n${FENCE}\n\nNote: I left {b} out, it was optional.`,
      { a: 1 },
    ],
    [
      "leading prose followed by a fence",
      `Here it is, with {braces} in the prose:\n\n${FENCE}json\n{"a": 1}\n${FENCE}`,
      { a: 1 },
    ],
    ["an array", '[{"id": 1}, {"id": 2}]\n\nThat is all of them.', [{ id: 1 }, { id: 2 }]],
    ["an object after prose, with none", 'The answer: {"a": 1}. Hope that helps.', { a: 1 }],
    ["a brace inside a string", '{"a": "}"} and then prose', { a: "}" }],
    [
      "a json fence after a fence in another language",
      `${FENCE}ts\nconst x = {};\n${FENCE}\n${FENCE}json\n{"a": 1}\n${FENCE}`,
      { a: 1 },
    ],
    ["CRLF line ends", `${FENCE}json\r\n{"a": 1}\r\n${FENCE}\r\n`, { a: 1 }],
    ["a bare number", " 42 ", 42],
  ])("reads %s", (_name, text, expected) => {
    expect(parseJsonAnswer(text)).toEqual(expected);
  });

  // A JSON string can't hold a raw newline, so no line of JSON starts with a
  // fence. A fence therefore only counts at the start of a line, and a value
  // that carries one (a code sample, a markdown answer) comes back whole.
  it("keeps a fence inside a JSON value, bare or fenced", () => {
    const value = { snippet: `${FENCE}ts\nconst a = 1;\n${FENCE}` };
    const json = JSON.stringify(value, null, 2);

    expect(parseJsonAnswer(json)).toEqual(value);
    expect(parseJsonAnswer(`${FENCE}json\n${json}\n${FENCE}`)).toEqual(value);
    expect(parseJsonAnswer(`Here:\n${FENCE}\n${JSON.stringify(value)}\n${FENCE}`)).toEqual(value);
  });

  it("throws a JsonAnswerError carrying the answer, not a bare SyntaxError", () => {
    const text = "Sorry, I can't help with that.";
    const error = thrownBy(() => parseJsonAnswer(text));

    expect(error).toBeInstanceOf(JsonAnswerError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error).toMatchObject({ name: "JsonAnswerError", text });
    expect((error as JsonAnswerError).cause).toBeInstanceOf(SyntaxError);
  });

  it("throws on an object cut off before it closes", () => {
    const text = `${FENCE}json\n{"items": [1, 2`;
    expect(thrownBy(() => parseJsonAnswer(text))).toMatchObject({ text });
  });

  it("keeps the first 2,000 characters of a long answer", () => {
    const text = `{"a": "${"x".repeat(5_000)}`;
    const error = thrownBy(() => parseJsonAnswer(text));

    expect(error).toBeInstanceOf(JsonAnswerError);
    expect((error as JsonAnswerError).text).toBe(text.slice(0, 2_000));
  });
});

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw, and nothing was thrown");
}
