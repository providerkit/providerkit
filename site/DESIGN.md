---
name: providerkit
description: An optical layout plot for LLM failure — drafting grammar, wavelength-coded remedies, no cards.
colors:
  paper: "#16191d"
  paper-2: "#1c2026"
  paper-3: "#21262d"
  ink: "#e4e9ee"
  ink-2: "#b4bdc7"
  ink-3: "#7f8a96"
  rule: "#2a3038"
  rule-strong: "#3b434d"
  beam: "#35c0b1"
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

**Creative North Star: "The Optical Bench"**

Optics has named its defects by their correction for two centuries — spherical, coma,
astigmatism, chromatic — and diagnosed them with ray fans and spot diagrams. providerkit does
the same thing to LLM failure: it names thirteen kinds by what fixes each one, not by the
vendor or the status code that carried it. So the site is drawn as an optical layout plot.
Scattered rays enter, one element sorts them, and what leaves is parallel, evenly spaced, and
named. The brand mark is that same collimator, and the landing page is the mark at full scale
with the real classifier running inside it.

The consequence that governs every decision here: **a line is drafting, or it is deleted.**
Every rule on every page has to be doing a draftsman's job — an optical centreline, a
dimension line with witness ticks, a leader running from a label to the thing it names — and
if it cannot name its job it is decoration and comes out. That single test is what keeps this
world from sliding into the broadsheet-editorial look its hairlines could otherwise become.
The composition is always a horizontal bench, never newspaper columns.

The palette is not decorative either. Colour here is **wavelength**, and a wavelength stands
for a remedy: amber is "time fixes it", red is "money or a plan fixes it", blue is "sending
less fixes it", violet is "our request was wrong", graphite is "nothing to do". The teal beam
is reserved for what leaves the seam normalized. That coding _is_ the taxonomy — which also
means it can never be spent on emphasis. Emphasis comes from line frequency and ink weight
before it comes from another hue.

The audience reads long technical prose at 3am during an incident, so both grounds are
built for endurance: light is cool technical paper, dark is an anodized lab bench under work
light — never a void, never near-black with one neon accent.

**Key Characteristics:**

- Drafting line work only: centrelines, dimension lines with witness ticks, leader lines.
- Zero radius everywhere; no cards, no boxes, no dividers, no shadows.
- Colour is a remedy code, never decoration or emphasis.
- Every state legible without hue — line style and words carry it too.
- The whole set is always shown unlit; the selected one is struck forward.
- Tabular lining figures throughout. Numbers on a drafting sheet line up.

## Colors

Two grounds of one system. The frontmatter carries the dark values because dark is what
`:root` declares and what an engineer debugging at night actually sees; the light ground is
the same roles re-pointed, listed here beside each token. Every wavelength was darkened on
the light ground specifically so it clears 4.5:1 as text on paper.

### Primary

- **Collimated Teal** (`#35c0b1` dark / `#0b6a62` light): the beam that leaves the lens —
  what the package produces. It marks the seam itself and the four places where the reader is
  _on_ the normalized path: the link underline, the focused field's rule, the current-page
  tick in the sidebar, and the active table-of-contents entry. It never marks a failure.

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

**The Wavelength Rule.** A hue in this system always names a remedy. It is never used for
emphasis, never for hierarchy, never for delight. If a new element needs to stand out and it
is not a classified failure, it gets more ink or more line frequency — not a colour.

**The Beam Rule.** Teal is what _leaves_ the seam normalized. It never appears on a failure,
a warning, or an error state. Reaching for teal to mean "success" is the same mistake as
reaching for red to mean "important".

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

- **Display** (600, `clamp(2.4rem, 6vw, 3.6rem)`, 1.22, −0.03em): the masthead wordmark only.
  One per site.
- **Headline** (600, `2.1875rem`, 1.22, −0.017em): section headings. Always dimensioned from
  the margin — a hairline across the top with a 2.5rem heavier witness mark at its left,
  never an underline and never a box.
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

The page is a **plate**: a horizontal optical axis running the full width, with everything
else dimensioned off it. The splash template opens to the full plate width (**67.5rem /
1080px effective**) and drops Starlight's empty title panel, because the landing page carries
its own masthead beneath the bench. Docs pages run at the standard **47rem** reading column
with sidebar and table of contents.

Within a plate, three widths coexist: the bench, the specimen columns and the dimension row
run plate-wide, while prose is capped at **46rem** so the measure never follows the container.
Below `62rem` the plate collapses to a single column and the masthead is ordered to read
before the classifier console even though the island prints first.

The bench itself has a natural minimum width of `46rem` and **scrolls horizontally inside its
own container** below that, exactly as a wide drawing does. It is never reflowed into
something that is no longer a bench, and the caption tells a narrow reader to scroll sideways.

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

**Every corner in this system is square.** `border-radius: 0` on code frames, asides,
dialogs, search, pagination, inputs and buttons — Starlight's rounded defaults are all
overridden. The only curve in the entire world is the lens: a symmetric two-arc biconvex
element (`M x 24 Q x+56 240 x 456 Q x−56 240 x 24 Z`), which is the brand mark's own geometry
opened to the full aperture. That curve is meaningful, so it is the only one.

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

There are no filled buttons. An action is a **labelled leader**: ink-coloured text at label
weight, a 1px teal rule beneath it, and a `→` in teal after it. Hover thickens the rule from
1px to 2px in 90ms — the rule points the way the arrow does.

- **Shape:** square, no radius, no fill, no border box.
- **Padding:** `0 0 0.2rem` — the rule sits just under the baseline, not around a box.
- **Row spacing:** `1.75rem` between actions, which is what separates them instead of borders.

### Links in prose

Ink-coloured text with a **teal underline** at 1px and `0.22em` offset. Hover moves the text
to teal and thickens the underline to 2px. A link is never a coloured word on its own — the
underline is the leader that marks it.

### Inputs / Fields

- **Style:** no border, no fill, no radius. A single `rule-strong` underline. Mono type, since
  every value typed here is a status code or a response body.
- **Label:** above the field, label role, `ink-3`, sentence case, and phrased as guidance
  rather than a noun — "HTTP status — leave blank if it never got one".
- **Focus:** the underline goes teal and thickens to 2px, with bottom padding reduced by 1px
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
2px teal tick in the margin at `-0.75rem`, with the label going to `ink` at weight 600. There
is no pill, no highlight, no background. Hover adds a `rule-strong` underline. The table of
contents uses the same grammar with a 1px inline-start rule that turns teal on the active
entry. Search is an underlined input, not a capsule.

### Copy page as Markdown

Sits inline with the page title, right-aligned, as a label-role underlined control. It fetches
the page's own `.md` source and writes it to the clipboard; on success it reads "Copied" in
teal for 2.4s. **Its failure path never dead-ends:** if the clipboard is unavailable it opens
the markdown in a new tab and says "Opened the .md instead" in retry amber, so the control
always lands somewhere useful.

### The Optical Bench (signature component)

The landing page's classifier, drawn as the optical layout it actually is. Seven real vendor
failures enter at scattered angles from the left, converge on the lens, and thirteen named
exits leave parallel to the right, grouped into five remedy bands.

- **The axis** is a dash-dot centreline (`14 5 2 5`) at `rule-strong`, spanning the full plate.
- **Every lane is always drawn**, unlit at 0.32 opacity. The reader sees the whole taxonomy at
  once; the verdict is the one struck forward, not the only one shown.
- **The verdict's whole band is raised with it** (0.5 line / 0.85 label), so "this is a retry
  failure" reads before "this is `overload`".
- **The struck beam is three hairlines**, 2.6px apart, rather than one heavy stroke — emphasis
  from line frequency, so no extra hue is spent on it.
- **Motion:** a changed verdict re-traces the ray by remounting and running a 420ms
  `stroke-dashoffset` draw, with the landing dot scaling in over the last 30%. A ray being
  drawn is the only motion this world contains. Wrapped in
  `@media (prefers-reduced-motion: no-preference)`.

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
by being a page. The other six guides get none, and that is a decision rather than a backlog.

Label sizes in these figures are authored in viewBox units against a ~748px rendered measure,
so they are set for what lands on the page (a 12px label would render at 9).

### Reference pages (Read register)

The ~85 generated TypeDoc pages take the world's **colour, type and rules but none of its
figures or drafting devices**. They are lookup surfaces read in seconds, and expression there
costs scan speed while buying nothing. Headings on a generated page should sit closer to body
scale than the guides' headline role, and the emblematic-figure treatment used to open a
hand-written guide is explicitly not extended to them.

> Standing decision, not yet fully implemented: generated reference pages currently inherit
> the guides' headline scale (`2.1875rem` on "Parameters", "Returns"). Bringing them down to
> the Read register is outstanding work.

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
  context and ours; teal means normalized output. Emphasis is ink weight and line frequency.
- **Don't** introduce a border radius. The lens arc is the only curve in the system.
- **Don't** reach for Inter or JetBrains Mono. Both are retired from this project as category
  defaults.
- **Don't** compose in newspaper columns. The plate is a horizontal bench, and columns are
  what tip this world into broadsheet editorial.
- **Don't** make monospace the default for small labels. Mono is for code and for values the
  reader types or pastes; labels are Archivo.
- **Don't** ship a near-black ground with one bright accent. Dark is a lab bench under work
  light, not a void.
