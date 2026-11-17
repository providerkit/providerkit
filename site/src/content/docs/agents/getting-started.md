---
title: Agents quickstart
description: Run the published offline agent example, then connect a provider of your own.
---

```ts
await assistant.run("List the tasks.");
```

The [complete example](https://github.com/providerkit/providerkit/blob/7891647/agents/examples/basic.ts)
defines `assistant`. A scripted provider asks a tool for two tasks, then returns the tool's answer.
It makes no model calls and needs no API key.

## Run the offline example

Install the released package and its matching Core peer in a new folder:

```sh
bun add @providerkit/agents@0.1.0 @providerkit/core@^0.30.0
bun node_modules/@providerkit/agents/examples/basic.ts
```

Expected output:

```json
["Write a release note", "Check the documentation link"]
```

Agents 0.1 declares Core `^0.30.0` as its peer. Use that pair for this released example, not the
newer Core quickstart's version. The next Agents release will update the pair.

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

Change the agent's version when its instructions, tools or result contract change. A saved run
from another version is refused rather than continued under new rules.

Next: [specialist examples](/examples/#agents-examples), [the API reference](/reference/agents/)
and [tools and permissions](/concepts/tools-and-permissions/).
