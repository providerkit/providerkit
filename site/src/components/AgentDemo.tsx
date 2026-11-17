import { useEffect, useReducer, useRef, useState } from "react";
import { defineTool, type Provider } from "@providerkit/core";
import { defineAgent } from "@providerkit/agents";
import { createAgentProjector } from "@providerkit/react/agents";
import { emptyChatView, reduceChat } from "@providerkit/react/protocol";
import { Message } from "@providerkit/react/ui";

const TASKS = ["Write a release note", "Check the documentation link"];
const provider: Provider = {
  id: "site-sample",
  model: "scripted",
  async *createStream(messages, _tools, options = {}) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    options.signal?.throwIfAborted();
    const tool = messages.findLast((message) => message.role === "tool");
    if (tool) {
      yield { type: "delta", content: `Found ${TASKS.length} sample tasks:\n${tool.content}` };
      yield { type: "finish", finishReason: "stop" };
    } else {
      yield {
        type: "delta",
        toolCalls: [{ index: 0, id: "sample-read", name: "list_tasks", arguments: "{}" }],
      };
      yield { type: "finish", finishReason: "tool_calls" };
    }
  },
};
export const assistant = defineAgent({
  id: "site-task-demo",
  version: "1",
  instructions: "List the sample tasks using the registered tool.",
  provider,
  tools: [
    defineTool({
      name: "list_tasks",
      description: "Read this demo's two sample tasks.",
      inputSchema: { type: "object" },
      isReadOnly: true,
      async run(_input, { signal }) {
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        signal?.throwIfAborted();
        return TASKS;
      },
      summarize: (tasks) => tasks.join("\n"),
    }),
  ],
});

export default function AgentDemo() {
  const [view, dispatch] = useReducer(reduceChat, undefined, emptyChatView);
  const [state, setState] = useState<"idle" | "running" | "stopping">("idle");
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      const controller = active.current;
      active.current = undefined;
      controller?.abort();
    },
    [],
  );

  async function run() {
    if (active.current) return;
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      setError(
        "This example needs a secure connection. Open it over HTTPS or on localhost, then try again.",
      );
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setState("running");
    setError(undefined);
    try {
      const runId = crypto.randomUUID();
      const messageId = `demo-${runId}`;
      const projector = createAgentProjector({
        runId,
        messageId,
        agentId: assistant.id,
        labels: { tool: { list_tasks: "Read sample tasks" } },
      });
      dispatch({
        v: 1,
        type: "snapshot",
        messages: [],
        run: { id: runId, status: "running", messageId },
      });
      const result = await assistant.run("List the tasks.", {
        runId,
        signal: controller.signal,
        host: {
          beforeTool(request) {
            if (request.call.name !== "list_tasks")
              throw new Error("Only the sample read is allowed.");
          },
        },
        onEvent(event) {
          if (active.current !== controller) return;
          for (const update of projector.event(event)) dispatch(update);
        },
      });
      if (active.current === controller) {
        dispatch({
          v: 1,
          type: "snapshot",
          messages: [projector.snapshot(result.snapshot)],
          run: projector.run(result.snapshot),
        });
      }
    } catch {
      if (active.current === controller)
        setError("The local example could not finish. Try running it again.");
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        setState("idle");
      }
    }
  }

  function stop() {
    setState("stopping");
    active.current?.abort();
  }

  return (
    <div className="package-demo not-content">
      <p>
        A scripted provider asks a real SDK tool for two sample tasks. No API key, network request
        or paid model. Switching examples ends this local run.
      </p>
      <div className="example-workspace">
        <div>
          <p className="example-label">Call</p>
          <pre>
            <code>await assistant.run("List the tasks.")</code>
          </pre>
          <div className="demo-actions">
            <button type="button" disabled={state !== "idle"} onClick={() => void run()}>
              {state === "idle" ? "Run the example" : "Running..."}
            </button>
            {state !== "idle" && (
              <button type="button" disabled={state === "stopping"} onClick={stop}>
                {state === "stopping" ? "Stopping..." : "Stop"}
              </button>
            )}
          </div>
          <p>
            <a href="/agents/getting-started/">Import and setup</a>
          </p>
        </div>
        <div className="chat-demo" aria-live="polite" aria-busy={state !== "idle"}>
          <p className="example-label">Result</p>
          {!view.messages.length && (
            <p>
              {state === "idle"
                ? "Run the example to see tool activity and the answer."
                : "Starting the sample task..."}
            </p>
          )}
          {view.messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
          {view.run.status === "stopped" && (
            <p>The local run stopped. Run it again when you are ready.</p>
          )}
          {view.run.error && (
            <p role="alert">{view.run.error.message} Run the example again to retry.</p>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      </div>
      <p className="example-note">
        In an app, run privileged tools on your server and project only authorized display data.{" "}
        <a href="/agents/tools/">Read the tool rules</a>.
      </p>
    </div>
  );
}
