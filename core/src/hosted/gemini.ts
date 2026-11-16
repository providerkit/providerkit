// Built-ins and grounding follow Vercel AI SDK (Apache-2.0), PydanticAI
// and TanStack (MIT). See THIRD_PARTY_NOTICES.
import { ProviderError } from "../errors.ts";
import {
  hostedCounts,
  hostedRefused,
  hostedReplay,
  HostedRecorder,
  planHostedTools,
  queryInput,
  servedAt,
  utf8Index,
  isRecord,
} from "./shared.ts";
import type {
  Citation,
  HostedCallDelta,
  HostedInput,
  HostedTool,
  HostedToolType,
  Source,
} from "./types.ts";
import type {
  GeminiConfig,
  GeminiPart,
  GeminiResponse,
  GroundingSegment,
  GroundingChunk,
  GroundingMetadata,
} from "../providers/gemini.ts";
import type {
  ChatMessage,
  ToolCall,
  ToolDefinition,
  StreamOptions,
  ProviderChunk,
  TokenUsage,
} from "../types.ts";

/** The hosted types this wire has a shape for, and the fields it applies.
 *  Gemini's built-ins take no domain filter, use cap or location. */
const GEMINI_FIELDS: Partial<Record<HostedToolType, readonly string[]>> = {
  web_search: [],
  web_fetch: [],
  code_execution: [],
  file_search: ["storeIds", "maxResults"],
};
const GEMINI_SENDS = Object.keys(GEMINI_FIELDS);

/** One built-in tool on the wire. Shapes from Vercel's AI SDK (Apache-2.0),
 *  google-prepare-tools.ts:85-140. */
function geminiHostedTool(provider: string, tool: HostedTool): unknown {
  switch (tool.type) {
    case "web_search":
      return { googleSearch: {} };
    case "web_fetch":
      return { urlContext: {} };
    case "code_execution":
      return { codeExecution: {} };
    case "file_search":
      return {
        fileSearch: {
          fileSearchStoreNames: tool.storeIds,
          ...(tool.maxResults !== undefined ? { topK: tool.maxResults } : {}),
        },
      };
    default:
      // planHostedTools only passes the types in GEMINI_FIELDS.
      throw new ProviderError(provider, "invalid", `${provider}: no Gemini shape for ${tool.type}`);
  }
}

/** The seam's type for a server-side tool part (`toolCall`, `toolResponse`),
 *  by Gemini's `toolType` (TanStack ai-gemini text.ts:161-177, MIT). */
function serverToolType(toolType: string | undefined): HostedToolType | undefined {
  if (!toolType) return undefined;
  if (toolType.startsWith("GOOGLE_SEARCH")) return "web_search";
  if (toolType === "URL_CONTEXT") return "web_fetch";
  if (toolType === "CODE_EXECUTION") return "code_execution";
  if (toolType === "FILE_SEARCH") return "file_search";
  return undefined;
}

function serverToolUrls(args: Record<string, unknown> | undefined): string[] {
  return [args?.url, ...(Array.isArray(args?.urls) ? args.urls : [])].filter(
    (url): url is string => typeof url === "string" && !!url,
  );
}

function serverToolInput(args: Record<string, unknown> | undefined): HostedInput {
  if (!args) return {};
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const search = queryInput([text(args.query), ...list(args.queries)]);
  if (Object.keys(search).length > 0) return search;
  const url = serverToolUrls(args)[0];
  return url ? { url } : {};
}

// File Search can arrive as executable code with its result in grounding, not
// as a code run. Ported from PydanticAI (MIT), _FILE_SEARCH_QUERY_PATTERN.
const FILE_SEARCH_QUERY = /file_search\.query\(query=(["'])((?:\\.|(?!\1)[^\\])*)\1\)/;

/** Text fragments of one response Part, with its offset in the flat answer.
 *  Non-text Parts occupy empty slots so grounding's partIndex keeps its meaning. */
interface GeminiTextPart {
  text: string;
  at: number;
  thought: boolean;
}

/**
 * Where a grounding segment sits in the answer, as JS indices. Gemini counts
 * in UTF-8 bytes, so the offsets are converted and then checked against the
 * segment's own text. Google sometimes reports a segment a byte off; the text
 * still places it when it occurs once. Otherwise the citation keeps its
 * source and no span. Ported from PydanticAI (MIT), models/google.py:2347-2405.
 */
function segmentSpan(
  answer: string,
  segment: GroundingSegment | undefined,
  parts: readonly (GeminiTextPart | undefined)[],
): { start: number; end: number } | undefined {
  if (!segment?.text) return undefined;
  const part = segment.partIndex === undefined ? undefined : parts[segment.partIndex];
  // An explicit Part index never falls back to a different Part's words.
  if (segment.partIndex !== undefined && (!part || part.thought)) return undefined;
  const text = part?.text ?? answer;
  const offset = part?.at ?? 0;
  const said = segment.text;
  const start = utf8Index(text, segment.startIndex ?? 0);
  const end = utf8Index(text, segment.endIndex ?? 0);
  if (start !== undefined && end !== undefined && start < end && text.slice(start, end) === said) {
    return { start: offset + start, end: offset + end };
  }
  const at = text.indexOf(said);
  return at !== -1 && text.indexOf(said, at + 1) === -1
    ? { start: offset + at, end: offset + at + said.length }
    : undefined;
}

/** A grounding chunk as a source: a web page, or a passage of a stored file. */
function chunkSource(chunk: GroundingChunk): Source | undefined {
  if (chunk.web?.uri) {
    return {
      type: "url",
      url: chunk.web.uri,
      ...(chunk.web.title ? { title: chunk.web.title } : {}),
    };
  }
  const context = chunk.retrievedContext;
  if (!context) return undefined;
  return {
    type: "file",
    ...(context.uri ? { url: context.uri } : {}),
    ...(context.title ? { title: context.title } : {}),
    ...(context.text ? { excerpt: context.text } : {}),
  };
}

/** The first of each URL, in order: a page several supports cite is one
 *  source of the search, not several. */
function distinctSources(sources: readonly Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.url ?? source.title ?? source.excerpt ?? "";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const geminiHosted = {
  plan(
    config: GeminiConfig,
    baseUrl: string,
    id: string,
    isAntigravity: boolean,
    isGemini2: boolean,
    tools: ToolDefinition[],
    opts: StreamOptions,
  ) {
    let hosted = planHostedTools(
      id,
      {
        name: "Gemini",
        serves: isAntigravity
          ? []
          : (
              config.servesHostedTools ??
              servedAt(baseUrl, "generativelanguage.googleapis.com", [
                "web_search",
                "web_fetch",
                "code_execution",
                "file_search",
              ])
            ).filter((type) => GEMINI_SENDS.includes(type)),
        fields: GEMINI_FIELDS,
        // Gemini 2 runs built-in tools or function tools in one request, not
        // both (Vercel warns and drops the functions, google-prepare-tools.ts:70-79).
        refuse: () =>
          isGemini2 && tools.length > 0
            ? "Gemini 2 can't run hosted tools beside function tools. Use a Gemini 3 model, " +
              "send the hosted tools on a call without function tools, or mark them optional."
            : undefined,
      },
      opts,
    );

    // File Search cannot share a request with other built-ins (Google's
    // File Search guide, limitations). Apply this after field refusals so an
    // optional sibling never excuses a required tool's unsupported setting.
    const fileSearch = hosted.find((tool) => tool.type === "file_search");
    const otherHosted = hosted.filter((tool) => tool !== fileSearch);
    if (fileSearch && otherHosted.length > 0) {
      if (otherHosted.some((tool) => !tool.optional)) {
        if (!fileSearch.optional) {
          throw hostedRefused(
            id,
            "Gemini",
            "file_search",
            "File Search can't run beside other hosted tools. Send it on a separate call, " +
              "or mark a conflicting tool optional.",
          );
        }
        hosted = otherHosted;
      } else {
        hosted = [fileSearch];
      }
    }

    return { hosted, tools: hosted.map((tool) => geminiHostedTool(id, tool)) };
  },
  replay(
    message: Extract<ChatMessage, { role: "assistant" }>,
    provider: string,
    functionCallPart: (call: ToolCall) => unknown,
  ): unknown[] | undefined {
    return hostedReplay(message, provider)?.map((entry) => {
      if ("call" in entry) return functionCallPart(entry.call);
      if ("item" in entry) return entry.item;
      return { text: entry.text };
    });
  },
  stream(id: string, hosted: HostedTool[], isGemini2: boolean) {
    const recorder = new HostedRecorder();
    // The answer so far, thoughts left out: what grounding offsets count into.
    let text = "";
    const textParts: (GeminiTextPart | undefined)[] = [];
    // The model turn's parts, for `hostedItems`: the built-in parts as they
    // came, its text as `{ length }`, its function calls as `{ call }`.
    const items: unknown[] = [];
    const builtInParts = new Set<unknown>();
    let recordedCalls = 0;
    // The code run a result answers, and the server call a response does:
    // Gemini pairs them by order. Each open call's part, so one that never
    // got its result can leave the record.
    let lastCode: string | undefined;
    let lastServer: string | undefined;
    const openParts = new Map<string, unknown>();
    // Calls that late grounding or URL metadata fills, never a second run.
    let searchIndex: number | undefined;
    const fileSearches = new Map<string, number>();
    const fetches = new Map<string, { index: number; urls: string[] }>();
    // The last of each that the stream stated: Gemini repeats them as it goes.
    let grounding: GroundingMetadata | undefined;
    const searchQueries = new Set<string>();
    let returnedWebSource = false;
    let urlContext:
      | { urlMetadata?: { retrievedUrl?: string; urlRetrievalStatus?: string }[] }
      | undefined;
    let lastUsage: TokenUsage | undefined;
    const searched = hosted.some((tool) => tool.type === "web_search");
    const fileSearched = hosted.some((tool) => tool.type === "file_search");
    const withCounts = (usage: TokenUsage): TokenUsage => {
      // Google bills unique non-empty queries on Gemini 3+, but only one
      // grounded prompt on Gemini 2.5, and only when it returns a web source.
      // Ported from PydanticAI (MIT), _set_web_search_usage.
      const billableSearches = isGemini2
        ? Number(searchQueries.size > 0 && returnedWebSource)
        : searchQueries.size;
      const hostedCalls = hostedCounts(
        recorder.shown(),
        searched && grounding ? { web_search: billableSearches } : undefined,
      );
      return hostedCalls ? { ...usage, hostedCalls } : usage;
    };

    // A built-in tool's part as its hosted delta (`delta` absent when the
    // part changes no record), or undefined for any other part.
    const builtIn = (part: GeminiPart, at: number): { delta?: HostedCallDelta } | undefined => {
      if (part.executableCode) {
        const { code, language } = part.executableCode;
        const fileQuery = fileSearched && code?.match(FILE_SEARCH_QUERY);
        const started = fileQuery
          ? recorder.start(undefined, "file_search", at, {
              query: fileQuery[2]!.replace(/\\([\\'"])/g, "$1"),
            })
          : recorder.start(undefined, "code_execution", at, {
              ...(code ? { code } : {}),
              ...(language ? { language: language.toLowerCase() } : {}),
            });
        if (fileQuery) fileSearches.set(started.id, started.index);
        else lastCode = started.id;
        openParts.set(started.id, part);
        return { delta: started };
      }
      if (part.codeExecutionResult) {
        const { outcome, output } = part.codeExecutionResult;
        // OUTCOME_FAILED ran the program, and the program failed: that is
        // its stderr, as a shell's non-zero exit is on Anthropic. A deadline,
        // or an outcome nobody named, is the tool failing (invariant 7: data).
        const ran = outcome === "OUTCOME_OK" || outcome === "OUTCOME_FAILED";
        let said: { stdout: string } | { stderr: string } | undefined;
        if (output) said = outcome === "OUTCOME_OK" ? { stdout: output } : { stderr: output };
        const delta = recorder.end(lastCode, {
          status: ran ? "completed" : "failed",
          ...(said ? { output: said } : {}),
          ...(ran ? {} : { error: outcome ?? "OUTCOME_UNSPECIFIED" }),
        });
        lastCode = undefined;
        return delta ? { delta } : {};
      }
      if (part.toolCall) {
        const type = serverToolType(part.toolCall.toolType);
        if (!type) return {};
        const started = recorder.start(
          part.toolCall.id,
          type,
          at,
          serverToolInput(part.toolCall.args),
        );
        lastServer = started.id;
        openParts.set(started.id, part);
        if (type === "web_search") searchIndex ??= started.index;
        if (type === "file_search") fileSearches.set(started.id, started.index);
        if (type === "web_fetch") {
          fetches.set(started.id, {
            index: started.index,
            urls: serverToolUrls(part.toolCall.args),
          });
        }
        return { delta: started };
      }
      if (part.toolResponse) {
        const delta = recorder.end(part.toolResponse.id ?? lastServer, { status: "completed" });
        lastServer = undefined;
        return delta ? { delta } : {};
      }
      return undefined;
    };

    // The end of the turn, before its finish: grounding and URL context
    // become records and citations now that the whole answer is known, a
    // code run with no result fails, and the parts worth replaying go out.
    function* closeTurn(): Generator<ProviderChunk> {
      const deltas: HostedCallDelta[] = [];
      const citations: Citation[] = [];
      if (grounding) {
        const sources = (grounding.groundingChunks ?? []).map(chunkSource);
        for (const support of grounding.groundingSupports ?? []) {
          const span = segmentSpan(text, support.segment, textParts);
          for (const at of support.groundingChunkIndices ?? []) {
            const source = sources[at];
            if (source) citations.push({ source, ...(span ? { ...span, anchor: "claim" } : {}) });
          }
        }
        const found = distinctSources(sources.filter((source) => source !== undefined));
        const web = found.filter((source) => source.type === "url");
        const files = found.filter((source) => source.type === "file");
        const suggestions = grounding.searchEntryPoint?.renderedContent;
        const queries = grounding.webSearchQueries ?? [];
        // One search record for the whole answer, at its start: Gemini says
        // only that it searched, after the answer it grounded.
        if (searched && (web.length > 0 || queries.length > 0 || suggestions)) {
          const output = {
            ...(web.length > 0 ? { sources: web } : {}),
            ...(suggestions ? { searchSuggestions: suggestions } : {}),
          };
          const input = queryInput(queries);
          deltas.push(
            searchIndex !== undefined
              ? { index: searchIndex, output }
              : recorder.whole(undefined, "web_search", 0, {
                  status: "completed",
                  ...(Object.keys(input).length > 0 ? { input } : {}),
                  output,
                }),
          );
        }
        if (fileSearched && files.length > 0) {
          const result = { status: "completed" as const, output: { sources: files } };
          if (fileSearches.size > 0) {
            // Gemini 3 sends empty server responses; Gemini 2.5 exposes the
            // query as executable code. Both get their passages here.
            for (const [key, index] of fileSearches) {
              deltas.push(recorder.end(key, result) ?? { index, output: result.output });
            }
          } else {
            deltas.push(recorder.whole(undefined, "file_search", 0, result));
          }
        }
      }
      const retrieved = urlContext?.urlMetadata ?? [];
      const matchedUrls = new Set<string>();
      for (const [key, { index, urls }] of fetches) {
        // One server invocation can fetch several URLs. Metadata is the
        // authoritative result, even after an empty toolResponse completed it.
        const results = retrieved.filter(
          (entry) => entry.retrievedUrl && urls.includes(entry.retrievedUrl),
        );
        if (results.length === 0) continue;
        const sources: Source[] = [];
        const errors = new Set<string>();
        for (const { retrievedUrl: url, urlRetrievalStatus: status } of results) {
          if (!url) continue;
          matchedUrls.add(url);
          if (status === "URL_RETRIEVAL_STATUS_SUCCESS") sources.push({ type: "url", url });
          else errors.add(status ?? "URL_RETRIEVAL_STATUS_UNSPECIFIED");
        }
        const result = {
          status: errors.size > 0 ? ("failed" as const) : ("completed" as const),
          ...(sources.length > 0 ? { output: { sources } } : {}),
          ...(errors.size > 0 ? { error: [...errors].join(", ") } : {}),
        };
        deltas.push(recorder.end(key, result) ?? { index, ...result });
      }
      for (const { retrievedUrl: url, urlRetrievalStatus: status } of retrieved) {
        if (!url || matchedUrls.has(url)) continue;
        const ok = status === "URL_RETRIEVAL_STATUS_SUCCESS";
        deltas.push(
          recorder.whole(undefined, "web_fetch", 0, {
            status: ok ? "completed" : "failed",
            input: { url },
            ...(ok
              ? { output: { sources: [{ type: "url", url }] } }
              : { error: status ?? "URL_RETRIEVAL_STATUS_UNSPECIFIED" }),
          }),
        );
      }
      const dropped = new Set([...recorder.unsettled()].map((key) => openParts.get(key)));
      deltas.push(...recorder.settle());
      if (deltas.length > 0) yield { type: "delta", hosted: deltas };
      if (citations.length > 0) yield { type: "delta", citations };
      const kept = items.filter((item) => !dropped.has(item));
      if (kept.some((item) => builtInParts.has(item))) {
        yield { type: "delta", hostedItems: { provider: id, items: kept } };
      }
      // The usage already sent predates the records above.
      if (lastUsage && hostedCounts(recorder.shown())) {
        yield { type: "usage", usage: withCounts(lastUsage) };
      }
    }

    return {
      candidate(candidate: NonNullable<GeminiResponse["candidates"]>[number]) {
        if (candidate.groundingMetadata) {
          grounding = candidate.groundingMetadata;
          for (const query of grounding.webSearchQueries ?? []) {
            if (query.trim()) searchQueries.add(query);
          }
          returnedWebSource ||= (grounding.groundingChunks ?? []).some(
            (source) => !!source.web?.uri,
          );
        }
        if (candidate.urlContextMetadata) urlContext = candidate.urlContextMetadata;
      },
      part(part: GeminiPart, partIndex: number, pendingLength: number) {
        if (part.text !== undefined) {
          const previous = textParts.at(-1);
          const thought = !!part.thought;
          // The first text Part may continue the preceding frame. A
          // second Part in this frame, or a change of kind, starts anew.
          if (partIndex === 0 && previous && previous.thought === thought) {
            previous.text += part.text;
          } else {
            textParts.push({ text: part.text, at: text.length + pendingLength, thought });
          }
          if (part.thought) return;
          // Streamed text is one part in many pieces: one placeholder.
          const last = items.at(-1);
          if (isRecord(last) && typeof last.length === "number" && !builtInParts.has(last)) {
            last.length += part.text.length;
          } else {
            items.push({ length: part.text.length });
          }
          return;
        }
        textParts.push(undefined);
        const ran = builtIn(part, text.length + pendingLength);
        if (ran) {
          items.push(part);
          builtInParts.add(part);
          return ran;
        }
        if (part.functionCall) items.push({ call: recordedCalls++ });
        return;
      },
      text(content: string) {
        text += content;
      },
      usage(usage: TokenUsage) {
        lastUsage = usage;
        return withCounts(usage);
      },
      close: closeTurn,
    };
  },
};
