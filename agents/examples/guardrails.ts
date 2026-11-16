import { defineTool, type Provider } from "@providerkit/core";
import { defineAgent } from "../src/index.ts";

// Offline: two recorded turns, no key or network request.
const provider: Provider = {
  id: "offline",
  model: "recorded",
  async *createStream(messages) {
    if (!messages.some((message) => message.role === "tool")) {
      yield {
        type: "delta",
        toolCalls: [{ index: 0, id: "picture-1", name: "picture", arguments: "{}" }],
      };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    yield { type: "delta", content: "The tool returned an image and its description." };
    yield { type: "finish", finishReason: "stop" };
  },
};
const picture = defineTool({
  name: "picture",
  description: "Return the sample picture.",
  inputSchema: { type: "object" },
  isReadOnly: true,
  run: async () => [
    { type: "text", text: "One transparent pixel." },
    {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nKAAAAAASUVORK5CYII=",
    },
  ],
});
const reader = defineAgent({
  id: "reader",
  version: "1",
  instructions: "Describe the sample picture.",
  provider,
  tools: [picture],
  guardrails: {
    identity: "sample-policy-1",
    maxOutputBytes: 16_384,
    modelInput: ({ messages }) => ({ allow: messages.length <= 20 }),
    modelOutput: (turn) => ({ allow: !turn.message.content.includes("private") }),
    toolOutput: ({ result }) => ({ allow: result.ok }),
  },
  onLifecycle(event) {
    // These hooks are privileged. Log identities, not raw prompts or results.
    console.log(event.type);
  },
});

const result = await reader.run("Show the sample picture.");
if (result.status !== "completed") throw new Error(`Run ended: ${result.status}`);
console.log(result.output);
