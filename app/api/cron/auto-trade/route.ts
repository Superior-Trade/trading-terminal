import { NextResponse } from "next/server";
import { currentAccount } from "../../../../lib/account";
import { loadSettings } from "../../../../lib/auto-trade/settings";
import { lastRunAt, runAutoCycle } from "../../../../lib/auto-trade/engine";

export const runtime = "nodejs";
// Never cache — this can deploy.
export const dynamic = "force-dynamic";

// Scheduled auto-mode scan. Safe to hit every minute: it does nothing while
// auto mode is off, or until intervalMinutes have passed since the last run.
//
// The terminal calls this itself once a minute (lib/auto-trade/scheduler.ts,
// started from instrumentation.ts). To drive it from outside instead, set
// AUTO_TRADE_SCHEDULER=off and point a cron at it, like the one-shot sweep:
//   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3200/api/cron/auto-trade
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = await currentAccount();
  const s = await loadSettings(user.id);
  if (!s.enabled) return NextResponse.json({ ran: false, reason: "auto mode is off" });
  const last = await lastRunAt(user.id);
  if (last && Date.now() - last < s.intervalMinutes * 60_000) {
    return NextResponse.json({ ran: false, reason: "not due", nextAt: last + s.intervalMinutes * 60_000 });
  }
  void runAutoCycle("schedule").catch((err) =>
    console.error("[auto-trade] scheduled run failed:", err instanceof Error ? err.message : err),
  );
  return NextResponse.json({ ran: true }, { status: 202 });
}
