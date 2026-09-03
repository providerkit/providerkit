---
version: 1
slug: "site-src-content-docs-index-mdx"
primary_target: "site/src/content/docs/index.mdx"
related_targets: ["site/src/content/docs/guides", "site/astro.config.mjs"]
---

## Scope and mode

providerkit.dev, all of it. The landing page is **Persuade**; every guide and reference page is
**Read** and inherits the same world in a quieter register. One world, two registers — not two
designs.

## Audience, job, action

A TypeScript developer who is either evaluating a provider layer, or is mid-incident at 2am with
a status code that is lying to them. The action on the landing page is to believe the taxonomy is
real and go read a guide. The job on a docs page is to find the one paragraph that says what to
do about the failure in front of them, fast, and to keep reading comfortably for an hour.

## Proof on hand

Five pooled production codebases (~9,100 lines), three independently-derived identical 60s
watchdogs, two repos shipping the same five fixes on the same day, 218 tests, 13 error kinds, and
a classifier that runs the real published package in the reader's browser. No users, no
testimonials, no adopters — none may be invented.

## Chosen direction — "Optical Bench" (seed 805dd357, assigned index 5)

THESIS: Optics has named defects by their correction for two centuries — spherical, coma,
astigmatism, chromatic — and diagnosed them with spot diagrams and ray fans. This surface is an
optical layout plot for LLM failure. It refuses the category default it currently ships: near-black
ground, one neon accent, identical rounded cards, tracked ALL-CAPS eyebrows, middle-dot meta strings.

OWN-WORLD: Cool technical paper `#EEF1F4`, graphite ink `#191D23`, hairline axis `#9AA6B2`. Rays
are wavelength-coded by remedy, and that coding _is_ the taxonomy: retry amber `#C2610B`, account
red `#B3261E`, context blue `#1F5FA8`, ours violet `#6B3FA0`, inert graphite `#5B6672`. The
collimated beam keeps the brand teal `#0E7C73` — what leaves the lens is normalized. Dark mode is
the lab bench (anodized black), never a void. Line work follows drafting semantics: dash-dot
optical centrelines, arrowheaded dimension lines, leader lines from label to referent. No cards,
no uniform radius, no soft grey shadows. Type is a drafting grotesque with tabular lining figures
(Archivo) plus one code mono (Commit Mono) — both to be verified obtainable before use; Inter and
JetBrains Mono are retired as category defaults.

STORY: The reader sees seven real vendor failures enter as scattered rays, pass one element, and
leave parallel and named. They understand the seam and the taxonomy in one image, believe it
because the diagram is running the real package, and go read the guide for their failure.

FIRST VIEWPORT: A horizontal optical axis across the page. Seven labeled rays enter left at
scattered angles carrying real vendor bodies. One element on the axis. Thirteen parallel exits
right, wavelength-coded by remedy. The live classifier IS this diagram, not a widget beside it.
Title and install sit under the axis, left-aligned. No hero card, no gradient.

SIGNATURE INTERACTION: Editing the status or body re-traces the ray in place — the entering angle,
the exit lane, and the wavelength all change from the real classifier's verdict.

RISK: Drafting hairlines can slide into the broadsheet-editorial tell. The discipline that keeps
them apart: every rule must carry drafting semantics (centreline, dimension, leader), never
decoration; and the composition is a horizontal bench, never newspaper columns.

## Challenger verdicts and raises

- **Struck cathode gauze** — _competitive_ (holds product clarity). Kept: **every alternative
  present at once as an unlit ghost, the classified one struck forward**, and **no boxes, rules or
  dividers — group by density and depth**. This is the raise that kills the card grid.
- **Night instrument six-pack** — _declined_. Kept: **show trend as well as value; deviation reads
  before the alarm.** The classifier shows a verdict's neighbours, not only its verdict.
- **Accretion-disk threshold** — _competitive_ (product clarity, one idea). Kept: **an irreversible
  threshold rendered as a place.** The retries guide draws the commitment boundary — once a chunk
  is emitted the turn cannot be retried — as a real horizon in the layout, not a paragraph.
- **Riley moiré gallery** — _declined_. Kept: **contrast from line frequency, not from adding a
  hue.** Emphasis comes from ray density before it comes from another colour.
- **Colour-chord counterpoint** — _declined_. Kept: **states legible beyond colour.** Every failure
  family must be readable without hue — required for the classifier and an accessibility floor.
- **Push Pin poster** — _declined_. Kept: **one emblematic figure anchors each section.** Each
  guide opens with its own diagram rather than uniform prose.

## Rebuild, do not refactor

This is a replacement world, not a refinement. The current implementation is **evidence and
anti-reference only**. Do not polish it, do not port its classes, do not keep "the good parts".

Nothing below survives into the new build:

- `site/src/styles/brand.css` in its entirety — including every `--pk-*` token and the whole
  `pk-` class family. Delete the file and author the new world from the direction contract.
- The `.pk-eyebrow` device: a tracked ALL-CAPS label above a heading. Drafting has its own label
  grammar (leader line to referent, dimensioned callout); use that instead.
- The `.pk-meta` middle-dot string (`A · B · C`).
- `.pk-grid` / `.pk-cell` / `.pk-stats` / `.pk-stat` — identical rounded cards with one shared
  radius and a hairline gap. The cathode-gauze raise forbids boxes and dividers outright.
- `--pk-radius: 10px` applied uniformly to every surface.
- Monospace as the default for every small label.
- Inter and JetBrains Mono. Both are category defaults and are retired.
- The near-black-plus-one-bright-accent ground.

What _is_ preserved, because it is product truth or a brand commitment, not visual habit: all
copy and content, the collimator mark and its geometry, the teal as the collimated-beam role,
the failure-family semantics (retry / account / context / ours / inert), the classifier's logic
in `Classifier.tsx`, Astro + Starlight, and every route.

## Agent channel — BUILT (except the copy control)

Agents read this site as much as people do, and they never render the visual world — they want
the markdown underneath. Both halves ship with the rebuild; neither costs the design anything.

- **`starlight-llms-txt`** for `/llms.txt`, `/llms-full.txt`, `/llms-small.txt`. Sizing decision:
  8 guides plus ~85 generated TypeDoc pages is too much for one context file, so scope
  `llms-small.txt` to the guides and let `llms-full.txt` carry guides plus reference. The plugin
  takes include/exclude globs. Verified: the plugin does **not** emit per-page markdown.
- **Per-page `.md`**, Bun-style — `providerkit.dev/guides/errors.md` returning `text/markdown`
  from a small Astro endpoint over the content collection. This is the one agents use most:
  `llms.txt` says the page exists, the `.md` fetches it without spending tokens on HTML chrome.
- **Point `llms.txt` at the API reference explicitly.** This is a library that coding agents write
  code _against_, so the exact signatures matter more than the prose. The shipped `.d.ts` is the
  precise contract; the generated reference is its readable form.
- **A "Copy page as Markdown" control** is the human half of the same feature. It is a real UI
  element in the Read register and belongs in the rebuild, not bolted on afterwards. **Still to
  do — the only part of this section the rebuild still owes.**
- Optional, not decided: a generated `kinds.json` (13 kinds x `{kind, fix, isTransient,
isBackupEligible}`, emitted from `core/src` so it cannot drift). It is the most-queried fact
  about the package and an agent mid-incident wants it as data.

Do not build an MCP server. MCP is a transport for capability, not a distribution format for
text: the site is static on Cloudflare Pages with nothing running to host one, it needs per-user
client configuration where a URL needs none, and it cannot be crawled or cached. The only version
that would earn its keep is exposing the classifier as a tool — and `bun add @providerkit/core`
puts the real classifier in the agent's own process, which beats a network round trip for pure
computation.

Keep this separate from the repo's `AGENTS.md`, which addresses agents working _on_ providerkit.
This section is for agents _using_ it.

## Unresolved

- Font availability unverified (Archivo via Fontsource; Commit Mono self-hosted). Confirm before
  building; if Commit Mono is impractical, choose another non-default mono — not JetBrains Mono.
- Whether the ~85 generated TypeDoc reference pages take the full world or a deliberately plainer
  Read register. Decide during the build from how the generated markup actually renders.
- Whether `kinds.json` ships (see Agent channel). Still undecided.
- The "Copy page as Markdown" control is the rebuild's to add; everything else in the agent
  channel is shipped and verified (94 pages, 94 `.md` files, 1:1).
- DESIGN.md is written at finish, from the built world, not before. Its absence is deliberate and
  is not a gap to fill by inventing tokens ahead of the build.
