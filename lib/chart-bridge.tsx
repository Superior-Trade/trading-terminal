"use client";

// Bidirectional AI<->chart bridge.
// Read: getChartContext() returns the semantic state of the chart.
// Write: dispatchChartAction() applies agent (or UI) actions to the chart.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

export interface ChartDrawing {
  id: string;
  /** TradingView shape name, e.g. "trend_line", "horizontal_line", "rectangle", "brush" */
  kind: string;
  /** Anchor points in price/time. */
  points: Array<{ time: number; price: number }>;
  origin: "user" | "agent";
  label?: string;
}

export interface ChartIndicator {
  id: string;
  name: string;
  inputs?: Record<string, unknown>;
  /** Quality grade + class from lib/indicator-tiers (set by the provider) so
   * the agent reasons about confluence, not just which indicators are on. */
  tier?: string;
  indicatorClass?: string;
  weakAlone?: boolean;
}

export interface ChartContext {
  symbol: string;
  timeframe: string;
  visibleRange: { from: number; to: number } | null;
  indicators: ChartIndicator[];
  drawings: ChartDrawing[];
  lastPrice: number | null;
  /** Recent OHLC bars (unix seconds) so the agent can read structure. */
  recentCandles?: Array<{ t: number; o: number; h: number; l: number; c: number }>;
}

export type ChartAction =
  | { action: "set_timeframe"; resolution: string }
  | { action: "set_range"; from: number; to: number }
  | { action: "set_symbol"; pair: string }
  | {
      action: "add_indicators";
      indicators: Array<{
        name: string;
        inputs?: Record<string, number | string>;
        forceOverlay?: boolean;
      }>;
    }
  | { action: "remove_indicators"; names: string[] }
  | { action: "clear_indicators" }
  | { action: "select_tool"; tool: string }
  | { action: "draw_level"; price: number; label?: string; side?: "support" | "resistance" }
  | {
      action: "draw_zone";
      from: { time: number; price: number };
      to: { time: number; price: number };
      label?: string;
    }
  | {
      action: "draw_trendline";
      from: { time: number; price: number };
      to: { time: number; price: number };
      label?: string;
    }
  // Fibonacci retracement/extension: anchor from the swing that bounds the leg.
  | {
      action: "draw_fib";
      from: { time: number; price: number };
      to: { time: number; price: number };
      label?: string;
    }
  // Vertical time marker (session open, news/CPI, funding, kill-zone).
  | { action: "draw_vertical"; time: number; label?: string }
  // Parallel channel: two anchors define one rail, offsetPrice sets the
  // parallel rail (at from.time) so the band spans the range.
  | {
      action: "draw_channel";
      from: { time: number; price: number };
      to: { time: number; price: number };
      offsetPrice: number;
      label?: string;
    }
  // Trend-based fib EXTENSION (projected 1.272/1.618/2.618 targets): a
  // 3-anchor tool — move start, move end, and the retrace it projects from.
  | {
      action: "draw_fib_extension";
      from: { time: number; price: number };
      to: { time: number; price: number };
      retrace: { time: number; price: number };
      label?: string;
    }
  // Free-text note anchored at a point (thesis/event annotation).
  | { action: "draw_text"; time: number; price: number; text: string }
  | { action: "clear_agent_drawings" }
  | { action: "clear_all_drawings" }
  | { action: "remove_entities"; ids: string[] }
  // A trade plan's entry/stop/target as one replaceable group. Levels whose
  // `source` names an indicator (e.g. "bb_lower", "ema:50") LIVE-TRACK that
  // indicator each candle — the drawn line follows the real trigger instead
  // of freezing at a snapshot price. `source` absent/"fixed" → static line.
  | {
      action: "draw_tracked_setup";
      levels: Array<{
        role: "entry" | "stop" | "target";
        price: number;
        label: string;
        source?: string | null;
      }>;
    }
  // Exchange-style position overlay: entry/TP/SL/liq/order lines drawn as
  // one replaceable group (each call clears the previous group).
  | {
      action: "draw_position_marks";
      marks: Array<{
        price: number;
        label: string;
        kind: "entry" | "tp" | "sl" | "liq" | "order";
      }>;
    };

// Truthful outcome of an action. Draw actions used to return a hardcoded
// {ok:true} regardless of whether the TradingView shape actually rendered
// (a throw inside the handler was swallowed to console). That let the agent
// report "I drew the fib" on a draw that never appeared, and left the
// persisted tool-call output (in messages.partsJson) lying about what
// happened. Handlers now return the real result so both the model and the
// audit trail see ground truth.
export interface ChartActionResult {
  ok: boolean;
  /** TradingView entity id of the shape/line created, when applicable. */
  shapeId?: string;
  /** Failure reason, surfaced to the agent so it doesn't claim success. */
  error?: string;
}

type ChartActionHandler = (
  action: ChartAction,
) => Promise<ChartActionResult | void> | ChartActionResult | void;
type ChartContextProvider = () => ChartContext | null;
/** Returns a downscaled JPEG data-URL of the live chart, or null. */
type ChartScreenshotProvider = () => Promise<string | null>;

interface ChartBridgeContextType {
  registerChartActionHandler: (handler: ChartActionHandler | null) => void;
  dispatchChartAction: (action: ChartAction) => Promise<ChartActionResult>;
  registerChartContextProvider: (provider: ChartContextProvider | null) => void;
  getChartContext: () => ChartContext | null;
  registerChartScreenshotProvider: (provider: ChartScreenshotProvider | null) => void;
  getChartScreenshot: () => Promise<string | null>;
}

const ChartBridgeContext = createContext<ChartBridgeContextType | null>(null);

export function useChartBridge(): ChartBridgeContextType {
  const ctx = useContext(ChartBridgeContext);
  if (!ctx)
    throw new Error("useChartBridge must be used within ChartBridgeProvider");
  return ctx;
}

export function ChartBridgeProvider({ children }: { children: ReactNode }) {
  const handlerRef = useRef<ChartActionHandler | null>(null);
  const providerRef = useRef<ChartContextProvider | null>(null);

  const registerChartActionHandler = useCallback(
    (handler: ChartActionHandler | null) => {
      handlerRef.current = handler;
    },
    [],
  );

  const dispatchChartAction = useCallback(
    async (action: ChartAction): Promise<ChartActionResult> => {
      if (!handlerRef.current) {
        console.warn("No chart action handler registered", action);
        return { ok: false, error: "chart is not mounted" };
      }
      return (await handlerRef.current(action)) ?? { ok: true };
    },
    [],
  );

  const registerChartContextProvider = useCallback(
    (provider: ChartContextProvider | null) => {
      providerRef.current = provider;
    },
    [],
  );

  const getChartContext = useCallback((): ChartContext | null => {
    return providerRef.current?.() ?? null;
  }, []);

  const screenshotRef = useRef<ChartScreenshotProvider | null>(null);
  const registerChartScreenshotProvider = useCallback(
    (provider: ChartScreenshotProvider | null) => {
      screenshotRef.current = provider;
    },
    [],
  );
  const getChartScreenshot = useCallback(async (): Promise<string | null> => {
    try {
      return (await screenshotRef.current?.()) ?? null;
    } catch {
      return null;
    }
  }, []);

  // Dev escape hatch (mirrors window.__tvWidget): drive the bridge from the
  // console or a headless test — window.__chartBridge.getChartContext(),
  // .dispatchChartAction({ action: "set_symbol", pair: "ETH-USD" }), …
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__chartBridge = { dispatchChartAction, getChartContext };
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__chartBridge;
    };
  }, [dispatchChartAction, getChartContext]);

  return (
    <ChartBridgeContext.Provider
      value={{
        registerChartActionHandler,
        dispatchChartAction,
        registerChartContextProvider,
        getChartContext,
        registerChartScreenshotProvider,
        getChartScreenshot,
      }}
    >
      {children}
    </ChartBridgeContext.Provider>
  );
}
