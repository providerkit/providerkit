import type { Provider, ProviderChunk } from "@providerkit/core";
import { defineAgent, defineDelegation } from "@providerkit/agents";

// Fake providers keep the whole orchestration example offline.
function answerProvider(answer: string): Provider {
  return {
    id: "demo",
    model: "demo",
    async *createStream(): AsyncGenerator<ProviderChunk> {
      yield { type: "finish", content: answer, finishReason: "stop" };
    },
  };
}

const writer = defineAgent({
  id: "writer",
  version: "1",
  instructions: "Write a short release note.",
  provider: answerProvider("The update adds a search filter."),
});
const reviewer = defineAgent({
  id: "reviewer",
  version: "1",
  instructions: "Check that a release note tells readers what changed.",
  provider: answerProvider("Say which results the new filter can narrow down."),
});

const reviewTogether = defineDelegation({
  name: "review_together",
  description: "Ask the writer and reviewer for their input in parallel.",
  specialists: [writer, reviewer],
  inputSchema: {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  },
  validate(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("input" in value) ||
      typeof value.input !== "string"
    ) {
      throw new Error("Pass an input string for the specialists.");
    }
    return value.input;
  },
  async run(input, context) {
    const draft = context.child("draft", writer, input);
    const review = context.child("review", reviewer, input);
    const results = await context.join([draft, review]);
    return results.map((result) => {
      if (result.status !== "completed") {
        throw new Error(`A specialist stopped with status ${result.status}.`);
      }
      return result.output;
    });
  },
});

const managerProvider: Provider = {
  id: "demo-manager",
  model: "demo",
  async *createStream(history): AsyncGenerator<ProviderChunk> {
    const last = history.at(-1);
    if (last?.role === "tool") {
      yield { type: "finish", content: last.content, finishReason: "stop" };
      return;
    }
    yield {
      type: "finish",
      toolCalls: [
        {
          index: 0,
          id: "review_1",
          name: "review_together",
          arguments: JSON.stringify({ input: last?.content ?? "Review the update." }),
        },
      ],
      finishReason: "tool_calls",
    };
  },
};

const manager = defineAgent({
  id: "manager",
  version: "1",
  instructions: "Ask both specialists, then return their notes.",
  provider: managerProvider,
  tools: [reviewTogether],
  treeLimits: { maxParallel: 2, maxChildren: 2, maxDepth: 1 },
});

const result = await manager.run("Prepare notes for a new search filter.");
if (result.status !== "completed") {
  throw new Error(`The manager stopped with status ${result.status}.`);
}
console.log(result.output);
