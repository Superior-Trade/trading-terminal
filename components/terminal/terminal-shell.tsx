"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import {
  HyperliquidProvider,
  useHyperliquid,
  coinToPair,
  pairToSlug,
} from "../../lib/hyperliquid-provider";
import { ChartBridgeProvider } from "../../lib/chart-bridge";
import { SetupsProvider, useSetups } from "../../lib/setups-context";
import { I18nProvider, useLang } from "../../lib/i18n";
import { PrivacyProvider } from "../../lib/privacy";
import { useServerPrefs } from "../../lib/server-prefs";
import { Header } from "./header";
import { RateLimitBanner } from "./rate-limit-banner";
import { DeploymentsPanel } from "./deployments-panel";
import { FloatingChat } from "../chat/floating-chat";
import { HAS_ADVANCED_CHARTS } from "../../lib/chart-availability";
import { PreviewChartBanner } from "../chart/preview-chart-banner";

// Both chart bundles touch browser globals; never SSR either.
//
// Which one mounts is decided at build time by whether TradingView's Advanced
// Charts was installed (next.config.ts). The preview is a real fallback rather
// than a placeholder — see components/chart/preview-chart.tsx for what it gives
// up — and it exists so a fresh clone runs without waiting on TradingView.
const TradingChart = dynamic(
  () => import("../chart/trading-chart").then((m) => m.TradingChart),
  { ssr: false },
);
const PreviewChart = dynamic(
  () => import("../chart/preview-chart").then((m) => m.PreviewChart),
  { ssr: false },
);
const Chart = HAS_ADVANCED_CHARTS ? TradingChart : PreviewChart;

const DEFAULT_PAIR = "BTC-USD";

// Selected market, owned here so the header picker, chart, and agent
// (set_symbol action) all see one source of truth.
const PairContext = createContext<{
  pair: string;
  setPair: (p: string) => void;
}>({ pair: DEFAULT_PAIR, setPair: () => {} });

export function usePair() {
  return useContext(PairContext);
}

// Sidebar drag-divider. Own component: TerminalShell renders I18nProvider
// itself, so the localized tooltip must come from a child inside it.
function ResizeDivider({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  const { t } = useLang();
  return (
    <div
      onMouseDown={onMouseDown}
      className="hidden w-1 shrink-0 cursor-col-resize bg-white/5 transition-colors hover:bg-lime-400/40 md:block"
      title={t("dragResize")}
    />
  );
}

// Resolves a URL slug (e.g. "XYZ-SKHX") to its canonical pair once the market
// universe has loaded, and switches the chart to it. Lives inside the provider
// so it can read `assets`. Runs once per slug.
function PairSlugResolver({ slug }: { slug?: string }) {
  const { assets } = useHyperliquid();
  const { pair, setPair } = usePair();
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !slug || !assets.length) return;
    const want = slug.toUpperCase();
    const match = assets.find((a) => pairToSlug(coinToPair(a.name)) === want);
    applied.current = true; // one-shot, even if unmatched (stay on default)
    if (match) {
      const canonical = coinToPair(match.name);
      if (canonical !== pair) setPair(canonical);
    }
  }, [slug, assets, pair, setPair]);
  return null;
}

// Overlay banner floated over the chart while a detected setup is marked.
// Confirms WHICH setup is drawn and offers a one-tap Undo to deselect it.
// Lives inside SetupsProvider (so it reads activePlan) and the relative <main>.
function ChartSetupBanner() {
  const { activePlan, markedKey, markedLabel, clearMark } = useSetups();
  const { t, lang } = useLang();
  // Show for ANY current mark — a detected plan (activePlan) OR a marked
  // previous/deployed setup (markedKey with no activePlan; named by markedLabel).
  if (!markedKey) return null;
  const name = activePlan
    ? (lang === "zh" && activePlan.zh?.title) || activePlan.title || activePlan.symbol || ""
    : markedLabel || "";
  return (
    <div className="pointer-events-none absolute left-1/2 top-20 z-30 flex w-full -translate-x-1/2 justify-center px-3">
      <div className="pointer-events-auto flex max-w-[min(90vw,520px)] items-center gap-3 rounded-full border border-lime-400/30 bg-black/80 px-4 py-1.5 text-xs shadow-lg backdrop-blur-sm">
        <span className="flex min-w-0 items-center gap-1.5 text-white/85">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-lime-400" />
          <span className="truncate">
            {t("setupBannerShowing").replace("{name}", name)}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void clearMark()}
          className="shrink-0 cursor-pointer rounded-full border border-white/15 px-2.5 py-0.5 font-medium text-white/70 transition-colors hover:border-white/30 hover:text-white"
        >
          {t("setupBannerUndo")}
        </button>
      </div>
    </div>
  );
}

// Mobile-only access to the setups sidebar (which is hidden below md): a
// floating launcher that opens the panel as a full-screen sheet.
function MobileSetups() {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={t("setupsSheet")}
        className="fixed right-3 top-[4.25rem] z-40 flex items-center gap-1.5 rounded-full border border-lime-400/30 bg-black/75 px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-lime-300 backdrop-blur-md transition-colors hover:text-lime-200 md:hidden"
      >
        {t("setupsSheet")}
      </button>
      {open && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-[var(--app-bg)] md:hidden">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
            <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-white/70">
              {t("setupsSheet")}
            </span>
            <button
              onClick={() => setOpen(false)}
              aria-label={t("close")}
              className="cursor-pointer px-1 text-white/55 transition-colors hover:text-white"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <DeploymentsPanel />
          </div>
        </div>
      )}
    </>
  );
}

export function TerminalShell({ initialPairSlug }: { initialPairSlug?: string }) {
  // Divider position persists in the cg-sw cookie; the server layout reads it
  // so a reload paints at the saved width immediately.
  const serverPrefs = useServerPrefs();
  const [sidebarWidth, setSidebarWidth] = useState(serverPrefs.sidebarWidth ?? 450);
  const widthRef = useRef(serverPrefs.sidebarWidth ?? 450);
  // Pair is deep-linked as a clean root path (/BTC-USD, /XYZ-SKHX) so a shared
  // link opens the right asset. Start from DEFAULT_PAIR for SSR/hydration
  // stability; PairSlugResolver applies the path slug once the universe loads.
  // Every switch rewrites the path.
  const [pair, setPairState] = useState(DEFAULT_PAIR);
  const setPair = useCallback((p: string) => {
    setPairState(p);
    try {
      const url = new URL(window.location.href);
      url.pathname = `/${pairToSlug(p)}`;
      url.search = ""; // drop any legacy ?pair= param
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* non-browser / opaque origin */
    }
    // Broadcast the switch so the setups panel can drop a plan selection
    // that belongs to a different market (event bus avoids a provider cycle
    // — SetupsProvider is mounted below PairContext).
    try {
      window.dispatchEvent(new CustomEvent("cg:pair-changed", { detail: { pair: p } }));
    } catch {
      /* non-browser */
    }
  }, []);
  const dragging = useRef(false);
  // While dragging we lay a transparent full-window overlay OVER the chart
  // iframe. Otherwise, dragging left moves the cursor into TradingView's
  // iframe, which captures the mouse and starves our window mousemove — so
  // the divider only worked dragging right (away from the chart).
  const [isDragging, setIsDragging] = useState(false);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    setIsDragging(true);
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const w = Math.min(700, Math.max(280, window.innerWidth - ev.clientX));
      widthRef.current = w;
      setSidebarWidth(w);
    };
    const onUp = () => {
      dragging.current = false;
      setIsDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Persist the divider position; the server layout reads this cookie so
      // the next load paints at the saved width (no jump).
      try {
        document.cookie = `cg-sw=${Math.round(widthRef.current)}; path=/; max-age=31536000; SameSite=Lax`;
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <HyperliquidProvider>
      <ChartBridgeProvider>
        <I18nProvider>
        <PrivacyProvider>
        <PairContext.Provider value={{ pair, setPair }}>
        <PairSlugResolver slug={initialPairSlug} />
        <SetupsProvider>
        <div
          className="flex h-dvh flex-col"
          style={{ background: "var(--app-bg)" }}
        >
          <Header />
          <RateLimitBanner />
          <div className="flex min-h-0 flex-1">
            <main className="relative min-w-0 flex-1">
              {/* DetectChip removed by user request — detection lives in the
                  sidebar panel; the chart stays clean when drawing. */}
              <Chart pair={pair} onSymbolChange={setPair} resolution="240" />
              <PreviewChartBanner />
              <ChartSetupBanner />
              <FloatingChat />
            </main>
            <ResizeDivider onMouseDown={startDrag} />
            <div style={{ width: sidebarWidth }} className="hidden shrink-0 md:flex">
              <DeploymentsPanel />
            </div>
          </div>
          <MobileSetups />
          {/* Drag shield: sits above the chart iframe so the mouse stays with
              our window while resizing (fixes leftward drag stalling). */}
          {isDragging && (
            <div className="fixed inset-0 z-50 cursor-col-resize" style={{ userSelect: "none" }} />
          )}
        </div>
        </SetupsProvider>
        </PairContext.Provider>
        </PrivacyProvider>
        </I18nProvider>
      </ChartBridgeProvider>
    </HyperliquidProvider>
  );
}
