import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

/**
 * A freehand brush stroke: an open polyline of price/time anchors, drawn as an
 * ISeriesPrimitive so it moves with the chart under pan and zoom instead of
 * sticking to pixels. One pointerdown→pointerup drag is one stroke.
 *
 * Same source-view-renderer shape as the other preview primitives (adapted
 * from TradingView's lightweight-charts plugin-examples, Apache-2.0), with one
 * twist: brush anchors are sampled at arbitrary cursor positions, so their
 * times fall BETWEEN bars, and `timeToCoordinate` resolves only bar times.
 * The preview's candles are a uniform grid (crypto trades continuously, no
 * session gaps), which makes time↔x affine: resolve ONE anchor's nearest
 * on-grid bar to a coordinate and place every point linearly from it via
 * `barSpacing`. When no anchor's bar is on the loaded range (the stroke panned
 * off old data after a reload) the frame is skipped, like the other
 * primitives.
 */

export interface BrushPoint {
  /** Unix seconds; fractional between bars. */
  time: Time;
  price: number;
}

type Pixel = { x: number; y: number };
type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

import { drawSelectionHandle, strokeSelectionGlow } from "./trend-line-primitive";
import { distToSegment } from "./drawing-hit-test";

// ── stroke sampling / simplification ───────────────────────────────────
// Pointermove fires at 60–120Hz; storing every event would bloat the stroke
// (and the ChartContext the agent reads). Two passes keep it light:
//  1. live, min-distance sampling — a point is kept only when the cursor has
//     moved MIN_SAMPLE_PX from the last kept point;
//  2. on finalize, Ramer–Douglas–Peucker in pixel space — collinear runs
//     collapse to their endpoints within RDP_EPSILON_PX.

export const MIN_SAMPLE_PX = 3;
export const RDP_EPSILON_PX = 1.5;

/**
 * Ramer–Douglas–Peucker over pixel points. Returns the INDICES kept (always
 * including both endpoints, in ascending order) so the caller can filter the
 * parallel time/price array with the same selection.
 */
export function simplifyIndices(
  pts: readonly Pixel[],
  epsilon: number = RDP_EPSILON_PX,
): number[] {
  if (pts.length <= 2) return pts.map((_, i) => i);
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(
        pts[i].x, pts[i].y,
        pts[a].x, pts[a].y,
        pts[b].x, pts[b].y,
      );
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > epsilon) {
      keep[maxIdx] = true;
      stack.push([a, maxIdx], [maxIdx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(i);
  return out;
}

// ── the primitive ──────────────────────────────────────────────────────

class BrushPaneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _pixels: Pixel[] | null,
    private readonly _color: string,
    private readonly _selected: boolean,
  ) {}

  draw(target: RenderTarget): void {
    const pixels = this._pixels;
    if (!pixels || pixels.length < 2) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const pts = pixels.map((p) => ({
        x: Math.round(p.x * scope.horizontalPixelRatio),
        y: Math.round(p.y * scope.verticalPixelRatio),
      }));
      const path = (c: CanvasRenderingContext2D) => {
        c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      };
      if (this._selected) strokeSelectionGlow(scope, this._color, path);
      ctx.beginPath();
      ctx.strokeStyle = this._color;
      ctx.lineWidth = Math.max(
        1,
        Math.round((this._selected ? 3 : 2) * scope.verticalPixelRatio),
      );
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      path(ctx);
      ctx.stroke();
      if (this._selected) {
        drawSelectionHandle(scope, pts[0].x, pts[0].y, this._color);
        drawSelectionHandle(
          scope,
          pts[pts.length - 1].x,
          pts[pts.length - 1].y,
          this._color,
        );
      }
    });
  }
}

class BrushPaneView implements IPrimitivePaneView {
  private _pixels: Pixel[] | null = null;

  constructor(private readonly _source: BrushPrimitive) {}

  update(): void {
    this._pixels = this._source.pixelPoints();
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new BrushPaneRenderer(
      this._pixels,
      this._source.color,
      this._source.selected,
    );
  }
}

export class BrushPrimitive implements ISeriesPrimitive<Time> {
  attachedTo: SeriesAttachedParameter<Time> | null = null;
  selected = false;
  private readonly _paneView = new BrushPaneView(this);

  constructor(
    public points: BrushPoint[],
    public readonly color: string,
    /** Bar interval (seconds) of the timeframe the stroke was drawn on. */
    public readonly intervalSec: number,
  ) {}

  setSelected(selected: boolean): void {
    this.selected = selected;
    this.attachedTo?.requestUpdate();
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.attachedTo = param;
    param.requestUpdate();
  }

  detached(): void {
    this.attachedTo = null;
  }

  /** Appends a sampled point while the drag is live. */
  addPoint(p: BrushPoint): void {
    this.points.push(p);
    this.attachedTo?.requestUpdate();
  }

  /** Replaces the stroke (finalize swaps in the simplified points). */
  setPoints(points: BrushPoint[]): void {
    this.points = points;
    this.attachedTo?.requestUpdate();
  }

  /**
   * The stroke's current pane-pixel polyline, or null when it cannot be
   * resolved (detached, empty, or every anchor's bar off the loaded range).
   * Also the hit-test geometry — preview-chart.tsx calls this so selection
   * uses exactly the pixels the renderer draws.
   */
  pixelPoints(): Pixel[] | null {
    const attached = this.attachedTo;
    const interval = this.intervalSec;
    if (!attached || this.points.length === 0 || interval <= 0) return null;
    const timeScale = attached.chart.timeScale();
    const spacing = timeScale.options().barSpacing;
    // One resolvable on-grid bar anchors the whole stroke; every other point
    // is a linear barSpacing offset from it (uniform bars, see header).
    let ref: { t: number; x: number } | null = null;
    for (const p of this.points) {
      const snapped = Math.round(Number(p.time) / interval) * interval;
      const x = timeScale.timeToCoordinate(snapped as Time);
      if (x !== null) {
        ref = { t: snapped, x: Number(x) };
        break;
      }
    }
    if (!ref) return null; // stroke entirely off the loaded range — skip
    const out: Pixel[] = [];
    for (const p of this.points) {
      const y = attached.series.priceToCoordinate(p.price);
      if (y === null) continue; // price scale not ready for this point
      const x = ref.x + ((Number(p.time) - ref.t) / interval) * spacing;
      out.push({ x, y: Number(y) });
    }
    return out.length > 0 ? out : null;
  }

  updateAllViews(): void {
    this._paneView.update();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }
}
