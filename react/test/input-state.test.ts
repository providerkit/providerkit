import { describe, expect, it } from "vitest";
import {
  emptyChatView,
  parseChatEvent,
  reduceChat,
  type ChatEvent,
  type DisplayInput,
} from "../src/protocol.ts";

const queued: DisplayInput = {
  id: "input",
  rootRunId: "root",
  status: "queued",
  text: "Keep this message",
};
const accepted: DisplayInput = { ...queued, runId: "target", status: "accepted" };
const opening: ChatEvent = {
  v: 1,
  type: "run",
  run: {
    id: "root",
    status: "running",
    owner: { runId: "target", agentId: "billing", label: "Billing" },
  },
};
const input = (value: DisplayInput, seq: number): ChatEvent => ({
  v: 1,
  type: "input",
  input: value,
  segment: "segment",
  seq,
});

describe("input receipt wire and reduction", () => {
  it("validates delivery and owner identities and copies only display fields", () => {
    expect(
      parseChatEvent({
        ...opening,
        run: { ...opening.run, owner: { ...opening.run.owner, note: "private" } },
      }),
    ).toEqual(opening);
    expect(
      parseChatEvent({
        ...input(accepted, 1),
        input: { ...accepted, content: "private", beforeModel: 2 },
      }),
    ).toEqual(input(accepted, 1));
    for (const invalid of [
      { ...accepted, runId: undefined },
      { ...queued, rootRunId: "" },
      { ...queued, status: "finished" },
    ])
      expect(parseChatEvent({ v: 1, type: "input", input: invalid })).toBeNull();
    expect(
      parseChatEvent({
        v: 1,
        type: "snapshot",
        messages: [],
        run: opening.run,
        inputs: [accepted],
      }),
    ).toMatchObject({ inputs: [accepted] });
    expect(
      parseChatEvent({
        v: 1,
        type: "snapshot",
        messages: [],
        run: opening.run,
        inputs: [accepted, accepted],
      }),
    ).toBeNull();
    const handoff: ChatEvent = {
      v: 1,
      type: "part",
      messageId: "answer",
      part: {
        type: "agent",
        id: "target",
        agentId: "billing",
        kind: "handoff",
        toolId: "transfer",
        label: "Billing",
        state: "running",
      },
    };
    expect(parseChatEvent(handoff)).toEqual(handoff);
  });

  it("ignores wrong-root receipts and never regresses accepted or consumed delivery on replay or snapshots", () => {
    let view = reduceChat(emptyChatView(), opening);
    view = reduceChat(view, input(queued, 1));
    view = reduceChat(view, input({ ...accepted, rootRunId: "other" }, 2));
    expect(view.inputs).toEqual([queued]);
    view = reduceChat(view, input(accepted, 3));
    view = reduceChat(view, input({ ...accepted, runId: "wrong-target", status: "consumed" }, 4));
    view = reduceChat(view, input({ ...queued, status: "recalled" }, 5));
    expect(view.inputs).toEqual([accepted]);
    view = reduceChat(view, input({ ...accepted, status: "consumed" }, 6));
    view = reduceChat(view, {
      v: 1,
      type: "snapshot",
      run: { ...opening.run, status: "completed" },
      messages: [],
      inputs: [queued],
    });
    expect(view.inputs[0]?.status).toBe("consumed");
    const before = view;
    expect(reduceChat(view, input(queued, 3))).toBe(before);
  });

  it.each(["accepted", "consumed"] as const)(
    "fills in viewer-safe text on %s receipts from live updates and snapshots",
    (status) => {
      const receipt: DisplayInput = { id: "input", rootRunId: "root", runId: "target", status };
      const initial = [opening, input(receipt, 1)].reduce(reduceChat, emptyChatView());
      const displayed = { ...receipt, text: "Text allowed for this viewer" };
      const updates: ChatEvent[] = [
        input(displayed, 2),
        { v: 1, type: "snapshot", messages: [], run: opening.run, inputs: [displayed] },
      ];
      for (const update of updates) {
        const next = reduceChat(initial, update);
        expect(next.inputs).toEqual([displayed]);
        expect(initial.inputs).toEqual([receipt]);
        // Later content-free receipts neither erase the text nor force another render.
        expect(reduceChat(next, input({ ...receipt, text: undefined }, 3)).inputs).toBe(
          next.inputs,
        );
      }
    },
  );

  it.each([
    ["accepted", "queued"],
    ["consumed", "accepted"],
    ["recalled", "queued"],
  ] as const)(
    "merges snapshot text from %s's earlier %s state without regressing delivery",
    (held, incoming) => {
      const receipt: DisplayInput = {
        id: "input",
        rootRunId: "root",
        runId: "target",
        status: held,
      };
      const view = [opening, input(receipt, 1)].reduce(reduceChat, emptyChatView());
      const next = reduceChat(view, {
        v: 1,
        type: "snapshot",
        messages: [],
        run: opening.run,
        inputs: [
          { ...queued, status: incoming, ...(incoming === "accepted" && { runId: "target" }) },
        ],
      });
      expect(next.inputs).toEqual([{ ...receipt, text: queued.text }]);
    },
  );

  it("does not merge text from a different recipient or contradictory recall receipt", () => {
    const view = [opening, input(accepted, 1)].reduce(reduceChat, emptyChatView());
    for (const incoming of [
      { ...accepted, runId: "wrong-target" },
      { ...accepted, status: "recalled" as const },
    ]) {
      expect(reduceChat(view, input({ ...incoming, text: "Wrong receipt" }, 2)).inputs).toBe(
        view.inputs,
      );
    }
    const recalled = [opening, input({ ...queued, status: "recalled" }, 1)].reduce(
      reduceChat,
      emptyChatView(),
    );
    expect(reduceChat(recalled, input({ ...accepted, text: "Wrong receipt" }, 2)).inputs).toBe(
      recalled.inputs,
    );
  });

  it("keeps queued input at completion, accepts fenced recall and clears receipts for a new root", () => {
    let view = [opening, input(queued, 1)].reduce(reduceChat, emptyChatView());
    view = reduceChat(view, {
      v: 1,
      type: "snapshot",
      messages: [],
      run: { id: "root", status: "completed" },
    });
    expect(view.inputs).toEqual([queued]);
    view = reduceChat(view, input({ ...queued, status: "recalled" }, 2));
    view = reduceChat(view, input(queued, 3));
    expect(view.inputs[0]?.status).toBe("recalled");
    view = reduceChat(view, { v: 1, type: "run", run: { id: "new-root", status: "running" } });
    expect(view.inputs).toEqual([]);
  });
});
