"use client";

/* Footprint chart — our own renderer, since the TV library's Volume
 * Footprint ships inert in this build. Renders per-price-level aggressor
 * volume (sell × buy) inside each time bucket, imbalance highlighting,
 * per-column POC, delta/total footers, and a session volume profile on
 * the right — fed live from Hyperliquid's public trades WebSocket.
 * HL exposes no public-trade history, so the picture accumulates from
 * toggle-on (recentTrades seeds only a few prints).
 */

import { useEffect, useRef, useState } from "react";
import { useHyperliquid, pairToCoin } from "../../lib/hyperliquid-provider";
import { useLang } from "../../lib/i18n";

const IMBALANCE = 3; // buy/sell ratio at a level to highlight
const COL_W = 104;
const PROFILE_W = 150;
const AXIS_W = 74;

type Cell = { b: number; s: number }; // aggressive buy / sell notional ($)

function fmtK(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return v > 0 ? `${Math.round(v)}` : "·";
}

export function OrderFlowPanel({ pair }: { pair: string }) {
  const { subscription } = useHyperliquid();
  const { t } = useLang();
  // The canvas draw loop is created once (effect deps []) — it reads
  // translations via this ref so a language switch repaints correctly.
  const tRef = useRef(t);
  tRef.current = t;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bucketsRef = useRef<Map<number, Map<number, Cell>>>(new Map());
  const binRef = useRef<number | null>(null);
  const lastPxRef = useRef<number | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [binShown, setBinShown] = useState<number | null>(null);

  // ── Cells come from the server-side tape recorder (persistent history —
  // the API call also starts/resumes recording for this coin). The client
  // WS is used only for the live last-price line.
  const [recStartedAt, setRecStartedAt] = useState<number | null>(null);
  useEffect(() => {
    bucketsRef.current = new Map();
    binRef.current = null;
    setBinShown(null);
    let cancelled = false;
    const coin = pairToCoin(pair);
    const load = async () => {
      try {
        const { authFetch } = await import("../../lib/client-auth");
        const r = await authFetch(`/api/orderflow?coin=${encodeURIComponent(coin)}`);
        const j = (await r.json()) as {
          binSize: number | null;
          startedAt: number | null;
          cells: Array<{ bucket: number; bin: number; buy: number; sell: number }>;
        };
        if (cancelled) return;
        if (j.binSize) {
          binRef.current = j.binSize;
          setBinShown(j.binSize);
        }
        setRecStartedAt(j.startedAt ?? null);
        const next = new Map<number, Map<number, Cell>>();
        for (const row of j.cells ?? []) {
          let bucket = next.get(row.bucket);
          if (!bucket) {
            bucket = new Map();
            next.set(row.bucket, bucket);
          }
          bucket.set(row.bin, { b: row.buy, s: row.sell });
        }
        bucketsRef.current = next;
      } catch {
        /* next poll retries */
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 4_000);
    // live last-price line
    let sub: { unsubscribe: () => Promise<unknown> } | null = null;
    (async () => {
      try {
        sub = await subscription.trades({ coin }, (trades) => {
          const last = (trades as Array<{ px: string }>).at(-1);
          if (last) lastPxRef.current = parseFloat(last.px);
        });
      } catch {
        /* line just stays hidden */
      }
      if (cancelled) sub?.unsubscribe().catch(() => {});
    })();
    return () => {
      cancelled = true;
      clearInterval(timer);
      sub?.unsubscribe().catch(() => {});
    };
  }, [subscription, pair]);

  // ── Render loop ──
  useEffect(() => {
    const draw = () => {
      const c = canvasRef.current;
      if (!c) return;
      const dpr = devicePixelRatio || 1;
      const W = (c.width = c.clientWidth * dpr);
      const H = (c.height = c.clientHeight * dpr);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.scale(1, 1);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#07090b";
      ctx.fillRect(0, 0, W, H);
      const bin = binRef.current;
      const buckets = [...bucketsRef.current.entries()].sort((a, b) => a[0] - b[0]);
      const mono = `${11 * dpr}px ui-monospace, monospace`;
      if (!bin || !buckets.length) {
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.font = mono;
        ctx.fillText(tRef.current("ofCollecting"), 24 * dpr, 40 * dpr);
        return;
      }

      const colW = COL_W * dpr;
      const profileW = PROFILE_W * dpr;
      const axisW = AXIS_W * dpr;
      const footerH = 40 * dpr;
      const maxCols = Math.max(1, Math.floor((W - profileW - axisW) / colW));
      const visible = buckets.slice(-maxCols);

      // Collect visible price levels + session profile
      const levels = new Set<number>();
      const profile = new Map<number, Cell>();
      for (const [, bucket] of buckets) {
        for (const [lvl, cell] of bucket) {
          const p = profile.get(lvl) ?? { b: 0, s: 0 };
          p.b += cell.b;
          p.s += cell.s;
          profile.set(lvl, p);
        }
      }
      for (const [, bucket] of visible) for (const lvl of bucket.keys()) levels.add(lvl);
      const sorted = [...levels].sort((a, b) => b - a);
      if (!sorted.length) return;
      const rowH = Math.min(22 * dpr, Math.max(13 * dpr, (H - footerH - 8 * dpr) / sorted.length));
      const rowY = new Map<number, number>();
      sorted.forEach((lvl, i) => rowY.set(lvl, 6 * dpr + i * rowH));

      const maxCell = Math.max(
        1,
        ...visible.flatMap(([, b]) => [...b.values()].map((c2) => c2.b + c2.s)),
      );
      ctx.font = mono;
      ctx.textBaseline = "middle";

      visible.forEach(([bt, bucket], ci) => {
        const x = ci * colW;
        // POC = loudest level in this column
        let poc = -1;
        let pocVol = 0;
        for (const [lvl, cell] of bucket)
          if (cell.b + cell.s > pocVol) {
            pocVol = cell.b + cell.s;
            poc = lvl;
          }
        let delta = 0;
        let total = 0;
        for (const [lvl, cell] of bucket) {
          const y = rowY.get(lvl);
          if (y == null) continue;
          delta += cell.b - cell.s;
          total += cell.b + cell.s;
          const heat = Math.min(1, (cell.b + cell.s) / maxCell);
          const bullish = cell.b >= cell.s;
          ctx.fillStyle = bullish
            ? `rgba(74,124,42,${0.14 + heat * 0.5})`
            : `rgba(140,58,58,${0.14 + heat * 0.5})`;
          ctx.fillRect(x + 2 * dpr, y, colW - 4 * dpr, rowH - 1.5 * dpr);
          // imbalance outline
          const ratio = cell.s > 0 ? cell.b / cell.s : Infinity;
          if (ratio >= IMBALANCE || ratio <= 1 / IMBALANCE) {
            ctx.strokeStyle = ratio >= IMBALANCE ? "rgba(163,230,53,0.9)" : "rgba(248,113,113,0.9)";
            ctx.lineWidth = 1.2 * dpr;
            ctx.strokeRect(x + 2 * dpr, y, colW - 4 * dpr, rowH - 1.5 * dpr);
          }
          if (lvl === poc) {
            ctx.strokeStyle = "rgba(255,255,255,0.85)";
            ctx.lineWidth = 1.4 * dpr;
            ctx.strokeRect(x + 2 * dpr, y, colW - 4 * dpr, rowH - 1.5 * dpr);
          }
          // sell × buy numbers
          ctx.fillStyle = "rgba(248,180,180,0.95)";
          ctx.textAlign = "right";
          ctx.fillText(fmtK(cell.s), x + colW / 2 - 4 * dpr, y + rowH / 2);
          ctx.fillStyle = "rgba(190,235,140,0.95)";
          ctx.textAlign = "left";
          ctx.fillText(fmtK(cell.b), x + colW / 2 + 4 * dpr, y + rowH / 2);
        }
        // column footer: time, delta, total
        ctx.textAlign = "center";
        const fx = x + colW / 2;
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.fillText(
          new Date(bt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          fx,
          H - footerH + 8 * dpr,
        );
        ctx.fillStyle = delta >= 0 ? "rgba(163,230,53,0.95)" : "rgba(248,113,113,0.95)";
        ctx.fillText(`Δ ${delta >= 0 ? "" : "−"}${fmtK(Math.abs(delta))}`, fx, H - footerH + 21 * dpr);
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.fillText(fmtK(total), fx, H - footerH + 34 * dpr);
      });

      // session profile (right)
      const maxProf = Math.max(1, ...[...profile.values()].map((p) => p.b + p.s));
      for (const [lvl, p] of profile) {
        const y = rowY.get(lvl);
        if (y == null) continue;
        const w = ((p.b + p.s) / maxProf) * (profileW - 12 * dpr);
        const bullish = p.b >= p.s;
        ctx.fillStyle = bullish ? "rgba(74,124,42,0.55)" : "rgba(140,58,58,0.55)";
        ctx.fillRect(W - axisW - w, y, w, rowH - 1.5 * dpr);
      }
      // price axis
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      const axisEvery = Math.max(1, Math.round((18 * dpr) / rowH));
      sorted.forEach((lvl, i) => {
        if (i % axisEvery) return;
        ctx.fillText(lvl.toLocaleString("en-US"), W - axisW + 6 * dpr, rowY.get(lvl)! + rowH / 2);
      });
      // last price line
      const lp = lastPxRef.current;
      if (lp && bin) {
        const lvl = Math.floor(lp / bin) * bin;
        const y = rowY.get(lvl);
        if (y != null) {
          ctx.strokeStyle = "rgba(163,230,53,0.8)";
          ctx.setLineDash([4 * dpr, 4 * dpr]);
          ctx.lineWidth = 1 * dpr;
          ctx.beginPath();
          ctx.moveTo(0, y + rowH / 2);
          ctx.lineTo(W - axisW, y + rowH / 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    };
    draw();
    const timer = setInterval(draw, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="absolute inset-0 z-30 flex flex-col" style={{ background: "#07090b" }}>
      <div className="flex items-center gap-3 border-b border-white/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest">
        <span className="font-bold text-lime-300">{t("ofTitle")}</span>
        <span className="text-white/40">
          {pairToCoin(pair)} · 5m · {t("ofBin")} {binShown ?? "…"}
        </span>
        <span className="text-white/35">
          {t("ofImb")} ≥{IMBALANCE}:1
        </span>
        <span className="ml-auto text-white/30">
          {t("ofSince")}{" "}
          {new Date(recStartedAt ?? startedAt).toLocaleString([], {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
      <canvas ref={canvasRef} className="min-h-0 w-full flex-1" />
    </div>
  );
}
