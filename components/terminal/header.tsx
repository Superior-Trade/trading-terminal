"use client";

import { useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/i18n";
import { usePrivacy, Masked } from "../../lib/privacy";
import { AccountControl, useAuthGate } from "../providers";
import { useHlBalance } from "../../lib/use-hl-balance";
import { useHeldUsdc } from "../../lib/use-held-usdc";
import { useAccountValue } from "../../lib/use-account-value";
import { useVenueOnboarding } from "../../lib/use-venue-onboarding";
import { DepositDialog } from "./deposit-dialog";
import { MarketPicker } from "./market-picker";
import { MarketPositioning } from "./market-positioning";
import { Inbox } from "./inbox";

// Balance polling lives in lib/use-hl-balance.ts (shared with the sizing
// sliders, which need the withdrawable/tradable figure).

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

function EyeSlashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M10.2 6a10.7 10.7 0 0 1 1.8-.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-2.2 3" />
      <path d="M6.6 7A16.3 16.3 0 0 0 2.5 12S6 18.5 12 18.5a9.8 9.8 0 0 0 4.3-1" />
      <path d="M10.2 10.3a2.6 2.6 0 0 0 3.6 3.6" />
      <path d="m4 4 16 16" />
    </svg>
  );
}

/** Privacy-mode toggle: hides every money amount app-wide (see lib/privacy).
 *  Compact ghost button living INSIDE the account-value pill, right behind
 *  the number it masks. */
function PrivacyToggle() {
  const { hidden, toggle } = usePrivacy();
  const { t } = useLang();
  return (
    // -ml pulls the eye 3px toward the number (halves the row gap for this
    // pair only; eye↔deposit keeps the full gap).
    <button
      onClick={toggle}
      title={t(hidden ? "privacyShow" : "privacyHide")}
      className="-ml-[3px] grid h-5 w-5 place-items-center rounded-full text-white/40 transition-colors hover:text-white"
    >
      {hidden ? <EyeSlashIcon className="h-3.5 w-3.5" /> : <EyeIcon className="h-3.5 w-3.5" />}
    </button>
  );
}

export function Header() {
  const { authed } = useAuthGate();
  // Single-wallet balance stays mounted as the FALLBACK display when the
  // account list can't load (useAccountValue errors out).
  const { balance, status } = useHlBalance(authed);
  const accountValue = useAccountValue(authed);
  // Held (un-deployed) USDC in the user's Superior wallet(s). In the hold model
  // deposits sit here until a deploy allocates them, so the balance must include
  // it — otherwise a fresh deposit reads as $0 until deployed.
  const heldWallets = accountValue.perWallet
    .map((w) => w.wallet)
    .filter((w): w is string => Boolean(w));
  const { held, status: heldStatus } = useHeldUsdc(heldWallets, authed);
  // Once the account is funded, ensure its wallet is Hyperliquid-tradeable
  // (agent wallet + builder fee). Reuses the total above — no extra poller.
  useVenueOnboarding(accountValue.total, authed);
  const { t } = useLang();
  // Method chooser (Card vs Crypto) — the dialog resolves the deposit link.
  const [depositOpen, setDepositOpen] = useState(false);
  // Other surfaces (deploy failing on insufficient funds; the account
  // dropdown's Accounts section) open these dialogs via window events — the
  // dialogs themselves stay mounted here in the header.
  useEffect(() => {
    const openDeposit = () => setDepositOpen(true);
    window.addEventListener("cg:open-deposit", openDeposit);
    return () => {
      window.removeEventListener("cg:open-deposit", openDeposit);
    };
  }, []);

  // Sum across all trading accounts. The single-wallet figure is a PARTIAL
  // view (main only), so it's used only when the account list itself failed
  // — never while the full sum is still loading, where a partial number
  // reads as a scary balance drop.
  // Base = venue value (Hyperliquid across all accounts, or the single-wallet
  // fallback on error). Total shown = base + held USDC.
  const baseValue =
    accountValue.total ?? (accountValue.status === "error" ? balance : null);
  // CRITICAL: do NOT publish a number until BOTH the venue value AND the held-
  // USDC read have settled at least once. Otherwise the pill briefly shows the
  // Hyperliquid-only figure (often $0 right after a deposit, since funds sit as
  // held Arbitrum USDC) before `held` loads — which reads as "my money vanished"
  // and scares users. `held !== null` OR a non-loading status counts as settled
  // (an errored held read contributes 0 rather than blocking the whole balance).
  const heldSettled = heldWallets.length === 0 || heldStatus !== "loading";
  const fullyLoaded = baseValue !== null && heldSettled;
  const computedTotal = fullyLoaded ? baseValue + (held ?? 0) : null;
  // Hold the last good total across transient reloads / in-flight fund movement
  // so the figure never dips to $0 mid-transition.
  const lastTotalRef = useRef<number | null>(null);
  useEffect(() => {
    if (computedTotal !== null) lastTotalRef.current = computedTotal;
  }, [computedTotal]);
  const displayValue = computedTotal ?? lastTotalRef.current;
  const valueLoading =
    displayValue === null &&
    (accountValue.status === "loading" ||
      status === "loading" ||
      (heldWallets.length > 0 && heldStatus === "loading"));

  return (
    // No backdrop-blur on the header: an ancestor backdrop-filter becomes
    // the backdrop root and kills blur on dropdowns that overhang it.
    <header className="relative z-50 flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-black/40 px-2.5 sm:px-5">
      <div className="flex items-center gap-2">
        {/* Theme-swapped v3 mark (turborepo pattern): light asset in light
            mode, dark in dark. Swap is CSS-driven off html.light (our theme
            class — Tailwind's `dark:` variant is not wired to it).
            width/height ATTRIBUTES matter: the source PNGs are 1453×1453 and
            h-9/w-9 live in the external stylesheet — without an element-level
            size the pre-CSS first paint shows the mark at natural size. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-light.png"
          alt=""
          width={36}
          height={36}
          className="logo-v3-light h-9 w-9"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-dark.png"
          alt=""
          width={36}
          height={36}
          className="logo-v3-dark h-9 w-9"
        />
        {/* Brand text is header clutter on a phone — logo alone reads there. */}
        <span className="hidden text-lg font-semibold tracking-tight text-white sm:inline">
          Superior Trade
        </span>
      </div>

      {/* The pair-selector TRIGGER lives in the TradingView toolbar now;
          MarketPicker here is headless (renders only its opened panel). The
          positioning bar (SMART/CROWD) is desktop-only — it overflows on mobile
          and duplicates data the chart already shows. */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-4 px-2 sm:px-4">
        <MarketPicker />
        <div className="hidden min-w-0 md:flex">
          <MarketPositioning />
        </div>
      </div>

      <div className="flex items-center gap-3">
        {authed && (
          <>
            <Inbox />
            {/* On mobile the header keeps just Inbox + Account — the balance
                pill (value / eye / Deposit) is hidden and the balance moves
                into the account dropdown. Dialogs below stay mounted (they
                portal to body) so the dropdown can still open them. */}
            <div
              className="liquid-glass hidden items-center gap-1.5 rounded-full py-1 pl-3 pr-1 md:flex"
              style={{ background: "var(--pill-fill)" }}
            >
              {/* Flat row, ONE gap value between number · eye · deposit;
                  leading-none keeps the number's baseline from skewing the
                  vertical centering against the icon/button. */}
              {displayValue !== null ? (
                <span className="font-mono text-[13px] font-bold leading-none tabular-nums text-lime-400">
                  <Masked
                    value={`$${displayValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  />
                </span>
              ) : valueLoading ? (
                <span className="h-3.5 w-16 animate-pulse rounded bg-lime-400/25" />
              ) : (
                <span
                  className="font-mono text-[13px] font-bold leading-none text-white/35"
                  title={t("acctValueUnavailable")}
                >
                  ——
                </span>
              )}
              <PrivacyToggle />
              {/* Withdraw lives only in the account dropdown now (deposits grow
                  accounts and belong up front; withdrawals are rarer and stay
                  one level in). The dialog + cg:open-withdraw listener remain
                  mounted here so the dropdown can open it. */}
              <button
                onClick={() => setDepositOpen(true)}
                className="rounded-full bg-lime-400 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-black transition-opacity hover:opacity-85"
              >
                {t("deposit")}
              </button>
              {depositOpen && <DepositDialog onClose={() => setDepositOpen(false)} />}
            </div>
          </>
        )}
        <AccountControl balance={displayValue} />
      </div>
    </header>
  );
}
