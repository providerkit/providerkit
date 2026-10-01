// Golden transcripts for the Responses shape: real event sequences replayed
// through the adapter, asserting the normalized chunks they must produce.
import { describe, expect, it } from "vitest";
import { createResponsesProvider, toResponsesInput } from "../src/providers/responses.ts";
import { ProviderError } from "../src/errors.ts";
import type { ChatMessage, ProviderChunk, ToolDefinition } from "../src/types.ts";

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

/**
 * What a caller does with the fragments: the last STATED id or name wins and
 * arguments concatenate. The seam's assembly contract, spelled out here so the
 * tests below assert the ToolCall a loop actually ends up dispatching.
 */
function assemble(chunks: ProviderChunk[]) {
  const calls = new Map<number, { index: number; id: string; name: string; arguments: string }>();
  for (const fragment of chunks.flatMap((c) => c.toolCalls ?? [])) {
    const call = calls.get(fragment.index) ?? {
      index: fragment.index,
      id: "",
      name: "",
      arguments: "",
    };
    if (fragment.id) call.id = fragment.id;
    if (fragment.name) call.name = fragment.name;
    call.arguments += fragment.arguments ?? "";
    calls.set(fragment.index, call);
  }
  return [...calls.values()];
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

  it("reports the thinking share of the output, already inside it", async () => {
    const { fetchImpl } = recorder([
      j({ type: "response.output_text.delta", delta: "ok" }),
      j({
        type: "response.completed",
        response: { usage: { ...USAGE, output_tokens_details: { reasoning_tokens: 12 } } },
      }),
    ]);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));
    expect(chunks.find((c) => c.type === "usage")?.usage).toMatchObject({
      outputTokens: 20,
      reasoningTokens: 12,
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

  it("takes the identity from done when the skeleton carried none", async () => {
    // The ChatGPT surface opens a call with the `fc_…` id alone and states the
    // `call_id` and the name only on done. Seeding the slot with `""` would
    // survive them and leave the loop a nameless call it cannot dispatch,
    // answered with `call_id: ""` on the turn after.
    const { fetchImpl } = recorder([
      j({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1" } }),
      j({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"q":"x"}' }),
      j({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_real",
          name: "search",
          arguments: '{"q":"x"}',
        },
      }),
      j({ type: "response.completed", response: { usage: USAGE } }),
    ]);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));

    // The skeleton states nothing it does not know — no empty id, no empty name.
    expect(chunks.flatMap((c) => c.toolCalls ?? [])).toEqual([
      { index: 0 },
      { index: 0, arguments: '{"q":"x"}' },
      { index: 0, id: "call_real", name: "search" },
    ]);
    expect(assemble(chunks)).toEqual([
      { index: 0, id: "call_real", name: "search", arguments: '{"q":"x"}' },
    ]);
  });

  it("lets a done that renames the call win over the skeleton", async () => {
    const { fetchImpl } = recorder([
      j({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_draft", name: "searc" },
      }),
      j({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_final",
          name: "search",
          arguments: "{}",
        },
      }),
      j({ type: "response.completed", response: { usage: USAGE } }),
    ]);
    expect(assemble(await collect(provider({ fetchImpl }).createStream(hi, [])))).toEqual([
      { index: 0, id: "call_final", name: "search", arguments: "{}" },
    ]);
  });

  it("drops a done-only call with no call_id instead of handing one over unrunnable", async () => {
    // Nothing was streamed for it, so it can still be dropped — and a turn
    // whose only call vanished must not finish as tool_calls, or the loop
    // goes looking for a call that is not there.
    const { fetchImpl } = recorder([
      j({
        type: "response.output_item.done",
        item: { type: "function_call", id: "fc_9", name: "search", arguments: '{"q":"x"}' },
      }),
      j({ type: "response.completed", response: { usage: USAGE } }),
    ]);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));

    expect(chunks.flatMap((c) => c.toolCalls ?? [])).toEqual([]);
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("stop");
  });

  it("says nothing on a done that restates exactly what already streamed", async () => {
    const { fetchImpl } = recorder(TOOL_TURN);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));
    // The identity is unchanged and the snapshot equals the fragments: the
    // only frames are the skeleton and the two argument deltas.
    expect(chunks.flatMap((c) => c.toolCalls ?? [])).toHaveLength(3);
  });

  it("follows calls keyed by call_id alone, the way xAI's Grok streams them", async () => {
    // Grok's lifecycle (cc-proxy's reducer fixture): no item id anywhere, the
    // deltas and `.arguments.done` quote `call_id`, and the closing item states
    // nothing but `call_id`. Keyed on item id only, this came back as a call
    // with no name and empty arguments.
    const { fetchImpl } = recorder([
      j({
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_1", name: "lookup" },
      }),
      j({
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_2", name: "read" },
      }),
      j({ type: "response.function_call_arguments.delta", call_id: "call_1", delta: '{"q":' }),
      j({ type: "response.function_call_arguments.delta", call_id: "call_2", delta: '{"p":"/a"}' }),
      j({ type: "response.function_call_arguments.done", call_id: "call_1", arguments: '{"q":1}' }),
      j({
        type: "response.function_call_arguments.done",
        call_id: "call_2",
        arguments: '{"p":"/a"}',
      }),
      // Arguments that never streamed a delta still arrive, whole, on `.done`.
      j({
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_3", name: "ls" },
      }),
      j({ type: "response.function_call_arguments.done", call_id: "call_3", arguments: "{}" }),
      j({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1" } }),
      j({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_2" } }),
      j({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_3" } }),
      j({ type: "response.completed", response: { usage: USAGE } }),
    ]);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));
    expect(assemble(chunks)).toEqual([
      { index: 0, id: "call_1", name: "lookup", arguments: '{"q":1}' },
      { index: 1, id: "call_2", name: "read", arguments: '{"p":"/a"}' },
      { index: 2, id: "call_3", name: "ls", arguments: "{}" },
    ]);
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("tool_calls");
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

  it("reads the outcome a terminal event states, not the one its type implies", async () => {
    // `completed` that says `incomplete` was cut; one that carries an error
    // failed. Read as a clean stop, either is a broken turn reported finished.
    const cut = recorder([
      j({ type: "response.output_text.delta", delta: "Hel" }),
      j({
        type: "response.completed",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: USAGE,
        },
      }),
    ]);
    const chunks = await collect(provider({ fetchImpl: cut.fetchImpl }).createStream(hi, []));
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("length");
    expect(chunks.find((c) => c.type === "usage")).toBeDefined();

    const failed = recorder([
      j({
        type: "response.completed",
        response: { status: "failed", error: { code: "server_error", message: "boom" } },
      }),
    ]);
    await expect(
      collect(provider({ fetchImpl: failed.fetchImpl }).createStream(hi, [])),
    ).rejects.toMatchObject({ kind: "overload" });
  });

  it("ends on response.done, the terminal event OpenCode's gateway sends", async () => {
    const { fetchImpl } = recorder([
      j({ type: "response.output_text.delta", delta: "hi" }),
      j({ type: "response.done", response: { usage: USAGE } }),
    ]);
    const chunks = await collect(provider({ fetchImpl }).createStream(hi, []));
    expect(chunks.find((c) => c.type === "finish")?.finishReason).toBe("stop");
    expect(chunks.find((c) => c.type === "usage")).toBeDefined();
  });

  it("says a stream with no terminal event was cut, after what it delivered", async () => {
    const { fetchImpl } = recorder([j({ type: "response.output_text.delta", delta: "Hel" })]);
    const seen: ProviderChunk[] = [];
    const err = await (async () => {
      for await (const chunk of provider({ fetchImpl }).createStream(hi, [])) seen.push(chunk);
    })().catch((e: unknown) => e);
    expect(seen).toEqual([{ type: "delta", content: "Hel" }]);
    expect(err).toMatchObject({ kind: "network" });
  });

  it("names a spent window when the backend's last word was a quota snapshot", async () => {
    // The snapshot is telemetry on a healthy turn. Followed by a close with no
    // response, it is the reason — and the fuller window binds.
    const wall = (extra: Record<string, unknown> = {}) =>
      recorder([
        j({
          type: "codex.rate_limits",
          rate_limits: {
            limit_reached: true,
            primary: { used_percent: 40, reset_after_seconds: 3_600 },
            secondary: { used_percent: 100, reset_after_seconds: 400_000 },
          },
          ...extra,
        }),
      ]);
    const err = (await collect(
      provider({ fetchImpl: wall().fetchImpl }).createStream(hi, []),
    ).catch((e: unknown) => e)) as ProviderError;
    expect(err).toMatchObject({ kind: "quota", retryAfterMs: 400_000_000 });

    // Credits cover the window: not a wall, so the close is a plain cut.
    const covered = await collect(
      provider({
        fetchImpl: wall({ credits: { has_credits: true } }).fetchImpl,
      }).createStream(hi, []),
    ).catch((e: unknown) => e);
    expect(covered).toMatchObject({ kind: "network" });
  });

  it("reads a spent Codex window as quota, with its clock and its window", async () => {
    // Recorded by cc-proxy off a live turn that spent the 5-hour window. The
    // status and the window clocks ride BESIDE `error`, not inside it.
    const resetsAt = Math.floor(Date.now() / 1000) + 9_568;
    const { fetchImpl } = recorder([
      j({
        type: "error",
        status_code: 429,
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          plan_type: "plus",
          resets_at: resetsAt,
          resets_in_seconds: 9_568,
        },
        headers: {
          "X-Codex-Primary-Used-Percent": "100",
          "X-Codex-Primary-Window-Minutes": "300",
          "X-Codex-Primary-Reset-After-Seconds": "9569",
          "X-Codex-Primary-Reset-At": String(resetsAt + 1),
          "X-Codex-Secondary-Used-Percent": "16",
          "X-Codex-Secondary-Window-Minutes": "10080",
          "X-Codex-Secondary-Reset-After-Seconds": "596369",
          "X-Codex-Secondary-Reset-At": String(resetsAt + 586_801),
        },
      }),
    ]);
    const err = (await collect(provider({ fetchImpl }).createStream(hi, [])).catch(
      (e: unknown) => e,
    )) as ProviderError;
    expect(err).toMatchObject({ kind: "quota", status: 429, window: "5h" });
    expect(err.resetAtMs).toBe((resetsAt + 1) * 1000);
    // Neither retried nor walked: every backup on this key hits the same wall.
    expect(err.isTransient).toBe(false);
    expect(err.isBackupEligible).toBe(false);
  });

  it("does not retry a flagged prompt", async () => {
    for (const code of ["invalid_prompt", "bio_policy"]) {
      const { fetchImpl } = recorder([
        j({
          type: "response.failed",
          response: {
            error: {
              code,
              message:
                "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
            },
          },
        }),
      ]);
      await expect(collect(provider({ fetchImpl }).createStream(hi, []))).rejects.toMatchObject({
        kind: "content",
      });
    }
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

  it("reaches a backend that serves the endpoint off /v1", async () => {
    // The ChatGPT subscription surface has no version segment. Appending
    // /v1 there is a 404, and classify() reads a 404 as kind "model" — the
    // user is told their model id is wrong when the path was.
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider({
        fetchImpl,
        baseUrl: "https://chatgpt.com/backend-api/codex",
        path: "/responses",
      }).createStream(hi, []),
    );
    expect(seen[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("swaps an image the backend would refuse for a note, only when it sets limits", async () => {
    const webp: ChatMessage[] = [
      { role: "user", content: [{ type: "image", mimeType: "image/webp", data: "UklGRg==" }] },
    ];
    const limits = { minSide: 8, minArea: 512, maxDecodedBytes: 5 * 1024 * 1024, maxImages: 4 };
    const gated = recorder(TEXT_TURN);
    await collect(
      provider({ fetchImpl: gated.fetchImpl, imageLimits: limits }).createStream(webp, []),
    );
    expect(gated.seen[0]!.body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "[image omitted: image/webp] (unreadable dimensions for image/webp)",
          },
        ],
      },
    ]);

    const open = recorder(TEXT_TURN);
    await collect(provider({ fetchImpl: open.fetchImpl }).createStream(webp, []));
    expect(open.seen[0]!.body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/webp;base64,UklGRg==" }],
      },
    ]);
  });

  it("asks for a reasoning summary whenever effort is on — the deltas need it", async () => {
    const on = recorder(TEXT_TURN);
    await collect(provider({ fetchImpl: on.fetchImpl, effort: "high" }).createStream(hi, []));
    expect(on.seen[0]!.body.reasoning).toEqual({ effort: "high", summary: "auto" });

    // `none` still rides — it is one of this shape's values, and omitting it
    // means the model's own default, which is `medium` on everything older
    // than GPT-5.1. No summary, though: there is nothing to summarise.
    const off = recorder(TEXT_TURN);
    await collect(provider({ fetchImpl: off.fetchImpl, effort: "none" }).createStream(hi, []));
    expect(off.seen[0]!.body.reasoning).toEqual({ effort: "none" });

    // Absent is the one case that sends nothing: a knob the caller never
    // touched stays the provider's.
    const absent = recorder(TEXT_TURN);
    await collect(provider({ fetchImpl: absent.fetchImpl }).createStream(hi, []));
    expect(absent.seen[0]!.body.reasoning).toBeUndefined();
  });

  it("uses Muse Contributor's lowest reasoning tier and encodes tool none by omission", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider({
        fetchImpl,
        model: "muse-spark-1.3-contributor",
      }).createStream(
        hi,
        [
          {
            name: "search",
            description: "look it up",
            inputSchema: { type: "object" },
          },
        ],
        { effort: "none", toolChoice: "none" },
      ),
    );

    expect(seen[0]!.body.reasoning).toEqual({ effort: "minimal", summary: "auto" });
    expect(seen[0]!.body.tools).toBeUndefined();
    expect(seen[0]!.body.tool_choice).toBeUndefined();
  });

  it("keeps Muse Contributor's max tier instead of applying OpenAI's high ceiling", async () => {
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider({ fetchImpl, model: "muse-spark-1.3-contributor" }).createStream(hi, [], {
        effort: "max",
      }),
    );
    expect(seen[0]!.body.reasoning).toEqual({ effort: "max", summary: "auto" });
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
        strict: false,
      },
    ]);
    expect(seen[0]!.body.tool_choice).toEqual({ type: "function", name: "search" });
    expect(seen[0]!.body.max_output_tokens).toBe(4_000);
    expect(seen[0]!.body.text).toEqual({
      format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true },
    });
  });

  it("says strict either way, and leaves no regex for the backend to choke on", async () => {
    // The ChatGPT backend 400s the WHOLE request on a pattern it cannot
    // compile (Claude Code's Artifact tool, cc-proxy #141). A property NAMED
    // `pattern` is data, not a constraint, and stays.
    const strictTool: ToolDefinition = {
      name: "save",
      description: "save a file",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^(?!-)[a-z-]+$" },
          pattern: { type: "string" },
          tags: { type: "array", items: { type: "string", pattern: "^#" } },
        },
        required: ["id", "pattern", "tags"],
        additionalProperties: false,
      },
    };
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(provider({ fetchImpl }).createStream(hi, [strictTool]));
    expect(seen[0]!.body.tools).toEqual([
      {
        type: "function",
        name: "save",
        description: "save a file",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            pattern: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["id", "pattern", "tags"],
          additionalProperties: false,
        },
        strict: true,
      },
    ]);
  });

  it("pins the cache to the session and serializes calls when asked", async () => {
    const tool = { name: "t", description: "t", inputSchema: { type: "object" as const } };
    const { seen, fetchImpl } = recorder(TEXT_TURN);
    await collect(
      provider({ fetchImpl }).createStream(hi, [tool], {
        sessionId: "conv-42",
        parallelToolCalls: false,
      }),
    );
    await collect(provider({ fetchImpl }).createStream(hi, []));
    expect(seen[0]!.body).toMatchObject({
      prompt_cache_key: "conv-42",
      parallel_tool_calls: false,
    });
    expect(seen[1]!.body).not.toHaveProperty("prompt_cache_key");
    expect(seen[1]!.body).not.toHaveProperty("parallel_tool_calls");
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
    // `max` is this package's word; OpenAI's enum stops at `high`. Every other
    // shape clamps it, and this one used to send it through — a 400 on the top
    // setting alone, which is the setting an agent reaches for when it matters.
    expect(seen[0]!.body.reasoning).toEqual({ effort: "high", summary: "auto" });
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
