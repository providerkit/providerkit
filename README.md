<img src="brand/providerkit-mark.svg" alt="" width="76" align="left" hspace="4" vspace="2">

# providerkit

**The layer under your agent loop.** One seam for every LLM provider, plus the failure
handling you only learn in production.

```bash
bun add @providerkit/core   # npm / pnpm / yarn all fine
```

Zero runtime dependencies. `fetch` only — no vendor SDKs, no Node built-ins — so the same
build runs in Bun, Node, Cloudflare Workers, Deno and a Chrome MV3 service worker.

## What this is

Most "unified LLM interface" libraries stop at the interface. That part is easy, and it is
not where the time goes. The time goes here:

- a stream that opens, sends nothing, and never ends
- a socket that dies four `cause` levels down, with no HTTP status to read
- quota exhaustion arriving as `429` from one vendor, `402` from another, `403` from a
  third and `400` from a fourth — with "retry" being the wrong advice for all of them
- a `429` that is really a context overflow, where waiting fixes nothing and compaction
  fixes everything
- a plan that never included the API, which neither a new key nor a top-up will fix
- Anthropic reporting cache tokens _outside_ the input count while OpenAI reports them
  _inside_ it — so the same conversation costs two different things
- `reasoning_content` that must be replayed on tool-call turns, and must _not_ be sent
  when thinking is off
- a tool call's JSON truncated mid-argument, throwing away an answer that was right there

providerkit is that knowledge, as a library.

## What this is not

**Not an agent framework.** There is no loop here, no prompt, no memory, no graph. Your
loop is where your product lives; it should stay yours. This is everything underneath it.

## Use

```ts
import { createAnthropicProvider, ProviderError, isTransient } from "@providerkit/core";

const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-5",
});

try {
  for await (const chunk of provider.createStream(messages, tools, { effort: "medium" })) {
    if (chunk.content) write(chunk.content);
    if (chunk.usage) record(chunk.usage); // one usage shape across every provider
  }
} catch (raw) {
  const err = ProviderError.from("anthropic", raw);
  if (err.kind === "context") return compactAndRetry();
  if (isTransient(err.kind)) return retry(err.retryAfterMs);
  surface(err); // .body has their actual words
}
```

**Full documentation lives at [providerkit.dev](https://providerkit.dev)** — it is the single
source of truth for usage, and this README deliberately stays a front door so the two cannot
drift.

| Guide                                                                   | What it covers                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------ |
| [Getting started](https://providerkit.dev/guides/getting-started/)      | Install, first stream, swapping vendors          |
| [The provider seam](https://providerkit.dev/guides/providers/)          | Message, chunk and tool shapes                   |
| [Errors](https://providerkit.dev/guides/errors/)                        | The thirteen kinds, and why status is not enough |
| [Retries and fallback](https://providerkit.dev/guides/retries/)         | Backoff, the commitment rule, backup models      |
| [Streaming and the watchdog](https://providerkit.dev/guides/streaming/) | The stream that stops sending; TTFT              |
| [Tools](https://providerkit.dev/guides/tools/)                          | Tool kernel, truncated-argument salvage, zod     |
| [Context and compaction](https://providerkit.dev/guides/context/)       | When to compact, and where to cut                |
| [Usage and cost](https://providerkit.dev/guides/usage/)                 | Reconciling cache tokens, cost, savings          |

The [API reference](https://providerkit.dev/reference/) is generated from the source, so it
cannot drift either.

## Origin

This was extracted from five production codebases that had each independently grown the same
layer — about 9,100 lines solving one ~2,000-line problem. They had three separate
60-second idle watchdogs, identical down to the constant. On one day in September 2026, two
of them shipped the same five fixes independently.

They had also each learned a _different_ part of the problem. One walked the `cause` chain
for dead sockets; one parsed Gemini's `RetryInfo`; one read the body before the status and
knew the quota wordings in five languages; one knew Anthropic's `529` and when a failure is
worth a different model; one could rescue an answer from a tool call the model truncated.

The classifier here is the union of all five, and the suite is every failure any of them
ever saw. That is the part worth having.

## Repo

```
core/     the npm package `@providerkit/core`
site/     providerkit.dev — Astro + Starlight, also open source
brand/    the mark, the OG card, and the generator for both
```

`bun install`, then `cd core && bun run test`. See [AGENTS.md](./AGENTS.md) for the layout,
the invariants worth not regressing, and what is left to build.

## Status

Working and tested (380 tests): the seam, the error classifier, retry and backup-model
fallback, the idle watchdog, cost math, the fetch/SSE transport, tool-argument salvage, the
Anthropic, OpenAI-shape, Responses and Gemini adapters, the multi-key rotation pool,
rate-limit reset windows, the tool kernel, schema clamping, and the compaction decisions.

That is the whole extraction, and the claim it rests on is that an adopting codebase gets
**smaller**. The first migration — a Chrome MV3 extension, the hardest runtime of the five
and the one with no Node, no bundler escape hatch and no zod — **deleted 634 lines** and kept
every one of its six gates green. If a repo grows on adopting this, the boundary was drawn in
the wrong place.

## License

MIT
