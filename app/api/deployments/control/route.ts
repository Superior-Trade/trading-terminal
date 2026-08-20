import { NextResponse } from "next/server";
import { requireSuperiorAuth } from "../../../../lib/account";
import {
  sweepWalletToMain,
  walletOfDeployment,
  controlDeployment,
} from "../../../../lib/superior-api";


export const runtime = "nodejs";
// start (restarting a stopped deployment) re-enters the allocate-on-deploy
// funding path, and stop runs closeAll against Hyperliquid — both can take well
// over the ~10-15s Vercel default. Give it the same ceiling as /api/deploy so
// these lifecycle calls aren't killed mid-flight.
export const maxDuration = 300;

const API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

// Control proxy for deployments (ours AND foreign ones):
// POST { id, action: "stop" | "start" | "exit" | "delete" }
export async function POST(req: Request) {
  let apiKey: string;
  try {
    ({ key: apiKey } = await requireSuperiorAuth());
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const headers = { "Content-Type": "application/json", "x-api-key": apiKey };
  try {
    const { id, action } = (await req.json()) as { id: string; action: string };
    if (!id || !["stop", "start", "exit", "delete"].includes(action)) {
      return NextResponse.json({ error: "id and valid action required" }, { status: 400 });
    }
    if (action === "start") {
      // Shared lib path: restart also re-funds the wallet to the stake
      // (the auto-sweep may have drained a stopped deployment's account).
      //
      // ⚠️ BACKEND HEADS-UP: this restart/re-fund is best-effort — if
      // main + idle funds can't cover the stake, the deployment still starts,
      // UNDERFUNDED (Freqtrade then silently never trades, or errors). The
      // frontend now disables the Restart button when deployable < stake
      // (see components/terminal/deployments-panel.tsx restartAffordable), but
      // that's a client-side guard only. The control/deploy API should reject
      // a start/re-fund it can't fully fund (verify post-fund wallet balance
      // >= stake, else refuse with a clear error) instead of starting broken.
      const r = await controlDeployment(apiKey, id, "start");
      return NextResponse.json(r.json, { status: r.status });
    }
    let res: Response;
    if (action === "delete") {
      // Capture the wallet BEFORE deleting (history keeps it, but resolve
      // now so the sweep below can't race a history lag).
      const wallet = await walletOfDeployment(apiKey, id);
      res = await fetch(`${API_BASE}/v2/deployment/${id}`, { method: "DELETE", headers });
      if (res.ok && wallet) {
        // Deleting frees the wallet: return its free margin to the main
        // funding pool instead of stranding it on the trading account.
        const swept = await sweepWalletToMain(apiKey, wallet);
        if (swept) {
          const json = await res.json().catch(() => ({}));
          return NextResponse.json({ ...json, sweptToMain: swept }, { status: res.status });
        }
      }
    } else if (action === "exit") {
      res = await fetch(`${API_BASE}/v2/deployment/${id}/exit`, { method: "POST", headers, body: "{}" });
    } else {
      // stop: toggle the pod off, THEN sweep the wallet's free margin back to
      // main so a stopped deployment's funds are immediately reusable — they'd
      // otherwise sit stranded on the trading account until delete. Resolve
      // the wallet BEFORE the status flip so a history lag can't lose it.
      // sweepWalletToMain moves only free margin (no-ops under $1 / on main),
      // so an open position's locked margin is left untouched. Restart
      // re-funds from main, so this composes with the lifecycle.
      const wallet = await walletOfDeployment(apiKey, id).catch(() => null);
      res = await fetch(`${API_BASE}/v2/deployment/${id}/status`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ action: "stop" }),
      });
      if (!res.ok) {
        res = await fetch(`${API_BASE}/v1/deployment/${id}/status`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ action: "stop" }),
        });
      }
      if (res.ok && wallet) {
        const swept = await sweepWalletToMain(apiKey, wallet);
        if (swept) {
          const json = await res.json().catch(() => ({}));
          return NextResponse.json({ ...json, sweptToMain: swept }, { status: res.status });
        }
      }
    }
    const json = await res.json().catch(() => ({}));
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "control proxy error" },
      { status: 502 },
    );
  }
}
