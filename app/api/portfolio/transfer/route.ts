import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../../lib/superior-key";
import { fundsFrozen } from "../../../../lib/kill-switch";
import { transferBetweenAccounts } from "../../../../lib/superior-api";
import { track } from "../../../../lib/analytics";

export const runtime = "nodejs";

// Transfer — move USDC between two of the user's OWN Superior accounts. The
// funds never leave the user's custody (both endpoints are re-validated
// against their account list in transferBetweenAccounts), but it is real money
// movement, so it rides behind the same freeze guard as withdrawals.
//
// POST /api/portfolio/transfer  { from, to, amount }  -> execute the transfer

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

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

  let body: { from?: string; to?: string; amount?: number | string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const from = String(body.from ?? "").trim();
  const to = String(body.to ?? "").trim();
  const amount = Number(body.amount);
  if (!ADDR_RE.test(from) || !ADDR_RE.test(to)) {
    return NextResponse.json({ error: "from/to must be valid addresses" }, { status: 400 });
  }
  if (from.toLowerCase() === to.toLowerCase()) {
    return NextResponse.json({ error: "from and to are the same account" }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  }

  const result = await transferBetweenAccounts(key, from, to, amount);
  track("transfer_executed", {
    user: user.did,
    props: { from, to, amount, ok: result.ok, detail: result.detail },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.detail }, { status: 400 });
  }
  return NextResponse.json({ ok: true, detail: result.detail });
}
