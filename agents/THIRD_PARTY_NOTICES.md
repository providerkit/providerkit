# Third-party notices

Parts of `@providerkit/agents` are adapted from the open source projects below. Each adapted
block has a short comment that names its source. Their copyright notices and licenses follow.

## TanStack AI

- Source: [TanStack/ai](https://github.com/TanStack/ai/tree/1888233ddb501d14b17aa9a5f3497373a0e9242e),
  `packages/ai-harness/src/inline-media.ts`, `packages/ai-harness/src/media.ts`,
  `packages/ai-harness/src/handoff.ts`, `packages/ai-harness/src/log-records.ts`,
  `packages/ai-harness/src/log.ts`,
  `packages/ai-harness/src/session/turn-parts.ts` (`steering` and `joinSteers`) and
  `packages/ai/src/interrupt-serialization.ts`.
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
  `packages/agents-core/src/extensions/handoffFilters.ts` and `packages/agents-core/src/runState.ts`.
- Used in: `src/handoff.ts`, the history-filter context, removal of tools and reasoning, and the
  duplicate-agent identity check. Changed: assistant text survives without its private fields;
  target identity is saved before approval; checked output is not supported across handoffs.
  `test/handoff.test.ts` checks history filtering, next-turn routing, interrupted transfer reuse
  and cancellation before admission.
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
  `pydantic_ai_slim/pydantic_ai/settings.py`, and
  `src/pydantic_ai_harness/pydantic_ai_harness/ask_user/_types.py`.
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

## Vercel AI SDK

- Source: [vercel/ai](https://github.com/vercel/ai/tree/8ba3940d3dd1f3cd3c4365bbaec505c6ef0eb1e3),
  `packages/ai/src/prompt/convert-to-language-model-prompt.ts` and
  `packages/workflow/src/do-stream-step.ts`.
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
