// Client-side indicator math for LIVE-TRACKING dynamic plan levels.
// When a plan's entry/stop/target is derived from an indicator (a Bollinger
// band, a moving average, VWAP…), the drawn chart line must follow that
// indicator each candle — a frozen price snapshot is misleading and, in a
// deployed strategy, simply never fills once price leaves the window.
// These are pure functions over the chart's own OHLCV bars.

export interface OHLCV {
  time: number; // seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export function sma(vals: number[], len: number): number | null {
  if (len <= 0 || vals.length < len) return null;
  let s = 0;
  for (let i = vals.length - len; i < vals.length; i++) s += vals[i];
  return s / len;
}

export function ema(vals: number[], len: number): number | null {
  if (len <= 0 || vals.length < len) return null;
  const k = 2 / (len + 1);
  // Seed with the SMA of the first `len` values, then roll forward.
  let e = 0;
  for (let i = 0; i < len; i++) e += vals[i];
  e /= len;
  for (let i = len; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

function stddev(vals: number[], len: number, mean: number): number | null {
  if (vals.length < len) return null;
  let s = 0;
  for (let i = vals.length - len; i < vals.length; i++) {
    const d = vals[i] - mean;
    s += d * d;
  }
  return Math.sqrt(s / len);
}

export function bollinger(
  closes: number[],
  len: number,
  mult: number,
): { lower: number; middle: number; upper: number } | null {
  const middle = sma(closes, len);
  if (middle === null) return null;
  const sd = stddev(closes, len, middle);
  if (sd === null) return null;
  return { lower: middle - mult * sd, middle, upper: middle + mult * sd };
}

// Rolling (length-window) VWAP from typical price × volume. Falls back to null
// when the feed has no volume, so the caller keeps the static price.
export function rollingVwap(bars: OHLCV[], len: number): number | null {
  if (bars.length < len) return null;
  let pv = 0;
  let vol = 0;
  for (let i = bars.length - len; i < bars.length; i++) {
    const b = bars[i];
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume ?? 0;
    pv += tp * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

export type LevelSourceKind =
  | "fixed"
  | "bb_lower"
  | "bb_middle"
  | "bb_upper"
  | "ema"
  | "sma"
  | "vwap"
  | "trendline";

export interface LevelSource {
  kind: LevelSourceKind;
  length?: number;
  mult?: number;
  /** trendline anchors (unix SECONDS + price) — the level is the line
   *  through them extended right, exactly what the compiled bot trades. */
  anchors?: { t1: number; p1: number; t2: number; p2: number };
}

const DYNAMIC_KINDS = new Set([
  "bb_lower",
  "bb_middle",
  "bb_upper",
  "ema",
  "sma",
  "vwap",
  "trendline",
]);

// Aliases for names the model naturally emits. "basis" is TradingView's own
// label for the Bollinger middle band, so the generator reaches for
// "bb_basis"; "bb_mid" / "ma" / "moving_average" are the other common drifts.
// Without this the string parses to "fixed" and the level never live-tracks.
const SOURCE_ALIASES: Record<string, LevelSourceKind> = {
  bb_basis: "bb_middle",
  bb_mid: "bb_middle",
  bb_basis_line: "bb_middle",
  basis: "bb_middle",
  bb_low: "bb_lower",
  bb_up: "bb_upper",
  moving_average: "sma",
  ma: "sma",
};

// Accepts compact model-emitted strings: "fixed", "bb_lower", "bb_lower:20:2",
// "ema:50", "sma:20", "vwap", "vwap:20", "trendline:t1,p1,t2,p2" (anchor
// unix-seconds + prices). Missing/garbage → fixed (static line).
export function parseLevelSource(s?: string | null): LevelSource {
  if (!s) return { kind: "fixed" };
  const parts = s.trim().toLowerCase().split(/[:,\s]+/).filter(Boolean);
  const head = SOURCE_ALIASES[parts[0]] ?? parts[0];
  if (!head || !DYNAMIC_KINDS.has(head)) return { kind: "fixed" };
  if (head === "trendline") {
    const [t1, p1, t2, p2] = parts.slice(1, 5).map((v) => parseFloat(v));
    // Anchors must be two distinct real points, or the source is useless —
    // degrade to fixed so the chart shows an honest static line instead.
    if (
      [t1, p1, t2, p2].every((v) => Number.isFinite(v)) &&
      t2 !== t1 &&
      p1 > 0 &&
      p2 > 0
    ) {
      return { kind: "trendline", anchors: { t1, p1, t2, p2 } };
    }
    return { kind: "fixed" };
  }
  const length = parts[1] ? parseInt(parts[1], 10) : undefined;
  const mult = parts[2] ? parseFloat(parts[2]) : undefined;
  return {
    kind: head as LevelSourceKind,
    length: Number.isFinite(length) ? length : undefined,
    mult: Number.isFinite(mult) ? mult : undefined,
  };
}

/** Trendline value at time t (unix seconds): the line through the anchors.
 *  This is BY CONSTRUCTION the same line the compiled bot computes. */
export function trendlineValueAt(
  anchors: NonNullable<LevelSource["anchors"]>,
  tSec: number,
): number {
  const slope = (anchors.p2 - anchors.p1) / (anchors.t2 - anchors.t1);
  return anchors.p1 + slope * (tSec - anchors.t1);
}

export function isDynamic(s?: string | null): boolean {
  return parseLevelSource(s).kind !== "fixed";
}

// Current value of the indicator a level tracks, or null (→ keep static price).
// `studyDefaults` lets the caller pass params read from the chart's plotted
// study (e.g. the actual Bollinger length/std the user has on screen).
export function computeLevel(
  bars: OHLCV[],
  src: LevelSource,
  studyDefaults?: { length?: number; mult?: number },
): number | null {
  if (src.kind === "fixed") return null;
  if (src.kind === "trendline") {
    return src.anchors
      ? trendlineValueAt(src.anchors, Math.floor(Date.now() / 1000))
      : null;
  }
  if (!bars.length) return null;
  const closes = bars.map((b) => b.close);
  const len = src.length ?? studyDefaults?.length;
  switch (src.kind) {
    case "sma":
      return sma(closes, len ?? 20);
    case "ema":
      return ema(closes, len ?? 20);
    case "vwap":
      return rollingVwap(bars, len ?? 20);
    case "bb_lower":
    case "bb_middle":
    case "bb_upper": {
      const bb = bollinger(closes, len ?? 20, src.mult ?? studyDefaults?.mult ?? 2);
      if (!bb) return null;
      return src.kind === "bb_lower"
        ? bb.lower
        : src.kind === "bb_upper"
          ? bb.upper
          : bb.middle;
    }
    default:
      return null;
  }
}
