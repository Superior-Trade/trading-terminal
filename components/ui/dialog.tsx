"use client";

/* Standard dialog for the terminal — one look, four sizes.
 * size: sm 360px (confirms), md 480px (forms), lg 640px (rich content,
 * previews), xl 880px (wide editors / side-by-side). All center-screen,
 * glass style, backdrop-dismiss, ESC to close, scroll inside.
 */

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLang } from "../../lib/i18n";

export type DialogSize = "sm" | "md" | "lg" | "xl";

const WIDTHS: Record<DialogSize, number> = { sm: 360, md: 480, lg: 640, xl: 880 };

export function Dialog({
  title,
  size = "md",
  onClose,
  icon,
  children,
}: {
  title?: ReactNode;
  size?: DialogSize;
  onClose: () => void;
  /** Optional visual — rendered as a left column (used by soft-warning
   *  dialogs to carry a glass icon beside the message). */
  icon?: ReactNode;
  children: ReactNode;
}) {
  // Context flows through portals, so useLang still resolves — every Dialog
  // call site sits inside TerminalShell's I18nProvider.
  const { t } = useLang();
  // Portal to <body>: ancestors with backdrop-filter/transform (the glass
  // sidebar) become containing blocks for position:fixed, which traps the
  // overlay inside them — a dialog must always cover the whole screen.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Scroll lives on an INNER wrapper, not the .liquid-glass-strong panel:
          that class sets `overflow: hidden` (to clip its rounded-border ::before
          overlay), which — being later in the cascade — beats an `overflow-y-auto`
          utility on the same element and silently traps tall content (e.g. many
          accounts). The inner div owns the max-height + scroll instead. */}
      <div
        className="liquid-glass-strong w-full rounded-2xl border border-white/12"
        style={{ background: "var(--glass-strong-fill)", maxWidth: WIDTHS[size] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="max-h-[92vh] overflow-y-auto p-5">
          <div className={icon != null ? "flex gap-4" : undefined}>
            {icon != null && <div className="shrink-0 pt-0.5">{icon}</div>}
            <div className="min-w-0 flex-1">
              {title != null && (
                <div className="mb-4 flex items-center justify-between">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-white/70">
                    {title}
                  </span>
                  <button
                    onClick={onClose}
                    aria-label={t("close")}
                    className="text-white/50 transition-colors hover:text-white"
                  >
                    ✕
                  </button>
                </div>
              )}
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
