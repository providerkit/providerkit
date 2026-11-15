# Agent framework references

Research for a provider-independent agent layer above `@providerkit/core`.
An orchestrator is an agent that gives work to specialists and combines their results.
A specialist is an agent with a specific task, its own instructions and a limited set of tools.

This is a source comparison and a proposal, not an implemented SDK or a release decision.
Source was reviewed on 2026-11-15 at the commits linked below. These are repository snapshots,
not a claim that every feature is in a published package. No reference code, install scripts,
tests or builds were run.

## Local references

Each directory is a shallow, single-branch clone without tags. Cloned repositories are ignored
by this repo's Git rules. Keep them as reading material, not dependencies or vendored source.
The repository links pin the commits used for the comparison.

| Reference                              | Local directory                | License                                                 | What to study                                                               |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Claude Agent SDK][claude]             | `claude-agent-sdk-typescript/` | Commercial terms                                        | Child context, permissions, task identity and completion events             |
| [OpenAI Agents JS][openai]             | `openai-agents-js/`            | MIT                                                     | Agent-as-tool, handoffs, nested approvals and run state                     |
| [Google ADK JS][adk-js]                | `google-adk-js/`               | Apache-2.0                                              | Workflow routing, parallel children and event-based resumption              |
| [Google ADK Python][adk-python]        | `google-adk-python/`           | Apache-2.0                                              | Child progress tracking and differences from the TS implementation          |
| [TanStack AI][tanstack]                | `tanstack-ai/`                 | MIT                                                     | Subagents, execution logs, ownership and a background worker                |
| [LangGraph.js][langgraph]              | `langgraphjs/`                 | MIT                                                     | Checkpoint boundaries, interruptions and replay                             |
| [Mastra][mastra]                       | `mastra/`                      | Apache-2.0 outside separately licensed `ee` directories | Background task records, leases and recovery policies                       |
| [Vercel AI SDK][vercel]                | `vercel-ai/`                   | Apache-2.0                                              | Small agent loops, specialist tools and a separate workflow integration     |
| [Microsoft Agent Framework][microsoft] | `microsoft-agent-framework/`   | MIT                                                     | Fan-out/join and saved pending approvals; selected Python code reviewed     |
| [CrewAI][crewai]                       | `crewai/`                      | MIT                                                     | Manager delegation, execution checkpoints and persisted feedback            |
| [PydanticAI][pydantic]                 | `pydantic-ai/`                 | MIT                                                     | Typed results, deferred tools, child budgets and durable backend boundaries |

Google ADK is the relevant Google agent framework, rather than the lower-level Gemini API SDK.
Both language implementations are included because similarly named APIs do not always behave alike.
Microsoft's current Agent Framework is included instead of adding another older Microsoft stack.

Claude's repository is not an engine-source donor: it contains documentation, release notes and
session-store examples, not the runtime implementation. Its [license][claude-license] is not MIT.
Use its documented behavior as a reference, not as permission to copy its code. The other license
labels describe the inspected top-level licenses, not an audit of every dependency or component.
Preserve required notices if any permissively licensed implementation is reused.

## What the comparison changes

### Delegation and handoff are different

A parent calling a specialist should receive a result and continue its own work. A handoff instead
changes which agent owns the conversation. OpenAI implements both; [its nested agent tool][openai-tool]
is the closer match for an orchestrator. Conversation handoff should remain a separate operation.

A child having its own history does not isolate its permissions, application objects or process.
Give each child explicit input and tools. The host must still authorize every action.

### Background work needs an executor, not just saved messages

There are three separate capabilities:

1. Concurrent execution: several agents run while the current process is alive.
2. Saved conversation: messages can be loaded for a later turn.
3. Recoverable execution: saved work can be claimed and resumed after the process dies.

TanStack's current source includes all three in separate layers. Its [subagent definitions][tanstack-agents]
are in `ai`; persistence is separate; `ai-harness` adds [ownership][tanstack-ownership],
[recovery workers][tanstack-worker] and background children. A production store must implement
atomic writes that reject an expired owner's updates. The in-memory store does not survive a restart.
This is the most directly relevant TypeScript reference for the full requested lifecycle, not a
claim that it has been tested with providerkit.

Other useful boundaries:

- Google ADK's new Workflow API reconstructs execution from saved events. The legacy sequence,
  parallel and loop classes are deprecated at the inspected commits. Dynamic children are not
  covered by the static graph concurrency limit. [TS source][adk-workflow].
- LangGraph persists execution checkpoints, but [interrupt resume][langgraph-interrupt] re-enters
  task code. It does not restore a JavaScript stack at the paused instruction.
- Mastra has real background task records and recovery. Its [durable-agent checkpoint policy][mastra-durable]
  is configurable; `startAsync` alone is not a crash-recovery guarantee. A durable parent does not
  automatically checkpoint each operation inside an ordinary delegated child.
- Vercel separates its in-memory loop from [WorkflowAgent][vercel-workflow], which depends on an
  external workflow runtime and explicit durable step functions.
- Microsoft's inspected [background-agent implementation][microsoft-background] is in-process;
  its recoverable workflow checkpoints are a different facility.
- CrewAI distinguishes [execution checkpoints][crewai-checkpoints] from saved application state.
  Restoring state alone does not prove completed work will be skipped.
- PydanticAI separates [typed agent composition][pydantic-composition] from durable backends.
  Usage shared in memory does not automatically return across a remote activity boundary.

These are source-backed contracts, not measured restart guarantees. Store implementations, worker
operations and external workflow services were not exercised.

### Replaying a result is not the same as repeating an action

A checkpoint can remember a finished result. It cannot undo an email, a payment or a paid model
request that completed just before the worker died. [TanStack's durable tools][tanstack-durable-tool]
state this boundary explicitly and supply stable idempotency keys: identifiers a receiving service
can use to reject a duplicate action.

A new layer must preserve providerkit's retry and no-replay rules. A job retry must not silently
turn an interrupted write or paid audio request into a second purchase. Unknown outcomes need
reconciliation or an explicit failure, not a promise of exactly-once execution.

## Recommended direction

Build the shared API by extracting repeated agent behavior, not by copying a whole framework.
Keep three responsibilities separate:

| Layer                         | Owns                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@providerkit/core`           | Provider calls, failure classification, retry/fallback rules, streams, usage, tool primitives and history repair |
| Shared agent layer            | Model/tool loop, specialist definitions, delegation, validated results, child lifecycle and execution limits     |
| Host execution and app policy | Persistent jobs, worker ownership, approvals, tenant authorization, billing and data retention                   |

Use an existing durable-run service where one is already available. Do not build another scheduler
or database abstraction to obtain subagents. TanStack's harness is the strongest alternative to
compare against that service before committing to a new execution backend.

Keep `@providerkit/core` below the agent loop. The chosen direction is a separate agent package
above core, not a new core entry point or a split of its current capabilities. The agent package
must use public core exports without duplicating provider adapters.

### First shared slice

| Capability                   | Required behavior                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable agent definition    | Instructions, a provider, allowed tools, validated input/output and finite execution limits                                              |
| Orchestrator and specialists | A parent delegates to registered specialists and receives typed results. No unrestricted creation of new agents or tools                 |
| Parallel children            | Bounded admission, explicit join and failure policy, separate child histories and stable result ordering                                 |
| Background runs              | Start returns a stored run ID; the host can observe, wait, cancel or resume it without holding an HTTP request open                      |
| Human approval               | Persist a pending decision tied to the exact call and arguments. Resume only after the host authenticates and authorizes the answer      |
| Shared limits                | Bound total children, depth, active children, model turns and elapsed time across the tree. Carry child usage back to the root           |
| Progress and diagnosis       | Stable run, parent, attempt and tool-call IDs; streamed progress; terminal outcomes; opt-in tracing with no default external data export |
| Context control              | Explicit child input and a small parent-facing result. Preserve tool/result pairs and provider reasoning metadata when storing history   |

The default programming model should be ordinary functions, not a required graph builder.
Specialists can choose different providers while using the same message and tool contracts.

Important semantics to settle before implementing that table:

- Distinguish a task's stable identity from each execution attempt. Persist definition versions
  and data, not closures or database handles.
- Separate disconnecting an observer from cancelling work. Define which children stop with their
  parent and which the host has explicitly accepted as independent jobs.
- A cancelled or timed-out tool may still finish an external effect. Cancellation is cooperative,
  not rollback or a sandbox. Child tools cannot gain authority merely because a model delegated work.
- Respect providerkit's `isConcurrencySafe` flag. Unmarked tools run serially. A provider connection
  gate is not a global child-run limit, and a waiting parent must not occupy the only child slot.
- Aggregate usage once per recorded operation. Counts of completed calls are not hard spending
  caps: parallel work needs admission reservations, and billed usage can arrive after a limit is hit.
  Prices remain caller-supplied. Do not claim an exact monetary ceiling without that accounting.
- Approval is an explicit decision, not an LLM's interpretation of feedback. Recheck permissions
  on resume and reject duplicate or stale answers.
- Persist pending children and approvals as execution state, separately from chat messages.
  A saved transcript, reconnectable stream or trace is not an execution journal.
- Choose one owner for each retry. Re-entering a job must reuse completed child results and must
  not stack a second automatic retry policy over providerkit's paid-call protections.

### Add only when an adopter needs it

MCP tool adapters, scheduled runs, artifacts, richer handoffs and evaluation hooks are useful
extensions. Add them at the existing tool, worker or event boundaries. Keep application-specific
memory, retrieval, prompts and sandboxed code execution outside the initial shared layer.
Do not introduce a vector database, graph DSL, cross-agent chat bus, A2A protocol or visual workflow
editor just because another framework has one.

### Next implementation step

Build, validate and release the standalone agent package before integrating an app. Existing app
code is a behavior reference, not a migration target during SDK development. Verify the public
package and examples without requiring a private app checkout. Evaluate each later adoption as a
separate task that removes duplicated mechanisms rather than wrapping an unchanged old loop.

Leave one small runnable lifecycle check with that first implementation. It should cover two bounded
children, cancellation, an approval resumed with the same call ID and a host restart that reuses a
completed child's recorded result. Use fake providers and a deduplicated test action. Explicitly test
the interrupted-action case rather than claiming a checkpoint prevents every duplicate.

No SDK, production migration or deployment is part of this research.

[claude]: https://github.com/anthropics/claude-agent-sdk-typescript/tree/7befb6ff11dc33172a6db25b890b90a39889f311
[openai]: https://github.com/openai/openai-agents-js/tree/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f
[adk-js]: https://github.com/google/adk-js/tree/a662b30976d68625a7348f3139bb41806aad7818
[adk-python]: https://github.com/google/adk-python/tree/d05e482038bdbb226c3a1179550cf83bd8fcbefb
[tanstack]: https://github.com/TanStack/ai/tree/1888233ddb501d14b17aa9a5f3497373a0e9242e
[langgraph]: https://github.com/langchain-ai/langgraphjs/tree/fa426b293b6ecccbf62b4f262475777b4bf86673
[mastra]: https://github.com/mastra-ai/mastra/tree/1072f7c6268db5fb515460fdcdda173592bce450
[vercel]: https://github.com/vercel/ai/tree/8ba3940d3dd1f3cd3c4365bbaec505c6ef0eb1e3
[microsoft]: https://github.com/microsoft/agent-framework/tree/92838b60498395142cb8b74693353163e95a0faf
[crewai]: https://github.com/crewAIInc/crewAI/tree/36f28c018af8db02f9134b5e75f1fc42fee85d3f
[pydantic]: https://github.com/pydantic/pydantic-ai/tree/f93bcff0c72caa0d5b0e2ead8b550d9674c8c9c4
[claude-license]: https://github.com/anthropics/claude-agent-sdk-typescript/blob/7befb6ff11dc33172a6db25b890b90a39889f311/LICENSE.md#L1
[openai-tool]: https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/packages/agents-core/src/agent.ts#L753-L784
[tanstack-agents]: https://github.com/TanStack/ai/blob/1888233ddb501d14b17aa9a5f3497373a0e9242e/packages/ai/src/activities/chat/agents/define-agent.ts#L104-L146
[tanstack-ownership]: https://github.com/TanStack/ai/blob/1888233ddb501d14b17aa9a5f3497373a0e9242e/packages/ai-harness/src/ownership.ts#L185-L199
[tanstack-worker]: https://github.com/TanStack/ai/blob/1888233ddb501d14b17aa9a5f3497373a0e9242e/packages/ai-harness/src/harness-worker.ts#L98-L184
[tanstack-durable-tool]: https://github.com/TanStack/ai/blob/1888233ddb501d14b17aa9a5f3497373a0e9242e/packages/ai-harness/src/durable-tool.ts#L42-L78
[adk-workflow]: https://github.com/google/adk-js/blob/a662b30976d68625a7348f3139bb41806aad7818/core/src/workflow/workflow.ts#L135-L170
[langgraph-interrupt]: https://github.com/langchain-ai/langgraphjs/blob/fa426b293b6ecccbf62b4f262475777b4bf86673/libs/langgraph-core/src/interrupt.ts#L107-L163
[mastra-durable]: https://github.com/mastra-ai/mastra/blob/1072f7c6268db5fb515460fdcdda173592bce450/packages/core/src/agent/durable/durable-agent.ts#L2584-L2612
[vercel-workflow]: https://github.com/vercel/ai/blob/8ba3940d3dd1f3cd3c4365bbaec505c6ef0eb1e3/content/docs/03-agents/07-workflow-agent.mdx
[microsoft-background]: https://github.com/microsoft/agent-framework/blob/92838b60498395142cb8b74693353163e95a0faf/python/packages/core/agent_framework/_harness/_background_agents.py#L431-L435
[crewai-checkpoints]: https://github.com/crewAIInc/crewAI/blob/36f28c018af8db02f9134b5e75f1fc42fee85d3f/lib/crewai/src/crewai/state/checkpoint_config.py#L160-L194
[pydantic-composition]: https://github.com/pydantic/pydantic-ai/blob/f93bcff0c72caa0d5b0e2ead8b550d9674c8c9c4/docs/multi-agent-applications.md#L17-L58
