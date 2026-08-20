"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLang, THEMES, type Lang, type Theme, type FontScale } from "../lib/i18n";

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-full bg-white/[0.06] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-full px-2.5 py-1 font-mono text-[10.5px] font-bold transition-all ${
            value === o.value
              ? "bg-lime-400 text-black"
              : "text-white/60 hover:text-white"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Font size picker: the same "A" glyph at three real sizes, so the
 *  control demonstrates what it changes instead of relying on ±. */
function FontSizeControl({
  value,
  onChange,
}: {
  value: FontScale;
  onChange: (f: FontScale) => void;
}) {
  const { t } = useLang();
  const options: Array<{ value: FontScale; px: string; tip: string }> = [
    { value: "sm", px: "10px", tip: t("fontSmall") },
    { value: "md", px: "12.5px", tip: t("fontDefault") },
    { value: "lg", px: "15px", tip: t("fontLarge") },
  ];
  return (
    <div className="flex items-end rounded-full bg-white/[0.06] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          title={o.tip}
          aria-label={`${t("fontSize")}: ${o.tip}`}
          className={`flex h-7 flex-1 items-end justify-center rounded-full pb-0.5 font-sans font-bold leading-none transition-all ${
            value === o.value
              ? "bg-lime-400 text-black"
              : "text-white/60 hover:text-white"
          }`}
          // Fixed px (not rem): the sample sizes must not themselves scale
          // with the setting, or the visual anchors shift as you click.
          style={{ fontSize: o.px }}
        >
          A
        </button>
      ))}
    </div>
  );
}

/** Language + theme selectors, shared by the settings/account dropdown. */
export function SettingsRows() {
  const { lang, setLang, t, theme, setTheme, fontScale, setFontScale } = useLang();
  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-white/45">
          {t("language")}
        </span>
        <div className="w-28">
          <Segmented<Lang>
            value={lang}
            options={[
              { value: "en", label: "EN" },
              { value: "zh", label: "繁中" },
            ]}
            onChange={setLang}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-white/45">
          {t("themeLabel")}
        </span>
        <ThemePill theme={theme} setTheme={setTheme} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-white/45">
          {t("fontSize")}
        </span>
        <div className="w-28">
          <FontSizeControl value={fontScale} onChange={setFontScale} />
        </div>
      </div>
    </div>
  );
}

/** Four theme options, each a circle split into the scheme's two colors
 *  (surface + accent). Scheme name shows on hover via title. */
export function ThemePill({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {THEMES.map((th) => (
        <button
          key={th.id}
          type="button"
          title={th.name}
          aria-label={th.name}
          onClick={() => setTheme(th.id)}
          className={`h-5 w-5 shrink-0 cursor-pointer rounded-full transition-transform hover:scale-110 ${
            theme === th.id
              ? "ring-2 ring-lime-400 ring-offset-1 ring-offset-black/40"
              : "ring-1 ring-white/25"
          }`}
          style={{
            background: `linear-gradient(135deg, ${th.swatch} 50%, ${th.track} 50%)`,
          }}
        />
      ))}
    </div>
  );
}

/** Generic dropdown shell with click-outside + Escape handling. */
export function Dropdown({
  trigger,
  children,
  open,
  setOpen,
  panelClassName = "right-0 w-64",
}: {
  trigger: ReactNode;
  children: ReactNode;
  open: boolean;
  setOpen: (o: boolean) => void;
  /** Positioning-wrapper classes: side + width (default right-aligned 16rem). */
  panelClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);
  return (
    <div ref={ref} className="relative">
      {trigger}
      {open && (
        // Positioning wrapper is separate from the glass surface:
        // .liquid-glass forces position:relative and would cancel `absolute`.
        <div className={`absolute top-full z-50 mt-2 ${panelClassName}`}>
          <div
            className="liquid-glass rounded-xl p-1.5 shadow-2xl"
            style={{
              background: "var(--menu-fill)",
              // Inline wins over .liquid-glass's blur(4px) in the cascade.
              backdropFilter: "blur(28px)",
              WebkitBackdropFilter: "blur(28px)",
            }}
          >
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

export function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
