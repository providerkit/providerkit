// A tool call written into the answer's text instead of the tool-call field.
// It reaches the reader as raw markup, and once it sits in the history the
// model copies it on later turns. Two shapes reach production:
//
// 1. DeepSeek's own special tokens, which open with `<` and a fullwidth
//    vertical line (U+FF5C), as in `<｜tool▁calls▁begin｜>`. What follows one
//    is the vendor's call syntax, never prose, so the rest of the turn's text
//    goes with it.
// 2. A call improvised as a tag, like `<suggest_dossie subjectType="company" />`.
//    The signal is a snake_case name, then an attribute (`name=`) or a
//    self-closing slash: real markup almost never puts an underscore in a tag
//    name. Only the tag goes, with its closing tag when it opens a pair, and
//    the prose around it keeps streaming.
//
// A false match deletes the reader's words, so a tag needs both halves of the
// signal. The source app's filter took any space after the name for the start
// of attributes: `sort <in_file >out_file` lost `<in_file >` and became a
// different command, and `Promise<user_row | null>` became `Promise`. A closing
// tag counts only when its opening tag went: alone, `</user_id>` is no more a
// call than `<user_id>`, and stripping only the closing tags of a call written
// as plain tags, the way GLM writes one, left the reader its opening tags and
// arguments.
import type { Citation } from "./hosted/types.ts";
import type { ProviderChunk } from "./types.ts";

/** How every DeepSeek special token opens: `<` and U+FF5C, written as an
 *  escape because it looks like `|` in most fonts. */
const DEEPSEEK_TOKEN = "<\uFF5C";
/** A tag name with an underscore in it, like `save_note`. */
const NAME = "[a-z][a-z0-9]*(?:_[a-z0-9]+)+";
/** An attribute's name, like `title` or `subjectType`. */
const ATTR = String.raw`[A-Za-z_][\w.:-]*`;
/** A whole opening pseudo tag, its name captured: the name, then an attribute
 *  or a self-closing slash. */
const OPENING_TAG = new RegExp(String.raw`^<(${NAME})(?:\s+${ATTR}\s*=[^>]*|\s*/)>`);
/** A whole closing tag, its name captured. */
const CLOSING_TAG = new RegExp(String.raw`^</(${NAME})\s*>`);
/** Text that may still grow into either tag, or a DeepSeek token, on the next chunk. */
const PARTIAL_TAG = new RegExp(
  String.raw`^<(?:/?[a-z0-9_]*|/${NAME}\s*|${NAME}(?:\s+(?:${ATTR}\s*(?:=[^>]*)?)?|\s*/)?)$`,
);
/** Held text that already reads as an opening pseudo tag: markup, even unclosed. */
const OPENED_TAG = new RegExp(String.raw`^<${NAME}(?:\s+${ATTR}\s*=|\s*/)`);
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
 * whole tag, or a DeepSeek token and the rest of the text it arrived in. The
 * rest of a leak goes without another call: a pair's closing tag, and text
 * after a DeepSeek token in later chunks.
 *
 * ponytail: a leaked call is dropped, not turned into the tool call it meant.
 * Some get through, whole or in part: a pair of tags with no attributes (GLM's
 * call format) stays whole, the text between a pair's tags stays, a `>` inside
 * an attribute ends the tag early, and a tag split across chunks that runs past
 * 512 characters before it closes leaks. Code is not exempt: a snake_case tag
 * with an attribute, as in an XML sample, is removed from a code block too.
 * Count `onStrip` to learn whether recovering the calls is worth building.
 */
export async function* stripLeakedToolMarkup(
  chunks: AsyncIterable<ProviderChunk>,
  opts: { onStrip?: (markup: string) => void } = {},
): AsyncGenerator<ProviderChunk> {
  // Text that could still become markup, waiting for the next chunk.
  let held = "";
  // A DeepSeek token went by: the rest of the turn's text is its syntax.
  let tripped = false;
  // The names of the pairs whose opening tag went and whose closing tag has not
  // come yet. Only their closing tags are markup.
  const open: string[] = [];
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
      const opening = OPENING_TAG.exec(rest);
      if (opening) {
        strip(base + lt, opening[0]);
        if (!opening[0].endsWith("/>")) open.push(opening[1]!);
        i = lt + opening[0].length;
        continue;
      }
      const closing = CLOSING_TAG.exec(rest);
      const pair = closing ? open.lastIndexOf(closing[1]!) : -1;
      if (closing && pair >= 0) {
        // The end of a leak already reported, so no second report. Its opening
        // tag already marked the first cut the citations are checked against.
        open.splice(pair, 1);
        i = lt + closing[0].length;
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
    // Nor the start of the closing tag a removed pair was waiting for.
    if (tail.startsWith("</") && open.some((name) => `</${name}`.startsWith(tail.trimEnd()))) {
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
