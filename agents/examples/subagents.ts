import type { Provider } from "@providerkit/core";
import { defineAgent, subagentTool } from "../src/index.ts";

// Offline example. This provider supplies fixed responses and makes no network calls.
const provider: Provider = {
  id: "offline",
  model: "example",
  async *createStream(messages, tools) {
    const coordinating = tools?.some((tool) => tool.name === "create_helpers");
    const results = messages.findLast((message) => message.role === "tool");
    if (coordinating && !results) {
      yield {
        type: "delta",
        toolCalls: [
          {
            index: 0,
            id: "helpers",
            name: "create_helpers",
            arguments: JSON.stringify({
              agents: [
                {
                  name: "reads",
                  task: "Explain how an index speeds up a search.",
                  instructions: "Use one short sentence.",
                  fork: true,
                },
                {
                  name: "writes",
                  task: "Explain why an index can slow down a write.",
                  instructions: "Use one short sentence.",
                },
              ],
            }),
          },
        ],
      };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    if (
      coordinating &&
      results &&
      messages.filter((message) => message.role === "tool").length === 1
    ) {
      const output: unknown = JSON.parse(results.content);
      const first: unknown = Array.isArray(output) ? output[0] : undefined;
      if (
        !first ||
        typeof first !== "object" ||
        !("helperId" in first) ||
        typeof first.helperId !== "string"
      )
        throw new Error("The helper did not return an identity.");
      yield {
        type: "delta",
        toolCalls: [
          {
            index: 0,
            id: "followup",
            name: "create_helpers",
            arguments: JSON.stringify({
              agents: [
                { name: "reads", continues: first.helperId, task: "Give one search example." },
              ],
            }),
          },
        ],
      };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    yield {
      type: "delta",
      content: coordinating
        ? "An index helps a search find rows. A write has to update the index too."
        : String(messages.at(-1)?.content).includes("search")
          ? "An index points to matching rows without reading every row."
          : "A write must update both the row and its index.",
    };
    yield { type: "finish", finishReason: "stop" };
  },
};

const helper = defineAgent({
  id: "helper",
  version: "1",
  instructions: "Answer only the task you receive.",
  provider,
});
const explainer = defineAgent({
  id: "explainer",
  version: "1",
  instructions: "Ask helpers about reads and writes, then combine their answers.",
  provider,
  tools: [
    subagentTool({
      name: "create_helpers",
      description: "Start helpers for separate parts of the question.",
      agent: helper,
      followUp: true,
      fork: {
        identity: "public-example-history-1",
        maxMessages: 2,
        maxBytes: 2_000,
        // This offline example contains only a public question. A real host checks its data.
        select: (messages) => messages.map((_, index) => index).slice(-2),
      },
    }),
  ],
});

const result = await explainer.run("When does a database index help?", {
  // No external resources exist in this example. Production hosts check the owner and lease here.
  host: { beforeTool() {} },
});
if (result.status !== "completed") throw new Error(`The example ended with ${result.status}.`);
if (result.snapshot.delegations[0]?.children.length !== 2) throw new Error("Expected two helpers.");
const original = result.snapshot.delegations[0]?.children[0]?.snapshot;
const followup = result.snapshot.delegations[1]?.children[0]?.snapshot;
if (
  original?.kind !== "agent" ||
  followup?.kind !== "agent" ||
  !followup.subagent ||
  followup.subagent.previousRunId !== original.runId
)
  throw new Error("Expected a follow-up to the first helper.");
console.log(result.output);
