# Third-party notices

Parts of `@providerkit/agents` are adapted from the open source projects below. Each adapted
block has a short comment that names its source. Their copyright notices and licenses follow.

## TanStack AI

- Source: [TanStack/ai](https://github.com/TanStack/ai/tree/1888233ddb501d14b17aa9a5f3497373a0e9242e),
  `packages/ai-harness/src/inline-media.ts`, `packages/ai-harness/src/media.ts`,
  `packages/ai-harness/src/handoff.ts`, `packages/ai-harness/src/log-records.ts`,
  `packages/ai-harness/src/log.ts`,
  `packages/ai-harness/src/session/turn-parts.ts` (`steering` and `joinSteers`) and
  `packages/ai/src/interrupt-serialization.ts`, `packages/ai/src/utilities/tool-result.ts`
  and `packages/ai-compaction/src/index.ts` (`evictOldest`, `summarizeOldest` and checkpoint reuse),
  plus `packages/ai-harness/src/first-party/agents.ts` (`allowedTools` and child continuation),
  `packages/ai-memory/src/internal/store.ts` (`sameScope`, `lexicalOverlap`, `defaultRenderMemory`)
  and `packages/ai-memory/src/testkit/contract.ts`.
- Used in: `src/memory.ts`, `src/memory-store.ts` and `test/memory.test.ts`, exact scope matching,
  word ranking, JSON-quoted memory and the disposable store contract check. Changed: all four
  scope dimensions match exactly; empty labels are refused; words support Unicode and accent
  folding. Version checks and erasure generations are atomic. Ingestion is explicit and commits
  a receipt with its writes. Recall is journaled user data, never system instructions.
- Used in: `src/subagents.ts`, limiting helper tools to the creator's available tools.
  Changed: exact tool object identity replaces glob matching. Grants and host configuration
  live in child snapshots instead of an in-memory tool map; hidden tools cannot be invoked.
  Follow-ups keep an admitted helper's history and provider session identity. Changed: an opaque
  stored id is scoped to one creator and root. Each turn is a journaled child; unfinished work,
  changed grants and concurrent follow-ups to one helper are refused.
- Used in: `src/compaction.ts` and `src/run.ts`, a saved model-only view separate from the full
  transcript, usage plus new-message estimates and checkpoint-before-apply.
  Changed: core owns the cut and tool pairing; unread steers stay verbatim. Summary calls use
  the existing model guards, admissions and usage receipts, and interrupted summaries never
  replay automatically. `test/compaction.test.ts` checks session identity, pairing and recovery.
- Used in: `src/extensions.ts`, detection and normalization of rich tool content arrays.
  Changed: core's outcome, text and image types are reused; files and references are refused.
  JSON output stays in the private receipt; model history uses the tool's text summary and images.
  `test/extensions.test.ts` checks real model/tool turns, limits, sessions and resume.
- Used in: `src/progress.ts`, adjacent delta folding, timed batching and a single writer.
  Changed: only compatible text or reasoning folds, never tool calls. Buffers have count and
  byte limits. Unknown writes are not replayed; a new persisted gap record is required before
  execution continues. The host owns sequence numbers and uncertain-write reconciliation.
  `test/progress.test.ts` checks fold equivalence, barriers, bounds and failures.
- Used in: `src/steering.ts`, joining queued user messages before a model call, in order,
  committing them before removing them from pending delivery, and excluding delegated children.
  Changed: a bounded host inbox supplies immutable ids; the existing execution journal records
  positions before idempotent acknowledgement. A completed model receipt confirms consumption.
  Unconsumed messages stay with the host, with no automatic follow-up run. `src/input.ts` folds
  these positions between whole tool rounds; `test/steering.test.ts` checks admission and recovery.
- Used in: `src/handoff.ts`, a transfer notice appended after existing history, fixed-target
  guards and the active-agent fold. `test/handoff.test.ts` carries the transfer, self-target,
  conflict and resume cases. Changed: every transfer is a journaled child with shared budgets;
  only a root's own handoff chain changes its conversation owner, and notes use JSON quoting.
- Used in: `src/request.ts`, canonical JSON ordering for request definition hashes. Our JSON
  validator checks values first; Web Crypto supplies SHA-256 instead of a copied hash function.
- Used in: `src/snapshot.ts`, the base64 check and the byte count read from its length;
  `src/input.ts` and `src/run.ts`, a media reference swapped for its bytes only in the provider
  request, loaded once per id per run.
- Changed: whitespace is refused and padding is required, because the text goes to the provider
  as given. A missing file fails the run instead of becoming a text note.

```text
MIT License

Copyright (c) 2025 Tanner Linsley

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OpenAI Agents JS

- Source: [openai/openai-agents-js](https://github.com/openai/openai-agents-js/tree/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f),
  `packages/agents-core/src/memory/memorySession.ts`, `packages/agents-core/src/agent.ts`,
  `packages/agents-core/src/tool.ts`, `packages/agents-core/src/runner/modelSettings.ts`,
  `packages/agents-core/src/runner/toolExecution.ts`, `packages/agents-core/src/handoff.ts`,
  `packages/agents-core/src/extensions/handoffFilters.ts`, `packages/agents-core/src/runState.ts`,
  `packages/agents-core/src/result.ts`, `packages/agents-core/src/runner/turnResolution.ts`,
  `packages/agents-core/src/guardrail.ts` and `packages/agents-core/src/testing/scriptedModel.ts`.
- Used in: `src/evals/testing.ts`, a finite scripted provider for offline evaluation. Changed:
  core chunks replace vendor messages; tool calls and usage use core's portable public contract.
- Used in: `src/types.ts`, `src/extensions.ts` and `src/run.ts`, explicit input/output verdicts
  and blocking checks before tool dispatch from `guardrail.ts` and `runner/toolExecution.ts`.
  Changed: checks always block, cannot waive host authorization and have recorded identities
  and verdicts. Guarded model output is bounded and withheld before disclosure. Rejected checks
  stop rather than retry effects; interrupted guards require host reconciliation.
- Used in: `src/handoff.ts`, the history-filter context, removal of tools and reasoning, and the
  duplicate-agent identity check. Changed: assistant text survives without its private fields;
  target identity is saved before approval. `test/handoff.test.ts` checks history filtering,
  next-turn routing, interrupted transfer reuse and cancellation before admission.
- Used in: `src/run.ts`, `src/types.ts` and `src/handoff.ts`, handoff output union inference from
  `agent.ts` (`HandoffsOutputUnion`, `Agent.create`) and active-agent validation from `result.ts`
  (`finalOutput`) and `runner/turnResolution.ts` (`processFinalOutput`). Changed: infer from the
  registered tools, without casts; restore the owning child's runtime instead of swapping the
  source's agent pointer. Raw candidates stay in the existing child journal. Only the target
  validates its output, never the source's different schema. `test/structured-handoff.test.ts`
  checks distinct schemas, transformed values, validation failure, resume and public inference.
- Used in: `src/session.ts`, `createMemorySession`: a run id that already appended the same turn
  succeeds without writing it again, and the same run id with another turn fails.
- Used in: `src/types.ts` and `src/run.ts`, dynamic instructions, enabled tools, resetting a
  forced tool choice after tool use, and selecting a tool result as the final answer.
- Changed: instructions and enabled tools resolve once at creation, are saved in the journal,
  and never resolve again on resume. The run's tool selection may only narrow the agent's.
  Only successful, validated stopping-tool results finish a run, after all calls settle; the
  selected raw candidate is saved so restoring cannot repeat an effect.

```text
MIT License

Copyright (c) 2025 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## PydanticAI

- Source: [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai/tree/f93bcff0c72caa0d5b0e2ead8b550d9674c8c9c4),
  `pydantic_ai_slim/pydantic_ai/conversation_store.py` and
  `pydantic_ai_slim/pydantic_ai/settings.py`,
  `pydantic_ai_slim/pydantic_ai/tool_manager.py` (`_check_max_retries`),
  `src/pydantic_ai_harness/pydantic_ai_harness/ask_user/_types.py`,
  `pydantic_evals/pydantic_evals/evaluators/agentic.py` and
  `pydantic_evals/pydantic_evals/evaluators/llm_as_a_judge.py`.
- Used in: `src/evals/trajectory.ts`, `scorers.ts` and `judge.ts`, trajectory/argument matching
  and explicit model judging. Changed: journals replace spans, matching includes child work,
  reasons omit private values by default, and judges require explicit bounded execution.
- Used in: `src/tool-retry.ts`, `src/types.ts` and `src/run.ts`, per-tool attempt ceilings.
  Changed: default zero retries, with exact operation receipts rather than model-directed
  permission. Read-only calls require explicit policy and current host authorization; writes
  require authoritative not-run reconciliation. Requests and control tools cannot gain a replay
  path. `test/tool-retry.test.ts` checks budgets, saved failures and unsafe retry refusals.
- Used in: `src/request.ts`, answer checks for offered choices, repeated selections, blank text
  and cancellation. Changed to our keyed requests and host-authorized decisions.
- Used in: `src/session.ts`, `createMemorySession`: the revision check on every append, and a
  copy on every read and write.
- Used in: `src/run.ts`, merging model settings with the run's values preferred over the
  agent's. Provider defaults stay in core; `undefined` fields inherit.

```text
The MIT License (MIT)

Copyright (c) Pydantic Services Inc. 2024 to present

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## PydanticAI Harness and Vstorm

- Sources: [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai),
  `src/pydantic_ai_harness/pydantic_ai_harness/sub_agents/_toolset.py` (`create_agent`,
  `_build_created` and replay reconstruction), `_control.py` (`DynamicAgentSpec`, name validation
  and the tool-free default), and `tests/harness/sub_agents/test_task_control.py` and
  `test_dbos.py`, and `src/pydantic_ai_harness/pydantic_ai_harness/memory/_capability.py`
  (user-role memory snapshots and `_neutralize`).
- Used in: `src/memory.ts`, keeping recalled data out of system instructions and neutralizing
  stored framing tags. Changed: every `<` is escaped inside JSON text. One bounded recall lives
  in the run journal and is reattached to the model view after compaction, not to session history.
- Used in: `src/subagents.ts` and `test/subagents.test.ts`, names, model menus, bounded creation
  and rebuilding from saved definitions without asking the model again. Changed: versioned
  host templates run through providerkit's existing child journal, guards and limits. Names are
  private; positional keys identify children. Host policy can narrow grants, never add authority.
- PydanticAI Harness's `THIRD_PARTY_NOTICES.md` identifies dynamic agents as a port of
  [vstorm-co/subagents-pydantic-ai](https://github.com/vstorm-co/subagents-pydantic-ai).
  Both notices are retained below.

```text
The MIT License (MIT)

Copyright (c) 2026 Pydantic Services Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```text
MIT License

Copyright (c) 2026 Vstorm

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Microsoft Agent Framework

- Source: [microsoft/agent-framework](https://github.com/microsoft/agent-framework),
  `python/packages/core/agent_framework/_tools.py`, `_reset_required_tool_choice` and the
  final tool-free call after the iteration allowance.
- Used in: `src/run.ts`, resetting a forced choice and requesting one final answer with no
  tools after the local turn limit.
- Changed: the final call still counts against the tree's model-call and time budgets. It
  cannot execute tools even if the provider returns them. Checked-output agents skip it,
  because they need the reserved result tool to finish.

```text
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
```

## LangGraph.js

- Source: [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs),
  `libs/langgraph-core/src/interrupt.ts`.
- Used in: `src/delegation.ts`, returning a saved answer when pure coordination replays and
  validating it before returning to the coordinator.
- Changed: stable question keys replace positional matching. Requests and decisions stay in
  the existing effect journal, and host authorization is required before accepting an answer.

```text
The MIT License

Copyright (c) 2024 LangChain

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Google ADK

Copyright 2026 Google LLC. Licensed under Apache 2.0; the full license is included as
`LICENSE-APACHE-2.0`.

- Sources: [google/adk-python](https://github.com/google/adk-python),
  `src/google/adk/evaluation/_multi_run_aggregation_methods.py` and
  `src/google/adk/evaluation/simulation/llm_backed_user_simulator_prompts.py`;
  [google/adk-js](https://github.com/google/adk-js), `core/src/cli/cli_eval.ts`.
- Used in: `src/evals/report.ts`, `scorers.ts`, `simulation.ts` and `driver.ts`, multi-run
  aggregation, ROUGE-1, bounded user simulation and mock matching. Changed: products replace
  combinations, excluded outcomes remain counted, words use Unicode segmentation, simulation
  requires explicit provider consent, and mocks never fall through to real tool execution.

## Mastra

Copyright (c) 2025 Kepler Software, Inc. Licensed under Apache 2.0; the full license is included
as `LICENSE-APACHE-2.0`. No code from `ee/` is used.

- Source: [mastra-ai/mastra](https://github.com/mastra-ai/mastra),
  `packages/core/src/evals/not-scorable.ts`, `packages/core/src/evals/hooks.ts`
  and `packages/core/src/agent-controller/tools.ts` (forked helper history).
- Used in: `src/subagents.ts` and `test/subagents.test.ts`, a fork starts a child from earlier
  conversation. Changed: task-only is the default. A bounded host filter selects sanitized
  messages, and the journal saves their exact bytes before execution. Source system prompts,
  tool rounds and private reasoning do not cross this boundary; approvals are never disabled.
- Used in: `src/evals/types.ts` and `runner.ts`, cross-copy skip branding and deterministic
  six-byte SHA-256 sampling. Changed: skips require a reason, the brand is providerkit's, hashing
  uses Web Crypto, and scoring has no automatic hook wiring or telemetry.

## Vercel AI SDK

- The full Apache 2.0 license is included as `LICENSE-APACHE-2.0`.
- Source: [vercel/ai](https://github.com/vercel/ai/tree/8ba3940d3dd1f3cd3c4365bbaec505c6ef0eb1e3),
  `packages/ai/src/prompt/convert-to-language-model-prompt.ts` and
  `packages/workflow/src/do-stream-step.ts` and
  `packages/ai/src/agent/tool-loop-agent-settings.ts`.
- Used in: `src/extensions.ts`, `src/types.ts` and `src/run.ts`, lifecycle boundaries around
  runs, model calls and tool execution. Changed: callbacks are ordered, cancellable observers,
  separate from guards and host permission checks. Raw inspection is distinct from guarded
  progress, and callback failures do not grant or deny work.
- Used in: `src/run.ts`, the restart marker before replacement model output.
- Changed: restart is opt-in for inference-only and trusted read-only work, retains every
  attempt's measured usage, and names the stable operation plus old and new attempts. It does
  not reset an entire workflow step or promise durable partial output.
- Used in: `test/input.test.ts`, the check that a request never reaches a user turn, or its end,
  while a tool call is unanswered. This test is not in the published package.
- Changed: it returns the unanswered ids instead of throwing, and it also reports a tool result
  that answers no call.

```text
Copyright 2023 Vercel, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
