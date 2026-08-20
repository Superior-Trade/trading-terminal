import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";

/* Uniform audit log (strategy_log table) covering the FULL verification
 * ladder — compiling is necessary but not sufficient (a compiled strategy
 * can still never enter, enter the wrong side, or get its orders rejected):
 *
 *   1. detect / suggest_plan  — the plan was generated (framework-agnostic)
 *   2. compile_ok / _reject   — static: parses + passes the safety guard
 *   3. backtest_submit/_verify— dynamic: does it actually TRADE on real
 *                               candles, and do the trades match the plan?
 *   4. live_verify            — production: first real fill vs the plan
 *                               (direction + entry deviation)
 *
 * Stages join on codeHash (compile → backtest) and deploymentId (→ live);
 * the plan JSON stays the framework-agnostic layer throughout.
 * Logging must NEVER break generation: swallow all errors.
 */

export type StrategyLogKind =
  | "detect"
  | "suggest_plan"
  | "compile_ok"
  | "compile_reject"
  | "backtest_submit"
  | "backtest_verify"
  | "live_verify";

/** Short stable hash of generated strategy code — the join key between a
 *  compile row and the backtest rows exercising the same artifact. */
export function codeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 16);
}

/** Has this kind already been logged with the given marker in its artifact?
 *  (Dedupe for poll-driven stages — volumes are tiny, LIKE is fine.) */
export async function alreadyLogged(
  kind: StrategyLogKind,
  marker: string,
): Promise<boolean> {
  try {
    const db = getDb();
    // Filter in JS: rows per kind stay small and marker position varies.
    const rows = await db
      .select({ artifactJson: schema.strategyLog.artifactJson })
      .from(schema.strategyLog)
      .where(eq(schema.strategyLog.kind, kind));
    return rows.some((r) => r.artifactJson?.includes(marker));
  } catch {
    return false; // when unsure, log — a duplicate beats a hole in the corpus
  }
}

export async function logStrategy(
  userId: string,
  kind: StrategyLogKind,
  entry: {
    symbol?: string | null;
    /** Generating LLM model id (null for client-side suggestions). */
    model?: string | null;
    plan: unknown;
    /** compile_*: { name?, configJson, code, validationErrors?, repair? } */
    artifact?: unknown;
  },
): Promise<void> {
  try {
    const db = getDb();
    await db.insert(schema.strategyLog).values({
      userId,
      kind,
      symbol: entry.symbol ?? null,
      model: entry.model ?? null,
      planJson: JSON.stringify(entry.plan),
      artifactJson: entry.artifact != null ? JSON.stringify(entry.artifact) : null,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.warn("[strategy-log] write failed:", err instanceof Error ? err.message : err);
  }
}
