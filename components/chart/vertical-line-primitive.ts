import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

/**
 * A full-height vertical line anchored to a bar time — session opens, news
 * prints, "the move started here". One anchor, so one click places it.
 *
 * Same primitive pattern as the trendline (adapted from TradingView's
 * lightweight-charts plugin-examples, Apache-2.0): pane view converts the
 * time to a coordinate, renderer draws top-to-bottom in bitmap space.
 */

type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

class VerticalLinePaneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _x: number | null,
    private readonly _color: string,
    private readonly _label?: string,
  ) {}

  draw(target: RenderTarget): void {
    const xMedia = this._x;
    if (xMedia === null) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const x = Math.round(xMedia * scope.horizontalPixelRatio);
      ctx.beginPath();
      ctx.strokeStyle = this._color;
      ctx.lineWidth = Math.max(1, Math.round(scope.verticalPixelRatio));
      ctx.moveTo(x, 0);
      ctx.lineTo(x, scope.bitmapSize.height);
      ctx.stroke();
      if (this._label) {
        ctx.fillStyle = this._color;
        ctx.font = `${Math.round(10 * scope.verticalPixelRatio)}px monospace`;
        ctx.fillText(
          this._label,
          x + Math.round(4 * scope.horizontalPixelRatio),
          Math.round(12 * scope.verticalPixelRatio),
        );
      }
    });
  }
}

class VerticalLinePaneView implements IPrimitivePaneView {
  private _x: number | null = null;

  constructor(private readonly _source: VerticalLinePrimitive) {}

  update(): void {
    const attached = this._source.attachedTo;
    if (!attached) {
      this._x = null;
      return;
    }
    // null off the loaded range — the renderer then skips the frame.
    const x = attached.chart.timeScale().timeToCoordinate(this._source.time);
    this._x = x === null ? null : Number(x);
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new VerticalLinePaneRenderer(
      this._x,
      this._source.color,
      this._source.label,
    );
  }
}

export class VerticalLinePrimitive implements ISeriesPrimitive<Time> {
  attachedTo: SeriesAttachedParameter<Time> | null = null;
  private readonly _paneView = new VerticalLinePaneView(this);

  constructor(
    public readonly time: Time,
    public readonly color: string,
    public readonly label?: string,
  ) {}

  attached(param: SeriesAttachedParameter<Time>): void {
    this.attachedTo = param;
    param.requestUpdate();
  }

  detached(): void {
    this.attachedTo = null;
  }

  updateAllViews(): void {
    this._paneView.update();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }
}
