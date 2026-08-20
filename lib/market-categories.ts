// Market taxonomy for the pair picker.
//
// PRIMARY grouping is by ASSET CLASS, not by venue: HIP-3 dexes mix
// instrument types (xyz = mostly US equities + GOLD + an index; para =
// crypto-dominance indices + AVGO; mkts = US500/USTECH), so dex tabs told
// a trader nothing. Classification = small curated sets + per-dex
// defaults, so new listings self-classify (unknown xyz ticker → Stocks).
//
// SECONDARY (inside Crypto only): a trimmed thematic chip row — Majors /
// Meme / AI. HL's public API exposes no tag data, so these stay curated.
// Categories are cosmetic; evals/markets.mjs guards pair COVERAGE.

export const ASSET_CLASSES = ["Crypto", "Stocks", "Indices", "Commodities", "FX"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

// Index products across dexes (equity indices + crypto-dominance baskets).
const INDICES = new Set([
  "XYZ100", "US500", "USTECH", "TOTAL2", "OTHERS", "BTCD",
  "SP500", "KR200", "JP225",
]);
const COMMODITIES = new Set([
  "GOLD", "SILVER", "OIL", "XAU", "XAG", "WTI", "NATGAS", "COPPER",
  "CL", "BRENTOIL", "PLATINUM", "PALLADIUM", "DRAM",
]);
const FX = new Set(["JPY", "EUR", "GBP", "CHF", "AUD", "CNH", "KRW"]);
// Equities listed outside the equities-focused dex.
const STOCK_OVERRIDES = new Set(["AVGO"]);
// Dexes whose default listing type is equities (incl. equity ETFs like
// EWY/XLE/SMH, which stay under Stocks).
const EQUITY_DEXES = new Set(["xyz"]);

/** Base ticker without the HIP-3 dex prefix ("xyz:TSLA" → "TSLA"). */
export function baseTicker(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

export function assetClass(name: string, dex?: string | null): AssetClass {
  const base = baseTicker(name).toUpperCase();
  if (INDICES.has(base)) return "Indices";
  if (COMMODITIES.has(base)) return "Commodities";
  if (FX.has(base)) return "FX";
  if (STOCK_OVERRIDES.has(base)) return "Stocks";
  if (dex && EQUITY_DEXES.has(dex)) return "Stocks";
  return "Crypto";
}

export const CRYPTO_TAGS = ["Majors", "Meme", "AI"] as const;
export type CryptoTag = (typeof CRYPTO_TAGS)[number];

const TAG_MAP: Record<CryptoTag, string[]> = {
  Majors: [
    "BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "LTC",
    "BCH", "SUI", "HYPE", "TON", "DOT", "TRX", "NEAR", "APT", "XMR", "ZEC",
  ],
  Meme: [
    "DOGE", "kSHIB", "WIF", "kPEPE", "kBONK", "FARTCOIN", "POPCAT", "TRUMP",
    "MELANIA", "MOODENG", "PNUT", "GOAT", "MEW", "BRETT", "kNEIRO", "TURBO",
    "SPX", "PENGU", "DOOD", "PURR", "JELLY", "CHILLGUY", "HPOS", "BOME",
    "MEME", "kFLOKI", "kLUNC", "BABY", "USELESS", "PUMP",
  ],
  AI: [
    "TAO", "FET", "RENDER", "WLD", "AI16Z", "VIRTUAL", "AIXBT", "GRIFFAIN",
    "IO", "ARKM", "PROMPT", "KAITO", "GRASS", "AVA", "ZEREBRO", "GOAT",
  ],
};

const TAG_SETS: Record<CryptoTag, Set<string>> = Object.fromEntries(
  CRYPTO_TAGS.map((c) => [c, new Set(TAG_MAP[c])]),
) as Record<CryptoTag, Set<string>>;

/** Tag check on the BASE ticker, so hyna:BTC counts as a Major too. */
export function hasCryptoTag(coinName: string, tag: CryptoTag): boolean {
  return TAG_SETS[tag].has(baseTicker(coinName));
}

// SECONDARY (inside Stocks only): thematic chip row, same idea as Crypto's.
// The equity universe here skews tech/semi/AI (a crypto-native audience
// trading stocks), so those get first-class chips; Crypto = crypto-linked
// equities (COIN/MSTR/…), EV = autos + space/frontier hardware. Overlap is
// fine (NVDA is both a semi and an AI name), mirroring the crypto tags.
export const STOCK_TAGS = ["Tech", "Semis", "AI", "Crypto", "EV"] as const;
export type StockTag = (typeof STOCK_TAGS)[number];

const STOCK_TAG_MAP: Record<StockTag, string[]> = {
  Tech: [
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NFLX", "ORCL", "NOW", "IBM",
    "DELL", "ZM", "EBAY", "BABA", "NOK", "BB", "SOFTBANK",
  ],
  Semis: [
    "NVDA", "AMD", "AVGO", "TSM", "ASML", "MU", "MRVL", "QCOM", "INTC", "ARM",
    "AMAT", "SKHX", "SNDK", "WDC", "KIOXIA", "SMSN", "CBRS", "IBIDEN", "LITE",
    "SMH",
  ],
  AI: [
    "NVDA", "PLTR", "CRWV", "NBIS", "BIRD", "MINIMAX", "ZHIPU", "SHAZ", "QNT",
    "BOT", "CBRS",
  ],
  Crypto: ["COIN", "MSTR", "CRCL", "HOOD", "STRC", "PURRDAT"],
  EV: ["TSLA", "RIVN", "RKLB", "SPCX", "HYUNDAI"],
};

const STOCK_TAG_SETS: Record<StockTag, Set<string>> = Object.fromEntries(
  STOCK_TAGS.map((c) => [c, new Set(STOCK_TAG_MAP[c])]),
) as Record<StockTag, Set<string>>;

/** Tag check on the BASE ticker, so xyz:NVDA matches the Semis chip. */
export function hasStockTag(coinName: string, tag: StockTag): boolean {
  return STOCK_TAG_SETS[tag].has(baseTicker(coinName));
}
