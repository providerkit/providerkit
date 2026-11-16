// Explicit OTel parent contexts and span-per-operation observation are adapted from
// TanStack AI, packages/ai/src/middlewares/otel.ts (MIT, copyright 2025 Tanner Linsley).
// Changed for SDK attempts, observer composition, bounded cleanup and content-free traces.
// See THIRD_PARTY_NOTICES.md.
import {
  context as otelContext,
  trace,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { TokenUsage } from "@providerkit/core";
import type {
  AgentEvent,
  LifecycleContext,
  LifecycleEvent,
  LifecycleHook,
  RunOptions,
  RunState,
} from "./types.ts";

export interface AgentSpanInfo {
  readonly kind: "run" | "model" | "tool" | "child" | "handoff";
  readonly agentId: string;
  readonly version: string;
  readonly runId: string;
  readonly runAttemptId: string;
  readonly operationId?: string;
  /** A tool retry changes this without changing runAttemptId. */
  readonly operationAttemptId?: string;
  readonly childRunId?: string;
}

export interface AgentTracingOptions {
  /** Defaults to the host's registered tracer for @providerkit/agents. No SDK is installed. */
  tracer?: Tracer;
  /** Otherwise options() captures the current OTel context for each call. */
  parentContext?: Context;
  /** Explicit host-approved values only, never raw callback payloads. At most 32 scalar
   * attributes, 64-character keys and 256-character strings, under providerkit.host.*.
   * Non-finite numbers and other values are dropped. Do not put secrets in IDs or attributes. */
  attributes?: (
    info: Readonly<AgentSpanInfo>,
  ) => Readonly<Record<string, string | number | boolean>>;
  /** Oldest incomplete runs are closed, not cancelled, when full. Default 128, maximum 1,024. */
  maxRuns?: number;
  /** Includes ended-operation tombstones and child relationships. Once full, new spans are
   * skipped until the run ends. Default 1,024, maximum 16,384. */
  maxSpansPerRun?: number;
  /** Absolute observation lifetime, not an execution timeout. Default 30 minutes, max 24 hours.
   * A missing end cannot retain spans or signal listeners indefinitely. */
  maxRunMs?: number;
}

export interface AgentTracing {
  /** Use options() to compose existing callbacks. These two observers are also available
   * separately for hosts that already compose them. Attach each once, not at both levels. */
  readonly onLifecycle: LifecycleHook;
  readonly onEvent: NonNullable<RunOptions["onEvent"]>;
  options(): RunOptions;
  options<T extends RunOptions>(options: T): T;
  /** Close unfinished observations as incomplete and detach listeners. Does not stop agents,
   * flush exporters or shut down the host's tracer. Later callbacks are ignored. */
  close(): void;
}

type EndReason = RunState["status"] | "returned" | "error" | "aborted" | "incomplete";
interface ObservedSpan {
  span?: Span;
  context?: Context;
}
interface Operation extends ObservedSpan {
  kind: "model" | "tool";
  id: string;
  attemptId: string;
  usage?: Attributes;
}
interface Relationship extends ObservedSpan {
  childRunId: string;
  run?: ObservedRun;
}
interface ObservedRun extends ObservedSpan {
  info: AgentSpanInfo;
  signal: AbortSignal;
  onAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  operations: Map<string, Operation>;
  children: Map<string, Relationship>;
  relationship?: Relationship;
  closed: boolean;
}

/** An observer only. No Agent wrapper, exporter, network request or context manager.
 *
 * Run spans describe one live attempt, not the time between resumes. Model/tool spans end
 * when the call returns, BEFORE its output guard. Only the run status describes acceptance.
 * A tool boundary includes host checks and can end without an invocation. Cached work emits
 * no new spans. Missing starts are not reconstructed from private snapshots or ID formats.
 *
 * SDK spans have explicit parents even without a context manager. The SDK has no around-call
 * hook, so these observers CANNOT activate a span around provider/tool execution. Automatic
 * HTTP instrumentation will not inherit these model/tool spans. The host owns that integration.
 *
 * Usage comes from observed usage chunks, or nonzero usage in model_end. A guarded all-zero
 * Turn cannot be distinguished from missing usage by the current lifecycle API, so it is
 * omitted. Interrupted guarded usage and the configured provider identity are not exposed
 * by these hooks. No cost is estimated, and no raw content, host context or error message
 * is recorded.
 */
export function createAgentTracing(options: AgentTracingOptions = {}): AgentTracing {
  const maxRuns = limit(options.maxRuns, 128, 1_024, "maxRuns");
  const maxSpans = limit(options.maxSpansPerRun, 1_024, 16_384, "maxSpansPerRun");
  const maxRunMs = limit(options.maxRunMs, 30 * 60_000, 24 * 60 * 60_000, "maxRunMs");
  const tracer = options.tracer ?? safely(() => trace.getTracer("@providerkit/agents"));
  const runs = new Map<string, ObservedRun>();
  const relationships = new Map<string, Relationship>();
  // The SDK reuses its frozen context within an attempt. Weak keys prevent replayed starts
  // from reopening a closed observation without keeping completed runs in a global ledger.
  const seen = new WeakSet<LifecycleContext>();
  let closed = false;

  function currentContext(): Context {
    return options.parentContext ?? safely(() => otelContext.active()) ?? ROOT_CONTEXT;
  }

  function start(
    info: AgentSpanInfo,
    parent: Context,
    ownerClosed?: () => boolean,
  ): ObservedSpan | undefined {
    const attributes: Attributes = {
      "providerkit.span.kind": info.kind,
      "providerkit.agent.id": info.agentId,
      "providerkit.agent.version": info.version,
      "providerkit.run.id": info.runId,
      "providerkit.run.attempt.id": info.runAttemptId,
    };
    if (info.operationId !== undefined) attributes["providerkit.operation.id"] = info.operationId;
    if (info.operationAttemptId !== undefined)
      attributes["providerkit.operation.attempt.id"] = info.operationAttemptId;
    if (info.childRunId !== undefined) attributes["providerkit.child.run.id"] = info.childRunId;
    if (info.kind === "model") attributes["gen_ai.operation.name"] = "chat";
    const custom = safely(() => safeAttributes(options.attributes?.(Object.freeze({ ...info }))));
    const span = safely(() =>
      tracer?.startSpan(
        `providerkit.agent.${info.kind}`,
        {
          kind: info.kind === "model" ? SpanKind.CLIENT : SpanKind.INTERNAL,
          attributes: { ...attributes, ...custom },
        },
        parent,
      ),
    );
    // setSpan is the public context API. No ambient/global current-run variable is needed.
    const entry = {
      span,
      context: span ? (safely(() => trace.setSpan(parent, span)) ?? parent) : parent,
    };
    // A synchronous tracer or attribute callback can close us before the caller registers
    // this span. End it here; shutdown cannot reach an entry it does not own yet.
    if (closed || ownerClosed?.()) {
      end(
        entry,
        "incomplete",
        info.kind === "model" ? { "providerkit.usage.complete": false } : {},
      );
      return;
    }
    return entry;
  }

  function end(entry: ObservedSpan, reason: EndReason, attributes: Attributes = {}): void {
    const span = entry.span;
    // Clear our ownership BEFORE calling exporter-facing methods: each end is attempted once,
    // even when a broken processor throws or calls an observer again from span.end().
    entry.span = undefined;
    entry.context = undefined;
    if (!span) return;
    safely(() => span.setAttributes({ ...attributes, "providerkit.outcome": reason }));
    const code =
      reason === "completed" || reason === "returned"
        ? SpanStatusCode.OK
        : reason === "failed" || reason === "error" || reason === "limited" || reason === "aborted"
          ? SpanStatusCode.ERROR
          : SpanStatusCode.UNSET;
    safely(() => span.setStatus({ code }));
    safely(() => span.end());
  }

  function endRelationship(relation: Relationship, reason: EndReason): void {
    if (relationships.get(relation.childRunId) === relation)
      relationships.delete(relation.childRunId);
    relation.run = undefined;
    end(relation, reason);
  }

  function endRun(run: ObservedRun, reason: EndReason, detail?: string): void {
    if (run.closed) return;
    run.closed = true;
    if (runs.get(run.info.runId) === run) runs.delete(run.info.runId);
    clearTimeout(run.timer);
    run.signal.removeEventListener("abort", run.onAbort);
    // A parent ending is not evidence of any missing child's or operation's success.
    for (const relation of run.children.values()) {
      if (relation.run) endRun(relation.run, "incomplete", "parent_ended");
      endRelationship(relation, "incomplete");
    }
    for (const operation of run.operations.values()) {
      end(operation, "incomplete", {
        ...operation.usage,
        ...(operation.kind === "model" ? { "providerkit.usage.complete": false } : {}),
      });
    }
    run.children.clear();
    run.operations.clear();
    end(run, reason, detail ? { "providerkit.observation.end": detail } : {});
    if (run.relationship) endRelationship(run.relationship, reason);
    run.relationship = undefined;
  }

  function startRun(context: LifecycleContext, parent: Context): void {
    if (seen.has(context)) return;
    seen.add(context);
    if (!identities(context.runId, context.attemptId, context.agentId, context.version)) return;
    const previous = runs.get(context.runId);
    if (previous?.info.runAttemptId === context.attemptId) return;
    if (previous) endRun(previous, "incomplete", "superseded");
    while (runs.size >= maxRuns) {
      const oldest = runs.values().next().value;
      if (oldest) endRun(oldest, "incomplete", "capacity");
    }
    const relationship = relationships.get(context.runId);
    const info: AgentSpanInfo = {
      kind: "run",
      agentId: context.agentId,
      version: context.version,
      runId: context.runId,
      runAttemptId: context.attemptId,
    };
    const observed = start(
      info,
      relationship?.context ?? parent,
      () => relationship !== undefined && relationships.get(context.runId) !== relationship,
    );
    if (!observed) return;
    const run: ObservedRun = {
      ...observed,
      info,
      signal: context.signal,
      onAbort: () => endRun(run, "aborted", "signal"),
      operations: new Map(),
      children: new Map(),
      relationship,
      closed: false,
    };
    runs.set(info.runId, run);
    if (relationship) relationship.run = run;
    run.timer = setTimeout(() => endRun(run, "incomplete", "expired"), maxRunMs);
    run.signal.addEventListener("abort", run.onAbort, { once: true });
    if (run.signal.aborted) run.onAbort();
  }

  function operationKey(kind: Operation["kind"], id: string, attempt: string): string {
    return JSON.stringify([kind, id, attempt]);
  }

  function lifecycle(event: LifecycleEvent, context: LifecycleContext, parent: Context): void {
    if (closed) return;
    if (event.type === "run_start") {
      startRun(context, parent);
      return;
    }
    const run = runs.get(context.runId);
    if (!run || run.info.runAttemptId !== context.attemptId) return;
    if (event.type === "run_end") {
      endRun(run, event.state.status);
      return;
    }
    const tool = "request" in event;
    const kind = tool ? "tool" : "model";
    const id = tool ? event.request.operationId : event.operationId;
    const attempt = tool ? event.request.attemptId : event.attemptId;
    if (!identities(id, attempt)) return;
    const key = operationKey(kind, id, attempt);
    if (event.type === "model_start" || event.type === "tool_start") {
      if (run.operations.has(key) || run.operations.size + run.children.size >= maxSpans) return;
      const observed = start(
        { ...run.info, kind, operationId: id, operationAttemptId: attempt },
        run.context ?? parent,
        () => run.closed,
      );
      if (!observed) return;
      run.operations.set(key, { ...observed, kind, id, attemptId: attempt });
      return;
    }
    const operation = run.operations.get(key);
    if (!operation?.span) return;
    if (event.type === "model_end") {
      // collectTurn uses zeros for absent usage. Nonzero values prove a measurement; zero
      // requires an observed usage chunk. Guarded chunks are emitted AFTER this boundary.
      const measured = usageAttributes(event.turn.usage);
      if (Object.values(measured).some((value) => typeof value === "number" && value > 0))
        operation.usage = measured;
      end(operation, "returned", {
        ...operation.usage,
        "providerkit.usage.observed": operation.usage !== undefined,
        "providerkit.usage.complete": operation.usage !== undefined,
      });
    } else if (event.type === "tool_end") {
      end(operation, event.result.ok ? "returned" : "error");
    } else {
      end(operation, "error", {
        ...operation.usage,
        ...(kind === "model" ? { "providerkit.usage.complete": false } : {}),
      });
    }
  }

  function relationship(event: Extract<AgentEvent, { type: "child" | "handoff" }>): void {
    const handoff = event.type === "handoff";
    const parent = runs.get(handoff ? event.runId : event.parentRunId);
    const childRunId = handoff ? event.childRunId : event.runId;
    if (
      !parent ||
      (handoff && event.attemptId !== parent.info.runAttemptId) ||
      !identities(childRunId, event.operationId) ||
      childRunId === parent.info.runId ||
      parent.children.has(childRunId) ||
      relationships.has(childRunId) ||
      runs.has(childRunId) ||
      parent.operations.size + parent.children.size >= maxSpans
    )
      return;
    // ponytail: scan the bounded operation map instead of retaining a second index. Only a
    // currently open tool can parent new child work; an ended or missing start cannot.
    const tool = [...parent.operations.values()].find(
      (entry) => entry.kind === "tool" && entry.id === event.operationId && entry.context,
    );
    const observed = start(
      {
        ...parent.info,
        kind: handoff ? "handoff" : "child",
        operationId: event.operationId,
        operationAttemptId: tool?.attemptId,
        childRunId,
      },
      tool?.context ?? parent.context ?? currentContext(),
      () => parent.closed,
    );
    if (!observed) return;
    const relation: Relationship = { ...observed, childRunId };
    parent.children.set(childRunId, relation);
    relationships.set(childRunId, relation);
  }

  function progress(event: AgentEvent): void {
    if (closed) return;
    if (event.type === "child" || event.type === "handoff") relationship(event);
    else if (event.type === "model_chunk" && event.chunk.usage) {
      const run = runs.get(event.runId);
      if (run?.info.runAttemptId !== event.attemptId) return;
      const operation = run.operations.get(
        operationKey("model", event.operationId, event.attemptId),
      );
      if (operation?.span) operation.usage = usageAttributes(event.chunk.usage);
    } else if (event.type === "state" && event.state.status !== "running") {
      const run = runs.get(event.runId);
      if (run?.info.runAttemptId === event.attemptId) endRun(run, event.state.status);
      else {
        const relation = relationships.get(event.runId);
        // A child can fail before run_start (for example while acquiring its gate slot).
        if (relation && !relation.run) endRelationship(relation, event.state.status);
      }
    }
    // Restarts do not create spans. The next lifecycle start carries the real operation
    // attempt. In particular a tool restart must never replace its run's attempt identity.
  }

  const onLifecycle: LifecycleHook = (event, context) => {
    safely(() => lifecycle(event, context, currentContext()));
  };
  const onEvent: NonNullable<RunOptions["onEvent"]> = (event) => {
    safely(() => progress(event));
  };

  function withOptions<T extends RunOptions>(existing: T): T;
  function withOptions(): RunOptions;
  function withOptions(existing: RunOptions = {}): RunOptions {
    const parent = currentContext();
    return {
      ...existing,
      async onLifecycle(event, context) {
        safely(() => lifecycle(event, context, parent));
        try {
          await existing.onLifecycle?.(event, context);
        } catch {
          // Observers are not authority. Never log their exceptions, which may quote secrets.
        }
      },
      async onEvent(event) {
        onEvent(event);
        try {
          await existing.onEvent?.(event);
        } catch {
          // Same best-effort contract as the SDK's progress observer.
        }
      },
    };
  }

  return {
    onLifecycle,
    onEvent,
    options: withOptions,
    close() {
      closed = true;
      for (const run of runs.values()) endRun(run, "incomplete", "closed");
    },
  };
}

function safely<T>(work: () => T): T | undefined {
  try {
    return work();
  } catch {
    return undefined;
  }
}

function limit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new TypeError(`${name} must be a whole number from 1 to ${maximum}.`);
  return result;
}

function identities(...values: string[]): boolean {
  // Bound stored keys too, not just exporter values. Oversized identities skip observation,
  // rather than truncating two different operations into the same key.
  return values.every(
    (value) => typeof value === "string" && value.length > 0 && value.length <= 512,
  );
}

function safeAttributes(
  values: ReturnType<NonNullable<AgentTracingOptions["attributes"]>> | undefined,
): Attributes {
  const attributes: Attributes = {};
  let visited = 0;
  for (const key in values) {
    if (!Object.hasOwn(values, key)) continue;
    if (++visited > 32) break;
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) continue;
    const value = values[key];
    if (typeof value === "string") attributes[`providerkit.host.${key}`] = value.slice(0, 256);
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      attributes[`providerkit.host.${key}`] = value;
  }
  return attributes;
}

function usageAttributes(usage: TokenUsage): Attributes {
  const attributes: Attributes = {};
  const fields = {
    inputTokens: "gen_ai.usage.input_tokens",
    outputTokens: "gen_ai.usage.output_tokens",
    cachedInputTokens: "gen_ai.usage.cache_read.input_tokens",
    cacheWriteTokens: "gen_ai.usage.cache_creation.input_tokens",
    reasoningTokens: "providerkit.usage.reasoning_tokens",
    reportedCostUsd: "providerkit.usage.reported_cost_usd",
  } as const;
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      attributes[fields[key]] = value;
  }
  return attributes;
}
