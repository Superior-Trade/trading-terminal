"use client";

/* API Keys — list, create (reveal-once), rename, delete. Thin client over
 * /api/keys (which proxies apps/api's better-auth key endpoints). The full
 * secret is shown ONCE on creation; existing keys expose only a masked prefix.
 * Styling mirrors the account dialogs (mono, rounded-lg, lime primary). */

import { useEffect, useState } from "react";
import { Dialog } from "../ui/dialog";
import { authFetch } from "../../lib/client-auth";
import { useLang } from "../../lib/i18n";

interface KeyRow {
  id: string;
  name?: string | null;
  prefix?: string | null;
  createdAt?: string | number | null;
}

const fmtDate = (v: string | number | null | undefined): string => {
  if (v == null) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-[2px] border-lime-400/30 border-t-lime-400"
      aria-hidden
    />
  );
}

export function ApiKeysDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLang();
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null); // full secret, once
  const [copied, setCopied] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const notify = (m: string) => {
    setToast(m);
    setTimeout(() => setToast((c) => (c === m ? null : c)), 2800);
  };

  const load = async () => {
    try {
      const r = await authFetch("/api/keys");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setLoadErr(j.error ?? t("apiKeyLoadFailed"));
        return;
      }
      // Hide the terminal's own auto-minted key — it's infra, not user-managed.
      const items = ((j.items ?? []) as KeyRow[]).filter((k) => k.name !== "trading-terminal");
      setKeys(items);
    } catch {
      setLoadErr(t("apiKeyLoadFailed"));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const r = await authFetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.key) {
        notify(j.error ?? t("apiKeyCreateFailed"));
        return;
      }
      setRevealed(j.key as string);
      setNewName("");
      // Re-fetch rather than trust the create response's metadata: the new row
      // then shows its real name / prefix / created date from the list source.
      await load();
    } catch {
      notify(t("apiKeyCreateFailed"));
    } finally {
      setCreating(false);
    }
  };

  const copyRevealed = () => {
    if (!revealed) return;
    void navigator.clipboard?.writeText(revealed);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const rename = async (id: string) => {
    const name = editName.trim();
    if (!name) return;
    setBusyId(id);
    try {
      const r = await authFetch(`/api/keys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        notify(j.error ?? t("apiKeyRenameFailed"));
        return;
      }
      setKeys((prev) => (prev ?? []).map((k) => (k.id === id ? { ...k, name } : k)));
      setEditingId(null);
    } catch {
      notify(t("apiKeyRenameFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const del = async (id: string) => {
    setBusyId(id);
    try {
      const r = await authFetch(`/api/keys/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        notify(j.error ?? t("apiKeyDeleteFailed"));
        return;
      }
      setKeys((prev) => (prev ?? []).filter((k) => k.id !== id));
      setConfirmDelete(null);
    } catch {
      notify(t("apiKeyDeleteFailed"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog title={t("apiKeysTitle")} size="md" onClose={onClose}>
      {toast && (
        <div className="mb-2.5 rounded-lg bg-amber-400/10 px-3 py-2 font-mono text-[11px] text-amber-300">
          {toast}
        </div>
      )}

      {/* Full secret — shown exactly once. */}
      {revealed && (
        <div className="mb-3 rounded-xl border border-lime-400/30 bg-lime-400/[0.06] p-3">
          <div className="font-mono text-[10.5px] font-bold uppercase tracking-wider text-lime-300">
            {t("apiKeyRevealTitle")}
          </div>
          <p className="mt-1 font-mono text-[10.5px] leading-relaxed text-white/55">
            {t("apiKeyRevealWarn")}
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-white">{revealed}</code>
            <button
              onClick={copyRevealed}
              className="shrink-0 cursor-pointer rounded-md bg-white/[0.08] px-2 py-1 font-mono text-[10px] font-bold uppercase text-white/70 transition-colors hover:bg-lime-400/15 hover:text-lime-300"
            >
              {copied ? t("copied") : t("apiKeyCopy")}
            </button>
          </div>
          <button
            onClick={() => setRevealed(null)}
            className="mt-2 cursor-pointer font-mono text-[10.5px] text-white/45 transition-colors hover:text-white"
          >
            {t("apiKeyDismiss")}
          </button>
        </div>
      )}

      {/* Create */}
      <div className="mb-3 flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder={t("apiKeyNamePlaceholder")}
          maxLength={60}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2.5 font-mono text-[13px] text-white outline-none placeholder-white/30"
        />
        <button
          onClick={() => void create()}
          disabled={!newName.trim() || creating}
          className="flex shrink-0 cursor-pointer items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 font-mono text-[11.5px] font-bold uppercase tracking-wider text-black transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-40"
        >
          {creating ? <Spinner /> : t("apiKeyCreate")}
        </button>
      </div>

      {/* List */}
      {loadErr ? (
        <p className="py-6 text-center font-mono text-[11px] text-amber-300">{loadErr}</p>
      ) : keys === null ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-white/[0.05]" />
          ))}
        </div>
      ) : keys.length === 0 ? (
        <p className="py-6 text-center font-mono text-[11px] text-white/40">{t("apiKeyEmpty")}</p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div
              key={k.id}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                {editingId === k.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={editName}
                      maxLength={60}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename(k.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="min-w-0 flex-1 rounded-md border border-white/15 bg-black/40 px-2 py-1 font-mono text-[12px] text-white outline-none"
                    />
                    <button
                      onClick={() => void rename(k.id)}
                      disabled={busyId === k.id || !editName.trim()}
                      className="cursor-pointer rounded-md bg-lime-400 px-2 py-1 font-mono text-[10px] font-bold text-black transition hover:bg-lime-300 disabled:opacity-50"
                    >
                      {busyId === k.id ? t("fmBusy") : t("fmSave")}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="cursor-pointer rounded-md bg-white/10 px-2 py-1 font-mono text-[10px] font-semibold text-white/70 transition hover:bg-white/15"
                    >
                      {t("fmCancel")}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="truncate font-mono text-[12.5px] font-semibold text-white">
                      {k.name || t("apiKeyUnnamed")}
                    </div>
                    <div className="mt-0.5 font-mono text-[10.5px] text-white/40">
                      {k.prefix ? `${k.prefix}…` : ""}
                      {k.prefix && fmtDate(k.createdAt) ? " · " : ""}
                      {fmtDate(k.createdAt)}
                    </div>
                  </>
                )}
              </div>
              {editingId !== k.id &&
                (confirmDelete === k.id ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="font-mono text-[10px] text-white/55">{t("apiKeyDeleteConfirm")}</span>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="cursor-pointer rounded-md bg-white/10 px-2 py-1 font-mono text-[10px] font-semibold text-white/70 transition hover:bg-white/15"
                    >
                      {t("fmCancel")}
                    </button>
                    <button
                      onClick={() => void del(k.id)}
                      disabled={busyId === k.id}
                      className="cursor-pointer rounded-md bg-red-500/80 px-2 py-1 font-mono text-[10px] font-bold text-white transition hover:bg-red-500 disabled:opacity-50"
                    >
                      {busyId === k.id ? t("fmBusy") : t("apiKeyDelete")}
                    </button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-3 font-mono text-[10px] uppercase tracking-wider">
                    <button
                      onClick={() => {
                        setEditingId(k.id);
                        setEditName(k.name ?? "");
                      }}
                      className="cursor-pointer text-white/40 transition hover:text-white"
                    >
                      {t("apiKeyRename")}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(k.id)}
                      className="cursor-pointer text-white/40 transition hover:text-red-300"
                    >
                      {t("apiKeyDelete")}
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
