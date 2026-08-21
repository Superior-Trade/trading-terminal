"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  CrosshairMode,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  useChartBridge,
  type ChartAction,
  type ChartActionResult,
  type ChartContext,
} from "../../lib/chart-bridge";
import { RESOLUTION_TO_HL, RESOLUTION_TO_MS } from "./hyperliquid-datafeed";
import { pairToCoin } from "../../lib/hyperliquid-provider";

/**
 * The preview chart: TradingView's Lightweight Charts, which is Apache-2.0 and
 * ships in this repository.
 *
 * It exists so the terminal runs the moment you clone it. Advanced Charts is
 * the real chart and everything is built for it, but TradingView licenses that
 * one to you individually and forbids redistribution, so a fresh clone would
 * otherwise not start until they had approved you.
 *
 * WHAT THIS CANNOT DO, because Lightweight Charts has no concept of them:
 *   - user drawing. There are no drawing tools, so you cannot sketch your read
 *     onto the chart. This is the biggest loss: it is step one of the product.
 *   - indicator studies. No study engine and no indicator UI.
 *   - the order-flow footprint overlay, which is drawn against Advanced
 *     Charts' pane geometry.
 *   - saved chart layouts.
 *
 * What it does do is render the market honestly and take everything the agent
 * draws, so detect, compile, backtest and deploy all work end to end. Levels,
 * zones, trendlines, channels, fibs and verticals are all expressible with
 * price lines and two-point line series.
 */

const BG = "#08090a";
const GRID = "rgba(255,255,255,0.045)";
const UP = "#a3e635";
const DOWN = "#ef4444";

type Candle = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

interface AgentLine {
  id: string;
  kind: string;
  line?: IPriceLine;
  series?: ISeriesApi<"Line">;
  label?: string;
  points: Array<{ time: number; price: number }>;
}

/** Hyperliquid candles, straight from the public info endpoint. */
async function fetchCandles(coin: string, resolution: string): Promise<Candle[]> {
  const interval = RESOLUTION_TO_HL[resolution] ?? "4h";
  const ms = RESOLUTION_TO_MS[resolution] ?? 14_400_000;
  const endTime = Date.now();
  const startTime = endTime - ms * 500;
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin, interval, startTime, endTime },
    }),
  });
  if (!res.ok) throw new Error(`candles ${res.status}`);
  const raw = (await res.json()) as Array<{
    t: number; o: string; h: string; l: string; c: string;
  }>;
  return raw.map((c) => ({
    time: Math.floor(c.t / 1000) as UTCTimestamp,
    open: Number(c.o),
    high: Number(c.h),
    low: Number(c.l),
    close: Number(c.c),
  }));
}

export function PreviewChart({
  pair,
  resolution = "240",
}: {
  pair: string;
  resolution?: string;
  onSymbolChange?: (pair: string) => void;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const drawings = useRef<AgentLine[]>([]);
  const candlesRef = useRef<Candle[]>([]);
  const [tf, setTf] = useState(resolution);
  const [symbol, setSymbol] = useState(pair);
  const [error, setError] = useState<string | null>(null);

  const {
    registerChartActionHandler,
    registerChartContextProvider,
    registerChartScreenshotProvider,
  } = useChartBridge();

  // ── mount ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!holder.current) return;
    const chart = createChart(holder.current, {
      layout: {
        background: { type: ColorType.Solid, color: BG },
        textColor: "#8b8f94",
        attributionLogo: true, // the licence asks for it, and it is fair
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: { borderColor: "rgba(255,255,255,0.1)", timeVisible: true },
      autoSize: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // ── data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const candles = await fetchCandles(pairToCoin(symbol), tf);
        if (cancelled || !seriesRef.current) return;
        candlesRef.current = candles;
        seriesRef.current.setData(candles);
        chartRef.current?.timeScale().fitContent();
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "could not load candles");
      }
    };
    void load();
    // The live socket belongs to the Advanced Charts datafeed; polling is
    // enough for a preview and keeps this component self-contained.
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [symbol, tf]);

  // ── drawing helpers ──────────────────────────────────────────────────
  const priceLine = useCallback(
    (price: number, color: string, label: string, dashed = false) => {
      const s = seriesRef.current;
      if (!s) return null;
      return s.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: label,
      });
    },
    [],
  );

  const segment = useCallback(
    (
      from: { time: number; price: number },
      to: { time: number; price: number },
      color: string,
    ) => {
      const chart = chartRef.current;
      if (!chart) return null;
      const s = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const a = Math.min(from.time, to.time) as UTCTimestamp;
      const b = Math.max(from.time, to.time) as UTCTimestamp;
      s.setData([
        { time: a, value: from.time <= to.time ? from.price : to.price },
        { time: b, value: from.time <= to.time ? to.price : from.price },
      ]);
      return s;
    },
    [],
  );

  const remember = useCallback((d: AgentLine) => {
    drawings.current.push(d);
  }, []);

  const clearDrawings = useCallback(() => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    for (const d of drawings.current) {
      if (d.line && s) s.removePriceLine(d.line);
      if (d.series && chart) chart.removeSeries(d.series);
    }
    drawings.current = [];
  }, []);

  // ── the agent's actions ──────────────────────────────────────────────
  useEffect(() => {
    const handle = (action: ChartAction): ChartActionResult => {
      const id = `${action.action}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const unsupported = (what: string): ChartActionResult => ({
        ok: false,
        error: `${what} needs TradingView Advanced Charts; this build is running the Lightweight Charts preview`,
      });
      try {
        switch (action.action) {
          case "set_timeframe":
            setTf(action.resolution);
            return { ok: true };
          case "set_symbol":
            setSymbol(action.pair);
            return { ok: true };
          case "set_range":
            chartRef.current?.timeScale().setVisibleRange({
              from: action.from as UTCTimestamp,
              to: action.to as UTCTimestamp,
            });
            return { ok: true };

          case "draw_level": {
            const c = action.side === "resistance" ? DOWN : UP;
            const l = priceLine(action.price, c, action.label ?? "level");
            if (!l) return { ok: false, error: "chart not ready" };
            remember({ id, kind: "horizontal_line", line: l, label: action.label,
              points: [{ time: 0, price: action.price }] });
            return { ok: true, shapeId: id };
          }
          case "draw_zone": {
            const top = priceLine(Math.max(action.from.price, action.to.price),
              "rgba(163,230,53,0.8)", `${action.label ?? "zone"} ↑`, true);
            const bot = priceLine(Math.min(action.from.price, action.to.price),
              "rgba(163,230,53,0.8)", `${action.label ?? "zone"} ↓`, true);
            if (!top || !bot) return { ok: false, error: "chart not ready" };
            remember({ id, kind: "rectangle", line: top, points: [action.from, action.to] });
            remember({ id: `${id}-b`, kind: "rectangle", line: bot, points: [] });
            return { ok: true, shapeId: id };
          }
          case "draw_trendline":
          case "draw_channel": {
            const s = segment(action.from, action.to, "#38bdf8");
            if (!s) return { ok: false, error: "chart not ready" };
            remember({ id, kind: "trend_line", series: s, points: [action.from, action.to] });
            if (action.action === "draw_channel") {
              const off = action.offsetPrice - action.from.price;
              const s2 = segment(
                { time: action.from.time, price: action.from.price + off },
                { time: action.to.time, price: action.to.price + off },
                "#38bdf8",
              );
              if (s2) remember({ id: `${id}-p`, kind: "trend_line", series: s2, points: [] });
            }
            return { ok: true, shapeId: id };
          }
          case "draw_fib":
          case "draw_fib_extension": {
            const lo = Math.min(action.from.price, action.to.price);
            const hi = Math.max(action.from.price, action.to.price);
            const span = hi - lo;
            const ratios =
              action.action === "draw_fib"
                ? [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
                : [1.272, 1.618, 2.618];
            for (const r of ratios) {
              const l = priceLine(lo + span * r, "rgba(250,204,21,0.75)", r.toFixed(3), true);
              if (l) remember({ id: `${id}-${r}`, kind: "fib_retracement", line: l, points: [] });
            }
            return { ok: true, shapeId: id };
          }
          case "draw_tracked_setup": {
            const colors = { entry: "#38bdf8", stop: DOWN, target: UP } as const;
            for (const lv of action.levels) {
              const l = priceLine(lv.price, colors[lv.role], lv.label);
              if (l) remember({ id: `${id}-${lv.role}`, kind: "horizontal_line", line: l, points: [] });
            }
            return { ok: true, shapeId: id };
          }
          case "draw_position_marks": {
            const colors: Record<string, string> = {
              entry: "#38bdf8", tp: UP, sl: DOWN, liq: "#f97316", order: "#a1a1aa",
            };
            for (const m of action.marks) {
              const l = priceLine(m.price, colors[m.kind] ?? "#a1a1aa", m.label);
              if (l) remember({ id: `${id}-${m.kind}`, kind: "horizontal_line", line: l, points: [] });
            }
            return { ok: true, shapeId: id };
          }

          case "clear_agent_drawings":
          case "clear_all_drawings":
            clearDrawings();
            return { ok: true };

          // Honest refusals. Returning ok:true here would let the agent claim
          // it had plotted an indicator that is not on screen.
          case "add_indicators":
          case "remove_indicators":
          case "clear_indicators":
            return unsupported("indicator studies");
          case "select_tool":
            return unsupported("drawing tools");
          case "draw_vertical":
          case "draw_text":
            return unsupported(action.action.replace("draw_", "the ") + " tool");
          default:
            return { ok: false, error: "unsupported action" };
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "chart error" };
      }
    };
    registerChartActionHandler(handle);
    return () => registerChartActionHandler(null);
  }, [registerChartActionHandler, priceLine, segment, remember, clearDrawings]);

  // ── what the agent can read ──────────────────────────────────────────
  useEffect(() => {
    const provide = (): ChartContext => {
      const range = chartRef.current?.timeScale().getVisibleRange();
      const candles = candlesRef.current;
      return {
        symbol,
        timeframe: tf,
        visibleRange: range
          ? { from: Number(range.from), to: Number(range.to) }
          : null,
        indicators: [],
        drawings: drawings.current
          .filter((d) => d.points.length > 0)
          .map((d) => ({ id: d.id, kind: d.kind, points: d.points, origin: "agent" as const, label: d.label })),
        lastPrice: candles.length ? candles[candles.length - 1].close : null,
        recentCandles: candles.slice(-120).map((c) => ({
          t: Number(c.time), o: c.open, h: c.high, l: c.low, c: c.close,
        })),
      };
    };
    registerChartContextProvider(provide);
    return () => registerChartContextProvider(null);
  }, [registerChartContextProvider, symbol, tf]);

  // The agent sees the chart as an image too. Lightweight Charts renders to a
  // canvas it owns, and takeScreenshot() hands back a copy of it.
  useEffect(() => {
    const shot = async (): Promise<string | null> => {
      try {
        const canvas = chartRef.current?.takeScreenshot();
        return canvas ? canvas.toDataURL("image/jpeg", 0.7) : null;
      } catch {
        return null;
      }
    };
    registerChartScreenshotProvider(shot);
    return () => registerChartScreenshotProvider(null);
  }, [registerChartScreenshotProvider]);

  useEffect(() => setSymbol(pair), [pair]);

  return (
    <div className="relative h-full w-full">
      <div ref={holder} className="h-full w-full" />
      {error && (
        <div className="pointer-events-none absolute inset-x-0 top-3 mx-auto w-fit rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-1.5 font-mono text-[11px] text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
