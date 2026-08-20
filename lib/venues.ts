// Shared venue contract for the multi-venue terminal (Lighter integration).
// Single source of truth for venue identity, display metadata, and the chart
// symbol convention — imported by the market picker, deploy flow, and the
// chart datafeed router so they can never disagree on what a venue is.
//
// Symbol convention: Hyperliquid pairs keep their existing bare form
// ("BTC", "HYPE", freqtrade "BTC/USDC:USDC"). Lighter markets are always
// carried with the "LIGHTER:" prefix ("LIGHTER:BTC-PERP") — the datafeed
// router dispatches on that prefix and strips it before hitting zklighter.

export type Venue = "hyperliquid" | "lighter";

export const VENUES: Record<
  Venue,
  {
    /** Display name shown in the picker dropdown, chart legend, deploy button. */
    label: string;
    /** TradingView `exchange` / `listed_exchange` value. */
    chartExchange: string;
    /** Venue-level fee badge — venue truth only, never per-pair math. */
    feeBadge: string;
    /** Runtime that executes live deployments on this venue. */
    runtime: "freqtrade" | "nautilus-pyo3";
  }
> = {
  hyperliquid: {
    label: "Hyperliquid",
    chartExchange: "Hyperliquid",
    // Builder fee is the platform's venue-level cost; env-driven so it can
    // never drift from what the API actually configures. apps/web sets this
    // env WITH a trailing percent sign ("1%") while bare numbers are also in
    // use — normalize both so the badge never renders "1%%".
    feeBadge: `${(process.env.NEXT_PUBLIC_HL_BUILDER_FEE ?? "0.04").replace(/%\s*$/, "")}% builder`,
    runtime: "freqtrade",
  },
  lighter: {
    label: "Lighter",
    chartExchange: "Lighter",
    feeBadge: "0 fees",
    runtime: "nautilus-pyo3",
  },
};

export const LIGHTER_SYMBOL_PREFIX = "LIGHTER:";

export function venueOfSymbol(symbol: string): Venue {
  return symbol.startsWith(LIGHTER_SYMBOL_PREFIX) ? "lighter" : "hyperliquid";
}

/** "LIGHTER:BTC-PERP" → "BTC-PERP"; passes non-lighter symbols through. */
export function stripVenuePrefix(symbol: string): string {
  return symbol.startsWith(LIGHTER_SYMBOL_PREFIX)
    ? symbol.slice(LIGHTER_SYMBOL_PREFIX.length)
    : symbol;
}

export function toLighterSymbol(market: string): string {
  return `${LIGHTER_SYMBOL_PREFIX}${market}`;
}

/** Client-side feature gate for everything Lighter-facing in the UI. */
export function lighterUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_LIGHTER_EXCHANGE === "true";
}
