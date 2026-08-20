import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../../lib/superior-key";
import { deploymentHistory } from "../../../../lib/superior-api";

export const runtime = "nodejs";

// GET /api/deployments/pnl → per-deployment realized-PnL equity series.
// Sessions (deployment ↔ wallet ↔ startedAt) come from Superior's
// /v2/deployment-history, but the FILLS come from Hyperliquid userFills —
// the exchange is the source of truth (Superior's history reports trades:0
// even while a wallet holds a live position). Fills are attributed to a
// deployment by its wallet's session window: one active execution per
// wallet means everything between this deployment's start and the next
// deployment's start on that wallet belongs to it.
// One fetch per wallet; 30s in-memory cache keeps panel refreshes cheap.

interface HistoryFill {
  time?: number;
  closedPnl?: string | number;
  fee?: string | number;
  coin?: string;
  dir?: string; // e.g. "Open Long", "Close Long", "Open Short"…
  side?: string; // "B" | "A"
  px?: string | number;
}

interface HistoryItem {
  deploymentId?: string | null;
  walletAddress?: string | null;
  trades?: HistoryFill[] | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface DeploymentPnl {
  points: Array<{ t: number; v: number }>;
  totalPnl: number;
  tradeCount: number;
  startedAt: string | null;
  lastAt: number | null;
  running: boolean;
  coins: string[];
  /** Trading wallet — lets the client pull live positions/open orders. */
  walletAddress: string | null;
  /** Recent trades for the share card: closing fills = realized, opening
   *  fills with no later close = still-open. Newest first, capped. */
  recentTrades: Array<{
    t: number;
    coin: string;
    dir: "long" | "short";
    pnl: number;
    realized: boolean;
    px: number | null;
  }>;
}

const num = (v: string | number | undefined): number => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? (n as number) : 0;
};

let cache: { at: number; key: string; body: Record<string, DeploymentPnl> } | null =
  null;

export async function GET(req: Request) {
  try {
    const { key } = await resolveSuperiorAuth(req);
    if (cache && cache.key === key && Date.now() - cache.at < 30_000) {
      return NextResponse.json({ items: cache.body });
    }

    const { status, json } = await deploymentHistory(key);
    if (status >= 400) {
      return NextResponse.json(
        { error: `deployment-history HTTP ${status}` },
        { status: 502 },
      );
    }
    const j = json as { items?: HistoryItem[] };

    // Group sessions by deployment (restarts = multiple sessions).
    const byDep = new Map<string, HistoryItem[]>();
    for (const item of j.items ?? []) {
      if (!item.deploymentId) continue;
      const list = byDep.get(item.deploymentId) ?? [];
      list.push(item);
      byDep.set(item.deploymentId, list);
    }

    // Exchange fills per wallet (one request per unique wallet).
    const wallets = new Set<string>();
    for (const sessions of byDep.values())
      for (const s of sessions) if (s.walletAddress) wallets.add(s.walletAddress);
    const fillsByWallet = new Map<string, HistoryFill[]>();
    await Promise.all(
      [...wallets].map(async (w) => {
        try {
          const r = await fetch("https://api.hyperliquid.xyz/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "userFills", user: w }),
          });
          const fills = (await r.json()) as HistoryFill[];
          fillsByWallet.set(w, Array.isArray(fills) ? fills : []);
        } catch {
          fillsByWallet.set(w, []);
        }
      }),
    );

    // Per wallet: order deployments by first session start so each one's
    // window is [myStart, nextDeploymentStart) — fills attribute cleanly
    // under the one-active-execution-per-wallet invariant.
    const depStart = (sessions: HistoryItem[]) =>
      Math.min(
        ...sessions.map((s) => (s.startedAt ? Date.parse(s.startedAt) : Infinity)),
      );
    const byWalletDeps = new Map<string, Array<{ depId: string; start: number }>>();
    for (const [depId, sessions] of byDep) {
      const w = sessions.map((s) => s.walletAddress).find(Boolean);
      if (!w) continue;
      const list = byWalletDeps.get(w) ?? [];
      list.push({ depId, start: depStart(sessions) });
      byWalletDeps.set(w, list);
    }
    for (const list of byWalletDeps.values()) list.sort((a, b) => a.start - b.start);

    const fillsFor = (depId: string, sessions: HistoryItem[]): HistoryFill[] => {
      // Prefer Superior's own trade log if it ever starts populating.
      const own = sessions.flatMap((s) => s.trades ?? []);
      if (own.length) return own.filter((f) => Number.isFinite(f.time));
      const w = sessions.map((s) => s.walletAddress).find(Boolean);
      if (!w) return [];
      const peers = byWalletDeps.get(w) ?? [];
      const idx = peers.findIndex((p) => p.depId === depId);
      if (idx < 0) return [];
      const start = peers[idx].start;
      const end = peers[idx + 1]?.start ?? Infinity;
      return (fillsByWallet.get(w) ?? []).filter(
        (f) => Number.isFinite(f.time) && (f.time as number) >= start && (f.time as number) < end,
      );
    };

    const out: Record<string, DeploymentPnl> = {};
    for (const [depId, sessions] of byDep) {
      const fills = fillsFor(depId, sessions).sort(
        (a, b) => (a.time ?? 0) - (b.time ?? 0),
      );
      const points: Array<{ t: number; v: number }> = [];
      let cum = 0;
      const coins = new Set<string>();
      for (const f of fills) {
        cum += num(f.closedPnl) - num(f.fee);
        points.push({ t: f.time as number, v: Number(cum.toFixed(6)) });
        if (f.coin) coins.add(f.coin);
      }
      const startedAts = sessions
        .map((s) => s.startedAt)
        .filter(Boolean)
        .sort();
      // Trade rows: HL fills carry dir like "Open Long"/"Close Short".
      // A Close fill is a realized trade (pnl = closedPnl - fee); the most
      // recent Open with no later Close is the still-open position.
      const recentTrades: DeploymentPnl["recentTrades"] = [];
      for (let i = fills.length - 1; i >= 0 && recentTrades.length < 8; i--) {
        const f = fills[i];
        const d = String(f.dir ?? "");
        const isClose = /close/i.test(d);
        const isOpen = /open/i.test(d);
        const long = /long/i.test(d) ? true : /short/i.test(d) ? false : f.side === "B";
        if (isClose) {
          recentTrades.push({
            t: f.time as number,
            coin: f.coin ?? "?",
            dir: long ? "long" : "short",
            pnl: Number((num(f.closedPnl) - num(f.fee)).toFixed(4)),
            realized: true,
            px: num(f.px) || null,
          });
        } else if (isOpen && recentTrades.length === 0) {
          // Only the latest open counts as an in-flight trade row.
          recentTrades.push({
            t: f.time as number,
            coin: f.coin ?? "?",
            dir: long ? "long" : "short",
            pnl: 0,
            realized: false,
            px: num(f.px) || null,
          });
        }
      }
      out[depId] = {
        points,
        totalPnl: points.length ? points[points.length - 1].v : 0,
        tradeCount: fills.length,
        startedAt: startedAts[0] ?? null,
        lastAt: points.length ? points[points.length - 1].t : null,
        running: sessions.some((s) => s.startedAt && !s.endedAt),
        coins: [...coins],
        walletAddress:
          sessions.map((s) => s.walletAddress).find(Boolean) ?? null,
        recentTrades,
      };
    }

    cache = { at: Date.now(), key, body: out };
    return NextResponse.json({ items: out });
  } catch (err) {
    if (err instanceof Response) return err;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "pnl error" },
      { status: 500 },
    );
  }
}
