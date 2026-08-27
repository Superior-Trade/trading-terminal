"use client";

import { useEffect, useRef, useState, useCallback, type ReactElement } from "react";
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
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { TrendLinePrimitive } from "./trend-line-primitive";
import { RectanglePrimitive } from "./rectangle-primitive";
import { VerticalLinePrimitive } from "./vertical-line-primitive";
import { FibRetracementPrimitive } from "./fib-retracement-primitive";
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
 *   - the freehand brush and text notes. The toolbar below covers the rest of
 *     the chat pencil's tool list — trendlines, rays, horizontal levels,
 *     vertical lines, rectangles and fib retracements. A level is a native
 *     price line; everything else is an ISeriesPrimitive, so all of it is
 *     price/time-anchored and survives pan and zoom. Everything you draw
 *     lands in ChartContext.drawings with origin "user" and the TradingView
 *     kind names — the same structure the Advanced Charts path reports — so
 *     the agent reads your sketch either way. The brush would need drag
 *     capture that fights chart panning; it stays Advanced-only.
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
/** User drawings are amber, so yours and the agent's stay tellable apart. */
const USER = "#fbbf24";
const USER_FILL = "rgba(251,191,36,0.12)";

type Candle = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

type UserTool = "trendline" | "ray" | "level" | "vline" | "rect" | "fib";

/** Toolbar tool → the TradingView kind name the drawing reports. */
const KIND: Record<UserTool, string> = {
  trendline: "trend_line",
  ray: "ray",
  level: "horizontal_line",
  vline: "vertical_line",
  rect: "rectangle",
  fib: "fib_retracement",
};

/** select_tool arrives with TradingView selectLineTool names; map the ones
 *  the preview can honour onto toolbar tools. */
const TOOL_FOR_NAME: Record<string, UserTool> = {
  trend_line: "trendline",
  ray: "ray",
  horizontal_line: "level",
  vertical_line: "vline",
  rectangle: "rect",
  fib_retracement: "fib",
};

const HINT: Record<UserTool, string> = {
  trendline: "click two points",
  ray: "click two points",
  level: "click a price",
  vline: "click a bar",
  rect: "click two corners",
  fib: "click two points",
};

type TwoPointPrimitive =
  | TrendLinePrimitive
  | RectanglePrimitive
  | FibRetracementPrimitive;
type PreviewPrimitive = TwoPointPrimitive | VerticalLinePrimitive;

interface Drawing {
  id: string;
  kind: string;
  line?: IPriceLine;
  series?: ISeriesApi<"Line">;
  primitive?: PreviewPrimitive;
  label?: string;
  points: Array<{ time: number; price: number }>;
  /** Who drew it. Absent means the agent; the toolbar sets "user". */
  origin?: "user" | "agent";
}

// ── toolbar icons ──────────────────────────────────────────────────────
// Same visual language as the chat pencil's tool picker, redrawn small.

type IconProps = { className?: string };

function TrendIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className}>
      <path d="M5 19 19 5" />
      <circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className}>
      <path d="M6 18 20 4" />
      <circle cx="6" cy="18" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function HLineIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className}>
      <path d="M3 12h18" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function VLineIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className}>
      <path d="M12 3v18" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RectIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className={className}>
      <rect x="4" y="7" width="16" height="10" rx="1" />
    </svg>
  );
}

function FibIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className={className}>
      <path d="M4 5h16" />
      <path d="M4 10h16" opacity="0.75" />
      <path d="M4 14h16" opacity="0.55" />
      <path d="M4 19h16" opacity="0.4" />
    </svg>
  );
}

const TOOLBAR: Array<{
  tool: UserTool;
  name: string;
  Icon: (p: IconProps) => ReactElement;
}> = [
  { tool: "trendline", name: "Trendline", Icon: TrendIcon },
  { tool: "ray", name: "Ray", Icon: RayIcon },
  { tool: "level", name: "Horizontal level", Icon: HLineIcon },
  { tool: "vline", name: "Vertical line", Icon: VLineIcon },
  { tool: "rect", name: "Rectangle", Icon: RectIcon },
  { tool: "fib", name: "Fib retracement", Icon: FibIcon },
];

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
  const drawings = useRef<Drawing[]>([]);
  const candlesRef = useRef<Candle[]>([]);
  const [tf, setTf] = useState(resolution);
  const [symbol, setSymbol] = useState(pair);
  const [error, setError] = useState<string | null>(null);
  // ── user drawing state ───────────────────────────────────────────────
  // The armed tool stays armed after each drawing (matching the Advanced
  // Charts path's sticky tools) until re-clicked, ESC, or select_tool cursor.
  const [tool, setTool] = useState<UserTool | null>(null);
  const toolRef = useRef<UserTool | null>(null);
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  /** First anchor of an in-progress two-point shape + its live preview primitive. */
  const pendingRef = useRef<{
    start: { time: UTCTimestamp; price: number };
    primitive: TwoPointPrimitive;
  } | null>(null);

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

  const remember = useCallback((d: Drawing) => {
    drawings.current.push(d);
  }, []);

  const unrender = useCallback((d: Drawing) => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    if (d.line && s) s.removePriceLine(d.line);
    if (d.series && chart) chart.removeSeries(d.series);
    if (d.primitive && s) s.detachPrimitive(d.primitive);
  }, []);

  const clearDrawings = useCallback(() => {
    for (const d of drawings.current) unrender(d);
    drawings.current = [];
  }, [unrender]);

  // ── user drawing (the toolbar) ───────────────────────────────────────
  const cancelPending = useCallback(() => {
    const p = pendingRef.current;
    if (p && seriesRef.current) seriesRef.current.detachPrimitive(p.primitive);
    pendingRef.current = null;
  }, []);

  const armTool = useCallback(
    (next: UserTool | null) => {
      cancelPending();
      setTool((cur) => (cur === next ? null : next));
    },
    [cancelPending],
  );

  // Click-to-draw. Subscribed once; reads the armed tool through a ref so the
  // subscription survives re-renders. Points snap to the bar under the cursor,
  // which is also what keeps them expressible to the agent.
  //
  // Clicks are captured at the DOM, not via chart.subscribeClick: the
  // library's click counter swallows the second click of a fast pair (< its
  // 500ms double-click window) whenever it lands 5px or more from the first —
  // neither click nor dblclick fires — so quickly placed second anchors would
  // silently vanish. The DOM listener sees every click; the mousedown-distance
  // guard below keeps a pan that ends on the chart from placing an anchor.
  useEffect(() => {
    const chart = chartRef.current;
    const el = holder.current;
    if (!chart || !el) return;
    const resolveXY = (
      x: number,
      y: number,
    ): { time: UTCTimestamp; price: number } | null => {
      const s = seriesRef.current;
      if (!s) return null;
      const pane = chart.paneSize();
      if (x < 0 || y < 0 || x > pane.width || y > pane.height) return null; // axis areas
      const t = chart.timeScale().coordinateToTime(x);
      const price = s.coordinateToPrice(y);
      if (typeof t !== "number" || price === null) return null;
      return { time: t as UTCTimestamp, price: Number(price) };
    };
    const resolve = (
      param: MouseEventParams,
    ): { time: UTCTimestamp; price: number } | null => {
      const s = seriesRef.current;
      if (!s || !param.point) return null;
      const t = param.time ?? chart.timeScale().coordinateToTime(param.point.x);
      const price = s.coordinateToPrice(param.point.y);
      if (typeof t !== "number" || price === null) return null;
      return { time: t as UTCTimestamp, price: Number(price) };
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent) => {
      const mode = toolRef.current;
      if (!mode) return;
      if (down && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) >= 5)
        return; // that was a pan, not a placement
      const rect = el.getBoundingClientRect();
      const pt = resolveXY(e.clientX - rect.left, e.clientY - rect.top);
      if (!pt) return;
      const s = seriesRef.current;
      if (!s) return;
      const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      if (mode === "level") {
        const l = priceLine(pt.price, USER, "");
        if (l)
          remember({
            id,
            kind: KIND.level,
            line: l,
            points: [{ time: Number(pt.time), price: pt.price }],
            origin: "user",
          });
        return;
      }
      if (mode === "vline") {
        const primitive = new VerticalLinePrimitive(pt.time, USER);
        s.attachPrimitive(primitive);
        remember({
          id,
          kind: KIND.vline,
          primitive,
          points: [{ time: Number(pt.time), price: pt.price }],
          origin: "user",
        });
        return;
      }
      const pending = pendingRef.current;
      if (
        pending &&
        Number(pending.start.time) === Number(pt.time) &&
        pending.start.price === pt.price
      )
        // A double-click in place would otherwise finalize a zero-length shape.
        return;
      if (!pending) {
        // First anchor: attach a preview primitive that follows the cursor.
        const primitive: TwoPointPrimitive =
          mode === "rect"
            ? new RectanglePrimitive(pt, pt, USER, USER_FILL)
            : mode === "fib"
              ? new FibRetracementPrimitive(pt, pt, USER)
              : new TrendLinePrimitive(pt, pt, USER, mode === "ray");
        s.attachPrimitive(primitive);
        pendingRef.current = { start: pt, primitive };
        return;
      }
      pending.primitive.setPoints(pending.start, pt);
      remember({
        id,
        kind: KIND[mode],
        primitive: pending.primitive,
        points: [
          { time: Number(pending.start.time), price: pending.start.price },
          { time: Number(pt.time), price: pt.price },
        ],
        origin: "user",
      });
      pendingRef.current = null;
    };
    const onMove = (param: MouseEventParams) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const pt = resolve(param);
      if (pt) pending.primitive.setPoints(pending.start, pt);
    };
    el.addEventListener("mousedown", onDown);
    el.addEventListener("click", onClick);
    chart.subscribeCrosshairMove(onMove);
    return () => {
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("click", onClick);
      try {
        chart.unsubscribeCrosshairMove(onMove);
      } catch {
        /* chart already disposed by the mount effect's cleanup */
      }
    };
  }, [priceLine, remember]);

  // ESC drops the armed tool (and any half-placed two-point shape).
  useEffect(() => {
    if (!tool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelPending();
        setTool(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, cancelPending]);

  // ── the agent's actions ──────────────────────────────────────────────
  useEffect(() => {
    const handle = (action: ChartAction): ChartActionResult => {
      const id = `${action.action}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const unsupported = (what: string): ChartActionResult => ({
        ok: false,
        error: `${what} is available with TradingView Advanced Charts (npm run setup:charts) or on the hosted terminal at terminal.superior.trade; this build is running the Lightweight Charts preview`,
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
          case "remove_entities": {
            // Grouped drawings (zones, fibs, setups) store companions under
            // `${id}-suffix`; removing the id the agent saw removes the group.
            const doomed = drawings.current.filter((d) =>
              action.ids.some((x) => d.id === x || d.id.startsWith(`${x}-`)),
            );
            for (const d of doomed) unrender(d);
            drawings.current = drawings.current.filter((d) => !doomed.includes(d));
            return { ok: true };
          }

          case "draw_vertical": {
            const s = seriesRef.current;
            if (!s) return { ok: false, error: "chart not ready" };
            // Snap to the nearest bar: timeToCoordinate resolves bar times,
            // not arbitrary timestamps between them.
            const candles = candlesRef.current;
            let t = action.time as UTCTimestamp;
            for (const c of candles) {
              if (Math.abs(Number(c.time) - action.time) < Math.abs(Number(t) - action.time))
                t = c.time;
            }
            const primitive = new VerticalLinePrimitive(t, "#a3e635", action.label);
            s.attachPrimitive(primitive);
            remember({
              id,
              kind: "vertical_line",
              primitive,
              label: action.label,
              points: [{ time: Number(t), price: 0 }],
            });
            return { ok: true, shapeId: id };
          }

          // The chat bar's pencil arms tools through select_tool with
          // TradingView tool names; map the ones the preview can honour.
          case "select_tool": {
            cancelPending();
            if (action.tool === "cursor") {
              setTool(null);
              return { ok: true };
            }
            const mapped = TOOL_FOR_NAME[action.tool];
            if (mapped) {
              setTool(mapped);
              return { ok: true };
            }
            return unsupported(`the ${action.tool} tool`);
          }

          // Honest refusals. Returning ok:true here would let the agent claim
          // it had plotted an indicator that is not on screen.
          case "add_indicators":
          case "remove_indicators":
          case "clear_indicators":
            return unsupported("indicator studies");
          case "draw_text":
            return unsupported("the text tool");
          default:
            return { ok: false, error: "unsupported action" };
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "chart error" };
      }
    };
    registerChartActionHandler(handle);
    return () => registerChartActionHandler(null);
  }, [
    registerChartActionHandler,
    priceLine,
    segment,
    remember,
    clearDrawings,
    unrender,
    cancelPending,
  ]);

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
          .map((d) => ({
            id: d.id,
            kind: d.kind,
            points: d.points,
            // Same structure the Advanced Charts provider reports, so the
            // agent reads a hand-drawn preview trendline exactly like a
            // TradingView one.
            origin: d.origin ?? ("agent" as const),
            label: d.label,
          })),
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
      <div
        ref={holder}
        className="h-full w-full"
        style={tool ? { cursor: "crosshair" } : undefined}
      />
      <div className="absolute left-3 top-3 z-20 flex items-center gap-0.5 rounded-lg border border-white/10 bg-black/60 p-1 backdrop-blur">
        {TOOLBAR.map(({ tool: t, name, Icon }, i) => (
          <span key={t} className="flex items-center gap-0.5">
            {/* lines | shapes */}
            {i === 4 && <span className="mx-0.5 h-4 w-px bg-white/10" />}
            <button
              onClick={() => armTool(t)}
              title={`${name} — ${HINT[t]}`}
              aria-label={name}
              className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                tool === t
                  ? "bg-amber-500/15 text-amber-300"
                  : "text-white/60 hover:bg-white/10 hover:text-white"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
        <span className="mx-0.5 h-4 w-px bg-white/10" />
        <button
          onClick={clearDrawings}
          title="Remove every drawing"
          className="rounded-md px-1.5 py-1 font-mono text-[11px] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          Clear
        </button>
        {tool && (
          <span className="px-1.5 font-mono text-[10px] text-white/35">
            {HINT[tool]} · esc
          </span>
        )}
      </div>
      {error && (
        <div className="pointer-events-none absolute inset-x-0 top-3 mx-auto w-fit rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-1.5 font-mono text-[11px] text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
