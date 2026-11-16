import { ProviderError } from "../errors.ts";
import type { ChatMessage, StreamOptions } from "../types.ts";

/** Internal wiring only. Type imports never pull the codecs into plain chat. */
export interface HostedCodecs {
  anthropic: typeof import("../hosted/anthropic.ts").anthropicHosted;
  responses: typeof import("../hosted/responses.ts").responsesHosted;
  gemini: typeof import("../hosted/gemini.ts").geminiHosted;
  openai: typeof import("../hosted/openai.ts").openaiHosted;
}

export function refuseHostedTools(
  provider: string,
  opts: StreamOptions,
  messages: readonly ChatMessage[],
): void {
  if (
    opts.hostedTools?.length ||
    messages.some(
      (message) => message.role === "assistant" && message.hostedItems?.provider === provider,
    )
  ) {
    throw new ProviderError(
      provider,
      "invalid",
      `${provider}: hosted tools need the opt-in provider. Import its constructor from @providerkit/core/hosted.`,
    );
  }
}
