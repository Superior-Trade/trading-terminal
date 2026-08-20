// Server-side order-flow tape recorder. Hyperliquid's live trades WS is the
// only free real-time tape (full history lives in requester-pays S3 —
// s3://hl-mainnet-node-data/node_trades — wired up separately when AWS creds
// exist). This module subscribes per coin and aggregates footprint cells
// (5m bucket × price bin → buy/sell notional), so the footprint panel gets
// history for any coin that has been watched.
//
// Persistence, serverless edition (the original used better-sqlite3): the
// in-memory cell map is the hot store — authoritative within a warm function
// instance — and unflushed DELTAS are pushed to Neon periodically: a timer
// while the instance is warm, plus an opportunistic flush on every API hit
// for instances whose timers were frozen between invocations. Flushes are
// additive (buy = buy + excluded.buy), so several instances recording the
// same coin each contribute their own deltas instead of clobbering each
// other. On cold start an instance simply resumes recording; history comes
// from Postgres. Local dev without DATABASE_URL records in memory only
// (nothing persists across restarts), which is fine.

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getSubscriptionClient } from "./hyperliquid-clients";

const BUCKET_MS = 5 * 60_000;
const RETENTION_MS = 7 * 24 * 3600_000;
const HYDRATE_MS = 24 * 3600_000; // how much history to pull into memory
const FLUSH_MS = 45_000; // background timer cadence (warm instances)
const FLUSH_MIN_GAP_MS = 30_000; // opportunistic on-hit flush throttle

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * pow;
}

type Cell = { buy: number; sell: number };

interface Recorder {
  subs: Map<string, boolean>;
  /** coin|bucket|bin → totals known to this instance (DB baseline + live). */
  cells: Map<string, Cell>;
  /** coin|bucket|bin → accumulated since the last successful flush. */
  deltas: Map<string, Cell>;
  meta: Map<string, { binSize: number; startedAt: number }>;
  flushing: boolean;
  lastFlushAt: number;
  lastPruneAt: number;
}

// Module-level singleton survives route invocations within one warm
// instance; Postgres survives everything else.
const g = globalThis as unknown as { __ofRecorder?: Recorder };

function getRecorder(): Recorder {
  if (g.__ofRecorder) return g.__ofRecorder;
  const rec: Recorder = {
    subs: new Map(),
    cells: new Map(),
    deltas: new Map(),
    meta: new Map(),
    flushing: false,
    lastFlushAt: 0,
    lastPruneAt: 0,
  };
  // Flush while warm; unref so it never pins a local dev process. Frozen
  // serverless timers are covered by the on-hit flush in readCells().
  const timer = setInterval(() => void flushDeltas(rec), FLUSH_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  g.__ofRecorder = rec;
  return rec;
}

// Pull the coin's recent history into memory so this instance serves a full
// picture immediately. Runs BEFORE subscribing, so live deltas can never be
// overwritten by stale DB rows (the additive merge below is belt-and-braces).
async function hydrate(rec: Recorder, coin: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const db = getDb();
    if (!rec.meta.has(coin)) {
      const m = await db
        .select()
        .from(schema.ofMeta)
        .where(eq(schema.ofMeta.coin, coin));
      if (m.length) {
        rec.meta.set(coin, { binSize: m[0].binSize, startedAt: m[0].startedAt });
      }
    }
    const rows = await db
      .select()
      .from(schema.ofBins)
      .where(
        and(
          eq(schema.ofBins.coin, coin),
          gte(schema.ofBins.bucket, Date.now() - HYDRATE_MS),
        ),
      );
    for (const row of rows) {
      const key = `${coin}|${row.bucket}|${row.bin}`;
      const local = rec.deltas.get(key);
      rec.cells.set(key, {
        buy: row.buy + (local?.buy ?? 0),
        sell: row.sell + (local?.sell ?? 0),
      });
    }
  } catch {
    /* memory-only until the next cold start */
  }
}

// First trade for a brand-new coin picks the bin size. Persist it, then
// adopt whatever actually landed in the DB — another instance may have won
// the race, and bin sizes must agree forever after.
async function persistMeta(
  rec: Recorder,
  coin: string,
  meta: { binSize: number; startedAt: number },
): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const db = getDb();
    await db.insert(schema.ofMeta).values({ coin, ...meta }).onConflictDoNothing();
    const m = await db
      .select()
      .from(schema.ofMeta)
      .where(eq(schema.ofMeta.coin, coin));
    if (m.length) {
      rec.meta.set(coin, { binSize: m[0].binSize, startedAt: m[0].startedAt });
    }
  } catch {
    /* meta best-effort */
  }
}

// Push unflushed deltas as an additive upsert. On failure only the chunks
// that didn't make it are re-queued (merged with anything that accumulated
// during the flush), so nothing is lost and already-applied chunks aren't
// double-counted.
async function flushDeltas(rec: Recorder): Promise<void> {
  if (rec.flushing || !rec.deltas.size || !process.env.DATABASE_URL) return;
  rec.flushing = true;
  const entries = [...rec.deltas.entries()];
  rec.deltas.clear();
  const rows = entries.map(([key, v]) => {
    const [coin, bucket, bin] = key.split("|");
    return { coin, bucket: Number(bucket), bin: Number(bin), buy: v.buy, sell: v.sell };
  });
  let i = 0;
  try {
    const db = getDb();
    // Chunked — 100 rows × 5 params stays well under driver limits.
    for (; i < rows.length; i += 100) {
      await db
        .insert(schema.ofBins)
        .values(rows.slice(i, i + 100))
        .onConflictDoUpdate({
          target: [schema.ofBins.coin, schema.ofBins.bucket, schema.ofBins.bin],
          set: {
            buy: sql`${schema.ofBins.buy} + excluded.buy`,
            sell: sql`${schema.ofBins.sell} + excluded.sell`,
          },
        });
    }
    rec.lastFlushAt = Date.now();
    // Opportunistic retention sweep, at most hourly per instance.
    if (Date.now() - rec.lastPruneAt > 3600_000) {
      rec.lastPruneAt = Date.now();
      await db
        .delete(schema.ofBins)
        .where(lt(schema.ofBins.bucket, Date.now() - RETENTION_MS));
    }
  } catch {
    for (const row of rows.slice(i)) {
      const key = `${row.coin}|${row.bucket}|${row.bin}`;
      const cur = rec.deltas.get(key) ?? { buy: 0, sell: 0 };
      cur.buy += row.buy;
      cur.sell += row.sell;
      rec.deltas.set(key, cur);
    }
  } finally {
    rec.flushing = false;
  }
}

/** Ensure a live recording subscription exists for the coin. Idempotent. */
export async function ensureRecording(coin: string): Promise<void> {
  const rec = getRecorder();
  if (rec.subs.get(coin)) return;
  rec.subs.set(coin, true);
  try {
    await hydrate(rec, coin);
    await getSubscriptionClient().trades({ coin }, (trades) => {
      for (const tr of trades as Array<{ side: string; px: string; sz: string; time: number }>) {
        const px = parseFloat(tr.px);
        const notional = px * parseFloat(tr.sz);
        if (!Number.isFinite(notional) || notional <= 0) continue;
        let meta = rec.meta.get(coin);
        if (!meta) {
          meta = { binSize: niceStep(px * 0.00025), startedAt: Date.now() };
          rec.meta.set(coin, meta);
          void persistMeta(rec, coin, meta);
        }
        const bucket = Math.floor(tr.time / BUCKET_MS) * BUCKET_MS;
        const level = Math.floor(px / meta.binSize) * meta.binSize;
        const key = `${coin}|${bucket}|${level}`;
        for (const map of [rec.cells, rec.deltas]) {
          const cell = map.get(key) ?? { buy: 0, sell: 0 };
          if (tr.side === "B") cell.buy += notional;
          else cell.sell += notional;
          map.set(key, cell);
        }
      }
    });
  } catch {
    rec.subs.delete(coin); // retry on the next request
  }
}

export interface OfCell {
  bucket: number;
  bin: number;
  buy: number;
  sell: number;
}

/** Merged view for the API: Postgres history (older buckets, other
 *  instances' flushes) overlaid with this instance's in-memory cells —
 *  memory wins on conflicts, since it already carries the hydrated DB
 *  baseline plus live trades. Doubles as the flush hook for instances
 *  whose background timer was frozen between invocations. */
export async function readCells(
  coin: string,
  fromMs: number,
): Promise<{ binSize: number | null; startedAt: number | null; cells: OfCell[] }> {
  const rec = getRecorder();
  if (Date.now() - rec.lastFlushAt > FLUSH_MIN_GAP_MS) void flushDeltas(rec);
  let binSize = rec.meta.get(coin)?.binSize ?? null;
  let startedAt = rec.meta.get(coin)?.startedAt ?? null;
  const merged = new Map<string, OfCell>(); // "bucket|bin"
  if (process.env.DATABASE_URL) {
    try {
      const db = getDb();
      if (binSize == null) {
        const m = await db
          .select()
          .from(schema.ofMeta)
          .where(eq(schema.ofMeta.coin, coin));
        if (m.length) {
          binSize = m[0].binSize;
          startedAt = m[0].startedAt;
        }
      }
      const rows = await db
        .select()
        .from(schema.ofBins)
        .where(and(eq(schema.ofBins.coin, coin), gte(schema.ofBins.bucket, fromMs)));
      for (const r of rows) {
        merged.set(`${r.bucket}|${r.bin}`, {
          bucket: r.bucket,
          bin: r.bin,
          buy: r.buy,
          sell: r.sell,
        });
      }
    } catch {
      /* memory-only response */
    }
  }
  const prefix = `${coin}|`;
  for (const [key, cell] of rec.cells) {
    if (!key.startsWith(prefix)) continue;
    const [, bucketS, binS] = key.split("|");
    const bucket = Number(bucketS);
    if (bucket < fromMs) continue;
    merged.set(`${bucketS}|${binS}`, {
      bucket,
      bin: Number(binS),
      buy: cell.buy,
      sell: cell.sell,
    });
  }
  const cells = [...merged.values()].sort((a, b) => a.bucket - b.bucket || a.bin - b.bin);
  return { binSize, startedAt, cells };
}
