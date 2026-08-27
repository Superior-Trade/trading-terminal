import { describe, expect, test } from "vitest";
import {
  distToRay,
  distToSegment,
  hitDistance,
  pickNearest,
  type HitGeometry,
} from "./drawing-hit-test";

describe("distToSegment", () => {
  test("perpendicular distance to the middle of a segment", () => {
    expect(distToSegment(50, 10, 0, 0, 100, 0)).toBe(10);
  });

  test("clamps to the endpoints past either end", () => {
    expect(distToSegment(-30, 40, 0, 0, 100, 0)).toBe(50); // 3-4-5 to (0,0)
    expect(distToSegment(130, 40, 0, 0, 100, 0)).toBe(50); // to (100,0)
  });

  test("degenerate segment measures to the point", () => {
    expect(distToSegment(3, 4, 10, 10, 10, 10)).toBeCloseTo(Math.hypot(7, 6));
  });
});

describe("distToRay", () => {
  test("extends past the second anchor", () => {
    // Segment would clamp at (100,0) → distance 50; the ray keeps going.
    expect(distToRay(130, 40, 0, 0, 100, 0)).toBe(40);
  });

  test("still clamps at the origin", () => {
    expect(distToRay(-30, 40, 0, 0, 100, 0)).toBe(50);
  });
});

describe("hitDistance", () => {
  test("segment: hit within tolerance, miss outside", () => {
    const g: HitGeometry = { kind: "segment", x1: 0, y1: 0, x2: 100, y2: 100 };
    expect(hitDistance(g, 52, 48, 6)).toBeCloseTo(Math.SQRT2 * 2);
    expect(hitDistance(g, 60, 40, 6)).toBeNull(); // ~14px off the line
  });

  test("hline hits at any x, misses past tolerance", () => {
    const g: HitGeometry = { kind: "hline", y: 200 };
    expect(hitDistance(g, 5, 204, 6)).toBe(4);
    expect(hitDistance(g, 900, 195, 6)).toBe(5);
    expect(hitDistance(g, 50, 207, 6)).toBeNull();
  });

  test("vline hits at any y", () => {
    const g: HitGeometry = { kind: "vline", x: 300 };
    expect(hitDistance(g, 305, 10, 6)).toBe(5);
    expect(hitDistance(g, 307, 10, 6)).toBeNull();
  });

  test("rect: border, inside, and outside beyond tolerance", () => {
    const g: HitGeometry = { kind: "rect", x1: 10, y1: 10, x2: 110, y2: 60 };
    expect(hitDistance(g, 10, 30, 6)).toBe(0); // on the left border
    expect(hitDistance(g, 60, 35, 6)).toBe(25); // dead centre still hits
    expect(hitDistance(g, 60, 70, 6)).toBeNull(); // 10px below
    // corners handled too (diagonal distance)
    expect(hitDistance(g, 114, 63, 6)).toBe(5);
  });

  test("rect works with unordered corners", () => {
    const g: HitGeometry = { kind: "rect", x1: 110, y1: 60, x2: 10, y2: 10 };
    expect(hitDistance(g, 60, 35, 6)).not.toBeNull();
  });

  test("fib: nearest level within the x span", () => {
    const g: HitGeometry = { kind: "fib", xa: 0, xb: 100, ys: [10, 50, 90] };
    expect(hitDistance(g, 50, 53, 6)).toBe(3);
    expect(hitDistance(g, 50, 70, 6)).toBeNull(); // between levels
    expect(hitDistance(g, 130, 50, 6)).toBeNull(); // past the span (+tol)
  });
});

describe("pickNearest", () => {
  test("ranks overlapping drawings by distance", () => {
    const geoms: Array<HitGeometry | null> = [
      { kind: "hline", y: 105 }, // 5px away
      { kind: "segment", x1: 0, y1: 100, x2: 200, y2: 100 }, // dead on
      null, // un-hit-testable drawing slots stay index-aligned
    ];
    expect(pickNearest(geoms, 100, 100, 6)).toBe(1);
  });

  test("null when nothing is within tolerance", () => {
    expect(pickNearest([{ kind: "hline", y: 0 }], 100, 100, 6)).toBeNull();
  });
});
