"use client";

import { authFetch } from "./client-auth";

// Client-side analytics: fire-and-forget POST to /api/track (whitelisted
// events only — see app/api/track/route.ts). keepalive lets events survive
// an imminent reload or navigation.
//
// Nothing is sent anywhere unless POSTHOG_KEY is configured; see lib/analytics.

function anonId(): string {
  try {
    let id = window.localStorage.getItem("cg-anon");
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem("cg-anon", id);
    }
    return id;
  } catch {
    return "no-storage";
  }
}

export function track(
  event: string,
  props?: Record<string, string | number | boolean>,
): void {
  try {
    void authFetch("/api/track", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        props,
        anonId: anonId(),
      }),
    }).catch(() => {});
  } catch {
    /* analytics never breaks the UI */
  }
}
