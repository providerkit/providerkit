/**
 * Provider presets — hand-curated, wire-level facts only.
 *
 * A preset is everything `createPresetProvider` needs to speak to one
 * endpoint: which adapter shape it speaks, its API root, how the credential
 * rides, and what it is called. Deliberately absent: prices (invariant 9 —
 * they drift on a vendor's schedule and a wrong number in a library is a
 * wrong number in everyone's ledger), icons, colors, marketing names, and
 * sign-in flows (an `oauth` preset expects the CALLER to hand over an access
 * token; `@providerkit/core/auth` is how to get and renew one).
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
import type { ImageLimits } from "./image.ts";

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
 *   token from a sign-in flow (see `@providerkit/core/auth`). The preset may carry the beta
 *   headers that switch the endpoint into OAuth mode.
 */
export type PresetAuth = "key" | "bearer" | "oauth";

/**
 * One wire a preset serves besides its own. A gateway that puts different
 * models on different wires (OpenCode Go) lists the exceptions here, and the
 * preset's own `shape` and `baseUrl` serve every other model.
 */
export interface PresetRoute {
  /** The model ids this route serves, matched by prefix. */
  prefixes: readonly string[];
  shape: PresetShape;
  baseUrl: string;
  path?: string;
  /** Defaults to the preset's `auth`. */
  auth?: PresetAuth;
}

export interface ProviderPreset {
  /** Adapter wire format. */
  shape: PresetShape;
  /** API root — if it ends with /v1, /v4 or another version segment, the
   *  adapter automatically routes to /chat/completions instead of /v1/chat/completions. */
  baseUrl: string;
  /** Explicit path override when a gateway has custom routing. */
  path?: string;
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
   *  omit → thinking block; disabled → none). Leave it unset for native
   *  Anthropic: the adapter spells none per Claude model, and ignores this
   *  flag for every Claude from 4.6 on. */
  explicitNone?: boolean;
  /** Output ceiling when the caller sets none. Thinking and the answer share
   *  it, so a model that reasons past the adapter's default ends the turn with
   *  neither text nor a tool call. */
  maxTokens?: number;
  /** Header that carries `StreamOptions.sessionId`, for gateways that route
   *  and cache per conversation — and refuse a call without it (OpenCode Go:
   *  `MissingSessionID`, measured 2026-09-27). */
  sessionHeader?: string;
  /** Wires for model ids that don't use the preset's own `shape`. The first
   *  route with a matching prefix serves the model. A model on a different wire
   *  than the one the provider was built for is refused with `invalid`, so a
   *  per-call `model` can't send a request to an endpoint that would 404 it. */
  routes?: readonly PresetRoute[];
  /** Default model chain when the caller names neither `model` nor `models`:
   *  the first answers, the rest take over (same key) when it fails. */
  rotation?: readonly string[];
  /** Responses shape: what the backend accepts as an image, for backends that
   *  fail a whole request over one image they won't take. */
  imageLimits?: ImageLimits;
  /** Responses shape: ask for the encrypted reasoning items, and send them back
   *  on the next turn. Only for backends that take `include`; `chatgpt` is the
   *  one that does, and Go and Grok may refuse it. */
  replayReasoning?: boolean;
  /** OpenAI shape: send `X-Initiator` (`user` or `agent`) on every call. GitHub
   *  Copilot bills a premium request per `user` turn. */
  initiatorHeader?: boolean;
}

export const PROVIDER_PRESETS = {
  // ── Keyed, native shapes ────────────────────────────────────────────────
  anthropic: {
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: "key",
    defaultModel: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-fable-5-1", "claude-haiku-4-5"],
  },
  openai: {
    shape: "openai",
    baseUrl: "https://api.openai.com",
    auth: "key",
    defaultModel: "gpt-5.6-sol",
    models: ["gpt-5.6-sol", "gpt-5.5-pro", "gpt-5.4-mini"],
  },
  google: {
    // Native Generative Language REST — the adapter authenticates with
    // `x-goog-api-key` (NOT Bearer) and fixes its own /v1… paths.
    shape: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    auth: "key",
    defaultModel: "gemini-3.1-pro-preview",
    models: ["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-flash-latest"],
  },
  /** Gemini behind its OpenAI-compatible route — the drop-in for codebases
   *  that only speak the openai shape. */
  "google-openai": {
    shape: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: "key",
    defaultModel: "gemini-3.1-pro-preview",
    models: ["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-flash-latest"],
  },
  deepseek: {
    shape: "openai",
    baseUrl: "https://api.deepseek.com",
    auth: "key",
    // Measured 2026-09-13 via /models on live key: first-party serves only
    // deepseek-flash and deepseek-v4-pro. v4.1-flash is OpenRouter/Baseten.
    defaultModel: "deepseek-flash",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    // Text-only API — an image part in the body is a hard 400 (measured).
    textOnly: true,
  },
  openrouter: {
    shape: "openai",
    baseUrl: "https://openrouter.ai/api",
    auth: "key",
    defaultModel: "deepseek/deepseek-v4.1-flash",
    models: [
      "deepseek/deepseek-v4.1-flash",
      "z-ai/glm-5.3-flash",
      "x-ai/grok-4.6",
      "openai/gpt-5.6-luna-pro",
    ],
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
    models: ["devstral-2512", "mistral-large-latest", "magistral-small"],
  },
  xai: {
    shape: "openai",
    baseUrl: "https://api.x.ai/v1",
    auth: "key",
    defaultModel: "grok-4.6",
    models: ["grok-4.6", "grok-4.5", "grok-4.3"],
  },
  together: {
    shape: "openai",
    baseUrl: "https://api.together.xyz/v1",
    auth: "key",
    defaultModel: "MiniMaxAI/MiniMax-M3",
    models: ["MiniMaxAI/MiniMax-M3", "Qwen/Qwen3-Coder-Next-FP8"],
  },
  fireworks: {
    shape: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    auth: "key",
    defaultModel: "accounts/fireworks/models/deepseek-v4p1-flash",
    models: [
      "accounts/fireworks/models/deepseek-v4p1-flash",
      "accounts/fireworks/models/glm-5p3-flash",
    ],
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
    path: "/chat/completions",
    auth: "key",
    defaultModel: "glm-5.3-flash",
    models: ["glm-5.3-flash", "glm-5.3", "glm-5.2"],
  },
  minimax: {
    shape: "anthropic",
    baseUrl: "https://api.minimax.io/anthropic",
    auth: "key",
    defaultModel: "MiniMax-M3",
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"],
  },
  "minimax-openai": {
    shape: "openai",
    baseUrl: "https://api.minimax.io/v1",
    auth: "key",
    defaultModel: "MiniMax-M3",
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"],
  },

  // ── Popular gateways & cloud providers ──────────────────────────────────
  nvidia: {
    shape: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    auth: "key",
    defaultModel: "deepseek-ai/deepseek-v4-flash",
    models: ["deepseek-ai/deepseek-v4-flash", "deepseek-ai/deepseek-v4-pro"],
  },
  perplexity: {
    shape: "openai",
    baseUrl: "https://api.perplexity.ai",
    auth: "key",
    defaultModel: "sonar",
    models: ["sonar", "sonar-pro", "sonar-reasoning-pro", "sonar-deep-research"],
  },
  deepinfra: {
    shape: "openai",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    path: "/chat/completions",
    auth: "key",
    defaultModel: "MiniMaxAI/MiniMax-M3",
    models: ["MiniMaxAI/MiniMax-M3", "ByteDance/Seed-2.0-pro"],
  },
  nebius: {
    shape: "openai",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    auth: "key",
    defaultModel: "Qwen/Qwen3.5-397B-A17B",
    models: ["Qwen/Qwen3.5-397B-A17B", "deepseek-ai/DeepSeek-V4-Flash-0731"],
  },
  novita: {
    shape: "openai",
    baseUrl: "https://api.novita.ai/openai",
    path: "/v1/chat/completions",
    auth: "key",
    defaultModel: "baichuan/baichuan-m2-32b",
    models: ["baichuan/baichuan-m2-32b", "baidu/ernie-4.5-300b-a47b-paddle"],
  },
  chutes: {
    shape: "openai",
    baseUrl: "https://llm.chutes.ai/v1",
    auth: "key",
    defaultModel: "Qwen/Qwen3.8-27B-TEE",
    models: ["Qwen/Qwen3.8-27B-TEE", "Qwen/Qwen3.5-397B-A17B-TEE"],
  },
  siliconflow: {
    shape: "openai",
    baseUrl: "https://api.siliconflow.com/v1",
    auth: "key",
    defaultModel: "Qwen/Qwen3-235B-A22B-Thinking-2507",
    models: ["Qwen/Qwen3-235B-A22B-Thinking-2507", "MiniMaxAI/MiniMax-M2.5"],
  },
  volcengine: {
    shape: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    auth: "key",
    defaultModel: "doubao-seed-1-8-251228",
    models: ["doubao-seed-1-8-251228", "deepseek-v4-flash-ga-260731"],
  },
  stepfun: {
    shape: "openai",
    baseUrl: "https://api.stepfun.com/v1",
    auth: "key",
    defaultModel: "step-3.7-flash",
    models: ["step-3.7-flash", "step-3.5-flash"],
  },
  digitalocean: {
    shape: "openai",
    baseUrl: "https://inference.do-ai.run/v1",
    auth: "key",
    defaultModel: "anthropic-claude-3.7-sonnet",
    models: ["anthropic-claude-3.7-sonnet", "alibaba-qwen3-32b"],
  },
  crusoe: {
    shape: "openai",
    baseUrl: "https://api.inference.crusoecloud.com/v1",
    auth: "key",
    defaultModel: "Qwen/Qwen3-235B-A22B-Instruct-2507",
    models: ["Qwen/Qwen3-235B-A22B-Instruct-2507", "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B"],
  },
  baseten: {
    shape: "openai",
    baseUrl: "https://inference.baseten.co/v1",
    auth: "key",
    defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash",
    models: ["deepseek-ai/DeepSeek-V4.1-Flash", "MiniMaxAI/MiniMax-M2.5"],
  },
  huggingface: {
    shape: "openai",
    baseUrl: "https://router.huggingface.co/v1",
    auth: "key",
    defaultModel: "MiniMaxAI/MiniMax-M3",
    models: ["MiniMaxAI/MiniMax-M3", "Qwen/Qwen2.5-Coder-32B-Instruct"],
  },

  // ── Coding plans — Anthropic wire + Bearer (measured family trait) ─────
  zai: {
    shape: "anthropic",
    baseUrl: "https://api.z.ai/api/anthropic",
    auth: "bearer",
    defaultModel: "glm-5.3-flash",
    models: ["glm-5.3-flash", "glm-5.3-highspeed", "glm-5.3", "glm-5.2"],
    // Model ids are BARE here — the gateway-prefixed spelling
    // (`z-ai/glm-5.3-flash`) answers 400 [1211] Unknown Model.
    explicitNone: true,
    // GLM reasons past the thinking budget we send. Under the Anthropic
    // adapter's 8,192 default, GLM 5.3 Flash at effort "high" spent the whole
    // turn reasoning (about 31k characters) and returned no text and no tool
    // call. createZaiCodingProvider reads this number too.
    maxTokens: 65_536,
  },
  "zai-openai": {
    shape: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    path: "/chat/completions",
    auth: "key",
    defaultModel: "glm-5.3-flash",
    models: ["glm-5.3-flash", "glm-5.3", "glm-5.2"],
  },
  /**
   * OpenCode Go — one $10/month key across many open models, each with its own
   * monthly dollar limit (5h = 20%, week = 50%). Chain several models as
   * `fallbacks` so a spent one hands over to the next.
   *
   * Measured 2026-09-27 on /chat/completions: a call without
   * `x-opencode-session` is refused. `mimo-v2.6-flash` passes plain text,
   * `reasoning_effort: "none"`, tool calls and json_schema; `glm-5.3-flash`
   * 400s on a tool without a description and on a `thinking` field.
   *
   * Go serves three wires, and `routes` picks one from the model id (cc-proxy's
   * table, from Go's own docs): `minimax-` and `qwen` on Anthropic /messages
   * (key in `x-api-key`), `gpt-`, `grok-` and `muse-spark-` on /responses, and
   * everything else on chat completions. Each model in a chain resolves its
   * own route, so one preset serves a chain that crosses wires.
   *
   * Muse Contributor, measured 2026-09-28 on /responses: text, images, strict
   * JSON Schema, parallel tools and tool-result round trips all passed. It
   * requires reasoning (`none` becomes `minimal`) and accepts only automatic
   * tool choice (`none` is encoded by sending no tools). Contributor requests
   * may be used to improve Meta products; the workspace must explicitly allow
   * those endpoints.
   *
   * Reasoning effort is spelled per model on chat completions (see
   * `effortParams`): GLM takes only `high` and `max`, DeepSeek V4 and MiMo
   * take graded levels.
   */
  "opencode-go": {
    shape: "openai",
    baseUrl: "https://opencode.ai/zen/go/v1",
    auth: "bearer",
    defaultModel: "mimo-v2.6-flash",
    models: [
      "mimo-v2.6-flash",
      "mimo-v2.5",
      "glm-5.3-flash",
      "qwen3.8-flash",
      "longcat-2.0",
      "muse-spark-1.3-contributor",
    ],
    sessionHeader: "x-opencode-session",
    routes: [
      {
        prefixes: ["minimax-", "qwen"],
        shape: "anthropic",
        baseUrl: "https://opencode.ai/zen/go",
        auth: "key",
      },
      {
        prefixes: ["gpt-", "grok-", "muse-spark-"],
        shape: "responses",
        baseUrl: "https://opencode.ai/zen/go",
      },
    ],
    // Cheapest first, each with its own monthly limit ($60, qwen3.8-flash $30).
    // All five passed plain text, a described tool call and json_schema on
    // 2026-09-27; longcat-2.0 ignores reasoning "none", so it goes last.
    // DeepSeek is left out: on Go it needs the workspace's Global regions
    // privacy setting, and answers 500 without it.
    rotation: ["mimo-v2.6-flash", "mimo-v2.5", "glm-5.3-flash", "qwen3.8-flash", "longcat-2.0"],
  },
  kimi: {
    shape: "anthropic",
    baseUrl: "https://api.kimi.ai/coding",
    auth: "bearer",
    defaultModel: "kimi-for-coding",
    models: ["kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k"],
  },
  "kimi-openai": {
    shape: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    auth: "key",
    defaultModel: "kimi-k2.7-code",
    models: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3"],
  },
  /** Alibaba's dashscope coding plan — OpenAI-compatible per its registry. */
  "alibaba-coding-plan": {
    shape: "openai",
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    auth: "bearer",
    defaultModel: "qwen3.5-plus",
    models: ["qwen3.5-plus", "qwen3-coder-next", "glm-5"],
  },
  /** QwenCloud's token plan — Anthropic wire (measured by tabrunner). */
  qwen: {
    shape: "anthropic",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    auth: "bearer",
    defaultModel: "qwen3.8-max",
    models: ["qwen3.8-max", "qwen3.8-flash", "qwen3.6-flash"],
  },
  /** QwenCloud's token plan — OpenAI-compatible endpoint. */
  "qwen-token-plan-openai": {
    shape: "openai",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    auth: "bearer",
    defaultModel: "qwen3.8-max",
    models: ["qwen3.8-max", "qwen3.8-flash", "qwen3.6-flash"],
  },
  /** Alibaba DashScope Platform API — standard pay-as-you-go API key. */
  alibaba: {
    shape: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    auth: "bearer",
    defaultModel: "qwen-max",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-flash"],
  },
  /** Alias for alibaba (DashScope platform API). */
  "qwen-api": {
    shape: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    auth: "bearer",
    defaultModel: "qwen-max",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-flash"],
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

  // ── OAuth — sign in with `@providerkit/core/auth`, hand over the token ──
  claude: {
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: "oauth",
    defaultModel: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-fable-5"],
    // The beta flag is what switches the API into OAuth-token mode (measured
    // by tabrunner's Claude plan sign-in).
    headers: { "anthropic-beta": "claude-code-20250219,oauth-2025-04-20" },
  },
  /**
   * The Codex backend behind a ChatGPT sign-in — Responses wire, no public
   * model list, so these ids are the list.
   *
   * The endpoint is `/backend-api/codex/responses`, with no version segment.
   * Without the `path` the adapter appends `/v1/responses`, the POST 404s, and
   * a 404 classifies as "model": every call failed telling the user their
   * model id was wrong. `session-id` is the header the official Codex client
   * sends; the backend keys its prompt cache on it (cc-proxy, in daily use
   * against this backend, 2026-09).
   *
   * The backend retires models without notice, and models.dev doesn't list
   * this backend, so `refresh-presets` can't catch the drift. By 2026-10-01 the
   * default here (gpt-5.3-codex) and two of the other three listed ids
   * answered 400 "not supported when using Codex with a ChatGPT account": a
   * caller who took the default failed on every call. This list is what the
   * backend accepted that day. It checks the model before the quota, so an
   * account with its window spent still tells the two apart: 400 for a
   * rejected model, 429 for an accepted one.
   */
  chatgpt: {
    shape: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    path: "/responses",
    sessionHeader: "session-id",
    auth: "oauth",
    defaultModel: "gpt-6-sol",
    models: [
      "gpt-6-sol",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ],
    replayReasoning: true,
  },
  /**
   * A Grok subscription (SuperGrok, X Premium) — the backend the Grok CLI
   * talks to, Responses wire. Distinct from `xai`, which is the keyed API and
   * bills per token.
   *
   * The two `x-…` headers are what switch the backend into CLI-token mode;
   * without them the subscription token is refused. The version header is the
   * Grok CLI release cc-proxy sends by default (2026-09); pass your own in
   * `headers` when the backend starts asking for a newer one. Tool calls on
   * this backend are keyed by `call_id` alone, which the adapter follows.
   */
  grok: {
    shape: "responses",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    path: "/responses",
    auth: "oauth",
    defaultModel: "grok-4.7",
    models: ["grok-4.7", "grok-4.6", "grok-4.5", "grok-composer-2.5-fast"],
    headers: {
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-identifier": "grok-shell",
      "x-grok-client-version": "0.2.93",
    },
    // Measured by cc-proxy on 2026-07-20: an 8x8 image fails the whole request,
    // 32x32 passes. Too small, over 5 MB decoded, WebP (its size can't be read)
    // or older than the last four: each becomes a note instead.
    imageLimits: { minSide: 8, minArea: 512, maxDecodedBytes: 5 * 1024 * 1024, maxImages: 4 },
  },
  /** Kimi's coding endpoint reached with a subscription token instead of a
   *  key — Kimi bills the two separately. */
  "kimi-plan": {
    shape: "anthropic",
    baseUrl: "https://api.kimi.ai/coding",
    auth: "oauth",
    defaultModel: "kimi-for-coding",
  },
  /**
   * GitHub Copilot, on an individual seat's host. Other plans have their own
   * host, which the sign-in returns as `credential.baseUrl`: pass it as
   * `baseUrl`. Copilot serves chat at `/chat/completions` with no `/v1`, and the
   * default path would have added one and 404'd.
   *
   * The headers are the ones its gate checks on every call. Pass
   * `copilotHeaders(appName, "user")` from `@providerkit/core/auth` in
   * `headers` to name your app in `Editor-Version`. `X-Initiator` is set per
   * call, because it decides what Copilot bills.
   */
  "github-copilot": {
    shape: "openai",
    baseUrl: "https://api.individual.githubcopilot.com",
    path: "/chat/completions",
    auth: "oauth",
    defaultModel: "gpt-5.6-sol",
    models: ["gpt-5.6-sol", "claude-opus-5", "claude-sonnet-5", "gpt-6-astra"],
    headers: {
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "providerkit",
      "Editor-Plugin-Version": "providerkit",
      "X-GitHub-Api-Version": "2026-06-01",
      "Openai-Intent": "conversation-edits",
      "Copilot-Vision-Request": "true",
    },
    initiatorHeader: true,
  },
} as const satisfies Record<string, ProviderPreset>;

export type ProviderPresetId = keyof typeof PROVIDER_PRESETS;

/** Every valid preset id — the factory's unknown-id error lists these. */
export const PRESET_IDS = Object.keys(PROVIDER_PRESETS) as ProviderPresetId[];
