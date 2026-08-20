// Server-side snapshot of the LIVE Hyperliquid perp + HIP-3 market universe,
// as the set of canonical freqtrade pairs ("BTC/USDC:USDC", "XYZ-TSLA/USDC:USDC").
//
// Used at compile time to REJECT a strategy whose pair doesn't resolve to a
// real, listed market — the deterministic backstop for every dead-pair class
// (malformed quote/settle, dropped HIP-3 dex prefix, delisted, spot-only).
// A funded bot on an unresolvable pair silently trades nothing; failing the
// compile surfaces it before any money moves.

const HL_INFO = "https://api.hyperliquid.xyz/info";
const TTL_MS = 5 * 60 * 1000;

let cache: { at: number; pairs: Set<string> } | null = null;

async function post(body: unknown): Promise<unknown> {
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // compile is not latency-critical; keep it snappy but not hair-trigger
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`HL info ${r.status}`);
  return r.json();
}

/** Canonical pair set for all live HL perps (main dex) + HIP-3 builder dexes.
 *  Cached for TTL_MS. Throws if the base perp meta can't be fetched (caller
 *  should treat a throw as "can't validate" and skip the gate, never block). */
export async function liveHlPairs(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.pairs;
  const pairs = new Set<string>();
  const meta = (await post({ type: "meta" })) as {
    universe?: Array<{ name: string; isDelisted?: boolean }>;
  };
  for (const u of meta.universe ?? [])
    if (!u.isDelisted) pairs.add(`${u.name.toUpperCase()}/USDC:USDC`);
  // HIP-3 builder-deployed dexes (best-effort; a failure here still leaves the
  // main-perp set usable).
  try {
    const dexs = (await post({ type: "perpDexs" })) as Array<{ name?: string }>;
    for (const d of Array.isArray(dexs) ? dexs : []) {
      if (!d?.name) continue;
      try {
        const m = (await post({ type: "meta", dex: d.name })) as {
          universe?: Array<{ name: string; isDelisted?: boolean }>;
        };
        for (const u of m.universe ?? [])
          if (!u.isDelisted)
            pairs.add(`${d.name.toUpperCase()}-${u.name.toUpperCase()}/USDC:USDC`);
      } catch {
        /* skip this dex */
      }
    }
  } catch {
    /* no HIP-3 markets this refresh — main perps still validated */
  }
  cache = { at: Date.now(), pairs };
  return pairs;
}
