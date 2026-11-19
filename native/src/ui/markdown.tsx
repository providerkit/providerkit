/**
 * Model text drawn as nested `Text`, from the blocks `markdown.ts` reads. Each block is its own
 * memoized row and keeps its object while a reply streams, so a growing reply renders only its last
 * block again, and a link the reader is pressing in an earlier paragraph stays put.
 *
 * Links open only on a scheme the app allows, through the app's `onLink`. Images stay their alt
 * text unless the app draws them: drawing one makes the phone fetch an address the model chose,
 * and that address can carry what the model saw.
 */
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import type { DisplayPart, SourcePart } from "@providerkit/react/protocol";
import {
  allowedLink,
  continueMarkdown,
  type MarkdownBlock,
  type MarkdownOptions,
  type MarkdownSpan,
  type ParsedMarkdown,
} from "../markdown.ts";
import { part, root, useSkin, type Appearance, type PartProps } from "./classes.tsx";
import {
  defaultChatLabels,
  useLabels,
  type ChatLabelOverrides,
  type ChatLabels,
} from "./labels.ts";

/** The options every message's Markdown shares. Pass them once to `MessageList`, the same object
 * on every render. */
export interface MarkdownSettings extends MarkdownOptions {
  /** Opens an allowed link the person pressed. Without it links stay text. When it throws or
   * rejects, a line under the text says so and shows the address, so the person can still get
   * there. */
  onLink?: (url: string) => void | Promise<unknown>;
  /** Called when the person presses a citation, for an app that shows sources in its own view.
   * Without it, a citation opens its source's address through `onLink`, when the scheme is one
   * `linkSchemes` allows. */
  onCitation?: (source: SourcePart) => void;
  /** Draws an image the model wrote. Without it no image loads, and each shows as its alt text.
   * Only http and https addresses reach it. Return `undefined` to show one as its alt text. */
  renderImage?: (image: { src: string; alt: string }) => ReactNode;
}

export interface MarkdownProps extends MarkdownSettings, Appearance {
  /** The Markdown to draw. */
  text: string;
  /** The message's parts. `[1]` in the text is a citation only when one of these is a `source`
   * with marker `1`; any other marker stays its plain text. Pass `message.parts` as it is. */
  sources?: readonly DisplayPart[];
  /** Words to change, from `markdown`. Keep it the same object between renders. */
  labels?: ChatLabelOverrides;
}

interface Context {
  labels: ChatLabels["markdown"];
  options: MarkdownOptions;
  citations: ReadonlyMap<string, SourcePart>;
  open?: (url: string) => void;
  onCitation: MarkdownSettings["onCitation"];
  renderImage: MarkdownSettings["renderImage"];
}

const MarkdownContext = createContext<Context>({
  labels: defaultChatLabels.markdown,
  options: {},
  citations: new Map(),
  open: undefined,
  onCitation: undefined,
  renderImage: undefined,
});

const NO_PARTS: readonly DisplayPart[] = [];

/** Draws Markdown a model wrote. See the module comment for what it refuses to draw. */
export const Markdown = memo(function Markdown({
  text,
  sources,
  linkSchemes,
  lineBreaks,
  onLink,
  onCitation,
  renderImage,
  labels: overrides,
  className,
  style,
}: MarkdownProps) {
  const skin = useSkin();
  const options = useMemo<MarkdownOptions>(
    () => ({ linkSchemes, lineBreaks }),
    [linkSchemes, lineBreaks],
  );
  const blocks = useBlocks(text, options);
  const citations = useCitations(sources ?? NO_PARTS);
  const { open, failed } = useOpenLink(onLink);
  const labels = useLabels(overrides).markdown;
  const context = useMemo<Context>(
    () => ({ labels, options, citations, open, onCitation, renderImage }),
    [labels, options, citations, open, onCitation, renderImage],
  );
  return (
    <View {...root(part(skin, "markdown", "root"), { className, style })}>
      <MarkdownContext value={context}>
        {blocks.map((block, index) => (
          <Block key={index} block={block} />
        ))}
      </MarkdownContext>
      {failed ? (
        <Text selectable {...part(skin, "markdown", "linkFailed")}>
          {labels.linkFailed(failed)}
        </Text>
      ) : null}
    </View>
  );
});

export function useOpenLink(onLink: MarkdownSettings["onLink"]) {
  const [failed, setFailed] = useState<string>();
  const press = useCallback(
    async (url: string) => {
      setFailed(undefined);
      try {
        await onLink?.(url);
      } catch {
        setFailed(url);
      }
    },
    [onLink],
  );
  return { open: onLink ? press : undefined, failed };
}

/** The blocks of `text`, read again only from the last block when the text only grew. */
function useBlocks(text: string, options: MarkdownOptions): readonly MarkdownBlock[] {
  const [held, setHeld] = useState<ParsedMarkdown>(() =>
    continueMarkdown(undefined, text, options),
  );
  const next = continueMarkdown(held, text, options);
  if (next !== held) setHeld(next);
  return next.blocks;
}

/** A host may write a marker as `1` or as `[1]`. */
function normalizeMarker(marker: string): string {
  const trimmed = marker.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1).trim() : trimmed;
}

function citationMap(parts: readonly DisplayPart[]): Map<string, SourcePart> {
  const map = new Map<string, SourcePart>();
  for (const entry of parts) {
    if (entry.type !== "source" || entry.marker === undefined) continue;
    const marker = normalizeMarker(entry.marker);
    if (marker && !map.has(marker)) map.set(marker, entry);
  }
  return map;
}

function sameCitations(
  held: ReadonlyMap<string, SourcePart>,
  next: ReadonlyMap<string, SourcePart>,
): boolean {
  if (held.size !== next.size) return false;
  for (const [marker, source] of next) if (held.get(marker) !== source) return false;
  return true;
}

/** The citations by marker. A streaming message gets a new parts array with every token, so the
 * map is kept while its sources stay the same: otherwise every block would render again. */
function useCitations(parts: readonly DisplayPart[]): ReadonlyMap<string, SourcePart> {
  const [held, setHeld] = useState(() => ({ parts, citations: citationMap(parts) }));
  if (held.parts === parts) return held.citations;
  const next = citationMap(parts);
  const citations = sameCitations(held.citations, next) ? held.citations : next;
  setHeld({ parts, citations });
  return citations;
}

const Block = memo(function Block({ block }: { block: MarkdownBlock }) {
  const skin = useSkin();
  switch (block.kind) {
    case "paragraph":
      return <Paragraph spans={block.spans} props={part(skin, "markdown", "paragraph")} />;
    case "heading":
      return (
        <Paragraph
          spans={block.spans}
          props={{
            ...part(skin, "markdown", "heading", { level: String(block.level) }),
            accessibilityRole: "header",
          }}
        />
      );
    case "code":
      return (
        <View {...part(skin, "markdown", "code")}>
          <Text selectable {...part(skin, "markdown", "codeText")}>
            {block.text}
          </Text>
        </View>
      );
    case "list":
      return (
        <View {...part(skin, "markdown", "list", { ordered: String(block.ordered) })}>
          {block.items.map((item, index) => (
            <View key={index} {...part(skin, "markdown", "item")}>
              {block.ordered ? (
                <Text {...part(skin, "markdown", "bullet")}>{`${block.start + index}.`}</Text>
              ) : (
                <Text
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  {...part(skin, "markdown", "bullet")}
                >
                  •
                </Text>
              )}
              <Paragraph spans={item} props={part(skin, "markdown", "itemText")} />
            </View>
          ))}
        </View>
      );
  }
});

/** A paragraph's spans in one `Text`. When the app draws images, each image the paragraph holds
 * sits between its words, as its own block, because a drawn image cannot sit inside a line. */
function Paragraph({
  spans,
  props,
}: {
  spans: MarkdownSpan[];
  props: PartProps<"text"> & { accessibilityRole?: "header" };
}) {
  const skin = useSkin();
  const { renderImage, open } = useContext(MarkdownContext);
  if (!renderImage || !spans.some((span) => span.image !== undefined))
    return (
      <Text selectable {...props}>
        <Spans spans={spans} />
      </Text>
    );
  const pieces: ReactNode[] = [];
  let words: MarkdownSpan[] = [];
  const flush = () => {
    if (words.length)
      pieces.push(
        <Text key={pieces.length} selectable {...props}>
          <Spans spans={words} />
        </Text>,
      );
    words = [];
  };
  for (const span of spans) {
    const drawn =
      span.image === undefined ? undefined : renderImage({ src: span.image, alt: span.text });
    if (drawn === undefined) {
      words.push(span);
      continue;
    }
    if (drawn === null) continue;
    flush();
    const href = span.href;
    pieces.push(
      href && open ? (
        <Pressable
          {...part(skin, "markdown", "imageBox")}
          key={pieces.length}
          accessibilityRole="link"
          onPress={() => open(href)}
        >
          {drawn}
        </Pressable>
      ) : (
        <View {...part(skin, "markdown", "imageBox")} key={pieces.length}>
          {drawn}
        </View>
      ),
    );
  }
  flush();
  return <>{pieces}</>;
}

/** Classes and styles of several parts on one `Text`, for a span that is bold and a link at once. */
function merge(...parts: PartProps<"text">[]): PartProps<"text"> {
  const classes = parts.flatMap((props) => (props.className ? [props.className] : []));
  const styles = parts.flatMap((props) => (props.style ? [props.style] : []));
  const merged: PartProps<"text"> = {};
  if (classes.length) merged.className = classes.join(" ");
  if (styles.length) merged.style = styles;
  return merged;
}

/** A block's spans as the children of its `Text`. Nested `Text` inherits the block's style, so a
 * span only adds what it changes. */
function Spans({ spans }: { spans: MarkdownSpan[] }) {
  const skin = useSkin();
  const { citations, labels, open, onCitation, options } = useContext(MarkdownContext);
  return spans.map((span, index) => {
    if (span.cite !== undefined) {
      const marker = normalizeMarker(span.cite);
      const source = citations.get(marker);
      // A marker with no source is ordinary text, like "[sic]", and stays as written.
      if (!source) return span.text;
      const address = source.url === undefined ? null : allowedLink(source.url, options);
      const press = onCitation
        ? () => onCitation(source)
        : address && open
          ? () => open(address)
          : undefined;
      return (
        <Text
          key={index}
          accessibilityRole={press ? "link" : undefined}
          accessibilityLabel={labels.source(marker, source.title)}
          onPress={press}
          {...part(skin, "markdown", "cite")}
        >
          {span.text}
        </Text>
      );
    }
    const looks: PartProps<"text">[] = [];
    if (span.bold) looks.push(part(skin, "markdown", "strong"));
    if (span.italic) looks.push(part(skin, "markdown", "em"));
    if (span.code) looks.push(part(skin, "markdown", "codeSpan"));
    if (span.image !== undefined) looks.push(part(skin, "markdown", "image"));
    if (span.href && open) looks.push(part(skin, "markdown", "link"));
    const words = span.image !== undefined ? span.text || labels.image : span.text;
    const { href } = span;
    if (!href && looks.length === 0) return words;
    return (
      <Text
        key={index}
        accessibilityRole={href && open ? "link" : undefined}
        onPress={href && open ? () => open(href) : undefined}
        {...merge(...looks)}
      >
        {words}
      </Text>
    );
  });
}
