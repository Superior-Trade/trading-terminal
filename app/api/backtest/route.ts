import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../lib/superior-key";
import { submitBacktest } from "../../../lib/superior-api";
import { logStrategy, codeHash } from "../../../lib/strategy-log";
import { track } from "../../../lib/analytics";

export const runtime = "nodejs";

// Submits an agent-built strategy to Superior Trade's real backtesting
// infra (create + auto-start via lib/superior-api).
export async function POST(req: Request) {
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
  try {
    const body = (await req.json()) as {
      code?: string;
      config?: Record<string, unknown>;
      timerange?: unknown;
    } & Record<string, unknown>;
    const { status, json } = await submitBacktest(apiKey, body);
    const btCfg = (body.config ?? {}) as {
      exchange?: { pair_whitelist?: string[] };
      timeframe?: string;
    };
    track(status < 400 ? "backtest_submitted" : "backtest_failed", {
      user: userDid,
      props: {
        status,
        backtestId: (json as { id?: string }).id,
        pair: btCfg.exchange?.pair_whitelist?.[0],
        timeframe: btCfg.timeframe,
        timerange: typeof body.timerange === "string" ? body.timerange : undefined,
      },
    });
    // Verification ladder stage 3a: record the RUN attempt. codeHash joins
    // this row to its compile_ok row; the poll route logs the verdict.
    if (status < 400 && json.id && typeof body.code === "string") {
      await logStrategy(userDid, "backtest_submit", {
        plan: { linkedBy: "codeHash" },
        artifact: {
          backtestId: json.id,
          codeHash: codeHash(body.code),
          timerange: body.timerange ?? null,
        },
      });
    }
    return NextResponse.json(json, { status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "backtest proxy error" },
      { status: 502 },
    );
  }
}
