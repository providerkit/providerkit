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
    ["JSON on the fence line", `${FENCE}json {"a": 1}\n${FENCE}`, { a: 1 }],
    [
      "JSON that starts on the fence line and goes on",
      `${FENCE}json {"a": 1,\n"b": 2}\n${FENCE}`,
      { a: 1, b: 2 },
    ],
    ["JSON against the fence, with no language", `${FENCE}{"a": 1}\n${FENCE}`, { a: 1 }],
    [
      "a title after the language",
      `${FENCE}json title="report.json"\n{"a": 1}\n${FENCE}`,
      { a: 1 },
    ],
    ["words after the language", `${FENCE}json here you go\n{"a": 1}\n${FENCE}`, { a: 1 }],
    [
      "an attribute block after the language",
      `${FENCE}json {.report}\n{"a": 1}\n${FENCE}`,
      { a: 1 },
    ],
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

  // Text after the language is either where the JSON starts or a label on the
  // block. When nothing parses, the error names the JSON's fault, not the label's.
  it("names the body's fault when a labelled block holds broken JSON", () => {
    const text = `${FENCE}json title="report.json"\n{"a": 1,}\n${FENCE}`;
    expect(causeOf(text)).toBe(parseErrorOf('{"a": 1,}\n'));
  });

  it("names the whole JSON's fault when it starts on the fence line", () => {
    const text = `${FENCE}json {"a": 1,\n"b": 2,}\n${FENCE}`;
    expect(causeOf(text)).toBe(parseErrorOf(' {"a": 1,\n"b": 2,}\n'));
  });

  // A blank fence line takes the one-reading path, so the error is exactly
  // JSON.parse's for the body, with no newline joined on the front.
  it("gives a blank fence line's block the body's own error", () => {
    const text = `${FENCE}json\nSorry, I can't help with that.\n${FENCE}`;
    expect(causeOf(text)).toBe(parseErrorOf("Sorry, I can't help with that.\n"));
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

/** The SyntaxError message inside the JsonAnswerError this answer throws. */
function causeOf(text: string): string {
  const error = thrownBy(() => parseJsonAnswer(text));
  expect(error).toMatchObject({ name: "JsonAnswerError", text });
  return ((error as JsonAnswerError).cause as SyntaxError).message;
}

/** What JSON.parse says about this exact string, in the engine running the test. */
function parseErrorOf(candidate: string): string {
  return (thrownBy(() => JSON.parse(candidate)) as SyntaxError).message;
}
