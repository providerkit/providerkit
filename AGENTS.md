Entry point for AI agents working on this repo.

# providerkit

**The layer under an LLM agent loop.** One seam for every provider, plus the failure
handling you only learn in production. Deliberately **not** an agent framework: no loop, no
prompts, no memory, no graph — those are where a product lives and they stay in the app.

MIT · open source · `providerkit.dev`

> **Before touching anything under `site/`, read
> [`site/.impeccable/surfaces/site-src-content-docs-index-mdx.md`](site/.impeccable/surfaces/site-src-content-docs-index-mdx.md).**
>
> The site rebuild has landed. That brief holds the committed direction, the palette, the
> list of what must **not** survive, and the agent-channel decisions; `site/DESIGN.md` (with
> its `site/.impeccable/design.json` sidecar) is the built design system, written from the
> shipped pages rather than ahead of them. `PRODUCT.md` holds product truth. Read the brief
> for _why_ a rule exists and DESIGN.md for _what_ the rule is.

## Why it exists

Extracted from five of Gus's production codebases that had each independently grown the same
layer — roughly **9,100 lines solving one ~2,000-line problem**:

| Codebase               | Kernel lines | Generation                                       |
| ---------------------- | -----------: | ------------------------------------------------ |
| `packages/falai/agent` |        3,266 | oldest — abstract classes, per-vendor subclasses |
| `tabrunner/chrome`     |        2,078 | newest transport — fetch-only, MV3-safe          |
| `smartgenius`          |       ~1,900 | newest seam — provider-neutral types             |
| `olhary`               |        1,178 | OpenAI-param-typed seam                          |
| `featury`              |          649 | OpenAI-param-typed seam                          |

The duplication was actively expensive: on **2026-09-01** featury and olhary shipped the same
five fixes independently (idle watchdog, `AbortSignal.any` bridging, TTFT, OpenRouter route
pin, per-call effort). Three separate 60-second idle watchdogs existed, identical to the
constant. Five error classifiers existed, **each holding knowledge none of the others had** —
which is the single highest-value merge in the package.

## Layout

```
providerkit/            ← repo root (this folder), git root
├── core/               ← the npm package `providerkit`
│   ├── src/
│   └── test/
├── site/               ← providerkit.dev — Astro + Starlight, open source
│   └── src/content/docs/  ← the docs, as plain markdown (guides/ is hand-written,
│                             reference/ is TypeDoc output and gitignored)
├── brand/              ← the mark, the OG card, and generate.ts — see brand/README.md
├── .github/workflows/  ← CI, and Cloudflare Pages deploy for providerkit.dev
├── README.md           ← the pitch; single source of truth, copied into core/ on publish
└── LICENSE             ← same
```

`core/` names its ROLE in the repo, not an npm scope. If adapters ever split for bundle
size they become `@providerkit/gemini` siblings; `core/` stays put.

## Commands

```bash
bun install                  # workspace root

cd core
bun run test                 # vitest, 344 tests
bun run typecheck
bun run lint
bun run build                # tsc → dist/, ESM only

cd site
bun run dev                  # needs `cd ../core && bun run build` first
bun run build
```

Root shortcuts: `bun run test`, `bun run build`, `bun run dev:site`.

## Naming and publishing — decided

- **npm: `@providerkit/core`.** The bare name is permanently unavailable — npm rejects it
  with a 403, "too similar to existing package provider-kit". That check normalizes
  punctuation, so `providerkit` and `provider-kit` are the same name to the registry and
  no appeal changes that. The scope was already reserved, so this costs nothing but the
  extra characters. Scoped packages publish restricted by default; `publishConfig.access`
  is set to `public` so a release can't silently go private.
- **`core/` is the role, not the identity.** If adapters ever split for bundle size they
  become `@providerkit/gemini` siblings — same scope, no rename, no broken links.
- **GitHub: org `providerkit`, repo `providerkit/providerkit`.** Matches the `falai-dev`
  precedent and allows maintainers later without a repo transfer.
- Release scripts match the other packages in `dev/packages`:
  `bun run release:patch|minor|major`. `prepublishOnly` runs lint → typecheck → test →
  build → `sync:docs` (which copies the root README and LICENSE into `core/`, so they are
  tracked once and `.gitignore`d inside `core/`).

- **Site deploys to Cloudflare Pages** on push to `main`, project `providerkit`. Needs
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets — same names and
  values as the other repos.
- **The repo must be public.** A free npm org can only host public packages, and a free
  GitHub org only gets unlimited Actions minutes on public repos. It is MIT anyway.

**Not yet done:** point the providerkit.dev DNS at the Pages project. `0.1.0` is on npm;
the next release waits on tabrunner proving the API (see **Next**).

## State

**Built, tested, green** (344 tests; typecheck, lint, build, and the MV3 guard all clean):

| Module                   | What it holds                                                              |
| ------------------------ | -------------------------------------------------------------------------- |
| `types.ts`               | the seam — messages, tools, chunks, usage, `stripReasoning`                |
| `errors.ts`              | **the merged classifier** — 13 kinds named by what fixes them              |
| `retry.ts`               | full-jitter backoff, Retry-After, stream retry, backup-model walker        |
| `watchdog.ts`            | 60s idle deadline + TTFT                                                   |
| `usage.ts`               | cost arithmetic (rates stay with the caller)                               |
| `transport.ts`           | fetch + SSE + the error envelope                                           |
| `tool-args.ts`           | truncation salvage + double-escape healing                                 |
| `tools.ts`               | validated, cancellable, time-bounded tool calls + registry                 |
| `schema.ts`              | clamp overflow to advertised bounds                                        |
| `context.ts`             | compaction decisions — `needsCompaction`, `pickCut`, `applyCompaction`     |
| `providers/anthropic.ts` | Anthropic shape                                                            |
| `providers/openai.ts`    | OpenAI shape (serves OpenRouter, DeepSeek, GLM, Kimi, Groq, …)             |
| `providers/responses.ts` | OpenAI Responses shape, incl. the ChatGPT subscription backend             |
| `providers/gemini.ts`    | Gemini REST/SSE — no SDK, thought signatures, thoughts billed as output    |
| `key-pool.ts`            | rotating keys — free round-robin then paid, `withKeyPool` decorator        |
| `rate-limit.ts`          | which subscription window bound (5h / weekly / monthly) and when it resets |
| `zod.ts`                 | `@providerkit/core/zod` — optional peer, typed tools                       |

**Not built yet:** nothing in the extraction's scope. Every concern the plan named is in.
What is unproven is _adoption_ — no codebase consumes this yet, so "every adopting codebase
gets smaller" is still a claim, not a measurement.

## Invariants — do not regress these

Each cost someone a production incident. The tests pin them; if one fails, a lesson is being
un-learned.

1. **Retry a stream only while nothing has been emitted.** Past the first chunk the stream is
   committed — a retry replays tokens the reader already saw. Same rule governs the
   backup-model walker (falai's original did _not_ have this, and would restart an answer in
   another model's voice mid-render).
2. **The watchdog aborts its OWN controller**, bridging the caller's via `AbortSignal.any`.
   That is what keeps a user's Stop (never retried) distinguishable from our timeout (always
   retried). `AbortSignal.any` also catches the already-aborted race no listener can.
3. **Body outranks status for the 4xx family**, and within it context › entitlement › quota ›
   auth. Each earlier fix is useless for the later ones. Swap two and the suite fails.
4. **Anthropic usage must be reconciled.** Its `input_tokens` EXCLUDES cache reads/writes;
   the OpenAI shapes report a cached subset INSIDE the prompt count. Unreconciled, an
   Anthropic prompt reads ~10× small — wrong in the ledger and wrong again in compaction.
5. **`stream_options.include_usage` is not optional** on the OpenAI shape. Without it no
   usage arrives and every call silently costs zero.
6. **`pickCut` never splits a tool call from its result** (providers 400 on the orphan — the
   exact failure compaction was called to avoid), never cuts into the system prompt, and
   always keeps the newest message.
7. **A failing tool is data, not an exception.** `invoke` returns an outcome the loop feeds
   back so the model can self-correct. Only a caller's abort escapes.
8. **No Node built-ins, no `process`, no `Buffer`, no vendor SDKs** anywhere in `core/src`.
   That is what keeps MV3, Workers and Deno working. Guard:
   `grep -rE 'from "node:|require\(|\bprocess\.env|\bBuffer\b' core/src`
9. **Price tables never ship here.** Volatile data on a vendor's schedule; a wrong number in
   a library is a wrong number in everyone's ledger. Callers pass `ModelRate`.

## Next

1. **Migrate tabrunner first** — hardest runtime (MV3, no Node, no zod) and the strongest
   existing implementation, so it pressure-tests the API where it is most likely to break.
   This is also the release gate: the version does not move until one real consumer proves
   the API.
2. Then smartgenius → featury → olhary.
3. **falai last, as `@falai/agent` v3** — it is the only consumer with a public API to break
   (six exported provider classes plus three error functions, and `OpenAICompatibleProvider`
   is an `abstract class` others extend). Clean break, major bump, no compat shims.

Consume via bun `catalog:` in each repo so upgrades stay opt-in per app and one bad publish
cannot take down five apps at once. **Each migration should be net-negative in lines** — if a
repo grows, the cut line was drawn in the wrong place.

## House rules

- 2-space, printWidth 100, double quotes (matches `.prettierrc`).
- Source imports keep real `.ts` extensions; `rewriteRelativeImportExtensions` emits `.js`.
- No `as any` / `as unknown as T`. Fix the type.
- Comments explain **why**, especially the non-obvious production reason. That is most of the
  value being preserved here — a rule without its reason gets "simplified" away next quarter.
