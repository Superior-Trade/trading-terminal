import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../../lib/superior-key";

export const runtime = "nodejs";
// Never cache — this mutates on-exchange account state (agent wallet + builder).
export const dynamic = "force-dynamic";

const API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

// POST /api/onboarding/venue
// Makes the user's PRIMARY trading wallet Hyperliquid-tradeable: agent wallet
// approved + builder fee set. Mirrors the v1 auto-onboarding (PR #601):
// check status, and only if it reports not-ready do we call the idempotent
// bootstrap. The CALLER gates this behind a positive balance — HL onboarding
// before any funds is pointless (and #601 gates it the same way). Both upstream
// calls are idempotent, so a retry after a partial failure is safe.
//
// Returns { ready: boolean, onboarded: boolean } (onboarded = a bootstrap call
// was made this request) or an error with the upstream status.
export async function POST(req: Request) {
  let apiKey: string;
  try {
    ({ key: apiKey } = await resolveSuperiorAuth(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const headers = { "x-api-key": apiKey };

  try {
    // Primary trading wallet.
    const acctRes = await fetch(`${API_BASE}/v2/account`, { headers });
    const acct = (await acctRes.json().catch(() => ({}))) as {
      items?: Array<{ wallet_address?: string }>;
    };
    const wallet = acct.items?.[0]?.wallet_address;
    if (!wallet) {
      // No trading wallet yet — bootstrap (POST /api/onboarding) has to run
      // first. Not an error the caller should retry-spam.
      return NextResponse.json(
        { ready: false, error: "no_trading_wallet" },
        { status: 409 },
      );
    }
    const addr = encodeURIComponent(wallet);

    // Already Hyperliquid-ready? A 200 status means agent wallet + builder are
    // set — nothing to do.
    const statusRes = await fetch(
      `${API_BASE}/v3/account/${addr}/status/hyperliquid`,
      { headers },
    );
    if (statusRes.ok) {
      return NextResponse.json({ ready: true, onboarded: false });
    }
    // 400/404 = the venue reports needs-onboarding (agent_wallet_not_ready /
    // builder_not_configured). Any other status is a transient upstream issue —
    // don't fire the money-path bootstrap on those.
    if (statusRes.status !== 400 && statusRes.status !== 404) {
      return NextResponse.json(
        { ready: false, error: "status_unavailable" },
        { status: 502 },
      );
    }

    // Idempotent bootstrap: creates + approves the agent wallet and sets the
    // builder fee (handleHyperliquidAccountBootstrap upstream).
    const onboardRes = await fetch(`${API_BASE}/v3/account/${addr}/hyperliquid`, {
      method: "POST",
      headers,
    });
    const body = (await onboardRes.json().catch(() => ({}))) as {
      message?: string;
      onboarding?: { ready?: boolean };
    };
    if (!onboardRes.ok) {
      return NextResponse.json(
        { ready: false, error: body.message ?? "onboard_failed" },
        { status: onboardRes.status },
      );
    }
    return NextResponse.json({
      ready: body.onboarding?.ready ?? true,
      onboarded: true,
    });
  } catch (err) {
    return NextResponse.json(
      { ready: false, error: err instanceof Error ? err.message : "proxy_error" },
      { status: 502 },
    );
  }
}
