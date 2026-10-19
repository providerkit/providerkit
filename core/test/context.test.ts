import { describe, expect, it } from "vitest";
import {
  applyCompaction,
  CONTEXT_RESERVE_TOKENS,
  conversationTokens,
  estimateTokens,
  guessContextWindow,
  historyBudgetTokens,
  messageTokens,
  needsCompaction,
  pickCut,
  repairHistory,
} from "../src/context.ts";
import type { ChatMessage, ImagePart } from "../src/types.ts";

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: text });

describe("estimateTokens", () => {
  it("uses four characters a token", () => {
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("messageTokens", () => {
  it("counts encrypted reasoning by cc-proxy's estimate, not its base64 length", () => {
    const blob = "A".repeat(10_000);
    const withItems: ChatMessage = {
      role: "assistant",
      content: "",
      reasoningItems: {
        provider: "chatgpt",
        items: [{ type: "reasoning", encrypted_content: blob }],
      },
    };
    expect(messageTokens(withItems)).toBe(Math.ceil(((10_000 * 3) / 4 - 650) / 4));
  });

  it("counts an assistant turn's reasoning and tool arguments too", () => {
    // All three are re-sent, so all three cost.
    const plain = messageTokens(assistant("hello"));
    const withExtras = messageTokens({
      role: "assistant",
      content: "hello",
      reasoning: "a long chain of thought here",
      toolCalls: [{ id: "1", name: "search", arguments: '{"q":"something"}' }],
    });
    expect(withExtras).toBeGreaterThan(plain);
  });

  it("counts only the words of a multi-part user turn", () => {
    // An image's cost is the provider's own arithmetic; no character count
    // approximates it, so pretending otherwise would be worse than omitting it.
    const message: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "12345678" },
        { type: "image", mimeType: "image/png", data: "x".repeat(10_000) },
      ],
    };
    expect(messageTokens(message)).toBe(2);
  });

  it("sums a conversation", () => {
    expect(conversationTokens([user("1234"), assistant("5678")])).toBe(2);
  });
});

describe("needsCompaction on a small window", () => {
  it("does not demand compaction before the first turn has reported usage", () => {
    // Found during the first migration, in an app that had carried this guard
    // locally. Its windows are LEARNED from a provider's own length rejection,
    // so a genuine 8k ceiling reaches this function. Without the guard the
    // threshold goes negative, every turn reads as full, and the run folds an
    // empty history forever.
    for (const window of [8_000, 20_000, 32_000]) {
      expect(needsCompaction(0, window)).toBe(false);
    }
    // A real overrun on a small window still fires.
    expect(needsCompaction(7_900, 8_000)).toBe(true);
  });
});

describe("needsCompaction", () => {
  it("fires while the reserve still fits — before the 400, not after", () => {
    const window = 200_000;
    expect(needsCompaction(window - CONTEXT_RESERVE_TOKENS - 1, window)).toBe(false);
    expect(needsCompaction(window - CONTEXT_RESERVE_TOKENS, window)).toBe(true);
  });
});

describe("historyBudgetTokens", () => {
  it("is a tenth of the window", () => {
    expect(historyBudgetTokens(1_000_000)).toBe(100_000);
  });

  it("keeps a usable floor on a small window", () => {
    expect(historyBudgetTokens(20_000)).toBe(6_000);
  });
});

describe("pickCut", () => {
  it("returns 0 when everything already fits", () => {
    expect(pickCut([user("hi"), assistant("hello")], 1_000_000)).toBe(0);
  });

  it("keeps the newest messages that fit the budget", () => {
    const messages = [user("a".repeat(4_000)), user("b".repeat(4_000)), user("c".repeat(400))];
    // Only the last (100 tokens) fits a 200-token budget.
    expect(pickCut(messages, 200)).toBe(2);
  });

  it("never cuts into the system prompt — it is not history", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s".repeat(40_000) },
      user("x".repeat(40_000)),
    ];
    expect(pickCut(messages, 1)).toBe(1);
  });

  it("keeps the newest message even when it alone overruns the budget", () => {
    // Cutting history cannot fix an oversized latest turn, and answering a
    // summary instead of the question just asked is never the right failure.
    const messages = [user("a".repeat(4_000)), user("b".repeat(40_000))];
    expect(pickCut(messages, 10)).toBe(1);
  });

  it("returns an index inside the array, always", () => {
    const messages = [user("x".repeat(40_000))];
    const cut = pickCut(messages, 1);
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(cut).toBeLessThan(messages.length);
  });

  it("never separates a tool result from the call that produced it", () => {
    // A tool result whose call is missing is a 400 on the very next turn —
    // the exact failure compaction was called to avoid.
    const messages: ChatMessage[] = [
      user("go"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "search", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "t1", name: "search", content: "r".repeat(4_000) },
    ];
    const cut = pickCut(messages, 200);
    expect(messages[cut]!.role).not.toBe("tool");
  });
});

describe("applyCompaction", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "be brief" },
    user("old one"),
    user("old two"),
    user("recent"),
  ];

  it("keeps the system prompt, inserts the summary, keeps the tail", () => {
    const folded = applyCompaction(messages, 3, "they discussed old things");
    expect(folded).toHaveLength(3);
    expect(folded[0]).toEqual({ role: "system", content: "be brief" });
    expect(folded[1]!.role).toBe("user");
    expect(folded[1]!.content).toContain("they discussed old things");
    expect(folded[2]!.content).toBe("recent");
  });

  it("delivers the summary as a user turn, not a second system block", () => {
    // A system message added mid-conversation reads as a new instruction, and
    // several providers require the system block to be first and singular.
    const folded = applyCompaction(messages, 3, "summary");
    expect(folded.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("actually shortens the conversation", () => {
    const long = [
      { role: "system" as const, content: "s" },
      ...Array.from({ length: 50 }, (_, i) => user(`m${i}`)),
    ];
    const folded = applyCompaction(long, 45, "the first 44 messages");
    expect(conversationTokens(folded)).toBeLessThan(conversationTokens(long));
  });
});

describe("repairHistory", () => {
  const calls = (...ids: string[]): ChatMessage => ({
    role: "assistant",
    content: "",
    toolCalls: ids.map((id) => ({
      id,
      name: id.startsWith("read") ? "read" : "write",
      arguments: "{}",
    })),
  });
  const result = (id: string, content = `${id} done`, images?: ImagePart[]): ChatMessage => ({
    role: "tool",
    toolCallId: id,
    name: id.startsWith("read") ? "read" : "write",
    content,
    ...(images ? { images } : {}),
  });
  const MAY_HAVE_RUN =
    "This call was interrupted before it returned. It may have partly run, so check its effect before calling it again.";
  const SAFE_AGAIN =
    "This call was interrupted before it returned. It changed nothing, so it is safe to call again.";
  const repaired = (messages: ChatMessage[]) => repairHistory(messages).messages;

  it("leaves a valid history as it is, object for object", () => {
    // Nothing to fix must cost nothing: the same objects, so a caller comparing
    // by identity (Responses' reasoning replay does) sees no change.
    const history = [user("go"), calls("a", "b"), result("a"), result("b"), assistant("done")];
    const out = repaired(history);
    expect(out).toEqual(history);
    out.forEach((message, i) => expect(message).toBe(history[i]));
  });

  it("moves a span's results to just after its calls, in call order, and keeps the rest in order", () => {
    // A steer the user typed while the tools ran lands between the results.
    // Every wire wants the results first, so the steer waits behind them.
    const steer = user("also check the logs");
    expect(repaired([calls("a", "b"), result("b"), steer, result("a")])).toEqual([
      calls("a", "b"),
      result("a"),
      result("b"),
      steer,
    ]);
  });

  it("answers a call that never returned, under its own id", () => {
    const { messages, interrupted } = repairHistory([user("go"), calls("a", "b"), result("a")]);
    expect(messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "b",
      name: "write",
      content: MAY_HAVE_RUN,
    });
    expect(interrupted).toEqual([{ id: "b", name: "write", arguments: "{}" }]);
  });

  it("says a read-only call is safe to repeat, and only when told it is read-only", () => {
    const history = [calls("read_1", "write_1")];
    const told = repairHistory(history, { isReadOnly: (name) => name === "read" }).messages;
    expect(told.slice(1).map((m) => m.content)).toEqual([SAFE_AGAIN, MAY_HAVE_RUN]);
    // Not knowing is not knowing it is safe.
    const untold = repaired(history);
    expect(untold.slice(1).map((m) => m.content)).toEqual([MAY_HAVE_RUN, MAY_HAVE_RUN]);
  });

  it("turns a result with no call in its span into a user note, images and all", () => {
    const png: ImagePart = { type: "image", mimeType: "image/png", data: "iVBORw0K" };
    const history = [
      result("early"), // before any call at all
      calls("a"),
      result("a"),
      result("a", "again"), // the call already has its result
      result("z", "lost", [png]), // a call this span never made
      assistant("done"),
      result("a", "late"), // its call is in an EARLIER span
    ];
    const note = (id: string, text: string) =>
      `[Tool result for ${id}; the tool call is missing or already has a result]\n${text}`;
    expect(repaired(history)).toEqual([
      { role: "user", content: note("early", "early done") },
      calls("a"),
      result("a"),
      { role: "user", content: note("a", "again") },
      { role: "user", content: [{ type: "text", text: note("z", "lost") }, png] },
      assistant("done"),
      { role: "user", content: note("a", "late") },
    ]);
  });

  it("renames an id a later reply reuses, call and result together", () => {
    // Kimi restarts its ids every reply. Anthropic and Responses reject the
    // second `functions.search:0`, so it becomes `_2`, and its result follows.
    const kimi = "functions.search:0";
    const out = repaired([
      user("go"),
      calls(kimi),
      result(kimi),
      calls(kimi),
      result(kimi),
      calls(kimi, `${kimi}_2`),
      result(kimi),
      result(`${kimi}_2`),
    ]);
    const ids = out.flatMap((m) =>
      m.role === "assistant"
        ? (m.toolCalls ?? []).map((c) => `call ${c.id}`)
        : m.role === "tool"
          ? [`result ${m.toolCallId}`]
          : [],
    );
    // The third reply asks for `_2` itself, which is taken by then. The rename
    // never reaches back to change an earlier id: earlier bytes stay put.
    expect(ids).toEqual([
      `call ${kimi}`,
      `result ${kimi}`,
      `call ${kimi}_2`,
      `result ${kimi}_2`,
      `call ${kimi}_3`,
      `call ${kimi}_2_2`,
      `result ${kimi}_3`,
      `result ${kimi}_2_2`,
    ]);
  });

  it("pairs two calls that share an id inside one reply in order", () => {
    const out = repaired([calls("x", "x"), result("x", "first"), result("x", "second")]);
    expect(out.slice(1)).toEqual([
      result("x", "first"),
      { ...result("x", "second"), toolCallId: "x_2" },
    ]);
  });

  it("names an empty id after where it sits, never at random", () => {
    // `normalizeToolId` would mint a random one, and a random id is a new
    // prompt on every send: the cache misses from that turn on.
    const history: ChatMessage[] = [
      user("go"),
      { role: "assistant", content: "", toolCalls: [{ id: "", name: "write", arguments: "{}" }] },
      { role: "tool", toolCallId: "", name: "write", content: "ok" },
      { role: "assistant", content: "", toolCalls: [{ id: " ", name: "write", arguments: "{}" }] },
    ];
    const { messages, interrupted } = repairHistory(history);
    expect(messages[1]).toMatchObject({ toolCalls: [{ id: "call_1_0" }] });
    expect(messages[2]).toMatchObject({ toolCallId: "call_1_0", content: "ok" });
    expect(messages[3]).toMatchObject({ toolCalls: [{ id: "call_3_0" }] });
    expect(interrupted.map((call) => call.id)).toEqual(["call_3_0"]);
    expect(repairHistory(history)).toEqual({ messages, interrupted });
  });

  it("drops an assistant turn with no calls and only whitespace, as if it were never there", () => {
    // A loop that saves a placeholder before its tools run must not orphan
    // their results: the empty turn neither ends the span nor reaches the wire.
    expect(repaired([user("go"), calls("a"), assistant("  \n"), result("a")])).toEqual([
      user("go"),
      calls("a"),
      result("a"),
    ]);
    // Reasoning alone does not keep it: a turn that said nothing is not an answer.
    expect(repaired([user("go"), { role: "assistant", content: "", reasoning: "hmm" }])).toEqual([
      user("go"),
    ]);
  });

  it("changes nothing the second time", () => {
    const messy = [
      user("go"),
      calls("functions.search:0", "", "b"),
      user("steer"),
      result("b"),
      result("ghost"),
      assistant(""),
      calls("functions.search:0"),
      result("functions.search:0"),
    ];
    const once = repairHistory(messy);
    const twice = repairHistory(once.messages);
    expect(twice.messages).toEqual(once.messages);
    expect(twice.interrupted).toEqual([]);
  });

  it("keeps every earlier byte when the history grows", () => {
    // The prompt cache is a prefix cache. If repairing turn N+1 changed a byte
    // of what turn N sent, every turn after a repair would re-bill the whole
    // conversation. Claude Code minted new ids on every resume, and its
    // transcripts grew exponentially.
    const kimi = "functions.search:0";
    const history = [
      user("go"),
      calls(kimi, ""),
      result(kimi),
      user("steer"),
      assistant("looking"),
      calls(kimi),
      result("ghost"),
      result(kimi),
      calls(kimi, "b"),
      result("b"),
      assistant("done"),
    ];
    const whole = JSON.stringify(repaired(history));
    for (let end = 1; end <= history.length; end++) {
      // Only a cut at an assistant message closes every span before it; a cut
      // inside a span is a span still waiting for its results.
      if (end < history.length && history[end]!.role !== "assistant") continue;
      const prefix = JSON.stringify(repaired(history.slice(0, end))).slice(0, -1);
      expect(whole.startsWith(prefix), `cut at ${end}`).toBe(true);
    }
  });

  it("does not touch the caller's array or messages", () => {
    const history = [calls("x"), result("x"), calls("x"), result("ghost")];
    const before = structuredClone(history);
    repairHistory(history);
    expect(history).toEqual(before);
  });
});

describe("guessContextWindow", () => {
  it("knows the million-token families", () => {
    expect(guessContextWindow("gemini-3.1-pro")).toBe(1_000_000);
  });

  it("knows the 200k families", () => {
    expect(guessContextWindow("claude-opus-5")).toBe(200_000);
    expect(guessContextWindow("deepseek-v4-pro")).toBe(200_000);
  });

  it("errs small for an unknown model — folding early costs a cheap call, folding late costs the turn", () => {
    expect(guessContextWindow("some-new-model-9")).toBe(128_000);
  });
});
