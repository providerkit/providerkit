// Tool calls a model wrote into its text. The first four cases are the source
// app's own tests for this filter, moved from its engine to the chunk stream;
// the next pin what a stream of chunks adds: a token split after its `<`, the
// finish, a failure, the other fields, citations and the report. The last pin
// what the source's filter got wrong: text after a snake_case name that is no
// attribute, and a closing tag whose opening tag stayed.
import { describe, expect, it } from "vitest";
import type { Source } from "../src/hosted/types.ts";
import { stripLeakedToolMarkup } from "../src/tool-markup.ts";
import { collectTurn } from "../src/turn.ts";
import type { ProviderChunk } from "../src/types.ts";

/** One turn: each string is a text delta, each object a chunk, then a stop. */
async function* turn(...parts: (string | ProviderChunk)[]): AsyncGenerator<ProviderChunk> {
  for (const part of parts)
    yield typeof part === "string" ? { type: "delta", content: part } : part;
  yield { type: "finish", finishReason: "stop" };
}

async function textOf(...parts: (string | ProviderChunk)[]): Promise<string> {
  return (await collectTurn(stripLeakedToolMarkup(turn(...parts)))).message.content;
}

async function chunksOf(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("stripLeakedToolMarkup", () => {
  it("strips DeepSeek's tool-call tokens that leak into the text", async () => {
    // DeepSeek sometimes writes its own call syntax as text instead of a
    // structured call. Nothing after its first token is prose.
    expect(
      await textOf(
        "Análise inicial. ",
        "<｜tool▁calls▁begin｜><｜tool▁call｜>web_search",
        '{"query":"x"}<｜tool▁call▁end｜>',
      ),
    ).toBe("Análise inicial. ");
  });

  it("strips a pseudo tag split across chunks, keeping the prose around it", async () => {
    expect(
      await textOf(
        "Posso ajudar.\n",
        '<suggest_dossie subjectType="company" ',
        'subjectId="22145039000130" label="X" reason="Y" />',
        "\nO que você gostaria de fazer?",
      ),
    ).toBe("Posso ajudar.\n\nO que você gostaria de fazer?");
  });

  it("keeps angle brackets that are not a pseudo tag", async () => {
    // A comparison, HTML split across chunks, and a snake_case name with no
    // attributes: real markup almost never has an underscore AND attributes.
    expect(await textOf("Se a < b, use <strong", ">valor</strong> em <user_id> aqui.")).toBe(
      "Se a < b, use <strong>valor</strong> em <user_id> aqui.",
    );
  });

  it("drops a pseudo tag the turn ended inside", async () => {
    expect(await textOf('Fim. <suggest_dossie subjectType="company"')).toBe("Fim. ");
  });

  it("catches a DeepSeek token split right after its `<`", async () => {
    expect(await textOf("Vou buscar. <", "｜tool▁call｜>web_search")).toBe("Vou buscar. ");
  });

  it("sends held text before the finish, as it was when it never became a tag", async () => {
    const chunks = await chunksOf(stripLeakedToolMarkup(turn("a <stro")));
    expect(chunks).toEqual([
      { type: "delta", content: "a " },
      { type: "delta", content: "<stro" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("hands over held text before the stream's own error", async () => {
    const lost = new Error("socket closed");
    async function* dying(): AsyncGenerator<ProviderChunk> {
      yield { type: "delta", content: "Olhe <b" };
      throw lost;
    }
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of stripLeakedToolMarkup(dying())) seen.push(chunk.content ?? "");
      })(),
    ).rejects.toBe(lost);
    expect(seen.join("")).toBe("Olhe <b");
  });

  it("changes only the text, and passes every chunk on in order", async () => {
    const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 };
    const call = { index: 0, id: "call_1", name: "search", arguments: '{"q":"cats"}' };
    const chunks = await chunksOf(
      stripLeakedToolMarkup(
        turn(
          { type: "delta", reasoning: "Thinking.", content: '<search_web q="cats"/>' },
          { type: "delta", toolCalls: [call] },
          { type: "usage", usage },
        ),
      ),
    );
    expect(chunks).toEqual([
      { type: "delta", reasoning: "Thinking.", content: "" },
      { type: "delta", toolCalls: [call] },
      { type: "usage", usage },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("keeps a citation span no removal can have moved, and drops one a removal may have", async () => {
    const source: Source = { type: "url", url: "https://cats.example/sleep" };
    const { message } = await collectTurn(
      stripLeakedToolMarkup(
        turn(
          "Cats sleep. ",
          { type: "delta", citations: [{ source, start: 0, end: 11, anchor: "claim" }] },
          '<suggest_source id="1"/>',
          "Dogs bark.",
          // Counted on the text as the model wrote it, tag included.
          { type: "delta", citations: [{ source, start: 36, end: 46, anchor: "claim" }] },
        ),
      ),
    );
    expect(message.content).toBe("Cats sleep. Dogs bark.");
    expect(message.citations).toEqual([{ source, start: 0, end: 11, anchor: "claim" }, { source }]);
    expect(message.content.slice(0, 11)).toBe("Cats sleep.");
  });

  it("reports each leak once, with the markup that set it off", async () => {
    const stripped: string[] = [];
    const strip = (...parts: string[]) =>
      collectTurn(
        stripLeakedToolMarkup(turn(...parts), { onStrip: (markup) => stripped.push(markup) }),
      );
    await strip("a <save_", 'brief title="x"/> b', ' <note_it c="1"');
    await strip("c <｜tool▁call｜>x", "more of the call");
    expect(stripped).toEqual(['<save_brief title="x"/>', '<note_it c="1"', "<｜tool▁call｜>x"]);
  });

  it.each([
    ["a shell redirect", "Run `sort <in_file >out_file` to sort."],
    ["a placeholder with a space in it", "Set the header to `Bearer <your_api_key here>`."],
    ["a type argument", "type Row = Promise<user_row | null>;"],
    ["a comparison the turn ends on", "Keep retries <max_retries and stop."],
  ])("keeps %s, where no attribute follows the name", async (_, text) => {
    // Each lost words when any space after a snake_case name counted as the
    // start of attributes. Also cut after that space, where the text waits.
    const cut = text.indexOf(" ", text.indexOf("<")) + 1;
    expect(await textOf(text)).toBe(text);
    expect(await textOf(text.slice(0, cut), text.slice(cut))).toBe(text);
  });

  it("lets prose go as soon as it can't become an attribute", async () => {
    // Held, this would stall the answer for up to 512 characters.
    const chunks = await chunksOf(stripLeakedToolMarkup(turn("Use <max_retries and stop", ".")));
    expect(chunks[0]).toEqual({ type: "delta", content: "Use <max_retries and stop" });
  });

  it("removes a closing tag only with its opening tag, and reports the pair once", async () => {
    const stripped: string[] = [];
    const textWith = async (...parts: string[]) =>
      (
        await collectTurn(
          stripLeakedToolMarkup(turn(...parts), { onStrip: (markup) => stripped.push(markup) }),
        )
      ).message.content;
    expect(await textWith('Ok. <save_note title="x">', "body</save_", "note> done")).toBe(
      "Ok. body done",
    );
    expect(await textWith('<save_note title="x">body</save_no')).toBe("body");
    // A call written as plain tags, the way GLM writes one, stays whole: with
    // only its closing tags gone, the reader still saw the call, unbalanced.
    const plain =
      "Ok.<tool_call>search\n<arg_key>q</arg_key>\n<arg_value>cats</arg_value>\n</tool_call>";
    expect(await textWith(plain)).toBe(plain);
    expect(stripped).toEqual(['<save_note title="x">', '<save_note title="x">']);
  });
});
