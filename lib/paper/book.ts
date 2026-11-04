// The paper account's books: cash, positions, fills, fees, funding. Pure, so
// every dollar it reports can be tested. No function here can reach an
// exchange — that is the point of a paper account.

/** Hyperliquid's base taker fee. */
export const TAKER_FEE = 0.00045;
/** Assumed cost of crossing the spread, per side. Conservative for BTC/ETH. */
export const SLIPPAGE = 0.0005;

export interface PaperPosition {
  qty: number;
  /** Average fill price, slippage included. */
  entryPx: number;
  entryAt: number;
}

export interface PaperState {
  startingUsd: number;
  cash: number;
  positions: Record<string, PaperPosition>;
  /** UTC day (YYYY-MM-DD) of the last daily candle a decision was made on. */
  lastDecisionDay: string | null;
  /** When funding was last charged; funding accrues from here. */
  lastFundingAt: number;
  feesPaid: number;
  fundingPaid: number;
  realizedPnl: number;
  running: boolean;
  createdAt: number;
}

export interface Fill {
  coin: string;
  side: "buy" | "sell";
  qty: number;
  /** Price after slippage. */
  px: number;
  fee: number;
  /** Sells only: profit on the closed quantity, fees on both legs excluded. */
  pnl: number | null;
}

export function newPaperState(startingUsd: number, now: number): PaperState {
  return {
    startingUsd,
    cash: startingUsd,
    positions: {},
    lastDecisionDay: null,
    lastFundingAt: now,
    feesPaid: 0,
    fundingPaid: 0,
    realizedPnl: 0,
    running: true,
    createdAt: now,
  };
}

export function equity(state: PaperState, mids: Record<string, number>): number | null {
  let total = state.cash;
  for (const [coin, p] of Object.entries(state.positions)) {
    const mid = mids[coin];
    if (!(mid && mid > 0)) return null;
    total += p.qty * mid;
  }
  return total;
}

/**
 * Buy `usd` worth of `coin` at `mid`, fee taken from cash on top. Spends at
 * most the cash on hand. Returns null for nothing worth filling (under $1).
 */
export function buy(
  state: PaperState,
  coin: string,
  usd: number,
  mid: number,
  now: number,
): { state: PaperState; fill: Fill } | null {
  if (!(mid > 0)) return null;
  const allIn = usd * (1 + TAKER_FEE) >= state.cash;
  const spend = allIn ? state.cash / (1 + TAKER_FEE) : usd;
  if (!(spend >= 1)) return null;
  const px = mid * (1 + SLIPPAGE);
  const qty = spend / px;
  // All-in: the fee is whatever is left, so cash lands on exactly 0 rather
  // than a rounding error below it.
  const fee = allIn ? state.cash - spend : spend * TAKER_FEE;
  const prev = state.positions[coin];
  const total = (prev?.qty ?? 0) + qty;
  const entryPx = prev ? (prev.qty * prev.entryPx + qty * px) / total : px;
  return {
    state: {
      ...state,
      cash: state.cash - spend - fee,
      feesPaid: state.feesPaid + fee,
      positions: { ...state.positions, [coin]: { qty: total, entryPx, entryAt: prev?.entryAt ?? now } },
    },
    fill: { coin, side: "buy", qty, px, fee, pnl: null },
  };
}

/** Close the whole position in `coin` at `mid`. Null when there is none. */
export function sellAll(
  state: PaperState,
  coin: string,
  mid: number,
): { state: PaperState; fill: Fill } | null {
  const p = state.positions[coin];
  if (!p || !(mid > 0)) return null;
  const px = mid * (1 - SLIPPAGE);
  const proceeds = p.qty * px;
  const fee = proceeds * TAKER_FEE;
  const pnl = (px - p.entryPx) * p.qty;
  const positions = { ...state.positions };
  delete positions[coin];
  return {
    state: {
      ...state,
      cash: state.cash + proceeds - fee,
      feesPaid: state.feesPaid + fee,
      realizedPnl: state.realizedPnl + pnl,
      positions,
    },
    fill: { coin, side: "sell", qty: p.qty, px, fee, pnl },
  };
}

/**
 * Charge funding on open positions since lastFundingAt, at each coin's
 * current hourly rate (positive rate = longs pay). Using the current rate for
 * the whole gap is an approximation; ticks are minutes apart, so it is a
 * close one.
 */
export function chargeFunding(
  state: PaperState,
  mids: Record<string, number>,
  hourlyRates: Record<string, number>,
  now: number,
): PaperState {
  const hours = Math.max(0, now - state.lastFundingAt) / 3_600_000;
  let paid = 0;
  for (const [coin, p] of Object.entries(state.positions)) {
    const mid = mids[coin];
    const rate = hourlyRates[coin];
    if (!(mid > 0) || !Number.isFinite(rate)) continue;
    paid += p.qty * mid * rate! * hours;
  }
  return { ...state, cash: state.cash - paid, fundingPaid: state.fundingPaid + paid, lastFundingAt: now };
}
