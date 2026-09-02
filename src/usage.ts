// Counting tokens and pricing them.
//
// The RATES are not here on purpose. A price table is volatile data about a
// model catalogue that differs per application, it goes stale on a vendor's
// schedule rather than this package's, and a wrong number shipped in a library
// is a wrong number in everyone's ledger. So the arithmetic lives here and the
// numbers stay with the caller, who can verify them line by line against a
// price sheet.
import type { TokenUsage } from "./types.ts";
import { EMPTY_USAGE } from "./types.ts";

/** USD per MILLION tokens — how every vendor prints its price sheet, so a row
 *  can be checked against one without arithmetic. */
export interface ModelRate {
  /** Cache-MISS input: fresh tokens the provider had to read. */
  input: number;
  output: number;
  /** Cache-HIT input. Providers auto-cache repeated prefixes and bill the hit
   *  portion far cheaper — 0.1× on Anthropic, ~0.1× on Gemini, 0.5× on some
   *  OpenAI models. In an agent loop the re-sent context is overwhelmingly
   *  hits, so billing it at the miss rate overcounts by up to 10×. */
  cacheRead: number;
  /** Input WRITTEN to cache. Anthropic bills this ABOVE the input rate
   *  (1.25×); the OpenAI-shape auto-cachers bill it at the input rate.
   *  Defaults to `input` when a vendor does not price it separately. */
  cacheWrite?: number;
}

/** Add two usage records. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/**
 * USD for one call.
 *
 * Cached tokens are a SUBSET of input, not an addition to it: the miss part
 * bills at the full rate and the hit part at the cache rate. `cached` is
 * clamped to `input` so an over-reporting provider can neither drive the miss
 * count negative nor bill for more prompt than it was sent.
 */
export function costUsd(usage: TokenUsage, rate: ModelRate): number {
  const input = Math.max(0, usage.inputTokens);
  const cached = Math.min(Math.max(0, usage.cachedInputTokens), input);
  const written = Math.max(0, usage.cacheWriteTokens ?? 0);
  const miss = input - cached;
  const writeRate = rate.cacheWrite ?? rate.input;
  return (
    (miss * rate.input +
      cached * rate.cacheRead +
      written * writeRate +
      Math.max(0, usage.outputTokens) * rate.output) /
    1_000_000
  );
}

/**
 * Accumulates usage and cost across the calls of one run, pricing each with
 * the rate in effect for the model that served it — so a run that switches to
 * a backup model, or spans a time-of-day price boundary, still bills correctly.
 */
export class UsageTracker {
  private usage: TokenUsage = { ...EMPTY_USAGE, cacheWriteTokens: 0 };
  private cost = 0;
  /** USD the cache hits saved, versus billing them all as misses.
   *  Observability only — never billed. */
  private saved = 0;

  add(usage: TokenUsage, rate?: ModelRate): void {
    this.usage = addUsage(this.usage, usage);
    if (!rate) return;
    this.cost += costUsd(usage, rate);
    const cached = Math.min(Math.max(0, usage.cachedInputTokens), Math.max(0, usage.inputTokens));
    this.saved += (cached * (rate.input - rate.cacheRead)) / 1_000_000;
  }

  get totals(): TokenUsage {
    return { ...this.usage };
  }

  get costUsd(): number {
    return this.cost;
  }

  get cacheSavingsUsd(): number {
    return this.saved;
  }

  /** A generous runaway guard, not a quality cap: the loop's step budget is
   *  the real bound, and a run that trips this should finalize rather than
   *  fail, so set it well above any legitimate run. */
  isOverBudget(maxUsd: number): boolean {
    return this.cost >= maxUsd;
  }

  reset(): void {
    this.usage = { ...EMPTY_USAGE, cacheWriteTokens: 0 };
    this.cost = 0;
    this.saved = 0;
  }
}
