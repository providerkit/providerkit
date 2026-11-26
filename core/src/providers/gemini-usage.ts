import type { TokenUsage } from "../types.ts";

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

/** Gemini bills tool prompts as input and thoughts as output, but reports them separately. */
export function geminiTokenUsage(usage: GeminiUsageMetadata): TokenUsage {
  return {
    inputTokens: (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0),
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cachedInputTokens: usage.cachedContentTokenCount ?? 0,
    ...(usage.toolUsePromptTokenCount !== undefined
      ? { toolUsePromptTokens: usage.toolUsePromptTokenCount }
      : {}),
    ...(usage.thoughtsTokenCount !== undefined
      ? { reasoningTokens: usage.thoughtsTokenCount }
      : {}),
  };
}
