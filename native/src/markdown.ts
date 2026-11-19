/**
 * The Markdown a model writes in a chat reply, read into blocks and spans that a React Native app
 * draws as nested `Text`. Never HTML: a span is words plus how they look, so nothing a model writes
 * can become markup, a link only ever points at a scheme the app allows, and an image is never
 * fetched here.
 *
 * Model text is not trusted. A model repeats what it read (a web page, a file, a tool result), so
 * whoever wrote those can write here. That is why a link's words cannot name another site than the
 * one it opens, and why an image stays its alt text unless the app draws it.
 *
 * The chat parser runs on every streamed token on the web and in
 * Hermes. ponytail: only the subset models write. Paragraphs, `-`/`*`/`+`/`1.` lists, `#` headings,
 * fenced code, `**bold**`, `*italic*`/`_italic_`, inline code, `[text](address)`, bare web
 * addresses, `![alt](address)` and `[1]` citations. Nested lists flatten into one; quotes and tables
 * stay the characters they were, and a rule is dropped. A reply parses in linear time: where marks
 * and parentheses close is found in one pass per text, never by a scan per opening mark. Ceilings
 * keep a stray mark local: an emphasis closes within EMPHASIS_REACH characters, a link's address
 * ends within LINK_REACH, marks nest at most MAX_DEPTH deep and a run of more than MAX_RUN marks is
 * plain text. Past a ceiling the marks stay the characters they were. A real CommonMark parser is
 * the upgrade if replies ever need more.
 *
 * Imports nothing from React Native, so it runs, and is tested, under Node.
 */

export interface MarkdownSpan {
  text: string;
  bold?: true;
  italic?: true;
  /** Inline code: `text` is the words exactly as written. */
  code?: true;
  /** Where the span links to. Always an address whose scheme the app allows. */
  href?: string;
  /** An image the model wrote. `text` is its alt text, and this is its http or https address. It
   * is never loaded here: an app that wants images draws them itself. */
  image?: string;
  /** A citation, such as `1` for `[1]`. `text` is the marker as written. It shows as a citation
   * only when the message has a source part with this marker, and as its plain text otherwise. */
  cite?: string;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type MarkdownBlock =
  | { kind: "paragraph"; spans: MarkdownSpan[] }
  | { kind: "heading"; level: HeadingLevel; spans: MarkdownSpan[] }
  | { kind: "list"; ordered: false; items: MarkdownSpan[][] }
  | { kind: "list"; ordered: true; start: number; items: MarkdownSpan[][] }
  | { kind: "code"; text: string };

export interface MarkdownOptions {
  /** The schemes a link may use, such as `"https"` or `"mailto"`. Any other link shows as the
   * characters the model wrote. `javascript`, `vbscript` and `data` never link, even when listed.
   * Without a list, no link opens. */
  linkSchemes?: readonly string[];
  /** What a single line break inside a paragraph becomes. `"space"` joins the two lines, as a web
   * page does, so a sentence the source happened to wrap reads as one sentence. `"keep"` keeps the
   * break, for replies whose line breaks are part of the text, like a caption. A line that ends in
   * two spaces or a backslash always keeps its break. Default `"space"`. */
  lineBreaks?: "space" | "keep";
}

/** A parse that a later, longer text can continue from. Hold it and pass it back. */
export interface ParsedMarkdown {
  readonly text: string;
  readonly blocks: readonly MarkdownBlock[];
  /** The first line that can still change a block. A list stays open across blank lines. */
  readonly resumeAt: number;
  readonly complete: number;
  /** The options it was parsed with, as one string. */
  readonly settings: string;
}

type Style = Omit<MarkdownSpan, "text">;

interface Settings {
  schemes: ReadonlySet<string>;
  keepBreaks: boolean;
}

/** How far past its opening mark an emphasis may close. */
const EMPHASIS_REACH = 512;
/** How long the address inside a link's parentheses may be. */
const LINK_REACH = 1000;
/** How deep marks and links nest; deeper ones are their characters. */
const MAX_DEPTH = 8;
/** A longer run of `*` or `_` is plain text: it neither opens nor closes. */
const MAX_RUN = 3;
/** The longest citation marker, as on the web: `[12]`, `[a]`, `[source 3]`. */
const MAX_MARKER = 32;

const NO_SCHEMES: readonly string[] = [];
const SCHEME_NAME = /^[a-z][a-z\d+.-]*$/;
/** Schemes that run code or show content the model wrote as if a site sent it. */
const UNSAFE_SCHEMES = new Set(["javascript", "vbscript", "data"]);

const NEWLINE = /\r\n?|\n/g;
// `[\s\S]`, not `.`: a dot stops at U+2028, and the failed match then backtracks over the line.
const LIST_ITEM = /^\s*(?:[-*+]|(\d{1,9})[.)])\s+([\s\S]*)$/;
// One space before the closing #s, not `\s+`: that made a long run of spaces quadratic.
const HEADING = /^\s{0,3}(#{1,6})\s+([\s\S]*?)(?:\s#+)?$/;
// One class per loop and a count after it: a repeated backreference group falls off a cliff in
// JavaScriptCore past 65,536 repetitions (a model stuck on "-----" cost Safari 30 to 60 ms a token).
const RULE = /^\s{0,3}(?:-[-\s]*|\*[*\s]*|_[_\s]*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const WEB_ADDRESS = /^https?:\/\/[^\s/?#@<>"'`\\]+(?:[/?#][^\s<>"`\\]*)?$/i;
/** Any other scheme: an address with no space, quote, angle bracket or backslash in it. */
const OTHER_ADDRESS = /^[a-z][a-z\d+.-]*:[^\s<>"'`\\]+$/i;
const SCHEME = /^([a-z][a-z\d+.-]*):/i;
// Sticky, read at `lastIndex`: never on a copy of the rest of the reply (Hermes copies a slice).
const BARE_URL = /https?:\/\/[^\s<>"`\\]+/iy;
const HANDLE = /@[A-Za-z0-9._]+/y;
/** A link's words that name an address: an optional scheme, then its host. */
const ADDRESS = /^(https?:\/\/)?([^\s/?#]+)(?:[/?#]\S*)?$/i;
/** A host without a scheme: dotted, no `@`, and its last part does not start with a digit. */
const DOMAIN = /^[^@.]+(?:\.[^@.]+)*\.[^@.\d][^@.]*$/;
const WORD = /[A-Za-z0-9]/;
/** Before an `_`, these keep it inside a word or an address: `snake_case`, `site.com/_x_`. */
const UNDERSCORE_GLUE = /[A-Za-z0-9/]/;
const SPACE = /\s/;
const ESCAPABLE = "\\`*_[]()#+-.!~>";
// No `_`: an address may end in one (instagram.com/bia_), and an italic address is read first.
const URL_END_PUNCTUATION = ".,;:!?*'\"]";

function settingsOf(options: MarkdownOptions): Settings {
  const schemes = new Set<string>();
  for (const scheme of options.linkSchemes ?? NO_SCHEMES) {
    const name = scheme.toLowerCase().replace(/:$/, "");
    if (SCHEME_NAME.test(name) && !UNSAFE_SCHEMES.has(name)) schemes.add(name);
  }
  return { schemes, keepBreaks: options.lineBreaks === "keep" };
}

function settingsKey(settings: Settings): string {
  return `${[...settings.schemes].sort().join(" ")}|${settings.keepBreaks ? "keep" : "space"}`;
}

/** The reply as blocks: paragraphs, headings, lists and code, each holding spans. */
export function parseMarkdown(markdown: string, options: MarkdownOptions = {}): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  parseFrom(markdown, 0, settingsOf(options), blocks);
  return blocks;
}

/**
 * The parse of `markdown`, reusing `previous` when `markdown` only grew. A streaming reply grows a
 * few characters at a time, so only its last block is read again, and every block before it is
 * the same object as in `previous`: a component that draws it does not render again.
 *
 * The parser's state is empty wherever a block starts, so starting again at the last block's first
 * line gives exactly what a parse of the whole text gives.
 */
export function continueMarkdown(
  previous: ParsedMarkdown | undefined,
  markdown: string,
  options: MarkdownOptions = {},
): ParsedMarkdown {
  const settings = settingsOf(options);
  const key = settingsKey(settings);
  if (previous && previous.text === markdown && previous.settings === key) return previous;
  const append = previous && previous.settings === key && markdown.startsWith(previous.text);
  const prefix = append ? previous.blocks.slice(0, previous.complete) : [];
  return {
    text: markdown,
    settings: key,
    ...parseFrom(markdown, append ? previous.resumeAt : 0, settings, prefix),
  };
}

/** The blocks of `markdown` from `from` on, which must be where a line starts. */
function parseFrom(
  markdown: string,
  from: number,
  settings: Settings,
  blocks: MarkdownBlock[],
): Pick<ParsedMarkdown, "blocks" | "complete" | "resumeAt"> {
  let resumeAt = from;
  let complete = blocks.length;
  let paragraph: string[] = [];
  // Whether each paragraph line ends in a hard break, kept beside it for the join.
  let breaks: boolean[] = [];
  let paragraphStart = 0;
  // Each item keeps its lines and joins them once, so a long item is never rebuilt per line.
  let list: { ordered: boolean; start: number; items: string[][]; at: number } | null = null;
  let itemBreaks: boolean[][] = [];
  // A blank line since the list's last line: an unindented line after it ends the list.
  let blank = false;
  let fence: string | null = null;
  let fenceStart = 0;
  let code: string[] = [];

  const join = (lines: string[], hard: boolean[]) => {
    if (settings.keepBreaks) return lines.join("\n");
    return lines.map((line, i) => (i === 0 ? line : (hard[i - 1] ? "\n" : " ") + line)).join("");
  };
  const endParagraph = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: "paragraph", spans: parseInline(join(paragraph, breaks), settings) });
    paragraph = [];
    breaks = [];
  };
  const endList = () => {
    if (list) {
      const items = list.items.map((lines, index) =>
        parseInline(join(lines, itemBreaks[index] ?? []), settings),
      );
      blocks.push(
        list.ordered
          ? { kind: "list", ordered: true, start: list.start, items }
          : { kind: "list", ordered: false, items },
      );
    }
    list = null;
    itemBreaks = [];
    blank = false;
  };
  const endCode = () => {
    if (code.some((line) => line.trim())) blocks.push({ kind: "code", text: code.join("\n") });
    code = [];
    fence = null;
  };

  let position = from;
  for (;;) {
    NEWLINE.lastIndex = position;
    const newline = NEWLINE.exec(markdown);
    const end = newline ? newline.index : markdown.length;
    const raw = markdown.slice(position, end);
    const at = position;
    const line = raw.trimEnd();
    if (fence !== null) {
      // A fenced block is its words, read as nothing else.
      if (line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim())) endCode();
      else code.push(raw);
    } else if (!line.trim()) {
      endParagraph();
      if (list) blank = true;
    } else {
      const opened = FENCE.exec(line);
      // Two spaces at the end of a line are a hard break, as in CommonMark. Read as the last two
      // characters, not as / {2,}$/: that pattern tries every start in a run of spaces, and a
      // model that writes 20,000 of them made it quadratic.
      const slashBreak = newline !== null && raw.endsWith("\\") && !raw.endsWith("\\\\");
      const hard = raw.endsWith("  ") || slashBreak;
      const words = slashBreak ? line.slice(0, -1) : line;
      const heading = opened ? null : HEADING.exec(words);
      if (opened?.[1]) {
        endParagraph();
        endList();
        fence = opened[1];
        fenceStart = at;
      } else if (RULE.test(line) && line.replace(/\s/g, "").length >= 3) {
        endParagraph();
        endList();
      } else if (heading) {
        endParagraph();
        endList();
        const spans = parseInline((heading[2] ?? "").trimEnd(), settings);
        const level = Math.min(6, heading[1]?.length ?? 1) as HeadingLevel;
        if (spans.length > 0) blocks.push({ kind: "heading", level, spans });
      } else {
        const item = LIST_ITEM.exec(words);
        const number = item?.[1];
        // "2024. It was a good year" inside a paragraph is a sentence: only a 1 starts a list there.
        if (item && !(paragraph.length > 0 && number !== undefined && Number(number) !== 1)) {
          endParagraph();
          const ordered = number !== undefined;
          if (!list || list.ordered !== ordered) {
            endList();
            list = { ordered, start: ordered ? Number(number) : 1, items: [], at };
          }
          list.items.push([item[2] ?? ""]);
          itemBreaks.push([hard]);
          blank = false;
        } else if (list && (!blank || /^\s{2,}/.test(raw))) {
          // A line under an item belongs to it, unless a blank line came first and it is not
          // indented: then the list is over.
          list.items[list.items.length - 1]?.push(words.trim());
          itemBreaks[itemBreaks.length - 1]?.push(hard);
          blank = false;
        } else {
          if (list) endList();
          if (paragraph.length === 0) paragraphStart = at;
          paragraph.push(words.trim());
          breaks.push(hard);
        }
      }
    }
    if (!newline) break;
    position = newline.index + newline[0].length;
    // A final CR may still gain its LF. Re-read that line, or the LF would become a blank line.
    if (position === markdown.length && newline[0] === "\r") continue;
    complete = blocks.length;
    if (fence !== null) resumeAt = fenceStart;
    else if (list) resumeAt = list.at;
    else resumeAt = paragraph.length ? paragraphStart : position;
  }
  if (fence !== null) endCode();
  endParagraph();
  endList();
  return { blocks, complete, resumeAt };
}

/** The reply's words without its marks, for a title, a label or a notification: one line per
 * block or list item, an ordered item keeping its number, a link its words and an image its alt
 * text. */
export function toPlainText(markdown: string, options: MarkdownOptions = {}): string {
  const words = (spans: MarkdownSpan[]) => spans.map((span) => span.text).join("");
  return parseMarkdown(markdown, options)
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
        case "heading":
          return words(block.spans);
        case "code":
          return block.text;
        case "list":
          return block.items
            .map((item, index) =>
              block.ordered ? `${block.start + index}. ${words(item)}` : words(item),
            )
            .join("\n");
      }
    })
    .join("\n");
}

/** `text`'s spans, added to `spans`: nested marks and link labels write into the same list. */
function parseInline(
  text: string,
  settings: Settings,
  style: Style = {},
  depth = 0,
  spans: MarkdownSpan[] = [],
): MarkdownSpan[] {
  const nests = depth < MAX_DEPTH;
  // The words waiting for a span: `cut` holds what escapes rewrote, and text from `from` to `i`
  // is still the reply's own characters, so words are never built one character at a time.
  let cut: string[] = [];
  let from = 0;
  const flush = (end: number) => {
    cut.push(text.slice(from, end));
    const words = cut.join("");
    if (words) spans.push({ ...style, text: words });
    cut = [];
  };
  // Found for the first mark or link that needs them, then shared by every later one.
  let stars: Closers | undefined;
  let underscores: Closers | undefined;
  let parens: Int32Array | undefined;
  const closersOf = (mark: string): Closers => {
    if (mark === "*") return stars ?? (stars = findClosers(text, mark));
    return underscores ?? (underscores = findClosers(text, mark));
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const before = text[i - 1] ?? " ";
    if (char === "\\" && ESCAPABLE.includes(text[i + 1] ?? "\n")) {
      cut.push(text.slice(from, i), text.charAt(i + 1));
      i += 2;
      from = i;
      continue;
    }
    if (char === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i + 1) {
        flush(i);
        spans.push({ ...style, code: true, text: text.slice(i + 1, close) });
        i = from = close + 1;
        continue;
      }
    }
    if (char === "@" && !WORD.test(before)) {
      // A handle is its characters: @_carol_ never turns into an italic carol.
      const handle = readAt(HANDLE, text, i);
      if (handle) {
        i += handle.length;
        continue;
      }
    }
    // An image's brackets come after its `!`. Inside a link's words an image still reads, so a
    // linked image (`[![alt](src)](href)`) keeps both.
    const image = char === "!" && text[i + 1] === "[" && nests;
    if ((char === "[" || image) && nests && (image || style.href === undefined)) {
      if (!parens) parens = matchParens(text);
      const bracket = readBracket(text, image ? i + 1 : i, parens, settings, image);
      if (bracket?.kind === "image") {
        if (bracket.src) {
          flush(i);
          spans.push({ ...style, image: bracket.src, text: bracket.alt });
          from = bracket.end;
        }
        // Not a web address: shown as the characters it was, never as an image.
        i = bracket.end;
        continue;
      }
      if (bracket?.kind === "link") {
        if (bracket.href) {
          flush(i);
          const linked = { ...style, href: bracket.href };
          if (bracket.label === null) spans.push({ ...linked, text: bracket.href });
          else parseInline(bracket.label, settings, linked, depth + 1, spans);
          from = bracket.end;
        }
        // Not an address the app allows: shown as the words it was, never as a link.
        i = bracket.end;
        continue;
      }
      if (bracket?.kind === "cite" && style.href === undefined) {
        flush(i);
        spans.push({ ...style, cite: bracket.marker, text: text.slice(i, bracket.end) });
        i = from = bracket.end;
        continue;
      }
    }
    if ((char === "h" || char === "H") && style.href === undefined && !WORD.test(before)) {
      const url = readBareUrl(text, i, settings);
      if (url) {
        if (url.href) {
          flush(i);
          spans.push({ ...style, text: url.href, href: url.href });
          from = url.end;
        }
        // Not an address the app allows: its characters, read as nothing else.
        i = url.end;
        continue;
      }
    }
    if (char === "*" || char === "_") {
      let run = 1;
      while (text[i + run] === char) run++;
      if (run > MAX_RUN || !nests) {
        i += run;
        continue;
      }
      const emphasis = readEmphasis(text, i, closersOf);
      if (emphasis) {
        flush(i);
        const inner: Style = emphasis.bold ? { ...style, bold: true } : { ...style, italic: true };
        parseInline(emphasis.inner, settings, inner, depth + 1, spans);
        i = from = emphasis.end;
        continue;
      }
    }
    i++;
  }
  flush(text.length);
  return spans;
}

/** What a sticky pattern matches at `at`, read in place. */
function readAt(pattern: RegExp, text: string, at: number): string | null {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0] ?? null;
}

/** The address when a link to it may open under `options`, or null. For an address the app got
 * from somewhere else that the model may have steered, such as a source's URL. */
export function allowedLink(url: string, options: MarkdownOptions = {}): string | null {
  return allowedAddress(url.trim(), settingsOf(options), false);
}

/** The address a link or an image may use, or null. A web address must have a host; any other
 * allowed scheme must at least have no space, quote or angle bracket in it. */
function allowedAddress(target: string, settings: Settings, webOnly: boolean): string | null {
  const scheme = SCHEME.exec(target)?.[1]?.toLowerCase();
  if (!scheme || /\p{Cc}/u.test(target)) return null;
  if (scheme === "http" || scheme === "https") {
    if (!WEB_ADDRESS.test(target)) return null;
    return webOnly || settings.schemes.has(scheme) ? target : null;
  }
  return !webOnly && settings.schemes.has(scheme) && OTHER_ADDRESS.test(target) ? target : null;
}

type Bracket =
  | { kind: "link"; label: string | null; href: string | null; end: number }
  | { kind: "image"; alt: string; src: string | null; end: number }
  | { kind: "cite"; marker: string; end: number };

/**
 * What starts with the `[` at `start`: `[label](target)`, `![alt](target)` when `image`, or a
 * `[marker]` citation. A target keeps its own parentheses (a Wikipedia address). `href` and `src`
 * are null for an address the app does not allow; `label` is null when the target shows as its own
 * words (no label, or a label that names another address).
 */
function readBracket(
  text: string,
  start: number,
  parens: Int32Array,
  settings: Settings,
  image: boolean,
): Bracket | null {
  let close = -1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "!" && text[i + 1] === "[" && !image) {
      // A link's words may hold one image (`[![alt](src)](href)`, a badge): step over it. Each
      // image is stepped over once here and read once with the label, so this stays one pass.
      const inner = imageEnd(text, i + 1, parens);
      if (inner === -1) return null;
      i = inner - 1;
    } else if (text[i] === "[") return null;
    else if (text[i] === "]") {
      close = i;
      break;
    }
  }
  if (close === -1) return null;
  const label = text.slice(start + 1, close);
  if (text[close + 1] !== "(") {
    // A marker of up to 32 characters, with no line break inside and no space at either end, so
    // `[ ]` and a whole bracketed sentence are not candidates.
    if (image || label.length === 0 || label.length > MAX_MARKER) return null;
    if (isSpace(label[0] ?? " ") || isSpace(label[label.length - 1] ?? " ")) return null;
    if (label.includes("\n")) return null;
    return { kind: "cite", marker: label, end: close + 1 };
  }
  const end = parens[close + 1] ?? -1;
  if (end === -1 || end - (close + 2) > LINK_REACH) return null;
  // A title after the address (`"..."`) and angle brackets around it are not part of it.
  const target = (
    text
      .slice(close + 2, end)
      .trim()
      .split(/\s+/)[0] ?? ""
  ).replace(/^<(.*)>$/, "$1");
  if (image) {
    // An image is drawn only by the app, and only from the web. Its alt text is its words.
    return {
      kind: "image",
      alt: label.trim(),
      src: allowedAddress(target, settings, true),
      end: end + 1,
    };
  }
  const href = allowedAddress(target, settings, false);
  const own = label.trim() !== "" && !(href !== null && namesAnotherHost(label, href));
  return { kind: "link", label: own ? label : null, href, end: end + 1 };
}

/** Where the `![alt](target)` whose `[` is at `start` ends, or -1 when it is not one. */
function imageEnd(text: string, start: number, parens: Int32Array): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "[") return -1;
    else if (text[i] === "]") {
      const end = text[i + 1] === "(" ? (parens[i + 1] ?? -1) : -1;
      return end === -1 ? -1 : end + 1;
    }
  }
  return -1;
}

/** Where each "(" of the text closes (-1 when it never does), all in one pass. */
function matchParens(text: string): Int32Array {
  const closing = new Int32Array(text.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") open.push(i);
    else if (text[i] === ")") {
      const at = open.pop();
      if (at !== undefined) closing[at] = i;
    }
  }
  return closing;
}

/** Whether a link's words are an address on another host than the link's own, so
 * `[https://bank.example/login](https://evil.example)` never shows the trusted address. */
function namesAnotherHost(label: string, href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  // The label's own marks are not part of the address it names ("**g1.globo.com**").
  // Read the underscores from the edges. An unanchored search for trailing underscores would
  // try every start in a long run of them inside the label.
  const words = label.trim().replace(/[*`]/g, "");
  let from = 0;
  let end = words.length;
  while (from < end && words[from] === "_") from++;
  while (end > from && words[end - 1] === "_") end--;
  const address = ADDRESS.exec(words.slice(from, end));
  if (!address) return false;
  const host = bareHost(address[2] ?? "");
  if (address[1] === undefined && !DOMAIN.test(host)) return false;
  const linked = bareHost(href.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "");
  // A subdomain of the named site is the same owner ("globo.com" linking to g1.globo.com).
  return linked !== host && !linked.endsWith(`.${host}`);
}

function bareHost(authority: string): string {
  const host = authority.toLowerCase();
  return (host.startsWith("www.") ? host.slice(4) : host).replace(/\.$/, "");
}

/** A bare web address at `start`, without the punctuation of the sentence it ends. `end` is where
 * the address stops; `href` is null when what stands there is not a valid one, or its scheme is
 * not one the app allows. */
function readBareUrl(
  text: string,
  start: number,
  settings: Settings,
): { href: string | null; end: number } | null {
  const found = readAt(BARE_URL, text, start);
  if (!found) return null;
  let opens = 0;
  let closes = 0;
  for (let i = 0; i < found.length; i++) {
    if (found[i] === "(") opens++;
    else if (found[i] === ")") closes++;
  }
  let end = found.length;
  while (end > 0) {
    const last = found[end - 1] ?? "";
    // A ")" stays while it closes one of the address's own "(".
    if (last === ")" ? opens >= closes : !URL_END_PUNCTUATION.includes(last)) break;
    if (last === ")") closes--;
    end--;
  }
  const url = found.slice(0, end);
  return { href: allowedAddress(url, settings, false), end: start + end };
}

/** Where an emphasis of one mark may close, in order: an italic on a single mark, a bold on the
 * last pair of a run of two or three. `next` points past the ones already behind the reader, which
 * only moves forward, so a text full of unclosed marks still costs one pass. */
interface Closers {
  italic: number[];
  bold: number[];
  next: { italic: number; bold: number };
}

/** Every place in `text` that closes an emphasis of `mark`. Escapes, inline code, handles and runs
 * longer than MAX_RUN close nothing, nor does a mark after a space (`2 * 3`) or an underscore
 * inside a word (`snake_case`). */
function findClosers(text: string, mark: string): Closers {
  const closers: Closers = { italic: [], bold: [], next: { italic: 0, bold: 0 } };
  let j = 0;
  while (j < text.length) {
    const char = text[j];
    if (char === "\\") {
      j += 2;
      continue;
    }
    if (char === "`") {
      const close = text.indexOf("`", j + 1);
      if (close !== -1) {
        j = close + 1;
        continue;
      }
    }
    if (char === "@" && !WORD.test(text[j - 1] ?? " ")) {
      const handle = readAt(HANDLE, text, j);
      if (handle) {
        j += handle.length;
        continue;
      }
    }
    if (char !== mark) {
      j++;
      continue;
    }
    let run = 1;
    while (text[j + run] === mark) run++;
    const closes =
      run <= MAX_RUN &&
      !isSpace(text[j - 1] ?? " ") &&
      !(mark === "_" && WORD.test(text[j + run] ?? " "));
    if (closes && run === 1) closers.italic.push(j);
    // In `***x***` the run's last pair closes the bold, leaving `*x*` inside it.
    else if (closes) closers.bold.push(j + run - 2);
    j += run;
  }
  return closers;
}

/** `*x*`, `_x_`, `**x**` or `__x__` from `start`. An underscore after a letter, a digit or a slash
 * (`snake_case`, `site.com/_x_`) and a mark before a space open nothing. */
function readEmphasis(
  text: string,
  start: number,
  closersOf: (mark: string) => Closers,
): { inner: string; bold: boolean; end: number } | null {
  const mark = text[start] ?? "";
  if (mark === "_" && UNDERSCORE_GLUE.test(text[start - 1] ?? " ")) return null;
  const bold = text[start + 1] === mark;
  const from = start + (bold ? 2 : 1);
  const first = text[from];
  if (first === undefined || isSpace(first) || (!bold && first === mark)) return null;
  const closers = closersOf(mark);
  const kind = bold ? "bold" : "italic";
  const list = closers[kind];
  let next = closers.next[kind];
  while ((list[next] ?? Infinity) <= from) next++;
  closers.next[kind] = next;
  const at = list[next];
  if (at === undefined || at - from > EMPHASIS_REACH) return null;
  return { inner: text.slice(from, at), bold, end: at + (bold ? 2 : 1) };
}

/** `/\s/` without a regex call for the ASCII ones, which every scan meets. */
function isSpace(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 128 ? code === 32 || (code >= 9 && code <= 13) : SPACE.test(char);
}
