/** Chart change-tracking for the agent.
 *
 *  The agent reasons across turns while the user freely edits the chart —
 *  without an explicit delta it keeps reasoning about drawings that no
 *  longer exist (a failure we shipped once: the agent stayed anchored to an
 *  old plan's trendline after the user deleted it). The client snapshots the
 *  chart at every send; the diff versus the agent's LAST-SEEN snapshot rides
 *  the request as plain sentences the model cannot miss, and trendline-
 *  sourced plan levels are cross-checked against the live drawings so a
 *  stale plan is flagged deterministically, not left to model vigilance.
 *
 *  Pure module — used by the client (snapshot + diff) and the chat route
 *  (stale-plan warnings). TV shape ids are stable across edits, so identity
 *  is by id and geometry changes are signature mismatches on the same id.
 */

interface CtxPoint {
  time?: number;
  price?: number;
}
interface CtxDrawing {
  id?: string;
  kind?: string;
  origin?: string;
  points?: CtxPoint[];
}
interface CtxIndicator {
  name?: string;
}
interface CtxLike {
  symbol?: string | null;
  timeframe?: string | null;
  drawings?: CtxDrawing[];
  indicators?: CtxIndicator[];
}

export interface DrawingSnap {
  id: string;
  kind: string;
  sig: string;
  desc: string;
}

export interface ChartSnapshot {
  symbol: string | null;
  timeframe: string | null;
  /** USER drawings only — the agent already knows about its own marks
   *  (they move through its tools), so agent-origin deltas are noise. */
  drawings: DrawingSnap[];
  indicators: string[];
}

const fmtPrice = (p: number) =>
  Math.abs(p) >= 1000 ? p.toFixed(0) : Math.abs(p) >= 1 ? p.toFixed(2) : p.toPrecision(4);

function describeDrawing(d: CtxDrawing): string {
  const kind = d.kind ?? "drawing";
  const pts = (d.points ?? []).filter(
    (p): p is { time: number; price: number } =>
      Number.isFinite(p.time) && Number.isFinite(p.price),
  );
  if (!pts.length) return kind;
  if (pts.length === 1) return `${kind} at ${fmtPrice(pts[0].price)}`;
  const ordered = [...pts].sort((a, b) => a.time - b.time);
  return `${kind} ${ordered
    .slice(0, 4)
    .map((p) => fmtPrice(p.price))
    .join(" → ")}`;
}

export function snapshotChart(ctx: unknown): ChartSnapshot {
  const c = (ctx ?? {}) as CtxLike;
  return {
    symbol: c.symbol ?? null,
    timeframe: c.timeframe ?? null,
    drawings: (c.drawings ?? [])
      .filter((d) => d.origin === "user" && d.id != null)
      .map((d) => ({
        id: String(d.id),
        kind: d.kind ?? "drawing",
        // Geometry signature: same id + different sig = the user moved it.
        sig: (d.points ?? [])
          .map((p) => `${Math.round(p.time ?? 0)}:${(p.price ?? 0).toPrecision(8)}`)
          .join("|"),
        desc: describeDrawing(d),
      })),
    indicators: (c.indicators ?? [])
      .map((i) => i.name ?? "")
      .filter(Boolean)
      .sort(),
  };
}

/** Human-readable delta lines since the agent's last-seen snapshot.
 *  Empty array = nothing changed (or no baseline yet). */
export function diffChart(
  prev: ChartSnapshot | null | undefined,
  next: ChartSnapshot,
): string[] {
  if (!prev) return [];
  const lines: string[] = [];
  if (prev.symbol && next.symbol && prev.symbol !== next.symbol)
    lines.push(`switched market: ${prev.symbol} → ${next.symbol}`);
  if (prev.timeframe && next.timeframe && prev.timeframe !== next.timeframe)
    lines.push(`switched timeframe: ${prev.timeframe} → ${next.timeframe}`);

  const prevById = new Map(prev.drawings.map((d) => [d.id, d]));
  const nextById = new Map(next.drawings.map((d) => [d.id, d]));
  for (const d of next.drawings) {
    const was = prevById.get(d.id);
    if (!was) lines.push(`user ADDED a ${d.desc}`);
    else if (was.sig !== d.sig)
      lines.push(`user MOVED/reshaped a ${was.desc} — it is now ${d.desc}`);
  }
  for (const d of prev.drawings) {
    if (!nextById.has(d.id)) lines.push(`user DELETED the ${d.desc}`);
  }

  const prevInd = new Set(prev.indicators);
  const nextInd = new Set(next.indicators);
  for (const n of nextInd) if (!prevInd.has(n)) lines.push(`indicator enabled: ${n}`);
  for (const n of prevInd) if (!nextInd.has(n)) lines.push(`indicator removed: ${n}`);
  return lines;
}

/** Deterministic staleness check: a plan level tagged
 *  "trendline:<t1>,<p1>,<t2>,<p2>" rides a DRAWN trendline — if no current
 *  drawing matches those anchors, the user deleted or moved it and the
 *  plan's level is stale. Only verifiable on the plan's own symbol. */
export function stalePlanWarnings(
  plans: Array<Record<string, unknown> | null | undefined>,
  ctx: unknown,
): string[] {
  const c = (ctx ?? {}) as CtxLike;
  const symbol = c.symbol ?? null;
  const drawings = (c.drawings ?? []).filter((d) => (d.points ?? []).length >= 2);
  const warnings: string[] = [];
  const matchesAnchor = (t: number, p: number) =>
    drawings.some((d) =>
      (d.points ?? []).some(
        (pt) =>
          Number.isFinite(pt.time) &&
          Number.isFinite(pt.price) &&
          Math.abs((pt.time as number) - t) <= 120 &&
          Math.abs((pt.price as number) - p) <= Math.abs(p) * 0.001,
      ),
    );
  for (const plan of plans) {
    if (!plan) continue;
    const planSymbol = (plan.symbol as string | null) ?? null;
    if (planSymbol && symbol && planSymbol !== symbol) continue; // other chart — unverifiable
    for (const role of ["entry", "stop", "target"] as const) {
      const src = plan[`${role}Source`] as string | null | undefined;
      if (!src?.startsWith("trendline:")) continue;
      const nums = src.slice("trendline:".length).split(",").map(Number);
      if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) continue;
      const [t1, p1, t2, p2] = nums;
      if (!matchesAnchor(t1, p1) || !matchesAnchor(t2, p2)) {
        warnings.push(
          `Plan "${String(plan.title ?? "?")}": its ${role} rides trendline anchors that NO LONGER match any drawing on the chart (the user deleted or moved that trendline) — treat this plan's levels as stale; re-derive from the current drawings before acting on it.`,
        );
        break; // one warning per plan is enough
      }
    }
  }
  return warnings;
}
