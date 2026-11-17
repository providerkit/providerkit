import assert from "node:assert/strict";
import { TransportError } from "@providerkit/react";
import {
  emptyChatView,
  parseChatEvent,
  reduceChat,
  type DisplayMessage,
} from "@providerkit/react/protocol";
import { assistant } from "../src/components/AgentDemo.tsx";
import { createSampleTransport, restoreDemo } from "../src/components/ChatDemo.tsx";

// Manual check only. No paid provider, browser service or live request is involved.
globalThis.fetch = async () => {
  throw new Error("The site examples must not make live requests.");
};

const run = await assistant.run("List the tasks.");
assert.equal(run.status, "completed");
if (run.status === "completed") {
  assert.match(run.output, /Found 2 sample tasks/);
  assert.match(run.output, /Write a release note/);
}
const send = createSampleTransport(false).send;
assert(send);
const controller = new AbortController();
const reply = await send(
  { clientId: "sample", text: "Keep this text" },
  { signal: controller.signal },
);
assert(reply);
let view = emptyChatView();
for await (const event of reply.events) {
  assert.deepEqual(parseChatEvent(event), event);
  view = reduceChat(view, event);
}
assert.equal(view.run.status, "completed");
const reopened = restoreDemo({
  getItem: () =>
    JSON.stringify({
      expiresAt: Date.now() + 10_000,
      event: { v: 1, type: "snapshot", messages: view.messages, run: view.run },
    }),
  removeItem: () => assert.fail("The saved conversation is still current."),
});
assert.deepEqual(reopened, { messages: view.messages, run: view.run });
assert.equal(view.messages[0]?.clientId, "sample");
assert.equal(view.messages[0]?.parts[0]?.type, "text");
assert.match(JSON.stringify(view.messages), /Keep this text/);
assert.match(JSON.stringify(view.messages), /sample reply/);

const refused = createSampleTransport(true).send;
assert(refused);
await assert.rejects(
  () => refused({ clientId: "refused", text: "Keep my draft" }, { signal: controller.signal }),
  (error: unknown) => error instanceof TransportError && error.outcome === "refused",
);
await assert.rejects(
  () => send({ clientId: "long", text: "x".repeat(1201) }, { signal: controller.signal }),
  (error: unknown) => error instanceof TransportError && error.error.code === "demo_length",
);

const cancelled = new AbortController();
const pending = await send({ clientId: "cancel", text: "Stop" }, { signal: cancelled.signal });
assert(pending);
cancelled.abort();
const iterator = pending.events[Symbol.asyncIterator]();
assert.equal((await iterator.next()).done, true);

const messages: DisplayMessage[] = [
  {
    id: "partial",
    role: "assistant",
    state: "live",
    parts: [{ id: "text", type: "text", text: "Saved fragment", settled: false }],
  },
];
const saved = JSON.stringify({
  expiresAt: Date.now() + 10_000,
  event: { v: 1, type: "snapshot", messages, run: { status: "running" } },
});
const restored = restoreDemo({ getItem: () => saved, removeItem: () => {} });
assert.equal(restored.run?.status, "stopped");
assert.equal(restored.messages[0]?.state, "stopped");
assert.match(restored.notice ?? "", /stopped/);
assert.deepEqual(restored.messages[0]?.parts[0], {
  id: "text",
  type: "text",
  text: "Saved fragment",
  settled: true,
});
const broken = restoreDemo({ getItem: () => "broken-json", removeItem: () => {} });
assert(broken.notice, "A failed restore must not look like an empty demo.");
let removed = "";
const expired = restoreDemo({
  getItem: () => JSON.stringify({ expiresAt: 0, event: null }),
  removeItem: (key) => {
    removed = key;
  },
});
assert.equal(expired.messages.length, 0);
assert.equal(removed, "providerkit.demo.chat.v1");
console.log("Site demo execution, delivery, cancellation and restore checks passed.");
