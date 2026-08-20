"use client";

/* Deposit dialog — two method cards, then the crypto path runs ENTIRELY
 * inline (no redirect): QR (EIP-681) + tap-to-copy address for the user's
 * TRADING wallet, live on-chain arrival detection (public Arbitrum RPC
 * balance polling), and an automatic move into Hyperliquid via
 * /api/portfolio/hl-deposit once funds land. Target UX: Deposit → Crypto →
 * scan/copy → done — no further clicks.
 *
 * NOTE: the upstream deposit-link API surface was removed. /api/account?deposit=1
 * intentionally returns the trading wallet for this Hyperliquid flow (see
 * app/api/account/route.ts).
 *
 * Card (Stripe) is still an external hop: there is no fiat onramp backend
 * yet — the card routes to the account page.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Dialog } from "../ui/dialog";
import { authFetch } from "../../lib/client-auth";
import { track } from "../../lib/track";
import { useLang } from "../../lib/i18n";
import {
  arbitrumBlockNumber,
  atomsToUsdc,
  incomingUsdcTransferHashes,
  usdcBalanceAtoms,
} from "../../lib/arbitrum";
import { pushInboxNotice } from "./inbox";

interface DepositInfo {
  wallet_address: string;
  eip681: string;
}

// Product-recommended minimum deposit (launch policy). Shown up front as the
// deposit floor. The on-chain bridge still credits anything above the HL
// bridge floor below, so this is user guidance, not a hard on-chain block.
const MIN_DEPOSIT_USDC = 50;
// Hyperliquid bridge floor: 5 USDC (6-decimal atoms). Below THIS a deposit
// doesn't credit at all (sent to the bridge it would be lost) — the belowMin
// accumulate case. Distinct from the product minimum above; must stay 5 so
// 5–50 USDC deposits still credit normally.
const HL_BRIDGE_MIN_USDC = 5;

async function resolveAccountPageUrl(): Promise<string> {
  return "https://account.superior.trade";
}

function MethodCard({
  icon,
  fallbackGlyph,
  title,
  rate,
  desc,
  busy,
  disabled = false,
  onPick,
}: {
  icon: string;
  fallbackGlyph: string;
  title: string;
  rate: string;
  desc: string;
  busy: boolean;
  /** Coming-soon state: rendered but not clickable, muted, amber pill. */
  disabled?: boolean;
  onPick: () => void;
}) {
  const [imgOk, setImgOk] = useState(true);
  return (
    <button
      onClick={onPick}
      disabled={busy || disabled}
      className={`liquid-glass group relative flex flex-1 flex-col items-center gap-2.5 rounded-2xl border p-5 text-center transition-all ${
        disabled
          ? "cursor-default border-white/10 opacity-70"
          : "cursor-pointer border-white/12 hover:border-lime-400/60 hover:bg-lime-400/[0.05]"
      } disabled:opacity-70`}
      style={{ background: "var(--glass-fill)" }}
    >
      {/* Coming-soon ribbon for the disabled method — clearer than a muted
          rate pill alone. */}
      {disabled && (
        <span className="absolute right-2.5 top-2.5 rounded-full bg-amber-400/12 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-300">
          {rate}
        </span>
      )}
      {imgOk ? (
        // Bare icon — no padded tile/background behind it (transparent PNG
        // floats on the card, matching the empty-state / error icon set).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={icon}
          alt=""
          className={`h-20 w-20 select-none object-contain transition-transform duration-300 ${disabled ? "grayscale-[0.5]" : "group-hover:scale-105"}`}
          onError={() => setImgOk(false)}
        />
      ) : (
        <span className="flex h-20 w-20 items-center justify-center text-4xl text-white/70">
          {fallbackGlyph}
        </span>
      )}
      <span className="mt-0.5 flex items-center gap-2 text-[14px] font-semibold text-white">
        {title}
        {!disabled && (
          <span className="rounded-full bg-lime-400/12 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-lime-300">
            {busy ? "…" : rate}
          </span>
        )}
      </span>
      <span className="text-[11.5px] leading-relaxed text-white/55">{desc}</span>
    </button>
  );
}

/** Tiny lime spinner for in-flight states. */
function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-[2px] border-lime-400/30 border-t-lime-400"
      aria-hidden
    />
  );
}

/** Inline crypto panel: QR + address + live arrival → auto-credit. */
function CryptoPanel({
  info,
  onProcessingChange,
}: {
  info: DepositInfo;
  /** True while funds are mid-transfer into HL — the dialog must not close. */
  onProcessingChange: (busy: boolean) => void;
}) {
  const { t } = useLang();
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // idle → arrived (on-chain) → credited (moved into HL) | creditFailed;
  // belowMin = funds arrived but under the HL bridge floor, accumulating.
  const [phase, setPhase] = useState<
    "idle" | "arrived" | "credited" | "creditFailed" | "belowMin"
  >("idle");
  const [amount, setAmount] = useState<number | null>(null);
  const [fundingProofFailed, setFundingProofFailed] = useState(false);
  const baselineRef = useRef<bigint | null>(null);
  const baselineBlockRef = useRef<bigint | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    // White tile QR — scanners want dark-on-light; the tile supplies the
    // light ground on our dark UI. EC level H tolerates ~30% damage, which
    // pays for the Arbitrum badge overlaid in the center (chain-specific at
    // a glance — the one wrong-chain mistake is unrecoverable).
    QRCode.toDataURL(info.eip681, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: "H",
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then(setQr)
      .catch(() => setQr(null));
  }, [info.eip681]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive || busyRef.current) return;
      const [atoms, currentBlock] = await Promise.all([
        usdcBalanceAtoms(info.wallet_address),
        arbitrumBlockNumber(),
      ]);
      if (!alive || atoms == null) return;
      if (baselineRef.current == null) {
        baselineRef.current = atoms;
        baselineBlockRef.current = currentBlock;
        return;
      }
      const delta = atoms - baselineRef.current;
      if (delta <= 0n) {
        if (currentBlock !== null) baselineBlockRef.current = currentBlock;
        return;
      }
      // Any on-chain arrival credits to the Superior wallet (Trading Account 1).
      // Funds are held as Arbitrum USDC and only bridged into a venue at deploy
      // time, so there is no deposit-time Hyperliquid bridge floor to gate on.
      if (delta > 0n) {
        busyRef.current = true;
        setFundingProofFailed(false);
        baselineRef.current = atoms;
        const usd = atomsToUsdc(delta);
        setAmount(usd);
        setPhase("arrived");
        onProcessingChange(true); // lock the dialog while the balance settles
        const fromBlock = baselineBlockRef.current;
        let proofResult: "verified" | "not_applicable" | "failed" = "failed";
        if (fromBlock !== null) {
          for (
            let attempt = 0;
            attempt < 3 && proofResult === "failed";
            attempt += 1
          ) {
            const hashes = await incomingUsdcTransferHashes(
              info.wallet_address,
              fromBlock,
            );
            for (const transactionHash of hashes) {
              const response = await authFetch("/api/funding-wallet/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ transactionHash }),
              }).catch(() => null);
              if (!response) continue;
              const result = (await response.json().catch(() => ({}))) as {
                applicable?: boolean;
                verified?: boolean;
              };
              if (response.ok && result.applicable === false) {
                proofResult = "not_applicable";
                break;
              }
              if (response.ok && result.verified === true) {
                proofResult = "verified";
                break;
              }
            }
            if (proofResult === "failed" && attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 1_500));
            }
          }
        }
        setFundingProofFailed(proofResult === "failed");
        if (currentBlock !== null) baselineBlockRef.current = currentBlock;
        // HOLD MODEL (feature/superior-wallet-allocate-on-deploy): funds that
        // land on-chain are now in the user's Superior wallet (Trading Account
        // 1). We NO LONGER auto-bridge into Hyperliquid here — a deposit is
        // complete the moment it reaches the Superior wallet. Allocation into a
        // venue (Hyperliquid/Lighter) happens at DEPLOY time, moving the chosen
        // sizing from the Superior wallet into that deployment's trading account
        // and finishing venue onboarding there. See PUT /v2/deployment/:id/status.
        setPhase("credited");
        pushInboxNotice({
          kind: "open",
          id: `deposit-${info.wallet_address}-${Math.round(usd * 100)}`,
          title: t("inboxDepositTitle"),
          body: t("inboxDepositBody").replace("{amt}", usd.toFixed(2)),
        });
        busyRef.current = false;
        onProcessingChange(false);
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 6000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [info.wallet_address]);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(info.wallet_address).then(() => {
      setCopied(true);
      track("deposit_address_copied");
      setTimeout(() => setCopied(false), 1600);
    });
  }, [info.wallet_address]);

  return (
    <div className="flex flex-col items-center gap-3.5">
      {/* QR on a white tile, Arbitrum badge centered (EC-H absorbs it) */}
      <div className="relative rounded-2xl bg-white p-3 shadow-[0_10px_36px_-14px_rgba(0,0,0,0.9)]">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt={t("depositQrAlt")} className="h-[220px] w-[220px]" />
        ) : (
          <div className="h-[220px] w-[220px] animate-pulse rounded-lg bg-black/10" />
        )}
        {qr && (
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {/* max-w-none: preflight's img{max-width:100%} collapses inside a
                shrink-wrapped absolute parent (4px-wide badge). */}
            <img src="/deposit/arbitrum.png" alt="Arbitrum" className="h-10 w-10 max-w-none" />
          </span>
        )}
      </div>

      {/* Tap-to-copy address — FULL address, breaks across lines if needed;
          verifying every character against the sender is the whole point. */}
      <button
        onClick={copy}
        className="group flex max-w-full cursor-pointer flex-col items-center gap-1 rounded-xl border border-white/12 bg-white/[0.05] px-4 py-2.5 transition-all hover:border-lime-400/50 hover:bg-lime-400/[0.06]"
      >
        <span className="break-all font-mono text-[12.5px] leading-relaxed tracking-tight text-white">
          {info.wallet_address}
        </span>
        <span className={`font-mono text-[11px] ${copied ? "text-lime-300" : "text-white/40 group-hover:text-white/70"}`}>
          {copied ? t("copied") : t("copy")}
        </span>
      </button>

      {/* Network warning + minimum — grouped. Losing funds on the wrong chain
          is the one unrecoverable mistake; make it loud but compact. */}
      <div className="flex flex-col items-center gap-1.5">
        <div className="rounded-full bg-amber-400/12 px-3 py-1 font-mono text-[10.5px] font-bold text-amber-300">
          {t("depositNetworkWarn")}
        </div>
        <div className="font-mono text-[10.5px] text-white/40">
          {t("depositMinNote").replace("{min}", String(MIN_DEPOSIT_USDC))}
        </div>
      </div>

      {/* Live status */}
      <div className="flex items-center gap-2 font-mono text-[11.5px]">
        {phase === "idle" && (
          <>
            <span className="h-2 w-2 animate-pulse rounded-full bg-white/40" />
            <span className="text-white/50">{t("depositWaiting")}</span>
          </>
        )}
        {phase === "arrived" && (
          <>
            <Spinner />
            <span className="text-lime-300">
              {t("depositArrived").replace("{amt}", (amount ?? 0).toFixed(2))}
            </span>
          </>
        )}
        {phase === "credited" && (
          <div className="flex flex-col items-center gap-1 text-center">
            <span className="text-lime-300">
              ✓{" "}
              {t("depositCredited").replace("{amt}", (amount ?? 0).toFixed(2))}
            </span>
            {fundingProofFailed && (
              <span className="max-w-sm text-amber-300">
                {t("depositFundingProofFailed")}
              </span>
            )}
          </div>
        )}
        {phase === "creditFailed" && (
          <span className="text-amber-300">{t("depositCreditFailed")}</span>
        )}
        {phase === "belowMin" && (
          <span className="text-amber-300">
            {t("depositBelowMin")
              .replace("{amt}", (amount ?? 0).toFixed(2))
              .replace("{min}", String(HL_BRIDGE_MIN_USDC))}
          </span>
        )}
      </div>
    </div>
  );
}

export function DepositDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLang();
  const [view, setView] = useState<"choose" | "crypto">("choose");
  const [info, setInfo] = useState<DepositInfo | null>(null);
  const [infoErr, setInfoErr] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);
  // While funds are mid-move into HL, closing the dialog would hide an
  // in-flight money operation — ESC/backdrop/✕ and the back arrow all no-op.
  const [processing, setProcessing] = useState(false);

  // Prefetch the deposit payload the moment the dialog opens, so the crypto
  // panel is instant on click.
  useEffect(() => {
    track("deposit_opened");
    let alive = true;
    void authFetch("/api/account?deposit=1")
      .then(async (r) => {
        const j = (await r.json()) as DepositInfo & { error?: string };
        if (!alive) return;
        if (r.ok && j.wallet_address && j.eip681) setInfo(j);
        else setInfoErr(true);
      })
      .catch(() => alive && setInfoErr(true));
    return () => {
      alive = false;
    };
  }, []);

  const pickCard = async () => {
    setCardBusy(true);
    try {
      const url = await resolveAccountPageUrl();
      window.open(`${url}#card`, "_blank", "noopener");
      onClose();
    } finally {
      setCardBusy(false);
    }
  };

  const openHistory = async () => {
    const url = await resolveAccountPageUrl();
    window.open(`${url}#history`, "_blank", "noopener");
  };

  return (
    <Dialog
      title={
        view === "crypto" ? (
          <span className="flex items-center gap-2">
            {!processing && (
              <button
                onClick={() => setView("choose")}
                className="cursor-pointer text-white/50 transition-colors hover:text-white"
                aria-label={t("back")}
              >
                ←
              </button>
            )}
            {t("depositCryptoTitle")}
          </span>
        ) : (
          t("depositTitle")
        )
      }
      size="lg"
      onClose={() => {
        if (!processing) onClose();
      }}
    >
      {view === "choose" ? (
        <>
          <div className="flex flex-col gap-3 sm:flex-row">
            <MethodCard
              icon="/deposit/card.webp"
              fallbackGlyph="💳"
              title={t("depositCardTitle")}
              rate={t("depositCardRate")}
              desc={t("depositCardDesc")}
              busy={cardBusy}
              disabled
              onPick={() => void pickCard()}
            />
            <MethodCard
              icon="/deposit/usdc.webp"
              fallbackGlyph="◎"
              title={t("depositCryptoTitle")}
              rate={t("depositCryptoRate")}
              desc={t("depositCryptoDesc")}
              busy={false}
              onPick={() => {
                setView("crypto");
                track("deposit_method_selected", { method: "crypto" });
              }}
            />
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => void openHistory()}
              className="group inline-flex cursor-pointer items-center gap-1 font-mono text-[11px] text-white/50 transition-colors hover:text-lime-300"
            >
              {t("depositHistory")}
              <span className="transition-transform group-hover:translate-x-0.5">→</span>
            </button>
          </div>
        </>
      ) : info ? (
        <CryptoPanel info={info} onProcessingChange={setProcessing} />
      ) : (
        <div className="flex flex-col items-center gap-3 py-8">
          {infoErr ? (
            <span className="font-mono text-[12px] text-amber-300">
              {t("depositInfoError")}
            </span>
          ) : (
            <>
              <div className="h-[220px] w-[220px] animate-pulse rounded-2xl bg-white/[0.06]" />
              <div className="h-9 w-56 animate-pulse rounded-xl bg-white/[0.06]" />
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
