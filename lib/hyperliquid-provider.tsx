"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type {
  InfoClient,
  ISubscription,
  SubscriptionClient,
} from "@nktkas/hyperliquid";
import { getInfoClient, getSubscriptionClient } from "./hyperliquid-clients";
import { buildAssetList } from "./market-universe.mjs";
export type { AssetMeta } from "./market-universe";

// ─── HL meta cache ─────────────────────────────────────────────────────
// The two REST calls below (`allPerpMetas` + `spotMetaAndAssetCtxs`)
// run on every page load. Cache the responses in localStorage with a
// 1-hour TTL so app boot is synchronous when the cache is warm and a
// boot-time 429 falls back to cache.
const META_CACHE_KEY = "hl-meta:v1";
const META_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

type AllPerpMetas = Awaited<ReturnType<InfoClient["allPerpMetas"]>>;
type SpotMetaAndAssetCtxs = Awaited<
  ReturnType<InfoClient["spotMetaAndAssetCtxs"]>
>;

function readMetaCache(): {
  allPerps: AllPerpMetas;
  spotResp: SpotMetaAndAssetCtxs;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(META_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      ts?: number;
      allPerps?: AllPerpMetas;
      spotResp?: SpotMetaAndAssetCtxs;
    };
    if (!parsed.ts || Date.now() - parsed.ts > META_CACHE_TTL_MS) return null;
    if (!parsed.allPerps || !parsed.spotResp) return null;
    return { allPerps: parsed.allPerps, spotResp: parsed.spotResp };
  } catch {
    return null;
  }
}

function writeMetaCache(
  allPerps: AllPerpMetas,
  spotResp: SpotMetaAndAssetCtxs,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      META_CACHE_KEY,
      JSON.stringify({ ts: Date.now(), allPerps, spotResp }),
    );
  } catch {
    // localStorage may be quota-exceeded or disabled; non-fatal.
  }
}

async function refreshMetaInBackground(info: InfoClient): Promise<void> {
  try {
    const [allPerps, spotResp] = await Promise.all([
      info.allPerpMetas(),
      info.spotMetaAndAssetCtxs(),
    ]);
    writeMetaCache(allPerps, spotResp);
  } catch {
    // Don't surface — we already rendered with the cached version.
  }
}

// AssetMeta now lives in lib/market-universe.d.ts (single source of truth
// shared with the server screen_markets tool and evals/markets.mjs) and is
// re-exported above for existing importers.
import type { AssetMeta } from "./market-universe";

interface HyperliquidContextType {
  info: InfoClient;
  subscription: SubscriptionClient;
  assets: AssetMeta[];
  assetsByName: Map<string, AssetMeta>;
  /** Ordered asset names keyed by DEX name ("" = main DEX). */
  perpUniversesByDex: Map<string, string[]>;
  isReady: boolean;
  /** Why the universe failed to load (null while loading / on success) — lets
   *  the market picker say "unavailable" instead of spinning forever. */
  loadError: string | null;
}

const HyperliquidContext = createContext<HyperliquidContextType | null>(null);

/** Returns the display pair string for a coin identifier. */
export function coinToPair(coin: string): string {
  return coin.includes("/") || coin.includes(":") ? coin : `${coin}-USD`;
}

export function pairToCoin(pair: string): string {
  return pair.includes("/") || pair.includes(":")
    ? pair
    : pair.replace(/-USD$/, "");
}

/** Case-insensitive asset resolution. TradingView uppercases symbols it
 *  echoes back ("XYZ:SPCX") while HIP-3 canonical names keep a lowercase
 *  dex prefix ("xyz:SPCX") — an exact Map.get misses whenever the pair
 *  state came from a chart echo. */
export function resolveAsset(
  assetsByName: Map<string, AssetMeta>,
  coin: string,
): AssetMeta | undefined {
  const hit = assetsByName.get(coin);
  if (hit) return hit;
  const lower = coin.toLowerCase();
  for (const a of assetsByName.values())
    if (a.name.toLowerCase() === lower) return a;
  return undefined;
}

/** URL-friendly slug for a pair — no ":" or "/" (which need percent-encoding).
 *  "xyz:SKHX" → "XYZ-SKHX", "BTC-USD" → "BTC-USD", "HYPE/USDC" → "HYPE-USDC". */
export function pairToSlug(pair: string): string {
  return pair.replace(/[:/]/g, "-").toUpperCase();
}

/** Human-readable display name for a pair/coin. */
export function pairDisplayName(pair: string): string {
  if (pair.includes(":")) {
    return pair.split(":")[1] + "-USDC";
  }
  return pair;
}

export function useHyperliquid(): HyperliquidContextType {
  const ctx = useContext(HyperliquidContext);
  if (!ctx)
    throw new Error("useHyperliquid must be used within HyperliquidProvider");
  return ctx;
}

export function HyperliquidProvider({ children }: { children: ReactNode }) {
  const [assets, setAssets] = useState<AssetMeta[]>([]);
  const [assetsByName, setAssetsByName] = useState<Map<string, AssetMeta>>(
    new Map(),
  );
  const [perpUniversesByDex, setPerpUniversesByDex] = useState<
    Map<string, string[]>
  >(new Map());
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const info = getInfoClient();
  const subscription = getSubscriptionClient();

  useEffect(() => {
    let cancelled = false;
    let dexsSub: ISubscription | null = null;

    async function fetchMeta() {
      try {
        const cached = readMetaCache();
        let allPerps: Awaited<ReturnType<typeof info.allPerpMetas>>;
        let spotResp: Awaited<ReturnType<typeof info.spotMetaAndAssetCtxs>>;
        if (cached) {
          allPerps = cached.allPerps;
          spotResp = cached.spotResp;
          void refreshMetaInBackground(info);
        } else {
          [allPerps, spotResp] = await Promise.all([
            info.allPerpMetas(),
            info.spotMetaAndAssetCtxs(),
          ]);
          if (cancelled) return;
          writeMetaCache(allPerps, spotResp);
        }
        // IDEMPOTENT: the allDexsAssetCtxs subscription below is meant to be
        // one-shot, but its first message can arrive BEFORE the await hands
        // us the subscription handle — the callback's unsubscribe is then a
        // no-op and every ~5s stream update would re-run finish, minting a
        // new assetsByName Map identity and RECREATING the TV widget (the
        // "chart keeps refreshing" prod bug). The guard kills the loop at
        // the source regardless of unsubscribe races.
        let finished = false;
        const finish = (dexNames: string[]) => {
          if (cancelled || finished) return;
          finished = true;
          const { assets: assetList, universesByDex } = buildAssetList(
            allPerps,
            spotResp,
            dexNames,
          );
          const byName = new Map<string, AssetMeta>();
          for (const a of assetList) byName.set(a.name, a);
          setAssets(assetList);
          setAssetsByName(byName);
          setPerpUniversesByDex(universesByDex);
          setLoadError(null);
          setIsReady(true);
        };

        // HIP-3 dex names, aligned with allPerps by position. Primary:
        // one-shot allDexsAssetCtxs subscription. The WS can drop on boot
        // (multiple tabs / flaky handshake) — and NOTHING must depend on it,
        // so fall back to the perpDexs REST endpoint.
        try {
          dexsSub = await subscription.allDexsAssetCtxs((data) => {
            finish(data.ctxs.map(([dex]) => dex));
            // One-shot: unsubscribe after first message.
            dexsSub?.unsubscribe().catch(() => {});
            dexsSub = null;
          });
        } catch {
          const dexs = await info.perpDexs().catch(() => [null]);
          finish(
            (dexs as Array<{ name: string } | null>).map((d) =>
              d === null ? "" : d.name,
            ),
          );
        }

        if (cancelled) {
          dexsSub?.unsubscribe().catch(() => {});
          dexsSub = null;
        }
      } catch (err) {
        console.warn("Failed to fetch Hyperliquid meta:", err);
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : "universe fetch failed");
      }
    }

    fetchMeta();
    return () => {
      cancelled = true;
      dexsSub?.unsubscribe().catch(() => {});
    };
  }, [info, subscription]);

  return (
    <HyperliquidContext.Provider
      value={{
        info,
        subscription,
        assets,
        assetsByName,
        perpUniversesByDex,
        isReady,
        loadError,
      }}
    >
      {children}
    </HyperliquidContext.Provider>
  );
}
