// Opt-in only: the main entry and its declarations must never import this module.
// GenAI field names follow the Development conventions at
// https://github.com/open-telemetry/semantic-conventions-genai/tree/e6658f14c9d9ea0760825f029cb82e7673f48fab
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { classify, ProviderError, type ErrorKind } from "./errors.ts";
import type { RateLimitReset } from "./rate-limit.ts";
import type { Provider, ProviderChunk, StreamOptions, TokenUsage } from "./types.ts";

export interface ProviderTracingOptions {
  /** Defaults to the host's tracer named `@providerkit/core`. No SDK is installed here. */
  tracer?: Tracer;
  /** Otherwise captured from the active context at each createStream call, not at setup. */
  parentContext?: Context;
  /** Telemetry label only. Does not change routing. Keep credentials and user data out of it. */
  providerName?: string;
}

// Own wrappers only. An SDK can bind a fresh parent without nesting another CLIENT span.
const owned = new WeakMap<Provider, Provider>();

/**
 * Observe chat calls without capturing their content.
 *
 * ```ts
 * const traced = withProviderTracing(provider);
 * ```
 *
 * Wrap the final provider, outside registry, fallback, gate and watchdog layers.
 * Each consumed stream gets one CLIENT span, including queueing and consumption pauses.
 * No attempts are counted and no retry, read-ahead or cancellation is added.
 * Speech, transcription, decisions, standalone auth and agent runs are not covered.
 * Re-wrapping an owned wrapper replaces its tracing options; hidden inner wrappers
 * cannot be deduplicated. HTTP child spans require the host's context manager.
 */
export function withProviderTracing(
  provider: Provider,
  options: ProviderTracingOptions = {},
): Provider {
  const inner = owned.get(provider) ?? provider;
  const wrapped: Provider = {
    get id() {
      return inner.id;
    },
    get model() {
      return inner.model;
    },
    createStream(messages, tools, opts = {}) {
      const parent = options.parentContext ?? quietly(() => context.active()) ?? ROOT_CONTEXT;
      let span: Span | undefined;
      let scope: Context | undefined;
      let started = false;
      let ended = false;
      let startTime = 0;
      let firstChunk = false;
      let firstActivity = false;
      let usage: Attributes = {};
      let rate: Attributes = {};

      function end(outcome: "completed" | "closed" | "cancelled" | "error", error?: unknown) {
        if (ended) return;
        ended = true;
        quietly(() => opts.signal?.removeEventListener("abort", cancelled));
        quietly(() => span?.setAttributes(usage));
        quietly(() => span?.setAttributes(rate));
        quietly(() => span?.setAttribute("providerkit.stream.outcome", outcome));
        if (outcome === "error") {
          const kind = quietly(() => classify(error));
          quietly(() =>
            span?.setAttribute(
              "error.type",
              kind && Object.hasOwn(ERROR_KINDS, kind) ? kind : "unknown",
            ),
          );
          quietly(() => {
            if (!(error instanceof ProviderError)) return;
            span?.setAttributes(rateAttributes(error));
            if (Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599) {
              span?.setAttribute("http.response.status_code", error.status!);
            }
          });
          // Never recordException: messages, bodies and stacks can contain the prompt or key.
          quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
        }
        quietly(() => span?.end());
      }

      function cancelled() {
        end("cancelled");
      }

      function start() {
        if (started || ended) return;
        started = true;
        startTime = quietly(() => performance.now()) ?? 0;
        const model = quietly(() => opts.model ?? inner.model);
        const providerName = quietly(() => options.providerName ?? canonicalProvider(inner.id));
        span = quietly(() =>
          (options.tracer ?? trace.getTracer("@providerkit/core")).startSpan(
            model ? `chat ${model}` : "chat",
            {
              kind: SpanKind.CLIENT,
              attributes: {
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": providerName,
                "gen_ai.request.model": model,
                "gen_ai.request.stream": true,
              },
            },
            parent,
          ),
        );
        scope = quietly(() => (span ? trace.setSpan(parent, span) : parent));
        quietly(() => {
          opts.signal?.addEventListener("abort", cancelled, { once: true });
          if (opts.signal?.aborted) cancelled();
        });
      }

      const streamOptions: StreamOptions = {
        ...opts,
        onActivity() {
          quietly(() => {
            if (ended || !started || firstActivity) return;
            firstActivity = true;
            span?.setAttribute(
              "providerkit.stream.first_activity_seconds",
              (performance.now() - startTime) / 1000,
            );
          });
          // Only instrumentation is guarded. A caller's exception keeps its normal behavior.
          opts.onActivity?.();
        },
        onRateLimit(reading) {
          quietly(() => {
            if (!ended) rate = rateAttributes(reading);
          });
          opts.onRateLimit?.(reading);
        },
      };
      const iterator = once<AsyncIterator<ProviderChunk, unknown, unknown>>(() =>
        inner.createStream(messages, tools, streamOptions)[Symbol.asyncIterator](),
      );

      async function advance(method: "next" | "return" | "throw", args: [] | [unknown]) {
        if (method === "next") start();
        try {
          const result = await inScope(scope, async () => {
            const source = iterator();
            const operation = source[method];
            if (operation) return operation.apply(source, args);
            if (method === "throw") {
              // Match yield* when throw is absent: close first, even if return yields again.
              // A cleanup failure must escape instead of the missing-method TypeError.
              await source.return?.();
              throw new TypeError("The iterator does not provide a 'throw' method.");
            }
            return { done: true as const, value: args[0] };
          });
          quietly(() => {
            if (ended) return;
            if (result.done) {
              end(method === "next" ? "completed" : "closed");
              return;
            }
            const chunk: ProviderChunk = result.value;
            if (!firstChunk) {
              firstChunk = true;
              span?.setAttribute(
                "providerkit.stream.first_chunk_seconds",
                (performance.now() - startTime) / 1000,
              );
            }
            if (chunk.usage) usage = usageAttributes(chunk.usage);
            if (chunk.source) {
              span?.setAttribute("providerkit.response.provider", chunk.source.provider);
              span?.setAttribute("providerkit.response.model", chunk.source.model);
            }
            if (chunk.finishReason && FINISH_REASONS.has(chunk.finishReason)) {
              span?.setAttribute("gen_ai.response.finish_reasons", [chunk.finishReason]);
            }
          });
          return result;
        } catch (error) {
          end(
            opts.signal?.aborted || quietly(() => classify(error)) === "aborted"
              ? "cancelled"
              : "error",
            error,
          );
          throw error;
        }
      }

      const stream: AsyncIterableIterator<ProviderChunk, unknown, unknown> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(...args: [] | [unknown]) {
          return advance("next", args);
        },
        return(...args: [] | [unknown]) {
          return advance("return", args);
        },
        throw(...args: [] | [unknown]) {
          return advance("throw", args);
        },
      };
      return stream;
    },
  };
  owned.set(wrapped, inner);
  return wrapped;
}

function quietly<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

// Cache failures too: a broken context manager may call back then throw, or call
// back twice. Neither can replay a paid operation or replace its own exception.
function once<T>(operation: () => T): () => T {
  let outcome: { value: T } | { error: unknown } | undefined;
  return () => {
    if (!outcome) {
      try {
        outcome = { value: operation() };
      } catch (error) {
        outcome = { error };
      }
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  };
}

function inScope<T>(scope: Context | undefined, operation: () => T): T {
  if (!scope) return operation();
  const invoke = once(operation);
  // A manager can return a derived promise (for example, callback().finally(cleanup)).
  // Handle its rejection too, but keep the provider's cached result as the only outcome.
  quietly(() => Promise.resolve(context.with(scope, invoke)).catch(() => {}));
  return invoke();
}

function canonicalProvider(id: string): string {
  if (id === "google" || id === "gemini") return "gcp.gemini";
  if (id === "openai-responses" || id === "chatgpt") return "openai";
  return id;
}

function number(attributes: Attributes, key: string, value: number | undefined) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) attributes[key] = value;
}

function usageAttributes(usage: TokenUsage): Attributes {
  const attributes: Attributes = {};
  number(attributes, "gen_ai.usage.input_tokens", usage.inputTokens);
  number(attributes, "gen_ai.usage.output_tokens", usage.outputTokens);
  number(attributes, "gen_ai.usage.cache_read.input_tokens", usage.cachedInputTokens);
  number(attributes, "gen_ai.usage.cache_write.input_tokens", usage.cacheWriteTokens);
  number(attributes, "gen_ai.usage.reasoning.output_tokens", usage.reasoningTokens);
  number(attributes, "providerkit.usage.reported_cost_usd", usage.reportedCostUsd);
  return attributes;
}

function rateAttributes(reading: RateLimitReset): Attributes {
  const attributes: Attributes = {};
  number(attributes, "providerkit.rate_limit.utilization", reading.utilization);
  number(attributes, "providerkit.rate_limit.reset_at_ms", reading.resetAtMs);
  number(attributes, "providerkit.rate_limit.retry_after_ms", reading.retryAfterMs);
  if (reading.window && WINDOWS.has(reading.window))
    attributes["providerkit.rate_limit.window"] = reading.window;
  return attributes;
}

const WINDOWS = new Set(["5h", "weekly", "monthly"]);
const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter"]);
const ERROR_KINDS = {
  aborted: true,
  timeout: true,
  network: true,
  overload: true,
  rate: true,
  quota: true,
  entitlement: true,
  auth: true,
  model: true,
  context: true,
  content: true,
  invalid: true,
  unknown: true,
} satisfies Record<ErrorKind, boolean>;
