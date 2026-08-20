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
import { HyperliquidDatafeed, CVD_PREFIX } from "./hyperliquid-datafeed";
import { LighterDatafeed } from "./lighter-datafeed";
import {
  VENUES,
  lighterUiEnabled,
  venueOfSymbol,
  type Venue,
} from "../../lib/venues";

/* ── Venue datafeed router ─────────────────────────────────────────────────
 * Thin TradingView datafeed that dispatches every call to the Hyperliquid
 * or Lighter datafeed based on the shared symbol convention
 * (`venueOfSymbol`: "LIGHTER:<MARKET>" → lighter, everything else → HL —
 * including synthetic tickers like "CVD:<coin>" and HIP-3 "xyz:SPCX").
 *
 * With the Lighter UI flag OFF this is a pure pass-through to the HL
 * datafeed: onReady forwards HL's config untouched and non-prefixed symbols
 * always hit HL directly — zero behavior change.
 */
export class VenueDatafeedRouter {
  private readonly hl: HyperliquidDatafeed;
  private readonly lighter: LighterDatafeed;
  /** Which venue owns each live-bars listener, for exact unsubscribe. */
  private guidVenue = new Map<string, Venue>();
  /** Venue of the last real (non-CVD) series — backs recentBars(). */
  private activeVenue: Venue = "hyperliquid";

  constructor(hl: HyperliquidDatafeed, lighter: LighterDatafeed) {
    this.hl = hl;
    this.lighter = lighter;
  }

  private feedFor(venue: Venue): HyperliquidDatafeed | LighterDatafeed {
    return venue === "lighter" ? this.lighter : this.hl;
  }

  private symbolOf(symbolInfo: LibrarySymbolInfo): string {
    return symbolInfo.ticker ?? symbolInfo.name;
  }

  onReady(callback: (config: DatafeedConfiguration) => void): void {
    this.hl.onReady((config) => {
      if (!lighterUiEnabled()) {
        callback(config);
        return;
      }
      callback({
        ...config,
        exchanges: [
          ...(config.exchanges ?? []),
          {
            value: VENUES.lighter.chartExchange,
            name: VENUES.lighter.label,
            desc: "Lighter DEX",
          },
        ],
      });
    });
  }

  searchSymbols(
    userInput: string,
    exchange: string,
    symbolType: string,
    onResult: (items: SearchSymbolResultItem[]) => void,
  ): void {
    if (!lighterUiEnabled() || exchange === VENUES.hyperliquid.chartExchange) {
      this.hl.searchSymbols(userInput, exchange, symbolType, onResult);
      return;
    }
    if (exchange === VENUES.lighter.chartExchange) {
      this.lighter.searchSymbols(userInput, exchange, symbolType, onResult);
      return;
    }
    // No venue filter: merge, HL first (the incumbent venue stays primary).
    const slots: [SearchSymbolResultItem[] | null, SearchSymbolResultItem[] | null] =
      [null, null];
    let pending = 2;
    const collect = (slot: 0 | 1) => (items: SearchSymbolResultItem[]) => {
      slots[slot] = items;
      if (--pending === 0) onResult([...(slots[0] ?? []), ...(slots[1] ?? [])]);
    };
    this.hl.searchSymbols(userInput, exchange, symbolType, collect(0));
    this.lighter.searchSymbols(userInput, exchange, symbolType, collect(1));
  }

  resolveSymbol(
    symbolName: string,
    onResolve: (info: LibrarySymbolInfo) => void,
    onError: (reason: string) => void,
  ): void {
    this.feedFor(venueOfSymbol(symbolName)).resolveSymbol(
      symbolName,
      onResolve,
      onError,
    );
  }

  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: (reason: string) => void,
  ): void {
    const symbol = this.symbolOf(symbolInfo);
    const venue = venueOfSymbol(symbol);
    // CVD is a synthetic study series that always loads from the HL feed —
    // it must not flip which venue's recentBars() the chart context reads.
    if (!symbol.startsWith(CVD_PREFIX)) this.activeVenue = venue;
    this.feedFor(venue).getBars(
      symbolInfo,
      resolution,
      periodParams,
      onResult,
      onError,
    );
  }

  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
  ): void {
    const venue = venueOfSymbol(this.symbolOf(symbolInfo));
    this.guidVenue.set(listenerGuid, venue);
    this.feedFor(venue).subscribeBars(symbolInfo, resolution, onTick, listenerGuid);
  }

  unsubscribeBars(listenerGuid: string): void {
    const venue = this.guidVenue.get(listenerGuid);
    if (venue) {
      this.guidVenue.delete(listenerGuid);
      this.feedFor(venue).unsubscribeBars(listenerGuid);
      return;
    }
    // Unknown guid (shouldn't happen) — both feeds no-op on unknown guids.
    this.hl.unsubscribeBars(listenerGuid);
    this.lighter.unsubscribeBars(listenerGuid);
  }

  getMarks(
    symbolInfo: LibrarySymbolInfo,
    from: number,
    to: number,
    onDataCallback: GetMarksCallback<Mark>,
    resolution: ResolutionString,
  ): void {
    this.feedFor(venueOfSymbol(this.symbolOf(symbolInfo))).getMarks(
      symbolInfo,
      from,
      to,
      onDataCallback,
      resolution,
    );
  }

  getTimescaleMarks(
    symbolInfo: LibrarySymbolInfo,
    from: number,
    to: number,
    onDataCallback: GetMarksCallback<TimescaleMark>,
    resolution: ResolutionString,
  ): void {
    this.feedFor(venueOfSymbol(this.symbolOf(symbolInfo))).getTimescaleMarks(
      symbolInfo,
      from,
      to,
      onDataCallback,
      resolution,
    );
  }

  /* ── app-facing helpers (same surface trading-chart already uses) ── */

  recentBars(): Bar[] {
    return this.feedFor(this.activeVenue).recentBars();
  }

  setMarks(marks: Mark[]): void {
    this.hl.setMarks(marks);
    this.lighter.setMarks(marks);
  }

  setTimescaleMarks(marks: TimescaleMark[]): void {
    this.hl.setTimescaleMarks(marks);
    this.lighter.setTimescaleMarks(marks);
  }

  destroy(): void {
    this.guidVenue.clear();
    this.hl.destroy();
    this.lighter.destroy();
  }
}
