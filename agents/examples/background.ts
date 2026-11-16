import { defineAgent } from "@providerkit/agents";
import type { createRuns } from "@gusnips/server/runs";
import { createBackgroundAgent, type BackgroundOptions } from "@providerkit/agents/runs";

// The fake provider needs no model account. Supply your existing run service, durable queue
// and trusted policy. The policy authenticates approvals; this example does not grant them.
// The optional session factory returns a conversation after checking that the owner may use
// it: an id from a request is not authorization.
export function backgroundExample(
  runs: ReturnType<typeof createRuns>,
  enqueue: BackgroundOptions<string>["enqueue"],
  policy: BackgroundOptions<string>["policy"],
  session?: BackgroundOptions<string>["session"],
) {
  const agent = defineAgent({
    id: "background-example",
    version: "1",
    instructions: "Return the example result.",
    provider: {
      id: "offline",
      model: "offline",
      async *createStream() {
        yield { type: "finish", content: "The background task finished.", finishReason: "stop" };
      },
    },
  });
  return createBackgroundAgent({
    agent,
    kind: "background-example-v1",
    runs,
    enqueue,
    policy,
    ...(session ? { session } : {}),
  });
}

// After authentication:
// const jobs = backgroundExample(runs, enqueue, policy);
// const { id } = await jobs.start(authenticatedOwner, "Run the example");
// const saved = await jobs.wait(authenticatedOwner, id, observerSignal);
// saved.status is the host segment status. Read saved.outcome.status for the agent result.
// In a conversation, pass its id. start reads the history in this request; the worker appends
// the turn when the run settles, and saved.outcome.session says whether that worked:
// const { id } = await jobs.start(authenticatedOwner, "Continue the plan.", { sessionId });
// saved.snapshot holds the whole conversation. Keep it, and every raw event, on the server.
// Aborting observerSignal stops waiting, not the worker. To stop the whole tree:
// await jobs.cancel(authenticatedOwner, id);
// For a suspended outcome, send authenticated decision evidence, never a client snapshot:
// const next = await jobs.resume(authenticatedOwner, id, decisionEvidence);
// The worker claims that decision under its lease. Check next.id for acceptance or failure.
// Observe next.id: continuation creates a new host row but keeps the logical agent run id.

// The host's queue worker awaits runs.drive(job.runId, jobs.handlers).
// On boot, await runs.sweep({ olderThanSecs: 0, nudge: enqueue }); repeat it periodically.
// Before stopping workers, await runs.drain(5_000).
// An enqueue failure throws BackgroundEnqueueError with the saved id. Requeue that id.
// After a worker restart, the policy must accept the same claim on the same segment only.
// Return worker-only tool values, such as a database handle, as policy.context.
// Stable usage receipts are in saved.outcome; they are not an atomic monetary ledger.
