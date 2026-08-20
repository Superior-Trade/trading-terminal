import { NextResponse } from "next/server";
import { requireSuperiorAuth } from "../../../lib/account";
import { fundsFrozen } from "../../../lib/kill-switch";
import { track } from "../../../lib/analytics";
import {
  withdrawQuote,
  prepareHyperliquidWithdrawal,
  withdrawToSuperiorWallet,
  HL_WITHDRAW_FEE_USDC,
  MIN_WITHDRAW_USDC,
} from "../../../lib/superior-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Withdraw USDC from Hyperliquid to this account's Superior wallet on Arbitrum.
 *
 * This is the deposit dialog run backwards, and it is one hop, not two: the
 * money leaves trading and lands in the Superior wallet the API resolves from
 * your key. Sending it onward to a wallet you hold the keys for is a separate
 * step that deliberately requires a signed-in session — docs/withdrawals.md
 * explains why, and what to do.
 */
export async function GET() {
  let key: string;
  try {
    ({ key } = await requireSuperiorAuth());
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  try {
    const quote = await withdrawQuote(key);
    return NextResponse.json({
      availableUsd: quote.availableUsd,
      mainAvailableUsd: quote.mainAvailableUsd,
      mainAddress: quote.mainAddress,
      feeUsd: HL_WITHDRAW_FEE_USDC,
      minUsd: MIN_WITHDRAW_USDC,
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

  let key: string;
  let user: { id: string };
  try {
    ({ key, user } = await requireSuperiorAuth());
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as { amount?: unknown };
  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "a positive amount is required" }, { status: 400 });
  }
  // Truncate rather than round: never ask the venue for more than requested.
  const normalizedAmount = Math.floor(amount * 100) / 100;
  if (normalizedAmount < MIN_WITHDRAW_USDC) {
    return NextResponse.json(
      { error: `minimum withdrawal is $${MIN_WITHDRAW_USDC}` },
      { status: 400 },
    );
  }

  // Re-read the balance at execution time — never trust a client-supplied cap.
  let quote;
  try {
    quote = await withdrawQuote(key);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "quote failed" },
      { status: 502 },
    );
  }
  if (normalizedAmount > quote.availableUsd + 1e-9) {
    return NextResponse.json(
      {
        error: `amount exceeds your withdrawable balance ($${quote.availableUsd.toFixed(2)})`,
      },
      { status: 400 },
    );
  }

  // Only the main wallet can withdraw, so idle wallets are swept into it
  // first. This moves funds on-exchange and is safe to retry.
  const prepared = await prepareHyperliquidWithdrawal(key, normalizedAmount);
  if (!prepared.ok) {
    return NextResponse.json({ error: prepared.detail }, { status: 409 });
  }

  try {
    const result = await withdrawToSuperiorWallet(
      key,
      normalizedAmount,
      quote.mainAddress,
    );
    track("withdraw_succeeded", {
      user: user.id,
      props: { amount: normalizedAmount },
    });
    return NextResponse.json({
      ok: true,
      amount: result.amount,
      destination: result.destination,
      feeUsd: HL_WITHDRAW_FEE_USDC,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "withdrawal failed";
    track("withdraw_failed", {
      user: user.id,
      props: { amount: normalizedAmount, reason: detail.slice(0, 180) },
    });
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
