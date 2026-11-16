import { defineTool, type Provider, type ProviderChunk } from "@providerkit/core";
import { defineAgent } from "../src/index.ts";
import { assertReport, contains, formatReport, runEvals, trajectory } from "../src/evals.ts";

const report = await evaluate("14 days");
console.log(formatReport(report));
assertReport(report);

// This example runs offline. Every repeat gets a fresh provider and only a local read-only tool.
// Real eval agents need sandboxed tools and SDK run/tree limits. The host stores any report.
function evaluate(expected: string) {
  return runEvals({
    name: "Refund window",
    cases: [{ id: "refund-window", input: "How long is the refund window?", expected }],
    repeat: 3,
    k: [1, 2],
    scorers: [contains(), trajectory({ calls: [{ name: "refund_window" }], match: "exact" })],
    agent: () => {
      const provider: Provider = {
        id: "offline",
        model: "offline",
        async *createStream(history): AsyncGenerator<ProviderChunk> {
          yield {
            type: "usage",
            usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reportedCostUsd: 0 },
          };
          if (history.at(-1)?.role === "tool") {
            yield {
              type: "finish",
              content: "You can request a refund within 14 days.",
              finishReason: "stop",
            };
          } else {
            yield {
              type: "finish",
              finishReason: "tool_calls",
              toolCalls: [{ index: 0, id: "refund", name: "refund_window", arguments: "{}" }],
            };
          }
        },
      };
      return defineAgent({
        id: "refund-help",
        version: "1",
        instructions: "Read the refund window, then answer.",
        provider,
        limits: { turns: 2, toolCalls: 1 },
        treeLimits: { modelCalls: 2, maxChildren: 0 },
        tools: [
          defineTool({
            name: "refund_window",
            description: "Read the example refund window.",
            inputSchema: { type: "object" },
            isReadOnly: true,
            run: async () => "14 days",
          }),
        ],
      });
    },
  });
}
