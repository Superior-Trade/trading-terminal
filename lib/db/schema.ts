import {
  pgTable,
  text,
  bigint,
  index,
  doublePrecision,
  integer,
  primaryKey,
} from "drizzle-orm/pg-core";

// Ported from the original better-sqlite3 schema to Postgres (Neon). The port
// is intentionally 1:1 so query callers are untouched: text stays text, epoch-
// millisecond timestamps stay JS numbers via bigint(mode: "number"), and the
// *_json columns stay text (the app JSON.stringify/parses them by hand).

// The account rows belong to (see lib/account.ts). A self-hosted terminal has
// exactly one, but everything user-scoped still carries the id so the schema
// does not assume that.
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  walletAddress: text("wallet_address"),
  lang: text("lang").default("en"),
  theme: text("theme").default("dark"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Structured session state (selected plan, symbol/timeframe) lives HERE,
// injected fresh each turn — never replayed as old messages. `summary`
// compacts history older than summaryUptoMessageId for the prompt only;
// raw message rows are kept forever.
export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title"),
  summary: text("summary"),
  summaryUptoMessageId: text("summary_upto_message_id"),
  stateJson: text("state_json"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// AI SDK v6-compatible shape: envelope columns + parts[]/metadata JSON.
// text -> text part; strategy/plan payloads -> data-* parts; tool chip
// label + followUps -> metadata.
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    role: text("role").notNull(), // "user" | "assistant"
    partsJson: text("parts_json").notNull(),
    metadataJson: text("metadata_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_messages_conversation").on(t.conversationId, t.createdAt)],
);

// Liquidation-level snapshots (HyperTracker bins). Each row is one price bin
// for one coin; first_seen is when WE first observed liquidity there — the
// honest formation-time anchor for heatmap bar lengths (Coinglass-style,
// but from real on-chain positions, accumulating from deploy day onward).
// Refreshed opportunistically whenever /api/liquidation-heatmap fetches
// fresh bins (~15-min cadence per viewed coin).
export const liqLevels = pgTable(
  "liq_levels",
  {
    coin: text("coin").notNull(),
    binStart: doublePrecision("bin_start").notNull(),
    binEnd: doublePrecision("bin_end").notNull(),
    firstSeen: bigint("first_seen", { mode: "number" }).notNull(),
    lastSeen: bigint("last_seen", { mode: "number" }).notNull(),
    value: doublePrecision("value").notNull(),
    positionsCount: integer("positions_count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.coin, t.binStart] })],
);

// Per-cohort long/short positioning from HyperTracker's positions/heatmap.
// One row per coin, refreshed by the always-on collector (positions/heatmap
// is ONE upstream call for ALL markets, so this is cheap). The web route
// READS this table instead of calling HyperTracker per-request: the vendor's
// free tier is 100 req/day shared with the liq snapshotter, and serverless
// cold starts (each a fresh in-memory cache) would burn the quota and 429.
// Counts are stored raw; the route derives long% = long / (long + short).
export const marketPositioning = pgTable("market_positioning", {
  coin: text("coin").primaryKey(),
  count: integer("count").notNull().default(0),
  crowdLong: integer("crowd_long").notNull().default(0),
  crowdShort: integer("crowd_short").notNull().default(0),
  smartLong: integer("smart_long").notNull().default(0),
  smartShort: integer("smart_short").notNull().default(0),
  whaleLong: integer("whale_long").notNull().default(0),
  whaleShort: integer("whale_short").notNull().default(0),
  retailLong: integer("retail_long").notNull().default(0),
  retailShort: integer("retail_short").notNull().default(0),
  rektLong: integer("rekt_long").notNull().default(0),
  rektShort: integer("rekt_short").notNull().default(0),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Order-flow footprint cells from the server-side tape recorder. Each row is
// one (coin, 5-min bucket, price bin) with accumulated aggressive buy/sell
// notional. Instances hold a hot in-memory copy and flush unflushed DELTAS
// with buy = buy + excluded.buy (commutative, so concurrent serverless
// instances can't clobber each other). 7-day retention, pruned on flush.
export const ofBins = pgTable(
  "of_bins",
  {
    coin: text("coin").notNull(),
    bucket: bigint("bucket", { mode: "number" }).notNull(), // epoch-ms 5m bucket start
    bin: doublePrecision("bin").notNull(), // price-bin lower edge
    buy: doublePrecision("buy").notNull().default(0),
    sell: doublePrecision("sell").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.coin, t.bucket, t.bin] })],
);

// Per-coin recorder metadata: the bin size is chosen once from the first
// trade's price (niceStep) and must stay stable forever after — every
// instance reads it from here before recording. started_at anchors the
// "live since" label in the footprint panel.
export const ofMeta = pgTable("of_meta", {
  coin: text("coin").primaryKey(),
  binSize: doublePrecision("bin_size").notNull(),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
});

// Enrichment for Superior deployments (Superior's API knows status, we know
// the plan). origin distinguishes ours from foreign ones surfaced read-only.
export const deployments = pgTable(
  "deployments",
  {
    deploymentId: text("deployment_id").primaryKey(),
    userId: text("user_id").notNull(),
    planJson: text("plan_json").notNull(),
    symbol: text("symbol"),
    timeframe: text("timeframe"),
    origin: text("origin").notNull().default("ours"),
    // Execution mode. "one_shot" deployments are auto-stopped after their first
    // completed trade by the one-shot sweep (app/api/cron/one-shot-sweep);
    // "recurring" run until the user stops them (or alive_until fires).
    mode: text("mode").notNull().default("recurring"),
    // Stamped by the sweep when it stops a finished one_shot, so later passes
    // skip it. Null = not yet auto-stopped.
    autostoppedAt: bigint("autostopped_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_deployments_user").on(t.userId, t.createdAt)],
);

// Uniform audit log of every generated strategy artifact — detected plans,
// chat-suggested plans, and compiled strategies (accepted AND rejected).
// Purpose: debugging + a corpus for verifying that generated strategies
// actually run on target frameworks (Freqtrade today, Nautilus/other later).
// The plan JSON is the framework-AGNOSTIC layer; artifact_json holds the
// per-target output (config+code) plus validator verdicts. Fire-and-forget
// writes — logging must never fail a generation.
// Per-user LLM usage counters for rate limiting (fixed-window). One row per
// (DID, bucket) where bucket encodes route + granularity + window, e.g.
// "chat:d:2026-07-14" (daily) or "chat:m:29280102" (per-minute burst).
// count is bumped atomically via upsert; expires_at lets a sweep prune stale
// rows. All reads/writes fail OPEN — an infra error must never lock a paying
// user out, only forgo the limit.
export const usageCounter = pgTable(
  "usage_counter",
  {
    userId: text("user_id").notNull(),
    bucket: text("bucket").notNull(),
    count: integer("count").notNull().default(0),
    /** Epoch ms after which this window is dead and prunable. */
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bucket] })],
);

export const strategyLog = pgTable(
  "strategy_log",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    userId: text("user_id").notNull(),
    // "detect" | "suggest_plan" | "compile_ok" | "compile_reject"
    kind: text("kind").notNull(),
    symbol: text("symbol"),
    /** Generating LLM (model id) — null for client-side suggest logging. */
    model: text("model"),
    planJson: text("plan_json").notNull(),
    /** compile_*: {name?, configJson, code, validationErrors?, repair?} */
    artifactJson: text("artifact_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_strategy_log_user").on(t.userId, t.createdAt)],
);
