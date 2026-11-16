// Hosted shapes and annotations follow Vercel AI SDK (Apache-2.0) and
// PydanticAI (MIT). See THIRD_PARTY_NOTICES.
import { ProviderError } from "../errors.ts";
import {
  codePointIndex,
  hostedCounts,
  HostedRecorder,
  planHostedTools,
  queryInput,
  servedAt,
} from "./shared.ts";
import type {
  Citation,
  HostedCall,
  HostedCallDelta,
  HostedInput,
  HostedTool,
  HostedToolType,
} from "./types.ts";
import type { ResponsesConfig, ResponsesEvent, ResponsesItem } from "../providers/responses.ts";
import type { ImagePart, ProviderChunk, StreamOptions } from "../types.ts";

/** The hosted types this wire has a shape for, and the fields it applies. No
 *  use cap on web search, and no fetch tool, on this wire. */
const RESPONSES_FIELDS: Partial<Record<HostedToolType, readonly string[]>> = {
  web_search: ["allowedDomains", "blockedDomains", "userLocation"],
  code_execution: ["fileIds"],
  file_search: ["storeIds", "maxResults"],
  image_generation: ["size", "quality", "format", "background"],
};
const RESPONSES_SENDS = Object.keys(RESPONSES_FIELDS);

/** The output each hosted tool needs asked for by name, or it comes back
 *  without its sources, logs or results. */
const RESPONSES_INCLUDES: Partial<Record<HostedToolType, string>> = {
  web_search: "web_search_call.action.sources",
  code_execution: "code_interpreter_call.outputs",
  file_search: "file_search_call.results",
};

/** One hosted tool on the wire. Shapes from Vercel's AI SDK (Apache-2.0),
 *  openai-responses-prepare-tools.ts:238-381. */
function responsesHostedTool(provider: string, tool: HostedTool): unknown {
  switch (tool.type) {
    case "web_search":
      return {
        type: "web_search",
        ...(tool.allowedDomains || tool.blockedDomains
          ? {
              filters: {
                allowed_domains: tool.allowedDomains,
                blocked_domains: tool.blockedDomains,
              },
            }
          : {}),
        ...(tool.userLocation
          ? { user_location: { type: "approximate", ...tool.userLocation } }
          : {}),
      };
    case "code_execution":
      return { type: "code_interpreter", container: { type: "auto", file_ids: tool.fileIds } };
    case "file_search":
      return {
        type: "file_search",
        vector_store_ids: tool.storeIds,
        max_num_results: tool.maxResults,
      };
    case "image_generation":
      return {
        type: "image_generation",
        size: tool.size,
        quality: tool.quality,
        output_format: tool.format,
        background: tool.background,
      };
    default:
      // planHostedTools only passes the types in RESPONSES_FIELDS.
      throw new ProviderError(
        provider,
        "invalid",
        `${provider}: no Responses shape for ${tool.type}`,
      );
  }
}

/** The seam's type for a hosted output item, or undefined for any other item. */
const HOSTED_ITEMS: Record<string, HostedToolType> = {
  web_search_call: "web_search",
  code_interpreter_call: "code_execution",
  file_search_call: "file_search",
  image_generation_call: "image_generation",
};

/** A generated image's media type, read off its first bytes: the format the
 *  request asked for is a wish, the bytes are the image. */
function imageType(base64: string, asked: HostedTool | undefined): ImagePart["mimeType"] {
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  // ponytail: unrecognized bytes fall back to the format asked for, PNG by
  // default, which is the API's own default. Upgrade: refuse them.
  switch (asked?.type === "image_generation" ? asked.format : undefined) {
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

/** What a web search did, from its `action`: the queries it ran, or the page
 *  it opened or searched within. */
function webSearchInput(action: ResponsesItem["action"]): HostedInput | undefined {
  if (action?.type === "search") return queryInput(action.queries ?? [action.query]);
  return action?.url ? { url: action.url } : undefined;
}

/** What a hosted item says it did. `.added` states only its id and type;
 *  `.done` states the whole call. A status other than `completed` on `.done`
 *  is a failed call, kept as data (invariant 7). */
function hostedItemDelta(
  item: ResponsesItem,
  done: boolean,
  asked: HostedTool | undefined,
): Omit<HostedCallDelta, "index"> {
  const failed = done && item.status !== undefined && item.status !== "completed";
  let status: HostedCall["status"] = "running";
  if (failed) status = "failed";
  else if (done) status = "completed";
  const error = failed ? (item.error?.code ?? item.error?.message ?? item.status) : undefined;
  const base = { status, ...(error ? { error } : {}) };
  switch (item.type) {
    case "web_search_call": {
      const action = item.action;
      const input = webSearchInput(action);
      const sources = (action?.sources ?? []).flatMap((source) =>
        source.type === "url" && source.url ? [{ type: "url" as const, url: source.url }] : [],
      );
      return {
        ...base,
        ...(input && Object.keys(input).length > 0 ? { input } : {}),
        ...(done && sources.length > 0 ? { output: { sources } } : {}),
      };
    }
    case "code_interpreter_call": {
      const logs = (item.outputs ?? []).flatMap((out) =>
        out.type === "logs" && out.logs ? [out.logs] : [],
      );
      const files = (item.outputs ?? []).flatMap((out) =>
        out.type === "image" && out.url
          ? [{ url: out.url, ...(item.container_id ? { containerId: item.container_id } : {}) }]
          : [],
      );
      return {
        ...base,
        input: { ...(item.code ? { code: item.code } : {}), language: "python" },
        ...(done && (logs.length > 0 || files.length > 0)
          ? {
              output: {
                ...(logs.length > 0 ? { stdout: logs.join("\n") } : {}),
                ...(files.length > 0 ? { files } : {}),
              },
            }
          : {}),
      };
    }
    case "file_search_call": {
      const input = queryInput(item.queries ?? []);
      const sources = (item.results ?? []).map((result) => ({
        type: "file" as const,
        ...(result.file_id ? { fileId: result.file_id } : {}),
        ...(result.filename ? { title: result.filename } : {}),
        ...(result.text ? { excerpt: result.text } : {}),
      }));
      return {
        ...base,
        ...(Object.keys(input).length > 0 ? { input } : {}),
        ...(done && sources.length > 0 ? { output: { sources } } : {}),
      };
    }
    default: {
      const image = done && item.result ? item.result : undefined;
      return {
        ...base,
        ...(item.revised_prompt ? { input: { prompt: item.revised_prompt } } : {}),
        ...(image
          ? {
              output: {
                images: [{ type: "image", mimeType: imageType(image, asked), data: image }],
              },
            }
          : {}),
      };
    }
  }
}

/** An annotation Responses attached to a part of the answer. */
export interface ResponsesAnnotation {
  type?: string;
  url?: string;
  title?: string;
  file_id?: string;
  filename?: string;
  container_id?: string;
  start_index?: number;
  end_index?: number;
  index?: number;
}

/**
 * One annotation as a citation, its offsets moved from the part's code points
 * to the turn's JS indices. A URL citation selects the link the model wrote,
 * so its span is kept only while it still contains the URL (PydanticAI, MIT,
 * openai/_citations.py:112-118); a span that doesn't check out is dropped and
 * the source kept. Mapping from Vercel's AI SDK (Apache-2.0),
 * map-openai-responses-annotation.ts:11-74.
 */
function annotationCitation(
  annotation: ResponsesAnnotation,
  text: string,
  part: { start: number; end: number } | undefined,
): Citation | undefined {
  const partText = part ? text.slice(part.start, part.end) : "";
  const at = (points: number | undefined) =>
    part && points !== undefined ? codePointIndex(partText, points) : undefined;
  const span = (start: number | undefined, end: number | undefined, contains?: string) =>
    part &&
    start !== undefined &&
    end !== undefined &&
    start < end &&
    (contains === undefined || partText.slice(start, end).includes(contains))
      ? { start: part.start + start, end: part.start + end, anchor: "marker" as const }
      : {};
  switch (annotation.type) {
    case "url_citation": {
      if (!annotation.url) return undefined;
      const source = {
        type: "url" as const,
        url: annotation.url,
        ...(annotation.title ? { title: annotation.title } : {}),
      };
      return {
        source,
        ...span(at(annotation.start_index), at(annotation.end_index), annotation.url),
      };
    }
    case "file_citation":
    case "container_file_citation": {
      if (!annotation.file_id && !annotation.filename) return undefined;
      const source = {
        type: "file" as const,
        ...(annotation.file_id ? { fileId: annotation.file_id } : {}),
        ...(annotation.filename ? { title: annotation.filename } : {}),
        ...(annotation.container_id ? { containerId: annotation.container_id } : {}),
      };
      // A file citation marks one point, where the model referred to the file.
      const point = at(annotation.index);
      if (annotation.type === "file_citation") {
        return point === undefined || !part
          ? { source }
          : { source, start: part.start + point, end: part.start + point, anchor: "marker" };
      }
      return { source, ...span(at(annotation.start_index), at(annotation.end_index)) };
    }
    default:
      // `file_path` names a file code wrote, not a source of the answer.
      return undefined;
  }
}

export const responsesHosted = {
  plan(config: ResponsesConfig, baseUrl: string, id: string, opts: StreamOptions) {
    const hosted = planHostedTools(
      id,
      {
        name: "Responses",
        serves: (
          config.servesHostedTools ??
          servedAt(baseUrl, "api.openai.com", [
            "web_search",
            "code_execution",
            "file_search",
            "image_generation",
          ])
        ).filter((type) => RESPONSES_SENDS.includes(type)),
        fields: RESPONSES_FIELDS,
      },
      opts,
    );
    return {
      hosted,
      tools: hosted.map((tool) => responsesHostedTool(id, tool)),
      include: hosted.flatMap((tool) => RESPONSES_INCLUDES[tool.type] ?? []),
    };
  },
  stream(hosted: HostedTool[]) {
    // Hosted calls, by item id. The answer so far, and where each part of it
    // starts, so an annotation's offsets can be placed and checked.
    const recorder = new HostedRecorder();
    let text = "";
    const parts = new Map<string, { start: number; end: number }>();
    // Waiting annotations, by the message item they belong to.
    const annotations = new Map<string, { part: string; annotation: ResponsesAnnotation }[]>();
    const partKey = (event: ResponsesEvent) => `${event.item_id ?? ""}:${event.content_index ?? 0}`;
    const asked = (type: HostedToolType) => hosted.find((tool) => tool.type === type);
    // An annotation is placed once its part is whole: when its message item
    // ends, or, for every item still waiting, when the turn does.
    function* cite(item?: string): Generator<ProviderChunk> {
      const due =
        item === undefined ? [...annotations.values()].flat() : (annotations.get(item) ?? []);
      if (item === undefined) annotations.clear();
      else annotations.delete(item);
      const citations = due.flatMap(({ part, annotation }) => {
        const citation = annotationCitation(annotation, text, parts.get(part));
        return citation ? [citation] : [];
      });
      if (citations.length > 0) yield { type: "delta", citations };
    }
    // The end of the turn: a hosted call the backend never finished fails,
    // and every annotation still waiting is placed.
    function* closeHosted(): Generator<ProviderChunk> {
      const failed = recorder.settle();
      if (failed.length > 0) yield { type: "delta", hosted: failed };
      yield* cite();
    }

    return {
      *event(event: ResponsesEvent): Generator<ProviderChunk> {
        // Every step a hosted call reports (in progress, searching,
        // interpreting, generating) goes out as a status delta: progress the
        // watchdog's progress clock can see while the vendor's tool works.
        if (
          /^response\.(web_search|file_search|code_interpreter|image_generation)_call\.\w+$/.test(
            event.type ?? "",
          )
        ) {
          const index = recorder.indexOf(event.item_id);
          if (index !== undefined) yield { type: "delta", hosted: [{ index, status: "running" }] };
          return;
        }

        switch (event.type) {
          case "response.output_text.delta":
            if (event.delta) {
              const key = partKey(event);
              const part = parts.get(key) ?? { start: text.length, end: text.length };
              text += event.delta;
              part.end = text.length;
              parts.set(key, part);
            }
            break;

          case "response.output_text.annotation.added":
            if (event.annotation) {
              const item = event.item_id ?? "";
              const waiting = annotations.get(item) ?? [];
              waiting.push({ part: partKey(event), annotation: event.annotation });
              annotations.set(item, waiting);
            }
            break;

          case "response.code_interpreter_call_code.delta": {
            const index = recorder.indexOf(event.item_id);
            if (index !== undefined && event.delta) {
              yield { type: "delta", hosted: [{ index, codeDelta: event.delta }] };
            }
            break;
          }

          // The whole program, which wins over the deltas it repeats.
          case "response.code_interpreter_call_code.done": {
            const index = recorder.indexOf(event.item_id);
            if (index !== undefined && event.code !== undefined) {
              yield { type: "delta", hosted: [{ index, input: { code: event.code } }] };
            }
            break;
          }

          case "response.output_item.added": {
            const item = event.item;
            const type = item?.type ? HOSTED_ITEMS[item.type] : undefined;
            if (item && type) {
              // A hosted call, never a function call: no tool for the loop to
              // run, and no part in the finish reason.
              const started = recorder.start(item.id, type, text.length);
              yield {
                type: "delta",
                hosted: [{ ...started, ...hostedItemDelta(item, false, asked(type)) }],
              };
              break;
            }
            break;
          }
          case "response.output_item.done": {
            const item = event.item;
            const type = item?.type ? HOSTED_ITEMS[item.type] : undefined;
            if (item && type) {
              const delta = hostedItemDelta(item, true, asked(type));
              // A backend that sends only the finished item still ran it.
              const done =
                recorder.end(item.id, delta) ?? recorder.whole(item.id, type, text.length, delta);
              yield { type: "delta", hosted: [done] };
              break;
            }
            if (item?.type === "message") {
              yield* cite(item.id);
              break;
            }
            break;
          }
        }
      },
      close: closeHosted,
      counts: () => hostedCounts(recorder.shown()),
    };
  },
};
