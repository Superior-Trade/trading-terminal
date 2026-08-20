import { NextResponse } from "next/server";
import { requireUser } from "../../../lib/server-auth";
import { logStrategy } from "../../../lib/strategy-log";

export const runtime = "nodejs";

// Client-side generations (the chat agent's suggest_plan tool executes in
// the browser) report here so the strategy_log audit stays complete.
// Server-side generations (detect, compile) log directly — not through this.
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json()) as { plan?: unknown; symbol?: string | null };
    if (!body.plan) {
      return NextResponse.json({ error: "plan required" }, { status: 400 });
    }
    await logStrategy(user.did, "suggest_plan", {
      symbol: body.symbol ?? null,
      plan: body.plan,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof Response) return err;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "log error" },
      { status: 500 },
    );
  }
}
