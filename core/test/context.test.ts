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
} from "../src/context.ts";
import type { ChatMessage } from "../src/types.ts";

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: text });

describe("estimateTokens", () => {
  it("uses four characters a token", () => {
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("messageTokens", () => {
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
    // Found migrating tabrunner, which had carried this guard locally. Its
    // windows are LEARNED from a provider's own length rejection, so a genuine
    // 8k ceiling reaches this function. Without the guard the threshold goes
    // negative, every turn reads as full, and the run folds an empty history
    // forever.
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
