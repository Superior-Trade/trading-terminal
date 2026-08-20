import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../../lib/superior-key";
import { fundsFrozen } from "../../../../lib/kill-switch";
import { walletOverview, consolidateIdleToMain } from "../../../../lib/superior-api";
import { track } from "../../../../lib/analytics";

export const runtime = "nodejs";

// Consolidate — sweep every IDLE trading account's free margin back to the
// MAIN funding wallet in one pass. Funds stay inside the user's own accounts
// (never leave custody), but this is real money movement, so it rides behind
// the same freeze guard as withdrawals.
//
// GET  /api/portfolio/consolidate  -> quote: sweepable total + idle count
// POST /api/portfolio/consolidate  -> execute the sweep

export async function GET(req: Request) {
  const frozen = fundsFrozen("withdraw");
  if (frozen) return frozen;
  let key;
  try {
    ({ key } = await resolveSuperiorAuth(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  try {
    const wallets = await walletOverview(key);
    const idle = wallets.filter(
      (w) => !w.isMain && !w.occupied && (w.withdrawableUsd ?? 0) >= 1,
    );
    return NextResponse.json({
      sweepableUsd:
        Math.floor(idle.reduce((s, w) => s + (w.withdrawableUsd as number), 0) * 100) /
        100,
      idleCount: idle.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "quote failed" },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  const frozen = fundsFrozen("withdraw");
  if (frozen) return frozen;
  let user, key;
  try {
    ({ user, key } = await resolveSuperiorAuth(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const result = await consolidateIdleToMain(key);
  track("consolidate_executed", {
    user: user.did,
    props: { movedUsd: result.movedUsd, count: result.count, detail: result.detail },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.detail }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    movedUsd: result.movedUsd,
    count: result.count,
    detail: result.detail,
  });
}
