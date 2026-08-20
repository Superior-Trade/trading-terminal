// Superior Trade upstream calls, shared by the proxy routes AND the agent
// tools (backtest_run / deploy_strategy / pnl_check). Every function takes
// the caller's resolved API key — auth stays at the route/tool boundary.

import { ARB_USDC } from "./arbitrum";

export const SUPERIOR_API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

function headers(key: string): Record<string, string> {
  return { "Content-Type": "application/json", "x-api-key": key };
}

/** Fill required Freqtrade config fields models tend to omit and strip
 *  upstream-controlled ones (dry_run). Model/caller values win where set.
 *  Applied on EVERY submit path (agent tools + deploy button). */
export function withConfigDefaults(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const exchange = (config.exchange ?? {}) as Record<string, unknown>;
  const orderTypes = (config.order_types ?? {}) as Record<string, unknown>;
  const rest = { ...config };
  delete rest.dry_run; // upstream-controlled; validation rejects it
  return {
    stake_currency: "USDC",
    stake_amount: "unlimited",
    dry_run_wallet: { USDC: 1000 },
    max_open_trades: 1,
    trading_mode: "futures",
    margin_mode: "isolated",
    pairlists: [{ method: "StaticPairList" }],
    // Overridable default: cancel stale unfilled orders instead of letting
    // a limit order fill a candle later at a plan-invalid price.
    unfilledtimeout: { entry: 5, exit: 5, exit_timeout_count: 3, unit: "minutes" },
    ...rest,
    exchange: { name: "hyperliquid", ...exchange },
    // ── Forced safety rails (NOT overridable by generated configs) ──
    // The stop lives ON the exchange: a bot-emulated stop dies with the pod
    // and leaves a naked leveraged position. HL supports stop-loss-limit.
    order_types: {
      entry: "market",
      exit: "market",
      ...orderTypes,
      stoploss: "limit",
      stoploss_on_exchange: true,
      stoploss_on_exchange_interval: 60,
    },
    // Market orders REQUIRE price_side "other" (validator-enforced) — the
    // taker side of the book is what a market order actually crosses.
    entry_pricing: {
      ...((config.entry_pricing as Record<string, unknown>) ?? {}),
      price_side: "other",
    },
    exit_pricing: {
      ...((config.exit_pricing as Record<string, unknown>) ?? {}),
      price_side: "other",
    },
    // Exit-flag foot-guns: exit_profit_only silently mutes exit signals
    // while underwater; ignore_roi_if_entry_signal overrides take-profit.
    use_exit_signal: true,
    exit_profit_only: false,
    exit_profit_offset: 0.0,
    ignore_roi_if_entry_signal: false,
  };
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** POST /v2/backtesting + auto-start. Returns upstream JSON + status. */
export async function submitBacktest(
  key: string,
  body: { config?: Record<string, unknown> } & Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body.config
    ? { ...body, config: withConfigDefaults(body.config) }
    : body;
  const res = await fetch(`${SUPERIOR_API_BASE}/v2/backtesting`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(payload),
  });
  const json = await jsonOf(res);
  const id = json.id as string | undefined;
  if (res.ok && id) {
    await fetch(`${SUPERIOR_API_BASE}/v2/backtesting/${id}/status`, {
      method: "PUT",
      headers: headers(key),
      body: JSON.stringify({ action: "start" }),
    }).catch(() => {});
  }
  return { status: res.status, json };
}

/** GET /v2/backtesting/:id — status + results when completed. */
export async function getBacktest(
  key: string,
  id: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(
    `${SUPERIOR_API_BASE}/v2/backtesting/${encodeURIComponent(id)}`,
    { headers: headers(key) },
  );
  return { status: res.status, json: await jsonOf(res) };
}

/** Backtest results with the resultUrl fallback. Upstream leaves the
 *  `results` column null and uploads freqtrade's output to GCS behind a
 *  signed `resultUrl` (2026-07-10 generation audit: every completed
 *  backtest had results:null — the agent tool and the chat card were
 *  reporting empty numbers off real runs). Normalizes both blob shapes
 *  (flat freqtrade output / {strategy:{<Name>:{…}}}) into the fields the
 *  UI expects. Null when nothing is readable. */
export async function resolveBacktestResults(
  bt: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (bt.results && typeof bt.results === "object") {
    return bt.results as Record<string, unknown>;
  }
  const url = bt.resultUrl;
  if (typeof url !== "string" || !url) return null;
  try {
    const blob = (await fetch(url).then((r) => r.json())) as Record<string, unknown>;
    const s =
      blob?.strategy && typeof blob.strategy === "object"
        ? (Object.values(blob.strategy as Record<string, unknown>)[0] as Record<string, unknown>)
        : blob;
    if (!s || typeof s !== "object") return null;
    const wins = typeof s.wins === "number" ? s.wins : null;
    const totalTrades = typeof s.total_trades === "number" ? s.total_trades : null;
    return {
      ...s,
      profit_total_pct:
        s.profit_total_pct ??
        (typeof s.profit_total === "number"
          ? Math.round(s.profit_total * 10000) / 100
          : null),
      winrate:
        s.winrate ??
        (wins !== null && totalTrades ? wins / totalTrades : null),
      max_drawdown_account: s.max_drawdown_account ?? null,
    };
  } catch {
    return null;
  }
}

export interface DeployResult {
  status: number;
  json: Record<string, unknown>;
  steps: Record<string, number>;
  stepErrors: Record<string, string>;
}

/** Wallets held by a LIVE deployment. Stopping now releases the account
 *  upstream, so a stopped or deleted deployment no longer occupies its wallet
 *  and must not be filtered out here — reading deployment history instead
 *  treated every wallet ever used as permanently taken. */
async function linkedWallets(key: string): Promise<Set<string>> {
  const deps = await listDeployments(key).catch(() => null);
  return new Set(
    (
      (deps?.json?.items ?? []) as Array<{
        status?: string;
        deletedAt?: string | null;
        exchange?: string | null;
        walletAddress?: string | null;
      }>
    )
      .filter((d) => deploymentOccupiesExchange(d, "hyperliquid"))
      .map((d) => d.walletAddress?.toLowerCase())
      .filter(Boolean) as string[],
  );
}

/** HL withdrawable USDC for a wallet — null on failure (unknown, don't
 *  assume unfunded). */
async function hlWithdrawable(address: string): Promise<number | null> {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address }),
    });
    const j = (await res.json()) as { withdrawable?: string };
    const n = parseFloat(j.withdrawable ?? "");
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Held (un-deployed) native Arbitrum USDC in a wallet — read on-chain via the
// public RPC (server-side sibling of lib/arbitrum.ts's usdcBalanceAtoms). Under
// the hold model (#903) deposits park here until a deploy allocates them into
// the venue, so the AGENT must count this as deployable — otherwise the AI sees
// only the (empty) Hyperliquid balance and refuses to deploy a funded account.
async function heldUsdcOnChain(address: string): Promise<number | null> {
  try {
    const data = `0x70a08231${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
    const res = await fetch("https://arb1.arbitrum.io/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: ARB_USDC, data }, "latest"],
      }),
    });
    const j = (await res.json()) as { result?: string };
    if (!j.result || !j.result.startsWith("0x")) return null;
    return Number(BigInt(j.result)) / 1e6;
  } catch {
    return null;
  }
}

/** Sweep a trading account's free margin back to the MAIN wallet (via the
 *  wallet-to-wallet transfer endpoint). Used when an execution frees its
 *  wallet — deployment deleted, one-shot auto-stopped — so capital returns
 *  to the funding pool instead of stranding on the account. No-ops for the
 *  main wallet itself, dust (<$1), or on any failure (best-effort). */
export async function sweepWalletToMain(
  key: string,
  wallet: string,
): Promise<string | null> {
  try {
    const acct = await fetch(`${SUPERIOR_API_BASE}/v2/account`, {
      headers: headers(key),
    });
    const items = ((await jsonOf(acct)).items ?? []) as Array<{
      account_index?: number;
      wallet_address?: string;
    }>;
    const main = items.find((a) => (a.account_index ?? 1) === 1)?.wallet_address;
    if (!main || main.toLowerCase() === wallet.toLowerCase()) return null;
    const avail = await hlWithdrawable(wallet);
    if (avail === null || avail < 1) return null;
    const amt = Math.floor(avail * 100) / 100;
    const res = await fetch(
      `${SUPERIOR_API_BASE}/v2/portfolio/hyperliquid/transfer`,
      {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({ from: wallet, to: main, amount: String(amt) }),
      },
    );
    return res.ok ? String(amt) : null;
  } catch {
    return null;
  }
}

/** Hyperliquid's flat withdrawal fee (USDC, deducted from the amount). */
export const HL_WITHDRAW_FEE_USDC = 1;
/** Product minimum — withdrawing less than 2× the fee is a footgun. */
export const MIN_WITHDRAW_USDC = 2;

export interface WithdrawQuote {
  /** Free margin on the MAIN wallet (withdraw source). */
  mainAvailableUsd: number;
  /** Main + idle (unoccupied) trading wallets — reachable via sweeps. */
  availableUsd: number;
  mainAddress: string | null;
}

/** What the user can withdraw right now: main wallet free margin plus every
 *  idle trading wallet's (sweepable to main first). Occupied wallets are a
 *  running execution's budget — never drained by a withdrawal. */
export async function withdrawQuote(key: string): Promise<WithdrawQuote> {
  const wallets = await walletOverview(key);
  const main = wallets.find((w) => w.isMain) ?? null;
  const mainAvail = main?.withdrawableUsd ?? 0;
  const idleSum = wallets
    .filter((w) => !w.isMain && !w.occupied && (w.withdrawableUsd ?? 0) > 0)
    .reduce((s, w) => s + (w.withdrawableUsd as number), 0);
  return {
    mainAvailableUsd: Math.floor(mainAvail * 100) / 100,
    availableUsd: Math.floor((mainAvail + idleSum) * 100) / 100,
    mainAddress: main?.address ?? null,
  };
}

/** Stage a withdrawal by sweeping idle trading wallets into the account's main
 *  Superior wallet on Hyperliquid, which is the only wallet the venue
 *  withdrawal below can draw from. Occupied wallets are never touched — a
 *  running strategy keeps its budget. */
export async function prepareHyperliquidWithdrawal(
  key: string,
  amountUsd: number,
): Promise<{ ok: boolean; detail: string }> {
  const amt = Math.floor(amountUsd * 100) / 100;
  if (!(amt >= MIN_WITHDRAW_USDC)) {
    return { ok: false, detail: `minimum withdrawal is ${MIN_WITHDRAW_USDC} USDC` };
  }
  const wallets = await walletOverview(key);
  const main = wallets.find((w) => w.isMain);
  if (!main) return { ok: false, detail: "no main wallet on this account" };
  let mainAvail = main.withdrawableUsd ?? 0;

  // Sweep idle wallets → main until main covers the amount (richest first,
  // fewest transfers). Occupied wallets are never touched — a running
  // execution keeps its budget.
  if (mainAvail < amt) {
    const sources = wallets
      .filter((w) => !w.isMain && !w.occupied && (w.withdrawableUsd ?? 0) > 0.01)
      .sort((a, b) => (b.withdrawableUsd ?? 0) - (a.withdrawableUsd ?? 0));
    for (const src of sources) {
      if (mainAvail >= amt) break;
      const move =
        Math.floor(Math.min(src.withdrawableUsd ?? 0, amt - mainAvail) * 100) / 100;
      if (move <= 0) continue;
      const res = await fetch(`${SUPERIOR_API_BASE}/v2/portfolio/hyperliquid/transfer`, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({ from: src.address, to: main.address, amount: String(move) }),
      });
      if (res.ok) mainAvail += move;
    }
    // Re-read main: transfers land on-exchange near-instantly, but trust
    // the venue's number over our arithmetic before moving real funds out.
    const confirmed = await hlWithdrawable(main.address);
    if (confirmed !== null) mainAvail = confirmed;
    if (mainAvail < amt) {
      return {
        ok: false,
        detail: `only $${mainAvail.toFixed(2)} reachable — running strategies keep their own budget`,
      };
    }
  }

  return {
    ok: true,
    detail: `prepared $${amt.toFixed(2)} in the main Superior trading wallet`,
  };
}

export interface WithdrawResult {
  /** Where the USDC landed — the account's own Superior wallet on Arbitrum. */
  destination: string | null;
  /** Hyperliquid wallet the funds left. */
  from: string | null;
  amount: string;
}

/**
 * Move USDC off Hyperliquid into this account's Superior wallet on Arbitrum.
 *
 * The destination is resolved by the API from the API key, not sent by us: the
 * endpoint rejects a client-supplied external address outright (403). That is
 * deliberate on their side, and it is the reason this is a one-hop withdrawal
 * rather than a cash-out — see docs/withdrawals.md for how the money leaves
 * the Superior wallet afterwards.
 *
 * Hyperliquid charges its own fee and the transfer takes a few minutes to
 * arrive on Arbitrum.
 */
export async function withdrawToSuperiorWallet(
  key: string,
  amountUsd: number,
  from?: string | null,
): Promise<WithdrawResult> {
  const amount = (Math.floor(amountUsd * 100) / 100).toFixed(2);
  const res = await fetch(`${SUPERIOR_API_BASE}/v3/portfolio/hyperliquid/withdraw`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({
      chain: "arbitrum",
      asset_address: ARB_USDC,
      amount,
      ...(from ? { from } : {}),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    destination?: string;
    wallet_address?: string;
    amount?: string;
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(json.message || json.error || `withdrawal failed (${res.status})`);
  }
  return {
    destination: json.destination ?? null,
    from: json.wallet_address ?? from ?? null,
    amount: json.amount ?? amount,
  };
}

/** Wallet a deployment ran on, from history (which retains deleted rows). */
export async function walletOfDeployment(
  key: string,
  deploymentId: string,
): Promise<string | null> {
  try {
    const hist = await deploymentHistory(key);
    const item = (
      (hist.json as { items?: Array<{ deploymentId?: string | null; walletAddress?: string | null }> })
        .items ?? []
    ).find((s) => s.deploymentId === deploymentId && s.walletAddress);
    return item?.walletAddress ?? null;
  } catch {
    return null;
  }
}

/** Wallets held by CURRENT (non-deleted) deployments: history retains
 *  deleted deployments, so intersect its wallets with the live deployment
 *  ids — this is the accurate "occupied" set (matches the sizing slider). */
// A deployment only occupies its wallet's CAPITAL while it can still trade.
// Terminal states (stopped/deleted/failed/…) hold no position and won't act
// until restarted (which re-funds from main), so their wallet's free margin
// is idle and may be swept/transferred. Unknown statuses default to occupied
// (fail safe — never free a wallet we're unsure about). NOTE: this is distinct
// from linkedWallets, which stays any-status because it guards the upstream
// credentials secret for deploy PLACEMENT, not capital.
const TERMINAL_DEPLOY_STATUS =
  /stopped|deleted|failed|error|cancel|complete|closed|done|expired|archiv/i;

type DeploymentOccupancyRow = {
  id?: string | null;
  status?: string | null;
  exchange?: string | null;
  deletedAt?: string | null;
  walletAddress?: string | null;
};

function deploymentExchangeName(deployment: Pick<DeploymentOccupancyRow, "exchange">): string {
  return (deployment.exchange ?? "hyperliquid").toLowerCase();
}

export function deploymentOccupiesExchange(
  deployment: Pick<DeploymentOccupancyRow, "deletedAt" | "status" | "exchange">,
  exchange: string,
): boolean {
  return (
    !deployment.deletedAt &&
    !TERMINAL_DEPLOY_STATUS.test(deployment.status ?? "") &&
    deploymentExchangeName(deployment) === exchange.toLowerCase()
  );
}

async function occupiedWalletsUpstream(
  key: string,
  exchange = "hyperliquid",
): Promise<Set<string>> {
  try {
    const [deps, hist] = await Promise.all([
      listDeployments(key),
      deploymentHistory(key),
    ]);
    const current = new Set(
      ((deps.json.items ?? []) as DeploymentOccupancyRow[])
        .filter((d) => d.id && deploymentOccupiesExchange(d, exchange))
        .map((d) => d.id) as string[],
    );
    const occupied = new Set<string>();
    for (const s of ((hist.json as { items?: Array<{ deploymentId?: string | null; walletAddress?: string | null }> }).items ?? [])) {
      if (s.deploymentId && s.walletAddress && current.has(s.deploymentId)) {
        occupied.add(s.walletAddress.toLowerCase());
      }
    }
    return occupied;
  } catch {
    return new Set();
  }
}

/** Top a trading account up to the stake, pulling from the MAIN wallet
 *  first and then from other IDLE trading accounts (richest first) via the
 *  wallet-to-wallet transfer endpoint — this is what makes the sizing
 *  slider's "main + all idle accounts" ceiling actually deployable onto one
 *  wallet. Returns the total moved ("0" when already funded), or null when
 *  funding failed — best-effort: the deployment proceeds either way. */
async function fundWallet(
  key: string,
  destination: string,
  stakeUsd: number,
  accounts: Array<{ account_index?: number; wallet_address?: string }>,
): Promise<string | null> {
  const balance = await hlWithdrawable(destination);
  if (balance === null) return null;
  // 5% over the stake: Freqtrade's tradable_balance_ratio (default 0.99)
  // reserves 1% of the wallet, and HL taker fees (0.045% of NOTIONAL, so
  // leverage-scaled — ~3.6% of stake round-trip at 40x) come out of the
  // same balance. Funding exactly the stake = a bot that never trades.
  let need = Math.ceil(Math.max(0, stakeUsd * 1.05 - balance) * 100) / 100;
  if (need <= 0) return "0";

  const occupied = await occupiedWalletsUpstream(key);
  const main = accounts.find((a) => (a.account_index ?? 1) === 1)?.wallet_address;
  const otherIdle = accounts
    .filter(
      (a) =>
        a.wallet_address &&
        (a.account_index ?? 1) !== 1 &&
        a.wallet_address.toLowerCase() !== destination.toLowerCase() &&
        !occupied.has(a.wallet_address.toLowerCase()),
    )
    .map((a) => a.wallet_address as string);
  // Main first (it's the funding pool), then idle accounts richest-first.
  const otherBalances = await Promise.all(otherIdle.map((w) => hlWithdrawable(w)));
  const sources = [
    ...(main && main.toLowerCase() !== destination.toLowerCase() ? [main] : []),
    ...otherIdle
      .map((w, i) => ({ w, b: otherBalances[i] ?? 0 }))
      .sort((x, y) => y.b - x.b)
      .map((x) => x.w),
  ];

  let moved = 0;
  for (const from of sources) {
    if (need <= 0) break;
    const avail = (await hlWithdrawable(from)) ?? 0;
    const amt = Math.floor(Math.min(need, avail) * 100) / 100;
    if (amt <= 0) continue;
    try {
      const res = await fetch(
        `${SUPERIOR_API_BASE}/v2/portfolio/hyperliquid/transfer`,
        {
          method: "POST",
          headers: headers(key),
          body: JSON.stringify({ from, to: destination, amount: String(amt) }),
        },
      );
      if (res.ok) {
        moved += amt;
        need = Math.ceil((need - amt) * 100) / 100;
      }
    } catch {
      /* try the next source */
    }
  }
  return moved > 0 ? String(Math.round(moved * 100) / 100) : need <= 0 ? "0" : null;
}

export function deployableHyperliquidUsd(
  withdrawableUsd: number | null,
  heldUsd: number | null,
  isMain: boolean,
): number | null {
  return withdrawableUsd === null && heldUsd === null
    ? null
    : (withdrawableUsd ?? 0) + (isMain ? (heldUsd ?? 0) : 0);
}

/** Trading-account fallback for a busy main wallet (the CURRENT concurrency
 *  model: one execution per wallet, extra executions go on trading account
 *  2/3). Tries credentials with each OTHER trading account in index order
 *  until one sticks — upstream's duplicate check is the source of truth for
 *  "occupied" (deployment history would wrongly flag freed wallets forever).
 *  A numeric stake is then auto-topped-up from the main wallet, since
 *  nothing upstream funds the account and an unfunded bot silently never
 *  trades. */
/** Finish Hyperliquid setup on a trading account so it can actually trade.
 *
 *  A terminal user has no way to know an onboarding endpoint exists, so a
 *  second account sits unusable and every deploy piles onto the first. This
 *  runs it for them — but the ORDER matters. Bootstrap is attempted BEFORE any
 *  funding, because its error distinguishes the two cases:
 *
 *    account_not_funded_on_hyperliquid  -> repairable: fund, then retry
 *    anything else (e.g. wrong Privy owner) -> NOT repairable: never fund it
 *
 *  Funding first would mean sending money to an account that may be unable to
 *  sign it back out, which is precisely how a live account ended up with $105
 *  stranded on it.
 *
 *  Returns true when the account is ready to take credentials. */
/**
 * Could finishing Hyperliquid setup plausibly fix this credentials failure?
 *
 * Asked as "is repair ruled out", not "is repair indicated". The previous
 * version tested for agent_wallet_not_ready / wallet_not_ready /
 * not_onboarded — none of which the credentials route returns. Its code for a
 * spare account with no agent wallet is `no_agent_wallet`, and
 * agent_wallet_not_ready comes from a DIFFERENT route entirely. So the branch
 * never ran: accounts that needed exactly this repair were reported as
 * unusable instead.
 *
 * That is the third time an enumerated list of the other service's error codes
 * has silently gone stale — wallet_occupied missing from the busy set, then
 * the deposit-dialog test, now this. Enumerating the failures repair CAN fix
 * means every new code defaults to "give up". Enumerating the ones it CANNOT
 * means a new code defaults to "try the repair", which costs one idempotent
 * bootstrap call and self-corrects on the retry.
 */
export const SETUP_CANNOT_FIX = new Set([
  // The account is taken. More setup does not free it.
  "wallet_occupied",
  "duplicate_wallet_address",
  // Not ours to set up, or we could not establish that it is.
  "wallet_not_owned",
  "wallet_wrong_owner",
  "subaccount_not_owned",
  "account_state_unavailable",
  // The request itself is wrong — retrying with a bootstrapped account changes
  // nothing about it.
  "invalid_wallet_address",
  "invalid_subaccount_address",
  "exchange_mismatch",
  "unsupported_exchange",
  "validation_failed",
  "invalid_request",
  "invalid_json",
  "not_found",
  // Ours to fix, not the user's.
  "server_misconfigured",
  "internal_error",
]);

export function setupCouldFix(code: string): boolean {
  return code.length > 0 && !SETUP_CANNOT_FIX.has(code);
}

async function ensureHyperliquidReady(
  key: string,
  address: string,
  minFundUsd: number,
  accounts: Array<{ account_index?: number; wallet_address?: string }>,
): Promise<{ ready: boolean; detail?: string; spent?: boolean }> {
  const bootstrap = async () =>
    fetch(`${SUPERIOR_API_BASE}/v3/account/${address}/hyperliquid`, {
      method: "POST",
      headers: headers(key),
      body: "{}",
    }).catch(() => null);

  const first = await bootstrap();
  if (first?.ok) return { ready: true };

  const err = first ? await jsonOf(first) : {};
  const code = String(err.error ?? "");
  // Only ever fund on the not-funded signal, and only because the server now
  // verifies wallet ownership BEFORE that gate — so the code genuinely means
  // "repairable, needs money" rather than "we stopped before finding out".
  // wallet_wrong_owner is explicitly never funded.
  if (code !== "account_not_funded_on_hyperliquid") {
    // Unrepairable from here — leave it untouched and unfunded.
    return { ready: false, detail: String(err.message ?? (code || "setup failed")) };
  }

  // Repairable: it only needs a balance. Fund the minimum the venue requires,
  // or the stake if that is larger, then finish setup.
  const funded = await fundWallet(key, address, Math.max(minFundUsd, 5), accounts);
  if (funded === null) return { ready: false, detail: "could not fund for setup" };

  const second = await bootstrap();
  if (second?.ok) return { ready: true, spent: true };
  const err2 = second ? await jsonOf(second) : {};
  return {
    ready: false,
    spent: true,
    detail: String(err2.message ?? err2.error ?? "setup failed after funding"),
  };
}

async function tryDeployOnTradingAccount(
  key: string,
  deploymentId: string,
  exchange: string,
  stakeUsd: number | null,
): Promise<{
  ok: boolean;
  address?: string;
  label?: string;
  funded?: string | null;
  detail?: string;
}> {
  const acct = await fetch(`${SUPERIOR_API_BASE}/v2/account`, { headers: headers(key) });
  const acctJson = await jsonOf(acct);
  const items = (acctJson.items ?? []) as Array<{
    name?: string;
    account_index?: number;
    wallet_address?: string;
  }>;
  // Index 1 is the main wallet — the one that just failed as busy.
  const others = items.filter(
    (a) => a.wallet_address && (a.account_index ?? 1) !== 1,
  );
  if (!others.length)
    return { ok: false, detail: "no other trading accounts on the profile" };

  // Richest first: minimizes the main-wallet top-up and matches the sizing
  // slider's promise (deployable = main + the richest free trading account).
  const balances = await Promise.all(
    others.map((a) => hlWithdrawable(a.wallet_address as string)),
  );
  const ordered = others
    .map((a, i) => ({ a, bal: balances[i] ?? 0 }))
    .sort((x, y) => y.bal - x.bal)
    .map((x) => x.a);

  let lastError = "";
  // Setup moves real money, so at most one account per deploy is ever brought
  // into service — the one this deploy is about to use. Walking on to fund the
  // next candidate would leave a balance in an account that never finished
  // setup, and an account that cannot sign cannot send that balance back.
  let spentOnSetup = false;
  for (const a of ordered) {
    const addr = a.wallet_address as string;
    let attempt = await fetch(
      `${SUPERIOR_API_BASE}/v2/deployment/${deploymentId}/credentials`,
      {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({ exchange, wallet_address: addr }),
      },
    ).catch(() => null);

    // A spare account that has never finished Hyperliquid setup refuses
    // credentials. Finish the setup and retry once, rather than reporting the
    // account as unusable to someone who has no way to fix it from the UI.
    if (attempt && !attempt.ok && exchange === "hyperliquid") {
      const e = await jsonOf(attempt.clone());
      const code = String(e.error ?? "");
      if (setupCouldFix(code)) {
        if (spentOnSetup) {
          lastError = `${a.name ?? addr.slice(0, 8)}: needs setup, and another account was already funded for it this deploy`;
          break;
        }
        const ready = await ensureHyperliquidReady(key, addr, stakeUsd ?? 0, items);
        if (ready.spent) spentOnSetup = true;
        if (!ready.ready) {
          lastError = `${a.name ?? addr.slice(0, 8)}: ${ready.detail ?? "setup incomplete"}`;
          // Funded but still not ready: stop. Trying the next account would
          // move a second balance while this one sits in a wallet that cannot
          // yet send it back.
          if (ready.spent) break;
          continue;
        }
        attempt = await fetch(
          `${SUPERIOR_API_BASE}/v2/deployment/${deploymentId}/credentials`,
          {
            method: "POST",
            headers: headers(key),
            body: JSON.stringify({ exchange, wallet_address: addr }),
          },
        ).catch(() => null);
      }
    }
    if (attempt?.ok) {
      // Credentials stuck — top the account up to the stake from main so
      // the bot actually has capital (nothing upstream funds it).
      const funded =
        stakeUsd !== null ? await fundWallet(key, addr, stakeUsd, items) : null;
      return { ok: true, address: addr, label: a.name, funded };
    }
    if (attempt) {
      const e = await jsonOf(attempt);
      lastError = String(e.message ?? e.error ?? "");
    }
  }
  return {
    ok: false,
    detail: `tried ${others.length} other trading account(s), none accepted${
      lastError ? ` (last: ${lastError})` : ""
    }`,
  };
}

/** Sub-account fallback for a busy main wallet: enumerate the account's
 *  HL sub-accounts, skip ones already holding a deployment or under the
 *  $11 upstream minimum, and try credentials with each until one sticks. */
async function tryDeployOnSubaccount(
  key: string,
  deploymentId: string,
  exchange: string,
): Promise<{ ok: boolean; address?: string; detail?: string }> {
  // Main wallet address.
  const acct = await fetch(`${SUPERIOR_API_BASE}/v2/account`, { headers: headers(key) });
  const acctJson = await jsonOf(acct);
  const main = (acctJson.items as Array<{ wallet_address?: string }> | undefined)?.[0]
    ?.wallet_address;
  if (!main) return { ok: false, detail: "no main wallet on the account" };

  // Wallets already holding deployments (any status still occupies).
  const linked = await linkedWallets(key);

  // On-chain sub-accounts with balances.
  const subsRes = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "subAccounts", user: main }),
  });
  const subs = (await subsRes.json().catch(() => [])) as Array<{
    name?: string;
    subAccountUser?: string;
    clearinghouseState?: { withdrawable?: string };
  }>;
  if (!Array.isArray(subs) || !subs.length)
    return { ok: false, detail: "no sub-accounts exist — create one on Hyperliquid" };

  const candidates = subs.filter((s) => {
    const addr = s.subAccountUser?.toLowerCase();
    if (!addr || linked.has(addr)) return false;
    return parseFloat(s.clearinghouseState?.withdrawable ?? "0") >= 11;
  });
  if (!candidates.length)
    return {
      ok: false,
      detail: `all ${subs.length} sub-account(s) are occupied or under the $11 minimum`,
    };

  for (const c of candidates) {
    const attempt = await fetch(
      `${SUPERIOR_API_BASE}/v2/deployment/${deploymentId}/credentials`,
      {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({ exchange, subaccount_address: c.subAccountUser }),
      },
    ).catch(() => null);
    if (attempt?.ok) return { ok: true, address: c.subAccountUser };
  }
  return { ok: false, detail: `tried ${candidates.length} free sub-account(s), none accepted` };
}

function deploymentCreatedMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^\d+$/.test(trimmed)) return numeric;
  return Date.parse(trimmed) || 0;
}

/** Last-resort placement: every owned trading wallet is held by the user's OWN
 *  STOPPED/terminal deployment. A stopped deployment keeps its wallet secret so
 *  it can be restarted, which is what makes upstream reject a new bind with
 *  duplicate_wallet. We do not delete stopped deployments automatically here:
 *  deleting is destructive and must be an explicit user action. Instead, return
 *  the oldest reclaimable stopped strategy so the UI/API can tell the user what
 *  to free before retrying. */
async function tryReclaimStoppedWallet(
  key: string,
): Promise<{
  ok: boolean;
  address?: string;
  reclaimedFrom?: string;
  funded?: string | null;
  detail?: string;
}> {
  const acct = await fetch(`${SUPERIOR_API_BASE}/v2/account`, { headers: headers(key) });
  const items = ((await jsonOf(acct)).items ?? []) as Array<{
    account_index?: number;
    wallet_address?: string;
    name?: string;
  }>;
  const owned = new Map(
    items
      .filter((a) => a.wallet_address)
      .map((a) => [a.wallet_address!.toLowerCase(), a]),
  );
  if (!owned.size) return { ok: false, detail: "no trading accounts on the profile" };

  const deps = await listDeployments(key).catch(() => null);
  const rows = ((deps?.json as { items?: Array<Record<string, unknown>> })?.items ?? []).map(
    (r) => ({
      id: String(r.id ?? ""),
      status: String(r.status ?? ""),
      wallet: String(r.walletAddress ?? r.wallet_address ?? "").toLowerCase(),
      created: deploymentCreatedMs(r.createdAt ?? r.created_at),
      name: String(r.name ?? ""),
    }),
  );
  // Wallets a live (non-terminal) deployment is using — never free these.
  const activeWallets = new Set(
    rows.filter((d) => d.wallet && !TERMINAL_DEPLOY_STATUS.test(d.status)).map((d) => d.wallet),
  );
  // Reclaim candidates: a terminal-state deployment on an OWNED wallet that no
  // active deployment is using. Oldest first (matches the "free the oldest
  // stopped strategy" contract).
  const candidates = rows
    .filter(
      (d) =>
        d.id &&
        d.wallet &&
        owned.has(d.wallet) &&
        !activeWallets.has(d.wallet) &&
        TERMINAL_DEPLOY_STATUS.test(d.status),
    )
    .sort((a, b) => a.created - b.created);
  if (!candidates.length)
    return { ok: false, detail: "no stopped strategy holds a reclaimable trading wallet" };

  const c = candidates[0]!;
  const walletAddress = owned.get(c.wallet)!.wallet_address;
  return {
    ok: false,
    reclaimedFrom: c.name || undefined,
    detail: `oldest reclaimable stopped strategy${c.name ? ` "${c.name}"` : ""} holds wallet ${walletAddress}; delete it before retrying`,
  };
}

/** Create → credentials (exchange REQUIRED upstream) → start.
 *  Known upstream constraint: one live deployment per trading wallet —
 *  a duplicate_wallet_address error means an existing (even stopped)
 *  deployment still holds the wallet and must be deleted first. */
export async function deployStrategy(
  key: string,
  body: { name?: string; config?: { exchange?: { name?: string } }; code?: string },
): Promise<DeployResult> {
  const payload = body.config
    ? { ...body, config: withConfigDefaults(body.config as Record<string, unknown>) }
    : body;
  const created = await fetch(`${SUPERIOR_API_BASE}/v2/deployment`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(payload),
  });
  const json = await jsonOf(created);
  const steps: Record<string, number> = { create: created.status };
  const stepErrors: Record<string, string> = {};
  const id = json.id as string | undefined;
  if (!created.ok || !id) {
    return { status: created.status, json, steps, stepErrors };
  }

  const exchange = body.config?.exchange?.name ?? "hyperliquid";
  const stakeRaw = (body.config as { stake_amount?: unknown } | undefined)
    ?.stake_amount;
  const stakeUsd =
    typeof stakeRaw === "number" && Number.isFinite(stakeRaw) ? stakeRaw : null;

  const applyTa = (ta: Awaited<ReturnType<typeof tryDeployOnTradingAccount>>) => {
    steps.credentials = 200;
    delete stepErrors.credentials;
    (json as Record<string, unknown>).usedTradingAccount = ta.label ?? ta.address;
    if (ta.funded && ta.funded !== "0") {
      (json as Record<string, unknown>).fundedFromMain = ta.funded;
    }
  };

  // Upfront wallet choice: the default credentials path binds the MAIN
  // wallet — if main can't cover the stake (with the ×1.05 headroom) the
  // bot would link and then silently starve. When another trading account
  // plus a main top-up CAN cover it (this is what the sizing slider's
  // ceiling promises), link that account first instead.
  let credsDone = false;
  if (stakeUsd !== null && exchange === "hyperliquid") {
    try {
      const acct = await fetch(`${SUPERIOR_API_BASE}/v2/account`, {
        headers: headers(key),
      });
      const acctJson = await jsonOf(acct);
      const main = (
        (acctJson.items ?? []) as Array<{
          account_index?: number;
          wallet_address?: string;
        }>
      ).find((a) => (a.account_index ?? 1) === 1)?.wallet_address;
      const [mainW, mainHeld] = main
        ? await Promise.all([hlWithdrawable(main), heldUsdcOnChain(main)])
        : [null, null];
      const mainDeployable = deployableHyperliquidUsd(mainW, mainHeld, true);
      if (mainDeployable !== null && stakeUsd * 1.05 > mainDeployable) {
        const ta = await tryDeployOnTradingAccount(key, id, exchange, stakeUsd);
        if (ta.ok) {
          applyTa(ta);
          credsDone = true;
        }
        // Not ok → fall through to the default main attempt below; main may
        // still be the least-bad wallet (all others occupied).
      }
    } catch {
      /* sizing pre-check is best-effort */
    }
  }

  if (!credsDone) {
    const creds = await fetch(
      `${SUPERIOR_API_BASE}/v2/deployment/${id}/credentials`,
      { method: "POST", headers: headers(key), body: JSON.stringify({ exchange }) },
    ).catch(() => null);
    steps.credentials = creds?.status ?? 0;
    if (creds && !creds.ok) {
      const e = await jsonOf(creds);
      stepErrors.credentials = String(e.message ?? e.error ?? "");
      // Keep the CODE as well as the message. The busy-wallet test below used
      // to run on the message alone, so a new rejection reason whose prose
      // happened not to contain "duplicate_wallet" silently disabled the
      // fallback — a user with three accounts was told to free the first one.
      const credsErrorCode = String(e.error ?? "");
      // Main wallet busy → the CURRENT model is one execution per wallet with
      // concurrency on trading accounts 2/3: try the profile's other trading
      // accounts first (upstream accepts wallet_address + validates ownership),
      // then legacy HL sub-accounts as a last resort. Only give up when every
      // wallet is genuinely occupied.
      // Every way upstream can say "this wallet is taken". Match the code
      // first; the message regex stays for older responses that carry no code.
      const WALLET_BUSY_CODES = new Set([
        "duplicate_wallet_address",
        "wallet_occupied",
        "account_state_unavailable",
      ]);
      if (
        WALLET_BUSY_CODES.has(credsErrorCode) ||
        /already linked|duplicate_wallet|wallet_occupied/i.test(stepErrors.credentials)
      ) {
        try {
          const ta = await tryDeployOnTradingAccount(key, id, exchange, stakeUsd);
          if (ta.ok) {
            applyTa(ta);
          } else {
            if (ta.detail) {
              stepErrors.credentials += ` — trading-account fallback: ${ta.detail}`;
            }
            const sub = await tryDeployOnSubaccount(key, id, exchange);
            if (sub.ok) {
              steps.credentials = 200;
              delete stepErrors.credentials;
              (json as Record<string, unknown>).usedSubaccount = sub.address;
            } else {
              if (sub.detail) {
                stepErrors.credentials += ` — sub-account fallback: ${sub.detail}`;
              }
              // Every wallet is held by the user's own STOPPED strategies.
              // Report the oldest reclaimable one; deletion is destructive and
              // must be explicit instead of automatic.
              const rc = await tryReclaimStoppedWallet(key);
              if (rc.ok) {
                steps.credentials = 200;
                delete stepErrors.credentials;
                (json as Record<string, unknown>).usedTradingAccount = rc.address;
                if (rc.reclaimedFrom) {
                  (json as Record<string, unknown>).reclaimedFrom = rc.reclaimedFrom;
                }
                if (rc.funded && rc.funded !== "0") {
                  (json as Record<string, unknown>).fundedFromMain = rc.funded;
                }
              } else if (rc.detail) {
                stepErrors.credentials += ` — reclaim: ${rc.detail}`;
              }
            }
          }
        } catch {
          /* fallback is best-effort; original error stands */
        }
      }
    }
  }

  // Roll back a created-but-unbound deployment: if no wallet ever bound, the
  // row would surface as a plan-less "foreign" / pending zombie (the frontend
  // returns on the credentials error before it writes the plan record). Delete
  // it so a failed deploy leaves nothing behind. Best-effort.
  if (steps.credentials !== 200) {
    await controlDeployment(key, id, "delete").catch(() => {});
    return { status: 200, json, steps, stepErrors };
  }

  let start = await fetch(`${SUPERIOR_API_BASE}/v2/deployment/${id}/status`, {
    method: "PATCH",
    headers: headers(key),
    body: JSON.stringify({ action: "start" }),
  }).catch(() => null);
  if (!start?.ok) {
    start = await fetch(`${SUPERIOR_API_BASE}/v1/deployment/${id}/status`, {
      method: "PUT",
      headers: headers(key),
      body: JSON.stringify({ action: "start" }),
    }).catch(() => null);
  }
  steps.start = start?.status ?? 0;
  if (start && !start.ok) {
    const e = await jsonOf(start);
    stepErrors.start = String(e.message ?? e.error ?? "");
  }

  return { status: 200, json, steps, stepErrors };
}

/** GET /v2/backtesting/:id/logs — runtime traceback lines on failure. */
export async function getBacktestLogs(
  key: string,
  id: string,
): Promise<string[]> {
  try {
    const res = await fetch(
      `${SUPERIOR_API_BASE}/v2/backtesting/${encodeURIComponent(id)}/logs`,
      { headers: headers(key) },
    );
    const j = (await jsonOf(res)) as {
      items?: Array<{ message?: string }>;
    };
    return (j.items ?? []).map((i) => i.message ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/** GET /v2/deployment — the caller's deployments (running + previous). */
export async function listDeployments(
  key: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${SUPERIOR_API_BASE}/v2/deployment`, {
    headers: headers(key),
  });
  return { status: res.status, json: await jsonOf(res) };
}

/** GET /v2/deployment/:id — a single deployment (config + code + status). */
export async function getDeployment(
  key: string,
  id: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(
    `${SUPERIOR_API_BASE}/v2/deployment/${encodeURIComponent(id)}`,
    { headers: headers(key) },
  );
  return { status: res.status, json: await jsonOf(res) };
}

/** Lifecycle control. stop/start toggle the pod; exit closes open positions
 *  (realizes PnL); delete removes the deployment and FREES the trading wallet
 *  (a stopped deployment still holds it). */
export async function controlDeployment(
  key: string,
  id: string,
  action: "start" | "stop" | "exit" | "delete",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const h = headers(key);
  let res: Response;
  if (action === "delete") {
    res = await fetch(`${SUPERIOR_API_BASE}/v2/deployment/${id}`, {
      method: "DELETE",
      headers: h,
    });
  } else if (action === "exit") {
    res = await fetch(`${SUPERIOR_API_BASE}/v2/deployment/${id}/exit`, {
      method: "POST",
      headers: h,
      body: "{}",
    });
  } else {
    if (action === "start") {
      // Restarting a stopped deployment: its wallet may have been swept back
      // to main (one-shot auto-stop, delete-sweep) — top it up to the stake
      // again or the restarted bot silently never trades. Best-effort: the
      // start proceeds either way.
      try {
        const [wallet, dep] = await Promise.all([
          walletOfDeployment(key, id),
          getDeployment(key, id),
        ]);
        const stake = Number(
          (dep.json as { config?: { stake_amount?: unknown } }).config?.stake_amount,
        );
        if (wallet && Number.isFinite(stake) && stake > 0) {
          const acct = await fetch(`${SUPERIOR_API_BASE}/v2/account`, { headers: h });
          const items = ((await jsonOf(acct)).items ?? []) as Array<{
            account_index?: number;
            wallet_address?: string;
          }>;
          await fundWallet(key, wallet, stake, items);
        }
      } catch {
        /* funding is best-effort */
      }
    }
    res = await fetch(`${SUPERIOR_API_BASE}/v2/deployment/${id}/status`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      res = await fetch(`${SUPERIOR_API_BASE}/v1/deployment/${id}/status`, {
        method: "PUT",
        headers: h,
        body: JSON.stringify({ action }),
      });
    }
  }
  return { status: res.status, json: await jsonOf(res) };
}

/** Change a live deployment's sizing. Upstream has no in-place config update,
 *  so this recreates: read current config+code, delete the old one (frees the
 *  wallet), redeploy with the new stake_amount / leverage. */
export async function updateDeployment(
  key: string,
  id: string,
  changes: { stakeAmount?: number; leverage?: number },
): Promise<DeployResult & { replacedId?: string }> {
  const { json: dep } = await getDeployment(key, id);
  const config = { ...(dep.config as Record<string, unknown> | undefined) };
  let code = String(dep.code ?? "");
  const name = String(dep.name ?? "Updated strategy");
  if (!config || !code) {
    return {
      status: 404,
      json: { error: "deployment not found or missing config/code" },
      steps: {},
      stepErrors: {},
    };
  }
  if (typeof changes.stakeAmount === "number") {
    config.stake_amount = changes.stakeAmount;
  }
  if (typeof changes.leverage === "number") {
    // Rewrite the leverage() return; add the method if the strategy lacks one.
    if (/def\s+leverage\s*\(/.test(code)) {
      code = code.replace(
        /(def\s+leverage\s*\([^)]*\)[^:]*:[\s\S]*?return\s+)[\d.]+/,
        `$1${changes.leverage}.0`,
      );
    } else {
      code = code.replace(
        /(class\s+\w+\s*\(\s*IStrategy\s*\)\s*:\s*\n)/,
        `$1    def leverage(self, pair: str, current_time, current_rate: float, proposed_leverage: float, max_leverage: float, side: str, **kwargs) -> float:\n        return ${changes.leverage}.0\n\n`,
      );
    }
  }
  // Free the wallet before recreating on it.
  await controlDeployment(key, id, "delete").catch(() => null);
  const result = await deployStrategy(key, { name, config: config as { exchange?: { name?: string } }, code });
  return { ...result, replacedId: id };
}

/** GET /v2/deployment-history — per-run sessions with raw HL fills. */
export async function deploymentHistory(
  key: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${SUPERIOR_API_BASE}/v2/deployment-history`, {
    headers: headers(key),
  });
  return { status: res.status, json: await jsonOf(res) };
}

/* ── Wallet + bracket primitives for the agent's executor tools ────────
 *  The agent supplies intent; every dollar figure and occupancy decision
 *  here stays deterministic code. */

export interface WalletOverviewItem {
  accountIndex: number;
  name: string | null;
  address: string;
  /** Free margin already ON Hyperliquid for this wallet. */
  withdrawableUsd: number | null;
  /** Un-deployed native Arbitrum USDC held in this wallet (hold model, #903). */
  heldUsd: number | null;
  /** What can actually back a deployment on this wallet: venue withdrawable +
   *  (main only) its held USDC, which allocate-on-deploy bridges into the venue
   *  at deploy time. Held on NON-main wallets is not deployable (allocation only
   *  reads the main account) so it is excluded here. Size deploys against THIS. */
  deployableUsd: number | null;
  /** Held by a current deployment or an active bracket order (one active
   *  execution per wallet). */
  occupied: boolean;
  isMain: boolean;
}

/** Main + trading accounts with live withdrawable balance and occupancy. */
export async function walletOverview(key: string): Promise<WalletOverviewItem[]> {
  const acct = await fetch(`${SUPERIOR_API_BASE}/v2/account`, { headers: headers(key) });
  const items = ((await jsonOf(acct)).items ?? []) as Array<{
    name?: string;
    account_index?: number;
    wallet_address?: string;
  }>;
  const [occupiedDeploys, brackets] = await Promise.all([
    occupiedWalletsUpstream(key),
    listBrackets(key).catch(() => ({ status: 0, json: {} as Record<string, unknown> })),
  ]);
  // Active brackets occupy their wallet too (upstream enforces the same).
  const bracketWallets = new Set(
    (((brackets.json as { items?: Array<Record<string, unknown>> }).items ?? []) as Array<{
      wallet_address?: string;
      status?: string;
    }>)
      .filter((b) => !/cancelled|closed|done|failed|expired/i.test(b.status ?? ""))
      .map((b) => (b.wallet_address ?? "").toLowerCase())
      .filter(Boolean),
  );
  return Promise.all(
    items
      .filter((a) => a.wallet_address)
      .map(async (a) => {
        const address = a.wallet_address as string;
        const isMain = (a.account_index ?? 1) === 1;
        const [withdrawableUsd, heldUsd] = await Promise.all([
          hlWithdrawable(address),
          heldUsdcOnChain(address),
        ]);
        // Deployable = venue withdrawable + (main only) held USDC. Held on the
        // main account is bridged into the venue by allocate-on-deploy (#903),
        // so a hold-model account (venue $0, funds parked on-chain) is still
        // deployable — this is what unblocks the AI from reporting "$0 reachable".
        const deployableUsd = deployableHyperliquidUsd(withdrawableUsd, heldUsd, isMain);
        return {
          accountIndex: a.account_index ?? 1,
          name: a.name ?? null,
          address,
          withdrawableUsd,
          heldUsd,
          deployableUsd,
          occupied:
            occupiedDeploys.has(address.toLowerCase()) ||
            bracketWallets.has(address.toLowerCase()),
          isMain,
        };
      }),
  );
}

/** USDC transfer between the user's OWN Superior accounts. Both addresses
 *  are re-validated against the account list — this can never send funds
 *  to an address that is not on the user's profile. */
export async function transferBetweenAccounts(
  key: string,
  from: string,
  to: string,
  amountUsd: number,
): Promise<{ ok: boolean; detail: string }> {
  if (!(amountUsd > 0)) return { ok: false, detail: "amount must be positive" };
  const wallets = await walletOverview(key);
  const known = new Set(wallets.map((w) => w.address.toLowerCase()));
  if (!known.has(from.toLowerCase()) || !known.has(to.toLowerCase())) {
    return {
      ok: false,
      detail: "from/to must both be the user's own account addresses (see list_wallets)",
    };
  }
  const amt = Math.floor(amountUsd * 100) / 100;
  const res = await fetch(`${SUPERIOR_API_BASE}/v2/portfolio/hyperliquid/transfer`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({ from, to, amount: String(amt) }),
  });
  const j = await jsonOf(res);
  return res.ok
    ? { ok: true, detail: `moved $${amt}` }
    : { ok: false, detail: String(j.message ?? j.error ?? `transfer HTTP ${res.status}`) };
}

/** Rename one of the user's OWN accounts. The label is UPDATEd upstream
 *  (PATCH /v2/account/:address {name}) after re-validating the address is on
 *  the caller's profile — a client can never rename someone else's account. */
export async function renameAccount(
  key: string,
  wallet: string,
  name: string,
): Promise<{ ok: boolean; name?: string; detail: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, detail: "name cannot be empty" };
  if (trimmed.length > 40) return { ok: false, detail: "name too long (max 40)" };
  const wallets = await walletOverview(key);
  if (!wallets.some((w) => w.address.toLowerCase() === wallet.toLowerCase())) {
    return { ok: false, detail: "not one of your accounts" };
  }
  const res = await fetch(
    `${SUPERIOR_API_BASE}/v2/account/${encodeURIComponent(wallet)}`,
    {
      method: "PATCH",
      headers: headers(key),
      body: JSON.stringify({ name: trimmed }),
    },
  );
  const j = await jsonOf(res);
  if (!res.ok) {
    return { ok: false, detail: String(j.message ?? j.error ?? `rename HTTP ${res.status}`) };
  }
  const account = (j.account ?? {}) as { name?: string };
  return { ok: true, name: account.name ?? trimmed, detail: "renamed" };
}

/** Sweep every IDLE trading account's free margin back to MAIN in one pass.
 *  Occupied wallets (a running execution's budget) are never touched. Dust
 *  (<$1) is left in place. Best-effort per wallet — a single failed transfer
 *  doesn't abort the rest. */
export async function consolidateIdleToMain(key: string): Promise<{
  ok: boolean;
  movedUsd: number;
  count: number;
  detail: string;
}> {
  const wallets = await walletOverview(key);
  const main = wallets.find((w) => w.isMain);
  if (!main) return { ok: false, movedUsd: 0, count: 0, detail: "no main wallet" };
  const idle = wallets
    .filter((w) => !w.isMain && !w.occupied && (w.withdrawableUsd ?? 0) >= 1)
    .sort((a, b) => (b.withdrawableUsd ?? 0) - (a.withdrawableUsd ?? 0));
  let moved = 0;
  let count = 0;
  for (const w of idle) {
    const amt = Math.floor((w.withdrawableUsd as number) * 100) / 100;
    if (amt < 1) continue;
    const res = await fetch(`${SUPERIOR_API_BASE}/v2/portfolio/hyperliquid/transfer`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ from: w.address, to: main.address, amount: String(amt) }),
    });
    if (res.ok) {
      moved += amt;
      count += 1;
    }
  }
  return {
    ok: true,
    movedUsd: Math.floor(moved * 100) / 100,
    count,
    detail: count
      ? `swept $${moved.toFixed(2)} from ${count} account(s)`
      : "nothing idle to consolidate",
  };
}

/** GET /v2/bracket — the user's bracket orders (all statuses). */
export async function listBrackets(
  key: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${SUPERIOR_API_BASE}/v2/bracket`, { headers: headers(key) });
  return { status: res.status, json: await jsonOf(res) };
}

/** POST /v2/bracket — one atomic HL normalTpsl (entry + reduce-only TP/SL)
 *  on a free trading account. */
export async function placeBracket(
  key: string,
  payload: {
    pair: string;
    name?: string;
    side: "long" | "short";
    entry: number;
    take_profit: number;
    stop_loss: number;
    size_usd: number;
    leverage: number;
    alive_until?: string;
  },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${SUPERIOR_API_BASE}/v2/bracket`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await jsonOf(res) };
}

/** DELETE /v2/bracket/:id — cancel a bracket and free its wallet. */
export async function cancelBracket(
  key: string,
  id: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${SUPERIOR_API_BASE}/v2/bracket/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(key),
  });
  return { status: res.status, json: await jsonOf(res) };
}
