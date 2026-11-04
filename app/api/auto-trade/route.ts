import { NextResponse } from "next/server";
import { currentAccount } from "../../../lib/account";
import { loadSettings, saveSettings } from "../../../lib/auto-trade/settings";
import { recentLog, status } from "../../../lib/auto-trade/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/auto-trade  → settings, current limit state, recent decisions
// POST /api/auto-trade  → partial settings update
//
// Going live (enabled AND not dry run) needs confirmLive: true in the same
// request. The panel sends it only from its own confirmation step, so a
// stray settings write can never be the thing that starts real deploys.
export async function GET() {
  try {
    const user = await currentAccount();
    const [st, rows] = await Promise.all([status(user.id), recentLog(user.id, 150)]);
    return NextResponse.json({
      ...st,
      log: rows.map((r) => ({
        id: r.id,
        runId: r.runId,
        kind: r.kind,
        symbol: r.symbol,
        deploymentId: r.deploymentId,
        message: r.message,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "auto-trade status error" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await currentAccount();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown> & {
      confirmLive?: boolean;
    };
    const { confirmLive, ...patch } = body;
    const current = await loadSettings(user.id);
    const enabled = typeof patch.enabled === "boolean" ? patch.enabled : current.enabled;
    const dryRun = typeof patch.dryRun === "boolean" ? patch.dryRun : current.dryRun;
    const wasLive = current.enabled && !current.dryRun;
    if (enabled && !dryRun && !wasLive && confirmLive !== true) {
      return NextResponse.json(
        { error: "Turning on live auto deploys needs confirmLive: true", needsConfirm: true },
        { status: 409 },
      );
    }
    const saved = await saveSettings(user.id, patch);
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
    return NextResponse.json({ settings: saved.settings });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "auto-trade settings error" },
      { status: 500 },
    );
  }
}
