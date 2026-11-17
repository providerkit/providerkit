---
title: AG-UI
description: Convert AG-UI events while keeping identity, private-data policy and mapping losses explicit.
---

Read one event:

```ts
const { events, issues } = reader.read(event);
```

Apply the display events and handle the issues. A mapping issue is not a successful conversion
of an unsupported field. The `@providerkit/react/ag-ui` entry needs no React, agent engine or
server runtime.

## Bind the execution explicitly

```ts
import { createAgUiReader, createAgUiWriter } from "@providerkit/react/ag-ui";

const binding = {
  threadId: "conversation",
  runId: "logical-run",
  segment: "physical-segment",
  agUiRunId: "native-execution",
};
const reader = createAgUiReader({ binding });
const writer = createAgUiWriter({ binding });
```

Use a new mapper per segment or connection, initialized from a snapshot. Send `writer.write`
results in order. `end()` detects an unfinished stream; it does not invent completion. The host
may supply sequence and segment metadata when reading external native events.

## Keep the display extension when needed

Native AG-UI carries text, tool, step, run and snapshot events. The owned `providerkit.display.v1`
custom events keep fields native events cannot express: requests, handoff ownership, attempts,
input receipts and missing-text markers. Keep them for a full display round trip.

Workflow rows use native step events, never fake model tool calls. Their operation identity and
waiting/failure state need the extension. Code inner calls remain tool calls, but native AG-UI
flattens their parent relationship and lacks effect-attempt framing. Remote identity and unknown
status also have no complete native equivalent. These losses are reported, not silently hidden.

## Project private data

Arguments, results, reasoning, raw failures and opaque app state are hidden by default. Explicit
host callbacks choose safe fields. Shared-state patches require a state projection; supported
operations are bounded rather than silently truncated.

Native-only snapshots lack some settled and attempt information. Imported saved text is sealed,
and an issue explains the loss. Preserve that distinction during reconnect.

## Validate responses on the host

`toResumeEntry` maps supported native answers. `toProviderkitResumeEntry` keeps richer request
answers with binding metadata, and `readResumeEntry` checks either against the saved request.
Unsupported answer fields are refused instead of discarded.

Native entries do not contain all binding metadata, so the host resolves the real request.
Parsing never authorizes a response or grants a client action. See [requests](/react/requests/)
and [the AG-UI API](/reference/react/).
