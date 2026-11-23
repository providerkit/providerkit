export interface OpenRouterBill {
  cost?: unknown;
  is_byok?: boolean;
  cost_details?: { upstream_inference_cost?: unknown } | null;
}

/** Other gateways may speak the same wire format without billing in US dollars. */
export function isOpenRouterBillingHost(baseUrl: string): boolean {
  try {
    return /(?:^|\.)openrouter\.ai\.?$/.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** A negative or a string falls back to the caller's rate. Zero is a real bill. */
function price(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * What an OpenRouter call cost, in USD, or undefined when it did not say.
 *
 * Nothing has to ask for it. OpenRouter's usage-accounting docs (read
 * 2026-09-26) say every response now carries the full usage record, cost
 * included, on the last frame of a stream, and that `usage: { include: true }`
 * is deprecated and does nothing. Measured the same day: a streamed call and a
 * plain one, neither sending the flag, both came back with `usage.cost`, the
 * stream on its last frame. So the request does not send it.
 *
 * With the caller's own provider key (BYOK), `cost` is only OpenRouter's fee.
 * The inference is billed to the caller's provider account and arrives as
 * `cost_details.upstream_inference_cost`, so the call cost the two together.
 * Without that second figure there is no whole bill to report, and the
 * caller's rate prices the call instead.
 */
export function openRouterCostUsd(
  usage: OpenRouterBill,
  scope: "total" | "reported" = "total",
): number | undefined {
  const cost = price(usage.cost);
  if (scope === "reported" || cost === undefined || usage.is_byok !== true) return cost;
  const upstream = price(usage.cost_details?.upstream_inference_cost);
  return upstream === undefined ? undefined : price(cost + upstream);
}
