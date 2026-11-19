/**
 * How a message's parts lay out as rows, and when the list follows the answer. The components draw
 * what this returns, so the rules live here, where Node can test them: this file imports nothing
 * from React Native.
 *
 * Ported from three phone chats. A call reads in the app's own words from its display table, keyed
 * by the part's `name`, with the host's `label` and `summary` as the
 * default, because the host never sends a call's raw arguments. Runs of quiet calls fold into one
 * line; a call the person must read, such as filing a request,
 * never folds. While no text arrives, the end of the live answer names the running step or says
 * Thinking.
 */
import type { ReactNode } from "react";
import type { ChatStatus } from "@providerkit/react";
import {
  isRequestPart,
  type DisplayMessage,
  type DisplayPart,
  type ToolPart,
} from "@providerkit/react/protocol";

/** How one tool reads. Every field is optional: a call with no entry reads as the host wrote it. */
export interface ToolEntry {
  /** The words while it runs or waits, such as "Searching the code". */
  running?: string;
  /** The words once it is done, such as "Searched the code". */
  done?: string;
  /** The words when it failed. Default `done`, then the host's label. */
  failed?: string;
  /** Drawn before the words. The package ships no icons, so pass one already tinted. */
  icon?: ReactNode;
  /** A quiet call folds into one line with the quiet calls beside it. Default true. Set false for a
   * call whose outcome the person reads, such as a request it filed: it keeps its own row and
   * stays in view after the answer settles. */
  quiet?: boolean;
}

/** Your app's words for its tools. */
export interface ToolTable {
  /** By the tool part's `name`. */
  byName?: Readonly<Record<string, ToolEntry>>;
  /** For a call `byName` has no entry for, or that came without a name. */
  fallback?: ToolEntry;
}

/** One call, as its row draws it. */
export interface ToolView {
  part: ToolPart;
  label: string;
  /** The host's hint, such as the search or the file. */
  hint?: string;
  icon?: ReactNode;
  quiet: boolean;
}

/** One row of a message. `node` is what the app's `renderPart` drew for that part. */
export type MessageRow =
  | { kind: "part"; key: string; part: DisplayPart; node?: ReactNode }
  | { kind: "tool"; key: string; tool: ToolPart; live: boolean }
  /** Adjacent quiet calls folded into one line, in order. */
  | { kind: "group"; key: string; items: readonly ToolPart[] }
  /** The end of a live answer while no text arrives. `label` is the running step's words; without
   * it, the model is thinking. */
  | { kind: "status"; key: string; label?: string };

export interface LayoutOptions {
  tools?: ToolTable;
  /** How many quiet calls in a row fold into one line. Default 1, so every run folds. */
  foldAt?: number;
  /** The app's `renderPart`: `undefined` draws the default row, `null` hides the part. */
  renderPart?: (part: DisplayPart) => ReactNode | undefined;
  /** Whether the run is working, so a live answer may show the status line. */
  working?: boolean;
}

/** The words and the place of one call. */
export function toolView(part: ToolPart, table: ToolTable | undefined): ToolView {
  const byName = table?.byName;
  const entry =
    part.name !== undefined && byName && Object.hasOwn(byName, part.name)
      ? byName[part.name]
      : table?.fallback;
  let label: string;
  if (part.state === "done") label = entry?.done ?? part.label;
  else if (part.state === "failed") label = entry?.failed ?? entry?.done ?? part.label;
  else label = entry?.running ?? part.label;
  const view: ToolView = { part, label, quiet: entry?.quiet ?? true };
  if (part.summary) view.hint = part.summary;
  if (entry?.icon !== undefined) view.icon = entry.icon;
  return view;
}

/** What a folded line says: the words of its first two different tools, and how many calls that
 * leaves out ("Searched the web, Read a page and 3 more"). Two
 * calls of one tool count once in the words, and both in the count. */
export function foldWords(
  items: readonly ToolPart[],
  table?: ToolTable,
): { names: string[]; more: number } {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.name ?? item.label;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(toolView(item, table).label);
    if (names.length === 2) break;
  }
  return { names, more: items.length - names.length };
}

/** Whether a call is still going: running, or waiting for an answer. */
export function isRunning(part: ToolPart): boolean {
  return part.state === "running" || part.state === "waiting";
}

/**
 * A message's rows, in reading order. Results are matched by call id, never by tool name: each
 * call is its own part, so two calls to one tool keep their own state.
 *
 * - `renderPart` sees every part first. What it draws is a row of its own and ends a fold; `null`
 *   hides the part, and a hidden part does not split the calls around it.
 * - A quiet call joins the run of quiet calls before it. A failed call
 *   never folds: it carries what went wrong. A run with at least `foldAt` calls folds into one
 *   line; a shorter run shows each call.
 * - Text with nothing in it yet draws nothing and splits nothing.
 */
export function layoutMessage(message: DisplayMessage, options: LayoutOptions = {}): MessageRow[] {
  const { tools, foldAt = 1, renderPart } = options;
  const rows: MessageRow[] = [];
  let run: ToolPart[] = [];
  const flush = () => {
    const first = run[0];
    if (first && run.length >= foldAt)
      rows.push({ kind: "group", key: `group:${first.id}`, items: run });
    else
      for (const tool of run)
        rows.push({ kind: "tool", key: `tool:${tool.id}`, tool, live: false });
    run = [];
  };
  for (const entry of message.parts) {
    const node = renderPart?.(entry);
    if (node === null) continue;
    if (node !== undefined) {
      flush();
      rows.push({ kind: "part", key: `part:${entry.id}`, part: entry, node });
      continue;
    }
    if (entry.type === "text" && !entry.text.trim() && !entry.incomplete) continue;
    if (entry.type === "tool") {
      const view = toolView(entry, tools);
      if (view.quiet && entry.state !== "failed") {
        run.push(entry);
        continue;
      }
      flush();
      rows.push({ kind: "tool", key: `tool:${entry.id}`, tool: entry, live: false });
      continue;
    }
    flush();
    rows.push({ kind: "part", key: `part:${entry.id}`, part: entry });
  }
  flush();
  if (message.state === "live" && options.working) addLiveStatus(rows, tools);
  return rows;
}

/** The current step speaks for itself when visible. If folded, name it below the fold. */
function addLiveStatus(rows: MessageRow[], tools?: ToolTable): void {
  const last = rows.at(-1);
  if (last?.kind === "part") {
    const entry = last.part;
    if (entry.type === "text" || (isRequestPart(entry) && entry.state === "pending")) return;
    if (entry.type === "tool" && isRunning(entry)) return; // The host drew its own card.
  }
  if (last?.kind === "tool" && isRunning(last.tool)) {
    last.live = true;
    return;
  }
  let label: string | undefined;
  if (last?.kind === "group")
    for (let i = last.items.length - 1; i >= 0; i--) {
      const item = last.items[i];
      if (item && isRunning(item)) {
        label = toolView(item, tools).label;
        break;
      }
    }
  rows.push({ kind: "status", key: "status", label });
}

/**
 * Whether the list owes the person a reply it has not started drawing: a message is on its way or
 * the run is working, and nothing after the person's last message is being written. The list then
 * ends with the Thinking line, so the screen answers the send at once.
 */
export function awaitsReply(messages: readonly DisplayMessage[], status: ChatStatus): boolean {
  return (status === "sending" || status === "running") && messages.at(-1)?.state !== "live";
}

/** A FlatList snapshot. Changes to a live message's parts belong to its subscribed cell; a new,
 * removed, reordered, changed saved or newly settled message belongs to the list. */
export function listRows(previous: readonly DisplayMessage[], next: readonly DisplayMessage[]) {
  return previous.length === next.length &&
    next.every((message, index) => {
      const before = previous[index];
      return (
        before === message ||
        (message.state === "live" &&
          before?.state === "live" &&
          before.id === message.id &&
          before.role === message.role)
      );
    })
    ? previous
    : next;
}

/** Whether a list scrolled to `offset`, showing `viewport` of `content`, is close enough to its end
 * to keep following the answer. */
export function nearEnd(
  offset: number,
  viewport: number,
  content: number,
  distance: number,
): boolean {
  return offset + viewport >= content - distance;
}
