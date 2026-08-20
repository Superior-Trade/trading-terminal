"use client";

import { authFetch } from "./client-auth";

// Client-side analytics: fire-and-forget POST to /api/track (whitelisted
// events only — see app/api/track/route.ts). keepalive lets events survive
// an imminent reload/navigation (the login flow reloads the page).

// Identity enrichment: AuthBridge registers the logged-in user's email +
// wallet here (render-phase idempotent write, like registerTokenGetter);
// every client event carries them so the Discord feed reads as a person,
// not a DID.
let identity: Record<string, string> | null = null;
export function registerTrackIdentity(
  info: { email?: string | null; wallet?: string | null } | null,
): void {
  if (!info) {
    identity = null;
    return;
  }
  const entries = Object.entries(info).filter(([, v]) => !!v) as [
    string,
    string,
  ][];
  identity = entries.length ? Object.fromEntries(entries) : null;
}

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
        props: { ...identity, ...props },
        anonId: anonId(),
      }),
    }).catch(() => {});
  } catch {
    /* analytics never breaks the UI */
  }
}
