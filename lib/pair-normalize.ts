// Deterministic Hyperliquid perp pair normalizer.
//
// The compile step asks the model to emit `pair_whitelist: ["<BASE>/USDC:USDC"]`,
// but models don't always comply — a 2026-07-15 live deployment shipped
// "HYPE/USD:USD" (wrong quote AND settle) with stake_currency "USDC". ccxt/
// freqtrade can't resolve that symbol, drops the pair at startup, and the bot
// runs funded-but-idle, trading nothing. Nothing downstream caught it: the
// deploy path forwards pair_whitelist[0] verbatim and only checks it's
// non-empty.
//
// Every real Hyperliquid perp market settles in USDC. Across 400 recent
// deployments the quote/settle was ALWAYS `/USDC:USDC`; only the base varies:
//   standard perp   BTC        -> BTC/USDC:USDC
//   HIP-3 (dex xyz) xyz:SNDK   -> XYZ-SNDK/USDC:USDC   (chart uses "xyz:SNDK",
//                                                        freqtrade uses "XYZ-SNDK")
// So normalization is: keep the base, force the quote+settle to /USDC:USDC.

/** Canonicalize any single market string to its Hyperliquid perp pair. */
export function normalizePerpPair(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return s;
  let base: string;
  const slash = s.indexOf("/");
  if (slash >= 0) {
    // Quote/settle live after the first "/": "HYPE/USD:USD", "HYPE/USDC:USDC",
    // "HYPE/USDC", "XYZ-SNDK/USDC:USDC" — the base is everything before it.
    base = s.slice(0, slash);
  } else if (s.includes(":")) {
    // No "/", so a ":" is the HIP-3 dex separator, not a settle marker:
    // "xyz:SNDK" -> dex "xyz", coin "SNDK" -> canonical base "XYZ-SNDK".
    base = s.replace(":", "-");
  } else {
    // Bare coin or URL slug: "HYPE", "BTC-USD".
    base = s;
  }
  base = base.trim().toUpperCase();
  // A trailing "-USD"/"-USDC" on a slug base is a quote, not part of the coin
  // ("BTC-USD" -> "BTC"). A HIP-3 dex prefix ("XYZ-...") is never stripped.
  if (!base.startsWith("XYZ-")) base = base.replace(/-USDC?$/, "");
  return `${base}/USDC:USDC`;
}

/** Normalize a freqtrade config's pair_whitelist + stake_currency in place-safe
 *  fashion (returns the same object). No-op when the config shape is unexpected,
 *  so it can be applied defensively on any deploy path. */
export function normalizeConfigPairs<T extends Record<string, unknown>>(
  config: T,
): T {
  if (!config || typeof config !== "object") return config;
  const ex = (config as { exchange?: { pair_whitelist?: unknown } }).exchange;
  const wl = ex?.pair_whitelist;
  if (Array.isArray(wl)) {
    ex!.pair_whitelist = wl.map((p) =>
      typeof p === "string" ? normalizePerpPair(p) : p,
    );
  }
  // HL perps settle in USDC; a mismatched stake_currency (e.g. "USD") is
  // rejected by freqtrade even once the pair is right.
  const sc = (config as { stake_currency?: unknown }).stake_currency;
  if (typeof sc === "string" && sc.toUpperCase() !== "USDC") {
    (config as { stake_currency?: unknown }).stake_currency = "USDC";
  }
  return config;
}
