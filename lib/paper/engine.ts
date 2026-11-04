import { and, asc, desc, eq, gte } from "drizzle-orm";
import { getDb, schema } from "../db";
import { currentAccount } from "../account";
import { PAPER_COINS, SMA_DAYS, trendSignal } from "./strategy";
import { buy, chargeFunding, equity, newPaperState, sellAll, type Fill, type PaperState } from "./book";

// Paper trading: runs lib/paper/strategy.ts on live Hyperliquid prices against
// a virtual account. Reads public market data only — this file imports nothing
// that can place an order, deploy, or move funds, and must stay that way.
//
// Each tick (once a minute, from the scheduler): charge funding on open
// positions, snapshot equity at most hourly, and — once per UTC day, after
// the daily candle closes — decide each coin from its completed closes.

const HL_INFO = "https://api.hyperliquid.xyz/info";
const DAY_MS = 86_400_000;
const EQUITY_EVERY_MS = 60 * 60_000;

const lock = globalThis as { __paperTick?: Promise<unknown> | null };

async function hl<T>(body: unknown): Promise<T> {
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function mids(): Promise<Record<string, number>> {
  const raw = await hl<Record<string, string>>({ type: "allMids" });
  const out: Record<string, number> = {};
  for (const c of PAPER_COINS) {
    const v = parseFloat(raw[c] ?? "");
    if (v > 0) out[c] = v;
  }
  return out;
}

async function fundingRates(): Promise<Record<string, number>> {
  const [meta, ctxs] = await hl<[{ universe: Array<{ name: string }> }, Array<{ funding?: string }>]>({
    type: "metaAndAssetCtxs",
  });
  const out: Record<string, number> = {};
  meta.universe.forEach((u, i) => {
    const f = parseFloat(ctxs[i]?.funding ?? "");
    if ((PAPER_COINS as readonly string[]).includes(u.name) && Number.isFinite(f)) out[u.name] = f;
  });
  return out;
}

/** Completed daily closes, oldest first; today's forming candle is dropped. */
async function dailyCloses(coin: string, now: number): Promise<number[]> {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const raw = await hl<Array<{ t: number; c: string }>>({
    type: "candleSnapshot",
    req: { coin, interval: "1d", startTime: today - (SMA_DAYS + 30) * DAY_MS, endTime: now },
  });
  return raw.filter((k) => k.t < today).map((k) => parseFloat(k.c));
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ── storage ───────────────────────────────────────────────────────────────

async function loadState(userId: string): Promise<PaperState | null> {
  const [row] = await getDb()
    .select()
    .from(schema.paperAccount)
    .where(eq(schema.paperAccount.userId, userId))
    .limit(1);
  return row ? (JSON.parse(row.stateJson) as PaperState) : null;
}

async function saveState(userId: string, state: PaperState): Promise<void> {
  const now = Date.now();
  await getDb()
    .insert(schema.paperAccount)
    .values({ userId, stateJson: JSON.stringify(state), updatedAt: now })
    .onConflictDoUpdate({
      target: schema.paperAccount.userId,
      set: { stateJson: JSON.stringify(state), updatedAt: now },
    });
}

async function event(
  userId: string,
  kind: string,
  message: string,
  extra: { coin?: string; detail?: unknown } = {},
): Promise<void> {
  await getDb()
    .insert(schema.paperEvents)
    .values({
      userId,
      kind,
      coin: extra.coin ?? null,
      message: message.slice(0, 1000),
      detailJson: extra.detail === undefined ? null : JSON.stringify(extra.detail),
      createdAt: Date.now(),
    });
}

async function snapshotEquity(userId: string, value: number, now: number, force = false): Promise<void> {
  if (!force) {
    const [last] = await getDb()
      .select({ at: schema.paperEquity.createdAt })
      .from(schema.paperEquity)
      .where(eq(schema.paperEquity.userId, userId))
      .orderBy(desc(schema.paperEquity.createdAt))
      .limit(1);
    if (last && now - last.at < EQUITY_EVERY_MS) return;
  }
  await getDb().insert(schema.paperEquity).values({ userId, equity: value, createdAt: now });
}

const fmtFill = (f: Fill) =>
  `${f.side === "buy" ? "Bought" : "Sold"} ${f.qty.toPrecision(4)} ${f.coin} at $${f.px.toFixed(2)} (fee $${f.fee.toFixed(4)})` +
  (f.pnl == null ? "" : `, ${f.pnl >= 0 ? "+" : ""}$${f.pnl.toFixed(2)} on the trade`);

// ── public ────────────────────────────────────────────────────────────────

/** Start (or restart from scratch) with `startingUsd` of virtual cash. */
export async function startPaper(startingUsd: number): Promise<PaperState> {
  const user = await currentAccount();
  const now = Date.now();
  const state = newPaperState(startingUsd, now);
  await saveState(user.id, state);
  await event(user.id, "start", `Paper account started with $${startingUsd.toFixed(2)} of virtual cash`);
  await snapshotEquity(user.id, startingUsd, now, true);
  await tickPaper();
  return (await loadState(user.id)) ?? state;
}

export async function stopPaper(): Promise<void> {
  const user = await currentAccount();
  const state = await loadState(user.id);
  if (!state) return;
  await saveState(user.id, { ...state, running: false });
  await event(user.id, "stop", "Paused. Positions are kept and still marked to market; no new decisions until resumed.");
}

export async function resumePaper(): Promise<void> {
  const user = await currentAccount();
  const state = await loadState(user.id);
  if (!state) return;
  // Funding accrues while paused too — positions are still held.
  await saveState(user.id, { ...state, running: true });
  await event(user.id, "start", "Resumed");
  await tickPaper();
}

export function tickPaper(): Promise<unknown> {
  if (lock.__paperTick) return lock.__paperTick;
  const p = tick().finally(() => {
    lock.__paperTick = null;
  });
  lock.__paperTick = p;
  return p;
}

async function tick(): Promise<void> {
  const user = await currentAccount();
  let state = await loadState(user.id);
  if (!state) return;
  const now = Date.now();
  try {
    const [px, rates] = await Promise.all([mids(), fundingRates()]);
    state = chargeFunding(state, px, rates, now);

    const decideDay = utcDay(now - DAY_MS); // the last completed daily candle
    if (state.running && state.lastDecisionDay !== decideDay) {
      for (const coin of PAPER_COINS) {
        const closes = await dailyCloses(coin, now);
        const signal = trendSignal(closes);
        const holding = Boolean(state.positions[coin]);
        const mid = px[coin];
        if (!signal || !mid) {
          await event(user.id, "error", `${coin}: no decision — ${!signal ? `only ${closes.length} usable daily closes` : "no live price"}`, { coin });
          continue;
        }
        const last = closes[closes.length - 1]!;
        const sma = closes.slice(-SMA_DAYS).reduce((a, b) => a + b, 0) / SMA_DAYS;
        const why = `close $${last.toFixed(2)} vs 200-day average $${sma.toFixed(2)}`;
        if (signal === "long" && !holding) {
          // Half of current equity per coin (one share per coin in the rule).
          const eq = equity(state, px) ?? state.cash;
          const r = buy(state, coin, eq / PAPER_COINS.length, mid, now);
          if (r) {
            state = r.state;
            // Saved with its log line, so the two can never disagree.
            await saveState(user.id, state);
            await event(user.id, "buy", `${fmtFill(r.fill)} — ${why}`, { coin, detail: r.fill });
          }
        } else if (signal === "flat" && holding) {
          const r = sellAll(state, coin, mid);
          if (r) {
            state = r.state;
            // Saved with its log line, so the two can never disagree.
            await saveState(user.id, state);
            await event(user.id, "sell", `${fmtFill(r.fill)} — ${why}`, { coin, detail: r.fill });
          }
        } else {
          await event(user.id, "decision", `${coin}: ${holding ? "hold" : "stay in cash"} — ${why}`, { coin });
        }
      }
      state = { ...state, lastDecisionDay: decideDay };
    }

    await saveState(user.id, state);
    const value = equity(state, px);
    if (value != null) await snapshotEquity(user.id, value, now);
  } catch (err) {
    // Fills are saved as they happen; anything else from this tick is
    // dropped and the next tick retries from the last saved state.
    await event(user.id, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function paperStatus() {
  const user = await currentAccount();
  const state = await loadState(user.id);
  if (!state) return { state: null };
  const px = await mids().catch(() => ({}) as Record<string, number>);
  const db = getDb();
  const [events, curve] = await Promise.all([
    db
      .select()
      .from(schema.paperEvents)
      .where(and(eq(schema.paperEvents.userId, user.id), gte(schema.paperEvents.createdAt, state.createdAt)))
      .orderBy(desc(schema.paperEvents.createdAt), desc(schema.paperEvents.id))
      .limit(200),
    db
      .select({ equity: schema.paperEquity.equity, at: schema.paperEquity.createdAt })
      .from(schema.paperEquity)
      .where(and(eq(schema.paperEquity.userId, user.id), gte(schema.paperEquity.createdAt, state.createdAt)))
      .orderBy(asc(schema.paperEquity.createdAt))
      .limit(5000),
  ]);
  return {
    state,
    mids: px,
    equity: equity(state, px),
    positions: Object.entries(state.positions).map(([coin, p]) => ({
      coin,
      ...p,
      mid: px[coin] ?? null,
      unrealized: px[coin] ? (px[coin]! - p.entryPx) * p.qty : null,
    })),
    events: events.map((e) => ({ id: e.id, kind: e.kind, coin: e.coin, message: e.message, createdAt: e.createdAt })),
    curve,
  };
}
