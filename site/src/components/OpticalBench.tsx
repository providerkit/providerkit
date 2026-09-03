import { ProviderError } from "@providerkit/core";
import { useId, useMemo, useState } from "react";
import { BY_KIND, FAMILIES, KINDS, type Family } from "../lib/kinds";

/*
  The classifier, drawn as the optical layout it actually is: scattered failures
  arrive at whatever angle they arrive at, one element sorts them, and what
  leaves is parallel, evenly spaced and named.

  Three rules the drawing has to keep:
    - Every exit lane is always present, unlit. You can see the whole taxonomy at
      once; the verdict is the one struck forward, not the only one shown.
    - The verdict's whole remedy band is raised with it, so a reader sees the
      neighbours — "this is a retry failure" reads before "this is `overload`".
    - Nothing depends on hue alone. Each band also owns a line style, and the
      readout names the remedy in words.
*/

const W = 1240;
const H = 480;
const AXIS_Y = 240;
const SRC_X = 306; /* where an incoming ray starts */
const LENS_X = 600;
const LENS_W = 56; /* thin, the way a layout plot draws an element on the axis */
const EXIT_X = 972; /* where the collimated beam leaves the plate */
const LANE_LABEL_X = 986;
const ROW = 24;
const LADDER_TOP = 36;

/** Line style per remedy band — the taxonomy has to survive without colour. */
const DASH: Record<Family, string | undefined> = {
  retry: "8 5",
  account: undefined,
  context: "12 3 3 3",
  ours: "2 5",
  inert: undefined,
};

const WEIGHT: Record<Family, number> = {
  retry: 1.25,
  account: 1.6,
  context: 1.25,
  ours: 1.25,
  inert: 0.75,
};

interface Sample {
  label: string;
  note: string;
  status: string;
  body: string;
  /** Where the ray enters. Scattered on purpose: the angle carries no meaning,
   *  which is the whole point — the status you arrive with does not either. */
  y: number;
}

/** Real shapes from real vendors. Every one of these files a root cause under a
 *  status that disagrees with what fixes it. */
const SAMPLES: Sample[] = [
  {
    label: "OpenAI",
    note: "429 · out of credit",
    status: "429",
    body: '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}',
    y: 44,
  },
  {
    label: "Anthropic",
    note: "529 · overloaded",
    status: "529",
    body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    y: 116,
  },
  {
    label: "Prompt too long",
    note: "400 · 213k > 200k",
    status: "400",
    body: '{"error":{"message":"prompt is too long: 213410 tokens > 200000 maximum"}}',
    y: 172,
  },
  {
    label: "Plan excludes the API",
    note: "403 · entitlement",
    status: "403",
    body: '{"error":{"message":"Your plan does not include API access"}}',
    y: 292,
  },
  {
    label: "Moonshot",
    note: "400 · 余额不足",
    status: "400",
    body: '{"error":{"message":"账户余额不足，请充值后重试"}}',
    y: 344,
  },
  {
    label: "Socket died mid-flight",
    note: "no status at all",
    status: "",
    body: "fetch failed",
    y: 396,
  },
  {
    label: "Gemini",
    note: "429 · retryDelay 48s",
    status: "429",
    body: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"48s"}]}}',
    y: 444,
  },
];

/** One row per line of the exit ladder: a band heading, then its kinds. */
const ROWS = FAMILIES.flatMap((band) => [
  { kind: null, family: band.family, label: band.label, note: band.note },
  ...KINDS.filter((k) => k.family === band.family).map((k) => ({
    kind: k.kind,
    family: k.family,
    label: k.kind,
    note: "",
  })),
]);

const LANE_Y = new Map(
  ROWS.map((row, i) => [row.kind ?? `band:${row.family}`, LADDER_TOP + i * ROW]),
);

function classifySample(status: string, body: string) {
  // No status means the response never arrived — the shape a dead socket really
  // throws, and exactly what the cause-chain walk exists for.
  const raw = status.trim()
    ? Object.assign(new Error(`${status} status code`), { status: Number(status), error: body })
    : new TypeError(body);
  return ProviderError.from("demo", raw);
}

export default function OpticalBench() {
  const [active, setActive] = useState(0);
  const [hover, setHover] = useState(-1);
  const [status, setStatus] = useState(SAMPLES[0]!.status);
  const [body, setBody] = useState(SAMPLES[0]!.body);
  const uid = useId();

  const err = useMemo(() => classifySample(status, body), [status, body]);
  const verdict = BY_KIND[err.kind];
  const band = FAMILIES.find((f) => f.family === verdict.family)!;
  const laneY = LANE_Y.get(verdict.kind)!;
  const sourceY = active >= 0 ? SAMPLES[active]!.y : AXIS_Y;

  const pick = (sample: Sample, index: number) => {
    setActive(index);
    setStatus(sample.status);
    setBody(sample.body);
  };

  const edit = (next: () => void) => {
    setActive(-1);
    next();
  };

  return (
    <>
      <figure className="bench-plate">
        <div className="bench-scroll">
          <svg
            className="bench-svg"
            viewBox={`0 0 ${W} ${H}`}
            role="group"
            aria-label="Optical bench: seven provider failures entering, thirteen named exits leaving"
          >
            {/* The optical axis. Dash-dot, as every layout plot draws it. */}
            <line className="ax" x1="0" y1={AXIS_Y} x2={W} y2={AXIS_Y} strokeDasharray="14 5 2 5" />

            {/* Rays first, and never interactive: a diagonal line's bounding box
                is a huge swath of the plate, and seven of them overlap. The
                label strip below is the button, so every hit area is its own
                tidy rectangle. */}
            {SAMPLES.map((sample, i) => (
              <line
                key={`ray-${sample.label}`}
                className={`ray ${i === active ? "on" : ""} ${i === hover ? "near" : ""}`}
                x1={SRC_X}
                y1={sample.y}
                x2={LENS_X}
                y2={AXIS_Y}
                style={i === active ? { color: `var(--ray-${verdict.family})` } : undefined}
              />
            ))}

            {/* A pasted body enters on the axis — your own input, dead centre. */}
            {active < 0 && (
              <>
                <line
                  className="ray on"
                  x1={SRC_X}
                  y1={AXIS_Y}
                  x2={LENS_X}
                  y2={AXIS_Y}
                  style={{ color: `var(--ray-${verdict.family})` }}
                />
                <g className="src on" style={{ color: `var(--ray-${verdict.family})` }}>
                  {/* Break the axis for the label, the way a drawing does. */}
                  <rect className="src-break" x="150" y={AXIS_Y - 17} width="146" height="34" />
                  <text className="src-label" x="288" y={AXIS_Y - 3} textAnchor="end">
                    your paste
                  </text>
                  <text className="src-note" x="288" y={AXIS_Y + 12} textAnchor="end">
                    {status.trim() ? `${status} · pasted` : "no status · pasted"}
                  </text>
                  <line className="src-tick" x1={SRC_X} y1={AXIS_Y - 7} x2={SRC_X} y2={AXIS_Y + 7} />
                </g>
              </>
            )}

            {SAMPLES.map((sample, i) => {
              const on = i === active;
              return (
                <g
                  key={sample.label}
                  className={`src ${on ? "on" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  aria-label={`${sample.label}, ${sample.note}`}
                  onClick={() => pick(sample, i)}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(-1)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(-1)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      pick(sample, i);
                    }
                  }}
                  style={on ? { color: `var(--ray-${verdict.family})` } : undefined}
                >
                  <rect className="src-hit" x="8" y={sample.y - 18} width={SRC_X - 4} height="36" />
                  <text className="src-label" x="288" y={sample.y - 3} textAnchor="end">
                    {sample.label}
                  </text>
                  <text className="src-note" x="288" y={sample.y + 12} textAnchor="end">
                    {sample.note}
                  </text>
                  <line
                    className="src-tick"
                    x1={SRC_X}
                    y1={sample.y - 7}
                    x2={SRC_X}
                    y2={sample.y + 7}
                  />
                </g>
              );
            })}

            {/* The element. The brand mark's own geometry, opened to the full
                aperture — a collimator is drawn spanning the beam it collimates. */}
            <path
              className="lens"
              d={`M${LENS_X} 24 Q${LENS_X + LENS_W} ${AXIS_Y} ${LENS_X} 456 Q${LENS_X - LENS_W} ${AXIS_Y} ${LENS_X} 24 Z`}
            />

            {/* The exit ladder. Every lane always present; the verdict's band
                raised; the verdict itself struck forward as a beam bundle. */}
            {ROWS.map((row) => {
              const y = LANE_Y.get(row.kind ?? `band:${row.family}`)!;
              const inBand = row.family === verdict.family;
              const lit = row.kind === verdict.kind;
              const state = lit ? "lit" : inBand ? "near" : "off";

              if (!row.kind) {
                return (
                  <g key={`band-${row.family}`} className={`band ${state}`}>
                    <text
                      className="band-label"
                      x={LANE_LABEL_X}
                      y={y + 4}
                      style={{ fill: `var(--ray-${row.family})` }}
                    >
                      {row.label}
                    </text>
                    <text className="band-note" x={LANE_LABEL_X + 78} y={y + 4}>
                      {row.note}
                    </text>
                  </g>
                );
              }

              return (
                <g key={row.kind} className={`lane ${state}`}>
                  <line
                    className="lane-line"
                    x1={LENS_X}
                    y1={y}
                    x2={EXIT_X}
                    y2={y}
                    stroke={`var(--ray-${row.family})`}
                    strokeDasharray={DASH[row.family]}
                    strokeWidth={WEIGHT[row.family]}
                  />
                  <text className="lane-label" x={LANE_LABEL_X} y={y + 4}>
                    {row.label}
                  </text>
                </g>
              );
            })}

            {/* The struck beam. Three hairlines rather than one heavy stroke:
                emphasis from line frequency, so no extra hue is spent on it. */}
            <g
              /* Remounting on a new verdict is what replays the trace: the ray is
                 drawn again rather than sliding to a new position. */
              key={`${verdict.kind}:${sourceY}`}
              className="beam"
              style={{ color: `var(--ray-${verdict.family})` }}
            >
              {[-2.6, 0, 2.6].map((d) => (
                <line
                  key={d}
                  x1={LENS_X}
                  y1={laneY + d}
                  x2={EXIT_X}
                  y2={laneY + d}
                  strokeWidth="1"
                />
              ))}
              <circle cx={EXIT_X} cy={laneY} r="3.5" />
            </g>
          </svg>
        </div>
        <p className="bench-hint">Wider than this screen — scroll the plate sideways.</p>
        <figcaption className="leader">
          <span>
            Fig. 1 — the real classifier from the package, running in your browser. Click a ray, or
            paste your own failure below.
          </span>
        </figcaption>
      </figure>

      <div className="bench-console">
        <div className="console-in">
          <p className="leader">
            <span>Input</span>
          </p>
          <div className="field">
            <label htmlFor={`${uid}-status`}>HTTP status — leave blank if it never got one</label>
            <input
              id={`${uid}-status`}
              type="text"
              inputMode="numeric"
              placeholder="(none)"
              value={status}
              onChange={(e) => edit(() => setStatus(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-body`}>Response body, or the message that was thrown</label>
            <textarea
              id={`${uid}-body`}
              rows={5}
              value={body}
              onChange={(e) => edit(() => setBody(e.target.value))}
            />
          </div>
          <p className="field-note">
            Paste a real one. Nothing is sent anywhere — this is the package running locally.
          </p>
        </div>

        <div
          className="console-out"
          style={{ ["--ray" as string]: `var(--ray-${verdict.family})` }}
        >
          <p className="leader">
            <span>Verdict</span>
          </p>
          <p className="verdict-kind" aria-live="polite">
            <span className="verdict-mark" />
            {verdict.kind}
            <span className="verdict-band">
              {band.label.toLowerCase()} — {band.note}
            </span>
          </p>
          <p className="verdict-fix">{verdict.fix}</p>
          <dl className="readout">
            <div>
              <dt>isTransient</dt>
              <dd>{String(verdict.isTransient)}</dd>
            </div>
            <div>
              <dt>isBackupEligible</dt>
              <dd>{String(verdict.isBackupEligible)}</dd>
            </div>
            <div>
              <dt>retryAfterMs</dt>
              <dd>{err.retryAfterMs ?? "—"}</dd>
            </div>
            <div>
              <dt>status</dt>
              <dd>{err.status ?? "none"}</dd>
            </div>
          </dl>
        </div>
      </div>
    </>
  );
}
