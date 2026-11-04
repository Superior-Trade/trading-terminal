import { TIERS, type AutoTradeSettings, type Tier } from "./settings";

// The decisions auto mode makes without a human, as pure functions so each one
// is tested on its own (guards.test.ts). The engine only wires them together;
// if a rule is not in this file it is not a rule auto mode follows.

export interface AutoPlan {
  title: string;
  direction: "long" | "short" | "neutral";
  mode?: "one_shot" | "recurring";
  tier: Tier;
  entry: number;
  stop: number;
  target: number;
  aliveUntil?: string | null;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Reward:risk from the plan's own levels, or null when the levels are not a
 * coherent trade (stop on the wrong side of entry, target behind it). Neutral
 * plans are graded on their long leg — that is what entry/stop/target describe.
 */
export function rewardRisk(p: Pick<AutoPlan, "direction" | "entry" | "stop" | "target">): number | null {
  const { entry, stop, target } = p;
  if (![entry, stop, target].every((n) => Number.isFinite(n) && n > 0)) return null;
  const short = p.direction === "short";
  const risk = short ? stop - entry : entry - stop;
  const reward = short ? entry - target : target - entry;
  if (risk <= 0 || reward <= 0) return null;
  return reward / risk;
}

const tierRank = (t: Tier) => TIERS.indexOf(t); // S = 0 … D = 4

/** Is this plan good enough to spend a compile and a backtest on? */
export function screenPlan(p: AutoPlan, s: AutoTradeSettings): Verdict {
  if (tierRank(p.tier) > tierRank(s.minTier)) {
    return { ok: false, reason: `tier ${p.tier} is below the minimum ${s.minTier}` };
  }
  const rr = rewardRisk(p);
  if (rr === null) {
    return { ok: false, reason: "entry/stop/target are not a coherent trade" };
  }
  if (rr < s.minRewardRisk) {
    return { ok: false, reason: `reward:risk ${rr.toFixed(2)} is below ${s.minRewardRisk}` };
  }
  // Isolated liquidation sits ≈ 100/leverage % away; the stop must be well
  // inside it or the exchange closes the trade before the strategy does.
  const stopPct = (Math.abs(p.entry - p.stop) / p.entry) * 100;
  const liqPct = 100 / s.leverage;
  if (stopPct * 3 > liqPct) {
    return {
      ok: false,
      reason: `stop ${stopPct.toFixed(2)}% away is too close to liquidation (~${liqPct.toFixed(1)}%) at ${s.leverage}x`,
    };
  }
  return { ok: true };
}

/** Best plan first: tier, then reward:risk. */
export function rankPlans<T extends AutoPlan>(plans: T[]): T[] {
  return [...plans].sort(
    (a, b) => tierRank(a.tier) - tierRank(b.tier) || (rewardRisk(b) ?? 0) - (rewardRisk(a) ?? 0),
  );
}

export interface BacktestMetrics {
  trades: number | null;
  profitPct: number | null;
  drawdownPct: number | null;
}

/** Pulls the three numbers the gate needs out of a resolved freqtrade result. */
export function backtestMetrics(results: Record<string, unknown> | null): BacktestMetrics {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (!results) return { trades: null, profitPct: null, drawdownPct: null };
  const trades =
    num(results.total_trades) ??
    (Array.isArray(results.trades) ? results.trades.length : null);
  // freqtrade reports max_drawdown_account as a ratio (0.12 = 12%).
  const dd = num(results.max_drawdown_account);
  return {
    trades,
    profitPct: num(results.profit_total_pct),
    drawdownPct: dd === null ? null : Math.abs(dd) * 100,
  };
}

/** Did the backtest earn a live deploy? Missing numbers fail closed. */
export function backtestVerdict(m: BacktestMetrics, s: AutoTradeSettings): Verdict {
  if (m.trades === null || m.profitPct === null || m.drawdownPct === null) {
    return { ok: false, reason: "backtest returned no readable results" };
  }
  if (m.trades < s.minBacktestTrades) {
    return { ok: false, reason: `backtest took ${m.trades} trades, fewer than ${s.minBacktestTrades}` };
  }
  if (m.profitPct < s.minBacktestProfitPct) {
    return {
      ok: false,
      reason: `backtest returned ${m.profitPct.toFixed(2)}%, below ${s.minBacktestProfitPct}%`,
    };
  }
  if (m.drawdownPct > s.maxBacktestDrawdownPct) {
    return {
      ok: false,
      reason: `backtest drawdown ${m.drawdownPct.toFixed(1)}% exceeds ${s.maxBacktestDrawdownPct}%`,
    };
  }
  return { ok: true };
}

export interface LimitState {
  tradingFrozen: boolean;
  /** Pairs (bare coins) with an auto bot still able to trade. */
  runningAutoPairs: string[];
  /** Real auto deploys since UTC midnight. */
  deploysToday: number;
  /** Realized PnL of auto bots since UTC midnight (negative = loss), or null when unknown. */
  realizedPnlToday: number | null;
}

/**
 * The last check before money moves. Order matters only for the message: the
 * first failing limit is the one reported. An unknown daily PnL blocks — auto
 * mode must never deploy past a loss limit it could not read.
 */
export function checkLimits(symbol: string, st: LimitState, s: AutoTradeSettings): Verdict {
  if (st.tradingFrozen) return { ok: false, reason: "trading is frozen (FREEZE_TRADING / FREEZE_ALL)" };
  if (st.realizedPnlToday === null) {
    return { ok: false, reason: "could not read today's realized PnL, so the loss limit cannot be checked" };
  }
  if (-st.realizedPnlToday >= s.dailyLossLimitUsd) {
    return {
      ok: false,
      reason: `daily loss limit hit: ${st.realizedPnlToday.toFixed(2)} USDC today (limit -${s.dailyLossLimitUsd})`,
    };
  }
  if (st.deploysToday >= s.maxDeploysPerDay) {
    return { ok: false, reason: `already made ${st.deploysToday} of ${s.maxDeploysPerDay} deploys today` };
  }
  if (st.runningAutoPairs.length >= s.maxConcurrent) {
    return {
      ok: false,
      reason: `${st.runningAutoPairs.length} auto bot(s) running, the maximum is ${s.maxConcurrent}`,
    };
  }
  if (st.runningAutoPairs.some((p) => p.toLowerCase() === symbol.toLowerCase())) {
    return { ok: false, reason: `an auto bot is already running on ${symbol}` };
  }
  return { ok: true };
}

/** Start of the current UTC day, epoch ms. */
export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
