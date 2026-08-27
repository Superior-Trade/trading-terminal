import { describe, expect, test, vi } from "vitest";
import type {
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import { FIB_RATIOS, FibRetracementPrimitive } from "./fib-retracement-primitive";

type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** Chart stub: time 100 → x 10, time 200 → x 50; price p → y (1000 - p) / 10. */
function attachStub(primitive: FibRetracementPrimitive) {
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

function renderToCalls(primitive: FibRetracementPrimitive) {
  primitive.updateAllViews?.();
  const renderer = primitive.paneViews?.()[0]?.renderer();
  const calls: Array<[string, ...Array<number | string>]> = [];
  const ctx = {
    beginPath: () => {},
    moveTo: (x: number, y: number) => calls.push(["moveTo", x, y]),
    lineTo: (x: number, y: number) => calls.push(["lineTo", x, y]),
    stroke: () => {},
    fillText: (text: string, x: number, y: number) =>
      calls.push(["fillText", text, x, y]),
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

describe("FibRetracementPrimitive", () => {
  // Leg: 900 (first anchor, ratio 1) → 500 (second anchor, ratio 0).
  const p1 = { time: 100 as Time, price: 900 };
  const p2 = { time: 200 as Time, price: 500 };

  test("draws every standard ratio between the anchor times", () => {
    const prim = new FibRetracementPrimitive(p1, p2, "#fbbf24");
    attachStub(prim);
    const calls = renderToCalls(prim);
    // price(r) = 500 + 400r → y = 2·(50 − 40r). Anchors span x 20→100.
    expect(calls).toContainEqual(["moveTo", 20, 100]); // 0 at the leg's end
    expect(calls).toContainEqual(["lineTo", 100, 100]);
    expect(calls).toContainEqual(["moveTo", 20, 60]); // 0.5 midway
    expect(calls).toContainEqual(["moveTo", 20, 20]); // 1 back at the start
    const lines = calls.filter(([op]) => op === "moveTo");
    expect(lines).toHaveLength(FIB_RATIOS.length);
  });

  test("labels each level with its ratio", () => {
    const prim = new FibRetracementPrimitive(p1, p2, "#fbbf24");
    attachStub(prim);
    const calls = renderToCalls(prim);
    expect(calls).toContainEqual(["fillText", "0.000", 20, 94]);
    expect(calls).toContainEqual(["fillText", "0.618", 20, expect.any(Number)]);
  });

  test("skips the frame when an anchor is off the loaded range", () => {
    const prim = new FibRetracementPrimitive(
      p1,
      { time: 999 as Time, price: 500 }, // timeToCoordinate → null
      "#fbbf24",
    );
    attachStub(prim);
    expect(renderToCalls(prim)).toEqual([]);
  });

  test("setPoints moves the anchors and requests a repaint", () => {
    const prim = new FibRetracementPrimitive(p1, p1, "#fbbf24");
    const requestUpdate = attachStub(prim);
    requestUpdate.mockClear();
    prim.setPoints(p1, p2);
    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(renderToCalls(prim)).toContainEqual(["moveTo", 20, 100]);
  });
});
