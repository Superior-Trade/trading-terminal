import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "../../../lib/db";

/* Market positioning intel — READS the market_positioning table that the
 * always-on collector refreshes from HyperTracker's positions/heatmap.
 *
 * Why not fetch HyperTracker here: the free tier is 100 req/day, shared with
 * the collector's liq snapshotter. This route runs on serverless — every cold
 * start is a fresh process, so a per-request in-memory cache doesn't survive
 * and each cold invocation would re-hit upstream and 429. Centralizing the
 * fetch in the collector (one all-markets call, hourly) keeps us in quota and
 * makes this route a pure DB read.
 *
 * The signal is account COUNTS, not values: long/short *value* nets to ~50/50
 * on every coin by construction (matched OI). Per coin we surface crowd long %
 * plus cohort splits (smart / whale / retail / rekt); the interesting bit is
 * the divergence between profitable and losing cohorts.
 */

type Split = { long: number; short: number; pct: number | null };

function split(long: number, short: number): Split {
  const tot = long + short;
  return { long, short, pct: tot > 0 ? long / tot : null };
}

// Match an app pair/coin ("BTC-USD", "XYZ-SPCX", "kPEPE", "HYPE") to a stored
// coin key. Rows are keyed by HyperTracker's coin symbol (e.g. "BTC").
const norm = (s: string) =>
  s.toLowerCase().replace(/[-/]/g, ":").replace(/:usdc?$/, "");

export async function GET(req: NextRequest) {
  const coin = req.nextUrl.searchParams.get("coin");
  if (!coin) {
    return NextResponse.json({ error: "coin required" }, { status: 400 });
  }

  // No DB configured (local dev without DATABASE_URL) → pill hides itself.
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ available: false }, { status: 200 });
  }

  const candidates = [coin, coin.split("-")[0] ?? coin, coin.replace("-", ":")];
  const wanted = new Set(candidates.map(norm));

  try {
    const db = getDb();
    const rows = await db.select().from(schema.marketPositioning);
    // Small table (a few hundred coins); resolve the symbol match in-process
    // so pair/coin normalization stays identical to the rest of the app.
    const hit = rows.find((r) => wanted.has(norm(r.coin))) ?? null;
    if (!hit) {
      return NextResponse.json({ available: false, coin }, { status: 200 });
    }
    return NextResponse.json(
      {
        available: true,
        coin: hit.coin,
        count: hit.count,
        crowd: split(hit.crowdLong, hit.crowdShort),
        smart: split(hit.smartLong, hit.smartShort),
        whale: split(hit.whaleLong, hit.whaleShort),
        retail: split(hit.retailLong, hit.retailShort),
        rekt: split(hit.rektLong, hit.rektShort),
        updatedAt: hit.updatedAt,
      },
      { status: 200 },
    );
  } catch {
    return NextResponse.json({ available: false }, { status: 200 });
  }
}
