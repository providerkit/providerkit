"use client";
/**
 * The `@providerkit/react/markdown` entry: assistant text drawn as Markdown. It has an entry of
 * its own, so an app that never imports it never loads the parser.
 *
 * Model text is not trusted. A model repeats what it read (a web page, a file, a tool result), so
 * whoever wrote those can write here. Raw HTML shows as text. A link opens only on a scheme the app
 * allows. An image the model wrote stays its alt text until the app opts in, because drawing it
 * makes the reader's browser fetch an address the model may have been steered to write, and that
 * address can carry what the model saw in its query string.
 *
 * Streaming: only the last block is mended for display (an open fence, a half table, a link
 * without its address). The parser reads the whole message so reference definitions also work
 * across blocks and inside containers. Its output is split into memoized blocks: unchanged blocks
 * keep their mounted components, so a growing tail does not re-render them or steal link focus.
 */
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentProps, MouseEvent, ReactNode, RefObject } from "react";
import ReactMarkdown from "react-markdown";
import type { Components, ExtraProps, Options, UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DisplayPart, SourcePart } from "./protocol.ts";

/** Turns one finished code block into highlighted nodes, drawn inside its `<code>` element. Return
 * them, or a promise of them. The plain code stays on screen until a promise resolves, and stays
 * for good when it rejects, throws or returns nothing. */
export type Highlighter = (
  code: string,
  language: string | undefined,
) => ReactNode | PromiseLike<ReactNode>;

/** Every word the renderer shows or reads out. Pass only the ones to change. */
export interface MarkdownLabels {
  /** The copy button on a code block. */
  copy: string;
  /** The copy button while the browser is writing to the clipboard. */
  copying: string;
  /** The copy button for a moment after the code was copied. */
  copied: string;
  /** The copy button when the browser refused to copy. */
  copyFailed: string;
  /** Read out when the browser refused to copy. The code is selected at that point. */
  copyFailedHelp: string;
  /** Read out with a link that opens in a new tab. An empty string says nothing. */
  newTab: string;
  /** Shown for a blocked image that has no alt text. */
  image: string;
  /** What a screen reader calls a citation, from its marker and its source's title. */
  source: (marker: string, title: string) => string;
  /** The hidden heading above a text's footnotes. */
  footnotes: string;
  /** The link from a footnote back to where the text cites it. */
  footnoteBack: string;
}

export const defaultMarkdownLabels: Readonly<MarkdownLabels> = Object.freeze({
  copy: "Copy",
  copying: "Copying...",
  copied: "Copied",
  copyFailed: "Copy failed",
  copyFailedHelp: "Copy failed. The code is selected, so you can copy it with your keyboard.",
  newTab: "Opens in a new tab",
  image: "Image",
  source: (marker: string, title: string) => `Source ${marker}: ${title}`,
  footnotes: "Footnotes",
  footnoteBack: "Back to the text",
});

/** The schemes a link may use when the app says nothing. */
export const defaultLinkSchemes: readonly string[] = Object.freeze(["http", "https", "mailto"]);

/** One link the model wrote, as a link policy sees it. */
export interface MarkdownLink {
  /** The address, read the way a browser reads it. */
  href: string;
  /** The scheme in lower case, without the colon: `"https"`. Empty for an address inside the
   * app, such as `/pricing` or `#top`. */
  scheme: string;
  /** Whether `linkSchemes` has the scheme. An address inside the app is never on it. */
  allowed: boolean;
}

/** What a link becomes. `"link"` is an ordinary link, `"text"` is its text with no link, and
 * `{ onClick }` is a link whose clicks the app handles: call `event.preventDefault()` in it to
 * route inside the app or to ask first. Without that call, the browser follows the link. */
export type LinkDecision =
  | "link"
  | "text"
  | { onClick: (event: MouseEvent<HTMLAnchorElement>) => void };

/** One image the model wrote, as an image callback sees it. */
export interface MarkdownImage {
  /** The address, read the way a browser reads it. */
  src: string;
  alt: string;
  /** The scheme in lower case, without the colon. Empty for an address without one. */
  scheme: string;
}

export interface MarkdownProps {
  /** The Markdown to draw. */
  text: string;
  /** True while the text is still arriving. The last block then closes what the model has not
   * finished yet, so raw syntax never flashes, and its code is not highlighted until it settles. */
  streaming?: boolean;
  /** The message's parts. `[1]` in the text becomes a citation only when one of these is a
   * `source` part with marker `1`; any other marker stays plain text. Other parts are ignored, so
   * `message.parts` can be passed as it is. */
  sources?: readonly DisplayPart[];
  /** The schemes a link may use. This replaces the list, so keep the defaults by spreading
   * them: `[...defaultLinkSchemes, "tel"]`. */
  linkSchemes?: readonly string[];
  /** Decides what each link becomes, for routing inside the app or asking before leaving it.
   * Return nothing to keep the default: a link when its scheme is allowed, its text when not.
   * A `javascript:`, `vbscript:` or `data:` address, or one that starts with `//` and so leaves
   * the app while looking like a path, is always text and never reaches this function. Called
   * while drawing, so keep it fast and keep its identity stable. */
  linkPolicy?: (link: MarkdownLink) => LinkDecision | undefined;
  /** Whether to draw the images the model wrote. Off by default: each one is a request to an
   * address the model chose, and its alt text is shown instead. `true` draws http and https
   * images. A function decides per image. */
  images?: boolean | ((image: MarkdownImage) => boolean);
  /** Highlights code blocks once they are finished. Keep its identity stable: a new function
   * highlights every block again. */
  highlight?: Highlighter;
  /** When set, each citation is a button that calls this, for an app that shows sources in its
   * own panel. Without it, a citation links to its source's address. */
  onCitation?: (source: SourcePart) => void;
  /** Replaces any of `defaultMarkdownLabels`. Keep its identity stable, like the callbacks: a new
   * object re-renders every link and code block. */
  labels?: Partial<MarkdownLabels>;
}

/** What the elements inside the parsed blocks read. They live at module scope, so their identity
 * never changes and React never remounts a link the reader has focused. They take their options
 * from here instead of from closures. */
interface Settings {
  labels: MarkdownLabels;
  schemes: ReadonlySet<string>;
  linkPolicy: MarkdownProps["linkPolicy"];
  images: NonNullable<MarkdownProps["images"]>;
  highlight: Highlighter | undefined;
  onCitation: MarkdownProps["onCitation"];
  /** The id of the hidden sentence that tells a screen reader a link opens in a new tab. */
  newTabHint: string | undefined;
}

const SettingsContext = createContext<Settings>({
  labels: defaultMarkdownLabels,
  schemes: new Set(defaultLinkSchemes),
  linkPolicy: undefined,
  images: false,
  highlight: undefined,
  onCitation: undefined,
  newTabHint: undefined,
});

/** Apart from the settings, so a citation can re-render alone when its source arrives. */
const CitationContext = createContext<ReadonlyMap<string, SourcePart>>(new Map());

/** True inside the block that is still arriving. */
const LiveContext = createContext(false);

type Plugins = NonNullable<Options["rehypePlugins"]>;
type RehypeOptions = NonNullable<Options["remarkRehypeOptions"]>;

/** Draws Markdown the model wrote. See the module comment for what it refuses to draw. */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  sources,
  linkSchemes = defaultLinkSchemes,
  linkPolicy,
  images = false,
  highlight,
  onCitation,
  labels,
}: MarkdownProps) {
  // Footnote ids and the new-tab hint must not collide with another message on the same page.
  const prefix = `pk-md-${useId().replace(/[^\w-]/g, "")}-`;
  const merged = useMemo(() => ({ ...defaultMarkdownLabels, ...labels }), [labels]);
  // Keyed by the names rather than the array, so a list written inline in the app's JSX is not a
  // change on every render.
  const schemeKey = linkSchemes.join(" ").toLowerCase();
  const schemes = useMemo(
    () => new Set(schemeKey.split(" ").map((scheme) => scheme.replace(/:$/, ""))),
    [schemeKey],
  );
  const newTabHint = merged.newTab ? `${prefix}new-tab` : undefined;
  const settings = useMemo<Settings>(
    () => ({ labels: merged, schemes, linkPolicy, images, highlight, onCitation, newTabHint }),
    [merged, schemes, linkPolicy, images, highlight, onCitation, newTabHint],
  );
  const citations = useCitations(sources);
  const remarkPlugins = useMemo<Plugins>(
    () => [remarkGfm, [remarkStreaming, { streaming, text }]],
    [streaming, text],
  );
  const rehypePlugins = useMemo<Plugins>(() => [[rehypeMarkdown, prefix]], [prefix]);
  const footnoteLabel = merged.footnotes;
  const footnoteBackLabel = merged.footnoteBack;
  const remarkRehypeOptions = useMemo<RehypeOptions>(
    () => ({
      clobberPrefix: prefix,
      footnoteLabel,
      footnoteBackLabel,
      // The parser's default class, `sr-only`, exists only in apps that define it.
      footnoteLabelProperties: { className: ["pk-md-sr"] },
    }),
    [prefix, footnoteLabel, footnoteBackLabel],
  );

  return (
    <div className="pk-md" data-state={streaming ? "streaming" : "settled"}>
      <SettingsContext value={settings}>
        <CitationContext value={citations}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            remarkRehypeOptions={remarkRehypeOptions}
            components={COMPONENTS}
            urlTransform={keepUrl}
          >
            {text}
          </ReactMarkdown>
        </CitationContext>
      </SettingsContext>
      {newTabHint ? (
        <span id={newTabHint} className="pk-md-hint" hidden>
          {merged.newTab}
        </span>
      ) : null}
    </div>
  );
});

/** The parser's wrapper is only a memo boundary, not another DOM element. Compare the parsed
 * content, not just its source: a definition arriving later can change an earlier reference.
 * Unchanged blocks keep their children, including focused links and pending clipboard writes. */
const Block = memo(
  function Block({ node, children }: ComponentProps<"div"> & ExtraProps) {
    return <LiveContext value={node?.properties.dataLive === true}>{children}</LiveContext>;
  },
  (before, after) =>
    before.node?.properties.dataContent === after.node?.properties.dataContent &&
    before.node?.properties.dataLive === after.node?.properties.dataLive,
);

/** Leaves a link's and an image's address as written, for the policy in their components to judge.
 * The parser's own filter would turn a refused link into `href=""`, which still navigates. Any
 * other address attribute is dropped, so nothing reaches the page unjudged. */
const keepUrl: UrlTransform = (url, key, node) =>
  (key === "href" && node.tagName === "a") || (key === "src" && node.tagName === "img")
    ? url
    : undefined;

// ---- Links ----

/** Schemes that run code or show content the model wrote as if a site sent it. */
const UNSAFE_SCHEMES = new Set(["javascript", "vbscript", "data"]);
const SCHEME = /^([a-z][a-z\d+.-]*):/i;
/** `//host/path` and its backslash spellings, which browsers read the same way. */
const OTHER_HOST = /^[\\/]{2}/;

/** The address the way a browser reads it: it trims control characters and spaces around it and
 * drops tabs and line breaks inside it, so `java\nscript:` runs as `javascript:`. */
function cleanUrl(url: string): string {
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= 0x20) start++;
  while (end > start && url.charCodeAt(end - 1) <= 0x20) end--;
  return url.slice(start, end).replace(/[\t\n\r]/g, "");
}

function schemeOf(url: string): string {
  return SCHEME.exec(url)?.[1]?.toLowerCase() ?? "";
}

/** The link as a policy sees it, or `undefined` for an address that stays text whatever a policy
 * says: a host that allows "any address in the app" must not let `//evil.example` through. */
function readLink(href: string, schemes: ReadonlySet<string>): MarkdownLink | undefined {
  const clean = cleanUrl(href);
  const scheme = schemeOf(clean);
  if (UNSAFE_SCHEMES.has(scheme) || (scheme === "" && OTHER_HOST.test(clean))) return undefined;
  return { href: clean, scheme, allowed: scheme !== "" && schemes.has(scheme) };
}

function decideLink(link: MarkdownLink | undefined, policy: Settings["linkPolicy"]): LinkDecision {
  if (!link) return "text";
  return policy?.(link) ?? (link.allowed ? "link" : "text");
}

/** What every link the renderer draws carries. Only http and https open a new tab: a mail link or
 * an app's own route has no page to keep the conversation open beside. */
function anchorProps(
  link: MarkdownLink,
  decision: Exclude<LinkDecision, "text">,
  newTabHint: string | undefined,
): ComponentProps<"a"> {
  const external = link.scheme === "http" || link.scheme === "https";
  return {
    href: link.href,
    rel: "noopener noreferrer",
    target: external ? "_blank" : undefined,
    "aria-describedby": external ? newTabHint : undefined,
    onClick: typeof decision === "object" ? decision.onClick : undefined,
  };
}

function Anchor({ node, href, title, children, ...rest }: ComponentProps<"a"> & ExtraProps) {
  const { schemes, linkPolicy, newTabHint } = useContext(SettingsContext);
  const properties = node?.properties;
  // The parser builds footnote links from a footnote's label, never from an address the model
  // wrote, and they point inside this text.
  if (properties?.dataFootnoteRef !== undefined || properties?.dataFootnoteBackref !== undefined) {
    return (
      <a href={href} title={title} {...rest}>
        {children}
      </a>
    );
  }
  const link = readLink(href ?? "", schemes);
  const decision = decideLink(link, linkPolicy);
  if (!link || decision === "text") {
    return (
      <span className="pk-md-a" data-state="blocked">
        {children}
      </span>
    );
  }
  return (
    <a className="pk-md-a" title={title} {...anchorProps(link, decision, newTabHint)}>
      {children}
    </a>
  );
}

// ---- Images ----

function readImage(src: string, alt: string): MarkdownImage | undefined {
  const clean = cleanUrl(src);
  const scheme = schemeOf(clean);
  return scheme === "javascript" || scheme === "vbscript" ? undefined : { src: clean, alt, scheme };
}

function showImage(image: MarkdownImage | undefined, images: Settings["images"]): boolean {
  if (!image) return false;
  if (typeof images === "function") return images(image);
  return images && (image.scheme === "http" || image.scheme === "https");
}

function Img({ src, alt, title }: ComponentProps<"img"> & ExtraProps) {
  const { images, labels } = useContext(SettingsContext);
  const image = readImage(typeof src === "string" ? src : "", alt ?? "");
  if (!image || !showImage(image, images)) {
    return (
      <span className="pk-md-img" data-state="blocked">
        {alt || labels.image}
      </span>
    );
  }
  return (
    <img
      className="pk-md-img"
      src={image.src}
      alt={image.alt}
      title={title}
      loading="lazy"
      decoding="async"
      // The image host learns nothing about the page the conversation is on.
      referrerPolicy="no-referrer"
    />
  );
}

// ---- Code blocks ----

type HastElement = NonNullable<ExtraProps["node"]>;
type HastNode = HastElement["children"][number];

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value;
  return node.type === "element" ? node.children.map(textOf).join("") : "";
}

function readCode(pre: HastElement | undefined): { code: string; language: string | undefined } {
  const element = pre?.children.find(
    (child): child is HastElement => child.type === "element" && child.tagName === "code",
  );
  if (!element) return { code: "", language: undefined };
  const classes = element.properties.className;
  const name = Array.isArray(classes)
    ? classes.find(
        (value): value is string => typeof value === "string" && value.startsWith("language-"),
      )
    : undefined;
  // The parser ends every code block with a line break the model did not write.
  const text = textOf(element);
  return {
    code: text.endsWith("\n") ? text.slice(0, -1) : text,
    language: name?.slice("language-".length),
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<ReactNode> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function isBlank(node: unknown): boolean {
  return node === undefined || node === null || typeof node === "boolean" || node === "";
}

function tryHighlight(
  highlight: Highlighter,
  code: string,
  language: string | undefined,
): ReactNode | PromiseLike<ReactNode> {
  try {
    const result = highlight(code, language);
    // Effects do not run during SSR or an abandoned render. Handle rejection as soon as the
    // promise exists, so a missing grammar cannot become an unhandled server error.
    return isPromiseLike(result) ? Promise.resolve(result).catch(() => undefined) : result;
  } catch {
    // A highlighter that throws leaves the plain block, never a blank one.
    return undefined;
  }
}

type CodeState = "streaming" | "plain" | "highlighting" | "highlighted";

interface Highlighted {
  code: string;
  language: string | undefined;
  node: ReactNode;
}

function useHighlight(
  code: string,
  language: string | undefined,
  highlight: Highlighter | undefined,
  live: boolean,
): { state: CodeState; node?: ReactNode } {
  // Called while rendering, so a synchronous highlighter paints on the first frame and on the
  // server. Never on the block still arriving: it changes with every token, and highlighting it
  // would run the app's highlighter per token and swap colors under the reader.
  const result = useMemo(
    () => (live || !highlight ? undefined : tryHighlight(highlight, code, language)),
    [live, highlight, code, language],
  );
  const [done, setDone] = useState<Highlighted | undefined>(undefined);
  useEffect(() => {
    if (!isPromiseLike(result)) return;
    let current = true;
    result.then((node) => {
      if (current) setDone({ code, language, node });
    });
    return () => {
      current = false;
    };
  }, [result, code, language]);

  if (live) return { state: "streaming" };
  if (!highlight) return { state: "plain" };
  if (!isPromiseLike(result)) {
    return isBlank(result) ? { state: "plain" } : { state: "highlighted", node: result };
  }
  // A new promise for code already highlighted (a new highlighter, a theme change) keeps the old
  // colors until it resolves, instead of flashing back to plain.
  if (done && done.code === code && done.language === language) {
    return isBlank(done.node) ? { state: "plain" } : { state: "highlighted", node: done.node };
  }
  return { state: "highlighting" };
}

function CodeBlock({ node }: ComponentProps<"pre"> & ExtraProps) {
  const { highlight, labels } = useContext(SettingsContext);
  const live = useContext(LiveContext);
  const { code, language } = readCode(node);
  const shown = useHighlight(code, language, highlight, live);
  const codeRef = useRef<HTMLElement>(null);
  return (
    <div className="pk-md-codeblock" data-state={shown.state} data-language={language}>
      <div className="pk-md-codeblock-bar">
        {language ? <span className="pk-md-codeblock-language">{language}</span> : null}
        <CopyButton code={code} target={codeRef} labels={labels} />
      </div>
      <pre className="pk-md-pre">
        <code
          ref={codeRef}
          className={
            language ? `pk-md-codeblock-code language-${language}` : "pk-md-codeblock-code"
          }
        >
          {shown.node ?? code}
        </code>
      </pre>
    </div>
  );
}

type CopyState = "idle" | "copying" | "copied" | "failed";

const COPIED_MS = 2000;

/** `navigator.clipboard` is missing outside a secure context, and its promise rejects when the
 * page may not write to the clipboard. Called inside the click, because some browsers allow a
 * write only while the click is being handled. */
function writeClipboard(text: string): Promise<void> {
  try {
    return navigator.clipboard.writeText(text);
  } catch (error) {
    return Promise.reject(error);
  }
}

function CopyButton({
  code,
  target,
  labels,
}: {
  code: string;
  target: RefObject<HTMLElement | null>;
  labels: MarkdownLabels;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const pending = useRef(false);
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = () => {
    // A ref closes the gap before React paints the pending state. aria-disabled, rather than
    // disabled, keeps keyboard focus on the button while the browser finishes the write.
    if (pending.current) return;
    pending.current = true;
    setState("copying");
    writeClipboard(code).then(
      () => {
        pending.current = false;
        setState("copied");
      },
      () => {
        pending.current = false;
        // Selecting the code leaves the reader one keyboard shortcut from a copy, instead of
        // with an error and nothing to do about it.
        const element = target.current;
        if (element) window.getSelection()?.selectAllChildren(element);
        setState("failed");
      },
    );
  };

  const names: Record<CopyState, string> = {
    idle: labels.copy,
    copying: labels.copying,
    copied: labels.copied,
    failed: labels.copyFailed,
  };
  let announcement = names[state];
  if (state === "idle") announcement = "";
  else if (state === "failed") announcement = labels.copyFailedHelp;
  return (
    <>
      <button
        type="button"
        className="pk-md-copy"
        data-state={state}
        aria-disabled={state === "copying"}
        aria-busy={state === "copying"}
        onClick={copy}
      >
        {names[state]}
      </button>
      <span role="status" className="pk-md-sr">
        {announcement}
      </span>
    </>
  );
}

/** A wide table scrolls inside its own box instead of widening the message. */
function Table({ node: _node, ...props }: ComponentProps<"table"> & ExtraProps) {
  return (
    <div className="pk-md-table-scroll">
      <table {...props} />
    </div>
  );
}

// ---- Citations ----

const NO_PARTS: readonly DisplayPart[] = [];

/** A host may write the marker as `1` or as `[1]`. */
function normalizeMarker(marker: string): string {
  const trimmed = marker.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1).trim() : trimmed;
}

function citationMap(parts: readonly DisplayPart[]): Map<string, SourcePart> {
  const map = new Map<string, SourcePart>();
  for (const part of parts) {
    if (part.type !== "source" || part.marker === undefined) continue;
    const marker = normalizeMarker(part.marker);
    if (marker && !map.has(marker)) map.set(marker, part);
  }
  return map;
}

function sameCitations(
  held: ReadonlyMap<string, SourcePart>,
  next: ReadonlyMap<string, SourcePart>,
): boolean {
  if (held.size !== next.size) return false;
  for (const [marker, source] of next) {
    const old = held.get(marker);
    if (
      !old ||
      old.id !== source.id ||
      old.title !== source.title ||
      old.url !== source.url ||
      old.snippet !== source.snippet
    )
      return false;
  }
  return true;
}

/** The message's citations by marker. A streaming message gets a new parts array with every
 * token, so the map is kept while its sources stay the same: otherwise every citation on screen
 * would re-render with each token. */
function useCitations(parts: readonly DisplayPart[] = NO_PARTS): ReadonlyMap<string, SourcePart> {
  const [held, setHeld] = useState(() => ({ parts, citations: citationMap(parts) }));
  if (held.parts !== parts) {
    const next = citationMap(parts);
    setHeld({ parts, citations: sameCitations(held.citations, next) ? held.citations : next });
  }
  return held.citations;
}

function Citation({ node, children }: ComponentProps<"cite"> & ExtraProps) {
  const { labels, schemes, linkPolicy, onCitation, newTabHint } = useContext(SettingsContext);
  const citations = useContext(CitationContext);
  const marker = node?.properties.dataMarker;
  const source = typeof marker === "string" ? citations.get(marker) : undefined;
  // A marker with no source is ordinary text, like "[sic]", and stays exactly as written.
  if (typeof marker !== "string" || !source) return children;
  const label = labels.source(marker, source.title);
  if (onCitation) {
    return (
      <button
        type="button"
        className="pk-md-cite"
        aria-label={label}
        title={source.title}
        onClick={() => onCitation(source)}
      >
        {children}
      </button>
    );
  }
  // The host supplied the address, but it may have copied it from a page the model read.
  const link = source.url === undefined ? undefined : readLink(source.url, schemes);
  const decision = decideLink(link, linkPolicy);
  if (!link || decision === "text") {
    return (
      <span className="pk-md-cite" title={source.title}>
        {children}
      </span>
    );
  }
  return (
    <a
      className="pk-md-cite"
      title={source.title}
      aria-label={label}
      {...anchorProps(link, decision, newTabHint)}
    >
      {children}
    </a>
  );
}

// Module scope, so React keeps each element's identity across re-parses.
const COMPONENTS: Components = {
  a: Anchor,
  img: Img,
  pre: CodeBlock,
  table: Table,
  cite: Citation,
  div: Block,
};

// ---- The tree pass ----

/** One citation candidate: a marker of up to 32 characters in brackets, with no brackets inside
 * and no space at either end, so `[ ]` and `[a [b] c]` are not candidates. */
const MARKER = /\[([^[\]\s](?:[^[\]\n]{0,30}[^[\]\s])?)\]/g;
/** No citation inside a link (a link in a link is not allowed) or in code (it shows what it says). */
const NO_CITATIONS = new Set(["a", "code", "pre"]);

/**
 * One pass over the parsed tree. Every element gets a `pk-md-<tag>` class, so app styles reach
 * each element without a descendant selector that would also hit what a highlighter draws. Each
 * `[marker]` in the text becomes a `cite` candidate, which the `cite` component resolves against
 * the sources. Resolving there rather than here means a source that arrives after the text
 * re-renders its citations without parsing any block again.
 */
function rehypeMarkdown(prefix: string) {
  return (tree: { children: HastNode[] }, file: MarkdownFile) => {
    const liveStart = typeof file.data.pkLiveStart === "number" ? file.data.pkLiveStart : undefined;
    tree.children = visit(tree.children, prefix, true).map((node): HastNode => ({
      type: "element",
      tagName: "div",
      properties: {
        dataContent: JSON.stringify(node),
        dataLive: liveStart !== undefined && (node.position?.end.offset ?? 0) > liveStart,
      },
      children: [node],
    }));
  };
}

function visit(nodes: readonly HastNode[], prefix: string, cite: boolean): HastNode[] {
  return nodes.flatMap((node): HastNode[] => {
    if (node.type === "text") return cite ? splitMarkers(node.value) : [node];
    if (node.type !== "element") return [node];
    tag(node, prefix);
    node.children = visit(node.children, prefix, cite && !NO_CITATIONS.has(node.tagName));
    return [node];
  });
}

function tag(node: HastElement, prefix: string): void {
  const { properties } = node;
  const classes = Array.isArray(properties.className) ? properties.className : [];
  properties.className = [...classes, `pk-md-${node.tagName}`];
  // The parser gives the footnotes heading one id in every message. This text's prefix makes it
  // unique, like the parser already does for the footnotes themselves.
  const label = "footnote-label";
  if (properties.id === label) properties.id = `${prefix}${label}`;
  const described = properties.ariaDescribedBy;
  if (Array.isArray(described)) {
    properties.ariaDescribedBy = described.map((id) => (id === label ? `${prefix}${label}` : id));
  }
}

function splitMarkers(value: string): HastNode[] {
  const nodes: HastNode[] = [];
  let from = 0;
  for (const match of value.matchAll(MARKER)) {
    if (match.index > from) nodes.push({ type: "text", value: value.slice(from, match.index) });
    nodes.push({
      type: "element",
      tagName: "cite",
      properties: { dataMarker: match[1] },
      children: [{ type: "text", value: match[0] }],
    });
    from = match.index + match[0].length;
  }
  if (from < value.length) nodes.push({ type: "text", value: value.slice(from) });
  return nodes;
}

// ---- The block still arriving ----

interface MarkdownNode {
  type: string;
  position?: HastNode["position"];
  children?: MarkdownNode[];
}

interface MarkdownRoot extends MarkdownNode {
  children: MarkdownNode[];
}

interface MarkdownFile {
  data: Record<string, unknown>;
}

/** Use the parser's block boundaries, not indentation guesses: four spaces can mean literal code
 * or a continuation of a paragraph, including a link destination. The same parser also owns
 * document-wide references, so repairing the live tail never splits definitions from their uses. */
function remarkStreaming(
  this: { parse: (source: string) => MarkdownNode },
  { streaming, text }: { streaming: boolean; text: string },
) {
  return (tree: MarkdownRoot, file: MarkdownFile) => {
    if (!streaming) return;
    const tail = tree.children.at(-1);
    const start = tail?.position?.start.offset ?? text.length;
    file.data.pkLiveStart = start;
    let lastBlock = tail;
    while (
      lastBlock?.children?.length &&
      lastBlock.type !== "paragraph" &&
      lastBlock.type !== "heading"
    ) {
      lastBlock = lastBlock.children.at(-1);
    }
    const blockStart = lastBlock?.position?.start.offset ?? start;
    // An indented code block has no fence. Do not add inline syntax to it or hide literal backticks.
    if (
      lastBlock?.type === "code" &&
      !fenceOpenedBy(text.slice(blockStart).split("\n", 1)[0] ?? "")
    ) {
      return;
    }
    const inlineStart =
      lastBlock?.type === "paragraph" || lastBlock?.type === "heading"
        ? blockStart - start
        : undefined;
    const shown = mendTail(text.slice(start), inlineStart);
    const next = text.slice(0, start) + shown;
    return next === text ? undefined : this.parse(next);
  };
}

// A backtick fence's info string cannot hold a backtick: "```a`b`" is inline code, not a fence.
const FENCE_OPEN = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/;

function fenceOpenedBy(line: string): string | undefined {
  const match = FENCE_OPEN.exec(line);
  return match?.[1] ?? match?.[2];
}

const EMPTY_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]*$/;

// The block still arriving looks for fences more widely than the splitter does: after a list or
// quote marker on the same line, and at any depth. Taking a line for code by mistake only skips a
// fix below, while missing a fence would let a fix write a backtick or `**` into someone's code
// (`def f(**kwargs):`). Only one quantifier can take each run of spaces, so a long line of model
// text cannot make these patterns backtrack.
const TAIL_FENCE_OPEN =
  /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]*)*(?:(`{3,})[^`]*|(~{3,}).*)$/;
const TAIL_FENCE_CLOSE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[ \t]*$/;
const PARTIAL_CLOSE = /^[ \t]*(?:>[ \t]*)*(`+|~+)[ \t]*$/;

function openFence(lines: readonly string[]): { marker: string; line: number } | undefined {
  let open: { marker: string; line: number } | undefined;
  for (const [index, line] of lines.entries()) {
    if (open) {
      if (TAIL_FENCE_CLOSE.exec(line)?.[1]?.startsWith(open.marker)) open = undefined;
      continue;
    }
    const match = TAIL_FENCE_OPEN.exec(line);
    const marker = match?.[1] ?? match?.[2];
    if (marker) open = { marker, line: index };
  }
  return open;
}

/**
 * The last block of a streaming text, as it should look right now. Each fix hides syntax the model
 * has started but not finished, which would otherwise show as raw characters and then vanish a
 * token later. The result is only drawn, never stored: once the text settles, it renders as written.
 */
function mendTail(block: string, inlineStart: number | undefined): string {
  // One line break at the end only ends a line: the paragraph above it is still open.
  const newline = block.endsWith("\n") ? "\n" : "";
  const lines = block.slice(0, block.length - newline.length).split("\n");
  const last = lines.length - 1;

  const fence = openFence(lines);
  if (fence) {
    // CommonMark draws an open fence as code to the end of the block, so nothing needs closing.
    // Two lines still being typed would flash: the fence line while its language arrives, and a
    // closing fence that is not full length yet, which shows as a line of code.
    const typing =
      newline === "" && (fence.line === last || isPartialClose(lines[last] ?? "", fence.marker));
    return typing ? lines.slice(0, last).join("\n") : block;
  }

  // A soft newline does not end a link or a code span. Mend the parser's whole live paragraph,
  // never literal code that may sit above it in the same list item or quote.
  const mended =
    inlineStart === undefined
      ? lines
      : (
          block.slice(0, inlineStart) +
          mendInline(block.slice(inlineStart, block.length - newline.length))
        ).split("\n");
  let start = mended.length;
  while (start > 0 && (mended[start - 1] ?? "").trim() !== "") start--;
  // A blank line ends the paragraph: the model left whatever is open in it open.
  if (start === mended.length) return block;
  let paragraph = mended.slice(start);
  // A list marker with no text yet turns the line above it into a heading (`-`) or shows as text
  // (`*`, `1.`) until the item's first word arrives.
  if (EMPTY_ITEM.test(paragraph[paragraph.length - 1] ?? "")) paragraph = paragraph.slice(0, -1);
  paragraph = mendTable(paragraph);
  return [...mended.slice(0, start), ...paragraph].join("\n") + newline;
}

function isPartialClose(line: string, marker: string): boolean {
  const run = PARTIAL_CLOSE.exec(line)?.[1];
  return run !== undefined && run[0] === marker[0] && run.length < marker.length;
}

const TABLE_ROW = /^ {0,3}\|/;
/** A line that can only be part of a delimiter row: pipes, colons, dashes and spaces. */
const DELIMITER_LINE = /^[\s|:-]*$/;
const DELIMITER_CELL = /^\s*:?-+:?\s*$/;

/** The cells of a table row, split on pipes that are not escaped. */
function cellsOf(row: string): string[] {
  let line = row.trim();
  if (line.startsWith("|")) line = line.slice(1);
  if (line.endsWith("|") && !line.endsWith("\\|")) line = line.slice(0, -1);
  return line === "" ? [] : line.split(/(?<!\\)\|/);
}

/**
 * GFM draws a table only once its delimiter row has one cell per header cell. Until then the
 * header shows as a line of pipes. So while the table is being written, a missing or short
 * delimiter row is drawn complete, with the header's width.
 */
function mendTable(lines: string[]): string[] {
  let start = lines.length;
  while (start > 0 && TABLE_ROW.test(lines[start - 1] ?? "")) start--;
  const header = lines[start];
  if (header === undefined) return lines;
  const width = cellsOf(header).length;
  const delimiter = lines[start + 1];
  if (delimiter !== undefined) {
    if (!DELIMITER_LINE.test(delimiter)) return lines;
    const cells = cellsOf(delimiter);
    if (cells.length === width && cells.every((cell) => DELIMITER_CELL.test(cell))) return lines;
    // Rows below a delimiter that does not fit: this is not a table being written.
    if (lines.length > start + 2) return lines;
  }
  // A lone pipe has no cell to draw yet.
  if (width === 0) return lines.slice(0, start);
  return [...lines.slice(0, start + 1), `|${" --- |".repeat(width)}`];
}

/** Hides what is inside code spans behind letters, so the checks below skip it and every index
 * still points at the same character of the line. Also returns a span that is still open. */
function maskCode(line: string): { masked: string; open?: { index: number; run: string } } {
  let masked = "";
  let from = 0;
  let open: { index: number; run: string } | undefined;
  for (const match of line.matchAll(/`+/g)) {
    if (!open) {
      open = { index: match.index, run: match[0] };
      continue;
    }
    // A span closes only on a run of the same length.
    if (match[0].length !== open.run.length) continue;
    const end = match.index + match[0].length;
    masked += line.slice(from, open.index) + "x".repeat(end - open.index);
    from = end;
    open = undefined;
  }
  if (!open) return { masked: masked + line.slice(from) };
  return {
    masked: masked + line.slice(from, open.index) + "x".repeat(line.length - open.index),
    open,
  };
}

/** The live paragraph, including soft newlines within inline constructs. */
function mendInline(line: string): string {
  return closeStrong(closeCode(closeLink(line)));
}

/** A link whose address is still arriving shows as its text, and an image as its alt text. A
 * link to half an address would open the wrong page, and the raw brackets would flash. */
function closeLink(line: string): string {
  const { masked } = maskCode(line);
  const middle = masked.lastIndexOf("](");
  if (middle < 0) return line;
  let depth = 1;
  for (let index = middle + 2; index < masked.length; index++) {
    const char = masked[index];
    if (char === "\\") index++;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return line;
  }
  let nested = 0;
  for (let index = middle - 1; index >= 0; index--) {
    const char = masked[index];
    if (masked[index - 1] === "\\") continue;
    if (char === "]") nested++;
    else if (char === "[" && nested > 0) nested--;
    else if (char === "[") {
      const start = masked[index - 1] === "!" ? index - 1 : index;
      return line.slice(0, start) + line.slice(index + 1, middle);
    }
  }
  return line;
}

/** Inline code still open is drawn closed. A run with nothing after it yet is hidden: closed, it
 * would be an empty pair of backticks. */
function closeCode(line: string): string {
  const { open } = maskCode(line);
  if (!open) return line;
  const after = open.index + open.run.length;
  return after === line.length ? line.slice(0, open.index) : line + open.run;
}

/** Bold still open is drawn closed, before any trailing space, since `**bold **` stays raw. A
 * single `*` at the end is the first half of the closing pair, so it is dropped first. */
function closeStrong(line: string): string {
  const { masked } = maskCode(line);
  const runs = [...masked.matchAll(/\*\*/g)];
  const opener = runs.length % 2 === 1 ? runs[runs.length - 1]?.index : undefined;
  if (opener === undefined) return line;
  const after = line.slice(opener + 2);
  if (after.trim() === "") return line.slice(0, opener) + after;
  const body = line.trimEnd();
  const kept = body.endsWith("*") && !body.endsWith("**") ? body.slice(0, -1) : body;
  return `${kept}**${line.slice(body.length)}`;
}
