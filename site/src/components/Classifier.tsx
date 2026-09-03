import { ProviderError, isBackupEligible, isTransient, type ErrorKind } from "@providerkit/core";
import { useMemo, useState } from "react";

type Family = "retry" | "acct" | "ours" | "ctx" | "none";

/** What each kind means for the caller — the only question an error answers. */
const FIX: Record<ErrorKind, { fix: string; family: Family }> = {
  aborted: { fix: "Nothing. The caller pressed Stop — this is not a failure.", family: "none" },
  timeout: { fix: "Retry. Our deadline fired, not their answer.", family: "retry" },
  network: { fix: "Retry. The request never reached them.", family: "retry" },
  overload: { fix: "Retry — or fall back to another model.", family: "retry" },
  rate: { fix: "Wait out the window, or rotate the key or model.", family: "retry" },
  quota: {
    fix: "Top up, or wait for the window to reset. Retrying will not help.",
    family: "acct",
  },
  entitlement: { fix: "Change the plan. A new key and a top-up both fail here.", family: "acct" },
  auth: { fix: "Fix the credential. Every retry lands the same.", family: "acct" },
  model: { fix: "Use a model this endpoint actually serves.", family: "ours" },
  context: { fix: "Send less. Compact the conversation — waiting fixes nothing.", family: "ctx" },
  content: { fix: "A safety filter caught the prompt or the answer.", family: "ours" },
  invalid: { fix: "Fix the request. This one is our bug.", family: "ours" },
  unknown: { fix: "Unrecognised. Surface the body and look at it.", family: "none" },
};

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

/** Real shapes, from real vendors. The point of the demo is that these root
 *  causes arrive under statuses that do not match what fixes them. */
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
  { label: "Socket died mid-flight", status: "", body: "fetch failed" },
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
    ? Object.assign(new Error(`${status} status code`), { status: Number(status), error: body })
    : new TypeError(body);
  return ProviderError.from("demo", raw);
}

export default function Classifier() {
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
      <div className="pk-chips">
        {SAMPLES.map((sample, index) => (
          <button
            key={sample.label}
            className="pk-chip"
            aria-pressed={active === index}
            onClick={() => pick(sample, index)}
          >
            {sample.label}
          </button>
        ))}
      </div>

      <div className="pk-demo">
        <div className="pk-panel">
          <div className="pk-field">
            <label htmlFor="pk-status">HTTP status — blank if it never got one</label>
            <input
              id="pk-status"
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
          <div className="pk-field">
            <label htmlFor="pk-body">Response body, or the thrown message</label>
            <textarea
              id="pk-body"
              rows={6}
              value={body}
              onChange={(e) => {
                setActive(-1);
                setBody(e.target.value);
              }}
            />
            <p className="pk-hint">
              Paste a real one. This runs the actual classifier from the package, in your browser —
              nothing is sent anywhere.
            </p>
          </div>
        </div>

        <div className="pk-verdict">
          <div className="pk-verdict-head">
            <span
              className="pk-kind"
              style={{ color: `var(--k-${familyVar})`, background: `var(--k-${familyVar}-bg)` }}
            >
              {err.kind}
            </span>
            <p className="pk-fix">{meaning.fix}</p>
          </div>
          <div>
            <div className="pk-row">
              <span>isTransient</span>
              <span className={isTransient(err.kind) ? "pk-yes" : "pk-no"}>
                {String(isTransient(err.kind))}
              </span>
            </div>
            <div className="pk-row">
              <span>isBackupEligible</span>
              <span className={isBackupEligible(err.kind) ? "pk-yes" : "pk-no"}>
                {String(isBackupEligible(err.kind))}
              </span>
            </div>
            <div className="pk-row">
              <span>retryAfterMs</span>
              <span className={err.retryAfterMs ? "pk-yes" : "pk-no"}>
                {err.retryAfterMs ?? "—"}
              </span>
            </div>
            <div className="pk-row">
              <span>status</span>
              <span className="pk-no">{err.status ?? "none"}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
