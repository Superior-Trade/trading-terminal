import { NextResponse } from "next/server";
import { currentAccount } from "../../../lib/account";
import { ensureRecording, readCells } from "../../../lib/orderflow-recorder";

export const runtime = "nodejs";

// GET /api/orderflow?coin=BTC[&from=ms] → aggregated footprint cells,
// merged from this instance's in-memory recorder and Postgres history
// (memory wins). The call also starts recording the coin on this instance —
// history accrues while clients keep a coin's footprint open.

export async function GET(req: Request) {
  try {
    await currentAccount();
    const url = new URL(req.url);
    const coin = url.searchParams.get("coin");
    if (!coin) return NextResponse.json({ error: "coin required" }, { status: 400 });
    const from = Number(url.searchParams.get("from")) || Date.now() - 24 * 3600_000;
    // Coins covered by the always-on collector worker (apps/collector) must
    // NOT be recorded here too — two recorders on one coin double-count
    // volume. Web instances only record coins the collector doesn't cover.
    const collectorCoins = (process.env.COLLECTOR_COINS ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (!collectorCoins.includes(coin)) void ensureRecording(coin);
    const { binSize, startedAt, cells } = await readCells(coin, from);
    return NextResponse.json({ binSize, startedAt, cells, now: Date.now() });
  } catch (err) {
    if (err instanceof Response) return err;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "orderflow error" },
      { status: 500 },
    );
  }
}
