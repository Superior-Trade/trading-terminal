import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import {
  drawSelectionHandle,
  strokeSelectionGlow,
  timeToXWithWhitespace,
  type TrendPoint,
} from "./trend-line-primitive";

/**
 * A Fibonacci retracement: two anchors bound a leg, and horizontal levels are
 * drawn between the anchor times at the standard ratios. 0 sits on the second
 * anchor (the end of the move) and 1 on the first, matching TradingView, so
 * the same two clicks read the same way on either chart.
 *
 * Built on the trendline primitive pattern (adapted from TradingView's
 * lightweight-charts plugin-examples, Apache-2.0): the pane view converts the
 * anchors to coordinates, the renderer draws every level in bitmap space.
 */

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

type Level = { y: number; ratio: number };
type Pixel = { x: number; y: number };
type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

class FibRetracementPaneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _x1: number | null,
    private readonly _x2: number | null,
    private readonly _levels: Level[],
    private readonly _color: string,
    private readonly _anchors: [Pixel, Pixel] | null,
    private readonly _selected: boolean,
  ) {}

  draw(target: RenderTarget): void {
    const x1m = this._x1;
    const x2m = this._x2;
    if (x1m === null || x2m === null || this._levels.length === 0) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const xa = Math.round(Math.min(x1m, x2m) * scope.horizontalPixelRatio);
      const xb = Math.round(Math.max(x1m, x2m) * scope.horizontalPixelRatio);
      ctx.strokeStyle = this._color;
      ctx.fillStyle = this._color;
      ctx.lineWidth = Math.max(
        1,
        Math.round((this._selected ? 2 : 1) * scope.verticalPixelRatio),
      );
      ctx.font = `${Math.round(10 * scope.verticalPixelRatio)}px monospace`;
      for (const lvl of this._levels) {
        const y = Math.round(lvl.y * scope.verticalPixelRatio);
        if (this._selected)
          strokeSelectionGlow(scope, this._color, (c) => {
            c.moveTo(xa, y);
            c.lineTo(xb, y);
          });
        ctx.beginPath();
        ctx.moveTo(xa, y);
        ctx.lineTo(xb, y);
        ctx.stroke();
        ctx.fillText(
          lvl.ratio.toFixed(3),
          xa,
          y - Math.round(3 * scope.verticalPixelRatio),
        );
      }
      if (this._selected && this._anchors) {
        for (const a of this._anchors)
          drawSelectionHandle(
            scope,
            Math.round(a.x * scope.horizontalPixelRatio),
            Math.round(a.y * scope.verticalPixelRatio),
            this._color,
          );
      }
    });
  }
}

class FibRetracementPaneView implements IPrimitivePaneView {
  private _x1: number | null = null;
  private _x2: number | null = null;
  private _levels: Level[] = [];
  private _anchors: [Pixel, Pixel] | null = null;

  constructor(private readonly _source: FibRetracementPrimitive) {}

  update(): void {
    this._x1 = null;
    this._x2 = null;
    this._levels = [];
    this._anchors = null;
    const attached = this._source.attachedTo;
    if (!attached) return;
    const { p1, p2 } = this._source;
    const x1 = timeToXWithWhitespace(attached, p1.time);
    const x2 = timeToXWithWhitespace(attached, p2.time);
    // Either anchor unresolvable → skip the frame, same rule as the
    // trendline: no levels drawn to a wrong place.
    if (x1 === null || x2 === null) return;
    this._x1 = x1;
    this._x2 = x2;
    for (const ratio of this._source.ratios) {
      const price = p2.price + (p1.price - p2.price) * ratio;
      const y = attached.series.priceToCoordinate(price);
      if (y !== null) this._levels.push({ y: Number(y), ratio });
    }
    const y1 = attached.series.priceToCoordinate(p1.price);
    const y2 = attached.series.priceToCoordinate(p2.price);
    if (y1 !== null && y2 !== null)
      this._anchors = [
        { x: Number(x1), y: Number(y1) },
        { x: Number(x2), y: Number(y2) },
      ];
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new FibRetracementPaneRenderer(
      this._x1,
      this._x2,
      this._levels,
      this._source.color,
      this._anchors,
      this._source.selected,
    );
  }
}

export class FibRetracementPrimitive implements ISeriesPrimitive<Time> {
  attachedTo: SeriesAttachedParameter<Time> | null = null;
  selected = false;
  private readonly _paneView = new FibRetracementPaneView(this);

  constructor(
    public p1: TrendPoint,
    public p2: TrendPoint,
    public readonly color: string,
    public readonly ratios: readonly number[] = FIB_RATIOS,
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

  /** Moves the anchors (used live while the second point follows the cursor). */
  setPoints(p1: TrendPoint, p2: TrendPoint): void {
    this.p1 = p1;
    this.p2 = p2;
    this.attachedTo?.requestUpdate();
  }

  updateAllViews(): void {
    this._paneView.update();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }
}
