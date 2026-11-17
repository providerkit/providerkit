// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { FetchLike } from "@providerkit/core";
import { renderToStaticMarkup } from "react-dom/server";
import { defineAgent, type AgentEvent, type RunSnapshot, type TreeNode } from "@providerkit/agents";
import { defineWorkflow } from "@providerkit/agents/workflow";
import { scriptedProvider } from "@providerkit/agents/evals";
import {
  defineRemoteAgent,
  decodeA2AAgentCard,
  decodeA2ARpcRequest,
  encodeA2AEvent,
  encodeA2AResult,
  type A2AEvent,
  type RemoteSnapshot,
} from "@providerkit/agents/a2a";
import { createChatClient } from "../src/client.ts";
import { createAgentProjector } from "../src/agents.ts";
import { emptyChatView, parseChatEvent, reduceChat } from "../src/protocol.ts";
import { createAgUiReader, createAgUiWriter } from "../src/ag-ui.ts";
import { Message } from "../src/ui/message.tsx";

const dialect = { version: "1.0", binding: "JSONRPC" } as const;
const host = {
  beforeTool() {},
  beforeStep() {},
  authorizeResume() {},
  prepareRequest: () => ({
    scope: {
      actorId: "test",
      resource: { id: "test", version: "1" },
      expiresAt: Date.now() + 60_000,
    },
  }),
};
function remote(mode: "stream" | "question" | "unavailable") {
  const fetch = vi.fn<FetchLike>(async (input, init) => {
    const rpc = decodeA2ARpcRequest(await new Request(input, init).json(), "1.0");
    if (mode === "stream") {
      const events: A2AEvent[] = [
        {
          kind: "task",
          id: "PRIVATE_TASK",
          contextId: "PRIVATE_CONTEXT",
          status: { state: "working" },
          artifacts: [
            { artifactId: "PRIVATE_ARTIFACT", parts: [{ kind: "text", text: "Long answer" }] },
          ],
        },
        {
          kind: "artifact-update",
          taskId: "PRIVATE_TASK",
          contextId: "PRIVATE_CONTEXT",
          artifact: {
            artifactId: "PRIVATE_ARTIFACT",
            parts: [{ kind: "text", text: " plus more" }],
          },
          append: true,
        },
        {
          kind: "artifact-update",
          taskId: "PRIVATE_TASK",
          contextId: "PRIVATE_CONTEXT",
          artifact: {
            artifactId: "PRIVATE_ARTIFACT",
            parts: [
              { kind: "text", text: "Short" },
              { kind: "url", url: "https://private-file.test" },
            ],
          },
          append: false,
        },
        {
          kind: "status-update",
          taskId: "PRIVATE_TASK",
          contextId: "PRIVATE_CONTEXT",
          status: { state: "completed" },
          final: true,
        },
      ];
      return new Response(
        events
          .map(
            (event) =>
              `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: encodeA2AEvent(event, dialect) })}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (rpc.request.method !== "SendMessage") throw new Error("PRIVATE_NETWORK_ERROR");
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: encodeA2AResult(
        {
          method: "SendMessage",
          result: {
            kind: "task",
            id: "PRIVATE_TASK",
            contextId: "PRIVATE_CONTEXT",
            status:
              mode === "question"
                ? {
                    state: "input_required",
                    message: {
                      kind: "message",
                      messageId: "question",
                      role: "agent",
                      parts: [{ kind: "text", text: "PRIVATE_QUESTION" }],
                    },
                  }
                : { state: "working" },
            metadata: { callback: "https://private-callback.test" },
          },
        },
        dialect,
      ),
    });
  });
  return {
    fetch,
    agent: defineRemoteAgent({
      id: "peer",
      agentVersion: "1",
      ...dialect,
      updates: mode === "stream" ? "stream" : "poll",
      card: decodeA2AAgentCard(
        {
          name: "PRIVATE_CARD",
          description: "PRIVATE_DESCRIPTION",
          version: "1",
          capabilities: { streaming: true },
          defaultInputModes: ["text/plain"],
          defaultOutputModes: ["text/plain"],
          skills: [],
          supportedInterfaces: [
            {
              url: "https://private-peer.test/a2a",
              protocolVersion: "1.0",
              protocolBinding: "JSONRPC",
            },
          ],
        },
        "1.0",
      ),
      policy: { allow: (url) => url.origin === "https://private-peer.test" },
      fetch,
    }),
  };
}
function peer(node: TreeNode): RemoteSnapshot | undefined {
  if (node.kind === "remote") return node;
  const children = node.kind === "agent" ? node.delegations : node.steps;
  for (const entry of children)
    for (const child of entry.children) {
      const found = peer(child.snapshot);
      if (found) return found;
    }
  return undefined;
}
const settings = {
  runId: "root",
  messageId: "reply",
  labels: { agent: { peer: "Remote reader" } },
};
afterEach(() => vi.useRealTimers());

it("projects real mixed remote children and replaces complete artifact snapshots without model attempts", async () => {
  const fixture = remote("stream");
  const flow = defineWorkflow({
    id: "flow",
    version: "1",
    input: { schema: { type: "object" }, validate: () => null },
    agents: [fixture.agent],
    async run(_, context) {
      return (await context.agent("peer", fixture.agent, { input: "PRIVATE_INPUT" })).status;
    },
  });
  const agent = defineAgent({
    id: "root-agent",
    version: "1",
    instructions: "Offline",
    tools: [flow.asTool({ name: "work", description: "Work" })],
    provider: scriptedProvider([{ toolCalls: [{ name: "work" }] }, "Root answer"]),
  });
  const saved: RunSnapshot[] = [];
  const events: AgentEvent[] = [];
  const outcome = await agent.run("Go", {
    runId: "root",
    host: {
      ...host,
      checkpoint(node) {
        if (node.kind === "agent") saved.push(structuredClone(node));
      },
    },
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(
    outcome.status,
    JSON.stringify({ root: outcome.snapshot.state, peer: peer(outcome.snapshot)?.state }),
  ).toBe("completed");
  const projector = createAgentProjector(settings);
  const message = projector.snapshot(outcome.snapshot);
  expect(projector.inputs(outcome.snapshot)).toEqual([]);
  const child = peer(outcome.snapshot);
  if (!child) throw new Error("Missing remote child");
  expect(message.parts.find((part) => part.id === child.runId)).toMatchObject({
    type: "agent",
    kind: "remote",
    agentId: "peer",
    state: "completed",
    remoteState: "completed",
  });
  expect(message.parts.some((part) => part.type === "text" && part.agentId === child.runId)).toBe(
    false,
  );
  for (const secret of ["PRIVATE", "private-peer", "private-callback", "private-file"])
    expect(JSON.stringify(message)).not.toContain(secret);
  const visible = createAgentProjector({ ...settings, text: () => true });
  let view = emptyChatView();
  const texts: string[] = [];
  for (const snapshot of saved) {
    const message = visible.snapshot(snapshot);
    const event = {
      v: 1 as const,
      type: "snapshot" as const,
      messages: [message],
      run: visible.run(snapshot),
    };
    expect(parseChatEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    view = reduceChat(view, event);
    const part = view.messages[0]?.parts.find(
      (part) => part.type === "text" && part.agentId === child.runId,
    );
    if (part?.type === "text") {
      texts.push(part.text);
      expect(part.attempt).toBeUndefined();
    }
  }
  expect(texts).toContain("Long answer");
  expect(texts).toContain("Long answer plus more");
  expect(texts.at(-1)).toBe("Short[File: attachment]");
  expect(view.cursor).toBeUndefined();
  const live = createAgentProjector(settings);
  const display = events.flatMap((event) => live.event(event));
  expect(
    display.some(
      (event) =>
        event.type === "part" &&
        event.part.type === "agent" &&
        event.part.id === child.runId &&
        event.part.state === "running",
    ),
  ).toBe(true);
  expect(display.filter((event) => event.type === "part").at(-1)).toBeDefined();
  const liveView = display.reduce(reduceChat, emptyChatView());
  expect(liveView.messages[0]?.parts.find((part) => part.id === child.runId)).toMatchObject({
    kind: "remote",
    state: "completed",
  });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});

it("keeps remote requests private, projects saved wakes and does not call a local abort remote cancellation", async () => {
  const fixture = remote("question");
  const rootEvents: AgentEvent[] = [];
  const waiting = await fixture.agent.run("Go", {
    runId: "root",
    host,
    onEvent: (event) => {
      rootEvents.push(event);
    },
  });
  const remoteStatus = rootEvents.findIndex((event) => event.type === "remote_status");
  const rootLive = createAgentProjector(settings);
  expect(
    rootEvents
      .slice(0, remoteStatus + 1)
      .flatMap((event) => rootLive.event(event))
      .reduce(reduceChat, emptyChatView()).run,
  ).toMatchObject({ remoteState: "input_required" });
  expect(waiting.status).toBe("suspended");
  const projector = createAgentProjector(settings);
  expect(projector.snapshot(waiting.snapshot).parts).toContainEqual(
    expect.objectContaining({ type: "question", canAnswer: false, state: "pending" }),
  );
  expect(JSON.stringify(projector.snapshot(waiting.snapshot))).not.toContain("PRIVATE_QUESTION");
  expect(projector.inputs(waiting.snapshot)).toEqual([]);
  expect(projector.run(waiting.snapshot)).toMatchObject({
    status: "waiting",
    waitingFor: "response",
  });
  const permitted = createAgentProjector({
    ...settings,
    request: () => ({ title: "Which city?", freeText: true }),
  });
  expect(permitted.snapshot(waiting.snapshot).parts).toContainEqual(
    expect.objectContaining({ title: "Which city?", canAnswer: true }),
  );
  const rootStopped = await fixture.agent.resume(waiting.snapshot, {
    host,
    signal: AbortSignal.abort(),
  });
  const rootRun = projector.run(rootStopped.snapshot);
  expect(rootRun).toMatchObject({
    status: "stopped",
    remoteState: "input_required",
    error: { code: "remote_status_unknown" },
  });
  const rootWire = createAgUiWriter({
    binding: { threadId: "thread", agUiRunId: "wire-root", runId: "root", segment: "root-segment" },
  }).write({
    v: 1,
    type: "snapshot",
    messages: [projector.snapshot(rootStopped.snapshot)],
    run: rootRun,
  });
  expect(rootWire.events).toContainEqual(
    expect.objectContaining({ type: "RUN_ERROR", code: "remote_status_unknown" }),
  );
  expect(rootWire.events.some((event) => event.type === "RUN_FINISHED")).toBe(false);
  const controller = new AbortController();
  const agent = defineAgent({
    id: "parent",
    version: "1",
    instructions: "Offline",
    tools: [fixture.agent.asTool({ name: "consult", description: "Consult" })],
    provider: scriptedProvider([{ toolCalls: [{ name: "consult", arguments: { input: "Go" } }] }]),
  });
  const events: AgentEvent[] = [];
  const stopped = await agent.run("Go", {
    runId: "root",
    host,
    signal: controller.signal,
    onEvent(event) {
      events.push(event);
      if (event.type === "remote_status") controller.abort();
    },
  });
  expect(stopped.status).toBe("cancelled");
  const child = peer(stopped.snapshot);
  if (!child) throw new Error("Missing remote child");
  const projected = createAgentProjector(settings).snapshot(stopped.snapshot);
  const row = projected.parts.find((part) => part.id === child.runId);
  expect(row).toMatchObject({
    kind: "remote",
    state: "unknown",
    remoteState: "input_required",
    summary: expect.stringContaining("may still be working"),
  });
  expect(renderToStaticMarkup(<Message message={projected} />)).toContain("Status unknown");
  const live = createAgentProjector(settings);
  const view = events.flatMap((event) => live.event(event)).reduce(reduceChat, emptyChatView());
  expect(view.messages[0]?.parts.find((part) => part.id === child.runId)).toMatchObject({
    state: "unknown",
  });
  const binding = { threadId: "thread", agUiRunId: "wire", runId: "root", segment: "segment" };
  const written = createAgUiWriter({ binding }).write({
    v: 1,
    type: "snapshot",
    messages: [projected],
    run: { id: "root", status: "stopped" },
  });
  expect(
    written.events.some(
      (event) => event.type === "SUBAGENT_FINISHED" && event.subagentRunId === child.runId,
    ),
  ).toBe(false);
  const reader = createAgUiReader({ binding });
  expect(
    written.events.flatMap((event) => reader.read(event).events).reduce(reduceChat, emptyChatView())
      .messages[0]?.parts,
  ).toEqual(projected.parts);
  expect(written.issues.some((issue) => issue.code === "unsupported")).toBe(true);
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});

it("does not claim remote cancellation when the client closes its own reply stream", async () => {
  const client = createChatClient({
    transport: {
      send: async (_input, { signal }) => ({
        events: (async function* () {
          yield {
            v: 1 as const,
            type: "message" as const,
            message: {
              id: "reply",
              role: "assistant" as const,
              state: "live" as const,
              parts: [
                {
                  type: "agent" as const,
                  id: "peer-run",
                  agentId: "peer",
                  kind: "remote" as const,
                  state: "running" as const,
                  remoteState: "working" as const,
                  label: "Remote reader",
                },
              ],
            },
          };
          yield {
            v: 1 as const,
            type: "run" as const,
            run: { id: "root", status: "running" as const, messageId: "reply" },
          };
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        })(),
      }),
    },
  });
  await client.send("Go");
  await vi.waitFor(() => expect(client.getState().run.status).toBe("running"));
  await client.stop();
  expect(
    client.getState().messages.find((message) => message.id === "reply")?.parts[0],
  ).toMatchObject({ kind: "remote", state: "unknown", remoteState: "working" });
});

it("projects the remote observation wake without any local tool or model journal", async () => {
  vi.useFakeTimers();
  const fixture = remote("unavailable");
  const pending = fixture.agent.run("Go", { runId: "root", host });
  await vi.advanceTimersByTimeAsync(3100);
  const result = await pending;
  if (result.status !== "suspended" || result.wakeAt === undefined)
    throw new Error("Missing remote wake");
  const projector = createAgentProjector(settings);
  expect(projector.run(result.snapshot)).toMatchObject({
    status: "waiting",
    waitingFor: "continuation",
    wakeAt: result.wakeAt,
  });
  expect(projector.snapshot(result.snapshot).parts).toEqual([]);
  expect(projector.inputs(result.snapshot)).toEqual([]);
});
