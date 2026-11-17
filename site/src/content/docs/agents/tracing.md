---
title: Tracing
description: Observe agent execution through OpenTelemetry without recording private content or duplicating provider spans.
---

Add tracing to your existing run options:

```ts
const options = tracing.options(runOptions);
```

Your current authorization, signal and other options stay in place. Install the optional
`@opentelemetry/api` peer, then create the adapter:

```ts
import { createAgentTracing } from "@providerkit/agents/otel";

const tracing = createAgentTracing();
try {
  await agent.run("Summarize the changes.", tracing.options());
} finally {
  tracing.close();
}
```

Your app registers the tracer and exporter. The package installs neither and sends no telemetry
by itself. You may pass an existing `tracer` and `parentContext` instead. Normal SDK imports do
not load `/otel`.

## One provider observation

A span is a timed record of an operation. Agents records execution and tool/workflow steps. Core
records the provider stream and reported usage. The SDK's internal model-operation span connects
its identities to the Core span, without duplicating usage or claiming another provider request.
A resumed run starts a new span; time between attempts is not included.

For manual composition, attach `onLifecycle`, `onEvent` and `bindModelProvider` once. Apply the
provider binding last, outside other decorators. A directly wrapped Core provider can be rebound;
a hidden inner tracing wrapper cannot be deduplicated.

## Context and data

Explicit parent contexts work without a context manager. Core activates context around provider
iterator calls. Tool and step hooks only observe: HTTP calls inside those functions need your
host's own instrumentation and context manager.

Prompts, code, tool data, remote payloads and raw errors are not captured by default. IDs and
versions are recorded, so do not put personal text or secrets in them. `AgentSpanInfo.nodeKind`
and `nodeId` distinguish agents, workflows and remote nodes. Host-approved custom attributes are
bounded and use the `providerkit.host.*` prefix.

Remote spans cover local observation, not the peer's full task lifetime or bill. The last peer
state is separate from local run state. Explicit `remote.cancel()` has a receipt but no separate
SDK operation span; host HTTP instrumentation may observe its request. Status updates are not
proof of a send, cancellation or known cost.

## Close observations, not work

`close()` never cancels execution, repeats a request or flushes an exporter. Core streams already
bound by the adapter stay observed until they end or the caller aborts. This adapter cannot close
a Core span for a stream abandoned without either event.

The defaults retain 128 run observations and 1,024 operation/relationship records per run, with a
30-minute observation lifetime. Reaching those bounds stops observations, not execution.

Run the [offline tracing example](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/otel.ts)
to see the SDK and Core spans without an exporter or model request.
