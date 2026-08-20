"use client";

import { useEffect, useRef, useState } from "react";
import { useHyperliquid } from "./hyperliquid-provider";
import { authFetch } from "./client-auth";

// Total "Account Value" across ALL of the user's trading accounts (the
// header pill + account-management dialog). Account list comes from
// /api/account (Superior /v2/account) ONCE per auth session; each wallet's
// value is polled from Hyperliquid every 15s.
//
// A wallet's value = perp equity (marginSummary.accountValue, which already
// folds in margin locked in open positions + unrealized PnL) + FREE SPOT USDC
// + each HL sub-account's (perp equity + free spot USDC). Perp and spot live
// in separate Hyperliquid clearinghouses, so summing never double-counts.
// This mirrors apps/web's fetchAccountValue (hooks/use-main-account-balances)
// — the v1 terminal counted spot + sub-accounts, and reading ONLY perps here
// made real balances "disappear" to $0 for anyone holding idle spot USDC
// (deposits/withdrawn funds park in spot) or funds in a sub-account.
// NOTE: lib/use-hl-balance.ts stays untouched — the sizing sliders depend
// on its single-wallet withdrawable figure. `withdrawable` below likewise
// stays perp-only free margin: spot USDC is real value but not perp margin,
// so it must not inflate what the sliders treat as deployable.

export interface WalletValue {
  wallet: string;
  /** Superior account name; empty string when unnamed. */
  name: string;
  /** Superior account_index (display fallback "Account N"). */
  accountIndex: number | null;
  /** Hyperliquid marginSummary.accountValue in USD; null until fetched. */
  value: number | null;
  /** Hyperliquid withdrawable USD (free margin); null until fetched. The
   *  sizing slider sums this across main + idle trading accounts. */
  withdrawable: number | null;
}

interface AccountItem {
  name?: string | null;
  account_index?: number | null;
  wallet_address?: string | null;
}

export interface SpotBalance {
  coin?: string;
  token?: number;
  total?: string | number;
  hold?: string | number;
}

export function toNum(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Free (total − hold) spot USDC across a wallet's spot balances. HL exposes
 *  USDC as token index 0; match on coin name too for resilience. */
export function freeSpotUsdc(balances: SpotBalance[] | undefined): number {
  return (balances ?? [])
    .filter((b) => b.token === 0 || String(b.coin ?? "").toUpperCase() === "USDC")
    .reduce((sum, b) => sum + Math.max(0, toNum(b.total) - toNum(b.hold)), 0);
}

/** A wallet's full displayed value from its HL settled-state responses:
 *  perp equity + free spot USDC + each sub-account's (perp + free spot USDC).
 *  Perp and spot are separate clearinghouses, so summing never double-counts.
 *  `null` when the perp response is missing (the caller should hold its
 *  last-known value rather than show a spot-only figure that reads as a drop). */
export function walletValueFromHl(
  perp: { marginSummary?: { accountValue?: string }; withdrawable?: string } | null,
  spot: { balances?: SpotBalance[] } | null,
  subs: Array<{
    clearinghouseState?: { marginSummary?: { accountValue?: string } };
    spotState?: { balances?: SpotBalance[] };
  }> | null,
): { value: number; withdrawable: number | null } | null {
  if (!perp) return null;
  const v = parseFloat(perp.marginSummary?.accountValue ?? "");
  const w = parseFloat(perp.withdrawable ?? "");
  let value = Number.isFinite(v) ? v : 0;
  value += freeSpotUsdc(spot?.balances);
  if (Array.isArray(subs)) {
    for (const sub of subs) {
      value +=
        toNum(sub.clearinghouseState?.marginSummary?.accountValue) +
        freeSpotUsdc(sub.spotState?.balances);
    }
  }
  return { value, withdrawable: Number.isFinite(w) ? w : null };
}

export function useAccountValue(enabled: boolean): {
  /** Sum of accountValue across all wallets; null until the first fetch. */
  total: number | null;
  perWallet: WalletValue[];
  loading: boolean;
  status: "loading" | "ok" | "error";
} {
  const { info } = useHyperliquid();
  const [perWallet, setPerWallet] = useState<WalletValue[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  // Last-known value per wallet, persisted across polls. The total is only
  // published once EVERY wallet has reported at least once — a partial sum
  // reads as a terrifying balance drop — and a transient single-wallet
  // failure afterwards reuses its last-known value instead of dipping.
  const lastKnownRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Account list is fetched once per auth session and cached here; a
    // failure retries on the next poll tick.
    let accounts: Array<{ wallet: string; name: string; accountIndex: number | null }> | null =
      null;

    const poll = async () => {
      // Skip while our tab is hidden — don't compete for the shared per-IP
      // Hyperliquid API budget; resumes on the next visible tick.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        if (!accounts) {
          const res = await authFetch("/api/account");
          const j = (await res.json()) as { items?: AccountItem[] };
          const items = (j.items ?? []).filter((a) => a.wallet_address);
          if (!items.length) {
            if (!cancelled) setStatus("error");
            return;
          }
          accounts = items.map((a) => ({
            wallet: a.wallet_address as string,
            name: a.name ?? "",
            accountIndex:
              typeof a.account_index === "number" ? a.account_index : null,
          }));
        }
        // Per wallet: perp + spot + sub-accounts, in parallel; a single
        // wallet failing must not blank the others. The perp call is the
        // anchor — if it fails we report null (last-known value holds) rather
        // than publishing a spot-only figure that would read as a balance
        // drop; spot/sub-account calls only ADD to a successful perp figure.
        const values = await Promise.all(
          accounts.map(async (a) => {
            const user = a.wallet as `0x${string}`;
            const [perp, spot, subs] = await Promise.allSettled([
              info.clearinghouseState({ user }),
              info.spotClearinghouseState({ user }),
              info.subAccounts({ user }),
            ]);
            // walletValueFromHl returns null when perp is missing (last-known
            // value holds); withdrawable stays perp-only (sizing sliders).
            return (
              walletValueFromHl(
                perp.status === "fulfilled" ? perp.value : null,
                spot.status === "fulfilled" ? spot.value : null,
                subs.status === "fulfilled" && Array.isArray(subs.value)
                  ? subs.value
                  : null,
              ) ?? { value: null, withdrawable: null }
            );
          }),
        );
        if (cancelled) return;
        const next = accounts.map((a, i) => ({ ...a, ...values[i] }));
        setPerWallet(next);
        for (const [i, a] of accounts.entries()) {
          const v = values[i].value;
          if (v !== null) lastKnownRef.current.set(a.wallet, v);
        }
        const resolved = accounts.map((a) => lastKnownRef.current.get(a.wallet));
        if (resolved.every((v): v is number => v !== undefined)) {
          // Every wallet has reported at least once — safe to show the sum.
          setTotal(resolved.reduce((s, v) => s + v, 0));
          setStatus("ok");
        } else if (resolved.some((v) => v !== undefined)) {
          // Partial coverage: keep the loading shimmer rather than flash a
          // low number; the 15s poll keeps retrying the missing wallets.
          setStatus((s) => (s === "ok" ? s : "loading"));
        } else {
          setStatus((s) => (s === "ok" ? s : "error"));
        }
      } catch {
        if (!cancelled) setStatus((s) => (s === "ok" ? s : "error"));
      }
    };

    poll();
    const t = setInterval(poll, 15_000);
    // Returning to a backgrounded tab: refresh immediately instead of
    // waiting out the interval (the interval itself no-ops while hidden).
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Money-moving actions (deploy auto-fund, stop/exit/delete) broadcast
    // this so the totals update immediately instead of on the next tick.
    const onRefresh = () => void poll();
    window.addEventListener("cg:refresh-balances", onRefresh);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("cg:refresh-balances", onRefresh);
    };
  }, [info, enabled]);

  return { total, perWallet, loading: status === "loading", status };
}
