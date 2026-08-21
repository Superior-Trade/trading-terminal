"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type {
  ChartingLibraryWidgetOptions,
  EntityId,
  LanguageCode,
  ResolutionString,
  IChartingLibraryWidget,
} from "../../public/static/charting_library";
import { widget } from "../../public/static/charting_library";
import {
  HyperliquidDatafeed,
  RESOLUTION_TO_HL,
  RESOLUTION_TO_MS,
} from "./hyperliquid-datafeed";
import { LighterDatafeed } from "./lighter-datafeed";
import { VenueDatafeedRouter } from "./venue-datafeed-router";
import { venueOfSymbol } from "../../lib/venues";
import { FootprintOverlay } from "./footprint-overlay";
import { useSetups } from "../../lib/setups-context";
import { IndicatorMenu, type MenuAnchor } from "./indicator-menu";
import { tierMeta } from "../../lib/indicator-tiers";
import {
  useHyperliquid,
  pairToCoin,
  coinToPair,
  resolveAsset,
  type AssetMeta,
} from "../../lib/hyperliquid-provider";
import { Dialog } from "../ui/dialog";
import {
  useChartBridge,
  type ChartAction,
  type ChartActionResult,
  type ChartContext,
} from "../../lib/chart-bridge";
import { useLang } from "../../lib/i18n";
import { authFetch } from "../../lib/client-auth";
import { useAuthGate } from "../providers";
import {
  parseLevelSource,
  computeLevel,
  type LevelSource,
  type OHLCV,
} from "../../lib/indicators";

export interface ChartLevel {
  price: number;
  label?: string;
  side?: "support" | "resistance";
}

// Best-effort read of a plotted study's params so a tracked level uses the
// SAME length/std the user actually has on screen (falls back to defaults).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function studyParamsFor(chart: any, kind: string): { length?: number; mult?: number } {
  try {
    const want = kind.startsWith("bb")
      ? /bollinger/i
      : kind === "ema"
        ? /exponential|ema/i
        : kind === "sma"
          ? /moving average|sma/i
          : /vwap/i;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = chart.getAllStudies().find((s: any) => want.test(s.name));
    if (!st) return {};
    const vals = chart.getStudyById(st.id).getInputValues();
    const out: { length?: number; mult?: number } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const v of vals as any[]) {
      const id = String(v.id).toLowerCase();
      if (typeof v.value !== "number") continue;
      if (id.includes("length") || id.includes("period") || id === "in_0")
        out.length = v.value;
      if (id.includes("std") || id.includes("mult") || id.includes("dev"))
        out.mult = v.value;
    }
    return out;
  } catch {
    return {};
  }
}

interface TradingChartProps {
  pair: string;
  storageKey?: string;
  resolution?: string;
  /** Horizontal lines to draw on the chart (e.g. whale support/resistance). */
  supportResistanceLevels?: ChartLevel[];
  /** Fired when the user switches symbol inside the TradingView UI. */
  onSymbolChange?: (displaySymbol: string) => void;
}

// Viridis-style ramp for the liquidation heatmap overlay, matching the
// familiar liq-heatmap look: deep indigo (thin) → blue → cyan → yellow (walls).
const LIQ_STOPS: Array<[number, number, number]> = [
  [30, 27, 75],
  [37, 99, 235],
  [34, 211, 238],
  [253, 224, 71],
];
function liqColor(t: number, alpha: number): string {
  const x = Math.min(1, Math.max(0, t)) * (LIQ_STOPS.length - 1);
  const i = Math.min(LIQ_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const [r1, g1, b1] = LIQ_STOPS[i];
  const [r2, g2, b2] = LIQ_STOPS[i + 1];
  const r = Math.round(r1 + (r2 - r1) * f);
  const g = Math.round(g1 + (g2 - g1) * f);
  const b = Math.round(b1 + (b2 - b1) * f);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

interface LiqBin {
  priceBinStart: number;
  priceBinEnd: number;
  liquidationValue: number;
  positionsCount: number;
  /** Epoch ms when the server first observed liquidity in this bin. */
  firstSeen?: number;
}

function fmtLiqUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}
function fmtLiqPx(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return p.toPrecision(3);
}

const PALETTES = {
  dark: {
    candleUp: "#a3e635",
    candleDown: "#ef4444",
    grid: "#111311",
    text: "#a3a3a3",
    crossHair: "#525252",
    priceLine: "#a3e635",
    bg: "#000000",
  },
  light: {
    // GitHub Light
    candleUp: "#1a7f37",
    candleDown: "#cf222e",
    grid: "#eaeef2",
    text: "#656d76",
    crossHair: "#afb8c1",
    priceLine: "#1a7f37",
    bg: "#ffffff",
  },
  dracula: {
    candleUp: "#50fa7b",
    candleDown: "#ff5555",
    grid: "#2b2d3a",
    text: "#9ca0b5",
    crossHair: "#6272a4",
    priceLine: "#bd93f9",
    bg: "#1e1f29",
  },
  nord: {
    candleUp: "#a3be8c",
    candleDown: "#bf616a",
    grid: "#2e3440",
    text: "#9aa4b5",
    crossHair: "#4c566a",
    priceLine: "#88c0d0",
    bg: "#242933",
  },
  tokyo: {
    candleUp: "#9ece6a",
    candleDown: "#f7768e",
    grid: "#24283b",
    text: "#a9b1d6",
    crossHair: "#565f89",
    priceLine: "#7aa2f7",
    bg: "#1a1b26",
  },
} as const;

export function TradingChart({
  pair,
  storageKey,
  resolution = "240",
  supportResistanceLevels,
  onSymbolChange,
}: TradingChartProps) {
  const { info, subscription, assets, assetsByName, isReady } =
    useHyperliquid();
  const {
    registerChartActionHandler,
    registerChartContextProvider,
    registerChartScreenshotProvider,
  } = useChartBridge();
  const { theme, t, lang } = useLang();
  // The TV-toolbar paint closures are created once inside the widget-init
  // effect (deps don't include lang) — they read translations via this ref
  // so a language switch never shows stale strings.
  const tRef = useRef(t);
  tRef.current = t;
  const { detecting } = useSetups();
  const palette = PALETTES[theme];
  const agentShapeIdsRef = useRef<Set<string>>(new Set());
  // Position-overlay group (entry/TP/SL/liq/order lines) — replaced as a
  // unit on every draw_position_marks dispatch.
  const positionShapeIdsRef = useRef<Set<string>>(new Set());
  // Liquidation-heatmap overlay: HyperTracker price bins drawn as horizontal
  // intensity bands behind the candles. Toggled from a TV header button;
  // the whole group is replaced on redraw. Closures are reassigned every
  // render (recomputeTrackedRef idiom) so handlers created once inside the
  // widget init always see the current pair.
  // Persisted across reloads so an active heatmap comes back on next visit.
  const liqOnRef = useRef<boolean>(
    typeof window !== "undefined" && localStorage.getItem("cg:liq-on") === "1",
  );
  const liqShapeIdsRef = useRef<Set<string>>(new Set());
  const liqSeqRef = useRef(0);
  // Repaints the LIQ header button (spinner while a fetch is in flight);
  // bound when the button is created inside headerReady. Now sets React state
  // so the React indicator menu's row shows the spinner.
  const liqPaintRef = useRef<(loading: boolean) => void>(() => {});
  // Repaints the TV-toolbar "Indicators (N active)" button; bound at button
  // creation, called from the React toggle handlers to refresh the count.
  const paintBtnRef = useRef<() => void>(() => {});
  // Repaint the toolbar button when the UI language changes (the widget
  // itself is not recreated on lang switch).
  useEffect(() => {
    paintBtnRef.current();
  }, [lang]);
  // The indicator dropdown is a React portal in the parent doc (real tooltips);
  // these drive it, the TV-toolbar button only toggles them open.
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
  const [indicatorAnchor, setIndicatorAnchor] = useState<MenuAnchor | null>(null);
  const [liqLoading, setLiqLoading] = useState(false);
  // Detect scan sequence: (1) the screenshot capture pans/zooms the chart to
  // fit every drawing, (2) lock-on boxes snap around each drawing's REAL
  // screen position, (3) on finish the chart flashes green and the boxes
  // vanish. No fades, no decorative sweeps.
  const [scanBoxes, setScanBoxes] = useState<
    Array<{
      left: number;
      top: number;
      width: number;
      height: number;
      label: string;
      /** raw = model-authored reading (render verbatim); otherwise label is
       *  an i18n key and the tag shows the animated "reading…" dots. */
      raw?: boolean;
    }>
  >([]);
  const [scanFlash, setScanFlash] = useState(false);
  const wasDetectingRef = useRef(false);
  // Shared pane geometry: visible time/price ranges + the pane canvas rect
  // — the time/price↔pixel projection every glued overlay uses (scan
  // boxes, footprint). Lives in a ref so components below the widget
  // effect get a stable accessor.
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const paneGeometryRef = useRef(() => {
    // Whole body guarded: EVERY TV accessor here (activeChart, getPanes,
    // getVisibleRange, resolution) can throw "Value is null" while the
    // widget loads a symbol or tears down — callers poll per-frame, so a
    // null this frame is fine and a throw is not.
    try {
      const w = widgetRef.current;
      const idoc = chartContainerRef.current
        ?.querySelector("iframe")
        ?.contentDocument;
      if (!w || !idoc) return null;
      const chart = w.activeChart();
      let vr = chart.getVisibleRange();
      // getVisibleRange() is QUANTIZED to whole bars, so an overlay anchored
      // to it steps in bar-width jumps while TV pans per-pixel. The time
      // scale's barSpacing/rightOffset are the CONTINUOUS internal state —
      // rebuild the range from those so glued overlays track exactly.
      // (Verified: right edge = lastBarTime + rightOffset·res; span = width/barSpacing bars.)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tsApi = (chart as any).getTimeScale?.();
        const bars = datafeedRef.current?.recentBars() ?? [];
        const lastMs = bars.length ? bars[bars.length - 1].time : 0;
        const resMsExact = RESOLUTION_TO_MS[chart.resolution() as string];
        const resSec = (resMsExact ?? 0) / 1000;
        if (tsApi && lastMs > 0 && resSec > 0) {
          const bs = tsApi.barSpacing();
          const wpx = tsApi.width();
          if (bs > 0 && wpx > 0) {
            const toSec = lastMs / 1000 + tsApi.rightOffset() * resSec;
            const fromSec = toSec - (wpx / bs) * resSec;
            if (
              Number.isFinite(fromSec) &&
              Number.isFinite(toSec) &&
              toSec > fromSec
            )
              vr = { from: fromSec, to: toSec };
          }
        }
      } catch {
        /* quantized fallback is still correct, just steppier */
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (chart as any).getPanes()[0]?.getMainSourcePriceScale?.();
      const pr = ps?.getVisiblePriceRange?.();
      if (!pr || vr.to <= vr.from || pr.to <= pr.from) return null;
      // Pane pixel geometry = the largest canvas in the TV iframe.
      let pane: HTMLCanvasElement | null = null;
      for (const c of Array.from(idoc.querySelectorAll("canvas"))) {
        if (
          !pane ||
          c.clientWidth * c.clientHeight > pane.clientWidth * pane.clientHeight
        )
          pane = c as HTMLCanvasElement;
      }
      if (!pane) return null;
      const prect = pane.getBoundingClientRect();
      const irect = chartContainerRef.current!
        .querySelector("iframe")!
        .getBoundingClientRect();
      const crect = chartContainerRef.current!.getBoundingClientRect();
      const resMs =
        RESOLUTION_TO_MS[chart.resolution() as string] ?? 5 * 60_000;
      return { chart, vr, pr, prect, irect, crect, resMs };
    } catch {
      return null;
    }
  });

  // Model-authored scan annotations, anchored in TIME/PRICE so they stay
  // glued to the chart through pan/zoom (pixel boxes would strand).
  const scanAnnotationsRef = useRef<Array<{
    t0: number;
    p0: number;
    t1: number;
    p1: number;
    label: string;
    zh: string;
  }> | null>(null);
  const [liqActive, setLiqActive] = useState(
    () => typeof window !== "undefined" && localStorage.getItem("cg:liq-on") === "1",
  );
  // Order-flow footprint — a canvas GLUED over the live TV chart (not a
  // replacement panel). React state drives the render; the ref mirrors it
  // for the iframe dialog's paint closures. Persisted like the liq toggle.
  const [showOrderFlow, setShowOrderFlow] = useState(
    () => typeof window !== "undefined" && localStorage.getItem("cg:of-on") === "1",
  );
  const ofOnRef = useRef(showOrderFlow);
  // Footprint order flow is gated behind sign-in — its /api/orderflow feed is
  // authed, so an anonymous toggle 401s and silently never paints. authGate
  // lets the toggle prompt the Privy login dialog instead.
  const { authed: ofAuthed, requireAuth: ofRequireAuth } = useAuthGate();
  const ofAuthedRef = useRef(ofAuthed);
  ofAuthedRef.current = ofAuthed;
  // Data readiness gates the candle-fade: candles keep their colors until
  // the footprint actually has numbers to show (a cold coin starts recording
  // on the first request, so this can take a few seconds).
  const [ofDataReady, setOfDataReady] = useState(false);
  const ofReadyRef = useRef(false);
  // Gap LAYOUT: true when the overlay is drawing its own candles + footprint
  // in the widened gap (resolution ≥ 5m). Drives the host to hide the native
  // candles entirely and widen the bar spacing so the gap exists.
  const [ofGapped, setOfGapped] = useState(false);
  const handleOfMode = useCallback((gapped: boolean) => setOfGapped(gapped), []);
  // Bar spacing the user had before gap mode widened it, to restore on exit.
  const prevBarSpacingRef = useRef<number | null>(null);
  // The overlay unmounts when footprint turns off WITHOUT firing its
  // onModeChange(false), so clear gap state here — otherwise a re-enable at a
  // sub-5m timeframe would inherit a stale `true` (candles hidden, no overlay
  // candles drawn) and look broken.
  useEffect(() => {
    if (!showOrderFlow) setOfGapped(false);
  }, [showOrderFlow]);
  // Repaints the TV-toolbar "Order Flow" button; bound in headerReady.
  const ofPaintRef = useRef<() => void>(() => {});
  const handleOfData = useCallback((hasData: boolean) => {
    ofReadyRef.current = hasData;
    setOfDataReady(hasData);
    ofPaintRef.current();
  }, []);
  // Snapshot of the visible bars for the overlay's own candles — recentBars()
  // is already ms-timed OHLC (structurally an OHLCBar), so pass it straight.
  const getOverlayBars = useCallback(() => datafeedRef.current?.recentBars() ?? [], []);
  // Footprint availability. Only main-DEX Hyperliquid perps qualify: spot
  // markets stream trades on a different (@index) coin the recorder/collector
  // don't track, and HIP-3 builder-dex perps are too thin to render. An
  // unresolved asset (universe still loading) is treated as OK so a cold load
  // never wrongly blocks — the feed itself no-ops safely if it turns out empty.
  const [ofUnavailable, setOfUnavailable] = useState(false);
  const footprintSupported = useCallback(
    (p: string) => {
      const a = resolveAsset(assetsByName, pairToCoin(p));
      return !a || a.marketType === "perp";
    },
    [assetsByName],
  );
  // Switching to an unsupported pair while footprint is ON: turn it off and
  // explain, rather than leave an overlay that can never paint.
  useEffect(() => {
    if (!ofOnRef.current || footprintSupported(pair)) return;
    ofOnRef.current = false;
    setShowOrderFlow(false);
    ofReadyRef.current = false;
    setOfDataReady(false);
    try {
      localStorage.setItem("cg:of-on", "0");
    } catch {
      /* private mode */
    }
    ofPaintRef.current();
    setOfUnavailable(true);
  }, [pair, footprintSupported]);
  // Repaint the button when sign-in resolves so its dot/spinner reflects
  // whether the (auth-gated) overlay can actually mount and fetch.
  useEffect(() => {
    ofPaintRef.current();
  }, [ofAuthed]);
  // Visible range the bars were last sized against — bar lengths are
  // proportions of the view, so a material zoom/pan triggers a re-fit.
  const liqFitRangeRef = useRef<{ from: number; to: number } | null>(null);
  const clearLiqRef = useRef<() => void>(() => {});
  clearLiqRef.current = () => {
    const w = widgetRef.current;
    if (w) {
      try {
        const chart = w.activeChart();
        for (const id of liqShapeIdsRef.current) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            chart.removeEntity(id as any);
          } catch {
            /* already gone */
          }
        }
      } catch {
        /* widget disposed */
      }
    }
    liqShapeIdsRef.current.clear();
  };
  const drawLiqRef = useRef<() => void>(() => {});
  drawLiqRef.current = async () => {
    const w = widgetRef.current;
    if (!w || !isChartReadyRef.current || !liqOnRef.current) return;
    const seq = ++liqSeqRef.current;
    clearLiqRef.current();
    liqPaintRef.current(true);
    try {
      let bins: LiqBin[] = [];
      try {
        const r = await fetch(
          `/api/liquidation-heatmap?coin=${encodeURIComponent(pair)}`,
        );
        const j = (await r.json()) as { available?: boolean; bins?: LiqBin[] };
        if (!j.available || !Array.isArray(j.bins) || !j.bins.length) return;
        bins = j.bins;
      } catch {
        return;
      }
      if (seq !== liqSeqRef.current || !liqOnRef.current || !widgetRef.current)
        return;
      // Center the window on the live mid; fall back to the value-weighted
      // median bin when mids don't cover the market (HIP-3 dexes).
      let mid: number | null = null;
      try {
        if (!/^xyz/i.test(pair)) {
          const mids = (await info.allMids()) as Record<string, string>;
          const v = parseFloat(mids[pair.split("-")[0]] ?? "");
          if (Number.isFinite(v) && v > 0) mid = v;
        }
      } catch {
        /* fallback below */
      }
      if (seq !== liqSeqRef.current || !liqOnRef.current) return;
      if (mid == null) {
        const total = bins.reduce((s, b) => s + b.liquidationValue, 0);
        let acc = 0;
        for (const b of [...bins].sort(
          (a, c) => a.priceBinStart - c.priceBinStart,
        )) {
          acc += b.liquidationValue;
          if (acc >= total / 2) {
            mid = (b.priceBinStart + b.priceBinEnd) / 2;
            break;
          }
        }
      }
      if (!mid) return;
      // Keep bins near price, drop dust, cap the shape count.
      const windowed = bins.filter(
        (b) => b.priceBinEnd > mid * 0.45 && b.priceBinStart < mid * 1.8,
      );
      if (!windowed.length) return;
      const maxV = Math.max(...windowed.map((b) => b.liquidationValue));
      const kept = windowed
        .filter((b) => b.liquidationValue >= maxV * 0.015)
        .sort((a, b) => b.liquidationValue - a.liquidationValue)
        .slice(0, 90);
      const minV = Math.min(...kept.map((b) => b.liquidationValue));
      // Label only the biggest walls — labelling all ~90 bins is noise.
      const labelCut =
        kept[Math.min(9, kept.length - 1)].liquidationValue;
      let chart: ReturnType<IChartingLibraryWidget["activeChart"]>;
      try {
        chart = w.activeChart();
      } catch {
        return;
      }
      // Size bars against the VISIBLE window (absolute day-spans all render
      // full-width once the view is narrower than the shortest span — the
      // "every bar looks the same" failure). Longest wall ≈ 90% of the view,
      // smallest ≈ 15%, all ending just inside the right edge.
      let vr: { from: number; to: number } | null = null;
      try {
        vr = chart.getVisibleRange();
      } catch {
        /* fall back to a wide default */
      }
      const nowS = Math.floor(Date.now() / 1000);
      const viewTo = vr?.to ?? nowS;
      const viewFrom = vr?.from ?? nowS - 60 * 86400;
      const width = Math.max(3600, viewTo - viewFrom);
      liqFitRangeRef.current = { from: viewFrom, to: viewTo };
      const endT = Math.round(viewTo - width * 0.02);
      // Every band spans the FULL visible width — bar length carries no meaning
      // (we don't track formation time); intensity/color encodes size instead.
      const startT = Math.round(viewFrom);
      for (const b of kept) {
        // Log scale — liq values span orders of magnitude; linear would make
        // everything but the top walls invisible.
        const t =
          maxV > minV
            ? Math.log(b.liquidationValue / minV) / Math.log(maxV / minV)
            : 1;
        const label =
          b.liquidationValue >= labelCut
            ? `${fmtLiqPx((b.priceBinStart + b.priceBinEnd) / 2)} · ${fmtLiqUsd(b.liquidationValue)}`
            : "";
        try {
          const id = chart.createMultipointShape(
            [
              { time: startT, price: b.priceBinStart },
              { time: endT, price: b.priceBinEnd },
            ],
            {
              shape: "rectangle",
              lock: true,
              disableSave: true,
              disableSelection: true,
              zOrder: "bottom",
              overrides: {
                backgroundColor: liqColor(t, 0.07 + t * 0.28),
                color: "rgba(0,0,0,0)",
                linewidth: 1,
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          );
          if (id) liqShapeIdsRef.current.add(String(id));
        } catch {
          /* chart teardown mid-draw */
        }
        // Wall labels are standalone text shapes: labels INSIDE a rectangle
        // get clipped away as soon as the bin is thinner than the font when
        // zoomed out, which is exactly when the walls matter most.
        if (label) {
          try {
            // Anchor at the bin's TOP edge — TV text shapes render hanging
            // down from the anchor, so a mid-price anchor sat the label
            // half a row below the band.
            const tid = chart.createShape(
              {
                time: Math.round(endT - width * 0.07),
                price: b.priceBinEnd,
              },
              {
                shape: "text",
                lock: true,
                disableSave: true,
                disableSelection: true,
                zOrder: "top",
                text: label,
                overrides: {
                  color: liqColor(Math.max(t, 0.85), 0.95),
                  fontsize: 10,
                  bold: true,
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any,
            );
            if (tid) liqShapeIdsRef.current.add(String(tid));
          } catch {
            /* text tool unavailable — bands still render */
          }
        }
      }
    } finally {
      // Only the newest draw clears the spinner — a stale run must not wipe
      // the loading state of the one that superseded it.
      if (seq === liqSeqRef.current) liqPaintRef.current(false);
    }
  };
  // Toggle handlers the React indicator menu calls. They mirror the ref (used
  // by the iframe paint closures) into React state (drives the menu rows) and
  // refresh the toolbar button's "(N active)" count.
  const handleToggleLiq = () => {
    liqOnRef.current = !liqOnRef.current;
    setLiqActive(liqOnRef.current);
    try {
      localStorage.setItem("cg:liq-on", liqOnRef.current ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    paintBtnRef.current();
    if (liqOnRef.current) void drawLiqRef.current();
    else clearLiqRef.current();
  };
  const handleToggleOf = () => {
    // Footprint is built from Hyperliquid PERP trades. Spot markets stream on a
    // different (@index) coin we don't record, and HIP-3 builder-dex perps are
    // too thin to render — so footprint is only offered on main-DEX perps.
    // Turning ON an unsupported pair explains why instead of spinning forever.
    if (!ofOnRef.current && !footprintSupported(pair)) {
      setOfUnavailable(true);
      return;
    }
    // Turning ON while signed out: the footprint feed is authed, so prompt the
    // Privy login dialog instead of flipping on an overlay that 401s and never
    // paints. (Turning OFF always proceeds.)
    if (!ofOnRef.current && !ofAuthedRef.current) {
      ofRequireAuth(() => {});
      return;
    }
    ofOnRef.current = !ofOnRef.current;
    setShowOrderFlow(ofOnRef.current);
    if (!ofOnRef.current) {
      ofReadyRef.current = false;
      setOfDataReady(false);
    }
    try {
      localStorage.setItem("cg:of-on", ofOnRef.current ? "1" : "0");
    } catch {
      /* private mode */
    }
    ofPaintRef.current();
  };
  // Latest toggle for the iframe button's click closure (bound once).
  const ofToggleRef = useRef<() => void>(() => {});
  ofToggleRef.current = handleToggleOf;
  // Hover-tooltip anchor for the Order Flow button (container-relative px).
  const [ofTipAnchor, setOfTipAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );
  // Stable accessor for glued overlays (footprint canvas).
  const getOverlayGeometry = useCallback(() => paneGeometryRef.current(), []);
  // Live-tracked plan levels: dynamic (indicator-based) ones have their line
  // recomputed each candle so it follows the real trigger, not a snapshot.
  const trackedRef = useRef<
    Array<{
      id: string;
      role: string;
      source: LevelSource;
      studyDefaults?: { length?: number; mult?: number };
    }>
  >([]);
  // Plan levels rendered as native ORDER LINES (exchange-style price chips).
  // Dynamic ones (indicator/trendline triggers) slide via setPrice() in the
  // recompute loop — one moving horizontal chip, the working-order mental
  // model every trader already knows.
  const planOrderLinesRef = useRef<
    Array<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      line: any;
      source: LevelSource;
      studyDefaults?: { length?: number; mult?: number };
    }>
  >([]);
  const clearPlanOrderLines = () => {
    for (const ol of planOrderLinesRef.current) {
      try {
        ol.line.remove();
      } catch {
        /* already gone */
      }
    }
    planOrderLinesRef.current = [];
  };
  const trackedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Reassigned every render (cheap) so the interval always sees fresh refs.
  const recomputeTrackedRef = useRef<() => void>(() => {});
  recomputeTrackedRef.current = () => {
    const w = widgetRef.current;
    if (!w || (!trackedRef.current.length && !planOrderLinesRef.current.length))
      return;
    let chart: ReturnType<IChartingLibraryWidget["activeChart"]>;
    try {
      chart = w.activeChart();
    } catch {
      return;
    }
    // Empty bars are fine: trendline sources evaluate from anchors alone;
    // indicator sources just skip this tick (computeLevel returns null).
    const raw = datafeedRef.current?.recentBars() ?? [];
    const bars: OHLCV[] = raw.map((b) => ({
      time: Math.floor(b.time / 1000),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
    for (const tl of trackedRef.current) {
      if (tl.source.kind === "fixed") continue;
      const v = computeLevel(bars, tl.source, tl.studyDefaults);
      if (v == null || !Number.isFinite(v)) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sh = chart.getShapeById(tl.id as any);
        const pts = sh.getPoints();
        const time = pts?.[0]?.time ?? Math.floor(Date.now() / 1000);
        sh.setPoints([{ time, price: v }]);
      } catch {
        /* shape removed by the user */
      }
    }
    for (const ol of planOrderLinesRef.current) {
      if (ol.source.kind === "fixed") continue;
      const v = computeLevel(bars, ol.source, ol.studyDefaults);
      if (v == null || !Number.isFinite(v)) continue;
      try {
        ol.line.setPrice(v);
      } catch {
        /* line removed */
      }
    }
  };
  const stopTrackedTimer = () => {
    if (trackedTimerRef.current) {
      clearInterval(trackedTimerRef.current);
      trackedTimerRef.current = null;
    }
  };
  const datafeedRef = useRef<VenueDatafeedRouter | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUnmountingRef = useRef(false);
  const isChartReadyRef = useRef(false);
  // Tool armed via OUR toolbar (select_tool). TradingView auto-deselects
  // line tools after one placement (brush is the exception) — we re-arm
  // this tool on drawing_event "create" so it behaves like brush and stays
  // in sync with the toolbar's pressed state. Cleared when the toolbar
  // disarms ("cursor").
  const stickyToolRef = useRef<string | null>(null);
  const onSymbolChangeRef = useRef(onSymbolChange);
  onSymbolChangeRef.current = onSymbolChange;

  // Detect scan sequence orchestration (see the scanBoxes state above).
  useEffect(() => {
    if (detecting && !wasDetectingRef.current) {
      wasDetectingRef.current = true;
      // Recompute the lock-on boxes on a short interval for the WHOLE
      // detect: the chart stays interactive, so pan/zoom shifts the pixel
      // geometry — a one-shot computation stranded stale boxes on screen.
      const paneGeometry = paneGeometryRef.current;

      // The agent's reading annotations: one fast vision pass over the same
      // fitted screenshot the detector sees; the returned image-normalized
      // regions convert to TIME/PRICE anchors here so the boxes stay glued
      // through pan/zoom. On success they REPLACE the tool-kind lock-on
      // boxes — the labels become what the agent thinks each structure IS.
      const annotate = async () => {
        try {
          const w = widgetRef.current;
          const g = paneGeometry();
          if (!w || !g) return;
          const canvas = await w.takeClientScreenshot();
          const maxW = 1024;
          let out: HTMLCanvasElement = canvas;
          if (canvas.width > maxW) {
            const scale = maxW / canvas.width;
            const c2 = document.createElement("canvas");
            c2.width = maxW;
            c2.height = Math.round(canvas.height * scale);
            c2.getContext("2d")!.drawImage(canvas, 0, 0, c2.width, c2.height);
            out = c2;
          }
          // The vision pass can't be trusted to SPOT thin drawn lines on its
          // own — hand it the exact image-normalized geometry of every
          // point-bearing user drawing (its job becomes reading/merging, not
          // finding), plus a count of freehand strokes (which expose no
          // anchors) so it knows how many it must still locate visually.
          const known: Array<{
            kind: string;
            x0: number;
            y0: number;
            x1: number;
            y1: number;
          }> = [];
          let strokes = 0;
          try {
            const { vr, pr, prect, irect } = g;
            const fx = (tSec: number) =>
              (prect.left -
                irect.left +
                ((tSec - vr.from) / (vr.to - vr.from)) * prect.width) /
              irect.width;
            const fy = (price: number) =>
              (prect.top -
                irect.top +
                ((pr.to - price) / (pr.to - pr.from)) * prect.height) /
              irect.height;
            const clamp = (v: number) => Math.min(1, Math.max(0, v));
            for (const sh of w.activeChart().getAllShapes()) {
              const id = String(sh.id);
              if (liqShapeIdsRef.current.has(id) || agentShapeIdsRef.current.has(id))
                continue;
              let pts: Array<{ time: number; price: number }> = [];
              try {
                pts = w
                  .activeChart()
                  .getShapeById(sh.id)
                  .getPoints()
                  .filter(
                    (p: { time: number; price: number }) =>
        Number.isFinite(p.time) && Number.isFinite(p.price),
                  ) as Array<{ time: number; price: number }>;
              } catch {
                /* freehand tools expose no points */
              }
              if (!pts.length) {
                strokes++;
                continue;
              }
              const xs = pts.map((p) => clamp(fx(p.time)));
              const ys = pts.map((p) => clamp(fy(p.price)));
              known.push({
                kind: String(sh.name),
                x0: Math.min(...xs),
                y0: Math.min(...ys),
                x1: sh.name === "horizontal_line" ? 1 : Math.max(...xs),
                y1: Math.max(...ys),
              });
            }
          } catch {
            /* hints are best-effort — the screenshot alone still works */
          }
          const res = await authFetch("/api/chart-annotate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              screenshot: out.toDataURL("image/jpeg", 0.72),
              known: known.slice(0, 12),
              strokes,
            }),
          });
          if (!res.ok) return;
          const j = (await res.json()) as {
            regions?: Array<{ x0: number; y0: number; x1: number; y1: number; label: string; zh: string }>;
          };
          if (!j.regions?.length || !wasDetectingRef.current) return;
          // Image fraction → viewport px (image spans the iframe) → pane
          // fraction → time/price.
          const { vr, pr, prect, irect } = g;
          const toTime = (x: number) => {
            const px = irect.left + x * irect.width;
            return vr.from + ((px - prect.left) / prect.width) * (vr.to - vr.from);
          };
          const toPrice = (y: number) => {
            const py = irect.top + y * irect.height;
            return pr.to - ((py - prect.top) / prect.height) * (pr.to - pr.from);
          };
          scanAnnotationsRef.current = j.regions.map((r) => ({
            t0: toTime(r.x0),
            p0: toPrice(r.y0),
            t1: toTime(r.x1),
            p1: toPrice(r.y1),
            label: r.label,
            zh: r.zh,
          }));
        } catch {
          /* annotations are decoration — the kind-labeled boxes remain */
        }
      };
      void setTimeout(() => void annotate(), 1200);

      // While the user is actively panning/zooming, the boxes go INVISIBLE
      // instead of chasing the viewport on the recompute tick (they lagged
      // visibly) — they reappear once the view holds still for a tick.
      let lastView = { f: 0, t: 0, pf: 0, pt: 0 };
      const computeBoxes = () => {
        try {
          const g = paneGeometry();
          if (!g) return;
          const { chart, vr, pr, prect, crect } = g;
          const moved =
            vr.from !== lastView.f ||
            vr.to !== lastView.t ||
            pr.from !== lastView.pf ||
            pr.to !== lastView.pt;
          lastView = { f: vr.from, t: vr.to, pf: pr.from, pt: pr.to };
          if (moved) {
            setScanBoxes([]);
            return;
          }
          // CONTAINER-relative pixels: the boxes overlay is absolute inside
          // the chart container, so viewport coords must shed the
          // container's own offset (same correction the footprint canvas
          // applies) — without it every box sat a header-height too low.
          const toX = (tSec: number) =>
            prect.left -
            crect.left +
            ((tSec - vr.from) / (vr.to - vr.from)) * prect.width;
          // Nudge every box DOWN a touch — they read a hair too high relative
          // to the structure they annotate. Tunable.
          const BOX_Y_NUDGE = 10;
          const toY = (price: number) =>
            prect.top -
            crect.top +
            BOX_Y_NUDGE +
            ((pr.to - price) / (pr.to - pr.from)) * prect.height;
          const paneL = prect.left - crect.left;
          const paneR = paneL + prect.width;
          // Model annotations arrived → render THOSE (time/price-anchored,
          // reading labels); until then, lock onto the drawings by kind.
          const ann = scanAnnotationsRef.current;
          if (ann?.length) {
            const boxes = ann
              .map((r) => {
                const left = Math.min(toX(r.t0), toX(r.t1));
                const right = Math.max(toX(r.t0), toX(r.t1));
                const top = Math.min(toY(r.p0), toY(r.p1));
                const bottom = Math.max(toY(r.p0), toY(r.p1));
                return {
                  left,
                  top,
                  width: right - left,
                  height: bottom - top,
                  label: lang === "zh" ? r.zh : r.label,
                  raw: true,
                };
              })
              .filter((b) => b.left + b.width > paneL && b.left < paneR);
            setScanBoxes(boxes);
            return;
          }
          const boxes: Array<{
            left: number;
            top: number;
            width: number;
            height: number;
            label: string;
          }> = [];
          for (const sh of chart.getAllShapes()) {
            const id = String(sh.id);
            if (liqShapeIdsRef.current.has(id) || agentShapeIdsRef.current.has(id))
              continue;
            let pts: Array<{ time: number; price: number }> = [];
            try {
              pts = chart
                .getShapeById(sh.id)
                .getPoints()
                .filter(
                  (p: { time: number; price: number }) =>
        Number.isFinite(p.time) && Number.isFinite(p.price),
                ) as Array<{ time: number; price: number }>;
            } catch {
              /* freehand tools may expose no points */
            }
            if (!pts.length) continue;
            const xs = pts.map((p) => toX(p.time));
            const ys = pts.map((p) => toY(p.price));
            let left = Math.min(...xs) - 14;
            let right = Math.max(...xs) + 14;
            let top = Math.min(...ys) - 14;
            let bottom = Math.max(...ys) + 14;
            // A horizontal line spans the pane, not just its anchor.
            if (sh.name === "horizontal_line") {
              left = paneL + 8;
              right = paneR - 8;
            }
            if (right - left < 70) {
              const cx = (left + right) / 2;
              left = cx - 35;
              right = cx + 35;
            }
            if (bottom - top < 44) {
              const cy = (top + bottom) / 2;
              top = cy - 22;
              bottom = cy + 22;
            }
            // Off-viewport drawings (user panned away) get no box.
            if (right < paneL || left > paneR) continue;
            boxes.push({
              left,
              top,
              width: right - left,
              height: bottom - top,
              // Pre-annotation boxes carry no text — the tag shows only the
              // animated "…" (the agent's reading arrives to replace it).
              label: "",
            });
          }
          setScanBoxes(boxes);
        } catch {
          /* scan boxes are decoration — never break detect */
        }
      };
      // First pass after the screenshot's fit/autoscale settles, then track.
      const first = setTimeout(computeBoxes, 900);
      const iv = setInterval(computeBoxes, 400);
      return () => {
        clearTimeout(first);
        clearInterval(iv);
      };
    }
    if (!detecting && wasDetectingRef.current) {
      wasDetectingRef.current = false;
      scanAnnotationsRef.current = null;
      setScanBoxes([]);
      setScanFlash(true);
      const timer = setTimeout(() => setScanFlash(false), 800);
      return () => clearTimeout(timer);
    }
  }, [detecting]);

  const resolvedStorageKey = storageKey ?? "terminalV2ChartState";
  // HL pairs chart as "BASE/QUOTE"; Lighter symbols ("LIGHTER:BTC-PERP")
  // must pass through untouched — the dash is part of the market name and
  // the router dispatches on the venue prefix.
  const tvSymbol =
    venueOfSymbol(pair) === "lighter" ? pair : pair.replace("-", "/");
  // Latest desired symbol, for catching pair changes that land mid-init.
  const tvSymbolRef = useRef(tvSymbol);
  tvSymbolRef.current = tvSymbol;

  const saveChartState = useCallback(() => {
    if (!widgetRef.current || isUnmountingRef.current) return;
    try {
      if (typeof widgetRef.current.save !== "function") return;
      widgetRef.current.save((state: object) => {
        localStorage.setItem(resolvedStorageKey, JSON.stringify(state));
      });
    } catch {
      // widget may be disposed
    }
  }, [resolvedStorageKey]);

  const loadChartState = useCallback(() => {
    try {
      const saved = localStorage.getItem(resolvedStorageKey);
      if (!saved) return null;
      const state = JSON.parse(saved);
      // Self-heal a degenerate saved zoom: if the bar spacing was persisted
      // tiny (e.g. 0.66px/bar after a resize race), every candle restores at
      // sub-pixel width and the chart looks empty ("No data here") until the
      // user changes timeframe. Drop the saved time-scale in that case so
      // TradingView auto-fits to its default spacing.
      for (const chart of (state?.charts as Array<Record<string, unknown>>) ?? []) {
        const ts = chart?.timeScale as
          | { m_barSpacing?: number; m_rightOffset?: number }
          | undefined;
        if (ts && typeof ts.m_barSpacing === "number" && ts.m_barSpacing < 2) {
          ts.m_barSpacing = 6; // TradingView's default spacing
          // ~10-12 bars of right margin (was 5): un-jams the latest/forming
          // candle from the price scale and leaves room to project a setup's
          // target/stop lines to the right — where the user judges an entry.
          ts.m_rightOffset = 12;
        }
      }
      return state;
    } catch {
      // ignore parse errors
    }
    return null;
  }, [resolvedStorageKey]);

  const buildOverrides = useCallback(() => {
    const p = palette;
    return {
      overrides: {
        "paneProperties.background": p.bg,
        "paneProperties.backgroundType": "solid" as const,
        "paneProperties.backgroundGradientStartColor": p.bg,
        "paneProperties.backgroundGradientEndColor": p.bg,
        "paneProperties.vertGridProperties.color": p.grid,
        "paneProperties.horzGridProperties.color": p.grid,
        "paneProperties.crossHairProperties.color": p.crossHair,
        "paneProperties.crossHairProperties.style": 2,
        "paneProperties.crossHairProperties.width": 1,
        "mainSeriesProperties.priceLineColor": p.priceLine,
        "mainSeriesProperties.priceLineWidth": 1,
        "scalesProperties.lineColor": p.grid,
        "paneProperties.topMargin": 10,
        "paneProperties.bottomMargin": 10,
        "scalesProperties.textColor": p.text,
        "scalesProperties.backgroundColor": p.bg,
        "mainSeriesProperties.candleStyle.upColor": p.candleUp,
        "mainSeriesProperties.candleStyle.downColor": p.candleDown,
        "mainSeriesProperties.candleStyle.borderUpColor": p.candleUp,
        "mainSeriesProperties.candleStyle.borderDownColor": p.candleDown,
        "mainSeriesProperties.candleStyle.wickUpColor": p.candleUp,
        "mainSeriesProperties.candleStyle.wickDownColor": p.candleDown,
        // Multi-venue: the chart must SAY which venue it's charting — the
        // toolbar pair button alone no longer disambiguates "BTC ·
        // Hyperliquid" from "BTC-PERP · Lighter". Venue-agnostic and not
        // flag-gated on purpose.
        "paneProperties.legendProperties.showSeriesTitle": true,
        "paneProperties.legendProperties.showSeriesOHLC": true,
        "paneProperties.legendProperties.showBarChange": true,
        "paneProperties.legendProperties.showVolume": false,
        "mainSeriesProperties.statusViewStyle.showExchange": true,
        "mainSeriesProperties.statusViewStyle.showInterval": false,
        "linetoolsProperties.textcolor": p.priceLine,
        "linetoolsProperties.linecolor": p.priceLine,
        volumePaneSize: "small",
      },
      studiesOverrides: {
        "volume.volume.color.0": p.candleDown,
        "volume.volume.color.1": p.candleUp,
        "volume.volume.transparency": 65,
      },
    };
  }, [palette]);

  // Footprint MODE: the cells ARE the chart — fade the TV candles to faint
  // outlines (wicks stay as thin guides) so only the order flow reads;
  // toggle-off restores the palette candles. Retries briefly because the
  // persisted toggle can fire before the widget is ready. Candles only fade
  // once the footprint has DATA — a blank gray chart while a cold coin
  // starts recording would read as broken.
  useEffect(() => {
    let tries = 0;
    const fade = showOrderFlow && ofDataReady;
    // Gap mode: the overlay paints its OWN candles in each column, so the
    // native series must vanish entirely (not just fade) or two candle sets
    // would double up.
    const hide = showOrderFlow && ofGapped;
    const apply = () => {
      const w = widgetRef.current;
      if (!w || !isChartReadyRef.current) return false;
      try {
        if (hide) {
          w.applyOverrides({
            "mainSeriesProperties.candleStyle.upColor": "rgba(0,0,0,0)",
            "mainSeriesProperties.candleStyle.downColor": "rgba(0,0,0,0)",
            "mainSeriesProperties.candleStyle.borderUpColor": "rgba(0,0,0,0)",
            "mainSeriesProperties.candleStyle.borderDownColor": "rgba(0,0,0,0)",
            "mainSeriesProperties.candleStyle.wickUpColor": "rgba(0,0,0,0)",
            "mainSeriesProperties.candleStyle.wickDownColor": "rgba(0,0,0,0)",
          });
        } else if (fade) {
          w.applyOverrides({
            "mainSeriesProperties.candleStyle.upColor": "rgba(0,0,0,0)",
            "mainSeriesProperties.candleStyle.downColor": "rgba(0,0,0,0)",
            "mainSeriesProperties.candleStyle.borderUpColor": "rgba(148,163,184,0.28)",
            "mainSeriesProperties.candleStyle.borderDownColor": "rgba(148,163,184,0.28)",
            "mainSeriesProperties.candleStyle.wickUpColor": "rgba(148,163,184,0.4)",
            "mainSeriesProperties.candleStyle.wickDownColor": "rgba(148,163,184,0.4)",
          });
        } else {
          const o = buildOverrides().overrides as Record<string, unknown>;
          w.applyOverrides({
            "mainSeriesProperties.candleStyle.upColor":
              o["mainSeriesProperties.candleStyle.upColor"],
            "mainSeriesProperties.candleStyle.downColor":
              o["mainSeriesProperties.candleStyle.downColor"],
            "mainSeriesProperties.candleStyle.borderUpColor":
              o["mainSeriesProperties.candleStyle.borderUpColor"],
            "mainSeriesProperties.candleStyle.borderDownColor":
              o["mainSeriesProperties.candleStyle.borderDownColor"],
            "mainSeriesProperties.candleStyle.wickUpColor":
              o["mainSeriesProperties.candleStyle.wickUpColor"],
            "mainSeriesProperties.candleStyle.wickDownColor":
              o["mainSeriesProperties.candleStyle.wickDownColor"],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
        }
        return true;
      } catch {
        return false;
      }
    };
    if (apply()) return;
    // Generous retry window: a persisted toggle fires at mount, long before
    // the widget is ready (cold dev compiles take 20s+).
    const iv = setInterval(() => {
      tries++;
      if (apply() || tries > 120) clearInterval(iv);
    }, 500);
    return () => clearInterval(iv);
  }, [showOrderFlow, ofDataReady, ofGapped, buildOverrides]);

  // GAP SPACING: entering gap mode widens the bar spacing so each column has
  // room for its candle + footprint numbers; leaving restores the spacing the
  // user had. We only widen (never shrink below the user's own zoom) and only
  // touch it on a mode change, so pan/zoom stays free while gapped.
  useEffect(() => {
    const GAP_BAR_SPACING = 88; // ≈ slim candle + gap + one "sell × buy" column
    let cancelled = false;
    let tries = 0;
    const apply = () => {
      const w = widgetRef.current;
      if (!w || !isChartReadyRef.current) return false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = (w.activeChart() as any).getTimeScale?.();
        if (!ts || typeof ts.setBarSpacing !== "function") return false;
        if (showOrderFlow && ofGapped) {
          if (prevBarSpacingRef.current == null) prevBarSpacingRef.current = ts.barSpacing();
          if (ts.barSpacing() < GAP_BAR_SPACING) ts.setBarSpacing(GAP_BAR_SPACING);
        } else if (prevBarSpacingRef.current != null) {
          ts.setBarSpacing(prevBarSpacingRef.current);
          prevBarSpacingRef.current = null;
        }
        return true;
      } catch {
        return false;
      }
    };
    if (apply()) return;
    const iv = setInterval(() => {
      tries++;
      if (apply() || tries > 120 || cancelled) clearInterval(iv);
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [showOrderFlow, ofGapped]);

  const handleChartAction = useCallback(async (action: ChartAction): Promise<ChartActionResult> => {
    if (!widgetRef.current || !isChartReadyRef.current)
      return { ok: false, error: "chart is still loading — try again in a moment" };
    // Draw cases set this to the truthful outcome (shape id on success, an
    // error string on failure) so the agent and the persisted tool-call log
    // reflect what actually rendered instead of an unconditional {ok:true}.
    let result: ChartActionResult = { ok: true };
    try {
      const chart = widgetRef.current.activeChart();
      switch (action.action) {
        case "set_timeframe":
          chart.setResolution(action.resolution as ResolutionString);
          break;
        case "set_range":
          chart.setVisibleRange({ from: action.from, to: action.to });
          break;
        case "set_symbol": {
          // Resolve loosely (BTC-USD / BTC / HYPE/USDC / xyz:TSLA) against
          // the loaded universe; unknown pairs throw so the caller (agent
          // tool loop) sees the error and can self-correct.
          const raw = action.pair.trim();
          // Accept BTC-USD / BTC / BTC/USD / HYPE/USDC / xyz:TSLA. Strip a
          // perp quote suffix so a stored display symbol ("BTC/USD") resolves
          // to the asset name ("BTC"); keep ":" and spot "/USDC" pairs intact.
          const stripped = raw.includes(":")
            ? raw
            : raw.replace(/[-/]USD$/i, "");
          const candidates = [raw, pairToCoin(raw), stripped, raw.toUpperCase()];
          let asset: AssetMeta | undefined;
          for (const c of candidates) {
            asset =
              assetsByName.get(c) ??
              [...assetsByName.values()].find(
                (a) => a.name.toLowerCase() === c.toLowerCase(),
              );
            if (asset) break;
          }
          if (!asset) throw new Error(`Unknown pair: ${action.pair}`);
          const display = coinToPair(asset.name);
          if (onSymbolChangeRef.current) {
            // Parent owns pair state; the pair-prop effect swaps the widget.
            onSymbolChangeRef.current(display);
          } else {
            chart.setSymbol(display.replace("-", "/"));
          }
          break;
        }
        case "add_indicators": {
          for (const ind of action.indicators) {
            try {
              await chart.createStudy(
                ind.name,
                ind.forceOverlay ?? false,
                false,
                ind.inputs,
              );
            } catch (studyErr) {
              console.warn(
                `[chart-bridge] Failed to add study "${ind.name}":`,
                studyErr,
              );
            }
          }
          break;
        }
        case "remove_indicators": {
          const studies = chart.getAllStudies();
          for (const study of studies) {
            if (
              action.names.some((n) =>
                study.name.toLowerCase().includes(n.toLowerCase()),
              )
            ) {
              chart.removeEntity(study.id);
            }
          }
          break;
        }
        case "clear_indicators":
          chart.removeAllStudies();
          break;
        case "select_tool":
          stickyToolRef.current = action.tool === "cursor" ? null : action.tool;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          widgetRef.current.selectLineTool(action.tool as any);
          break;
        case "draw_level": {
          const color = action.side === "resistance" ? "#ef4444" : "#a3e635";
          const id = chart.createShape(
            { time: Math.floor(Date.now() / 1000), price: action.price },
            {
              shape: "horizontal_line",
              disableSave: true,
              text: action.label ?? "",
              overrides: {
                linecolor: color,
                linewidth: 1,
                linestyle: 2,
                showPrice: true,
                showLabel: Boolean(action.label),
                textcolor: color,
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          );
          if (id) {
            agentShapeIdsRef.current.add(String(id));
            result = { ok: true, shapeId: String(id) };
          } else {
            result = { ok: false, error: "TradingView did not create the horizontal line" };
          }
          break;
        }
        case "draw_zone": {
          const id = chart.createMultipointShape(
            [action.from, action.to],
            {
              shape: "rectangle",
              disableSave: true,
              text: action.label ?? "",
              overrides: {
                backgroundColor: "rgba(163,230,53,0.08)",
                color: "#a3e635",
                linewidth: 1,
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          );
          if (id) {
            agentShapeIdsRef.current.add(String(id));
            result = { ok: true, shapeId: String(id) };
          } else {
            result = { ok: false, error: "TradingView did not create the zone rectangle" };
          }
          break;
        }
        case "draw_trendline": {
          const id = chart.createMultipointShape(
            [action.from, action.to],
            {
              shape: "trend_line",
              disableSave: true,
              text: action.label ?? "",
              overrides: {
                linecolor: "#a3e635",
                linewidth: 1,
                linestyle: 1,
                textcolor: "#a3e635",
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          );
          if (id) {
            agentShapeIdsRef.current.add(String(id));
            result = { ok: true, shapeId: String(id) };
          } else {
            result = { ok: false, error: "TradingView did not create the trendline" };
          }
          break;
        }
        case "draw_fib": {
          const id = chart.createMultipointShape(
            [action.from, action.to],
            {
              shape: "fib_retracement",
              disableSave: true,
              text: action.label ?? "",
              overrides: { linecolor: "#a3e635", linewidth: 1 },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          );
          if (id) {
            agentShapeIdsRef.current.add(String(id));
            result = { ok: true, shapeId: String(id) };
          } else {
            result = { ok: false, error: "TradingView did not create the fib retracement" };
          }
          break;
        }
        case "draw_vertical": {
          const id = chart.createShape(
            { time: action.time, price: 0 },
            {
              shape: "vertical_line",
              disableSave: true,
              text: action.label ?? "",
              overrides: {
                linecolor: "#a3e635",
                linewidth: 1,
                linestyle: 2,
                showTime: false,
                showLabel: Boolean(action.label),
                textcolor: "#a3e635",
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          );
          if (id) {
            agentShapeIdsRef.current.add(String(id));
            result = { ok: true, shapeId: String(id) };
          } else {
            result = { ok: false, error: "TradingView did not create the vertical marker" };
          }
          break;
        }
        case "draw_channel": {
          // parallel_channel = a 3-point tool: two anchors define one rail,
          // the third's PRICE (at the start time) sets the parallel offset.
          const id = chart.createMultipointShape(
            [action.from, action.to, { time: action.from.time, price: action.offsetPrice }],
            {
              shape: "parallel_channel",
              disableSave: true,
              text: action.label ?? "",
              overrides: {
                linecolor: "#a3e635",
                linewidth: 1,
                linestyle: 1,
                showMidline: false,
                fillBackground: true,
                backgroundColor: "rgba(163,230,53,0.06)",
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          );
          if (id) {
            agentShapeIdsRef.current.add(String(id));
            result = { ok: true, shapeId: String(id) };
          } else {
            result = { ok: false, error: "TradingView did not create the channel" };
          }
          break;
        }
        case "draw_fib_extension": {
          // fib_trend_ext = trend-based fib extension: 3 anchors (move start,
          // move end, retrace point the extension projects from).
          const id = chart.createMultipointShape(
            [action.from, action.to, action.retrace],
            {
              shape: "fib_trend_ext",
              disableSave: true,
              text: action.label ?? "",
              overrides: { linecolor: "#a3e635", linewidth: 1 },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          );
          if (id) {
            agentShapeIdsRef.current.add(String(id));
            result = { ok: true, shapeId: String(id) };
          } else {
            result = { ok: false, error: "TradingView did not create the fib extension" };
          }
          break;
        }
        case "draw_text": {
          const id = chart.createShape(
            { time: action.time, price: action.price },
            {
              shape: "text",
              disableSave: true,
              text: action.text,
              overrides: {
                color: "#a3e635",
                fontsize: 12,
                bold: false,
                backgroundColor: "rgba(0,0,0,0.6)",
                drawBorder: false,
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          );
          if (id) {
            agentShapeIdsRef.current.add(String(id));
            result = { ok: true, shapeId: String(id) };
          } else {
            result = { ok: false, error: "TradingView did not create the text note" };
          }
          break;
        }
        case "draw_position_marks": {
          // Replace the previous overlay group wholesale.
          for (const id of positionShapeIdsRef.current) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              chart.removeEntity(id as any);
            } catch {
              /* already gone */
            }
          }
          positionShapeIdsRef.current.clear();
          // Exchange conventions: entry = solid line + PnL label; TP green
          // dashed; SL red dashed; liquidation orange dotted; open orders
          // blue dashed.
          const STYLE: Record<
            string,
            { color: string; linestyle: number; width: number }
          > = {
            entry: { color: "#e7e5e4", linestyle: 0, width: 1 },
            tp: { color: "#a3e635", linestyle: 2, width: 1 },
            sl: { color: "#ef4444", linestyle: 2, width: 1 },
            liq: { color: "#f59e0b", linestyle: 1, width: 1 },
            order: { color: "#60a5fa", linestyle: 2, width: 1 },
          };
          for (const m of action.marks) {
            if (!Number.isFinite(m.price)) continue;
            const s = STYLE[m.kind] ?? STYLE.order;
            try {
              const id = chart.createShape(
                { time: Math.floor(Date.now() / 1000), price: m.price },
                {
                  shape: "horizontal_line",
                  lock: true,
                  disableSelection: true,
                  disableSave: true,
                  text: m.label,
                  overrides: {
                    linecolor: s.color,
                    linewidth: s.width,
                    linestyle: s.linestyle,
                    showPrice: true,
                    showLabel: true,
                    textcolor: s.color,
                    horzLabelsAlign: "right",
                  },
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
              );
              if (id) {
                positionShapeIdsRef.current.add(String(id));
                agentShapeIdsRef.current.add(String(id)); // cleanup scope
              }
            } catch (err) {
              console.warn("position mark failed", m, err);
            }
          }
          break;
        }
        case "draw_tracked_setup": {
          // Replace the previous plan group + stop its recompute loop.
          stopTrackedTimer();
          for (const tl of trackedRef.current) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              chart.removeEntity(tl.id as any);
            } catch {
              /* already gone */
            }
            agentShapeIdsRef.current.delete(tl.id);
          }
          trackedRef.current = [];
          const raw = datafeedRef.current?.recentBars() ?? [];
          const bars: OHLCV[] = raw.map((b) => ({
            time: Math.floor(b.time / 1000),
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          }));
          clearPlanOrderLines();
          for (const lvl of action.levels) {
            const src = parseLevelSource(lvl.source);
            const dyn = src.kind !== "fixed";
            const color =
              lvl.role === "stop"
                ? "#ef4444"
                : lvl.role === "target"
                  ? "#a3e635"
                  : "#38bdf8";
            const defaults =
              dyn && src.kind !== "trendline"
                ? studyParamsFor(chart, src.kind)
                : undefined;
            const live = dyn ? computeLevel(bars, src, defaults) : null;
            const price = live != null && Number.isFinite(live) ? live : lvl.price;
            // Exchange-style ORDER LINE: one horizontal chip per level, the
            // working-order mental model. Dynamic triggers (indicator or
            // trendline) SLIDE to the live trigger value via setPrice() in
            // the recompute loop — always horizontal, always current, no
            // duplicate geometry over the user's own drawings.
            try {
              const line = (chart as unknown as {
                createOrderLine: () => {
                  setPrice: (p: number) => unknown;
                  setText: (t: string) => unknown;
                  setQuantity: (q: string) => unknown;
                  setLineColor: (c: string) => unknown;
                  setLineStyle: (s: number) => unknown;
                  setBodyFont: (f: string) => unknown;
                  setBodyTextColor: (c: string) => unknown;
                  setBodyBorderColor: (c: string) => unknown;
                  setBodyBackgroundColor: (c: string) => unknown;
                  remove: () => void;
                };
              }).createOrderLine();
              line.setText(dyn ? `${lvl.label} · ~${src.kind}` : lvl.label);
              // Empty quantity HIDES the quantity block entirely — styling it
              // transparent instead left an invisible box that read as a gap
              // before the label.
              line.setQuantity("");
              line.setPrice(price);
              line.setLineColor(color);
              line.setLineStyle(dyn ? 0 : 2); // live trigger solid, fixed dashed
              // Site font (custom.css embeds DM Sans inside the TV iframe).
              line.setBodyFont('500 10px "DM Sans", sans-serif');
              line.setBodyTextColor(color);
              line.setBodyBorderColor(color);
              line.setBodyBackgroundColor("rgba(0,0,0,0.75)");
              planOrderLinesRef.current.push({ line, source: src, studyDefaults: defaults });
            } catch {
              // Order lines unavailable in this build → the old shape path.
              const id = chart.createShape(
                { time: Math.floor(Date.now() / 1000), price },
                {
                  shape: "horizontal_line",
                  disableSave: true,
                  text: dyn ? `${lvl.label} · ~${src.kind}` : lvl.label,
                  overrides: {
                    linecolor: color,
                    linewidth: dyn ? 2 : 1,
                    linestyle: dyn ? 0 : 2,
                    showPrice: true,
                    showLabel: true,
                    textcolor: color,
                  },
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
              );
              if (id) {
                const sid = String(id);
                agentShapeIdsRef.current.add(sid);
                trackedRef.current.push({
                  id: sid,
                  role: lvl.role,
                  source: src,
                  studyDefaults: defaults,
                });
              }
            }
          }
          // Kick off tracking only if something is dynamic.
          if (
            trackedRef.current.some((t) => t.source.kind !== "fixed") ||
            planOrderLinesRef.current.some((o) => o.source.kind !== "fixed")
          ) {
            trackedTimerRef.current = setInterval(
              () => recomputeTrackedRef.current(),
              3000,
            );
          }
          break;
        }
        case "clear_all_drawings": {
          chart.removeAllShapes();
          agentShapeIdsRef.current.clear();
          positionShapeIdsRef.current.clear();
          stopTrackedTimer();
          trackedRef.current = [];
          clearPlanOrderLines();
          break;
        }
        case "remove_entities": {
          for (const id of action.ids) {
            // React overlays aren't TV entities — removeEntity no-ops on them
            // and the tag reappears on the next context tick. Route overlay
            // ids to their toggles so "clear all" genuinely clears them.
            if (id === "liq-heatmap") {
              if (liqOnRef.current) handleToggleLiq();
              continue;
            }
            if (id === "orderflow-footprint") {
              if (ofOnRef.current) handleToggleOf();
              continue;
            }
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              chart.removeEntity(id as any);
              agentShapeIdsRef.current.delete(id);
            } catch {
              /* already gone */
            }
          }
          break;
        }
        case "clear_agent_drawings": {
          for (const id of agentShapeIdsRef.current) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              chart.removeEntity(id as any);
            } catch {
              /* already gone */
            }
          }
          agentShapeIdsRef.current.clear();
          positionShapeIdsRef.current.clear();
          stopTrackedTimer();
          trackedRef.current = [];
          clearPlanOrderLines();
          break;
        }
      }
    } catch (err) {
      console.error("Chart action error:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return result;
  }, [assetsByName]);

  useEffect(() => {
    if (
      !chartContainerRef.current ||
      !pair ||
      !isReady ||
      assetsByName.size === 0
    )
      return;
    if (typeof window === "undefined" || typeof widget === "undefined") return;

    isChartReadyRef.current = false;
    setIsLoading(true);
    // Safety net: never let the loading shimmer hang forever if onChartReady
    // fails to fire (bad restore, widget error). The chart itself still
    // renders underneath; we just stop hiding it.
    const loadGuard = setTimeout(() => setIsLoading(false), 8000);

    if (widgetRef.current) {
      try {
        widgetRef.current.remove();
      } catch {
        /* noop */
      }
      widgetRef.current = null;
    }

    try {
      // Venue router: dispatches per-symbol to the HL or Lighter datafeed
      // ("LIGHTER:" prefix). With the Lighter flag off it is a pure
      // pass-through to the HL datafeed — zero behavior change.
      const datafeed = new VenueDatafeedRouter(
        new HyperliquidDatafeed(info, subscription, assets, assetsByName),
        new LighterDatafeed(),
      );
      datafeedRef.current = datafeed;

      const isMobile = window.innerWidth < 768;
      const { overrides, studiesOverrides } = buildOverrides();

      // Keep the toolbar as close to tradingview.com/chart as possible —
      // only saveload/templates (no backend for them) and trading pages
      // are disabled.
      const disabledFeatures: string[] = [
        "header_saveload",
        "study_templates",
        "chart_property_page_trading",
        "border_around_the_chart",
        // Typing must reach OUR chat, not TV's symbol search (type-to-chat).
        "symbol_search_hot_key",
        // Kills the "press and hold Ctrl while zooming…" hint overlay + friends.
        "popup_hints",
        // Our header owns pair selection (market picker) — TV's own symbol
        // search button in the chart toolbar is redundant, and so is the
        // compare-symbol overlay button next to it.
        "header_symbol_search",
        "header_compare",
        // Object Tree button + the date-range row under the chart — both
        // add clutter without trader value in our layout.
        "show_object_tree",
        "timeframes_toolbar",
        // Chart-type (candles) selector: we standardise on candles.
        "header_chart_type",
        // TV's own Indicators button — replaced by our combined dialog
        // (Superior-exclusive overlays pinned first + the TV catalog).
        "header_indicators",
      ];
      // The bottom-left TV logo is canvas-drawn (CSS can't reach it);
      // logo_without_link strips its link + hover-expand so it can't block
      // the chat bar. Attribution itself stays visible per the TV license.
      const enabledFeatures: string[] = [
        "remove_library_container_border",
        "logo_without_link",
      ];

      if (isMobile) {
        disabledFeatures.push("left_toolbar");
      }

      const widgetOptions: ChartingLibraryWidgetOptions = {
        // Dev only: prints custom-study runtime exceptions (with stacks) to
        // the iframe console — TV swallows them silently otherwise.
        debug: process.env.NODE_ENV === "development",
        symbol: tvSymbol,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        datafeed: datafeed as any,
        interval: resolution as ResolutionString,
        container: chartContainerRef.current,
        library_path: "/static/charting_library/",
        locale: "en" as LanguageCode,
        autosize: true,
        // Dracula/Nord are dark-family — only "light" maps to TV's light UI.
        theme: theme === "light" ? "light" : "dark",
        // tv-theme.css = lime accent variables (hover/active/selected states
        // inside the widget iframe); it @imports charting_library/custom.css
        // (structural chrome, fonts, glass menus) first so the accent wins
        // the cascade. This is the ONLY widget construction site.
        custom_css_url: "/static/tv-theme.css",
        // Site font inside the chart (UI + canvas scales). The face itself
        // is @font-face'd in custom.css — parent-page fonts don't reach
        // the iframe.
        custom_font_family: "'DM Sans', ui-sans-serif, system-ui, sans-serif",
        disabled_features:
          disabledFeatures as ChartingLibraryWidgetOptions["disabled_features"],
        enabled_features:
          enabledFeatures as ChartingLibraryWidgetOptions["enabled_features"],
        client_id: "trading-terminal",
        user_id: "terminal-user",
        saved_data: loadChartState() || undefined,
        auto_save_delay: 2,
        favorites: {
          // Header quick-select timeframes: 1m..4h (12h/1D dropped — the
          // dropdown still has them). NOTE: TV persists favorites in
          // localStorage which takes precedence; the scrub in initWidget
          // rewrites saved sets to match.
          intervals: ["1", "5", "15", "30", "60", "240"].map(
            (i) => i as ResolutionString,
          ),
          chartTypes: ["Candles"],
        },
        time_frames: [
          { text: "1m", resolution: "1" as ResolutionString },
          { text: "5m", resolution: "5" as ResolutionString },
          { text: "15m", resolution: "15" as ResolutionString },
          { text: "1h", resolution: "60" as ResolutionString },
          { text: "4h", resolution: "240" as ResolutionString },
          { text: "1D", resolution: "1D" as ResolutionString },
          { text: "1W", resolution: "1W" as ResolutionString },
          { text: "1M", resolution: "1M" as ResolutionString },
        ],
        overrides,
        studies_overrides: studiesOverrides,
        loading_screen: {
          backgroundColor: palette.bg,
          foregroundColor: palette.bg,
        },
        // Superior-exclusive studies, fed by our footprint store through the
        // datafeed's synthetic "CVD:<ticker>" symbol (documented new_sym +
        // adopt sample-and-hold pattern) — live edge from the collector, not
        // derivable from OHLCV. Rendering follows the order-flow conventions
        // pros expect: CVD as green/red CANDLES (wicks = intrabar delta
        // extremes, so absorption is visible — a plain line hid all of it,
        // and TV's own CVD study draws candles for the same reason), and
        // per-bar Volume Delta as a zero-anchored colored histogram.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        custom_indicators_getter: ((PineJS: any) => {
          // Shared plumbing: pull the CVD series for the chart's ticker and
          // sample-and-hold onto the main series' timeline.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const initCvdSym = function (self: any, context: any) {
            self._context = context;
            const base = PineJS.Std.ticker(self._context);
            self._context.new_sym(`CVD:${base}`, PineJS.Std.period(self._context));
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sampleCvd = function (self: any, context: any) {
            self._context = context;
            self._context.select_sym(1);
            const t1 = self._context.new_var(self._context.symbol.time);
            const o1 = self._context.new_var(PineJS.Std.open(self._context));
            const h1 = self._context.new_var(PineJS.Std.high(self._context));
            const l1 = self._context.new_var(PineJS.Std.low(self._context));
            const c1 = self._context.new_var(PineJS.Std.close(self._context));
            self._context.select_sym(0);
            const t0 = self._context.new_var(self._context.symbol.time);
            return {
              o: o1.adopt(t1, t0, 1),
              h: h1.adopt(t1, t0, 1),
              l: l1.adopt(t1, t0, 1),
              c: c1.adopt(t1, t0, 1),
            };
          };
          const GREEN = "#22c55e";
          const RED = "#ef4444";
          return Promise.resolve([
            {
              name: "Superior CVD",
              metainfo: {
                _metainfoVersion: 53,
                id: "SuperiorCVD@tv-basicstudies-1",
                name: "Superior CVD",
                description: "Superior CVD (order-flow delta)",
                shortDescription: "CVD",
                is_price_study: false,
                isCustomIndicator: true,
                format: { type: "volume" },
                plots: [
                  { id: "plot_open", type: "ohlc_open", target: "plot_candle" },
                  { id: "plot_high", type: "ohlc_high", target: "plot_candle" },
                  { id: "plot_low", type: "ohlc_low", target: "plot_candle" },
                  { id: "plot_close", type: "ohlc_close", target: "plot_candle" },
                  {
                    id: "plot_color",
                    type: "ohlc_colorer",
                    target: "plot_candle",
                    palette: "paletteCvd",
                  },
                ],
                ohlcPlots: { plot_candle: { title: "CVD" } },
                palettes: {
                  paletteCvd: {
                    colors: [{ name: "Delta up" }, { name: "Delta down" }],
                    valToIndex: { 0: 0, 1: 1 },
                  },
                },
                defaults: {
                  ohlcPlots: {
                    plot_candle: {
                      borderColor: GREEN,
                      color: GREEN,
                      // REQUIRED: the legend view subscribes to `display`
                      // unconditionally for ohlc plots — omitting it kills
                      // the study at construction with a bare "Runtime
                      // error" badge. 15 = StudyPlotDisplayTarget.All.
                      display: 15,
                      drawBorder: true,
                      drawWick: true,
                      plottype: "ohlc_candles",
                      visible: true,
                      wickColor: "#9ca3af",
                    },
                  },
                  palettes: {
                    paletteCvd: {
                      colors: [
                        { color: GREEN, style: 0, width: 1 },
                        { color: RED, style: 0, width: 1 },
                      ],
                    },
                  },
                  inputs: {},
                },
                inputs: [],
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              constructor: function (this: any) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.init = function (this: any, context: any) {
                  initCvdSym(this, context);
                };
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.main = function (this: any, context: any) {
                  const b = sampleCvd(this, context);
                  return [b.o, b.h, b.l, b.c, b.c >= b.o ? 0 : 1];
                };
              },
            },
            {
              name: "Superior Volume Delta",
              metainfo: {
                _metainfoVersion: 53,
                id: "SuperiorVolumeDelta@tv-basicstudies-1",
                name: "Superior Volume Delta",
                description: "Superior Volume Delta (per-bar order flow)",
                shortDescription: "Delta",
                is_price_study: false,
                isCustomIndicator: true,
                format: { type: "volume" },
                // TV's flagship Volume Delta rendering: candles whose OPEN is
                // pinned to 0 — bodies read as a histogram, wicks show the
                // intrabar delta excursion (how far the bar's running delta
                // stretched before settling).
                plots: [
                  { id: "plot_open", type: "ohlc_open", target: "plot_candle" },
                  { id: "plot_high", type: "ohlc_high", target: "plot_candle" },
                  { id: "plot_low", type: "ohlc_low", target: "plot_candle" },
                  { id: "plot_close", type: "ohlc_close", target: "plot_candle" },
                  {
                    id: "plot_color",
                    type: "ohlc_colorer",
                    target: "plot_candle",
                    palette: "paletteDelta",
                  },
                ],
                ohlcPlots: { plot_candle: { title: "Delta" } },
                palettes: {
                  paletteDelta: {
                    colors: [{ name: "Buy delta" }, { name: "Sell delta" }],
                    valToIndex: { 0: 0, 1: 1 },
                  },
                },
                defaults: {
                  ohlcPlots: {
                    plot_candle: {
                      borderColor: GREEN,
                      color: GREEN,
                      // Same requirement as the CVD study: display is
                      // subscribed unconditionally. 15 = All.
                      display: 15,
                      drawBorder: true,
                      drawWick: true,
                      plottype: "ohlc_candles",
                      visible: true,
                      wickColor: "#9ca3af",
                    },
                  },
                  palettes: {
                    paletteDelta: {
                      colors: [
                        { color: GREEN, style: 0, width: 1 },
                        { color: RED, style: 0, width: 1 },
                      ],
                    },
                  },
                  inputs: {},
                },
                inputs: [],
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              constructor: function (this: any) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.init = function (this: any, context: any) {
                  initCvdSym(this, context);
                };
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.main = function (this: any, context: any) {
                  const b = sampleCvd(this, context);
                  const delta = b.c - b.o;
                  // Delta candle: open 0, close = net delta, wicks = intrabar
                  // running-delta extremes relative to the bar's start.
                  return [0, b.h - b.o, b.l - b.o, delta, delta >= 0 ? 0 : 1];
                };
              },
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ]) as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      };

      // Scrub: TV's persisted interval favorites override our `favorites`
      // config — rewrite any saved interval set to the canonical quick-select
      // list (1m..4h) so config changes actually apply for existing browsers.
      try {
        const CANON = ["1", "5", "15", "30", "60", "240"];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (!k || !/favorite/i.test(k)) continue;
          const v = window.localStorage.getItem(k);
          if (!v) continue;
          const arr: unknown = JSON.parse(v);
          if (
            Array.isArray(arr) &&
            arr.length > 0 &&
            arr.every((x) => typeof x === "string" && /^\d+[SDWM]?$/.test(x)) &&
            JSON.stringify(arr) !== JSON.stringify(CANON)
          ) {
            window.localStorage.setItem(k, JSON.stringify(CANON));
          }
        }
      } catch {
        /* storage unavailable */
      }

      const tvWidget = new widget(widgetOptions);
      widgetRef.current = tvWidget;

      tvWidget.onChartReady(() => {
        isChartReadyRef.current = true;
        // Sticky line tools: TV drops back to browse mode after placing a
        // line (brush stays armed) while our toolbar still shows the tool
        // pressed — the user had to click twice to re-arm. Re-select the
        // armed tool right after each placement so every tool behaves like
        // brush. (Re-arming brush itself is a harmless no-op.)
        try {
          tvWidget.subscribe("drawing_event", (_id: string, type: string) => {
            if (type !== "create" || !stickyToolRef.current) return;
            setTimeout(() => {
              try {
                if (stickyToolRef.current) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  tvWidget.selectLineTool(stickyToolRef.current as any);
                }
              } catch {
                /* widget disposed mid-tick */
              }
            }, 0);
          });
        } catch {
          /* drawing_event unavailable in this library build */
        }
        // Fresh chart instance: stale liq-shape ids from a disposed chart are
        // meaningless; redraw if the toggle survived a widget rebuild.
        liqShapeIdsRef.current.clear();
        if (liqOnRef.current) void drawLiqRef.current();
        // Bar lengths are proportions of the visible window — re-fit after a
        // MATERIAL zoom/pan (debounced; small nudges keep the current draw).
        try {
          let refitTmr: ReturnType<typeof setTimeout> | null = null;
          tvWidget
            .activeChart()
            .onVisibleRangeChanged()
            .subscribe(null, () => {
              if (!liqOnRef.current) return;
              if (refitTmr) clearTimeout(refitTmr);
              refitTmr = setTimeout(() => {
                const last = liqFitRangeRef.current;
                let vr: { from: number; to: number } | null = null;
                try {
                  vr = tvWidget.activeChart().getVisibleRange();
                } catch {
                  return;
                }
                if (!vr || !liqOnRef.current) return;
                if (last) {
                  const w0 = last.to - last.from;
                  const w1 = vr.to - vr.from;
                  const ratio = w1 / Math.max(1, w0);
                  const shift = Math.abs(vr.to - last.to) / Math.max(1, w1);
                  if (ratio > 0.75 && ratio < 1.35 && shift < 0.3) return;
                }
                void drawLiqRef.current();
              }, 700);
            });
        } catch {
          /* subscription unavailable — bars keep their last fit */
        }
        // Tint the TV chrome (top toolbar + drawing sidebar) to the active
        // theme's background so it matches the app, not a hardcoded black.
        try {
          chartContainerRef.current
            ?.querySelector("iframe")
            ?.contentDocument?.documentElement.style.setProperty(
              "--tv-chrome-bg",
              palette.bg,
            );
        } catch {
          /* iframe not ready yet — the theme effect re-applies it */
        }
        // Force the TV chrome (top toolbar + drawing sidebar) to the app's
        // theme on load. A restored saved layout can carry a STALE theme, and
        // the theme effect may have run before the chart was ready — leaving
        // the toolbars on the wrong (light/white) theme. changeTheme applies
        // the `theme-dark` class that custom.css keys the toolbar colors off.
        try {
          // dark-family themes (dark, dracula, nord) all map to TV's "dark";
          // only "light" is light. (Was `=== "dark" ? ... : "light"`, which
          // sent dracula/nord to TV light → white toolbars.)
          const want = theme === "light" ? "light" : "dark";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = tvWidget as any;
          if (w.getTheme?.() !== want) {
            Promise.resolve(w.changeTheme?.(want))
              .then(() => {
                try {
                  const { overrides, studiesOverrides } = buildOverrides();
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  tvWidget.applyOverrides(overrides as any);
                  tvWidget.applyStudiesOverrides(studiesOverrides);
                } catch {
                  /* widget disposed */
                }
              })
              .catch(() => {});
          }
        } catch {
          /* changeTheme unavailable */
        }
        try {
          const chart = tvWidget.activeChart();

          // Agent-supplied support/resistance overlays: locked and
          // non-persisted so they stay pure overlays owned by the ledger.
          if (supportResistanceLevels?.length) {
            for (const level of supportResistanceLevels) {
              if (!Number.isFinite(level.price)) continue;
              const color =
                level.side === "resistance" ? "#ef4444" : "#a3e635";
              try {
                chart.createShape(
                  { time: Math.floor(Date.now() / 1000), price: level.price },
                  {
                    shape: "horizontal_line",
                    lock: true,
                    disableSelection: true,
                    disableSave: true,
                    text: level.label ?? "",
                    overrides: {
                      linecolor: color,
                      linewidth: 1,
                      linestyle: 2,
                      showPrice: true,
                      showLabel: Boolean(level.label),
                      textcolor: color,
                    },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  } as any,
                );
              } catch (err) {
                console.warn("Failed to draw chart level", level, err);
              }
            }
          }

          // Force-apply overrides after ready to beat any saved-state colors.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tvWidget.applyOverrides(overrides as any);
          tvWidget.applyStudiesOverrides(studiesOverrides);

          const debouncedSave = () => {
            if (isUnmountingRef.current) return;
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = setTimeout(() => saveChartState(), 2000);
          };

          chart.onDataLoaded().subscribe(null, debouncedSave);
          chart.onSymbolChanged().subscribe(null, debouncedSave);
          chart.onIntervalChanged().subscribe(null, debouncedSave);

          chart.onSymbolChanged().subscribe(null, () => {
            try {
              const raw = chart.symbol().replace(/^Hyperliquid:/, "");
              const display = raw.replace(/\/USD$/, "-USD");
              onSymbolChangeRef.current?.(display);
            } catch {
              /* widget disposed */
            }
          });

          const periodicInterval = setInterval(() => {
            if (!isUnmountingRef.current) saveChartState();
          }, 10000);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tvWidget as any)._periodicSaveInterval = periodicInterval;

          const handleBlur = () => {
            if (!isUnmountingRef.current) saveChartState();
          };
          window.addEventListener("blur", handleBlur);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tvWidget as any)._blurHandler = handleBlur;

          const handleUnload = () => {
            if (!isUnmountingRef.current) saveChartState();
          };
          window.addEventListener("beforeunload", handleUnload);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tvWidget as any)._beforeUnloadHandler = handleUnload;

          // Type-to-chat: the vendored library iframe is same-origin, so
          // its keystrokes are interceptable. Printable keys (no modifiers,
          // not aimed at TV's own dialog inputs) are rerouted to the chat
          // input; arrows/Escape/shortcuts stay with the chart.
          const iframe = chartContainerRef.current?.querySelector("iframe");
          const idoc = iframe?.contentDocument;
          if (idoc) {
            const onIframeKey = (e: KeyboardEvent) => {
              if (e.ctrlKey || e.metaKey || e.altKey) return;
              // ESC inside the iframe never reaches the parent's listeners —
              // forward it so the chat toolbar can release its armed tool
              // (TV also cancels its own drawing mode; both must agree).
              if (e.key === "Escape") {
                window.dispatchEvent(new Event("cg:escape"));
                return; // don't consume — TV handles its own cancel too
              }
              if (e.key.length !== 1) return;
              const t = e.target as HTMLElement | null;
              if (
                t &&
                (t.tagName === "INPUT" ||
                  t.tagName === "TEXTAREA" ||
                  t.isContentEditable)
              )
                return;
              e.preventDefault();
              e.stopPropagation();
              window.dispatchEvent(
                new CustomEvent("cg:type-to-chat", { detail: { char: e.key } }),
              );
            };
            idoc.addEventListener("keydown", onIframeKey, true);

            // Middle-click (wheel-hold) pan: TV only pans on left-drag with
            // the cursor tool, so an armed drawing tool forces users to
            // deselect just to move the view. Capture button-1 drags before
            // TV sees them and shift the visible TIME and PRICE ranges
            // manually — works with any tool armed. Applies are coalesced to
            // one per animation frame (latest event wins) for smoothness.
            const midPan = {
              active: null as null | {
                startX: number;
                startY: number;
                from: number;
                to: number;
                priceFrom: number;
                priceTo: number;
                width: number;
                height: number;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                priceScale: any | null;
              },
              pending: null as null | { x: number; y: number },
              raf: 0,
            };
            const applyMidPan = () => {
              midPan.raf = 0;
              const pan = midPan.active;
              const pt = midPan.pending;
              if (!pan || !pt) return;
              const secPerPx = (pan.to - pan.from) / Math.max(pan.width, 1);
              const dx = (pan.startX - pt.x) * secPerPx;
              try {
                const c = tvWidget.activeChart();
                // TV never sees the swallowed mousemoves, so its crosshair
                // (dotted cross) would stay frozen at the grab point — clear
                // it for the duration of the pan.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (c as any).clearCrosshairPosition?.();
                void c.setVisibleRange(
                  { from: pan.from + dx, to: pan.to + dx },
                  // Keep the price range pinned while panning so the time
                  // shift doesn't re-autoscale and fight the vertical drag.
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  { applyDefaultRightMargin: false } as any,
                );
                if (pan.priceScale) {
                  const pricePerPx =
                    (pan.priceTo - pan.priceFrom) / Math.max(pan.height, 1);
                  // Screen y grows downward: dragging DOWN should move the
                  // view down the price axis (prices decrease).
                  const dy = (pt.y - pan.startY) * pricePerPx;
                  pan.priceScale.setVisiblePriceRange({
                    from: pan.priceFrom + dy,
                    to: pan.priceTo + dy,
                  });
                }
              } catch {
                /* mid-layout — next frame applies */
              }
            };
            const onMidDown = (e: MouseEvent) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              try {
                const c = tvWidget.activeChart();
                const r = c.getVisibleRange();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let priceScale: any = null;
                let priceFrom = 0;
                let priceTo = 0;
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  priceScale = (c as any).getPanes()[0].getMainSourcePriceScale();
                  const pr = priceScale?.getVisiblePriceRange?.();
                  if (pr) {
                    priceFrom = pr.from;
                    priceTo = pr.to;
                    // Manual vertical pan implies manual scale (same as TV's
                    // own axis-drag behavior).
                    priceScale.setAutoScale(false);
                  } else {
                    priceScale = null;
                  }
                } catch {
                  priceScale = null;
                }
                midPan.active = {
                  startX: e.clientX,
                  startY: e.clientY,
                  from: r.from,
                  to: r.to,
                  priceFrom,
                  priceTo,
                  width: idoc.body?.clientWidth || 1000,
                  height: idoc.body?.clientHeight || 600,
                  priceScale,
                };
                midPan.pending = null;
              } catch {
                /* chart busy */
              }
            };
            const onMidMove = (e: MouseEvent) => {
              if (!midPan.active) return;
              e.preventDefault();
              e.stopPropagation();
              midPan.pending = { x: e.clientX, y: e.clientY };
              if (!midPan.raf) {
                midPan.raf = (iframe?.contentWindow ?? window).requestAnimationFrame(
                  applyMidPan,
                );
              }
            };
            const onMidUp = (e: MouseEvent) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              midPan.active = null;
              midPan.pending = null;
            };
            const onMidCancel = () => {
              midPan.active = null;
              midPan.pending = null;
            };
            const onAux = (e: MouseEvent) => {
              if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
              }
            };
            idoc.addEventListener("mousedown", onMidDown, true);
            idoc.addEventListener("mousemove", onMidMove, true);
            idoc.addEventListener("mouseup", onMidUp, true);
            idoc.addEventListener("mouseleave", onMidCancel, true);
            idoc.addEventListener("auxclick", onAux, true);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (tvWidget as any)._typeToChatCleanup = () => {
              try {
                idoc.removeEventListener("keydown", onIframeKey, true);
                idoc.removeEventListener("mousedown", onMidDown, true);
                idoc.removeEventListener("mousemove", onMidMove, true);
                idoc.removeEventListener("mouseup", onMidUp, true);
                idoc.removeEventListener("mouseleave", onMidCancel, true);
                idoc.removeEventListener("auxclick", onAux, true);
              } catch {
                /* iframe already gone */
              }
            };
          }
        } catch (err) {
          console.error("Chart ready error:", err);
        }

        // A pair switch that raced the init lands here.
        try {
          const chart = tvWidget.activeChart();
          const current = chart.symbol().replace(/^Hyperliquid:/, "");
          if (current !== tvSymbolRef.current) {
            chart.setSymbol(tvSymbolRef.current);
          }
        } catch {
          /* noop */
        }

        // Dev escape hatch: poke the live widget from the console
        // (e.g. window.__tvWidget.activeChart().setChartType(17)).
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__tvWidget = tvWidget;
        }

        // Pair selector lives in the TV toolbar, BEFORE the timeframe
        // favorites. The button is a dumb label (fed by "cg:pair-metrics"
        // from MarketPicker); clicking opens the picker panel in the parent
        // document at the button's screen position.
        void tvWidget.headerReady().then(() => {
          const btn = tvWidget.createButton({
            align: "left",
            useTradingViewStyle: false,
          });
          if (!btn) return;
          btn.style.cssText =
            "cursor:pointer;white-space:nowrap;font-weight:700;" +
            "display:inline-flex;align-items:center;padding:4px 12px;" +
            "margin-left:10px;border-radius:9999px;" +
            "border:1px solid rgba(255,255,255,0.16);" +
            "background:rgba(255,255,255,0.06);";
          btn.addEventListener("mouseenter", () => {
            btn.style.background = "rgba(255,255,255,0.11)";
          });
          btn.addEventListener("mouseleave", () => {
            btn.style.background = "rgba(255,255,255,0.06)";
          });
          interface PairMetricsDetail {
            pair?: string;
            label?: string;
            chg?: string;
            up?: boolean;
            lev?: string;
            levTip?: string;
            funding?: string;
            fundingUp?: boolean;
            fundingTip?: string;
          }
          const badge = (text: string, color: string) => {
            const el = document.createElement("span");
            el.textContent = text;
            el.style.cssText = `margin-left:6px;padding:1px 6px;border-radius:9999px;background:rgba(255,255,255,0.09);font-weight:600;font-size:11px;color:${color};`;
            return el;
          };
          const render = (d: PairMetricsDetail) => {
            btn.innerHTML = "";
            const name = document.createElement("span");
            // Prefer the "TICKER | Full Name" label; fall back to raw pair.
            name.textContent = d.label ?? d.pair ?? "";
            btn.append(name);
            if (d.lev) btn.append(badge(d.lev, "rgba(255,255,255,0.75)"));
            if (d.chg) btn.append(badge(d.chg, d.up ? "#a3e635" : "#f87171"));
            const caret = document.createElement("span");
            caret.textContent = " ▾";
            caret.style.opacity = "0.5";
            btn.append(caret);
          };
          render({ pair });
          const onMetrics = (e: Event) => render((e as CustomEvent<PairMetricsDetail>).detail);
          window.addEventListener("cg:pair-metrics", onMetrics);
          // Ask MarketPicker to replay the latest snapshot — the dispatches
          // that happened while the chart was still booting are gone.
          window.dispatchEvent(new CustomEvent("cg:request-pair-metrics"));
          btn.addEventListener("click", () => {
            const iframe = chartContainerRef.current?.querySelector("iframe");
            const iRect = iframe?.getBoundingClientRect();
            const bRect = btn.getBoundingClientRect();
            window.dispatchEvent(
              new CustomEvent("cg:open-market-picker", {
                detail: {
                  x: (iRect?.left ?? 0) + bRect.left,
                  y: (iRect?.top ?? 0) + bRect.bottom + 8,
                },
              }),
            );
          });
          // Move our button's toolbar GROUP to the front of the left
          // toolbar row, before the timeframe favorites. (Class names are
          // build-hashed, so match on the "group-" prefix.) The group's
          // PRECEDING separator must go with it — left behind it stacks
          // against the next group's separator as a double border.
          try {
            const group = btn.closest('[class*="group-"]');
            if (group?.parentElement) {
              const sep = group.previousElementSibling;
              if (sep && /separatorWrap-/.test(String(sep.className))) sep.remove();
              group.parentElement.prepend(group);
            }
          } catch {
            /* cosmetic — order stays default */
          }

          // Combined "Indicators" dialog — replaces BOTH TV's Indicators
          // button (header_indicators disabled) and the old Adv. Indicators
          // menu. Superior-exclusive overlays are pinned on top with a ✦
          // badge ("Superior exclusive" on hover); the full TV study catalog
          // (getStudiesList) sits below, one search box over both. Hand-
          // rolled so toggles KEEP the menu open (TV's dropdown closes).
          const advBtn = tvWidget.createButton({
            align: "left",
            useTradingViewStyle: false,
          });
          if (advBtn) {
            // Lives inside the TV iframe — spin keyframes + the menu must be
            // registered in THAT document, not the parent's.
            const bdoc = advBtn.ownerDocument;
            if (bdoc && !bdoc.getElementById("cg-liq-spin")) {
              const st = bdoc.createElement("style");
              st.id = "cg-liq-spin";
              st.textContent =
                "@keyframes cg-liq-spin{to{transform:rotate(360deg)}}";
              bdoc.head.appendChild(st);
            }
            const paintBtn = () => {
              // Active count = our overlays + TV studies on the chart.
              // (Order flow has its OWN toolbar button — not counted here.)
              let count = liqOnRef.current ? 1 : 0;
              try {
                const studies =
                  widgetRef.current?.activeChart?.().getAllStudies?.() ?? [];
                count += studies.length;
              } catch {
                /* chart not ready — overlays-only count */
              }
              const on = count > 0;
              advBtn.style.cssText =
                "cursor:pointer;white-space:nowrap;font-weight:700;font-size:13px;" +
                "display:inline-flex;align-items:center;gap:5px;padding:5px 11px;" +
                "margin-left:6px;border-radius:9999px;letter-spacing:0.02em;" +
                (on
                  ? "border:1px solid rgba(253,224,71,0.45);background:rgba(253,224,71,0.10);color:rgba(255,255,255,0.9);"
                  : "border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);");
              advBtn.innerHTML = "";
              advBtn.append(
                bdoc.createTextNode(
                  count > 0
                    ? tRef.current("indBtnActive").replace("{n}", String(count))
                    : tRef.current("indBtn"),
                ),
              );
              const caret = bdoc.createElement("span");
              caret.textContent = "▾";
              caret.style.opacity = "0.5";
              advBtn.append(caret);
            };
            paintBtn();

            // The button stays in the TV toolbar; the menu itself is a React
            // portal in the PARENT document (real components + tooltips). Here
            // we only bind the paint closures and toggle React state, handing
            // it the on-screen anchor rect (iframe offset + button rect).
            paintBtnRef.current = paintBtn;
            liqPaintRef.current = (loading: boolean) => {
              setLiqLoading(loading);
              paintBtn();
            };
            const openAnchored = () => {
              const iframe = chartContainerRef.current?.querySelector("iframe");
              const ir = iframe?.getBoundingClientRect();
              const br = advBtn.getBoundingClientRect();
              setIndicatorAnchor({
                left: (ir?.left ?? 0) + br.left,
                top: (ir?.top ?? 0) + br.bottom + 6,
              });
            };
            advBtn.addEventListener("click", () => {
              openAnchored();
              setIndicatorMenuOpen((v) => !v);
            });
            // Clicks elsewhere inside the iframe close the parent-doc menu
            // (its own outside-click listener can't observe iframe clicks).
            bdoc.addEventListener("mousedown", (e: MouseEvent) => {
              if (!advBtn.contains(e.target as Node)) setIndicatorMenuOpen(false);
            });
          }

          // Dedicated "Order Flow" toggle, right of the Indicators button —
          // a headline feature deserves one click, not a dialog dig. Lime
          // accent when live; a spinner while ON but still collecting data.
          const ofBtn = tvWidget.createButton({
            align: "left",
            useTradingViewStyle: false,
          });
          if (ofBtn) {
            const odoc = ofBtn.ownerDocument;
            const paintOf = () => {
              const on = ofOnRef.current;
              // No spinner when signed out — the overlay won't mount, so it
              // would spin forever. Only spin while genuinely fetching.
              const loading = on && ofAuthedRef.current && !ofReadyRef.current;
              ofBtn.style.cssText =
                "cursor:pointer;white-space:nowrap;font-weight:700;font-size:13px;" +
                "display:inline-flex;align-items:center;gap:6px;padding:5px 11px;" +
                "margin-left:6px;border-radius:9999px;letter-spacing:0.02em;" +
                (on
                  ? "border:1px solid rgba(163,230,53,0.5);background:rgba(163,230,53,0.12);color:rgba(255,255,255,0.92);"
                  : "border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);");
              ofBtn.innerHTML = "";
              const dot = odoc.createElement("span");
              if (loading) {
                // Reuses the cg-liq-spin keyframes registered above.
                dot.style.cssText =
                  "width:9px;height:9px;border-radius:9999px;border:1.5px solid rgba(163,230,53,0.9);" +
                  "border-top-color:transparent;animation:cg-liq-spin 0.8s linear infinite;";
              } else {
                dot.style.cssText = `width:7px;height:7px;border-radius:9999px;background:${
                  on ? "#a3e635" : "rgba(255,255,255,0.28)"
                };`;
              }
              ofBtn.append(dot, odoc.createTextNode(tRef.current("ofBtn")));
            };
            paintOf();
            ofPaintRef.current = paintOf;
            ofBtn.addEventListener("click", () => {
              setOfTipAnchor(null);
              ofToggleRef.current();
            });
            // Hover tooltip lives in the PARENT document (the button is in
            // the TV iframe) — explains what the footprint is and its
            // limits (trades only, merge-on-zoom-out, intraday-oriented).
            ofBtn.addEventListener("mouseenter", () => {
              const iframe = chartContainerRef.current?.querySelector("iframe");
              const ir = iframe?.getBoundingClientRect();
              const cr = chartContainerRef.current?.getBoundingClientRect();
              const br = ofBtn.getBoundingClientRect();
              if (!ir || !cr) return;
              setOfTipAnchor({
                left: ir.left + br.left + br.width / 2 - cr.left,
                top: ir.top + br.bottom + 8 - cr.top,
              });
            });
            ofBtn.addEventListener("mouseleave", () => setOfTipAnchor(null));
          }

          // ── "Strategies" overlay dropdown ─────────────────────────────
          // Paints ONE running strategy's live state on the chart at a time:
          // its exchange position + resting TP/SL/liq when in a trade, or its
          // live-tracked intended entry/stop/target when armed but unfilled.
          // Fed by the Running panel over cg:strategy-overlays; a toggle fires
          // cg:toggle-strategy-overlay (the panel does the drawing).
          // Hidden from the top bar for now (feature WIP, task #126) — flip the
          // flag to bring the dropdown back.
          const SHOW_STRATEGY_OVERLAY_BUTTON: boolean = false;
          const stratBtn = SHOW_STRATEGY_OVERLAY_BUTTON
            ? tvWidget.createButton({
                align: "left",
                useTradingViewStyle: false,
              })
            : null;
          if (stratBtn) {
            const sdoc = stratBtn.ownerDocument;
            let sOverlays: Array<{
              id: string;
              title: string;
              coin: string;
              live: boolean;
              count: number;
              dynamic: boolean;
            }> = [];
            let sActiveId: string | null = null;
            let sMenu: HTMLElement | null = null;

            const paintStrat = () => {
              const on = Boolean(sActiveId);
              stratBtn.style.cssText =
                "cursor:pointer;white-space:nowrap;font-weight:700;font-size:13px;" +
                "display:inline-flex;align-items:center;gap:6px;padding:5px 11px;" +
                "margin-left:6px;border-radius:9999px;letter-spacing:0.02em;" +
                (on
                  ? "border:1px solid rgba(163,230,53,0.5);background:rgba(163,230,53,0.12);color:rgba(255,255,255,0.92);"
                  : "border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);");
              stratBtn.innerHTML = "";
              const dot = sdoc.createElement("span");
              dot.style.cssText = `width:7px;height:7px;border-radius:9999px;background:${
                on ? "#a3e635" : "rgba(255,255,255,0.28)"
              };`;
              stratBtn.append(dot, sdoc.createTextNode(tRef.current("stratOverlayBtn")));
              if (sOverlays.length) {
                const badge = sdoc.createElement("span");
                badge.textContent = String(sOverlays.length);
                badge.style.cssText =
                  "padding:0 6px;border-radius:9999px;background:rgba(255,255,255,0.12);font-size:11px;";
                stratBtn.append(badge);
              }
              const caret = sdoc.createElement("span");
              caret.textContent = "▾";
              caret.style.opacity = "0.5";
              stratBtn.append(caret);
            };

            const closeStratMenu = () => {
              if (sMenu) {
                sMenu.remove();
                sMenu = null;
                window.dispatchEvent(new CustomEvent("cg:tv-popup", { detail: { open: false } }));
              }
            };

            const openStratMenu = () => {
              closeStratMenu();
              const m = sdoc.createElement("div");
              m.style.cssText =
                "position:absolute;z-index:9999;min-width:250px;max-height:60vh;overflow:auto;" +
                "padding:6px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);" +
                "background:#0b0d0e;box-shadow:0 12px 40px rgba(0,0,0,0.6);" +
                "font-family:'DM Sans',sans-serif;color:#e7e5e4;";
              const br = stratBtn.getBoundingClientRect();
              m.style.left = `${Math.max(8, br.left)}px`;
              m.style.top = `${br.bottom + 6}px`;
              if (!sOverlays.length) {
                const empty = sdoc.createElement("div");
                empty.textContent = tRef.current("stratOverlayEmpty");
                empty.style.cssText =
                  "padding:12px 10px;font-size:12px;color:rgba(255,255,255,0.45);";
                m.append(empty);
              } else {
                for (const o of sOverlays) {
                  const isOn = o.id === sActiveId;
                  const row = sdoc.createElement("button");
                  row.style.cssText =
                    "display:flex;align-items:center;gap:8px;width:100%;text-align:left;" +
                    "padding:8px 9px;border-radius:8px;border:none;cursor:pointer;font-size:12.5px;" +
                    `background:${isOn ? "rgba(163,230,53,0.14)" : "transparent"};color:inherit;`;
                  row.addEventListener("mouseenter", () => {
                    if (!isOn) row.style.background = "rgba(255,255,255,0.06)";
                  });
                  row.addEventListener("mouseleave", () => {
                    if (!isOn) row.style.background = "transparent";
                  });
                  const box = sdoc.createElement("span");
                  box.textContent = isOn ? "✓" : "";
                  box.style.cssText =
                    "width:14px;height:14px;flex:none;border-radius:4px;display:inline-flex;" +
                    "align-items:center;justify-content:center;font-size:10px;font-weight:900;color:#0b0d0e;" +
                    `border:1.5px solid ${isOn ? "#a3e635" : "rgba(255,255,255,0.3)"};` +
                    `background:${isOn ? "#a3e635" : "transparent"};`;
                  const txt = sdoc.createElement("span");
                  txt.textContent = o.title;
                  txt.style.cssText =
                    "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
                  const coin = sdoc.createElement("span");
                  coin.textContent = o.coin;
                  coin.style.cssText = "font-weight:700;opacity:0.7;";
                  const chip = sdoc.createElement("span");
                  chip.textContent = o.live
                    ? tRef.current("stratOverlayLive")
                    : o.dynamic
                      ? tRef.current("stratOverlayArmed")
                      : tRef.current("stratOverlayFlat");
                  const col = o.live ? "#a3e635" : o.dynamic ? "#38bdf8" : "rgba(255,255,255,0.4)";
                  chip.style.cssText =
                    "flex:none;font-size:10px;font-weight:700;padding:1px 6px;border-radius:9999px;" +
                    `color:${col};background:rgba(255,255,255,0.07);`;
                  row.append(box, txt, coin, chip);
                  row.addEventListener("click", () => {
                    window.dispatchEvent(
                      new CustomEvent("cg:toggle-strategy-overlay", { detail: { id: o.id } }),
                    );
                    closeStratMenu();
                  });
                  m.append(row);
                }
              }
              sdoc.body.append(m);
              sMenu = m;
              window.dispatchEvent(new CustomEvent("cg:tv-popup", { detail: { open: true } }));
              // Dismiss on the next outside click.
              setTimeout(() => {
                const onDoc = (ev: MouseEvent) => {
                  const target = ev.target as Node;
                  if (sMenu && !sMenu.contains(target) && !stratBtn.contains(target)) {
                    closeStratMenu();
                  } else if (sMenu) {
                    sdoc.addEventListener("mousedown", onDoc, { once: true });
                  }
                };
                sdoc.addEventListener("mousedown", onDoc, { once: true });
              }, 0);
            };

            stratBtn.addEventListener("click", (e: MouseEvent) => {
              e.stopPropagation();
              if (sMenu) closeStratMenu();
              else openStratMenu();
            });

            window.addEventListener("cg:strategy-overlays", (e: Event) => {
              const d = (e as CustomEvent<{
                items?: typeof sOverlays;
                activeId?: string | null;
              }>).detail;
              sOverlays = Array.isArray(d?.items) ? d!.items! : [];
              sActiveId = d?.activeId ?? null;
              // Keep the toolbar clean for users with no running strategies.
              stratBtn.style.display =
                sOverlays.length || sActiveId ? "inline-flex" : "none";
              paintStrat();
              if (sMenu) openStratMenu(); // rebuild an open menu with fresh data
            });

            paintStrat();
            stratBtn.style.display = "none"; // until the first overlay payload
            // The panel mounted before the chart booted — ask it to replay.
            window.dispatchEvent(new CustomEvent("cg:request-strategy-overlays"));
          }
        });

        // TV menus/dialogs live INSIDE the iframe, so no z-index can lift
        // them above our chat overlay — instead the chat hides while one
        // is open (observer → "cg:tv-popup" → floating-chat fades out).
        try {
          const iframe = chartContainerRef.current?.querySelector("iframe");
          const idoc = iframe?.contentDocument;
          if (idoc?.body) {
            let wasOpen = false;
            const check = () => {
              const open = Boolean(
                idoc.querySelector(
                  '[class*="menuWrap-"], [class*="popupDialog-"], [data-name="popup-menu-container"], ' +
                    '[data-name="indicators-dialog"], [data-dialog-name], [class*="dialog-"][class*="rounded-"], .tv-dialog',
                ),
              );
              if (open !== wasOpen) {
                wasOpen = open;
                window.dispatchEvent(
                  new CustomEvent("cg:tv-popup", { detail: { open } }),
                );
              }
            };
            const mo = new MutationObserver(check);
            mo.observe(idoc.body, { childList: true, subtree: true });
          }
        } catch {
          /* cross-origin or teardown race — chat just stays visible */
        }

        registerChartActionHandler(handleChartAction);
        // Multimodal detect: snapshot the live chart (candles + indicators +
        // every drawing, including freehand brush strokes TV exposes no
        // anchors for) as a downscaled JPEG the vision model can actually SEE.
        // Normalize the frame first so a bad zoom can't mislead the model:
        // widen a too-thin view to >= MIN_BARS candles, expand to include any
        // off-screen drawing (capped at ~1 extra viewport per side), and
        // auto-fit the price axis so a manual vertical zoom can't squish or
        // clip the candles. The normalized view STAYS — it doubles as step 1
        // of the detect scan ("go to where the action / lines are").
        registerChartScreenshotProvider(async () => {
          try {
            const chart = tvWidget.activeChart();
            try {
              const vr = chart.getVisibleRange();
              const width = Math.max(vr.to - vr.from, 1);
              const resSec =
                (RESOLUTION_TO_MS[chart.resolution() as string] ?? 0) / 1000;
              let tMin = vr.from;
              let tMax = vr.to;
              for (const sh of chart.getAllShapes()) {
                if (liqShapeIdsRef.current.has(String(sh.id))) continue;
                try {
                  for (const p of chart.getShapeById(sh.id).getPoints()) {
                    if (Number.isFinite(p.time)) {
                      tMin = Math.min(tMin, p.time);
                      tMax = Math.max(tMax, p.time);
                    }
                  }
                } catch {
                  /* freehand tools expose no points */
                }
              }
              // Cap the zoom-out at one extra viewport-width per side — far
              // outliers are covered exactly by the text digest instead.
              tMin = Math.max(tMin, vr.from - width);
              tMax = Math.min(tMax, vr.to + width);
              // Thin view (user zoomed into a handful of candles) starves the
              // vision model of structure. Widen to at least MIN_BARS bars of
              // history — anchored to the current right edge so recent action
              // stays framed. Applied AFTER the drawings cap so it isn't
              // undercut by it; only ever widens, never crops.
              // ~120-180 candles is the sweet spot for judging a setup; below
              // ~80 the framing support/resistance falls off-screen. Floor the
              // view here so a zoomed-in user always gets enough context.
              const MIN_BARS = 140;
              if (resSec > 0 && width / resSec < MIN_BARS) {
                tMin = Math.min(tMin, vr.to - MIN_BARS * resSec);
              }
              // Reframe on Detect — the "go to the action" feedback that
              // guarantees the context (>= MIN_BARS candles) plus right margin
              // to project the setup's target/stop lines. Generous right
              // padding un-jams the latest candle from the price scale.
              // EXCEPT when the user's current view already covers everything
              // the fit would frame: tMin/tMax only ever expand from
              // vr.from/vr.to, so "covered" means neither edge moved (within
              // ~a bar of tolerance). A user deliberately zoomed out past the
              // target keeps their exact view — no zoom, pan, or axis churn.
              const tol = Math.max(resSec, width * 0.01);
              const covered = tMin >= vr.from - tol && tMax <= vr.to + tol;
              if (!covered) {
                const span = tMax - tMin;
                await chart.setVisibleRange({
                  from: tMin - span * 0.08,
                  to: tMax + span * 0.16,
                });
                // Fit the price axis to the candles so a manual vertical zoom
                // can't leave the model reading a squished or half-off-screen
                // band. Autoscale is the healthy default and keeps tracking
                // price afterwards (vector drawings' exact prices are in the
                // JSON context regardless, so a level off the band isn't
                // lost).
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (chart as any)
                    .getPanes()[0]
                    .getMainSourcePriceScale()
                    .setAutoScale(true);
                } catch {
                  /* price-fit best-effort */
                }
              }
            } catch {
              /* fit is best-effort — capture the current view instead */
            }
            // Let TV repaint the re-ranged view before grabbing pixels.
            await new Promise((r) => requestAnimationFrame(() => r(null)));
            const canvas = await tvWidget.takeClientScreenshot();
            const maxW = 1280;
            let out: HTMLCanvasElement = canvas;
            if (canvas.width > maxW) {
              const scale = maxW / canvas.width;
              const c2 = document.createElement("canvas");
              c2.width = maxW;
              c2.height = Math.round(canvas.height * scale);
              c2.getContext("2d")!.drawImage(canvas, 0, 0, c2.width, c2.height);
              out = c2;
            }
            return out.toDataURL("image/jpeg", 0.72);
          } catch {
            return null;
          }
        });
        if (process.env.NODE_ENV === "development") {
          // Debug handle: lets devtools call createStudy and READ its
          // rejection (TV shows only a bare "Runtime error" badge in-UI).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__tvWidget = tvWidget;
        }
        registerChartContextProvider((): ChartContext | null => {
          try {
            const chart = tvWidget.activeChart();
            const indicators = chart
      .getAllStudies()
      .map((s: { id: EntityId; name: string }) => {
              let inputs: Record<string, unknown> | undefined;
              try {
                const vals = chart.getStudyById(s.id).getInputValues();
                inputs = Object.fromEntries(
            vals.map((v: { id: string; value: unknown }) => [v.id, v.value]),
          );
              } catch {
                /* some studies expose no inputs */
              }
              const meta = tierMeta(s.name);
              return {
                id: String(s.id),
                name: s.name,
                inputs,
                tier: meta?.tier,
                indicatorClass: meta?.class,
                weakAlone: meta?.weakAlone,
              };
            });
            // The liq overlay reads as an INDICATOR to the agent/detect, not
            // as 90 user zones — its shapes are excluded from drawings below.
            if (liqOnRef.current) {
              const m = tierMeta("Liquidation Heatmap");
              indicators.push({
                id: "liq-heatmap",
                name: "Liquidation Heatmap",
                inputs: undefined,
                tier: m?.tier,
                indicatorClass: m?.class,
                weakAlone: m?.weakAlone,
              });
            }
            if (ofOnRef.current) {
              const m = tierMeta("Order-flow Footprint");
              indicators.push({
                id: "orderflow-footprint",
                name: "Order-flow Footprint",
                inputs: undefined,
                tier: m?.tier,
                indicatorClass: m?.class,
                weakAlone: m?.weakAlone,
              });
            }
            const drawings = chart
              .getAllShapes()
              .filter((sh: { id: EntityId }) => !liqShapeIdsRef.current.has(String(sh.id)))
              .map((sh: { id: EntityId; name: string }) => {
              let points: Array<{ time: number; price: number }> = [];
              try {
                points = chart
                  .getShapeById(sh.id)
                  .getPoints()
                  .map((p: { time: number; price: number }) => ({ time: p.time, price: p.price }));
              } catch {
                /* brush and some tools do not expose points */
              }
              return {
                id: String(sh.id),
                kind: sh.name,
                points,
                origin: agentShapeIdsRef.current.has(String(sh.id))
                  ? ("agent" as const)
                  : ("user" as const),
              };
            });
            const bars = datafeedRef.current?.recentBars() ?? [];
            const recentCandles = bars.slice(-50).map((b) => ({
              t: Math.floor(b.time / 1000),
              o: b.open,
              h: b.high,
              l: b.low,
              c: b.close,
              // Volume matters: expansion/climax/rejection wicks are the
              // detector's candle-derived confirmation class.
              v: b.volume ?? 0,
            }));
            return {
              symbol: chart.symbol().replace(/^Hyperliquid:/, ""),
              timeframe:
                RESOLUTION_TO_HL[chart.resolution() as string] ??
                (chart.resolution() as string),
              visibleRange: chart.getVisibleRange(),
              indicators,
              drawings,
              lastPrice: recentCandles.length
                ? recentCandles[recentCandles.length - 1].c
                : null,
              recentCandles,
            };
          } catch {
            return null;
          }
        });
        clearTimeout(loadGuard);
        setIsLoading(false);
      });
    } catch (err) {
      console.error("Widget creation error:", err);
      setError(String(err));
      setIsLoading(false);
    }

    return () => {
      clearTimeout(loadGuard);
      isUnmountingRef.current = true;
      isChartReadyRef.current = false;
      registerChartActionHandler(null);
      registerChartContextProvider(null);
      registerChartScreenshotProvider(null);

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      if (trackedTimerRef.current) {
        clearInterval(trackedTimerRef.current);
        trackedTimerRef.current = null;
      }

      if (widgetRef.current) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = widgetRef.current as any;
          if (w._periodicSaveInterval) clearInterval(w._periodicSaveInterval);
          if (w._blurHandler)
            window.removeEventListener("blur", w._blurHandler);
          if (w._beforeUnloadHandler)
            window.removeEventListener("beforeunload", w._beforeUnloadHandler);
          if (w._typeToChatCleanup) w._typeToChatCleanup();
        } catch {
          /* noop */
        }
      }

      try {
        saveChartState();
      } catch {
        /* noop */
      }

      if (datafeedRef.current) {
        datafeedRef.current.destroy();
        datafeedRef.current = null;
      }

      if (widgetRef.current) {
        try {
          widgetRef.current.remove();
        } catch {
          /* noop */
        }
        widgetRef.current = null;
      }

      isUnmountingRef.current = false;
    };
    // NOTE: theme and pair are deliberately NOT dependencies — toggling
    // theme re-themes the live widget, and pair changes swap the symbol on
    // the live widget (effect below) instead of recreating it (which would
    // lose zoom, drawings-in-progress, and take seconds to reload).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolution, isReady, assetsByName]);

  // Pair changes swap the symbol on the LIVE widget. onSymbolChange also
  // routes back here (parent echoes the pair), so a same-symbol no-op
  // guard prevents loops.
  useEffect(() => {
    const w = widgetRef.current;
    if (!w || !isChartReadyRef.current) return;
    try {
      const chart = w.activeChart();
      const current = chart.symbol().replace(/^Hyperliquid:/, "");
      if (current === tvSymbol || current === pair) return;
      chart.setSymbol(tvSymbol);
      // The liq overlay is per-coin — swap it along with the symbol.
      if (liqOnRef.current) void drawLiqRef.current();
    } catch {
      /* widget mid-init; the init effect used the latest pair anyway */
    }
  }, [tvSymbol, pair]);

  useEffect(() => {
    const w = widgetRef.current;
    if (!w || !isChartReadyRef.current) return;
    // Defer one frame so CSS variables settle before TradingView repaints.
    const raf = requestAnimationFrame(() => {
      if (!widgetRef.current || isUnmountingRef.current) return;
      const applyPalette = () => {
        if (!widgetRef.current || isUnmountingRef.current) return;
        try {
          const { overrides, studiesOverrides } = buildOverrides();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          widgetRef.current.applyOverrides(overrides as any);
          widgetRef.current.applyStudiesOverrides(studiesOverrides);
          // Tint the TV chrome (toolbars/sidebar) to the theme background.
          chartContainerRef.current
            ?.querySelector("iframe")
            ?.contentDocument?.documentElement.style.setProperty(
              "--tv-chrome-bg",
              palette.bg,
            );
        } catch {
          /* widget disposed */
        }
      };
      try {
        // changeTheme resolves async and RESETS colors to TV's default
        // palette (blue-gray dark) — our overrides must re-apply AFTER it
        // settles, not alongside it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (widgetRef.current as any).changeTheme?.(
          theme === "light" ? "light" : "dark",
        );
        Promise.resolve(p).then(applyPalette).catch(applyPalette);
      } catch {
        applyPalette();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [theme, buildOverrides]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-400 mb-2">{t("chartLoadFailed")}</div>
          <div className="text-sm text-white/50 font-mono">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col" style={{ background: palette.bg }}>
      {isLoading && (
        <div
          className="absolute inset-0 pointer-events-none overflow-hidden"
          style={{ zIndex: 40, background: palette.bg }}
        >
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, rgba(163,230,53,0.06) 50%, transparent 100%)",
              animation: "tvShimmer 1.5s infinite",
            }}
          />
        </div>
      )}
      <div
        ref={chartContainerRef}
        className={`w-full min-h-0 flex-1 ${isLoading ? "opacity-0" : "opacity-100"}`}
        style={{
          transition: "opacity 0.15s ease-in-out",
          background: palette.bg,
        }}
      />
      {/* Detect lock: while the agent reads the chart, freeze pan/zoom and ring
          the pane with an accent glow so it's clear the agent has taken over.
          The overlay's own (auto) pointer-events swallow mouse + wheel; the
          context + screenshot were captured at detect-start, so locking also
          keeps the scan boxes anchored to what the agent actually saw. */}
      {/* Keep the pane lock (accent glow + pointer/wheel swallow) during a
          detect scan, but WITHOUT the status badge — the "agent detecting"
          message read as clutter. */}
      {detecting && <div className="cg-detect-lock" aria-hidden />}
      {/* Detect scan sequence: lock-on boxes on the user's drawings while
          the detector reads them; a low-opacity green flash on finish.
          (Boxes re-anchor on a short interval; with pan/zoom locked during
          detect they simply stay put.) */}
      {(scanBoxes.length > 0 || scanFlash) && (
        <div
          className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
          aria-hidden
        >
          {scanBoxes.map((b, i) => (
            <div
              key={i}
              className="cg-scan-box"
              style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
            >
              {(b.raw ? Boolean(b.label) : true) && (
                <span className={`cg-scan-tag${b.raw ? "" : " cg-scan-tag--reading"}`}>
                  {b.raw ? b.label : ""}
                </span>
              )}
            </div>
          ))}
          {scanFlash && <div className="cg-scan-flash" />}
        </div>
      )}
      {/* Order-flow footprint: full-cover overlay toggled from its own
          TV-toolbar button. Candles keep their colors until the first cells
          actually arrive — the toolbar button's spinner is the only loading
          signal (an on-chart pill read as clutter). */}
      {showOrderFlow && ofAuthed && (
        <FootprintOverlay
          pair={pair}
          getGeometry={getOverlayGeometry}
          onData={handleOfData}
          getBars={getOverlayBars}
          upColor={palette.candleUp}
          downColor={palette.candleDown}
          onModeChange={handleOfMode}
        />
      )}
      {/* Footprint not yet available for this market (spot / HIP-3): a
          "coming soon" explainer using the shared Dialog chrome. Reuses the
          crystal-glass empty-tray icon from the generated set (bare, no tile). */}
      {ofUnavailable && (
        <Dialog title={t("ofUnavailTitle")} size="sm" onClose={() => setOfUnavailable(false)}>
          <div className="flex flex-col items-center gap-4 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/empty/nothing.webp"
              alt=""
              aria-hidden
              draggable={false}
              className="h-20 w-20 select-none object-contain opacity-90"
            />
            <p className="text-[13px] leading-relaxed text-white/60">
              {t("ofUnavailBody")}
            </p>
            <button
              onClick={() => setOfUnavailable(false)}
              className="w-full cursor-pointer rounded-xl border border-lime-400/40 bg-lime-400/10 px-3 py-2.5 text-[13px] font-semibold text-lime-300 transition hover:bg-lime-400/15"
            >
              {t("ofUnavailGotIt")}
            </button>
          </div>
        </Dialog>
      )}
      {/* Order Flow button hover tooltip — what the footprint shows and
          what it can't (trades only, merge-on-zoom-out, intraday focus). */}
      {ofTipAnchor && (
        <div
          className="pointer-events-none absolute z-40 w-[300px] -translate-x-1/2 rounded-lg border px-3.5 py-3 text-xs leading-relaxed shadow-xl"
          style={{
            left: ofTipAnchor.left,
            top: ofTipAnchor.top,
            background: "rgba(12,14,10,0.96)",
            borderColor: "rgba(163,230,53,0.25)",
            color: "rgba(255,255,255,0.85)",
            backdropFilter: "blur(6px)",
          }}
          role="tooltip"
        >
          <div className="mb-1 font-bold" style={{ color: "#a3e635" }}>
            {t("ofTipTitle")}
          </div>
          <div className="whitespace-pre-line">{t("ofTipBody")}</div>
        </div>
      )}
      {/* Tier-ranked indicator dropdown — React portal anchored to the
          TV-toolbar "Indicators" button (lets us use real tooltips). */}
      <IndicatorMenu
        open={indicatorMenuOpen}
        anchor={indicatorAnchor}
        onClose={() => setIndicatorMenuOpen(false)}
        widget={widgetRef.current}
        liqOn={liqActive}
        liqLoading={liqLoading}
        onToggleLiq={handleToggleLiq}
      />
    </div>
  );
}
