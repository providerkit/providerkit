// Ported from the chat parser's tests, with the
// cases this version adds: headings and code as blocks, images, citations, the app's link schemes,
// soft line breaks, and the streaming parse that reads only the last block again.
import { describe, expect, it } from "vitest";
import {
  continueMarkdown,
  parseMarkdown,
  toPlainText,
  type MarkdownBlock,
  type MarkdownOptions,
  type MarkdownSpan,
} from "../src/markdown.ts";

const paragraph = (...spans: MarkdownSpan[]): MarkdownBlock => ({ kind: "paragraph", spans });
const web: MarkdownOptions = { linkSchemes: ["https"] };
const spansOf = (markdown: string, options: MarkdownOptions = web): MarkdownSpan[] => {
  const [block] = parseMarkdown(markdown, options);
  return block?.kind === "paragraph" || block?.kind === "heading" ? block.spans : [];
};
const keep: MarkdownOptions = { lineBreaks: "keep" };

describe("parseMarkdown blocks", () => {
  it("splits paragraphs at blank lines and joins a single line break with a space", () => {
    expect(parseMarkdown("Hi!\nAll good.\n\n\nSecond.")).toEqual([
      paragraph({ text: "Hi! All good." }),
      paragraph({ text: "Second." }),
    ]);
  });

  it("keeps a single line break when the app asks for it", () => {
    expect(parseMarkdown("Hi!\nAll good.\n\n\nSecond.", keep)).toEqual([
      paragraph({ text: "Hi!\nAll good." }),
      paragraph({ text: "Second." }),
    ]);
  });

  it("keeps a hard break, two spaces or a backslash, even when it joins lines", () => {
    expect(parseMarkdown("Read the guide  \nfor commands.\\\nThen build\nit.")).toEqual([
      paragraph({ text: "Read the guide\nfor commands.\nThen build it." }),
    ]);
  });

  it("reads -, * and numbered lists, keeping the first number", () => {
    expect(parseMarkdown("Three ideas:\n- one\n* two\n\n3. three\n4. four")).toEqual([
      paragraph({ text: "Three ideas:" }),
      { kind: "list", ordered: false, items: [[{ text: "one" }], [{ text: "two" }]] },
      {
        kind: "list",
        ordered: true,
        start: 3,
        items: [[{ text: "three" }], [{ text: "four" }]],
      },
    ]);
  });

  it("keeps a list whole across blank lines, and a line under an item in that item", () => {
    expect(parseMarkdown("1. a\n\n2. b\ngoes on\n\nAfter.", keep)).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [[{ text: "a" }], [{ text: "b\ngoes on" }]],
      },
      paragraph({ text: "After." }),
    ]);
    expect(parseMarkdown("1. a\n2. b\ngoes on")).toEqual([
      { kind: "list", ordered: true, start: 1, items: [[{ text: "a" }], [{ text: "b goes on" }]] },
    ]);
  });

  it("reads a sentence that starts with a year as a sentence", () => {
    expect(parseMarkdown("The year was good.\n2024. It was better.", keep)).toEqual([
      paragraph({ text: "The year was good.\n2024. It was better." }),
    ]);
  });

  it("reads a heading with its level and leaves a hashtag alone", () => {
    expect(parseMarkdown("## Summary of the **week**\n#launch #tip")).toEqual([
      {
        kind: "heading",
        level: 2,
        spans: [{ text: "Summary of the " }, { text: "week", bold: true }],
      },
      paragraph({ text: "#launch #tip" }),
    ]);
  });

  it("keeps a fenced block as its words and drops a rule", () => {
    expect(parseMarkdown("```ts\n**not** bold\n  indented\n```\n---\nEnd")).toEqual([
      { kind: "code", text: "**not** bold\n  indented" },
      paragraph({ text: "End" }),
    ]);
  });

  it("closes a fenced block only with the opening fence character", () => {
    expect(parseMarkdown("```\n```~~~\nstill code\n```")).toEqual([
      { kind: "code", text: "```~~~\nstill code" },
    ]);
    expect(parseMarkdown("~~~\n~~~```\nstill code\n~~~")).toEqual([
      { kind: "code", text: "~~~```\nstill code" },
    ]);
  });

  it("reads Windows line endings like any other", () => {
    expect(parseMarkdown("a\r\nb\r\n\r\n- c\r\n- d", keep)).toEqual([
      paragraph({ text: "a\nb" }),
      { kind: "list", ordered: false, items: [[{ text: "c" }], [{ text: "d" }]] },
    ]);
  });
});

describe("parseMarkdown spans", () => {
  it("reads bold and italic, with either mark", () => {
    expect(spansOf("**strong** and *light* and _light_ and __strong__")).toEqual([
      { text: "strong", bold: true },
      { text: " and " },
      { text: "light", italic: true },
      { text: " and " },
      { text: "light", italic: true },
      { text: " and " },
      { text: "strong", bold: true },
    ]);
  });

  it("nests italic inside bold", () => {
    expect(spansOf("**a *b* c**")).toEqual([
      { text: "a ", bold: true },
      { text: "b", bold: true, italic: true },
      { text: " c", bold: true },
    ]);
  });

  it("leaves an unclosed ** and marks beside spaces as they are", () => {
    expect(spansOf("**Careful: this")).toEqual([{ text: "**Careful: this" }]);
    expect(spansOf("2 * 3 * 4 and snake_case_name")).toEqual([
      { text: "2 * 3 * 4 and snake_case_name" },
    ]);
  });

  it("reads bold inside a list item", () => {
    expect(parseMarkdown("- **Format:** carousel")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ text: "Format:", bold: true }, { text: " carousel" }]],
      },
    ]);
  });

  it("reads an https link, with parentheses inside its address", () => {
    expect(spansOf("Source: [ContentDrips, 07/2026](https://contentdrips.com/blog?a=1).")).toEqual([
      { text: "Source: " },
      { text: "ContentDrips, 07/2026", href: "https://contentdrips.com/blog?a=1" },
      { text: "." },
    ]);
    expect(spansOf("[Bread](https://en.wikipedia.org/wiki/Bread_(food))")).toEqual([
      { text: "Bread", href: "https://en.wikipedia.org/wiki/Bread_(food)" },
    ]);
  });

  it("links only the schemes the app allows, none without a list", () => {
    expect(parseMarkdown("[site](https://example.com)")).toEqual([
      paragraph({ text: "[site](https://example.com)" }),
    ]);
    const written = "[click](javascript:alert(1)) and [site](http://example.com)";
    expect(spansOf(written)).toEqual([{ text: written }]);
    expect(spansOf("see http://example.com")).toEqual([{ text: "see http://example.com" }]);
    expect(spansOf("[mail us](mailto:team@example.com)")).toEqual([
      { text: "[mail us](mailto:team@example.com)" },
    ]);
    const wide = { linkSchemes: ["https", "http", "mailto"] };
    expect(
      spansOf("[site](http://example.com) or [mail us](mailto:team@example.com)", wide),
    ).toEqual([
      { text: "site", href: "http://example.com" },
      { text: " or " },
      { text: "mail us", href: "mailto:team@example.com" },
    ]);
    expect(spansOf("see http://example.com", wide)).toEqual([
      { text: "see " },
      { text: "http://example.com", href: "http://example.com" },
    ]);
  });

  it("never links a scheme that runs code, even when the app lists it", () => {
    const unsafe = { linkSchemes: ["javascript", "data", "vbscript", "https"] };
    expect(spansOf("[a](javascript:alert(1)) [b](data:text/html,x)", unsafe)).toEqual([
      { text: "[a](javascript:alert(1)) [b](data:text/html,x)" },
    ]);
  });

  it("links a bare https address without the sentence's punctuation", () => {
    expect(spansOf("See https://example.com/a. And (https://example.com/b)")).toEqual([
      { text: "See " },
      { text: "https://example.com/a", href: "https://example.com/a" },
      { text: ". And (" },
      { text: "https://example.com/b", href: "https://example.com/b" },
      { text: ")" },
    ]);
  });

  it("marks inline code and keeps escaped marks as plain words", () => {
    expect(spansOf("Use `**this**` and \\*that\\*")).toEqual([
      { text: "Use " },
      { text: "**this**", code: true },
      { text: " and *that*" },
    ]);
  });

  it("reads a run of more than three marks as plain text", () => {
    expect(spansOf(`x${"*".repeat(10)}x and **a****`)).toEqual([
      { text: `x${"*".repeat(10)}x and **a****` },
    ]);
  });

  it("still reads the deepest nesting the marks allow", () => {
    expect(spansOf("[**__*_x_*__**](https://a.com)")).toEqual([
      { text: "x", href: "https://a.com", bold: true, italic: true },
    ]);
  });

  it("keeps an address's own parentheses and never links half of a bad address", () => {
    expect(spansOf("(see https://en.wikipedia.org/wiki/Bread_(food)))")).toEqual([
      { text: "(see " },
      {
        text: "https://en.wikipedia.org/wiki/Bread_(food)",
        href: "https://en.wikipedia.org/wiki/Bread_(food)",
      },
      { text: "))" },
    ]);
    expect(spansOf("see https://user@https://b.com")).toEqual([
      { text: "see https://user@https://b.com" },
    ]);
  });

  it("links an address of up to 1,000 characters inside a link", () => {
    const path = "x".repeat(900);
    expect(spansOf(`[a](https://a.com/${path})`)).toEqual([
      { text: "a", href: `https://a.com/${path}` },
    ]);
    expect(spansOf(`[a](https://a.com/${path}${path})`)[0]).toEqual({ text: "[a](" });
  });

  it("closes an emphasis only within 512 characters", () => {
    const words = "a".repeat(500);
    expect(spansOf(`*${words}*`)).toEqual([{ text: words, italic: true }]);
    expect(spansOf(`*${words}${words}*`)).toEqual([{ text: `*${words}${words}*` }]);
  });

  it("reads a heading's closing marks and lines with a U+2028 inside", () => {
    expect(parseMarkdown("## Title   ##\n# a\u2028b\n- c\u2028d")).toEqual([
      { kind: "heading", level: 2, spans: [{ text: "Title" }] },
      { kind: "heading", level: 1, spans: [{ text: "a\u2028b" }] },
      { kind: "list", ordered: false, items: [[{ text: "c\u2028d" }]] },
    ]);
  });

  it("keeps a handle and an address's underscores as they are", () => {
    expect(spansOf("See @_carol_, @__joao__ and @bia_ at instagram.com/_carol_")).toEqual([
      { text: "See @_carol_, @__joao__ and @bia_ at instagram.com/_carol_" },
    ]);
    expect(spansOf("_see @bia_ today_")).toEqual([{ text: "see @bia_ today", italic: true }]);
    expect(spansOf("https://instagram.com/bia_")).toEqual([
      { text: "https://instagram.com/bia_", href: "https://instagram.com/bia_" },
    ]);
  });

  it("shows where a link goes when its words name another address", () => {
    const evil = { text: "https://evil.example", href: "https://evil.example" };
    expect(spansOf("[https://bank.example/login](https://evil.example)")).toEqual([evil]);
    expect(spansOf("[bank.example](https://evil.example)")).toEqual([evil]);
    expect(spansOf("[https://bank.example@evil.example](https://evil.example)")).toEqual([evil]);
  });

  it("keeps a label that names the site its link belongs to, a subdomain or in bold", () => {
    const g1 = "https://g1.globo.com/economia/noticia/2026/11/18/inflacao.ghtml";
    expect(spansOf(`[globo.com](${g1})`)).toEqual([{ text: "globo.com", href: g1 }]);
    expect(spansOf("[**g1.globo.com**](https://g1.globo.com/x)")).toEqual([
      { text: "g1.globo.com", href: "https://g1.globo.com/x", bold: true },
    ]);
    // A longer name that only starts like the site is still another owner.
    expect(spansOf("[bank.com.br](https://bank.com.br.evil.example)")).toEqual([
      { text: "https://bank.com.br.evil.example", href: "https://bank.com.br.evil.example" },
    ]);
    expect(spansOf("[www.g1.globo.com](https://g1.globo.com/a)")).toEqual([
      { text: "www.g1.globo.com", href: "https://g1.globo.com/a" },
    ]);
    expect(spansOf("[@forno.da.vila](https://instagram.com/forno.da.vila)")).toEqual([
      { text: "@forno.da.vila", href: "https://instagram.com/forno.da.vila" },
    ]);
  });
});

describe("images", () => {
  it("keeps an image as its alt text and its web address, never as a link", () => {
    expect(spansOf("Look: ![A red bike](https://cdn.example/bike.png) here")).toEqual([
      { text: "Look: " },
      { text: "A red bike", image: "https://cdn.example/bike.png" },
      { text: " here" },
    ]);
  });

  it("leaves an image with an address off the web as the characters it was", () => {
    for (const written of [
      "![x](javascript:alert(1))",
      "![x](data:image/svg+xml,<svg/>)",
      "![x](file:///etc/passwd)",
      "![x](/relative.png)",
    ])
      expect(spansOf(written)).toEqual([{ text: written }]);
  });

  it("keeps a linked image whole: its alt text, its address and its link", () => {
    expect(spansOf("[![Build passing](https://ci.example/badge.svg)](https://ci.example)")).toEqual(
      [
        {
          text: "Build passing",
          image: "https://ci.example/badge.svg",
          href: "https://ci.example",
        },
      ],
    );
  });
});

describe("citations", () => {
  it("marks a short bracketed marker as a citation, keeping how it was written", () => {
    expect(spansOf("It ships weekly [1] and daily [source 2].")).toEqual([
      { text: "It ships weekly " },
      { text: "[1]", cite: "1" },
      { text: " and daily " },
      { text: "[source 2]", cite: "source 2" },
      { text: "." },
    ]);
  });

  it("never reads a citation inside code, empty, or with spaces at its ends", () => {
    expect(spansOf("`a[1]`")).toEqual([{ text: "a[1]", code: true }]);
    expect(spansOf("[ 3 ] and [] and [a\nb]", keep)).toEqual([{ text: "[ 3 ] and [] and [a\nb]" }]);
    expect(spansOf(`[${"x".repeat(33)}]`)).toEqual([{ text: `[${"x".repeat(33)}]` }]);
  });

  it("reads brackets followed by an address as a link, never as a citation", () => {
    expect(spansOf("[1](https://a.com)")).toEqual([{ text: "1", href: "https://a.com" }]);
  });
});

describe("continueMarkdown", () => {
  const replies = [
    "# Plan\nRead **this** in [g1](https://g1.globo.com).\n\n1. one\n2. two\n\n- three\ngoes on\n\n```js\nconst a = 1;\n```\nDone [1].",
    "Para one\nstill one  \nbreak\n\n---\n## Heading\n- a\n\n  b\n\nc\n2024. Not a list\n1. a list",
    "```\nopen fence\n```~~~\nnever closed",
    "a\r\nb\r\n\r\n* c\r\n",
    "- list stays open\n\n- another item\n\nAfter.",
    "First para.\n# Heading\n- item\n\nAfter list\n---\n- --\n- a\n\n  continued",
  ];

  it("gives what a whole parse gives, for every length a stream passes through", () => {
    for (const reply of replies)
      for (const options of [{}, keep]) {
        let parsed = continueMarkdown(undefined, "", options);
        for (let length = 1; length <= reply.length; length++) {
          parsed = continueMarkdown(parsed, reply.slice(0, length), options);
          expect(parsed.blocks).toEqual(parseMarkdown(reply.slice(0, length), options));
        }
      }
  });

  it("keeps every block before the last one as the same object", () => {
    const first = continueMarkdown(undefined, "One.\n\nTwo **bo");
    const next = continueMarkdown(first, "One.\n\nTwo **bold** and more");
    expect(next.blocks[0]).toBe(first.blocks[0]);
    expect(next.blocks[1]).not.toBe(first.blocks[1]);
    expect(next.blocks[1]).toEqual(
      paragraph({ text: "Two " }, { text: "bold", bold: true }, { text: " and more" }),
    );
    expect(continueMarkdown(next, next.text)).toBe(next);

    // Block boundaries without a trailing newline still freeze the already-closed block.
    const headingStart = continueMarkdown(undefined, "First para.\n# He");
    const headingGrow = continueMarkdown(headingStart, "First para.\n# Heading");
    expect(headingGrow.blocks[0]).toBe(headingStart.blocks[0]);
    expect(headingGrow.blocks[1]).toEqual({
      kind: "heading",
      level: 1,
      spans: [{ text: "Heading" }],
    });

    const listStart = continueMarkdown(undefined, "First para.\n- it");
    const listGrow = continueMarkdown(listStart, "First para.\n- item");
    expect(listGrow.blocks[0]).toBe(listStart.blocks[0]);
    expect(listGrow.blocks[1]).toEqual({
      kind: "list",
      ordered: false,
      items: [[{ text: "item" }]],
    });

    const afterListStart = continueMarkdown(undefined, "- a\n\nHe");
    const afterListGrow = continueMarkdown(afterListStart, "- a\n\nHello");
    expect(afterListGrow.blocks[0]).toBe(afterListStart.blocks[0]);
    expect(afterListGrow.blocks[1]).toEqual(paragraph({ text: "Hello" }));
  });

  it("parses everything again when the text was replaced or the options changed", () => {
    const first = continueMarkdown(undefined, "One.\n\nTwo.");
    const replaced = continueMarkdown(first, "Une.\n\nTwo.");
    expect(replaced.blocks[0]).toEqual(paragraph({ text: "Une." }));
    const widened = continueMarkdown(first, "One.\n\nTwo.", { linkSchemes: ["https", "mailto"] });
    expect(widened.blocks[0]).not.toBe(first.blocks[0]);
  });
});

describe("parse time", () => {
  // A reply is read again on every streamed token. Before the one-pass reads each of these took
  // from a quarter of a second to four seconds, and the first overflowed the stack. The bound is
  // 100 ms, not 50, so a machine that is busy with other work does not fail it by chance.
  const replies: Record<string, string> = {
    "50,000 marks inside a line": `x${"*".repeat(50_000)}x`,
    '"**" 20,000 times after a word': `a${"**".repeat(20_000)}`,
    '"*a " 10,000 times': "*a ".repeat(10_000),
    "an address and 10,000 )": `see https://a.com/${")".repeat(10_000)}`,
    '"[a](" 10,000 times': "[a](".repeat(10_000),
    '"![a](" 10,000 times': "![a](".repeat(10_000),
    '"[![a](b)" 5,000 times': "[![a](b)".repeat(5_000),
    '"[" and 5,000 images': `[${"![a](https://a.com/b.png)".repeat(5_000)}`,
    '"[1]" 20,000 times': "[1]".repeat(20_000),
    "a heading with 20,000 spaces": `# a${" ".repeat(20_000)}b`,
    "a heading with 16,000 spaces and #s": `# a${" ".repeat(16_000)}${"#".repeat(16_000)}b`,
    "a list item with 20,000 spaces": `- ${" ".repeat(20_000)}a b`,
    "a list item with 20,000 spaces and a U+2028": `- ${" ".repeat(20_000)}a\u2028b`,
    "5,000 bad addresses in a row": "https://a'".repeat(5_000),
    "a rule of 100,000 dashes": "-".repeat(100_000),
    "a rule of 100,000 stars with spaces": "* ".repeat(100_000),
    "20,000 lines ending in two spaces": "a  \n".repeat(20_000),
  };
  for (const [name, reply] of Object.entries(replies)) {
    it(`reads ${name} in linear time`, () => {
      // Warm up once before timing so JIT compilation and GC on a shared machine do not flake.
      // Quadratic regressions on these inputs take seconds to minutes; 500 ms still catches them
      // without failing under concurrent CPU load.
      parseMarkdown(reply.slice(0, 200), web);
      for (const read of [parseMarkdown, toPlainText]) {
        const started = performance.now();
        read(reply, web);
        expect(performance.now() - started).toBeLessThan(500);
      }
    });
  }
});

describe("toPlainText", () => {
  it("drops the marks and keeps the words, one line per block or item", () => {
    expect(
      toPlainText(
        "# Plan\nRead **this** in [g1](https://g1.globo.com).\n\n1. one\n2. two\n- three\n\n![A chart](https://a.com/c.png)\n\n```\ncode\n```",
        web,
      ),
    ).toBe("Plan\nRead this in g1.\n1. one\n2. two\nthree\nA chart\ncode");
  });
});
