import { describe, expect, test, vi } from "vitest";
import type {
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import {
  BrushPrimitive,
  simplifyIndices,
  MIN_SAMPLE_PX,
  RDP_EPSILON_PX,
  type BrushPoint,
} from "./brush-primitive";

type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

const INTERVAL = 60; // one bar a minute

/**
 * Chart stub: bars every 60s from t=6000 to t=6300, barSpacing 10, bar t=6000
 * at x=10 (so x = 10 + (t-6000)/60*10 for on-grid times, null off-grid/range);
 * price p → y = (1000 - p) / 10.
 */
function attachStub(primitive: BrushPrimitive) {
  const requestUpdate = vi.fn();
  const param = {
    chart: {
      timeScale: () => ({
        options: () => ({ barSpacing: 10 }),
        timeToCoordinate: (t: Time) => {
          const n = Number(t);
          if (n % INTERVAL !== 0 || n < 6000 || n > 6300) return null;
          return 10 + ((n - 6000) / INTERVAL) * 10;
        },
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

function renderToCalls(primitive: BrushPrimitive) {
  primitive.updateAllViews?.();
  const renderer = primitive.paneViews?.()[0]?.renderer();
  const calls: Array<[string, ...number[]]> = [];
  const ctx = {
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (x: number, y: number) => calls.push(["moveTo", x, y]),
    lineTo: (x: number, y: number) => calls.push(["lineTo", x, y]),
    stroke: () => calls.push(["stroke"]),
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    arc: (x: number, y: number) => calls.push(["arc", x, y]),
    fill: () => calls.push(["fill"]),
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

const pt = (time: number, price: number): BrushPoint =>
  ({ time: time as Time, price });

describe("BrushPrimitive", () => {
  test("renders the polyline in bitmap coordinates, fractional times between bars", () => {
    const prim = new BrushPrimitive(
      [pt(6000, 900), pt(6030, 800), pt(6060, 700)],
      "#fbbf24",
      INTERVAL,
    );
    attachStub(prim);
    const calls = renderToCalls(prim);
    // Media px: (10,10) → (15,20) → (20,30); ratio 2 doubles everything.
    expect(calls).toContainEqual(["moveTo", 20, 20]);
    expect(calls).toContainEqual(["lineTo", 30, 40]);
    expect(calls).toContainEqual(["lineTo", 40, 60]);
    expect(calls.filter(([op]) => op === "stroke")).toHaveLength(1);
  });

  test("anchors past the reference bar still place linearly (drawn into whitespace)", () => {
    // 6330 snaps to 6360 which is off the range, but the FIRST anchor's bar
    // resolves and anchors the affine map for the whole stroke.
    const prim = new BrushPrimitive(
      [pt(6000, 900), pt(6330, 800)],
      "#fbbf24",
      INTERVAL,
    );
    attachStub(prim);
    const calls = renderToCalls(prim);
    expect(calls).toContainEqual(["moveTo", 20, 20]);
    // x = 10 + (330/60)*10 = 65 media → 130 bitmap; price 800 → y 20 → 40.
    expect(calls).toContainEqual(["lineTo", 130, 40]);
  });

  test("skips the frame when every anchor's bar is off the loaded range", () => {
    const prim = new BrushPrimitive(
      [pt(9000, 900), pt(9030, 800)],
      "#fbbf24",
      INTERVAL,
    );
    attachStub(prim);
    expect(renderToCalls(prim)).toEqual([]);
    expect(prim.pixelPoints()).toBeNull();
  });

  test("selected: glow under-stroke plus handles on both stroke ends", () => {
    const prim = new BrushPrimitive(
      [pt(6000, 900), pt(6060, 700)],
      "#fbbf24",
      INTERVAL,
    );
    attachStub(prim);
    prim.setSelected(true);
    const calls = renderToCalls(prim);
    expect(calls.filter(([op]) => op === "stroke").length).toBeGreaterThanOrEqual(2); // glow + line
    const handles = calls.filter(([op]) => op === "arc");
    expect(handles).toEqual([
      ["arc", 20, 20],
      ["arc", 40, 60],
    ]);
  });

  test("addPoint and setPoints request a repaint", () => {
    const prim = new BrushPrimitive([pt(6000, 900)], "#fbbf24", INTERVAL);
    const requestUpdate = attachStub(prim);
    requestUpdate.mockClear();
    prim.addPoint(pt(6030, 800));
    expect(requestUpdate).toHaveBeenCalledOnce();
    prim.setPoints([pt(6000, 900), pt(6060, 700)]);
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    expect(renderToCalls(prim)).toContainEqual(["lineTo", 40, 60]);
  });

  test("pixelPoints doubles as the hit-test polyline", () => {
    const prim = new BrushPrimitive(
      [pt(6000, 900), pt(6030, 800)],
      "#fbbf24",
      INTERVAL,
    );
    attachStub(prim);
    expect(prim.pixelPoints()).toEqual([
      { x: 10, y: 10 },
      { x: 15, y: 20 },
    ]);
  });
});

describe("simplifyIndices (Ramer–Douglas–Peucker)", () => {
  test("collapses collinear runs to their endpoints", () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: i * 5 }));
    expect(simplifyIndices(pts, RDP_EPSILON_PX)).toEqual([0, 10]);
  });

  test("keeps a corner that exceeds epsilon", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 0 },
    ];
    expect(simplifyIndices(pts, RDP_EPSILON_PX)).toEqual([0, 1, 2]);
  });

  test("drops wobble under epsilon, keeps real shape", () => {
    // A line with 1px noise — all noise is under the 1.5px epsilon.
    const noisy = Array.from({ length: 21 }, (_, i) => ({
      x: i * 5,
      y: i % 2, // alternates 0/1
    }));
    expect(simplifyIndices(noisy, RDP_EPSILON_PX)).toEqual([0, 20]);
    // The same wobble at 4px amplitude survives.
    const wavy = noisy.map((p, i) => ({ x: p.x, y: (i % 2) * 4 }));
    expect(simplifyIndices(wavy, RDP_EPSILON_PX).length).toBeGreaterThan(2);
  });

  test("a realistic squiggle stays light: ~100 raw samples → a handful", () => {
    // One smooth sine arch sampled every 3px of x (post min-distance sampling).
    const raw = Array.from({ length: 100 }, (_, i) => ({
      x: i * MIN_SAMPLE_PX,
      y: Math.round(40 * Math.sin((i / 99) * Math.PI)),
    }));
    const kept = simplifyIndices(raw, RDP_EPSILON_PX);
    expect(kept.length).toBeLessThan(raw.length / 4);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(99);
  });

  test("two points or fewer pass through", () => {
    expect(simplifyIndices([], RDP_EPSILON_PX)).toEqual([]);
    expect(simplifyIndices([{ x: 1, y: 1 }], RDP_EPSILON_PX)).toEqual([0]);
    expect(
      simplifyIndices([{ x: 0, y: 0 }, { x: 9, y: 9 }], RDP_EPSILON_PX),
    ).toEqual([0, 1]);
  });
});
