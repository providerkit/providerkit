// Script recording and step consumption adapted from OpenAI Agents JS (MIT),
// packages/agents-core/src/testing/scriptedModel.ts. Copyright (c) 2025 OpenAI.
// Changed: core Provider chunks, JSON-only snapshots and no retry advice.
import {
  EMPTY_USAGE,
  type ChatMessage,
  type FinishReason,
  type Provider,
  type ProviderChunk,
  type StreamOptions,
  type TokenUsage,
  type ToolDefinition,
} from "@providerkit/core";
import { copyData, immutableCopy, isId } from "../snapshot.ts";

export type ScriptReply =
  | string
  | {
      text?: string;
      reasoning?: string;
      usage?: Partial<TokenUsage>;
      finish?: FinishReason;
      toolCalls?: readonly {
        name: string;
        arguments?: Record<string, unknown> | string;
        id?: string;
      }[];
    }
  | { error: unknown }
  | { chunks: readonly ProviderChunk[] };
export type ScriptStep = ScriptReply | ((call: ScriptedCall) => ScriptReply | Promise<ScriptReply>);
export interface ScriptedCall {
  readonly index: number;
  readonly messages: ChatMessage[];
  readonly tools: ToolDefinition[];
  readonly options: Omit<StreamOptions, "signal" | "onActivity" | "onRateLimit">;
}
export interface ScriptedProvider extends Provider {
  readonly calls: readonly ScriptedCall[];
  readonly remaining: number;
  enqueue(...steps: ScriptStep[]): void;
  assertComplete(): void;
}

/** Offline provider. Shorthands report zero cost unless usage is supplied. Raw chunks are
 * unchanged, so missing usage still tests unknown billing. Create one per case/repeat. */
export function scriptedProvider(
  steps: readonly ScriptStep[],
  options: { id?: string; model?: string } = {},
): ScriptedProvider {
  const id = options.id ?? "scripted";
  const model = options.model ?? "offline";
  if (!isId(id) || !isId(model)) throw new TypeError("A scripted provider needs an id and model.");
  const keep = (step: ScriptStep): ScriptStep =>
    typeof step === "function" || (typeof step === "object" && step !== null && "error" in step)
      ? step
      : immutableCopy(step);
  const queue = steps.map(keep);
  const calls: ScriptedCall[] = [];
  return {
    id,
    model,
    get calls() {
      return Object.freeze([...calls]);
    },
    get remaining() {
      return queue.length;
    },
    enqueue(...next) {
      queue.push(...next.map(keep));
    },
    assertComplete() {
      if (queue.length) throw new Error(`The scripted provider has ${queue.length} unused steps.`);
    },
    createStream(messages, tools, opts = {}) {
      opts.signal?.throwIfAborted();
      const { signal, onActivity: _activity, onRateLimit: _rate, ...settings } = opts;
      const call = immutableCopy({ index: calls.length, messages, tools, options: settings });
      calls.push(call);
      const step = queue.shift();
      return (async function* (): AsyncGenerator<ProviderChunk> {
        signal?.throwIfAborted();
        if (step === undefined)
          throw new Error(`The scripted provider has no step for call ${call.index + 1}.`);
        const reply = typeof step === "function" ? await step(call) : step;
        signal?.throwIfAborted();
        if (typeof reply === "function")
          throw new TypeError("A responder must return a reply, not another function.");
        if (typeof reply !== "string" && "error" in reply) throw reply.error;
        let chunks: readonly ProviderChunk[];
        if (typeof reply !== "string" && "chunks" in reply) chunks = copyData(reply.chunks);
        else {
          const answer = typeof reply === "string" ? { text: reply } : reply;
          const source = { provider: id, model };
          chunks = [
            { type: "delta", content: answer.text, reasoning: answer.reasoning, source },
            {
              type: "usage",
              usage: { ...EMPTY_USAGE, ...(answer.usage ?? { reportedCostUsd: 0 }) },
              source,
            },
            {
              type: "finish",
              finishReason: answer.finish ?? (answer.toolCalls?.length ? "tool_calls" : "stop"),
              toolCalls: answer.toolCalls?.map((tool, index) => ({
                index,
                id: tool.id ?? `call_${call.index}_${index}`,
                name: tool.name,
                arguments:
                  typeof tool.arguments === "string"
                    ? tool.arguments
                    : JSON.stringify(tool.arguments ?? {}),
              })),
              source,
            },
          ];
        }
        for (const chunk of chunks) {
          signal?.throwIfAborted();
          yield copyData(chunk);
        }
        signal?.throwIfAborted();
      })();
    },
  };
}
