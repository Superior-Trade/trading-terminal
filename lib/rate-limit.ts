import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "./db";

/* Per-user LLM rate limiting (fixed-window, DB-backed so it holds across
 * serverless instances). Two windows per route: a generous DAILY cap and a
 * tighter per-minute BURST cap. Keyed on the Privy DID.
 *
 * Launch-week "unlimited" means the caps sit far above any real user — they
 * exist only to bound a scripted abuser, not to meter normal use.
 *
 * Everything fails OPEN: a DB outage degrades to
 * "no limit", never to "everyone blocked".
 */

export type RouteKey = "chat" | "compile";

interface Spec {
  day: number;
  min: number;
}

// Normal signed-in users.
const LIMITS: Record<RouteKey, Spec> = {
  chat: { day: 150, min: 20 },
  compile: { day: 30, min: 6 },
};

function specFor(_did: string, route: RouteKey): Spec {
  return LIMITS[route];
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/** UTC day stamp "YYYY-MM-DD" from epoch ms (no Date parsing of "now" — take
 *  the ms in explicitly so callers control the clock). */
function dayStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
/** Epoch ms at the next UTC midnight — when the daily window resets. */
function endOfUtcDay(nowMs: number): number {
  return Math.floor(nowMs / DAY) * DAY + DAY;
}

export interface WindowUsage {
  used: number;
  limit: number;
  /** Epoch ms when this window resets. */
  resetAt: number;
}
export interface RouteUsage {
  day: WindowUsage;
  min: WindowUsage;
}
export interface RateResult {
  ok: boolean;
  /** Which window tripped, when over limit. */
  scope?: "day" | "min";
  usage: RouteUsage;
}

/** Atomically increment a (did, bucket) counter and return the new value. */
async function bump(
  db: ReturnType<typeof getDb>,
  did: string,
  bucket: string,
  expiresAt: number,
): Promise<number> {
  const rows = await db
    .insert(schema.usageCounter)
    .values({ userId: did, bucket, count: 1, expiresAt })
    .onConflictDoUpdate({
      target: [schema.usageCounter.userId, schema.usageCounter.bucket],
      set: { count: sql`${schema.usageCounter.count} + 1` },
    })
    .returning({ count: schema.usageCounter.count });
  return rows[0]?.count ?? 1;
}

/** Read the current count for a (did, bucket) without incrementing. */
async function peek(
  db: ReturnType<typeof getDb>,
  did: string,
  bucket: string,
): Promise<number> {
  const rows = await db
    .select({ count: schema.usageCounter.count })
    .from(schema.usageCounter)
    .where(
      and(eq(schema.usageCounter.userId, did), eq(schema.usageCounter.bucket, bucket)),
    );
  return rows[0]?.count ?? 0;
}

/** Consume one unit against a route's caps. Increments both windows and
 *  reports whether the call is allowed. Fails open on any DB error. */
export async function consumeRate(
  did: string,
  route: RouteKey,
  nowMs: number,
): Promise<RateResult> {
  const spec = specFor(did, route);
  const dayReset = endOfUtcDay(nowMs);
  const minReset = Math.floor(nowMs / MINUTE) * MINUTE + MINUTE;
  const dayBucket = `${route}:d:${dayStamp(nowMs)}`;
  const minBucket = `${route}:m:${Math.floor(nowMs / MINUTE)}`;
  try {
    const db = getDb();
    const dayCount = await bump(db, did, dayBucket, dayReset);
    const minCount = await bump(db, did, minBucket, minReset);
    const usage: RouteUsage = {
      day: { used: dayCount, limit: spec.day, resetAt: dayReset },
      min: { used: minCount, limit: spec.min, resetAt: minReset },
    };
    if (minCount > spec.min) return { ok: false, scope: "min", usage };
    if (dayCount > spec.day) return { ok: false, scope: "day", usage };
    return { ok: true, usage };
  } catch (err) {
    console.warn(
      "[rate-limit] consume failed (failing open):",
      err instanceof Error ? err.message : err,
    );
    // Fail open: report empty usage so the client shows no false warning.
    return {
      ok: true,
      usage: {
        day: { used: 0, limit: spec.day, resetAt: dayReset },
        min: { used: 0, limit: spec.min, resetAt: minReset },
      },
    };
  }
}

/** Read-only usage snapshot across all rate-limited routes (for /api/usage
 *  and the near-cap banner). Never increments; fails open to zero usage. */
export async function getUsage(
  did: string,
  nowMs: number,
): Promise<Record<RouteKey, RouteUsage>> {
  const routes: RouteKey[] = ["chat", "compile"];
  const dayReset = endOfUtcDay(nowMs);
  const minReset = Math.floor(nowMs / MINUTE) * MINUTE + MINUTE;
  const blank = (route: RouteKey): RouteUsage => {
    const spec = specFor(did, route);
    return {
      day: { used: 0, limit: spec.day, resetAt: dayReset },
      min: { used: 0, limit: spec.min, resetAt: minReset },
    };
  };
  try {
    const db = getDb();
    const out = {} as Record<RouteKey, RouteUsage>;
    for (const route of routes) {
      const spec = specFor(did, route);
      const dayCount = await peek(db, did, `${route}:d:${dayStamp(nowMs)}`);
      const minCount = await peek(db, did, `${route}:m:${Math.floor(nowMs / MINUTE)}`);
      out[route] = {
        day: { used: dayCount, limit: spec.day, resetAt: dayReset },
        min: { used: minCount, limit: spec.min, resetAt: minReset },
      };
    }
    return out;
  } catch {
    return { chat: blank("chat"), compile: blank("compile") };
  }
}

/** Client-facing 429 body when a cap is hit. */
export function rateLimitBody(route: RouteKey, r: RateResult) {
  const w = r.scope === "min" ? r.usage.min : r.usage.day;
  return {
    error: "rate_limited",
    route,
    scope: r.scope,
    limit: w.limit,
    resetAt: w.resetAt,
  };
}
