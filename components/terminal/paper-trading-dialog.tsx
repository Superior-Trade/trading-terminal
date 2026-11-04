"use client";

/* Paper trading — a virtual account running lib/paper/strategy.ts on live
 * Hyperliquid prices. Thin client over /api/paper; nothing here or behind it
 * can place an order. English only for now: these strings are not in
 * lib/i18n yet. */

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "../ui/dialog";
import { authFetch } from "../../lib/client-auth";

interface Position {
  coin: string;
  qty: number;
  entryPx: number;
  mid: number | null;
  unrealized: number | null;
}

interface PaperResponse {
  strategy: { name: string; rule: string; evidence: string[]; caveat: string };
  state: null | {
    startingUsd: number;
    cash: number;
    feesPaid: number;
    fundingPaid: number;
    realizedPnl: number;
    running: boolean;
    lastDecisionDay: string | null;
    createdAt: number;
  };
  equity?: number | null;
  positions?: Position[];
  events?: Array<{ id: number; kind: string; coin: string | null; message: string; createdAt: number }>;
  curve?: Array<{ equity: number; at: number }>;
  error?: string;
}

const KIND_STYLE: Record<string, string> = {
  buy: "text-lime-400",
  sell: "text-sky-300",
  decision: "text-white/50",
  start: "text-white/40",
  stop: "text-amber-300",
  error: "text-red-300",
};

const usd = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
const signed = (v: number) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Sparkline({ points, start }: { points: Array<{ equity: number }>; start: number }) {
  if (points.length < 2) {
    return <p className="font-mono text-[11px] text-white/40">The equity line appears after a couple of hourly snapshots.</p>;
  }
  const vals = points.map((p) => p.equity);
  const lo = Math.min(start, ...vals);
  const hi = Math.max(start, ...vals);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (points.length - 1)) * 300;
  const y = (v: number) => 60 - ((v - lo) / span) * 56 - 2;
  const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = vals[vals.length - 1]! >= start;
  return (
    <svg viewBox="0 0 300 60" className="h-16 w-full" preserveAspectRatio="none" aria-label="Equity over time">
      <line x1="0" x2="300" y1={y(start)} y2={y(start)} stroke="currentColor" strokeOpacity="0.2" strokeDasharray="3 3" />
      <path d={d} fill="none" stroke={up ? "#a3e635" : "#fca5a5"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function PaperTradingDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<PaperResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await authFetch("/api/paper");
      const j = (await r.json()) as PaperResponse;
      if (!r.ok) setMsg(j.error ?? "Could not load paper trading");
      else setData(j);
    } catch {
      setMsg("Could not load paper trading");
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  const post = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await authFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setMsg(r.ok ? done : (j.error ?? `Failed (HTTP ${r.status})`));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const s = data?.state;
  const eq = data?.equity;
  const pnl = s && eq != null ? eq - s.startingUsd : null;

  return (
    <Dialog title="Paper trading" size="lg" onClose={onClose}>
      {!data ? (
        <div className="h-40 animate-pulse rounded-xl bg-white/[0.05]" />
      ) : (
        <div className="space-y-4">
          <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-white/55">
            Virtual money on live Hyperliquid prices, with fees, slippage and funding charged. No real orders are ever placed.
          </p>

          {!s ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-center">
              <p className="mb-3 font-mono text-[12px] text-white/70">Start a $100 paper account running the {data.strategy.name}.</p>
              <button
                onClick={() => void post("/api/paper/start", { startingUsd: 100 }, "Started")}
                disabled={busy}
                className="cursor-pointer rounded-lg bg-lime-400 px-4 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-black transition hover:opacity-85 disabled:opacity-40"
              >
                Start with $100
              </button>
            </div>
          ) : (
            <>
              {/* Account */}
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono">
                  <span className="text-[20px] font-bold text-white">{eq == null ? "—" : usd(eq)}</span>
                  {pnl != null && (
                    <span className={`text-[13px] font-bold ${pnl >= 0 ? "text-lime-400" : "text-red-300"}`}>
                      {signed(pnl)} ({((pnl / s.startingUsd) * 100).toFixed(2)}%)
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                      s.running ? "bg-lime-400/15 text-lime-300" : "bg-amber-300/15 text-amber-200"
                    }`}
                  >
                    {s.running ? "Running" : "Paused"}
                  </span>
                </div>
                <div className="mb-3 font-mono text-[10.5px] text-white/45">
                  Started {fmtTime(s.createdAt)} with {usd(s.startingUsd)} · Cash {usd(s.cash)} · Fees {usd(s.feesPaid)} · Funding{" "}
                  {signed(-s.fundingPaid)} · Realized {signed(s.realizedPnl)}
                  {s.lastDecisionDay && ` · Last decided on the ${s.lastDecisionDay} close`}
                </div>
                <Sparkline points={data.curve ?? []} start={s.startingUsd} />

                {(data.positions ?? []).length > 0 && (
                  <table className="mt-3 w-full font-mono text-[11px]">
                    <thead className="text-white/40">
                      <tr>
                        <th className="text-left font-normal">Coin</th>
                        <th className="text-right font-normal">Size</th>
                        <th className="text-right font-normal">Entry</th>
                        <th className="text-right font-normal">Now</th>
                        <th className="text-right font-normal">Open P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.positions!.map((p) => (
                        <tr key={p.coin} className="text-white/80">
                          <td>{p.coin}</td>
                          <td className="text-right">{p.qty.toPrecision(4)}</td>
                          <td className="text-right">${p.entryPx.toFixed(2)}</td>
                          <td className="text-right">{p.mid == null ? "—" : `$${p.mid.toFixed(2)}`}</td>
                          <td className={`text-right ${(p.unrealized ?? 0) >= 0 ? "text-lime-400" : "text-red-300"}`}>
                            {p.unrealized == null ? "—" : signed(p.unrealized)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => void post("/api/paper/pause", { paused: s.running }, s.running ? "Paused" : "Resumed")}
                    disabled={busy}
                    className="cursor-pointer rounded-lg bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-white transition hover:bg-white/15 disabled:opacity-50"
                  >
                    {s.running ? "Pause" : "Resume"}
                  </button>
                  <button
                    onClick={() => setConfirmRestart(true)}
                    disabled={busy}
                    className="cursor-pointer rounded-lg bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-white/70 transition hover:bg-white/15 disabled:opacity-50"
                  >
                    Restart at $100
                  </button>
                </div>
                {confirmRestart && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[11px] text-white/70">
                    <span>This wipes the paper account and its history.</span>
                    <button
                      onClick={() => setConfirmRestart(false)}
                      className="cursor-pointer rounded-md bg-white/10 px-2 py-1 font-bold hover:bg-white/15"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        setConfirmRestart(false);
                        void post("/api/paper/start", { startingUsd: 100 }, "Restarted with $100");
                      }}
                      className="cursor-pointer rounded-md bg-red-500/80 px-2 py-1 font-bold text-white hover:bg-red-500"
                    >
                      Restart
                    </button>
                  </div>
                )}
              </div>

              {/* Decisions */}
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-white/55">Decisions</div>
                <ul className="max-h-60 space-y-1 overflow-y-auto">
                  {(data.events ?? []).map((e) => (
                    <li key={e.id} className="flex gap-2 font-mono text-[11px] leading-snug">
                      <span className="shrink-0 text-white/30">{fmtTime(e.createdAt)}</span>
                      <span className={KIND_STYLE[e.kind] ?? "text-white/60"}>{e.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          {msg && <p className="font-mono text-[11px] text-white/60">{msg}</p>}

          {/* Strategy */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 font-mono text-[11px] text-white/65">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-white/55">{data.strategy.name}</div>
            <p className="mb-2">{data.strategy.rule}</p>
            <ul className="mb-2 list-disc space-y-0.5 pl-4 text-white/50">
              {data.strategy.evidence.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="text-amber-200/80">{data.strategy.caveat}</p>
          </div>
        </div>
      )}
    </Dialog>
  );
}
