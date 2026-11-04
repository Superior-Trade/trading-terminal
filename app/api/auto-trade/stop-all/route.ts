import { NextResponse } from "next/server";
import { stopAll } from "../../../../lib/auto-trade/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Kill switch for auto mode: turns it off, closes positions and stops every
// bot it started. Bots you deployed by hand are not touched.
export async function POST() {
  try {
    return NextResponse.json(await stopAll());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "stop-all error" },
      { status: 502 },
    );
  }
}
