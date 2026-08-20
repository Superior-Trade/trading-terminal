import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../lib/superior-key";
import { logStrategy, alreadyLogged } from "../../../lib/strategy-log";
import { resolveBacktestResults } from "../../../lib/superior-api";

export const runtime = "nodejs";

const API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

// GET /api/backtests           -> list recent backtests
// GET /api/backtests?id=<id>   -> single backtest status + results
export async function GET(req: Request) {
  let apiKey: string;
  let userDid: string;
  try {
    const auth = await resolveSuperiorAuth(req);
    apiKey = auth.key;
    userDid = auth.user.did;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const id = new URL(req.url).searchParams.get("id");
  const url = id
    ? `${API_BASE}/v2/backtesting/${id}`
    : `${API_BASE}/v2/backtesting?page=1&limit=20`;
  try {
    const res = await fetch(url, { headers: { "x-api-key": apiKey } });
    const json = await res.json().catch(() => ({}));
    // Verification ladder stage 3b: the VERDICT — a compiled strategy that
    // backtests with zero trades (or errors) never actually trades; record
    // the outcome once per backtest so the corpus shows run-behavior, not
    // just compile success. Poll-driven → dedupe by backtestId.
    if (id && res.ok) {
      const status = String(
        (json as { status?: string }).status ?? "",
      ).toLowerCase();
      const terminal =
        status.includes("complet") ||
        status.includes("fail") ||
        status.includes("error");
      // Upstream leaves the results column null and parks the freqtrade
      // output behind resultUrl (GCS) — resolve it so the CLIENT (chat card,
      // panel) and the verification log both see real numbers.
      if (terminal) {
        (json as Record<string, unknown>).results =
          await resolveBacktestResults(json as Record<string, unknown>);
      }
      if (terminal && !(await alreadyLogged("backtest_verify", `"${id}"`))) {
        const results = (json as {
          results?: {
            profit_total_pct?: number;
            trades?: Array<Record<string, unknown>>;
            [k: string]: unknown;
          } | null;
        }).results;
        const trades = Array.isArray(results?.trades) ? results.trades : null;
        await logStrategy(userDid, "backtest_verify", {
          plan: { linkedBy: "codeHash" },
          artifact: {
            backtestId: id,
            status,
            tradeCount: trades ? trades.length : null,
            profitTotalPct: results?.profit_total_pct ?? null,
            // Enough trades to judge direction/entry behavior without
            // ballooning the row.
            trades: trades ? trades.slice(0, 20) : null,
            traded: trades ? trades.length > 0 : null,
          },
        });
      }
    }
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "proxy error" },
      { status: 502 },
    );
  }
}
