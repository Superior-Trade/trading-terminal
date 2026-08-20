"use client";

/* Market positioning — navbar-compact view of HyperTracker cohort data for
 * the active coin. Headline pill shows the divergence that matters (smart
 * money vs the crowd); the dropdown expands the full cohort breakdown.
 * Data is a process-wide 15-min server cache (see app/api/market-intel), so
 * this polls lightly and pauses while the tab is hidden. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/i18n";
import { usePair } from "./terminal-shell";

type Split = { long: number; short: number; pct: number | null };
type Intel = {
  available: boolean;
  coin?: string;
  count?: number;
  crowd?: Split;
  smart?: Split;
  whale?: Split;
  retail?: Split;
  rekt?: Split;
  updatedAt?: number;
};

const REFRESH_MS = 15 * 60 * 1000;

// Long-lean → brand accent (lime/theme); short-lean → red; flat → muted.
function leanClass(pct: number | null | undefined): string {
  if (pct == null) return "text-white/40";
  if (pct >= 0.55) return "text-lime-400";
  if (pct <= 0.45) return "text-red-400";
  return "text-white/70";
}
function pctLabel(s: Split | undefined): string {
  if (!s || s.pct == null) return "—";
  // One decimal so a near-neutral lean reads as what it is (50.4% ≠ 50.0%).
  return `${(s.pct * 100).toFixed(1)}%`;
}

export function MarketPositioning() {
  const { pair } = usePair();
  const { t, lang } = useLang();
  const zh = lang === "zh";
  const [intel, setIntel] = useState<Intel | null>(null);
  const [open, setOpen] = useState(false);
  const pairRef = useRef(pair);
  pairRef.current = pair;

  const load = useCallback(async () => {
    const p = pairRef.current;
    try {
      const r = await fetch(`/api/market-intel?coin=${encodeURIComponent(p)}`);
      const j = (await r.json()) as Intel;
      // Ignore a stale response if the user switched pairs mid-flight.
      if (pairRef.current === p) setIntel(j);
    } catch {
      /* leave last-known intel; next tick retries */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, pair]);

  // No data for this market (HIP-3 gap, key missing, or upstream down) → render
  // nothing rather than an empty pill.
  if (!intel || !intel.available || !intel.crowd || intel.crowd.pct == null) {
    return null;
  }

  const smart = intel.smart;
  const crowd = intel.crowd;
  // Divergence: smart and crowd on opposite sides of neutral.
  const diverges =
    smart?.pct != null &&
    crowd.pct != null &&
    (smart.pct - 0.5) * (crowd.pct - 0.5) < 0 &&
    Math.abs(smart.pct - 0.5) > 0.05 &&
    Math.abs(crowd.pct - 0.5) > 0.05;

  const rows: Array<{ key: string; label: string; s: Split | undefined }> = [
    { key: "smart", label: zh ? "聰明錢" : "Smart money", s: intel.smart },
    { key: "whale", label: zh ? "巨鯨" : "Whales", s: intel.whale },
    { key: "retail", label: zh ? "散戶" : "Retail", s: intel.retail },
    { key: "rekt", label: zh ? "虧損盤" : "Rekt money", s: intel.rekt },
  ];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 py-1 transition-colors ${
          open ? "text-white" : "text-white/80 hover:text-white"
        }`}
        title={zh ? "持倉分布 — 聰明錢 vs 散戶" : "Positioning — smart money vs the crowd"}
      >
        {diverges && (
          <span
            className="mr-0.5 h-1.5 w-1.5 rounded-full bg-amber-400"
            title={zh ? "聰明錢與散戶方向相反" : "Smart money is fading the crowd"}
          />
        )}
        <span className="font-mono text-[10px] uppercase tracking-widest text-white/45">
          {zh ? "聰明" : "SMART"}
        </span>
        <span className={`font-mono text-[12px] font-bold tabular-nums ${leanClass(smart?.pct)}`}>
          {pctLabel(smart)}
        </span>
        <span className="text-white/20">·</span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-white/45">
          {zh ? "散戶" : "CROWD"}
        </span>
        <span className={`font-mono text-[12px] font-bold tabular-nums ${leanClass(crowd.pct)}`}>
          {pctLabel(crowd)}
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-1/2 top-full z-50 mt-2 w-72 -translate-x-1/2">
            <div
              className="liquid-glass rounded-xl p-1.5 shadow-2xl"
              style={{
                background: "var(--menu-fill)",
                backdropFilter: "blur(28px)",
                WebkitBackdropFilter: "blur(28px)",
              }}
            >
              <div className="flex items-center justify-between px-2.5 py-1.5">
                <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-white/50">
                  {zh ? "持倉分布" : "Positioning"}
                </span>
                <span className="font-mono text-[9px] text-white/30">
                  {intel.count?.toLocaleString("en-US")} {zh ? "個帳戶" : "accts"}
                </span>
              </div>
              {rows.map((row) => (
                <div
                  key={row.key}
                  className="grid grid-cols-[minmax(0,1fr)_52px_44px] items-baseline gap-2 rounded-lg px-2.5 py-1.5"
                >
                  <span className="truncate text-[12px] text-white/75">{row.label}</span>
                  <span className={`text-right font-mono text-[12px] font-bold tabular-nums ${leanClass(row.s?.pct)}`}>
                    {pctLabel(row.s)}
                  </span>
                  <span className="text-right font-mono text-[9px] uppercase tracking-wider text-white/35">
                    {row.s && row.s.pct != null ? (row.s.pct >= 0.5 ? (zh ? "偏多" : "long") : (zh ? "偏空" : "short")) : ""}
                  </span>
                </div>
              ))}
              <p className="px-2.5 pb-1.5 pt-1 text-[10px] leading-snug text-white/35">
                {zh
                  ? "各群體帳戶的多空比例。"
                  : "Share of each cohort's accounts positioned long."}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
