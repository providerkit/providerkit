import type { Provider, ProviderChunk } from "@providerkit/core";
import { createMemorySession, defineAgent, toClientMessages } from "@providerkit/agents";

// An offline provider that answers from what it was sent, so the example needs no API key.
const provider: Provider = {
  id: "demo",
  model: "demo",
  async *createStream(messages): AsyncGenerator<ProviderChunk> {
    const turn = messages.at(-1);
    const image =
      turn?.role === "user" &&
      Array.isArray(turn.content) &&
      turn.content.some((part) => part.type === "image");
    const earlier = messages.filter((message) => message.role === "user").length - 1;
    yield {
      type: "finish",
      content: `${image ? "I can see the picture. " : ""}Earlier turns I read: ${earlier}.`,
      finishReason: "stop",
    };
  },
};

const assistant = defineAgent({
  id: "demo-chat",
  version: "1",
  instructions: "Answer in one short sentence.",
  provider,
});

// Pictures stay on your server. The run stores only their ids and asks for the bytes right
// before each model call. A real loadMedia checks that the run's owner may read the id.
const pictures = new Map([["picture-1", "iVBORw0KGgoAAAAN"]]);
async function loadMedia(ref: { id: string }): Promise<string> {
  const bytes = pictures.get(ref.id);
  if (!bytes) throw new Error(`No picture ${ref.id}.`);
  return bytes;
}

// One session per conversation. This one lives in memory; a server uses its own store.
const thread = createMemorySession({ id: "demo-thread" });

const first = await assistant.run("Hello.", { session: thread });
const second = await assistant.run(
  [
    { type: "text", text: "What is in this picture?" },
    { type: "media", id: "picture-1", mimeType: "image/png" },
  ],
  { session: thread, host: { loadMedia } },
);
for (const result of [first, second]) {
  if (result.status !== "completed" || result.session?.status !== "saved") {
    throw new Error(`The demo stopped with status ${result.status}.`);
  }
  console.log(result.output);
}
// Send a browser this copy, never the snapshot: it leaves out the fields a provider owns.
console.log(`The conversation has ${toClientMessages(second.history).length} messages.`);
