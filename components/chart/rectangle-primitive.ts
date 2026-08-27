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
  type TrendPoint,
} from "./trend-line-primitive";

/**
 * A rectangle anchored by two opposite corners in price/time, so it stays on
 * the bars it was drawn over through pan and zoom. Translucent fill, hairline
 * border.
 *
 * Ported from TradingView's lightweight-charts plugin-examples (rectangle),
 * https://github.com/tradingview/lightweight-charts/tree/master/plugin-examples,
 * Apache-2.0 — same source the trendline primitive came from, trimmed the
 * same way (no drag handles, no axis views; the toolbar draws with clicks).
 */

type Pixel = { x: number; y: number };
type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

class RectanglePaneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _p1: Pixel | null,
    private readonly _p2: Pixel | null,
    private readonly _color: string,
    private readonly _fillColor: string,
    private readonly _selected: boolean,
  ) {}

  draw(target: RenderTarget): void {
    const p1 = this._p1;
    const p2 = this._p2;
    if (!p1 || !p2) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const x1 = Math.round(p1.x * scope.horizontalPixelRatio);
      const y1 = Math.round(p1.y * scope.verticalPixelRatio);
      const x2 = Math.round(p2.x * scope.horizontalPixelRatio);
      const y2 = Math.round(p2.y * scope.verticalPixelRatio);
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      ctx.fillStyle = this._fillColor;
      ctx.fillRect(x, y, w, h);
      if (this._selected)
        strokeSelectionGlow(scope, this._color, (c) => c.rect(x, y, w, h));
      ctx.strokeStyle = this._color;
      ctx.lineWidth = Math.max(
        1,
        Math.round((this._selected ? 2 : 1) * scope.verticalPixelRatio),
      );
      ctx.strokeRect(x, y, w, h);
      if (this._selected) {
        drawSelectionHandle(scope, x1, y1, this._color);
        drawSelectionHandle(scope, x2, y2, this._color);
      }
    });
  }
}

class RectanglePaneView implements IPrimitivePaneView {
  private _p1: Pixel | null = null;
  private _p2: Pixel | null = null;

  constructor(private readonly _source: RectanglePrimitive) {}

  update(): void {
    const attached = this._source.attachedTo;
    if (!attached) {
      this._p1 = null;
      this._p2 = null;
      return;
    }
    const timeScale = attached.chart.timeScale();
    const toPixel = (p: TrendPoint): Pixel | null => {
      const x = timeScale.timeToCoordinate(p.time);
      const y = attached.series.priceToCoordinate(p.price);
      return x === null || y === null ? null : { x: Number(x), y: Number(y) };
    };
    this._p1 = toPixel(this._source.p1);
    this._p2 = toPixel(this._source.p2);
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new RectanglePaneRenderer(
      this._p1,
      this._p2,
      this._source.color,
      this._source.fillColor,
      this._source.selected,
    );
  }
}

export class RectanglePrimitive implements ISeriesPrimitive<Time> {
  attachedTo: SeriesAttachedParameter<Time> | null = null;
  selected = false;
  private readonly _paneView = new RectanglePaneView(this);

  constructor(
    public p1: TrendPoint,
    public p2: TrendPoint,
    public readonly color: string,
    public readonly fillColor: string,
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

  /** Moves the corners (used live while the second corner follows the cursor). */
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
