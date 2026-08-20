"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useHyperliquid,
  coinToPair,
  pairToCoin,
  resolveAsset,
  type AssetMeta,
} from "../../lib/hyperliquid-provider";
import {
  ASSET_CLASSES,
  assetClass,
  CRYPTO_TAGS,
  hasCryptoTag,
  type CryptoTag,
  STOCK_TAGS,
  hasStockTag,
  type StockTag,
} from "../../lib/market-categories";
import {
  assetLabel,
  assetTicker,
  assetRowName,
  assetDescription,
  assetSearchText,
} from "../../lib/asset-directory";
import { usePair } from "./terminal-shell";
import { useLang } from "../../lib/i18n";
import { track } from "../../lib/track";
import {
  VENUES,
  venueOfSymbol,
  stripVenuePrefix,
  toLighterSymbol,
  lighterUiEnabled,
  type Venue,
} from "../../lib/venues";
import {
  useLighterMarkets,
  type LighterMarket,
} from "../../lib/use-lighter-markets";

interface MarketMetrics {
  mid: number | null;
  chg24h: number | null;
  vol24h: number;
  funding: number | null; // hourly rate (perps/hip3 only)
  oi: number;
}

type SortKey = "vol24h" | "chg24h" | "funding" | "oi";
// Spot is intentionally excluded: HL is perps-first — BTC/ETH/etc. exist only
// as perps, and its spot universe is thin, obscure HL-native tokens.
type Tab = "All" | (typeof ASSET_CLASSES)[number];
// Venue filter (flag-gated): "all" mixes venues in one list; a venue narrows
// the rows to that exchange. Rendered only when lighterUiEnabled().
type VenueFilter = "all" | Venue;
// Discriminated row model so HL and Lighter markets sort/filter as one list.
type Row =
  | { kind: "hl"; asset: AssetMeta }
  | { kind: "lighter"; market: LighterMarket };

export function unsubscribeQuietly(
  sub: { unsubscribe?: () => Promise<unknown> } | null | undefined,
): void {
  void sub?.unsubscribe?.().catch(() => {});
}

// ── Warm metrics cache ───────────────────────────────────────────────────
// The full sweep (2 + N-dex REST calls) used to run only when the picker
// OPENED, so the first open always showed a visibly-populating list. The
// sweep now warms once at app start (idle callback — never blocking first
// paint) and refreshes at a gentle 60s cadence while the tab is visible;
// opening the picker renders instantly from that cache. The last snapshot
// also persists to localStorage (10-min cap, stale-while-revalidate) so
// even the very first open after a reload has rows.
const METRICS_CACHE_KEY = "hl-picker-metrics:v1";
const METRICS_CACHE_TTL_MS = 10 * 60 * 1000;
/** Snapshot older than this triggers a re-sweep on open (matches cadence). */
const METRICS_FRESH_MS = 60_000;

function readMetricsCache(): {
  ts: number;
  metrics: Map<string, MarketMetrics>;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(METRICS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      ts?: number;
      entries?: Array<[string, MarketMetrics]>;
    };
    if (!parsed.ts || !Array.isArray(parsed.entries)) return null;
    if (Date.now() - parsed.ts > METRICS_CACHE_TTL_MS) return null;
    return { ts: parsed.ts, metrics: new Map(parsed.entries) };
  } catch {
    return null;
  }
}

function writeMetricsCache(metrics: Map<string, MarketMetrics>): void {
  try {
    window.localStorage.setItem(
      METRICS_CACHE_KEY,
      JSON.stringify({ ts: Date.now(), entries: [...metrics.entries()] }),
    );
  } catch {
    // localStorage may be quota-exceeded or disabled; non-fatal.
  }
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPx(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  return n.toPrecision(4);
}

/** Up/down arrow for the tab title, from the 24h change (▲ up · ▼ down). */
function titleArrow(chg24h: number | null | undefined): string {
  if (chg24h == null) return "";
  return chg24h >= 0 ? " ▲" : " ▼";
}

/** Compact venue selector rendered LEFT of the search input (flag-gated).
 *  Each venue option carries its venue-level fee badge — venue truth only,
 *  never per-pair fee math. */
function VenueDropdown({
  value,
  onChange,
  open,
  setOpen,
}: {
  value: VenueFilter;
  onChange: (v: VenueFilter) => void;
  open: boolean;
  setOpen: (o: boolean | ((o: boolean) => boolean)) => void;
}) {
  const { t } = useLang();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, setOpen]);
  const options: VenueFilter[] = ["all", "hyperliquid", "lighter"];
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={t("venuePicker")}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 font-mono text-[11px] font-bold uppercase tracking-wider text-white/80 transition-colors hover:text-white"
      >
        {value === "all" ? t("venueAll") : VENUES[value].label}
        <span className="text-[8px] text-white/40">▼</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-52 rounded-lg border border-white/[0.12] bg-black/90 p-1 shadow-xl backdrop-blur-md">
          {options.map((v) => (
            <button
              key={v}
              onClick={() => onChange(v)}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-white/[0.08] ${
                v === value ? "text-lime-300" : "text-white/75"
              }`}
            >
              <span className="font-bold uppercase tracking-wider">
                {v === "all" ? t("venueAll") : VENUES[v].label}
              </span>
              {v !== "all" && (
                <span className="shrink-0 rounded bg-white/[0.08] px-1.5 py-0.5 text-[9px] text-white/50">
                  {VENUES[v].feeBadge}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MarketPicker() {
  const { t } = useLang();
  const { pair, setPair } = usePair();
  const { info, subscription, assets, assetsByName, isReady } = useHyperliquid();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("All");
  const [query, setQuery] = useState("");
  // ── Venue layer (everything here is inert while the flag is off) ──────
  const venueUi = lighterUiEnabled();
  const [venueFilter, setVenueFilter] = useState<VenueFilter>("all");
  const [venueMenuOpen, setVenueMenuOpen] = useState(false);
  const lighter = useLighterMarkets(venueUi);
  const [sortKey, setSortKey] = useState<SortKey>("vol24h");
  const [sortDesc, setSortDesc] = useState(true);
  // Seed from the persisted snapshot (SSR-safe: null on the server, and the
  // component renders null while closed, so no hydration mismatch).
  const seeded = useMemo(readMetricsCache, []);
  const [metrics, setMetrics] = useState<Map<string, MarketMetrics>>(
    () => seeded?.metrics ?? new Map(),
  );
  // Epoch ms of the last successful full sweep — gates on-open re-sweeps.
  const metricsAtRef = useRef<number>(seeded?.ts ?? 0);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  const hip3Dexes = useMemo(
    () =>
      [...new Set(assets.filter((a) => a.marketType === "hip3").map((a) => a.dex!))].sort(),
    [assets],
  );

  // ── Live metrics: warmed at app start, 60s background refresh ─────────
  const loadMetrics = useCallback(async () => {
    try {
      const next = new Map<string, MarketMetrics>();
      const readCtx = (
        name: string,
        ctx: {
          midPx?: string | null;
          markPx?: string | null;
          prevDayPx?: string | null;
          dayNtlVlm?: string | null;
          funding?: string | null;
          openInterest?: string | null;
        },
        isPerp: boolean,
        markForOi?: number | null,
      ) => {
        const mid = ctx.midPx != null ? parseFloat(ctx.midPx) : ctx.markPx != null ? parseFloat(ctx.markPx) : null;
        const prev = ctx.prevDayPx != null ? parseFloat(ctx.prevDayPx) : null;
        next.set(name, {
          mid,
          chg24h: mid !== null && prev ? ((mid - prev) / prev) * 100 : null,
          vol24h: ctx.dayNtlVlm != null ? parseFloat(ctx.dayNtlVlm) : 0,
          funding: isPerp && ctx.funding != null ? parseFloat(ctx.funding) : null,
          oi:
            ctx.openInterest != null
              ? parseFloat(ctx.openInterest) * (markForOi ?? mid ?? 0)
              : 0,
        });
      };

      const [mainResp, spotResp, ...dexResps] = await Promise.all([
        info.metaAndAssetCtxs(),
        info.spotMetaAndAssetCtxs(),
        ...hip3Dexes.map((d) => info.metaAndAssetCtxs({ dex: d })),
      ]);

      const [mainMeta, mainCtxs] = mainResp;
      mainMeta.universe.forEach((u, i) => {
        if (mainCtxs[i]) readCtx(u.name, mainCtxs[i], true);
      });
      hip3Dexes.forEach((_, di) => {
        const [dm, dc] = dexResps[di];
        dm.universe.forEach((u, i) => {
          if (dc[i]) readCtx(u.name, dc[i], true);
        });
      });
      // Spot ctxs carry their coin id; assets map via apiCoin ?? name.
      const [, spotCtxs] = spotResp;
      const spotByCoin = new Map(spotCtxs.map((c) => [c.coin, c]));
      for (const a of assets) {
        if (a.marketType !== "spot") continue;
        const ctx = spotByCoin.get(a.apiCoin ?? a.name);
        if (ctx) readCtx(a.name, ctx, false);
      }
      setMetrics(next);
      metricsAtRef.current = Date.now();
      writeMetricsCache(next);
    } catch {
      /* metrics are cosmetic; rows render without them */
    }
  }, [info, assets, hip3Dexes]);

  // Warm ONCE at app start (idle callback so first paint is never blocked),
  // then refresh at a gentle 60s cadence while the tab is visible. Pure REST
  // against the existing InfoClient — no new WebSocket subscriptions, and no
  // per-open refetch storm: opening the picker reads this warm cache.
  useEffect(() => {
    if (!isReady) return;
    const warm = () => {
      if (Date.now() - metricsAtRef.current > METRICS_FRESH_MS)
        void loadMetrics();
    };
    let idleId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(warm, { timeout: 3000 });
    } else {
      timeoutId = setTimeout(warm, 300);
    }
    // Pause the full sweep while our tab is hidden (user on the HL site).
    const t = setInterval(() => {
      if (!document.hidden) void loadMetrics();
    }, 60_000);
    return () => {
      if (idleId !== null && typeof window.cancelIdleCallback === "function")
        window.cancelIdleCallback(idleId);
      if (timeoutId !== null) clearTimeout(timeoutId);
      clearInterval(t);
    };
  }, [isReady, loadMetrics]);

  useEffect(() => {
    if (!open) return;
    // The cache is kept warm by the background cadence — only re-sweep on
    // open when the snapshot is stale (e.g. the tab sat hidden past the
    // refresh window). Fresh data renders instantly with zero fetches.
    if (Date.now() - metricsAtRef.current > METRICS_FRESH_MS)
      void loadMetrics();
    // Focus search on open for keyboard-first flow.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, loadMetrics]);

  // The pill shows live price + 24h% even while CLOSED — a lightweight
  // poll for just the current pair's source (1 REST call vs the full
  // 11-call sweep the open panel uses).
  const pollCurrent = useCallback(async () => {
    // Case-insensitive resolve: TradingView uppercases symbols ("XYZ:SPCX")
    // while HIP-3 canonical names are lowercase-prefixed ("xyz:SPCX") — an
    // exact map hit misses whenever the pair state came from a chart echo.
    const coin = pairToCoin(pair);
    const a = resolveAsset(assetsByName, coin);
    if (!a) return;
    try {
      let name = a.name;
      let ctx:
        | { midPx?: string | null; markPx?: string | null; prevDayPx?: string | null; dayNtlVlm?: string | null; funding?: string | null; openInterest?: string | null }
        | undefined;
      let isPerp = true;
      if (a.marketType === "spot") {
        isPerp = false;
        const [, ctxs] = await info.spotMetaAndAssetCtxs();
        ctx = ctxs.find((c) => c.coin === (a.apiCoin ?? a.name));
      } else {
        const [meta, ctxs] = await info.metaAndAssetCtxs(
          a.dex ? { dex: a.dex } : undefined,
        );
        const i = meta.universe.findIndex((u) => u.name === a.name);
        if (i >= 0) ctx = ctxs[i];
        name = a.name;
      }
      if (!ctx) return;
      const mid = ctx.midPx != null ? parseFloat(ctx.midPx) : ctx.markPx != null ? parseFloat(ctx.markPx) : null;
      const prev = ctx.prevDayPx != null ? parseFloat(ctx.prevDayPx) : null;
      setMetrics((prevMap) => {
        const next = new Map(prevMap);
        next.set(name, {
          mid,
          chg24h: mid !== null && prev ? ((mid - prev) / prev) * 100 : null,
          vol24h: ctx!.dayNtlVlm != null ? parseFloat(ctx!.dayNtlVlm) : 0,
          funding: isPerp && ctx!.funding != null ? parseFloat(ctx!.funding) : null,
          oi: ctx!.openInterest != null ? parseFloat(ctx!.openInterest) * (mid ?? 0) : 0,
        });
        return next;
      });
    } catch {
      /* pill just shows the pair name until the next poll */
    }
  }, [assetsByName, pair, info]);

  useEffect(() => {
    if (!isReady) return;
    void pollCurrent();
    const t = setInterval(() => {
      if (!open && !document.hidden) void pollCurrent();
    }, 15_000);
    return () => clearInterval(t);
  }, [isReady, open, pollCurrent]);

  // Asset-class tabs (venue-agnostic: HIP-3 dexes mix stocks/indices/
  // commodities/crypto, so dex tabs told a trader nothing). Dex shows as a
  // row badge instead. Crypto and Stocks each expose a thematic chip row.
  const tabs: Tab[] = useMemo(() => ["All", ...ASSET_CLASSES], []);
  // Shared across the composite tabs — only one tab is active at a time, so
  // one selection suffices (reset to null whenever the tab changes).
  const [subTag, setSubTag] = useState<string | null>(null);
  const [hideLowVol, setHideLowVol] = useState(true);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toUpperCase();
    const out: Row[] = [];
    // HL rows: untouched behavior — and the ONLY branch while the flag is off.
    if (!venueUi || venueFilter !== "lighter") {
      for (const a of assets) {
        // Match code, display ticker, and full name so "bitcoin"/"nasdaq"/
        // "tesla" resolve, not just the raw symbol.
        if (q && !assetSearchText(a.name).toUpperCase().includes(q)) continue;
        // Low-volume filter (<$100k/24h) — only once metrics have loaded,
        // otherwise every row would vanish while the sweep is in flight.
        if (hideLowVol && metrics.size > 0 && (metrics.get(a.name)?.vol24h ?? 0) < 100_000)
          continue;
        if (a.marketType === "spot") continue; // spot excluded (see Tab)
        if (tab !== "All") {
          if (assetClass(a.name, a.dex) !== tab) continue;
          if (tab === "Crypto" && subTag && !hasCryptoTag(a.name, subTag as CryptoTag)) continue;
          if (tab === "Stocks" && subTag && !hasStockTag(a.name, subTag as StockTag)) continue;
        }
        out.push({ kind: "hl", asset: a });
      }
    }
    // Lighter rows (flag-gated): the venue lists crypto perps only, so they
    // appear under All and Crypto (thematic chips reuse the base-symbol tags).
    if (venueUi && venueFilter !== "hyperliquid") {
      for (const m of lighter.markets) {
        if (q && !`${m.symbol} ${m.base}`.toUpperCase().includes(q)) continue;
        if (hideLowVol && m.vol24hUsd < 100_000) continue;
        if (tab !== "All") {
          if (tab !== "Crypto") continue;
          if (subTag && !hasCryptoTag(m.base, subTag as CryptoTag)) continue;
        }
        out.push({ kind: "lighter", market: m });
      }
    }
    // One sort across venues. Lighter has no funding feed in this build —
    // its rows carry null there and sink rather than showing invented data.
    const metric = (r: Row): number | null => {
      if (r.kind === "hl")
        return metrics.get(r.asset.name)?.[sortKey] ?? (sortKey === "vol24h" ? 0 : null);
      const m = r.market;
      return sortKey === "vol24h"
        ? m.vol24hUsd
        : sortKey === "chg24h"
          ? m.chg24hPct
          : sortKey === "oi"
            ? m.oiUsd > 0
              ? m.oiUsd
              : null
            : null;
    };
    return out.sort((a, b) => {
      const va = metric(a);
      const vb = metric(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // metric-less rows sink regardless of direction
      if (vb === null) return -1;
      return (vb - va) * (sortDesc ? 1 : -1);
    });
  }, [assets, query, tab, subTag, hideLowVol, metrics, sortKey, sortDesc, venueUi, venueFilter, lighter.markets]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDesc((d) => !d);
    else {
      setSortKey(k);
      setSortDesc(true);
    }
  };

  const pick = (a: AssetMeta) => {
    setPair(coinToPair(a.name));
    track("pair_changed", { pair: a.name });
    // Dropdown stays open after selection: the user can read the asset
    // description (rendered under the now-active row) and keep browsing.
    // Only click-outside / Escape / the trigger closes it.
  };

  // Lighter selection rides the SAME pair-selection path, carrying the
  // "LIGHTER:" prefix so the chart datafeed router dispatches by venue.
  const pickLighter = (m: LighterMarket) => {
    const lighterPair = toLighterSymbol(m.symbol);
    setPair(lighterPair);
    track("pair_changed", { pair: lighterPair, venue: "lighter" });
  };

  // Venue of the CURRENT pair + its Lighter market row (when applicable) —
  // both resolve to HL/undefined while the flag is off, keeping every
  // downstream branch inert.
  const pairVenue: Venue = venueUi ? venueOfSymbol(pair) : "hyperliquid";
  const lighterCur =
    pairVenue === "lighter"
      ? lighter.markets.find(
          (m) => toLighterSymbol(m.symbol).toLowerCase() === pair.toLowerCase(),
        )
      : undefined;

  // Metrics are keyed by canonical asset name; resolve the pair case-
  // insensitively (chart echoes uppercase HIP-3 symbols).
  const current = (() => {
    const coin = pairToCoin(pair);
    const hit = metrics.get(coin);
    if (hit) return hit;
    const lower = coin.toLowerCase();
    for (const [k, v] of metrics) if (k.toLowerCase() === lower) return v;
    return undefined;
  })();

  // Live tab title: "64,233.4 ▲ BTC | Trading Terminal" — glanceable price +
  // a 24h-direction arrow. The base value + arrow come from the 15s poll (also
  // the fallback for coins the WS below doesn't push); the allMids WS updates
  // the price per-tick so the tab tracks the chart instead of lagging 15s.
  const chg24hRef = useRef<number | null>(null);
  chg24hRef.current = current?.chg24h ?? null;

  useEffect(() => {
    if (typeof document === "undefined") return;
    // Lighter pairs: show the market symbol without the routing prefix, and
    // price from the zklighter snapshot (no HL metrics exist for them).
    const coin =
      pairVenue === "lighter" ? stripVenuePrefix(pair) : pairToCoin(pair);
    const mid =
      pairVenue === "lighter" ? (lighterCur?.lastPrice ?? null) : (current?.mid ?? null);
    const chg =
      pairVenue === "lighter" ? (lighterCur?.chg24hPct ?? null) : (current?.chg24h ?? null);
    document.title =
      mid != null
        ? `${fmtPx(mid)}${titleArrow(chg)} ${coin} | Trading Terminal`
        : `${coin} | Trading Terminal`;
  }, [current?.mid, current?.chg24h, pair, pairVenue, lighterCur?.lastPrice, lighterCur?.chg24hPct]);

  // Per-tick live price from the shared allMids WS (one subscription covers
  // every coin), so the tab title tracks the market in real time.
  useEffect(() => {
    if (typeof document === "undefined") return;
    let cancelled = false;
    let sub: { unsubscribe: () => Promise<void> } | undefined;
    void (async () => {
      try {
        sub = await subscription.allMids((data) => {
          if (cancelled) return;
          const coin = pairToCoin(pair);
          const raw = (data as { mids?: Record<string, string> })?.mids?.[coin];
          const mid = raw != null ? parseFloat(raw) : NaN;
          if (!Number.isFinite(mid)) return;
          document.title = `${fmtPx(mid)}${titleArrow(chg24hRef.current)} ${coin} | Trading Terminal`;
        });
      } catch {
        /* WS unavailable → the 15s poll effect keeps the title current */
      }
    })();
    return () => {
      cancelled = true;
      unsubscribeQuietly(sub);
    };
  }, [pair, subscription]);

  // The visible trigger lives in the TRADINGVIEW TOOLBAR (trading-chart
  // creates a header button before the timeframes). It dispatches
  // "cg:open-market-picker" with screen coords; the panel renders fixed
  // there. Metrics flow the other way via "cg:pair-metrics".
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ x?: number; y?: number }>).detail;
      setAnchor({ x: d?.x ?? 16, y: d?.y ?? 96 });
      setOpen((o) => !o);
    };
    window.addEventListener("cg:open-market-picker", onOpen);
    return () => window.removeEventListener("cg:open-market-picker", onOpen);
  }, []);
  const coinName = pairToCoin(pair);
  const assetMeta = resolveAsset(assetsByName, coinName);
  const lastMetricsRef = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    const detail =
      pairVenue === "lighter"
        ? {
            pair,
            // Venue-qualified label so the toolbar pill never reads as an
            // HL market ("BTC-PERP · Lighter").
            label: `${stripVenuePrefix(pair)} · ${VENUES.lighter.label}`,
            chg:
              lighterCur?.chg24hPct != null
                ? `${lighterCur.chg24hPct >= 0 ? "+" : ""}${lighterCur.chg24hPct.toFixed(2)}%`
                : "",
            up: (lighterCur?.chg24hPct ?? 0) >= 0,
            lev: lighterCur?.maxLeverage ? `${lighterCur.maxLeverage}×` : "",
            levTip: t("maxLevTipDesc"),
            // No Lighter funding feed in this build — empty, never invented.
            funding: "",
            fundingUp: true,
            fundingTip: t("fundingTipDesc"),
          }
        : {
            pair,
            // "SKHX | SK Hynix" when the directory has a full name, else the bare
            // ticker — computed here so the TV-toolbar pill shares one source.
            label: assetLabel(coinName),
            chg:
              current?.chg24h != null
                ? `${current.chg24h >= 0 ? "+" : ""}${current.chg24h.toFixed(2)}%`
                : "",
            up: (current?.chg24h ?? 0) >= 0,
            lev: assetMeta?.maxLeverage ? `${assetMeta.maxLeverage}×` : "",
            levTip: t("maxLevTipDesc"),
            funding: current?.funding != null ? `${(current.funding * 100).toFixed(4)}%` : "",
            fundingUp: (current?.funding ?? 0) >= 0,
            fundingTip: t("fundingTipDesc"),
          };
    lastMetricsRef.current = detail;
    window.dispatchEvent(new CustomEvent("cg:pair-metrics", { detail }));
  }, [pair, current?.chg24h, current?.funding, assetMeta?.maxLeverage, t, pairVenue, lighterCur?.chg24hPct, lighterCur?.maxLeverage]);
  // The TV toolbar button attaches its listener AFTER the chart boots —
  // replay the latest snapshot when it asks.
  useEffect(() => {
    const onRequest = () => {
      if (lastMetricsRef.current)
        window.dispatchEvent(
          new CustomEvent("cg:pair-metrics", { detail: lastMetricsRef.current }),
        );
    };
    window.addEventListener("cg:request-pair-metrics", onRequest);
    return () => window.removeEventListener("cg:request-pair-metrics", onRequest);
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 50);
    else setVenueMenuOpen(false); // don't reopen with a stale inner menu
  }, [open]);

  // On open, bring the currently-selected pair into view (centered) so it
  // isn't lost off-screen in the long list. Scroll once immediately and once
  // after ~350ms, since the metrics sweep re-sorts the list on open.
  useEffect(() => {
    if (!open) return;
    const scroll = () =>
      activeRowRef.current?.scrollIntoView({ block: "center" });
    const r = requestAnimationFrame(scroll);
    const t = setTimeout(scroll, 350);
    return () => {
      cancelAnimationFrame(r);
      clearTimeout(t);
    };
  }, [open]);

  if (!open || !anchor) return null;
  const panelLeft = Math.max(8, Math.min(anchor.x, (typeof window !== "undefined" ? window.innerWidth : 1400) - 796));
  // Portaled to <body>: ancestors with backdrop-filter become containing
  // blocks for position:fixed and would trap/squeeze the panel.
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      {/* Positioning wrapper separate from the glass: liquid-glass forces
          position:relative, so it must not carry the fixed placement. */}
      <div
        className="fixed z-50 w-[780px] max-w-[calc(100vw-2rem)]"
        style={{ left: panelLeft, top: anchor.y }}
      >
      <div
        className="liquid-glass rounded-xl shadow-2xl"
        style={{
          background: "var(--menu-fill)",
          backdropFilter: "blur(28px)",
          WebkitBackdropFilter: "blur(28px)",
        }}
      >
      <div className="p-3">
        {venueUi ? (
          // Venue dropdown LEFT of the search input — only exists behind the
          // flag; flag off renders the exact single-input markup below.
          <div className="flex items-center gap-2">
            <VenueDropdown
              value={venueFilter}
              onChange={(v) => {
                setVenueFilter(v);
                setVenueMenuOpen(false);
              }}
              open={venueMenuOpen}
              setOpen={setVenueMenuOpen}
            />
            <div className="min-w-0 flex-1">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("mktSearch")}
                className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2.5 font-mono text-[13px] text-white placeholder-white/30 outline-none"
              />
            </div>
          </div>
        ) : (
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("mktSearch")}
            className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2.5 font-mono text-[13px] text-white placeholder-white/30 outline-none"
          />
        )}
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          {tabs.map((tb) => {
            const label =
              tb === "All"
                ? t("tabAll")
                : tb === "Crypto"
                  ? t("tabCrypto")
                  : tb === "Stocks"
                    ? t("tabStocks")
                    : tb === "Indices"
                      ? t("tabIndices")
                      : tb === "Commodities"
                        ? t("tabCommodities")
                        : t("tabFx");
            // Crypto and Stocks are COMPOSITE badges: main pill + a thematic
            // chip row, e.g. [CRYPTO (Majors)(Meme)(AI)] / [STOCKS (Tech)(Semis)
            // (AI)(Crypto)(EV)]. Chips render only while that tab is active;
            // no chip selected = the whole class.
            const composite =
              tb === "Crypto"
                ? {
                    tags: CRYPTO_TAGS as readonly string[],
                    tagLabel: (tg: string) =>
                      tg === "Majors" ? t("tagMajors") : tg === "Meme" ? t("tagMeme") : t("tagAI"),
                  }
                : tb === "Stocks"
                  ? {
                      tags: STOCK_TAGS as readonly string[],
                      tagLabel: (tg: string) =>
                        tg === "Tech"
                          ? t("tagTech")
                          : tg === "Semis"
                            ? t("tagSemis")
                            : tg === "AI"
                              ? t("tagAI")
                              : tg === "Crypto"
                                ? t("tagCryptoStk")
                                : t("tagEV"),
                    }
                  : null;
            if (composite) {
              const on = tab === tb;
              return (
                <div
                  key={tb}
                  className={`flex items-center gap-1 rounded-full transition-colors ${
                    on ? "bg-lime-400 py-0.5 pl-1 pr-1" : "bg-white/[0.06] hover:bg-white/[0.10]"
                  }`}
                >
                  <button
                    onClick={() => {
                      setTab(tb);
                      setSubTag(null);
                    }}
                    className={`rounded-full font-mono text-[11px] font-bold uppercase tracking-wider ${
                      on
                        ? `px-2 py-0.5 ${subTag ? "text-black/50 hover:text-black" : "text-black"}`
                        : "px-3 py-1 text-white/55 hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                  {on &&
                    composite.tags.map((tg) => {
                      const active = subTag === tg;
                      return (
                        <button
                          key={tg}
                          onClick={() => setSubTag((c) => (c === tg ? null : tg))}
                          className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors ${
                            active
                              ? "bg-black text-lime-300"
                              : "bg-black/15 text-black/65 hover:bg-black/25 hover:text-black"
                          }`}
                        >
                          {composite.tagLabel(tg)}
                        </button>
                      );
                    })}
                </div>
              );
            }
            return (
              <button
                key={tb}
                onClick={() => {
                  setTab(tb);
                  setSubTag(null);
                }}
                className={`rounded-full px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wider transition-colors ${
                  tab === tb
                    ? "bg-lime-400 text-black"
                    : "bg-white/[0.06] text-white/55 hover:bg-white/[0.10] hover:text-white"
                }`}
              >
                {label}
              </button>
            );
          })}
          <label className="ml-auto flex cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-white/50 hover:text-white/80">
            <input
              type="checkbox"
              checked={hideLowVol}
              onChange={(e) => setHideLowVol(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-lime-400"
            />
            {t("hideLowVol")}
          </label>
        </div>
        {/* Column set mirrors Hyperliquid's market selector. */}
        <div className="mt-4 flex items-center gap-4 border-b border-white/[0.07] px-2.5 pb-2.5 font-mono text-[10px] uppercase tracking-wider text-white/40">
          <span className="flex-1">{t("colMarket")}</span>
          <span className="w-24 text-right">{t("colLastPrice")}</span>
          <button onClick={() => toggleSort("chg24h")} className={`w-20 text-right hover:text-white ${sortKey === "chg24h" ? "text-lime-300" : ""}`}>
            {t("colChg24h")}
          </button>
          <button onClick={() => toggleSort("funding")} className={`w-20 text-right hover:text-white ${sortKey === "funding" ? "text-lime-300" : ""}`}>
            {t("colFunding")}
          </button>
          <button onClick={() => toggleSort("vol24h")} className={`w-24 text-right hover:text-white ${sortKey === "vol24h" ? "text-lime-300" : ""}`}>
            {t("colVolume")}
          </button>
          <button onClick={() => toggleSort("oi")} className={`w-24 text-right hover:text-white ${sortKey === "oi" ? "text-lime-300" : ""}`}>
            {t("colOpenInt")}
          </button>
        </div>
        <div className="mt-1 max-h-[50vh] overflow-y-auto">
          {rows.map((row) => {
            // ── Lighter rows (only ever present behind the flag) ─────────
            if (row.kind === "lighter") {
              const lm = row.market;
              const lighterPair = toLighterSymbol(lm.symbol);
              const lActive = lighterPair.toLowerCase() === pair.toLowerCase();
              return (
                <div
                  key={`lighter:${lm.marketId}`}
                  ref={lActive ? activeRowRef : undefined}
                >
                  <button
                    onClick={() => pickLighter(lm)}
                    className={`flex w-full items-center gap-4 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.07] ${
                      lActive ? "bg-lime-400/10" : ""
                    }`}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="shrink-0 font-mono text-[13px] font-bold text-white">
                        {lm.symbol}
                      </span>
                      {/* Venue tag only in the mixed "All" view — HL rows stay
                          untagged as the default venue. */}
                      {venueFilter === "all" && (
                        <span className="shrink-0 rounded bg-sky-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-sky-300/80">
                          {VENUES.lighter.label}
                        </span>
                      )}
                      {lm.maxLeverage != null && (
                        <span className="shrink-0 font-mono text-[10px] text-white/35">
                          {lm.maxLeverage}×
                        </span>
                      )}
                    </span>
                    <span className="w-24 text-right font-mono text-[12.5px] tabular-nums text-white/90">
                      {fmtPx(lm.lastPrice)}
                    </span>
                    <span
                      className={`w-20 text-right font-mono text-[12px] tabular-nums ${
                        lm.chg24hPct == null
                          ? "text-white/30"
                          : lm.chg24hPct >= 0
                            ? "text-lime-400"
                            : "text-red-400"
                      }`}
                    >
                      {lm.chg24hPct == null
                        ? "—"
                        : `${lm.chg24hPct >= 0 ? "+" : ""}${lm.chg24hPct.toFixed(2)}%`}
                    </span>
                    {/* Funding: no Lighter feed in this build — dash, never a
                        fabricated number. */}
                    <span className="w-20 text-right font-mono text-[11px] tabular-nums text-white/25">
                      —
                    </span>
                    <span className="w-24 text-right font-mono text-[12px] tabular-nums text-white/70">
                      {lm.vol24hUsd > 0 ? fmtUsd(lm.vol24hUsd) : "—"}
                    </span>
                    <span className="w-24 text-right font-mono text-[12px] tabular-nums text-white/70">
                      {lm.oiUsd > 0 ? fmtUsd(lm.oiUsd) : "—"}
                    </span>
                  </button>
                </div>
              );
            }
            // ── Hyperliquid rows (unchanged) ─────────────────────────────
            const a = row.asset;
            const m = metrics.get(a.name);
            // Case-insensitive: a deep-linked / chart-echoed pair arrives
            // uppercased ("XYZ:SKHX") while canonical names are lowercase-
            // prefixed ("xyz:SKHX") — an exact compare misses the match.
            const active = coinToPair(a.name).toLowerCase() === pair.toLowerCase();
            const ticker = assetTicker(a.name);
            const full = assetRowName(a.name);
            // Description shows only under the ACTIVE row (the pair the
            // chart is currently on) — keeps the list scannable.
            const desc = active ? assetDescription(a.name) : undefined;
            return (
              <div
                key={`${a.marketType}:${a.name}`}
                ref={active ? activeRowRef : undefined}
              >
                <button
                  onClick={() => pick(a)}
                  className={`flex w-full items-center gap-4 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.07] ${
                    active ? "bg-lime-400/10" : ""
                  }`}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {/* Ticker stays pinned; only the full name truncates. */}
                    <span className="shrink-0 font-mono text-[13px] font-bold text-white">{ticker}</span>
                    {full && (
                      <span className="truncate font-sans text-[11.5px] text-white/45">{full}</span>
                    )}
                    {a.marketType === "spot" && (
                      <span className="shrink-0 rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[9px] uppercase text-white/50">spot</span>
                    )}
                    {a.marketType === "hip3" && (
                      <span className="shrink-0 rounded bg-lime-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-lime-300/80">{a.dex}</span>
                    )}
                    {a.marketType !== "spot" && (
                      <span className="shrink-0 font-mono text-[10px] text-white/35">{a.maxLeverage}×</span>
                    )}
                  </span>
                  <span className="w-24 text-right font-mono text-[12.5px] tabular-nums text-white/90">
                    {fmtPx(m?.mid ?? null)}
                  </span>
                  <span
                    className={`w-20 text-right font-mono text-[12px] tabular-nums ${
                      m?.chg24h == null ? "text-white/30" : m.chg24h >= 0 ? "text-lime-400" : "text-red-400"
                    }`}
                  >
                    {m?.chg24h == null ? "—" : `${m.chg24h >= 0 ? "+" : ""}${m.chg24h.toFixed(2)}%`}
                  </span>
                  <span
                    className={`w-20 text-right font-mono text-[11px] tabular-nums ${
                      m?.funding == null ? "text-white/25" : m.funding >= 0 ? "text-lime-400/80" : "text-red-400/80"
                    }`}
                  >
                    {m?.funding == null ? "—" : `${(m.funding * 100).toFixed(4)}%`}
                  </span>
                  <span className="w-24 text-right font-mono text-[12px] tabular-nums text-white/70">
                    {m ? fmtUsd(m.vol24h) : "—"}
                  </span>
                  <span className="w-24 text-right font-mono text-[12px] tabular-nums text-white/70">
                    {m && m.oi > 0 ? fmtUsd(m.oi) : "—"}
                  </span>
                </button>
                {desc && (
                  <div className="mb-1 ml-2.5 mr-2.5 rounded-lg bg-white/[0.03] px-3 py-2 font-sans text-[11.5px] leading-relaxed text-white/55">
                    {desc}
                  </div>
                )}
              </div>
            );
          })}
          {!rows.length && (
            <div className="px-2 py-6 text-center font-mono text-[11px] text-white/35">
              {venueUi && venueFilter === "lighter" && lighter.status === "error"
                ? t("lighterMktsUnavailable")
                : t("noMarkets")}
            </div>
          )}
        </div>
      </div>
      </div>
      </div>
    </>,
    document.body,
  );
}
