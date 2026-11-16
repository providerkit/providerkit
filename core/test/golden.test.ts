import * as hostedProviders from "../src/hosted.ts";
// Golden transcripts: one turn and five failures on four vendors' wires, and
// one turn that ran a hosted search, asked the same questions on all four.
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
import { repairHistory } from "../src/context.ts";
import { ProviderError, classify } from "../src/errors.ts";
import { HOSTED_TOOL_TYPES, type HostedTool, type HostedToolType } from "../src/hosted.ts";
import { createAnthropicProvider } from "../src/providers/anthropic.ts";
import { createGeminiProvider } from "../src/providers/gemini.ts";
import { createOpenAIProvider } from "../src/providers/openai.ts";
import { createResponsesProvider } from "../src/providers/responses.ts";
import { withStreamRetry } from "../src/retry.ts";
import { collectTurn } from "../src/turn.ts";
import type {
  ChatMessage,
  FinishReason,
  Provider,
  ProviderChunk,
  StreamOptions,
  ToolChoice,
  ToolDefinition,
} from "../src/types.ts";
import { streamWatch, watchChunks, withWatchdog } from "../src/watchdog.ts";

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
 *  arrive, every few milliseconds — a keep-alive comment is bytes — which is
 *  exactly why the progress deadline is armed at the SEAM and not on the
 *  socket. */
const wedged: typeof fetch = (async (_url: string, init: RequestInit) => {
  const signal = init.signal!;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        const beat = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 5);
        signal.addEventListener(
          "abort",
          () => {
            clearInterval(beat);
            controller.error(signal.reason);
          },
          { once: true },
        );
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
    'data: {"choices":[],"usage":{"prompt_tokens":1050,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":900},"completion_tokens_details":{"reasoning_tokens":4}}}',
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
  'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1050,"output_tokens":12,"input_tokens_details":{"cached_tokens":900},"output_tokens_details":{"reasoning_tokens":4}}}}',
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

// A request the backend refuses AFTER committing to 200, in words no pattern
// knows. Three dialects name it only by type, with no status; Google states
// its status, as it always does.
const REFUSED = "messages.1: unexpected field 'cache_hint'";
const OPENAI_REFUSED = wire(
  `data: {"error":{"message":"${REFUSED}","type":"invalid_request_error","param":null,"code":null}}`,
);
const ANTHROPIC_REFUSED = wire(
  `event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"${REFUSED}"}}`,
);
const GEMINI_REFUSED = wire(
  `data: {"error":{"code":400,"message":"${REFUSED}","status":"INVALID_ARGUMENT"}}`,
);
const RESPONSES_REFUSED = wire(
  `event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","code":null,"message":"${REFUSED}","param":null}}`,
);

// ── one hosted search, four ways ──────────────────────────────────────────
//
// The vendor searched, read one page, and answered with a claim and a link to
// it. Each wire says that differently: Anthropic in server blocks with a
// citation over the claim's whole block, Gemini in server parts with grounding
// counted in UTF-8 bytes, Responses in an output item with an annotation on
// the link counted in code points, OpenRouter in an annotation and a count and
// nothing else. The emoji makes those three units disagree.

const SOURCE_URL = "https://cats.example/sleep";
const CLAIM = "Cats 🐈 sleep 12 to 16 hours a day.";
const LINK = `([cats.example](${SOURCE_URL}))`;
const ANSWER = `${CLAIM} ${LINK}`;
/** Where the link starts, and how long it is, in code points. */
const LINK_AT = [...ANSWER].indexOf("(");
const LINK_END = LINK_AT + [...LINK].length;
const QUERY = "how long do cats sleep";

/** The bytes of `turn` up to the end of the frame holding `marker`. */
const through = (turn: string, marker: string) =>
  turn.slice(0, turn.indexOf("\n\n", turn.indexOf(marker)) + 2);

const OPENAI_HOSTED_TURN = crlf(
  wire(
    `data: {"id":"gen-1","choices":[{"index":0,"delta":{"role":"assistant","content":"${CLAIM}"},"finish_reason":null}]}`,
    `data: {"choices":[{"index":0,"delta":{"content":" ${LINK}","annotations":[{"type":"url_citation","url_citation":{"url":"${SOURCE_URL}","title":"Cat sleep","start_index":${LINK_AT},"end_index":${LINK_END},"content":"Cats sleep 12 to 16 hours a day."}}]},"finish_reason":"stop"}]}`,
    'data: {"choices":[],"usage":{"prompt_tokens":2037,"completion_tokens":42,"cost":0.0123,"server_tool_use_details":{"web_search_requests":1}}}',
    "data: [DONE]",
  ),
);

const ANTHROPIC_RESULT = `[{"type":"web_search_result","url":"${SOURCE_URL}","title":"Cat sleep","encrypted_content":"EqgfCioIARgB","page_age":null}]`;
const ANTHROPIC_HOSTED_TURN = wire(
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":2037,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}}',
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\": \\"${QUERY}\\"}"}}`,
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":${ANTHROPIC_RESULT}}}`,
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
  'event: ping\ndata: {"type":"ping"}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"citations":[],"type":"text","text":""}}',
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","cited_text":"Cats sleep 12 to 16 hours a day.","url":"${SOURCE_URL}","title":"Cat sleep","encrypted_index":"Eo8BCioIAhgB"}}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"${CLAIM}"}}`,
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}',
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":" ${LINK}"}}`,
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":3}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42,"server_tool_use":{"web_search_requests":1,"web_fetch_requests":0}}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
);

const GEMINI_HOSTED_TURN = wire(
  `data: {"candidates":[{"content":{"parts":[{"toolCall":{"id":"srv_1","toolType":"GOOGLE_SEARCH_WEB","args":{"query":"${QUERY}"}},"thoughtSignature":"sig_a"}],"role":"model"},"index":0}]}`,
  'data: {"candidates":[{"content":{"parts":[{"toolResponse":{"id":"srv_1","toolType":"GOOGLE_SEARCH_WEB","response":{"ok":true}},"thoughtSignature":"sig_b"}],"role":"model"},"index":0}]}',
  `data: {"candidates":[{"content":{"parts":[{"text":"${CLAIM}"}],"role":"model"},"index":0}]}`,
  `data: {"candidates":[{"content":{"parts":[{"text":" ${LINK}"}],"role":"model"},"finishReason":"STOP","index":0,"groundingMetadata":{"webSearchQueries":["${QUERY}"],"groundingChunks":[{"web":{"uri":"${SOURCE_URL}","title":"Cat sleep"}}],"groundingSupports":[{"segment":{"endIndex":${new TextEncoder().encode(CLAIM).length},"text":"${CLAIM}"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":2037,"candidatesTokenCount":42,"toolUsePromptTokenCount":300}}`,
);

const RESPONSES_HOSTED_TURN = wire(
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_2"}}',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"web_search_call","id":"ws_1","status":"in_progress"}}',
  'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching","output_index":0,"item_id":"ws_1"}',
  `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"web_search_call","id":"ws_1","status":"completed","action":{"type":"search","query":"${QUERY}","sources":[{"type":"url","url":"${SOURCE_URL}"}]}}}`,
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}',
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"${CLAIM}"}`,
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":" ${LINK}"}`,
  `event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","item_id":"msg_1","output_index":1,"content_index":0,"annotation_index":0,"annotation":{"type":"url_citation","url":"${SOURCE_URL}","title":"Cat sleep","start_index":${LINK_AT},"end_index":${LINK_END}}}`,
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1"}}',
  'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2037,"output_tokens":42}}}',
);

/** A code run Gemini cut off at its deadline: the failure as data. */
const GEMINI_TIMED_OUT = wire(
  'data: {"candidates":[{"content":{"parts":[{"executableCode":{"language":"PYTHON","code":"while True: pass"}}],"role":"model"},"index":0}]}',
  'data: {"candidates":[{"content":{"parts":[{"codeExecutionResult":{"outcome":"OUTCOME_DEADLINE_EXCEEDED"}}],"role":"model"},"index":0}]}',
  'data: {"candidates":[{"content":{"parts":[{"text":"It ran too long."}],"role":"model"},"finishReason":"STOP","index":0}]}',
);

/** One tool of each type, with only what the type requires set. */
const PLAIN: Record<HostedToolType, HostedTool> = {
  web_search: { type: "web_search" },
  web_fetch: { type: "web_fetch" },
  code_execution: { type: "code_execution" },
  file_search: { type: "file_search", storeIds: ["store_1"] },
  image_generation: { type: "image_generation" },
};
const SEARCH: StreamOptions = { hostedTools: [PLAIN.web_search] };

/** The tool list a request body carries, whatever the wire calls its entries. */
const toolsOf = (body: Record<string, unknown>) =>
  ((body.tools ?? []) as Record<string, unknown>[]).filter((tool) => typeof tool === "object");

// ── the history that went out, four ways ──────────────────────────────────
//
// What a request carries, in the order it carries it, with each wire's nesting
// read away: OpenAI's tool messages, Anthropic's blocks merged into one user
// turn, Gemini's parts, Responses' items. Reduced to this, four requests can be
// held to one expected history.

type Item =
  | { user: string }
  | { assistant: string }
  | { image: string }
  | { call: string; name: string }
  | { result: string; text: string };

const said = (role: string, text: string): Item[] =>
  text ? [role === "user" ? { user: text } : { assistant: text }] : [];

/** The base64 out of a `data:` URI. */
const dataOf = (uri: string) => uri.slice(uri.indexOf(",") + 1);

interface OpenAIPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

function openAIHistory(raw: string): Item[] {
  const {
    messages,
  }: {
    messages: {
      role: string;
      content?: string | OpenAIPart[];
      tool_calls?: { id: string; function: { name: string } }[];
      tool_call_id?: string;
    }[];
  } = JSON.parse(raw);
  return messages.flatMap((message): Item[] => {
    if (message.role === "system") return [];
    if (message.role === "tool") {
      return [{ result: message.tool_call_id ?? "", text: String(message.content) }];
    }
    const parts: OpenAIPart[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content ?? []);
    return [
      ...parts.flatMap((part): Item[] =>
        part.image_url
          ? [{ image: dataOf(part.image_url.url) }]
          : said(message.role, part.text ?? ""),
      ),
      ...(message.tool_calls ?? []).map((call) => ({ call: call.id, name: call.function.name })),
    ];
  });
}

interface AnthropicBlock {
  type: string;
  text?: string;
  source?: { data: string };
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: AnthropicBlock[];
}

function anthropicHistory(raw: string): Item[] {
  const { messages }: { messages: { role: string; content: AnthropicBlock[] }[] } = JSON.parse(raw);
  const read =
    (role: string) =>
    (block: AnthropicBlock): Item[] => {
      switch (block.type) {
        case "text":
          return said(role, block.text ?? "");
        case "image":
          return [{ image: block.source?.data ?? "" }];
        case "tool_use":
          return [{ call: block.id ?? "", name: block.name ?? "" }];
        case "tool_result": {
          const [text, ...images] = block.content ?? [];
          return [
            { result: block.tool_use_id ?? "", text: text?.text ?? "" },
            ...images.flatMap(read(role)),
          ];
        }
        default:
          return [];
      }
    };
  return messages.flatMap((message) => message.content.flatMap(read(message.role)));
}

function geminiHistory(raw: string): Item[] {
  const {
    contents,
  }: {
    contents: {
      role: string;
      parts: {
        text?: string;
        inlineData?: { data: string };
        functionCall?: { id: string; name: string };
        functionResponse?: { id: string; response: { output?: unknown } };
      }[];
    }[];
  } = JSON.parse(raw);
  return contents.flatMap((content) =>
    content.parts.flatMap((part): Item[] => {
      const { functionCall: call, functionResponse: result } = part;
      if (call) return [{ call: call.id, name: call.name }];
      if (result) return [{ result: result.id, text: String(result.response.output) }];
      if (part.inlineData) return [{ image: part.inlineData.data }];
      return said(content.role, part.text ?? "");
    }),
  );
}

function responsesHistory(raw: string): Item[] {
  const {
    input,
  }: {
    input: {
      type: string;
      role?: string;
      content?: { type: string; text?: string; image_url?: string }[];
      call_id?: string;
      name?: string;
      output?: unknown;
    }[];
  } = JSON.parse(raw);
  return input.flatMap((item): Item[] => {
    if (item.type === "function_call") return [{ call: item.call_id ?? "", name: item.name ?? "" }];
    if (item.type === "function_call_output") {
      return [{ result: item.call_id ?? "", text: String(item.output) }];
    }
    return (item.content ?? []).flatMap((part): Item[] =>
      part.image_url ? [{ image: dataOf(part.image_url) }] : said(item.role ?? "", part.text ?? ""),
    );
  });
}

/** Walks a request body without asserting its shape — each wire nests its
 *  thinking dial somewhere different. */
function at(body: unknown, ...path: string[]): unknown {
  let node: unknown = body;
  for (const key of path) {
    if (typeof node !== "object" || node === null || !(key in node)) return undefined;
    node = Reflect.get(node, key);
  }
  return node;
}

interface Vendor {
  name: string;
  create(fetchImpl: typeof fetch): Provider;
  turn: string;
  throttled: string;
  /** What that backend says when it throttles, in its own words. */
  throttleSays: string;
  /** An invalid request it reports inside the 200, in words no pattern knows. */
  refused: string;
  /** How this wire says "do not think", read off the request that went out. */
  refusesThinking(body: Record<string, unknown>): boolean;
  /** Whether this wire carries a file part (a PDF, audio, video). Only
   *  Gemini's does; the other three must refuse one, never drop it. */
  takesFiles: boolean;
  /** Whether this wire has a service tier to send. Anthropic and Gemini do not,
   *  and must refuse one, never drop it. */
  takesServiceTier: boolean;
  /** The history a request body carries, read off the bytes that went out. */
  history(raw: string): Item[];
  /** How this wire spells Kimi's `functions.search:0`. Anthropic's id pattern
   *  takes only [A-Za-z0-9_-]. */
  kimiId: string;
  hosted: HostedVendor;
}

/** The same vendor, at an endpoint that runs hosted tools, and how its wire
 *  carries them. */
interface HostedVendor {
  /** The endpoint, when it is not `create`'s: OpenRouter, on the chat wire. */
  create?(fetchImpl: typeof fetch): Provider;
  /** The hosted types that endpoint runs. */
  serves: HostedToolType[];
  /** The search turn, as this wire streams it. */
  turn: string;
  /** Whether this wire states a record of each hosted call. The chat wire
   *  states only citations and a count: the one gap in this matrix. */
  records: boolean;
  /** Whether a request body carries a hosted tool of `type`. */
  sends(body: Record<string, unknown>, type: HostedToolType): boolean;
  /** A tool with a field this wire can't apply, and the endpoint to ask. */
  unapplied: { tool: HostedTool; create?(fetchImpl: typeof fetch): Provider };
  /** What the citation's span covers here, and what it is anchored to. */
  cited: { text: string; anchor: "claim" | "marker" };
  /** The bytes through the first hosted call the wire states, and the call's tool. */
  committed?: { bytes: string; opts: StreamOptions };
  /** A turn whose hosted call failed, its tool, and the code it failed with. */
  failed?: { turn: string; opts: StreamOptions; error: string };
  /** What marks the vendor's own hosted items in a request, on a wire that
   *  sends them back. Responses keeps none (`store` is off), nor does chat. */
  replays?: string;
}

/** The wire's name for each hosted type, per wire. */
const ANTHROPIC_NAMES: Partial<Record<HostedToolType, string>> = {
  web_search: "web_search_20250305",
  web_fetch: "web_fetch_20250910",
  code_execution: "code_execution_20250825",
};
const GEMINI_KEYS: Partial<Record<HostedToolType, string>> = {
  web_search: "googleSearch",
  web_fetch: "urlContext",
  code_execution: "codeExecution",
  file_search: "fileSearch",
};
const RESPONSES_NAMES: Partial<Record<HostedToolType, string>> = {
  web_search: "web_search",
  code_execution: "code_interpreter",
  file_search: "file_search",
  image_generation: "image_generation",
};

const VENDORS: Vendor[] = [
  {
    name: "openai",
    create: (fetchImpl) => createOpenAIProvider({ apiKey: "k", model: "gpt-5", fetchImpl }),
    turn: OPENAI_TURN,
    throttled: OPENAI_THROTTLED,
    throttleSays: "rate limit exceeded",
    refused: OPENAI_REFUSED,
    refusesThinking: (body) => at(body, "reasoning_effort") === "none",
    takesFiles: false,
    takesServiceTier: true,
    history: openAIHistory,
    kimiId: "functions.search:0",
    hosted: {
      create: (fetchImpl) =>
        hostedProviders.createOpenAIProvider({
          apiKey: "k",
          model: "openai/gpt-5",
          baseUrl: "https://openrouter.ai/api",
          id: "openrouter",
          fetchImpl,
        }),
      serves: ["web_search"],
      turn: OPENAI_HOSTED_TURN,
      records: false,
      sends: (body, type) =>
        type === "web_search" &&
        (toolsOf(body).some((tool) => tool.type === "openrouter:web_search") ||
          "web_search_options" in body),
      // OpenAI's own search models take a location, and nothing that restricts.
      unapplied: {
        tool: { type: "web_search", allowedDomains: ["cats.example"] },
        create: (fetchImpl) =>
          hostedProviders.createOpenAIProvider({
            apiKey: "k",
            model: "gpt-5-search-preview",
            fetchImpl,
          }),
      },
      cited: { text: LINK, anchor: "marker" },
    },
  },
  {
    name: "anthropic",
    create: (fetchImpl) =>
      createAnthropicProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl }),
    turn: ANTHROPIC_TURN,
    throttled: ANTHROPIC_THROTTLED,
    throttleSays: "exceeded your rate limit",
    refused: ANTHROPIC_REFUSED,
    // Sonnet 5 thinks by default and accepts an explicit off. Documented
    // (Anthropic per-model table, read 2026-09-27); other Claude models spell
    // none differently, and providers.test.ts pins each.
    refusesThinking: (body) => at(body, "thinking", "type") === "disabled",
    takesFiles: false,
    takesServiceTier: false,
    history: anthropicHistory,
    kimiId: "functions_search_0",
    hosted: {
      create: (fetchImpl) =>
        hostedProviders.createAnthropicProvider({
          apiKey: "k",
          model: "claude-sonnet-5",
          fetchImpl,
        }),
      serves: ["web_search", "web_fetch", "code_execution"],
      turn: ANTHROPIC_HOSTED_TURN,
      records: true,
      sends: (body, type) => {
        const name = ANTHROPIC_NAMES[type];
        return name !== undefined && toolsOf(body).some((tool) => tool.type === name);
      },
      // Container uploads are not built, so file ids would ride nowhere.
      unapplied: { tool: { type: "code_execution", fileIds: ["file_1"] } },
      cited: { text: CLAIM, anchor: "claim" },
      committed: { bytes: through(ANTHROPIC_HOSTED_TURN, '"server_tool_use"'), opts: SEARCH },
      failed: {
        turn: ANTHROPIC_HOSTED_TURN.replace(
          ANTHROPIC_RESULT,
          '{"type":"web_search_tool_result_error","error_code":"max_uses_exceeded"}',
        ),
        opts: SEARCH,
        error: "max_uses_exceeded",
      },
      replays: '"server_tool_use"',
    },
  },
  {
    name: "gemini",
    create: (fetchImpl) =>
      createGeminiProvider({ apiKey: "k", model: "gemini-3.5-pro", fetchImpl }),
    turn: GEMINI_TURN,
    throttled: GEMINI_THROTTLED,
    throttleSays: "RESOURCE_EXHAUSTED",
    refused: GEMINI_REFUSED,
    refusesThinking: (body) =>
      at(body, "generationConfig", "thinkingConfig", "thinkingLevel") === "MINIMAL" ||
      at(body, "generationConfig", "thinkingConfig", "thinkingLevel") === "LOW" ||
      at(body, "generationConfig", "thinkingConfig", "thinkingBudget") === 0,
    takesFiles: true,
    takesServiceTier: false,
    history: geminiHistory,
    kimiId: "functions.search:0",
    hosted: {
      create: (fetchImpl) =>
        hostedProviders.createGeminiProvider({ apiKey: "k", model: "gemini-3.5-pro", fetchImpl }),
      serves: ["web_search", "web_fetch", "code_execution", "file_search"],
      turn: GEMINI_HOSTED_TURN,
      records: true,
      sends: (body, type) => {
        const key = GEMINI_KEYS[type];
        return key !== undefined && toolsOf(body).some((tool) => key in tool);
      },
      // Gemini's search takes no domain filter.
      unapplied: { tool: { type: "web_search", allowedDomains: ["cats.example"] } },
      cited: { text: CLAIM, anchor: "claim" },
      committed: { bytes: through(GEMINI_HOSTED_TURN, '"toolCall"'), opts: SEARCH },
      failed: {
        turn: GEMINI_TIMED_OUT,
        opts: { hostedTools: [PLAIN.code_execution] },
        error: "OUTCOME_DEADLINE_EXCEEDED",
      },
      replays: '"toolCall"',
    },
  },
  {
    name: "responses",
    create: (fetchImpl) => createResponsesProvider({ apiKey: "k", model: "gpt-5", fetchImpl }),
    turn: RESPONSES_TURN,
    throttled: RESPONSES_THROTTLED,
    throttleSays: "Rate limit reached",
    refused: RESPONSES_REFUSED,
    refusesThinking: (body) => at(body, "reasoning", "effort") === "none",
    takesFiles: false,
    takesServiceTier: true,
    history: responsesHistory,
    kimiId: "functions.search:0",
    hosted: {
      create: (fetchImpl) =>
        hostedProviders.createResponsesProvider({ apiKey: "k", model: "gpt-5", fetchImpl }),
      serves: ["web_search", "code_execution", "file_search", "image_generation"],
      turn: RESPONSES_HOSTED_TURN,
      records: true,
      sends: (body, type) => {
        const name = RESPONSES_NAMES[type];
        return name !== undefined && toolsOf(body).some((tool) => tool.type === name);
      },
      // This wire's search has no use cap.
      unapplied: { tool: { type: "web_search", maxUses: 2 } },
      cited: { text: LINK, anchor: "marker" },
      committed: {
        bytes: through(
          RESPONSES_HOSTED_TURN,
          '"web_search_call","id":"ws_1","status":"in_progress"',
        ),
        opts: SEARCH,
      },
      failed: {
        turn: RESPONSES_HOSTED_TURN.replace(
          '"status":"completed","action"',
          '"status":"failed","action"',
        ),
        opts: SEARCH,
        error: "failed",
      },
    },
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
    reasoningTokens?: number;
  };
  finishReason: FinishReason | null;
}

const NO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

/** A transcript with every match of `swaps` applied, failing loudly when none
 *  matched, so a fixture that drifts cannot turn a check into a no-op. Every
 *  match, because Responses states a call twice: in its skeleton and its `.done`. */
function rewrite(turn: string, swaps: [string, string][], mustChange = true): string {
  const out = swaps.reduce((body, [from, to]) => body.replaceAll(from, to), turn);
  expect(out !== turn, "no swap matched this transcript").toBe(mustChange);
  return out;
}

/** The one turn every vendor's transcript must assemble into. */
const theTurn = (vendor: Vendor): Turn => ({
  text: "Hello there",
  reasoning: "Let me think.",
  toolCalls: [{ id: "call_1", name: "search", arguments: '{"q":"cats"}' }],
  usage: {
    inputTokens: 1_050,
    cachedInputTokens: 900,
    cacheWriteTokens: 0,
    outputTokens: 12,
    // The thinking share of those 12, on every wire that reports one.
    // Anthropic's does not, and a guessed number is worse than none.
    ...(vendor.name === "anthropic" ? {} : { reasoningTokens: 4 }),
  },
  finishReason: "tool_calls",
});

/** collectTurn, failing on any delta that arrives after the finish chunk. */
async function drain(stream: AsyncIterable<ProviderChunk>) {
  let finished = false;
  let afterFinish = 0;
  const turn = await collectTurn(
    (async function* () {
      for await (const chunk of stream) {
        if (chunk.type === "delta" && finished) afterFinish += 1;
        if (chunk.type === "finish" && chunk.finishReason) finished = true;
        yield chunk;
      }
    })(),
  );

  // A UI closes the message on `finish`. A delta after it renders into a turn
  // that is already sealed, or into nothing at all.
  expect(afterFinish, "a delta arrived after the finish chunk").toBe(0);
  return turn;
}

async function assemble(stream: AsyncIterable<ProviderChunk>): Promise<Turn> {
  const { message, usage, finishReason } = await drain(stream);
  return {
    text: message.content,
    reasoning: message.reasoning ?? "",
    toolCalls: (message.toolCalls ?? []).map(({ id, name, arguments: args }) => ({
      id,
      name,
      arguments: args,
    })),
    // Only the Anthropic shape reports cache WRITES separately; absent means
    // none were written, not that the field is unknown.
    usage: { ...usage, cacheWriteTokens: usage.cacheWriteTokens ?? 0 },
    finishReason,
  };
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

const ask = (provider: Provider, opts?: StreamOptions) =>
  provider.createStream(
    [{ role: "user", content: "hi" }],
    [{ name: "search", description: "search", inputSchema: { type: "object" } }],
    opts,
  );

/** Serves the turn and keeps the request body, for the claims that are about
 *  what went OUT rather than what came back. */
function recording(body: string) {
  const sent: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    raw.push(init.body as string);
    sent.push(JSON.parse(init.body as string));
    return new Response(socketBody(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, raw, fetchImpl };
}

// A resumed run, broken the two ways a saved history breaks: call_2 never
// returned, and call_9's result answers a call this history does not hold.
const PNG = { type: "image", mimeType: "image/png", data: "iVBORw0K" } as const;
const TOOLS: ToolDefinition[] = [
  { name: "search", description: "search", inputSchema: { type: "object" } },
  { name: "fetch", description: "fetch", inputSchema: { type: "object" } },
];
const BROKEN: ChatMessage[] = [
  { role: "user", content: "find cats" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "call_1", name: "search", arguments: '{"q":"cats"}' },
      { id: "call_2", name: "fetch", arguments: '{"url":"cats.example"}' },
    ],
  },
  { role: "tool", toolCallId: "call_1", name: "search", content: "3 cats" },
  { role: "tool", toolCallId: "call_9", name: "fetch", content: "a page", images: [PNG] },
  { role: "user", content: "go on" },
];
const REPAIRED: Item[] = [
  { user: "find cats" },
  { call: "call_1", name: "search" },
  { call: "call_2", name: "fetch" },
  { result: "call_1", text: "3 cats" },
  {
    result: "call_2",
    text: "This call was interrupted before it returned. It may have partly run, so check its effect before calling it again.",
  },
  { user: "[Tool result for call_9; the tool call is missing or already has a result]\na page" },
  { image: "iVBORw0K" },
  { user: "go on" },
];

/** Two replies from a model that restarts its call ids every reply, as Kimi
 *  does: both ask for `functions.search:0`. */
const KIMI_TWICE: ChatMessage[] = [
  { role: "user", content: "find cats, then dogs" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "functions.search:0", name: "search", arguments: '{"q":"cats"}' }],
  },
  { role: "tool", toolCallId: "functions.search:0", name: "search", content: "3 cats" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "functions.search:0", name: "search", arguments: '{"q":"dogs"}' }],
  },
  { role: "tool", toolCallId: "functions.search:0", name: "search", content: "2 dogs" },
];

describe.each(VENDORS)("$name", (vendor) => {
  it("says 'do not think' out loud — `none` is never the same request as silence", async () => {
    // The request-side half of the same promise: one seam value, four wires,
    // and the answer has to mean the same thing on each. `none` is the value
    // an agent reaches for when it caps `maxTokens`, because thinking tokens
    // come out of the answer's budget — a turn that spends the whole allowance
    // thinking returns empty with a length finish, which reads as a model
    // failure and is really a request nobody sent.
    //
    // Two shapes expressed it by sending NOTHING, which is not "do not think":
    // it is the model's own default, and that is `medium` on everything older
    // than GPT-5.1. Asserted as a difference rather than a spelling, so each
    // adapter stays free to say it in its own dialect.
    const none = recording(vendor.turn);
    await assemble(ask(vendor.create(none.fetchImpl), { effort: "none" }));
    expect(vendor.refusesThinking(none.sent[0]!)).toBe(true);

    // And the other half of the same rule: a knob the caller never touched is
    // the provider's, and on all four that default is not none. Anthropic
    // was the exception while its models defaulted to off; Claude 5 thinks
    // unless told not to.
    const silence = recording(vendor.turn);
    await assemble(ask(vendor.create(silence.fetchImpl)));
    expect(vendor.refusesThinking(silence.sent[0]!)).toBe(false);
  });

  it("sends a broken history repaired, the same way on every wire and every time", async () => {
    // Sent as it was, this history is a 400 on all four wires, and the turn is
    // lost. Repaired, the missing result is answered as interrupted and the
    // stray one is kept as a note the model can still read, png included.
    const { raw, fetchImpl } = recording(vendor.turn);
    const provider = vendor.create(fetchImpl);
    const once = repairHistory(BROKEN).messages;
    for (const history of [BROKEN, BROKEN, once]) {
      await assemble(provider.createStream(history, TOOLS));
    }
    expect(vendor.history(raw[0]!)).toEqual(REPAIRED);
    // Byte for byte, twice and from an already repaired copy. One byte that
    // moves between sends and the prompt cache misses from there on.
    expect(raw[1]).toBe(raw[0]);
    expect(raw[2]).toBe(raw[0]);
    expect(repairHistory(once).messages).toEqual(once);
  });

  it("renames an id the next reply reuses, call and result together", async () => {
    // Anthropic and Responses reject a second `functions.search:0`, and the
    // turn after a Kimi reply on a rotation can land on either.
    const { raw, fetchImpl } = recording(vendor.turn);
    await assemble(vendor.create(fetchImpl).createStream(KIMI_TWICE, TOOLS));
    const id = vendor.kimiId;
    const pairs = vendor.history(raw[0]!).filter((item) => "call" in item || "result" in item);
    expect(pairs).toEqual([
      { call: id, name: "search" },
      { result: id, text: "3 cats" },
      { call: `${id}_2`, name: "search" },
      { result: `${id}_2`, text: "2 dogs" },
    ]);
  });

  it("takes its own turn back as history, exactly as collectTurn assembled it", async () => {
    // The loop's whole job between two requests: append the message, answer
    // its calls, send. A message only one wire can read back breaks the app
    // the day a chain hands the next turn to another adapter.
    const { message } = await collectTurn(ask(vendor.create(serving(vendor.turn))));
    const { raw, fetchImpl } = recording(vendor.turn);
    const results: ChatMessage[] = (message.toolCalls ?? []).map((call) => ({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: "3 cats",
    }));
    await assemble(
      vendor
        .create(fetchImpl)
        .createStream([{ role: "user", content: "find cats" }, message, ...results], TOOLS),
    );
    expect(vendor.history(raw[0]!)).toEqual([
      { user: "find cats" },
      { assistant: "Hello there" },
      { call: "call_1", name: "search" },
      { result: "call_1", text: "3 cats" },
    ]);
  });

  it("sends a service tier or refuses it before any request, and never drops it", async () => {
    const tier = recording(vendor.turn);
    const stream = ask(vendor.create(tier.fetchImpl), { serviceTier: "priority" });
    if (vendor.takesServiceTier) {
      await assemble(stream);
      expect(tier.sent[0]).toMatchObject({ service_tier: "priority" });
    } else {
      expect(await thrownBy(stream)).toMatchObject({ kind: "invalid" });
      expect(tier.sent).toHaveLength(0);
    }
    // Silence sends nothing, on every wire.
    const silence = recording(vendor.turn);
    await assemble(ask(vendor.create(silence.fetchImpl)));
    expect(silence.sent[0]).not.toHaveProperty("service_tier");
  });

  it("sends a file part or refuses it before any request, and never drops it", async () => {
    // A dropped attachment is a model answering about a file it never saw, on
    // the happy path, where nothing retries and nothing logs.
    const pdf = recording(vendor.turn);
    const provider = vendor.create(pdf.fetchImpl);
    const stream = provider.createStream(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in it" },
            { type: "file", mimeType: "application/pdf", data: "JVBERi0" },
          ],
        },
      ],
      [],
    );
    if (vendor.takesFiles) {
      await assemble(stream);
      expect(JSON.stringify(pdf.sent[0])).toContain("JVBERi0");
    } else {
      const error = await thrownBy(stream);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ kind: "invalid", provider: provider.id });
      expect(String(error)).toContain(`${provider.id}:`);
      expect(String(error)).toContain("application/pdf");
      expect(pdf.sent).toHaveLength(0);
    }

    // An image is still an image on every wire.
    const png = recording(vendor.turn);
    await assemble(
      vendor
        .create(png.fetchImpl)
        .createStream(
          [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "iVBORw0K" }] }],
          [],
        ),
    );
    expect(JSON.stringify(png.sent[0])).toContain("iVBORw0K");
  });

  it("normalizes its own dialect into the one turn every vendor must produce", async () => {
    expect(await assemble(ask(vendor.create(serving(vendor.turn))))).toEqual(theTurn(vendor));
  });

  it("keeps the whole turn when the socket dies after its last event", async () => {
    // Kimi, GLM and OpenCode Go: the answer arrives whole, `[DONE]` or
    // `message_stop` included, and then the read after it fails. Reading on
    // threw away a turn the caller had already been shown (cc-proxy, measured).
    expect(await assemble(ask(vendor.create(dying(vendor.turn))))).toEqual(theTurn(vendor));
  });

  it("keeps a turn whose finish arrived when the socket dies before the rest", async () => {
    // The finish is stated and only trailing frames are left: the usage record
    // on the OpenAI shape, `message_stop` on Anthropic's. Gemini and Responses
    // end on the frame that states the finish, so the test above covers them.
    const trailingFrom: Partial<Record<string, string>> = {
      openai: 'data: {"choices":[],"usage"',
      anthropic: "event: message_stop",
    };
    const trailing = trailingFrom[vendor.name];
    if (!trailing) return;
    const cut = vendor.turn.slice(0, vendor.turn.indexOf(trailing));
    expect(await assemble(ask(vendor.create(dying(cut))))).toEqual({
      ...theTurn(vendor),
      // Lost with the frame that carried it. Anthropic's came in `message_delta`.
      ...(vendor.name === "openai" ? { usage: NO_USAGE } : {}),
    });
  });

  it("throws a retryable error on a finish it does not know", async () => {
    // DeepSeek's `insufficient_system_resource`, Gemini's `OTHER`: each ended
    // the stream as a clean success once, a turn the backend gave up on read
    // as an answer. Each wire states its finish in its own place; one of these
    // swaps lands on each.
    const unknown = rewrite(vendor.turn, [
      ['"finish_reason":"tool_calls"', '"finish_reason":"mystery"'],
      ['"stop_reason":"tool_use"', '"stop_reason":"mystery"'],
      ['"finishReason":"STOP"', '"finishReason":"MYSTERY"'],
      [
        '"type":"response.completed","response":{',
        '"type":"response.completed","response":{"status":"mystery",',
      ],
    ]);
    const err = await thrownBy(ask(vendor.create(serving(unknown))));
    expect(failure(err)).toMatchObject({ kind: "overload" });
    expect((err as ProviderError).isTransient).toBe(true);
  });

  it("fails a frame that is not JSON on the JSON wires, after what came before it", async () => {
    // Keep-alives are comments or JSON pings, dropped or ignored before this
    // point, so a frame that does not parse is a lost event. Gemini is the
    // documented exception: its suite pins a skip.
    const at = vendor.turn.indexOf(" there");
    const start = vendor.turn.lastIndexOf("data:", at);
    const broken = `${vendor.turn.slice(0, start)}data: {"not json\n\n${vendor.turn.slice(start)}`;
    const stream = ask(vendor.create(serving(broken)));
    if (vendor.name === "gemini") {
      expect(await assemble(stream)).toEqual(theTurn(vendor));
      return;
    }
    expect(failure(await thrownBy(stream))).toMatchObject({ kind: "network" });
  });

  it("finishes a turn that called a tool as tool_calls, even when it says stop", async () => {
    // Several gateways end a tool turn on a plain stop, and a caller reading
    // that as done never runs the tool. Gemini always says STOP and Responses
    // never states a reason, so only the first two wires need the swap.
    const saysStop = rewrite(
      vendor.turn,
      [
        ['"finish_reason":"tool_calls"', '"finish_reason":"stop"'],
        ['"stop_reason":"tool_use"', '"stop_reason":"end_turn"'],
      ],
      vendor.name === "openai" || vendor.name === "anthropic",
    );
    expect(await assemble(ask(vendor.create(serving(saysStop))))).toEqual(theTurn(vendor));
  });

  it("fails a tool call that has no name", async () => {
    // Nothing says which tool to run. Passed on, the loop failed one step
    // later with nothing to say why.
    const nameless = rewrite(vendor.turn, [['"name":"search",', ""]]);
    const err = await thrownBy(ask(vendor.create(serving(nameless))));
    expect(failure(err)).toMatchObject({ kind: "overload" });
  });

  it("gives a tool call with no id one, and the same one on every wire", async () => {
    // The result is paired back to its call by id, so a call without one
    // can't be answered. Responses names it `call_id`.
    const noId = rewrite(vendor.turn, [
      ['"id":"call_1",', ""],
      ['"call_id":"call_1",', ""],
    ]);
    const turn = await assemble(ask(vendor.create(serving(noId))));
    expect(turn).toEqual({
      ...theTurn(vendor),
      toolCalls: [
        { id: expect.stringMatching(/^call_pk_\w+$/), name: "search", arguments: '{"q":"cats"}' },
      ],
    });
  });

  it("delivers what arrived, then says the stream was cut", async () => {
    // A socket that closes mid-turn. A synthesized `stop` reads to every caller
    // as a model that chose to answer that much, so the run is never retried
    // and the truncated answer is kept. A quiet null finish reads the same way
    // to every caller that never checks it — and books a billed turn as free.
    // So all four hand over what came, then throw the `network` failure a
    // socket dying mid-read throws.
    const cut = vendor.turn.slice(0, vendor.turn.indexOf(" there"));
    const delivered: ProviderChunk[] = [];
    const err = await thrownBy(
      (async function* () {
        for await (const chunk of ask(vendor.create(serving(cut)))) {
          delivered.push(chunk);
          yield chunk;
        }
      })(),
    );
    expect(failure(err)).toMatchObject({ kind: "network" });
    expect(
      await assemble(
        (async function* () {
          yield* delivered;
        })(),
      ),
    ).toEqual({
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

  it("hands over a window's fill from the headers of a turn that went through", async () => {
    // `onRateLimit` is on the seam, so every wire answers it the same way: a
    // caller watching a Claude or ChatGPT subscription fill must not go blind
    // the day a chain hands the turn to another adapter.
    const resetAt = Math.floor(Date.now() / 1000) + 3 * 86_400;
    const headers = {
      "anthropic-ratelimit-unified-5h-utilization": "0.2",
      "anthropic-ratelimit-unified-5h-reset": String(resetAt - 86_400),
      "anthropic-ratelimit-unified-7d-utilization": "0.91",
      "anthropic-ratelimit-unified-7d-reset": String(resetAt),
    };
    const stamped: typeof fetch = async () =>
      new Response(socketBody(vendor.turn), { status: 200, headers });
    const readings: unknown[] = [];
    await assemble(ask(vendor.create(stamped), { onRateLimit: (r) => readings.push(r) }));
    expect(readings).toEqual([{ window: "weekly", utilization: 0.91, resetAtMs: resetAt * 1000 }]);
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

  it("reports a refused request that lands after the headers as invalid, never overload", async () => {
    // Its type is the only evidence. Floored to overload, it was retried and
    // walked every backup, cooling each, on a request they all refuse alike.
    const err = await thrownBy(ask(vendor.create(serving(vendor.refused))));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("invalid");
  });

  it("gives up on a stream that goes quiet, and never on one that is talking", async () => {
    // The fixture beats every 5ms. The idle clock needs real headroom over
    // that: at 20ms, a full parallel run delayed one beat past it and the
    // socket's clock fired instead of the progress clock.
    const clocks = { idleMs: 200, progressMs: 400 };
    const watch = streamWatch({ provider: vendor.name, ...clocks });
    const err = await thrownBy(
      watchChunks(
        watch,
        vendor.create(wedged).createStream([{ role: "user", content: "hi" }], [], {
          signal: watch.signal,
          onActivity: watch.sawActivity,
        }),
      ),
    );
    expect(failure(err)).toMatchObject({ kind: "timeout" });
    // Keep-alive bytes arrived, and they keep the socket's clock alive — but
    // the progress clock is on EVENTS at the seam, which is what a wedged
    // prefill actually starves the caller of.
    expect(String(err)).toContain("without a chunk");
    expect(watch.firstChunkMs()).toBeNull();

    const talking = streamWatch({ provider: vendor.name, ...clocks });
    await assemble(watchChunks(talking, ask(vendor.create(serving(vendor.turn)))));
    expect(talking.firstChunkMs()).not.toBeNull();
  });
});

describe.each(VENDORS)("$name, hosted tools", (vendor) => {
  const { hosted } = vendor;
  const create = hosted.create ?? vendor.create;
  const searched = async () => (await drain(ask(create(serving(hosted.turn)), SEARCH))).message;

  it("sends each hosted type or refuses it before any request, and never drops one", async () => {
    // A gateway that ignores a tool it doesn't know answers unsearched, on the
    // happy path, where nothing retries and nothing logs.
    for (const type of HOSTED_TOOL_TYPES) {
      const { sent, fetchImpl } = recording(hosted.turn);
      const stream = ask(create(fetchImpl), { hostedTools: [PLAIN[type]] });
      if (hosted.serves.includes(type)) {
        await drain(stream);
        expect(hosted.sends(sent[0]!, type), type).toBe(true);
      } else {
        expect(await thrownBy(stream), type).toMatchObject({ kind: "invalid" });
        expect(sent, type).toHaveLength(0);
      }
    }
    // Silence sends none, on every wire.
    const silence = recording(hosted.turn);
    await drain(ask(create(silence.fetchImpl)));
    for (const type of HOSTED_TOOL_TYPES) expect(hosted.sends(silence.sent[0]!, type)).toBe(false);
  });

  it("refuses a field the wire can't apply, and drops an optional tool whole", async () => {
    // Sent without its domain filter or use cap, the tool would do more than
    // the caller allowed. Optional drops the tool, which only does less.
    const { tool, create: at = create } = hosted.unapplied;
    const refused = recording(hosted.turn);
    expect(await thrownBy(ask(at(refused.fetchImpl), { hostedTools: [tool] }))).toMatchObject({
      kind: "invalid",
    });
    expect(refused.sent).toHaveLength(0);
    const optional = recording(hosted.turn);
    await drain(ask(at(optional.fetchImpl), { hostedTools: [{ ...tool, optional: true }] }));
    expect(hosted.sends(optional.sent[0]!, tool.type)).toBe(false);
  });

  it("assembles one search turn into the same answer as every other wire", async () => {
    const { message, usage, finishReason } = await drain(ask(create(serving(hosted.turn)), SEARCH));
    expect({
      text: message.content,
      citations: (message.citations ?? []).map(({ source }) => ({
        url: source.url,
        title: source.title,
      })),
      // A search is never a tool call for the loop to run.
      toolCalls: message.toolCalls ?? [],
      webSearches: usage.hostedCalls?.web_search,
      finishReason,
    }).toEqual({
      text: ANSWER,
      citations: [{ url: SOURCE_URL, title: "Cat sleep" }],
      toolCalls: [],
      webSearches: 1,
      finishReason: "stop",
    });
    // A record of the search itself, on the three wires that state one.
    const records = message.hostedCalls?.map((call) => ({
      type: call.type,
      status: call.status,
      query: call.input?.query,
      sources: call.output?.sources?.map((source) => source.url),
      at: call.at,
    }));
    expect(records).toEqual(
      hosted.records
        ? [{ type: "web_search", status: "completed", query: QUERY, sources: [SOURCE_URL], at: 0 }]
        : undefined,
    );
  });

  it("never retries a stream past a hosted call, and the reader keeps what arrived", async () => {
    // The chat wire states no hosted call, so nothing hosted can commit it.
    if (!hosted.committed) return;
    const { bytes, opts } = hosted.committed;
    let fetches = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches += 1;
      return dying(bytes)(input, init);
    }) as unknown as typeof fetch;
    const delivered: ProviderChunk[] = [];
    const err = await thrownBy(
      (async function* () {
        // Retried past it, the vendor reruns and rebills its search, and the
        // reader sees the search twice (invariants 1 and 16).
        for await (const chunk of withStreamRetry(
          (signal) => ask(withWatchdog(create(fetchImpl)), { ...opts, signal }),
          { maxAttempts: 3, sleep: async () => {} },
        )) {
          delivered.push(chunk);
          yield chunk;
        }
      })(),
    );
    expect(classify(err)).toBe("network");
    expect(fetches).toBe(1);
    expect(delivered.some((chunk) => chunk.hosted?.length)).toBe(true);
  });

  it("takes its own hosted turn back as the same bytes every time, and other wires take its text", async () => {
    const message = await searched();
    const history: ChatMessage[] = [
      { role: "user", content: QUERY },
      message,
      { role: "user", content: "and dogs?" },
    ];
    const own = recording(vendor.turn);
    const provider = create(own.fetchImpl);
    await drain(provider.createStream(history, TOOLS));
    await drain(provider.createStream(history, TOOLS));
    // Byte for byte: the prompt cache is a prefix cache (invariant 14).
    expect(own.raw[1]).toBe(own.raw[0]);
    // The vendor's own record goes back to the wire that made it, and only there.
    if (hosted.replays) expect(own.raw[0]).toContain(hosted.replays);
    for (const other of VENDORS) {
      if (other === vendor) continue;
      const theirs = recording(other.turn);
      await drain(other.create(theirs.fetchImpl).createStream(history, TOOLS));
      expect(other.history(theirs.raw[0]!), other.name).toEqual([
        { user: QUERY },
        { assistant: ANSWER },
        { user: "and dogs?" },
      ]);
      if (other.hosted.replays) expect(theirs.raw[0]).not.toContain(other.hosted.replays);
    }
  });

  it("sends an edited hosted turn back as plain text", async () => {
    // A citation sent back over edited text vouches for words its source
    // never backed, so an answer that no longer fits its record goes as text.
    const message = await searched();
    const edited = { ...message, content: `${message.content} Edited.` };
    const { raw, fetchImpl } = recording(vendor.turn);
    await drain(
      create(fetchImpl).createStream(
        [{ role: "user", content: QUERY }, edited, { role: "user", content: "and dogs?" }],
        TOOLS,
      ),
    );
    expect(vendor.history(raw[0]!)).toEqual([
      { user: QUERY },
      { assistant: edited.content },
      { user: "and dogs?" },
    ]);
    if (hosted.replays) expect(raw[0]).not.toContain(hosted.replays);
  });

  it("sends no hosted tool when the choice is none, and refuses one beside a forced choice", async () => {
    const none = recording(hosted.turn);
    await drain(ask(create(none.fetchImpl), { ...SEARCH, toolChoice: "none" }));
    expect(hosted.sends(none.sent[0]!, "web_search")).toBe(false);
    // Anthropic's `any` and Responses' `required` can be met by a vendor tool,
    // Gemini's ANY cannot: the pair has no one meaning, so no wire takes it.
    const forced: ToolChoice[] = ["required", { name: "search" }];
    for (const toolChoice of forced) {
      const { sent, fetchImpl } = recording(hosted.turn);
      expect(await thrownBy(ask(create(fetchImpl), { ...SEARCH, toolChoice }))).toMatchObject({
        kind: "invalid",
      });
      expect(sent).toHaveLength(0);
    }
  });

  it("completes a turn whose hosted call failed, with the failure as data", async () => {
    // The chat wire states no hosted call, so it has none to fail.
    if (!hosted.failed) return;
    const { turn, opts, error } = hosted.failed;
    const { message, finishReason } = await drain(ask(create(serving(turn)), opts));
    expect(message.hostedCalls?.[0]).toMatchObject({ status: "failed", error });
    expect(message.content).not.toBe("");
    expect(message.toolCalls).toBeUndefined();
    expect(finishReason).toBe("stop");
  });

  it("keeps each citation on the characters it covers, past an emoji", async () => {
    // Anthropic places its blocks in the text itself, Gemini counts UTF-8
    // bytes, OpenAI counts code points. gemini.test.ts pins the byte
    // conversion on an answer that repeats its claim, where matching the text
    // alone can't stand in for it.
    const message = await searched();
    const [citation] = message.citations ?? [];
    expect(citation?.anchor).toBe(hosted.cited.anchor);
    expect(message.content.slice(citation?.start, citation?.end)).toBe(hosted.cited.text);
  });
});
