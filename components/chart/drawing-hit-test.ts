/**
 * Pure hit-testing for the preview chart's drawings.
 *
 * Everything works in pane pixel space: the chart converts each drawing's
 * price/time anchors to coordinates, builds one of these geometries, and asks
 * "is this click close enough?". Keeping the math free of chart objects makes
 * it unit-testable and keeps preview-chart.tsx to wiring.
 *
 * `hitDistance` returns the pixel distance when the point is within tolerance
 * (so overlapping drawings can be ranked nearest-first) and null on a miss.
 */

export const HIT_TOLERANCE_PX = 6;

export type HitGeometry =
  /** A finite two-point line (trendline, agent-drawn segment). */
  | { kind: "segment"; x1: number; y1: number; x2: number; y2: number }
  /** A ray from (x1,y1) through (x2,y2), extending past the second anchor. */
  | { kind: "ray"; x1: number; y1: number; x2: number; y2: number }
  /** A full-width horizontal line at y (price line / level). */
  | { kind: "hline"; y: number }
  /** A full-height vertical line at x. */
  | { kind: "vline"; x: number }
  /** A rectangle by opposite corners; inside counts as a hit. */
  | { kind: "rect"; x1: number; y1: number; x2: number; y2: number }
  /** Fib retracement: horizontal level lines spanning xa..xb at each y. */
  | { kind: "fib"; xa: number; xb: number; ys: number[] };

/** Distance from point p to the segment (x1,y1)→(x2,y2). */
export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  // Degenerate segment: both anchors on the same pixel.
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Distance from point p to the ray starting at (x1,y1) through (x2,y2). */
export function distToRay(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  // t is clamped only at the origin end — the ray runs on past the anchor.
  const t = lenSq === 0 ? 0 : Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lenSq);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Distance from the point to the geometry, or null when it is farther than
 * `tolerance`. A point inside a rectangle always hits (the fill is visible and
 * clickable); its reported distance is the distance to the nearest border so a
 * line crossing the rectangle still wins when clicked directly.
 */
export function hitDistance(
  geom: HitGeometry,
  px: number,
  py: number,
  tolerance: number = HIT_TOLERANCE_PX,
): number | null {
  switch (geom.kind) {
    case "segment": {
      const d = distToSegment(px, py, geom.x1, geom.y1, geom.x2, geom.y2);
      return d <= tolerance ? d : null;
    }
    case "ray": {
      const d = distToRay(px, py, geom.x1, geom.y1, geom.x2, geom.y2);
      return d <= tolerance ? d : null;
    }
    case "hline": {
      const d = Math.abs(py - geom.y);
      return d <= tolerance ? d : null;
    }
    case "vline": {
      const d = Math.abs(px - geom.x);
      return d <= tolerance ? d : null;
    }
    case "rect": {
      const xa = Math.min(geom.x1, geom.x2);
      const xb = Math.max(geom.x1, geom.x2);
      const ya = Math.min(geom.y1, geom.y2);
      const yb = Math.max(geom.y1, geom.y2);
      const borders = [
        distToSegment(px, py, xa, ya, xb, ya),
        distToSegment(px, py, xb, ya, xb, yb),
        distToSegment(px, py, xb, yb, xa, yb),
        distToSegment(px, py, xa, yb, xa, ya),
      ];
      const d = Math.min(...borders);
      const inside = px >= xa && px <= xb && py >= ya && py <= yb;
      return inside || d <= tolerance ? d : null;
    }
    case "fib": {
      const xa = Math.min(geom.xa, geom.xb);
      const xb = Math.max(geom.xa, geom.xb);
      let best: number | null = null;
      for (const y of geom.ys) {
        const d = distToSegment(px, py, xa, y, xb, y);
        if (d <= tolerance && (best === null || d < best)) best = d;
      }
      return best;
    }
  }
}

/**
 * Pick the drawing nearest the point among those within tolerance.
 * Returns its index in `geoms`, or null when nothing is close enough.
 */
export function pickNearest(
  geoms: Array<HitGeometry | null>,
  px: number,
  py: number,
  tolerance: number = HIT_TOLERANCE_PX,
): number | null {
  let bestIdx: number | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < geoms.length; i++) {
    const g = geoms[i];
    if (!g) continue;
    const d = hitDistance(g, px, py, tolerance);
    if (d !== null && d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}
