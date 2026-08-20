import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "../../../lib/db";

/* Liquidation heatmap for one coin. Price bins with the notional value near
 * liquidation at each level — drawn as horizontal intensity bands over the
 * TradingView chart.
 *
 * Data comes from the always-on collector worker (apps/collector), which is
 * the SINGLE HyperTracker client: it snapshots liq_levels on a fixed cadence
 * so the whole app's HyperTracker footprint is one budgeted process, well
 * under the free 100 req/day. This route just reads liq_levels — no vendor
 * call, no per-view quota drain, and it works on Vercel with only
 * DATABASE_URL set (no HyperTracker key needed in the web app).
 *
 * Live fallback: if a coin has no collector rows AND a key is configured
 * (local dev, or a coin the collector doesn't cover), fetch HyperTracker
 * directly and stamp first_seen — same 15-min per-coin cache as before.
 */

const BASE =
  "https://ht-api.coinmarketman.com/api/external/exports/coins";
const TTL_MS = 15 * 60 * 1000;

type Bin = {
  priceBinStart: number;
  priceBinEnd: number;
  liquidationValue: number;
  positionsCount: number;
  /** Epoch ms when WE first observed liquidity in this bin (needs a DB). */
  firstSeen?: number;
};

const cache = new Map<string, { at: number; bins: Bin[] }>();
const inflight = new Map<string, Promise<Bin[]>>();

// App pair ("BTC-USD", "XYZ-SPCX", "kPEPE-USD") → HyperTracker coin key.
// HIP-3 builder-dex markets are lowercase-prefixed "xyz:TICKER"; HL meme
// 1000x coins keep their native "k" prefix.
function coinKey(raw: string): string {
  const base = raw.split("-USD")[0].split("/")[0].trim();
  if (/^xyz[-:]/i.test(base)) return `xyz:${base.slice(4).toUpperCase()}`;
  return base;
}

async function loadBins(key: string, coin: string): Promise<Bin[]> {
  const res = await fetch(
    `${BASE}/${encodeURIComponent(coin)}/liquidation-heatmap`,
    {
      headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
      cache: "no-store",
    },
  );
  if (!res.ok) throw new Error(`liq-heatmap ${coin}: ${res.status}`);
  const json = (await res.json()) as { heatmap?: Bin[] };
  return (json.heatmap ?? [])
    .filter((b) => b.liquidationValue > 0 && b.priceBinEnd > 0)
    .map((b) => ({
      priceBinStart: b.priceBinStart,
      priceBinEnd: b.priceBinEnd,
      liquidationValue: b.liquidationValue,
      positionsCount: b.positionsCount,
    }));
}

// Persist a snapshot and stamp each bin with when WE first saw liquidity
// there — the formation-time anchor for heatmap bar lengths (Coinglass shows
// model-estimated ages; ours are real positions, accumulating from deploy
// day). Best-effort: no DATABASE_URL (local dev) or a DB hiccup just means
// bins go out unstamped and the client falls back to size-cue lengths.
// Known limitation: a level that gets liquidated and later RE-forms keeps
// its original first_seen (viewing gaps are indistinguishable from absence).
async function stampFirstSeen(coin: string, bins: Bin[]): Promise<Bin[]> {
  if (!process.env.DATABASE_URL || !bins.length) return bins;
  try {
    const db = getDb();
    const now = Date.now();
    const rows = bins.map((b) => ({
      coin,
      binStart: b.priceBinStart,
      binEnd: b.priceBinEnd,
      firstSeen: now,
      lastSeen: now,
      value: b.liquidationValue,
      positionsCount: b.positionsCount,
    }));
    // Chunked upsert — 333 bins × 7 params stays under driver limits.
    for (let i = 0; i < rows.length; i += 100) {
      await db
        .insert(schema.liqLevels)
        .values(rows.slice(i, i + 100))
        .onConflictDoUpdate({
          target: [schema.liqLevels.coin, schema.liqLevels.binStart],
          set: {
            lastSeen: now,
            binEnd: sql`excluded.bin_end`,
            value: sql`excluded.value`,
            positionsCount: sql`excluded.positions_count`,
          },
        });
    }
    const seen = await db
      .select({
        binStart: schema.liqLevels.binStart,
        firstSeen: schema.liqLevels.firstSeen,
      })
      .from(schema.liqLevels)
      .where(eq(schema.liqLevels.coin, coin));
    const m = new Map(seen.map((r) => [r.binStart, r.firstSeen]));
    return bins.map((b) => ({ ...b, firstSeen: m.get(b.priceBinStart) }));
  } catch {
    return bins;
  }
}

// Read collector-maintained levels for a coin. Returns null if there's no DB
// or no rows yet (→ caller falls back to a live fetch).
async function readCollectorBins(coin: string): Promise<Bin[] | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const db = getDb();
    const rows = await db
      .select({
        priceBinStart: schema.liqLevels.binStart,
        priceBinEnd: schema.liqLevels.binEnd,
        liquidationValue: schema.liqLevels.value,
        positionsCount: schema.liqLevels.positionsCount,
        firstSeen: schema.liqLevels.firstSeen,
      })
      .from(schema.liqLevels)
      .where(eq(schema.liqLevels.coin, coin));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("coin");
  if (!raw) {
    return NextResponse.json({ error: "coin required" }, { status: 400 });
  }
  const coin = coinKey(raw);

  // Preferred path: read the collector's snapshot (no HyperTracker call).
  const fromDb = await readCollectorBins(coin);
  if (fromDb) {
    return NextResponse.json({ available: true, coin, bins: fromDb, source: "collector" });
  }

  // Fallback: live fetch for coins the collector doesn't cover (needs a key).
  const apiKey = process.env.COINMARKETMAN_API_KEY;
  if (!apiKey) return NextResponse.json({ available: false, coin });

  const hit = cache.get(coin);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json({ available: true, coin, bins: hit.bins });
  }
  let p = inflight.get(coin);
  if (!p) {
    p = loadBins(apiKey, coin).finally(() => inflight.delete(coin));
    inflight.set(coin, p);
  }
  try {
    const bins = await stampFirstSeen(coin, await p);
    cache.set(coin, { at: Date.now(), bins });
    return NextResponse.json({ available: true, coin, bins });
  } catch {
    // Unknown coin or upstream failure: serve stale if we have it.
    if (hit) {
      return NextResponse.json({ available: true, coin, bins: hit.bins });
    }
    return NextResponse.json({ available: false, coin });
  }
}
