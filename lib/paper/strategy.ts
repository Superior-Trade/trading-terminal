// The rule the paper account trades, and the evidence it was chosen on.
//
// Long a coin while its last completed daily close is above its 200-day simple
// average; flat otherwise. Long only, 1x, equal share of equity per coin.
//
// Why this one (measured 2026-11-04; numbers kept here so the panel can show
// them next to the live result, which is the only test that counts):
// - QuantGPT, Binance universe 2019–2026, before fees: every rotation rule
//   tried lost to holding BTC — 12-1 momentum, low and high funding, largest
//   coins with and without a trend filter.
// - Hyperliquid daily candles 2021-08 → 2026-11, fees and slippage in: the
//   200-day filter turned $100 into $339 on BTC (hold: $163, worst drop −32%
//   vs −77%) and $225 on ETH (hold: $75). 200 was picked from 5 lengths tried
//   on the same data, so part of that edge is fitted.
// - Superior Trade backtest (Freqtrade, its own fills and fees), BTC+ETH,
//   2021-03 → 2026-05: $100 → $172.63, worst drop −35%, 35 trades, 26% won;
//   holding both returned +30.6%.

export const PAPER_COINS = ["BTC", "ETH"] as const;
export type PaperCoin = (typeof PAPER_COINS)[number];
export const SMA_DAYS = 200;

export const STRATEGY_INFO = {
  id: "sma200-trend",
  name: "200-day trend filter",
  rule: "Long BTC and ETH, each while its last daily close is above its 200-day average; cash otherwise. 1x, long only, half of equity per coin.",
  evidence: [
    "QuantGPT 2019–2026: every altcoin rotation and funding rule tried lost to holding BTC.",
    "Hyperliquid 2021–2026 with fees: BTC $100 → $339 (hold $163), ETH $100 → $225 (hold $75).",
    "Superior Trade backtest 2021-03 → 2026-05: $100 → $172.63, worst drop −35%, 35 trades.",
  ],
  caveat:
    "Backtests are not a promise. The 200-day length was chosen on the same history it was tested on, and trend rules lose often in choppy markets — 74% of the backtest's trades lost.",
} as const;

/**
 * "long" when the newest close is above the simple average of the last `n`
 * closes (newest included), "flat" when at or below it, null when there are
 * fewer than `n` closes. Pass COMPLETED candles only, oldest first — feeding
 * the still-forming daily candle would decide on a price that may not hold.
 */
export function trendSignal(closes: number[], n = SMA_DAYS): "long" | "flat" | null {
  if (closes.length < n || n < 1) return null;
  const window = closes.slice(-n);
  if (window.some((c) => !Number.isFinite(c) || c <= 0)) return null;
  const sma = window.reduce((a, b) => a + b, 0) / n;
  return window[n - 1]! > sma ? "long" : "flat";
}
