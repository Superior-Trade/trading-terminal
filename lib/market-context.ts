/** Derivatives + measured-range context for a symbol — extracted from the
 *  detect route so the CHAT agent reads the exact same numbers through its
 *  market_pulse tool (one brain, one market read).
 *
 *  The range diagnostic is MEASURED, not vibes: last 120×1h candles →
 *  Kaufman efficiency ratio (net move ÷ path length; low = choppy) and
 *  alternating touches of the top/bottom quartiles (real two-sided
 *  rotation). Only an UNAMBIGUOUS range (low efficiency + 4+ alternating
 *  touches) sets rangeBound — callers use that as a neutral-plan coverage
 *  guarantee, so it must never fire on a slow trend. */
export async function marketContext(
  symbol: string | undefined,
): Promise<{ text: string; rangeBound: boolean }> {
  if (!symbol) return { text: "", rangeBound: false };
  try {
    const coin = symbol.includes(":")
      ? symbol
      : symbol.replace(/[-/](USD|USDC)$/i, "");
    const dex = coin.includes(":") ? coin.split(":")[0] : undefined;
    const r = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) }),
    });
    const [meta, ctxs] = (await r.json()) as [
      { universe: Array<{ name: string }> },
      Array<{
        funding?: string;
        openInterest?: string;
        dayNtlVlm?: string;
        midPx?: string;
        markPx?: string;
        prevDayPx?: string;
        premium?: string;
      }>,
    ];
    const i = meta.universe.findIndex(
      (u) => u.name.toLowerCase() === coin.toLowerCase(),
    );
    if (i < 0 || !ctxs[i]) return { text: "", rangeBound: false };
    const c = ctxs[i];
    const mid = parseFloat(c.midPx ?? c.markPx ?? "0");
    const prev = parseFloat(c.prevDayPx ?? "0");
    const fundingHr = parseFloat(c.funding ?? "0");
    const oiUsd = parseFloat(c.openInterest ?? "0") * mid;
    const chgPct = prev ? ((mid - prev) / prev) * 100 : null;
    let rangeBound = false;
    let rangeHint = "range check: unavailable";
    try {
      const end = Date.now();
      const candles = (await (
        await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "candleSnapshot",
            req: { coin, interval: "1h", startTime: end - 120 * 3_600_000, endTime: end },
          }),
        })
      ).json()) as Array<{ h: string; l: string; c: string; o: string }>;
      if (Array.isArray(candles) && candles.length >= 40) {
        const closes = candles.map((k) => parseFloat(k.c));
        const highs = candles.map((k) => parseFloat(k.h));
        const lows = candles.map((k) => parseFloat(k.l));
        const hi = Math.max(...highs);
        const lo = Math.min(...lows);
        const widthPct = ((hi - lo) / mid) * 100;
        const net = Math.abs(closes[closes.length - 1] - closes[0]);
        const path = closes.slice(1).reduce((s, v, j) => s + Math.abs(v - closes[j]), 0);
        const efficiency = path > 0 ? net / path : 1;
        // Alternating quartile touches = genuine rotation between bounds.
        const topQ = hi - (hi - lo) * 0.25;
        const botQ = lo + (hi - lo) * 0.25;
        let touches = 0;
        let last: "top" | "bot" | null = null;
        for (let j = 0; j < candles.length; j++) {
          const zone = highs[j] >= topQ ? "top" : lows[j] <= botQ ? "bot" : null;
          if (zone && zone !== last) {
            touches++;
            last = zone;
          }
        }
        rangeBound = efficiency < 0.25 && touches >= 4;
        rangeHint = `range diagnostic (last 120×1h): width ${widthPct.toFixed(1)}%, efficiency ratio ${efficiency.toFixed(2)} (low = choppy), ${touches} alternating bound touches → ${
          rangeBound
            ? "CLEAR RANGE — include a neutral rotation plan."
            : efficiency > 0.5
              ? "trending — directional plans fit."
              : "mixed/undecided — judge from the chart."
        }`;
      }
    } catch {
      /* diagnostic is a bonus */
    }
    return {
      rangeBound,
      text: `\n=== DERIVATIVES CONTEXT (live, weigh per the rubric's crypto-perp gates) ===\nfunding: ${(fundingHr * 100).toFixed(4)}%/hr (${(fundingHr * 24 * 365 * 100).toFixed(1)}% APR — positive = longs pay)\nopen interest: $${Math.round(oiUsd).toLocaleString("en-US")}\n24h volume: $${Math.round(parseFloat(c.dayNtlVlm ?? "0")).toLocaleString("en-US")}\n24h change: ${chgPct !== null ? chgPct.toFixed(2) : "?"}%\npremium vs oracle: ${c.premium ?? "?"}\n${rangeHint}\n`,
    };
  } catch {
    return { text: "", rangeBound: false }; // context is a bonus, never a blocker
  }
}
