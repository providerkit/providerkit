/**
 * Provider presets — hand-curated, wire-level facts only.
 *
 * A preset is everything `createPresetProvider` needs to speak to one
 * endpoint: which adapter shape it speaks, its API root, how the credential
 * rides, and what it is called. Deliberately absent: prices (invariant 9 —
 * they drift on a vendor's schedule and a wrong number in a library is a
 * wrong number in everyone's ledger), icons, colors, marketing names, and
 * sign-in flows (an `oauth` preset expects the CALLER to hand over an access
 * token; acquiring one stays app-side).
 *
 * Sources: the coding-plan endpoints and auth quirks are measured
 * (tabrunner's extension + this repo's adopters, 2026-09); the model lists
 * are representative, not exhaustive — every adapter takes a per-call model,
 * so a missing id costs nothing.
 *
 * Azure is deliberately ABSENT: its base URL is per-deployment
 * (`https://<resource>.openai.azure.com`), so no static preset can carry it —
 * point createOpenAIProvider's baseUrl at your resource instead.
 */
export type PresetShape = "anthropic" | "openai" | "responses" | "gemini";

/**
 * How the credential reaches the endpoint.
 * - `key`: the vendor's native key header (Anthropic reads `x-api-key`,
 *   Gemini `x-goog-api-key`); the OpenAI shapes have only Bearer, so they
 *   never use this.
 * - `bearer`: `Authorization: Bearer` — the OpenAI shapes' only mode, and the
 *   coding-plan gateways' mode on the Anthropic wire (measured: Z.ai's coding
 *   endpoint ignores `x-api-key` and reads Bearer).
 * - `oauth`: same wire as `bearer`, but the token is a short-lived access
 *   token from a sign-in flow the caller owns. The preset may carry the beta
 *   headers that switch the endpoint into OAuth mode.
 */
export type PresetAuth = "key" | "bearer" | "oauth";

export interface ProviderPreset {
  /** Adapter wire format. */
  shape: PresetShape;
  /** API root — the adapter appends its own path (/v1/chat/completions,
   *  /v1/messages, …), so this must NOT carry the version. */
  baseUrl: string;
  auth: PresetAuth;
  /** Fallback when the caller passes no model. */
  defaultModel?: string;
  /** Representative model ids. */
  models?: string[];
  /** Static protocol headers the endpoint requires (e.g. OAuth beta flags).
   *  Per-request headers (request ids, account ids) are the caller's. */
  headers?: Record<string, string>;
  /** True when the endpoint hard-400s image parts (measured on DeepSeek). */
  textOnly?: boolean;
  /** Anthropic-shape dialect: say "no thinking" with an explicit
   *  `thinking: { type: "disabled" }` marker when effort is none. For
   *  endpoints where an ABSENT field means the model's default — thinking ON
   *  for reasoning-mandatory models (measured on Z.ai's coding endpoint:
   *  omit → thinking block; disabled → none). Native Anthropic defaults to
   *  off when the field is absent and must stay unset. */
  explicitNone?: boolean;
}

export const PROVIDER_PRESETS = {
  // ── Keyed, native shapes ────────────────────────────────────────────────
  anthropic: {
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: "key",
    defaultModel: "claude-sonnet-4-6",
    models: ["claude-sonnet-4-6", "claude-opus-5", "claude-fable-5-1"],
  },
  openai: {
    shape: "openai",
    baseUrl: "https://api.openai.com",
    auth: "key",
    defaultModel: "gpt-5.6-sol",
    models: ["gpt-5.6-sol", "gpt-5-pro", "gpt-5-nano"],
  },
  google: {
    // Native Generative Language REST — the adapter authenticates with
    // `x-goog-api-key` (NOT Bearer) and fixes its own /v1… paths.
    shape: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    auth: "key",
    defaultModel: "gemini-3.1-pro",
    models: ["gemini-3.1-pro", "gemini-2.5-flash"],
  },
  /** Gemini behind its OpenAI-compatible route — the drop-in for codebases
   *  that only speak the openai shape. */
  "google-openai": {
    shape: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: "key",
    defaultModel: "gemini-3.1-pro",
    models: ["gemini-3.1-pro", "gemini-2.5-flash"],
  },
  deepseek: {
    shape: "openai",
    baseUrl: "https://api.deepseek.com",
    auth: "key",
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash"],
    // Text-only API — an image part in the body is a hard 400 (measured).
    textOnly: true,
  },
  openrouter: {
    shape: "openai",
    baseUrl: "https://openrouter.ai/api",
    auth: "key",
    defaultModel: "deepseek/deepseek-v4.1-flash",
    models: ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "qwen/qwen3.7-max"],
  },
  groq: {
    shape: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: "key",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "qwen/qwen3.8-27b"],
  },
  mistral: {
    shape: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    auth: "key",
    defaultModel: "devstral-2512",
    models: ["devstral-2512", "magistral-small", "mistral-small-2506"],
  },
  xai: {
    shape: "openai",
    baseUrl: "https://api.x.ai/v1",
    auth: "key",
    defaultModel: "grok-4.5",
    models: ["grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning"],
  },
  together: {
    shape: "openai",
    baseUrl: "https://api.together.xyz/v1",
    auth: "key",
    defaultModel: "deepseek-ai/DeepSeek-V3",
  },
  fireworks: {
    shape: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    auth: "key",
  },
  cerebras: {
    shape: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    auth: "key",
    defaultModel: "gpt-oss-120b",
    models: ["gpt-oss-120b", "qwen-3.8-27b"],
  },
  moonshot: {
    shape: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    auth: "key",
    defaultModel: "kimi-k2.7-code",
    models: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3"],
  },
  zhipu: {
    shape: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    auth: "key",
    defaultModel: "glm-5.3-flash",
    models: ["glm-5.3-flash", "glm-5.2", "glm-4.7"],
  },
  minimax: {
    shape: "anthropic",
    baseUrl: "https://api.minimax.io/anthropic",
    auth: "key",
    defaultModel: "MiniMax-M2.5",
    models: ["MiniMax-M3", "MiniMax-M2.5", "MiniMax-M2.1"],
  },

  // ── Coding plans — Anthropic wire + Bearer (measured family trait) ─────
  zai: {
    shape: "anthropic",
    baseUrl: "https://api.z.ai/api/anthropic",
    auth: "bearer",
    defaultModel: "glm-5.3-flash",
    models: ["glm-5.3-flash", "glm-5.3-highspeed", "glm-5.2", "glm-5-turbo"],
    // Model ids are BARE here — the gateway-prefixed spelling
    // (`z-ai/glm-5.3-flash`) answers 400 [1211] Unknown Model.
    explicitNone: true,
  },
  kimi: {
    shape: "anthropic",
    baseUrl: "https://api.kimi.ai/coding",
    auth: "bearer",
    defaultModel: "kimi-for-coding",
    models: ["kimi-for-coding", "kimi-for-coding-highspeed", "k3"],
  },
  /** Alibaba's dashscope coding plan — OpenAI-compatible per its registry. */
  "alibaba-coding-plan": {
    shape: "openai",
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    auth: "bearer",
    defaultModel: "qwen3.7-max",
    models: ["qwen3.7-max", "qwen3-coder-next", "glm-4.7"],
  },
  /** QwenCloud's token plan — Anthropic wire (measured by tabrunner). */
  qwen: {
    shape: "anthropic",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    auth: "bearer",
    defaultModel: "qwen3.8-max",
    models: ["qwen3.8-max", "qwen3.6-flash"],
  },

  // ── Local runtimes ──────────────────────────────────────────────────────
  ollama: {
    shape: "openai",
    baseUrl: "http://localhost:11434/v1",
    auth: "bearer",
  },
  lmstudio: {
    shape: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    auth: "bearer",
  },
  vllm: {
    shape: "openai",
    baseUrl: "http://localhost:8000/v1",
    auth: "bearer",
  },

  // ── OAuth — the caller owns the sign-in flow and hands over the token ───
  claude: {
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: "oauth",
    defaultModel: "claude-sonnet-4-6",
    models: ["claude-sonnet-4-6", "claude-opus-5"],
    // The beta flag is what switches the API into OAuth-token mode (measured
    // by tabrunner's Claude plan sign-in).
    headers: { "anthropic-beta": "claude-code-20250219,oauth-2025-04-20" },
  },
  /** The Codex backend behind a ChatGPT sign-in — Responses wire, no public
   *  model list, so these ids are the list. */
  chatgpt: {
    shape: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    auth: "oauth",
    defaultModel: "gpt-5.3-codex",
    models: ["gpt-5.3-codex", "gpt-5.5", "gpt-5.4-mini"],
  },
  /** Kimi's coding endpoint reached with a subscription token instead of a
   *  key — Kimi bills the two separately. */
  "kimi-plan": {
    shape: "anthropic",
    baseUrl: "https://api.kimi.ai/coding",
    auth: "oauth",
    defaultModel: "kimi-for-coding",
  },
  "github-copilot": {
    shape: "openai",
    baseUrl: "https://api.githubcopilot.com",
    auth: "oauth",
    defaultModel: "gpt-5.6-sol",
    models: ["gpt-5.6-sol", "claude-opus-5", "claude-opus-4.8", "kimi-k2.7-code"],
  },
} as const satisfies Record<string, ProviderPreset>;

export type ProviderPresetId = keyof typeof PROVIDER_PRESETS;

/** Every valid preset id — the factory's unknown-id error lists these. */
export const PRESET_IDS = Object.keys(PROVIDER_PRESETS) as ProviderPresetId[];
