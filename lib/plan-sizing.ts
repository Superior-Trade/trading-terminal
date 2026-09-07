/** Per-plan risk-based sizing.
 *
 *  A global funds/leverage slider divorces sizing from the plan: hot-changing
 *  leverage rescales risk with no relation to where the stop sits. The right
 *  order is the reverse — the plan's own stop decides the size:
 *
 *    risk$    = base × riskPct           (what hitting the stop costs)
 *    notional = risk$ ÷ stopDist         (tighter stop ⇒ larger position, same risk)
 *    leverage = suggested, clamped so isolated liquidation (≈ 1/leverage
 *               adverse move) sits ≥ LIQ_BUFFER × the stop distance away —
 *               the stop must always fire long before liquidation could
 *    stake    = notional ÷ leverage      (margin actually committed)
 *
 *  The model supplies riskPct + suggested leverage per plan (the judgment);
 *  this module owns the arithmetic (deterministic, money-critical). Shared
 *  by the plan cards, deployPlan, and the compile payload.
 */

export interface PlanSizingSuggestion {
  /** % of the capital base lost if the stop hits (model-graded by setup quality). */
  riskPct: number;
  /** Model-suggested leverage — clamped here by the liquidation buffer. */
  leverage: number;
  /** One-line sizing rationale (EN; zh rendition lives in plan.zh.sizingNote). */
  note?: string | null;
}

export interface DerivedSizing {
  /** Margin committed (freqtrade stake_amount / bracket collateral), USD. */
  stake: number;
  /** Final integer leverage after the liquidation-buffer clamp. */
  leverage: number;
  /** stake × leverage. */
  notional: number;
  /** $ lost if the stop hits (recomputed after any clamps). */
  riskUsd: number;
  /** |entry − stop| ÷ entry, in %. */
  stopDistPct: number;
  /** True when the funds ceiling or exchange minimums adjusted the ideal size. */
  adjusted: boolean;
}

/** Liquidation must sit at least this many stop-distances beyond the stop. */
export const LIQ_BUFFER = 3;
/** HL min order ≈ $10 notional; keep a little headroom. */
const MIN_NOTIONAL = 12;
/** Superior deploy minimum stake: HL's $10 order minimum plus the upstream
 *  ×1.05 fee/reserve headroom — the API rejects a $10 stake with "increase
 *  to at least $11". */
const MIN_STAKE = 11;
/** Absolute leverage ceiling when the pair's cap is unknown. */
const DEFAULT_MAX_LEVERAGE = 25;

/** Exchange-standard ("crypto default") sizing: the panel IS the order —
 *  stake = the funds the user set (isolated margin), leverage = the leverage
 *  they set, notional = stake × leverage. Risk is a readout, not a driver:
 *  what hitting the stop costs at this fixed size. No stop-driven resizing,
 *  no liquidation clamp beyond leverage ≥ 1 — the number you dial is the
 *  number that deploys. Used by the plan cards; deployPlan sends the same
 *  funds/leverage straight to compile + bracket. */
export function fixedSizing(opts: {
  entry: number;
  stop: number;
  funds: number;
  leverage: number;
}): DerivedSizing | null {
  const funds = opts.funds;
  if (!(funds > 0)) return null;
  const leverage = Math.max(1, Math.round(opts.leverage || 1));
  const stopDist =
    Number.isFinite(opts.entry) && Number.isFinite(opts.stop) && opts.entry
      ? Math.abs(opts.entry - opts.stop) / Math.abs(opts.entry)
      : 0;
  const notional = funds * leverage;
  return {
    stake: Math.round(funds * 100) / 100,
    leverage,
    notional: Math.round(notional * 100) / 100,
    riskUsd: Math.round(notional * stopDist * 100) / 100,
    stopDistPct: Math.round(stopDist * 10000) / 100,
    adjusted: false,
  };
}

export function derivePlanSizing(opts: {
  entry: number;
  stop: number;
  riskPct: number;
  /** Capital base, USD — the panel's funds allocation. */
  base: number;
  suggestedLeverage?: number | null;
  maxLeverage?: number | null;
}): DerivedSizing | null {
  const { entry, stop, base } = opts;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !(base > 0)) return null;
  const stopDist = Math.abs(entry - stop) / Math.abs(entry);
  // Degenerate stops (0 or sub-0.05% away) would size to infinity — refuse.
  if (!Number.isFinite(stopDist) || stopDist < 0.0005) return null;

  const riskPct = Math.min(Math.max(opts.riskPct, 0.1), 5);
  let riskUsd = (base * riskPct) / 100;
  let notional = Math.max(riskUsd / stopDist, MIN_NOTIONAL);

  // Liquidation buffer: isolated liq ≈ 1/leverage adverse move (maintenance
  // margin ignored — that makes the clamp strictly conservative).
  const levByLiq = Math.max(1, Math.floor(1 / (stopDist * LIQ_BUFFER)));
  const levCap = Math.min(
    levByLiq,
    Math.max(1, Math.round(opts.maxLeverage ?? DEFAULT_MAX_LEVERAGE)),
  );
  // No suggestion → conservative default, NOT the liquidation cap.
  let leverage = Math.min(
    Math.max(1, Math.round(opts.suggestedLeverage ?? Math.min(levCap, 3))),
    levCap,
  );

  let stake = notional / leverage;
  let adjusted = false;
  if (stake < MIN_STAKE) {
    // Preserve the RISK target by dropping leverage, not inflating the
    // position: the same notional on a min-stake margin.
    leverage = Math.max(1, Math.min(leverage, Math.round(notional / MIN_STAKE)));
    stake = Math.max(MIN_STAKE, notional / leverage);
    adjusted = true;
  }
  if (stake > base) {
    // Funds ceiling: scale the position down — risk shrinks with it.
    stake = base;
    adjusted = true;
  }
  notional = stake * leverage;
  riskUsd = notional * stopDist;

  return {
    stake: Math.round(stake * 100) / 100,
    leverage,
    notional: Math.round(notional * 100) / 100,
    riskUsd: Math.round(riskUsd * 100) / 100,
    stopDistPct: Math.round(stopDist * 10000) / 100,
    adjusted,
  };
}
