"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { registerTokenGetter, authFetch } from "../lib/client-auth";
import { track, registerTrackIdentity } from "../lib/track";
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

const APP_ID = (process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "").trim();
const MODE = (process.env.NEXT_PUBLIC_AUTH_MODE ?? "").trim().toLowerCase();
// Mirrors lib/server-auth: explicit mode wins, otherwise the app ID decides.
// ("dev"/"live" are the historical spellings of "local"/"privy".)
const LOCAL_MODE = MODE === "local" || MODE === "dev";
const PRIVY_APP_ID = LOCAL_MODE ? "" : APP_ID;
const TERMS_URL = (process.env.NEXT_PUBLIC_TERMS_URL ?? "").trim();
const PRIVACY_URL = (process.env.NEXT_PUBLIC_PRIVACY_URL ?? "").trim();

// Auth UX signal for the rest of the app. Local mode mounts no Privy
// provider, so it reports "authed" and nothing gates.
const AuthUXContext = createContext<{ authed: boolean; login: () => void }>({
  authed: true,
  login: () => {},
});

/** Gate hook: `requireAuth(fn)` runs fn when signed in, opens the Privy
 *  login dialog otherwise. `authed` for conditional rendering. */
let lastLoginPrompt = 0;
export function useAuthGate() {
  const { authed, login } = useContext(AuthUXContext);
  return {
    authed,
    requireAuth: (action: () => void) => {
      if (authed) {
        action();
        return;
      }
      // Debounce: closing the Privy dialog restores focus, which can
      // re-fire a gated handler and instantly reopen it. One prompt per
      // 1.5s breaks the loop.
      const now = Date.now();
      if (now - lastLoginPrompt < 1500) return;
      lastLoginPrompt = now;
      login();
    },
  };
}

function AuthBridge({ children }: { children: ReactNode }) {
  const { getAccessToken, ready, authenticated, login, user } = usePrivy();
  const prevAuth = useRef<boolean | null>(null);
  const onboardedRef = useRef(false);

  // Registered during RENDER, deliberately: child components fire their
  // effects BEFORE this parent's effects, so anything fetching on the
  // `authed` transition (chat history, balance) would race a useEffect
  // registration and 401. The setter is an idempotent ref write — safe.
  registerTokenGetter(ready && authenticated ? () => getAccessToken() : null);
  // Same render-phase idempotent write: analytics events carry who did it.
  registerTrackIdentity(
    ready && authenticated && user
      ? { email: user.email?.address, wallet: user.wallet?.address }
      : null,
  );
  useEffect(() => {
    return () => registerTokenGetter(null);
  }, []);

  // Account bootstrap: a brand-new Privy user has no Superior trading wallet,
  // so GET /v2/account returns {items:[]} and the header shows "--". On the
  // first authed load, ensure the terminal-DB user row + trading wallet exist
  // (server-side proxy to web-server; both steps idempotent), then refresh the
  // balance so a just-created wallet appears as $0.00 instead of "--".
  // Best-effort: any failure is swallowed; the 15s balance poll keeps retrying.
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (onboardedRef.current) return;
    onboardedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/onboarding", { method: "POST" });
        if (!res.ok || cancelled) return;
        const j = (await res.json().catch(() => null)) as
          | { ok?: boolean; created?: boolean }
          | null;
        // A wallet was just provisioned → nudge the balance poll immediately
        // rather than waiting out its interval.
        if (j?.ok && !cancelled) {
          window.dispatchEvent(new Event("cg:refresh-balances"));
        }
      } catch {
        /* best-effort — balance poll retries */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated]);

  // Login/logout changes WHOSE data every panel shows — a clean reload is
  // the smoothest correct transition (all polls, chat history, and the
  // balance re-resolve under the new identity).
  //
  // BUT `authenticated` is not stable-on-change: Privy briefly toggles it
  // during token refresh and — critically — when a SIBLING TAB syncs its
  // session (storage events). Reloading on every raw flip turns two open
  // terminal tabs into a reload loop ("chart reloads every few seconds").
  // So we DEBOUNCE: only a change that still holds after 1.2s is a real
  // login/logout worth reloading for; a momentary flip is cancelled by the
  // cleanup before it fires.
  useEffect(() => {
    if (!ready) return;
    if (prevAuth.current === null) {
      prevAuth.current = authenticated;
      return;
    }
    if (prevAuth.current === authenticated) return;
    const target = authenticated;
    const t = setTimeout(() => {
      prevAuth.current = target;
      // keepalive request — survives the reload below.
      track(target ? "login_completed" : "logged_out");
      if (!target) {
        try {
          window.localStorage.removeItem("cg-conversation");
        } catch {
          /* ignore */
        }
      }
      window.location.reload();
    }, 1200);
    return () => clearTimeout(t);
  }, [ready, authenticated]);

  return (
    <AuthUXContext.Provider value={{ authed: ready && authenticated, login }}>
      {children}
    </AuthUXContext.Provider>
  );
}

/** One page_view per terminal load — the top of the funnel. (Local mode:
 *  no Privy, fire immediately.) */
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

/** Privy branch: wait for ready before firing, otherwise the Bearer isn't
 *  registered yet and a logged-in user's page_view lands as anonymous. */
function AuthedPageViewBeacon() {
  const { ready } = usePrivy();
  const sent = useRef(false);
  useEffect(() => {
    if (!ready || sent.current) return;
    sent.current = true;
    track("page_view", {
      path: window.location.pathname,
      referrer: document.referrer || "direct",
      lang: navigator.language,
      screen: `${window.screen.width}x${window.screen.height}`,
      // First-touch acquisition (ft_*) — promoted to person props server-side.
      ...attributionProps(),
    });
  }, [ready]);
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
  if (!PRIVY_APP_ID)
    return (
      <ServerPrefsProvider value={prefs}>
        <PageViewBeacon />
        {children}
      </ServerPrefsProvider>
    ); // local mode: the server resolves one fixed account
  return (
    <ServerPrefsProvider value={prefs}>
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          // Custom hex = Privy derives a full dark palette from our app bg.
          theme: "#0b0d0a",
          accentColor: "#a3e635",
          logo: "/logo-dark.png",
          landingHeader: "Trading Terminal",
          // AppProviders mounts OUTSIDE I18nProvider (which lives in
          // TerminalShell), so localize off the server-read cookie prefs.
          loginMessage:
            prefs.lang === "zh"
              ? "在圖表上作畫，AI 為你建立交易。"
              : "Draw on the chart. AI builds the trade.",
          showWalletLoginFirst: false,
        },
        // Renders "By logging in I agree to the Terms & Conditions and
        // Privacy Policy" inside the Privy dialog, linked to whatever you set.
        // Those documents belong to whoever operates the deployment, so this
        // repository ships neither — set the two env vars to your own, and the
        // consent line disappears if you do not.
        ...(TERMS_URL && PRIVACY_URL
          ? {
              legal: {
                termsAndConditionsUrl: TERMS_URL,
                privacyPolicyUrl: PRIVACY_URL,
              },
            }
          : {}),
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
      }}
    >
      <AuthedPageViewBeacon />
      <AuthBridge>{children}</AuthBridge>
    </PrivyProvider>
    </ServerPrefsProvider>
  );
}

/** Header control: settings dropdown (language/theme selectors) everywhere;
 *  identity + logout inside it when authenticated. */
export function AccountControl({ balance }: { balance?: number | null } = {}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  if (!PRIVY_APP_ID) {
    return (
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
        <div className="border-b border-white/10 px-3 py-2">
          <span
            title={t("devModeHint")}
            className="cursor-help rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-amber-300"
          >
            {t("devMode")}
          </span>
        </div>
        <SettingsRows />
      </Dropdown>
    );
  }
  return <AccountControlInner balance={balance} />;
}

function AccountControlInner({ balance }: { balance?: number | null }) {
  const { t } = useLang();
  const { ready, authenticated, login, logout, user } = usePrivy();
  const [open, setOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  // Poll multi-account values only while the dialog is open — the header
  // already runs its own useAccountValue for the total.
  const accountValue = useAccountValue(authenticated && accountsOpen);

  if (!ready) {
    return <span className="h-8 w-20 animate-pulse rounded-full bg-white/[0.06]" />;
  }

  const address = user?.wallet?.address;
  const email = user?.email?.address;
  // Screen-share safe: never show the full identity in the always-visible
  // chip — mask the email local part, truncate the wallet.
  const maskedEmail = email
    ? `${email.slice(0, 2)}…@${email.split("@")[1] ?? ""}`
    : null;
  const label =
    maskedEmail ??
    (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : t("accountFallback"));

  const trigger = authenticated ? (
    // liquid-glass + --pill-fill: match the navbar's other pill containers
    // (account-value/deposit pill) instead of a flat bordered chip.
    <button
      onClick={() => setOpen(!open)}
      className={`liquid-glass flex items-center gap-2 rounded-full px-3 py-1.5 font-mono text-[11px] transition-colors ${
        open ? "text-white ring-1 ring-lime-400/40" : "text-white/80 hover:text-white"
      }`}
      style={{ background: "var(--pill-fill)" }}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-lime-400" />
      {label}
      <span className={`text-white/40 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
    </button>
  ) : (
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
  );

  return (
    <div className="flex items-center gap-2">
      {!authenticated && (
        <button
          onClick={login}
          className="rounded-full bg-lime-400 px-4 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-black transition-opacity hover:opacity-85"
        >
          {t("login")}
        </button>
      )}
      <Dropdown open={open} setOpen={setOpen} trigger={trigger}>
        {authenticated && (
          <div className="border-b border-white/10 px-3 py-2.5">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-lime-300">
              <span className="h-1 w-1 rounded-full bg-lime-400" />
              {t("signedIn")}
            </div>
            {email && <div className="mt-1 truncate text-[12.5px] text-white">{email}</div>}
            {/* Mobile only: the header balance pill is hidden below md, so the
                account value lives here instead. Masked respects privacy mode. */}
            {balance != null && (
              <div className="mt-2 flex items-center justify-between md:hidden">
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
            {/* Credits — launch week is unlimited for everyone. Sits right
                under the identity so it reads as a property of the account. */}
            <div className="mt-2 flex items-center justify-between" title={t("creditsTip")}>
              <span className="font-mono text-[10px] uppercase tracking-widest text-white/40">
                {t("credits")}
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[11px] font-bold">
                <span className="text-white/30 line-through">1,000</span>
                <span className="text-[14px] leading-none text-lime-300">∞</span>
              </span>
            </div>
            {/* Privy LOGIN wallet deliberately not shown — it's the auth
                identity, not a trading or deposit wallet; surfacing it next
                to real trading addresses caused confusion. Trading wallets
                live in the Accounts dialog below. */}
          </div>
        )}

        <SettingsRows />

        {authenticated && (
          <>
            <div className="my-1 border-t border-white/10" />
            {/* Accounts section: the management dialog plus the money actions,
                mirrored from the header pill so Deposit/Withdraw are reachable
                from here too. The dialogs live in the header — dispatch the
                window events it already listens for. */}
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
                setKeysOpen(true);
              }}
              className="w-full rounded-lg px-3 py-2 text-left font-mono text-[11px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
            >
              {t("apiKeysMenu")}
            </button>
            <div className="my-1 border-t border-white/10" />
            <button
              onClick={() => {
                setOpen(false);
                void logout();
              }}
              className="w-full rounded-lg px-3 py-2 text-left font-mono text-[11px] text-red-300 transition-colors hover:bg-red-400/15"
            >
              {t("logout")}
            </button>
          </>
        )}
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
