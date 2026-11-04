import { NextResponse } from "next/server";
import { resumePaper, stopPaper } from "../../../../lib/paper/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/paper/pause {paused: boolean}
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { paused?: unknown };
  if (typeof body.paused !== "boolean") {
    return NextResponse.json({ error: "paused must be true or false" }, { status: 400 });
  }
  await (body.paused ? stopPaper() : resumePaper());
  return NextResponse.json({ ok: true });
}
