"use client";

/* Inbox — fill/TP/SL notifications for the user's strategy wallets.
 * Source of truth is the exchange: one HL WebSocket userFills subscription
 * per deployment wallet (shared SubscriptionClient, snapshots skipped).
 * Events persist in localStorage; when the tab is hidden a native browser
 * Notification mirrors the event (permission requested on first bell click).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useHyperliquid } from "../../lib/hyperliquid-provider";
import { useLang } from "../../lib/i18n";
import { authFetch } from "../../lib/client-auth";
import { track } from "../../lib/track";

interface InboxEvent {
  id: string; // fill hash+coin — dedup key
  t: number;
  coin: string;
  action: string; // "Open Long" | "Close Short" | raw dir
  px: number;
  sz: number;
  pnl: number | null; // closedPnl for closing fills
  read: boolean;
  // Generic notices (deposit / withdrawal / system) set these; exchange fills
  // leave them undefined. When `title` is present the item renders from
  // title/body/kind instead of the fills fields above.
  kind?: InboxItemKind;
  title?: string;
  body?: string;
}

/** Fire a generic inbox notice from anywhere (deposit/withdraw dialogs, …).
 *  The mounted <Inbox> listens for this and persists + surfaces it. Strings
 *  are passed already-localized so the inbox stays presentation-only. */
export function pushInboxNotice(notice: {
  kind?: InboxItemKind;
  title: string;
  body?: string;
  id?: string;
}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("cg:inbox", { detail: notice }));
}

/* Generic inbox item — every message type (fills today; deploy notices,
 * system alerts, … tomorrow) maps onto this shape instead of hardcoding a
 * fills-only row: [kind glyph] [title + free-form body] [relative time]. */
type InboxItemKind = "open" | "close" | "info";

interface InboxItemModel {
  kind: InboxItemKind;
  title: string;
  body?: ReactNode; // free-form detail — may be multi-line, wraps
  time: number; // epoch ms
}

const STORE_KEY = "cg-inbox:v1";
const NOTIFY_KEY = "cg-inbox-notify";
const CAP = 50;

/* "3m ago" / "1h ago" / "2d ago" (en) — 「3分鐘前 / 1小時前 / 2天前」 (zh);
 * under a minute reads "just now" / 「剛剛」. */
function relTime(ts: number, t: (key: string) => string): string {
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return t("relJustNow");
  if (mins < 60) return t("relMinutes").replace("{n}", String(mins));
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("relHours").replace("{n}", String(hours));
  return t("relDays").replace("{n}", String(Math.floor(hours / 24)));
}

const GLYPH_STYLE: Record<InboxItemKind, string> = {
  open: "text-lime-300 border-lime-300/30 bg-lime-300/10",
  close: "text-sky-300 border-sky-300/30 bg-sky-300/10",
  info: "text-white/50 border-white/15 bg-white/[0.06]",
};

function KindGlyph({ kind }: { kind: InboxItemKind }) {
  return (
    <span
      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${GLYPH_STYLE[kind]}`}
      aria-hidden
    >
      {kind === "info" ? (
        <span className="h-1 w-1 rounded-full bg-current" />
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-2.5 w-2.5">
          {kind === "open" ? (
            <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="M7 7l10 10M17 9v8H9" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      )}
    </span>
  );
}

function InboxItem({ item }: { item: InboxItemModel }) {
  const { t, lang } = useLang();
  return (
    <div className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-white/[0.05]">
      <KindGlyph kind={item.kind} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] font-bold text-white/85">
          {item.title}
        </div>
        {item.body != null && (
          <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[10.5px] leading-snug tabular-nums text-white/55">
            {item.body}
          </div>
        )}
      </div>
      <span
        className="shrink-0 pt-px text-right font-mono text-[9.5px] text-white/35"
        title={new Date(item.time).toLocaleString(lang === "zh" ? "zh-TW" : "en-US")}
      >
        {relTime(item.time, t)}
      </span>
    </div>
  );
}

function load(): InboxEvent[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
    </svg>
  );
}

export function Inbox() {
  const { subscription } = useHyperliquid();
  const { t, lang } = useLang();
  const zh = lang === "zh";
  const [events, setEvents] = useState<InboxEvent[]>(() =>
    typeof window === "undefined" ? [] : load(),
  );
  const [open, setOpen] = useState(false);
  // Browser-notification switch: user preference (localStorage) AND the
  // browser permission must both be on. Turning the switch on doubles as
  // the permission trigger; "denied" can only be undone in browser settings.
  const [notifyPref, setNotifyPref] = useState(true);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");
  useEffect(() => {
    try {
      setNotifyPref(localStorage.getItem(NOTIFY_KEY) !== "0");
    } catch {
      /* ignore */
    }
    setPerm(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, []);
  const notifyOn = notifyPref && perm === "granted";
  const toggleNotify = async () => {
    if (perm === "unsupported" || perm === "denied") return;
    if (notifyOn) {
      setNotifyPref(false);
      try {
        localStorage.setItem(NOTIFY_KEY, "0");
      } catch {
        /* ignore */
      }
      return;
    }
    let p: NotificationPermission | "unsupported" = perm;
    if (p === "default") {
      p = await Notification.requestPermission();
      setPerm(p);
    }
    if (p === "granted") {
      setNotifyPref(true);
      try {
        localStorage.setItem(NOTIFY_KEY, "1");
      } catch {
        /* ignore */
      }
    }
  };
  const subsRef = useRef<Map<string, { unsubscribe: () => Promise<unknown> }>>(new Map());
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const push = useCallback(
    (ev: InboxEvent) => {
      setEvents((prev) => {
        if (prev.some((e) => e.id === ev.id)) return prev;
        const next = [ev, ...prev].slice(0, CAP);
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(next));
        } catch {
          /* quota */
        }
        return next;
      });
      // Native notification only when the user isn't looking at the app —
      // and only while the inbox switch is on (read fresh from storage so
      // this callback never sees a stale preference).
      let prefOn = true;
      try {
        prefOn = localStorage.getItem(NOTIFY_KEY) !== "0";
      } catch {
        /* ignore */
      }
      if (
        prefOn &&
        document.hidden &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        if (ev.title) {
          // Generic notice (deposit/withdraw/system) — already localized.
          new Notification(ev.title, {
            body: ev.body ?? "",
            icon: "/logo-dark.png",
            tag: ev.id,
          });
        } else {
          const sign = ev.pnl != null ? (ev.pnl >= 0 ? "+" : "") : "";
          new Notification(`${ev.action} · ${ev.coin} @ ${ev.px}`, {
            body:
              ev.pnl != null
                ? `PnL ${sign}$${ev.pnl.toFixed(2)}`
                : `${zh ? "數量" : "size"} ${ev.sz}`,
            icon: "/logo-dark.png",
            tag: ev.id,
          });
        }
      }
    },
    [zh],
  );

  // Discover deployment wallets (60s, paused when hidden) and keep one
  // userFills subscription per wallet on the shared WS.
  useEffect(() => {
    let cancelled = false;
    const subs = subsRef.current;
    const sync = async () => {
      if (document.hidden) return;
      try {
        const r = await authFetch("/api/deployments/pnl");
        const j = await r.json();
        if (cancelled || !j.items) return;
        const wallets = new Set<string>(
          (Object.values(j.items) as Array<{ walletAddress?: string | null }>)
            .map((d) => d.walletAddress)
            .filter((w): w is string => Boolean(w)),
        );
        for (const w of wallets) {
          if (subs.has(w)) continue;
          try {
            const sub = await subscription.userFills(
              { user: w as `0x${string}` },
              (data: {
                isSnapshot?: boolean;
                fills: Array<{
                  hash?: string;
                  tid?: number;
                  time: number;
                  coin: string;
                  dir?: string;
                  side?: string;
                  px: string;
                  sz: string;
                  closedPnl?: string;
                  fee?: string;
                }>;
              }) => {
                if (data.isSnapshot) return; // history, not news
                // A single position close often arrives as several partial
                // fills, each carrying only ITS slice of closedPnl. Showing one
                // fill's raw number is misleading (e.g. −0.17 when the position
                // actually realized −7.80). Aggregate the batch's closing fills
                // per coin into ONE notification whose PnL is net of fees —
                // Σ(closedPnl − fee) — matching the running-setups card exactly.
                const closes = new Map<
                  string,
                  { net: number; sz: number; px: number; dir: string; t: number; id: string }
                >();
                for (const f of data.fills ?? []) {
                  if (/close/i.test(f.dir ?? "")) {
                    const g = closes.get(f.coin) ?? {
                      net: 0,
                      sz: 0,
                      px: 0,
                      dir: f.dir ?? (zh ? "平倉" : "Close"),
                      t: f.time,
                      id: `${f.hash ?? f.tid ?? f.time}-${f.coin}-close`,
                    };
                    g.net += parseFloat(f.closedPnl ?? "0") - parseFloat(f.fee ?? "0");
                    g.sz += parseFloat(f.sz);
                    g.px = parseFloat(f.px); // last fill's price
                    g.t = Math.max(g.t, f.time);
                    closes.set(f.coin, g);
                  } else {
                    // Opening / non-realizing fill — announce as-is, no PnL.
                    push({
                      id: `${f.hash ?? f.tid ?? f.time}-${f.coin}-${f.px}`,
                      t: f.time,
                      coin: f.coin,
                      action:
                        f.dir ??
                        (f.side === "B" ? (zh ? "買入" : "Buy") : zh ? "賣出" : "Sell"),
                      px: parseFloat(f.px),
                      sz: parseFloat(f.sz),
                      pnl: null,
                      read: false,
                    });
                  }
                }
                for (const [coin, g] of closes) {
                  push({
                    id: g.id,
                    t: g.t,
                    coin,
                    action: g.dir,
                    px: g.px,
                    sz: g.sz,
                    pnl: Number(g.net.toFixed(4)),
                    read: false,
                  });
                }
              },
            );
            subs.set(w, sub);
          } catch {
            /* WS unavailable — next sync retries */
          }
        }
      } catch {
        /* not authed yet */
      }
    };
    void sync();
    const timer = setInterval(() => void sync(), 60_000);
    // Refresh on return to a backgrounded tab (interval no-ops while hidden).
    const onVisible = () => {
      if (!document.hidden) void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      for (const s of subs.values()) s.unsubscribe().catch(() => {});
      subs.clear();
    };
  }, [subscription, push, zh]);

  // Generic notices from elsewhere (deposit credited, withdrawal sent/failed,
  // system) arrive on the cg:inbox window event and are persisted like fills.
  useEffect(() => {
    const onNotice = (e: Event) => {
      const d = (e as CustomEvent<{
        kind?: InboxItemKind;
        title?: string;
        body?: string;
        id?: string;
      }>).detail;
      if (!d?.title) return;
      push({
        id: d.id ?? `notice-${d.title}-${Date.now()}`,
        t: Date.now(),
        coin: "",
        action: "",
        px: 0,
        sz: 0,
        pnl: null,
        read: false,
        kind: d.kind ?? "info",
        title: d.title,
        body: d.body,
      });
    };
    window.addEventListener("cg:inbox", onNotice);
    return () => window.removeEventListener("cg:inbox", onNotice);
  }, [push]);

  const unread = events.filter((e) => !e.read).length;

  // Relative timestamps drift — re-render every 30s while the dropdown is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  // Map exchange fill events onto the generic item model.
  const toItem = (e: InboxEvent): InboxItemModel => {
    // Generic notices carry their own presentation.
    if (e.title) {
      return { kind: e.kind ?? "info", title: e.title, body: e.body, time: e.t };
    }
    const kind: InboxItemKind = /open|buy|買/i.test(e.action)
      ? "open"
      : /close|sell|賣/i.test(e.action)
        ? "close"
        : "info";
    return {
      kind,
      title: `${e.action} · ${e.coin}`,
      body: (
        <>
          @{e.px.toLocaleString("en-US")} · {t("inboxSize")} {e.sz}
          {e.pnl != null && (
            <span
              className={`font-bold ${e.pnl >= 0 ? "text-lime-400" : "text-red-400"}`}
            >
              {" "}
              · PnL {e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(2)}
            </span>
          )}
        </>
      ),
      time: e.t,
    };
  };

  const openInbox = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      track("inbox_opened");
      // First open doubles as the notification-permission ask — unless the
      // user has switched notifications off.
      if (
        notifyPref &&
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
      ) {
        void Notification.requestPermission().then(setPerm);
      }
      // Opening marks everything read.
      setEvents((prev) => {
        const all = prev.map((e) => ({ ...e, read: true }));
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(all));
        } catch {
          /* quota */
        }
        return all;
      });
    }
  };

  return (
    <div className="relative">
      <button
        onClick={openInbox}
        aria-label={t("inboxTitle")}
        className={`liquid-glass relative grid h-[31px] w-[31px] place-items-center rounded-full transition-colors ${
          open ? "text-white" : "text-white/60 hover:text-white"
        }`}
        style={{ background: "var(--pill-fill)" }}
      >
        <BellIcon className="h-3.5 w-3.5" />
      </button>
      {/* Red dot lives on the UNCLIPPED wrapper: inside the round
          liquid-glass button the border-radius clipping cut it in half. */}
      {unread > 0 && (
        <span className="pointer-events-none absolute -bottom-px -right-px z-10 h-2 w-2 rounded-full bg-red-500 ring-2 ring-black/80" />
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Positioning wrapper separate from the glass (liquid-glass forces
              position:relative); surface matches the account dropdown. */}
          <div className="absolute right-0 top-full z-50 mt-2 w-[400px] max-w-[calc(100vw-1.5rem)]">
          <div
            className="liquid-glass rounded-xl p-1.5 shadow-2xl"
            style={{
              background: "var(--menu-fill)",
              backdropFilter: "blur(28px)",
              WebkitBackdropFilter: "blur(28px)",
            }}
          >
            <div className="flex items-center justify-between px-2.5 py-1.5">
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-white/50">
                {t("inboxTitle")}
              </span>
              {/* Browser-notification switch — flipping it on is also the
                  permission prompt trigger. */}
              <button
                onClick={() => void toggleNotify()}
                disabled={perm === "unsupported"}
                title={
                  perm === "denied"
                    ? t("notifyBlocked")
                    : t(notifyOn ? "notifyOffTip" : "notifyOnTip")
                }
                className={`flex items-center gap-1.5 ${perm === "denied" ? "cursor-not-allowed opacity-50" : ""}`}
              >
                <span className="font-mono text-[9px] uppercase tracking-widest text-white/40">
                  {t("notifyLabel")}
                </span>
                {/* Flex track (knob can't escape the bounds, unlike an
                    absolute+translate knob whose static offset drifts). */}
                <span
                  className={`flex h-4 w-7 items-center rounded-full px-0.5 transition-colors ${
                    notifyOn ? "justify-end bg-lime-400/80" : "justify-start bg-white/15"
                  }`}
                >
                  <span className="h-3 w-3 rounded-full bg-white shadow" />
                </span>
              </button>
            </div>
            {events.length === 0 ? (
              <p className="px-2.5 pb-2 pt-1 text-[12px] text-white/40">{t("inboxEmpty")}</p>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                {events.map((e) => (
                  <InboxItem key={e.id} item={toItem(e)} />
                ))}
              </div>
            )}
          </div>
          </div>
        </>
      )}
    </div>
  );
}
