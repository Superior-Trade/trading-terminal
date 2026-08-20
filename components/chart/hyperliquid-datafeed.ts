import type {
  DatafeedConfiguration,
  LibrarySymbolInfo,
  ResolutionString,
  SearchSymbolResultItem,
  Bar,
  PeriodParams,
  HistoryCallback,
  SubscribeBarsCallback,
  Mark,
  TimescaleMark,
  GetMarksCallback,
} from "../../public/static/charting_library/datafeed-api";
import type { InfoClient, SubscriptionClient } from "@nktkas/hyperliquid";
import type { ISubscription } from "@nktkas/hyperliquid";
import type { AssetMeta } from "../../lib/hyperliquid-provider";
import { authFetch } from "../../lib/client-auth";

/* ── Synthetic CVD series ("CVD:<coin>") ────────────────────────────────
 * Served from our own footprint store (/api/orderflow/cvd — collector
 * worker + web recorders), NOT Hyperliquid. The "Superior CVD" custom
 * study requests this ticker via new_sym and renders it in its own pane.
 * Data exists from each coin's recording start with 7-day retention. */
export const CVD_PREFIX = "CVD:";
/** Chart resolution → cvd endpoint res (minutes; 5m buckets are the floor). */
function cvdRes(resolution: string): number {
  const ms = RESOLUTION_TO_MS[resolution] ?? 300_000;
  return Math.max(5, Math.min(1440, Math.round(ms / 60_000)));
}

type HLInterval =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "8h"
  | "12h"
  | "1d"
  | "3d"
  | "1w"
  | "1M";

const SUPPORTED_RESOLUTIONS = [
  "1", "3", "5", "15", "30", "60", "120", "240", "480", "720",
  "1D", "3D", "1W", "1M",
] as ResolutionString[];

export const RESOLUTION_TO_HL: Record<string, HLInterval> = {
  "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m",
  "60": "1h", "120": "2h", "240": "4h", "480": "8h", "720": "12h",
  "1D": "1d", "3D": "3d", "1W": "1w", "1M": "1M",
};

export const RESOLUTION_TO_MS: Record<string, number> = {
  "1": 60_000, "3": 180_000, "5": 300_000, "15": 900_000, "30": 1_800_000,
  "60": 3_600_000, "120": 7_200_000, "240": 14_400_000, "480": 28_800_000,
  "720": 43_200_000, "1D": 86_400_000, "3D": 259_200_000,
  "1W": 604_800_000, "1M": 2_592_000_000,
};

function toApiCoin(coin: string, assetsByName: Map<string, AssetMeta>): string {
  const meta = findAssetByName(coin, assetsByName);
  if (meta?.apiCoin) return meta.apiCoin;
  return meta?.name ?? coin;
}

function findAssetByName(
  name: string,
  assetsByName: Map<string, AssetMeta>,
): AssetMeta | undefined {
  const exact = assetsByName.get(name);
  if (exact) return exact;

  const normalized = name.toLowerCase();
  for (const [key, asset] of assetsByName) {
    if (key.toLowerCase() === normalized) return asset;
  }

  return undefined;
}

function symbolToCoin(
  symbol: string,
  assetsByName: Map<string, AssetMeta>,
): string {
  // Spot coins look like "PURR/USDC" and must be kept intact
  const cleaned = symbol.trim();
  const cleanedAsset = findAssetByName(cleaned, assetsByName);
  if (cleanedAsset) return cleanedAsset.name;
  // Try stripping a leading "Hyperliquid:" prefix (TradingView format)
  const withoutExchange = cleaned.replace(/^[^:]+:/, "");
  const exchangeAsset = findAssetByName(withoutExchange, assetsByName);
  if (exchangeAsset) return exchangeAsset.name;
  // Fallback: extract base token (perp style "ETH/USD" or "ETH-USD")
  const baseCoin = withoutExchange
    .replace(/\/.*$/, "")
    .replace(/-.*$/, "")
    .trim();
  return findAssetByName(baseCoin, assetsByName)?.name ?? baseCoin;
}

function computePricescale(priceStr: string): number {
  if (!priceStr) return 100;
  const price = parseFloat(priceStr);
  if (isNaN(price) || price <= 0) return 100;

  if (price >= 1) return 100;

  const dotIdx = priceStr.indexOf(".");
  if (dotIdx === -1) return 100;
  const decimals = priceStr.length - dotIdx - 1;
  return Math.pow(10, Math.max(decimals, 2));
}

interface ActiveSub {
  sub: ISubscription;
  coin: string;
  resolution: string;
  onTick: SubscribeBarsCallback;
  lastBarTime: number;
  /** REST fallback poller when the candle WS is unavailable. */
  pollTimer?: ReturnType<typeof setInterval>;
}

export class HyperliquidDatafeed {
  private info: InfoClient;
  private subscription: SubscriptionClient;
  private assets: AssetMeta[];
  private assetsByName: Map<string, AssetMeta>;
  private activeSubs = new Map<string, ActiveSub>();
  // CVD tickers have no HL websocket — refresh the live bar by polling our
  // own endpoint (5m buckets; 30s is plenty).
  private cvdPolls = new Map<string, ReturnType<typeof setInterval>>();
  // Rolling window of the active series' bars so getChartContext can hand
  // the agent real OHLC (swing highs/lows, structure) — not just lastPrice.
  private _lastSeries: Bar[] = [];
  private _marks: Mark[] = [];
  private _timescaleMarks: TimescaleMark[] = [];

  constructor(
    info: InfoClient,
    subscription: SubscriptionClient,
    assets: AssetMeta[],
    assetsByName: Map<string, AssetMeta>,
  ) {
    this.info = info;
    this.subscription = subscription;
    this.assets = assets;
    this.assetsByName = assetsByName;
  }

  onReady(callback: (config: DatafeedConfiguration) => void): void {
    setTimeout(() => {
      callback({
        supported_resolutions: SUPPORTED_RESOLUTIONS,
        supports_marks: true,
        supports_timescale_marks: true,
        exchanges: [
          { value: "Hyperliquid", name: "Hyperliquid", desc: "Hyperliquid DEX" },
        ],
        symbols_types: [{ name: "Crypto", value: "crypto" }],
      });
    }, 0);
  }

  searchSymbols(
    userInput: string,
    _exchange: string,
    _symbolType: string,
    onResult: (items: SearchSymbolResultItem[]) => void,
  ): void {
    const query = userInput.toUpperCase();
    const results: SearchSymbolResultItem[] = this.assets
      .filter((a) => a.name.toUpperCase().includes(query))
      .slice(0, 30)
      .map((a) => {
        const symbol =
          a.marketType === "spot" || a.marketType === "hip3"
            ? a.name
            : `${a.name}/USD`;
        const desc =
          a.marketType === "spot"
            ? `${a.name} Spot`
            : a.marketType === "hip3"
            ? `${a.name} HIP-3 Perpetual`
            : `${a.name} / USD Perpetual`;
        return {
          symbol,
          full_name: symbol,
          description: desc,
          exchange: "Hyperliquid",
          ticker: symbol,
          type: "crypto",
        };
      });
    onResult(results);
  }

  resolveSymbol(
    symbolName: string,
    onResolve: (info: LibrarySymbolInfo) => void,
    onError: (reason: string) => void,
  ): void {
    if (symbolName.startsWith(CVD_PREFIX)) {
      const base = symbolName.slice(CVD_PREFIX.length);
      setTimeout(() =>
        onResolve({
          name: symbolName,
          ticker: symbolName,
          description: `CVD ${base}`,
          type: "index",
          session: "24x7",
          timezone: "Etc/UTC",
          exchange: "Superior",
          listed_exchange: "Superior",
          format: "volume",
          minmov: 1,
          pricescale: 1,
          has_intraday: true,
          has_daily: true,
          has_weekly_and_monthly: false,
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          intraday_multipliers: ["5", "15", "30", "60", "120", "240", "480", "720"],
          daily_multipliers: ["1"],
          volume_precision: 0,
          data_status: "streaming",
        } as LibrarySymbolInfo),
      );
      return;
    }
    const coin = symbolToCoin(symbolName, this.assetsByName);
    const asset = this.assetsByName.get(coin);

    if (!asset) {
      onError(`Symbol not found: ${symbolName}`);
      return;
    }

    const tvSymbol =
      asset.marketType === "spot" || asset.marketType === "hip3"
        ? coin
        : `${coin}/USD`;
    const description =
      asset.marketType === "spot"
        ? `${coin} Spot`
        : asset.marketType === "hip3"
        ? `${coin} HIP-3 Perpetual`
        : `${coin} / USD Perpetual`;

    const buildSymbolInfo = (pricescale: number) =>
      ({
        name: tvSymbol,
        ticker: tvSymbol,
        description,
        type: "crypto",
        session: "24x7",
        timezone: "Etc/UTC",
        exchange: "Hyperliquid",
        listed_exchange: "Hyperliquid",
        format: "price",
        minmov: 1,
        pricescale,
        has_intraday: true,
        has_daily: true,
        has_weekly_and_monthly: true,
        supported_resolutions: SUPPORTED_RESOLUTIONS,
        intraday_multipliers: [
          "1", "3", "5", "15", "30", "60", "120", "240", "480", "720",
        ],
        daily_multipliers: ["1", "3"],
        weekly_multipliers: ["1"],
        monthly_multipliers: ["1"],
        volume_precision: 2,
        data_status: "streaming",
      }) as LibrarySymbolInfo;

    this.info
      .allMids()
      .then((mids) => {
        const priceStr = (mids as Record<string, string>)[coin] || "";
        onResolve(buildSymbolInfo(computePricescale(priceStr)));
      })
      .catch(() => {
        onResolve(buildSymbolInfo(100));
      });
  }

  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: (reason: string) => void,
  ): void {
    const ticker = symbolInfo.ticker ?? symbolInfo.name;
    if (ticker.startsWith(CVD_PREFIX)) {
      const base = ticker.slice(CVD_PREFIX.length);
      const coin = toApiCoin(symbolToCoin(base, this.assetsByName), this.assetsByName);
      const res = cvdRes(resolution);
      void authFetch(
        `/api/orderflow/cvd?coin=${encodeURIComponent(coin)}&from=${periodParams.from * 1000}&to=${periodParams.to * 1000}&res=${res}`,
      )
        .then((r) => r.json())
        .then((j: { bars?: Array<{ t: number; o: number; h?: number; l?: number; cvd: number; buy: number; sell: number }> }) => {
          const bars: Bar[] = (j.bars ?? []).map((b) => ({
            time: b.t,
            open: b.o,
            // Intrabar cumulative-path extremes → real candle wicks
            // (absorption reads as a long wick, like TV's own CVD).
            high: b.h ?? Math.max(b.o, b.cvd),
            low: b.l ?? Math.min(b.o, b.cvd),
            close: b.cvd,
            volume: b.buy + b.sell,
          }));
          // Footprint retention is 7 days — older requests are genuinely
          // empty, not an error.
          onResult(bars, bars.length ? undefined : { noData: true });
        })
        .catch((err) =>
          onError(err instanceof Error ? err.message : "CVD fetch failed"),
        );
      return;
    }
    const coin = toApiCoin(
      symbolToCoin(symbolInfo.ticker || symbolInfo.name, this.assetsByName),
      this.assetsByName,
    );
    const interval = RESOLUTION_TO_HL[resolution];
    if (!interval) {
      onError(`Unsupported resolution: ${resolution}`);
      return;
    }

    const startTime = periodParams.from * 1000;
    const endTime = periodParams.to * 1000;

    this.info
      .candleSnapshot({ coin, interval, startTime, endTime })
      .then((candles) => {
        if (!candles || candles.length === 0) {
          onResult([], { noData: true });
          return;
        }

        const bars: Bar[] = candles.map((c) => ({
          time: c.t,
          open: parseFloat(c.o),
          high: parseFloat(c.h),
          low: parseFloat(c.l),
          close: parseFloat(c.c),
          volume: parseFloat(c.v),
        }));

        this._lastSeries = bars.slice(-80);
        onResult(bars);
      })
      .catch((err) => {
        onError(err instanceof Error ? err.message : "Failed to get bars");
      });
  }

  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
  ): void {
    const subTicker = symbolInfo.ticker ?? symbolInfo.name;
    if (subTicker.startsWith(CVD_PREFIX)) {
      const base = subTicker.slice(CVD_PREFIX.length);
      const cvdCoin = toApiCoin(symbolToCoin(base, this.assetsByName), this.assetsByName);
      const res = cvdRes(resolution);
      let lastTime = 0;
      const poll = setInterval(() => {
        void authFetch(
          `/api/orderflow/cvd?coin=${encodeURIComponent(cvdCoin)}&from=${Date.now() - 3 * res * 60_000}&res=${res}`,
        )
          .then((r) => r.json())
          .then((j: { bars?: Array<{ t: number; o: number; h?: number; l?: number; cvd: number; buy: number; sell: number }> }) => {
            const b = j.bars?.[j.bars.length - 1];
            if (!b || b.t < lastTime) return;
            lastTime = b.t;
            onTick({
              time: b.t,
              open: b.o,
              high: b.h ?? Math.max(b.o, b.cvd),
              low: b.l ?? Math.min(b.o, b.cvd),
              close: b.cvd,
              volume: b.buy + b.sell,
            });
          })
          .catch(() => {});
      }, 30_000);
      this.cvdPolls.set(listenerGuid, poll);
      return;
    }
    const coin = toApiCoin(
      symbolToCoin(symbolInfo.ticker || symbolInfo.name, this.assetsByName),
      this.assetsByName,
    );
    const interval = RESOLUTION_TO_HL[resolution];
    if (!interval) return;

    const subEntry: ActiveSub = {
      sub: null!,
      coin,
      resolution,
      onTick,
      lastBarTime: 0,
    };

    const applyBar = (data: { t: number; o: string; h: string; l: string; c: string; v: string }) => {
      const barTime = data.t;
      if (barTime > subEntry.lastBarTime) {
        subEntry.lastBarTime = barTime;
      }
      const bar = {
        time: barTime,
        open: parseFloat(data.o),
        high: parseFloat(data.h),
        low: parseFloat(data.l),
        close: parseFloat(data.c),
        volume: parseFloat(data.v),
      };
      const last = this._lastSeries[this._lastSeries.length - 1];
      if (last && last.time === bar.time) this._lastSeries[this._lastSeries.length - 1] = bar;
      else if (!last || bar.time > last.time) this._lastSeries.push(bar);
      if (this._lastSeries.length > 80) this._lastSeries.shift();
      onTick(bar);
    };

    this.subscription
      .candle({ coin, interval }, applyBar)
      .then((sub) => {
        subEntry.sub = sub;
        this.activeSubs.set(listenerGuid, subEntry);
      })
      .catch((err) => {
        // The HL WebSocket can refuse connections (per-IP limits, flaky
        // handshakes). Live candles must not die with it: fall back to
        // REST-polling the latest bar every 5s.
        console.warn("Candle WS unavailable, falling back to REST polling:", err);
        const apiCoin = toApiCoin(coin, this.assetsByName);
        const poll = async () => {
          // Don't hammer HL's REST while our tab is hidden (user on the HL
          // site) — the last bar can wait until they're back on our tab.
          if (typeof document !== "undefined" && document.hidden) return;
          try {
            const end = Date.now();
            const candles = await this.info.candleSnapshot({
              coin: apiCoin,
              interval,
              startTime: end - (RESOLUTION_TO_MS[resolution] ?? 60_000) * 3,
              endTime: end,
            });
            const latest = candles[candles.length - 1];
            if (latest) applyBar(latest);
          } catch {
            /* next tick retries */
          }
        };
        void poll();
        subEntry.pollTimer = setInterval(() => void poll(), 5_000);
        this.activeSubs.set(listenerGuid, subEntry);
      });

    this.activeSubs.set(listenerGuid, subEntry);
  }

  unsubscribeBars(listenerGuid: string): void {
    const cvdPoll = this.cvdPolls.get(listenerGuid);
    if (cvdPoll) {
      clearInterval(cvdPoll);
      this.cvdPolls.delete(listenerGuid);
      return;
    }
    const entry = this.activeSubs.get(listenerGuid);
    if (entry?.sub) {
      entry.sub.unsubscribe().catch(() => {});
    }
    if (entry?.pollTimer) clearInterval(entry.pollTimer);
    this.activeSubs.delete(listenerGuid);
  }

  recentBars(): Bar[] {
    return this._lastSeries;
  }

  setMarks(marks: Mark[]): void {
    this._marks = marks;
  }

  setTimescaleMarks(marks: TimescaleMark[]): void {
    this._timescaleMarks = marks;
  }

  getMarks(
    _symbolInfo: LibrarySymbolInfo,
    from: number,
    to: number,
    onDataCallback: GetMarksCallback<Mark>,
    resolution: ResolutionString,
  ): void {
    const resSec = (RESOLUTION_TO_MS[resolution] || 60_000) / 1000;
    const aligned = this._marks
      .filter((m) => m.time >= from && m.time <= to)
      .map((m) => ({ ...m, time: Math.floor(m.time / resSec) * resSec }));
    onDataCallback(aligned);
  }

  getTimescaleMarks(
    _symbolInfo: LibrarySymbolInfo,
    from: number,
    to: number,
    onDataCallback: GetMarksCallback<TimescaleMark>,
    resolution: ResolutionString,
  ): void {
    const resSec = (RESOLUTION_TO_MS[resolution] || 60_000) / 1000;
    const aligned = this._timescaleMarks
      .filter((m) => m.time >= from && m.time <= to)
      .map((m) => ({ ...m, time: Math.floor(m.time / resSec) * resSec }));
    onDataCallback(aligned);
  }

  destroy(): void {
    for (const entry of this.activeSubs.values()) {
      if (entry.sub) {
        entry.sub.unsubscribe().catch(() => {});
      }
      // Clear leaked REST-fallback pollers too — without this, every chart
      // re-init (symbol/theme change, remount) left a 5s HL poll running
      // forever, stacking API load until the page was closed.
      if (entry.pollTimer) clearInterval(entry.pollTimer);
    }
    this.activeSubs.clear();
  }
}
