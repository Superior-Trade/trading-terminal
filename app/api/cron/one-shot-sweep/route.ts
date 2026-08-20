import { NextResponse } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema } from "../../../../lib/db";
import { decryptSecret } from "../../../../lib/server-auth";
import { deploymentHistory, controlDeployment, sweepWalletToMain } from "../../../../lib/superior-api";
import { logStrategy, alreadyLogged } from "../../../../lib/strategy-log";

export const runtime = "nodejs";
// Never cache — this mutates deployments.
export const dynamic = "force-dynamic";

// One-shot auto-stop sweep.
//
// A one_shot plan is meant to take ONE trade and be done. We deploy it as a
// normal (recurring) Freqtrade bot — Superior has no native "trade once" — and
// this sweep enforces the one-shot semantics from outside: once the bot has
// opened AND closed its trade, we stop the deployment so it can't re-enter.
//
// Nothing calls this on its own — point a scheduler at it every minute:
// a cron entry hitting `curl -H "Authorization: Bearer $CRON_SECRET"
// http://localhost:3200/api/cron/one-shot-sweep`, or your host's own cron
// feature. Guarded by CRON_SECRET when set; unset leaves the guard open so
// you can hit it by hand while trying things out.
//
// Skipping it entirely only means one-shot plans keep running after their
// trade closes — everything else in the terminal is unaffected.
//
// "Done" = the deployment's trading wallet has a CLOSE fill after the
// deployment started (source of truth is Hyperliquid userFills — Superior's
// history reports trades:0 even mid-trade). A one_shot with only an open fill
// (still in the trade) is left alone so its TP/SL can work; one with no fills
// is still waiting for entry. Erring toward stopping is correct here — the
// whole point of one_shot is to not keep trading.

interface HistFill {
  time?: number;
  dir?: string; // "Open Long" | "Close Long" | "Open Short" | "Close Short"…
  closedPnl?: string | number;
  px?: string | number;
  coin?: string;
}
interface HistItem {
  deploymentId?: string | null;
  walletAddress?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

const isClose = (f: HistFill) =>
  (f.dir ?? "").toLowerCase().includes("close") ||
  Math.abs(typeof f.closedPnl === "string" ? parseFloat(f.closedPnl) : f.closedPnl ?? 0) > 0;

async function keyForUser(userId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ enc: schema.users.stKeyEncrypted })
    .from(schema.users)
    .where(eq(schema.users.privyDid, userId));
  const enc = rows[0]?.enc;
  if (enc) {
    try {
      return decryptSecret(enc);
    } catch {
      /* fall through to org key */
    }
  }
  // A sweep/stop MUST act on the USER's own account — never the org's. With no
  // per-user key we skip this user (caller: `if (!key) continue`) rather than
  // fall back to the org key. Org key stays a local-dev convenience only.
  return process.env.NODE_ENV !== "production"
    ? (process.env.SUPERIOR_TRADE_API_KEY ?? null)
    : null;
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const db = getDb();
  const pending = await db
    .select({
      deploymentId: schema.deployments.deploymentId,
      userId: schema.deployments.userId,
    })
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.mode, "one_shot"),
        eq(schema.deployments.origin, "ours"),
        isNull(schema.deployments.autostoppedAt),
      ),
    );

  // Live-verify candidates: OUR recent deployments with a stored plan —
  // stage 4 of the verification ladder. A strategy that compiled AND
  // backtested can still fail live (order rejected, never fills, wrong
  // side) — the first real fill vs the plan is the ground truth.
  const verifyCandidates = await db
    .select({
      deploymentId: schema.deployments.deploymentId,
      userId: schema.deployments.userId,
      planJson: schema.deployments.planJson,
    })
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.origin, "ours"),
        gt(schema.deployments.createdAt, Date.now() - 7 * 86_400_000),
      ),
    );

  if (!pending.length && !verifyCandidates.length) {
    return NextResponse.json({ checked: 0, stopped: [], verified: [] });
  }

  // Group by user so we resolve the key + fetch deployment-history once each.
  const byUser = new Map<string, string[]>();
  for (const p of pending) {
    const list = byUser.get(p.userId) ?? [];
    list.push(p.deploymentId);
    byUser.set(p.userId, list);
  }
  const verifyByUser = new Map<string, Array<{ deploymentId: string; planJson: string }>>();
  for (const v of verifyCandidates) {
    const list = verifyByUser.get(v.userId) ?? [];
    list.push({ deploymentId: v.deploymentId, planJson: v.planJson });
    verifyByUser.set(v.userId, list);
  }

  const stopped: string[] = [];
  const verified: string[] = [];
  const now = Date.now();

  const allUsers = new Set([...byUser.keys(), ...verifyByUser.keys()]);
  for (const userId of allUsers) {
    const depIds = byUser.get(userId) ?? [];
    const verifyList = verifyByUser.get(userId) ?? [];
    try {
      const key = await keyForUser(userId);
      if (!key) continue;

      const wantedIds = new Set([
        ...depIds,
        ...verifyList.map((v) => v.deploymentId),
      ]);
      const { json } = await deploymentHistory(key);
      const items = ((json as { items?: HistItem[] }).items ?? []).filter(
        (it) => it.deploymentId && wantedIds.has(it.deploymentId),
      );
      // deploymentId → {wallet, startMs, endMs, ended}. endMs bounds fill
      // attribution: wallets are REUSED across sequential deployments, so a
      // fill after this deployment ended belongs to a later one.
      const meta = new Map<
        string,
        { wallet: string | null; startMs: number; endMs: number | null; ended: boolean }
      >();
      for (const it of items) {
        const id = it.deploymentId!;
        const startMs = it.startedAt ? Date.parse(it.startedAt) : 0;
        const endMs = it.endedAt ? Date.parse(it.endedAt) : null;
        const prev = meta.get(id);
        meta.set(id, {
          wallet: it.walletAddress ?? prev?.wallet ?? null,
          startMs: prev ? Math.min(prev.startMs, startMs) : startMs,
          endMs:
            prev?.endMs != null && endMs != null
              ? Math.max(prev.endMs, endMs)
              : (endMs ?? prev?.endMs ?? null),
          ended: Boolean(it.endedAt) || Boolean(prev?.ended),
        });
      }

      // One userFills fetch per unique wallet.
      const wallets = new Set(
        [...meta.values()].map((m) => m.wallet).filter(Boolean) as string[],
      );
      const fillsByWallet = new Map<string, HistFill[]>();
      await Promise.all(
        [...wallets].map(async (w) => {
          try {
            const r = await fetch("https://api.hyperliquid.xyz/info", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "userFills", user: w }),
            });
            const fills = (await r.json()) as HistFill[];
            fillsByWallet.set(w, Array.isArray(fills) ? fills : []);
          } catch {
            fillsByWallet.set(w, []);
          }
        }),
      );

      for (const depId of depIds) {
        const m = meta.get(depId);
        if (!m) continue; // not started / no history yet — leave it
        let done = m.ended; // already stopped upstream → just mark handled
        if (!done && m.wallet) {
          const fills = fillsByWallet.get(m.wallet) ?? [];
          done = fills.some((f) => (f.time ?? 0) >= m.startMs && isClose(f));
        }
        if (!done) continue;

        // Stop the bot (idempotent enough — a stopped/absent deployment is a
        // no-op). Mark handled regardless so we don't re-scan it.
        try {
          if (!m.ended) await controlDeployment(key, depId, "stop");
        } catch {
          /* mark handled anyway; a transient stop failure is retried never —
             but the deployment already closed its one trade, so leaving it
             flagged is safer than looping forever. */
        }
        // One-shot finished on a trading account: return the free margin to
        // the main funding pool (stop keeps the wallet linked, but the FUNDS
        // aren't locked — no reason to strand them).
        if (m.wallet) {
          await sweepWalletToMain(key, m.wallet).catch(() => null);
        }
        await db
          .update(schema.deployments)
          .set({ autostoppedAt: now })
          .where(eq(schema.deployments.deploymentId, depId));
        stopped.push(depId);
      }

      // Stage 4 — live_verify: first REAL fill vs the plan. No fill yet →
      // skip silently (next sweep retries); logged once per deployment.
      for (const v of verifyList) {
        const m = meta.get(v.deploymentId);
        if (!m?.wallet) continue; // not started / no wallet yet
        const fills = fillsByWallet.get(m.wallet) ?? [];
        const firstOpen = fills
          .filter(
            (f) =>
              (f.time ?? 0) >= m.startMs &&
              (m.endMs == null || (f.time ?? 0) <= m.endMs) &&
              (f.dir ?? "").toLowerCase().includes("open"),
          )
          .sort((a, b) => (a.time ?? 0) - (b.time ?? 0))[0];
        if (!firstOpen) {
          // Ended without ever filling — that IS the verdict (compiled +
          // deployed but never traded). Log once so the corpus records it.
          if (m.ended && !(await alreadyLogged("live_verify", `"${v.deploymentId}"`))) {
            let plan: { entry?: number; direction?: string } = {};
            try {
              plan = JSON.parse(v.planJson) as typeof plan;
            } catch {
              /* unparseable plan */
            }
            await logStrategy(userId, "live_verify", {
              plan,
              artifact: {
                deploymentId: v.deploymentId,
                fill: null,
                traded: false,
                planEntry: plan.entry ?? null,
                planDirection: plan.direction ?? null,
              },
            });
            verified.push(v.deploymentId);
          }
          continue;
        }
        if (await alreadyLogged("live_verify", `"${v.deploymentId}"`)) continue;

        let plan: { entry?: number; direction?: string } = {};
        try {
          plan = JSON.parse(v.planJson) as typeof plan;
        } catch {
          /* foreign/legacy row without a parseable plan */
        }
        const fillPx =
          typeof firstOpen.px === "string" ? parseFloat(firstOpen.px) : firstOpen.px ?? null;
        const fillDir = (firstOpen.dir ?? "").toLowerCase().includes("long")
          ? "long"
          : "short";
        const directionOk =
          plan.direction === "neutral" ? true : plan.direction ? plan.direction === fillDir : null;
        const deviationPct =
          fillPx != null && typeof plan.entry === "number" && plan.entry > 0
            ? ((fillPx - plan.entry) / plan.entry) * 100
            : null;
        await logStrategy(userId, "live_verify", {
          symbol: firstOpen.coin ?? null,
          plan,
          artifact: {
            deploymentId: v.deploymentId,
            fill: { px: fillPx, dir: fillDir, time: firstOpen.time ?? null },
            traded: true,
            planEntry: plan.entry ?? null,
            planDirection: plan.direction ?? null,
            directionOk,
            entryDeviationPct: deviationPct,
          },
        });
        verified.push(v.deploymentId);
      }
    } catch {
      /* skip this user this pass; next sweep retries */
    }
  }

  return NextResponse.json({ checked: pending.length, stopped, verified });
}
