# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who are building or maintaining an LLM agent loop in TypeScript — the loop that
calls a model, runs tools, and streams an answer back to a user.

They arrive in one of two situations, and the second is the one that matters:

1. **Choosing a provider layer** at the start of a project. Comparing against LangChain, the
   Vercel AI SDK, LiteLLM, and hand-rolling it.
2. **Debugging a production incident.** A run died at 3am. They have a status code, a body,
   and a stack trace, and they need to know whether to retry, switch models, compact, or
   surface it. _(Inferred from the package's own origin: every one of its thirteen error
   kinds exists because a real run failed in one of the five source codebases.)_

The second situation is where the package earns its keep, and readers arriving in it are
looking for a specific answer, not an overview.

## Product Purpose

`@providerkit/core` is the layer _underneath_ an agent loop: one seam across every LLM
provider, plus the failure handling that only gets learned in production.

Success is a developer deleting code. Every adopting codebase should be net-negative in lines
after migrating; if a repo grows, the package drew its boundary in the wrong place.

## Positioning

Most "unified LLM interface" libraries stop at the interface. The interface is the easy part
and is not where the time goes.

The claim a neighbouring library could not truthfully copy: **this error taxonomy is the
pooled scar tissue of five independent production codebases**, and it is organised by what
fixes each failure rather than by vendor or status code. It knows that an empty balance
arrives as 429, 402, 403 and 400 from four different vendors; that a 429 is sometimes really
a context overflow; that a dead socket hides four `cause` levels down with no status at all.

Explicitly **not** an agent framework. No loop, no prompts, no graph, no memory, no chain.

## Operating Context

- Consumed as an ESM TypeScript package via `bun add @providerkit/core`.
- Must run unchanged in Bun, Node, Cloudflare Workers, Deno, and a **Chrome MV3 service
  worker**. MV3 is the binding constraint: no Node built-ins, no `process`, no `Buffer`, no
  vendor SDKs. CI enforces this with a grep over `core/src`.
- Evaluated by reading source and docs before installing — the audience reads code.
- The docs site is the reference developers keep open in a second tab while debugging.

## Capabilities and Constraints

**Shipped and tested (380 tests):** the provider seam; the merged error classifier (13 kinds);
retry with full-jitter backoff and backup-model fallback; the idle stream watchdog and TTFT;
fetch/SSE transport; tool-argument salvage; Anthropic, OpenAI-shape, Responses and Gemini
adapters; the multi-key rotation pool; rate-limit reset windows; the tool kernel; schema
clamping; compaction decisions; cost maths.

**Not yet built:** nothing in the extraction's scope. What is unbuilt is _adoption_ — no
codebase consumes the package yet, so the "every adopting codebase gets smaller" claim is
still unmeasured. tabrunner migrates first, and that is what gates the next release.

**Hard constraints:** zero runtime dependencies. `fetch` only. zod is an optional peer, never
imported by the kernel. No price tables ship — rates change weekly and a stale table is worse
than none.

**Terminology that must stay consistent:** _kind_ (not "type" or "code") for a classified
failure; _seam_ for the provider-neutral boundary; _loop_ for the caller's own agent loop.

## Brand Commitments

- Name **providerkit**, lowercase, always one word. npm package `@providerkit/core`.
- Domain **providerkit.dev**. GitHub org and repo `providerkit/providerkit`. MIT.
- The mark is a **collimator**: rays enter at scattered angles, a lens, rays leave parallel
  and evenly spaced. It is the package's function drawn literally, and it is fixed —
  `brand/providerkit-mark.svg`, geometry documented in `brand/README.md`.
- Voice: declarative, technical, unhedged. States what breaks and what fixes it. No
  exclamation marks, no "simply", no marketing superlatives. The README and guides already
  set this voice and it is binding.

## Evidence on Hand

Real, verifiable, and load-bearing — this is the proof the positioning rests on:

- **Five production codebases** pooled: `falai/agent` (3,266 kernel lines), `tabrunner/chrome`
  (2,078), `smartgenius` (~1,900), `olhary` (1,178), `featury` (649) — ~9,100 lines solving
  one ~2,000-line problem.
- **Three independent 60-second idle watchdogs**, identical down to the constant, derived
  separately in three of those repos.
- **2026-09-01:** featury and olhary shipped the same five fixes on the same day, independently.
  Provable from their git logs.
- **380 passing tests**; 103 exported symbols; 13 error kinds.
- The live classifier on the site runs the real published package in the reader's browser.

**Must not be fabricated:** there are no users, no testimonials, no adopters, no benchmarks,
no download counts, and no case studies. `@providerkit/core@0.1.0` went to npm on 2026-09-03 and
nothing has adopted it yet — not even the five codebases it came from. Any social proof would be
invented.

## Product Principles

1. **Name every failure by its fix.** The only question an error answers is "what do I do
   now?" Taxonomy follows the remedy, never the vendor or the status code.
2. **The loop stays the caller's.** Everything under the loop is in scope; the loop itself
   never is. A shared loop grows a flag per app — that is how the oldest of the five source
   codebases reached 27k lines and got declined by the four newer ones.
3. **Portability is a promise, not an aspiration.** MV3 is the hardest target and it is the
   floor. One build, five runtimes.
4. **Evidence over assertion.** Every claim is traceable to a real incident, a real vendor
   response, or a test. Prefer the specific failure to the general reassurance.
5. **Earn adoption by subtraction.** The measure is lines deleted from the adopting codebase.

## Accessibility & Inclusion

No product-specific standard was established. The audience reads long technical prose and
code for extended periods, often at night during an incident, so legibility at length and a
genuinely comfortable dark mode are functional requirements rather than preferences.
