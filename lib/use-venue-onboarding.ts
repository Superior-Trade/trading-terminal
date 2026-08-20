"use client";

import { useEffect, useRef } from "react";
import { authFetch } from "./client-auth";

// Layer 2 of account onboarding: once the account is FUNDED, make the primary
// trading wallet Hyperliquid-tradeable (agent wallet approved + builder fee).
// Mirrors the v1 auto-onboarding pattern (PR #601): only fire when balance > 0
// (HL onboarding pre-funding is pointless), let the server no-op when already
// ready, and don't hammer the money-path endpoint. The effect keys on `total`,
// so it runs on the transition to funded — not on a fixed timer.
//
// It reuses the header's existing useAccountValue total (no extra HL poller,
// per the connection-budget rule). Pass `enabled=false` when unauthed to skip.
export function useVenueOnboarding(total: number | null, enabled: boolean): void {
  const readyRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled || readyRef.current || inFlightRef.current) return;
    if (total === null || total <= 0) return; // gate: funded accounts only
    inFlightRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/onboarding/venue", { method: "POST" });
        const j = (await res.json().catch(() => null)) as {
          ready?: boolean;
          onboarded?: boolean;
        } | null;
        if (cancelled) return;
        if (res.ok && j?.ready) {
          readyRef.current = true; // fully tradeable — stop trying
          // If a bootstrap actually ran, the agent wallet/builder changed —
          // refresh so anything gated on readiness updates.
          if (j.onboarded) window.dispatchEvent(new Event("cg:refresh-balances"));
        }
        // not-ready / transient error → leave readyRef false; the next change
        // in `total` retries (idempotent upstream).
      } catch {
        /* retry on the next funded tick */
      } finally {
        inFlightRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [total, enabled]);
}
