"use client";

import { useEffect, useState } from "react";
import { useHyperliquid } from "./hyperliquid-provider";
import { authFetch } from "./client-auth";
import { walletValueFromHl } from "./use-account-value";

// Shared Hyperliquid balance poller (header pill FALLBACK + sizing sliders).
// `balance` = full account value (perp equity + free spot USDC + sub-accounts,
// via walletValueFromHl — same basis as useAccountValue so the fallback never
// under-reports funds parked in spot); `withdrawable` = actually tradable perp
// margin — sliders must size against the latter, not account value.
export function useHlBalance(enabled: boolean): {
  balance: number | null;
  withdrawable: number | null;
  status: "loading" | "ok" | "error";
} {
  const { info } = useHyperliquid();
  const [balance, setBalance] = useState<number | null>(null);
  const [withdrawable, setWithdrawable] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let address: `0x${string}` | null = null;

    const poll = async () => {
      // Skip while our tab is hidden (user on the HL site) — don't compete
      // for the shared per-IP API budget; resumes on the next visible tick.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        if (!address) {
          const res = await authFetch("/api/account");
          const j = await res.json();
          address = j.items?.[0]?.wallet_address ?? null;
          if (!address) {
            if (!cancelled) setStatus("error");
            return;
          }
        }
        const [perp, spot, subs] = await Promise.allSettled([
          info.clearinghouseState({ user: address }),
          info.spotClearinghouseState({ user: address }),
          info.subAccounts({ user: address }),
        ]);
        if (cancelled) return;
        const settled = walletValueFromHl(
          perp.status === "fulfilled" ? perp.value : null,
          spot.status === "fulfilled" ? spot.value : null,
          subs.status === "fulfilled" && Array.isArray(subs.value)
            ? subs.value
            : null,
        );
        if (settled) {
          setBalance(settled.value);
          setStatus("ok");
          if (settled.withdrawable !== null) setWithdrawable(settled.withdrawable);
        }
      } catch {
        if (!cancelled) setStatus((s) => (s === "ok" ? s : "error"));
      }
    };

    poll();
    const t = setInterval(poll, 15_000);
    // Returning to a backgrounded tab: refresh immediately instead of waiting
    // out the interval (the interval itself no-ops while hidden).
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Money-moving actions (deploy auto-fund, stop/exit/delete) broadcast
    // this so the figure updates immediately instead of on the next tick.
    const onRefresh = () => void poll();
    window.addEventListener("cg:refresh-balances", onRefresh);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("cg:refresh-balances", onRefresh);
    };
  }, [info, enabled]);

  return { balance, withdrawable, status };
}
