import { isTransient, type ErrorKind } from "@providerkit/core";
import { Component, lazy, Suspense, useEffect, useReducer, useState, type ReactNode } from "react";
import demoStyles from "../styles/chat-demo.css?url";
import { BY_KIND } from "../lib/kinds.ts";

const examples = [
  { kind: "overload", label: "Provider is busy" },
  { kind: "quota", label: "Credits ran out" },
  { kind: "context", label: "Prompt is too long" },
] satisfies { kind: ErrorKind; label: string }[];

const AgentDemo = lazy(() => import("./AgentDemo.tsx"));
const ChatDemo = lazy(() => import("./ChatDemo.tsx"));
type Task = "errors" | "agents" | "chat";
const tasks: { id: Task; label: string }[] = [
  { id: "errors", label: "Handle an error" },
  { id: "agents", label: "Run a task" },
  { id: "chat", label: "Build a chat" },
];

class DemoBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed)
      return (
        <p role="alert">
          The example could not load. Check your connection, then{" "}
          <button className="demo-reload" type="button" onClick={() => window.location.reload()}>
            reload this page
          </button>
          .
        </p>
      );
    return this.props.children;
  }
}

export function DemoPanel({ task }: { task: Task }) {
  if (task === "errors") return <CoreExample />;
  return (
    <DemoBoundary key={task}>
      <Suspense fallback={<p role="status">Loading the example...</p>}>
        <link rel="stylesheet" href={demoStyles} precedence="demo" />
        {task === "agents" ? <AgentDemo /> : <ChatDemo />}
      </Suspense>
    </DemoBoundary>
  );
}

export default function TaskExample() {
  // Keep an opened chat mounted: if the tab cannot save a draft, its only copy is in the composer.
  const [{ task, openedChat }, setTask] = useReducer(
    (previous: { task: Task; openedChat: boolean }, next: Task) => ({
      task: next,
      openedChat: previous.openedChat || next === "chat",
    }),
    { task: "errors", openedChat: false },
  );
  useEffect(() => {
    const restoreTask = () => {
      const requested = new URLSearchParams(window.location.search).get("task");
      setTask(tasks.find((item) => item.id === requested)?.id ?? "errors");
    };
    restoreTask();
    window.addEventListener("popstate", restoreTask);
    return () => window.removeEventListener("popstate", restoreTask);
  }, []);
  function selectTask(next: Task) {
    if (task === next) return;
    const url = new URL(window.location.href);
    url.searchParams.set("task", next);
    window.history.pushState(null, "", url);
    setTask(next);
  }
  return (
    <section className="task-example not-content" aria-labelledby="example-title" id="example">
      <h2 id="example-title">Try a task</h2>
      <div className="example-choices" aria-label="Example task">
        {tasks.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={task === item.id}
            onClick={() => selectTask(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {task !== "chat" && <DemoPanel task={task} />}
      {openedChat && (
        <div hidden={task !== "chat"}>
          <DemoPanel task="chat" />
        </div>
      )}
    </section>
  );
}

function CoreExample() {
  const [kind, setKind] = useState<ErrorKind>("overload");
  useEffect(() => {
    const restore = () => {
      const requested = new URLSearchParams(window.location.search).get("example");
      setKind(examples.find((example) => example.kind === requested)?.kind ?? "overload");
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  function select(next: ErrorKind) {
    if (kind === next) return;
    setKind(next);
    const url = new URL(window.location.href);
    url.searchParams.set("example", next);
    window.history.pushState(null, "", url);
  }

  const transient = isTransient(kind);
  return (
    <section className="core-task-example not-content" aria-labelledby="core-example-title">
      <div className="example-heading">
        <h3 id="core-example-title">Would waiting help?</h3>
        <p>A Core example. Choose a failure to run the real function in your browser.</p>
      </div>
      <div className="example-choices" aria-label="Example failure">
        {examples.map((example) => (
          <button
            key={example.kind}
            type="button"
            aria-pressed={kind === example.kind}
            onClick={() => select(example.kind)}
          >
            {example.label}
          </button>
        ))}
      </div>
      <div className="example-workspace">
        <div>
          <p className="example-label">Call</p>
          <pre>
            <code>{`isTransient("${kind}")`}</code>
          </pre>
          <p>
            <a href="/guides/errors/#try-it-in-your-code">Import and setup</a>
          </p>
        </div>
        <div className="example-result" aria-live="polite" aria-atomic="true">
          <p className="example-label">Result</p>
          <output>{String(transient)}</output>
          <p>
            {transient
              ? "This kind of failure can pass with time."
              : "Waiting alone will not fix this."}
          </p>
          <p>{BY_KIND[kind].fix}</p>
        </div>
      </div>
      <p className="example-note">
        No API key or network call. A transient kind is not permission to replay a request.{" "}
        <a href="/guides/retries/">Read the retry rules.</a>
      </p>
      <a className="action-link" href="/demos/errors/">
        Try the full error classifier
      </a>
    </section>
  );
}
