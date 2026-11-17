// Run: bun agents/examples/a2a-server.ts
// Offline. No socket, provider, model call or optional server package.
import { defineWorkflow } from "../src/workflow.ts";
import {
  createA2AClient,
  bearerToken,
  createMemoryRuns,
  createA2AServer,
  a2aSegments,
  createMemoryTaskStore,
  A2ATaskRejected,
} from "../src/a2a/index.ts";

const principal = { owner: "demo", actorId: "reader" };
const tasks = createMemoryTaskStore();
const workflow = defineWorkflow({
  id: "echo",
  version: "1",
  input: {
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    validate(value: unknown) {
      if (
        !value ||
        typeof value !== "object" ||
        !("text" in value) ||
        typeof value.text !== "string"
      )
        throw new TypeError("Pass an object with text to echo.");
      return { text: value.text };
    },
  },
  run: ({ text }, context) => context.step("echo", () => text),
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
  prepare(message) {
    const text = message.parts
      .map((part) => {
        if (part.kind !== "text") throw new A2ATaskRejected();
        return part.text;
      })
      .join("\n");
    return { text };
  },
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
