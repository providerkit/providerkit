// Asking a model what it can actually do, instead of reading its model card.
//
// One capability needs this badly enough to ship a prober: whether a model
// still emits a tool call when the same request also constrains its output to
// a schema. Most do. Several — measured 2026-09-07: `z-ai/glm-5.3-flash`,
// `z-ai/glm-5.3`, `deepseek-v4-flash` — never do, and they fail in the worst
// available way. The decoder is pinned to the schema, the tool call has nowhere
// to go, and the model writes the announcement instead ("let me look that up
// for you") and stops. No error, no warning, no finish reason to branch on: on
// the wire the turn succeeded. Downstream it reads as a model that will not use
// its tools, and no amount of prompting moves it, because the call was never
// representable.
//
// `jsonWithTools: "prompt"` is the remedy, and it cannot be a default: the same
// run put `qwen3.8-flash` at 10/10 with the response format and 1/6 without it,
// so a global flip only moves the silence to different models. One call each
// way settles it for the model actually being served.

import type { JsonWithTools, Provider } from "./types.ts";

/** Nothing a model can answer from memory — so a tool call is the only correct
 *  turn, and NOT making one is a real signal rather than a judgement call. */
const PROBE_TOOL = {
  name: "get_current_time",
  description:
    "The only source of the current time. You cannot know the time without calling this — never answer a time question from memory or guess.",
  inputSchema: {
    type: "object" as const,
    properties: { timezone: { type: "string", description: "IANA timezone, e.g. Asia/Tokyo" } },
    required: [],
  },
};

const PROBE_JSON = {
  name: "probe",
  schema: {
    type: "object" as const,
    properties: { message: { type: "string", description: "Your reply to the user." } },
    required: ["message"],
    additionalProperties: false,
  },
};

const SHAPES: JsonWithTools[] = ["response_format", "prompt"];

export interface JsonWithToolsProbe {
  /**
   * The shape to configure, or `null` when neither called the tool on every
   * sample — that model cannot be trusted with tools and a schema together,
   * whichever way the schema rides, and the honest fix is a different model.
   */
  use: JsonWithTools | null;
  /** Samples that produced a tool call, per shape, out of `samples`. */
  calls: Record<JsonWithTools, number>;
  /** How many times each shape was asked. */
  samples: number;
}

export interface ProbeOptions {
  /**
   * Samples per shape. Above one because the interesting failures are partial —
   * `gemini-3.8-flash` called its tool 3/10 — and a single sample reports a
   * coin flip as a capability. A shape passes only when EVERY sample calls.
   */
  samples?: number;
  /** Override the provider's bound model, to probe one it is not built for. */
  model?: string;
  signal?: AbortSignal;
}

async function callsTool(
  provider: Provider,
  shape: JsonWithTools,
  opts: ProbeOptions,
): Promise<boolean> {
  const stream = provider.createStream(
    [{ role: "user", content: "What time is it in Tokyo right now?" }],
    [PROBE_TOOL],
    {
      json: PROBE_JSON,
      jsonWithTools: shape,
      // Deterministic, so a rerun of the probe answers the same way.
      temperature: 0,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );
  // No token cap: on a thinking model a small one is spent before the answer
  // starts, and an empty completion would read here as "did not call the tool".
  for await (const chunk of stream) {
    if (chunk.toolCalls?.some((call) => call.name)) return true;
  }
  return false;
}

/**
 * Ask a model, on the wire, which {@link JsonWithTools} shape it actually
 * serves — then configure the provider with `probe.use`.
 *
 * Both shapes are always tried, because a result you can read beats a result
 * you have to trust: `calls` is the table to log, and "0/3 and 3/3" is what
 * makes a later regression obvious. It costs `samples × 2` short calls, made
 * one after another, once, at whatever moment the app decides to ask — boot is
 * the usual one.
 *
 * Probe each provider on its own, never a fallback chain: the shape is a fact
 * about one model on one endpoint, and a chain answers with whichever member
 * is up.
 *
 * Only the `openai` wire and Gemini 3 read `jsonWithTools`. The `anthropic`
 * wire (Anthropic, and coding plans like `zai` and `kimi`) always puts the
 * schema in the prompt, `responses` always sends it as the response format,
 * and Gemini 2.x always uses the prompt. There both shapes are one request and
 * the probe measures it twice, so skip it.
 *
 * Errors propagate. A probe that swallowed a bad key or a dead endpoint would
 * report "this model cannot call tools", which is a much worse thing to
 * believe than "the call failed".
 *
 * What it catches is the structural failure — the model that CANNOT emit the
 * call, every time, on the easiest question there is. A model that is merely
 * unreliable will pass: `gemini-3.8-flash` answers this probe 3/3 and a real
 * sales turn 3/10. That is the right line to draw. A harder probe would start
 * failing good models for being terse, and "sometimes forgets its tools" is a
 * prompt and eval problem, not a wire shape one.
 *
 * ```ts
 * const probe = await probeJsonWithTools(provider);
 * if (!probe.use) throw new Error(`${model} cannot use tools with a schema`);
 * ```
 */
export async function probeJsonWithTools(
  provider: Provider,
  opts: ProbeOptions = {},
): Promise<JsonWithToolsProbe> {
  const samples = Math.max(1, opts.samples ?? 3);

  // One call at a time. A flat-rate plan caps concurrent requests: six at once
  // on a Z.ai Coding Plan key came back with some 429s (measured 2026-09-25),
  // and behind a fallback chain those calls were answered by the NEXT model —
  // which the table then scored as this one. A slower probe that measures one
  // model beats a fast one that measures a mix.
  const calls: Record<JsonWithTools, number> = { response_format: 0, prompt: 0 };
  for (const shape of SHAPES) {
    for (let i = 0; i < samples; i++) {
      if (await callsTool(provider, shape, opts)) calls[shape] += 1;
    }
  }
  // `response_format` first when both are clean: it is the only one of the two
  // the endpoint actually enforces, so the prompt shape is the fallback rather
  // than the equal.
  return { use: SHAPES.find((shape) => calls[shape] === samples) ?? null, calls, samples };
}

// ── Model capability resolution ──────────────────────────────────────────

export interface ModelCapabilities {
  /** Canonical model identifier. */
  id: string;
  /** Human-readable model display name. */
  name?: string;
  /** Total context window in tokens. */
  contextWindow?: number;
  /** Maximum generation/output tokens. */
  maxOutput?: number;
  /** Whether the model natively supports tool / function calling. */
  supportsTools?: boolean;
  /** Whether the model natively supports JSON schema / structured output. */
  supportsStructuredOutput?: boolean;
  /** Whether the model can receive image inputs. */
  supportsVision?: boolean;
  /** Whether the model has extended thinking / reasoning capability. */
  supportsReasoning?: boolean;
}

export interface ResolveModelOptions {
  /** Custom catalog URL. Defaults to https://models.dev/api.json */
  catalogUrl?: string;
  /** Pre-loaded catalog object (useful for tests or offline execution). */
  catalog?: Record<string, unknown>;
  /** Custom fetch implementation (for proxies, custom headers, or tests). */
  fetchImpl?: typeof fetch;
  /** Max cache age in ms. Defaults to 24 hours (86_400_000 ms). */
  maxAgeMs?: number;
}

interface RawModelEntry {
  id?: string;
  name?: string;
  tool_call?: boolean;
  structured_output?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  limit?: {
    context?: number;
    output?: number;
  };
}

interface RawProviderEntry {
  models?: Record<string, RawModelEntry>;
}

const DEFAULT_CATALOG_URL = "https://models.dev/api.json";
const DEFAULT_MAX_AGE_MS = 86_400_000; // 24 hours

let cachedCatalog: { timestamp: number; data: Record<string, RawProviderEntry> } | null = null;

function normalizeId(id: string): string {
  // Strip gateway prefixes (z-ai/, deepseek/, openai/, accounts/fireworks/models/, etc.)
  const bare = id.replace(/^(?:accounts\/[^/]+\/models\/|[^/]+\/)/, "");
  // Normalize punctuation variations like 5p3 -> 5.3 or v4p1 -> v4.1
  return bare.replace(/([a-z0-9])p([0-9])/gi, "$1.$2").toLowerCase();
}

/**
 * Resolve model capabilities (context window, tool calling, vision, reasoning)
 * by looking up the model in a live or cached models.dev catalog.
 *
 * Normalizes model identifiers across gateway spellings:
 * - `z-ai/glm-5.3-flash` matches `glm-5.3-flash`
 * - `deepseek/deepseek-v4.1-flash` matches `deepseek-v4.1-flash`
 * - `accounts/fireworks/models/glm-5p3-flash` matches `glm-5.3-flash`
 *
 * Never throws — if the catalog cannot be retrieved or the model is unknown,
 * returns `undefined` so capability lookups never break caller execution.
 */
export async function resolveModelCapabilities(
  modelId: string,
  options: ResolveModelOptions = {},
): Promise<ModelCapabilities | undefined> {
  if (!modelId) return undefined;

  let catalogData: Record<string, RawProviderEntry>;

  if (options.catalog) {
    catalogData = options.catalog as Record<string, RawProviderEntry>;
  } else {
    const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const now = Date.now();

    if (cachedCatalog && now - cachedCatalog.timestamp < maxAge) {
      catalogData = cachedCatalog.data;
    } else {
      try {
        const fetcher = options.fetchImpl ?? fetch;
        const res = await fetcher(options.catalogUrl ?? DEFAULT_CATALOG_URL);
        if (!res.ok) return undefined;
        catalogData = (await res.json()) as Record<string, RawProviderEntry>;
        cachedCatalog = { timestamp: now, data: catalogData };
      } catch {
        // Degrade gracefully if offline or request failed
        if (cachedCatalog) return extractCapabilities(modelId, cachedCatalog.data);
        return undefined;
      }
    }
  }

  return extractCapabilities(modelId, catalogData);
}

function extractCapabilities(
  modelId: string,
  catalog: Record<string, RawProviderEntry>,
): ModelCapabilities | undefined {
  const targetNorm = normalizeId(modelId);
  let bestMatch: RawModelEntry | undefined;

  // Pass 1: exact match
  for (const provider of Object.values(catalog)) {
    if (!provider?.models) continue;
    if (provider.models[modelId]) {
      bestMatch = provider.models[modelId];
      break;
    }
  }

  // Pass 2: normalized match across vendor prefixes and punctuation
  if (!bestMatch) {
    for (const provider of Object.values(catalog)) {
      if (!provider?.models) continue;
      for (const [key, entry] of Object.entries(provider.models)) {
        if (normalizeId(key) === targetNorm) {
          bestMatch = entry;
          break;
        }
      }
      if (bestMatch) break;
    }
  }

  if (!bestMatch) return undefined;

  const inputs = bestMatch.modalities?.input ?? [];
  return {
    id: bestMatch.id ?? modelId,
    name: bestMatch.name,
    contextWindow: bestMatch.limit?.context,
    maxOutput: bestMatch.limit?.output,
    supportsTools: bestMatch.tool_call === true,
    supportsStructuredOutput: bestMatch.structured_output === true,
    supportsVision: inputs.includes("image") || bestMatch.attachment === true,
    supportsReasoning: bestMatch.reasoning === true,
  };
}
