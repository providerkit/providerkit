import type { FetchLike } from "@providerkit/core";
import { TransportError, type ClientToolHandler, type DraftScope } from "@providerkit/react";
import { apiPath, cardInput, cardResult, isRecord } from "./shared.ts";
import { demoFetch } from "./transport.ts";

/** Only this demo's server can grant execution. Local entries just carry an issued grant. */
export function clientActions(
  scope: DraftScope,
  loseReply = false,
  fetcher: FetchLike = demoFetch,
): Record<string, ClientToolHandler> {
  const grants = new Map<
    string,
    { token: string; runId: string; input: ReturnType<typeof cardInput> }
  >();
  async function post(action: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetcher(`${apiPath(scope)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
      signal,
    });
    const body: unknown = await response.json();
    if (!response.ok)
      throw new TransportError(response.status < 500 ? "refused" : "unknown", {
        code: "demo_action",
        message:
          isRecord(body) && typeof body.message === "string"
            ? body.message
            : "The action was not confirmed. Check action result before trying again.",
      });
    return body;
  }
  return {
    make_sample_card: {
      safety: "claimed",
      async claim({ signal, ...request }) {
        const result = await post("claim", request, signal);
        if (!isRecord(result)) return { status: "unknown" };
        if (result.status === "completed")
          return { status: "completed", value: cardResult(result.value) };
        if (result.status === "busy" || result.status === "denied" || result.status === "unknown")
          return { status: result.status };
        if (result.status !== "granted" || typeof result.token !== "string")
          return { status: "unknown" };
        const grant = {
          token: result.token,
          runId: request.runId,
          input: cardInput(request.input),
        };
        grants.set(request.requestId, grant);
        return {
          status: "granted",
          async complete(value) {
            // Record completion even when the view closed. No delayed SDK response is sent here.
            await post("complete", {
              ...grant,
              requestId: request.requestId,
              value: cardResult(value),
            });
            grants.delete(request.requestId);
          },
        };
      },
      async run(input, { requestId, signal }) {
        signal.throwIfAborted();
        const grant = grants.get(requestId);
        if (!grant || JSON.stringify(cardInput(input)) !== JSON.stringify(grant.input))
          throw new Error("The card has no matching grant. Check action result.");
        return cardResult(
          await post(`execute${loseReply ? "?lose=1" : ""}`, { ...grant, requestId }, signal),
        );
      },
    },
  };
}
