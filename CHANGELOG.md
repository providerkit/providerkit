# Changelog

All notable changes to `@providerkit/core` will be documented in this file.

## [Unreleased]

The Claude thinking changes come from Anthropic's documentation, read 2026-09-27: the per-model thinking table and the Thinking and Effort pages. None of it was measured against the live API.

### Added

- **A user turn can carry a file: a PDF, a recording, a video.** The new part is `{ type: "file", mimeType, data }`, base64 bytes like an image part. The Gemini adapter sends it as `inlineData`, the way it sends an image. Gemini takes up to 100 MB of inline data per request, and 50 MB for a PDF (documented, Gemini API "File input methods", read 2026-09-27); nothing here enforces that limit. The OpenAI, Anthropic and Responses adapters throw an `invalid` `ProviderError` before any request goes out, naming the adapter and the media type. The exported converters (`toOpenAIMessages`, `toAnthropicMessages`, `toResponsesInput`) refuse it too, and take the provider id to name as an optional second argument.
- **`parseJsonAnswer(text)` reads the JSON out of a model's answer.** It takes the first fenced block marked `json` or not marked at all, or else the text from the first `{` or `[` to the bracket that closes it, and parses that. A fence counts only at the start of a line, so a JSON value holding a code sample comes back whole. It returns `unknown`, for you to validate. When the text isn't JSON, it throws a `JsonAnswerError` whose `text` holds the first 2,000 characters of the answer and whose `cause` is the `SyntaxError`. No adapter calls it.

### Fixed

- **Any `effort` above `"none"` failed on current Claude models.** The Anthropic adapter asked for thinking with `thinking: { type: "enabled", budget_tokens }`. Every Claude from Opus 4.7 on answers that with a 400. From the 4.6 models on, a graded effort now sends `thinking: { type: "adaptive" }` and `output_config: { effort }`.
- **`effort: "none"` let current Claude models think.** The adapter said `"none"` by sending no `thinking` field, which meant "off" up to Claude 4.5. Claude Sonnet 5 and Opus 5 think by default. Fable 5 and 5.1, Mythos 5 and 5.1, Mythos Preview and Opus 5.5 can't stop. Now `"none"` sends `thinking: { type: "disabled" }` to Sonnet 5, and `output_config: { effort: "low" }` to the models that have no off. Opus 5 gets `low` too, although it accepts `disabled`: with thinking off it can write a tool call into its text, and that call never runs. Opus 4.6 to 4.8 and Sonnet 4.6 don't think unless asked, so `"none"` still sends nothing there.
- **A tool loop with an `effort` broke Claude 4.5's thinking rule from its second request.** Claude 4.5 and older have only extended thinking, which requires a thinking request's last assistant turn to start with a thinking block. The adapter sends no thinking blocks back, so every request that returned tool results broke a rule the docs say the API enforces. Whether the API refused those requests or quietly dropped thinking was not measured. Now those requests carry no `thinking` field and run without thinking. The first request of each turn still thinks, and so does the next user turn. The docs say turning thinking off in the middle of a turn doesn't cause an error. Other vendors on the Anthropic wire get the same bytes as before.
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
