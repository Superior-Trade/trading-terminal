import { NextResponse } from "next/server";
import { runAutoCycle } from "../../../../lib/auto-trade/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Run now" from the panel. A run takes minutes (detect, compile and a real
// backtest per pair), so this starts it and returns; the panel follows the log.
// While auto mode is off this is always a dry run (see engine.ts).
export async function POST() {
  void runAutoCycle("manual").catch((err) =>
    console.error("[auto-trade] manual run failed:", err instanceof Error ? err.message : err),
  );
  return NextResponse.json({ started: true }, { status: 202 });
}
