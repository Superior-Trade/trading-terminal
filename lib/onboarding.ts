// Account bootstrap: turn a freshly-logged-in Privy user into a Superior
// account that /v2/account can see.
//
// The gap this closes: terminal-v2 mints an API key via apps/api, but a new
// user may not yet have the API DB user row + Privy wallet slots that
// /v2/account lists. This calls the API's idempotent bootstrap endpoint
// server-to-server so the browser never needs direct cross-origin access.

const API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

export interface OnboardResult {
  ok: boolean;
  /** The provisioned/existing trading wallet address, when known. */
  walletAddress?: string | null;
  /** True when a wallet was created on THIS call (caller should refresh balances). */
  created?: boolean;
  /** Which step failed, for logging (never surfaced to the user verbatim). */
  step?: "bootstrap";
}

/**
 * Ensure the caller has an API DB user row + a trading wallet.
 * `bearer` is the caller's Privy access token (from the incoming request).
 */
export async function ensureOnboarded(bearer: string): Promise<OnboardResult> {
  try {
    const res = await fetch(`${API_BASE}/v2/account/bootstrap`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return { ok: false, step: "bootstrap" };
    const body = (await res.json().catch(() => ({}))) as {
      walletAddress?: string | null;
      privyWalletAddress?: string | null;
      created?: boolean;
    };
    return {
      ok: true,
      walletAddress: body.walletAddress ?? body.privyWalletAddress ?? null,
      created: Boolean(body.created),
    };
  } catch {
    return { ok: false, step: "bootstrap" };
  }
}
