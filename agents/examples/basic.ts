import { defineTool, type Provider, type ProviderChunk } from "@providerkit/core";
import { defineAgent } from "@providerkit/agents";

// An offline provider makes the example runnable without an API key or a private app.
const provider: Provider = {
  id: "demo",
  model: "demo",
  async *createStream(history): AsyncGenerator<ProviderChunk> {
    const last = history.at(-1);
    if (last?.role === "tool") {
      yield { type: "finish", content: last.content, finishReason: "stop" };
      return;
    }
    yield {
      type: "finish",
      toolCalls: [{ index: 0, id: "tasks_1", name: "list_demo_tasks", arguments: "{}" }],
      finishReason: "tool_calls",
    };
  },
};

const listTasks = defineTool({
  name: "list_demo_tasks",
  description: "List the tasks in this offline example.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  isReadOnly: true,
  async run() {
    return ["Write a release note", "Check the documentation link"];
  },
});

const assistant = defineAgent({
  id: "demo-assistant",
  version: "1",
  instructions: "Use the available tool to list the demo tasks.",
  provider,
  tools: [listTasks],
});

const result = await assistant.run("List the tasks.");
if (result.status !== "completed") {
  throw new Error(`The demo stopped with status ${result.status}.`);
}
console.log(result.output);
