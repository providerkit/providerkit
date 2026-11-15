# @providerkit/agents

An agent calls a model, runs the tools it requests and returns an answer.
Keep its instructions, provider and tools in one place:

```ts
const result = await writer.run("Explain why a database index speeds up a search.");
```

A completed result has `status: "completed"` and an `output` value. Other results say whether the
run failed, was cancelled, reached a limit or is waiting for approval. Check the status before
using the output.

The API may change before 1.0. This package uses `@providerkit/core` for model calls. Its main
entry has no database, queue or vendor SDK dependency and sends no traces to an external service.

## Set up an agent

Install the agent package and core:

```sh
bun add @providerkit/agents @providerkit/core
```

Pass a provider you already configured with core:

```ts
import { defineAgent } from "@providerkit/agents";
import type { Provider } from "@providerkit/core";

export function createWriter(provider: Provider) {
  return defineAgent({
    id: "writer",
    version: "1",
    instructions: "Explain technical topics in short sentences.",
    provider,
  });
}
```

Set up routing, fallback models, provider deadlines and retry policy in core. The agent uses that
provider as supplied; it does not add another retry loop.

Change the agent's version when its instructions, tools or result contract change. A saved run
from another version is refused rather than resumed under different rules.

## Results and progress

```ts
const result = await writer.run("Explain database indexes.", {
  signal: controller.signal,
  onEvent(event) {
    if (event.type === "model_chunk") {
      render(event.chunk.content ?? "");
    }
  },
});

if (result.status === "completed") {
  console.log(result.output);
}
```

The same reader collects the answer and reports progress. An observer failure does not stop the
work. Tool results and provider metadata stay in the recorded history.

| Status      | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `completed` | The answer passed the configured result validator.                         |
| `suspended` | A tool needs an approval decision from the host.                           |
| `cancelled` | The caller stopped the run. Cancellation does not undo an external action. |
| `limited`   | A turn, tool-call, time or provider output limit stopped the run.          |
| `failed`    | Execution could not continue. Read `error.code` and `error.message`.       |

Reasoning without an answer is not success. A provider's length-limited answer is not accepted as
a complete result. Increase the provider's output allowance when appropriate rather than blindly
repeating a paid request.

## Tools and checked output

Pass core `Tool` instances in `tools`. Their input validation, timeouts and error outcomes remain
core's responsibility. Unmarked tools run serially. Parallel tool execution requires both the
core tool's `isConcurrencySafe` flag and the host's permission to batch it. Tools run in your
process; this package does not provide a sandbox for untrusted code.

For a checked result, supply `output.schema` and `output.validate`. The schema tells the model what
to submit; the validator checks the actual value. Return the desired TypeScript value or throw a
message explaining what to correct. The SDK reserves the `submit_result` tool name for this path.
A validator should be pure: it can run again when a completed result is restored.

## Specialists and parallel work

An orchestrator can call another configured agent as a tool:

```ts
const editor = defineAgent({
  id: "editor",
  version: "1",
  instructions: "Ask the reviewer for feedback, then write the final answer.",
  provider,
  tools: [
    reviewer.asTool({
      name: "review",
      description: "Review a draft and identify changes it needs.",
    }),
  ],
});
```

The specialist gets the explicit input sent to it, not the parent's conversation. Its result returns
to the orchestrator; this is not a conversation handoff. Each agent can use a different core provider.
`asTool` propagates a specialist's stopped outcome. Use `defineDelegation` when your code needs to
combine several explicit child outcomes.

A delegation declares its fixed `specialists` list, input schema and validator. Inside its `run`
callback, start children before joining them:

```ts
const draft = context.child("draft", writer, input);
const review = context.child("review", reviewer, input);
const [draftResult, reviewResult] = await context.join([draft, review]);
```

Children start immediately, subject to the shared limit. Joining returns outcomes in the order you
requested, not the order they finish. Check their statuses and return only what the parent needs,
not their full snapshots. A suspended child pauses the parent instead of becoming a success string.

Coordination callbacks must be pure: use `child` and `join` for work. The callback can run again
after an interruption, but completed children are reused. Reusing a child key with different input
or a different agent is refused. Every admitted child settles before the delegation ends.

## Limits and usage

Per-run defaults are 12 model turns, 32 tool calls, 5 minutes and at most 3 approved concurrent
ordinary tools. Change these through `limits` when configuring an agent.

The root's `treeLimits` apply across all descendants:

| Setting       | Default | Counts                                                                            |
| ------------- | ------- | --------------------------------------------------------------------------------- |
| `maxParallel` | 4       | Active agents, including the root. A parent waiting on children lends its slot.   |
| `maxChildren` | 32      | Children in total, not per parent.                                                |
| `maxDepth`    | 4       | Descendant levels; the root is depth 0.                                           |
| `modelCalls`  | 128     | Calls from agent loops to core. Provider-internal retries can send more requests. |
| `elapsedMs`   | 300000  | Wall time, including queueing and waiting for approval, across attempts.          |

A child's local limits still apply. Set enough time for a human decision when using approval.
Resuming does not reset the deadline or give the tree a fresh call budget.

`usage` describes the current agent's model calls. `treeUsage` includes registered descendants
without counting recorded work twice. Only model usage reported by providers is known; an
interrupted call may have cost more than its last report. Ordinary tools' external service charges
are not included. Prices and billing stay with the host, and these counters are not an exact
spending cap. Use SDK delegation rather than calling another model directly inside an ordinary
tool when that work must share the tree's limits and usage.

## Checkpoints and approval

A host can save a run through `host.checkpoint`. The SDK records each model or tool operation before
starting it and records its result afterward. Saved operation IDs remain stable across attempts.

`agent.resume(snapshot, options)` requires a trusted `host.authorizeResume` callback. The host must
load authoritative state, check its owner and prevent concurrent attempts. Valid JSON is not
permission to run a tool, and a snapshot sent by a browser is not authoritative state.

For tools marked `needsApproval`, the host supplies the actor, resource version and expiry through
`approvalContext`, authenticates and consumes the decision through `resolveApproval`, and checks
current access through `beforeTool`. Missing approval policy refuses the action. A saved approval
flag cannot bypass those checks.

A suspended result includes the `path` to the exact child call. Pass it as `approvalPath` when
resuming a descendant decision. Approving the parent does not approve its children's actions.

Completed results can be reused. An operation recorded as running has an unknown outcome after a
crash, so resume refuses to repeat it automatically. An email, payment or paid model call may have
finished before its result was saved. Reconcile that outcome or use a receiving service that
honors an idempotency key; a checkpoint alone cannot make the action happen exactly once.

Snapshots include prompts, tool arguments and results. The host owns access, storage and retention.
Progress events are not a substitute for saved execution state.

## Background runs

`@providerkit/agents/runs` binds an agent to `@gusnips/server/runs` 0.19 or later. Install that
optional peer only when using this entry. Supply your existing run service, durable queue callback
and trusted policy factory:

```ts
import { createBackgroundAgent } from "@providerkit/agents/runs";

const jobs = createBackgroundAgent({
  agent: writer,
  kind: "writer-v1",
  runs,
  enqueue,
  policy,
});

const { id } = await jobs.start(authenticatedOwner, "Write a release note.");
const saved = await jobs.wait(authenticatedOwner, id);
```

The owner must come from your authentication code, not an unchecked request field. Reads,
observation, waiting, cancellation and resume all require it. A worker calls
`runs.drive(id, jobs.handlers)`. Run `runs.sweep` on boot and periodically to queue unfinished work,
and call `runs.drain` before shutting down. See [the background example](examples/background.ts)
for these connections. A stored job without a worker and recovery sweep does not run itself.

`start` saves the input before returning an ID. If queueing fails, `BackgroundEnqueueError.id`
identifies the saved run. Requeue that ID or let the sweep find it; do not create another run.

`read` and `wait` return two statuses. `saved.status` describes the host worker run;
`saved.outcome?.status` describes the agent. A successful worker run can contain a suspended or
failed agent outcome. Read the latter before treating the answer as complete.

Pass an observer signal to `observe` or `wait` to stop listening. That does not cancel the work.
`cancel(owner, id)` cancels the whole run tree. Children execute in-process under their root's
lease; they are not independently owned distributed jobs.

### Background approval policy

The required `policy` factory receives the authoritative owner and host run ID. It provides the
same resume and tool checks described above, plus `claimContinuation`. Keep these rules in trusted
server code:

- `authorizeResume` checks stored state and ownership on every attempt.
- `approvalContext` identifies the actor, resource version and decision expiry.
- `claimContinuation` authenticates submitted evidence and atomically reserves the exact pending
  decision for one continuation and one host run. Repeating that same claim during recovery must
  succeed; a different claim or host run must fail.
- `resolveApproval` returns the decision only for that claim. `beforeTool` checks current access
  and resource version again immediately before the action.

Return database handles or other worker-only tool values through `policy.context`. They are not
serialized. Do not put secrets or handles in a saved snapshot.

`resume(owner, id, decisionEvidence)` saves a new host run with the same logical agent history.
It queues evidence, not permission. The worker claims it under its lease after the row exists;
read or wait on the returned ID to learn whether the decision was accepted. Completed child work
is retained, and old evidence cannot approve a later tool call. The host must store approval claims
durably; an in-memory boolean is not sufficient.

This binding stores token-usage receipts, not money. It does not call the run service's additive
`spend()` method or claim atomic billing with checkpoints. Account for recorded operations using
stable IDs in your own billing system.

## Development

From the repository root, run `bun install` and `bun run build`. Then, from `agents/`:

```sh
bun run lint
bun run typecheck
bunx vitest run test/lifecycle.test.ts
bunx vitest run test/delegation.test.ts
bun examples/basic.ts
bun examples/specialists.ts
```

These checks and examples use fake providers and tools. They do not call a live model or any app.
The basic example runs a model/tool round. The specialist example runs a manager with two children
and returns their notes in order. Neither needs an API key.

The background integration file needs a disposable local PostgreSQL database named
`providerkit_agents`. It creates and drops its own schema and starts worker processes that it
kills deliberately to check recovery. It refuses non-loopback database URLs:

```sh
AGENTS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/providerkit_agents \
  bunx vitest run test/runs.test.ts
```

Use a throwaway database, not an app database. These checks never call a live model.
