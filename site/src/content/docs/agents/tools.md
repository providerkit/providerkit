---
title: Tools and guards
description: Register tools, validate results and reject work before an external effect.
---

Run the offline guard example:

```sh
bun node_modules/@providerkit/agents/examples/guardrails.ts
```

It exercises real SDK guards without a model request. [Read the complete source](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/guardrails.ts).

## Register the capabilities you allow

Agents uses Core `Tool` objects. Define input validation, a timeout and the operation in the tool;
the SDK records its attempts and outcomes. A failing tool returns data the model can use to
correct its next call. A caller's abort remains cancellation, not a retryable tool failure.

The registered catalog is the ceiling. Per-run `enabledTools` may remove capabilities, not add
unregistered ones. Instructions, selected tools and model settings are resolved once and saved.
Model-written instructions cannot grant a tool.

Unmarked tools run serially. Parallel execution needs both `isConcurrencySafe` on the tool and
permission from the host. `isReadOnly` is a claim you make about the real implementation, not a
promise inferred from its name.

## Make the model call one tool first

```ts
const assistant = defineAgent({ ...config, modelSettings: { toolChoice: { name: "route" } } });
```

Every turn must call `route` until one call of it succeeds. A failed or denied call, or a call to
another tool, forces `route` again on the next turn, up to the turn limit. After that the model
chooses its tools. `"required"` asks for any tool and lets the model answer once a turn has
called one.

## Refuse or cancel a call

```ts
await agent.run(task, {
  host: {
    screenCall(call, { earlier }) {
      const planned = earlier.some((done) => done.name === "plan" && done.result?.ok);
      if (call.call.name === "click" && !planned)
        return { refuse: "Blocked: no plan has been posted yet. Call the plan tool first." };
    },
  },
});
```

`screenCall` runs right before each call would start. `{ refuse }` answers that call with your
text: the model reads it as the call's result, the tool does not run and nobody is asked.
`{ cancel }` answers that call and every call after it in its turn, for example after a failed
click. A cancel is saved with the call's result, so it still holds after a restart. `earlier`
lists the run's earlier calls with their results, in the order they ran, so a policy can count
them. Calls batched together share an allowance. A refused or cancelled call does not count as a
tool call, inside a code program too.

A call that needs approval is screened before its approval opens, and again before it runs,
once the calls ahead of it ran. So a failed click still cancels an approved click behind it.

Models often send a plan with its first step in one turn. `runFirst: ["plan"]` runs plan calls
before the rest of their turn, and the rest waits for their results, so `screenCall` sees the
plan before it decides about the step. Results keep the model's order.

## End only on a stopping tool

```ts
const browser = defineAgent({
  ...config,
  stopAtTools: ["done"],
  stopOnlyAtTools: { nudge: "Respond with a tool call, not plain text. Call done when finished." },
});
```

A turn that writes text and calls no tool no longer ends the run: the model reads the nudge and
keeps working. A question written as text pauses nothing, so this keeps the model on its tools.
`done` may share its turn with other calls. Once it succeeds, the calls after it get a result
that says they did not run. When `done` comes back with an empty summary, the turn's text is the
answer. A turn cut by the output limit ends the run with `limited: outputTokens`, and the turn
limit is a hard cap, unless the agent sets `finish` (below). A run that turns off every stopping
tool, with `enabledTools` or `toolChoice: "none"`, throws before it starts.

## Finish a run that hits a limit or gets cut off

```ts
const analyst = defineAgent({ ...config, output, limits: { turns: 8 }, finish: {} });
```

With `finish`, a run that would end without its answer gets one more model call, its finish turn.
It comes when the run reaches its turn, tool-call or own cost limit, when the output limit cut a
turn off, or when a checked-output agent answered in text instead of calling `submit_result`. The
model reads a short note that says why. A text agent answers with no tools. Any other agent is
made to call its stopping tool, at effort `none` so its whole output budget goes to the answer,
and only that call runs. None of a cut turn's calls run.

A saved run completes with `salvaged` naming what would have ended it. When the finish turn
cannot save it, the run ends as it would have. The finish turn is priced and counted like any
other call, so past `costUsd` the cost limit is soft by that one call. Time limits, the tree's
limits and a Stop stay hard.

`finish.emptyTurns` lets a few turns in a row come back with no text and no tool call before the
run fails with `empty_output`. `finish.nearEnd` is a note the model reads with its last turn that
has tools, so it can wrap up while it still can.

## Check output

`output.schema` tells the model what result to submit. `output.validate` checks the actual value
and returns your typed result or throws a correction message. The SDK reserves `submit_result`
for this path. Keep validation free of effects: restoring a completed result may run it again.

An ordinary tool may return JSON or text and inline image parts. Its summary controls what the
model reads. Saved output and images remain private host data; they are not automatic browser
content. Media limits include images returned by tools.

## Reject work with guards

Guards can inspect model input/output and tool input/output. They are blocking checks with
recorded identities, time limits and bounded data. A rejected guard prevents the protected next
step. Guarded model output is held back until the guard allows it, rather than leaked to progress
first. Changed guard policies cannot silently resume old work.

The host's `beforeTool` check is still required for application permissions. A model-generated
approval, a guard result or a tracing callback cannot replace it. Output validation cannot undo
a tool that already changed an external service.

## Observe without controlling

`onLifecycle` observes starts, ends and failures. Its errors do not change execution decisions.
`onEvent` is best-effort progress. Both can contain private data, and either can repeat after a
restart. Do not use an observer to perform a non-repeatable business action.

Use [tracing](/agents/tracing/) for content-free operation records, [requests](/agents/requests/)
for human decisions and [recovery policies](/agents/recovery/) for interrupted work.
