// Structured order-flow (footprint) digest for the AI.
//
// The footprint overlay is a SEPARATE canvas painted over TradingView, so it
// never appears in the chart screenshot the detector/agent receives — and even
// if it did, the per-price "sell × buy" numbers are far too small to read in a
// downscaled JPEG. So when footprint mode is on, we hand the model the same
// numbers as TEXT: per-bar delta, cumulative delta (CVD), point-of-control, and
// the standout price-level imbalances. Same source the overlay uses (readCells).

import { readCells } from "./orderflow-recorder";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

/** Chart timeframe (HL interval "5m"/"1h" or TV resolution "5"/"60"/"1D") → ms. */
function timeframeMs(tf?: string | null): number {
  if (!tf) return 300_000;
  const s = String(tf).trim().toLowerCase();
  if (INTERVAL_MS[s]) return INTERVAL_MS[s];
  const m = s.match(/^(\d+)\s*([mhdw])$/);
  if (m) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]]!;
    return parseInt(m[1], 10) * unit;
  }
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n % 1440 === 0) return 86_400_000 * (n / 1440);
    if (n % 60 === 0) return 3_600_000 * (n / 60);
    return 60_000 * n;
  }
  return 300_000;
}

/** Chart symbol → HL coin, mirroring the datafeed's symbolToCoin (strip an
 *  "Exchange:" prefix, take the base token before "/" or "-"). */
function symbolToCoin(symbol?: string | null): string | null {
  if (!symbol) return null;
  const noPrefix = symbol.replace(/^[^:]+:/, "").trim();
  const base = noPrefix.replace(/\/.*$/, "").replace(/-.*$/, "").trim();
  return base || null;
}

function fmtVol(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return v.toFixed(0);
  return v.toFixed(3);
}

function fmtPrice(p: number): string {
  return p.toFixed(p < 10 ? 4 : p < 1000 ? 2 : 0);
}

/** Does the chart context have the Order-flow Footprint indicator enabled? */
export function footprintEnabled(
  indicators?: Array<{ name?: string; id?: string }> | null,
): boolean {
  return !!indicators?.some(
    (i) => /order-?flow|footprint/i.test(i.name ?? "") || /orderflow/i.test(i.id ?? ""),
  );
}

/** Build the text digest, or null when there's no coin. Never throws. */
export async function buildOrderflowDigest(
  symbol?: string | null,
  timeframe?: string | null,
): Promise<string | null> {
  const coin = symbolToCoin(symbol);
  if (!coin) return null;
  const barMs = timeframeMs(timeframe);
  const WINDOW_BARS = 14;
  const from = Date.now() - Math.max(barMs * WINDOW_BARS, 3 * 3_600_000);

  let data: Awaited<ReturnType<typeof readCells>>;
  try {
    data = await readCells(coin, from);
  } catch {
    return null;
  }
  const { binSize, cells } = data;
  if (!cells?.length) {
    return `=== ORDER FLOW (footprint) for ${coin} ===\n(No recorded order-flow yet — the footprint feed is still warming up for this coin; rely on price/volume for now.)`;
  }

  // Aggregate 5-min buckets → chart-timeframe bars, keeping per-price rows.
  type Bar = { buy: number; sell: number; rows: Map<number, { buy: number; sell: number }> };
  const bars = new Map<number, Bar>();
  for (const c of cells) {
    const barT = Math.floor(c.bucket / barMs) * barMs;
    let bar = bars.get(barT);
    if (!bar) {
      bar = { buy: 0, sell: 0, rows: new Map() };
      bars.set(barT, bar);
    }
    bar.buy += c.buy;
    bar.sell += c.sell;
    const row = bar.rows.get(c.bin) ?? { buy: 0, sell: 0 };
    row.buy += c.buy;
    row.sell += c.sell;
    bar.rows.set(c.bin, row);
  }

  const sorted = [...bars.entries()].sort((a, b) => a[0] - b[0]).slice(-WINDOW_BARS);
  const lines: string[] = [];
  let cvd = 0;
  let totBuy = 0;
  let totSell = 0;
  const agg = new Map<number, { buy: number; sell: number }>();
  for (const [barT, bar] of sorted) {
    const delta = bar.buy - bar.sell;
    cvd += delta;
    totBuy += bar.buy;
    totSell += bar.sell;
    let pocPrice = NaN;
    let pocVol = -1;
    for (const [price, r] of bar.rows) {
      const t = r.buy + r.sell;
      if (t > pocVol) {
        pocVol = t;
        pocPrice = price;
      }
      const a = agg.get(price) ?? { buy: 0, sell: 0 };
      a.buy += r.buy;
      a.sell += r.sell;
      agg.set(price, a);
    }
    const time = new Date(barT).toISOString().slice(11, 16);
    lines.push(
      `${time}  Δ${delta >= 0 ? "+" : ""}${fmtVol(delta)}  (buy ${fmtVol(bar.buy)} / sell ${fmtVol(bar.sell)})  POC≈${fmtPrice(pocPrice)}  CVD ${cvd >= 0 ? "+" : ""}${fmtVol(cvd)}`,
    );
  }

  // Standout price-level imbalances (≥3:1) among the highest-volume rows.
  const imbal: string[] = [];
  for (const [price, r] of [...agg.entries()]
    .sort((a, b) => b[1].buy + b[1].sell - (a[1].buy + a[1].sell))
    .slice(0, 24)) {
    if (r.buy + r.sell <= 0) continue;
    if (r.buy > 0 && r.buy >= 3 * Math.max(r.sell, 1e-9))
      imbal.push(`buy stack ${fmtPrice(price)} (buy ${fmtVol(r.buy)} vs sell ${fmtVol(r.sell)})`);
    else if (r.sell > 0 && r.sell >= 3 * Math.max(r.buy, 1e-9))
      imbal.push(`sell stack ${fmtPrice(price)} (sell ${fmtVol(r.sell)} vs buy ${fmtVol(r.buy)})`);
    if (imbal.length >= 5) break;
  }

  const bias =
    totBuy > totSell * 1.1
      ? "net BUYING (aggressive buyers dominate)"
      : totSell > totBuy * 1.1
        ? "net SELLING (aggressive sellers dominate)"
        : "roughly balanced";

  return [
    `=== ORDER FLOW (footprint) for ${coin} — aggressive buy vs sell volume traded AT each price (bin size ${binSize}) ===`,
    `These are the exact numbers the on-chart footprint cells show (unreadable in the screenshot). Δ = bar delta (buy−sell); CVD = cumulative delta over the window; POC = the bar's highest-volume price.`,
    `Window bias: ${bias} — total buy ${fmtVol(totBuy)} vs sell ${fmtVol(totSell)}, ending CVD ${cvd >= 0 ? "+" : ""}${fmtVol(cvd)}.`,
    `Per ${timeframe ?? "bar"} (UTC, newest last):`,
    ...lines,
    imbal.length ? `Notable price-level imbalances (≥3:1): ${imbal.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
