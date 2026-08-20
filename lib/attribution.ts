"use client";

// First-touch traffic-source attribution.
//
// We don't ship posthog-js (analytics is a custom server fan-out — see
// lib/analytics.ts), so the automatic UTM/referrer first-touch capture that
// SDK would give us is done here by hand. On the first-ever load we read UTM
// tags + click-ids + the referrer, persist them to localStorage, and attach
// them (prefixed ft_) to page_view. The server promotes ft_* to PostHog
// person properties via $set_once, so a later login/deposit/deploy is
// attributed back to the acquisition source.
//
// Why UTM tags and not referrer alone: Instagram/TikTok/X in-app browsers
// usually send NO referrer, and our Referrer-Policy strips cross-origin
// referrers to origin. Tag your links with utm_source and attribution is
// reliable; the referrer/click-id inference below is only a fallback.

const KEY = "cg-first-touch";

// Click-id → inferred source when no utm_source is present (paid social/search).
const CLICK_ID_SOURCE: Record<string, string> = {
  fbclid: "facebook",
  igshid: "instagram",
  ttclid: "tiktok",
  twclid: "twitter",
  gclid: "google",
  li_fat_id: "linkedin",
};

export interface FirstTouch {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  referrer?: string;
  landing?: string;
  ts?: number;
}

/** Capture & persist first-touch acquisition data. Idempotent: writes only
 *  when nothing is stored yet, so the value survives a page reload
 *  and every later load (true first-touch). Safe to call on any load. */
export function captureFirstTouch(): FirstTouch {
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing) return JSON.parse(existing) as FirstTouch;

    const q = new URLSearchParams(window.location.search);
    const get = (k: string) => q.get(k) || undefined;

    // Priority: explicit utm_source → ?ref= → click-id inference → referrer host.
    let source = get("utm_source") || get("ref");
    let medium = get("utm_medium");
    if (!source) {
      for (const [id, name] of Object.entries(CLICK_ID_SOURCE)) {
        if (q.get(id)) {
          source = name;
          medium = medium || "paid";
          break;
        }
      }
    }
    const ref = document.referrer || "";
    if (!source && ref) {
      try {
        source = new URL(ref).hostname.replace(/^www\./, "");
        medium = medium || "referral";
      } catch {
        /* malformed referrer — leave source unset */
      }
    }

    const ft: FirstTouch = {
      source: source || "direct",
      medium: medium || undefined,
      campaign: get("utm_campaign"),
      content: get("utm_content"),
      term: get("utm_term"),
      referrer: ref || "direct",
      landing: (window.location.pathname + window.location.search).slice(0, 300),
      ts: Date.now(),
    };
    window.localStorage.setItem(KEY, JSON.stringify(ft));
    return ft;
  } catch {
    return {};
  }
}

/** Flattened ft_* props for an analytics event. Empty fields are omitted so
 *  the 16-prop cap in /api/track isn't wasted. */
export function attributionProps(): Record<string, string> {
  const ft = captureFirstTouch();
  const out: Record<string, string> = {};
  if (ft.source) out.ft_source = ft.source;
  if (ft.medium) out.ft_medium = ft.medium;
  if (ft.campaign) out.ft_campaign = ft.campaign;
  if (ft.content) out.ft_content = ft.content;
  if (ft.term) out.ft_term = ft.term;
  if (ft.referrer) out.ft_referrer = ft.referrer;
  return out;
}
