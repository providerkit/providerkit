import { AGENT_RUNTIME, type NodeRuntime, type Specialist } from "./delegation.ts";
import type { SubagentCreation } from "./subagents.ts";
import { readInput } from "./input.ts";
import type { ChildEnvelope, RunOptions, TreeNode } from "./types.ts";
import { checkChildProgress, checkTree, immutableCopy, isId, isRecord } from "./snapshot.ts";
import { emitEvent, fail, untilAbort, type ExecutionScope } from "./tree.ts";

/** Capture input before asynchronous admission so callers cannot change the saved identity. */
export function prepareChild(
  node: Specialist,
  input: unknown,
  subagent?: SubagentCreation,
  root?: TreeNode,
) {
  if (node.kind === "remote") {
    const start = node[AGENT_RUNTIME].prepare(input);
    return {
      input: start,
      create: (runId: string, tree: TreeNode["tree"], options: RunOptions): Promise<TreeNode> =>
        node[AGENT_RUNTIME].create(start, runId, tree, options, root),
    };
  }
  if (node.kind === "agent") {
    const start = node[AGENT_RUNTIME].freeze(readInput(input, "trusted"));
    return {
      input: start,
      create: (runId: string, tree: TreeNode["tree"], options: RunOptions): Promise<TreeNode> =>
        node[AGENT_RUNTIME].create(start, runId, tree, options, subagent),
    };
  }
  const start = immutableCopy(input);
  return {
    input: start,
    create: (runId: string, tree: TreeNode["tree"], options: RunOptions): Promise<TreeNode> =>
      node[AGENT_RUNTIME].create(start, runId, tree, options),
  };
}

/** Insert and validate without yielding, so competing coordinators cannot consume one handle.
 * A refused child must never reach a checkpoint or leave an invalid admission behind. */
export function admitChild(
  children: (ChildEnvelope & { key: string })[],
  child: ChildEnvelope & { key: string },
  scope: ExecutionScope,
): ChildEnvelope & { key: string } {
  scope.tree.reserveChild(scope.depth + 1);
  children.push(child);
  try {
    checkTree(scope.tree.root);
  } catch (error) {
    children.pop();
    throw error;
  }
  return child;
}

/** Shared leased child execution. Admission belongs to the caller's journal, never the host. */
export async function startChild(
  saved: ChildEnvelope & { key: string },
  parent: TreeNode,
  operationId: string,
  runtime: NodeRuntime,
  options: RunOptions,
  scope: ExecutionScope,
  signal: AbortSignal,
  active: () => void,
  resume: boolean,
  before?: () => void | Promise<void>,
  handoffInput?: ExecutionScope["handoffInput"],
): Promise<void> {
  if (saved.snapshot.state.status !== "running" && saved.snapshot.state.status !== "suspended")
    return;
  await scope.tree.save();
  active();
  const step = { operationId, key: saved.key, runId: saved.snapshot.runId };
  let execution: Promise<ChildEnvelope> | undefined;
  let hookOpen = true;
  let executionSettled = false;
  const execute = () => {
    if (!hookOpen || execution)
      throw new Error("A host child may execute once, before its hook returns.");
    execution = (async () => {
      await before?.();
      active();
      if (resume) saved.snapshot.attemptId = crypto.randomUUID();
      const identity =
        saved.snapshot.kind === "agent"
          ? {
              kind: "agent" as const,
              agentId: saved.snapshot.agentId,
              ...(saved.snapshot.subagent ? { subagent: true as const } : {}),
            }
          : saved.snapshot.kind === "remote"
            ? { kind: "remote" as const, agentId: saved.snapshot.agentId }
            : { kind: "workflow" as const, workflowId: saved.snapshot.workflowId };
      emitEvent(options, {
        type: "child",
        parentRunId: parent.runId,
        ...step,
        ...identity,
        version: saved.snapshot.version,
      });
      const result = await runtime.execute(
        saved.snapshot,
        { ...options, signal },
        {
          tree: scope.tree,
          depth: scope.depth + 1,
          path: [...scope.path, step],
          handoffInput,
        },
      );
      executionSettled = true;
      return { snapshot: result.snapshot };
    })();
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
                operationId,
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
        operationId,
      );
  } finally {
    hookOpen = false;
    if (execution) await execution;
  }
  active();
  if (!isRecord(envelope) || (envelope.reference !== undefined && !isId(envelope.reference)))
    fail("invalid_child_host", "The child hook must return a snapshot envelope.", operationId);
  const restored = runtime.restore(
    envelope.snapshot,
    parent.tree,
    saved.snapshot.kind === "agent" ? saved.snapshot.subagent : undefined,
  );
  checkChildProgress(saved.snapshot, restored);
  if (restored.state.status === "running")
    fail("invalid_child_host", "The child hook returned an unfinished child.", operationId);
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
}

/** A child never inherits conversation storage or its parent's resolved provider policy. Its
 * provider session stays its own run id: it has other instructions, so it shares no cached
 * prefix with its parent. */
export function childOptions(options: RunOptions): RunOptions {
  const {
    session: _session,
    historyLimit: _history,
    prepareHistory: _prepare,
    modelSettings: _settings,
    enabledTools: _tools,
    providerSessionId: _providerSession,
    ...inherited
  } = options;
  return inherited;
}
