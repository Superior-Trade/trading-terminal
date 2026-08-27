import { describe, expect, test, vi } from "vitest";
import type {
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import { RectanglePrimitive } from "./rectangle-primitive";

type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** Chart stub: time 100 → x 10, time 200 → x 50; price p → y (1000 - p) / 10. */
function attachStub(primitive: RectanglePrimitive) {
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

function renderToCalls(primitive: RectanglePrimitive) {
  primitive.updateAllViews?.();
  const renderer = primitive.paneViews?.()[0]?.renderer();
  const calls: Array<[string, ...number[]]> = [];
  const ctx = {
    fillRect: (x: number, y: number, w: number, h: number) =>
      calls.push(["fillRect", x, y, w, h]),
    strokeRect: (x: number, y: number, w: number, h: number) =>
      calls.push(["strokeRect", x, y, w, h]),
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

describe("RectanglePrimitive", () => {
  test("fills and strokes the corner-anchored box in bitmap coordinates", () => {
    const prim = new RectanglePrimitive(
      { time: 100 as Time, price: 900 },
      { time: 200 as Time, price: 500 },
      "#fbbf24",
      "rgba(251,191,36,0.12)",
    );
    attachStub(prim);
    const calls = renderToCalls(prim);
    // Corners (10,10)/(50,50) media → (20,20) with 80×80 sides at ratio 2.
    expect(calls).toContainEqual(["fillRect", 20, 20, 80, 80]);
    expect(calls).toContainEqual(["strokeRect", 20, 20, 80, 80]);
  });

  test("normalizes corners given in any order", () => {
    const prim = new RectanglePrimitive(
      { time: 200 as Time, price: 500 },
      { time: 100 as Time, price: 900 },
      "#fbbf24",
      "rgba(251,191,36,0.12)",
    );
    attachStub(prim);
    expect(renderToCalls(prim)).toContainEqual(["fillRect", 20, 20, 80, 80]);
  });

  test("skips the frame when a corner is off the loaded range", () => {
    const prim = new RectanglePrimitive(
      { time: 100 as Time, price: 900 },
      { time: 999 as Time, price: 500 }, // timeToCoordinate → null
      "#fbbf24",
      "rgba(251,191,36,0.12)",
    );
    attachStub(prim);
    expect(renderToCalls(prim)).toEqual([]);
  });

  test("setPoints moves the corners and requests a repaint", () => {
    const prim = new RectanglePrimitive(
      { time: 100 as Time, price: 900 },
      { time: 100 as Time, price: 900 },
      "#fbbf24",
      "rgba(251,191,36,0.12)",
    );
    const requestUpdate = attachStub(prim);
    requestUpdate.mockClear();
    prim.setPoints(
      { time: 100 as Time, price: 900 },
      { time: 200 as Time, price: 500 },
    );
    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(renderToCalls(prim)).toContainEqual(["strokeRect", 20, 20, 80, 80]);
  });
});
