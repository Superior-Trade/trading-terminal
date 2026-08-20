import { NextResponse } from "next/server";
import { requireUser, type AuthedUser } from "../../../lib/server-auth";
import { track, trackFlush } from "../../../lib/analytics";

export const runtime = "nodejs";

// Client-side funnel events (lib/track.ts). Server-originated actions
// (deploy, compile, deposit credit …) are tracked directly in their route
// handlers with server-verified props — this endpoint only accepts the
// whitelisted UI-interaction set below, because the event name becomes a
// Discord channel: an open set would let any client spam channels into
// existence.
const CLIENT_EVENTS = new Set([
  "page_view",
  "login_completed",
  "logged_out",
  "deposit_opened",
  "deposit_method_selected",
  "deposit_address_copied",
  "pair_changed",
  "accounts_opened",
  "inbox_opened",
  "share_card_opened",
  "detect_failed",
  "deploy_failed",
]);

// Per-warm-instance limiter: 60 events/min per identity. Analytics is
// best-effort — over-limit events are dropped with a 200, not an error the
// client would retry.
const buckets = new Map<string, { n: number; t: number }>();
function allow(id: string): boolean {
  const now = Date.now();
  const b = buckets.get(id);
  if (!b || now - b.t > 60_000) {
    if (buckets.size > 5000) buckets.clear();
    buckets.set(id, { n: 1, t: now });
    return true;
  }
  return ++b.n <= 60;
}

export async function POST(req: Request) {
  // Pre-login events are part of the funnel — auth failure means anonymous,
  // not rejected.
  let user: AuthedUser | null = null;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (!(e instanceof Response)) throw e;
  }

  let body: { event?: unknown; props?: unknown; anonId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const event = typeof body.event === "string" ? body.event : "";
  if (!CLIENT_EVENTS.has(event)) {
    return NextResponse.json({ error: "unknown event" }, { status: 400 });
  }

  const anon =
    typeof body.anonId === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(body.anonId)
      ? body.anonId
      : null;
  const distinctId = user?.did ?? (anon ? `anon:${anon}` : "anon");
  if (!allow(distinctId)) return NextResponse.json({ ok: true });

  // Sanitize props: scalar values only, bounded count/length.
  const props: Record<string, string | number | boolean> = {};
  if (body.props && typeof body.props === "object") {
    for (const [k, v] of Object.entries(body.props).slice(0, 16)) {
      if (!/^[a-zA-Z0-9_]{1,32}$/.test(k)) continue;
      if (typeof v === "string") props[k] = v.slice(0, 300);
      else if (typeof v === "number" || typeof v === "boolean") props[k] = v;
    }
  }

  // debug: run the sink inline and report the outcome + whether analytics is
  // configured at all, so delivery can be diagnosed without server-log access.
  // No secret values are exposed.
  if ((body as { debug?: boolean }).debug) {
    const outcome = await trackFlush(event, { user: distinctId, props });
    return NextResponse.json({
      ok: true,
      outcome,
      configured: { posthog: Boolean(process.env.POSTHOG_KEY) },
    });
  }
  track(event, { user: distinctId, props });
  return NextResponse.json({ ok: true });
}
