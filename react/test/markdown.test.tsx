// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultLinkSchemes,
  Markdown,
  type Highlighter,
  type LinkDecision,
  type MarkdownImage,
  type MarkdownLink,
} from "../src/markdown.tsx";
import type { SourcePart } from "../src/protocol.ts";

// Tells React that this file drives it through `act`, so updates land where each test expects.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return { container, rerender: (next: ReactNode) => act(() => root.render(next)) };
}

function find(container: ParentNode, selector: string): HTMLElement {
  const element = container.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Nothing matches ${selector}`);
  return element;
}

function all(container: ParentNode, selector: string): Element[] {
  return [...container.querySelectorAll(selector)];
}

function source(marker: string, title: string, url?: string): SourcePart {
  return { type: "source", id: `source-${marker}`, marker, title, url };
}

function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  const value = writeText ? { writeText } : undefined;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

describe("raw HTML and unsafe addresses", () => {
  it("shows raw HTML as text and never builds an element from it", () => {
    const text = [
      '<img src="x" onerror="alert(1)">',
      "",
      'Inline <script>alert(1)</script> and <a href="javascript:alert(1)">a link</a>.',
      "",
      '<iframe src="https://evil.example"></iframe>',
    ].join("\n");
    const { container } = mount(<Markdown text={text} />);
    expect(container.querySelector("img, script, iframe, a, [onerror]")).toBeNull();
    expect(container.textContent).toContain('<img src="x" onerror="alert(1)">');
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("draws links with a script or data scheme as their text", () => {
    const text = [
      "[a](javascript:alert(1))",
      "[b](JaVaScRiPt:alert(1))",
      "[c](&#106;avascript:alert(1))",
      "[d](data:text/html;base64,PHNjcmlwdD4=)",
      "[e](vbscript:msgbox)",
      "<javascript:alert(1)>",
    ].join(" ");
    const { container } = mount(<Markdown text={text} />);
    expect(container.querySelector("a")).toBeNull();
    expect(
      all(container, '.pk-md-a[data-state="blocked"]').map((link) => link.textContent),
    ).toEqual(["a", "b", "c", "d", "e", "javascript:alert(1)"]);
  });

  it("keeps unsafe addresses as text even when the app allows their scheme", () => {
    const linkPolicy = vi.fn((): LinkDecision => "link");
    const { container } = mount(
      <Markdown
        text="[a](javascript:alert(1)) [b](data:text/html,hi) [c](//evil.example/x)"
        linkSchemes={[...defaultLinkSchemes, "javascript", "data"]}
        linkPolicy={linkPolicy}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(linkPolicy).not.toHaveBeenCalled();
  });

  it("opens web links in a new tab, without the opener or the referrer", () => {
    const { container } = mount(
      <Markdown text="Read [the docs](https://docs.example/start) or [write](mailto:help@docs.example)." />,
    );
    const [web, mail] = all(container, "a");
    expect(web?.getAttribute("href")).toBe("https://docs.example/start");
    expect(web?.getAttribute("target")).toBe("_blank");
    expect(web?.getAttribute("rel")).toBe("noopener noreferrer");
    const hint = document.getElementById(web?.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("Opens in a new tab");
    expect(mail?.getAttribute("href")).toBe("mailto:help@docs.example");
    expect(mail?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(mail?.hasAttribute("target")).toBe(false);
  });

  it("keeps addresses inside the app as text until a policy routes them", () => {
    const text = "[Pricing](/pricing), [top](#top) and [away](//evil.example/x)";
    expect(mount(<Markdown text={text} />).container.querySelector("a")).toBeNull();

    const navigate = vi.fn();
    const linkPolicy = (link: MarkdownLink): LinkDecision | undefined =>
      link.scheme === ""
        ? {
            onClick: (event) => {
              event.preventDefault();
              navigate(link.href);
            },
          }
        : undefined;
    const { container } = mount(<Markdown text={text} linkPolicy={linkPolicy} />);
    const links = all(container, "a");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/pricing", "#top"]);
    expect(links[0]?.hasAttribute("target")).toBe(false);

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      links[0]?.dispatchEvent(click);
    });
    expect(navigate).toHaveBeenCalledWith("/pricing");
    expect(click.defaultPrevented).toBe(true);
  });

  it("links a scheme the app adds", () => {
    const text = "Call [support](tel:+15550100).";
    expect(mount(<Markdown text={text} />).container.querySelector("a")).toBeNull();
    const { container } = mount(
      <Markdown text={text} linkSchemes={[...defaultLinkSchemes, "tel"]} />,
    );
    expect(find(container, "a").getAttribute("href")).toBe("tel:+15550100");
  });
});

describe("images", () => {
  it("shows an image the model wrote as its alt text", () => {
    const { container } = mount(
      <Markdown text="![A cat on a mat](https://cdn.example/cat.png) and ![](https://cdn.example/x.png)" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(
      all(container, '.pk-md-img[data-state="blocked"]').map((image) => image.textContent),
    ).toEqual(["A cat on a mat", "Image"]);
  });

  it("draws web images once the app allows them, without sending the referrer", () => {
    const text = [
      '![chart" onerror="alert(1)](https://cdn.example/chart.png)',
      "![x](javascript:alert(1))",
      "![y](data:image/png;base64,AAAA)",
    ].join(" ");
    const { container } = mount(<Markdown text={text} images />);
    expect(all(container, "img")).toHaveLength(1);
    const image = find(container, "img");
    expect(image.getAttribute("src")).toBe("https://cdn.example/chart.png");
    expect(image.getAttribute("alt")).toBe('chart" onerror="alert(1)');
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelector("[onerror]")).toBeNull();
  });

  it("lets a callback choose which images to draw", () => {
    const images = (image: MarkdownImage) => image.src.startsWith("https://cdn.example/");
    const { container } = mount(
      <Markdown
        text="![ours](https://cdn.example/a.png) ![theirs](https://tracker.example/b.png?q=secret)"
        images={images}
      />,
    );
    expect(all(container, "img").map((image) => image.getAttribute("src"))).toEqual([
      "https://cdn.example/a.png",
    ]);
    expect(find(container, '.pk-md-img[data-state="blocked"]').textContent).toBe("theirs");
  });
});

describe("citations", () => {
  const atlas = source("1", "World atlas", "https://atlas.example/paris");

  it("links a marker only when the message has a source with that marker", () => {
    const text = "Paris is the capital [1]. Lyon is second [2], they say [sic].";
    const { container } = mount(<Markdown text={text} sources={[atlas]} />);
    const cites = all(container, ".pk-md-cite");
    expect(cites).toHaveLength(1);
    expect(cites[0]?.tagName).toBe("A");
    expect(cites[0]?.textContent).toBe("[1]");
    expect(cites[0]?.getAttribute("href")).toBe("https://atlas.example/paris");
    expect(cites[0]?.getAttribute("aria-label")).toBe("Source 1: World atlas");
    expect(cites[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(find(container, ".pk-md-p").textContent).toBe(text);
  });

  it("reads a marker written with brackets and leaves markers in code alone", () => {
    const guide = source("[2]", "Guide", "https://guide.example");
    const { container } = mount(<Markdown text="See [2] and `[2]`." sources={[guide]} />);
    expect(all(container, ".pk-md-cite")).toHaveLength(1);
    expect(find(container, ".pk-md-code").textContent).toBe("[2]");
  });

  it("hands the source to the app when it shows sources itself", () => {
    const onCitation = vi.fn();
    const { container } = mount(
      <Markdown text="Paris [1]." sources={[atlas]} onCitation={onCitation} />,
    );
    const button = find(container, "button.pk-md-cite");
    expect(button.getAttribute("type")).toBe("button");
    act(() => button.click());
    expect(onCitation).toHaveBeenCalledWith(atlas);
  });

  it("does not link a source whose address is unsafe or missing", () => {
    const sources = [source("1", "Bad", "javascript:alert(1)"), source("2", "Offline notes")];
    const { container } = mount(<Markdown text="A [1], B [2]." sources={sources} />);
    const cites = all(container, ".pk-md-cite");
    expect(cites.map((cite) => cite.tagName)).toEqual(["SPAN", "SPAN"]);
    expect(cites.map((cite) => cite.getAttribute("title"))).toEqual(["Bad", "Offline notes"]);
  });

  it("turns markers into citations when the sources arrive after the text", () => {
    const text = "Paris [1].";
    const { container, rerender } = mount(<Markdown text={text} />);
    const paragraph = find(container, ".pk-md-p");
    expect(container.querySelector(".pk-md-cite")).toBeNull();

    // A message's whole parts list, as a message component would pass it.
    rerender(
      <Markdown text={text} sources={[{ type: "text", id: "t", text, settled: true }, atlas]} />,
    );
    expect(find(container, "a.pk-md-cite").getAttribute("href")).toBe(
      "https://atlas.example/paris",
    );
    expect(find(container, ".pk-md-p")).toBe(paragraph);
  });
});

describe("code blocks", () => {
  const python = "def total(items):\n\treturn  sum(items)  # two spaces\n\n\nprint(total([1, 2]))";
  const fenced = `\`\`\`python\n${python}\n\`\`\``;

  it("keeps the code's whitespace exactly and copies it", async () => {
    let finish = () => {};
    const writeText = vi.fn(
      (_text: string) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    stubClipboard(writeText);
    vi.useFakeTimers();
    const { container } = mount(<Markdown text={fenced} />);
    expect(find(container, ".pk-md-codeblock-code").textContent).toBe(python);
    const button = find(container, "button.pk-md-copy");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.textContent).toBe("Copy");

    act(() => button.click());
    expect(writeText).toHaveBeenCalledWith(python);
    expect(button.dataset.state).toBe("copying");

    await act(async () => finish());
    expect(button.dataset.state).toBe("copied");
    expect(button.textContent).toBe("Copied");
    expect(find(container, '[role="status"]').textContent).toBe("Copied");

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(button.dataset.state).toBe("idle");
    expect(button.textContent).toBe("Copy");
  });

  it.each([
    ["refuses", () => Promise.reject(new Error("Write permission denied."))],
    ["is missing", undefined],
  ])("selects the code when the clipboard %s", async (_, writeText) => {
    stubClipboard(writeText);
    const { container } = mount(<Markdown text={fenced} />);
    const button = find(container, "button.pk-md-copy");
    await act(async () => button.click());
    expect(button.dataset.state).toBe("failed");
    expect(button.textContent).toBe("Copy failed");
    expect(find(container, '[role="status"]').textContent).toContain("The code is selected");
    expect(window.getSelection()?.toString()).toBe(python);
  });

  it("blocks another copy while the clipboard is pending without losing focus", async () => {
    let finish = () => {};
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    stubClipboard(writeText);
    const { container } = mount(<Markdown text={fenced} />);
    const button = find(container, "button.pk-md-copy");
    act(() => {
      button.focus();
      // Both activations precede a render, like an app dispatching two clicks in one task.
      button.click();
      button.click();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Copying...");
    expect(find(container, '[role="status"]').textContent).toBe("Copying...");
    expect(document.activeElement).toBe(button);
    act(() => button.click());
    expect(writeText).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    expect(button.textContent).toBe("Copied");
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("handles a rejected highlighter during server rendering without browser globals", async () => {
    const rejected = Promise.reject(new Error("Grammar unavailable"));
    const then = vi.spyOn(rejected, "then");
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    try {
      const html = renderToStaticMarkup(
        <Markdown text={"```js\nplain code\n```"} highlight={() => rejected} />,
      );
      expect(html).toContain(">plain code</code>");
      // SSR never runs effects. A handler must already be attached before the event loop sees
      // the rejection, even if no client ever mounts this block.
      expect(then.mock.calls.some(([, onRejected]) => typeof onRejected === "function")).toBe(true);
    } finally {
      // A failing assertion must not leak this test's rejection into other tests.
      await rejected.catch(() => undefined);
      then.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("shows the plain code until an async highlighter resolves", async () => {
    let paint = (_node: ReactNode) => {};
    const highlight = vi.fn<Highlighter>(
      () =>
        new Promise<ReactNode>((resolve) => {
          paint = resolve;
        }),
    );
    const { container } = mount(<Markdown text={fenced} highlight={highlight} />);
    const block = find(container, ".pk-md-codeblock");
    expect(block.dataset.state).toBe("highlighting");
    expect(find(container, ".pk-md-codeblock-code").textContent).toBe(python);
    expect(highlight).toHaveBeenCalledWith(python, "python");

    await act(async () => paint(<span className="token">colored</span>));
    expect(block.dataset.state).toBe("highlighted");
    expect(find(container, ".pk-md-codeblock-code .token").textContent).toBe("colored");
  });

  it.each<[string, Highlighter]>([
    ["rejects", () => Promise.reject(new Error("No grammar for python."))],
    [
      "throws",
      () => {
        throw new Error("Highlighter crashed.");
      },
    ],
    ["returns nothing", () => null],
  ])("keeps the plain code when the highlighter %s", async (_, highlight) => {
    const { container } = mount(<Markdown text={fenced} highlight={highlight} />);
    await act(async () => {});
    expect(find(container, ".pk-md-codeblock").dataset.state).toBe("plain");
    expect(find(container, ".pk-md-codeblock-code").textContent).toBe(python);
  });

  it("paints a synchronous highlighter on the first render", () => {
    const { container } = mount(
      <Markdown text={fenced} highlight={(code) => <b>{code.length}</b>} />,
    );
    expect(find(container, ".pk-md-codeblock").dataset.state).toBe("highlighted");
    expect(find(container, ".pk-md-codeblock-code b").textContent).toBe(String(python.length));
  });

  it("does not highlight a code block that is still arriving", () => {
    const highlight = vi.fn<Highlighter>((code) => <b>{code}</b>);
    const open = `\`\`\`python\n${python}`;
    const { container, rerender } = mount(<Markdown text={open} streaming highlight={highlight} />);
    expect(highlight).not.toHaveBeenCalled();
    expect(find(container, ".pk-md-codeblock").dataset.state).toBe("streaming");

    rerender(<Markdown text={`${open}\n\`\`\``} highlight={highlight} />);
    expect(highlight).toHaveBeenCalledTimes(1);
    expect(find(container, ".pk-md-codeblock").dataset.state).toBe("highlighted");
  });
});

describe("streaming", () => {
  it("draws an open fence as code without its backticks, and keeps the block when it closes", () => {
    const { container, rerender } = mount(
      <Markdown text={"Here:\n\n```ts\nconst a = 1;"} streaming />,
    );
    const code = find(container, ".pk-md-codeblock-code");
    expect(code.textContent).toBe("const a = 1;");
    expect(container.textContent).not.toContain("`");

    // The closing fence, two of its three backticks in.
    rerender(<Markdown text={"Here:\n\n```ts\nconst a = 1;\n``"} streaming />);
    expect(find(container, ".pk-md-codeblock-code").textContent).toBe("const a = 1;");

    rerender(<Markdown text={"Here:\n\n```ts\nconst a = 1;\n```\n\nDone."} streaming />);
    expect(find(container, ".pk-md-codeblock-code")).toBe(code);
    expect(code.textContent).toBe("const a = 1;");
    expect(container.textContent).not.toContain("`");
  });

  it.each([
    ["1. Run it:\n   ```python\n   def f(**kwargs", "def f(**kwargs"],
    ["- ```python\n  def f(**kwargs", "def f(**kwargs"],
    ["> ```js\n> const s = `x", "const s = `x"],
  ])("never writes into code that a list item or a quote opened in %j", (text, code) => {
    const { container } = mount(<Markdown text={text} streaming />);
    expect(find(container, ".pk-md-codeblock-code").textContent).toBe(code);
  });

  it.each([
    ["    def f(**kwargs):", "def f(**kwargs):"],
    ["    [not a link](https://example.invalid", "[not a link](https://example.invalid"],
    ["    const text = `unfinished", "const text = `unfinished"],
    ["    ```typescript", "```typescript"],
    ["\tdef f(**kwargs):", "def f(**kwargs):"],
    [">     def f(**kwargs):", "def f(**kwargs):"],
    ["- item\n\n      def f(**kwargs):", "def f(**kwargs):"],
  ])("keeps displayed and copied indented code literal in %j", async (text, code) => {
    const writeText = vi.fn(async (_text: string) => {});
    stubClipboard(writeText);
    const { container } = mount(<Markdown text={text} streaming />);
    expect(find(container, ".pk-md-codeblock-code").textContent).toBe(code);
    await act(async () => find(container, "button.pk-md-copy").click());
    expect(writeText).toHaveBeenCalledWith(code);
  });

  it.each(["", "    "])("waits for a multiline link destination with %j indentation", (indent) => {
    const start = `Read [guide](\n${indent}`;
    const destination = "https://guide.invalid/path";
    const { container, rerender } = mount(<Markdown text={start} streaming />);
    for (let length = 0; length <= destination.length; length++) {
      rerender(<Markdown text={start + destination.slice(0, length)} streaming />);
      expect(find(container, ".pk-md-p").textContent?.trim()).toBe("Read guide");
      expect(container.querySelector("a")).toBeNull();
    }
    rerender(<Markdown text={`${start}${destination})`} streaming />);
    expect(find(container, "a").getAttribute("href")).toBe(destination);
  });

  it("hides a fence line while its language is being typed", () => {
    const { container } = mount(<Markdown text={"Here:\n\n```typ"} streaming />);
    expect(container.querySelector(".pk-md-codeblock")).toBeNull();
    expect(container.textContent).not.toContain("`");
  });

  it.each([
    ["only its header", "| Name | Age |", "Age"],
    ["a short delimiter row", "| Name | Age |\n| --- |", "Age"],
    ["a delimiter row being typed", "| Name | Age |\n| --", "Age"],
    ["a header still being typed under a sentence", "Intro:\n| Name | Ag", "Ag"],
  ])("draws a table with %s as a table", (_, text, second) => {
    const { container } = mount(<Markdown text={text} streaming />);
    expect(all(container, "th").map((cell) => cell.textContent)).toEqual(["Name", second]);
    expect(container.textContent).not.toContain("|");
  });

  it("shows a link whose address is still arriving as its text", () => {
    const { container, rerender } = mount(
      <Markdown text="Read [the guide](https://docs.exa" streaming />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(find(container, ".pk-md-p").textContent).toBe("Read the guide");

    rerender(<Markdown text="Read [the guide](https://docs.example/guide) now" streaming />);
    expect(find(container, "a").getAttribute("href")).toBe("https://docs.example/guide");
  });

  it.each([
    ["Run `npm ins", "code", "npm ins"],
    ["**Bold te", "strong", "Bold te"],
    ["**Bold text*", "strong", "Bold text"],
    ["Mixed **bold `co", "strong code", "co"],
  ])("closes inline code and bold that are still open in %j", (text, selector, inner) => {
    const { container } = mount(<Markdown text={text} streaming />);
    expect(find(container, selector).textContent).toBe(inner);
    expect(find(container, ".pk-md-p").textContent).not.toMatch(/[`*]/);
  });

  it.each(["Steps:\n-", "Steps:\n- ", "Steps:\n*", "Steps:\n1."])(
    "does not turn the line above a new list item into a heading in %j",
    (text) => {
      const { container } = mount(<Markdown text={text} streaming />);
      expect(container.querySelector("h2")).toBeNull();
      expect(find(container, ".pk-md-p").textContent).toBe("Steps:");
    },
  );

  it("draws the text exactly as written once it settles", () => {
    const { container } = mount(<Markdown text="**Not closed" />);
    expect(container.querySelector("strong")).toBeNull();
    expect(find(container, ".pk-md-p").textContent).toBe("**Not closed");
  });
});

describe("settled blocks", () => {
  it("re-renders only the block still arriving", () => {
    const linkPolicy = vi.fn((_link: MarkdownLink): LinkDecision | undefined => undefined);
    const highlight = vi.fn<Highlighter>((code) => <b>{code}</b>);
    const settled = "First, [a link](https://a.example).\n\n```js\nlet x = 1;\n```\n\n";
    const view = (tail: string) => (
      <Markdown text={settled + tail} streaming linkPolicy={linkPolicy} highlight={highlight} />
    );
    const { container, rerender } = mount(view("Tail"));
    const paragraph = find(container, ".pk-md-p");
    const codeBlock = find(container, ".pk-md-codeblock");

    for (let words = 1; words <= 20; words++) rerender(view(`Tail${" more".repeat(words)}`));

    // Both callbacks run while their block renders, so one call each means one render each.
    expect(linkPolicy).toHaveBeenCalledTimes(1);
    expect(highlight).toHaveBeenCalledTimes(1);
    expect(find(container, ".pk-md-p")).toBe(paragraph);
    expect(find(container, ".pk-md-codeblock")).toBe(codeBlock);
    expect(all(container, ".pk-md-p").at(-1)?.textContent).toBe(`Tail${" more".repeat(20)}`);
  });

  it("keeps a focused block mounted when a reference definition arrives", () => {
    const start = "First paragraph.\n\nSee [the guide](https://guide.invalid).\n\n[reference]";
    const linkPolicy = vi.fn((): LinkDecision => "link");
    const { container, rerender } = mount(
      <Markdown text={start} streaming linkPolicy={linkPolicy} />,
    );
    const link = find(container, "a");
    act(() => link.focus());
    rerender(
      <Markdown text={`${start}: https://reference.invalid`} streaming linkPolicy={linkPolicy} />,
    );
    expect(find(container, "a")).toBe(link);
    expect(document.activeElement).toBe(link);
    expect(linkPolicy).toHaveBeenCalledTimes(1);
  });

  it.each([">", "-"])("resolves reference definitions inside a %s container", (containerMarker) => {
    const text = `Before\n\nSee [guide].\n\n${containerMarker} [guide]: https://guide.invalid`;
    const { container } = mount(<Markdown text={text} />);
    expect(find(container, "a").getAttribute("href")).toBe("https://guide.invalid");
  });

  it("keeps a focused link mounted while text streams after it", () => {
    const start = "See [the docs](https://docs.example) and";
    const { container, rerender } = mount(<Markdown text={start} streaming />);
    const link = find(container, "a");
    act(() => link.focus());
    expect(document.activeElement).toBe(link);

    for (const more of [" then", " then more", " then more words.", " then more words.\n\nNext"]) {
      rerender(<Markdown text={start + more} streaming />);
    }
    expect(find(container, "a")).toBe(link);
    expect(document.activeElement).toBe(link);
  });
});

describe("footnotes and classes", () => {
  it("links footnotes inside their own message", () => {
    const text = "A claim[^1].\n\n[^1]: The proof.";
    const first = mount(<Markdown text={text} />).container;
    const second = mount(<Markdown text={text} />).container;
    const reference = find(first, "a[data-footnote-ref]");
    const target = reference.getAttribute("href")?.slice(1) ?? "";
    expect(first.querySelector(`[id="${target}"]`)?.textContent).toContain("The proof.");
    expect(find(second, "a[data-footnote-ref]").getAttribute("href")).not.toBe(
      reference.getAttribute("href"),
    );
    const heading = document.getElementById(reference.getAttribute("aria-describedby") ?? "");
    expect(heading?.textContent).toBe("Footnotes");
    expect(find(first, "a[data-footnote-backref]").getAttribute("aria-label")).toBe(
      "Back to the text",
    );
  });

  it("gives every element it draws a pk-md class", () => {
    const text = [
      "# Title",
      "Some *em*, **strong**, ~~gone~~ and `code`.",
      "- [ ] task\n- item",
      "> quote",
      "| a | b |\n| - | - |\n| 1 | 2 |",
      "---",
      "```\nplain\n```",
    ].join("\n\n");
    const { container } = mount(<Markdown text={text} />);
    const unclassed = all(container, ".pk-md *").filter(
      (element) => ![...element.classList].some((name) => name.startsWith("pk-md")),
    );
    expect(unclassed.map((element) => element.tagName)).toEqual([]);
  });
});
