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
 * makes a later regression obvious. It costs `samples × 2` short calls, once,
 * at whatever moment the app decides to ask — boot is the usual one.
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

  const counted = await Promise.all(
    SHAPES.map(async (shape) => {
      const runs = await Promise.all(
        Array.from({ length: samples }, () => callsTool(provider, shape, opts)),
      );
      return [shape, runs.filter(Boolean).length] as const;
    }),
  );

  const calls = Object.fromEntries(counted) as Record<JsonWithTools, number>;
  // `response_format` first when both are clean: it is the only one of the two
  // the endpoint actually enforces, so the prompt shape is the fallback rather
  // than the equal.
  return { use: SHAPES.find((shape) => calls[shape] === samples) ?? null, calls, samples };
}
