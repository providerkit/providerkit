import { messageOf, type JsonObjectSchema, type ToolDefinition } from "@providerkit/core";
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
import { fail, Halt, untilAbort, type ExecutionScope } from "./tree.ts";
import type {
  Agent,
  ChildEnvelope,
  ChildPathStep,
  DelegationExecution,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  ToolResult,
} from "./types.ts";

/** Internal symbol holds no execution state. Every invocation receives its own scope. */
export const AGENT_RUNTIME = Symbol("agent-runtime");

export interface ApprovalEvidence {
  path: readonly ChildPathStep[];
  decision: unknown;
}

/** @internal */
export interface AgentRuntime<T> {
  create(input: string, runId: string, tree?: RunSnapshot["tree"]): RunSnapshot;
  restore(raw: unknown, tree?: RunSnapshot["tree"]): RunSnapshot;
  hydrate(snapshot: RunSnapshot): RunOutcome<T>;
  execute(
    snapshot: RunSnapshot,
    options: RunOptions,
    scope: ExecutionScope,
    evidence?: ApprovalEvidence,
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
  child<T>(key: string, agent: Agent<T>, input: string): ChildHandle<T>;
  /** Settles in caller order, not completion order. No child may outlive this barrier. */
  join<const H extends readonly ChildHandle<unknown>[]>(handles: H): Promise<Joined<H>>;
}

export interface DelegationSpec<I, O> {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
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
  readonly specialists: readonly Agent<unknown>[];
  definition(): ToolDefinition;
  /** @internal Errors and suspensions must not go through Tool.invoke's error conversion. */
  execute(raw: unknown, context: DelegationContext): Promise<ToolResult>;
}

export interface SpecialistToolOptions<T> {
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
  return defineDelegation({
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
}

/** The whole pure coordination barrier lends its parent's slot, not each join.
 * Overlapping joins therefore cannot reacquire a slot while another join still waits. */
export async function executeDelegation(
  descriptor: Delegation,
  journal: DelegationExecution,
  parent: RunSnapshot,
  raw: unknown,
  options: RunOptions,
  scope: ExecutionScope,
  signal: AbortSignal,
  active: () => void,
  evidence?: ApprovalEvidence,
): Promise<ToolResult> {
  let open = true;
  const started = new Map<string, Promise<void>>();
  const handles = new WeakSet<ChildHandle<unknown>>();

  function child<T>(key: string, agent: Agent<T>, input: string): ChildHandle<T> {
    if (!open)
      throw new Error("This delegation has ended; start children only inside its coordinator.");
    active();
    if (!isId(key) || !isId(input))
      throw new TypeError("A child needs a non-empty key and text input.");
    if (!descriptor.specialists.includes(agent))
      fail(
        "unregistered_specialist",
        "Register this specialist in the delegation before starting it.",
        journal.operationId,
      );
    const runtime = agent[AGENT_RUNTIME];
    let entry = journal.children.find((saved) => saved.key === key);
    const resume = entry !== undefined;
    if (entry) {
      if (
        entry.snapshot.agentId !== agent.id ||
        entry.snapshot.version !== agent.version ||
        entry.snapshot.input !== input
      )
        fail(
          "child_key_conflict",
          "This child key already belongs to another agent, version or input.",
          journal.operationId,
        );
    } else {
      scope.tree.reserveChild(scope.depth + 1);
      entry = {
        key,
        snapshot: runtime.create(input, childRunId(journal.operationId, key), parent.tree),
      };
      journal.children.push(entry);
    }
    const saved = entry;
    if (!started.has(key)) {
      const work = async () => {
        if (
          saved.snapshot.state.status !== "running" &&
          saved.snapshot.state.status !== "suspended"
        )
          return;
        await scope.tree.save();
        active();
        const step = { operationId: journal.operationId, key, runId: saved.snapshot.runId };
        const childEvidence =
          evidence && equalData(evidence.path[0], step)
            ? { path: evidence.path.slice(1), decision: evidence.decision }
            : undefined;
        let execution: Promise<ChildEnvelope> | undefined;
        let hookOpen = true;
        let executionSettled = false;
        const execute = () => {
          if (!hookOpen || execution)
            throw new Error("A host child may execute once, before its hook returns.");
          execution = (async () => {
            if (resume) saved.snapshot.attemptId = crypto.randomUUID();
            const result = await runtime.execute(
              saved.snapshot,
              { ...options, signal },
              { tree: scope.tree, depth: scope.depth + 1 },
              childEvidence,
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
        // Returning a cached suspended host segment cannot consume an SDK approval.
        if (!execution && childEvidence && restored.state.status === "suspended")
          fail(
            "host_resume_unsupported",
            "The host returned a cached suspension. Resume this child in a new or resumable host segment.",
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
        if (saved.snapshot.state.status === "running") {
          saved.snapshot.state =
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
      runId: saved.snapshot.runId,
      async join(): Promise<RunOutcome<T>> {
        await pending;
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

  let result: ToolResult | undefined;
  let failure: { error: unknown } | undefined;
  try {
    result = await untilAbort(descriptor.execute(raw, Object.freeze({ child, join })), signal);
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
        child(entry.key, agent, entry.snapshot.input);
      }
    } catch (error) {
      failure ??= { error };
    }
    open = false;
    const settled = await Promise.allSettled(started.values());
    const rejected = settled.find((item) => item.status === "rejected");
    if (rejected?.status === "rejected") failure = { error: rejected.reason };
  }
  active();
  if (failure && !(failure.error instanceof Halt && failure.error.state.status === "suspended"))
    throw failure.error;
  for (const entry of journal.children) {
    const state = entry.snapshot.state;
    if (state.status === "suspended") {
      throw new Halt({
        ...state,
        path: [
          { operationId: journal.operationId, key: entry.key, runId: entry.snapshot.runId },
          ...state.path,
        ],
      });
    }
  }
  if (failure) throw failure.error;
  if (!result) throw new Error("The delegation ended without a result.");
  return result;
}
