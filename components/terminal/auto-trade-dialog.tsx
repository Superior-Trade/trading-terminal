"use client";

/* Auto mode — the rules auto mode trades by, its on/off and dry-run switches,
 * Run now, Stop all, and the log of every decision it made. Thin client over
 * /api/auto-trade; every limit is enforced server-side (lib/auto-trade), so
 * nothing here is the safety — it only shows and edits it.
 * English only for now: these strings are not in lib/i18n yet. */

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "../ui/dialog";
import { authFetch } from "../../lib/client-auth";

interface Settings {
  enabled: boolean;
  dryRun: boolean;
  pairs: string[];
  timeframe: "5m" | "15m" | "1h" | "4h";
  minTier: "S" | "A" | "B" | "C" | "D";
  minRewardRisk: number;
  stakeUsd: number;
  leverage: number;
  maxConcurrent: number;
  maxDeploysPerDay: number;
  dailyLossLimitUsd: number;
  backtestDays: number;
  minBacktestTrades: number;
  minBacktestProfitPct: number;
  maxBacktestDrawdownPct: number;
  intervalMinutes: number;
}

interface LogRow {
  id: number;
  kind: string;
  symbol: string | null;
  message: string;
  createdAt: number;
}

interface StatusResponse {
  settings: Settings;
  state: {
    tradingFrozen: boolean;
    runningAutoPairs: string[];
    deploysToday: number;
    realizedPnlToday: number | null;
  };
  lastRunAt: number | null;
  running: boolean;
  log: LogRow[];
  error?: string;
}

const KIND_STYLE: Record<string, string> = {
  deployed: "text-lime-400",
  would_deploy: "text-sky-300",
  reject: "text-white/45",
  skip: "text-white/45",
  error: "text-red-300",
  halt: "text-amber-300",
  stop_all: "text-amber-300",
  run_start: "text-white/30",
  run_end: "text-white/30",
};

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const NUM_FIELDS: Array<{ key: keyof Settings; label: string; step?: number }> = [
  { key: "stakeUsd", label: "Stake per bot (USDC)" },
  { key: "leverage", label: "Leverage (x)" },
  { key: "maxConcurrent", label: "Max bots at once" },
  { key: "maxDeploysPerDay", label: "Max deploys per day" },
  { key: "dailyLossLimitUsd", label: "Daily loss limit (USDC)" },
  { key: "minRewardRisk", label: "Min reward:risk", step: 0.1 },
  { key: "backtestDays", label: "Backtest days" },
  { key: "minBacktestTrades", label: "Min backtest trades" },
  { key: "minBacktestProfitPct", label: "Min backtest profit %", step: 0.5 },
  { key: "maxBacktestDrawdownPct", label: "Max backtest drawdown %" },
  { key: "intervalMinutes", label: "Scan every (minutes)" },
];

const inputCls =
  "w-full rounded-md border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-[12px] text-white outline-none focus:border-lime-400/60";
const labelCls = "mb-1 block font-mono text-[10px] uppercase tracking-wider text-white/45";

export function AutoTradeDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [pairsText, setPairsText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The change waiting on the "real money" confirmation, if any.
  const [confirmLive, setConfirmLive] = useState<Partial<Settings> | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);

  const load = useCallback(async (resetDraft = false) => {
    try {
      const r = await authFetch("/api/auto-trade");
      const j = (await r.json()) as StatusResponse;
      if (!r.ok) {
        setMsg(j.error ?? "Could not load auto mode");
        return;
      }
      setData(j);
      if (resetDraft) {
        setDraft(j.settings);
        setPairsText(j.settings.pairs.join(", "));
      }
    } catch {
      setMsg("Could not load auto mode");
    }
  }, []);

  useEffect(() => {
    void load(true);
    const id = setInterval(() => void load(false), 5000);
    return () => clearInterval(id);
  }, [load]);

  const save = async (patch: Partial<Settings>, opts: { confirmLive?: boolean } = {}) => {
    setBusy("save");
    setMsg(null);
    try {
      const r = await authFetch("/api/auto-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...patch, ...(opts.confirmLive ? { confirmLive: true } : {}) }),
      });
      const j = (await r.json().catch(() => ({}))) as { settings?: Settings; error?: string; needsConfirm?: boolean };
      if (r.status === 409 && j.needsConfirm) {
        setConfirmLive(patch);
        return false;
      }
      if (!r.ok || !j.settings) {
        setMsg(j.error ?? `Save failed (HTTP ${r.status})`);
        return false;
      }
      setDraft(j.settings);
      setPairsText(j.settings.pairs.join(", "));
      setMsg("Saved");
      await load(false);
      return true;
    } finally {
      setBusy(null);
    }
  };

  const saveRules = () => {
    if (!draft) return;
    const pairs = pairsText.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    // The on/off and dry-run switches have their own buttons; Save rules
    // must never be the thing that flips them.
    const rules: Partial<Settings> = { ...draft, pairs };
    delete rules.enabled;
    delete rules.dryRun;
    void save(rules);
  };

  const runNow = async () => {
    setBusy("run");
    setMsg(null);
    try {
      await authFetch("/api/auto-trade/run", { method: "POST" });
      setMsg("Run started — decisions appear in the log as they happen (a run takes a few minutes per pair).");
      setTimeout(() => void load(false), 1500);
    } finally {
      setBusy(null);
    }
  };

  const stopAll = async () => {
    setBusy("stop");
    setConfirmStop(false);
    try {
      const r = await authFetch("/api/auto-trade/stop-all", { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as { stopped?: string[]; failed?: unknown[]; error?: string };
      setMsg(
        r.ok
          ? `Auto mode off. Stopped ${j.stopped?.length ?? 0} bot(s)${j.failed?.length ? `, ${j.failed.length} failed — stop them from the Running panel` : ""}.`
          : (j.error ?? "Stop all failed"),
      );
      await load(true);
    } finally {
      setBusy(null);
    }
  };

  const s = data?.settings;
  const live = s ? s.enabled && !s.dryRun : false;
  const pnl = data?.state.realizedPnlToday;

  return (
    <Dialog title="Auto mode" size="lg" onClose={onClose}>
      {!data || !draft || !s ? (
        <div className="h-40 animate-pulse rounded-xl bg-white/[0.05]" />
      ) : (
        <div className="space-y-4">
          {/* Status + switches */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span
                className={`rounded-full px-2 py-0.5 font-bold uppercase tracking-wider ${
                  live ? "bg-lime-400 text-black" : s.enabled ? "bg-sky-400/20 text-sky-200" : "bg-white/10 text-white/60"
                }`}
              >
                {live ? "Live" : s.enabled ? "On · dry run" : "Off"}
              </span>
              {data.running && <span className="text-sky-300">Run in progress…</span>}
              {data.state.tradingFrozen && <span className="text-amber-300">Trading frozen by env</span>}
              <span className="text-white/45">
                Bots running: {data.state.runningAutoPairs.length}/{s.maxConcurrent} · Deploys today:{" "}
                {data.state.deploysToday}/{s.maxDeploysPerDay} · PnL today:{" "}
                {pnl == null ? "unknown" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC`}
              </span>
              {data.lastRunAt && <span className="text-white/35">Last run {fmtTime(data.lastRunAt)}</span>}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void save({ enabled: !s.enabled })}
                disabled={busy !== null}
                className="cursor-pointer rounded-lg bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-white transition hover:bg-white/15 disabled:opacity-50"
              >
                {s.enabled ? "Turn off" : "Turn on"}
              </button>
              <button
                onClick={() => (s.dryRun ? setConfirmLive({ dryRun: false }) : void save({ dryRun: true }))}
                disabled={busy !== null}
                className="cursor-pointer rounded-lg bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-white transition hover:bg-white/15 disabled:opacity-50"
              >
                {s.dryRun ? "Allow real deploys…" : "Back to dry run"}
              </button>
              <button
                onClick={() => void runNow()}
                disabled={busy !== null || data.running}
                className="cursor-pointer rounded-lg bg-lime-400 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-black transition hover:opacity-85 disabled:opacity-40"
              >
                {live ? "Run now" : "Dry run now"}
              </button>
              <button
                onClick={() => setConfirmStop(true)}
                disabled={busy !== null}
                className="ml-auto cursor-pointer rounded-lg bg-red-500/80 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-white transition hover:bg-red-500 disabled:opacity-50"
              >
                Stop all
              </button>
            </div>

            {confirmLive && (
              <div className="mt-3 rounded-lg border border-amber-300/40 bg-amber-300/10 p-3 font-mono text-[11px] text-amber-100">
                <p className="mb-2">
                  Real deploys use real money from your Superior Trade account. With auto mode on, it can start up to{" "}
                  {s.maxDeploysPerDay} bot(s) a day at ${s.stakeUsd} and {s.leverage}x each, without asking you
                  first. It stops opening new bots after a {s.dailyLossLimitUsd} USDC loss in a day, but bots already
                  running keep trading until they stop or you press Stop all.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmLive(null)}
                    className="cursor-pointer rounded-md bg-white/10 px-3 py-1 font-bold text-white/80 hover:bg-white/15"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      const ok = await save({ ...confirmLive, dryRun: false }, { confirmLive: true });
                      if (ok) setConfirmLive(null);
                    }}
                    className="cursor-pointer rounded-md bg-amber-400 px-3 py-1 font-bold text-black hover:opacity-85"
                  >
                    Allow real deploys
                  </button>
                </div>
              </div>
            )}

            {confirmStop && (
              <div className="mt-3 rounded-lg border border-red-400/40 bg-red-500/10 p-3 font-mono text-[11px] text-red-100">
                <p className="mb-2">
                  This turns auto mode off, closes the open positions of every bot auto mode started, and stops them.
                  Bots you deployed yourself are not touched.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmStop(false)}
                    className="cursor-pointer rounded-md bg-white/10 px-3 py-1 font-bold text-white/80 hover:bg-white/15"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void stopAll()}
                    className="cursor-pointer rounded-md bg-red-500 px-3 py-1 font-bold text-white hover:opacity-85"
                  >
                    Close positions and stop
                  </button>
                </div>
              </div>
            )}

            {msg && <p className="mt-2 font-mono text-[11px] text-white/60">{msg}</p>}
          </div>

          {/* Rules */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-3 font-mono text-[10px] font-bold uppercase tracking-widest text-white/55">Rules</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="sm:col-span-3">
                <span className={labelCls}>Pairs (comma separated, up to 10)</span>
                <input value={pairsText} onChange={(e) => setPairsText(e.target.value)} className={inputCls} />
              </label>
              <label>
                <span className={labelCls}>Timeframe</span>
                <select
                  value={draft.timeframe}
                  onChange={(e) => setDraft({ ...draft, timeframe: e.target.value as Settings["timeframe"] })}
                  className={inputCls}
                >
                  {["5m", "15m", "1h", "4h"].map((tf) => (
                    <option key={tf}>{tf}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelCls}>Min grade</span>
                <select
                  value={draft.minTier}
                  onChange={(e) => setDraft({ ...draft, minTier: e.target.value as Settings["minTier"] })}
                  className={inputCls}
                >
                  {["S", "A", "B", "C"].map((tier) => (
                    <option key={tier}>{tier}</option>
                  ))}
                </select>
              </label>
              {NUM_FIELDS.map((f) => (
                <label key={f.key}>
                  <span className={labelCls}>{f.label}</span>
                  <input
                    type="number"
                    step={f.step ?? 1}
                    value={String(draft[f.key])}
                    onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                    className={inputCls}
                  />
                </label>
              ))}
            </div>
            <div className="mt-3 flex justify-end">
              <button
                onClick={saveRules}
                disabled={busy !== null}
                className="cursor-pointer rounded-lg bg-lime-400 px-4 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-black transition hover:opacity-85 disabled:opacity-40"
              >
                Save rules
              </button>
            </div>
          </div>

          {/* Log */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-white/55">Decisions</div>
            {data.log.length === 0 ? (
              <p className="py-4 text-center font-mono text-[11px] text-white/40">
                Nothing yet. Press Dry run now to see what auto mode would do.
              </p>
            ) : (
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {data.log.map((row) => (
                  <li key={row.id} className="flex gap-2 font-mono text-[11px] leading-snug">
                    <span className="shrink-0 text-white/30">{fmtTime(row.createdAt)}</span>
                    {row.symbol && <span className="shrink-0 text-white/60">{row.symbol}</span>}
                    <span className={KIND_STYLE[row.kind] ?? "text-white/60"}>{row.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
