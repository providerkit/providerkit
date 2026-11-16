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

describe("collectTurn, hosted calls", () => {
  const source = { type: "url" as const, url: "https://cats.example/sleep" };

  it("assembles each hosted call by index, and never as a tool call", async () => {
    const turn = await collectTurn(
      replay(
        {
          type: "delta",
          hosted: [{ index: 0, id: "srv_1", type: "web_search", status: "running", at: 0 }],
        },
        { type: "delta", hosted: [{ index: 0, input: { query: "cats" } }] },
        { type: "delta", content: "Cats sleep." },
        // `at` defaults to where the text was when the index first appeared,
        // and code arrives in pieces that join.
        { type: "delta", hosted: [{ index: 1, type: "code_execution", codeDelta: "print(" }] },
        { type: "delta", hosted: [{ index: 1, id: "", codeDelta: "1)" }] },
        {
          type: "delta",
          hosted: [{ index: 0, status: "completed", output: { sources: [source] } }],
        },
        {
          type: "delta",
          hosted: [{ index: 1, id: "code_1", status: "failed", error: "no_result" }],
        },
        { type: "delta", citations: [{ source, start: 0, end: 11, anchor: "claim" }] },
        { type: "delta", hostedItems: { provider: "anthropic", items: [{ length: 11 }] } },
        { type: "finish", finishReason: "stop" },
      ),
    );
    expect(turn.message).toEqual({
      role: "assistant",
      content: "Cats sleep.",
      hostedCalls: [
        {
          id: "srv_1",
          type: "web_search",
          status: "completed",
          input: { query: "cats" },
          output: { sources: [source] },
          at: 0,
        },
        {
          // An empty id never erases one, and the last one stated wins.
          id: "code_1",
          type: "code_execution",
          status: "failed",
          input: { code: "print(1)" },
          error: "no_result",
          at: 11,
        },
      ],
      citations: [{ source, start: 0, end: 11, anchor: "claim" }],
      hostedItems: { provider: "anthropic", items: [{ length: 11 }] },
    });
    expect(turn.finishReason).toBe("stop");
  });

  it("fails a hosted call that never says which tool ran", async () => {
    // A record nobody can show or count: the vendor's frame was broken, the
    // same fault as a tool call with no name.
    await expect(
      collectTurn(replay({ type: "delta", hosted: [{ index: 0, id: "x", status: "completed" }] })),
    ).rejects.toMatchObject({ kind: "overload" });
  });

  it("hands drainStream's caller the calls and citations too", async () => {
    const completion = await drainStream(
      replay(
        {
          type: "delta",
          hosted: [{ index: 0, id: "ws_1", type: "web_search", status: "completed" }],
        },
        { type: "delta", content: "Hi", citations: [{ source }] },
      ),
      "m",
    );
    expect(completion.hostedCalls).toEqual([
      { id: "ws_1", type: "web_search", status: "completed", at: 0 },
    ]);
    expect(completion.citations).toEqual([{ source }]);
    expect(completion.toolCalls).toEqual([]);
  });
});
