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
import { LIGHTER_SYMBOL_PREFIX, VENUES, stripVenuePrefix } from "../../lib/venues";

/* ── Lighter (zklighter) datafeed ──────────────────────────────────────────
 * TradingView charting-library datafeed backed by the PUBLIC keyless
 * zklighter REST + WebSocket API. Mirrors the HyperliquidDatafeed contract
 * so the venue router can dispatch to either interchangeably.
 *
 * Verified against the live API (2026-07-27):
 * - Markets:  GET /api/v1/orderBookDetails → { code, order_book_details: [
 *     { symbol: "BTC", market_id: 1, price_decimals: 1, size_decimals: 5,
 *       status: "active" | "inactive", market_type: "perp", ... } ] }
 * - Candles:  GET /api/v1/candles?market_id&resolution&start_timestamp&
 *     end_timestamp&count_back → { code, r, c: [{ t(ms), o, h, l, c, v(base),
 *     V(quote), i }] } — numbers, not strings. Query timestamps in SECONDS.
 *     count_back dominates: at least count_back candles ending at
 *     end_timestamp (extends before start_timestamp), max 500 per call;
 *     a genuinely pre-listing window returns c: [].
 *     NOTE: /api/v1/candlesticks (the SDK's class name) 403s at CloudFront —
 *     the real path is /api/v1/candles.
 * - Live:     wss://.../stream, subscribe { type: "subscribe", channel:
 *     "candle/{market_id}/{resolution}" } → "subscribed/candle" with the
 *     current bar, then "update/candle" ~every 500ms; message channel is
 *     colon-form "candle:{market_id}:{resolution}".
 */

const LIGHTER_REST_URL = "https://mainnet.zklighter.elliot.ai";
const LIGHTER_WS_URL = "wss://mainnet.zklighter.elliot.ai/stream";

/** Server-enforced maximum candles per /api/v1/candles call. */
const MAX_CANDLES_PER_CALL = 500;
/** Hard cap on history pages per getBars (3 × 500 = 1500 bars). */
const MAX_HISTORY_PAGES = 3;

/* zklighter serves exactly these resolutions (probed live: 2h/3m/1w → 400).
 * Honestly narrower than Hyperliquid's set — no 3m/2h/8h/3D/1W/1M. */
const SUPPORTED_RESOLUTIONS = [
  "1", "5", "15", "30", "60", "240", "720", "1D",
] as ResolutionString[];

const RESOLUTION_TO_LIGHTER: Record<string, string> = {
  "1": "1m", "5": "5m", "15": "15m", "30": "30m",
  "60": "1h", "240": "4h", "720": "12h", "1D": "1d",
};

const RESOLUTION_TO_MS: Record<string, number> = {
  "1": 60_000, "5": 300_000, "15": 900_000, "30": 1_800_000,
  "60": 3_600_000, "240": 14_400_000, "720": 43_200_000, "1D": 86_400_000,
};

interface LighterMarket {
  symbol: string;
  marketId: number;
  priceDecimals: number;
  sizeDecimals: number;
  status: string;
}

interface LighterCandle {
  t: number; // bar open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // base volume
  V: number; // quote volume (unused)
  i: number; // last trade id (unused)
}

interface LiveSub {
  onTick: SubscribeBarsCallback;
  lastBarTime: number;
  /** "candle/{market_id}/{resolution}" — null until the market resolves. */
  subscribeChannel: string | null;
  /** "candle:{market_id}:{resolution}" — the form WS messages carry. */
  messageChannel: string | null;
}

/** "LIGHTER:BTC-PERP" / "BTC-PERP" / "BTC" → candidate market keys. */
function marketKeyCandidates(symbol: string): string[] {
  const bare = stripVenuePrefix(symbol.trim()).toUpperCase();
  const candidates = [bare];
  // The picker may carry instrument-style names ("BTC-PERP", "BTC/USD");
  // zklighter market symbols are bare ("BTC" — verified: no dashes/colons).
  const stripped = bare.replace(/(-PERP|-USD|\/USD)$/, "");
  if (stripped && stripped !== bare) candidates.push(stripped);
  return candidates;
}

export class LighterDatafeed {
  private marketsPromise: Promise<Map<string, LighterMarket>> | null = null;

  private ws: WebSocket | null = null;
  private wsOpen = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1_000;
  private destroyed = false;
  private liveSubs = new Map<string, LiveSub>();

  // Rolling window of the active series' bars — same contract as the HL
  // datafeed's recentBars(), so getChartContext gets real OHLC either venue.
  private _lastSeries: Bar[] = [];
  private _marks: Mark[] = [];
  private _timescaleMarks: TimescaleMark[] = [];

  /* ── markets metadata ─────────────────────────────────────────────── */

  private loadMarkets(): Promise<Map<string, LighterMarket>> {
    if (!this.marketsPromise) {
      this.marketsPromise = fetch(`${LIGHTER_REST_URL}/api/v1/orderBookDetails`)
        .then((r) => {
          if (!r.ok) throw new Error(`Lighter markets HTTP ${r.status}`);
          return r.json() as Promise<{
            code?: number;
            order_book_details?: Array<{
              symbol?: string;
              market_id?: number;
              price_decimals?: number;
              supported_price_decimals?: number;
              size_decimals?: number;
              supported_size_decimals?: number;
              status?: string;
            }>;
          }>;
        })
        .then((j) => {
          const map = new Map<string, LighterMarket>();
          for (const row of j.order_book_details ?? []) {
            if (typeof row.symbol !== "string" || typeof row.market_id !== "number")
              continue;
            map.set(row.symbol.toUpperCase(), {
              symbol: row.symbol.toUpperCase(),
              marketId: row.market_id,
              priceDecimals: row.price_decimals ?? row.supported_price_decimals ?? 2,
              sizeDecimals: row.size_decimals ?? row.supported_size_decimals ?? 2,
              status: row.status ?? "active",
            });
          }
          if (map.size === 0) throw new Error("Lighter markets list empty");
          return map;
        })
        .catch((err: unknown) => {
          // Drop the cached promise so a transient failure retries on the
          // next call instead of poisoning the datafeed for the session.
          this.marketsPromise = null;
          throw err;
        });
    }
    return this.marketsPromise;
  }

  private findMarket(
    markets: Map<string, LighterMarket>,
    symbol: string,
  ): LighterMarket | undefined {
    for (const key of marketKeyCandidates(symbol)) {
      const market = markets.get(key);
      if (market) return market;
    }
    return undefined;
  }

  /* ── TradingView datafeed API ─────────────────────────────────────── */

  onReady(callback: (config: DatafeedConfiguration) => void): void {
    setTimeout(() => {
      callback({
        supported_resolutions: SUPPORTED_RESOLUTIONS,
        supports_marks: true,
        supports_timescale_marks: true,
        exchanges: [
          {
            value: VENUES.lighter.chartExchange,
            name: VENUES.lighter.label,
            desc: "Lighter DEX",
          },
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
    this.loadMarkets()
      .then((markets) => {
        const query = userInput.toUpperCase();
        const results: SearchSymbolResultItem[] = [...markets.values()]
          .filter((m) => m.status === "active" && m.symbol.includes(query))
          .slice(0, 30)
          .map((m) => ({
            symbol: m.symbol,
            full_name: `${LIGHTER_SYMBOL_PREFIX}${m.symbol}`,
            description: `${m.symbol} Perpetual`,
            exchange: VENUES.lighter.chartExchange,
            ticker: `${LIGHTER_SYMBOL_PREFIX}${m.symbol}`,
            type: "crypto",
          }));
        onResult(results);
      })
      .catch(() => onResult([]));
  }

  resolveSymbol(
    symbolName: string,
    onResolve: (info: LibrarySymbolInfo) => void,
    onError: (reason: string) => void,
  ): void {
    this.loadMarkets()
      .then((markets) => {
        const market = this.findMarket(markets, symbolName);
        if (!market) {
          onError(`Symbol not found: ${symbolName}`);
          return;
        }
        // Keep the picker's display form ("BTC-PERP") in the name, but the
        // ticker MUST stay venue-prefixed — it is what TV hands back to
        // getBars/subscribeBars, and the router dispatches on that prefix.
        const display = stripVenuePrefix(symbolName.trim()).toUpperCase();
        onResolve({
          name: display,
          ticker: `${LIGHTER_SYMBOL_PREFIX}${display}`,
          description: `${display} Perpetual`,
          type: "crypto",
          session: "24x7",
          timezone: "Etc/UTC",
          exchange: VENUES.lighter.chartExchange,
          listed_exchange: VENUES.lighter.chartExchange,
          format: "price",
          minmov: 1,
          pricescale: Math.pow(10, market.priceDecimals),
          has_intraday: true,
          has_daily: true,
          // zklighter has no native weekly/monthly candles — don't offer them.
          has_weekly_and_monthly: false,
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          intraday_multipliers: ["1", "5", "15", "30", "60", "240", "720"],
          daily_multipliers: ["1"],
          volume_precision: market.sizeDecimals,
          data_status: "streaming",
        } as LibrarySymbolInfo);
      })
      .catch((err: unknown) =>
        onError(err instanceof Error ? err.message : "Lighter markets unavailable"),
      );
  }

  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: (reason: string) => void,
  ): void {
    const interval = RESOLUTION_TO_LIGHTER[resolution];
    if (!interval) {
      onError(`Unsupported resolution: ${resolution}`);
      return;
    }
    const ticker = symbolInfo.ticker ?? symbolInfo.name;
    const resMs = RESOLUTION_TO_MS[resolution] ?? 60_000;

    this.loadMarkets()
      .then(async (markets) => {
        const market = this.findMarket(markets, ticker);
        if (!market) throw new Error(`Symbol not found: ${ticker}`);

        const { from, to } = periodParams;
        const windowBars = Math.max(Math.ceil(((to - from) * 1000) / resMs), 1);
        const want = Math.min(
          Math.max(periodParams.countBack ?? 0, 0) || windowBars,
          MAX_CANDLES_PER_CALL * MAX_HISTORY_PAGES,
        );

        // count_back returns candles ENDING at end_timestamp (reaching
        // before start_timestamp when needed) — exactly TV's countBack
        // contract. Page the end back only when >500 bars are wanted.
        const collected = new Map<number, Bar>();
        let end = to;
        for (let page = 0; page < MAX_HISTORY_PAGES && collected.size < want; page++) {
          const count = Math.min(want - collected.size, MAX_CANDLES_PER_CALL);
          const start = Math.min(from, end - 1);
          const url =
            `${LIGHTER_REST_URL}/api/v1/candles?market_id=${market.marketId}` +
            `&resolution=${interval}&start_timestamp=${start}` +
            `&end_timestamp=${end}&count_back=${count}`;
          const response = await fetch(url);
          if (!response.ok)
            throw new Error(`Lighter candles HTTP ${response.status}`);
          const json = (await response.json()) as { c?: LighterCandle[] };
          const batch = json.c ?? [];
          if (batch.length === 0) break;

          let earliest = Infinity;
          for (const candle of batch) {
            if (candle.t < earliest) earliest = candle.t;
            // Defensive: never hand TV a bar newer than the requested range.
            if (candle.t > to * 1000) continue;
            collected.set(candle.t, {
              time: candle.t,
              open: candle.o,
              high: candle.h,
              low: candle.l,
              close: candle.c,
              volume: candle.v,
            });
          }
          if (batch.length < count) break; // history exhausted
          end = Math.floor(earliest / 1000) - 1;
          if (end <= 0) break;
        }

        const bars = [...collected.values()].sort((a, b) => a.time - b.time);
        if (bars.length === 0) {
          // Verified: pre-listing windows return c: [] — genuinely no data.
          onResult([], { noData: true });
          return;
        }
        this._lastSeries = bars.slice(-80);
        onResult(bars);
      })
      .catch((err: unknown) =>
        onError(err instanceof Error ? err.message : "Failed to get Lighter bars"),
      );
  }

  /* ── live bars (WebSocket) ────────────────────────────────────────── */

  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
  ): void {
    const interval = RESOLUTION_TO_LIGHTER[resolution];
    if (!interval) return;

    // Register synchronously so an early unsubscribe (fast symbol flips)
    // cancels the pending market lookup instead of leaking a channel.
    const sub: LiveSub = {
      onTick,
      lastBarTime: 0,
      subscribeChannel: null,
      messageChannel: null,
    };
    this.liveSubs.set(listenerGuid, sub);

    this.loadMarkets()
      .then((markets) => {
        if (this.destroyed || this.liveSubs.get(listenerGuid) !== sub) return;
        const market = this.findMarket(markets, symbolInfo.ticker ?? symbolInfo.name);
        if (!market) return;
        sub.subscribeChannel = `candle/${market.marketId}/${interval}`;
        sub.messageChannel = `candle:${market.marketId}:${interval}`;
        this.ensureSocket();
        if (this.wsOpen) this.sendSubscribe(sub.subscribeChannel);
      })
      .catch(() => {
        /* markets fetch failed — getBars will surface the error; the next
         * subscribe retries the (uncached) fetch. */
      });
  }

  unsubscribeBars(listenerGuid: string): void {
    const sub = this.liveSubs.get(listenerGuid);
    if (!sub) return;
    this.liveSubs.delete(listenerGuid);

    if (sub.subscribeChannel) {
      const shared = [...this.liveSubs.values()].some(
        (s) => s.subscribeChannel === sub.subscribeChannel,
      );
      if (!shared && this.wsOpen && this.ws) {
        try {
          this.ws.send(
            JSON.stringify({ type: "unsubscribe", channel: sub.subscribeChannel }),
          );
        } catch {
          /* socket already dying — teardown below handles it */
        }
      }
    }
    // Deterministic teardown: no subscribers → no socket, no reconnect loop.
    if (this.liveSubs.size === 0) this.teardownSocket();
  }

  private ensureSocket(): void {
    if (this.ws || this.destroyed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(LIGHTER_WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.wsOpen = true;
      this.reconnectDelayMs = 1_000;
      const sent = new Set<string>();
      for (const sub of this.liveSubs.values()) {
        if (sub.subscribeChannel && !sent.has(sub.subscribeChannel)) {
          sent.add(sub.subscribeChannel);
          this.sendSubscribe(sub.subscribeChannel);
        }
      }
    };
    ws.onmessage = (event: MessageEvent) => {
      if (ws !== this.ws) return;
      this.handleMessage(event);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.wsOpen = false;
      if (!this.destroyed && this.liveSubs.size > 0) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and owns the reconnect; just make sure it fires.
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
  }

  private sendSubscribe(channel: string): void {
    if (!this.ws || !this.wsOpen) return;
    try {
      this.ws.send(JSON.stringify({ type: "subscribe", channel }));
    } catch {
      /* onclose will reconnect and resubscribe */
    }
  }

  private handleMessage(event: MessageEvent): void {
    let msg: {
      type?: string;
      channel?: string;
      candles?: LighterCandle[];
    };
    try {
      msg = JSON.parse(
        typeof event.data === "string" ? event.data : String(event.data),
      ) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "ping") {
      try {
        this.ws?.send(JSON.stringify({ type: "pong" }));
      } catch {
        /* reconnect handles it */
      }
      return;
    }
    // "subscribed/candle" (initial snapshot) and "update/candle" both carry
    // the forming bar in `candles`; channel is colon-form "candle:1:1m".
    if (
      (msg.type !== "update/candle" && msg.type !== "subscribed/candle") ||
      typeof msg.channel !== "string" ||
      !Array.isArray(msg.candles) ||
      msg.candles.length === 0
    )
      return;

    const candle = msg.candles[msg.candles.length - 1];
    if (typeof candle?.t !== "number") return;
    const bar: Bar = {
      time: candle.t,
      open: candle.o,
      high: candle.h,
      low: candle.l,
      close: candle.c,
      volume: candle.v,
    };

    for (const sub of this.liveSubs.values()) {
      if (sub.messageChannel !== msg.channel) continue;
      // TV requires non-decreasing bar times per subscription.
      if (bar.time < sub.lastBarTime) continue;
      sub.lastBarTime = bar.time;
      sub.onTick(bar);
    }

    const last = this._lastSeries[this._lastSeries.length - 1];
    if (last && last.time === bar.time)
      this._lastSeries[this._lastSeries.length - 1] = bar;
    else if (last && bar.time > last.time) this._lastSeries.push(bar);
    if (this._lastSeries.length > 80) this._lastSeries.shift();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.destroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed && this.liveSubs.size > 0) this.ensureSocket();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15_000);
  }

  private teardownSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelayMs = 1_000;
    const ws = this.ws;
    this.ws = null;
    this.wsOpen = false;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  /* ── parity helpers (same surface as HyperliquidDatafeed) ─────────── */

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
    this.destroyed = true;
    this.liveSubs.clear();
    this.teardownSocket();
  }
}
