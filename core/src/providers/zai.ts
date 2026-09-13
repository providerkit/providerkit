import { createAnthropicProvider, type AnthropicConfig } from "./anthropic.ts";
import type { Provider } from "../types.ts";

/** Z.ai Coding Plan's Anthropic-compatible API root, not its pay-per-token API. */
export const ZAI_CODING_BASE_URL = "https://api.z.ai/api/anthropic";

export type ZaiCodingConfig = Omit<AnthropicConfig, "baseUrl" | "id" | "bearer">;

/** Use a Z.ai Coding Plan key with the shared Messages adapter. The preset owns
 *  the endpoint, Bearer auth and the thinking dialect; callers still choose
 *  their model and effort. Tool calls, usage and errors use the existing
 *  adapter.
 *
 *  Dialect notes, measured 2026-09-13 against the live endpoint on
 *  `glm-5.3-flash`: an absent thinking field means the MODEL's default —
 *  thinking ON — so `effort: "none"` is sent as an explicit
 *  `thinking: { type: "disabled" }`; `low`–`max` ride the standard thinking
 *  budgets, which the endpoint accepts. Images force a thinking block even
 *  under `disabled` (the model's choice, billed as output). */
export function createZaiCodingProvider(config: ZaiCodingConfig): Provider {
  return createAnthropicProvider({
    ...config,
    id: "zai",
    baseUrl: ZAI_CODING_BASE_URL,
    bearer: true,
    explicitNone: true,
    // Coding gateways can allocate a 32K thinking budget themselves. Leave room
    // for the answer; callers can still set a smaller cap for their model.
    maxTokens: config.maxTokens ?? 65_536,
  });
}
