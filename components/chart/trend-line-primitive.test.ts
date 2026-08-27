import { describe, expect, test, vi } from "vitest";
import type {
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import { TrendLinePrimitive } from "./trend-line-primitive";

type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** Chart stub: time 100 → x 10, time 200 → x 50; price p → y (1000 - p) / 10. */
function attachStub(primitive: TrendLinePrimitive) {
  const requestUpdate = vi.fn();
  const param = {
    chart: {
      timeScale: () => ({
        timeToCoordinate: (t: Time) =>
          t === (100 as Time) ? 10 : t === (200 as Time) ? 50 : null,
      }),
    },
    series: {
      priceToCoordinate: (p: number) => (1000 - p) / 10,
    },
    requestUpdate,
  } as unknown as SeriesAttachedParameter<Time>;
  primitive.attached?.(param);
  return requestUpdate;
}

function renderToCalls(primitive: TrendLinePrimitive) {
  primitive.updateAllViews?.();
  const renderer = primitive.paneViews?.()[0]?.renderer();
  const calls: Array<[string, ...number[]]> = [];
  const ctx = {
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (x: number, y: number) => calls.push(["moveTo", x, y]),
    lineTo: (x: number, y: number) => calls.push(["lineTo", x, y]),
    stroke: () => calls.push(["stroke"]),
  };
  const target = {
    useBitmapCoordinateSpace: (
      fn: (scope: {
        context: typeof ctx;
        horizontalPixelRatio: number;
        verticalPixelRatio: number;
      }) => void,
    ) => fn({ context: ctx, horizontalPixelRatio: 2, verticalPixelRatio: 2 }),
  } as unknown as RenderTarget;
  renderer?.draw(target);
  return calls;
}

describe("TrendLinePrimitive", () => {
  test("anchors in price/time and draws in scaled bitmap coordinates", () => {
    const prim = new TrendLinePrimitive(
      { time: 100 as Time, price: 900 },
      { time: 200 as Time, price: 500 },
      "#fbbf24",
    );
    attachStub(prim);
    const calls = renderToCalls(prim);
    // x = timeToCoordinate * ratio, y = priceToCoordinate * ratio.
    expect(calls).toContainEqual(["moveTo", 20, 20]);
    expect(calls).toContainEqual(["lineTo", 100, 100]);
    expect(calls).toContainEqual(["stroke"]);
  });

  test("skips the frame when an anchor is off the loaded range", () => {
    const prim = new TrendLinePrimitive(
      { time: 100 as Time, price: 900 },
      { time: 999 as Time, price: 500 }, // timeToCoordinate → null
      "#fbbf24",
    );
    attachStub(prim);
    const calls = renderToCalls(prim);
    expect(calls).toEqual([]); // no half-drawn line to a wrong place
  });

  test("setPoints moves the anchors and requests a repaint", () => {
    const prim = new TrendLinePrimitive(
      { time: 100 as Time, price: 900 },
      { time: 100 as Time, price: 900 },
      "#fbbf24",
    );
    const requestUpdate = attachStub(prim);
    requestUpdate.mockClear();
    prim.setPoints(
      { time: 100 as Time, price: 900 },
      { time: 200 as Time, price: 500 },
    );
    expect(requestUpdate).toHaveBeenCalledOnce();
    const calls = renderToCalls(prim);
    expect(calls).toContainEqual(["lineTo", 100, 100]);
  });
});
