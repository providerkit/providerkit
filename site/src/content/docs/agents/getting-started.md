---
title: Agents quickstart
description: Run the published offline agent example, then connect a provider of your own.
---

```ts
await assistant.run("List the tasks.");
```

The [complete example](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/basic.ts)
defines `assistant`. A scripted provider asks a tool for two tasks, then returns the tool's answer.
It makes no model calls and needs no API key.

## Run the offline example

Install the released package and its matching Core peer in a new folder:

```sh
bun add @providerkit/agents@0.3.0 @providerkit/core@^0.33.1
bun node_modules/@providerkit/agents/examples/basic.ts
```

Expected output:

```json
["Write a release note", "Check the documentation link"]
```

Agents 0.3 uses Core `^0.33.1`. The optional integrations have their own peer dependencies;
the basic example does not need a server package, MCP, tracing or a code engine.

## Connect your provider

Pass a [configured Core provider](/guides/getting-started/) into your agent:

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

The offline example is free to run. Replacing its scripted provider with a live one sends requests
to that provider and may cost money.

## Read the result

```ts
const result = await writer.run("Explain database indexes.");
if (result.status === "completed") {
  console.log(result.output);
} else {
  console.log(result.status);
}
```

A run can also be `suspended` for approval, `cancelled`, `limited` or `failed`. Do not treat those
as complete answers. A failed result includes an error with a code and message.

## Cap what a run spends

```ts
const analyst = defineAgent({ ...config, limits: { costUsd: 1.5 } });
await analyst.run(question, { host: { priceModelCall: ({ usage }) => costUsd(usage, rate) } });
```

Once the calls this run and its helpers made cost $1.50, no new call starts and the run ends
`limited` with `limit: "costUsd"`. Your host supplies the prices: Core's `costUsd` turns token
counts into dollars with your own rates. A tool that pays for something itself, such as a paid
API, adds the amount with `context.reportCost(usd)`, and the limit counts it. Calls that were
already running can finish above the limit. The [cost limit section](https://github.com/providerkit/providerkit/blob/main/agents/README.md#cost-limit)
covers helpers, workflows and resume.

Change the agent's version when its instructions, tools or result contract change. A saved run
from another version is refused rather than continued under new rules.

Next: [specialist examples](/examples/#agents-examples), [the API reference](/reference/agents/)
and [tools and permissions](/concepts/tools-and-permissions/).
