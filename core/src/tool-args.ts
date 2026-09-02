// Reading a model's tool-call arguments, including the ones it broke.
//
// Two failure modes cost real answers, and both are invisible — the JSON simply
// does not parse, and the run reports "no result" while the answer was sitting
// in the fragments.
//
//  1. TRUNCATION. The turn hit its output ceiling mid-argument, so the JSON is
//     cut off. Everything before the cut is still good, and the field the cut
//     landed in holds a half-written answer that beats no answer.
//
//  2. DOUBLE ESCAPING. Most models write non-ASCII inside tool JSON as
//     `\uXXXX`, which JSON.parse decodes correctly. Some escape it twice and
//     emit `\\u00e7`, so even a clean parse leaves six literal characters
//     standing and a Portuguese answer reaches the user as `atenção`.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `\uXXXX` only. An answer that legitimately spells that sequence is
 * vanishingly rare; one that mentions `\n` while talking about code is not.
 */
const UNICODE_ESCAPE = /\\u([0-9a-fA-F]{4})/g;

function healUnicodeEscapes(text: string): string {
  return text.replace(UNICODE_ESCAPE, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function healValue(value: unknown): unknown {
  if (typeof value === "string") return healUnicodeEscapes(value);
  if (Array.isArray(value)) return value.map(healValue);
  if (isRecord(value)) return healArgs(value);
  return value;
}

function healArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = healValue(value);
  return out;
}

/** The cut can land inside an escape (`…aten\u00`, or a lone `\`). That
 *  fragment is not text, and a trailing backslash also stops the field
 *  patterns below from matching. */
const DANGLING_ESCAPE = /\\(?:u[0-9a-fA-F]{0,3})?$/;

function unescapeJson(text: string): string {
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

/**
 * Best-effort recovery of `"key": "value"` string fields from truncated JSON.
 *
 * Only strings: they are what a summary field — the one worth rescuing — is
 * made of, and a closing quote is the single reliable boundary in a partial
 * stream. Numbers, booleans and objects are dropped, because a salvaged
 * half-value is worse than none.
 */
function salvageStringFields(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const text = raw.replace(DANGLING_ESCAPE, "");

  // A completed `"key": "value",` or `"key": "value"}` pair.
  const COMPLETE_FIELD = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*[,}]/gs;
  let match: RegExpExecArray | null;
  let lastCompleteEnd = 0;
  while ((match = COMPLETE_FIELD.exec(text)) !== null) {
    out[unescapeJson(match[1]!)] = unescapeJson(match[2]!);
    lastCompleteEnd = COMPLETE_FIELD.lastIndex;
  }

  // The tail after the last complete field: if it opens one more string that
  // never closed, keep its content up to the cut.
  const OPEN_FIELD = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)$/s;
  const open = OPEN_FIELD.exec(text.slice(lastCompleteEnd));
  if (open?.[2]) out[unescapeJson(open[1]!)] = unescapeJson(open[2]!);

  return out;
}

/**
 * Parse a tool call's raw argument string into an object, salvaging what a
 * truncated stream left behind and healing double-escaped text either way.
 *
 * Never throws: a tool call the model malformed is data the caller decides
 * about, not an exception in the transport.
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return healArgs(salvageStringFields(raw));
  }
  // A non-object payload is a protocol violation, not a value to pass on.
  return healArgs(isRecord(parsed) ? parsed : {});
}

/** Whether `raw` parses at all — how a caller tells a truncated tool call from
 *  an intact one, since `parseToolArgs` deliberately never throws. */
export function isCompleteJson(raw: string): boolean {
  if (!raw.trim()) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}
