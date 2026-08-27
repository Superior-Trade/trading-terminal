import { describe, expect, test } from "vitest";
import type {
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import { VerticalLinePrimitive } from "./vertical-line-primitive";

type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** Chart stub: time 100 → x 10; anything else off-range. */
function attachStub(primitive: VerticalLinePrimitive) {
  const param = {
    chart: {
      timeScale: () => ({
        timeToCoordinate: (t: Time) => (t === (100 as Time) ? 10 : null),
      }),
    },
    series: {},
    requestUpdate: () => {},
  } as unknown as SeriesAttachedParameter<Time>;
  primitive.attached?.(param);
}

function renderToCalls(primitive: VerticalLinePrimitive) {
  primitive.updateAllViews?.();
  const renderer = primitive.paneViews?.()[0]?.renderer();
  const calls: Array<[string, ...Array<number | string>]> = [];
  const ctx = {
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (x: number, y: number) => calls.push(["moveTo", x, y]),
    lineTo: (x: number, y: number) => calls.push(["lineTo", x, y]),
    stroke: () => calls.push(["stroke"]),
    fillText: (text: string, x: number, y: number) =>
      calls.push(["fillText", text, x, y]),
  };
  const target = {
    useBitmapCoordinateSpace: (
      fn: (scope: {
        context: typeof ctx;
        horizontalPixelRatio: number;
        verticalPixelRatio: number;
        bitmapSize: { width: number; height: number };
      }) => void,
    ) =>
      fn({
        context: ctx,
        horizontalPixelRatio: 2,
        verticalPixelRatio: 2,
        bitmapSize: { width: 200, height: 300 },
      }),
  } as unknown as RenderTarget;
  renderer?.draw(target);
  return calls;
}

describe("VerticalLinePrimitive", () => {
  test("draws the full pane height at the bar's scaled x", () => {
    const prim = new VerticalLinePrimitive(100 as Time, "#fbbf24");
    attachStub(prim);
    const calls = renderToCalls(prim);
    expect(calls).toContainEqual(["moveTo", 20, 0]);
    expect(calls).toContainEqual(["lineTo", 20, 300]);
    expect(calls).toContainEqual(["stroke"]);
  });

  test("writes the label beside the line when one is set", () => {
    const prim = new VerticalLinePrimitive(100 as Time, "#a3e635", "CPI");
    attachStub(prim);
    const calls = renderToCalls(prim);
    expect(calls).toContainEqual(["fillText", "CPI", 28, 24]);
  });

  test("skips the frame when the time is off the loaded range", () => {
    const prim = new VerticalLinePrimitive(999 as Time, "#fbbf24");
    attachStub(prim);
    expect(renderToCalls(prim)).toEqual([]);
  });
});
