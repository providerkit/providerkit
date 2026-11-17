import type { Provider } from "@providerkit/core";
import { createMemoryStore, defineAgent, ingestMemory, memoryTools } from "../src/index.ts";

// Offline example. The real host gets these ids from its authenticated server context.
const store = createMemoryStore();
const signal = new AbortController().signal;
const scope = await store.access({ tenantId: "example", userId: "person" }, { signal });
const memory = { store, scope };
await store.save(
  { access: scope, notes: [{ key: "drink", text: "Coffee without sugar", version: null }] },
  { signal },
);

const provider: Provider = {
  id: "offline",
  model: "example",
  async *createStream(messages) {
    const recalled = JSON.stringify(messages).includes("Coffee without sugar");
    if (!recalled) throw new Error("The saved preference did not reach the model.");
    yield { type: "delta", content: "Coffee without sugar." };
    yield { type: "finish", finishReason: "stop" };
  },
};
const notes = memoryTools();
const agent = defineAgent({
  id: "helper",
  version: "1",
  instructions: "Use saved preferences only when they help answer the person.",
  provider,
  memory: true,
  tools: [notes.search],
});
const result = await agent.run("How do I take my coffee?", { memory });
if (result.status !== "completed") throw new Error("The offline run did not complete.");
console.log(result.output);

// No hook writes memories. The host explicitly chooses facts after inspecting the result.
const ingested = await ingestMemory(result, {
  memory,
  notes: [{ key: "format", text: "Prefers short answers", version: null }],
});
if (ingested.status !== "saved") throw new Error("The example did not save its ingestion receipt.");
await store.erase({ tenantId: "example", userId: "person" }, { signal });
// The host must also remove snapshots, sessions, event logs and copies in its own storage.
