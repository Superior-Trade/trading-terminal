import { NextResponse } from "next/server";
import { requireUser, bearerFrom } from "../../../lib/server-auth";
import { ensureOnboarded } from "../../../lib/onboarding";

export const runtime = "nodejs";
// Never cache — this provisions per-user account state.
export const dynamic = "force-dynamic";

// POST /api/onboarding
// Ensures the logged-in user has a terminal-DB user row + trading wallet, so
// GET /v2/account stops returning {items:[]} (which renders "--"). Called once
// per session by AuthBridge after login. Idempotent + best-effort: a failure
// is reported but not fatal — the balance poll will keep retrying.
export async function POST(req: Request) {
  let bearer: string | null;
  try {
    // Establishes the identity (401 if unauthenticated/invalid token).
    await requireUser(req);
    bearer = bearerFrom(req);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  // Provisioning a trading account for a brand-new sign-in needs that user's
  // own Privy access token. Local mode has no bearer and needs none — its
  // account already exists behind the SUPERIOR_TRADE_API_KEY you configured —
  // so skip cleanly rather than treating it as a failure.
  if (!bearer) {
    return NextResponse.json({ ok: false, skipped: true });
  }

  const result = await ensureOnboarded(bearer);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
