import { describe, expect, it } from "vitest";
import { trendSignal } from "./strategy";
import { buy, chargeFunding, equity, newPaperState, sellAll, SLIPPAGE, TAKER_FEE } from "./book";

describe("trendSignal", () => {
  it("is null without enough history", () => {
    expect(trendSignal([1, 2, 3], 5)).toBeNull();
  });
  it("is long when the last close is above the average", () => {
    expect(trendSignal([1, 1, 1, 1, 2], 5)).toBe("long");
  });
  it("is flat when the last close is below the average", () => {
    expect(trendSignal([2, 2, 2, 2, 1], 5)).toBe("flat");
  });
  it("is flat exactly at the average", () => {
    expect(trendSignal([3, 3, 3, 3, 3], 5)).toBe("flat");
  });
  it("uses only the last n closes", () => {
    // A huge old close must not drag the average.
    expect(trendSignal([1000, 1, 1, 1, 1, 2], 5)).toBe("long");
  });
  it("refuses bad prices rather than deciding on them", () => {
    expect(trendSignal([1, 1, NaN, 1, 2], 5)).toBeNull();
    expect(trendSignal([1, 1, 0, 1, 2], 5)).toBeNull();
  });
});

describe("paper book", () => {
  const t = 1_800_000_000_000;

  it("starts with all cash", () => {
    const s = newPaperState(100, t);
    expect(s.cash).toBe(100);
    expect(equity(s, {})).toBe(100);
  });

  it("buys with slippage and fee, and never spends more than it has", () => {
    const s = newPaperState(100, t);
    const r = buy(s, "BTC", 1000, 50_000, t)!;
    expect(r.state.cash).toBeGreaterThanOrEqual(0);
    expect(r.state.cash).toBeCloseTo(0, 6);
    expect(r.fill.px).toBeCloseTo(50_000 * (1 + SLIPPAGE));
    expect(r.state.feesPaid).toBeCloseTo(r.fill.qty * r.fill.px * TAKER_FEE);
  });

  it("loses exactly the round-trip costs on a flat round trip", () => {
    const s = newPaperState(100, t);
    const b = buy(s, "BTC", 50, 50_000, t)!;
    const x = sellAll(b.state, "BTC", 50_000)!;
    const costs = 100 - x.state.cash;
    // Two slippages and two fees on ~$50, nothing else.
    expect(costs).toBeGreaterThan(50 * 2 * (SLIPPAGE + TAKER_FEE) * 0.99);
    expect(costs).toBeLessThan(50 * 2 * (SLIPPAGE + TAKER_FEE) * 1.01);
    expect(x.state.positions).toEqual({});
  });

  it("books the price move as realized pnl", () => {
    const s = newPaperState(100, t);
    const b = buy(s, "ETH", 50, 2_000, t)!;
    const x = sellAll(b.state, "ETH", 2_200)!;
    expect(x.fill.pnl!).toBeGreaterThan(4.5);
    expect(x.state.realizedPnl).toBeCloseTo(x.fill.pnl!);
  });

  it("marks equity to market and refuses to guess a missing price", () => {
    const b = buy(newPaperState(100, t), "BTC", 50, 50_000, t)!;
    expect(equity(b.state, { BTC: 55_000 })!).toBeGreaterThan(100);
    expect(equity(b.state, {})).toBeNull();
  });

  it("skips fills under a dollar and selling what it does not hold", () => {
    expect(buy(newPaperState(0.5, t), "BTC", 10, 50_000, t)).toBeNull();
    expect(sellAll(newPaperState(100, t), "BTC", 50_000)).toBeNull();
  });

  it("charges longs positive funding by the hour", () => {
    const b = buy(newPaperState(100, t), "BTC", 50, 50_000, t)!;
    const notional = b.state.positions.BTC!.qty * 50_000;
    const f = chargeFunding(b.state, { BTC: 50_000 }, { BTC: 0.0001 }, t + 2 * 3_600_000);
    expect(f.fundingPaid).toBeCloseTo(notional * 0.0001 * 2);
    expect(f.cash).toBeCloseTo(b.state.cash - notional * 0.0001 * 2);
    expect(f.lastFundingAt).toBe(t + 2 * 3_600_000);
  });
});
