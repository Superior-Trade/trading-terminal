import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

/**
 * A two-point line anchored in price/time, drawn as an ISeriesPrimitive so it
 * moves with the chart under pan and zoom instead of sticking to pixels.
 * With `ray` set, the line extends past the second anchor to the pane edge —
 * TradingView's "ray" tool.
 *
 * The primitive pattern here — source primitive, pane view converting
 * price/time to coordinates, renderer drawing in bitmap coordinate space — is
 * adapted from TradingView's lightweight-charts plugin-examples (trend-line),
 * https://github.com/tradingview/lightweight-charts/tree/master/plugin-examples,
 * Apache-2.0. Trimmed to the shapes the preview chart's toolbar needs.
 */

export interface TrendPoint {
  time: Time;
  price: number;
}

type Pixel = { x: number; y: number };
type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** Pushes (x2,y2) along the p1→p2 direction until it hits a pane edge. */
function extendToEdge(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  height: number,
): Pixel {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const tx = dx > 0 ? (width - x1) / dx : dx < 0 ? -x1 / dx : Infinity;
  const ty = dy > 0 ? (height - y1) / dy : dy < 0 ? -y1 / dy : Infinity;
  const t = Math.max(1, Math.min(tx, ty)); // never stop short of the anchor
  return { x: Math.round(x1 + dx * t), y: Math.round(y1 + dy * t) };
}

class TrendLinePaneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _p1: Pixel | null,
    private readonly _p2: Pixel | null,
    private readonly _color: string,
    private readonly _ray: boolean,
  ) {}

  draw(target: RenderTarget): void {
    const p1 = this._p1;
    const p2 = this._p2;
    if (!p1 || !p2) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const x1 = Math.round(p1.x * scope.horizontalPixelRatio);
      const y1 = Math.round(p1.y * scope.verticalPixelRatio);
      let x2 = Math.round(p2.x * scope.horizontalPixelRatio);
      let y2 = Math.round(p2.y * scope.verticalPixelRatio);
      if (this._ray && (x1 !== x2 || y1 !== y2)) {
        const end = extendToEdge(
          x1, y1, x2, y2,
          scope.bitmapSize.width,
          scope.bitmapSize.height,
        );
        x2 = end.x;
        y2 = end.y;
      }
      ctx.beginPath();
      ctx.strokeStyle = this._color;
      ctx.lineWidth = Math.max(1, Math.round(2 * scope.verticalPixelRatio));
      ctx.lineCap = "round";
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    });
  }
}

class TrendLinePaneView implements IPrimitivePaneView {
  private _p1: Pixel | null = null;
  private _p2: Pixel | null = null;

  constructor(private readonly _source: TrendLinePrimitive) {}

  update(): void {
    const attached = this._source.attachedTo;
    if (!attached) {
      this._p1 = null;
      this._p2 = null;
      return;
    }
    const timeScale = attached.chart.timeScale();
    const toPixel = (p: TrendPoint): Pixel | null => {
      // Both converters return null off-range (e.g. an anchor panned out of
      // the loaded data); the renderer then skips the frame rather than
      // drawing a line to a wrong place.
      const x = timeScale.timeToCoordinate(p.time);
      const y = attached.series.priceToCoordinate(p.price);
      return x === null || y === null ? null : { x: Number(x), y: Number(y) };
    };
    this._p1 = toPixel(this._source.p1);
    this._p2 = toPixel(this._source.p2);
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new TrendLinePaneRenderer(
      this._p1,
      this._p2,
      this._source.color,
      this._source.ray,
    );
  }
}

export class TrendLinePrimitive implements ISeriesPrimitive<Time> {
  attachedTo: SeriesAttachedParameter<Time> | null = null;
  private readonly _paneView = new TrendLinePaneView(this);

  constructor(
    public p1: TrendPoint,
    public p2: TrendPoint,
    public readonly color: string,
    public readonly ray = false,
  ) {}

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
