"use client";

import { useEffect, useState } from "react";
import { useLang } from "../../lib/i18n";
import { authFetch } from "../../lib/client-auth";
import { useAuthGate } from "../providers";

// Pinned near-cap notice for the daily/burst LLM rate limits. Polls
// /api/usage (read-only, never increments) and shows a slim bar when the user
// is within 10% of a DAILY cap or at a per-minute BURST cap. Auto-hides once
// the window refreshes back under the threshold. Other surfaces can force an
// immediate re-check by dispatching `cg:usage-refresh`.

interface WindowUsage {
  used: number;
  limit: number;
  resetAt: number;
}
interface RouteUsage {
  day: WindowUsage;
  min: WindowUsage;
}
type Usage = Record<"chat" | "compile", RouteUsage>;

interface Hit {
  route: "chat" | "compile";
  scope: "day" | "min";
  used: number;
  limit: number;
  resetAt: number;
}

function nearCap(u: Usage | null): Hit | null {
  if (!u) return null;
  // Daily caps first (the meaningful "you're almost out" signal); burst only
  // when actually maxed (it refreshes within a minute).
  for (const route of ["chat", "compile"] as const) {
    const d = u[route].day;
    if (d.limit - d.used <= Math.ceil(d.limit * 0.1)) {
      return { route, scope: "day", used: d.used, limit: d.limit, resetAt: d.resetAt };
    }
  }
  for (const route of ["chat", "compile"] as const) {
    const m = u[route].min;
    if (m.used >= m.limit) {
      return { route, scope: "min", used: m.used, limit: m.limit, resetAt: m.resetAt };
    }
  }
  return null;
}

export function RateLimitBanner() {
  const { authed } = useAuthGate();
  const { t, lang } = useLang();
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    if (!authed) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const r = await authFetch("/api/usage");
        if (!r.ok) return;
        const j = (await r.json()) as { usage?: Usage };
        if (!cancelled) setUsage(j.usage ?? null);
      } catch {
        /* best effort — the banner is advisory */
      }
    };
    void load();
    const iv = setInterval(() => void load(), 45_000);
    const onRefresh = () => void load();
    const onVis = () => {
      if (!document.hidden) void load();
    };
    window.addEventListener("cg:usage-refresh", onRefresh);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(iv);
      window.removeEventListener("cg:usage-refresh", onRefresh);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [authed]);

  const hit = nearCap(usage);
  if (!hit) return null;

  const remaining = Math.max(0, hit.limit - hit.used);
  const atCap = remaining === 0;
  const routeLabel = t(hit.route === "chat" ? "rlRouteChat" : "rlRouteCompile");
  const reset =
    hit.scope === "min"
      ? t("rlResetsSoon")
      : t("rlResetsAt").replace(
          "{time}",
          new Date(hit.resetAt).toLocaleTimeString(lang === "zh" ? "zh-TW" : "en-US", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        );
  const headline = atCap
    ? t("rlAtCap").replace("{route}", routeLabel)
    : t("rlNearCap")
        .replace("{route}", routeLabel)
        .replace("{n}", String(remaining))
        .replace("{limit}", String(hit.limit));

  return (
    <div
      className="pointer-events-none fixed left-1/2 top-16 z-[60] -translate-x-1/2"
      role="status"
    >
      <div
        className={`pointer-events-auto flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-[11px] font-semibold shadow-lg backdrop-blur-md ${
          atCap
            ? "border-red-400/40 bg-red-500/15 text-red-200"
            : "border-amber-400/40 bg-amber-500/15 text-amber-200"
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${atCap ? "bg-red-400" : "bg-amber-400 animate-pulse"}`} />
        <span>{headline}</span>
        <span className="text-white/45">·</span>
        <span className="text-white/60">{reset}</span>
      </div>
    </div>
  );
}
