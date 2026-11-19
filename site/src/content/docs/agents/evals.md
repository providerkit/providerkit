---
title: Evals
description: Run repeatable checks against real execution journals, with explicit mocks and private reports.
---

Run checks and get a report:

```ts
const report = await runEvals(checks);
```

This complete case makes no network request:

```ts
import { defineAgent } from "@providerkit/agents";
import { assertReport, exact, runEvals, scriptedProvider } from "@providerkit/agents/evals";

const checks = {
  agent: () =>
    defineAgent({
      id: "greeting",
      version: "1",
      instructions: "Say hello.",
      provider: scriptedProvider(["Hello"]),
    }),
  cases: [{ id: "hello", input: "Hi", expected: "Hello" }],
  scorers: [exact()],
};
assertReport(await runEvals(checks));
```

`assertReport` throws when the case does not pass. A missing score does not become a success.

## Score the actual journal

Use exact text, containment, schema, similarity, trajectory, tool-argument and budget scorers,
or supply your own scorer. `scoreRun` and `trajectoryOf` can inspect saved runs without replaying
effects. `caseFromRun` refuses input timing it cannot reproduce.

Code inner calls retain their parent operations. Repeated programs cannot hide behind their
inner calls, and denied code preserves its exact source. Workflow steps and remote operations
keep their real identities rather than becoming local model calls.

## Make scenarios repeatable

A case supplies exactly one of `input`, `turns` or `user`. Multiple turns share a fresh memory
session. Scripted answers and tool mocks live in `drivers`, not stored case data. Match actual
agent/tool or workflow/step requests, with question keys, original input and child paths when
needed. Answers remain subject to the host's request policy.

`stub` replaces both execution paths and never falls through to the real effect. It preserves
code-tool identity and output-schema metadata, so a mocked helper keeps the same capability and
model guidance. A mock does not prove the original backend's validation works.

Give the eval's `host` the same `screenCall`, `needsApproval` and `canRunConcurrently` your app
uses, so a check runs your agent with its own rules. An eval host cannot answer requests: that is
what `drivers` are for.

The [offline eval example](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/evals.ts)
shows multiple turns, mocks and scripted approvals.

## Opt into paid checks

Simulated users require an explicit provider and `allowSimulation: true`. Model judges need an
explicit provider/rubric and `allowJudge: true`. These make extra provider calls and may cost money.
A judge's score is an assessment, not proof that an answer is true. Supply current rates yourself.

Unknown charges stay unknown. `remoteAttempts` records safe operation identities, send/cancel
status and unknown billing, not peer endpoints or task handles. A zero local token count does not
mean a free remote task. Spending thresholds stop new work, not calls already in flight.

## Keep reports private when needed

Reports omit inputs, outputs, snapshots, reasons and exception messages by default. Use
non-sensitive case IDs. `includePrivateData` opts those fields in; review golden cases before
sharing them. `createLiveScorer` scores only runs your host submits. The host owns sampling,
deduplication, storage and retention; there is no automatic queue or telemetry.
