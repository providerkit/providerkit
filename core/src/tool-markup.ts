// A tool call written into the answer's text instead of the tool-call field.
// It reaches the reader as raw markup, and once it sits in the history the
// model copies it on later turns. Two shapes reach production:
//
// 1. DeepSeek's own special tokens, which open with `<` and a fullwidth
//    vertical line (U+FF5C), as in `<｜tool▁calls▁begin｜>`. What follows one
//    is the vendor's call syntax, never prose, so the rest of the turn's text
//    goes with it.
// 2. A call improvised as a tag, like `<suggest_dossie subjectType="company" />`.
//    The signal is a snake_case name with attributes or a self-closing slash:
//    real markup almost never puts an underscore in a tag name. Only the tag
//    goes, and the prose around it keeps streaming.
import type { Citation } from "./hosted/types.ts";
import type { ProviderChunk } from "./types.ts";

/** How every DeepSeek special token opens: `<` and U+FF5C, written as an
 *  escape because it looks like `|` in most fonts. */
const DEEPSEEK_TOKEN = "<\uFF5C";
/** A whole pseudo tag: a snake_case name with attributes or a self-closing
 *  slash, or a snake_case closing tag. */
const TAG =
  /^<(?:\/[a-z][a-z0-9]*(?:_[a-z0-9]+)+\s*>|[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:\s[^>]*\/?|\/)>)/;
/** Text that may still grow into a tag, or a DeepSeek token, on the next chunk. */
const PARTIAL_TAG = /^<\/?(?:[a-z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:\s[^>]*)?\/?)$/;
/** Held text that already reads as a pseudo tag's start: markup, even unclosed. */
const OPENED_TAG = /^<\/?[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:[\s/]|$)/;
/** The longest text held while it waits for its `>` in a later chunk. A real
 *  leaked tag closes well within it; a tag that arrives whole is caught at any
 *  length. */
const MAX_HELD = 512;

/**
 * Strip tool calls a model wrote into its text, as the stream arrives.
 *
 * ```ts
 * for await (const chunk of stripLeakedToolMarkup(provider.createStream(messages, tools))) {
 *   if (chunk.content) write(chunk.content);
 * }
 * ```
 *
 * A tag can arrive split across chunks, so text that could still become one
 * (`<`, `<suggest_`) is held until the next chunk settles it. Held text goes
 * out before the finish chunk, and before the stream's own error. Only
 * `content` changes: every chunk still passes, in order, with its reasoning,
 * tool calls and usage. A citation whose span reaches text that was removed,
 * or is still held, keeps its source and loses its span, as any span that
 * doesn't check out against the text does.
 *
 * A turn that was nothing but markup comes out with no text. Wrap the result
 * in `requireContent` to have it fail like any other empty turn.
 *
 * `onStrip` runs once for each leak removed, with the markup that set it off: a
 * whole tag, or a DeepSeek token and the rest of the text it arrived in. Text
 * after a DeepSeek token in later chunks goes without another call.
 *
 * ponytail: a leaked call is dropped, not turned into the tool call it meant.
 * A `>` inside an attribute, a paired tag (the text between its tags stays,
 * and so does an opening tag with no attributes), or a tag split across chunks
 * that runs past 512 characters before it closes leaks in part. Count
 * `onStrip` to learn whether recovering the calls is worth building.
 */
export async function* stripLeakedToolMarkup(
  chunks: AsyncIterable<ProviderChunk>,
  opts: { onStrip?: (markup: string) => void } = {},
): AsyncGenerator<ProviderChunk> {
  // Text that could still become markup, waiting for the next chunk.
  let held = "";
  // A DeepSeek token went by: the rest of the turn's text is its syntax.
  let tripped = false;
  // Positions in the source's text, the one a citation's span indexes: how
  // much of it is settled (sent on or removed), and where the first removal
  // began.
  let settled = 0;
  let firstCut: number | undefined;

  function strip(at: number, markup: string): void {
    firstCut ??= at;
    opts.onStrip?.(markup);
  }

  function push(text: string): string {
    if (tripped) {
      settled += text.length;
      return "";
    }
    const base = settled;
    let buf = held + text;
    const length = buf.length;
    held = "";
    const token = buf.indexOf(DEEPSEEK_TOKEN);
    let afterToken = "";
    if (token >= 0) {
      tripped = true;
      afterToken = buf.slice(token);
      buf = buf.slice(0, token);
    }
    let out = "";
    let i = 0;
    while (i < buf.length) {
      const lt = buf.indexOf("<", i);
      if (lt < 0) {
        out += buf.slice(i);
        break;
      }
      out += buf.slice(i, lt);
      const rest = buf.slice(lt);
      const tag = TAG.exec(rest);
      if (tag) {
        strip(base + lt, tag[0]);
        i = lt + tag[0].length;
        continue;
      }
      if (!tripped && rest.length <= MAX_HELD && PARTIAL_TAG.test(rest)) {
        held = rest;
        break;
      }
      out += "<";
      i = lt + 1;
    }
    // Reported after the loop, so leaks are reported in the order they appear.
    if (afterToken) strip(base + token, afterToken);
    settled = base + length - held.length;
    return out;
  }

  /** The held text as a chunk of its own, unless it already reads as markup. */
  function flush(): ProviderChunk[] {
    const tail = held;
    if (!tail) return [];
    held = "";
    const at = settled;
    settled += tail.length;
    // A tag the turn ended inside is still markup: never show it.
    if (OPENED_TAG.test(tail)) {
      strip(at, tail);
      return [];
    }
    return [{ type: "delta", content: tail }];
  }

  /** A span no removal can have moved stays as it is. One that a removal may
   *  have moved is dropped with its anchor, never shifted by a guess. */
  function checked(citation: Citation): Citation {
    const end = citation.end ?? citation.start;
    return end === undefined || end <= (firstCut ?? settled)
      ? citation
      : { source: citation.source };
  }

  try {
    for await (const chunk of chunks) {
      // A delta after the finish lands in a message the reader already closed.
      if (chunk.type === "finish") yield* flush();
      let out = chunk;
      if (chunk.content) {
        const content = push(chunk.content);
        if (content !== chunk.content) out = { ...out, content };
      }
      if (chunk.citations?.length) out = { ...out, citations: chunk.citations.map(checked) };
      yield out;
    }
  } catch (err) {
    // What arrived before the failure is the reader's, as on every wire.
    yield* flush();
    throw err;
  }
  yield* flush();
}
