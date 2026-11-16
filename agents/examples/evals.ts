import { defineTool } from "@providerkit/core";
import { defineAgent } from "@providerkit/agents";
import {
  answeredBy,
  assertReport,
  contains,
  formatReport,
  runEvals,
  scriptedProvider,
  trajectory,
} from "@providerkit/agents/evals";

const report = await evaluate("14 days");
console.log(formatReport(report));
assertReport(report);

// All providers are offline. Real agents need sandboxed tools and SDK limits.
// Stored cases contain expectations, not permission. Trusted drivers are separate.
function evaluate(expected: string) {
  return runEvals({
    name: "Refund conversation",
    cases: [
      {
        id: "refund-window",
        turns: [
          {
            input: "How long is the refund window?",
            expected,
            scorers: [trajectory({ calls: [{ name: "refund_window" }], match: "exact" })],
          },
          { input: "Is that from the purchase date?", expected: "purchase date" },
        ],
      },
    ],
    repeat: 3,
    k: [1, 2],
    scorers: [contains(), answeredBy("refund-help")],
    drivers: {
      "refund-window": {
        toolMocks: [{ name: "refund_window", result: "14 days from the purchase date" }],
        answers: [
          {
            agentId: "refund-help",
            tool: "refund_window",
            ask: "approval",
            decision: { type: "approve" },
          },
        ],
      },
    },
    agent: ({ stub }) =>
      defineAgent({
        id: "refund-help",
        version: "1",
        instructions: "Read the refund window, then answer.",
        provider: scriptedProvider([
          { toolCalls: [{ name: "refund_window" }] },
          "You can request a refund within 14 days.",
          "Yes, 14 days from the purchase date.",
        ]),
        limits: { turns: 2, toolCalls: 1 },
        treeLimits: { modelCalls: 2, maxChildren: 0 },
        tools: stub([
          defineTool({
            name: "refund_window",
            description: "Read the refund window.",
            inputSchema: { type: "object" },
            isReadOnly: true,
            needsApproval: true,
            // The mock replaces call and invoke, including backend validation and execution.
            // This example does not test those replaced checks.
            run: async () => {
              throw new Error("The offline example must use its tool mock.");
            },
          }),
        ]),
      }),
  });
}
