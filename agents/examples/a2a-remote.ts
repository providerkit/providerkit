/** Offline A2A specialist. Run with: bun agents/examples/a2a-remote.ts */
import { strict as assert } from "node:assert";
import {
  defineRemoteAgent,
  decodeA2AAgentCard,
  decodeA2ARpcRequest,
  encodeA2AResult,
} from "../src/a2a/index.ts";
import { checkChildProgress, equalData } from "../src/snapshot.ts";
import type { AgentHost, TreeNode } from "../src/types.ts";

const endpoint = "https://offline.example/a2a";
const dialect = { version: "1.0", binding: "JSONRPC" } as const;
let sends = 0;
const remote = defineRemoteAgent({
  id: "offline-helper",
  agentVersion: "1",
  ...dialect,
  card: decodeA2AAgentCard(
    {
      name: "Offline helper",
      version: "1",
      capabilities: {},
      supportedInterfaces: [{ url: endpoint, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    },
    "1.0",
  ),
  policy: { allow: (url) => url.href === endpoint },
  // No socket, provider or application storage. The real client still encodes and decodes.
  async fetch(input, init) {
    const request = new Request(input, init);
    const { id, request: call } = decodeA2ARpcRequest(await request.json(), "1.0");
    assert.equal(call.method, "SendMessage");
    sends++;
    const result = encodeA2AResult(
      {
        method: "SendMessage",
        result: {
          kind: "task",
          id: "peer-task",
          contextId: "peer-context",
          status: { state: "completed" },
          artifacts: [{ artifactId: "answer", parts: [{ kind: "text", text: "Done" }] }],
        },
      },
      dialect,
    );
    return Response.json({ jsonrpc: "2.0", id, result });
  },
});

// This example has one trusted caller and one registered endpoint. A real host must also
// check its authenticated owner, current lease and permission to send the actual message.
const saved = new Map<string, TreeNode>();
const host = {
  beforeTool(call) {
    if (
      call.agentId !== remote.id ||
      call.version !== remote.version ||
      call.call.name !== "remote_send"
    )
      throw new Error("This example authorizes only its configured remote send.");
  },
  checkpoint(snapshot) {
    const previous = saved.get(snapshot.runId);
    if (previous) checkChildProgress(previous, snapshot);
    saved.set(snapshot.runId, structuredClone(snapshot));
  },
  authorizeResume(snapshot) {
    if (!equalData(saved.get(snapshot.runId), snapshot))
      throw new Error("Resume only the authoritative saved snapshot.");
  },
} satisfies AgentHost;

async function askRemote(input: string) {
  const result = await remote.run(input, { host });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("Expected the fixture result.");
  assert.equal(result.receipts[0]?.billing, "unknown");
  await remote.resume(result.snapshot, { host });
  assert.equal(sends, 1);
  return result.output;
}

console.log(await askRemote("Hello"));
