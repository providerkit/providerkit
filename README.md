<img src="brand/providerkit-mark.svg" alt="" width="76" align="left" hspace="4" vspace="2">

# providerkit

**The layer under your agent loop.** One seam for every LLM provider, plus the failure
handling you only learn in production.

```bash
bun add providerkit   # npm / pnpm / yarn all fine
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
import { createAnthropicProvider, drainStream } from "providerkit";

const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-5",
});

for await (const chunk of provider.createStream(messages, tools, { effort: "medium" })) {
  if (chunk.content) process.stdout.write(chunk.content);
  if (chunk.usage) console.log(chunk.usage); // one meaning across every provider
}
```

`createOpenAIProvider` speaks the dialect most gateways do, so it serves OpenAI, OpenRouter,
DeepSeek, GLM, Kimi, Groq, Together, vLLM, Ollama and LM Studio:

```ts
const provider = createOpenAIProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseUrl: "https://openrouter.ai/api",
  id: "openrouter",
  model: "deepseek/deepseek-v4-pro",
  // Keep the prompt cache warm: it lives on the upstream host's account, and
  // OpenRouter's default routing hops hosts between rounds — every hop is a
  // cold cache, in both latency and effective input cost.
  providerOrder: ["deepinfra", "fireworks"],
});
```

### Failures, named by what fixes them

```ts
import { ProviderError, isTransient, isBackupEligible } from "providerkit";

try {
  // …
} catch (raw) {
  const err = ProviderError.from("anthropic", raw);

  err.kind; // "overload" | "rate" | "quota" | "entitlement" | "auth" | "context" | …
  err.retryAfterMs; // honoured from Retry-After, vendor reset headers, or Gemini's RetryInfo
  err.body; // the provider's actual words, never "400 status code (no body)"

  if (err.kind === "context") compactAndRetry();
  else if (isBackupEligible(err.kind)) tryAnotherModel();
  else if (isTransient(err.kind)) retry();
  else surface(err);
}
```

### Retrying, safely

```ts
import { withStreamRetry, streamWithBackupModels } from "providerkit";

// Retries only while NOTHING has been emitted. Past the first chunk the stream
// is committed — a retry would replay tokens already on the reader's screen.
const stream = withStreamRetry((signal) => provider.createStream(messages, tools, { signal }));

// Walks [primary, ...backups] on overload and rate limits only; an auth failure
// or an invalid request would land identically on every backup.
const withFallback = streamWithBackupModels((model) => run(model), {
  models: ["claude-opus-5", "claude-sonnet-5"],
});
```

### The watchdog

```ts
import { streamWatch, watchChunks } from "providerkit";

const watch = streamWatch({ provider: "openai", signal: userSignal });
for await (const chunk of watchChunks(
  watch,
  provider.createStream(messages, tools, {
    signal: watch.signal,
  }),
)) {
  // any byte re-arms the deadline
}
watch.firstChunkMs(); // TTFT — the number a prompt-cache pin exists to shrink
```

A stream that goes 60 seconds without a byte is aborted and surfaced as a transient
`timeout`. The watchdog aborts its _own_ controller and only bridges the caller's, so your
user's Stop stays distinguishable from our deadline: one is never retried, the other always
is.

### Tools

JSON Schema by default, so the core needs no zod:

```ts
import { defineTool, ToolRegistry } from "providerkit";

const search = defineTool({
  name: "search",
  description: "Search the corpus",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  run: async ({ q }, ctx) => findAll(q, { signal: ctx.signal }),
});

const outcome = await search.invoke(rawArgsFromModel);
// { ok: false, kind: "invalid_input" | "timeout" | "aborted" | "failed", error }
```

A failing tool is **data**, not an exception — the loop feeds `error` back so the model can
correct itself. Only a caller's abort escapes.

With zod, from the optional entry point:

```ts
import { zodTool } from "providerkit/zod";

const submit = zodTool({
  name: "submit",
  description: "Submit the final answer",
  isTerminal: true,
  clampOverflow: true, // a terminal tool gets no second chance
  input: z.object({ summary: z.string().max(2000) }),
  run: async (input) => input,
});
```

### Truncated tool calls

```ts
import { parseToolArgs, isCompleteJson } from "providerkit";

// Never throws. A turn cut off mid-argument keeps every field that closed
// before the cut, plus the half-written one the cut landed in.
const args = parseToolArgs(rawArgumentString);
```

### Compaction

The decisions, not the prompt — the summary is yours to write:

```ts
import { needsCompaction, pickCut, applyCompaction, historyBudgetTokens } from "providerkit";

if (needsCompaction(lastInputTokens, contextWindow)) {
  const cut = pickCut(messages, historyBudgetTokens(contextWindow));
  messages = applyCompaction(messages, cut, await summarize(messages.slice(0, cut)));
}
```

`pickCut` never splits a tool call from its result (every provider rejects the orphan with a
400 — the failure compaction was called to avoid), never cuts into the system prompt, and
always keeps the newest message.

### Cost

The arithmetic, not the rates. A price table is volatile data about a catalogue that differs
per application, and a wrong number shipped in a library is a wrong number in everyone's
ledger — so you keep the numbers, verifiable line by line against a vendor's price sheet:

```ts
import { UsageTracker } from "providerkit";

const tracker = new UsageTracker();
tracker.add(usage, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }); // USD per Mtok
tracker.costUsd;
tracker.cacheSavingsUsd; // what the cache saved, for the "is caching even working" question
```

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
core/    the npm package `providerkit`
site/    providerkit.dev — also open source
```

`bun install`, then `cd core && bun run test`. See [AGENTS.md](./AGENTS.md) for the layout,
the invariants worth not regressing, and what is left to build.

## Status

Working and tested (218 tests): the seam, the error classifier, retry and backup-model
fallback, the idle watchdog, cost math, the fetch/SSE transport, tool-argument salvage, the
Anthropic and OpenAI-shape adapters, the tool kernel, schema clamping, and the compaction
decisions.

Not yet: the Gemini and Responses adapters, and the multi-key rotation pool.

## License

MIT
