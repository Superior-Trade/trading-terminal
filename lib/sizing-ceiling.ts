/**
 * Deploy sizing and funding constants, shared by the panel (slider ceiling),
 * the server pre-flight (lib/superior-api) and the deploy route — one module
 * so the numbers cannot drift apart.
 *
 * The terminal caps with a 0.95 haircut; the API refuses anything whose
 * margin × FUNDING_BUFFER (1.05) exceeds what it can reach. Those are two
 * different constants aimed at the same gap — venue fees on top of the bare
 * margin. They are compatible (0.95·D ≤ D/1.05 ≈ 0.952·D), but only just.
 * sizing-ceiling.test.ts reads FUNDING_BUFFER out of the API source and
 * asserts the relationship still holds, so raising one without the other
 * fails a test instead of surfacing as a venue rejection.
 */
export const SIZING_HAIRCUT = 0.95;

/** The upstream API reserves stake × this before funding a deployment:
 *  Freqtrade's tradable_balance_ratio holds back 1% of the wallet and HL
 *  taker fees come out of the same balance — funding exactly the stake
 *  produces a bot that never trades. */
export const FUNDING_BUFFER = 1.05;

/** Minimum deployable stake: HL's $10 order value × the API's reserve,
 *  rounded up — upstream rejects less with "increase to at least $11". */
export const MIN_STAKE_USD = 11;

/** What a wallet must actually reach to fund the minimum stake. Anything
 *  below this cannot deploy at all — the panel shows a funding prompt
 *  instead of a slider whose only value is doomed. */
export const MIN_DEPLOYABLE_USD = neededForStakeUsd(MIN_STAKE_USD);

/** The marker phrase in the server-composed funding sentence; the client
 *  keys off it to open the deposit dialog and pass the text through
 *  verbatim (lib/superior-api's insufficientBalanceMessage ↔
 *  lib/setups-context's isServerFundingGuidance). */
export const DEPOSIT_GUIDANCE_PHRASE = "Add funds via the Deposit button";

/** Reachable funds a stake needs to clear the upstream reserve. */
export function neededForStakeUsd(stakeUsd: number): number {
  return Math.ceil(stakeUsd * FUNDING_BUFFER * 100) / 100;
}

/**
 * The largest stake the panel may offer for a given deployable balance, or
 * null when the balance cannot fund even the minimum stake (with its
 * reserve) — the caller should prompt for a deposit rather than offer $11.
 *
 * Any stake in [MIN_STAKE_USD, maxStakeFor(D)] passes the funding
 * pre-flight by construction: the haircut already divides out the reserve
 * (stake × 1.05 ≤ D × 0.95 × 1.05 < D), and the floor case requires
 * D ≥ MIN_DEPLOYABLE_USD up front.
 */
export function maxStakeFor(deployableUsd: number): number | null {
  if (deployableUsd < MIN_DEPLOYABLE_USD) return null;
  return Math.max(MIN_STAKE_USD, Math.floor(deployableUsd * SIZING_HAIRCUT));
}

/** Restore a persisted funds value: clamp under-minimum values up to the
 *  floor (the live-balance ceiling clamps the other side once it loads);
 *  null for anything non-numeric. */
export function clampPersistedStake(funds: unknown): number | null {
  return typeof funds === "number" && Number.isFinite(funds)
    ? Math.max(MIN_STAKE_USD, funds)
    : null;
}

/** Deployment states whose stake counts as committed capital on a wallet.
 *  Terminal states (stopped/deleted/failed) commit nothing — their balance
 *  is idle until a restart re-funds it. */
export const COMMITTED_DEPLOY_STATES = ["running", "deployed", "pending"];

export interface DeployableWalletFunds {
  /** Free margin already on the venue; null when unknown. */
  withdrawableUsd: number | null;
  /** Un-deployed on-chain USDC (hold model) — counted for the main wallet
   *  only, which is the account allocate-on-deploy bridges from. */
  heldUsd?: number | null;
  isMain: boolean;
  /** Capital committed to live strategies on this wallet. Absent/0 = none;
   *  null = a live strategy whose stake is unreadable, which treats the
   *  whole wallet as spoken for rather than guessed at. */
  committedUsd?: number | null;
}

/**
 * Deployable funds = Σ over wallets of max(0, withdrawable − committed),
 * plus the main wallet's held USDC.
 *
 * Committed, NOT occupied: zeroing any wallet that hosts a live strategy
 * collapses a $200 account running a $12 strategy to nothing, while
 * counting full balances offers the same money twice. Occupancy stays a
 * yes/no only for placement. This is the single source of truth for the
 * sizing-slider ceiling, the restart guard AND the server's deploy
 * pre-flight — the slider must never advertise a stake the pre-flight
 * rejects. Null while the main balance is entirely unknown.
 */
export function deployableFundsUsd(
  wallets: DeployableWalletFunds[],
): number | null {
  const main = wallets.find((w) => w.isMain) ?? null;
  const mainHeld = main?.heldUsd ?? null;
  if ((main?.withdrawableUsd ?? null) === null && mainHeld === null) return null;
  const free = (w: DeployableWalletFunds) => {
    if (w.withdrawableUsd === null) return 0;
    if (w.committedUsd === null) return 0;
    return Math.max(0, w.withdrawableUsd - (w.committedUsd ?? 0));
  };
  const total = wallets.reduce((s, w) => s + free(w), 0) + (mainHeld ?? 0);
  return Math.floor(total * 100) / 100;
}
