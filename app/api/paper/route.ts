import { NextResponse } from "next/server";
import { paperStatus } from "../../../lib/paper/engine";
import { STRATEGY_INFO } from "../../../lib/paper/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/paper → the paper account marked to live prices, its decisions and
// equity curve, and the rule it trades. Virtual money only.
export async function GET() {
  try {
    return NextResponse.json({ strategy: STRATEGY_INFO, ...(await paperStatus()) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "paper status error" },
      { status: 500 },
    );
  }
}
