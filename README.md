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
- `reasoning_content` that must be replayed on tool-call turns — and must *not* be sent
  when thinking is off
- a tool-call's JSON silently truncated mid-argument because the output ceiling was hit

providerkit is that knowledge, as a library.

## What this is not

**Not an agent framework.** There is no loop here, no prompt, no memory, no graph. Your
loop is where your product lives; it should stay yours. This package is everything
underneath it.

## Quick look

```ts
import { ProviderError, isTransient, isBackupEligible } from "providerkit";

try {
  for await (const chunk of provider.createStream(messages, tools)) {
    // chunk: { type: "delta" | "usage" | "finish", content?, reasoning?, toolCalls?, usage? }
  }
} catch (raw) {
  const err = ProviderError.from("anthropic", raw);

  err.kind; // "overload" | "rate" | "quota" | "entitlement" | "auth" | "context" | …
  err.retryAfterMs; // honoured from Retry-After or Gemini's RetryInfo
  err.body; // the provider's actual words, never "400 status code (no body)"

  if (isTransient(err.kind)) retry();
  else if (isBackupEligible(err.kind)) tryAnotherModel();
  else if (err.kind === "context") compactAndRetry();
  else surface(err);
}
```

Every `kind` is named for **what fixes it**, which is the only question a caller ever has.

## Origin

This was extracted from five production codebases that had each independently grown the
same layer — about 9,100 lines solving one ~2,000-line problem. They had three separate
60-second idle watchdogs, identical down to the constant. On one day in September 2026, two
of them shipped the same five fixes independently.

They had also each learned a *different* part of the problem. One walked the `cause` chain
for dead sockets; one parsed Gemini's `RetryInfo`; one read the body before the status and
knew the quota wordings in five languages; one knew Anthropic's `529` and when a failure is
worth trying a different model.

The classifier here is the union of all five, and the test suite is every failure any of
them ever saw. That is the part worth having.

## License

MIT
