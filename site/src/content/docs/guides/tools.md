---
title: Tools
description: A JSON-Schema-first tool kernel with timeouts, abort, structured outcomes, and optional zod ergonomics.
---

The kernel takes plain JSON Schema, because that is what every provider's tool contract wants and
it is the one shape that needs no dependency. zod is available as an optional peer for people who
want inference.

## Defining a tool

```ts
import { defineTool } from "@providerkit/core";

const readFile = defineTool({
  name: "read_file",
  description: "Read a UTF-8 file from the workspace.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Workspace-relative path" } },
    required: ["path"],
    additionalProperties: false,
  },
  timeoutMs: 10_000,
  isReadOnly: true,
  async run({ path }, ctx) {
    return await fs.readFile(path, "utf8");
  },
});
```

The flags are metadata your loop reads — the kernel does not enforce policy:

| Flag                | Meaning                                      |
| ------------------- | -------------------------------------------- |
| `isReadOnly`        | Changes nothing; safe to run without asking. |
| `needsApproval`     | The loop should gate this behind the user.   |
| `isConcurrencySafe` | May run in parallel with other tools.        |
| `isTerminal`        | Ends the turn — a submit or a final answer.  |

## Invoking

```ts
const outcome = await tool.invoke(rawArgsFromModel, { signal });

if (outcome.ok) {
  send(outcome.output);
} else {
  switch (outcome.kind) {
    case "invalid_input":
      /* tell the model what was wrong */ break;
    case "timeout":
      /* tool exceeded timeoutMs */ break;
    case "aborted":
      /* caller stopped */ break;
    case "failed":
      /* the tool threw */ break;
  }
}
```

`invoke` never throws. A tool that throws, times out, or receives arguments that fail validation
comes back as a structured `ToolOutcome` — because in an agent loop a thrown tool is not an
exception, it is a _result the model needs to see and react to_. Crashing the loop instead robs
the model of the chance to correct itself.

`call(input, ctx)` is the typed, direct path for your own code; it throws normally.

## Arguments the model truncated

Providers stream tool arguments a few characters at a time, and a turn cut off at its output
ceiling leaves invalid JSON. The run then reports nothing while the answer sits in the fragments.

```ts
import { parseToolArgs, isCompleteJson } from "@providerkit/core";

const args = parseToolArgs(raw); // never throws
```

`parseToolArgs` parses normally when it can, and otherwise salvages the string fields it can
recover from the truncated JSON. It also heals double-escaped `\\uXXXX` sequences, which some
gateways emit when they re-encode a payload.

## zod

```ts
import { zodTool } from "@providerkit/core/zod";
import { z } from "zod";

const search = zodTool({
  name: "search",
  description: "Search the index.",
  input: z.object({ query: z.string(), limit: z.number().max(50).default(10) }),
  async run({ query, limit }) {
    return await index.search(query, limit);
  },
});
```

zod is an **optional peer dependency**. The kernel never imports it, so a project without zod —
a Chrome MV3 extension, say — pays nothing for its existence.

`clampOverflow` is worth knowing about for terminal tools: when a model's output exceeds a
schema's limits, clamping to the limit and submitting beats rejecting and losing the whole turn.
