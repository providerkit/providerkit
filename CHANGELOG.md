# Changelog

All notable changes to `@providerkit/core` will be documented in this file.

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
