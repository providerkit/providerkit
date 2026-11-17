// Run: bun agents/examples/a2a-server.ts
// Offline. No socket, provider, model call or optional server package.
import { defineWorkflow } from "../src/workflow.ts";
import { createA2AClient } from "../src/a2a/client.ts";
import { bearerToken } from "../src/a2a/auth.ts";
import { createMemoryRuns } from "../src/a2a/memory-runs.ts";
import { createA2AServer } from "../src/a2a/server.ts";
import { a2aSegments, createMemoryTaskStore } from "../src/a2a/tasks.ts";

const principal = { owner: "demo", actorId: "reader" };
const tasks = createMemoryTaskStore();
const workflow = defineWorkflow({
  id: "echo",
  version: "1",
  input: {
    schema: { type: "object" },
    validate(value: unknown) {
      if (typeof value !== "string") throw new TypeError("Pass text to echo.");
      return value;
    },
  },
  run: (text, context) => context.step("echo", () => text),
});
const runs = createMemoryRuns({
  workflow,
  onSegment: a2aSegments({ tasks, scope: () => principal }),
  policy(context) {
    const check = () => {
      if (context.owner !== principal.owner) throw new Error("This run belongs to another owner.");
    };
    return {
      authorizeResume: check,
      beforeTool: check,
      beforeStep: check,
      prepareRequest() {
        throw new Error("This demo does not accept questions or approvals.");
      },
      resolveRequest() {
        throw new Error("This demo does not accept answers.");
      },
      claimContinuation() {
        throw new Error("This demo does not continue paused work.");
      },
    };
  },
});
const server = createA2AServer({
  runs,
  tasks,
  authenticate: bearerToken("offline-demo-only", principal),
  card: { url: "https://demo.test/", name: "Echo", description: "Returns the text you send." },
  prepare: (message) =>
    message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("\n"),
  // Only this selected result crosses the boundary, not workflow steps or snapshots.
  projectOutput: (outcome) =>
    typeof outcome.output === "string" ? [{ kind: "text", text: outcome.output }] : [],
});
const client = createA2AClient({
  endpoint: "https://demo.test/jsonrpc",
  version: "1.0",
  binding: "JSONRPC",
  policy: { allow: (url) => url.origin === "https://demo.test" },
  headers: () => ({ authorization: "Bearer offline-demo-only" }),
  fetch: (url, init) => server.fetch(new Request(url, init)),
});
try {
  const result = await client.call("SendMessage", {
    message: {
      kind: "message",
      messageId: "hello",
      role: "user",
      parts: [{ kind: "text", text: "Hello" }],
    },
  });
  if (result.kind !== "task" || result.status.state !== "completed")
    throw new Error("The demo did not complete.");
  const part = result.artifacts?.[0]?.parts[0];
  if (part?.kind !== "text" || part.text !== "Hello")
    throw new Error("The demo returned different text.");
  console.log(part.text);
} finally {
  await server.close();
}
