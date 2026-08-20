"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "../ui/dialog";
import { useLang } from "../../lib/i18n";
import { authFetch } from "../../lib/client-auth";
import { track } from "../../lib/track";

/**
 * Move USDC off Hyperliquid and into this account's Superior wallet on
 * Arbitrum — the deposit dialog run backwards.
 *
 * There is no destination picker because there is no destination choice: the
 * API resolves it from the key and rejects anything else. See
 * docs/withdrawals.md for what to do to get funds onward to a wallet you hold
 * the keys for.
 */
interface Quote {
  availableUsd: number;
  mainAvailableUsd: number;
  mainAddress: string | null;
  feeUsd: number;
  minUsd: number;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function WithdrawDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLang();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await authFetch("/api/withdraw");
        const j = (await r.json()) as Quote & { error?: string };
        if (cancelled) return;
        if (!r.ok) {
          setLoadError(true);
          setError(j.error ?? null);
          return;
        }
        setQuote(j);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(async () => {
    if (busy || !quote) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value < quote.minUsd) {
      setError(t("withdrawMinNote").replace("{min}", String(quote.minUsd)));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: value }),
      });
      const j = (await r.json()) as { amount?: string; error?: string };
      if (!r.ok) {
        setError(t("withdrawFailed").replace("{detail}", j.error ?? ""));
        track("withdraw_failed", { amount: value });
        return;
      }
      setDone(j.amount ?? value.toFixed(2));
      track("withdraw_succeeded", { amount: value });
    } catch (e) {
      setError(
        t("withdrawFailed").replace(
          "{detail}",
          e instanceof Error ? e.message : "",
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [amount, busy, quote, t]);

  return (
    <Dialog onClose={onClose} title={t("withdrawTitle")}>
      {done ? (
        <div className="px-1 py-2">
          <p className="text-[13px] leading-relaxed text-white/80">
            {t("withdrawDone").replace("{amt}", done)}
          </p>
          <button
            onClick={onClose}
            className="mt-4 w-full rounded-xl bg-lime-400 py-2.5 font-mono text-[12px] font-bold uppercase tracking-wider text-black transition-opacity hover:opacity-85"
          >
            {t("close")}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-1 py-1">
          {loadError && (
            <p className="text-[12.5px] text-red-300">{t("withdrawQuoteError")}</p>
          )}

          <div className="flex items-center justify-between font-mono text-[11.5px] text-white/55">
            <span>{t("withdrawAvailable")}</span>
            <span className="font-bold tabular-nums text-white">
              {quote
                ? `$${quote.availableUsd.toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                : "—"}
            </span>
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.05] px-4 py-3 focus-within:border-lime-400/50">
            <span className="font-mono text-[15px] text-white/40">$</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0.00"
              disabled={!quote || busy}
              className="min-w-0 flex-1 bg-transparent font-mono text-[15px] text-white tabular-nums focus:outline-none placeholder:text-white/25"
            />
            <button
              onClick={() => quote && setAmount(String(quote.availableUsd))}
              disabled={!quote || busy}
              className="font-mono text-[10px] font-bold uppercase tracking-widest text-lime-300 transition-opacity hover:opacity-75 disabled:opacity-40"
            >
              {t("withdrawMax")}
            </button>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
            <div className="font-mono text-[9.5px] font-bold uppercase tracking-widest text-white/35">
              {t("withdrawDestLabel")}
            </div>
            <div className="mt-1 text-[12.5px] text-white/85">
              {t("withdrawDestSuperior")}
              {quote?.mainAddress && (
                <span className="ml-1.5 font-mono text-[11px] text-white/40">
                  {short(quote.mainAddress)}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-white/45">
              {t("withdrawDestNote")}
            </p>
          </div>

          <p className="font-mono text-[10.5px] text-white/40">
            {t("withdrawFeeNote")}
          </p>

          {error && <p className="text-[12.5px] text-red-300">{error}</p>}

          <button
            onClick={() => void submit()}
            disabled={!quote || busy || !amount}
            className="w-full rounded-xl bg-lime-400 py-2.5 font-mono text-[12px] font-bold uppercase tracking-wider text-black transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            {busy ? t("withdrawSubmitting") : t("withdrawSubmit")}
          </button>
        </div>
      )}
    </Dialog>
  );
}
