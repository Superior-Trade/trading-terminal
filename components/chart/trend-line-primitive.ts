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
 *
 * The primitive pattern here — source primitive, pane view converting
 * price/time to coordinates, renderer drawing in bitmap coordinate space — is
 * adapted from TradingView's lightweight-charts plugin-examples (trend-line),
 * https://github.com/tradingview/lightweight-charts/tree/master/plugin-examples,
 * Apache-2.0. Trimmed to the one shape the preview chart's toolbar needs.
 */

export interface TrendPoint {
  time: Time;
  price: number;
}

type Pixel = { x: number; y: number };
type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

class TrendLinePaneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _p1: Pixel | null,
    private readonly _p2: Pixel | null,
    private readonly _color: string,
  ) {}

  draw(target: RenderTarget): void {
    const p1 = this._p1;
    const p2 = this._p2;
    if (!p1 || !p2) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      ctx.beginPath();
      ctx.strokeStyle = this._color;
      ctx.lineWidth = Math.max(1, Math.round(2 * scope.verticalPixelRatio));
      ctx.lineCap = "round";
      ctx.moveTo(
        Math.round(p1.x * scope.horizontalPixelRatio),
        Math.round(p1.y * scope.verticalPixelRatio),
      );
      ctx.lineTo(
        Math.round(p2.x * scope.horizontalPixelRatio),
        Math.round(p2.y * scope.verticalPixelRatio),
      );
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
    return new TrendLinePaneRenderer(this._p1, this._p2, this._source.color);
  }
}

export class TrendLinePrimitive implements ISeriesPrimitive<Time> {
  attachedTo: SeriesAttachedParameter<Time> | null = null;
  private readonly _paneView = new TrendLinePaneView(this);

  constructor(
    public p1: TrendPoint,
    public p2: TrendPoint,
    public readonly color: string,
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
