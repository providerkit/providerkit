# Changelog

All notable changes to `@providerkit/core` will be documented in this file.

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
