# Design

providerkit.dev is drawn as an **optical bench**: a technical layout plot for LLM failure.

This document is written from the built site, not before it. It records what the world is, why
each rule exists, and what would break it. The direction brief that produced it lives in
`site/.impeccable/surfaces/site-src-content-docs-index-mdx.md`; this is the maintenance record.

---

## The thesis

Optics has named its defects by their correction for two centuries — spherical, coma,
astigmatism, chromatic — and diagnosed them with spot diagrams and ray fans. providerkit names
thirteen failures by what fixes each one. The parallel is not decoration: it is the same
intellectual move, and the site is built as the instrument that performs it.

The package's mark is a **collimator** — rays enter at scattered angles, pass one element, leave
parallel and evenly spaced. That is the library's function drawn literally, and the landing page
is that mark at full scale, running the real classifier.

### What this world refuses

The category default for a developer tool in 2026 is: near-black ground, one neon accent,
identical rounded cards, tracked ALL-CAPS eyebrows, middle-dot meta strings. The previous
implementation of this site shipped every one of them. None survives.

- **No cards.** No shared radius applied to every surface. Grouping comes from density and
  rules that mean something.
- **No eyebrows.** Drafting has its own label grammar — a leader line to its referent, a
  dimensioned callout — and that grammar is used instead.
- **No decorative rule.** Every line on the page carries drafting semantics: a centreline, a
  dimension, a witness, a leader. A rule that only separates two things is removed.
- **No shadows.** `box-shadow` is `none` throughout. Depth comes from paper value.
- **No colour-only state.** Every failure family is legible without hue.

---

## Ground and wavelength

Two palettes, one role set. Dark is the default and is an **anodized lab bench**, never a void;
light is **cool technical paper**, never white.

|                 | dark      | light     | role                         |
| --------------- | --------- | --------- | ---------------------------- |
| `--paper`       | `#16191D` | `#EEF1F4` | the bench                    |
| `--paper-2/-3`  | `#1C2026` | `#E5EAEF` | inset specimens, code strips |
| `--ink`         | `#E4E9EE` | `#191D23` | body                         |
| `--ink-2/-3`    | `#B4BDC7` | `#303740` | secondary, then annotation   |
| `--rule`        | `#2A3038` | `#C7CFD8` | hairline                     |
| `--rule-strong` | `#3B434D` | `#9AA6B2` | an axis                      |

**The wavelengths are the taxonomy.** Each failure family gets one, and the coding is semantic —
it is not a palette, it is the classification:

| family     | token           | dark      | light     | what fixes it             |
| ---------- | --------------- | --------- | --------- | ------------------------- |
| retry      | `--ray-retry`   | `#E4A040` | `#A85408` | time                      |
| account    | `--ray-account` | `#EC6A5E` | `#B3261E` | money or a plan change    |
| context    | `--ray-context` | `#6FA9EE` | `#1F5FA8` | sending less              |
| ours       | `--ray-ours`    | `#B08BE0` | `#6B3FA0` | fixing our own request    |
| inert      | `--ray-inert`   | `#8B97A5` | `#5B6672` | nothing                   |
| collimated | `--beam`        | `#35C0B1` | `#0B6A62` | output that left the lens |

The teal is the brand's, and it has exactly one job: **what leaves the lens is normalized.** It
marks output, never a failure.

The light-mode values were darkened from the direction's plate so each clears 4.5:1 as text on
`#EEF1F4`. As line work the originals were fine; contrast is not a place to keep a swatch for its
own sake.

**Colour never carries a state alone.** In the bench, each family also has a line style
(`DASH` and `WEIGHT` in `OpticalBench.tsx`) so the diagram survives being read in greyscale, by
someone with a colour vision deficiency, or through a screenshot pipeline that eats saturation.

---

## Type

- **Archivo Variable** — a drafting grotesque with tabular lining figures. One 32 KB latin
  variable file covers 100–900.
- **Commit Mono** — code, and only code.

Both are OFL-1.1, both self-hosted via Fontsource, both loaded in `astro.config.mjs`. **Inter and
JetBrains Mono are retired** as category defaults and must not come back.

Monospace is not the default for small labels. A drafting label is set in the grotesque at a
small size with real weight, not in code type — code type means code.

---

## Drafting grammar

These are the primitives. Anything new on the site is built from them rather than beside them.

**Leader** (`.leader`) — a label joined to its referent by a rule that runs to the edge. This is
what replaced the eyebrow. A leader always points at something; it is never a decorative caption.

**Dimension** (`.dim`, `.dim-value`, `.dim-rule`, `.dim-label`) — a measured span with witness
ticks at both ends. Used for figures the reader should read as _quantities_: the five codebases,
the thirteen kinds, the 344 tests, the zero dependencies.

**Witness tick** — the short mark on a heading (`h2::before`) and at a dimension's ends. It
anchors a label to its exact position.

**Centreline** — dash-dot, `stroke-dasharray="14 5 2 5"`. Reserved for an optical axis and for
the commitment horizon. It means _reference line_, so nothing else may use it.

**Readout** (`.readout`) — term, dotted leader, value. An instrument's answer, not a table.

**Specimens** (`.specimens`) — the failure inventory, grouped by density with tick-witnessed
headings and no boxes.

---

## The two registers

One world, two registers — not two designs.

**Persuade** is the landing page only. It is the bench at full scale: the plate, the live
classifier, the masthead under the axis.

**Read** is every guide and all ~85 generated reference pages. Same tokens, same grammar, quieter
application: no plate, prose measure, code strips inset into the sheet. The audience reads long
technical prose at night during an incident, so legibility at length is a functional requirement.

The generated TypeDoc pages inherit the Read register unchanged and it holds. Revisit only if the
generated markup starts fighting the grammar.

---

## The bench (`OpticalBench.tsx`)

The landing page's diagram **is** the classifier, not a widget beside it. Seven real vendor
failures enter left at scattered angles; one element sits on the axis; thirteen named lanes leave
right, wavelength-coded by remedy. Editing the status or body re-traces the ray from the real
`ProviderError.from()` verdict.

Three things about it are load-bearing and easy to break:

1. **The rays are not the buttons.** A diagonal line's bounding box is a huge swath of the plate
   and seven of them overlap, so a pointer would land on whichever `<g>` happened to be on top.
   The label strip is the button; rays are drawn separately with `pointer-events: none`. This was
   found by driving the page, not by reading it.

2. **The struck beam remounts to replay.** A React `key` on the beam group forces a fresh mount
   per verdict, so the trace animation runs again instead of the line sliding to a new position.
   A ray being _drawn_ is the one motion this world contains.

3. **Every alternative stays present as an unlit ghost.** The whole taxonomy is on the plate at
   all times and the classified one is struck forward. A verdict is only meaningful beside its
   neighbours — that is the raise this design kept from its strongest challenger.

The data behind it lives in `site/src/lib/kinds.ts`: the editorial `fix` prose is the site's, the
flags come from the package's own `isTransient` / `isBackupEligible` so they cannot drift, and one
`Record<ErrorKind, …>` makes the list **exhaustive by compilation** — adding a kind to the package
fails the site build until it is described.

---

## Guide figures

Two guides carry a figure, and only two:

- **`CommitmentHorizon.astro`** (retries) — the same failure twice, once either side of the first
  emitted chunk. The return path on the right runs into the horizon and stops. This exists because
  the retry rule is about a _place_: prose can state it, only a drawing shows the asymmetry.

- **`WatchdogTimeline.astro`** (streaming) — four idle timers cancelled by an arriving chunk and a
  fifth running its full window. The ghosts are the time that was left. This exists because the
  thing that fires the watchdog is an _absence_, which prose can only assert.

Both are Astro components, so they ship **zero JavaScript** — and, just as importantly, the guide's
`.md` source stays two lines longer instead of two hundred, which keeps the agent channel clean.

The other six guides get no figure. A figure is earned by having spatial information to carry, not
by being a page.

---

## The agent channel

Agents read this site as much as people do, and they never render the visual world.

- `/llms.txt`, `/llms-full.txt`, `/llms-small.txt` — `llms-small` is scoped to the guides;
  `llms-full` carries guides plus the generated reference.
- **Per-page `.md`** — appending `.md` to any page returns its markdown source, Bun-style. This is
  the one agents use most.
- **`/kinds.json`** — the taxonomy as data, generated from `kinds.ts`. The most-queried fact about
  the package, in the shape an agent mid-incident actually wants.
- **"Copy page as Markdown"** — the human half of the same feature, a `PageTitle` override on every
  Read page. When the clipboard refuses it opens the `.md` instead. It never dead-ends.

No MCP server. MCP is a transport for capability, not a distribution format for text, and
`bun add @providerkit/core` puts the real classifier in the agent's own process — which beats a
network round trip for pure computation.

---

## Rules that keep it coherent

1. **Every rule carries drafting semantics.** Centreline, dimension, witness, or leader. If a line
   is only separating two things, delete it. This is the discipline that keeps hairlines from
   sliding into the broadsheet-editorial tell.
2. **The composition is a horizontal bench, never newspaper columns.**
3. **Colour is never the only carrier of a state.** Line style or weight must also distinguish.
4. **The teal means collimated output.** Never a failure, never an accent.
5. **A wide drawing scrolls in its own frame** (`.bench-scroll`), and says so below 48rem. Grid
   children carry `min-width: 0` — a grid item defaults to `min-width: auto`, so a wide SVG will
   otherwise push the whole page sideways instead of scrolling inside its container.
6. **Custom CSS stays unlayered.** Starlight's own styles live in `@layer starlight.*`, so
   unlayered rules win without `!important`. Declare the Starlight token remapping once at plain
   `:root` — a `:root[data-theme="light"]` copy out-specifies `html:not([data-has-sidebar])` and
   silently defeats the splash overrides.
7. **No new colour without a role.** The palette is a role set, not a swatch library.

---

## Verification

The two defects that mattered most in this build were invisible in the source and only appeared
under a real browser: the overlapping SVG buttons, and a page-wide horizontal overflow on mobile.

So: drive the page. Check 390 / 768 / 1440 in both themes, confirm `scrollWidth === innerWidth`,
click a ray, paste a failure, and press the copy control. `bun run build:site` must stay at zero
errors, warnings and hints.
