import { describe, expect, it } from "vitest";
import { repairHistory } from "../src/context.ts";
import { ProviderError } from "../src/errors.ts";
import { collectTurn, drainStream } from "../src/turn.ts";
import type { ChatMessage, ProviderChunk, TokenUsage } from "../src/types.ts";

/** Chunks as a stream delivers them, one at a time. */
const replay = (...chunks: ProviderChunk[]): AsyncIterable<ProviderChunk> =>
  (async function* () {
    yield* chunks;
  })();

const USAGE: TokenUsage = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 };

describe("collectTurn", () => {
  it("assembles parallel calls in index order, their fragments joined", async () => {
    // Index 1 opens first and the fragments interleave, the way two calls
    // stream side by side on the OpenAI shape.
    const turn = await collectTurn(
      replay(
        { type: "delta", content: "Checking " },
        { type: "delta", toolCalls: [{ index: 1, id: "call_b", name: "fetch", arguments: "" }] },
        { type: "delta", toolCalls: [{ index: 0, id: "call_a", name: "search", arguments: "" }] },
        { type: "delta", toolCalls: [{ index: 1, arguments: '{"url":' }] },
        { type: "delta", toolCalls: [{ index: 0, arguments: '{"q":"cats"}' }] },
        { type: "delta", content: "both." },
        { type: "delta", toolCalls: [{ index: 1, arguments: '"cats.example"}' }] },
        { type: "finish", finishReason: "tool_calls" },
      ),
    );
    expect(turn.message).toEqual({
      role: "assistant",
      content: "Checking both.",
      toolCalls: [
        { id: "call_a", name: "search", arguments: '{"q":"cats"}' },
        { id: "call_b", name: "fetch", arguments: '{"url":"cats.example"}' },
      ],
    });
    expect(turn.finishReason).toBe("tool_calls");
  });

  it("takes an id and a name that arrive after the call's first fragment", async () => {
    // The ChatGPT backend opens a call with neither and states both on its
    // closing event; a later name also overrides an earlier one.
    const turn = await collectTurn(
      replay(
        { type: "delta", toolCalls: [{ index: 0, name: "searc" }] },
        { type: "delta", toolCalls: [{ index: 0, id: "", arguments: '{"q":"x"}' }] },
        { type: "delta", toolCalls: [{ index: 0, id: "call_real", name: "search" }] },
      ),
    );
    expect(turn.message.toolCalls).toEqual([
      { id: "call_real", name: "search", arguments: '{"q":"x"}' },
    ]);
  });

  it("keeps a call's thoughtSignature, so Gemini gets its reasoning back", async () => {
    const turn = await collectTurn(
      replay({
        type: "delta",
        toolCalls: [
          { index: 0, id: "call_0", name: "search", arguments: "{}", thoughtSignature: "sig==" },
        ],
      }),
    );
    expect(turn.message.toolCalls).toEqual([
      { id: "call_0", name: "search", arguments: "{}", thoughtSignature: "sig==" },
    ]);
  });

  it("keeps reading after the finish, where the OpenAI shape sends its usage", async () => {
    const turn = await collectTurn(
      replay(
        { type: "delta", content: "ok" },
        { type: "finish", finishReason: "stop" },
        { type: "usage", usage: { ...USAGE, outputTokens: 1 } },
        { type: "usage", usage: USAGE },
      ),
    );
    expect(turn.usage).toEqual(USAGE);
    expect(turn.finishReason).toBe("stop");
  });

  it("throws a retryable failure for a call that never got a name", async () => {
    const err = await collectTurn(
      replay(
        { type: "delta", toolCalls: [{ index: 0, id: "call_1", arguments: "{}" }] },
        { type: "finish", finishReason: "tool_calls" },
        { type: "usage", usage: USAGE, source: { provider: "openrouter", model: "m" } },
      ),
    ).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "overload", provider: "openrouter", isTransient: true });
    expect(String(err)).toContain("call_1");
  });

  it("keeps an empty id empty, and repairHistory names it the same way every time", async () => {
    const turn = await collectTurn(
      replay({ type: "delta", toolCalls: [{ index: 0, name: "search", arguments: "{}" }] }),
    );
    expect(turn.message.toolCalls).toEqual([{ id: "", name: "search", arguments: "{}" }]);

    // The loop answers the call under the id it was given, "", and the
    // history goes out paired under one deterministic id.
    const history: ChatMessage[] = [
      { role: "user", content: "find cats" },
      turn.message,
      { role: "tool", toolCallId: "", name: "search", content: "3 cats" },
    ];
    const sent = repairHistory(history).messages;
    expect(sent[1]).toMatchObject({ toolCalls: [{ id: "call_1_0" }] });
    expect(sent[2]).toMatchObject({ role: "tool", toolCallId: "call_1_0" });
    expect(repairHistory(history).messages).toEqual(sent);
  });

  it("reports a reasoning-only turn as sent, and leaves judging it to requireContent", async () => {
    const turn = await collectTurn(
      replay(
        { type: "delta", reasoning: "Let me " },
        { type: "delta", reasoning: "think." },
        { type: "finish", finishReason: "length" },
      ),
    );
    expect(turn.message).toEqual({ role: "assistant", content: "", reasoning: "Let me think." });
    expect(turn.finishReason).toBe("length");
  });

  it("keeps the last provider-owned reasoning payload whole, and the source", async () => {
    const turn = await collectTurn(
      replay(
        { type: "delta", reasoningDetails: [{ type: "reasoning.text", text: "a" }] },
        { type: "delta", reasoningDetails: [] },
        {
          type: "delta",
          reasoningItems: { provider: "chatgpt", items: [{ id: "rs_1" }] },
          source: { provider: "chatgpt", model: "gpt-5.6" },
        },
      ),
    );
    expect(turn.message.reasoningDetails).toEqual([{ type: "reasoning.text", text: "a" }]);
    expect(turn.message.reasoningItems).toEqual({ provider: "chatgpt", items: [{ id: "rs_1" }] });
    expect(turn.source).toEqual({ provider: "chatgpt", model: "gpt-5.6" });
  });
});

describe("drainStream", () => {
  it("returns the tool calls a buffered turn made", async () => {
    const completion = await drainStream(
      replay(
        { type: "delta", toolCalls: [{ index: 0, id: "call_1", name: "search" }] },
        { type: "delta", toolCalls: [{ index: 0, arguments: '{"q":"cats"}' }] },
        { type: "finish", finishReason: "tool_calls" },
        { type: "usage", usage: USAGE },
      ),
      "gpt-5",
    );
    expect(completion).toEqual({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "search", arguments: '{"q":"cats"}' }],
      usage: USAGE,
      finishReason: "tool_calls",
      model: "gpt-5",
    });
  });
});
