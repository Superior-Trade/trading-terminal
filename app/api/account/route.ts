import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../lib/superior-key";


export const runtime = "nodejs";

const API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

// GET /api/account              -> trading accounts (wallet addresses)
// GET /api/account?deposit=1    -> full deposit payload for the primary
//                                  trading wallet: { wallet_address, token,
//                                  chain_id, links: { eip681, metamask… } }
//
// The API deposit-link surface was removed. For the inline Hyperliquid
// deposit panel, resolve the user's trading wallet and build the Arbitrum
// USDC payload directly.
export async function GET(req: Request) {
  let apiKey: string;
  try {
    ({ key: apiKey } = await resolveSuperiorAuth(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const deposit = new URL(req.url).searchParams.get("deposit");
  try {
    if (!deposit) {
      const res = await fetch(`${API_BASE}/v2/account`, {
        headers: { "x-api-key": apiKey },
      });
      const json = await res.json().catch(() => ({}));
      return NextResponse.json(json, { status: res.status });
    }

    // Deposit payload for the TRADING wallet. HL deposits go to this wallet
    // first and are then moved on-exchange via
    // POST /v2/portfolio/hyperliquid/deposit. Token/chain are constants, so
    // we build the payload directly.
    const acctRes = await fetch(`${API_BASE}/v2/account`, {
      headers: { "x-api-key": apiKey },
    });
    const acct = (await acctRes.json().catch(() => ({}))) as {
      items?: Array<{ wallet_address?: string; name?: string }>;
    };
    const wallet = acct.items?.[0]?.wallet_address;
    if (!acctRes.ok || !wallet) {
      return NextResponse.json(
        { error: "no trading wallet for this account" },
        { status: acctRes.ok ? 404 : acctRes.status },
      );
    }
    const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // native Arbitrum USDC
    return NextResponse.json({
      wallet_address: wallet,
      account_name: acct.items?.[0]?.name ?? null,
      chain: "arbitrum",
      chain_id: 42161,
      token: { symbol: "USDC", address: USDC, decimals: 6 },
      eip681: `ethereum:pay-${USDC}@42161/transfer?address=${wallet}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "proxy error" },
      { status: 502 },
    );
  }
}
