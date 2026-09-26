import { describe, expect, it } from "vitest";
import { addUsage, costUsd, subtractUsage, UsageTracker, type ModelRate } from "../src/usage.ts";
import type { TokenUsage } from "../src/types.ts";

/** Anthropic-shaped rates: cache reads at 0.1x, writes at 1.25x. */
const CLAUDE: ModelRate = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
/** An auto-cacher that does not price writes separately. */
const FLASH: ModelRate = { input: 0.5, output: 3, cacheRead: 0.05 };

const usage = (u: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  ...u,
});

describe("costUsd", () => {
  it("bills the miss part at input and the hit part at the cache rate", () => {
    // 1M input of which 900k cached: 100k * $3 + 900k * $0.30, all per 1M.
    const cost = costUsd(usage({ inputTokens: 1_000_000, cachedInputTokens: 900_000 }), CLAUDE);
    expect(cost).toBeCloseTo(0.3 + 0.27, 10);
  });

  it("treats cached as a SUBSET of input, never an addition", () => {
    const allCached = costUsd(usage({ inputTokens: 1_000, cachedInputTokens: 1_000 }), CLAUDE);
    expect(allCached).toBeCloseTo((1_000 * 0.3) / 1_000_000, 12);
  });

  it("clamps an over-reporting provider instead of billing negative misses", () => {
    // cached > input would drive the miss count negative and UNDER-bill.
    const cost = costUsd(usage({ inputTokens: 100, cachedInputTokens: 5_000 }), CLAUDE);
    expect(cost).toBeCloseTo((100 * 0.3) / 1_000_000, 12);
    expect(cost).toBeGreaterThan(0);
  });

  it("prices cache writes above input where the vendor does", () => {
    const written = costUsd(usage({ inputTokens: 0, cacheWriteTokens: 1_000_000 }), CLAUDE);
    expect(written).toBeCloseTo(3.75, 10);
  });

  it("falls back to the input rate when a vendor does not price writes", () => {
    const written = costUsd(usage({ inputTokens: 0, cacheWriteTokens: 1_000_000 }), FLASH);
    expect(written).toBeCloseTo(0.5, 10);
  });

  it("never returns a negative cost from junk counters", () => {
    const cost = costUsd(
      usage({ inputTokens: -10, cachedInputTokens: -5, outputTokens: -1_000 }),
      CLAUDE,
    );
    expect(cost).toBe(0);
  });

  it("bills what the provider reported over what the rate says", () => {
    // The rate would say $3.00. The host that answered charged $1.20, and
    // that is the bill.
    const cost = costUsd(usage({ inputTokens: 1_000_000, reportedCostUsd: 1.2 }), CLAUDE);
    expect(cost).toBe(1.2);
  });

  it("keeps a free call free", () => {
    expect(costUsd(usage({ inputTokens: 1_000_000, reportedCostUsd: 0 }), CLAUDE)).toBe(0);
  });
});

describe("addUsage", () => {
  it("sums every counter, treating an absent cacheWrite as zero", () => {
    const total = addUsage(
      usage({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }),
      usage({ inputTokens: 5, cachedInputTokens: 1, outputTokens: 3, cacheWriteTokens: 7 }),
    );
    expect(total).toEqual({
      inputTokens: 15,
      cachedInputTokens: 5,
      cacheWriteTokens: 7,
      outputTokens: 5,
    });
  });

  it("carries no reported cost — a sum is not one invoice", () => {
    // If one call reported a cost and the other did not, keeping the one
    // figure would make `costUsd(total, rate)` bill the whole sum at it.
    const total = addUsage(
      usage({ inputTokens: 10, reportedCostUsd: 0.5 }),
      usage({ inputTokens: 1_000_000 }),
    );
    expect(total).not.toHaveProperty("reportedCostUsd");
  });
});

describe("UsageTracker", () => {
  it("prices each call with the rate of the model that served it", () => {
    // A run that falls back to a cheaper model must not be billed at the first
    // model's rates.
    const tracker = new UsageTracker();
    tracker.add(usage({ inputTokens: 1_000_000, outputTokens: 0 }), CLAUDE);
    tracker.add(usage({ inputTokens: 1_000_000, outputTokens: 0 }), FLASH);
    expect(tracker.costUsd).toBeCloseTo(3 + 0.5, 10);
    expect(tracker.totals.inputTokens).toBe(2_000_000);
  });

  it("accumulates usage even when no rate is known", () => {
    const tracker = new UsageTracker();
    tracker.add(usage({ inputTokens: 100, outputTokens: 20 }));
    expect(tracker.totals).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(tracker.costUsd).toBe(0);
  });

  it("counts a reported cost with no rate, and prefers it over one", () => {
    // A run that falls back from a rate-priced host to one that reports its
    // own bill: each call keeps the price that is true for it.
    const tracker = new UsageTracker();
    tracker.add(usage({ inputTokens: 1_000_000 }), FLASH);
    tracker.add(usage({ inputTokens: 1_000_000, reportedCostUsd: 0.25 }));
    tracker.add(usage({ inputTokens: 1_000_000, reportedCostUsd: 0.1 }), CLAUDE);
    expect(tracker.costUsd).toBeCloseTo(0.5 + 0.25 + 0.1, 10);
    expect(tracker.isOverBudget(0.85)).toBe(true);

    tracker.subtract(usage({ inputTokens: 1_000_000, reportedCostUsd: 0.25 }));
    expect(tracker.costUsd).toBeCloseTo(0.6, 10);
  });

  it("reports what the cache saved, without billing it", () => {
    const tracker = new UsageTracker();
    tracker.add(usage({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }), CLAUDE);
    expect(tracker.cacheSavingsUsd).toBeCloseTo(3 - 0.3, 10);
    expect(tracker.costUsd).toBeCloseTo(0.3, 10);
  });

  it("is a runaway guard, not a quality cap", () => {
    const tracker = new UsageTracker();
    tracker.add(usage({ inputTokens: 1_000_000, outputTokens: 0 }), CLAUDE);
    expect(tracker.isOverBudget(3)).toBe(true);
    expect(tracker.isOverBudget(10)).toBe(false);
  });

  it("resets to empty", () => {
    const tracker = new UsageTracker();
    tracker.add(usage({ inputTokens: 500, outputTokens: 100 }), CLAUDE);
    tracker.reset();
    expect(tracker.costUsd).toBe(0);
    expect(tracker.totals.inputTokens).toBe(0);
  });

  it("subtracts rolled back or optimistic turns without going negative", () => {
    const tracker = new UsageTracker();
    tracker.add(usage({ inputTokens: 1_000, outputTokens: 200 }), CLAUDE);
    tracker.subtract(usage({ inputTokens: 400, outputTokens: 50 }), CLAUDE);
    expect(tracker.totals.inputTokens).toBe(600);
    expect(tracker.totals.outputTokens).toBe(150);

    // Over-subtraction clamps to 0
    tracker.subtract(usage({ inputTokens: 10_000, outputTokens: 10_000 }), CLAUDE);
    expect(tracker.totals.inputTokens).toBe(0);
    expect(tracker.totals.outputTokens).toBe(0);
    expect(tracker.costUsd).toBe(0);
  });
});

describe("subtractUsage", () => {
  it("subtracts usage fields and clamps each at zero", () => {
    const a = usage({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 });
    const b = usage({ inputTokens: 30, cachedInputTokens: 20, outputTokens: 10 });
    expect(subtractUsage(a, b)).toEqual({
      inputTokens: 70,
      cachedInputTokens: 30,
      cacheWriteTokens: 0,
      outputTokens: 10,
    });

    const c = usage({ inputTokens: 200, cachedInputTokens: 200, outputTokens: 200 });
    expect(subtractUsage(a, c)).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
  });
});
