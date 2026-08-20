"use client";

import { useEffect, useRef, useState } from "react";
import { usdcBalanceAtoms, atomsToUsdc } from "./arbitrum";

// Held (un-deployed) USDC — native Arbitrum USDC sitting in the user's trading
// account wallets (the Superior wallet / Trading Account 1 primarily). In the
// hold model, deposits land here and STAY until a deploy allocates them into a
// venue, so this must count toward the displayed account balance. Without it,
// freshly deposited funds read as $0 (the Hyperliquid balance is still empty)
// even though the money is safely in the user's wallet, ready to deploy.
//
// This reads on-chain balances directly from the browser (same basis as the
// deposit dialog's poller) and is deliberately kept OUT of the Hyperliquid
// balance/account-value hooks. The sizing sliders add ONLY TA1's held USDC on
// top of tradable venue margin (useDeployableUsd in deployments-panel):
// allocate-on-deploy bridges the TA1 pot into the venue at deploy time, so it
// is genuinely deployable — held USDC on other wallets stays display-only.
export function useHeldUsdc(
  wallets: string[],
  enabled: boolean,
): {
  held: number | null;
  /** Per-wallet held USDC (lower-cased address -> USD). Used by the accounts
   *  modal to show each Trading Account's held balance, not just the total. */
  heldByWallet: Record<string, number>;
  status: "loading" | "ok" | "error";
} {
  const [held, setHeld] = useState<number | null>(null);
  const [heldByWallet, setHeldByWallet] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const lastKnownByWallet = useRef<Record<string, number>>({});
  const key = wallets.join(",");

  useEffect(() => {
    if (!enabled || wallets.length === 0) return;
    let cancelled = false;

    const poll = async () => {
      // Skip while our tab is hidden — resumes on the next visible tick.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const atoms = await Promise.all(wallets.map((w) => usdcBalanceAtoms(w)));
        if (cancelled) return;
        // If EVERY read failed, keep the last-known figures rather than dropping
        // to $0 (a transient RPC failure must not read as funds vanishing).
        if (atoms.every((a) => a == null)) {
          setStatus((s) => (s === "ok" ? s : "error"));
          return;
        }
        // Per-wallet map scoped to the current wallet set; a single wallet's
        // transient read failure keeps that wallet's last-known value.
        const byWallet: Record<string, number> = {};
        wallets.forEach((w, i) => {
          const a = atoms[i];
          const lower = w.toLowerCase();
          if (a != null) byWallet[lower] = atomsToUsdc(a);
          else if (lastKnownByWallet.current[lower] != null)
            byWallet[lower] = lastKnownByWallet.current[lower];
        });
        lastKnownByWallet.current = byWallet;
        const usd = Object.values(byWallet).reduce((sum, v) => sum + v, 0);
        setHeld(usd);
        setHeldByWallet(byWallet);
        setStatus("ok");
      } catch {
        if (!cancelled) setStatus((s) => (s === "ok" ? s : "error"));
      }
    };

    void poll();
    const iv = setInterval(poll, 15_000);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Deploy/stop broadcast this after moving money so the figure updates at
    // once instead of on the next 15s tick.
    const onRefresh = () => void poll();
    window.addEventListener("cg:refresh-balances", onRefresh);
    return () => {
      cancelled = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("cg:refresh-balances", onRefresh);
    };
  }, [key, enabled]);

  return { held, heldByWallet, status };
}
