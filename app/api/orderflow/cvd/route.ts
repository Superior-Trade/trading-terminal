import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { currentAccount } from "../../../../lib/account";
import { getDb } from "../../../../lib/db";
import { ensureRecording } from "../../../../lib/orderflow-recorder";

export const runtime = "nodejs";

// GET /api/orderflow/cvd?coin=BTC&from=ms&to=ms&res=minutes
//
// Per-bar aggressive volume delta + cumulative volume delta (CVD) from the
// of_bins footprint store (collector worker + web recorders, 5-min buckets,
// 7-day retention). `res` groups the 5-min buckets into chart-resolution
// bars (5/15/30/60/240…). The CVD baseline is the SUM of all deltas BEFORE
// `from`, so panning the chart never re-anchors the curve mid-history.
export async function GET(req: Request) {
  try {
    await currentAccount();
    const url = new URL(req.url);
    const coin = url.searchParams.get("coin");
    if (!coin) return NextResponse.json({ error: "coin required" }, { status: 400 });
    const now = Date.now();
    const to = Number(url.searchParams.get("to")) || now;
    const from = Number(url.searchParams.get("from")) || to - 24 * 3600_000;
    const resMin = Math.max(5, Math.min(1440, Number(url.searchParams.get("res")) || 5));
    const barMs = resMin * 60_000;

    // Same double-count guard as /api/orderflow: web instances only record
    // coins the always-on collector doesn't cover.
    const collectorCoins = (process.env.COLLECTOR_COINS ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (!collectorCoins.includes(coin)) void ensureRecording(coin);

    // Per-5m-bucket sums (finest grain) + the pre-range baseline delta
    // (CVD anchor) + earliest recorded bucket. Bars aggregate in JS so we
    // can walk the cumulative path THROUGH each bar's sub-buckets — that
    // intrabar high/low is what renders as candle wicks (absorption shows
    // as a long wick the way TV's own CVD study draws it).
    const db = getDb();
    const rows = (await db.execute(sql`
      SELECT bucket AS t,
             SUM(buy)  AS buy,
             SUM(sell) AS sell
      FROM of_bins
      WHERE coin = ${coin} AND bucket >= ${from} AND bucket < ${to}
      GROUP BY 1 ORDER BY 1
    `)) as unknown as { rows: Array<{ t: string; buy: string; sell: string }> };
    const base = (await db.execute(sql`
      SELECT COALESCE(SUM(buy) - SUM(sell), 0) AS baseline,
             MIN(bucket) AS earliest
      FROM of_bins WHERE coin = ${coin} AND bucket < ${from}
    `)) as unknown as { rows: Array<{ baseline: string; earliest: string | null }> };

    let cvd = Number(base.rows[0]?.baseline ?? 0);
    interface CvdBar {
      t: number;
      delta: number;
      cvd: number;
      o: number;
      h: number;
      l: number;
      buy: number;
      sell: number;
    }
    const bars: CvdBar[] = [];
    for (const r of rows.rows) {
      const bucket = Number(r.t);
      const buy = Number(r.buy);
      const sell = Number(r.sell);
      const barT = Math.floor(bucket / barMs) * barMs;
      let bar = bars[bars.length - 1];
      if (!bar || bar.t !== barT) {
        bar = { t: barT, delta: 0, cvd, o: cvd, h: cvd, l: cvd, buy: 0, sell: 0 };
        bars.push(bar);
      }
      cvd += buy - sell;
      bar.delta += buy - sell;
      bar.cvd = cvd;
      bar.h = Math.max(bar.h, cvd);
      bar.l = Math.min(bar.l, cvd);
      bar.buy += buy;
      bar.sell += sell;
    }
    for (const b of bars) {
      b.delta = Math.round(b.delta);
      b.cvd = Math.round(b.cvd);
      b.o = Math.round(b.o);
      b.h = Math.round(b.h);
      b.l = Math.round(b.l);
      b.buy = Math.round(b.buy);
      b.sell = Math.round(b.sell);
    }
    return NextResponse.json({
      coin,
      res: resMin,
      bars,
      earliest: base.rows[0]?.earliest ? Number(base.rows[0].earliest) : bars[0]?.t ?? null,
      now,
    });
  } catch (err) {
    if (err instanceof Response) return err;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "cvd error" },
      { status: 500 },
    );
  }
}
