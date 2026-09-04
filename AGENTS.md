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
> shipped pages rather than ahead of them. Read the brief
> for _why_ a rule exists and DESIGN.md for _what_ the rule is.

## Why it exists

Extracted from five private production codebases that had each independently grown the same
layer — roughly **9,100 lines solving one ~2,000-line problem**, spanning three generations of
the same idea: abstract classes with per-vendor subclasses (3,266 lines, the oldest), two
seams typed against OpenAI's own parameter types, and two newer ones — a provider-neutral
seam, and a fetch-only transport built to survive MV3.

The duplication was actively expensive. On one day in September 2026 two of them shipped the
same five fixes independently (idle watchdog, `AbortSignal.any` bridging, TTFT, OpenRouter
route pin, per-call effort). Three separate 60-second idle watchdogs existed, identical to the
constant. Five error classifiers existed, **each holding knowledge none of the others had** —
which is the single highest-value merge in the package.

The source repos are private and are not named here; nothing about the package depends on
knowing which they were.

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
bun run test                 # vitest, 380 tests
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
- **GitHub: org `providerkit`, repo `providerkit/providerkit`.** An org rather than a personal
  repo, so maintainers can be added later without a transfer.
- Release scripts match the other packages in `dev/packages`:
  `bun run release:patch|minor|major`. `prepublishOnly` runs lint → typecheck → test →
  build → `sync:docs` (which copies the root README and LICENSE into `core/`, so they are
  tracked once and `.gitignore`d inside `core/`).

- **Site deploys to Cloudflare Pages** on push to `main`, project `providerkit`. Needs
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets.
- **The repo must be public.** A free npm org can only host public packages, and a free
  GitHub org only gets unlimited Actions minutes on public repos. It is MIT anyway.

**Not yet done:** point the providerkit.dev DNS at the Pages project. `0.2.0` is on npm.

## State

**Built, tested, green** (380 tests; typecheck, lint, build, and the MV3 guard all clean):

| Module                   | What it holds                                                              |
| ------------------------ | -------------------------------------------------------------------------- |
| `types.ts`               | the seam — messages, tools, chunks, usage, `stripReasoning`                |
| `errors.ts`              | **the merged classifier** — 13 kinds named by what fixes them              |
| `retry.ts`               | full-jitter backoff, Retry-After, stream retry, backup-model walker        |
| `watchdog.ts`            | 60s idle deadline + TTFT                                                   |
| `usage.ts`               | cost arithmetic (rates stay with the caller)                               |
| `transport.ts`           | fetch + the error envelope, and `parseSseStream` on its own                |
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

Plus `test/golden.test.ts` — the cross-vendor conformance matrix. Not a module: the one place
the four adapters are asked the same question, on recorded wire bytes, and have to agree.

**Not built yet:** nothing in the extraction's scope. Every concern the plan named is in,
verification included.

## Invariants — do not regress these

Each cost someone a production incident. The tests pin them; if one fails, a lesson is being
un-learned.

1. **Retry a stream only while nothing has been emitted.** Past the first chunk the stream is
   committed — a retry replays tokens the reader already saw. Same rule governs the
   backup-model walker (the oldest of the five did _not_ have this, and would restart an answer in
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
10. **Four adapters, one answer.** The same turn on four wires assembles into the same text,
    reasoning, tool calls, usage and finish reason; the same failure classifies the same way.
    `test/golden.test.ts` is that check — a divergence passes four green per-adapter suites and
    breaks the app that switches provider. It is also the only suite fed BYTES the way a socket
    delivers them (mid-frame reads, CRLF split across a read, keep-alives, `[DONE]`), which is
    where three of its four findings came from.
11. **A failure inside a 200 is still a failure.** An SSE response commits to 200 at its headers,
    so a throttle landing after them arrives as a body payload. Unread, the turn ends as a
    successful zero-token completion: nothing retries, nothing logs, no key rotates. One
    `streamError` for all four shapes.

## Next

`0.2.0` is on npm and one codebase has migrated onto it — a Chrome MV3 extension, the hardest
of the runtimes this package promises, **452 lines lighter** afterwards (667 out, 215 in). Four
more private migrations follow; they are tracked in `ROADMAP.local.md`, which is deliberately not in this
repo because it is a map of codebases that are not open.

Two open chores: point the providerkit.dev DNS at the Pages project, and set the org avatar
(`brand/providerkit-avatar-1024.png` — GitHub has no API for it).

**Every migration must be net-negative in lines.** If an adopting repo grows, the cut line was
drawn in the wrong place and the fix belongs here, not in the adopter.

### What the first migration taught

- **Split the envelope from the framing wherever both exist.** The adopter could take
  `streamSse`'s SSE reader but not its error envelope: its failure line is translated, and its
  log level splits on whether the kind is one its own UI already explains. That is not one app
  being odd — an app with its own copy, log levels or auth refresh is the normal case.
  `parseSseStream` is exported beside `streamSse` for exactly that. Expect the same shape
  elsewhere and cut there **before** an adopter has to keep a copy.
- **Not everything should migrate.** The adopter's context-window ladder stayed put: it learns
  the real ceiling from a provider's own length rejection instead of guessing from a model
  name, which is better than the regex ladder here, and it is tied to that app's storage. A
  worse shared version is not a win — leaving a module behind is a valid outcome.
- **Widening a union is a breaking change downstream even when nothing throws.** The merged
  classifier answers 13 kinds where the adopter's answered eight-or-`undefined`, so its
  kind→copy map needed two new strings in every locale it ships. Keep such maps exhaustive
  (`satisfies Record<ErrorKind, …>`) so a 14th kind fails the build rather than silently
  falling through to a status code.

## House rules

- 2-space, printWidth 100, double quotes (matches `.prettierrc`).
- Source imports keep real `.ts` extensions; `rewriteRelativeImportExtensions` emits `.js`.
- No `as any` / `as unknown as T`. Fix the type.
- Comments explain **why**, especially the non-obvious production reason. That is most of the
  value being preserved here — a rule without its reason gets "simplified" away next quarter.
