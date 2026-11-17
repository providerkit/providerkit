// Offline example. No network, credentials or persistent storage.
import assert from "node:assert/strict";
import { defineTool, type Provider } from "@providerkit/core";
import { createMemoryInbox, defineAgent } from "../src/index.ts";

const runId = "example-conversation";
const inbox = createMemoryInbox(runId);
const reading = Promise.withResolvers<void>();
const finishReading = Promise.withResolvers<void>();
let calls = 0;
const provider: Provider = {
  id: "example",
  model: "offline",
  async *createStream(messages) {
    if (++calls === 1) {
      yield {
        type: "finish",
        finishReason: "tool_calls",
        toolCalls: [{ index: 0, id: "read", name: "read", arguments: "{}" }],
      };
      return;
    }
    assert.deepEqual(messages.at(-1), { role: "user", content: "Use one sentence." });
    assert.equal(inbox.list()[0]?.status, "accepted");
    // This arrives after the last poll. Finishing does not silently start another paid run.
    inbox.enqueue({ id: "later", content: "What about writes?" });
    yield {
      type: "finish",
      finishReason: "stop",
      content: "An index lets a database find a row without reading every row.",
    };
  },
};
const writer = defineAgent({
  id: "writer",
  version: "1",
  instructions: "Explain database indexes.",
  provider,
  tools: [
    defineTool({
      name: "read",
      description: "Read a note about database indexes.",
      inputSchema: { type: "object" },
      async run() {
        reading.resolve();
        await finishReading.promise;
        return "An index stores values in search order.";
      },
    }),
  ],
});

const work = writer.run("Explain indexes.", { runId, host: { inbox } });
await reading.promise;
inbox.enqueue({ id: "shorter", content: "Use one sentence." });
assert.equal(inbox.list()[0]?.status, "queued");
finishReading.resolve();
const result = await work;
assert.equal(result.status, "completed");
assert.deepEqual(
  inbox.list().map(({ id, status }) => ({ id, status })),
  [
    { id: "shorter", status: "consumed" },
    { id: "later", status: "queued" },
  ],
);
assert.equal(calls, 2);
console.log(result.output);
console.log("The later message stays queued. The host can offer it back for the next run.");
