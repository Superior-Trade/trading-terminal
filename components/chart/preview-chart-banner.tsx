"use client";

import { useEffect, useState } from "react";
import { HAS_ADVANCED_CHARTS } from "../../lib/chart-availability";

const DISMISSED = "cg-preview-chart-dismissed";

/**
 * Says which chart you are looking at, once, when it is the preview.
 *
 * The preview is honest but noticeably less capable — basic drawing only, no
 * indicator studies — and someone who does not know that will read missing
 * features as bugs. Dismissible and remembered, because a permanent banner over
 * a trading chart is its own kind of bug.
 */
export function PreviewChartBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (HAS_ADVANCED_CHARTS) return;
    try {
      if (window.localStorage.getItem(DISMISSED) !== "1") setShow(true);
    } catch {
      setShow(true); // storage blocked — showing it is the safer default
    }
  }, []);

  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    try {
      window.localStorage.setItem(DISMISSED, "1");
    } catch {
      /* session-only */
    }
  };

  return (
    <div className="pointer-events-auto absolute inset-x-0 top-3 z-30 mx-auto w-fit max-w-[min(680px,92vw)]">
      <div
        className="liquid-glass flex items-start gap-3 rounded-xl border border-amber-400/25 px-4 py-3"
        style={{ background: "rgba(251,191,36,0.08)", backdropFilter: "blur(18px)" }}
      >
        <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300" />
        <div className="min-w-0">
          <div className="font-mono text-[10.5px] font-bold uppercase tracking-widest text-amber-300">
            Preview chart
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-white/75">
            Running Lightweight Charts. The market, the agent&apos;s levels, the toolbar&apos;s
            drawing tools, and every deploy work — but the brush, text notes and
            indicator studies are off.{" "}
            <a
              href="https://www.tradingview.com/advanced-charts/"
              target="_blank"
              rel="noreferrer noopener"
              className="text-amber-200 underline underline-offset-2 hover:text-amber-100"
            >
              Request Advanced Charts
            </a>{" "}
            (free), then run{" "}
            <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px] text-amber-200">
              npm run setup:charts
            </code>
            {" "}— or use the full chart on the hosted terminal at{" "}
            <a
              href="https://terminal.superior.trade"
              target="_blank"
              rel="noreferrer noopener"
              className="text-amber-200 underline underline-offset-2 hover:text-amber-100"
            >
              terminal.superior.trade
            </a>
            .
          </p>
        </div>
        <button
          onClick={dismiss}
          className="ml-1 shrink-0 rounded-md px-2 py-1 font-mono text-[11px] text-white/45 transition-colors hover:bg-white/10 hover:text-white"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
