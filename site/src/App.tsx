import { useMemo, useState } from "react";
import { ProviderError, isBackupEligible, isTransient, type ErrorKind } from "@providerkit/core";

const REPO = "https://github.com/providerkit/providerkit";
const NPM = "https://www.npmjs.com/package/providerkit";

/** What each kind means for the caller — the only question an error answers. */
const FIX: Record<ErrorKind, { fix: string; family: Family }> = {
  aborted: { fix: "Nothing. The caller pressed Stop — this is not a failure.", family: "none" },
  timeout: { fix: "Retry. Our deadline fired, not their answer.", family: "retry" },
  network: { fix: "Retry. The request never reached them.", family: "retry" },
  overload: { fix: "Retry — or fall back to another model.", family: "retry" },
  rate: { fix: "Wait out the window, or rotate the key or model.", family: "retry" },
  quota: { fix: "Top up, or wait for the window to reset. Retrying will not help.", family: "acct" },
  entitlement: { fix: "Change the plan. A new key and a top-up both fail here.", family: "acct" },
  auth: { fix: "Fix the credential. Every retry lands the same.", family: "acct" },
  model: { fix: "Use a model this endpoint actually serves.", family: "ours" },
  context: { fix: "Send less. Compact the conversation — waiting fixes nothing.", family: "ctx" },
  content: { fix: "A safety filter caught the prompt or the answer.", family: "ours" },
  invalid: { fix: "Fix the request. This one is our bug.", family: "ours" },
  unknown: { fix: "Unrecognised. Surface the body and look at it.", family: "none" },
};

type Family = "retry" | "acct" | "ours" | "ctx" | "none";
const FAMILY_VAR: Record<Family, string> = {
  retry: "retry",
  acct: "account",
  ours: "ours",
  ctx: "context",
  none: "none",
};

interface Sample {
  label: string;
  status: string;
  body: string;
}

/** Real shapes, from real vendors. The point of the demo is that these five
 *  root causes arrive under five different statuses. */
const SAMPLES: Sample[] = [
  {
    label: "OpenAI · out of credit",
    status: "429",
    body: '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}',
  },
  {
    label: "Anthropic · overloaded",
    status: "529",
    body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  },
  {
    label: "Prompt too long",
    status: "400",
    body: '{"error":{"message":"prompt is too long: 213410 tokens > 200000 maximum"}}',
  },
  {
    label: "Plan excludes the API",
    status: "403",
    body: '{"error":{"message":"Your plan does not include API access"}}',
  },
  {
    label: "Moonshot · 余额不足",
    status: "400",
    body: '{"error":{"message":"账户余额不足，请充值后重试"}}',
  },
  {
    label: "Socket died mid-flight",
    status: "",
    body: "fetch failed",
  },
  {
    label: "Gemini · throttled",
    status: "429",
    body: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"48s"}]}}',
  },
];

function classifySample(status: string, body: string) {
  // No status means the request never got a response — the shape a dead socket
  // actually throws, which is exactly what the cause-chain walk is for.
  const raw = status.trim()
    ? Object.assign(new Error(`${status} status code`), {
        status: Number(status),
        error: body,
      })
    : new TypeError(body);
  return ProviderError.from("demo", raw);
}

function Classifier() {
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState(SAMPLES[0]!.status);
  const [body, setBody] = useState(SAMPLES[0]!.body);

  const err = useMemo(() => classifySample(status, body), [status, body]);
  const meaning = FIX[err.kind];
  const familyVar = FAMILY_VAR[meaning.family];

  const pick = (sample: Sample, index: number) => {
    setActive(index);
    setStatus(sample.status);
    setBody(sample.body);
  };

  return (
    <>
      <div className="chips">
        {SAMPLES.map((sample, index) => (
          <button
            key={sample.label}
            className="chip"
            aria-pressed={active === index}
            onClick={() => pick(sample, index)}
          >
            {sample.label}
          </button>
        ))}
      </div>

      <div className="demo">
        <div className="panel">
          <div className="field">
            <label htmlFor="status">HTTP status — blank if it never got one</label>
            <input
              id="status"
              type="text"
              value={status}
              inputMode="numeric"
              placeholder="(none)"
              onChange={(e) => {
                setActive(-1);
                setStatus(e.target.value);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="body">Response body, or the thrown message</label>
            <textarea
              id="body"
              rows={6}
              value={body}
              onChange={(e) => {
                setActive(-1);
                setBody(e.target.value);
              }}
            />
            <p className="hint">
              Paste a real one. This runs the actual classifier from the package, in your
              browser — nothing is sent anywhere.
            </p>
          </div>
        </div>

        <div className="verdict">
          <div className="verdict-head">
            <span
              className="kind"
              style={{
                color: `var(--k-${familyVar})`,
                background: `var(--k-${familyVar}-bg)`,
              }}
            >
              {err.kind}
            </span>
            <p className="fix">{meaning.fix}</p>
          </div>
          <div className="rows">
            <div className="row">
              <span>isTransient</span>
              <span className={isTransient(err.kind) ? "yes" : "no"}>
                {String(isTransient(err.kind))}
              </span>
            </div>
            <div className="row">
              <span>isBackupEligible</span>
              <span className={isBackupEligible(err.kind) ? "yes" : "no"}>
                {String(isBackupEligible(err.kind))}
              </span>
            </div>
            <div className="row">
              <span>retryAfterMs</span>
              <span className={err.retryAfterMs ? "yes" : "no"}>
                {err.retryAfterMs ?? "—"}
              </span>
            </div>
            <div className="row">
              <span>status</span>
              <span className="no">{err.status ?? "none"}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** A small TS highlighter. Earns its place: code is the page's main content,
 *  and a whole syntax library does not, for four blocks. */
function Code({ children }: { children: string }) {
  const html = children
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
    .replace(/(\/\/[^\n]*)/g, '<span class="tok-com">$1</span>')
    .replace(/("(?:[^"\\]|\\.)*")/g, '<span class="tok-str">$1</span>')
    .replace(
      /\b(import|from|const|let|await|for|of|if|else|return|new|type|export|async|function|try|catch)\b/g,
      '<span class="tok-key">$1</span>',
    )
    .replace(/\b([a-zA-Z_$][\w$]*)(?=\()/g, '<span class="tok-fn">$1</span>');
  return (
    <pre>
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

function Install() {
  const [copied, setCopied] = useState(false);
  const command = "bun add @providerkit/core";
  return (
    <button
      className="install"
      onClick={() => {
        void navigator.clipboard?.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      <span>$ {command}</span>
      <span className="copied">{copied ? "copied" : "copy"}</span>
    </button>
  );
}

const BREAKS = [
  {
    t: "The stream that never ends",
    d: "A provider accepts the request and then sends nothing. Every SDK's default is to wait forever, and the symptom is the worst kind: none at all.",
  },
  {
    t: "The socket four levels down",
    d: "A dead connection carries no HTTP status, and the useful code sits on cause.cause.cause. Miss it and every network blip reads as permanent.",
  },
  {
    t: "One cause, five statuses",
    d: "Running out of credit arrives as 429, 402, 403 and 400 depending on the vendor. Status alone tells you to retry an empty balance.",
  },
  {
    t: "The 429 that is really a full prompt",
    d: "Waiting fixes a throttle and does nothing for an overflowing context window. They arrive under the same status.",
  },
  {
    t: "Cache tokens, counted twice",
    d: "Anthropic reports cache reads outside the input count; OpenAI reports them inside it. Hand both through unreconciled and the same conversation costs two different things.",
  },
  {
    t: "The answer that was already there",
    d: "A turn cut off at its output ceiling leaves invalid JSON — and a run reports nothing while the answer sits in the fragments.",
  },
];

export function App() {
  return (
    <>
      <header>
        <div className="wrap">
          <a className="brand" href="/">
            provider<span>kit</span>
          </a>
          <nav>
            <a href="#breaks">Why</a>
            <a href="#try">Try it</a>
            <a href="#use">Use</a>
            <a href={REPO}>GitHub</a>
          </nav>
        </div>
      </header>

      <div className="hero">
        <div className="wrap">
          <h1>The layer under your agent loop.</h1>
          <p className="lede">
            One seam for every LLM provider — plus <strong>the failure handling you only
            learn in production</strong>. Not a framework: no loop, no prompts, no graph.
            Your loop is where your product lives.
          </p>
          <div className="cta">
            <Install />
            <a className="btn primary" href="#try">
              Try the classifier
            </a>
            <a className="btn ghost" href={REPO}>
              GitHub
            </a>
          </div>
          <div className="meta">
            <span>zero runtime dependencies</span> <i>·</i> <span>fetch only</span> <i>·</i>{" "}
            <span>Bun · Node · Workers · Deno · MV3</span> <i>·</i> <span>MIT</span>
          </div>
        </div>
      </div>

      <section id="breaks">
        <div className="wrap">
          <p className="eyebrow">What actually breaks</p>
          <h2>The interface is the easy part.</h2>
          <p className="sub">
            Most "unified LLM interface" libraries stop at the interface. That is not where
            the time goes. This is where the time goes.
          </p>
          <div className="grid">
            {BREAKS.map((b) => (
              <div className="cell" key={b.t}>
                <h3>{b.t}</h3>
                <p>{b.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="try">
        <div className="wrap">
          <p className="eyebrow">Live</p>
          <h2>Every failure, named by what fixes it.</h2>
          <p className="sub">
            The classifier is pure, so it runs right here. Pick a real provider failure — or
            paste your own — and see the answer to the only question an error has:{" "}
            <em>what do I do now?</em>
          </p>
          <Classifier />
        </div>
      </section>

      <section id="use">
        <div className="wrap">
          <p className="eyebrow">Use</p>
          <h2>Small surface. Boring on purpose.</h2>
          <p className="sub">
            One provider interface, one error type, and the handful of primitives a loop
            actually needs underneath it.
          </p>
          <div className="two-up">
            <Code>{`import { createAnthropicProvider } from "@providerkit/core";

const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-sonnet-5",
});

for await (const chunk of provider.createStream(
  messages, tools, { effort: "medium" }
)) {
  if (chunk.content) write(chunk.content);
  // one usage shape across every provider
  if (chunk.usage) record(chunk.usage);
}`}</Code>
            <Code>{`import {
  ProviderError, isTransient, isBackupEligible,
} from "@providerkit/core";

try { /* ... */ } catch (raw) {
  const err = ProviderError.from("anthropic", raw);

  if (err.kind === "context") return compactAndRetry();
  if (isBackupEligible(err.kind)) return otherModel();
  if (isTransient(err.kind)) return retry(err.retryAfterMs);
  surface(err); // .body has their actual words
}`}</Code>
          </div>
        </div>
      </section>

      <section className="origin">
        <div className="wrap">
          <p className="eyebrow">Origin</p>
          <h2>Five codebases learned this separately.</h2>
          <p>
            providerkit was extracted from five production codebases that had each
            independently grown the same layer — <strong>about 9,100 lines solving one
            ~2,000-line problem</strong>. They had three separate 60-second idle watchdogs,
            identical down to the constant. On one day in September 2026, two of them
            shipped the same five fixes independently.
          </p>
          <p>
            They had also each learned a <strong>different</strong> part of it. One walked
            the cause chain for dead sockets. One parsed Gemini's RetryInfo. One read the
            body before the status and knew the quota wordings in five languages. One knew
            Anthropic's 529 and when a failure is worth a different model. One could rescue
            an answer from a tool call the model truncated.
          </p>
          <div className="stat-row">
            <div className="stat">
              <b>5</b>
              <span>codebases pooled</span>
            </div>
            <div className="stat">
              <b>13</b>
              <span>failure kinds, by their fix</span>
            </div>
            <div className="stat">
              <b>0</b>
              <span>runtime dependencies</span>
            </div>
          </div>
          <p style={{ marginTop: 28 }}>
            The classifier here is the union of all five, and the test suite is every failure
            any of them ever saw. That is the part worth having.
          </p>
        </div>
      </section>

      <footer className="wrap">
        <span>MIT · built from production scar tissue</span>
        <span>
          <a href={REPO}>GitHub</a> · <a href={NPM}>npm</a>
        </span>
      </footer>
    </>
  );
}
