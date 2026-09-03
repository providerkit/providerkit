// Golden transcripts — one turn and five failures, on four vendors' wires.
//
// Every other suite here asks ONE adapter whether it reads its own vendor
// correctly. This one asks all four the same question: given the same turn, do
// they hand the caller the same thing? That is the package's actual promise,
// and it is the one no per-adapter test can check — a divergence (one shape
// inventing a finish reason a truncated stream never stated, another swallowing
// a failure the rest classify) passes four green suites and still breaks the app
// that switches provider.
//
// The transcripts are BYTES, not objects: `event:` lines where the vendor sends
// them, its keep-alives, its CRLF, its `[DONE]`. And they arrive in slices that
// fall mid-frame, because that is how a socket delivers them. A fixture cut on
// frame boundaries only ever tests a parser that never meets the wire — which
// is how five hand-written fixtures in the first adopting app turned out not to
// be SSE at all.
import { describe, expect, it } from "vitest";
import { ProviderError, classify } from "../src/errors.ts";
import { createAnthropicProvider } from "../src/providers/anthropic.ts";
import { createGeminiProvider } from "../src/providers/gemini.ts";
import { createOpenAIProvider } from "../src/providers/openai.ts";
import { createResponsesProvider } from "../src/providers/responses.ts";
import type { FinishReason, Provider, ProviderChunk } from "../src/types.ts";
import { streamWatch, watchChunks } from "../src/watchdog.ts";

const encoder = new TextEncoder();

/** Frames as the vendor puts them on the wire — the blank line is the spec's
 *  frame separator, and the reason none of these are `data: …\n` strings. */
const wire = (...frames: string[]) => frames.map((frame) => `${frame}\n\n`).join("");

/** Azure and several gateways in front of the OpenAI shape send CRLF. */
const crlf = (body: string) => body.replace(/\n/g, "\r\n");

/**
 * The wire as a socket delivers it: reads whose boundaries fall INSIDE frames
 * rather than between them.
 *
 * One is placed deliberately, inside the CRLF frame SEPARATOR — after its
 * second CR, before that CR's LF. A read ends there eventually on any real
 * connection, and it is the split that costs events: normalize each read on its
 * own and the buffer holds `}\n\r\ndata:`, which contains no `\n\n` to split on,
 * so the finished frame is not emitted and then merges with the next one into a
 * payload that parses as neither. Two events, silently gone.
 */
function socketBody(body: string): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(body);
  const separator = bytes.findIndex(
    (byte, at) =>
      byte === 13 && bytes[at + 1] === 10 && bytes[at + 2] === 13 && bytes[at + 3] === 10,
  );
  const cuts = [
    ...new Set([
      0,
      ...(separator === -1 ? [] : [separator + 3]),
      Math.floor(bytes.length / 3),
      Math.floor((bytes.length * 2) / 3),
      bytes.length,
    ]),
  ].sort((a, b) => a - b);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < cuts.length - 1; i += 1) {
        controller.enqueue(bytes.slice(cuts[i]!, cuts[i + 1]!));
      }
      controller.close();
    },
  });
}

const serving = (body: string): typeof fetch =>
  (async () => new Response(socketBody(body), { status: 200 })) as unknown as typeof fetch;

/**
 * Delivers the prefix, then the socket dies — the queue must drain BEFORE the
 * error, which is why this pulls rather than enqueueing and erroring at once.
 *
 * The rejection is undici's real one, `cause` included: a bare
 * `TypeError: terminated` says nothing a classifier can use, and the evidence
 * sits one wrapper down. That gap is the entire reason the cause chain is
 * walked, so a fixture that flattens it would test a fault nobody ships.
 */
const socketDeath = () =>
  Object.assign(new TypeError("terminated"), {
    cause: Object.assign(new Error("other side closed"), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
    }),
  });

const dying = (body: string): typeof fetch =>
  (async () => {
    let sent = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return controller.error(socketDeath());
          sent = true;
          controller.enqueue(encoder.encode(body));
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

const failing = (make: () => Response): typeof fetch =>
  (async () => make()) as unknown as typeof fetch;

/** 200, headers out, and then nothing that carries an event. Bytes still
 *  arrive — a keep-alive comment is bytes — which is exactly why the deadline
 *  is armed at the SEAM and not on the socket. */
const wedged: typeof fetch = (async (_url: string, init: RequestInit) => {
  const signal = init.signal!;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }),
    { status: 200 },
  );
}) as unknown as typeof fetch;

// ── the one turn, four ways ───────────────────────────────────────────────
//
// Reasoning, two text deltas, one tool call, a cached prompt, and a stop
// reason that says tools ran. Every vendor states all five; no two state them
// alike.

const OPENAI_TURN = crlf(
  wire(
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Let me think."},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cats\\"}"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":1050,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":900}}}',
    "data: [DONE]",
  ),
);

const ANTHROPIC_TURN = wire(
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":150,"cache_read_input_tokens":900,"cache_creation_input_tokens":0,"output_tokens":1}}}',
  'event: ping\ndata: {"type":"ping"}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think."}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" there"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_1","name":"search","input":{}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"cats\\"}"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
);

const GEMINI_TURN = wire(
  'data: {"candidates":[{"content":{"parts":[{"text":"Let me think.","thought":true}],"role":"model"},"index":0}]}',
  'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"index":0}]}',
  'data: {"candidates":[{"content":{"parts":[{"text":" there"}],"role":"model"},"index":0}]}',
  'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_1","name":"search","args":{"q":"cats"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":1050,"cachedContentTokenCount":900,"candidatesTokenCount":8,"thoughtsTokenCount":4}}',
);

const RESPONSES_TURN = wire(
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}',
  'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Let me think."}',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there"}',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"search","arguments":""}}',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"q\\":"}',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\\"cats\\"}"}',
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"search","arguments":"{\\"q\\":\\"cats\\"}"}}',
  'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1050,"output_tokens":12,"input_tokens_details":{"cached_tokens":900}}}}',
);

// The throttle each backend reports AFTER committing to 200 — the failure with
// no status line, in four dialects: a numeric code on the gateways, a slug on
// OpenAI and Anthropic, the canonical name on Google.
const OPENAI_THROTTLED = wire(
  'data: {"error":{"code":429,"message":"Provider returned error: rate limit exceeded"}}',
);
const ANTHROPIC_THROTTLED = wire(
  'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}',
);
const GEMINI_THROTTLED = wire(
  'data: {"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}',
);
const RESPONSES_THROTTLED = wire(
  'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached for this model"}}}',
);

interface Vendor {
  name: string;
  create(fetchImpl: typeof fetch): Provider;
  turn: string;
  throttled: string;
  /** What that backend says when it throttles, in its own words. */
  throttleSays: string;
}

const VENDORS: Vendor[] = [
  {
    name: "openai",
    create: (fetchImpl) => createOpenAIProvider({ apiKey: "k", model: "gpt-5", fetchImpl }),
    turn: OPENAI_TURN,
    throttled: OPENAI_THROTTLED,
    throttleSays: "rate limit exceeded",
  },
  {
    name: "anthropic",
    create: (fetchImpl) =>
      createAnthropicProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl }),
    turn: ANTHROPIC_TURN,
    throttled: ANTHROPIC_THROTTLED,
    throttleSays: "exceeded your rate limit",
  },
  {
    name: "gemini",
    create: (fetchImpl) =>
      createGeminiProvider({ apiKey: "k", model: "gemini-2.5-pro", fetchImpl }),
    turn: GEMINI_TURN,
    throttled: GEMINI_THROTTLED,
    throttleSays: "RESOURCE_EXHAUSTED",
  },
  {
    name: "responses",
    create: (fetchImpl) => createResponsesProvider({ apiKey: "k", model: "gpt-5", fetchImpl }),
    turn: RESPONSES_TURN,
    throttled: RESPONSES_THROTTLED,
    throttleSays: "Rate limit reached",
  },
];

/** Everything a caller actually keeps from a turn, with the per-vendor
 *  scaffolding — delta counts, fragment sizes, which index a tool call got —
 *  assembled away. Two providers agreeing HERE is the whole claim. */
interface Turn {
  text: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  };
  finishReason: FinishReason | null;
}

const NO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

async function assemble(stream: AsyncIterable<ProviderChunk>): Promise<Turn> {
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let text = "";
  let reasoning = "";
  let usage = NO_USAGE;
  let finishReason: FinishReason | null = null;
  let afterFinish = 0;

  for await (const chunk of stream) {
    if (chunk.type === "delta") {
      if (finishReason) afterFinish += 1;
      text += chunk.content ?? "";
      reasoning += chunk.reasoning ?? "";
      for (const delta of chunk.toolCalls ?? []) {
        const call = calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
        // Last stated wins for identity, concatenated for arguments — the rule
        // every shape's fragments are written against.
        if (delta.id) call.id = delta.id;
        if (delta.name) call.name = delta.name;
        call.arguments += delta.arguments ?? "";
        calls.set(delta.index, call);
      }
    } else if (chunk.type === "usage" && chunk.usage) {
      // Only the Anthropic shape reports cache WRITES separately; absent means
      // none were written, not that the field is unknown.
      usage = { ...chunk.usage, cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0 };
    } else if (chunk.type === "finish" && chunk.finishReason) {
      finishReason = chunk.finishReason;
    }
  }

  // A UI closes the message on `finish`. A delta after it renders into a turn
  // that is already sealed, or into nothing at all.
  expect(afterFinish, "a delta arrived after the finish chunk").toBe(0);
  return { text, reasoning, toolCalls: [...calls.values()], usage, finishReason };
}

/** The three fields a caller branches on, compared whole so a divergence in
 *  any one of them fails loudly rather than being read past. */
const failure = (err: unknown) => {
  expect(err).toBeInstanceOf(ProviderError);
  const { kind, status, retryAfterMs } = err as ProviderError;
  return { kind, status, retryAfterMs };
};

const thrownBy = async (stream: AsyncIterable<ProviderChunk>): Promise<unknown> => {
  try {
    await assemble(stream);
  } catch (err) {
    return err;
  }
  throw new Error("the stream was expected to fail and did not");
};

const ask = (provider: Provider) =>
  provider.createStream(
    [{ role: "user", content: "hi" }],
    [{ name: "search", description: "search", inputSchema: { type: "object" } }],
  );

describe.each(VENDORS)("$name", (vendor) => {
  it("normalizes its own dialect into the one turn every vendor must produce", async () => {
    expect(await assemble(ask(vendor.create(serving(vendor.turn))))).toEqual({
      text: "Hello there",
      reasoning: "Let me think.",
      toolCalls: [{ id: "call_1", name: "search", arguments: '{"q":"cats"}' }],
      usage: {
        inputTokens: 1_050,
        cachedInputTokens: 900,
        cacheWriteTokens: 0,
        outputTokens: 12,
      },
      finishReason: "tool_calls",
    } satisfies Turn);
  });

  it("keeps what arrived and states no finish when the stream is cut short", async () => {
    // A socket that closes mid-turn. The temptation is to close the turn out
    // with a synthesized `stop` — which reads to every caller as a model that
    // chose to answer that much, so the run is never retried and the truncated
    // answer is kept. A null finish is the only honest report.
    const cut = vendor.turn.slice(0, vendor.turn.indexOf(" there"));
    expect(await assemble(ask(vendor.create(serving(cut))))).toEqual({
      text: "Hello",
      reasoning: "Let me think.",
      toolCalls: [],
      usage: NO_USAGE,
      finishReason: null,
    } satisfies Turn);
  });

  it("lets a dead socket reach the caller, after everything it did deliver", async () => {
    // Not wrapped: `streamSse` classifies what fails BEFORE the body opens, and
    // a read that dies afterwards keeps its own shape. What matters is that it
    // is not swallowed, and that `classify` still names it — which is how
    // retry.ts decides, and it is the one kind safe to retry only because
    // nothing was committed.
    const cut = vendor.turn.slice(0, vendor.turn.indexOf(" there"));
    const err = await thrownBy(ask(vendor.create(dying(cut))));
    expect(classify(err)).toBe("network");
  });

  it("classifies a 429 identically, and honours the wait it came with", async () => {
    const err = await thrownBy(
      ask(
        vendor.create(
          failing(
            () =>
              new Response(
                '{"error":{"message":"Rate limit reached for requests","type":"rate_limit_error"}}',
                { status: 429, headers: { "retry-after": "30" } },
              ),
          ),
        ),
      ),
    );
    expect(failure(err)).toEqual({ kind: "rate", status: 429, retryAfterMs: 30_000 });
  });

  it("classifies an oversized prompt as context, not as a bad request", async () => {
    // The distinction the whole 4xx ordering exists for: `invalid` is a bug in
    // our request and stops the run, `context` is a prompt the caller can
    // compact and try again.
    const err = await thrownBy(
      ask(
        vendor.create(
          failing(
            () =>
              new Response(
                '{"error":{"message":"This model\'s maximum context length is 200000 tokens, however you requested 261000 tokens","code":"context_length_exceeded"}}',
                { status: 400 },
              ),
          ),
        ),
      ),
    );
    expect(failure(err)).toEqual({ kind: "context", status: 400, retryAfterMs: undefined });
  });

  it("reports a throttle that lands after the headers as a throttle", async () => {
    // The failure with no status line. Every shape has this hole — an SSE
    // response is already 200 when the throttle arrives — and an adapter that
    // does not read it ends the turn as a successful zero-token completion:
    // nothing to retry, and a key pool that never rotates off a spent key.
    const err = await thrownBy(ask(vendor.create(serving(vendor.throttled))));
    expect(err).toBeInstanceOf(ProviderError);
    const provider = err as ProviderError;
    expect(provider.kind).toBe("rate");
    expect(provider.isTransient).toBe(true);
    // The vendor's own words survive to the log, whichever dialect they were
    // in — a classified kind is what the run branches on, and the body is the
    // only thing that says which of the four backends said it.
    expect(provider.body).toContain(vendor.throttleSays);
  });

  it("gives up on a stream that goes quiet, and never on one that is talking", async () => {
    const watch = streamWatch({ provider: vendor.name, idleMs: 20 });
    const err = await thrownBy(
      watchChunks(
        watch,
        vendor.create(wedged).createStream([{ role: "user", content: "hi" }], [], {
          signal: watch.signal,
        }),
      ),
    );
    expect(failure(err)).toMatchObject({ kind: "timeout" });
    // Keep-alive bytes arrived and re-armed nothing: the deadline is on EVENTS
    // at the seam, which is what a wedged prefill actually starves the caller of.
    expect(watch.firstChunkMs()).toBeNull();

    const talking = streamWatch({ provider: vendor.name, idleMs: 20 });
    await assemble(watchChunks(talking, ask(vendor.create(serving(vendor.turn)))));
    expect(talking.firstChunkMs()).not.toBeNull();
  });
});
