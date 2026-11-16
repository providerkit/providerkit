import { messageOf, type JsonObjectSchema, type ToolDefinition } from "@providerkit/core";
import { RequestJournal } from "./request.ts";
import { handoffRef, type Handoff } from "./handoff.ts";
import { conversationOf, inputOf, readInput } from "./input.ts";
import {
  checkChildProgress,
  checkTree,
  childRunId,
  copyData,
  equalData,
  immutableCopy,
  isId,
  isRecord,
} from "./snapshot.ts";
import { emitEvent, fail, Halt, isLocalStop, untilAbort, type ExecutionScope } from "./tree.ts";
import type {
  Agent,
  AgentInput,
  AgentMessage,
  Answer,
  QuestionAsk,
  ChildEnvelope,
  DelegationExecution,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  ToolResult,
  UserContent,
} from "./types.ts";

/** Internal symbol holds no execution state. Every invocation receives its own scope. */
export const AGENT_RUNTIME = Symbol("agent-runtime");

/** @internal What a new run starts from, checked: the history before the new turn, the turn,
 * and the session the history came from. */
export interface RunStart {
  history: AgentMessage[];
  input: UserContent;
  session?: RunSnapshot["session"];
}

/** @internal */
export interface AgentRuntime<T> {
  readonly outputKind: "text" | "checked";
  readonly handoffs: readonly Handoff[];
  /** A new root run's snapshot: the input normalized, the session read once and the history
   * prepared, repaired and frozen, before anything is saved. */
  open(input: AgentInput, options: RunOptions, runId: string): Promise<RunSnapshot>;
  /** The history repaired with this agent's tools and the inline bytes checked: the exact form
   * a snapshot stores, so a saved child can be compared with a new request for its key. */
  freeze(start: RunStart): RunStart;
  /** Resolves the run definition once, then creates a snapshot from the repaired history. */
  create(
    start: RunStart,
    runId: string,
    tree?: RunSnapshot["tree"],
    options?: RunOptions,
  ): Promise<RunSnapshot>;
  restore(raw: unknown, tree?: RunSnapshot["tree"]): RunSnapshot;
  hydrate(snapshot: RunSnapshot): RunOutcome<T>;
  answerRequests(
    snapshot: RunSnapshot,
    options: RunOptions,
    scope: ExecutionScope,
    answers: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void>;
  execute(
    snapshot: RunSnapshot,
    options: RunOptions,
    scope: ExecutionScope,
    answers?: Readonly<Record<string, unknown>>,
  ): Promise<RunOutcome<T>>;
}

export interface ChildHandle<T = unknown> {
  readonly key: string;
  readonly runId: string;
  /** A started child, not another provider call. Repeated joins reuse the same outcome. */
  join(): Promise<RunOutcome<T>>;
}

export type Joined<H extends readonly ChildHandle<unknown>[]> = {
  [K in keyof H]: H[K] extends ChildHandle<infer T> ? RunOutcome<T> : never;
};

export interface DelegationContext {
  /** Pure coordination replays from its start. The saved answer is matched by key and checked
   * by this pure validator, not by a saved JavaScript stack. A rejected form is asked again. */
  ask<T>(question: Omit<QuestionAsk, "type">, validate: (answer: Answer) => T): Promise<T>;
  /** `key` becomes part of the child's run id and of every operation id under it, which
   * progress events carry and a display layer may send to a browser. Key by position or a
   * fixed name ("topic-1"), never by the input. The input is checked like `run`'s, except
   * that provider-owned fields are kept: coordinator code is trusted. A child never gets the
   * parent's session. */
  child<T>(key: string, agent: Agent<T>, input: AgentInput): ChildHandle<T>;
  /** Settles in caller order, not completion order. No child may outlive this barrier. */
  join<const H extends readonly ChildHandle<unknown>[]>(handles: H): Promise<Joined<H>>;
  /** The parent's conversation before this tool call: no system prompt and no unfinished
   * round. Frozen. A child sees none of it unless you forward it, for example
   * `{ messages: [...context.conversation, { role: "user", content: task }] }`. */
  readonly conversation: readonly AgentMessage[];
}

export interface DelegationSpec<I, O> {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  needsApproval?: boolean;
  validate: (raw: unknown) => I;
  /** Fixed allow-list. Agents cannot add tools or specialists at runtime. */
  specialists: readonly Agent<unknown>[];
  /** Pure, deterministic coordination only: use child and join for work. This callback
   * can replay after interruption; do not put external effects or mutable host state here. */
  run: (input: I, context: DelegationContext) => Promise<O>;
  summarize?: (output: O) => string;
}

/** Advertises a core tool definition, but deliberately is not an invokable core Tool. */
export interface Delegation {
  readonly kind: "delegation";
  readonly name: string;
  readonly needsApproval: boolean;
  readonly specialists: readonly Agent<unknown>[];
  definition(): ToolDefinition;
  /** @internal Errors and suspensions must not go through Tool.invoke's error conversion. */
  execute(raw: unknown, context: DelegationContext): Promise<ToolResult>;
}

export interface SpecialistToolOptions<T> {
  needsApproval?: boolean;
  name: string;
  description: string;
  /** Pure; may run again when replaying coordination. */
  summarize?: (output: T) => string;
}

export function isDelegation(value: { readonly name: string }): value is Delegation {
  return "kind" in value && value.kind === "delegation";
}

export function defineDelegation<I, O>(spec: DelegationSpec<I, O>): Delegation {
  if (
    !isId(spec.name) ||
    !isId(spec.description) ||
    !isRecord(spec.inputSchema) ||
    spec.inputSchema.type !== "object" ||
    typeof spec.validate !== "function" ||
    typeof spec.run !== "function" ||
    (spec.summarize !== undefined && typeof spec.summarize !== "function")
  )
    throw new TypeError(
      "A delegation needs a name, description, object schema, validator and coordinator.",
    );
  const specialists = Object.freeze([...spec.specialists]);
  if (
    specialists.some((agent) => !agent?.[AGENT_RUNTIME]) ||
    new Set(specialists.map((agent) => agent.id)).size !== specialists.length
  )
    throw new TypeError("Register each specialist agent once, with a unique id.");
  const definition = immutableCopy({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  });
  const { validate, run, summarize } = spec;
  return Object.freeze({
    kind: "delegation",
    name: spec.name,
    needsApproval: spec.needsApproval ?? false,
    specialists,
    definition: () => copyData(definition),
    async execute(raw: unknown, context: DelegationContext): Promise<ToolResult> {
      let input: I;
      try {
        input = validate(copyData(raw));
      } catch (error) {
        return { ok: false, kind: "invalid_input", content: messageOf(error) };
      }
      const output = await run(input, context);
      const content = summarize ? summarize(output) : JSON.stringify(output);
      if (typeof content !== "string") throw new TypeError("A delegation summary must be text.");
      return { ok: true, content };
    },
  });
}

export function specialistTool<T>(agent: Agent<T>, options: SpecialistToolOptions<T>): Delegation {
  const descriptor = defineDelegation({
    ...options,
    inputSchema: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    },
    specialists: [agent],
    validate(raw) {
      if (!isRecord(raw) || !isId(raw.input) || Object.keys(raw).some((key) => key !== "input"))
        throw new TypeError("Pass one non-empty input string to the specialist.");
      return raw.input;
    },
    async run(input, context) {
      const result = await context.child("result", agent, input).join();
      if (result.status !== "completed") {
        // A suspension is lifted with its child path by executeDelegation below.
        const state = result.snapshot.state;
        if (state.status === "running" || state.status === "completed")
          throw new Error("The specialist outcome does not match its snapshot.");
        throw new Halt(state);
      }
      return result.output;
    },
  });
  return Object.freeze({
    ...descriptor,
    async execute(raw: unknown, context: DelegationContext): Promise<ToolResult> {
      try {
        return await descriptor.execute(raw, context);
      } catch (error) {
        if (!(error instanceof Halt) || !isLocalStop(error.state)) throw error;
        const reason =
          error.state.status === "limited"
            ? `its ${error.state.limit === "elapsedMs" ? "time" : error.state.limit === "outputTokens" ? "output" : error.state.limit === "toolCalls" ? "tool-call" : "model-turn"} limit`
            : "a model or result failure";
        return {
          ok: false,
          kind: "failed",
          content: `The specialist could not finish because of ${reason}. Continue with the other results.`,
        };
      }
    },
  });
}

/** The whole pure coordination barrier lends its parent's slot, not each join.
 * Overlapping joins therefore cannot reacquire a slot while another join still waits. */
export async function executeDelegation(
  descriptor: Delegation,
  journal: DelegationExecution,
  parent: RunSnapshot,
  raw: Record<string, unknown>,
  options: RunOptions,
  scope: ExecutionScope,
  signal: AbortSignal,
  active: () => void,
  requests: RequestJournal,
): Promise<ToolResult> {
  let open = true;
  const started = new Map<string, Promise<void>>();
  const requested = new Map<string, { agentId: string; version: string; start: RunStart }>();
  // Resolve new child definitions in admission order, without delaying children already
  // running. No half-resolved definition can appear in another child's root checkpoint.
  let admissions = Promise.resolve();
  const handles = new WeakSet<ChildHandle<unknown>>();
  // Computed again on a replay from the same settled rounds, so a coordinator that forwards it
  // asks for the same child input and reuses the saved child.
  const conversation = immutableCopy(conversationOf(parent));
  // A specialist never loads or appends its parent's conversation.
  const {
    session: _session,
    historyLimit: _historyLimit,
    prepareHistory: _prepareHistory,
    modelSettings: _modelSettings,
    enabledTools: _enabledTools,
    ...inherited
  } = options;

  function child<T>(key: string, agent: Agent<T>, input: AgentInput): ChildHandle<T> {
    if (!open)
      throw new Error("This delegation has ended; start children only inside its coordinator.");
    active();
    if (!isId(key)) throw new TypeError("A child needs a non-empty key.");
    if (!descriptor.specialists.includes(agent))
      fail(
        "unregistered_specialist",
        "Register this specialist in the delegation before starting it.",
        journal.operationId,
      );
    const runtime = agent[AGENT_RUNTIME];
    const start = runtime.freeze(readInput(input, "trusted"));
    const prior = requested.get(key);
    if (
      prior &&
      (prior.agentId !== agent.id ||
        prior.version !== agent.version ||
        !equalData(prior.start, start))
    )
      fail(
        "child_key_conflict",
        "This child key already belongs to another agent, version or input.",
        journal.operationId,
      );
    requested.set(key, { agentId: agent.id, version: agent.version, start });
    const runId = childRunId(journal.operationId, key);
    let entry = journal.children.find((saved) => saved.key === key);
    const resume = entry !== undefined;
    if (
      entry &&
      (entry.snapshot.agentId !== agent.id ||
        entry.snapshot.version !== agent.version ||
        !equalData(entry.snapshot.history, start.history) ||
        !equalData(entry.snapshot.input, start.input))
    )
      fail(
        "child_key_conflict",
        "This child key already belongs to another agent, version or input.",
        journal.operationId,
      );
    if (!started.has(key)) {
      let admitted: Promise<ChildEnvelope & { key: string }>;
      if (entry) admitted = Promise.resolve(entry);
      else {
        scope.tree.reserveChild(scope.depth + 1);
        admitted = admissions.then(async () => {
          const snapshot = await runtime.create(start, runId, parent.tree, {
            ...inherited,
            signal,
          });
          active();
          // Recheck after the async definition, and push without an await: children in
          // another delegation may have used the tree's last admission in the meantime.
          scope.tree.reserveChild(scope.depth + 1);
          entry = { key, snapshot };
          journal.children.push(entry);
          return entry;
        });
        admissions = admitted.then(
          () => {},
          () => {},
        );
      }
      const work = async () => {
        const saved = await admitted;
        if (
          saved.snapshot.state.status !== "running" &&
          saved.snapshot.state.status !== "suspended"
        )
          return;
        await scope.tree.save();
        active();
        const step = { operationId: journal.operationId, key, runId: saved.snapshot.runId };
        if (journal.kind === "handoff")
          emitEvent(options, {
            type: "handoff",
            runId: parent.runId,
            attemptId: parent.attemptId,
            operationId: journal.operationId,
            childRunId: saved.snapshot.runId,
            from: handoffRef(parent),
            to: journal.target,
            ...(journal.note !== undefined ? { note: journal.note } : {}),
          });
        let execution: Promise<ChildEnvelope> | undefined;
        let hookOpen = true;
        let executionSettled = false;
        const execute = () => {
          if (!hookOpen || execution)
            throw new Error("A host child may execute once, before its hook returns.");
          execution = (async () => {
            if (resume) saved.snapshot.attemptId = crypto.randomUUID();
            // Sent here, not where the child is admitted, so it always comes with a run: the
            // child's own state event follows it. A settled child that is reused, or one the host
            // serves from a saved copy without running it, never gets this far, and a row for it
            // would wait for a status that no event brings. Once per key: `started` and the
            // execute-once check above both guard it.
            emitEvent(options, {
              type: "child",
              parentRunId: parent.runId,
              ...step,
              agentId: agent.id,
              version: agent.version,
            });
            const result = await runtime.execute(
              saved.snapshot,
              { ...inherited, signal },
              { tree: scope.tree, depth: scope.depth + 1, path: [...scope.path, step] },
            );
            executionSettled = true;
            return { snapshot: result.snapshot };
          })();
          // A hook that throws or forgets to await cannot leave an unhandled child promise.
          void execution.catch(() => {});
          return execution;
        };
        let envelope: ChildEnvelope;
        try {
          envelope = options.host?.child
            ? await untilAbort(
                Promise.resolve(
                  options.host.child(
                    immutableCopy({
                      ...saved,
                      parentRunId: parent.runId,
                      operationId: journal.operationId,
                      resume,
                    }),
                    execute,
                  ),
                ),
                signal,
              )
            : await execute();
          if (execution && !executionSettled)
            fail(
              "invalid_child_host",
              "The child hook returned before its execution settled.",
              journal.operationId,
            );
        } finally {
          hookOpen = false;
          if (execution) await execution;
        }
        if (!isRecord(envelope) || (envelope.reference !== undefined && !isId(envelope.reference)))
          fail(
            "invalid_child_host",
            "The child hook must return a snapshot envelope.",
            journal.operationId,
          );
        const restored = runtime.restore(envelope.snapshot, parent.tree);
        checkChildProgress(saved.snapshot, restored);
        if (restored.state.status === "running")
          fail(
            "invalid_child_host",
            "The child hook returned an unfinished child.",
            journal.operationId,
          );
        const previous = saved.snapshot;
        saved.snapshot = restored;
        try {
          checkTree(scope.tree.root);
        } catch (error) {
          saved.snapshot = previous;
          throw error;
        }
        saved.reference = envelope.reference ?? saved.reference;
        await scope.tree.save();
      };
      const promise = work().catch(async (error: unknown) => {
        let failure = error;
        try {
          active();
        } catch (stopped) {
          failure = stopped;
        }
        if (entry?.snapshot.state.status === "running") {
          entry.snapshot.state =
            failure instanceof Halt
              ? failure.state
              : {
                  status: "failed",
                  error: { code: "child_host_failed", message: messageOf(failure) },
                };
          await scope.tree.save();
        }
        throw failure;
      });
      started.set(key, promise);
      void promise.catch(() => {});
    }
    const pending = started.get(key);
    const handle = Object.freeze({
      key,
      runId,
      async join(): Promise<RunOutcome<T>> {
        await pending;
        const saved = journal.children.find((child) => child.key === key);
        if (!saved) throw new Error("The child ended before its definition was resolved.");
        return runtime.hydrate(saved.snapshot);
      },
    });
    handles.add(handle);
    return handle;
  }

  function join<const H extends readonly ChildHandle<unknown>[]>(items: H): Promise<Joined<H>>;
  async function join(items: readonly ChildHandle<unknown>[]): Promise<RunOutcome<unknown>[]> {
    if (items.some((handle) => !handles.has(handle)))
      throw new TypeError("Join only handles created by this delegation context.");
    return Promise.all(items.map((handle) => handle.join()));
  }

  // Adapted from LangGraph.js (MIT), interrupt.ts: return a saved answer on replay.
  // Keys replace positional matching; validation stays with the trusted coordinator.
  let asks = Promise.resolve();
  const asking: Promise<unknown>[] = [];
  function ask<T>(
    question: Omit<QuestionAsk, "type">,
    validate: (answer: Answer) => T,
  ): Promise<T> {
    if (!open) throw new Error("Ask only inside the active coordinator.");
    const work = asks.then(async () => {
      active();
      const record = await requests.ensure({ ...question, type: "question" });
      if (!record.decision) throw new Halt({ status: "suspended" });
      if (record.decision.type === "stop") {
        scope.tree.stop();
        throw new Halt({ status: "cancelled" });
      }
      if (record.decision.type === "cancel") throw new CancelledQuestion();
      if (record.decision.type !== "answer") throw new TypeError("This question needs an answer.");
      await requests.recheck({ ...requests.call, arguments: raw });
      active();
      try {
        return validate(immutableCopy(record.decision.answer));
      } catch (error) {
        record.closed = "invalid";
        await requests.open(
          { ...question, type: "question" },
          { code: "invalid_answer", message: messageOf(error) },
        );
        throw new Halt({ status: "suspended" });
      }
    });
    asks = work.then(
      () => {},
      () => {},
    );
    asking.push(work);
    void work.catch(() => {});
    return work;
  }

  let result: ToolResult | undefined;
  let failure: { error: unknown } | undefined;
  try {
    result = await untilAbort(
      descriptor.execute(raw, Object.freeze({ child, join, ask, conversation })),
      signal,
    );
  } catch (error) {
    failure = { error };
  } finally {
    // Even ignored children belong to this parent, including children admitted on an
    // earlier attempt that pure coordination did not revisit this time.
    try {
      for (const entry of journal.children) {
        if (started.has(entry.key)) continue;
        const agent = descriptor.specialists.find(
          (agent) =>
            agent.id === entry.snapshot.agentId && agent.version === entry.snapshot.version,
        );
        if (!agent)
          fail("unregistered_specialist", "The saved child is not a registered specialist.");
        child(entry.key, agent, inputOf(entry.snapshot));
      }
    } catch (error) {
      failure ??= { error };
    }
    open = false;
    const settled = await Promise.allSettled([...started.values(), ...asking]);
    const rejected =
      settled.find(
        (item) =>
          item.status === "rejected" &&
          !(item.reason instanceof Halt && item.reason.state.status === "suspended"),
      ) ?? settled.find((item) => item.status === "rejected");
    if (rejected?.status === "rejected") failure = { error: rejected.reason };
  }
  active();
  // A coordinator may inspect or ignore outcomes, but cannot waive cancellation, tree limits
  // or broken host/journal contracts. All admitted children have settled at this point.
  for (const { snapshot } of journal.children) {
    const state = snapshot.state;
    if (state.status === "cancelled") scope.tree.stop();
    if (
      (state.status === "cancelled" || state.status === "limited" || state.status === "failed") &&
      !isLocalStop(state)
    )
      throw new Halt(state);
  }
  if (failure?.error instanceof CancelledQuestion)
    return {
      ok: false,
      kind: "cancelled",
      content: "The person cancelled this question. Continue without this action.",
    };
  if (failure && !(failure.error instanceof Halt && failure.error.state.status === "suspended"))
    throw failure.error;
  if (
    journal.children.some((entry) => entry.snapshot.state.status === "suspended") ||
    requests.execution.asks?.some((record) => !record.closed && !record.decision)
  )
    throw new Halt({ status: "suspended" });
  if (failure) throw failure.error;
  if (!result) throw new Error("The delegation ended without a result.");
  return result;
}

class CancelledQuestion extends Error {}
