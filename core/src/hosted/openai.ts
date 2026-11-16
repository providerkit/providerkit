// Hosted Chat Completions shapes follow PydanticAI (MIT). See THIRD_PARTY_NOTICES.
import { codePointIndex, hostedCounts, planHostedTools, servedAt } from "./shared.ts";
import type { Citation, HostedTool, HostedToolType } from "./types.ts";
import type { OpenAIConfig, OpenAIChunk } from "../providers/openai.ts";
import type { ProviderChunk, StreamOptions } from "../types.ts";

/**
 * Web search as this wire carries it. OpenRouter runs it as its own server
 * tool, which takes every field (PydanticAI openrouter.py:840-853,1349-1355,
 * MIT). OpenAI's search models take `web_search_options`, which has room for a
 * location and nothing that restricts the search (PydanticAI
 * openai/_chat_model.py:357-358,975-987).
 */
function webSearchFields(openRouter: boolean): Partial<Record<HostedToolType, readonly string[]>> {
  return {
    web_search: openRouter
      ? ["allowedDomains", "blockedDomains", "maxUses", "userLocation"]
      : ["userLocation"],
  };
}

function openRouterWebSearch(tool: Extract<HostedTool, { type: "web_search" }>): unknown {
  return {
    type: "openrouter:web_search",
    parameters: {
      ...(tool.userLocation
        ? { user_location: { type: "approximate", ...tool.userLocation } }
        : {}),
      allowed_domains: tool.allowedDomains,
      excluded_domains: tool.blockedDomains,
      max_uses: tool.maxUses,
    },
  };
}

/** A chat annotation: OpenRouter's and OpenAI's search models nest it the same way. */
export interface ChatAnnotation {
  type?: string;
  url_citation?: {
    url?: string;
    title?: string;
    start_index?: number;
    end_index?: number;
    content?: string;
  };
}

/**
 * A `url_citation` as a citation. Its offsets count code points and select the
 * link the model wrote, so the span is kept only when it still contains the
 * URL; otherwise the source stays and the span goes (PydanticAI
 * openai/_citations.py:44-47,96-120, MIT).
 */
function chatCitation(annotation: ChatAnnotation, text: string): Citation | undefined {
  const cited = annotation.url_citation;
  if (annotation.type !== "url_citation" || !cited?.url) return undefined;
  const source = {
    type: "url" as const,
    url: cited.url,
    ...(cited.title ? { title: cited.title } : {}),
    ...(cited.content ? { excerpt: cited.content } : {}),
  };
  const start =
    cited.start_index === undefined ? undefined : codePointIndex(text, cited.start_index);
  const end = cited.end_index === undefined ? undefined : codePointIndex(text, cited.end_index);
  return start !== undefined &&
    end !== undefined &&
    start < end &&
    text.slice(start, end).includes(cited.url)
    ? { source, start, end, anchor: "marker" }
    : { source };
}

export const openaiHosted = {
  plan(
    config: OpenAIConfig,
    baseUrl: string,
    id: string,
    model: string,
    openRouter: boolean,
    opts: StreamOptions,
  ) {
    // On OpenAI's own API only its search models search (PydanticAI
    // profiles/openai.py:640-641).
    const searches = model.includes("-search-preview") ? (["web_search"] as const) : [];
    const hosted = planHostedTools(
      id,
      {
        name: "OpenAI chat",
        serves: (
          config.servesHostedTools ??
          (openRouter ? ["web_search"] : servedAt(baseUrl, "api.openai.com", searches))
        ).filter((type) => type === "web_search"),
        fields: webSearchFields(openRouter),
      },
      opts,
    );
    const webSearch = hosted.find(
      (tool): tool is Extract<HostedTool, { type: "web_search" }> => tool.type === "web_search",
    );
    return {
      active: hosted.length > 0,
      tools: webSearch && openRouter ? [openRouterWebSearch(webSearch)] : [],
      ...(webSearch && !openRouter
        ? {
            searchOptions: webSearch.userLocation
              ? { user_location: { type: "approximate", approximate: webSearch.userLocation } }
              : {},
          }
        : {}),
    };
  },
  stream() {
    // The answer so far, and the annotations on it, which are placed once
    // the text they index is whole: at the finish. This wire states no
    // record of the search itself, only what the answer cites and a count.
    let text = "";
    const annotations: ChatAnnotation[] = [];
    function* cite(): Generator<ProviderChunk> {
      const citations = annotations.splice(0).flatMap((annotation) => {
        const citation = chatCitation(annotation, text);
        return citation ? [citation] : [];
      });
      if (citations.length > 0) yield { type: "delta", citations };
    }
    return {
      delta(delta: NonNullable<NonNullable<OpenAIChunk["choices"]>[number]["delta"]>) {
        if (delta.content) text += delta.content;
        if (delta.annotations?.length) annotations.push(...delta.annotations);
      },
      close: cite,
    };
  },
  counts(usage: NonNullable<OpenAIChunk["usage"]>) {
    return hostedCounts({ web_search: usage.server_tool_use_details?.web_search_requests });
  },
};
