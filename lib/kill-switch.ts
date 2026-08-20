import { NextResponse } from "next/server";

// Funds "kill switch" — an operator freeze for money movement, independent of
// shipping code. Set the relevant env var to a truthy value ("1"/"true"/"on")
// and the matching funds routes reject with 503 until it's cleared. Use it to
// stop the bleeding the instant a deposit/withdrawal/ledger anomaly shows up,
// then investigate. `FREEZE_ALL` trips every category at once.
//
// On Vercel, env changes take effect on the next deployment — pair this with an
// Instant Rollback / redeploy to flip it in seconds. (A zero-deploy toggle via
// an Edge Config / DB flag is a deliberate follow-up; this env version is the
// safe, low-risk v1.)

export type FundsAction = "withdraw" | "deposit" | "trade";

const TRUTHY = new Set(["1", "true", "on", "yes", "frozen"]);
const isSet = (v: string | undefined) =>
  typeof v === "string" && TRUTHY.has(v.trim().toLowerCase());

const ENV_FOR: Record<FundsAction, string> = {
  withdraw: "FREEZE_WITHDRAWALS",
  deposit: "FREEZE_DEPOSITS",
  trade: "FREEZE_TRADING",
};

/** True when the given money-movement category is currently frozen. */
export function isFundsFrozen(action: FundsAction): boolean {
  return isSet(process.env.FREEZE_ALL) || isSet(process.env[ENV_FOR[action]]);
}

/**
 * Guard for funds routes. Returns a 503 NextResponse when the action is frozen,
 * or null to proceed. Call it right after auth, before touching any funds.
 *
 *   const frozen = fundsFrozen("withdraw");
 *   if (frozen) return frozen;
 */
export function fundsFrozen(action: FundsAction): NextResponse | null {
  if (!isFundsFrozen(action)) return null;
  return NextResponse.json(
    {
      error:
        "This action is temporarily paused for maintenance. Your funds are safe. Please try again shortly.",
      frozen: action,
    },
    { status: 503, headers: { "Retry-After": "300" } },
  );
}
