import { tool } from "ai";
import { z } from "zod";
import { buildAssetList } from "./market-universe.mjs";
import { marketContext } from "./market-context";
import { migrateDeploymentRecord } from "./plan-records";
import { validateStrategySafety, fixTaLibFloatParams } from "./freqtrade-guard";
import {
  submitBacktest,
  getBacktest,
  getBacktestLogs,
  resolveBacktestResults,
  deployStrategy,
  deploymentHistory,
  listDeployments,
  controlDeployment,
  updateDeployment,
  withConfigDefaults,
  walletOverview,
  transferBetweenAccounts,
  listBrackets,
  placeBracket,
  cancelBracket,
  sweepWalletToMain,
} from "./superior-api";

// Tool set for the streaming agent (/api/chat). Per-tool flat schemas —
// this dissolves the old single-generateObject oneOf workaround entirely.
//
// CLIENT tools have no `execute`: the call streams to the browser, which
// runs it against the chart bridge and returns the result (useChat
// onToolCall → addToolResult), continuing the loop.
// SERVER tools execute here with the caller's Superior key.

const point = { time: z.number().describe("unix seconds"), price: z.number() };

// withConfigDefaults now lives in lib/superior-api.ts and is applied inside
// submitBacktest/deployStrategy — every submit path gets it automatically.

/** Chart write-tools, executed in the browser via dispatchChartAction. */
export function clientTools() {
  return {
    draw_level: tool({
      description:
        "Draw a horizontal support/resistance level on the chart at a price.",
      inputSchema: z.object({
        price: z.number(),
        label: z.string().nullable().describe("short label"),
        side: z.enum(["support", "resistance"]).nullable(),
      }),
    }),
    draw_zone: tool({
      description: "Draw a rectangular price zone between two anchors.",
      inputSchema: z.object({
        fromTime: point.time,
        fromPrice: z.number(),
        toTime: point.time,
        toPrice: z.number(),
        label: z.string().nullable(),
      }),
    }),
    draw_trendline: tool({
      description:
        "Draw a trendline between two time/price anchors. Anchor on real swing pivots (≥2 touches); default to wicks.",
      inputSchema: z.object({
        fromTime: point.time,
        fromPrice: z.number(),
        toTime: point.time,
        toPrice: z.number(),
        label: z.string().nullable(),
      }),
    }),
    draw_fib: tool({
      description:
        "Draw a Fibonacci retracement/extension. Anchor `from` on the swing that STARTS the leg and `to` on the swing that ends it (for an up-leg: from=swing low, to=swing high). The .382/.5/.618/.786 levels are auto-drawn between.",
      inputSchema: z.object({
        fromTime: point.time,
        fromPrice: z.number(),
        toTime: point.time,
        toPrice: z.number(),
        label: z.string().nullable(),
      }),
    }),
    draw_vertical: tool({
      description:
        "Draw a vertical time marker (session open, kill-zone, funding, news/CPI). `time` is unix seconds.",
      inputSchema: z.object({
        time: point.time,
        label: z.string().nullable(),
      }),
    }),
    draw_channel: tool({
      description:
        "Draw a PARALLEL CHANNEL (a trendline plus its parallel rail) — use for channels, flags, and trend envelopes instead of two separate trendlines. Anchor `from`/`to` on the touches of ONE rail (≥2 touches, prefer 3, default to wicks); `offsetPrice` is the price of the OPPOSITE rail (at `fromTime`) so the band spans the range.",
      inputSchema: z.object({
        fromTime: point.time,
        fromPrice: z.number(),
        toTime: point.time,
        toPrice: z.number(),
        offsetPrice: z.number().describe("price of the parallel (opposite) rail at fromTime"),
        label: z.string().nullable(),
      }),
    }),
    draw_fib_extension: tool({
      description:
        "Draw a TREND-BASED Fibonacci EXTENSION for PROJECTED targets (1.272/1.618/2.618) — distinct from draw_fib, which is a retracement. Three anchors: `from` = the move's start, `to` = the move's end, `retrace` = the pullback low/high the extension projects FROM. Use whenever the user wants targets BEYOND the swing (measured move, projection).",
      inputSchema: z.object({
        fromTime: point.time,
        fromPrice: z.number(),
        toTime: point.time,
        toPrice: z.number(),
        retraceTime: point.time,
        retracePrice: z.number(),
        label: z.string().nullable(),
      }),
    }),
    draw_text: tool({
      description:
        "Pin a free-text note on the chart at a point (thesis annotation, event label, 'HTF supply'). Prefer this over cramming a long story into a line's label. `time` is unix seconds, `price` the y-anchor.",
      inputSchema: z.object({
        time: point.time,
        price: z.number(),
        text: z.string().describe("the note content, in the user's language"),
      }),
    }),
    add_indicators: tool({
      description:
        'Add TradingView studies. Names: "Relative Strength Index", "Moving Average Exponential", "Bollinger Bands", "MACD", "Average True Range", "Volume Weighted Average Price", "Superior CVD" (order-flow delta candles pane), "Superior Volume Delta" (per-bar delta histogram) — the Superior ones are exclusive, from the live tape.',
      inputSchema: z.object({
        indicators: z.array(
          z.object({
            name: z.string(),
            inputsJson: z
              .string()
              .nullable()
              .describe('JSON object of study inputs, e.g. {"length":20}'),
            forceOverlay: z.boolean().nullable(),
          }),
        ),
      }),
    }),
    remove_indicators: tool({
      description: "Remove studies whose names match (case-insensitive).",
      inputSchema: z.object({ names: z.array(z.string()) }),
    }),
    clear_indicators: tool({
      description: "Remove ALL studies from the chart.",
      inputSchema: z.object({}),
    }),
    set_timeframe: tool({
      description:
        'Change the chart timeframe. Resolutions: "1","5","15","60","240","1D","1W". "Zoom out"/"bigger picture" = higher timeframe; "zoom in" = lower.',
      inputSchema: z.object({ resolution: z.string() }),
    }),
    set_range: tool({
      description: "Set the visible time range (unix seconds).",
      inputSchema: z.object({ rangeFrom: z.number(), rangeTo: z.number() }),
    }),
    set_symbol: tool({
      description:
        'Switch the chart to another market. Accepts "BTC-USD", "HYPE/USDC" (spot), "xyz:TSLA" (HIP-3). Unknown pairs error back — use screen_markets to find exact names.',
      inputSchema: z.object({ pair: z.string() }),
    }),
    clear_agent_drawings: tool({
      description:
        "Remove ONLY agent-created drawings. Default for ambiguous cleanup asks — the user's own drawings stay.",
      inputSchema: z.object({}),
    }),
    clear_all_drawings: tool({
      description:
        "Remove EVERYTHING drawn including the user's own work. Only when they explicitly include their drawings ('everything', 'including mine').",
      inputSchema: z.object({}),
    }),
    update_plan: tool({
      description:
        "Replace the SELECTED trade plan (the one marked on the chart) after the user asks for changes. The terminal redraws marks automatically — do NOT also emit draw_level for plan levels. Keep unchanged fields identical. Pass `mode` when the user corrects how the setup should execute (one_shot vs recurring) — omitting it keeps the current mode.",
      inputSchema: z
        .object({
          title: z.string(),
          direction: z.enum(["long", "short", "neutral"]),
          // Execution mode is correctable here. It used to be settable only at
          // creation, where a missing value silently defaulted to "recurring";
          // a user saying "that's recurring, not one-shot" then had no path to
          // a fix, and the agent reported success on an edit it could not make.
          mode: z
            .enum(["one_shot", "recurring"])
            .optional()
            .describe(
              "one_shot = taken ONCE (enter → TP/SL → done); recurring = re-enters on each trigger. Omit to keep the plan's current mode.",
            ),
          entry: z.number(),
          stop: z.number(),
          target: z.number(),
          thesis: z.string(),
          invalidation: z.string(),
          // REQUIRED on every plan: tag each level so the terminal live-tracks
          // its line to the moving trigger. "bb_lower"|"bb_middle"|"bb_upper"|
          // "ema:<n>"|"sma:<n>"|"vwap"; "trendline:<t1>,<p1>,<t2>,<p2>" (anchor
          // unix-seconds + prices from the drawn trendline) for sloped lines;
          // "fixed" ONLY for a true horizontal price. An omitted source
          // renders a dead line that stops tracking.
          entrySource: z.string().nullable().optional(),
          stopSource: z.string().nullable().optional(),
          targetSource: z.string().nullable().optional(),
          // Optional sizing adjustment ("make it 2% risk") — unspecified
          // keeps the plan's existing sizing.
          sizing: z
            .object({
              riskPct: z.number(),
              leverage: z.number(),
              note: z.string().nullable(),
            })
            .nullable()
            .optional(),
        })
        .superRefine((p, ctx) => {
          // Deterministic geometry guard, validated server-side BEFORE the
          // call reaches the client: invalid edits bounce back to the model
          // as schema errors, and it must push back instead. Neutral plans
          // carry the LONG leg's levels (lower range edge), so they share
          // the long geometry.
          const sane =
            p.direction === "short"
              ? p.stop > p.entry && p.target < p.entry
              : p.stop < p.entry && p.target > p.entry;
          if (!sane) {
            ctx.addIssue({
              code: "custom",
              message: `Invalid geometry for a ${p.direction}: stop must be on the losing side of entry and target on the profit side. Do not apply this edit — explain the problem to the user instead.`,
            });
          }
        }),
    }),
    mark_setup: tool({
      description:
        "Select and DRAW a detected setup on the chart (from the DETECTED SETUPS list in context) — this switches the chart to that setup's asset and marks its entry/stop/target. Use when the user asks to see/show/put up a setup, or asks for one of a given quality ('show me the A-tier setup', 'put the best one on the chart'). Provide EITHER a tier (picks the best plan of that tier) OR the plan's 1-based index from the list.",
      inputSchema: z.object({
        tier: z.enum(["S", "A", "B", "C", "D"]).nullable(),
        index: z.number().nullable().describe("1-based index into the detected setups list"),
      }),
    }),
    suggest_plan: tool({
      description:
        "Publish trade plans YOU designed to the Draft Setups side panel as cards (tier badge, levels, deploy button). MANDATORY whenever you propose a concrete strategy with entry/stop/target — never leave a full plan as prose only. Takes a PLANS ARRAY: pass 1 plan for a conversational suggestion, and for a detect scan pass ALL 2-4 plans in ONE call (never one call per plan — each extra call costs a full model round-trip). After calling, tell the user the plans are in the panel on the right. Levels must sit on the correct sides (long: stop < entry < target; short: target < entry < stop). When a level's source is a trendline, its DRAWN line tracks the trendline's value at the CURRENT time — so the snapshot entry/stop/target must also be ordered correctly using each trendline's value NOW, not a future projection point: a rising trendline entry paired with a fixed stop above today's trendline value renders the entry line below the stop even though the numbers look ordered. Set the snapshot entry to the trendline's value at the current candle.",
      inputSchema: z.object({
        plans: z.array(z.object({
        title: z.string().describe("Short plan name, in the user's language"),
        direction: z
          .enum(["long", "short", "neutral"])
          .describe(
            "neutral ONLY for range-rotation plans trading both sides; levels then describe the LONG leg at the lower bound and the thesis states the mirrored short leg.",
          ),
        mode: z
          .enum(["one_shot", "recurring"])
          // A missing/odd mode must not sink the whole detect turn — default it.
          .catch("recurring")
          .describe(
            "one_shot = a specific setup taken ONCE (enter → TP/SL → the deployment auto-stops); recurring = a systematic rule that keeps re-entering on each trigger. Fixed price level / one-time structural event ⇒ one_shot; repeatable indicator condition ⇒ recurring. When unsure, 'recurring'.",
          ),
        symbol: z
          .string()
          .nullable()
          .describe("Chart pair e.g. 'BTC/USD'; null = the current chart"),
        thesis: z.string().describe("1-2 sentence WHY, in the user's language"),
        // Coerce so a numeric string ("535") from the model doesn't hard-fail.
        entry: z.coerce.number(),
        stop: z.coerce.number(),
        target: z.coerce.number(),
        invalidation: z.string().catch("").describe("What kills the idea, in the user's language"),
        tier: z.enum(["S", "A", "B", "C", "D"]).catch("C").describe("Grade per the tier rubric"),
        tierReason: z
          .string()
          .describe("1 sentence why this tier; refer to R:R only qualitatively"),
        entryCondition: z.string().nullable().describe("Trigger text shown before the price"),
        stopCondition: z.string().nullable(),
        targetCondition: z.string().nullable(),
        // REQUIRED on every level so the terminal live-tracks the drawn line
        // to its moving trigger: "fixed" | "bb_lower"|"bb_middle"|"bb_upper" |
        // "ema:<n>"|"sma:<n>"|"vwap" | "trendline:<t1>,<p1>,<t2>,<p2>" (anchor
        // unix-seconds + prices copied from the drawn trendline). An omitted
        // source renders a dead line that stops tracking.
        entrySource: z
          .string()
          .nullable()
          .describe(
            'REQUIRED: "fixed", "bb_lower", "ema:50", "vwap", "trendline:<t1>,<p1>,<t2>,<p2>", … — the series this level rides so the chart live-tracks it',
          ),
        stopSource: z.string().nullable(),
        targetSource: z.string().nullable(),
        aliveUntil: z
          .string()
          .nullable()
          .describe(
            "ONLY for time-sensitive setups: ISO-8601 UTC instant (e.g. 2026-07-10T16:00:00Z) when the deployed strategy auto-stops and closes its positions. Must be ≥ 15 minutes in the future. Null for swing/position plans without a time thesis.",
          ),
        aliveUntilReason: z
          .string()
          .nullable()
          .describe("Required when aliveUntil is set: why this expiry, in the user's language"),
        // Advisory only: the terminal deploys with the panel's stake/leverage
        // verbatim (exchange standard) and IGNORES these numbers for sizing.
        sizing: z
          .object({
            riskPct: z
              .number()
              .describe("Advisory: rough % of stake at risk if the stop hits — display only"),
            leverage: z
              .number()
              .describe("Advisory only — the panel leverage is what actually deploys"),
            note: z
              .string()
              .describe("One-line risk note in English (what hitting the stop costs at the chosen size)"),
          })
          .nullable()
          .optional()
          .describe(
            "OPTIONAL, advisory only: leave null unless a one-line risk note helps. The panel stake/leverage deploy verbatim; this does not size anything.",
          ),
        // Bilingual card rendering: primary fields are ALWAYS English; zh is
        // the Traditional-Chinese rendition so the UI switches instantly.
        zh: z
          .object({
            title: z.string().nullish(),
            thesis: z.string().nullish(),
            invalidation: z.string().nullish(),
            tierReason: z.string().nullish(),
            entryCondition: z.string().nullish(),
            stopCondition: z.string().nullish(),
            targetCondition: z.string().nullish(),
            aliveUntilReason: z.string().nullish(),
            sizingNote: z.string().nullish(),
          })
          // The bilingual block is the #1 cause of dropped detect turns: when
          // the model omits zh or a subfield, strict validation rejected the
          // ENTIRE plans array. Make it fully optional — the UI already falls
          // back to the English fields (zh?.title || title). Still described as
          // "always provide" so the model keeps writing it when it can.
          .nullish()
          .describe(
            "Traditional Chinese (繁體中文) renditions of the human-readable fields (title, thesis, invalidation, tierReason, conditions). Keep indicator tokens and numbers as-is. ALWAYS provide — write the primary fields in English.",
          ),
        })).min(1).max(4).describe("1-4 plans, best tier first — ALL plans of a scan in this ONE call"),
      }),
    }),
  };
}

/** Server tools: market data + Superior Trade infra. */
export function serverTools(getKey: () => Promise<string>) {
  return {
    market_pulse: tool({
      description:
        "Live derivatives read for a market: hourly funding (+APR), open interest, 24h volume/change, premium vs oracle, and a MEASURED range diagnostic (Kaufman efficiency + alternating bound touches over 120×1h). REQUIRED first step of every setup detection — when it says CLEAR RANGE, one published plan MUST be a neutral rotation. Also for any funding/OI question.",
      inputSchema: z.object({
        symbol: z.string().describe("chart pair, e.g. 'BTC/USD' or 'xyz:TSLA'"),
      }),
      execute: async (input) => {
        const { text, rangeBound } = await marketContext(input.symbol);
        return text
          ? { pulse: text.trim(), rangeBound }
          : { error: `no derivatives data for ${input.symbol}` };
      },
    }),

    screen_markets: tool({
      description:
        "Screen ALL Hyperliquid markets (perps, spot, HIP-3 builder dexes) with live metrics. Use for ANY 'which coin/market…' question (highest volume, funding extremes, biggest movers) instead of guessing. Funding is HOURLY. Returns CSV: name,type,dex,mid,chg24h%,vol24h_usd,funding,oi_usd.",
      inputSchema: z.object({
        marketType: z.enum(["perp", "spot", "hip3", "all"]).nullable(),
        dex: z.string().nullable().describe("HIP-3 dex filter, e.g. 'xyz'"),
        sortBy: z
          .enum(["volume24h", "funding", "openInterest", "change24h", "price"])
          .nullable()
          .describe("default volume24h"),
        direction: z.enum(["asc", "desc"]).nullable(),
        limit: z.number().nullable().describe("default 30, max 100"),
        minVolume24h: z.number().nullable().describe("USD floor"),
        nameFilter: z.string().nullable(),
      }),
      execute: async (input) => {
        const api = async (body: unknown) => {
          const r = await fetch("https://api.hyperliquid.xyz/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!r.ok) throw new Error(`HL info HTTP ${r.status}`);
          return r.json();
        };
        const dexs = (await api({ type: "perpDexs" })) as Array<{ name: string } | null>;
        const dexNames = dexs.map((d) => (d === null ? "" : d.name));
        const [spotResp, ...perpResps] = await Promise.all([
          api({ type: "spotMetaAndAssetCtxs" }),
          ...dexNames.map((d) =>
            api(d === "" ? { type: "metaAndAssetCtxs" } : { type: "metaAndAssetCtxs", dex: d }),
          ),
        ]);
        const allPerps = perpResps.map((r) => (r as [unknown, unknown])[0]) as Array<{
          universe: Array<{ name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }>;
        }>;
        const { assets } = buildAssetList(
          allPerps,
          spotResp as never,
          dexNames,
        );
        // metrics per name
        interface Ctx {
          midPx?: string | null;
          markPx?: string | null;
          prevDayPx?: string | null;
          dayNtlVlm?: string | null;
          funding?: string | null;
          openInterest?: string | null;
          coin?: string;
        }
        const metrics = new Map<string, Ctx>();
        perpResps.forEach((r, i) => {
          const [meta, ctxs] = r as [{ universe: Array<{ name: string }> }, Ctx[]];
          meta.universe.forEach((u, j) => {
            if (ctxs[j]) metrics.set(u.name, ctxs[j]);
          });
        });
        const [, spotCtxs] = spotResp as [unknown, Ctx[]];
        const spotByCoin = new Map(spotCtxs.map((c) => [c.coin, c]));
        const num = (v: string | null | undefined) => {
          const n = v != null ? parseFloat(v) : NaN;
          return Number.isFinite(n) ? n : null;
        };
        let rows = assets.map((a) => {
          const c =
            a.marketType === "spot"
              ? spotByCoin.get(a.apiCoin ?? a.name)
              : metrics.get(a.name);
          const mid = num(c?.midPx) ?? num(c?.markPx);
          const prev = num(c?.prevDayPx);
          return {
            name: a.name,
            type: a.marketType,
            dex: a.dex ?? "",
            price: mid,
            change24h: mid !== null && prev ? ((mid - prev) / prev) * 100 : null,
            volume24h: num(c?.dayNtlVlm) ?? 0,
            funding: a.marketType === "spot" ? null : num(c?.funding),
            openInterest:
              c?.openInterest != null ? (num(c.openInterest) ?? 0) * (mid ?? 0) : 0,
          };
        });
        if (input.marketType && input.marketType !== "all")
          rows = rows.filter((r) => r.type === input.marketType);
        if (input.dex) rows = rows.filter((r) => r.dex === input.dex);
        if (input.minVolume24h != null)
          rows = rows.filter((r) => r.volume24h >= (input.minVolume24h as number));
        if (input.nameFilter) {
          const q = input.nameFilter.toUpperCase();
          rows = rows.filter((r) => r.name.toUpperCase().includes(q));
        }
        const key = input.sortBy ?? "volume24h";
        const dir = input.direction === "asc" ? 1 : -1;
        rows.sort((a, b) => {
          const va = a[key] ?? -Infinity;
          const vb = b[key] ?? -Infinity;
          return (Number(va) - Number(vb)) * dir;
        });
        const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
        const shown = rows.slice(0, limit);
        const lines = shown.map(
          (r) =>
            `${r.name},${r.type},${r.dex},${r.price ?? ""},${r.change24h?.toFixed(2) ?? ""},${Math.round(r.volume24h)},${r.funding ?? ""},${Math.round(r.openInterest)}`,
        );
        return [
          "name,type,dex,mid,chg24h%,vol24h_usd,funding_hourly,oi_usd",
          ...lines,
          `# showing ${shown.length}/${rows.length} matches of ${assets.length} total markets`,
        ].join("\n");
      },
    }),

    backtest_run: tool({
      description:
        "Submit a Freqtrade strategy to Superior Trade's REAL backtesting infra, wait for completion (up to ~3 min), and return the results for you to interpret for the user. Pass the SAME configJson and code you registered via compile_strategy. If validation fails, the response includes the exact field errors — fix them, do not resubmit the identical payload.",
      inputSchema: z.object({
        configJson: z.string().describe("Freqtrade config as a JSON string — same conventions as compile_strategy"),
        code: z.string().describe("Python IStrategy code"),
        startDate: z.string().describe("YYYY-MM-DD"),
        endDate: z.string().describe("YYYY-MM-DD"),
      }),
      execute: async (input) => {
        const key = await getKey();
        let config: Record<string, unknown>;
        try {
          config = JSON.parse(input.configJson) as Record<string, unknown>;
        } catch {
          return { error: "configJson is not valid JSON" };
        }
        const { status, json } = await submitBacktest(key, {
          config: withConfigDefaults(config),
          code: input.code,
          timerange: { start: input.startDate, end: input.endDate },
        });
        const id = json.id as string | undefined;
        if (status >= 400 || !id) {
          return {
            error: `submit failed (HTTP ${status})`,
            validation: json.details ?? json.message ?? json.error ?? json,
            hint: "Fix the reported fields and resubmit ONCE; if it still fails, tell the user what's wrong instead of retrying.",
          };
        }
        // Poll to completion inside the turn (10s × 18 ≈ 3min).
        for (let i = 0; i < 18; i++) {
          await new Promise((r) => setTimeout(r, 10_000));
          const { json: bt } = await getBacktest(key, id);
          const st = String(bt.status ?? "");
          if (["completed", "failed", "stopped"].includes(st)) {
            // results ride a GCS resultUrl, not the DB row — resolve both.
            const res = (await resolveBacktestResults(bt)) ?? {};
            if (st === "failed") {
              // Surface the runtime traceback so the model can FIX the
              // strategy code (e.g. TA-Lib float params) and resubmit once.
              const logs = await getBacktestLogs(key, id);
              return {
                id,
                status: st,
                error: "strategy runtime failure — see traceback",
                traceback: logs.slice(0, 12),
                hint: "Fix the code based on the traceback and resubmit ONCE. Common: TA-Lib float params (nbdevup=2.0 not 2), missing imports.",
              };
            }
            return {
              id,
              status: st,
              trades: res.total_trades ?? null,
              profitTotalPct: res.profit_total_pct ?? null,
              winrate: res.winrate ?? null,
              maxDrawdownAccount: res.max_drawdown_account ?? null,
            };
          }
        }
        return {
          id,
          status: "timeout",
          note: "Backtest still running after 3min — results will appear in the panel; tell the user to check back.",
        };
      },
    }),

    deploy_strategy: tool({
      description:
        "Deploy a Freqtrade strategy LIVE on Superior Trade infra (creates a real trading pod). Only when the user asked to deploy/go live. Known constraint: one live deployment per trading wallet — a duplicate_wallet_address error means an old deployment must be deleted first (ask the user).",
      inputSchema: z.object({
        name: z.string().describe("short deployment name"),
        configJson: z.string().describe("Freqtrade config as a JSON string"),
        code: z.string().describe("Python IStrategy code"),
      }),
      execute: async (input) => {
        const key = await getKey();
        let config: Record<string, unknown>;
        try {
          config = JSON.parse(input.configJson) as Record<string, unknown>;
        } catch {
          return { error: "configJson is not valid JSON" };
        }
        const { json, steps, stepErrors } = await deployStrategy(key, {
          name: input.name.slice(0, 40),
          config: withConfigDefaults(config) as { exchange?: { name?: string } },
          code: input.code,
        });
        if (steps.create >= 400) {
          // Surface the creation-validation details so you can fix or
          // explain — do not blind-retry the same payload.
          return {
            error: "deployment creation rejected",
            validation: json.details ?? json.message ?? json.error ?? json,
          };
        }
        // Wallet contention: the create succeeded but the wallet is held by
        // another deployment. Tell the agent exactly how to recover.
        // Includes wallet_occupied: a live one-shot holds the wallet just as
        // a deployment does, and omitting it left the agent without the
        // recovery advice for that case.
        const contested = /already linked|duplicate_wallet|in_use|wallet_occupied|live one-shot/i.test(
          `${stepErrors.credentials ?? ""} ${stepErrors.start ?? ""}`,
        );
        return {
          id: json.id ?? null,
          steps,
          ...(Object.keys(stepErrors).length ? { stepErrors } : {}),
          live: steps.start === 200,
          ...(contested
            ? {
                walletBusy: true,
                hint: "The trading wallet is held by another deployment. Call list_deployments, then manage_deployment{action:'delete'} on the blocker (with the user's ok), then retry deploy_strategy.",
              }
            : {}),
        };
      },
    }),

    pnl_check: tool({
      description:
        "Realized PnL (net of fees) per deployment from live trading history. Use when the user asks how their bots/strategies/deployments are doing.",
      inputSchema: z.object({
        deploymentId: z.string().nullable(),
      }),
      execute: async (input) => {
        const key = await getKey();
        const { status, json } = await deploymentHistory(key);
        if (status >= 400) return { error: `history HTTP ${status}` };
        interface Fill { closedPnl?: string | number; fee?: string | number; coin?: string }
        interface Sess { deploymentId?: string | null; trades?: Fill[] | null; startedAt?: string | null; endedAt?: string | null }
        const items = (json.items ?? []) as Sess[];
        const num = (v: string | number | undefined) => {
          const n = typeof v === "string" ? parseFloat(v) : v;
          return Number.isFinite(n) ? (n as number) : 0;
        };
        const byDep = new Map<string, { pnl: number; fills: number; coins: Set<string>; running: boolean }>();
        for (const s of items) {
          if (!s.deploymentId) continue;
          if (input.deploymentId && s.deploymentId !== input.deploymentId) continue;
          const d = byDep.get(s.deploymentId) ?? { pnl: 0, fills: 0, coins: new Set<string>(), running: false };
          for (const f of s.trades ?? []) {
            d.pnl += num(f.closedPnl) - num(f.fee);
            d.fills++;
            if (f.coin) d.coins.add(f.coin);
          }
          if (s.startedAt && !s.endedAt) d.running = true;
          byDep.set(s.deploymentId, d);
        }
        return {
          deployments: [...byDep.entries()].map(([id, d]) => ({
            id,
            realizedPnlNet: Number(d.pnl.toFixed(4)),
            fills: d.fills,
            coins: [...d.coins],
            running: d.running,
          })),
          note: "Realized net-of-fees only; excludes unrealized PnL on open positions and backtests.",
        };
      },
    }),

    list_deployments: tool({
      description:
        "List the user's deployments (running AND previous) with status, traded pairs, stake, wallet. Use to answer 'what's deployed/running', to identify a deployment the user refers to ('the old one', 'my BTC bot'), and BEFORE deploying when a wallet-contention error is likely — one live deployment per trading wallet, so you must find and delete the blocker first.",
      inputSchema: z.object({}),
      execute: async () => {
        const key = await getKey();
        const { status, json } = await listDeployments(key);
        if (status >= 400) return { error: `deployments HTTP ${status}` };
        interface Dep {
          id?: string;
          name?: string;
          status?: string;
          walletAddress?: string;
          createdAt?: string;
          config?: { exchange?: { pair_whitelist?: string[] }; stake_amount?: unknown };
        }
        const items = (json.items ?? []) as Dep[];
        return {
          deployments: items.map((d) => ({
            id: d.id ?? null,
            name: d.name ?? null,
            status: d.status ?? null,
            running: ["running", "deployed"].includes(d.status ?? ""),
            pairs: d.config?.exchange?.pair_whitelist ?? [],
            stake: d.config?.stake_amount ?? null,
            wallet: d.walletAddress ?? null,
            createdAt: d.createdAt ?? null,
          })),
          note: "One live deployment per trading wallet; even a stopped one holds it — delete to free the wallet before redeploying.",
        };
      },
    }),

    manage_deployment: tool({
      description:
        "Control an existing deployment by id: 'stop' (pause the pod), 'start' (restart a stopped one — automatically re-funds its wallet to the stake from main if it was swept), 'exit' (close all open positions — REALIZES PnL), 'delete' (remove it and FREE the trading wallet). Only act on the user's explicit instruction. 'delete' and 'exit' are irreversible — if which deployment is unclear, call list_deployments and confirm the target first. To replace/redeploy on the same wallet, delete the blocker then deploy_strategy.",
      inputSchema: z.object({
        id: z.string().describe("deployment id"),
        action: z.enum(["stop", "start", "exit", "delete"]),
      }),
      execute: async (input) => {
        const key = await getKey();
        const { status, json } = await controlDeployment(key, input.id, input.action);
        if (status >= 400) {
          return {
            error: `${input.action} rejected (HTTP ${status})`,
            detail: json.message ?? json.error ?? json,
          };
        }
        return { ok: true, action: input.action, id: input.id, result: json };
      },
    }),

    update_deployment: tool({
      description:
        "Change a running deployment's sizing (stake amount and/or leverage). Upstream has no in-place edit, so this recreates the deployment: it deletes the old one and redeploys the SAME strategy with the new sizing (brief downtime, new id). Only on explicit user request. Leverage must not exceed the pair's max.",
      inputSchema: z.object({
        id: z.string(),
        stakeAmount: z.number().nullable(),
        leverage: z.number().nullable(),
      }),
      execute: async (input) => {
        if (input.stakeAmount == null && input.leverage == null) {
          return { error: "specify stakeAmount and/or leverage to change" };
        }
        const key = await getKey();
        const res = await updateDeployment(key, input.id, {
          stakeAmount: input.stakeAmount ?? undefined,
          leverage: input.leverage ?? undefined,
        });
        if (res.steps.create >= 400) {
          return {
            error: "redeploy after update rejected",
            validation: res.json.details ?? res.json.message ?? res.json,
            warning: "the old deployment was deleted — redeploy manually if this persists",
          };
        }
        // The recreate gives the deployment a NEW id — carry the plan record
        // over or the card degrades to a plan-less "foreign" deployment.
        const newId = res.json.id;
        if (typeof newId === "string" && res.replacedId) {
          await migrateDeploymentRecord(res.replacedId, newId);
        }
        return {
          ok: true,
          replacedId: res.replacedId,
          newId: res.json.id ?? null,
          steps: res.steps,
          live: res.steps.start === 200,
        };
      },
    }),

    list_wallets: tool({
      description:
        "The user's main + trading accounts with balances and occupancy (one active execution — deployment OR bracket — per wallet). Each wallet reports: withdrawableUsd (free margin already on Hyperliquid), heldUsd (un-deployed USDC held on-chain in the account), and deployableUsd (what can back a deployment = venue withdrawable + the main account's held USDC, which is bridged into the venue automatically at deploy time). ALWAYS size a deployment against deployableUsd, NOT withdrawableUsd — a funded hold-model account often shows withdrawableUsd 0 while deployableUsd holds the real balance. Use before transfers, bracket placement, sweeps, and when a deploy hits wallet contention.",
      inputSchema: z.object({}),
      execute: async () => {
        const key = await getKey();
        try {
          const wallets = await walletOverview(key);
          return {
            wallets,
            note: "occupied=true means a current deployment or active bracket holds the wallet — do not place executions there; sweep only unoccupied ones.",
          };
        } catch (e) {
          return { error: e instanceof Error ? e.message : "wallet overview failed" };
        }
      },
    }),

    transfer_funds: tool({
      description:
        "Move USDC between the user's OWN Superior accounts (main ↔ trading accounts). ONLY on the user's explicit instruction, and only between addresses returned by list_wallets — transfers to any external address are impossible and must be refused. Say what moved where when done.",
      inputSchema: z.object({
        from: z.string().describe("source wallet address (from list_wallets)"),
        to: z.string().describe("destination wallet address (from list_wallets)"),
        amountUsd: z.number().describe("USDC amount, > 0"),
      }),
      execute: async (input) => {
        const key = await getKey();
        const r = await transferBetweenAccounts(key, input.from, input.to, input.amountUsd);
        return r.ok ? { ok: true, detail: r.detail } : { error: r.detail };
      },
    }),

    list_brackets: tool({
      description:
        "The user's native bracket orders (atomic entry+TP/SL on Hyperliquid) with status and wallet. Use when they ask about brackets or before placing/cancelling one.",
      inputSchema: z.object({}),
      execute: async () => {
        const key = await getKey();
        const { status, json } = await listBrackets(key);
        if (status >= 400) return { error: `brackets HTTP ${status}` };
        return { brackets: json.items ?? json };
      },
    }),

    place_bracket: tool({
      description:
        "Place a NATIVE bracket order: one atomic Hyperliquid entry limit + reduce-only TP/SL on a free trading account — no bot, no compile; fills and exits live on the exchange. The right execution for a ONE-SHOT directional plan with FIXED levels (prefer this over deploy_strategy for those). Only on explicit user instruction. Size per the SIZING rubric (size_usd is the NOTIONAL = stake × leverage). One active execution per wallet — a 409/conflict means no free wallet: list_wallets, free one (with the user's ok), retry.",
      inputSchema: z.object({
        pair: z.string().describe("coin, e.g. 'BTC' (no ':' — HIP-3 not supported)"),
        side: z.enum(["long", "short"]),
        entry: z.number(),
        take_profit: z.number(),
        stop_loss: z.number(),
        size_usd: z.number().describe("notional USD (stake × leverage)"),
        leverage: z.number().describe("integer, within the pair's cap; liq must sit ≥3× the stop distance away"),
        alive_until: z
          .string()
          .nullable()
          .describe("optional ISO-8601 UTC auto-cancel/auto-stop instant, ≥15 min out"),
      }),
      execute: async (input) => {
        // Deterministic geometry guard — same rule as suggest_plan.
        const sane =
          input.side === "short"
            ? input.stop_loss > input.entry && input.take_profit < input.entry
            : input.stop_loss < input.entry && input.take_profit > input.entry;
        if (!sane) {
          return {
            error: `Invalid geometry for a ${input.side}: stop must be on the losing side of entry and take-profit on the profit side. Fix the levels — do not retry unchanged.`,
          };
        }
        const key = await getKey();
        const { status, json } = await placeBracket(key, {
          pair: input.pair,
          side: input.side,
          entry: input.entry,
          take_profit: input.take_profit,
          stop_loss: input.stop_loss,
          size_usd: input.size_usd,
          leverage: Math.max(1, Math.round(input.leverage)),
          ...(input.alive_until ? { alive_until: input.alive_until } : {}),
        });
        if (status !== 201 || !json.id) {
          return {
            error: String(json.message ?? json.error ?? `bracket HTTP ${status}`),
            ...(status === 409
              ? { hint: "No free wallet — list_wallets, then free one (cancel a bracket / delete a deployment) with the user's ok, then retry." }
              : {}),
          };
        }
        return {
          ok: true,
          id: json.id,
          account: json.account_label ?? null,
          wallet: json.wallet_address ?? null,
        };
      },
    }),

    cancel_bracket: tool({
      description:
        "Cancel a bracket order by id (closes its open position if filled, frees the wallet). Irreversible — only on explicit user instruction; if the target is unclear, list_brackets and confirm first.",
      inputSchema: z.object({ id: z.string() }),
      execute: async (input) => {
        const key = await getKey();
        const { status, json } = await cancelBracket(key, input.id);
        if (status >= 400)
          return { error: String(json.message ?? json.error ?? `cancel HTTP ${status}`) };
        return { ok: true, id: input.id };
      },
    }),

    sweep_wallet: tool({
      description:
        "Return an IDLE trading account's funds to the main wallet. Refuses occupied wallets (a running deployment/bracket needs its margin). Use when the user asks to consolidate/free funds after stopping executions.",
      inputSchema: z.object({
        wallet: z.string().describe("trading-account address (from list_wallets)"),
      }),
      execute: async (input) => {
        const key = await getKey();
        const wallets = await walletOverview(key).catch(() => []);
        const target = wallets.find(
          (w) => w.address.toLowerCase() === input.wallet.toLowerCase(),
        );
        if (!target) return { error: "not one of the user's accounts — see list_wallets" };
        if (target.isMain) return { error: "that IS the main wallet — nothing to sweep" };
        if (target.occupied)
          return {
            error:
              "wallet is occupied by a running deployment or active bracket — its margin must stay; stop/delete the execution first (with the user's ok).",
          };
        const moved = await sweepWalletToMain(key, input.wallet);
        return moved === null
          ? { ok: true, moved: 0, note: "nothing to sweep (< $1 or transfer unavailable)" }
          : { ok: true, moved: Number(moved) };
      },
    }),

    compile_strategy: tool({
      description:
        "REQUIRED whenever you produce a Freqtrade strategy: pass the full strategy here (it becomes the strategy card in the UI). Config conventions: exchange hyperliquid, pair_whitelist ['<BASE>/USDC:USDC'], stake_currency USDC, trading_mode futures, margin_mode isolated. Code: class <Name>Strategy(IStrategy) with populate_indicators/populate_entry_trend/populate_exit_trend, 'import talib.abstract as ta'. CRITICAL: when an entry/exit is driven by an INDICATOR (Bollinger, EMA/SMA, VWAP, RSI or other oscillator, ATR, Donchian…), gate it on the INDICATOR SERIES (e.g. close < dataframe['bb_lower'], rsi < 30) — do NOT freeze it into a hardcoded absolute price window like (close <= 62350) & (close > 62200); indicators move every candle, so a baked-in price snapshot never fills once price leaves it (the #1 cause of live strategies that never trade). Use a literal price only for a genuine fixed level the user drew/named.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "Human-readable SETUP name for the card — use the selected plan's title verbatim (e.g. \"EDIT 1 - HYPE BB Range Ref\"), NOT the Python class name. The class name lives in `code`.",
          ),
        configJson: z.string().describe("Freqtrade config as a JSON string"),
        code: z.string().describe("complete Python IStrategy code"),
      }),
      execute: async (input) => {
        // Deterministic auto-repair first: TA-Lib float params written as
        // ints crash the bot on every candle — rewrite instead of bouncing
        // the model (it keeps making this exact mistake).
        input.code = fixTaLibFloatParams(input.code);
        const issues: string[] = [];
        if (!input.code.includes("IStrategy")) issues.push("code must define an IStrategy subclass");
        if (!/populate_entry_trend|populate_buy_trend/.test(input.code))
          issues.push("code lacks an entry trend method");
        let cfg: Record<string, unknown> | null = null;
        try {
          cfg = JSON.parse(input.configJson) as Record<string, unknown>;
          const ex = cfg.exchange as { pair_whitelist?: string[] } | undefined;
          if (!ex?.pair_whitelist?.length) issues.push("config.exchange.pair_whitelist is empty");
        } catch {
          issues.push("configJson is not valid JSON");
        }
        // Deterministic safety gate — the pitfall classes that killed live
        // bots (leverage-scaled stop math, stop-vs-liquidation distance,
        // lookahead bias, NaN indicators). The model fixes and re-calls.
        if (cfg) {
          const levMatch = input.code.match(
            /def\s+leverage\s*\([^)]*\)[^:]*:\s*\n\s*return\s+(\d+(?:\.\d+)?)/,
          );
          issues.push(
            ...validateStrategySafety({
              config: cfg,
              code: input.code,
              leverage: levMatch ? Number(levMatch[1]) : 1,
            }),
          );
        }
        return issues.length ? { ok: false, issues } : { ok: true };
      },
    }),
  };
}
