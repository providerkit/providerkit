// Hosted shapes follow Vercel AI SDK (Apache-2.0) and PydanticAI (MIT).
// See THIRD_PARTY_NOTICES.
import { ProviderError } from "../errors.ts";
import { parseToolArgs } from "../tool-args.ts";
import {
  hostedCounts,
  hostedReplay,
  HostedRecorder,
  isRecord,
  planHostedTools,
  queryInput,
  servedAt,
} from "./shared.ts";
import type {
  Citation,
  HostedCallDelta,
  HostedInput,
  HostedTool,
  HostedToolType,
} from "./types.ts";
import type {
  AnthropicConfig,
  AnthropicEvent,
  AnthropicUsage,
  AnthropicMessage,
} from "../providers/anthropic.ts";
import type {
  ChatMessage,
  ToolCall,
  ToolDefinition,
  ProviderChunk,
  StreamOptions,
} from "../types.ts";

/** The hosted types this wire has a shape for, and the fields it applies. */
const ANTHROPIC_FIELDS: Partial<Record<HostedToolType, readonly string[]>> = {
  web_search: ["allowedDomains", "blockedDomains", "maxUses", "userLocation"],
  web_fetch: ["allowedDomains", "blockedDomains", "maxUses", "maxContentTokens"],
  // `fileIds` would ride as container_upload blocks in the prompt, not on the
  // tool; until that is built it is refused rather than dropped.
  code_execution: [],
};
const ANTHROPIC_SENDS = Object.keys(ANTHROPIC_FIELDS);

/** The names Anthropic's server tools answer to. A function tool under one of
 *  them, beside the hosted tool, is a request the API refuses. */
const RESERVED_NAMES: Partial<Record<HostedToolType, readonly string[]>> = {
  web_search: ["web_search"],
  web_fetch: ["web_fetch"],
  code_execution: ["code_execution", "bash_code_execution", "text_editor_code_execution"],
};

/** A paused turn resumed this many times without finishing is a vendor stuck
 *  pausing: PydanticAI's cap (models/_continuation.py:92-106). */
const MAX_PAUSES = 10;

/**
 * One hosted tool on the wire, and the beta header its version needs. Pinned
 * to the versions the model calls directly: the 2026-02-09 and 2026-03-18 web
 * tools route their calls through code execution and come back uncited
 * (PydanticAI anthropic/_citations.py:73-100). Shapes from Vercel's AI SDK
 * (Apache-2.0), anthropic-prepare-tools.ts:167-173,313-330,368-383.
 */
function anthropicHostedTool(provider: string, tool: HostedTool): { wire: unknown; beta?: string } {
  switch (tool.type) {
    case "web_search":
      return {
        wire: {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: tool.maxUses,
          allowed_domains: tool.allowedDomains,
          blocked_domains: tool.blockedDomains,
          ...(tool.userLocation
            ? { user_location: { type: "approximate", ...tool.userLocation } }
            : {}),
        },
      };
    case "web_fetch":
      return {
        wire: {
          type: "web_fetch_20250910",
          name: "web_fetch",
          max_uses: tool.maxUses,
          allowed_domains: tool.allowedDomains,
          blocked_domains: tool.blockedDomains,
          max_content_tokens: tool.maxContentTokens,
        },
        beta: "web-fetch-2025-09-10",
      };
    case "code_execution":
      return {
        wire: { type: "code_execution_20250825", name: "code_execution" },
        beta: "code-execution-2025-08-25",
      };
    default:
      // planHostedTools only passes the types in ANTHROPIC_FIELDS.
      throw new ProviderError(
        provider,
        "invalid",
        `${provider}: no Anthropic shape for ${tool.type}`,
      );
  }
}

/** The headers with this request's betas added to any the caller set, as one
 *  comma-separated `anthropic-beta`, whatever case the caller wrote it in. */
function withBetas(
  headers: Record<string, string>,
  betas: readonly string[],
): Record<string, string> {
  if (betas.length === 0) return headers;
  const out: Record<string, string> = {};
  const merged: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "anthropic-beta") out[name] = value;
    else
      merged.push(
        ...value
          .split(",")
          .map((beta) => beta.trim())
          .filter(Boolean),
      );
  }
  for (const beta of betas) if (!merged.includes(beta)) merged.push(beta);
  out["anthropic-beta"] = merged.join(",");
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** The seam's type for a server tool name; undefined for the server tools this
 *  adapter never asks for (tool search, MCP, the advisor). */
function serverToolType(name: string): HostedToolType | undefined {
  if (name === "web_search" || name === "web_fetch") return name;
  if (RESERVED_NAMES.code_execution?.includes(name)) return "code_execution";
  return undefined;
}

/** What a server tool was asked to do. Code execution 20250825 runs as two
 *  tools, a shell and a file editor, so both read as code runs. */
function serverToolInput(name: string, input: unknown): HostedInput {
  if (!isRecord(input)) return {};
  switch (name) {
    case "web_search":
      return queryInput([str(input.query)]);
    case "web_fetch": {
      const url = str(input.url);
      return url ? { url } : {};
    }
    case "bash_code_execution": {
      const code = str(input.command);
      return code ? { code, language: "bash" } : {};
    }
    case "text_editor_code_execution": {
      const path = str(input.path);
      const code = str(input.file_text);
      return { ...(path ? { path } : {}), ...(code ? { code } : {}) };
    }
    case "code_execution": {
      const code = str(input.code);
      return code ? { code, language: "python" } : {};
    }
    default:
      return {};
  }
}

/** A result block: `web_search_tool_result`, `bash_code_execution_tool_result`… */
function isResultBlock(block: Record<string, unknown>): boolean {
  return typeof block.type === "string" && block.type.endsWith("_tool_result");
}

/** What a server tool's result block says it did. An `*_error` content is a
 *  failed call, kept as data with the vendor's code (invariant 7). A shell
 *  that exits non-zero still ran: that is the program failing, not the tool. */
function serverToolResult(block: Record<string, unknown>): Omit<HostedCallDelta, "index"> {
  const { content } = block;
  if (Array.isArray(content)) {
    const sources = content.flatMap((result) => {
      const url = isRecord(result) ? str(result.url) : undefined;
      const title = isRecord(result) ? str(result.title) : undefined;
      return url ? [{ type: "url" as const, url, ...(title ? { title } : {}) }] : [];
    });
    return { status: "completed", output: { sources } };
  }
  if (!isRecord(content)) return { status: "completed" };
  const kind = str(content.type) ?? "";
  if (kind.endsWith("_error")) return { status: "failed", error: str(content.error_code) ?? kind };
  if (kind === "web_fetch_result") {
    const url = str(content.url);
    const title = isRecord(content.content) ? str(content.content.title) : undefined;
    return {
      status: "completed",
      output: url ? { sources: [{ type: "url", url, ...(title ? { title } : {}) }] } : {},
    };
  }
  if (kind === "bash_code_execution_result" || kind === "code_execution_result") {
    const files = (Array.isArray(content.content) ? content.content : []).flatMap((file) => {
      const id = isRecord(file) ? str(file.file_id) : undefined;
      return id ? [{ id }] : [];
    });
    const stdout = str(content.stdout);
    const stderr = str(content.stderr);
    return {
      status: "completed",
      output: {
        ...(stdout ? { stdout } : {}),
        ...(stderr ? { stderr } : {}),
        ...(typeof content.return_code === "number" ? { exitCode: content.return_code } : {}),
        ...(files.length > 0 ? { files } : {}),
      },
    };
  }
  const viewed = str(content.content);
  return { status: "completed", ...(viewed ? { output: { stdout: viewed } } : {}) };
}

/**
 * A text block's citations as the seam's: one claim per source over the whole
 * block, because Anthropic cites whole blocks (PydanticAI
 * anthropic/_citations.py:197-198). Only web search locations name a page;
 * the document kinds point into the prompt and stay in the vendor's record.
 */
function blockCitations(raw: readonly unknown[], start: number, end: number): Citation[] {
  return raw.flatMap((citation): Citation[] => {
    if (!isRecord(citation) || citation.type !== "web_search_result_location") return [];
    const url = str(citation.url);
    if (!url) return [];
    const title = str(citation.title);
    const excerpt = str(citation.cited_text);
    const source = {
      type: "url" as const,
      url,
      ...(title ? { title } : {}),
      ...(excerpt ? { excerpt } : {}),
    };
    return [{ source, start, end, anchor: "claim" }];
  });
}

/**
 * The code execution container of the turn still open: everything after the
 * last user message. A request inside that turn has to name the container its
 * earlier responses ran in, or the code it already ran is gone (PydanticAI
 * anthropic/_native_tools.py:128-147).
 */
function openTurnContainer(messages: readonly ChatMessage[], provider: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") return undefined;
    if (message.role === "assistant" && message.hostedItems?.provider === provider) {
      if (message.hostedItems.container) return message.hostedItems.container;
    }
  }
  return undefined;
}

/** The paused blocks as the last assistant message, which is how Anthropic is
 *  told to carry on with the turn it paused. */
function resumeWith(messages: AnthropicMessage[], blocks: readonly unknown[]): AnthropicMessage[] {
  const last = messages.at(-1);
  return last?.role === "assistant"
    ? [...messages.slice(0, -1), { role: "assistant", content: [...last.content, ...blocks] }]
    : [...messages, { role: "assistant", content: [...blocks] }];
}

/** The prompt of a turn's last model pass, cache included, when the vendor
 *  lists its passes. A server tool loop bills the sum of its passes, which is
 *  more than the window ever held. Ported from PydanticAI (MIT),
 *  anthropic/_response.py:180-196. */
function lastPassTokens(usage: AnthropicUsage | undefined): number | undefined {
  const passes = usage?.iterations ?? [];
  for (let i = passes.length - 1; i >= 0; i--) {
    const pass = passes[i]!;
    if (pass.type === "message" || pass.type === "fallback_message") {
      return (
        (pass.input_tokens ?? 0) +
        (pass.cache_read_input_tokens ?? 0) +
        (pass.cache_creation_input_tokens ?? 0)
      );
    }
  }
  return undefined;
}

/** The counts Anthropic states, by the seam's types. */
const STATED_COUNTS = [
  ["web_search_requests", "web_search"],
  ["web_fetch_requests", "web_fetch"],
  ["code_execution_requests", "code_execution"],
] as const;
export const anthropicHosted = {
  plan(
    config: AnthropicConfig,
    baseUrl: string,
    id: string,
    offered: ToolDefinition[],
    opts: StreamOptions,
  ) {
    const hosted = planHostedTools(
      id,
      {
        name: "Anthropic",
        serves: (
          config.servesHostedTools ??
          servedAt(baseUrl, "api.anthropic.com", ["web_search", "web_fetch", "code_execution"])
        ).filter((type) => ANTHROPIC_SENDS.includes(type)),
        fields: ANTHROPIC_FIELDS,
        refuse(tool) {
          // TanStack's rule (MIT, ai-anthropic tools/web-search-tool.ts:12-18).
          if (
            (tool.type === "web_search" || tool.type === "web_fetch") &&
            tool.allowedDomains !== undefined &&
            tool.blockedDomains !== undefined
          ) {
            return "Anthropic takes allowedDomains or blockedDomains, not both. Set one, or mark the tool optional.";
          }
          const taken = offered.find((fn) => RESERVED_NAMES[tool.type]?.includes(fn.name));
          return taken
            ? `a function tool is named ${taken.name}, which Anthropic keeps for this hosted tool. Rename the function tool.`
            : undefined;
        },
      },
      opts,
    );
    const hostedWire = hosted.map((tool) => anthropicHostedTool(id, tool));
    return {
      tools: hostedWire.map(({ wire }) => wire),
      betas: hostedWire.flatMap(({ beta }) => (beta ? [beta] : [])),
    };
  },
  headers: withBetas,
  replay(
    message: Extract<ChatMessage, { role: "assistant" }>,
    provider: string,
    toolUse: (call: ToolCall) => unknown,
  ): unknown[] | undefined {
    return hostedReplay(message, provider)?.map((entry) => {
      if ("call" in entry) return toolUse(entry.call);
      if ("item" in entry) return entry.item;
      const { citations } = entry.slot;
      return { type: "text", text: entry.text, ...(citations ? { citations } : {}) };
    });
  },
  stream(sent: readonly ChatMessage[], id: string) {
    const statedCounts: Partial<Record<HostedToolType, number>> = {};
    let contextTokens: number | undefined;
    // The answer's length so far, in JS string units: where a hosted call
    // sits in it, and the span a text block's citations cover.
    let length = 0;
    const recorder = new HostedRecorder();
    // The vendor's record of the turn, for `hostedItems`: its server blocks
    // as they came, its text as `{ length }`, its function calls as `{ call }`.
    const items: unknown[] = [];
    let recordedCalls = 0;
    let container = openTurnContainer(sent, id);
    // Every block of the passes so far, thinking and signatures included, to
    // send back when the turn pauses. Kept for this call only: the signatures
    // are what lets the model pick its own turn back up.
    const resumed: unknown[] = [];
    let open:
      | { block: Record<string, unknown>; json: string; start: number; citations: unknown[] }
      | undefined;
    let blocks: unknown[] = [];
    let servers: AnthropicUsage["server_tool_use"];
    // The end of the turn, before its finish: a hosted call that never got a
    // result fails, and leaves the record, because Anthropic pairs every
    // server block with its result and a lone one is a 400 on the next send.
    function* closeTurn(): Generator<ProviderChunk> {
      const unsettled = recorder.unsettled();
      const failed = recorder.settle();
      if (failed.length > 0) yield { type: "delta", hosted: failed };
      const kept = items.filter(
        (item) =>
          !(isRecord(item) && item.type === "server_tool_use" && unsettled.has(str(item.id) ?? "")),
      );
      if (kept.some((item) => isRecord(item) && "type" in item)) {
        yield {
          type: "delta",
          hostedItems: { provider: id, items: kept, ...(container ? { container } : {}) },
        };
      }
    }
    return {
      /** The conversation a pass sends: `body`, then what the paused passes
       *  wrote, as the turn they continue. */
      messages(body: AnthropicMessage[]): AnthropicMessage[] {
        return resumed.length > 0 ? resumeWith(body, resumed) : body;
      },
      payload(request: Record<string, unknown>) {
        blocks = [];
        open = undefined;
        servers = undefined;
        return { ...request, ...(container ? { container } : {}) };
      },
      *event(event: AnthropicEvent): Generator<ProviderChunk> {
        const usage = event.type === "message_start" ? event.message?.usage : event.usage;
        servers = usage?.server_tool_use ?? servers;
        contextTokens = lastPassTokens(usage) ?? contextTokens;
        container = event.message?.container?.id ?? event.delta?.container?.id ?? container;
        switch (event.type) {
          case "content_block_start": {
            const block: Record<string, unknown> = { ...event.content_block };
            open = { block, json: "", start: length, citations: [] };
            if (block.type === "server_tool_use") {
              const name = str(block.name) ?? "";
              const type = serverToolType(name);
              if (type) {
                // Whole here on some versions, in deltas of its own on others
                // (Vercel anthropic-language-model.ts:2635-2643).
                const whole = isRecord(block.input) && Object.keys(block.input).length > 0;
                const input = whole ? serverToolInput(name, block.input) : undefined;
                yield {
                  type: "delta",
                  hosted: [recorder.start(str(block.id), type, length, input)],
                };
              }
            } else if (isResultBlock(block)) {
              // A result arrives whole, in the block that opens it.
              const done = recorder.end(str(block.tool_use_id), serverToolResult(block));
              if (done) yield { type: "delta", hosted: [done] };
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (delta?.type === "text_delta" && delta.text) {
              length += delta.text.length;
              if (open) open.block.text = (str(open.block.text) ?? "") + delta.text;
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              if (open) open.block.thinking = (str(open.block.thinking) ?? "") + delta.thinking;
            } else if (delta?.type === "signature_delta" && open) {
              open.block.signature = delta.signature;
            } else if (delta?.type === "citations_delta" && open) {
              open.citations.push(delta.citation);
            } else if (delta?.type === "input_json_delta" && open) {
              open.json += delta.partial_json ?? "";
            }
            break;
          }
          case "content_block_stop": {
            if (!open) break;
            const { block, json, start, citations } = open;
            open = undefined;
            // An empty text block holds nothing, and sent back it is a 400.
            const size = block.type === "text" ? (str(block.text)?.length ?? 0) : undefined;
            if (size !== undefined) {
              if (citations.length > 0) {
                block.citations = citations;
                const cited = blockCitations(citations, start, length);
                if (cited.length > 0) yield { type: "delta", citations: cited };
              }
              if (size > 0) {
                items.push({ length: size, ...(citations.length > 0 ? { citations } : {}) });
              }
            } else if (block.type === "tool_use") {
              if (json) block.input = parseToolArgs(json);
              items.push({ call: recordedCalls++ });
            } else if (block.type === "server_tool_use") {
              // Kept exactly as the vendor wrote it: this goes back to it.
              if (json) block.input = parseJson(json) ?? block.input;
              const index = recorder.indexOf(str(block.id));
              if (index !== undefined && json) {
                const input = serverToolInput(str(block.name) ?? "", block.input);
                yield { type: "delta", hosted: [{ index, input }] };
              }
              items.push(block);
            } else if (isResultBlock(block)) {
              items.push(block);
            }
            if (size !== 0) blocks.push(block);
            break;
          }
        }
      },
      close: closeTurn,
      endPass(paused: boolean, pauses: number) {
        for (const [field, type] of STATED_COUNTS) {
          const count = servers?.[field];
          if (count !== undefined) statedCounts[type] = (statedCounts[type] ?? 0) + count;
        }
        if (!paused) return;
        if (pauses >= MAX_PAUSES) {
          throw new ProviderError(
            id,
            "overload",
            `${id}: the turn paused ${pauses + 1} times without finishing`,
            { code: "pause_turn" },
          );
        }
        resumed.push(...blocks);
      },
      usage() {
        const hostedCalls = hostedCounts(recorder.shown(), statedCounts);
        return {
          ...(hostedCalls ? { hostedCalls } : {}),
          ...(contextTokens !== undefined ? { contextTokens } : {}),
        };
      },
    };
  },
};
