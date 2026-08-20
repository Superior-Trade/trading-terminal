"use client";

// Lighter market universe for the market picker — public, keyless zklighter
// REST (same client-only pattern as the Hyperliquid InfoClient: the venue's
// public API is browser-safe and per-IP rate limits favor client fan-out).
//
// Two endpoints cover the whole universe in two requests (mirrors
// apps/api/scripts/lighter_dataset/lt_market_registry.py):
//   GET /api/v1/orderBooks        → authoritative market list (symbol, status)
//   GET /api/v1/orderBookDetails  → live stats (last price, 24h change/volume,
//                                    open interest, margin fractions)
//
// Resilient by contract: any fetch/parse failure resolves to the last good
// list (or an empty one) plus a status flag — nothing ever throws into render.

import { useCallback, useEffect, useRef, useState } from "react";

const LIGHTER_API_BASE = "https://mainnet.zklighter.elliot.ai";
/** Matches the HL metrics cadence in market-picker (gentle, visible-tab only). */
const POLL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface LighterMarket {
  marketId: number;
  /** Base asset symbol as zklighter reports it, e.g. "BTC". */
  base: string;
  /** Display market symbol, e.g. "BTC-PERP" (instrument form minus ".LIGHTER"). */
  symbol: string;
  lastPrice: number | null;
  /** 24h price change, percent (venue-reported; null when absent). */
  chg24hPct: number | null;
  /** 24h quote-token (USDC) volume; 0 when the venue omits it. */
  vol24hUsd: number;
  /** Open interest in USD (base OI × mark/last); 0 when not derivable. */
  oiUsd: number;
  /** Max leverage derived from the venue's initial-margin fraction; null when
   *  the field is absent or its scale is ambiguous — never guessed. */
  maxLeverage: number | null;
}

export type LighterMarketsStatus = "idle" | "loading" | "ready" | "error";

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** default_initial_margin_fraction → max leverage. The venue has used both a
 *  plain fraction (0.02 → 50×) and a 1e4-scaled basis value (200 → 50×);
 *  handle both, and return null for anything outside a sane range rather
 *  than showing a fabricated number. */
function leverageFromImf(imf: number | null): number | null {
  if (imf === null || imf <= 0) return null;
  const lev = imf < 1 ? 1 / imf : imf <= 10_000 ? 10_000 / imf : NaN;
  if (!Number.isFinite(lev)) return null;
  const rounded = Math.round(lev);
  return rounded >= 1 && rounded <= 200 ? rounded : null;
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${LIGHTER_API_BASE}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`lighter ${path} HTTP ${res.status}`);
  return res.json();
}

function parseMarkets(orderBooksPayload: unknown, detailsPayload: unknown): LighterMarket[] {
  const books = (orderBooksPayload as { order_books?: unknown })?.order_books;
  if (!Array.isArray(books)) throw new Error("orderBooks: no market list");
  const detailRows = (detailsPayload as { order_book_details?: unknown })
    ?.order_book_details;
  const details = new Map<number, Record<string, unknown>>();
  if (Array.isArray(detailRows)) {
    for (const row of detailRows) {
      if (row && typeof row === "object") {
        const id = num((row as Record<string, unknown>).market_id);
        if (id !== null) details.set(id, row as Record<string, unknown>);
      }
    }
  }

  const markets: LighterMarket[] = [];
  for (const raw of books) {
    if (!raw || typeof raw !== "object") continue;
    const book = raw as Record<string, unknown>;
    const marketId = num(book.market_id);
    const base = typeof book.symbol === "string" ? book.symbol.trim() : "";
    if (marketId === null || !base) continue;
    // Only tradeable markets; unknown/absent status passes through (the venue
    // has reported both string and numeric status forms).
    const status = book.status;
    if (typeof status === "string" && status.toLowerCase() !== "active") continue;
    const d = details.get(marketId) ?? {};
    const lastPrice = num(d.last_trade_price) ?? num(d.mark_price);
    const oiBase = num(d.open_interest);
    const oiPx = num(d.mark_price) ?? lastPrice;
    markets.push({
      marketId,
      base,
      symbol: `${base}-PERP`,
      lastPrice,
      chg24hPct: num(d.daily_price_change),
      vol24hUsd: num(d.daily_quote_token_volume) ?? 0,
      oiUsd: oiBase !== null && oiPx !== null ? oiBase * oiPx : 0,
      maxLeverage: leverageFromImf(num(d.default_initial_margin_fraction)),
    });
  }
  return markets;
}

/** Fetch + poll the Lighter market universe. `enabled` false (flag off) does
 *  nothing and returns a stable empty list — zero network traffic. */
export function useLighterMarkets(enabled: boolean): {
  markets: LighterMarket[];
  status: LighterMarketsStatus;
} {
  const [markets, setMarkets] = useState<LighterMarket[]>([]);
  const [status, setStatus] = useState<LighterMarketsStatus>("idle");
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setStatus((s) => (hasDataRef.current ? s : "loading"));
      const [books, details] = await Promise.all([
        fetchJson("/api/v1/orderBooks"),
        fetchJson("/api/v1/orderBookDetails"),
      ]);
      const next = parseMarkets(books, details);
      hasDataRef.current = true;
      setMarkets(next);
      setStatus("ready");
    } catch {
      // Keep the last good snapshot when we have one; the status flag lets
      // the picker distinguish "empty universe" from "venue unreachable".
      setStatus("error");
      if (!hasDataRef.current) setMarkets([]);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [enabled, load]);

  return { markets, status };
}
