import { NextResponse } from "next/server";
import { tickPaper } from "../../../../lib/paper/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Once-a-minute paper tick, knocked by lib/auto-trade/scheduler.ts. Does
// nothing until a paper account is started; decides at most once per UTC day.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  void tickPaper().catch((err) =>
    console.error("[paper] tick failed:", err instanceof Error ? err.message : err),
  );
  return NextResponse.json({ ok: true }, { status: 202 });
}
