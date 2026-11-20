---
name: providerkit
description: TypeScript provider calls, agent execution and chat screens, with an ultramarine p on graphite or cool paper.
colors:
  paper: "#16191d"
  paper-2: "#1c2026"
  paper-3: "#21262d"
  ink: "#e4e9ee"
  ink-2: "#b4bdc7"
  ink-3: "#7f8a96"
  rule: "#2a3038"
  rule-strong: "#3b434d"
  beam: "#a8b1ff"
  ray-retry: "#e4a040"
  ray-account: "#ec6a5e"
  ray-context: "#6fa9ee"
  ray-ours: "#b08be0"
  ray-inert: "#8b97a5"
typography:
  display:
    fontFamily: "Archivo Variable, -apple-system, system-ui, Segoe UI, Roboto, sans-serif"
    fontSize: "clamp(2.4rem, 6vw, 3.6rem)"
    fontWeight: 600
    lineHeight: 1.22
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Archivo Variable, -apple-system, system-ui, Segoe UI, Roboto, sans-serif"
    fontSize: "2.1875rem"
    fontWeight: 600
    lineHeight: 1.22
    letterSpacing: "-0.017em"
  figure:
    fontFamily: "Archivo Variable, -apple-system, system-ui, Segoe UI, Roboto, sans-serif"
    fontSize: "clamp(2.25rem, 5vw, 3.25rem)"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.03em"
    fontVariation: "tabular-nums lining-nums"
  title:
    fontFamily: "Archivo Variable, -apple-system, system-ui, Segoe UI, Roboto, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Archivo Variable, -apple-system, system-ui, Segoe UI, Roboto, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.72
    letterSpacing: "normal"
  label:
    fontFamily: "Archivo Variable, -apple-system, system-ui, Segoe UI, Roboto, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.01em"
  code:
    fontFamily: "Commit Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
rounded:
  none: "0"
spacing:
  tick: "0.4rem"
  label: "0.6rem"
  leader: "1.1rem"
  row: "2.25rem"
  section: "2.75rem"
  column: "3.5rem"
components:
  action-link:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 0 0.2rem 0"
  action-link-hover:
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0 0 0.2rem 0"
  field-input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.none}"
    padding: "0.4rem 0"
    width: "100%"
  field-input-focus:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0.4rem 0 calc(0.4rem - 1px) 0"
  copy-md:
    backgroundColor: "transparent"
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 0 0.2rem 0"
  copy-md-hover:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0 0 0.2rem 0"
  code-block:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.none}"
    padding: "1rem"
  aside:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.none}"
    padding: "0.1rem 0 0.1rem 1.1rem"
---

# Design System: providerkit

## Overview

**The world: the optical bench**

The three packages share an ultramarine p. Its open bowl and cut stem remain distinct at favicon size.
The name is lowercase Archivo in ink; it is not a second patch of accent color. Commit Mono stays
with code. The optical bench belongs to the Core classifier, not the logo.

Purpose and useful actions come before the drawing. The landing has one shared example area
followed by full-width package rows. The full classifier lives at `/demos/errors/`. It still runs
Core's real classifier, with the same ray geometry and remedy colors.

Rules are for useful marks: a focus indicator, a selected action, a leader or a diagram axis.
They are not repeated ornaments over every landing or reference heading. Group packages through
spacing and type, not three equal marketing cards. No filled controls, shadows or rounded boxes.

Remedy colors keep their meanings. They never become package colors. Body prose keeps its
bounded reading width and both themes remain comfortable for long documentation sessions.

**Key Characteristics:**

- Drafting line work only: centrelines, dimension lines with witness ticks, leader lines.
- Zero radius everywhere; no cards, no boxes, no dividers, no shadows.
- Ultramarine identifies the brand and current location. Error colors identify remedies.
- Every state legible without hue — line style and words carry it too.
- The whole set is always shown unlit; the selected one is struck forward.
- Tabular lining figures throughout. Numbers on a drafting sheet line up.

## Colors

Two grounds of one system. The frontmatter carries the dark values because dark is what
`:root` declares and what an engineer debugging at night actually sees; the light ground is
the same roles re-pointed, listed here beside each token. Every wavelength was darkened on
the light ground specifically so it clears 4.5:1 as text on paper.

### Primary

- **Ultramarine** (`#a8b1ff` on dark, `#414cac` on light): the link underline, keyboard focus,
  current section and active table-of-contents entry. It also marks the normalized output in the
  Core diagrams. The transparent logo uses `#666ed7` on both grounds.

### Secondary — the wavelengths

Each is a remedy band in the error taxonomy, and the coding is load-bearing product meaning.

- **Retry Amber** (`#e4a040` dark / `#a85408` light): time fixes it — `timeout`, `network`,
  `overload`, `rate`. Line style: long dash (`8 5`).
- **Account Red** (`#ec6a5e` dark / `#b3261e` light): money or a plan fixes it — `quota`,
  `entitlement`, `auth`. Line style: solid, heaviest weight (1.6).
- **Context Blue** (`#6fa9ee` dark / `#1f5fa8` light): sending less fixes it — `context`.
  Line style: dash-dot (`12 3 3 3`).
- **Ours Violet** (`#b08be0` dark / `#6b3fa0` light): our request was wrong — `model`,
  `content`, `invalid`. Line style: fine dot (`2 5`).
- **Inert Graphite** (`#8b97a5` dark / `#5b6672` light): nothing to do — `aborted`,
  `unknown`. Line style: solid, lightest weight (0.75).

### Neutral

- **Bench Ground** `paper` (`#16191d` dark / `#eef1f4` light): the page. Anodized graphite
  under work light, or cool technical paper. Never pure black, never pure white.
- **Inset Ground** `paper-2` (`#1c2026` / `#e5eaef`): code specimens and the recessed
  surfaces cut into the sheet.
- **Deep Inset** `paper-3` (`#21262d` / `#dbe2e9`): inline code, the lowest-lying surface.
- **Ink** (`#e4e9ee` / `#191d23`): headings, values, the struck verdict, anything at full
  attention.
- **Ink 2** (`#b4bdc7` / `#303740`): body prose. The default reading colour.
- **Ink 3** (`#7f8a96` / `#5b6672`): labels, captions, unlit lane names, sidebar groups.
- **Rule** (`#2a3038` / `#c7cfd8`): hairlines that separate.
- **Rule Strong** (`#3b434d` / `#9aa6b2`): hairlines that dimension — the ones carrying
  witness ticks, input underlines, and the optical axis.

### Named Rules

**Remedy colors.** Each failure color names the kind of fix it needs. Keep these colors out of
package branding. Use type weight or spacing to make an unrelated element stand out.

**The beam rule.** The brand accent identifies the current location or a normalized result in a
figure. It does not mean success or failure. Keep each remedy's own color and label.

**The Two-Ground Rule.** Every colour ships a light and a dark value and the roles never
swap. A token that looks right on one ground and is invented on the other is not finished.

## Typography

**Display / Body Font:** Archivo Variable (with `-apple-system, system-ui, Segoe UI, Roboto,
sans-serif`) — one variable file carries 100–900, self-hosted, OFL.
**Label/Mono Font:** Commit Mono (with `ui-monospace, SFMono-Regular, Menlo, monospace`) —
self-hosted at 400 and 600, OFL.

**Character:** A drafting grotesque against a code face. Archivo is squarish, tightly spaced,
and carries true tabular lining figures — it reads as an instrument panel rather than a
brochure, and it is deliberately not the category default. Commit Mono is narrow and even
enough that a pasted JSON error body stays scannable at 14px. Both were chosen partly by
subtraction: Inter and JetBrains Mono are retired from this project as category defaults.

### Hierarchy

- **Display** (600, `clamp(2.4rem, 4.8vw, 4rem)`, 1.22, −0.03em): the landing's purpose.
- **Headline** (600, `2.1875rem`, 1.22, −0.017em): guide headings and package names. Guide
  headings keep their witness mark; landing and reference headings do not repeat it.
- **Figure** (500, `clamp(2.25rem, 5vw, 3.25rem)`, 1, −0.03em, tabular): a dimensioned value —
  the number in a `.dim`, sitting above its own dimension line.
- **Title** (600, `1.05rem`, −0.01em): a specimen or callout heading, indented `1.1rem` behind
  its own witness tick.
- **Body** (400, `1.0625rem`, 1.72): all prose. Measure is capped at 46rem even where the
  plate is wider. The generous 1.72 leading is functional — this audience reads for an hour.
- **Label** (500, `0.8125rem`, +0.01em): every small label — leaders, captions, field labels,
  dimension labels, sidebar group names. Sentence case.
- **Code** (400, `0.875rem`, 1.6): Commit Mono, in specimens and in the classifier's fields.

### Named Rules

**The No-Eyebrow Rule.** Never a tracked ALL-CAPS label above a heading. A label in this
system earns attention from the rule that runs out of it to its referent — the `.leader`
device — so the type itself never has to shout. Letter-spacing above +0.01em and
`text-transform: uppercase` are both out.

**The Tabular Rule.** Every figure is `tabular-nums lining-nums`, on headings, table cells,
dimension values, and code alike. Numbers on a drafting sheet line up in a column.

**The Sentence-Case Rule.** Labels, buttons, aside titles, and sidebar groups are sentence
case. Starlight's uppercase aside titles are explicitly overridden.

## Layout

The splash template opens to **78rem**. Docs use a **47rem** column with the existing Starlight
sidebar and table of contents. Prose is capped at **46rem**, even on the wide landing.

The landing reads in DOM order: purpose, actions, example, package rows, next steps. On desktop,
the example's call and result share a row. Below `50rem`, code comes above output and package rows
stack. Nothing is reordered away from the keyboard or screen-reader sequence.

The full classifier is the only wide optical drawing. Its `77.5rem` minimum width keeps the
1240-unit drawing and its labels at their intended size. It scrolls inside the demo, never the
page. A caption tells narrow-screen readers how to see the rest. Its input and verdict stack
on phones; provider labels have 44px hit targets.

The header is one row. Its height comes from Starlight (4rem on desktop, 3.5rem on phones),
not from the logo. Below 50rem the section links move into one menu. The docs keep their existing
sidebar drawer and the landing page gets a short menu with the same destinations. See
[site navigation](STRUCTURE.md) for the order and keyboard behavior.

Spacing is role-named rather than a numeric ramp: `0.4rem` at a tick, `0.6rem` between a label
and its rule, **`1.1rem` as the standing leader indent** (the distance from a witness tick or
callout rule to the text it names — the one value that recurs everywhere), `2.25rem` between
rows, `2.75rem` before a section heading, `3.5–4rem` between columns.

### Named Rules

**The Bench Rule.** The primary composition is a horizontal axis with things dimensioned off
it. Never newspaper columns — that is the failure mode this world is one step away from, and
column-first layouts are what tip drafting hairlines into broadsheet editorial.

**The Measure Rule.** Prose is capped at 46rem no matter how wide the plate is. Widening the
container never widens the reading column.

## Elevation & Depth

**This system has no shadows.** `--sl-shadow-sm`, `-md` and `-lg` are all set to `none`, and
the expressive-code frame's shadow is nulled too. A drop shadow is not a drafting mark.

Depth comes from three things instead: **ink weight** (`ink` → `ink-2` → `ink-3` moves an
element back), **opacity** (the bench's unlit lanes sit at 0.32, the neighbouring band at 0.5,
the struck verdict at 1), and **tonal inset** (`paper-2` and `paper-3` are surfaces cut _into_
the sheet, never panels floating above it).

### Named Rules

**The No-Shadow Rule.** No `box-shadow`, no `filter: drop-shadow`, no soft grey glow, on any
element, in either theme. If something needs to come forward, give it more ink or raise its
opacity.

**The Inset Rule.** A tinted surface is always recessed, never elevated. `paper-2` and
`paper-3` read as material removed from the sheet — which is why they carry a heavier rule on
their inline-start edge and nothing resembling a lifted card.

## Shapes

**Controls and surfaces have square corners.** Code frames, asides, dialogs, search, pagination,
inputs and buttons all use `border-radius: 0`. The curved lens in the error classifier is part of
that diagram. The site's mark is a letter with flat cuts.

The recurring form is not a container but a **mark**: a short hairline that witnesses
something. It appears as the 2.5rem witness mark over a section heading, the 0.65rem tick
before a specimen title, the tick pair at each end of a dimension line, the 2px inline-start
tick beside the current sidebar page, and the leader rule that runs out of a label to fill its
line. Elements are grouped by putting these marks in a common rhythm — never by drawing a box
around them.

### Named Rules

**The Zero-Radius Rule.** `border-radius` is `0`. There is no radius scale to pick from.

**The No-Box Rule.** No cards, no bordered containers, no dividers between grid cells, no
uniform-radius tiles. Grouping comes from density, indentation and depth. If a layout needs a
box to be legible, the spacing is wrong.

**The Drafting-Semantics Rule.** Every rule must be able to name its drafting job — optical
centreline, dimension line, leader, or witness tick. A rule that is only separating things is
decoration and comes out.

## Components

### Action links (the button equivalent)

There are no filled buttons. An action link uses ink text, a 1px accent underline and a `→`.
Hover thickens the underline to 2px in 90ms.

- **Shape:** square, no radius, no fill, no border box.
- **Padding:** `0 0 0.2rem` — the rule sits just under the baseline, not around a box.
- **Row spacing:** `1.75rem` between actions, which is what separates them instead of borders.

### Links in prose

Links use ink text with a 1px ultramarine underline and `0.22em` offset. On hover the text turns
ultramarine and the underline thickens to 2px. The underline distinguishes a link without color.

### Inputs / Fields

- **Style:** no border, no fill, no radius. A single `rule-strong` underline. Mono type, since
  every value typed here is a status code or a response body.
- **Label:** above the field, label role, `ink-3`, sentence case, and phrased as guidance
  rather than a noun — "HTTP status — leave blank if it never got one".
- **Focus:** the underline goes ultramarine and thickens to 2px, with bottom padding reduced by 1px
  so the text does not shift. No ring, no glow, no background change.

### Code specimens

Square frames on `paper-2`, a `rule` hairline all round and a heavier `rule-strong` on the
inline-start edge — the mark of a specimen strip inset into the sheet. The terminal frame's
three coloured dots are removed outright: that titlebar belongs to somebody else's world, and
an install line is a specimen like any other.

### Asides

No fill and no border box. A 2px inline-start rule in the aside's own wavelength (`note` →
context blue, `tip` → beam, `caution` → retry amber, `danger` → account red), `1.1rem` of
indent, and a sentence-case title in that same colour.

### Tables

No cell borders and no zebra. One `rule` hairline under each row, a heavier `rule-strong`
under the header, cells aligned to the baseline with `0.5rem 1rem 0.5rem 0` padding and no
inline-start padding, so the first column sits flush to the measure.

### Navigation

Sidebar entries are plain text at `ink-3`. The current page is **witnessed, not filled**: a
2px ultramarine tick in the margin at `-0.75rem`, with the label going to `ink` at weight 600. There
is no pill, no highlight, no background. Hover adds a `rule-strong` underline. The table of
contents uses the same grammar with a 1px inline-start rule that turns ultramarine on the active
entry. Search is an underlined input, not a capsule.

### Copy page as Markdown

Sits inline with the page title, right-aligned, as a label-role underlined control. It fetches
the page's own `.md` source and writes it to the clipboard; on success it reads "Copied" in
ultramarine for 2.4s. **Its failure path never dead-ends:** if the clipboard is unavailable it opens
the markdown in a new tab and says "Opened the .md instead" in retry amber, so the control
always lands somewhere useful.

### The Optical Bench (signature component)

The classifier on `/demos/errors/`, drawn as an optical layout. Seven vendor error examples
enter from the left and thirteen named exits leave on the right, grouped into five remedy bands.

- **The axis** is a dash-dot centreline (`14 5 2 5`) at `rule-strong`, spanning the full plate.
- **Every lane is always drawn**, unlit at 0.32 opacity. The reader sees the whole taxonomy at
  once; the verdict is the one struck forward, not the only one shown.
- **The verdict's whole band is raised with it** (0.5 line / 0.85 label), so "this is a retry
  failure" reads before "this is `overload`".
- **The struck beam is three hairlines**, 2.6px apart, rather than one heavy stroke — emphasis
  from line frequency, so no extra hue is spent on it.
- **Motion:** a changed verdict re-traces the ray in 230ms. The dot arrives within 300ms.
  Both animations run only under `prefers-reduced-motion: no-preference`. No idle animation.

### Dimensioned figures

A statistic is drawn as a dimension: the value in figure role, a dimension line with a witness
tick at each end (`::before` / `::after`, 7px, `rule-strong`), then the label beneath at
`ink-3`. Never a stat card.

### Guide figures

Two guides carry a drawn figure, and only two. Both are Astro components, so they ship no
JavaScript — and the guide's `.md` source grows by two lines instead of two hundred, which is
what keeps the agent channel worth having.

- **`CommitmentHorizon.astro`** (retries) — the same failure twice, once either side of the
  first emitted chunk. The horizon is a dash-dot centreline drawn as a wall at 1.75px, and the
  late failure's return path is dashed and runs into it. The retryable span is dimensioned in
  `ray-retry`, the committed span in `beam`.
- **`WatchdogTimeline.astro`** (streaming) — four idle timers cancelled by an arriving chunk,
  stacked one per row, against a fifth that runs its full window. Each cancelled timer keeps a
  dashed ghost of the time that was left, and a witness line drops from each chunk on the axis
  to the timer it arms.

A figure is earned by having **spatial** information to carry — a threshold, an interval — not
by being a page. The other eleven guides get none, and that is a decision rather than a backlog.

Label sizes in these figures are authored in viewBox units against a ~748px rendered measure,
so they are set for what lands on the page (a 12px label would render at 9).

### Reference pages (Read register)

Generated reference pages use the same colors and fonts with quieter reading styles. Their
page title is `2rem`, second-level headings `1.5rem` and third-level headings `1.15rem`. No
ornamental heading rules or figures. The page title identifies reference routes for these styles.

Authored package reference indexes sit beside the generated directories. TypeDoc owns only
`reference/core/`, `reference/agents/` and `reference/react/`; regenerating them cannot erase the authored indexes.

## Do's and Don'ts

### Do:

- **Do** give every rule a drafting job — centreline, dimension line, leader, or witness tick
  — and delete any rule that cannot name one.
- **Do** show the whole set unlit and strike the selected one forward, rather than showing
  only the selection.
- **Do** carry every state in a line style and in words as well as a hue; the taxonomy has to
  read for someone who cannot separate the colours.
- **Do** cap prose at 46rem regardless of container width.
- **Do** let a wide diagram scroll horizontally inside its own container rather than reflowing
  it into something that is no longer a bench.
- **Do** keep both grounds finished — a token invented on one ground and guessed on the other
  is not done.
- **Do** end every error and empty state somewhere useful, the way the copy-markdown control
  opens the `.md` when the clipboard refuses.
- **Do** make a guide figure earn itself on spatial information. If prose states it just as
  well, the figure is decoration and the guide is better without it.

### Don't:

- **Don't** use a card, a bordered container, a divider between cells, or any uniform-radius
  tile. Group by density and depth.
- **Don't** add a `box-shadow`, drop shadow, or soft grey glow anywhere, in either theme.
- **Don't** write a tracked ALL-CAPS eyebrow above a heading. Use a leader with a rule.
- **Don't** join small labels with middle dots (`A · B · C`). That meta string is retired.
- **Don't** spend a wavelength on emphasis. Amber, red, blue and violet mean retry, account,
  context and ours; ultramarine means normalized output. Emphasis is ink weight and line frequency.
- **Don't** introduce a border radius. The lens arc is the only curve in the system.
- **Don't** reach for Inter or JetBrains Mono. Both are retired from this project as category
  defaults.
- **Don't** compose in newspaper columns. The plate is a horizontal bench, and columns are
  what tip this world into broadsheet editorial.
- **Don't** make monospace the default for small labels. Mono is for code and for values the
  reader types or pastes; labels are Archivo.
- **Don't** ship a near-black ground with one bright accent. Dark is a lab bench under work
  light, not a void.

## Landing

The landing helps a TypeScript developer choose a useful starting point. It takes a provider
failure and turns it into a remedy, then shows where provider calls, agent tasks and chat screens
belong. Guides and references keep the same visual world in a quieter reading style.

Spine: purpose, one real working example, full-width package rows, then boundaries and reference.
Driver: the reader chooses a task. Core computes error remedies locally, an Agents example runs a real tool with a scripted provider, and React renders its released chat components. Task and scenario choices stay in the URL.
Motion: results change in place; sample streaming shows the behavior being demonstrated. The classifier redraws its ray only after a new result, never on a timer.

The approved shared work area won over three equal package cards because readers need a job
before an import path. A diagram-first landing hid the purpose; a feature inventory hid the
starting point; separate package landings split the choice too early. A chat-first landing was
held back while React was unpublished; now the released chat is one task choice, not a replacement
for the package overview. These were alternatives, not extra designs to build.

First screen: what providerkit does, who it is for and links to Start and Examples. Code is above
output on phones. Controls are underlined and unfilled. The earlier suggestion of a filled
neutral primary action was not approved and is not part of this direction.

The Core example runs `isTransient`, not a copied classifier. The full demo reuses OpticalBench.
The package rows explain the next action with accurate release state: Core 0.35.1, Agents 0.4.0
and React 0.2.0. No invented installs, live model answers or unmaintained test counts.

Agents and React guides/reference now cover the released public entries. Their browser examples
use explicit sample responses, no credentials or paid providers. The site uses the published React
components rather than building another reducer, composer or Markdown renderer. Optional demo
code loads only when selected. Demo data stays in the tab with visible retention and clear actions;
this is not advertised as a durable backend. The package's scoped styles receive the site's square,
unfilled controls and inherited typography, not a second visual system.

## Decisions behind the site

Core, Agents and React share the same site. The new p replaces the old lens logo because a
single silhouette reads at tab size and identifies all three packages. Keep the existing fonts,
reading backgrounds, error remedy colors, guide URLs and machine-readable channels. Core's
zero-runtime-dependency claim never becomes a claim about the whole toolkit.

The shared example precedes full-width package rows. No three-card package grid, no statistics
strip and no diagram before the purpose. Reference headings now use the quiet reading style.

Generated references move to package directories using the locked plugin's multi-instance
factory. `scripts/legacy-reference-routes.json` captures the actual old build's routes.
`scripts/reference-routes.ts` generates explicit HTML and Markdown redirects, including paths
with and without a trailing slash. Its `--check` mode checks every destination after a build.
Never replace these with a wildcard prefix redirect: old and new trees overlap.

The retired `pk-*` card system, rounded surfaces, uppercase eyebrows and middle-dot metadata
strips remain retired. The later React package's `pk-*` selectors are unrelated library styles,
not permission to restore that old site design.

Fonts: Archivo Variable and Commit Mono, both OFL-1.1, self-hosted from Fontsource. One 32 KB
latin variable file covers weights 100–900 for Archivo.

The rays are not the buttons. A diagonal line's bounding box covers a huge part of the plate,
and seven of them overlap, so the label strip is the button and the rays are drawn separately
with `pointer-events: none`. Found by driving the page, not by reading it.

One design document per surface: this file holds both what was built and why. Do not start a
second one at the repo root. There was briefly one there.

### For agents reading the site

Agents read this site as much as people do, and they never render the visual world: they want
the markdown underneath. (`AGENTS.md` speaks to agents working _on_ providerkit; this part is
for agents _using_ it.)

- `starlight-llms-txt` keeps `/llms.txt`, `/llms-full.txt` and `/llms-small.txt`. The small
  bundle omits generated reference. Existing Guides and API reference sets remain; Core,
  Agents, React and Concepts sets make the package split explicit. The plugin does not emit
  per-page Markdown.
- Per-page `.md`, Bun-style: `providerkit.dev/guides/errors.md` returns `text/markdown` from a
  small Astro endpoint over the content collection. Agents use this one most: `llms.txt` says
  the page exists, and the `.md` fetches it without spending tokens on HTML chrome.
- `llms.txt` points at the API reference explicitly. Coding agents write code _against_ this
  library, so the exact signatures matter more than the prose. The shipped `.d.ts` is the
  precise contract; the generated reference is its readable form.
- `kinds.json`: the 13 kinds as `{kind, fix, isTransient, isBackupEligible}`. The `fix` prose
  lives on the site, the flags come from the package's own `isTransient` / `isBackupEligible`,
  and one `Record<ErrorKind, …>` makes the list exhaustive by compilation. It is the most-asked
  fact about the package, and an agent mid-incident wants it as data.
- "Copy page as Markdown" (above) is the human half of the same feature.

Do not build an MCP server. MCP exposes capability; it is not a way to ship text. The site is
static on Cloudflare Pages with nothing running to host one, it needs per-user client setup
where a URL needs none, and it cannot be crawled or cached. The only version worth having would
expose the classifier as a tool, and `bun add @providerkit/core` already puts the real
classifier in the agent's own process, which beats a network round trip for pure computation.
