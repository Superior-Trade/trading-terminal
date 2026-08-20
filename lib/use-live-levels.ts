"use client";

// Live-recomputed entry/stop/target values for the setup CARDS, so an
// indicator-based level's number tracks its chart line instead of showing the
// frozen plan-time snapshot. The chart can do this because it holds the candle
// series; the cards don't, so this hook fetches candles per plan symbol
// (candleSnapshot is REST — no websocket) on a light interval and runs the same
// computeLevel() the chart uses. Works for ANY plan, on-screen or not.

import { useEffect, useMemo, useState } from "react";
import {
  useHyperliquid,
  resolveAsset,
  type AssetMeta,
} from "./hyperliquid-provider";
import { parseLevelSource, computeLevel, type OHLCV } from "./indicators";

/** Resolve a plan symbol to the HL candle coin, matching the chart datafeed's
 *  symbolToCoin: try the full name (keeps spot "PURR/USDC" intact), then strip
 *  a leading "Exchange:" prefix, then fall back to the base token before "/" or
 *  "-". A naive pairToCoin() left slash-form pairs like "HYPE/USD" unresolved
 *  (they contain "/", so it returned them whole and no asset "HYPE/USD" exists),
 *  which silently dropped those plans from live-tracking. */
function resolveCoin(
  symbol: string | null | undefined,
  assetsByName: Map<string, AssetMeta>,
): string | null {
  const s = (symbol ?? "").trim();
  if (!s) return null;
  const noPrefix = s.replace(/^[^:]+:/, "");
  const base = noPrefix.replace(/\/.*$/, "").replace(/-.*$/, "").trim();
  for (const candidate of [s, noPrefix, base]) {
    if (!candidate) continue;
    const asset = resolveAsset(assetsByName, candidate);
    if (asset) return asset.apiCoin ?? asset.name;
  }
  return null;
}

export interface LiveLevels {
  entry?: number;
  stop?: number;
  target?: number;
}

export interface LiveLevelPlan {
  /** Stable key the caller looks the result up by (deployment id / plan id). */
  key: string;
  symbol?: string | null;
  timeframe?: string | null;
  entrySource?: string | null;
  stopSource?: string | null;
  targetSource?: string | null;
}

const REFRESH_MS = 5_000;
// Enough history for the longest common lookback (e.g. ema:200) plus slack.
const BAR_COUNT = 320;

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

/** Chart timeframe (TV resolution "5"/"60"/"1D" or "5m"/"1h") → HL interval. */
function toInterval(tf?: string | null): string {
  if (!tf) return "5m";
  const s = String(tf).trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n % 1440 === 0) return `${n / 1440}d`;
    if (n % 60 === 0) return `${n / 60}h`;
    return `${n}m`;
  }
  const m = s.match(/^(\d+)\s*([mhdw])$/);
  if (m) return `${m[1]}${m[2]}`;
  if (s === "d") return "1d";
  if (s === "w") return "1w";
  return INTERVAL_MS[s] ? s : "5m";
}

function isDynamic(s?: string | null): boolean {
  return !!s && parseLevelSource(s).kind !== "fixed";
}

/** Recompute the entry/stop/target of every dynamic-level plan every few
 *  seconds from live candles. Fixed levels are omitted (their card price never
 *  moves). Returns a map keyed by plan.key; a level absent from a plan's entry
 *  means "no live value — show the stored price". */
export function useLiveLevels(plans: LiveLevelPlan[]): Map<string, LiveLevels> {
  const { info, assetsByName } = useHyperliquid();
  const [out, setOut] = useState<Map<string, LiveLevels>>(new Map());

  // Stable signature of the inputs that actually change the computation, so the
  // poller re-subscribes only when a plan/level/symbol changes — not on every
  // render (the callers rebuild the plans array each time).
  const sig = plans
    .map(
      (p) =>
        `${p.key}~${p.symbol ?? ""}~${p.timeframe ?? ""}~${p.entrySource ?? ""}~${p.stopSource ?? ""}~${p.targetSource ?? ""}`,
    )
    .join("|");

  // Resolve each dynamic-level plan to (coin, interval) once per input change.
  const perPlan = useMemo(() => {
    return plans
      .filter(
        (p) => isDynamic(p.entrySource) || isDynamic(p.stopSource) || isDynamic(p.targetSource),
      )
      .map((p) => {
        const coin = resolveCoin(p.symbol, assetsByName);
        if (!coin) return null;
        const interval = toInterval(p.timeframe);
        return { p, coin, interval, jobKey: `${coin}|${interval}` };
      })
      .filter(Boolean) as Array<{
      p: LiveLevelPlan;
      coin: string;
      interval: string;
      jobKey: string;
    }>;
    // sig captures the plan inputs; assetsByName the coin resolution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, assetsByName]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const jobs = new Map<string, { coin: string; interval: string }>();
      for (const x of perPlan) jobs.set(x.jobKey, { coin: x.coin, interval: x.interval });

      const end = Date.now();
      const barsByJob = new Map<string, OHLCV[]>();
      await Promise.all(
        [...jobs].map(async ([jobKey, { coin, interval }]) => {
          try {
            const span = (INTERVAL_MS[interval] ?? 300_000) * BAR_COUNT;
            const raw = (await info.candleSnapshot({
              coin,
              interval: interval as Parameters<typeof info.candleSnapshot>[0]["interval"],
              startTime: end - span,
              endTime: end,
            })) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
            barsByJob.set(
              jobKey,
              (raw ?? []).map((k) => ({
                time: Math.floor(k.t / 1000),
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
                volume: parseFloat(k.v),
              })),
            );
          } catch {
            /* skip this symbol this tick — cards keep the last/stored value */
          }
        }),
      );

      const next = new Map<string, LiveLevels>();
      for (const { p, jobKey } of perPlan) {
        const bars = barsByJob.get(jobKey);
        if (!bars || !bars.length) continue;
        const at = (src?: string | null): number | undefined => {
          if (!isDynamic(src)) return undefined;
          const v = computeLevel(bars, parseLevelSource(src));
          return typeof v === "number" && Number.isFinite(v) ? v : undefined;
        };
        const lv: LiveLevels = {
          entry: at(p.entrySource),
          stop: at(p.stopSource),
          target: at(p.targetSource),
        };
        if (lv.entry !== undefined || lv.stop !== undefined || lv.target !== undefined) {
          next.set(p.key, lv);
        }
      }
      if (!cancelled) setOut(next);
    };

    void run();
    const iv = setInterval(() => void run(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [perPlan, info]);

  return out;
}
