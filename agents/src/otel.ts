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
import { withProviderTracing } from "@providerkit/core/otel";
import type {
  AgentEvent,
  LifecycleContext,
  LifecycleEvent,
  LifecycleHook,
  ModelProviderBinding,
  RunOptions,
  RunState,
} from "./types.ts";

export interface AgentSpanInfo {
  readonly kind: "run" | "model" | "tool" | "child" | "handoff" | "step";
  readonly nodeKind: "agent" | "workflow" | "remote";
  readonly nodeId: string;
  readonly version: string;
  readonly runId: string;
  readonly runAttemptId: string;
  readonly operationId?: string;
  /** A tool or workflow effect retry changes this without changing runAttemptId. */
  readonly operationAttemptId?: string;
  readonly parentOperationId?: string;
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
  /** Maximum Agents operation/relationship records per run, including ended records. Each
   * model record can also own one Core CLIENT child. New records are skipped once full.
   * Default 1,024, maximum 16,384. */
  maxSpansPerRun?: number;
  /** Absolute Agents observation lifetime, not an execution timeout. Default 30 minutes,
   * max 24 hours. Does not close Core's independently owned in-flight provider spans. */
  maxRunMs?: number;
}

export interface AgentTracing {
  /** options() composes all three hooks with existing callbacks. For manual composition,
   * attach each once and apply bindModelProvider last, outside other provider decorators. */
  readonly onLifecycle: LifecycleHook;
  readonly onEvent: NonNullable<RunOptions["onEvent"]>;
  readonly bindModelProvider: ModelProviderBinding;
  options(): RunOptions;
  options<T extends RunOptions>(options: T): T;
  /** Close Agents observations as incomplete and detach listeners, without cancelling work.
   * Later callbacks are ignored. Core has no independent close API: streams already bound
   * here remain independently observed until termination or caller abort. No exporter is flushed. */
  close(): void;
}

type EndReason = RunState["status"] | "returned" | "error" | "aborted" | "incomplete";
interface ObservedSpan {
  span?: Span;
  context?: Context;
  terminal?: { reason: EndReason; attributes: Attributes };
  detach?: () => void;
}
interface Operation extends ObservedSpan {
  kind: "model" | "tool" | "step";
  id: string;
  attemptId: string;
}
interface Relationship extends ObservedSpan {
  childRunId: string;
  run?: ObservedRun;
}
interface ObservedRun extends ObservedSpan {
  info: AgentSpanInfo;
  signal?: AbortSignal;
  onAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  operations: Map<string, Operation>;
  children: Map<string, Relationship>;
  relationship?: Relationship;
  closed: boolean;
}

/** Opt-in execution observation. No exporter, network request or context manager.
 *
 * Each run span covers one live agent, workflow or remote attempt, not time between resumes.
 * INTERNAL model-operation spans retain SDK operation identity. Core owns their single CLIENT
 * child and all provider/usage fields, including guarded, zero and partial observations. The
 * binding rebinds an already-traced final provider; wrappers hidden inside other decorators
 * cannot be deduplicated. Model/tool returns precede output guards; only run status describes
 * acceptance. Missing starts and cached work do not create spans.
 *
 * Remote spans describe local observation, not remote billing or confirmed cancellation.
 * Returning a parent-continuation handle can complete a run while the remote task still waits.
 * Its last observed remote state is separate; no peer task/context IDs or questions are captured.
 * Explicit remote.cancel() has no separate SDK operation span. Remote receipts still record
 * cancellation; host HTTP instrumentation may observe the request. Status updates do not prove
 * a send/cancel attempt or known cost.
 *
 * Explicit parents work without a context manager. Core activates context around provider
 * iterator calls only. Tool/step hooks are observers, NOT async execution scopes: HTTP children
 * there require host instrumentation and a working host-supplied context manager.
 *
 * Bounds and close() release Agents spans only. They never stop work, close an iterator or
 * replay a paid call. Core's in-flight spans end on stream termination or caller abort; a
 * stream abandoned without either cannot be closed by this adapter. No content, host context,
 * claims, endpoint, error message or estimated cost is recorded.
 */
export function createAgentTracing(options: AgentTracingOptions = {}): AgentTracing {
  const maxRuns = limit(options.maxRuns, 128, 1_024, "maxRuns");
  const maxSpans = limit(options.maxSpansPerRun, 1_024, 16_384, "maxSpansPerRun");
  const maxRunMs = limit(options.maxRunMs, 30 * 60_000, 24 * 60 * 60_000, "maxRunMs");
  const tracer = options.tracer ?? safely(() => trace.getTracer("@providerkit/agents"));
  const runs = new Map<string, ObservedRun>();
  const relationships = new Map<string, Relationship>();
  // Weak keys suppress repeated starts and unwrap only our instrumentation functions.
  // Never retain/restore an old options object: its authority and context can have changed.
  const seen = new WeakSet<object>();
  const lifecycleWrappers = new WeakMap<LifecycleHook, LifecycleHook | undefined>();
  const eventWrappers = new WeakMap<NonNullable<RunOptions["onEvent"]>, RunOptions["onEvent"]>();
  const providerWrappers = new WeakMap<ModelProviderBinding, ModelProviderBinding | undefined>();
  let closed = false;

  function currentContext(): Context {
    return options.parentContext ?? safely(() => otelContext.active()) ?? ROOT_CONTEXT;
  }

  function start(
    entry: ObservedSpan,
    info: AgentSpanInfo,
    parent: Context,
    ownerClosed: () => boolean,
  ): void {
    const attributes: Attributes = {
      "providerkit.span.kind": info.kind,
      "providerkit.node.kind": info.nodeKind,
      "providerkit.node.id": info.nodeId,
      "providerkit.node.version": info.version,
      "providerkit.run.id": info.runId,
      "providerkit.run.attempt.id": info.runAttemptId,
    };
    if (info.operationId !== undefined) attributes["providerkit.operation.id"] = info.operationId;
    if (info.operationAttemptId !== undefined)
      attributes["providerkit.operation.attempt.id"] = info.operationAttemptId;
    if (info.parentOperationId !== undefined)
      attributes["providerkit.operation.parent.id"] = info.parentOperationId;
    if (info.childRunId !== undefined) attributes["providerkit.child.run.id"] = info.childRunId;
    if (info.nodeKind === "remote") attributes["providerkit.billing"] = "unknown";
    const custom = safely(() => safeAttributes(options.attributes?.(Object.freeze({ ...info }))));
    const span = safely(() =>
      tracer?.startSpan(
        `providerkit.${info.nodeKind}.${info.kind}`,
        { kind: SpanKind.INTERNAL, attributes: { ...attributes, ...custom } },
        parent,
      ),
    );
    entry.span = span;
    entry.context = span ? (safely(() => trace.setSpan(parent, span)) ?? parent) : parent;
    // Terminal callbacks can arrive while startSpan is running. Keep their actual outcome,
    // even before there is a span to end, and apply it once to the returned span.
    if (entry.terminal) end(entry, entry.terminal.reason, entry.terminal.attributes);
    else if (closed || ownerClosed()) end(entry, "incomplete");
  }

  function end(entry: ObservedSpan, reason: EndReason, attributes: Attributes = {}): void {
    const terminal = (entry.terminal ??= { reason, attributes });
    const span = entry.span;
    const detach = entry.detach;
    // Drop ownership before exporter-facing methods, including a reentrant or throwing end().
    entry.span = undefined;
    entry.context = undefined;
    entry.detach = undefined;
    safely(() => detach?.());
    if (!span) return;
    safely(() =>
      span.setAttributes({ ...terminal.attributes, "providerkit.outcome": terminal.reason }),
    );
    if (
      terminal.reason === "failed" ||
      terminal.reason === "error" ||
      terminal.reason === "limited"
    )
      safely(() => span.setStatus({ code: SpanStatusCode.ERROR }));
    // Success and caller cancellation leave status UNSET, not OK or a provider failure.
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
    safely(() => run.signal?.removeEventListener("abort", run.onAbort));
    for (const relation of run.children.values()) {
      if (relation.run) endRun(relation.run, "incomplete", "parent_ended");
      endRelationship(relation, "incomplete");
    }
    // A parent ending is not evidence of a missing operation's success or cancellation.
    for (const operation of run.operations.values()) end(operation, "incomplete");
    run.children.clear();
    run.operations.clear();
    end(run, reason, detail ? { "providerkit.observation.end": detail } : {});
    if (run.relationship) endRelationship(run.relationship, reason);
    run.relationship = undefined;
  }

  function startRun(
    info: AgentSpanInfo,
    token: object,
    parent: Context,
    signal?: AbortSignal,
  ): void {
    if (seen.has(token)) return;
    seen.add(token);
    if (!identities(info.runId, info.runAttemptId, info.nodeId, info.version)) return;
    const relation = relationships.get(info.runId);
    const previous = runs.get(info.runId);
    if (previous?.info.runAttemptId === info.runAttemptId) return;
    if (previous) endRun(previous, "incomplete", "superseded");
    while (runs.size >= maxRuns) {
      const oldest = runs.values().next().value;
      if (oldest) endRun(oldest, "incomplete", "capacity");
    }
    // Evicting a parent can close this child's relationship. Do not invent a new root for it.
    if (closed || (relation && relationships.get(info.runId) !== relation)) return;
    const run: ObservedRun = {
      info,
      signal,
      onAbort: () => endRun(run, "aborted", "signal"),
      operations: new Map(),
      children: new Map(),
      relationship: relation,
      closed: false,
    };
    runs.set(info.runId, run);
    if (relation) relation.run = run;
    start(run, info, relation?.context ?? parent, () => run.closed);
    if (run.closed || closed) return;
    run.timer = setTimeout(() => endRun(run, "incomplete", "expired"), maxRunMs);
    signal?.addEventListener("abort", run.onAbort, { once: true });
    if (signal?.aborted) run.onAbort();
  }

  function operationKey(kind: Operation["kind"], id: string, attempt: string): string {
    return JSON.stringify([kind, id, attempt]);
  }

  function parentOperation(run: ObservedRun, id: string | undefined): Operation | undefined {
    // ponytail: scan the bounded map rather than retain another index. Ended operations
    // cannot parent new work; explicit parentOperationId handles code-mode inner calls.
    return id === undefined
      ? undefined
      : [...run.operations.values()].find((entry) => entry.id === id && entry.context);
  }

  function startOperation(
    run: ObservedRun,
    kind: Operation["kind"],
    id: string,
    attemptId: string,
    parentOperationId?: string,
    signal?: AbortSignal,
  ): void {
    if (
      !identities(id, attemptId) ||
      (parentOperationId !== undefined && !identities(parentOperationId))
    )
      return;
    const key = operationKey(kind, id, attemptId);
    if (run.operations.has(key) || run.operations.size + run.children.size >= maxSpans) return;
    const operation: Operation = { kind, id, attemptId };
    run.operations.set(key, operation);
    if (signal) {
      // A code program can stop an inner call while its owning run continues. Lifecycle end
      // hooks are skipped on that aborted signal; observe the explicit operation signal itself.
      const onAbort = () => end(operation, "aborted");
      operation.detach = () => signal.removeEventListener("abort", onAbort);
      safely(() => signal.addEventListener("abort", onAbort, { once: true }));
      if (signal.aborted) onAbort();
    }
    start(
      operation,
      { ...run.info, kind, operationId: id, operationAttemptId: attemptId, parentOperationId },
      parentOperation(run, parentOperationId)?.context ?? run.context ?? currentContext(),
      () => run.closed,
    );
  }

  function lifecycle(event: LifecycleEvent, context: LifecycleContext, parent: Context): void {
    if (closed) return;
    if (event.type === "run_start") {
      startRun(
        {
          kind: "run",
          nodeKind: "agent",
          nodeId: context.agentId,
          version: context.version,
          runId: context.runId,
          runAttemptId: context.attemptId,
        },
        context,
        parent,
        context.signal,
      );
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
    if (event.type === "model_start" || event.type === "tool_start") {
      startOperation(
        run,
        kind,
        id,
        attempt,
        tool ? event.request.parentOperationId : undefined,
        tool ? context.signal : undefined,
      );
      return;
    }
    const operation = run.operations.get(operationKey(kind, id, attempt));
    if (!operation) return;
    if (event.type === "model_end") end(operation, "returned");
    else if (event.type === "tool_end")
      end(
        operation,
        event.result.ok ? "returned" : event.result.kind === "cancelled" ? "cancelled" : "error",
      );
    else end(operation, "error");
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
    const operation = parentOperation(parent, event.operationId);
    const relation: Relationship = { childRunId };
    parent.children.set(childRunId, relation);
    relationships.set(childRunId, relation);
    start(
      relation,
      {
        ...parent.info,
        kind: handoff ? "handoff" : "child",
        operationId: event.operationId,
        operationAttemptId: operation?.attemptId,
        childRunId,
      },
      operation?.context ?? parent.context ?? currentContext(),
      () => parent.closed || relationships.get(childRunId) !== relation,
    );
  }

  function progress(event: AgentEvent, parent: Context, signal?: AbortSignal): void {
    if (closed) return;
    if (event.type === "execution_start") {
      startRun(
        {
          kind: "run",
          nodeKind: event.kind,
          nodeId: event.nodeId,
          version: event.version,
          runId: event.runId,
          runAttemptId: event.attemptId,
        },
        event,
        parent,
        signal,
      );
    } else if (event.type === "child" || event.type === "handoff") relationship(event);
    else if (event.type === "step_start" || event.type === "step_result") {
      const run = runs.get(event.runId);
      if (!run || run.info.nodeKind !== "workflow") return;
      // The event's attemptId is the actual effect attempt, NOT the workflow's attemptId.
      if (event.type === "step_start") {
        startOperation(run, "step", event.operationId, event.attemptId);
        const operation = run.operations.get(
          operationKey("step", event.operationId, event.attemptId),
        );
        safely(() => operation?.span?.setAttribute("providerkit.step.kind", event.kind));
      } else {
        const operation = run.operations.get(
          operationKey("step", event.operationId, event.attemptId),
        );
        if (operation) end(operation, event.status === "completed" ? "returned" : "error");
      }
    } else if (event.type === "remote_status") {
      const run = runs.get(event.runId);
      if (run?.info.nodeKind === "remote" && run.info.runAttemptId === event.attemptId)
        safely(() => run.span?.setAttribute("providerkit.remote.state", event.state));
    } else if (event.type === "state" && event.state.status !== "running") {
      const run = runs.get(event.runId);
      if (run?.info.runAttemptId === event.attemptId) endRun(run, event.state.status);
      else {
        const relation = relationships.get(event.runId);
        // A child can fail before its start, for example while acquiring its gate slot.
        if (relation && !relation.run) endRelationship(relation, event.state.status);
      }
    }
  }

  const onLifecycle: LifecycleHook = (event, context) => {
    safely(() => lifecycle(event, context, currentContext()));
  };
  const onEvent: NonNullable<RunOptions["onEvent"]> = (event) => {
    safely(() => progress(event, currentContext()));
  };
  const bindModelProvider: ModelProviderBinding = (provider, scope) =>
    safely(() => {
      if (closed) return provider;
      const run = runs.get(scope.run.runId);
      if (!run || run.info.runAttemptId !== scope.run.attemptId) return provider;
      const operation = run.operations.get(
        operationKey("model", scope.operationId, scope.operationAttemptId),
      );
      if (!operation?.context) return provider;
      safely(() => operation.span?.setAttribute("providerkit.model.purpose", scope.purpose));
      if (run.closed || closed || !operation.context) return provider;
      return withProviderTracing(provider, { tracer, parentContext: operation.context });
    }) ?? provider;

  function withOptions<T extends RunOptions>(existing: T): T;
  function withOptions(): RunOptions;
  function withOptions(input: RunOptions = {}): RunOptions {
    const existingLifecycle =
      input.onLifecycle && lifecycleWrappers.has(input.onLifecycle)
        ? lifecycleWrappers.get(input.onLifecycle)
        : input.onLifecycle;
    const existingEvent =
      input.onEvent && eventWrappers.has(input.onEvent)
        ? eventWrappers.get(input.onEvent)
        : input.onEvent;
    const existingBinding =
      input.bindModelProvider && providerWrappers.has(input.bindModelProvider)
        ? providerWrappers.get(input.bindModelProvider)
        : input.bindModelProvider;
    const parent = currentContext();
    const result = {
      ...input,
      async onLifecycle(event, context) {
        safely(() => lifecycle(event, context, parent));
        try {
          if (existingLifecycle !== onLifecycle) await existingLifecycle?.(event, context);
        } catch {
          // Observers are not authority. Never log exceptions, which may quote secrets.
        }
      },
      async onEvent(event) {
        safely(() => progress(event, parent, result.signal));
        try {
          if (existingEvent !== onEvent) await existingEvent?.(event);
        } catch {
          // Same best-effort contract as the SDK's progress observer.
        }
      },
      bindModelProvider(provider, scope) {
        // Existing instrumentation runs once, before our final Core wrapper. Only a binding
        // failure before dispatch can fall back; provider creation/reads are never retried here.
        const selected =
          safely(() => {
            if (!existingBinding || existingBinding === bindModelProvider) return provider;
            const bound = existingBinding(provider, scope);
            return bound && typeof bound.createStream === "function" ? bound : provider;
          }) ?? provider;
        return bindModelProvider(selected, scope);
      },
    } satisfies RunOptions;
    lifecycleWrappers.set(result.onLifecycle, existingLifecycle);
    eventWrappers.set(result.onEvent, existingEvent);
    providerWrappers.set(result.bindModelProvider, existingBinding);
    return result;
  }

  return {
    onLifecycle,
    onEvent,
    bindModelProvider,
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
  // Bound stored keys too. Truncation could merge two distinct operations into one span.
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
