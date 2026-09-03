// Golden transcripts for the Responses shape: real event sequences replayed
// through the adapter, asserting the normalized chunks they must produce.
import { describe, expect, it } from "vitest";
import { createResponsesProvider, toResponsesInput } from "../src/providers/responses.ts";
import { ProviderError } from "../src/errors.ts";
import type { ChatMessage, ProviderChunk } from "../src/types.ts";

/**
 * Records the request and replays a canned transcript. Frames go out with the
 * `event:` line the API really sends — the adapter must key off the payload's
 * own `type`, since that is the half the SSE reader hands on.
 */
function recorder(frames: string[], status = 200) {
  const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      body: JSON.parse(init.body as string),
      headers: new Headers(init.headers),
    });
    if (status !== 200) return new Response("upstream said no", { status });
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) {
            const name = frame.match(/"type":"([^"]+)"/)?.[1] ?? "message";
            controller.enqueue(encoder.encode(`event: ${name}\ndata: ${frame}\n\n`));
          }
          controller.close();
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const j = (o: unknown) => JSON.stringify(o);

const provider = (over: Partial<Parameters<typeof createResponsesProvider>[0]> = {}) =>
  createResponsesProvider({ apiKey: "k", model: "gpt-5.6", ...over });

const hi: ChatMessage[] = [{ role: "user", content: "hi" }];

const USAGE = {
  input_tokens: 1_000,
  input_tokens_details: { cached_tokens: 800 },
  output_tokens: 20,
};

const TEXT_TURN = [
  j({ type: "response.created", response: { id: "resp_1" } }),
  j({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: "msg_1" },
  }),
  j({ type: "response.output_text.delta", item_id: "msg_1", delta: "Hel" }),
  j({ type: "response.output_text.delta", item_id: "msg_1", delta: "lo" }),
  j({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } }),
  j({ type: "response.completed", response: { usage: USAGE } }),
];

// ── the event protocol ────────────────────────────────────────────────────

describe("responses adapter", () => {
  it("streams text deltas and infers a stop finish", async () => {
    const { fetchImpl } = recorder(TEXT_TURN);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));

    expect(chunks.filter((c) => c.content).map((c) => c.content)).toEqual(["Hel", "lo"]);
    // A message item's own added/done must not read as a tool call.
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("stop");
  });

  it("takes cached_tokens as a SUBSET — no reconciling on this shape", async () => {
    const { fetchImpl } = recorder(TEXT_TURN);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));

    expect(chunks.find((c) => c.type === "usage")?.usage).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 20,
    });
  });

  it("maps both reasoning event names to the same thing", async () => {
    const { fetchImpl } = recorder([
      j({ type: "response.reasoning_summary_text.delta", delta: "summarized" }),
      j({ type: "response.reasoning_text.delta", delta: " raw" }),
      j({ type: "response.completed", response: { usage: USAGE } }),
    ]);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));
    expect(chunks.filter((c) => c.reasoning).map((c) => c.reasoning)).toEqual([
      "summarized",
      " raw",
    ]);
  });

  it("stops at the terminal event", async () => {
    const { fetchImpl } = recorder([
      ...TEXT_TURN,
      j({ type: "response.output_text.delta", delta: "after the end" }),
    ]);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));
    expect(chunks.map((c) => c.content).join("")).toBe("Hello");
  });

  it("skips a frame that is not JSON", async () => {
    const { fetchImpl } = recorder(["not json at all", ...TEXT_TURN]);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));
    expect(chunks.filter((c) => c.content)).toHaveLength(2);
  });
});

// ── tool calls, assembled across output_item events ───────────────────────

describe("responses tool calls", () => {
  const TOOL_TURN = [
    j({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_abc",
        name: "search",
        arguments: "",
      },
    }),
    j({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"q":' }),
    j({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"cats"}' }),
    j({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_abc",
        name: "search",
        arguments: '{"q":"cats"}',
      },
    }),
    j({ type: "response.completed", response: { usage: USAGE } }),
  ];

  it("assembles fragments and does NOT re-emit the done snapshot", async () => {
    // Yielding the authoritative snapshot on top of the deltas would join the
    // JSON to itself and every argument parse would fail.
    const { fetchImpl } = recorder(TOOL_TURN);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));

    const calls = chunks.flatMap((c) => c.toolCalls ?? []);
    // `id` is the model's call_id, not the fc_ output-item id — a
    // function_call_output quoting fc_1 is rejected on the next turn.
    expect(calls[0]).toMatchObject({ index: 0, id: "call_abc", name: "search" });
    expect(calls.every((c) => c.index === 0)).toBe(true);
    expect(calls.map((c) => c.arguments ?? "").join("")).toBe('{"q":"cats"}');
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("tool_calls");
  });

  it("falls back to the done snapshot when no argument deltas arrived", async () => {
    const { fetchImpl } = recorder([
      j({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "search" },
      }),
      j({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "search",
          arguments: '{"q":"dogs"}',
        },
      }),
      j({ type: "response.completed", response: { usage: USAGE } }),
    ]);
    const calls = (await collect(provider({ fetchImpl }).createStream(hi, []))).flatMap(
      (c) => c.toolCalls ?? [],
    );
    expect(calls.map((c) => c.arguments ?? "").join("")).toBe('{"q":"dogs"}');
  });

  it("recovers a call that arrives only as a done event", async () => {
    const { fetchImpl } = recorder([
      j({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_9",
          call_id: "call_z",
          name: "search",
          arguments: '{"q":"x"}',
        },
      }),
      j({ type: "response.completed", response: { usage: USAGE } }),
    ]);
    const calls = (await collect(provider({ fetchImpl }).createStream(hi, []))).flatMap(
      (c) => c.toolCalls ?? [],
    );
    expect(calls).toEqual([{ index: 0, id: "call_z", name: "search", arguments: '{"q":"x"}' }]);
  });

  it("keeps parallel calls on separate indexes", async () => {
    const { fetchImpl } = recorder([
      j({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "c1", name: "a" },
      }),
      j({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_2", call_id: "c2", name: "b" },
      }),
      j({ type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '{"n":2}' }),
      j({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"n":1}' }),
      j({ type: "response.completed", response: { usage: USAGE } }),
    ]);
    const calls = (await collect(provider({ fetchImpl }).createStream(hi, []))).flatMap(
      (c) => c.toolCalls ?? [],
    );
    const byIndex = (index: number) =>
      calls
        .filter((c) => c.index === index)
        .map((c) => c.arguments ?? "")
        .join("");
    expect(byIndex(0)).toBe('{"n":1}');
    expect(byIndex(1)).toBe('{"n":2}');
  });
});

// ── finish reasons and failures ───────────────────────────────────────────

describe("responses finish reasons", () => {
  const incomplete = (reason: string) =>
    recorder([
      j({ type: "response.output_text.delta", delta: "half an ans" }),
      j({
        type: "response.incomplete",
        response: { incomplete_details: { reason }, usage: USAGE },
      }),
    ]);

  it("maps incomplete + max_output_tokens to length, and still reports usage", async () => {
    const { fetchImpl } = incomplete("max_output_tokens");
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("length");
    expect(chunks.find((c) => c.type === "usage")?.usage?.inputTokens).toBe(1_000);
  });

  it("maps incomplete + content_filter, and never reports a cut turn as stop", async () => {
    const filtered = await collect(
      provider({ fetchImpl: incomplete("content_filter").fetchImpl }).createStream(hi, []),
    );
    expect(filtered.find((c) => c.type === "finish")?.finishReason).toBe("content_filter");

    const unknown = await collect(
      provider({ fetchImpl: incomplete("something_new").fetchImpl }).createStream(hi, []),
    );
    expect(unknown.find((c) => c.type === "finish")?.finishReason).toBe("length");
  });

  it("classifies a mid-stream failure from its own body", async () => {
    const { fetchImpl } = recorder([
      j({
        type: "response.failed",
        response: {
          error: { code: "insufficient_quota", message: "You exceeded your current quota" },
        },
      }),
    ]);
    await expect(collect(provider({ fetchImpl }).createStream(hi, []))).rejects.toMatchObject({
      kind: "quota",
    });
  });

  it("falls back to overload for an unrecognized error event", async () => {
    // A stream that dies after its headers is a transient upstream fault;
    // "unknown" would take it off the retry path entirely.
    const { fetchImpl } = recorder([
      j({ type: "error", code: "server_error", message: "something went wrong" }),
    ]);
    const err = await collect(provider({ fetchImpl }).createStream(hi, [])).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "overload", code: "server_error" });
  });

  it("surfaces a non-2xx through the shared classifier", async () => {
    const { fetchImpl } = recorder([], 429);
    await expect(collect(provider({ fetchImpl }).createStream(hi, []))).rejects.toMatchObject({
      kind: "rate",
    });
  });
});

// ── the request ───────────────────────────────────────────────────────────

describe("responses request", () => {
  it("posts to /v1/responses with a Bearer, and never stores the turn", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider({ fetchImpl, headers: { "ChatGPT-Account-Id": "acct_1" } }).createStream(
        [
          { role: "system", content: "be brief" },
          { role: "system", content: "and kind" },
          { role: "user", content: "hi" },
        ],
        [],
      ),
    );

    expect(seen[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer k");
    expect(seen[0]!.headers.get("chatgpt-account-id")).toBe("acct_1");
    expect(seen[0]!.body.store).toBe(false);
    expect(seen[0]!.body.stream).toBe(true);
    // No system ROLE on this shape — both system turns lift into instructions.
    expect(seen[0]!.body.instructions).toBe("be brief\n\nand kind");
    expect(seen[0]!.body.input).toHaveLength(1);
  });

  it("asks for a reasoning summary whenever effort is on — the deltas need it", async () => {
    const on = recorder(TEXT_TURN);
    await collect(provider({ fetchImpl: on.fetchImpl, effort: "high" }).createStream(hi, []));
    expect(on.seen[0]!.body.reasoning).toEqual({ effort: "high", summary: "auto" });

    const off = recorder(TEXT_TURN);
    await collect(provider({ fetchImpl: off.fetchImpl, effort: "none" }).createStream(hi, []));
    expect(off.seen[0]!.body.reasoning).toBeUndefined();
  });

  it("sends tools flat, plus tool_choice, max_output_tokens and a json schema", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider({ fetchImpl, maxTokens: 4_000 }).createStream(
        hi,
        [
          {
            name: "search",
            description: "look it up",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
        {
          toolChoice: { name: "search" },
          json: { name: "answer", schema: { type: "object" } },
        },
      ),
    );

    // Flat — no nested `function` envelope, unlike chat/completions.
    expect(seen[0]!.body.tools).toEqual([
      {
        type: "function",
        name: "search",
        description: "look it up",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
    expect(seen[0]!.body.tool_choice).toEqual({ type: "function", name: "search" });
    expect(seen[0]!.body.max_output_tokens).toBe(4_000);
    expect(seen[0]!.body.text).toEqual({
      format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true },
    });
  });

  it("lets a per-call model and effort override the bound ones", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider({ fetchImpl, effort: "low" }).createStream(hi, [], {
        model: "gpt-5.6-mini",
        effort: "max",
      }),
    );
    expect(seen[0]!.body.model).toBe("gpt-5.6-mini");
    expect(seen[0]!.body.reasoning).toEqual({ effort: "max", summary: "auto" });
  });
});

// ── the input mapper ──────────────────────────────────────────────────────

describe("toResponsesInput", () => {
  it("maps every role to its item, splitting an assistant turn that called tools", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "search twice" },
      {
        role: "assistant",
        content: "on it",
        toolCalls: [
          { id: "call_a", name: "s", arguments: '{"q":1}' },
          { id: "call_b", name: "s", arguments: '{"q":2}' },
        ],
      },
      { role: "tool", toolCallId: "call_a", name: "s", content: "one" },
      { role: "tool", toolCallId: "call_b", name: "s", content: "two" },
    ];
    const { instructions, input } = toResponsesInput(messages);

    expect(instructions).toBe("be brief");
    expect(input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "search twice" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
      { type: "function_call", call_id: "call_a", name: "s", arguments: '{"q":1}' },
      { type: "function_call", call_id: "call_b", name: "s", arguments: '{"q":2}' },
      { type: "function_call_output", call_id: "call_a", output: "one" },
      { type: "function_call_output", call_id: "call_b", output: "two" },
    ]);
  });

  it("omits the text item for a tool-only assistant turn", () => {
    const { input } = toResponsesInput([
      { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "s", arguments: "{}" }] },
    ]);
    expect(input).toEqual([
      { type: "function_call", call_id: "call_a", name: "s", arguments: "{}" },
    ]);
  });

  it("does NOT replay reasoning — the item's id and encrypted blob are not on the seam", () => {
    const { input } = toResponsesInput([
      { role: "assistant", content: "hi", reasoning: "secret thoughts" },
    ]);
    expect(JSON.stringify(input)).not.toContain("secret thoughts");
  });

  it("carries user images as data URIs", () => {
    const { input } = toResponsesInput([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", mimeType: "image/png", data: "AAA" },
        ],
      },
    ]);
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what is this" },
        { type: "input_image", image_url: "data:image/png;base64,AAA" },
      ],
    });
  });

  it("switches a tool result to the content-array form only when it has images", () => {
    const { input } = toResponsesInput([
      {
        role: "tool",
        toolCallId: "call_a",
        name: "shot",
        content: "here",
        images: [{ type: "image", mimeType: "image/jpeg", data: "BBB" }],
      },
    ]);
    expect(input[0]).toEqual({
      type: "function_call_output",
      call_id: "call_a",
      output: [
        { type: "input_text", text: "here" },
        { type: "input_image", image_url: "data:image/jpeg;base64,BBB" },
      ],
    });
  });

  it("leaves instructions absent when the history has no system turn", () => {
    expect(toResponsesInput([{ role: "user", content: "hi" }]).instructions).toBeUndefined();
  });
});
