import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { currentAccount, superiorKey } from "../account";
import { isFundsFrozen } from "../kill-switch";
import { liveHlPairs } from "../hl-universe";
import { normalizePerpPair } from "../pair-normalize";
import {
  controlDeployment,
  deploymentHistory,
  deploymentOccupiesExchange,
  getBacktest,
  listDeployments,
  resolveBacktestResults,
  submitBacktest,
} from "../superior-api";
import type { ChartContext } from "../chart-bridge";
import { POST as detectRoute } from "../../app/api/detect/route";
import { POST as compileRoute } from "../../app/api/compile/route";
import { POST as deployRoute } from "../../app/api/deploy/route";
import { loadSettings, saveSettings, type AutoTradeSettings } from "./settings";
import {
  backtestMetrics,
  backtestVerdict,
  checkLimits,
  rankPlans,
  rewardRisk,
  screenPlan,
  utcDayStart,
  type AutoPlan,
  type LimitState,
} from "./guards";

// Auto mode: scan → detect → screen → compile → backtest → limits → deploy.
//
// It goes through the SAME detect, compile and deploy route handlers the panel
// uses (called in-process, not over HTTP), so every guard those routes enforce
// — the strategy validator, the live-pair check, the $11 minimum, the freeze
// switches — applies here unchanged. What this file adds is the part a human
// used to do: choosing, and saying no. Those rules live in ./guards.ts.
//
// One run at a time per process. A run never deploys more than once per pair,
// and re-reads the limits immediately before each deploy.

type DetectedPlan = AutoPlan & Record<string, unknown>;

interface RunSummary {
  runId: string;
  dryRun: boolean;
  skipped?: string;
  deployed: string[];
  wouldDeploy: string[];
  errors: number;
}

const HL_INFO = "https://api.hyperliquid.xyz/info";
const CANDLES = 150;
const TF_MS: Record<AutoTradeSettings["timeframe"], number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};
const BACKTEST_POLL_MS = 10_000;
const BACKTEST_TIMEOUT_MS = 6 * 60_000;

// On globalThis, not module scope: each route can get its own copy of this
// module, and the run and cron routes must still see one shared lock.
const lock = globalThis as { __autoTradeRun?: Promise<RunSummary> | null };

// ── log ───────────────────────────────────────────────────────────────────

async function log(
  userId: string,
  runId: string,
  kind: string,
  message: string,
  extra: { symbol?: string; deploymentId?: string; detail?: unknown } = {},
): Promise<void> {
  try {
    await getDb()
      .insert(schema.autoTradeLog)
      .values({
        userId,
        runId,
        kind,
        symbol: extra.symbol ?? null,
        deploymentId: extra.deploymentId ?? null,
        message: message.slice(0, 1000),
        detailJson: extra.detail === undefined ? null : JSON.stringify(extra.detail).slice(0, 20_000),
        createdAt: Date.now(),
      });
  } catch (err) {
    console.error("[auto-trade] log write failed:", err instanceof Error ? err.message : err);
  }
}

export async function recentLog(userId: string, limit = 100) {
  return getDb()
    .select()
    .from(schema.autoTradeLog)
    .where(eq(schema.autoTradeLog.userId, userId))
    // id breaks ties: rows written in the same millisecond keep their order.
    .orderBy(desc(schema.autoTradeLog.createdAt), desc(schema.autoTradeLog.id))
    .limit(limit);
}

export async function lastRunAt(userId: string): Promise<number | null> {
  const [row] = await getDb()
    .select({ at: schema.autoTradeLog.createdAt })
    .from(schema.autoTradeLog)
    .where(and(eq(schema.autoTradeLog.userId, userId), eq(schema.autoTradeLog.kind, "run_start")))
    .orderBy(desc(schema.autoTradeLog.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/** Deployments auto mode created: the "deployed" log rows. */
async function autoDeployments(userId: string) {
  return getDb()
    .select({
      deploymentId: schema.autoTradeLog.deploymentId,
      symbol: schema.autoTradeLog.symbol,
      createdAt: schema.autoTradeLog.createdAt,
    })
    .from(schema.autoTradeLog)
    .where(and(eq(schema.autoTradeLog.userId, userId), eq(schema.autoTradeLog.kind, "deployed")));
}

// ── market + route plumbing ───────────────────────────────────────────────

/** A chart context with no browser: recent candles from Hyperliquid, no drawings. */
async function buildChartContext(
  symbol: string,
  timeframe: AutoTradeSettings["timeframe"],
): Promise<ChartContext> {
  const end = Date.now();
  const start = end - TF_MS[timeframe] * CANDLES;
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin: symbol, interval: timeframe, startTime: start, endTime: end },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`candles HTTP ${r.status}`);
  const raw = (await r.json()) as Array<{ t: number; o: string; h: string; l: string; c: string }>;
  const candles = (Array.isArray(raw) ? raw : []).map((k) => ({
    t: Math.floor(k.t / 1000),
    o: +k.o,
    h: +k.h,
    l: +k.l,
    c: +k.c,
  }));
  if (candles.length < 30) throw new Error(`only ${candles.length} candles returned`);
  return {
    symbol,
    timeframe,
    visibleRange: { from: candles[0]!.t, to: candles[candles.length - 1]!.t },
    indicators: [],
    drawings: [],
    lastPrice: candles[candles.length - 1]!.c,
    recentCandles: candles,
  };
}

async function callRoute(
  handler: (req: Request) => Promise<Response>,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Compile with the same silent repair loop the panel runs (up to 2 repairs). */
async function compile(
  plan: DetectedPlan,
  ctx: ChartContext,
  s: AutoTradeSettings,
): Promise<{ config: Record<string, unknown>; code: string } | { error: string }> {
  let repair: { code: string; configJson: string; errors: string } | undefined;
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const { status, json } = await callRoute(compileRoute, "/api/compile", {
      plan,
      chartContext: ctx,
      funds: s.stakeUsd,
      leverage: s.leverage,
      ...(repair ? { repair } : {}),
    });
    const strategy = json.strategy as { config: Record<string, unknown>; code: string } | undefined;
    if (strategy) return strategy;
    const rejected = json.rejected as { configJson: string; code: string } | undefined;
    const errors = json.validationErrors as string[] | undefined;
    if (status === 422 && rejected && errors?.length) {
      repair = { code: rejected.code, configJson: rejected.configJson, errors: errors.join("\n") };
      lastErrors = errors;
      continue;
    }
    return { error: String(json.error ?? `compile HTTP ${status}`) };
  }
  return { error: `strategy still failed validation after 2 repairs: ${lastErrors.join("; ").slice(0, 400)}` };
}

async function backtest(
  key: string,
  strategy: { config: Record<string, unknown>; code: string },
  days: number,
): Promise<{ results: Record<string, unknown> | null; id?: string; error?: string; window: string }> {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const submit = (end: number) => {
    const timerange = { start: day(end - days * 86_400_000), end: day(end) };
    return submitBacktest(key, { config: strategy.config, code: strategy.code, timerange }).then((r) => ({
      ...r,
      window: `${timerange.start}..${timerange.end}`,
    }));
  };
  let { status, json, window } = await submit(Date.now());
  // Superior Trade's backtest data can lag well behind today (measured on
  // 2026-11-04: it ended 2026-05-07). The rejection says where it ends, so
  // test the same length of window ending there. The window is reported in
  // every log line, so an old window is never mistaken for a recent one.
  const availableTo = (json.available as { to?: string } | undefined)?.to;
  if (status === 400 && json.error === "invalid_timerange" && availableTo && !Number.isNaN(Date.parse(availableTo))) {
    ({ status, json, window } = await submit(Date.parse(availableTo)));
  }
  const id = json.id as string | undefined;
  if (status >= 400 || !id) {
    return {
      results: null,
      window,
      error: `backtest submit HTTP ${status}: ${JSON.stringify(json.details ?? json.message ?? json.error ?? "").slice(0, 300)}`,
    };
  }
  const deadline = Date.now() + BACKTEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BACKTEST_POLL_MS));
    const { json: bt } = await getBacktest(key, id);
    const st = String(bt.status ?? "").toLowerCase();
    if (st === "completed") return { id, window, results: await resolveBacktestResults(bt) };
    if (st === "failed" || st === "stopped") return { id, window, results: null, error: `backtest ${st}` };
  }
  return { id, window, results: null, error: "backtest timed out" };
}

// ── limits ────────────────────────────────────────────────────────────────

interface HistItem {
  deploymentId?: string | null;
  walletAddress?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}
interface Fill {
  time?: number;
  closedPnl?: string | number;
  fee?: string | number;
}

/**
 * Realized PnL (net of fees) of auto deployments since UTC midnight, from the
 * exchange's own fills. Wallets are reused across deployments, so each fill is
 * attributed only inside its deployment's start/end window. Null when any
 * piece cannot be read — the caller treats that as "do not deploy".
 */
async function realizedPnlToday(key: string, ids: Set<string>, now: number): Promise<number | null> {
  if (!ids.size) return 0;
  const dayStart = utcDayStart(now);
  try {
    const { status, json } = await deploymentHistory(key);
    if (status >= 400) return null;
    const items = ((json.items ?? []) as HistItem[]).filter(
      (it) => it.deploymentId && ids.has(it.deploymentId) && it.walletAddress,
    );
    const fillsByWallet = new Map<string, Fill[]>();
    for (const w of new Set(items.map((i) => i.walletAddress!.toLowerCase()))) {
      const r = await fetch(HL_INFO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "userFillsByTime", user: w, startTime: dayStart }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return null;
      const fills = (await r.json()) as Fill[];
      if (!Array.isArray(fills)) return null;
      fillsByWallet.set(w, fills);
    }
    const n = (v: unknown) => (typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0) || 0;
    let pnl = 0;
    const seen = new Set<string>();
    for (const it of items) {
      const w = it.walletAddress!.toLowerCase();
      const from = Math.max(dayStart, it.startedAt ? Date.parse(it.startedAt) : 0);
      const to = it.endedAt ? Date.parse(it.endedAt) : Infinity;
      for (const f of fillsByWallet.get(w) ?? []) {
        const t = f.time ?? 0;
        const tag = `${w}:${t}:${f.closedPnl}:${f.fee}`;
        if (t < from || t > to || seen.has(tag)) continue;
        seen.add(tag);
        pnl += n(f.closedPnl) - n(f.fee);
      }
    }
    return pnl;
  } catch {
    return null;
  }
}

async function limitState(userId: string, key: string | null): Promise<LimitState> {
  const now = Date.now();
  const mine = await autoDeployments(userId);
  const deploysToday = mine.filter((d) => d.createdAt >= utcDayStart(now)).length;
  const ids = new Set(mine.map((d) => d.deploymentId).filter(Boolean) as string[]);
  if (!key) {
    return { tradingFrozen: isFundsFrozen("trade"), runningAutoPairs: [], deploysToday, realizedPnlToday: null };
  }
  let runningAutoPairs: string[] = [];
  let pnl: number | null = null;
  const deps = await listDeployments(key).catch(() => null);
  if (deps && deps.status < 400) {
    const live = new Set(
      ((deps.json.items ?? []) as Array<{ id?: string; status?: string; deletedAt?: string | null; exchange?: string | null }>)
        .filter((d) => d.id && ids.has(d.id) && deploymentOccupiesExchange(d, "hyperliquid"))
        .map((d) => d.id!),
    );
    runningAutoPairs = mine.filter((d) => d.deploymentId && live.has(d.deploymentId)).map((d) => d.symbol ?? "?");
    pnl = await realizedPnlToday(key, ids, now);
  }
  // An unreadable deployment list leaves pnl null, which checkLimits treats
  // as a block — so "could not read" never passes as "nothing running".
  return { tradingFrozen: isFundsFrozen("trade"), runningAutoPairs, deploysToday, realizedPnlToday: pnl };
}

export async function status(userId: string) {
  const settings = await loadSettings(userId);
  const state = await limitState(userId, superiorKey());
  return { settings, state, lastRunAt: await lastRunAt(userId), running: Boolean(lock.__autoTradeRun) };
}

// ── the run ───────────────────────────────────────────────────────────────

export function runAutoCycle(trigger: "schedule" | "manual"): Promise<RunSummary> {
  if (lock.__autoTradeRun) {
    return Promise.resolve({ runId: "", dryRun: true, skipped: "a run is already in progress", deployed: [], wouldDeploy: [], errors: 0 });
  }
  const p = run(trigger).finally(() => {
    lock.__autoTradeRun = null;
  });
  lock.__autoTradeRun = p;
  return p;
}

async function run(trigger: "schedule" | "manual"): Promise<RunSummary> {
  const user = await currentAccount();
  const s = await loadSettings(user.id);
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // A manual run while auto mode is off is always a dry run.
  const dryRun = s.dryRun || !s.enabled;
  const summary: RunSummary = { runId, dryRun, deployed: [], wouldDeploy: [], errors: 0 };

  if (trigger === "schedule" && !s.enabled) return { ...summary, skipped: "auto mode is off" };
  const key = superiorKey();
  if (!key || !process.env.OPENROUTER_API_KEY?.trim()) {
    await log(user.id, runId, "error", "SUPERIOR_TRADE_API_KEY and OPENROUTER_API_KEY must both be set in .env.local");
    return { ...summary, errors: 1, skipped: "missing API keys" };
  }

  await log(user.id, runId, "run_start", `${trigger} run${dryRun ? " (dry run)" : ""} over ${s.pairs.join(", ")} on ${s.timeframe}`, {
    detail: { settings: s },
  });

  let live: Set<string> | null = null;
  try {
    live = await liveHlPairs();
  } catch {
    /* can't validate here; compile re-checks the pair */
  }

  for (const symbol of s.pairs) {
    try {
      if (live && !live.has(normalizePerpPair(symbol))) {
        await log(user.id, runId, "skip", `${symbol} is not a live Hyperliquid perp`, { symbol });
        continue;
      }
      // Cheap check first: no point paying for a detect + compile + backtest
      // that the limits would refuse anyway. Dry runs carry on regardless so
      // the log still shows what would have been picked.
      const pre = checkLimits(symbol, await limitState(user.id, key), s);
      if (!pre.ok && !dryRun) {
        await log(user.id, runId, "skip", pre.reason, { symbol });
        continue;
      }

      const ctx = await buildChartContext(symbol, s.timeframe);
      const det = await callRoute(detectRoute, "/api/detect", {
        chartContext: ctx,
        funds: s.stakeUsd,
        leverage: s.leverage,
      });
      const plans = ((det.json.plans ?? []) as DetectedPlan[]).map((p) => ({ ...p, symbol }));
      if (det.status >= 400 || !plans.length) {
        await log(user.id, runId, "error", `detect failed: ${String(det.json.error ?? `HTTP ${det.status}`)}`, { symbol });
        summary.errors++;
        continue;
      }

      const passing: DetectedPlan[] = [];
      for (const p of rankPlans(plans)) {
        const v = screenPlan(p, s);
        if (v.ok) passing.push(p);
        else await log(user.id, runId, "reject", `"${p.title}" (${p.tier}): ${v.reason}`, { symbol, detail: { plan: p } });
      }
      // One candidate per pair per run: the best one. Bounds model and
      // backtest spend, and a second-best plan on the same pair would be
      // refused as a duplicate anyway.
      const plan = passing[0];
      if (!plan) {
        await log(user.id, runId, "skip", `no plan met tier ${s.minTier} and reward:risk ${s.minRewardRisk}`, { symbol });
        continue;
      }
      const rr = rewardRisk(plan)!;

      const strategy = await compile(plan, ctx, s);
      if ("error" in strategy) {
        await log(user.id, runId, "reject", `"${plan.title}": compile failed: ${strategy.error}`, { symbol, detail: { plan } });
        continue;
      }

      const bt = await backtest(key, strategy, s.backtestDays);
      const metrics = backtestMetrics(bt.results);
      const btVerdict = bt.error ? { ok: false as const, reason: bt.error } : backtestVerdict(metrics, s);
      if (!btVerdict.ok) {
        await log(user.id, runId, "reject", `"${plan.title}": ${btVerdict.reason} (backtest ${bt.window})`, {
          symbol,
          detail: { plan, backtestId: bt.id, backtestWindow: bt.window, metrics },
        });
        continue;
      }

      // Fresh read right before money moves: another run, the user, or a
      // closing trade may have changed the picture since the pre-check.
      const limits = checkLimits(symbol, await limitState(user.id, key), s);
      const detail = { plan, rewardRisk: rr, backtestId: bt.id, backtestWindow: bt.window, metrics };
      if (dryRun) {
        await log(
          user.id,
          runId,
          "would_deploy",
          `"${plan.title}" ${plan.direction} ${plan.tier} R:R ${rr.toFixed(2)}, backtest ${metrics.profitPct?.toFixed(2)}% over ${metrics.trades} trades (${bt.window})${limits.ok ? "" : ` (but live it would be blocked: ${limits.reason})`}`,
          { symbol, detail },
        );
        summary.wouldDeploy.push(symbol);
        continue;
      }
      if (!limits.ok) {
        await log(user.id, runId, "skip", `"${plan.title}" passed but ${limits.reason}`, { symbol, detail });
        continue;
      }

      const dep = await callRoute(deployRoute, "/api/deploy", {
        name: `Auto · ${plan.title}`.slice(0, 40),
        config: strategy.config,
        code: strategy.code,
        ...(plan.aliveUntil && !Number.isNaN(Date.parse(plan.aliveUntil)) ? { alive_until: plan.aliveUntil } : {}),
      });
      const id = dep.json.id as string | undefined;
      if (!id) {
        await log(user.id, runId, "error", `deploy failed: ${String(dep.json.message ?? dep.json.error ?? `HTTP ${dep.status}`)}`, {
          symbol,
          detail: { ...detail, response: dep.json },
        });
        summary.errors++;
        continue;
      }
      // Recorded as soon as the deployment exists, even if a later step
      // failed: it may hold funds, so the limits and stop-all must see it.
      await log(user.id, runId, "deployed", `"${plan.title}" ${plan.direction} on ${symbol}, $${s.stakeUsd} at ${s.leverage}x`, {
        symbol,
        deploymentId: id,
        detail: { ...detail, steps: dep.json.steps, stepErrors: dep.json.stepErrors ?? null },
      });
      await getDb()
        .insert(schema.deployments)
        .values({
          deploymentId: id,
          userId: user.id,
          planJson: JSON.stringify({ ...plan, autoTrade: true }),
          symbol,
          timeframe: s.timeframe,
          origin: "ours",
          mode: plan.mode === "one_shot" ? "one_shot" : "recurring",
          createdAt: Date.now(),
        })
        .onConflictDoNothing();
      summary.deployed.push(id);
      if (dep.json.stepErrors) {
        await log(user.id, runId, "error", `deployment ${id} was created but a step failed: ${JSON.stringify(dep.json.stepErrors)}`, {
          symbol,
          deploymentId: id,
        });
        summary.errors++;
      }
    } catch (err) {
      await log(user.id, runId, "error", err instanceof Error ? err.message : String(err), { symbol });
      summary.errors++;
    }
  }

  await log(
    user.id,
    runId,
    "run_end",
    `done: ${summary.deployed.length} deployed, ${summary.wouldDeploy.length} would deploy, ${summary.errors} error(s)`,
    { detail: summary },
  );
  return summary;
}

// ── stop everything ───────────────────────────────────────────────────────

/**
 * Turns auto mode off, then closes positions and stops every bot it started.
 * Off first, so a scheduled run starting mid-teardown finds nothing to do.
 */
export async function stopAll(): Promise<{ stopped: string[]; failed: Array<{ id: string; error: string }> }> {
  const user = await currentAccount();
  await saveSettings(user.id, { enabled: false });
  const key = superiorKey();
  const runId = `stop-${Date.now().toString(36)}`;
  const stopped: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  if (!key) {
    await log(user.id, runId, "stop_all", "auto mode turned off; no Superior Trade key, so no bots could be stopped");
    return { stopped, failed };
  }
  const mine = new Set((await autoDeployments(user.id)).map((d) => d.deploymentId).filter(Boolean) as string[]);
  const deps = await listDeployments(key);
  const live = ((deps.json.items ?? []) as Array<{ id?: string; status?: string; deletedAt?: string | null; exchange?: string | null }>)
    .filter((d) => d.id && mine.has(d.id) && deploymentOccupiesExchange(d, "hyperliquid"))
    .map((d) => d.id!);
  for (const id of live) {
    try {
      const exit = await controlDeployment(key, id, "exit");
      const stop = await controlDeployment(key, id, "stop");
      if (stop.status >= 400) throw new Error(`stop HTTP ${stop.status} (exit HTTP ${exit.status})`);
      stopped.push(id);
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await log(
    user.id,
    runId,
    "stop_all",
    `auto mode turned off; stopped ${stopped.length} bot(s)${failed.length ? `, ${failed.length} failed — stop them from the Running panel` : ""}`,
    { detail: { stopped, failed } },
  );
  return { stopped, failed };
}
