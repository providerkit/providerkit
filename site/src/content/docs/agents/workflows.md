---
title: Workflows
description: Coordinate saved steps with ordinary async code, without a graph builder or a new scheduler.
---

A workflow accepts input and returns a checked result:

```ts
const result = await totals.run({ count: 2 }); // Completed output: 4.
```

Here is the complete pure workflow:

```ts
import { defineWorkflow } from "@providerkit/agents/workflow";

const totals = defineWorkflow({
  id: "totals",
  version: "1",
  input: {
    schema: {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    },
    validate(value) {
      if (
        !value ||
        typeof value !== "object" ||
        !("count" in value) ||
        typeof value.count !== "number"
      )
        throw new TypeError("Provide a numeric count.");
      return { count: value.count };
    },
  },
  async run({ count }) {
    return count * 2;
  },
});
```

The coordinator is an ordinary async function. On resume, it runs again and completed step
results are reused from the journal. Keep external effects inside steps, not in coordinator code.

## Use explicit step keys

`context.step` records an operation under a key. Keys must be unique and stable for that workflow
version. Duplicate keys or incompatible replay order are refused. Input and completed results
are copied as data; returning a mutable object does not grant later code permission to change a
saved result.

Use `context.agent` for a registered local or remote agent and `context.workflow` for another
workflow. They use the same child executor and tree limits as delegation, not a second runtime.
A workflow node has steps and a workflow ID, not a made-up model journal.

## Authorize effects

Declare every value an effect uses in its step's `options.input`. Runs with effects, children or
answers require the host's `beforeStep` check for current ownership and any execution lease. If
an approval edits input, authorization checks the edited value. A completed step is reused; an interrupted
write is not rerun simply because its key is the same.

Retries need an explicit read-only assertion or authoritative reconciliation. Your host owns
idempotence at the service that actually performs the action. See [recovery](/agents/recovery/).

## Pause without keeping a worker asleep

`context.ask` creates a real request. `context.sleep` records a wake time and returns control to
the host. Your existing queue schedules a later continuation; the SDK adds no scheduler. A saved
wake time or browser timer cannot authorize execution.

Run the [offline workflow example](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/workflow.ts)
for questions, effects and suspension. See the [`defineWorkflow` reference](/reference/agents/workflow/functions/defineworkflow/) for the types and [background runs](/agents/background-runs/) for host setup.
