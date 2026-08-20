"use client";

/* Indicator menu — rendered as a fixed-position React portal in the PARENT
 * document (not inside the TV iframe), anchored to the "Indicators" button in
 * the TV toolbar. That split is what lets us use real React tooltips instead
 * of raw title="".
 *
 * Layout (the familiar flat list, NOT tier-grouped): a pinned "Top tier" strip
 * of the S/A indicators (Superior overlays first) sits above the full,
 * alphabetical TradingView catalog. Every row carries a tier badge + hover
 * tooltip when we have tier data. The list is CATALOG-DRIVEN — rows come from
 * getStudiesList() so clicking always calls createStudy() with a real study
 * name — and clicking an active study toggles it OFF. See lib/indicator-tiers.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CLASS_COLOR,
  indicatorLabelParts,
  pairShort,
  tierMeta,
  type IndicatorClass,
  type IndicatorTier,
  type Tier,
} from "../../lib/indicator-tiers";
import { Tooltip } from "../ui/tooltip";
import { useLang, type Lang } from "../../lib/i18n";

// The app's monospace "terminal" face (Space Mono). Used for acronyms, section
// heads and the search box so this menu matches the pair/account dropdowns,
// which render tickers/labels in mono rather than the default sans.
const MONO = "var(--font-space-mono), ui-monospace, SFMono-Regular, monospace";

// Tooltip/menu chrome strings (indicator NAMES stay English; only the
// surrounding UI + descriptions get translated).
const T = {
  recommended: { en: "Recommended", zh: "推薦" },
  all: { en: "All indicators", zh: "全部指標" },
  search: { en: "Search indicators…", zh: "搜尋指標…" },
  worksWith: { en: "Works well with:", zh: "搭配使用：" },
  alone: { en: "alone —", zh: "單獨使用 —" },
  inConfluence: { en: "when combined —", zh: "配合其他指標時 —" },
} as const;
const CLASS_T: Record<IndicatorClass, { en: string; zh: string }> = {
  structure: { en: "Structure", zh: "結構" },
  momentum: { en: "Momentum", zh: "動量" },
  "volatility/regime": { en: "Volatility / regime", zh: "波動率 / 市場狀態" },
  "volume/flow": { en: "Volume / flow", zh: "成交量 / 資金流" },
  trend: { en: "Trend", zh: "趨勢" },
  "derivatives/positioning": { en: "Derivatives / positioning", zh: "衍生品 / 持倉" },
};
const tr = (lang: Lang, o: { en: string; zh: string }) => o[lang] ?? o.en;

const TIER_STYLE: Record<Tier, { fg: string; bg: string }> = {
  S: { fg: "#0b0d10", bg: "#e0af68" },
  A: { fg: "#0b0d10", bg: "#9ece6a" },
  B: { fg: "#e8eaed", bg: "rgba(122,162,247,0.35)" },
  C: { fg: "#c9ced6", bg: "rgba(255,255,255,0.14)" },
  D: { fg: "#8b93a0", bg: "rgba(255,255,255,0.07)" },
};

export interface MenuAnchor {
  left: number;
  top: number;
}

// Structural subset of IChartingLibraryWidget — kept loose (ids as any, no
// EntityId) so the real widget is assignable without a cast.
interface TvWidgetLike {
  getStudiesList?: () => string[];
  activeChart: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAllStudies: () => Array<{ id: any; name: string }>;
    createStudy: (name: string) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeEntity: (id: any) => void;
  };
}

function TierBadge({ tier, paired }: { tier: Tier; paired?: Tier | null }) {
  const s = TIER_STYLE[tier];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
          padding: "2px 5px",
          borderRadius: 4,
          color: s.fg,
          background: s.bg,
        }}
      >
        {tier}
      </span>
      {paired && paired !== tier && (
        <>
          <span style={{ fontSize: 9, opacity: 0.5 }}>→</span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              lineHeight: 1,
              padding: "2px 5px",
              borderRadius: 4,
              color: TIER_STYLE[paired].fg,
              background: TIER_STYLE[paired].bg,
              opacity: 0.9,
            }}
          >
            {paired}
          </span>
        </>
      )}
    </span>
  );
}

function TooltipBody({ meta }: { meta: IndicatorTier }) {
  const { lang } = useLang();
  const paired =
    meta.pairedTier && meta.pairedTier !== meta.tier ? meta.pairedTier : null;
  const why = (lang === "zh" && meta.whyZh) || meta.why;
  const combo = (lang === "zh" && meta.comboZh) || meta.combo;
  return (
    <div
      style={{
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.14)",
        background: "rgba(14,16,20,0.98)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
        padding: "10px 12px",
        color: "rgba(255,255,255,0.9)",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
        {meta.superior && <span style={{ color: "#a3e635" }}>✦</span>}
        <strong style={{ fontSize: 12.5 }}>{meta.name}</strong>
        <span style={{ marginLeft: "auto" }}>
          <TierBadge tier={meta.tier} paired={paired} />
        </span>
      </div>
      <div
        style={{
          display: "inline-block",
          fontFamily: MONO,
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: CLASS_COLOR[meta.class],
          marginBottom: 6,
        }}
      >
        {tr(lang, CLASS_T[meta.class])}
      </div>
      <div style={{ marginBottom: paired ? 6 : 0 }}>
        <span style={{ color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>
          {paired ? `${meta.tier} ${tr(lang, T.alone)} ` : ""}
        </span>
        {why}
      </div>
      {paired && combo && (
        <div style={{ marginBottom: 6 }}>
          <span style={{ color: "#9ece6a", fontWeight: 700 }}>
            {meta.pairedTier} {tr(lang, T.inConfluence)}{" "}
          </span>
          {combo}
        </div>
      )}
      {meta.pairs.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
          <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, marginRight: 2 }}>
            {tr(lang, T.worksWith)}
          </span>
          {meta.pairs.map((p) => (
            <span
              key={p}
              title={p}
              style={{
                fontFamily: MONO,
                fontSize: 10.5,
                padding: "1px 6px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              {pairShort(p)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  name,
  meta,
  active,
  loading,
  onClick,
}: {
  name: string;
  meta: IndicatorTier | null;
  active: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  const inner = (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        boxSizing: "border-box",
        padding: "7px 9px",
        borderRadius: 8,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 500,
        color: "rgba(255,255,255,0.85)",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {/* Fixed-width leading slot so all names align (✦ or blank). */}
      <span
        style={{
          width: 12,
          flex: "none",
          display: "inline-flex",
          justifyContent: "center",
          color: "#a3e635",
          fontSize: 11,
        }}
      >
        {meta?.superior ? "✦" : ""}
      </span>
      {/* Acronym in the mono terminal face + full name in sans, mirroring the
          pair picker's "TICKER · full name" row typography. */}
      {(() => {
        const parts = indicatorLabelParts(meta?.name ?? name);
        return (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "baseline",
              gap: 7,
              overflow: "hidden",
            }}
          >
            {parts.code && (
              <span
                style={{
                  flex: "none",
                  fontFamily: MONO,
                  fontWeight: 700,
                  fontSize: 12,
                  letterSpacing: "0.02em",
                  color: "rgba(255,255,255,0.92)",
                }}
              >
                {parts.code}
              </span>
            )}
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: parts.code ? 11.5 : 12,
                color: parts.code
                  ? "rgba(255,255,255,0.5)"
                  : "rgba(255,255,255,0.88)",
              }}
            >
              {parts.full}
            </span>
          </span>
        );
      })()}
      <span
        style={{
          width: 15,
          height: 15,
          borderRadius: 4,
          flex: "none",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          color: "#fde047",
          border: `1px solid ${active ? "rgba(253,224,71,0.7)" : "rgba(255,255,255,0.3)"}`,
          background: active ? "rgba(253,224,71,0.15)" : "transparent",
        }}
      >
        {loading ? (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              border: "2px solid rgba(253,224,71,0.3)",
              borderTopColor: "#fde047",
              animation: "cg-ind-spin .7s linear infinite",
              display: "inline-block",
            }}
          />
        ) : active ? (
          "✓"
        ) : (
          ""
        )}
      </span>
    </div>
  );
  return meta ? (
    <Tooltip content={<TooltipBody meta={meta} />} side="left" maxWidth={300} block>
      {inner}
    </Tooltip>
  ) : (
    inner
  );
}

function SectionHead({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "8px 9px 4px",
        fontFamily: MONO,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.4)",
      }}
    >
      {label}
    </div>
  );
}

export interface IndicatorMenuProps {
  open: boolean;
  anchor: MenuAnchor | null;
  onClose: () => void;
  widget: TvWidgetLike | null;
  liqOn: boolean;
  liqLoading: boolean;
  onToggleLiq: () => void;
}

// Superior overlays are React-toggled, not TV studies. (The order-flow
// footprint moved to its own TV-toolbar button next to this menu.)
const OVERLAYS: Array<{ name: string; toggle: "liq" }> = [
  { name: "Liquidation Heatmap", toggle: "liq" },
];

// Studies the TV library lists but our Charting Library LICENSE doesn't enable
// (they no-op on createStudy — the bundle carries "…available only on our
// upgraded plans"). Hidden so they aren't dead clicks. Volume Profile is a
// premium add-on; re-enable by removing this once the license tier includes it.
const GATED_STUDY = /volume profile/i;

export function IndicatorMenu({
  open,
  anchor,
  onClose,
  widget,
  liqOn,
  liqLoading,
  onToggleLiq,
}: IndicatorMenuProps) {
  const { lang } = useLang();
  const [query, setQuery] = useState("");
  const [tvActive, setTvActive] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refreshActive = () => {
    if (!widget) return;
    try {
      const s = widget.activeChart().getAllStudies();
      setTvActive(new Set(s.map((x) => x.name.toLowerCase())));
    } catch {
      /* chart not ready */
    }
  };

  useEffect(() => {
    if (!open || !widget) return;
    refreshActive();
    setQuery("");
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, widget]);

  // Outside-click / Escape (parent document).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const id = setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const { featured, rest } = useMemo(() => {
    let catalog: string[] = [];
    try {
      catalog = widget?.getStudiesList?.() ?? [];
    } catch {
      /* catalog unavailable */
    }
    // Drop license-gated studies (Volume Profile family) — they no-op on click.
    catalog = catalog.filter((n) => !GATED_STUDY.test(n));

    const q = query.trim().toLowerCase();
    const match = (n: string, m: IndicatorTier | null) =>
      !q || n.toLowerCase().includes(q) || (m ? m.class.includes(q) : false);
    const label = (a: { name: string; meta: IndicatorTier | null }) =>
      a.meta?.name ?? a.name;
    const rank: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };
    // Best tier an indicator can reach — standalone OR in confluence — so
    // high-potential context tools (Donchian B→A, RSI C→A) reach the top too.
    const best = (m: IndicatorTier) =>
      Math.min(rank[m.tier], m.pairedTier ? rank[m.pairedTier] : 5);

    const annotated = catalog.map((name) => ({ name, meta: tierMeta(name) }));
    const seen = new Set<string>();
    const keep = (a: { name: string; meta: IndicatorTier | null }) => {
      const l = label(a);
      if (seen.has(l) || !match(a.name, a.meta)) return false; // de-dup + search
      seen.add(l);
      return true;
    };
    // Featured = anything whose best reachable tier is S or A (order matters:
    // claim these labels first so they don't reappear in the flat list).
    const featured = annotated
      .filter((a) => a.meta && best(a.meta) <= rank.A)
      // Superior-exclusive overlays lead the list — they're the product's
      // edge; ties broken by best reachable tier, then name.
      .sort(
        (a, b) =>
          Number(Boolean(b.meta!.superior)) - Number(Boolean(a.meta!.superior)) ||
          best(a.meta!) - best(b.meta!) ||
          label(a).localeCompare(label(b)),
      )
      .filter(keep);
    // Everything else stays in the flat catalog list.
    const rest = annotated
      .filter(keep)
      .sort((a, b) => label(a).localeCompare(label(b)));
    return { featured, rest };
  }, [widget, query, open]);

  if (!open || !anchor || typeof document === "undefined") return null;

  const toggleStudy = (name: string) => {
    if (!widget) return;
    try {
      const chart = widget.activeChart();
      const matches = chart
        .getAllStudies()
        .filter((s) => s.name.toLowerCase() === name.toLowerCase());
      if (matches.length) {
        // Already on → toggle OFF.
        for (const s of matches) chart.removeEntity(s.id);
      } else {
        chart.createStudy(name);
      }
      setTimeout(refreshActive, 350);
    } catch {
      /* invalid study name */
    }
  };

  const overlayActive = (t: "liq") => (t === "liq" ? liqOn : false);
  const overlayToggle = (t: "liq") => onToggleLiq();
  const q = query.trim().toLowerCase();
  const overlaysShown = OVERLAYS.filter((o) => !q || o.name.toLowerCase().includes(q));

  return createPortal(
    <>
      <style>{"@keyframes cg-ind-spin{to{transform:rotate(360deg)}}"}</style>
      {/* Positioning wrapper kept separate from the glass: liquid-glass forces
          position:relative, matching the pair/account dropdowns' structure. */}
      <div
        ref={panelRef}
        style={{ position: "fixed", left: anchor.left, top: anchor.top, zIndex: 2147482000, width: 344 }}
      >
      <div
        role="menu"
        className="liquid-glass rounded-xl shadow-2xl"
        style={{
          maxHeight: "min(70vh, 560px)",
          display: "flex",
          flexDirection: "column",
          padding: 8,
          background: "var(--menu-fill)",
          backdropFilter: "blur(28px)",
          WebkitBackdropFilter: "blur(28px)",
        }}
      >
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr(lang, T.search)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            marginBottom: 6,
            padding: "8px 11px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.12)",
            outline: "none",
            background: "rgba(255,255,255,0.04)",
            color: "rgba(255,255,255,0.9)",
            fontFamily: MONO,
            fontSize: 13,
          }}
        />
        <div style={{ overflowY: "auto", minHeight: 0 }}>
          {(overlaysShown.length > 0 || featured.length > 0) && (
            <SectionHead label={tr(lang, T.recommended)} />
          )}
          {overlaysShown.map((o) => (
            <Row
              key={o.name}
              name={o.name}
              meta={tierMeta(o.name)}
              active={overlayActive(o.toggle)}
              loading={o.toggle === "liq" && liqLoading}
              onClick={() => overlayToggle(o.toggle)}
            />
          ))}
          {featured.map((a) => (
            <Row
              key={a.name}
              name={a.name}
              meta={a.meta}
              active={tvActive.has(a.name.toLowerCase())}
              onClick={() => toggleStudy(a.name)}
            />
          ))}
          {rest.length > 0 && <SectionHead label={tr(lang, T.all)} />}
          {rest.map((a) => (
            <Row
              key={a.name}
              name={a.name}
              meta={a.meta}
              active={tvActive.has(a.name.toLowerCase())}
              onClick={() => toggleStudy(a.name)}
            />
          ))}
        </div>
      </div>
      </div>
    </>,
    document.body,
  );
}
