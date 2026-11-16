import { describe, expect, it } from "vitest";
import {
  emptyChatView,
  reduceChat,
  type AgentPart,
  type ApprovalPart,
  type ChatEvent,
  type ChatView,
  type DisplayMessage,
  type DisplayPart,
  type RunInfo,
  type RunStatus,
  type TextPart,
  type ToolPart,
} from "../src/protocol.ts";

function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

/** Applies events in order. The view and the event are frozen before every step, so each case in
 * this file also fails if the reducer writes to what it was given. */
function play(view: ChatView, ...events: ChatEvent[]): ChatView {
  return events.reduce((current, event) => reduceChat(frozen(current), frozen(event)), view);
}

type Position = { seq?: number; segment?: string };
const at = (seq: number, segment = "s1"): Position => ({ seq, segment });

const text = (id: string, value: string, settled = false): TextPart => ({
  type: "text",
  id,
  text: value,
  settled,
});
const tool = (id: string, state: ToolPart["state"] = "running"): ToolPart => ({
  type: "tool",
  id,
  name: "search",
  label: "Searching the docs",
  state,
});
const agent = (id: string, state: AgentPart["state"]): AgentPart => ({
  type: "agent",
  id,
  label: "Researcher",
  state,
});
const approval = (id: string, state: ApprovalPart["state"]): ApprovalPart => ({
  type: "approval",
  id,
  title: "Send the email?",
  state,
});
function message(
  id: string,
  parts: DisplayPart[] = [],
  more: Partial<DisplayMessage> = {},
): DisplayMessage {
  return { id, role: "assistant", state: "live", parts, ...more };
}
const run = (status: RunStatus, id = "run-1"): RunInfo => ({ id, status });

const snapshot = (messages: DisplayMessage[], info: RunInfo, where: Position = {}): ChatEvent => ({
  v: 1,
  type: "snapshot",
  messages,
  run: info,
  ...where,
});
const put = (value: DisplayMessage, where: Position = {}): ChatEvent => ({
  v: 1,
  type: "message",
  message: value,
  ...where,
});
const patch = (messageId: string, part: DisplayPart, where: Position = {}): ChatEvent => ({
  v: 1,
  type: "part",
  messageId,
  part,
  ...where,
});
const delta = (
  messageId: string,
  partId: string,
  value: string,
  where: Position = {},
): ChatEvent => ({ v: 1, type: "text", messageId, partId, delta: value, ...where });
const status = (info: RunInfo, where: Position = {}): ChatEvent => ({
  v: 1,
  type: "run",
  run: info,
  ...where,
});

const find = (view: ChatView, id: string) => view.messages.find((item) => item.id === id);
function textOf(view: ChatView, messageId: string, partId: string): string | undefined {
  const part = find(view, messageId)?.parts.find((item) => item.id === partId);
  return part?.type === "text" ? part.text : undefined;
}

const question = () =>
  message("u1", [text("u1t", "What is an index?", true)], { role: "user", state: "settled" });

/** A run in the middle of its second answer: one sealed text, one tool still working, one text
 * still streaming. The ids stand for the operation ids a host would use. */
const midRun = () =>
  play(
    emptyChatView(),
    put(question()),
    put(
      message("a1", [text("op1", "First answer.", true), tool("op2"), text("op3", "Second ans")]),
    ),
    status(run("running")),
  );

describe("emptyChatView", () => {
  it("starts with no messages, an idle run and no cursor", () => {
    expect(emptyChatView()).toEqual({ messages: [], run: { status: "idle" } });
    expect("cursor" in emptyChatView()).toBe(false);
    expect(emptyChatView()).not.toBe(emptyChatView());
  });
});

describe("rule 1: seq and segment", () => {
  const started = () =>
    play(
      emptyChatView(),
      put(message("m", [text("t", "")]), at(0)),
      delta("m", "t", "Hello", at(1)),
    );

  it("ignores a seq it already took in and hands back the same view", () => {
    const view = started();
    expect(view.cursor).toEqual({ segment: "s1", seq: 1 });
    expect(play(view, delta("m", "t", "Hello", at(1)))).toBe(view);
    expect(play(view, delta("m", "t", " again", at(0)))).toBe(view);
    expect(textOf(view, "m", "t")).toBe("Hello");
  });

  it("takes the next seq and moves the cursor", () => {
    const next = play(started(), delta("m", "t", " world", at(2)));
    expect(textOf(next, "m", "t")).toBe("Hello world");
    expect(next.cursor).toEqual({ segment: "s1", seq: 2 });
  });

  it("starts counting again when the segment changes", () => {
    const next = play(started(), delta("m", "t", " world", at(0, "s2")));
    expect(textOf(next, "m", "t")).toBe("Hello world");
    expect(next.cursor).toEqual({ segment: "s2", seq: 0 });
    expect(play(next, delta("m", "t", " again", at(0, "s2")))).toBe(next);
    expect(textOf(play(next, delta("m", "t", "!", at(1, "s2"))), "m", "t")).toBe("Hello world!");
  });

  it("applies an event without a seq every time and leaves the cursor alone", () => {
    const view = started();
    const twice = play(view, delta("m", "t", "!"), delta("m", "t", "!"));
    expect(textOf(twice, "m", "t")).toBe("Hello!!");
    expect(twice.cursor).toBe(view.cursor);
    // A segment on its own is not a position, so it moves nothing either.
    const named = play(view, delta("m", "t", "?", { segment: "s2" }));
    expect(textOf(named, "m", "t")).toBe("Hello?");
    expect(named.cursor).toBe(view.cursor);
  });

  it("counts a seq with no segment in a space of its own", () => {
    const view = play(emptyChatView(), put(message("m", [text("t", "")]), { seq: 3 }));
    expect(view.cursor).toEqual({ seq: 3 });
    expect("segment" in (view.cursor ?? {})).toBe(false);
    expect(play(view, delta("m", "t", "late", { seq: 3 }))).toBe(view);
    expect(textOf(play(view, delta("m", "t", "next", { seq: 4 })), "m", "t")).toBe("next");
    // Naming a segment afterwards leaves that space.
    expect(textOf(play(view, delta("m", "t", "named", at(0))), "m", "t")).toBe("named");
  });

  it("moves past a new event that changes nothing, keeping messages and run", () => {
    const view = play(emptyChatView(), put(message("m", [text("t", "Done.", true)]), at(0)));
    const next = play(view, delta("m", "t", " more", at(1)));
    expect(next).not.toBe(view);
    expect(next.cursor).toEqual({ segment: "s1", seq: 1 });
    expect(next.messages).toBe(view.messages);
    expect(next.run).toBe(view.run);
  });

  it("gives a numbered snapshot its place in the log", () => {
    const view = play(
      emptyChatView(),
      snapshot([message("m", [text("t", "Hello")])], run("running"), at(5)),
    );
    expect(view.cursor).toEqual({ segment: "s1", seq: 5 });
    expect(play(view, delta("m", "t", "Hello", at(3)))).toBe(view);
    expect(play(view, snapshot([], run("completed"), at(5)))).toBe(view);
    expect(textOf(play(view, delta("m", "t", " world", at(6))), "m", "t")).toBe("Hello world");
  });
});

describe("rule 2: settled stays settled under patches", () => {
  it("appends a delta to a text that is still streaming", () => {
    const view = play(
      emptyChatView(),
      put(message("m", [text("t", "")])),
      delta("m", "t", "Hel"),
      delta("m", "t", "lo"),
    );
    expect(find(view, "m")?.parts).toEqual([text("t", "Hello")]);
  });

  it("never changes a settled text with a delta", () => {
    const view = play(emptyChatView(), put(message("m", [text("t", "Done.", true)])));
    expect(play(view, delta("m", "t", " more"))).toBe(view);
  });

  it("ignores a delta that has nowhere to go", () => {
    const view = play(emptyChatView(), put(message("m", [text("t", "Hi"), tool("c")])));
    expect(play(view, delta("nobody", "t", "x"))).toBe(view);
    // A delta never creates its part: the head of that text was never received.
    expect(play(view, delta("m", "missing", "x"))).toBe(view);
    expect(play(view, delta("m", "c", "x"))).toBe(view);
    expect(play(view, delta("m", "t", ""))).toBe(view);
  });

  it("adds a part, then replaces it where it stands", () => {
    const view = play(
      emptyChatView(),
      put(message("m")),
      patch("m", tool("c")),
      patch("m", text("t", "Hi")),
      patch("m", tool("c", "done")),
      patch("m", text("t", "Hi there.", true)),
    );
    expect(find(view, "m")?.parts).toEqual([tool("c", "done"), text("t", "Hi there.", true)]);
  });

  it("drops a part for a message the view does not hold", () => {
    const view = play(emptyChatView(), put(message("m")));
    expect(play(view, patch("other", tool("c")))).toBe(view);
  });

  it.each<[string, DisplayPart, DisplayPart]>([
    ["text", text("p", "Done.", true), text("p", "Do")],
    ["finished tool", tool("p", "done"), tool("p")],
    ["failed tool", tool("p", "failed"), tool("p")],
    ["finished specialist", agent("p", "completed"), agent("p", "running")],
    ["stopped specialist", agent("p", "stopped"), agent("p", "waiting")],
    ["decided approval", approval("p", "approved"), approval("p", "pending")],
    [
      "attachment",
      { type: "attachment", id: "p", name: "notes.pdf", mediaType: "application/pdf" },
      text("p", "streaming"),
    ],
  ])("does not let a patch turn a %s live again", (_kind, settled, live) => {
    const view = play(emptyChatView(), put(message("m", [settled])));
    expect(play(view, patch("m", live))).toBe(view);
    expect(play(view, put(message("m", [live])))).toBe(view);
  });

  it("lets the host correct a part it already settled", () => {
    const view = play(emptyChatView(), put(message("m", [text("t", "Teh answer.", true)])));
    expect(textOf(play(view, patch("m", text("t", "The answer.", true))), "m", "t")).toBe(
      "The answer.",
    );
  });

  it.each(["settled", "failed", "stopped"] as const)(
    "drops a live patch for a %s message whole, new parts included",
    (state) => {
      const view = play(emptyChatView(), put(message("m", [text("t", "Done.", true)], { state })));
      expect(play(view, put(message("m", [text("t", "Done.", true), text("u", "new")])))).toBe(
        view,
      );
      expect(play(view, put(message("m", [], { state: "sending" })))).toBe(view);
    },
  );

  it.each(["settled", "failed", "stopped"] as const)(
    "puts nothing live into a %s message, and still takes a settled part",
    (state) => {
      const view = play(emptyChatView(), put(message("m", [text("t", "Done.", true)], { state })));
      // Live output aimed at a finished message is older than its end, like a patch that would
      // reopen it: a replayed request would otherwise wait there for a decision nobody can make.
      expect(play(view, patch("m", approval("q", "pending")))).toBe(view);
      expect(play(view, patch("m", text("u", "Late")))).toBe(view);
      expect(play(view, patch("m", tool("c")))).toBe(view);
      // A snapshot can leave a finished message with a text still open. No delta reaches it.
      const open = play(
        emptyChatView(),
        snapshot([message("m", [text("t", "Hal")], { state })], run("completed")),
      );
      expect(play(open, delta("m", "t", "f"))).toBe(open);
      // What is settled still lands: a sealed text, a request that expired.
      const sealed = play(
        view,
        patch("m", approval("q", "expired")),
        patch("m", text("u", "Late.", true)),
      );
      expect(find(sealed, "m")?.parts).toEqual([
        text("t", "Done.", true),
        approval("q", "expired"),
        text("u", "Late.", true),
      ]);
    },
  );

  it("lets a finished message move to another finished state", () => {
    const view = play(emptyChatView(), put(message("m", [], { state: "stopped" })));
    expect(find(play(view, put(message("m", [], { state: "failed" }))), "m")?.state).toBe("failed");
  });

  it("updates a live message by id and keeps the parts the update does not list", () => {
    const view = play(
      emptyChatView(),
      put(message("m", [text("a", "First.", true), text("b", "Sec")], { createdAt: 5 })),
    );
    // The first event of a replay: the message as it was before anything streamed.
    expect(play(view, put(message("m")))).toBe(view);
    const done = play(
      view,
      put(message("m", [text("b", "Second.", true), tool("c", "done")], { state: "settled" })),
    );
    expect(find(done, "m")).toEqual(
      message("m", [text("a", "First.", true), text("b", "Second.", true), tool("c", "done")], {
        state: "settled",
        createdAt: 5,
      }),
    );
  });

  it("keeps two calls of one tool apart when their events interleave", () => {
    const both = play(
      emptyChatView(),
      put(message("m")),
      patch("m", tool("call-1")),
      patch("m", tool("call-2")),
    );
    const done = play(
      both,
      patch("m", { ...tool("call-2", "done"), summary: "2 results" }),
      patch("m", { ...tool("call-1", "failed"), summary: "Timed out" }),
    );
    expect(find(done, "m")?.parts).toEqual([
      { ...tool("call-1", "failed"), summary: "Timed out" },
      { ...tool("call-2", "done"), summary: "2 results" },
    ]);
    // A snapshot that has only seen the first one finish leaves the second one running.
    const merged = play(both, snapshot([message("m", [tool("call-1", "done")])], run("running")));
    expect(find(merged, "m")?.parts).toEqual([tool("call-1", "done"), tool("call-2")]);
  });
});

describe("rule 3: snapshots", () => {
  it("replaces the message list and the run", () => {
    const view = play(
      emptyChatView(),
      put(message("old", [text("t", "Old", true)], { state: "settled" })),
      status(run("completed", "run-0")),
    );
    const next = play(
      view,
      snapshot([message("new", [text("t", "New", true)], { state: "settled" })], run("completed")),
    );
    expect(next.messages).toEqual([message("new", [text("t", "New", true)], { state: "settled" })]);
    expect(next.run).toEqual(run("completed"));
  });

  describe.each(["running", "waiting"] as const)("while its run is %s", (active) => {
    it("keeps unsettled parts whose ids it lacks, after its own", () => {
      const next = play(
        midRun(),
        snapshot([question(), message("a1", [text("op1", "First answer.", true)])], run(active)),
      );
      expect(find(next, "a1")?.parts).toEqual([
        text("op1", "First answer.", true),
        tool("op2"),
        text("op3", "Second ans"),
      ]);
      expect(next.run).toEqual(run(active));
    });

    it("keeps a live text that is longer and starts with its text", () => {
      const next = play(
        midRun(),
        snapshot(
          [
            question(),
            message("a1", [
              text("op1", "First answer.", true),
              tool("op2", "done"),
              text("op3", "Second"),
            ]),
          ],
          run(active),
        ),
      );
      expect(find(next, "a1")?.parts).toEqual([
        text("op1", "First answer.", true),
        tool("op2", "done"),
        text("op3", "Second ans"),
      ]);
    });

    it.each([
      ["is the longer one", "Second answer, with more"],
      ["diverges and is shorter", "Secund"],
      ["diverges and is longer", "Another answer entirely"],
      ["diverges at the same length", "Second anz"],
    ])("takes its text when it %s", (_case, theirs) => {
      const next = play(
        midRun(),
        snapshot(
          [
            question(),
            message("a1", [text("op1", "First answer.", true), tool("op2"), text("op3", theirs)]),
          ],
          run(active),
        ),
      );
      expect(textOf(next, "a1", "op3")).toBe(theirs);
    });

    it("takes a text it settled, even a shorter one: that text is complete", () => {
      const next = play(
        midRun(),
        snapshot(
          [
            question(),
            message("a1", [
              text("op1", "First answer.", true),
              tool("op2"),
              text("op3", "Second", true),
            ]),
          ],
          run(active),
        ),
      );
      expect(find(next, "a1")?.parts[2]).toEqual(text("op3", "Second", true));
    });

    it("keeps a live message whose id it lacks, after its own", () => {
      const before = midRun();
      const next = play(before, snapshot([question()], run(active)));
      expect(next.messages.map((item) => item.id)).toEqual(["u1", "a1"]);
      expect(next.messages[1]).toBe(before.messages[1]);
    });

    it("drops what is not live output: a settled part or a finished message it lacks", () => {
      const view = play(
        midRun(),
        patch("a1", text("gone", "The host took this back.", true)),
        put(message("old", [text("t", "Deleted on the host", true)], { state: "settled" })),
      );
      const next = play(
        view,
        snapshot([question(), message("a1", [text("op1", "First answer.", true)])], run(active)),
      );
      expect(next.messages.map((item) => item.id)).toEqual(["u1", "a1"]);
      expect(find(next, "a1")?.parts.map((part) => part.id)).toEqual(["op1", "op2", "op3"]);
    });

    it("can turn a settled part live again, which no patch can", () => {
      const next = play(
        midRun(),
        snapshot([question(), message("a1", [text("op1", "First")])], run(active)),
      );
      expect(find(next, "a1")?.parts[0]).toEqual(text("op1", "First"));
    });
  });

  it.each(["completed", "stopped", "limited", "failed", "idle"] as const)(
    "keeps nothing local once its run is %s",
    (over) => {
      const view = play(midRun(), put(message("a2", [text("op9", "Still typing")])));
      const final = [
        question(),
        message("a1", [text("op1", "First answer.", true), text("op3", "Second")], {
          state: "settled",
        }),
      ];
      const next = play(view, snapshot(final, run(over)));
      // Not the running tool, not the longer text, not the live message it never heard of.
      expect(next.messages).toEqual(final);
      expect(next.run).toEqual(run(over));
    },
  );

  describe("a message the client is still sending", () => {
    const history = () => [
      question(),
      message("a1", [text("op1", "An index is a sorted copy.", true)], { state: "settled" }),
    ];
    const mine = () =>
      message("c2", [text("c2:text", "And a view?", true)], {
        clientId: "c2",
        role: "user",
        state: "sending",
      });
    const sent = () => play(emptyChatView(), snapshot(history(), run("completed")), put(mine()));

    // A poll read before the host had the message, or the first read after a send whose
    // outcome is unknown. Neither says the message is gone.
    it.each(["completed", "failed", "running", "waiting", "idle"] as const)(
      "stays, after the host's messages, through a snapshot that lacks it while its run is %s",
      (status) => {
        const view = sent();
        const next = play(view, snapshot(history(), run(status, "run-2")));
        expect(next.messages.map((item) => item.id)).toEqual(["u1", "a1", "c2"]);
        expect(next.messages[2]).toBe(view.messages[2]);
      },
    );

    it("gives way to the host's copy, found by its client id or by its id", () => {
      const echo = message("msg-9", [text("p1", "And a view?", true)], {
        clientId: "c2",
        role: "user",
        state: "settled",
      });
      const echoed = play(sent(), snapshot([...history(), echo], run("running", "run-2")));
      expect(echoed.messages).toEqual([...history(), echo]);
      const kept = message("c2", [text("p1", "And a view?", true)], {
        role: "user",
        state: "settled",
      });
      const same = play(sent(), snapshot([...history(), kept], run("running", "run-2")));
      expect(same.messages).toEqual([...history(), kept]);
    });

    it("keeps only what is still sending, not a copy that settled or failed", () => {
      for (const state of ["settled", "failed"] as const) {
        const view = play(emptyChatView(), put({ ...mine(), state }));
        expect(play(view, snapshot(history(), run("completed"))).messages).toEqual(history());
      }
    });
  });

  it("neither duplicates nor regresses text when a replay from seq 0 follows it", () => {
    // What a page that just opened receives: the saved transcript, which holds finished
    // operations only, then the events of the same segment from its first one.
    const saved = snapshot(
      [question(), message("a1", [text("op1", "First answer.", true), tool("op2", "done")])],
      run("running"),
    );
    const replay = [
      status(run("running"), at(0)),
      put(question(), at(1)),
      put(message("a1"), at(2)),
      patch("a1", text("op1", ""), at(3)),
      delta("a1", "op1", "First ", at(4)),
      delta("a1", "op1", "answer.", at(5)),
      patch("a1", text("op1", "First answer.", true), at(6)),
      patch("a1", tool("op2"), at(7)),
      patch("a1", tool("op2", "done"), at(8)),
      // From here on the snapshot had seen nothing.
      patch("a1", text("op3", ""), at(9)),
      delta("a1", "op3", "Second ", at(10)),
      delta("a1", "op3", "answer.", at(11)),
    ];
    let view = play(emptyChatView(), saved);
    const settled = view.messages;
    for (const [index, event] of replay.entries()) {
      view = play(view, event);
      expect(textOf(view, "a1", "op1")).toBe("First answer.");
      expect(view.messages.map((item) => item.id)).toEqual(["u1", "a1"]);
      // Everything the snapshot already held replays as a no-op, down to object identity.
      if (index <= 8) expect(view.messages).toBe(settled);
    }
    expect(find(view, "a1")?.parts).toEqual([
      text("op1", "First answer.", true),
      tool("op2", "done"),
      text("op3", "Second answer."),
    ]);
    expect(view.run).toEqual(run("running"));
    // The same replay once more, as a reconnect that lost its place sends it: all duplicates.
    expect(play(view, ...replay)).toBe(view);
  });

  it("stays finished through a replay that follows the final snapshot", () => {
    const view = play(
      emptyChatView(),
      snapshot(
        [question(), message("a1", [text("op1", "First answer.", true)], { state: "settled" })],
        run("completed"),
      ),
    );
    const replayed = play(
      view,
      status(run("running"), at(0)),
      put(message("a1"), at(1)),
      patch("a1", text("op1", ""), at(2)),
      delta("a1", "op1", "First ", at(3)),
      status(run("waiting"), at(4)),
      status(run("running"), at(5)),
      delta("a1", "op1", "answer.", at(6)),
      patch("a1", text("op1", "First answer.", true), at(7)),
      put(message("a1", [], { state: "settled" }), at(8)),
      status(run("completed"), at(9)),
    );
    expect(replayed.messages).toBe(view.messages);
    expect(replayed.run).toBe(view.run);
    expect(replayed.cursor).toEqual({ segment: "s1", seq: 9 });
  });
});

describe("rule 4: a finished run stays finished", () => {
  const finished = (over: RunStatus) =>
    play(emptyChatView(), status(run("running"), at(0)), status(run(over), at(1)));

  describe.each(["completed", "stopped", "limited", "failed"] as const)("after %s", (over) => {
    it.each(["running", "waiting"] as const)("ignores a late %s for the same run id", (late) => {
      const view = finished(over);
      expect(play(view, status(run(late)))).toBe(view);
      const numbered = play(view, status(run(late), at(2)));
      expect(numbered.run).toBe(view.run);
      expect(numbered.cursor).toEqual({ segment: "s1", seq: 2 });
    });
  });

  it("accepts it in a new segment, where an approval continues the run", () => {
    const view = finished("stopped");
    const next = play(view, status(run("running"), at(0, "s2")));
    expect(next.run).toEqual(run("running"));
    expect(next.cursor).toEqual({ segment: "s2", seq: 0 });
  });

  it("accepts it in a snapshot", () => {
    expect(play(finished("failed"), snapshot([], run("running"))).run).toEqual(run("running"));
  });

  it("does not take a segment named without a seq for a new one", () => {
    const view = finished("completed");
    expect(play(view, status(run("running"), { segment: "s2" }))).toBe(view);
  });

  it("does not take the first numbered event a view sees for a new segment", () => {
    const view = play(emptyChatView(), snapshot([], run("completed")));
    const next = play(view, status(run("running"), at(0)));
    expect(next.run).toBe(view.run);
    expect(next.cursor).toEqual({ segment: "s1", seq: 0 });
  });

  it("starts another run normally", () => {
    const next = play(finished("completed"), status(run("running", "run-2")));
    expect(next.run).toEqual(run("running", "run-2"));
  });

  it("starts a run that was only idle, under the same id", () => {
    const view = play(emptyChatView(), status(run("idle")), status(run("running")));
    expect(view.run).toEqual(run("running"));
  });

  it("never blocks a host that sends no run ids", () => {
    const view = play(
      emptyChatView(),
      status({ status: "running" }),
      status({ status: "completed" }),
      status({ status: "running" }),
    );
    expect(view.run).toEqual({ status: "running" });
  });

  it("lets a waiting run go on in the same segment", () => {
    const view = play(
      emptyChatView(),
      status(run("running"), at(0)),
      status(run("waiting"), at(1)),
      status(run("running"), at(2)),
    );
    expect(view.run).toEqual(run("running"));
  });

  it("keeps the run object when the host repeats what the view holds", () => {
    const view = finished("failed");
    const failure = { code: "rate_limited", message: "Too many requests.", retryable: true };
    const failed = play(view, status({ ...run("failed"), error: failure }));
    expect(failed.run).not.toBe(view.run);
    expect(play(failed, status({ ...run("failed"), error: { ...failure } }))).toBe(failed);
  });
});

describe("rule 5: the echo of a sent message", () => {
  const mine = (state: DisplayMessage["state"] = "sending") =>
    message("client-1", [text("client-1:text", "Hi there", true)], {
      clientId: "client-1",
      role: "user",
      state,
    });
  const echo = () =>
    message("msg-9", [text("p1", "Hi there", true)], {
      clientId: "client-1",
      role: "user",
      state: "settled",
    });

  it("replaces the client's copy where it stands, without doubling its text", () => {
    const view = play(
      emptyChatView(),
      put(message("before", [], { state: "settled" })),
      put(mine()),
      put(message("after")),
    );
    const next = play(view, put(echo()));
    expect(next.messages.map((item) => item.id)).toEqual(["before", "msg-9", "after"]);
    expect(next.messages[1]).toEqual(echo());
    expect(next.messages[0]).toBe(view.messages[0]);
    expect(next.messages[2]).toBe(view.messages[2]);
    // The echo again, as a replay sends it, now matches by id and changes nothing.
    expect(play(next, put(echo()))).toBe(next);
  });

  it("confirms a copy the client had marked failed", () => {
    const next = play(emptyChatView(), put(mine("failed")), put(echo()));
    expect(next.messages).toEqual([echo()]);
  });

  // A host can keep the id the client made and still number the parts itself. Whatever state
  // the client's copy is in by then, its parts must not survive next to the host's.
  it.each(["sending", "settled", "failed"] as const)(
    "replaces a %s copy whole when the host kept the client's id",
    (state) => {
      const kept = message("client-1", [text("p1", "Hi there", true)], {
        role: "user",
        state: "settled",
      });
      expect(play(emptyChatView(), put(mine(state)), put(kept)).messages).toEqual([kept]);
    },
  );

  it("replaces a copy that is still sending even when it carries no client id", () => {
    const bare = message("m", [text("mine", "Hi there", true)], { role: "user", state: "sending" });
    const kept = message("m", [text("p1", "Hi there", true)], { role: "user", state: "settled" });
    expect(play(emptyChatView(), put(bare), put(kept)).messages).toEqual([kept]);
  });

  it("matches the id before the client id", () => {
    const view = play(emptyChatView(), put(mine()), put(message("msg-9", [], { role: "user" })));
    const next = play(view, put(echo()));
    expect(next.messages.map((item) => item.id)).toEqual(["client-1", "msg-9"]);
    expect(next.messages[1]).toEqual(echo());
  });

  it("adds a message that matches nothing", () => {
    const view = play(emptyChatView(), put(mine()));
    const other = message("msg-3", [], { clientId: "client-2", role: "user", state: "settled" });
    expect(play(view, put(other)).messages.map((item) => item.id)).toEqual(["client-1", "msg-3"]);
  });
});

describe("rule 6: what did not change keeps its identity", () => {
  it("changes only the message a delta lands in, and only that part", () => {
    const before = midRun();
    const after = play(before, delta("a1", "op3", "wer."));
    expect(after.messages).not.toBe(before.messages);
    expect(after.messages[0]).toBe(before.messages[0]);
    expect(after.messages[1]).not.toBe(before.messages[1]);
    expect(after.messages[1]?.parts[0]).toBe(before.messages[1]?.parts[0]);
    expect(after.messages[1]?.parts[1]).toBe(before.messages[1]?.parts[1]);
    expect(after.messages[1]?.parts[2]).not.toBe(before.messages[1]?.parts[2]);
    expect(after.run).toBe(before.run);
  });

  it("returns the same view for a snapshot that says what the view already holds", () => {
    const before = midRun();
    const again = snapshot(structuredClone([...before.messages]), structuredClone(before.run));
    expect(play(before, again)).toBe(before);
  });

  it("keeps unchanged messages and parts through a snapshot that changes one part", () => {
    const before = midRun();
    const next = play(
      before,
      snapshot(
        [
          question(),
          message(
            "a1",
            [text("op1", "First answer.", true), tool("op2", "done"), text("op3", "Second.", true)],
            { state: "settled" },
          ),
        ],
        run("completed"),
      ),
    );
    expect(next.messages[0]).toBe(before.messages[0]);
    expect(next.messages[1]).not.toBe(before.messages[1]);
    expect(next.messages[1]?.parts[0]).toBe(before.messages[1]?.parts[0]);
    expect(next.messages[1]?.parts[1]).not.toBe(before.messages[1]?.parts[1]);
  });

  it("compares tool data by content, whatever order its keys come in", () => {
    const card = (data: unknown) =>
      message("m", [{ ...tool("c", "done"), data }], { state: "settled" });
    const before = play(
      emptyChatView(),
      snapshot([card({ rows: [{ id: 1 }], total: 1 })], run("completed")),
    );
    expect(play(before, snapshot([card({ total: 1, rows: [{ id: 1 }] })], run("completed")))).toBe(
      before,
    );
    const changed = play(
      before,
      snapshot([card({ rows: [{ id: 2 }], total: 1 })], run("completed")),
    );
    expect(changed.messages[0]).not.toBe(before.messages[0]);
    expect(play(before, snapshot([card([{ id: 1 }])], run("completed"))).messages[0]).not.toBe(
      before.messages[0],
    );
    // A list is not the object that happens to look like one.
    const list = play(emptyChatView(), snapshot([card([1])], run("completed")));
    const lookalike = play(list, snapshot([card({ 0: 1, length: 1 })], run("completed")));
    expect(lookalike.messages[0]).not.toBe(list.messages[0]);
  });

  it("leaves the view and the event it was given exactly as they were", () => {
    const view = midRun();
    const event = snapshot(
      [question(), message("a1", [text("op1", "First answer.", true), text("op3", "Sec")])],
      run("running"),
      at(4),
    );
    const before = structuredClone({ view, event });
    const next = reduceChat(view, event);
    expect({ view, event }).toEqual(before);
    expect(next).not.toBe(view);
  });
});
