"use client";

import { useEffect, useState, type ReactNode } from "react";
import { track } from "../lib/track";
import { attributionProps } from "../lib/attribution";
import { useLang } from "../lib/i18n";
import {
  DEFAULT_SERVER_PREFS,
  ServerPrefsProvider,
  type ServerPrefs,
} from "../lib/server-prefs";
import { Dropdown, SettingsRows, GearIcon } from "./settings-menu";
import { AccountsDialog } from "./terminal/accounts-dialog";
import { ApiKeysDialog } from "./terminal/api-keys-dialog";
import { useAccountValue } from "../lib/use-account-value";
import { Masked } from "../lib/privacy";

/**
 * Gate hook, kept for the call sites that use it.
 *
 * There is no login: the terminal runs on your machine with your API key, so
 * every action is already authorized and `requireAuth` simply runs what it is
 * given. The seam stays because deciding "may this happen?" in one place is
 * worth keeping even when today's answer is always yes.
 */
export function useAuthGate() {
  return {
    authed: true,
    requireAuth: (action: () => void) => action(),
  };
}

/** One page_view per terminal load — the top of the funnel. */
function PageViewBeacon() {
  useEffect(() => {
    track("page_view", {
      path: window.location.pathname,
      referrer: document.referrer || "direct",
      lang: navigator.language,
      screen: `${window.screen.width}x${window.screen.height}`,
      // First-touch acquisition (ft_*) — promoted to person props server-side.
      ...attributionProps(),
    });
  }, []);
  return null;
}

export function AppProviders({
  children,
  prefs = DEFAULT_SERVER_PREFS,
}: {
  children: ReactNode;
  /** Cookie prefs read by the SERVER layout — providers initialize to these
   *  so the first client render already matches the user's saved settings. */
  prefs?: ServerPrefs;
}) {
  return (
    <ServerPrefsProvider value={prefs}>
      <PageViewBeacon />
      {children}
    </ServerPrefsProvider>
  );
}

/** Header control: settings, plus the account actions (manage wallets,
 *  deposit, withdraw, API keys). The first two dialogs are mounted in the
 *  header, which is why those go out as window events. */
export function AccountControl({ balance }: { balance?: number | null } = {}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  // Poll multi-account values only while the dialog is open — the header
  // already runs its own useAccountValue for the total.
  const accountValue = useAccountValue(accountsOpen);

  return (
    <div className="flex items-center gap-2">
      <Dropdown
        open={open}
        setOpen={setOpen}
        trigger={
          <button
            onClick={() => setOpen(!open)}
            title={t("settings")}
            className={`grid h-8 w-8 place-items-center rounded-full border transition-colors ${
              open
                ? "border-lime-400/40 bg-white/[0.08] text-white"
                : "border-white/15 bg-white/[0.05] text-white/70 hover:text-white"
            }`}
          >
            <GearIcon className="h-4 w-4" />
          </button>
        }
      >
        {/* Mobile only: the header balance pill is hidden below md, so the
            account value lives here instead. Masked respects privacy mode. */}
        {balance != null && (
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5 md:hidden">
            <span className="font-mono text-[10px] uppercase tracking-widest text-white/40">
              {t("acctValue")}
            </span>
            <span className="font-mono text-[13px] font-bold tabular-nums text-lime-400">
              <Masked
                value={`$${balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              />
            </span>
          </div>
        )}

        <SettingsRows />

        <div className="my-1 border-t border-white/10" />
        <div className="px-3 pb-0.5 pt-1 font-mono text-[9px] font-bold uppercase tracking-widest text-white/35">
          {t("accountsTitle")}
        </div>
        <button
          onClick={() => {
            setOpen(false);
            setAccountsOpen(true);
            track("accounts_opened");
          }}
          className="w-full rounded-lg px-3 py-2 text-left font-mono text-[11px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
        >
          {t("acctManage")}
        </button>
        <button
          onClick={() => {
            setOpen(false);
            window.dispatchEvent(new Event("cg:open-deposit"));
          }}
          className="w-full rounded-lg px-3 py-2 text-left font-mono text-[11px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
        >
          {t("deposit")}
        </button>
        <button
          onClick={() => {
            setOpen(false);
            window.dispatchEvent(new Event("cg:open-withdraw"));
          }}
          className="w-full rounded-lg px-3 py-2 text-left font-mono text-[11px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
        >
          {t("withdraw")}
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setKeysOpen(true);
          }}
          className="w-full rounded-lg px-3 py-2 text-left font-mono text-[11px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
        >
          {t("apiKeysMenu")}
        </button>
      </Dropdown>
      {accountsOpen && (
        <AccountsDialog
          perWallet={accountValue.perWallet}
          loading={accountValue.loading}
          onClose={() => setAccountsOpen(false)}
        />
      )}
      {keysOpen && <ApiKeysDialog onClose={() => setKeysOpen(false)} />}
    </div>
  );
}
