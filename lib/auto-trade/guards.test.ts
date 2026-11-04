import { describe, it, expect } from "vitest";
import {
  rewardRisk,
  screenPlan,
  rankPlans,
  backtestMetrics,
  backtestVerdict,
  checkLimits,
  utcDayStart,
  type AutoPlan,
  type LimitState,
} from "./guards";
import { AutoTradeSettingsSchema, DEFAULT_SETTINGS } from "./settings";

const plan = (over: Partial<AutoPlan> = {}): AutoPlan => ({
  title: "t",
  direction: "long",
  tier: "A",
  entry: 100,
  stop: 98,
  target: 104,
  ...over,
});

const limits = (over: Partial<LimitState> = {}): LimitState => ({
  tradingFrozen: false,
  runningAutoPairs: [],
  deploysToday: 0,
  realizedPnlToday: 0,
  ...over,
});

describe("defaults", () => {
  it("start off and in dry run", () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.dryRun).toBe(true);
  });

  it("refuse a stake under the deploy minimum and leverage over 10x", () => {
    expect(AutoTradeSettingsSchema.safeParse({ stakeUsd: 5 }).success).toBe(false);
    expect(AutoTradeSettingsSchema.safeParse({ leverage: 25 }).success).toBe(false);
  });
});

describe("rewardRisk", () => {
  it("computes long and short", () => {
    expect(rewardRisk(plan())).toBeCloseTo(2);
    expect(rewardRisk(plan({ direction: "short", stop: 102, target: 96 }))).toBeCloseTo(2);
  });

  it("is null when the stop is on the wrong side", () => {
    expect(rewardRisk(plan({ stop: 101 }))).toBeNull();
    expect(rewardRisk(plan({ direction: "short", stop: 98, target: 96 }))).toBeNull();
  });
});

describe("screenPlan", () => {
  it("passes a clean A plan", () => {
    expect(screenPlan(plan(), DEFAULT_SETTINGS)).toEqual({ ok: true });
  });

  it("rejects a tier below the minimum", () => {
    const v = screenPlan(plan({ tier: "B" }), DEFAULT_SETTINGS);
    expect(v.ok).toBe(false);
  });

  it("accepts a tier above the minimum", () => {
    expect(screenPlan(plan({ tier: "S" }), DEFAULT_SETTINGS).ok).toBe(true);
  });

  it("rejects a thin reward:risk", () => {
    expect(screenPlan(plan({ target: 101 }), DEFAULT_SETTINGS).ok).toBe(false);
  });

  it("rejects a stop too close to liquidation for the leverage", () => {
    // 10% stop at 5x: liquidation ≈ 20% away, needs ≥3× headroom.
    const s = { ...DEFAULT_SETTINGS, leverage: 5 };
    expect(screenPlan(plan({ stop: 90, target: 130 }), s).ok).toBe(false);
  });
});

describe("rankPlans", () => {
  it("orders by tier, then reward:risk", () => {
    const ranked = rankPlans([
      plan({ title: "b", tier: "B" }),
      plan({ title: "a-low", tier: "A", target: 103 }),
      plan({ title: "a-high", tier: "A", target: 106 }),
    ]);
    expect(ranked.map((p) => p.title)).toEqual(["a-high", "a-low", "b"]);
  });
});

describe("backtest gate", () => {
  it("reads freqtrade's drawdown ratio as a percent", () => {
    expect(
      backtestMetrics({ total_trades: 5, profit_total_pct: 3.2, max_drawdown_account: 0.12 }),
    ).toEqual({ trades: 5, profitPct: 3.2, drawdownPct: 12 });
  });

  it("fails closed on missing results", () => {
    expect(backtestVerdict(backtestMetrics(null), DEFAULT_SETTINGS).ok).toBe(false);
  });

  it("rejects too few trades, a loss, or deep drawdown", () => {
    const s = DEFAULT_SETTINGS;
    expect(backtestVerdict({ trades: 1, profitPct: 5, drawdownPct: 2 }, s).ok).toBe(false);
    expect(backtestVerdict({ trades: 10, profitPct: -1, drawdownPct: 2 }, s).ok).toBe(false);
    expect(backtestVerdict({ trades: 10, profitPct: 5, drawdownPct: 35 }, s).ok).toBe(false);
    expect(backtestVerdict({ trades: 10, profitPct: 5, drawdownPct: 5 }, s).ok).toBe(true);
  });
});

describe("checkLimits", () => {
  const s = DEFAULT_SETTINGS;

  it("passes with nothing running", () => {
    expect(checkLimits("BTC", limits(), s)).toEqual({ ok: true });
  });

  it("blocks when trading is frozen", () => {
    expect(checkLimits("BTC", limits({ tradingFrozen: true }), s).ok).toBe(false);
  });

  it("blocks when today's PnL is unknown", () => {
    expect(checkLimits("BTC", limits({ realizedPnlToday: null }), s).ok).toBe(false);
  });

  it("blocks at the daily loss limit", () => {
    expect(checkLimits("BTC", limits({ realizedPnlToday: -s.dailyLossLimitUsd }), s).ok).toBe(false);
    expect(checkLimits("BTC", limits({ realizedPnlToday: -(s.dailyLossLimitUsd - 1) }), s).ok).toBe(true);
  });

  it("blocks at the daily deploy count", () => {
    expect(checkLimits("BTC", limits({ deploysToday: s.maxDeploysPerDay }), s).ok).toBe(false);
  });

  it("blocks at max concurrent and on a duplicate pair", () => {
    expect(checkLimits("BTC", limits({ runningAutoPairs: ["ETH"] }), s).ok).toBe(false);
    const two = { ...s, maxConcurrent: 2 };
    expect(checkLimits("BTC", limits({ runningAutoPairs: ["btc"] }), two).ok).toBe(false);
    expect(checkLimits("BTC", limits({ runningAutoPairs: ["ETH"] }), two).ok).toBe(true);
  });
});

describe("utcDayStart", () => {
  it("floors to UTC midnight", () => {
    expect(utcDayStart(Date.parse("2026-11-03T23:59:00Z"))).toBe(Date.parse("2026-11-03T00:00:00Z"));
  });
});
