"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../ui/dialog";
import { useLang } from "../../lib/i18n";
import { authFetch } from "../../lib/client-auth";
import { fallbackConversationTitle } from "../../lib/conversation-title";

export interface ConversationRow {
  id: string;
  title?: string | null;
  updatedAt?: number | string | null;
  createdAt?: number | string | null;
}

const PAGE = 6;

/**
 * Recent conversations, numbered from 0 so they can be switched to by number.
 *
 * The numbering is the reason this list is worth caching rather than deriving
 * on the fly: /switch 3 has to mean the row the user is looking at. Ordering
 * is newest-first and a conversation moves the moment a message lands in it,
 * so the caller keeps the exact array this rendered and resolves /switch
 * against that — not against a fresh fetch that may have reordered.
 */
export function ConversationList({
  rows,
  currentId,
  onPick,
  onClose,
}: {
  rows: ConversationRow[];
  currentId: string;
  onPick: (row: ConversationRow, index: number) => void;
  onClose: () => void;
}) {
  const { t } = useLang();
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));

  // Open on the page holding the current conversation, so the list starts
  // where the user already is rather than at an arbitrary top.
  useEffect(() => {
    const i = rows.findIndex((r) => r.id === currentId);
    if (i >= 0) setPage(Math.floor(i / PAGE));
  }, [rows, currentId]);

  const slice = useMemo(
    () => rows.slice(page * PAGE, page * PAGE + PAGE),
    [rows, page],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setPage((p) => Math.max(0, p - 1));
      if (e.key === "ArrowRight") setPage((p) => Math.min(pages - 1, p + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pages]);

  return (
    <Dialog title={t("convListTitle")} size="md" onClose={onClose}>
      {rows.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-white/60">
          {t("convListEmpty")}
        </p>
      ) : (
        <>
          <p className="mb-3 font-mono text-[10.5px] text-white/40">
            {t("convListHint")}
          </p>
          <div className="space-y-1">
            {slice.map((r, i) => {
              const n = page * PAGE + i;
              const isCurrent = r.id === currentId;
              return (
                <button
                  key={r.id}
                  onClick={() => onPick(r, n)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    isCurrent ? "bg-[rgba(163,230,53,0.10)]" : "hover:bg-white/[0.07]"
                  }`}
                >
                  <span
                    className={`w-5 shrink-0 text-right font-mono text-[12px] tabular-nums ${
                      isCurrent ? "text-lime-300" : "text-white/35"
                    }`}
                  >
                    {n}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-white/85">
                      {r.title?.trim() ||
                        fallbackConversationTitle(r.createdAt ?? r.updatedAt ?? Date.now())}
                    </span>
                    <span className="mt-0.5 block font-mono text-[10px] text-white/35">
                      {relative(r.updatedAt ?? r.createdAt)}
                    </span>
                  </span>
                  {isCurrent && (
                    <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-wider text-lime-300">
                      {t("convListCurrent")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {pages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                aria-label={t("convListPrev")}
                className="grid h-8 w-8 place-items-center rounded-full border border-white/12 text-white/70 transition-colors hover:text-white disabled:opacity-30 disabled:hover:text-white/70"
              >
                ‹
              </button>
              <span className="font-mono text-[10.5px] text-white/40">
                {page + 1} / {pages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                disabled={page >= pages - 1}
                aria-label={t("convListNext")}
                className="grid h-8 w-8 place-items-center rounded-full border border-white/12 text-white/70 transition-colors hover:text-white disabled:opacity-30 disabled:hover:text-white/70"
              >
                ›
              </button>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

function relative(at: number | string | null | undefined): string {
  if (at == null) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Newest-first conversations for the signed-in user. */
export async function fetchConversations(): Promise<ConversationRow[]> {
  const j = await authFetch("/api/chat-store")
    .then((r) => r.json())
    .catch(() => ({ items: [] }));
  return (j.items ?? j.conversations ?? []) as ConversationRow[];
}
