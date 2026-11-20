import type { DisplayMessage, DisplayPart, ToolPart } from "@providerkit/react/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  awaitsReply,
  foldWords,
  layoutMessage,
  nearEnd,
  toolView,
  type LayoutOptions,
  type MessageRow,
  type ToolTable,
} from "../src/ui/layout.ts";

function tool(id: string, name: string | undefined, state: ToolPart["state"] = "done"): ToolPart {
  return { type: "tool", id, ...(name && { name }), label: `host ${name ?? "call"}`, state };
}
const text = (id: string, value: string): DisplayPart => ({
  type: "text",
  id,
  text: value,
  settled: true,
});
const thought = (id: string): DisplayPart => ({
  type: "thinking",
  id,
  settled: true,
  durationMs: 2000,
});
const message = (
  parts: DisplayPart[],
  state: DisplayMessage["state"] = "settled",
): DisplayMessage => ({
  id: "m1",
  role: "assistant",
  parts,
  state,
});

/** Each row in a word, so a test reads as the screen does. */
function shape(rows: MessageRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === "group") return `group(${row.items.length})`;
    if (row.kind === "tool") return `tool:${row.tool.id}${row.live ? "(live)" : ""}`;
    if (row.kind === "status") return `status:${row.label ?? "thinking"}`;
    return `${row.node === undefined ? "part" : "card"}:${row.part.id}`;
  });
}
const rows = (parts: DisplayPart[], options?: LayoutOptions, state?: DisplayMessage["state"]) =>
  shape(layoutMessage(message(parts, state), options));

const table: ToolTable = {
  byName: {
    search_code: { running: "Searching the code", done: "Searched the code", icon: "search" },
    file_request: { running: "Filing", done: "Filed", failed: "Not filed", quiet: false },
  },
  fallback: { running: "Working", done: "Done", icon: "activity" },
};

describe("toolView", () => {
  it("uses the table's words for the call's state, and the host's hint", () => {
    const running = toolView({ ...tool("a", "search_code", "running"), summary: "auth.ts" }, table);
    expect(running).toMatchObject({ label: "Searching the code", hint: "auth.ts", icon: "search" });
    expect(toolView(tool("a", "search_code", "waiting"), table).label).toBe("Searching the code");
    expect(toolView(tool("a", "search_code", "done"), table).label).toBe("Searched the code");
    expect(toolView(tool("a", "file_request", "failed"), table).label).toBe("Not filed");
    expect(toolView(tool("a", "search_code", "failed"), table).label).toBe("Searched the code");
  });

  it("reads a call the table lacks through the fallback, and the host's words without one", () => {
    expect(toolView(tool("a", "read_file", "running"), table)).toMatchObject({
      label: "Working",
      icon: "activity",
      quiet: true,
    });
    expect(toolView(tool("a", undefined), table).label).toBe("Done");
    expect(toolView(tool("a", "read_file"), undefined)).toEqual({
      part: tool("a", "read_file"),
      label: "host read_file",
      quiet: true,
    });
    // A tool named like an object's own key is still a name the table lacks.
    expect(toolView(tool("a", "constructor"), { byName: {} }).label).toBe("host constructor");
  });
});

describe("layoutMessage", () => {
  it("folds every run of quiet calls by default, and splits runs at text", () => {
    expect(
      rows([tool("a", "x"), tool("b", "y"), text("t", "Found it."), tool("c", "x")], {
        tools: table,
      }),
    ).toEqual(["group(2)", "part:t", "group(1)"]);
  });

  it("folds only runs of at least foldAt calls", () => {
    const two = [tool("a", "x"), tool("b", "y")];
    expect(rows(two, { foldAt: 3 })).toEqual(["tool:a", "tool:b"]);
    expect(rows([...two, tool("c", "z")], { foldAt: 3 })).toEqual(["group(3)"]);
  });

  it("never folds a call that is not quiet or that failed, and either one splits a run", () => {
    expect(
      rows(
        [
          tool("a", "x"),
          tool("f", "file_request", "running"),
          tool("b", "x"),
          tool("e", "y", "failed"),
          tool("c", "x"),
        ],
        { tools: table },
      ),
    ).toEqual(["group(1)", "tool:f", "group(1)", "tool:e", "group(1)"]);
  });

  it("keeps a call that is not quiet in view after the answer settles", () => {
    expect(
      rows([tool("a", "x"), tool("f", "file_request"), text("t", "Filed it.")], { tools: table }),
    ).toEqual(["group(1)", "tool:f", "part:t"]);
  });

  it("keeps each thinking duration in its own row between calls", () => {
    expect(
      rows([thought("k1"), tool("a", "x"), thought("k2"), tool("b", "y"), text("t", "Ok")]),
    ).toEqual(["part:k1", "group(1)", "part:k2", "group(1)", "part:t"]);
  });

  it("draws nothing for empty text, and empty text splits nothing", () => {
    expect(rows([tool("a", "x"), text("t", "  "), tool("b", "y")])).toEqual(["group(2)"]);
  });

  it("names the first two tools of a fold and counts the rest, two calls of one tool apart", () => {
    const [group] = layoutMessage(
      message([
        tool("a", "search_code", "done"),
        tool("b", "search_code", "running"),
        tool("c", "read_file"),
        tool("d", "list_files"),
      ]),
      { tools: table },
    );
    if (group?.kind !== "group") throw new Error("Expected a fold.");
    expect(foldWords(group.items, table)).toEqual({
      names: ["Searched the code", "Done"],
      more: 2,
    });
    // Each call keeps its own state, matched by its id, never by the tool's name.
    expect(group.items.map((item) => item.state)).toEqual(["done", "running", "done", "done"]);
  });

  it("asks renderPart about every part; what it draws ends a fold, and null hides a part", () => {
    const parts = [
      tool("a", "x"),
      tool("plan", "update_plan"),
      tool("b", "y"),
      tool("hide", "z"),
      tool("c", "x"),
    ];
    const renderPart = vi.fn((entry: DisplayPart) => {
      if (entry.id === "plan") return "plan card";
      if (entry.id === "hide") return null;
      return undefined;
    });
    expect(rows(parts, { renderPart })).toEqual(["group(1)", "card:plan", "group(2)"]);
    expect(renderPart.mock.calls.map(([entry]) => entry.id)).toEqual([
      "a",
      "plan",
      "b",
      "hide",
      "c",
    ]);
  });
});

describe("the end of a live answer", () => {
  const working: LayoutOptions = { tools: table, working: true };

  it("names the running step when its call is folded out of view", () => {
    expect(rows([tool("a", "x"), tool("b", "search_code", "running")], working, "live")).toEqual([
      "group(2)",
      "status:Searching the code",
    ]);
  });

  it("says Thinking when nothing runs and no text arrives yet", () => {
    expect(rows([], working, "live")).toEqual(["status:thinking"]);
    expect(rows([tool("a", "x")], working, "live")).toEqual(["group(1)", "status:thinking"]);
    expect(rows([thought("k")], working, "live")).toEqual(["part:k", "status:thinking"]);
  });

  it("says nothing while text streams or a request waits", () => {
    expect(rows([tool("a", "x"), text("t", "The answer")], working, "live")).toEqual([
      "group(1)",
      "part:t",
    ]);
    const ask: DisplayPart = { type: "approval", id: "q", title: "Send it?", state: "pending" };
    expect(rows([ask], working, "live")).toEqual(["part:q"]);
  });

  it("lets a running call in view say it itself, in its row or in the app's card", () => {
    expect(rows([tool("f", "file_request", "running")], working, "live")).toEqual(["tool:f(live)"]);
    expect(rows([tool("a", "x", "running")], { ...working, foldAt: 3 }, "live")).toEqual([
      "tool:a(live)",
    ]);
    expect(
      rows(
        [tool("f", "file_request", "running")],
        { ...working, renderPart: () => "Filing card" },
        "live",
      ),
    ).toEqual(["card:f"]);
  });

  it("adds nothing to a settled answer or a run that does not work", () => {
    expect(rows([tool("a", "x")], working, "settled")).toEqual(["group(1)"]);
    expect(rows([tool("a", "x")], { tools: table }, "live")).toEqual(["group(1)"]);
  });
});

describe("awaitsReply", () => {
  const user: DisplayMessage = {
    id: "u",
    role: "user",
    parts: [text("t", "Hi")],
    state: "sending",
  };
  it("waits for a reply after the person's message while a send or a run goes on", () => {
    expect(awaitsReply([user], "sending")).toBe(true);
    expect(awaitsReply([user], "running")).toBe(true);
    expect(awaitsReply([user], "ready")).toBe(false);
    expect(awaitsReply([user], "waiting")).toBe(false);
    expect(awaitsReply([user, message([], "live")], "running")).toBe(false);
    expect(awaitsReply([user, message([])], "running")).toBe(true);
  });
});

describe("nearEnd", () => {
  it("follows within the distance of the end, and not past it", () => {
    expect(nearEnd(552, 400, 1000, 48)).toBe(true);
    expect(nearEnd(551, 400, 1000, 48)).toBe(false);
    expect(nearEnd(600, 400, 1000, 0)).toBe(true);
  });
});
