import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../../lib/superior-key";
import { track } from "../../../../lib/analytics";
import { fundsFrozen } from "../../../../lib/kill-switch";

export const runtime = "nodejs";

const API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// POST /api/portfolio/hl-deposit { amount: "12.5", from?: "0x…" }
// Moves native Arbitrum USDC already sitting on the trading wallet INTO
// Hyperliquid (Superior's /v2/portfolio/hyperliquid/deposit). Final step of
// the inline crypto deposit flow — the dialog calls this automatically when
// it detects the on-chain arrival.
export async function POST(req: Request) {
  const frozen = fundsFrozen("deposit");
  if (frozen) return frozen;
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
    const body = (await req.json()) as { amount?: string; from?: string };
    if (typeof body.amount !== "string" || !body.amount) {
      return NextResponse.json({ error: "amount required" }, { status: 400 });
    }
    const res = await fetch(`${API_BASE}/v2/portfolio/hyperliquid/deposit`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: "arbitrum",
        asset_address: ARB_USDC,
        amount: body.amount,
        ...(body.from ? { from: body.from } : {}),
      }),
    });
    const json = await res.json().catch(() => ({}));
    // The money moment of the funnel — track credit success/failure with the
    // server-verified amount, not a client claim.
    track(res.ok ? "deposit_credited" : "deposit_credit_failed", {
      user: userDid,
      props: {
        amount: body.amount,
        status: res.status,
        wallet: body.from,
        ...(res.ok
          ? {}
          : {
              error: String(
                (json as { message?: unknown; error?: unknown }).message ??
                  (json as { error?: unknown }).error ??
                  "",
              ).slice(0, 300),
            }),
      },
    });
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "proxy error" },
      { status: 502 },
    );
  }
}
