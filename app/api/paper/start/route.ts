import { NextResponse } from "next/server";
import { startPaper } from "../../../../lib/paper/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/paper/start {startingUsd?} → a fresh paper account (default $100).
// Replaces any existing paper account; the panel confirms first.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { startingUsd?: unknown };
  const usd = body.startingUsd === undefined ? 100 : Number(body.startingUsd);
  if (!Number.isFinite(usd) || usd < 10 || usd > 1_000_000) {
    return NextResponse.json({ error: "startingUsd must be between 10 and 1,000,000" }, { status: 400 });
  }
  try {
    return NextResponse.json({ state: await startPaper(usd) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "paper start error" },
      { status: 500 },
    );
  }
}
