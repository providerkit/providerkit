---
title: Tools
description: A JSON-Schema-first tool kernel with timeouts, abort, structured outcomes, and optional zod ergonomics, plus the tools a vendor runs inside its own turn.
---

The kernel takes plain JSON Schema, because that is what every provider's tool contract wants and
it is the one shape that needs no dependency. zod is available as an optional peer for people who
want inference.

## Defining a tool

```ts
import { defineTool } from "@providerkit/core";

const readFile = defineTool({
  name: "read_file",
  description: "Read a UTF-8 file from the workspace.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Workspace-relative path" } },
    required: ["path"],
    additionalProperties: false,
  },
  timeoutMs: 10_000,
  isReadOnly: true,
  async run({ path }, ctx) {
    return await fs.readFile(path, "utf8");
  },
});
```

The flags are metadata your loop reads. The kernel does not enforce policy:

| Flag                | Meaning                                      |
| ------------------- | -------------------------------------------- |
| `isReadOnly`        | Changes nothing; safe to run without asking. |
| `needsApproval`     | The loop should gate this behind the user.   |
| `isConcurrencySafe` | May run in parallel with other tools.        |
| `isTerminal`        | Ends the turn: a submit or a final answer.   |

Left out, all four are `false`. Set `isReadOnly: true` only on a tool that changes nothing:
[resuming a turn](/guides/resume/) tells the model a read-only call is safe to run again.

## Wire repairs and schema sanitization

Gateways, streaming cutoffs, and vendor quirks corrupt tool calls in ways that standard SDKs drop as 400 errors:

- **Concatenated JSON (`findLastValidJsonObject`)**: When a gateway emits `{}{"query":"foo"}`, `parseToolArgs` extracts the valid object from the tail rather than failing.
- **Tool ID synthesis and bounding (`normalizeToolId`)**: Makes up a random ID (`call_pk_` plus random letters and digits) when an upstream sends a blank one, so the same call gets a different ID each time. An ID over 64 characters becomes its first 48 characters plus a hash, the same every time, so the ChatGPT Responses API does not reject the turn. To fix the IDs of a saved history, use `repairHistory`: it names a blank one `call_{message}_{call}`, which never changes between sends.
- **Gemini schema repair (`toGeminiToolSchema`)**: Gemini takes standard JSON Schema, so your schema goes out as written, with four exceptions that Gemini answers with a 400. A `required` name with no matching property is dropped. A Draft-04 `exclusiveMinimum: true` becomes the number form. Tuple `items` becomes `prefixItems`. A recursive `$ref` that Gemini cannot follow becomes `{}`. The same repair covers the schema you pass as `json`.
- **Anthropic schema sanitization (`toAnthropicToolSchema`)**: Unwraps root `anyOf` / `oneOf` unions into a unified object schema to prevent Anthropic's root-object rejection.

## Invoking

```ts
const outcome = await tool.invoke(rawArgsFromModel, { signal });

if (outcome.ok) {
  send(outcome.output);
} else {
  switch (outcome.kind) {
    case "invalid_input":
      /* tell the model what was wrong */ break;
    case "timeout":
      /* tool exceeded timeoutMs */ break;
    case "aborted":
      /* caller stopped */ break;
    case "failed":
      /* the tool threw */ break;
  }
}
```

`invoke` never throws. A tool that throws, times out, or receives arguments that fail validation
comes back as a structured `ToolOutcome`, because in an agent loop a thrown tool is not an
exception, it is a _result the model needs to see and react to_. Crashing the loop instead robs
the model of the chance to correct itself.

`call(input, ctx)` is the typed, direct path for your own code; it throws normally.

`accepts(rawArgs)` runs the same check as `invoke`, without running the tool, and returns `true`
or `false`. Ask it before you open an approval, so nobody approves a call that would come back
`invalid_input`.

## Arguments the model truncated

Providers stream tool arguments a few characters at a time, and a turn cut off at its output
ceiling leaves invalid JSON. The run then reports nothing while the answer sits in the fragments.

```ts
import { parseToolArgs, isCompleteJson } from "@providerkit/core";

const args = parseToolArgs(raw); // never throws
```

`parseToolArgs` parses normally when it can, and otherwise salvages the string fields it can
recover from the truncated JSON. It also heals double-escaped `\\uXXXX` sequences, which some
gateways emit when they re-encode a payload.

## Tool calls written as text

Some models write a tool call into their answer instead of calling the tool. The person reading
sees raw markup, and once it is in the history the model writes it again on later turns.

```ts
import { stripLeakedToolMarkup } from "@providerkit/core";

for await (const chunk of stripLeakedToolMarkup(provider.createStream(messages, tools))) {
  if (chunk.content) write(chunk.content);
}
```

It removes two shapes from `content` as the stream arrives:

- A DeepSeek token, which starts with `<` and a fullwidth `｜`, as in `<｜tool▁calls▁begin｜>`.
  Everything after it is the call's syntax, so the rest of the turn's text goes too.
- A made-up tag with an underscore in its name, then an attribute (`title="x"`) or a closing
  `/>`, like `<save_note title="x" />`. When the tag opens a pair, its closing tag `</save_note>`
  goes too. Only the tags go. The text around them stays.

A tag can arrive split across chunks, so text that could still become one (`<`, `<save_`) waits
for the next chunk. Text held that way goes out before the finish chunk, and before the stream's
own error. If the turn ends partway through a tag that already has an attribute, like
`<save_note title="x"`, that part is dropped.

Ordinary angle brackets stay: `a < b`, `<strong>`, `<user_id>` and `</user_id>`. So does a tag
name followed by anything but an attribute, like `sort <in_file >out_file` or
`Promise<user_row | null>`.

Only the text changes. Reasoning, tool calls and usage pass through as they came. A citation
whose span reaches removed text keeps its source but loses its span, the same as any span that
doesn't match the text.

A turn that was only markup ends with no text. To fail it like any other empty answer, wrap the
result in `requireContent`:

```ts
const checked = requireContent(provider.id, stripLeakedToolMarkup(stream));
```

Pass `onStrip` to see each leak. It runs once per leak, with the markup it removed. For a pair of
tags, that is the opening tag:

```ts
stripLeakedToolMarkup(stream, { onStrip: (markup) => log.warn("tool call in text", { markup }) });
```

It removes calls, it doesn't run them, and some get through. A call written as plain tags with no
attributes, the way GLM writes one, stays whole. The text between a pair's tags stays too. A `>`
inside an attribute ends the tag early, so the rest of it shows, and so does a tag that arrives
over several chunks and runs past 512 characters before it closes.

It can also remove text that is not a call. Code gets no exception: a tag with an underscore in
its name and an attribute, like `<save_note title="x" />` in an XML sample, is removed from a code
block too.

## zod

```ts
import { zodTool } from "@providerkit/core/zod";
import { z } from "zod";

const search = zodTool({
  name: "search",
  description: "Search the index.",
  input: z.object({ query: z.string(), limit: z.number().max(50).default(10) }),
  async run({ query, limit }) {
    return await index.search(query, limit);
  },
});
```

zod is an **optional peer dependency**. The kernel never imports it, so a project without zod
(a Chrome MV3 extension, say) pays nothing for its existence.

When zod rejects a value for its type, `zodTool` repairs two mistakes models often make, then
checks the call again:

- an array or object sent as a JSON string: `"rows": "[{\"qty\":2}]"` becomes
  `"rows": [{ "qty": 2 }]`
- a string sent as an object with only a `text` key: `"title": { "text": "Q3" }` becomes
  `"title": "Q3"`

Nothing else changes. A string the schema accepts stays as sent, even when it looks like JSON,
and `"42"` never becomes a number. If the call still fails, the model reads what the second check
found, so a mistake inside the decoded JSON still reaches it. It sees at most five problems, each
with its path, then how many more there are:

```text
Invalid arguments for sheet: rows.0.qty: Invalid input: expected number, received string; …; and 35 more
```

`clampOverflow` is worth knowing about for terminal tools: when a model's output exceeds a
schema's limits, clamping to the limit and submitting beats rejecting and losing the whole turn.
A value the repairs fixed is clamped too.

### Checking results

Pass `output` to check what `run` returns:

```ts
const lookup = zodTool({
  name: "lookup",
  description: "Look up an order.",
  input: z.object({ id: z.string() }),
  output: z.object({ status: z.string(), total: z.number() }),
  async run({ id }) {
    return await orders.get(id);
  },
});
```

A result that fails the check comes back as a `failed` outcome, and the model reads the problems
like any other failure. `invoke` still never throws. Unless the tool is marked `isReadOnly`, the
message also tells the model to check the call's effect before calling it again, because the call
already ran. A result that passes is the parsed value, so keys the schema doesn't list are dropped
before the model sees them.

`output` also fills `outputSchema`, for code that writes types for tool results. On a tool from
`defineTool`, `outputSchema` only describes the result: nothing checks it.

## Hosted tools

Some tools run on the vendor's side, inside the model's own turn: web search, web fetch, code
execution, file search and image generation. Import your provider from `@providerkit/core/hosted`
and ask for the tools by type. Your loop runs none of them.

```ts
import { collectTurn } from "@providerkit/core";
import { createPresetProvider } from "@providerkit/core/hosted";

const provider = createPresetProvider("google", { apiKey });
const turn = await collectTurn(
  provider.createStream(history, [], { hostedTools: [{ type: "web_search" }] }),
);

turn.message.content; // the answer
turn.message.citations; // the pages it cites, and where in the answer
turn.message.hostedCalls; // what the vendor ran: the search, its query, the pages it found
```

The same import provides `createAnthropicProvider`, `createResponsesProvider`,
`createGeminiProvider`, `createOpenAIProvider`, `presetAdapter` and `createRegistry`.
Their arguments stay the same. Preset model chains, fallback specs and registry connections
keep the opt-in, including adapters rebuilt for key rotation or token refresh.
Hand-built fallback providers keep their own setup, so import their constructors from `/hosted`
too. Use `withConfiguredFallbacks` from `/hosted` when adding preset fallback specs separately.

Constructors from `@providerkit/core` stay plain. They refuse `hostedTools` and same-provider
`hostedItems` replay with an `invalid` error before any request, even with `optional: true`
or `toolChoice: "none"`. Importing `/hosted` does not change any plain provider instance.
The base entry still exports the hosted types, but bundles none of the hosted encoders or parsers.
`planHostedTools` and `hostedRefused`, for custom adapters, now come from `/hosted` too.

A hosted call is never a tool call. It never lands in `toolCalls`, never makes the finish
`tool_calls`, and never gets a `tool` message back. When one fails, the turn goes on: the call
says `status: "failed"`, and `error` holds the vendor's code, such as `max_uses_exceeded`.

### Which adapter sends what

| Type               | Anthropic | Responses | Gemini | Chat Completions                                  |
| ------------------ | --------- | --------- | ------ | ------------------------------------------------- |
| `web_search`       | yes       | yes       | yes    | OpenRouter, and OpenAI's `-search-preview` models |
| `web_fetch`        | yes       | no        | yes    | no                                                |
| `code_execution`   | yes       | yes       | yes    | no                                                |
| `file_search`      | no        | yes       | yes    | no                                                |
| `image_generation` | no        | yes       | no     | no                                                |

That is what each vendor's own API runs. Every other host runs none until you say it does: a
gateway that doesn't know a hosted tool can ignore it and answer without searching, and nothing
tells you. Once you have checked an endpoint, set `servesHostedTools` on its provider config.

A fetched page can carry instructions written for the model, and the model picks which pages to
fetch. Set `allowedDomains` to the sites you trust.

### Refused before anything is sent

Each setting on a hosted tool narrows what the vendor may do. An adapter that can't apply one
refuses the request with an `invalid` error that names the setting, because sending the tool
without it would let the vendor do more than you allowed.

| Setting                                                | Anthropic        | Responses | Gemini | Chat Completions |
| ------------------------------------------------------ | ---------------- | --------- | ------ | ---------------- |
| `allowedDomains`, `blockedDomains`                     | one or the other | yes       | no     | OpenRouter only  |
| `maxUses`                                              | yes              | no        | no     | OpenRouter only  |
| `userLocation`                                         | yes              | yes       | no     | yes              |
| `maxContentTokens`, on a fetch                         | yes              |           | no     |                  |
| `fileIds`, on code execution                           | no               | yes       | no     |                  |
| `storeIds` and `maxResults`, on a file search          |                  | yes       | yes    |                  |
| `size`, `quality`, `format`, `background`, on an image |                  | yes       |        |                  |

Mark a tool `optional: true` to drop it there instead of refusing. The whole tool goes, never
one setting: a search without its domain filter does more than you asked, and no search at all
only does less.

These are refused too:

- the same type listed twice;
- a forced `toolChoice` (`"required"`, or a named tool) beside hosted tools, because each vendor
  reads that pair differently. `toolChoice: "none"` sends no hosted tool at all;
- on Anthropic, a function tool named `web_search`, `web_fetch`, `code_execution`,
  `bash_code_execution` or `text_editor_code_execution`;
- on Gemini 2, hosted tools beside function tools. Gemini 3 runs both;
- on Gemini, file search beside another hosted tool. Send them on separate calls, or mark a
  conflicting tool optional;
- any hosted tool on Antigravity.

### Citations

Each citation names its source and, when it can, the part of the answer it covers. `start` and
`end` are indices into `content`, already moved from what the vendor counts in (UTF-8 bytes on
Gemini, code points on OpenAI). `anchor: "claim"` means the span is text the source backs, as
Anthropic and Gemini cite. `anchor: "marker"` means the span is a link the model wrote, as OpenAI
cites. A span that doesn't match the text is left off, and the citation keeps its source.

### Sending the turn back

`hostedItems` is the vendor's own record of the turn: search results, fetched pages, code
output. Anthropic and Gemini send it back with the turn, so the model keeps what it read.
Responses and Chat Completions never send it. It goes back only to the provider that made it,
and only while the answer is unchanged: edit the text, and the turn goes back as plain text.

Keep `hostedItems` with your stored history, like `reasoningItems`, and never send it to a
browser. `hostedCalls` and `citations` are as private as the answer: an excerpt can quote your
own files.

### Billing

Vendors bill hosted calls one by one, beside the tokens. `usage.hostedCalls` counts them by
type, and `costUsd` prices them at `rate.hosted`, the per-call prices from your vendor's price
sheet. A cost the provider reports, as OpenRouter does, already includes them.

A hosted call commits the stream, so a retry never runs it twice. A search loop can run several
model passes in one turn and bill all of them, so `inputTokens` can read larger than the window
ever was. Where Anthropic states the last pass, `usage.contextTokens` holds it. A long Anthropic
search can pause its turn: the stream sends it back and carries on, up to ten times, and every
pass is billed.
