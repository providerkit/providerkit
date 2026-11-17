import { isTransient, type ErrorKind } from "@providerkit/core";
import { useEffect, useState } from "react";
import { BY_KIND } from "../lib/kinds.ts";

const examples = [
  { kind: "overload", label: "Provider is busy" },
  { kind: "quota", label: "Credits ran out" },
  { kind: "context", label: "Prompt is too long" },
] satisfies { kind: ErrorKind; label: string }[];

export default function TaskExample() {
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
    setKind(next);
    const url = new URL(window.location.href);
    url.searchParams.set("example", next);
    window.history.pushState(null, "", url);
  }

  const transient = isTransient(kind);
  return (
    <section className="task-example not-content" aria-labelledby="example-title" id="example">
      <div className="example-heading">
        <h2 id="example-title">Would waiting help?</h2>
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
