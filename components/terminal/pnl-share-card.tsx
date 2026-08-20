"use client";

/* PnL share card — exchange-style (Binance/Bybit PnL poster) adapted to
 * strategy trading: direction + leverage + pair, big ROI%, realized PnL,
 * stake / fills / runtime rows, and the strategy's real equity curve.
 * Canvas-rendered at full resolution (1080-wide class), so downloads are
 * crisp regardless of preview size. Background images are user-supplied and
 * live ONLY in the browser (localStorage dataURL) — never uploaded.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/i18n";
import { Dialog } from "../ui/dialog";
import { useHyperliquid, pairToCoin } from "../../lib/hyperliquid-provider";

export interface PnlCardTrade {
  t: number; // ms epoch
  coin: string;
  dir: "long" | "short";
  pnl: number; // closedPnl - fee for closing fills; 0 while open
  realized: boolean;
  px?: number | null; // fill price — anchors the marker on the price chart
}

export interface CardCandle {
  t: number; // ms epoch
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface PnlCardData {
  strategyName: string;
  pair: string; // display pair, e.g. "xyz:SNDK" or "BTC-USD"
  direction: "long" | "short" | "neutral" | null;
  leverage: number | null;
  stake: number | null;
  totalPnl: number; // realized
  unrealizedPnl: number; // open positions right now
  tradeCount: number;
  startedAt: number | null; // ms epoch
  points: Array<{ t: number; v: number }>;
  trades: PnlCardTrade[]; // recent first
}

type Ratio = "1:1" | "4:5" | "9:16" | "16:9";
const RATIOS: Record<Ratio, { w: number; h: number }> = {
  "1:1": { w: 1080, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
  "9:16": { w: 1080, h: 1920 },
  "16:9": { w: 1600, h: 900 },
};

// Preset backdrops: brand-dark gradients that keep text legible.
const PRESETS: Array<{ id: string; stops: [string, string, string] }> = [
  { id: "carbon", stops: ["#07090b", "#0d1117", "#0a0f0a"] },
  { id: "lime", stops: ["#060906", "#0c1409", "#1a2b0d"] },
  { id: "ocean", stops: ["#05070c", "#081121", "#0a1a2e"] },
];

const BG_KEY = "cg-pnlcard-bg"; // user image (dataURL), frontend-only

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const s = abs >= 1000 ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 }) : abs.toFixed(2);
  return `${v < 0 ? "-" : "+"}$${s}`;
}

function runtime(startedAt: number | null, zh: boolean): string {
  if (!startedAt) return "—";
  const mins = Math.max(1, Math.floor((Date.now() - startedAt) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (zh) return d > 0 ? `${d} 天 ${h} 小時` : h > 0 ? `${h} 小時 ${mins % 60} 分` : `${mins} 分鐘`;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Draws the whole card. Pure of React so it can render at any size. */
async function drawCard(
  canvas: HTMLCanvasElement,
  data: PnlCardData,
  opts: {
    ratio: Ratio;
    bg: string;
    userBg: string | null;
    zh: boolean;
    candles?: CardCandle[] | null;
  },
) {
  const { w: W, h: H } = RATIOS[opts.ratio];
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  await document.fonts.ready;

  // Canvas can't resolve CSS vars in font shorthand, and next/font mangles
  // family names — read the real families off :root so the card uses the
  // app's actual typefaces instead of generic fallbacks.
  const rootStyle = getComputedStyle(document.documentElement);
  const monoFam =
    rootStyle.getPropertyValue("--font-space-mono").trim() || "ui-monospace, monospace";
  const sansFam =
    rootStyle.getPropertyValue("--font-dm-sans").trim() || "ui-sans-serif, sans-serif";
  const monoF = (px: number, weight = 700) => `${weight} ${px}px ${monoFam}, ui-monospace, monospace`;
  const sansF = (px: number, weight = 600) => `${weight} ${px}px ${sansFam}, ui-sans-serif, sans-serif`;

  // ── Backdrop ──
  if (opts.userBg) {
    try {
      const img = await loadImage(opts.userBg);
      // cover-fit
      const s = Math.max(W / img.width, H / img.height);
      const dw = img.width * s;
      const dh = img.height * s;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      // Legibility scrim: darken + bottom-heavy gradient.
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, W, H);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "rgba(0,0,0,0.15)");
      g.addColorStop(1, "rgba(0,0,0,0.55)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    } catch {
      opts.userBg = null; // fall through to preset
    }
  }
  if (!opts.userBg) {
    const preset = PRESETS.find((p) => p.id === opts.bg) ?? PRESETS[0];
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, preset.stops[0]);
    g.addColorStop(0.55, preset.stops[1]);
    g.addColorStop(1, preset.stops[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Subtle radial glow behind the ROI figure.
    const up = data.totalPnl + data.unrealizedPnl >= 0;
    const rg = ctx.createRadialGradient(W * 0.32, H * 0.42, 0, W * 0.32, H * 0.42, W * 0.55);
    rg.addColorStop(0, up ? "rgba(163,230,53,0.10)" : "rgba(248,113,113,0.10)");
    rg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }

  // Type scale rides the SMALLER axis (weighted) so landscape (16:9) text
  // doesn't outgrow the card height and collide with the curve.
  const U = Math.min(W, H * 1.15);
  const landscape = W > H;
  const M = Math.round(U * 0.065); // margin
  // Overall = realized + open — the strategy's true standing, not just
  // closed trades.
  const overall = data.totalPnl + data.unrealizedPnl;
  const up = overall >= 0;
  const lime = "#a3e635";
  const red = "#f87171";
  const accent = up ? lime : red;
  const zh = opts.zh;

  // ── Header: logo + wordmark ──
  let y = M;
  try {
    const logo = await loadImage("/logo-dark.png");
    const ls = Math.round(U * 0.052);
    ctx.drawImage(logo, M, y, ls, ls);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = sansF(Math.round(U * 0.03), 700);
    ctx.textBaseline = "middle";
    ctx.fillText("Superior Trade", M + ls + Math.round(U * 0.018), y + ls / 2);
  } catch {
    /* logo missing: wordmark only */
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = sansF(Math.round(U * 0.03), 700);
    ctx.textBaseline = "middle";
    ctx.fillText("Superior Trade", M, y + Math.round(U * 0.026));
  }

  // ── Badges: direction · leverage · pair ──
  y += Math.round(U * 0.115);
  ctx.textBaseline = "middle";
  let bx = M;
  const badgeH = Math.round(U * 0.052);
  const badge = (text: string, fg: string, bg: string) => {
    ctx.font = monoF(Math.round(badgeH * 0.5), 700);
    const tw = ctx.measureText(text).width;
    const bw = tw + badgeH * 0.9;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(bx, y, bw, badgeH, badgeH / 4);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(text, bx + badgeH * 0.45, y + badgeH / 2 + 1);
    bx += bw + badgeH * 0.3;
  };
  if (data.direction)
    badge(
      zh
        ? data.direction === "long"
          ? "做多"
          : data.direction === "short"
            ? "做空"
            : "中性"
        : data.direction.toUpperCase(),
      data.direction === "neutral" ? "rgba(255,255,255,0.9)" : "#000",
      data.direction === "long" ? lime : data.direction === "short" ? red : "rgba(255,255,255,0.16)",
    );
  if (data.leverage) badge(`${data.leverage}×`, "rgba(255,255,255,0.9)", "rgba(255,255,255,0.12)");
  badge(data.pair, "rgba(255,255,255,0.9)", "rgba(255,255,255,0.12)");

  // ── Strategy name ──
  y += badgeH + Math.round(U * 0.045);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = sansF(Math.round(U * 0.034), 600);
  const nameMax = W - M * 2;
  let name = data.strategyName;
  while (ctx.measureText(name).width > nameMax && name.length > 4) name = name.slice(0, -2);
  if (name !== data.strategyName) name += "…";
  ctx.fillText(name, M, y);

  // ── Big ROI% ──
  const roi = data.stake ? (overall / data.stake) * 100 : null;
  y += Math.round(U * 0.13);
  ctx.fillStyle = accent;
  ctx.font = monoF(Math.round(U * 0.115), 700);
  const roiText = roi != null ? `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%` : fmtUsd(overall);
  ctx.fillText(roiText, M, y);
  // PnL$ under it (or fills note when ROI hidden)
  y += Math.round(U * 0.055);
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.font = monoF(Math.round(U * 0.036), 700);
  if (roi != null) {
    const parts = [`${fmtUsd(data.totalPnl)} ${zh ? "已實現" : "realized"}`];
    if (Math.abs(data.unrealizedPnl) >= 0.01)
      parts.push(`${fmtUsd(data.unrealizedPnl)} ${zh ? "未實現" : "open"}`);
    ctx.fillText(parts.join("  ·  "), M, y);
  }

  // ── Detail rows ──
  const rows: Array<[string, string]> = [
    [zh ? "本金" : "Stake", data.stake != null ? `$${data.stake.toLocaleString("en-US")}` : "—"],
    [zh ? "成交筆數" : "Fills", String(data.tradeCount)],
    [zh ? "運行時間" : "Runtime", runtime(data.startedAt, zh)],
  ];
  y += Math.round(U * 0.075);
  const rowsTop = y;
  ctx.font = monoF(Math.round(U * 0.024), 400);
  for (const [k, v] of rows) {
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText(k, M, y);
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillText(v, M + Math.round(U * 0.19), y);
    y += Math.round(U * 0.045);
  }

  // ── Trade history column (recent trades; realized vs still-open) ──
  // Portrait/square: a SECOND column beside the detail rows (horizontal
  // space is abundant there). Landscape: below the rows in the left column,
  // capped by the footer. Never overlaps the curve or the bottom edge.
  const curveH = landscape ? Math.round(H * 0.42) : Math.round(H * 0.16);
  const curveTop = landscape
    ? Math.round(H * 0.32)
    : H - M - Math.round(U * 0.075) - curveH;
  const rowH = Math.round(U * 0.038);
  if (data.trades.length) {
    let tx: number; // column x origin
    let ty: number; // first line y
    let limit: number;
    if (landscape) {
      ty = y + Math.round(U * 0.02);
      tx = M;
      limit = H - M - rowH;
    } else {
      // Side column: aligned with the detail rows, right half of the card.
      tx = Math.round(W * 0.47);
      ty = rowsTop;
      limit = curveTop - rowH;
    }
    if (limit - ty > rowH * 1.8) {
      ctx.font = monoF(Math.round(U * 0.02), 700);
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.fillText(zh ? "交易紀錄" : "TRADES", tx, ty);
      ty += rowH;
      ctx.font = monoF(Math.round(U * 0.021), 400);
      const maxRows = Math.min(
        data.trades.length,
        Math.max(0, Math.floor((limit - ty) / rowH) + 1),
      );
      for (const tr of data.trades.slice(0, maxRows)) {
        const d = new Date(tr.t);
        const when = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillText(when, tx, ty);
        ctx.fillStyle = tr.dir === "long" ? lime : red;
        ctx.fillText(
          zh ? (tr.dir === "long" ? "多" : "空") : tr.dir === "long" ? "L" : "S",
          tx + Math.round(U * 0.075),
          ty,
        );
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.fillText(tr.coin, tx + Math.round(U * 0.105), ty);
        if (tr.realized) {
          ctx.fillStyle = tr.pnl >= 0 ? lime : red;
          ctx.fillText(fmtUsd(tr.pnl), tx + Math.round(U * 0.21), ty);
          ctx.fillStyle = "rgba(255,255,255,0.4)";
          ctx.fillText(zh ? "已實現" : "realized", tx + Math.round(U * 0.33), ty);
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.4)";
          ctx.fillText(zh ? "持倉中" : "open", tx + Math.round(U * 0.21), ty);
        }
        ty += rowH;
      }
    }
  }

  // ── Equity curve (the strategy-trading differentiator) ──
  // Portrait/square: bottom strip under the text column. Landscape (16:9):
  // right panel beside the text so the two never collide.
  // Price chart with position markers when candles are available; otherwise
  // the equity area chart. (User ask: show the pair chart and its positions.)
  const chartArea = {
    ch: curveH,
    cy: curveTop,
    cx: landscape ? Math.round(W * 0.55) : M,
    cw: landscape ? W - M - Math.round(W * 0.55) : W - M * 2,
  };
  const candles = opts.candles ?? [];
  if (candles.length >= 5) {
    const { ch, cy, cx, cw } = chartArea;
    const lo = Math.min(...candles.map((k) => k.l));
    const hi = Math.max(...candles.map((k) => k.h));
    const span = hi - lo || 1;
    const pyP = (v: number) => cy + ch - ((v - lo) / span) * ch;
    const t0 = candles[0].t;
    const t1 = candles[candles.length - 1].t || t0 + 1;
    const pxT = (tms: number) => cx + ((tms - t0) / (t1 - t0)) * cw;
    const bw = Math.max(2, (cw / candles.length) * 0.6);
    for (const k of candles) {
      const x = pxT(k.t);
      const green = k.c >= k.o;
      ctx.strokeStyle = green ? "rgba(163,230,53,0.75)" : "rgba(248,113,113,0.75)";
      ctx.fillStyle = green ? "rgba(163,230,53,0.75)" : "rgba(248,113,113,0.75)";
      ctx.lineWidth = Math.max(1, bw * 0.18);
      ctx.beginPath();
      ctx.moveTo(x, pyP(k.h));
      ctx.lineTo(x, pyP(k.l));
      ctx.stroke();
      const top = pyP(Math.max(k.o, k.c));
      const hgt = Math.max(1.5, Math.abs(pyP(k.o) - pyP(k.c)));
      ctx.fillRect(x - bw / 2, top, bw, hgt);
    }
    // Equity curve as a faint overlay (normalized to the same area).
    if (data.points.length >= 2) {
      const vs = data.points.map((p) => p.v);
      const vmin = Math.min(...vs, 0);
      const vmax = Math.max(...vs, 0);
      const vspan = vmax - vmin || 1;
      ctx.beginPath();
      data.points.forEach((p, i) => {
        const x = cx + (i / (data.points.length - 1)) * cw;
        const yv = cy + ch - ((p.v - vmin) / vspan) * ch * 0.9;
        if (i === 0) ctx.moveTo(x, yv);
        else ctx.lineTo(x, yv);
      });
      ctx.strokeStyle = up ? "rgba(163,230,53,0.28)" : "rgba(248,113,113,0.28)";
      ctx.lineWidth = Math.max(2, U * 0.0025);
      ctx.stroke();
    }
    // Position markers: ▲ open long / ▼ open short / ● close, at fill px.
    const mk = Math.max(6, U * 0.011);
    for (const tr of data.trades) {
      if (tr.px == null || tr.t < t0 || tr.t > t1) continue;
      const x = pxT(tr.t);
      // Clamp into the plot: a fill outside the visible price range pins to
      // the chart edge instead of stamping over the footer.
      const yv = Math.min(cy + ch - mk, Math.max(cy + mk, pyP(tr.px)));
      ctx.beginPath();
      if (!tr.realized) {
        // open — direction triangle
        if (tr.dir === "long") {
          ctx.moveTo(x, yv - mk);
          ctx.lineTo(x - mk * 0.9, yv + mk * 0.7);
          ctx.lineTo(x + mk * 0.9, yv + mk * 0.7);
        } else {
          ctx.moveTo(x, yv + mk);
          ctx.lineTo(x - mk * 0.9, yv - mk * 0.7);
          ctx.lineTo(x + mk * 0.9, yv - mk * 0.7);
        }
        ctx.closePath();
        ctx.fillStyle = tr.dir === "long" ? lime : red;
        ctx.fill();
      } else {
        ctx.arc(x, yv, mk * 0.62, 0, Math.PI * 2);
        ctx.fillStyle = tr.pnl >= 0 ? lime : red;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  } else if (data.points.length >= 2) {
    const { ch, cy, cx, cw } = chartArea;
    const vs = data.points.map((p) => p.v);
    const min = Math.min(...vs, 0);
    const max = Math.max(...vs, 0);
    const span = max - min || 1;
    const px = (i: number) => cx + (i / (data.points.length - 1)) * cw;
    const py = (v: number) => cy + ch - ((v - min) / span) * ch;
    // zero line
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.setLineDash([6, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, py(0));
    ctx.lineTo(cx + cw, py(0));
    ctx.stroke();
    ctx.setLineDash([]);
    // area fill
    const ag = ctx.createLinearGradient(0, cy, 0, cy + ch);
    ag.addColorStop(0, up ? "rgba(163,230,53,0.25)" : "rgba(248,113,113,0.25)");
    ag.addColorStop(1, "rgba(0,0,0,0)");
    ctx.beginPath();
    ctx.moveTo(px(0), py(vs[0]));
    vs.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.lineTo(cx + cw, cy + ch);
    ctx.lineTo(cx, cy + ch);
    ctx.closePath();
    ctx.fillStyle = ag;
    ctx.fill();
    // stroke
    ctx.beginPath();
    ctx.moveTo(px(0), py(vs[0]));
    vs.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(3, U * 0.004);
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  // ── Footer ──
  ctx.font = monoF(Math.round(U * 0.022), 400);
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  const date = new Date().toISOString().slice(0, 10);
  // The terminal's own host — a shared card should land someone on the thing
  // that produced it, not on the marketing site.
  ctx.fillText("terminal.superior.trade", M, H - M * 0.7);
  const dw2 = ctx.measureText(date).width;
  ctx.fillText(date, W - M - dw2, H - M * 0.7);
}

export function PnlShareCard({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  const { t, lang } = useLang();
  const zh = lang === "zh";
  // State-backed ref: the Dialog portals and mounts a tick later than this
  // component — a plain ref leaves the first draw with a null canvas (blank
  // card). State re-runs the draw effect when the canvas actually attaches.
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ratio, setRatio] = useState<Ratio>("1:1");
  const [bg, setBg] = useState<string>(PRESETS[0].id);
  const [userBg, setUserBg] = useState<string | null>(() => {
    try {
      return localStorage.getItem(BG_KEY);
    } catch {
      return null;
    }
  });
  const [useUserBg, setUseUserBg] = useState(false);
  const [busy, setBusy] = useState(false);

  // Pair candles for the price chart: interval scales with the strategy's
  // runtime so the whole trading window fits in ~60 bars.
  const { info } = useHyperliquid();
  const [candles, setCandles] = useState<CardCandle[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const start = data.startedAt ?? Date.now() - 3 * 86400_000;
        const spanH = (Date.now() - start) / 3600_000;
        const interval = spanH > 24 * 14 ? "1d" : spanH > 72 ? "4h" : "1h";
        const raw = await info.candleSnapshot({
          coin: pairToCoin(data.pair),
          interval,
          startTime: start - 6 * 3600_000,
          endTime: Date.now(),
        });
        if (cancelled) return;
        setCandles(
          (raw ?? []).slice(-80).map((k) => ({
            t: k.t,
            o: parseFloat(k.o),
            h: parseFloat(k.h),
            l: parseFloat(k.l),
            c: parseFloat(k.c),
          })),
        );
      } catch {
        if (!cancelled) setCandles([]); // equity-curve fallback
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [info, data.pair, data.startedAt]);

  const render = useCallback(async () => {
    const c = canvasRef.current;
    if (!c) return;
    await drawCard(c, data, {
      ratio,
      bg,
      userBg: useUserBg ? userBg : null,
      zh,
      candles,
    });
  }, [data, ratio, bg, userBg, useUserBg, zh, candles]);

  useEffect(() => {
    void render();
  }, [render, canvasEl]);

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      setUserBg(url);
      setUseUserBg(true);
      // Frontend-only persistence; ~2MB cap so localStorage doesn't blow up.
      try {
        if (url.length < 2_000_000) localStorage.setItem(BG_KEY, url);
      } catch {
        /* quota: keep it session-only */
      }
    };
    reader.readAsDataURL(f);
  };

  const toBlob = () =>
    new Promise<Blob | null>((resolve) => canvasRef.current?.toBlob((b) => resolve(b), "image/png"));

  const download = async () => {
    setBusy(true);
    const b = await toBlob();
    if (b) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `superior-pnl-${data.pair.replace(/[:/]/g, "-")}-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    setBusy(false);
  };

  const share = async () => {
    setBusy(true);
    try {
      const b = await toBlob();
      if (!b) return;
      const file = new File([b], "pnl.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else if (navigator.clipboard && "write" in navigator.clipboard) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
      } else {
        await download();
      }
    } catch {
      /* user cancelled the share sheet */
    } finally {
      setBusy(false);
    }
  };

  const { w, h } = RATIOS[ratio];
  // Preview ceiling for landscape width; the canvas scales like an <img>
  // (auto dims + max constraints on BOTH axes), so it can never overflow
  // the dialog horizontally (narrow windows) NOR vertically (square/tall
  // ratios on short windows — 52vh leaves room for the controls inside the
  // dialog's 92vh). aspect-ratio keeps proportions before the first paint
  // sizes the bitmap.
  const previewW = w >= h ? 560 : Math.min(560, 460 * (w / h));

  return (
    <Dialog title={t("pnlCardTitle")} size="lg" onClose={onClose}>
      <div>
        <canvas
          ref={(el) => {
            canvasRef.current = el;
            setCanvasEl(el);
          }}
          className="mx-auto block rounded-xl border border-white/10"
          style={{
            width: "auto",
            height: "auto",
            maxWidth: `min(100%, ${previewW}px)`,
            maxHeight: "52vh",
            aspectRatio: `${w} / ${h}`,
          }}
        />

        {/* Aspect ratio */}
        <div className="mt-3 flex items-center gap-1.5">
          {(Object.keys(RATIOS) as Ratio[]).map((r) => (
            <button
              key={r}
              onClick={() => setRatio(r)}
              className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ${
                ratio === r ? "bg-lime-400 text-black" : "bg-white/[0.08] text-white/60 hover:text-white"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Background */}
        <div className="mt-2.5 flex items-center gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setBg(p.id);
                setUseUserBg(false);
              }}
              aria-label={p.id}
              className={`h-7 w-7 rounded-full border ${
                !useUserBg && bg === p.id ? "border-lime-400" : "border-white/15"
              }`}
              style={{ background: `linear-gradient(135deg, ${p.stops[0]}, ${p.stops[2]})` }}
            />
          ))}
          {userBg && (
            <button
              onClick={() => setUseUserBg(true)}
              className={`h-7 w-7 overflow-hidden rounded-full border ${
                useUserBg ? "border-lime-400" : "border-white/15"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={userBg} alt="" className="h-full w-full object-cover" />
            </button>
          )}
          <label className="cursor-pointer rounded-full bg-white/[0.08] px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-white/60 transition-colors hover:text-white">
            {t("pnlCardUpload")}
            <input type="file" accept="image/*" className="hidden" onChange={onUpload} />
          </label>
        </div>

        {/* Actions */}
        <div className="mt-3.5 flex gap-2">
          <button
            onClick={() => void download()}
            disabled={busy}
            className="flex-1 rounded-full bg-lime-400 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-black transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            {t("pnlCardDownload")}
          </button>
          <button
            onClick={() => void share()}
            disabled={busy}
            className="flex-1 rounded-full border border-white/15 bg-white/[0.06] py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-white/80 transition-colors hover:text-white disabled:opacity-40"
          >
            {t("pnlCardShare")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
