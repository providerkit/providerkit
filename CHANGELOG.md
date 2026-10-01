# Changelog

All notable changes to `@providerkit/core` will be documented in this file.

## [0.17.2] - 2026-10-01

### Fixed

- **The `chatgpt` preset's default model no longer fails every call.** It defaulted to `gpt-5.3-codex`, which the ChatGPT backend no longer accepts, so every call that used the default got a 400 that said the model isn't supported with a ChatGPT account. `gpt-5.3-codex-spark` and `gpt-5.4-mini` were in the list too, and the backend rejects them as well. The default is now `gpt-6-sol`. The list holds the eight models the backend accepted on 2026-10-01, from `gpt-6-sol` down to `gpt-5.5`.

## [0.17.1] - 2026-10-01

### Fixed

- **One image Grok won't take no longer fails the whole request.** The Grok backend refuses an image with a side under 8 px, an area under 512 px², or more than 5 MB once decoded. The `grok` preset now replaces each of those with a note the model reads, like `[image omitted: image/png] (4x4 below minimum side 8px)`. A WebP image becomes a note too, because its size can't be checked. Only the last 4 images in a request are sent, and each older one gets a note that says so. The limits come from cc-proxy, which measured them on the live backend.

### Added

- **`gateImages(messages, limits)`** applies the same check to any history, for an app with its own adapter. `ImageLimits` holds the numbers, and the `imageLimits` option sets them on a Responses provider.

## [0.17.0] - 2026-10-01

### Changed

- **A turn that only thought now fails.** `requireContent`, which `withWatchdog` turns on by default, used to count reasoning as an answer. A high-effort model capped at 2,048 tokens spent all of them thinking and answered with an empty string. That passed as a success 22 times in a row in one production app, and the app's JSON parse failed with no hint why. An answer is now text or a tool call. Reasoning still streams as it arrives. An empty `stop` right after a tool result still passes.
- **An empty turn that hit `maxTokens` is `invalid`, not `overload`.** The cap was yours, so retrying it, or walking to a backup model, fails the same way and cools down models that did nothing wrong. The error says so: `the output cap ran out before any answer (2048 of 2048 output tokens went to reasoning) — raise maxTokens or lower effort`. Any other empty turn is still `overload`.

## [0.16.1] - 2026-10-01

### Fixed

- **A long `idleMs` was cut short at 5 minutes.** 0.16.0 added a progress clock with a 5-minute default, and raising `idleMs` didn't raise it. An outer watchdog set to 30 minutes, so a model chain could rotate inside it, aborted the whole chain at 5. When you don't set `progressMs`, it now defaults to `idleMs` if that is longer. A `progressMs` you set is still used as given.

## [0.16.0] - 2026-10-01

Lessons from cc-proxy, a proxy that serves Claude Code over Codex, Kimi, Grok, OpenCode Go and GLM every day. Most of these are bugs it hit live, and this package had too.

### Changed

- **A stream that ends before its turn does now throws.** No finish reason, no terminal event, no `[DONE]`: all four adapters hand over what arrived, then throw a `network` error, the same one a socket dying mid-read throws. Before, the turn ended quietly with no finish and no usage. A caller that never checks the finish kept half an answer as the whole one, and the ledger booked a billed turn as free. A test double that streams without an end signal now fails; give it the one its wire sends.
- **The watchdog runs two clocks.** The idle clock (60 s) now counts any byte, keep-alives included, so a provider that pings while it buffers a long tool call is no longer killed at 60 s. A new progress clock (`progressMs`, 300 s) counts chunks from the moment the request is sent. It still catches a route that only sends keep-alives, and it gives a backend room to think before its first byte: the ChatGPT backend sends nothing for minutes on a large high-effort turn.
- **An empty turn right after a tool result is no longer a failure.** An agent whose answer IS the tool call ends every turn that way. Empty with a length finish, or after a user message, still fails.
- **Responses tools say `strict: true` or `false`, never nothing.** It is `true` only when the schema already qualifies. Left to the default, the backend made optional arguments required and the model invented values for them.

### Added

- **`parallelToolCalls: false`** asks for at most one tool call per turn. Gemini has no such switch, so it refuses `false` with an `invalid` error instead of ignoring it.
- **`TokenUsage.reasoningTokens`**: the thinking share of `outputTokens`, on Responses, the OpenAI dialect and Gemini. It explains a turn that came back empty with a length finish. Anthropic does not report it.
- **`grok` preset** for a Grok subscription (SuperGrok, X Premium), on the backend the Grok CLI uses. `xai` stays the keyed API.
- **`StreamOptions.onActivity`** is called on every byte the stream reads. The watchdog uses it, and so can you.
- **`withoutPatterns`** removes every `pattern` from a JSON Schema, wherever a schema can sit.
- **`streamCut`**, the error an adapter throws when a stream ends early.

### Fixed

- **The `chatgpt` preset failed every call with a 404**, reported as a wrong model id. It now posts to `/backend-api/codex/responses` and sends the `session-id` header the backend keys its cache on.
- **A spent ChatGPT window was retried as a throttle.** `usage_limit_reached` is now `quota`, with its reset time and its window (5 h or weekly) read from the `x-codex-*` headers. A `codex.rate_limits` frame that says the limit is reached, followed by a closed stream, is `quota` too, unless credits cover it.
- **Flagged prompts were retried three times.** `invalid_prompt` and `bio_policy` are `content` now, and never retried.
- **Grok tool calls came back with no name and no arguments.** Grok keys a call by `call_id` alone, and the Responses adapter now follows it.
- **A Responses turn that ended `incomplete` or `failed` read as a clean stop.** The status on the terminal event now decides it. `response.done`, OpenCode's name for that event, is read too.
- **A Gemini prompt blocked outright** was read as a cut stream and retried into the same block. It is `content` now.
- **The ChatGPT backend 400'd any request with a regex it could not compile** in a tool schema, like the one in Claude Code's Artifact tool. Responses tools now go out without `pattern`.
- **Anthropic cache writes were billed twice**, at 2.25× the input rate.
- **Kimi cache hits were billed at the full input rate.** Kimi reports them at `usage.cached_tokens`, which is now read.
- **Parallel tool calls with images 400'd on the OpenAI dialect.** The images went out after each tool result. They now follow the whole run of results.
- **`Retry-After: 1.5` meant "retry now"**, and `retry-after-ms` was ignored. Both are read as waits now.
- **A Claude OAuth 529 benched its model for days.** The account's window reset, sent on every response, was read as the wait. Window headers now count only on a `rate` or `quota` answer.
- **The SSE reader** reads bare-CR line endings, gives up on a frame over 8 MiB instead of buffering forever, and no longer rescans the whole buffer on every read.
- **`sessionId` becomes `prompt_cache_key` on Responses**, so a conversation's turns hit the same cache.

## [0.15.1] - 2026-10-01

### Fixed

- **A forced tool choice failed on every request to Claude Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1.** `toolChoice: "required"` or `{ name }` went out as `tool_choice` `any` or `tool`, and Anthropic's Thinking page says these four models "reject forced tool use on every request with a 400 error". They now get no `tool_choice`, which means `auto`, as that page advises. `{ name }` sends only that tool, so the model cannot call a different one. It can still answer in text, so check for the tool call. A Claude id the adapter does not know yet is treated the same way. `"none"` and every other model are unchanged.
- **`effort: "none"` still thought on Claude Sonnet 5.5.** The adapter had no row for it and sent the lowest effort, which thinks when the model judges a turn hard. It now sends `thinking: { type: "between_tools" }`, the model's lowest setting: no thinking before the answer. `disabled` is a 400 on this model.

## [0.15.0] - 2026-09-27

### Added

- **`opencode-go-responses` preset.** OpenCode Go serves Muse Spark Contributor on the Responses API rather than Chat Completions. The preset sends the required session header and defaults to `muse-spark-1.3-contributor`. Live checks passed text, images, strict JSON Schema, parallel tool calls and tool-result round trips.

### Fixed

- **Muse Spark Contributor rejected the shared meanings of `effort: "none"` and `toolChoice: "none"`.** Its lowest reasoning tier is `minimal`, and it accepts only automatic tool choice. The Responses adapter now maps no reasoning to `minimal` for this model and encodes no tools by omitting the tool list. Named and required choices remain explicit so the endpoint refuses unsupported behavior instead of silently weakening it.
- **Responses presets could not send a per-call session header.** They now support the same stable fallback id and `StreamOptions.sessionId` override as Chat Completions presets.

## [0.14.1] - 2026-09-27

### Fixed

- **A watchdog around a model chain cancelled the whole chain instead of rotating.** The fallback pool correctly treats its input `signal` as the caller's cancellation, so `withWatchdog(createPresetProvider(...))` could not distinguish a silent candidate from a person pressing Stop. `createPresetProvider` now accepts `watchdog`; it wraps every model and configured fallback separately, while a caller's `signal` still cancels the whole chain immediately.

## [0.14.0] - 2026-09-27

### Added

- **`opencode-go` preset.** OpenCode Go serves many open models on one key, and each model has its own monthly limit. By default the preset tries `mimo-v2.6-flash`, `mimo-v2.5`, `glm-5.3-flash`, `qwen3.8-flash` and `longcat-2.0`, in that order, and moves to the next when one fails. All five passed plain text, tool calls and json_schema on 2026-09-27. DeepSeek is left out because Go serves it only when the workspace allows Global regions.
- **`models` on `createPresetProvider`.** A chain of models on one endpoint and key: the first answers, and the rest take over in order when it fails. It wins over `model` and the preset's `rotation`, and `fallbacks` still run after it.
- **`StreamOptions.sessionId`.** The conversation or job id. It goes only to endpoints that ask for it (Go reads `x-opencode-session` and refuses a call without it). Everything else ignores it. A call without one uses the provider's own random id.

## [0.13.2] - 2026-09-27

### Fixed

- **0.13.1 broke `parseJsonAnswer` on a fence line that carries a label.** 0.13.1 read everything after `json` on the fence line as the start of the JSON, so a block opened with `json title="report.json"`, `json {.report}` or `json here you go` threw a `JsonAnswerError`, where 0.12.3 had read it. Now that text is tried as the start of the JSON first, and when that doesn't parse, the block's body is read alone. When neither parses, the error names the body's fault if the body opens an object or array, and the whole JSON's fault if it began on the fence line. Skip 0.13.1.

## [0.13.1] - 2026-09-27

### Fixed

- **`parseJsonAnswer` threw when the JSON started on the fence line**, right after the `json`. The rest of that line was dropped along with the language, so the block read as empty, or as only its lines after the first. That rest now counts as the block's first line.

## [0.13.0] - 2026-09-27

### Added

- **`@providerkit/core/jev` asks TypeSafe's Jev model typed questions, on any of the four hosts that serve it.** `createJevClient({ host, apiKey })` takes `typesafe`, `openrouter`, `cloudflare` (with `accountId`) or `vercel`, and `ask(state, questions)` returns one answer per question with its probabilities, plus the usage. Each answer is checked against the question that asked it, and one that fails comes back `null` without failing the others. A choice must name an offered option, carry the full distribution over exactly those options, add up to 1 within rounding drift, and be the most likely option. Failures retry and classify like chat calls, with a 15-second deadline per attempt. `checkKey()` asks one real question, about 40 input tokens. `readAnswer(question, raw)` runs the checks alone, for an app that sends its own request. No price ships: OpenRouter's reported cost lands in `reportedCostUsd`, and `costUsd` prices the rest. OpenRouter was checked live on 2026-09-27. The Cloudflare and Vercel reply shapes come from their docs and another open-source client, not from a live call.
- **`openRouterCostUsd` is exported**, because Jev's OpenRouter bill has the same shape as chat's.

### Fixed

- **Cloudflare's 404 for an account ID that doesn't exist classified as `model`.** The caller went to fix a model ID that was fine. It classifies as `auth` now, on the chat path too.

## [0.12.3] - 2026-09-27

The Claude thinking changes come from Anthropic's documentation, read 2026-09-27: the per-model thinking table and the Thinking and Effort pages. None of it was measured against the live API.

### Added

- **A user turn can carry a file: a PDF, a recording, a video.** The new part is `{ type: "file", mimeType, data }`, base64 bytes like an image part. The Gemini adapter sends it as `inlineData`, the way it sends an image. Gemini takes up to 100 MB of inline data per request, and 50 MB for a PDF (documented, Gemini API "File input methods", read 2026-09-27); nothing here enforces that limit. The OpenAI, Anthropic and Responses adapters throw an `invalid` `ProviderError` before any request goes out, naming the adapter and the media type. The exported converters (`toOpenAIMessages`, `toAnthropicMessages`, `toResponsesInput`) refuse it too, and take the provider id to name as an optional second argument.
- **`parseJsonAnswer(text)` reads the JSON out of a model's answer.** It takes the first fenced block marked `json` or not marked at all, or else the text from the first `{` or `[` to the bracket that closes it, and parses that. A fence counts only at the start of a line, so a JSON value holding a code sample comes back whole. It returns `unknown`, for you to validate. When the text isn't JSON, it throws a `JsonAnswerError` whose `text` holds the first 2,000 characters of the answer and whose `cause` is the `SyntaxError`. No adapter calls it.

### Fixed

- **Any `effort` above `"none"` failed on current Claude models.** The Anthropic adapter asked for thinking with `thinking: { type: "enabled", budget_tokens }`. Every Claude from Opus 4.7 on answers that with a 400. From the 4.6 models on, a graded effort now sends `thinking: { type: "adaptive" }` and `output_config: { effort }`.
- **`effort: "none"` let current Claude models think.** The adapter said `"none"` by sending no `thinking` field, which meant "off" up to Claude 4.5. Claude Sonnet 5 and Opus 5 think by default. Fable 5 and 5.1, Mythos 5 and 5.1, Mythos Preview and Opus 5.5 can't stop. Now `"none"` sends `thinking: { type: "disabled" }` to Sonnet 5, and `output_config: { effort: "low" }` to the models that have no off. Opus 5 gets `low` too, although it accepts `disabled`: with thinking off it can write a tool call into its text, and that call never runs. Opus 4.6 to 4.8 and Sonnet 4.6 don't think unless asked, so `"none"` still sends nothing there.
- **A tool loop with an `effort` broke Claude 4.5's thinking rule from its second request.** Claude 4.5 and older have only extended thinking, which requires a thinking request's last assistant turn to start with a thinking block. The adapter sends no thinking blocks back, so every request that returned tool results broke a rule the docs say the API enforces. Whether the API refused those requests or quietly dropped thinking was not measured. Now those requests carry no `thinking` field and run without thinking. The first request of each turn still thinks, and so does the next user turn. The docs say turning thinking off in the middle of a turn doesn't cause an error. Other vendors on the Anthropic wire get the same bytes as before.
- **A forced tool choice with an `effort` failed on Claude 4.5 and older.** `toolChoice: "required"` or `{ name }` went out as `tool_choice` `any` or `tool` beside `thinking: { type: "enabled" }`, and Anthropic's Thinking page says forcing a tool "results in an error" in that mode. Now a request that forces a tool on these models carries no `thinking` field, so the tool you asked for wins. `auto` and `none` still think. Other vendors on the Anthropic wire get the same bytes as before.
- **`effort: "none"` on OpenRouter no longer lets MiMo v2.6 Flash or gpt-5-mini think.** An adopter's matrix measured both on 2026-09-27, with one pinned host per model and two runs per cell. With no `reasoning` field, MiMo used 57 and 47 reasoning tokens on Xiaomi's host (103–151 on DeepInfra in a 2026-09-26 sweep), and every explicit off gave 0, so `xiaomi/mimo-v2.6-flash` now gets `{ reasoning: { effort: "none" } }`. gpt-5-mini used 320 with the field omitted and answered every off with a 400; `minimal` gave 0 where `low` gave 64, so `openai/gpt-5-mini` now gets `{ reasoning: { effort: "minimal" } }`. That exact id only: gpt-5 and gpt-5-nano were not measured. GLM 5.3 Flash still gets `low`. Every other model still gets no field, on purpose: a model nobody measured may be one whose reasoning is mandatory, and an off would turn every call to it into a 400.
- **A `temperature` or `topP` failed every request on the newest Claude models.** From Opus 4.7 on, a non-default value is a 400, whether or not the model thinks. The adapter now leaves both out for those models, as it already did whenever it asked for thinking.

### Changed

- **The adapter picks the thinking fields from the model id**, including a per-call `model`. A `claude-` id it doesn't know is treated like the newest models. Claude 4.5 and older keep the thinking budget, and so does every other vendor on the Anthropic wire (Z.ai, MiniMax, Kimi, Qwen). Those endpoints get the same bytes as before. `explicitNone` is ignored from Claude 4.6 on.
- **Opus 4.6 and Sonnet 4.6 move from the thinking budget to adaptive thinking.** Both still accept a budget, but Anthropic has deprecated it. Adaptive thinking has no budget of its own and shares `maxTokens` with the answer, so raise `maxTokens` at `high` and `max`.

## [0.12.2] - 2026-09-26

### Fixed

- **`effort: "none"` on OpenRouter no longer leaves GLM 5.3 Flash free to think.** The adapter said `"none"` by sending no `reasoning` field, because a 2026-09-14 reading found that this turned GLM's thinking off. It depends on the host. A production classify body, sent to each of 28 hosts alone, made 18 of them think with the field left out, and GLM answers both explicit offs (`effort: "none"`, `enabled: false`) with a 400. `reasoning: { effort: "low" }` gave 0 reasoning tokens on every host that answered it except Sail Research (1) and Wafer, which is inverted. So for `z-ai/glm-5.3-flash`, `"none"` now sends `{ reasoning: { effort: "low" } }`. Every other model still gets no field: DeepSeek V4 Flash measured the reverse, with 0 reasoning tokens when the field is left out and thinking at `"low"`.

### Added

- **`effortParams` takes the model id as an optional third argument.** The OpenAI-shape adapter passes the id each request names, including a per-call `model`. Called without it, `effortParams` returns what it did before.

## [0.12.1] - 2026-09-26

### Fixed

- **A model id the provider does not serve is now a `model` error, not `invalid`, for DeepSeek, Z.ai and OpenRouter.** All three answer it with a 400, and a 400 whose words the classifier does not know is `invalid`. `invalid` has no fallback cooldown, so a `FallbackPool` sent the same request to that provider on every call and got the same 400 back. As `model`, the provider rests for an hour after its first refusal, and the pool stops calling it. The new wordings are DeepSeek's "The supported API model names are …", Z.ai's code 1211 "Unknown Model", and OpenRouter's "… is not a valid model ID".

## [0.12.0] - 2026-09-26

### Added

- **The price OpenRouter reports for each call.** OpenRouter serves one model id from many hosts, and they charge different prices, so a rate you pass can only describe one of them. The OpenAI-shape adapter now reads the `usage.cost` OpenRouter puts on the last frame of a stream into a new field, `TokenUsage.reportedCostUsd`. `costUsd` and `UsageTracker` bill it over your rate, and a tracker counts it even with no rate. A free call reads as `0`. A negative or non-number cost is dropped and your rate prices the call. With your own provider key (BYOK), `cost` is only OpenRouter's fee, so the adapter adds `cost_details.upstream_inference_cost` to report the whole bill. The adapter sends no `usage: { include: true }`: OpenRouter's docs say the cost now comes on every response and the flag does nothing. Other providers are unchanged.

### Changed

- **`costUsd` returns `usage.reportedCostUsd` when it is set**, whatever rate you pass. `addUsage` still returns only the token counts, so a sum is priced by the rate.

## [0.11.3] - 2026-09-25

### Fixed

- **`createPresetProvider("zai")` left no room to answer.** It sent no `maxTokens`, so the Anthropic adapter's 8,192 default applied. GLM 5.3 Flash at effort `"high"` spent all of it reasoning and ended the turn with no text and no tool call. `createZaiCodingProvider` already defaulted to 65,536, so the same model worked through one factory and failed through the other. A preset row can now set `maxTokens`, `zai`'s is 65,536, and both factories read it. A `maxTokens` you pass still wins.

## [0.11.2] - 2026-09-25

### Fixed

- **`probeJsonWithTools` makes its calls one at a time.** It used to fire all `samples × 2` at once. A flat-rate plan caps concurrent requests, and six at once on a Z.ai Coding Plan key came back with some 429s. Behind a fallback chain, the next model answered those calls, and the table scored that model's answer as this one's. The same app logged `1/3, 3/3`, `3/3, 2/3` and `1/3, 1/3` on four boots of one unchanged model. Probe each provider on its own, not a fallback chain.

## [0.11.1] - 2026-09-21

### Fixed

- **Gemini 2 cannot take a response schema beside tools.** The adapter sent both whenever `jsonWithTools` was not `"prompt"`, and Gemini 2.x answers that with `400 "Function calling with a response mime type: 'application/json' is unsupported"` — so every tool-carrying call to a 2.x model failed outright. On that generation the model id decides and `jsonWithTools` is ignored: the schema travels in the prompt, the one way it can. Gemini 3 serves both and keeps the enforced schema.

## [0.11.0] - 2026-09-21

### Added

- **OpenRouter app attribution (`siteUrl`, `siteName`).** Sent as `HTTP-Referer` and `X-Title` so a deployment shows up in OpenRouter's rankings under its own name.

## [0.10.0] - 2026-09-14

### Added

- **Wire Tool Schema Sanitization (`toGeminiToolSchema` & `toAnthropicToolSchema`)**:
  - `toGeminiToolSchema`: converts nullable unions (`anyOf: [{ type: "string" }, { type: "null" }]` and `type: ["string", "null"]`) to OpenAPI 3.0 `{ type: "string", nullable: true }`, converts numeric enums to strings, converts `const` to `enum: [val]`, ensures arrays have explicit item schemas, and strips unsupported keywords (`$schema`, `definitions`, `additionalProperties: true`).
  - `toAnthropicToolSchema`: unwraps and merges root `anyOf` / `oneOf` / `allOf` unions into a unified root `{ type: "object", properties: ... }` schema so Anthropic's Messages API does not reject requests with 400 invalid request errors.
- **Wire Tool Argument & ID Repair (`findLastValidJsonObject` & `normalizeToolId`)**:
  - `findLastValidJsonObject`: rescues concatenated or prepended JSON payloads (e.g. `{}{"query":"foo"}` or `{"a":1}{"b":2}`) emitted by gateways or streaming cutoffs.
  - `normalizeToolId`: synthesizes deterministic fallback IDs for empty or whitespace tool call IDs, and bounds/hashes IDs exceeding 64 characters to satisfy ChatGPT Responses API constraints.
- **Context Overflow Token Margin Extraction (`parseContextOverflow`)**:
  - Extracts `inputTokens`, `maxTokens`, `contextLimit`, and `excessTokens` from Anthropic and gateway context overflow errors for reactive retry margin calculation.
- **OpenRouter Sticky Routing (`openRouterHostFor` & `pinHost`)**:
  - Automatically pins OpenRouter requests to the first-party model vendor host (`order: ["<vendor>"]`, `allow_fallbacks: true`) to preserve server-side KV prompt caching across multi-turn agent conversations.
- **Diagnostics Probe Script (`bun run probe:model <preset> [model]`)**:
  - Comprehensive live diagnostic battery testing connectivity/latency, JSON schema structured output, tool calling in isolation, and `jsonWithTools` prompt vs response_format coexistence.
- **Usage Rollbacks (`subtractUsage` & `UsageTracker.subtract`)**:
  - Clamps each field (`inputTokens`, `cachedInputTokens`, `cacheWriteTokens`, `outputTokens`, `costUsd`) at zero so optimistic or speculative stream rollbacks cannot corrupt the ledger.

### Changed

- **Gemini Thinking Configuration**:
  - Dynamically switches between Gemini 3+ `thinkingLevel` (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`) and Gemini 2.x `thinkingBudget` based on model version, preventing `400: Thinking level is not supported for this model`.
  - Updated all golden test suites to use late-2026 flagships (`gemini-3.5-pro`).

## [0.9.0] - 2026-09-13

### Added

- **Centralized `isRetryable` Predicate**:
  - Evaluates error retryability across `ProviderError`, network/transport failures, server directives (`x-should-retry`), and rate-limit wait bounds (`maxWaitMs`).
  - Integrated into `withRetry` by default.
- **Preset Expansion**:
  - Expanded preset catalog to 45 endpoints with dual Anthropic and OpenAI wire configurations for Chinese coding-plan providers (`qwen`, `zai`, `kimi`, `minimax`).

## [0.8.1] - 2026-09-13

### Added

- **Extended Error Parsing**:
  - Added Go-style duration parsing (`parseDurationMs`), countdown prose parsing, and enhanced rate limit window recognition.

## [0.8.0] - 2026-09-13

### Added

- **Preset-ID Fallback Specifications (`FallbackSpec`)**:
  - Consumers declare cross-provider fallbacks by preset ID rather than hand-building `Provider` instances.
- **Dynamic Model Capabilities Resolution (`resolveModelCapabilities`)**:
  - Query model capabilities on-demand with 24-hour TTL caching and ID normalization.
