import type { UTCTimestamp } from "lightweight-charts";
import { RESOLUTION_TO_HL, RESOLUTION_TO_MS } from "./hyperliquid-datafeed";
import { pairToCoin } from "../../lib/hyperliquid-provider";
import { stripVenuePrefix, venueOfSymbol } from "../../lib/venues";

/**
 * Candle data for the preview chart, venue-routed.
 *
 * The Advanced Charts path streams through the venue datafeed router
 * (HyperliquidDatafeed / LighterDatafeed dispatched on the "LIGHTER:"
 * prefix). The preview keeps its simpler poll-based model but must chart
 * the SAME pairs the market picker offers — so this module mirrors the
 * router's dispatch: bare pairs hit Hyperliquid's public info endpoint,
 * "LIGHTER:*" pairs hit the public zklighter REST API.
 *
 * Parsing is split out pure so it is testable without a network.
 */

export type PreviewCandle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
};

/** How many bars one load asks for — matches the old preview behavior. */
const PREVIEW_BARS = 500;

const LIGHTER_REST_URL = "https://mainnet.zklighter.elliot.ai";

/* zklighter serves a narrower resolution set than Hyperliquid (verified in
 * lighter-datafeed.ts) — anything it can't serve falls back to 4h, the same
 * fallback the HL path uses for unknown resolutions. */
export const RESOLUTION_TO_LIGHTER: Record<string, string> = {
  "1": "1m", "5": "5m", "15": "15m", "30": "30m",
  "60": "1h", "240": "4h", "720": "12h", "1D": "1d",
};

/** Hyperliquid candleSnapshot rows (strings) → preview candles. */
export function parseHlCandles(
  raw: Array<{ t: number; o: string; h: string; l: string; c: string }>,
): PreviewCandle[] {
  return raw.map((c) => ({
    time: Math.floor(c.t / 1000) as UTCTimestamp,
    open: Number(c.o),
    high: Number(c.h),
    low: Number(c.l),
    close: Number(c.c),
  }));
}

/** zklighter /api/v1/candles payload ({ c: [{t(ms),o,h,l,c}] }, numbers) →
 *  preview candles, ascending and de-duplicated by bar time. */
export function parseLighterCandles(payload: unknown): PreviewCandle[] {
  const rows = (payload as { c?: unknown })?.c;
  if (!Array.isArray(rows)) return [];
  const byTime = new Map<number, PreviewCandle>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const c = row as { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown };
    if (
      typeof c.t !== "number" ||
      typeof c.o !== "number" ||
      typeof c.h !== "number" ||
      typeof c.l !== "number" ||
      typeof c.c !== "number"
    )
      continue;
    const time = Math.floor(c.t / 1000);
    byTime.set(time, {
      time: time as UTCTimestamp,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    });
  }
  return [...byTime.values()].sort((a, b) => Number(a.time) - Number(b.time));
}

/** "LIGHTER:BTC-PERP" / "BTC-PERP" / "BTC" → candidate zklighter market keys
 *  (market symbols are bare, e.g. "BTC" — same logic as LighterDatafeed). */
export function lighterMarketKeyCandidates(symbol: string): string[] {
  const bare = stripVenuePrefix(symbol.trim()).toUpperCase();
  const candidates = [bare];
  const stripped = bare.replace(/(-PERP|-USD|\/USD)$/, "");
  if (stripped && stripped !== bare) candidates.push(stripped);
  return candidates;
}

/** orderBookDetails payload → the market id for a picker symbol, or null. */
export function pickLighterMarketId(payload: unknown, symbol: string): number | null {
  const rows = (payload as { order_book_details?: unknown })?.order_book_details;
  if (!Array.isArray(rows)) return null;
  const byKey = new Map<string, number>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { symbol?: unknown; market_id?: unknown; status?: unknown };
    if (typeof r.symbol !== "string" || typeof r.market_id !== "number") continue;
    if (typeof r.status === "string" && r.status.toLowerCase() !== "active") continue;
    byKey.set(r.symbol.toUpperCase(), r.market_id);
  }
  for (const key of lighterMarketKeyCandidates(symbol)) {
    const id = byKey.get(key);
    if (id !== undefined) return id;
  }
  return null;
}

// Cached market list — one fetch per session, dropped on failure so a
// transient error retries on the next load instead of poisoning the chart.
let lighterMarketsPromise: Promise<unknown> | null = null;

function loadLighterMarkets(): Promise<unknown> {
  if (!lighterMarketsPromise) {
    lighterMarketsPromise = fetch(`${LIGHTER_REST_URL}/api/v1/orderBookDetails`)
      .then((r) => {
        if (!r.ok) throw new Error(`Lighter markets ${r.status}`);
        return r.json() as Promise<unknown>;
      })
      .catch((err: unknown) => {
        lighterMarketsPromise = null;
        throw err;
      });
  }
  return lighterMarketsPromise;
}

async function fetchLighterCandles(
  symbol: string,
  resolution: string,
): Promise<PreviewCandle[]> {
  const markets = await loadLighterMarkets();
  const marketId = pickLighterMarketId(markets, symbol);
  if (marketId === null) throw new Error(`unknown Lighter market: ${symbol}`);
  const interval = RESOLUTION_TO_LIGHTER[resolution] ?? "4h";
  const ms = RESOLUTION_TO_MS[resolution] ?? 14_400_000;
  const end = Math.floor(Date.now() / 1000);
  const start = end - Math.floor((ms * PREVIEW_BARS) / 1000);
  const res = await fetch(
    `${LIGHTER_REST_URL}/api/v1/candles?market_id=${marketId}` +
      `&resolution=${interval}&start_timestamp=${start}` +
      `&end_timestamp=${end}&count_back=${PREVIEW_BARS}`,
  );
  if (!res.ok) throw new Error(`candles ${res.status}`);
  return parseLighterCandles(await res.json());
}

async function fetchHlCandles(
  symbol: string,
  resolution: string,
): Promise<PreviewCandle[]> {
  const coin = pairToCoin(symbol);
  const interval = RESOLUTION_TO_HL[resolution] ?? "4h";
  const ms = RESOLUTION_TO_MS[resolution] ?? 14_400_000;
  const endTime = Date.now();
  const startTime = endTime - ms * PREVIEW_BARS;
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin, interval, startTime, endTime },
    }),
  });
  if (!res.ok) throw new Error(`candles ${res.status}`);
  const raw = (await res.json()) as Array<{
    t: number; o: string; h: string; l: string; c: string;
  }>;
  return parseHlCandles(raw);
}

/** Candle history for any pair the market picker can select, routed by the
 *  same venue convention the Advanced datafeed router dispatches on. */
export function fetchPreviewCandles(
  symbol: string,
  resolution: string,
): Promise<PreviewCandle[]> {
  return venueOfSymbol(symbol) === "lighter"
    ? fetchLighterCandles(symbol, resolution)
    : fetchHlCandles(symbol, resolution);
}
