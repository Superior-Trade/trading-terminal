import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../db";
import { MIN_STAKE_USD } from "../sizing-ceiling";

// Auto mode's rules. Every field has a conservative default and a hard bound:
// the UI is not the only writer (the API takes JSON), so the bounds live here.
// Off and dry-run are the defaults — turning on real deploys is two separate
// decisions the user has to make.

export const TIERS = ["S", "A", "B", "C", "D"] as const;
export type Tier = (typeof TIERS)[number];

export const AutoTradeSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Do everything except deploy. Logged as would_deploy. */
  dryRun: z.boolean().default(true),
  /** Bare HL coins ("BTC", "HYPE", "XYZ:TSLA"). Validated against the live universe at run time. */
  pairs: z.array(z.string().trim().min(1).max(40)).max(10).default(["BTC", "ETH"]),
  timeframe: z.enum(["5m", "15m", "1h", "4h"]).default("15m"),
  /** Minimum quality tier a plan must have to be considered. */
  minTier: z.enum(TIERS).default("A"),
  /** Minimum reward:risk computed from the plan's own entry/stop/target. */
  minRewardRisk: z.number().min(1).max(10).default(1.5),
  /** USDC stake per bot. Defaults above the $11 floor: Superior Trade adds a
   *  reserve that grows with the stop (a 7% stop needed $11.29 on 2026-11-04),
   *  so a strategy with a stop is rejected at exactly the floor. $15 covers
   *  stops up to about 20%. */
  stakeUsd: z.number().min(MIN_STAKE_USD).max(10_000).default(15),
  leverage: z.number().int().min(1).max(10).default(2),
  /** Auto-mode bots allowed to be running at once. */
  maxConcurrent: z.number().int().min(1).max(5).default(1),
  /** New auto deploys allowed per UTC day (dry runs do not count). */
  maxDeploysPerDay: z.number().int().min(0).max(20).default(2),
  /** Realized loss across auto bots today (USDC, positive number) that halts new deploys. */
  dailyLossLimitUsd: z.number().min(1).max(10_000).default(20),
  /** Backtest gate. */
  backtestDays: z.number().int().min(7).max(180).default(30),
  minBacktestTrades: z.number().int().min(1).max(500).default(3),
  minBacktestProfitPct: z.number().min(-100).max(1000).default(0),
  maxBacktestDrawdownPct: z.number().min(1).max(100).default(20),
  /** Minutes between scheduled scans. */
  intervalMinutes: z.number().int().min(5).max(1440).default(60),
});

export type AutoTradeSettings = z.infer<typeof AutoTradeSettingsSchema>;

export const DEFAULT_SETTINGS: AutoTradeSettings = AutoTradeSettingsSchema.parse({});

/** Stored settings merged over the defaults; a corrupt row reads as defaults. */
export async function loadSettings(userId: string): Promise<AutoTradeSettings> {
  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.autoTradeSettings)
      .where(eq(schema.autoTradeSettings.userId, userId));
    if (!row) return DEFAULT_SETTINGS;
    const parsed = AutoTradeSettingsSchema.safeParse(JSON.parse(row.settingsJson));
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Validates a partial update over the current settings and stores the result. */
export async function saveSettings(
  userId: string,
  patch: unknown,
): Promise<{ ok: true; settings: AutoTradeSettings } | { ok: false; error: string }> {
  const current = await loadSettings(userId);
  const merged = AutoTradeSettingsSchema.safeParse({
    ...current,
    ...(patch && typeof patch === "object" ? patch : {}),
  });
  if (!merged.success) {
    return {
      ok: false,
      error: merged.error.issues
        .map((i) => `${i.path.join(".") || "settings"}: ${i.message}`)
        .join("; "),
    };
  }
  const settings = merged.data;
  // "btc" / "BTC-USD" / "BTC/USDC:USDC" → "BTC". HIP-3 names ("xyz:TSLA")
  // keep their case: the dex prefix is lowercase on Hyperliquid.
  settings.pairs = [
    ...new Set(
      settings.pairs.map((p) => {
        const bare = p.replace(/[-/](USD|USDC)\b.*$/i, "");
        return bare.includes(":") ? bare : bare.toUpperCase();
      }),
    ),
  ];
  const db = getDb();
  const now = Date.now();
  await db
    .insert(schema.autoTradeSettings)
    .values({ userId, settingsJson: JSON.stringify(settings), updatedAt: now })
    .onConflictDoUpdate({
      target: schema.autoTradeSettings.userId,
      set: { settingsJson: JSON.stringify(settings), updatedAt: now },
    });
  return { ok: true, settings };
}
