"use client";

/* Footprint OVERLAY — per-price order-flow cells drawn ON TOP of the live
 * TradingView chart, glued to its own time/price coordinates (same
 * projection technique as the detect scan boxes). TradingView stays fully
 * interactive underneath: the canvas is pointer-events:none and re-anchors
 * every frame the view moves, so pan/zoom never de-syncs it.
 *
 * Rendering follows the ATAS/Exocharts conventions: delta-colored cells
 * (green/red by aggressor dominance, opacity by volume vs the bar's max),
 * a gold POC box per bar, and — when the zoom leaves room — "sell × buy"
 * numbers with DIAGONAL imbalance highlighting (buy at price vs sell one
 * bin above, ≥3:1 brightens the winning side).
 *
 * Data: the of_bins footprint store (collector worker + web recorders,
 * 5-minute buckets × per-coin price bins), fetched via /api/orderflow and
 * refreshed on a slow interval; buckets aggregate up to the chart's bar
 * resolution, and price bins merge so rows stay readable at any zoom. */

import { useEffect, useRef } from "react";
import { authFetch } from "../../lib/client-auth";
import { pairToCoin } from "../../lib/hyperliquid-provider";

export interface OverlayGeometry {
  vr: { from: number; to: number };
  pr: { from: number; to: number };
  /** Pane canvas rect — measured INSIDE the TV iframe, so its top/left are
   *  iframe-relative and must be combined with `irect` to get a screen box. */
  prect: DOMRect;
  /** The TV iframe's rect in the MAIN document (screen coords). */
  irect: DOMRect;
  crect: DOMRect;
  /** Active chart bar length in ms. */
  resMs: number;
}

interface Cell {
  b: number;
  s: number;
}

/** Minimal OHLC bar (structurally a TradingView Bar) for drawing our own
 *  candles in the gapped footprint layout. time is unix ms. */
export interface OHLCBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const IMBALANCE = 3; // diagonal buy/sell ratio that flags an imbalance
const GOLD = "#eab308";
const MIN_TEXT_ROW_PX = 13; // rows merge until numbers fit
const MIN_TEXT_COL_PX = 58; // columns merge until numbers fit
const BUCKET_MS = 5 * 60_000;
const GAP_PX = 4; // padding between the gap-mode candle and its footprint column

function fmtK(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return v > 0 ? `${Math.round(v)}` : "·";
}

export function FootprintOverlay({
  pair,
  getGeometry,
  onData,
  getBars,
  upColor = "#26a69a",
  downColor = "#ef5350",
  onModeChange,
}: {
  pair: string;
  getGeometry: () => OverlayGeometry | null;
  /** Fired whenever data presence changes — lets the host delay the
   *  candle-fade until there are actual numbers to look at. */
  onData?: (hasData: boolean) => void;
  /** Visible chart bars (unix ms), newest-last. When supplied AND the chart
   *  resolution is ≥ one footprint bucket, the overlay switches to the GAP
   *  layout: it draws its own narrow candle at each bar's true time and the
   *  footprint column in the empty gap to the candle's right. */
  getBars?: () => OHLCBar[];
  /** Candle body/wick colors for the overlay's own candles (match the TV
   *  palette so the gapped candles are indistinguishable from native ones). */
  upColor?: string;
  downColor?: string;
  /** Fired when the overlay enters/leaves the gap layout, so the host can
   *  hide the native candles + widen bar spacing (gapped) or restore them. */
  onModeChange?: (gapped: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cellsRef = useRef<Map<number, Map<number, Cell>>>(new Map());
  const binSizeRef = useRef<number>(0);
  const versionRef = useRef(0);
  // Latest gap-mode, so the render loop only fires onModeChange on a flip
  // (it runs every frame; the host callback drives React state).
  const gappedRef = useRef(false);
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;
  const getBarsRef = useRef(getBars);
  getBarsRef.current = getBars;
  const upColorRef = useRef(upColor);
  upColorRef.current = upColor;
  const downColorRef = useRef(downColor);
  downColorRef.current = downColor;

  // ── Data: initial backfill + slow refresh (5m buckets move slowly). ──
  // (onData is expected to be referentially stable — it only gates the
  // host's candle-fade, and a new identity would just refetch once.)
  useEffect(() => {
    const coin = pairToCoin(pair);
    let cancelled = false;
    cellsRef.current = new Map();
    binSizeRef.current = 0;
    versionRef.current++;
    onData?.(false);
    const load = async () => {
      try {
        const res = await authFetch(
          `/api/orderflow?coin=${encodeURIComponent(coin)}&from=${Date.now() - 48 * 3600_000}`,
        );
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as {
          binSize?: number;
          cells?: Array<{ bucket: number; bin: number; buy: number; sell: number }>;
        };
        if (cancelled || !j.binSize || !j.cells) return;
        binSizeRef.current = j.binSize;
        const map = new Map<number, Map<number, Cell>>();
        for (const c of j.cells) {
          let row = map.get(c.bucket);
          if (!row) {
            row = new Map();
            map.set(c.bucket, row);
          }
          row.set(c.bin, { b: c.buy, s: c.sell });
        }
        cellsRef.current = map;
        versionRef.current++;
        onData?.(map.size > 0);
      } catch {
        /* keep the last picture */
      }
    };
    // Fast retries until the first cells land (a cold coin starts recording
    // on the first request — trades appear within seconds), then relax.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await load();
      if (cancelled) return;
      timer = setTimeout(() => void tick(), cellsRef.current.size > 0 ? 20_000 : 4_000);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pair, onData]);

  // ── Render loop: repaint only when the view or the data moved. ──
  useEffect(() => {
    let raf = 0;
    let lastKey = "";
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const g = getGeometry();
      if (!canvas || !g) return;
      const { vr, pr, prect, irect, crect, resMs } = g;

      // GAP layout, entered ONLY when ALL of: the host feeds bars, the
      // resolution is coarse enough that each footprint column maps to exactly
      // one chart bar (< a bucket, several candles share a column and the gap
      // is meaningless), AND the footprint feed has actually landed. Waiting on
      // the data is what avoids the ugly interim state where the candles are
      // already widened apart but the gaps are still empty.
      const binSize = binSizeRef.current;
      const hasCells = binSize > 0 && cellsRef.current.size > 0;
      const ohlc = getBarsRef.current?.() ?? [];
      const gapped = resMs >= BUCKET_MS && ohlc.length > 0 && hasCells;
      if (gapped !== gappedRef.current) {
        gappedRef.current = gapped;
        onModeChangeRef.current?.(gapped);
      }
      // Live-candle fingerprint so the forming bar's wick/body still repaints
      // between the (slow) footprint refreshes.
      const lastBar = ohlc.length ? ohlc[ohlc.length - 1] : undefined;
      const barsFp = gapped ? `${ohlc.length}:${lastBar?.time}:${lastBar?.high}:${lastBar?.low}:${lastBar?.close}` : "";
      const key = `${vr.from},${vr.to},${pr.from},${pr.to},${prect.width},${prect.height},${versionRef.current},${resMs},${gapped ? 1 : 0},${barsFp}`;
      if (key === lastKey) return;
      lastKey = key;

      // Pin the canvas over the pane (container-relative). prect is measured
      // INSIDE the TV iframe (iframe-relative viewport coords), so we must add
      // the iframe's own screen offset (irect) before subtracting the main-doc
      // container origin — otherwise the canvas sits `irect.top` px too high.
      const dpr = window.devicePixelRatio || 1;
      canvas.style.left = `${irect.left + prect.left - crect.left}px`;
      canvas.style.top = `${irect.top + prect.top - crect.top}px`;
      canvas.style.width = `${prect.width}px`;
      canvas.style.height = `${prect.height}px`;
      if (canvas.width !== Math.round(prect.width * dpr))
        canvas.width = Math.round(prect.width * dpr);
      if (canvas.height !== Math.round(prect.height * dpr))
        canvas.height = Math.round(prect.height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, prect.width, prect.height);

      const toX = (tMs: number) =>
        ((tMs / 1000 - vr.from) / (vr.to - vr.from)) * prect.width;
      const toY = (price: number) =>
        ((pr.to - price) / (pr.to - pr.from)) * prect.height;

      // Bar length: in gap mode each candle owns exactly one column (never
      // merged — the host widens the spacing instead); in flat mode columns
      // merge chart bars until every "sell × buy" fits.
      const resPx = (Math.max(resMs, BUCKET_MS) / 1000 / (vr.to - vr.from)) * prect.width;
      const colsMerge = gapped
        ? 1
        : Math.max(1, Math.ceil(MIN_TEXT_COL_PX / Math.max(resPx, 0.0001)));
      const barMs = Math.max(resMs, BUCKET_MS) * colsMerge;
      const barW = (barMs / 1000 / (vr.to - vr.from)) * prect.width;

      // Gap geometry: a slim candle pinned to the LEFT of each column, the
      // footprint filling the space to its right. In flat mode candleW is 0 and
      // no candles are drawn (the legacy full-width look).
      const candleW = gapped ? Math.min(Math.max(barW * 0.16, 5), 14) : 0;
      const toCandleX = (barT: number) => toX(barT) + candleW / 2 + 1;

      // OWN CANDLES FIRST — straight from the host's bars, INDEPENDENT of the
      // footprint feed. This is what lets the host hide the native candles the
      // instant gap mode turns on: ours are already on screen even while a cold
      // coin's order flow is still warming up, so the chart is never blank.
      if (gapped) {
        for (const b of ohlc) {
          const cX = toCandleX(b.time);
          const col = b.close >= b.open ? upColorRef.current : downColorRef.current;
          const yO = toY(b.open);
          const yC = toY(b.close);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = col;
          ctx.fillStyle = col;
          ctx.lineWidth = 1;
          const wickX = Math.round(cX) + 0.5;
          ctx.beginPath();
          ctx.moveTo(wickX, toY(b.high));
          ctx.lineTo(wickX, toY(b.low));
          ctx.stroke();
          const bodyTop = Math.min(yO, yC);
          ctx.fillRect(cX - candleW / 2, bodyTop, candleW, Math.max(Math.abs(yC - yO), 1));
        }
      }

      // FOOTPRINT CELLS need the recorded feed; until it lands the native
      // candles are still showing (flat mode), so just skip the numbers.
      if (!hasCells) return;

      // NUMBERS ALWAYS FIT vertically: rows merge price bins until text fits.
      const binPx = (binSize / (pr.to - pr.from)) * prect.height;
      const mergeBins = Math.max(
        1,
        Math.ceil(MIN_TEXT_ROW_PX / Math.max(binPx, 0.0001)),
      );
      const rowSize = binSize * mergeBins;
      const rowH = (rowSize / (pr.to - pr.from)) * prect.height;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textBaseline = "middle";

      // Aggregate visible buckets → bar×row grid.
      const fromMs = vr.from * 1000 - barMs;
      const toMs = vr.to * 1000 + barMs;
      const bars = new Map<number, Map<number, Cell>>();
      for (const [bucket, rowMap] of cellsRef.current) {
        if (bucket < fromMs || bucket > toMs) continue;
        const barT = Math.floor(bucket / barMs) * barMs;
        let bar = bars.get(barT);
        if (!bar) {
          bar = new Map();
          bars.set(barT, bar);
        }
        for (const [bin, c] of rowMap) {
          if (bin > pr.to || bin + binSize < pr.from) continue;
          const row = Math.floor(bin / rowSize) * rowSize;
          const agg = bar.get(row);
          if (agg) {
            agg.b += c.b;
            agg.s += c.s;
          } else bar.set(row, { b: c.b, s: c.s });
        }
      }

      for (const [barT, rows] of bars) {
        let maxTotal = 0;
        let pocRow = NaN;
        for (const [row, c] of rows) {
          const total = c.b + c.s;
          if (total > maxTotal) {
            maxTotal = total;
            pocRow = row;
          }
        }
        if (maxTotal <= 0) continue;
        // Cell x-range: in gap mode, right of the candle up to (just shy of)
        // the next candle; in flat mode, the full bar width.
        const cellX = gapped ? toCandleX(barT) + candleW / 2 + GAP_PX : toX(barT);
        const cellW = gapped
          ? Math.max(toX(barT + barMs) - GAP_PX - cellX, 1)
          : Math.max(barW - 1, 1);
        for (const [row, c] of rows) {
          const y = toY(row + rowSize);
          const h = Math.max(rowH - 1, 1);
          // NEUTRAL slate heat (volume vs the bar's max) — color lives in
          // the NUMBERS, so cells never fight the candles for green/red.
          ctx.fillStyle = "#64748b";
          ctx.globalAlpha = 0.08 + 0.24 * Math.min(1, (c.b + c.s) / maxTotal);
          ctx.fillRect(cellX, y, cellW, h);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "rgba(255,255,255,0.05)";
          ctx.strokeRect(cellX + 0.5, y + 0.5, cellW - 1, h - 1);
          // Diagonal imbalance (ATAS convention): buys at P fight sells
          // one row up; sells at P fight buys one row down. Imbalanced
          // numbers go bright + bold; balanced ones stay muted.
          const up = rows.get(row + rowSize);
          const down = rows.get(row - rowSize);
          const buyImb = up && up.s > 0 ? c.b / up.s >= IMBALANCE : c.b > 0 && !up;
          const sellImb = down && down.b > 0 ? c.s / down.b >= IMBALANCE : c.s > 0 && !down;
          // Over live indicators the numbers need a dark halo to stay legible.
          if (gapped) {
            ctx.shadowColor = "rgba(0,0,0,0.9)";
            ctx.shadowBlur = 3;
          }
          ctx.font = sellImb ? "bold 10px ui-monospace, monospace" : "10px ui-monospace, monospace";
          ctx.fillStyle = sellImb ? "#fca5a5" : "rgba(248,113,113,0.7)";
          ctx.textAlign = "right";
          ctx.fillText(fmtK(c.s), cellX + cellW / 2 - 4, y + h / 2);
          ctx.font = "10px ui-monospace, monospace";
          ctx.fillStyle = "rgba(255,255,255,0.25)";
          ctx.textAlign = "center";
          ctx.fillText("×", cellX + cellW / 2, y + h / 2);
          ctx.font = buyImb ? "bold 10px ui-monospace, monospace" : "10px ui-monospace, monospace";
          ctx.fillStyle = buyImb ? "#86efac" : "rgba(74,222,128,0.7)";
          ctx.textAlign = "left";
          ctx.fillText(fmtK(c.b), cellX + cellW / 2 + 4, y + h / 2);
          if (gapped) ctx.shadowBlur = 0;
        }
        // POC: gold box on the bar's highest-volume row.
        if (Number.isFinite(pocRow)) {
          ctx.strokeStyle = GOLD;
          ctx.globalAlpha = 0.85;
          ctx.lineWidth = 1;
          ctx.strokeRect(cellX + 0.5, toY(pocRow + rowSize) + 0.5, cellW - 1, Math.max(rowH - 2, 1));
          ctx.globalAlpha = 1;
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [getGeometry]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute z-20"
      aria-hidden
    />
  );
}
