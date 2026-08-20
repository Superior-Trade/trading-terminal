"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChartBridge } from "../../lib/chart-bridge";
import { useSetups, type DetectedPlan } from "../../lib/setups-context";
import { useLang } from "../../lib/i18n";
import { pushInboxNotice } from "./inbox";
import { usePrivacy, Masked } from "../../lib/privacy";
import { track } from "../../lib/track";
import { useAuthGate } from "../providers";
import { authFetch } from "../../lib/client-auth";
import { usePair } from "./terminal-shell";
import { useHyperliquid, pairToCoin, coinToPair, resolveAsset } from "../../lib/hyperliquid-provider";
import { useHlBalance } from "../../lib/use-hl-balance";
import { useAccountValue, type WalletValue } from "../../lib/use-account-value";
import { useHeldUsdc } from "../../lib/use-held-usdc";
import { parseLevelSource, trendlineValueAt } from "../../lib/indicators";
import { orderSetupsNewestFirst } from "../../lib/setup-order";
import { maxStakeFor } from "../../lib/sizing-ceiling";
import { useLiveLevels, type LiveLevels } from "../../lib/use-live-levels";
import { fixedSizing } from "../../lib/plan-sizing";
import { PnlShareCard } from "./pnl-share-card";
import { Dialog } from "../ui/dialog";
import {
  VENUES,
  venueOfSymbol,
  lighterUiEnabled,
  type Venue,
} from "../../lib/venues";

/** Minimal 16px venue monogram (circled H / circled L) for the Confirm Deploy
 *  button — inline SVG in currentColor, element-level width/height. Not a
 *  brand logo: a neutral letter mark so the venue is unambiguous at a glance. */
function VenueMark({ venue }: { venue: Venue }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="mr-1.5 inline-block align-[-3px]"
    >
      <circle cx="8" cy="8" r="6.9" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <text
        x="8"
        y="11.1"
        textAnchor="middle"
        fontSize="8.5"
        fontWeight="700"
        fill="currentColor"
        fontFamily="inherit"
      >
        {venue === "lighter" ? "L" : "H"}
      </text>
    </svg>
  );
}

/* ── Running setups: live deployments + running backtests ─────────── */

interface ApiItem {
  id: string;
  name?: string;
  status?: string;
  walletAddress?: string | null;
  // Soft-deleted rows carry deletedAt (the API maps is_deleted → deletedAt);
  // a deleted deployment no longer holds its wallet.
  deletedAt?: string;
  // Set by the API when the deployment-alive-until watcher auto-stopped this
  // deployment (its time limit / "stop 2" hit) — the terminal raises a notice.
  stoppedReason?: string;
  createdAt?: string;
  created_at?: string;
  config?: {
    timeframe?: string;
    stake_amount?: number | string;
    exchange?: { pair_whitelist?: string[] };
  };
  results?: { profit_total_pct?: number } | null;
}

interface StoredRecord {
  deploymentId: string;
  plan: {
    title: string;
    direction: "long" | "short" | "neutral";
    mode?: "one_shot" | "recurring" | null;
    thesis: string;
    entry: number;
    stop: number;
    target: number;
    entryCondition?: string | null;
    stopCondition?: string | null;
    targetCondition?: string | null;
    // Indicator basis per level — persisted at deploy so a running
    // deployment's intended entry/stop/target can be live-tracked
    // (computeLevel) exactly like a selected setup. Absent/"fixed" → static.
    entrySource?: string | null;
    stopSource?: string | null;
    targetSource?: string | null;
    symbol?: string | null;
    invalidation: string;
    aliveUntil?: string | null;
    aliveUntilReason?: string | null;
    sizing?: DetectedPlan["sizing"];
    zh?: DetectedPlan["zh"];
  };
  mode?: "one_shot" | "recurring" | null;
  symbol?: string;
  timeframe?: string;
  createdAt: number;
}

const ACTIVE_STATES = ["running", "deployed", "pending"];

/** Capital already committed to live strategies, keyed by lowercased wallet.
 *  A wallet maps to `null` when a live strategy on it has no readable stake —
 *  the whole wallet is then treated as spoken for rather than guessed at. */
export type CommittedByWallet = Map<string, number | null>;

/** Deployable funds = Σ over trading wallets of (withdrawable − committed).
 *
 *  Committed, NOT occupied. Both earlier versions were wrong in opposite
 *  directions: counting a wallet's full balance regardless of live strategies
 *  offered the same money twice, and zeroing any wallet holding a live strategy
 *  collapsed a $200 account running a $12 strategy to the $10 floor. The main
 *  account hosts several strategies against one balance, so for FUNDS the
 *  question is how much is spoken for — occupancy stays a yes/no only for
 *  placement.
 *
 *  Shared by the sizing slider ceiling and the restart-affordability guard.
 *  null while balances are still loading. */
function computeDeployable(
  perWallet: WalletValue[],
  fallbackWithdrawable: number | null,
  committed: CommittedByWallet | null,
): number | null {
  const main = perWallet.find((w) => w.accountIndex === 1);
  const mainW = main?.withdrawable ?? fallbackWithdrawable;
  if (mainW === null) return null;
  // Commitments still loading: publish the main balance alone rather than an
  // idle pool we cannot yet net down.
  if (committed === null) return mainW;

  const free = (wallet: string | undefined, withdrawable: number) => {
    if (!wallet) return withdrawable; // fallback balance, no address to key on
    const used = committed.get(wallet.toLowerCase());
    if (used === undefined) return withdrawable; // nothing live on this wallet
    if (used === null) return 0; // live strategy with an unreadable stake
    return Math.max(0, withdrawable - used);
  };

  const idle = perWallet
    .filter((w) => w.accountIndex !== 1 && w.withdrawable !== null)
    .reduce((s, w) => s + free(w.wallet, w.withdrawable as number), 0);
  return free(main?.wallet, mainW) + idle;
}

/** Deployable funds for the sizing slider + restart guard: venue deployable
 *  (computeDeployable) PLUS the un-deployed USDC held on-chain in TA1 (the
 *  Superior wallet). Allocate-on-deploy (#903) bridges TA1's held USDC into
 *  the venue as part of deploy/restart, and an empty TA1 skips allocation so
 *  the deploy proceeds on the venue balance (#918) — both pots are genuinely
 *  deployable. Held USDC on OTHER trading accounts is NOT counted: the
 *  allocation only ever reads TA1. Mirrors the header's settle rule (#912):
 *  publish nothing until BOTH the venue figure and the held read settle, so a
 *  hold-model account (venue $0, deposits parked in TA1) never reads as a $10
 *  ceiling; an errored held read contributes 0 rather than blocking.
 *  null while balances are still loading. */
function useDeployableUsd(
  authed: boolean,
  committed: CommittedByWallet | null,
): number | null {
  const { withdrawable } = useHlBalance(authed);
  const { perWallet } = useAccountValue(authed);
  const mainWallet = perWallet.find((w) => w.accountIndex === 1)?.wallet;
  const { held, status: heldStatus } = useHeldUsdc(
    mainWallet ? [mainWallet] : [],
    authed,
  );
  const venue = computeDeployable(perWallet, withdrawable, committed);
  if (venue === null) return null;
  if (mainWallet && heldStatus === "loading") return null;
  return venue + (held ?? 0);
}

/* ── Native bracket orders (Superior /v2/bracket) ─────────────────────── */

interface BracketItem {
  id: string;
  wallet_address: string;
  pair: string;
  /** The setup's name, when the order was placed from one. */
  name?: string | null;
  side: "long" | "short";
  entry: number;
  take_profit: number;
  stop_loss: number;
  size_usd: number;
  leverage: number;
  status: string; // resting | filled | closed | cancelled | expired
  alive_until: string | null;
  created_at?: string;
  /** Entry, take-profit and stop-loss order ids, so fills can be attributed to
   *  this order rather than to whatever else traded on the wallet. */
  oids?: number[];
}

const BRACKET_ACTIVE = ["resting", "filled"];

/** Confirmation copy per destructive control. Stop belongs here for the same
 *  reason Exit does: it closes open positions and realizes the PnL. */
const CONFIRM_COPY = {
  stop: { title: "confirmStopTitle", body: "confirmStopBody", cta: "stopBtn" },
  exit: { title: "confirmExitTitle", body: "confirmExitBody", cta: "exitBtn" },
  delete: { title: "confirmDeleteTitle", body: "confirmDeleteBody", cta: "deleteBtn" },
} as const;

/* ── PnL equity curve (realized: cumulative closedPnl − fees) ────────── */

interface DepPnl {
  points: Array<{ t: number; v: number }>;
  totalPnl: number;
  tradeCount: number;
  running: boolean;
  coins?: string[];
  walletAddress?: string | null;
  recentTrades?: Array<{
    t: number;
    coin: string;
    dir: "long" | "short";
    pnl: number;
    realized: boolean;
  }>;
}

/* ── Live positions / open orders per deployment wallet ──────────────── */

interface LivePosition {
  coin: string;
  szi: number; // signed size (+long / -short)
  entryPx: number;
  unrealizedPnl: number;
  liquidationPx: number | null;
  leverage: number | null;
}

interface LiveOrder {
  coin: string;
  side: string; // "B" | "A"
  limitPx: number | null;
  triggerPx: number | null;
  sz: number;
  isTrigger: boolean;
  reduceOnly: boolean;
}

interface WalletLive {
  positions: LivePosition[];
  orders: LiveOrder[];
}

type PosMark = {
  price: number;
  label: string;
  kind: "entry" | "tp" | "sl" | "liq" | "order";
};

/** Exchange-truth chart marks for one coin from a wallet's live HL state:
 *  position entry (+dir/size/uPnL), liquidation, and resting orders — trigger
 *  orders classified TP/SL by side vs entry, plain limits as working orders.
 *  Shared by the per-card "show on chart" row and the top-bar strategy-overlay
 *  dropdown so both paint identical marks. Privacy mode drops the size/PnL
 *  figures but keeps every price level (marks render on the shared screen). */
function buildStrategyMarks(
  pos: LivePosition | null,
  orders: LiveOrder[],
  coin: string,
  hidden: boolean,
): PosMark[] {
  const marks: PosMark[] = [];
  if (pos) {
    const dir = pos.szi > 0 ? "LONG" : "SHORT";
    marks.push({
      price: pos.entryPx,
      label: hidden
        ? `Entry ${dir}`
        : `Entry ${dir} ${Math.abs(pos.szi)} · uPnL ${pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(2)}`,
      kind: "entry",
    });
    if (pos.liquidationPx) {
      marks.push({ price: pos.liquidationPx, label: "Liquidation", kind: "liq" });
    }
  }
  for (const o of orders.filter((o) => o.coin === coin)) {
    const px = o.triggerPx ?? o.limitPx;
    if (!px) continue;
    if (o.isTrigger && pos) {
      const profitable = pos.szi > 0 ? px > pos.entryPx : px < pos.entryPx;
      marks.push({
        price: px,
        label: `${profitable ? "TP" : "SL"} ${hidden ? "" : o.sz || ""}`.trim(),
        kind: profitable ? "tp" : "sl",
      });
    } else {
      marks.push({
        price: px,
        label: `${o.side === "B" ? "BUY" : "SELL"}${hidden ? "" : ` ${o.sz}`}`,
        kind: "order",
      });
    }
  }
  return marks;
}

function PnlSparkline({ pnl, noFillsLabel }: { pnl: DepPnl; noFillsLabel: string }) {
  if (!pnl.tradeCount) {
    return (
      <div className="mt-2 font-mono text-[9.5px] uppercase tracking-wider text-white/25">
        {noFillsLabel}
      </div>
    );
  }
  const w = 132;
  const h = 34;
  const pts = pnl.points;
  const tMin = pts[0].t;
  const tMax = pts[pts.length - 1].t;
  const vMin = Math.min(0, ...pts.map((p) => p.v));
  const vMax = Math.max(0, ...pts.map((p) => p.v));
  const x = (t: number) => (tMax === tMin ? w : ((t - tMin) / (tMax - tMin)) * w);
  const y = (v: number) =>
    vMax === vMin ? h / 2 : h - 2 - ((v - vMin) / (vMax - vMin)) * (h - 4);
  const line = pts
    .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const up = pnl.totalPnl >= 0;
  const color = up ? "#a3e635" : "#f87171";
  return (
    <div className="mt-2 flex items-center gap-3">
      <svg width={w} height={h} className="shrink-0 overflow-visible">
        {/* zero line */}
        <line
          x1="0"
          y1={y(0)}
          x2={w}
          y2={y(0)}
          stroke="rgba(255,255,255,0.15)"
          strokeDasharray="3 3"
          strokeWidth="1"
        />
        <path
          d={`${line} L${w},${y(Math.min(0, vMin) === vMin && vMin < 0 ? vMin : 0)} L0,${y(
            Math.min(0, vMin) === vMin && vMin < 0 ? vMin : 0,
          )} Z`}
          fill={color}
          opacity="0.12"
          stroke="none"
        />
        <path d={line} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      <div className="font-mono">
        <div
          className={`text-[13px] font-bold tabular-nums ${up ? "text-lime-400" : "text-red-400"}`}
        >
          <Masked value={`${up ? "+" : ""}${pnl.totalPnl.toFixed(3)}`} />
        </div>
        <div className="text-[9.5px] uppercase tracking-wider text-white/35">
          {pnl.tradeCount} fills · realized
        </div>
      </div>
    </div>
  );
}

/** One row per live position / open order. Click switches the chart to
 *  that coin and overlays exchange-style marks (entry+PnL, TP/SL, liq,
 *  resting orders). */
/** Glass warning icon for the left column of soft-warning dialogs. Assets are
 *  produced with the Higgsfield icon pipeline (see docs/icon-pipeline.md).
 *  Hides itself if the asset is missing so the dialog still renders cleanly. */
function WarnGlassIcon({ src }: { src: string }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      className="h-12 w-12 shrink-0 select-none object-contain"
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

function LiveRows({ live }: { live: WalletLive }) {
  const { dispatchChartAction } = useChartBridge();
  const { setPair } = usePair();
  const { hidden } = usePrivacy();

  const showOnChart = async (pos: LivePosition | null, coin: string) => {
    setPair(coinToPair(coin));
    const marks = buildStrategyMarks(pos, live.orders, coin, hidden);
    // Let the symbol swap settle before drawing — TV attaches shapes to the
    // active symbol.
    setTimeout(() => void dispatchChartAction({ action: "draw_position_marks", marks }), 1200);
  };

  if (!live.positions.length && !live.orders.length) return null;
  const orderOnlyCoins = [
    ...new Set(
      live.orders
        .map((o) => o.coin)
        .filter((c) => !live.positions.some((p) => p.coin === c)),
    ),
  ];
  return (
    <div className="mt-2 space-y-1">
      {live.positions.map((p) => (
        <button
          key={`pos-${p.coin}`}
          onClick={(e) => {
            e.stopPropagation();
            void showOnChart(p, p.coin);
          }}
          title="Show on chart with entry/TP/SL marks"
          className="flex w-full items-center gap-2 rounded-lg bg-white/[0.05] px-2 py-1.5 text-left font-mono text-[10.5px] transition-colors hover:bg-white/[0.1]"
        >
          <span className={p.szi > 0 ? "text-lime-400" : "text-red-400"}>
            {p.szi > 0 ? "▲" : "▼"}
          </span>
          <span className="font-bold text-white">{p.coin}</span>
          <span className="text-white/50">
            <Masked value={String(Math.abs(p.szi))} /> @ {fmt(p.entryPx)}
            {p.leverage ? ` · ${p.leverage}×` : ""}
          </span>
          <span
            className={`ml-auto tabular-nums ${p.unrealizedPnl >= 0 ? "text-lime-400" : "text-red-400"}`}
          >
            <Masked
              value={`${p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toFixed(2)}`}
            />
          </span>
        </button>
      ))}
      {orderOnlyCoins.map((coin) => {
        const os = live.orders.filter((o) => o.coin === coin);
        return (
          <button
            key={`ord-${coin}`}
            onClick={(e) => {
              e.stopPropagation();
              void showOnChart(null, coin);
            }}
            title="Show resting orders on chart"
            className="flex w-full items-center gap-2 rounded-lg bg-white/[0.04] px-2 py-1.5 text-left font-mono text-[10.5px] text-white/60 transition-colors hover:bg-white/[0.09]"
          >
            <span className="text-sky-400">◆</span>
            <span className="font-bold text-white/85">{coin}</span>
            <span>
              {os.length} open order{os.length > 1 ? "s" : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DeploymentCard({
  item,
  record,
  pnl,
  live,
  liveLevels,
  deployableUsd,
  onReload,
}: {
  item: ApiItem;
  record: StoredRecord | undefined;
  pnl: DepPnl | undefined;
  live: WalletLive | undefined;
  /** Live-recomputed indicator level values (entry/stop/target) for this
   *  deployment's plan, refreshed every few seconds. Undefined → static. */
  liveLevels?: LiveLevels;
  /** Funds available to re-fund a restart (main + idle); null while loading. */
  deployableUsd: number | null;
  onReload: () => void;
}) {
  const { t, lang } = useLang();
  const { markedKey, toggleMarkLevels } = useSetups();
  const [busy, setBusy] = useState<string | null>(null);
  const [showShareCard, setShowShareCard] = useState(false);
  // Irreversible actions (exit closes real positions, delete removes the
  // deployment) go through a confirm dialog; stop is reversible and doesn't.
  const [confirmAction, setConfirmAction] = useState<
    "stop" | "exit" | "delete" | null
  >(null);
  const [ctrlError, setCtrlError] = useState<string | null>(null);
  const isActive = ACTIVE_STATES.includes(item.status ?? "");
  // Stop/exit only make sense for a deployment whose bot is actually up.
  // "pending" is active for grouping purposes but has nothing to stop — its
  // lifecycle actions are start (via deploy flow) or delete.
  const isRunning = item.status === "running" || item.status === "deployed";
  const key = `dep-${item.id}`;
  const marked = markedKey === key;
  const plan = record?.plan;
  const rr = plan
    ? Math.abs(plan.target - plan.entry) / Math.max(Math.abs(plan.entry - plan.stop), 1e-9)
    : null;

  // Restart re-funds the wallet to its stake from main + idle. If that stake
  // exceeds deployable funds the restart would start underfunded (or fail),
  // so we disable the button. Unknown stake (foreign deployment) or still-
  // loading balances → don't block. NOTE: this is a FRONTEND-ONLY guard; the
  // control/deploy API still accepts an underfunded restart (see the dev
  // heads-up in app/api/deployments/control/route.ts).
  const restartStake = Number(item.config?.stake_amount ?? 0) || 0;
  const restartAffordable =
    deployableUsd == null || restartStake <= 0 || restartStake <= deployableUsd;

  // Pairs this deployment trades: config whitelist first (intent), actual
  // traded coins from fills as fallback (foreign deployments lack config).
  const tradedPairs = (() => {
    const fromConfig = (item.config?.exchange?.pair_whitelist ?? []).map(
      (p) => p.split("/")[0],
    );
    const list = fromConfig.length ? fromConfig : pnl?.coins ?? [];
    return [...new Set(list)];
  })();

  const control = async (action: "stop" | "start" | "exit" | "delete") => {
    setBusy(action);
    setCtrlError(null);
    try {
      const res = await authFetch("/api/deployments/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, action }),
      });
      if (!res.ok) {
        // Surface the API's reason (e.g. "Can only stop a running deployment")
        // instead of silently reloading — the card looked broken otherwise.
        const j = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        setCtrlError(j.message ?? j.error ?? `${action} failed (${res.status})`);
      } else {
        // Money/occupancy changed (exit closes positions, delete frees the
        // wallet) — refresh balances + the sizing ceiling immediately.
        window.dispatchEvent(new Event("cg:refresh-balances"));
      }
      onReload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role={plan ? "button" : undefined}
      onClick={plan ? () => void toggleMarkLevels(key, plan) : undefined}
      className={`liquid-glass rounded-[1rem] p-3.5 transition-all ${
        plan ? "cursor-pointer" : ""
      } ${
        marked
          ? "outline outline-2 outline-lime-400/70"
          : plan
            ? "hover:outline hover:outline-1 hover:outline-white/20"
            : ""
      }`}
      style={{ background: marked ? "rgba(163,230,53,0.10)" : "var(--glass-fill)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Status leads the name — a live dot when the pod is actually up. */}
          <span
            className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-[9px] font-bold uppercase leading-none tracking-wide ${
              isActive
                ? "bg-[rgba(163,230,53,0.14)] text-lime-300"
                : "bg-white/[0.08] text-white/50"
            }`}
          >
            {isActive && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lime-400" />
            )}
            {item.status}
          </span>
          <span className="truncate text-[13px] font-semibold text-white">
            {(plan && planField(plan, "title", lang)) ?? item.name ?? `#${item.id.slice(-6)}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {plan ? (
            <>
              <span
                title={t(plan.mode === "one_shot" ? "oneShotTip" : "recurringTip")}
                className={`inline-flex h-5 cursor-help items-center gap-0.5 rounded-md px-1.5 font-mono text-[10px] font-bold uppercase leading-none ${
                  plan.mode === "one_shot"
                    ? "bg-amber-400/15 text-amber-300"
                    : "bg-white/10 text-white/70"
                }`}
              >
                {plan.mode === "one_shot" ? "⧗" : "↻"} {t(plan.mode === "one_shot" ? "oneShot" : "recurring")}
              </span>
              <DirectionBadge direction={plan.direction} />
              {rr !== null && (
                <span
                  title={t("rrTip").replace("{rr}", rr.toFixed(1))}
                  className="inline-flex h-5 cursor-help items-center rounded-md bg-white/10 px-1.5 font-mono text-[10px] font-bold leading-none text-white/80"
                >
                  {t("rrBadge").replace("{rr}", rr.toFixed(1))}
                </span>
              )}
            </>
          ) : (
            <span
              className="inline-flex h-5 shrink-0 items-center rounded-md bg-amber-400/15 px-1.5 font-mono text-[10px] font-bold uppercase leading-none text-amber-300"
              title={t("foreignHint")}
            >
              {t("foreign")}
            </span>
          )}
        </div>
      </div>

      <PlanDetail plan={plan} liveLevels={liveLevels} />

      {tradedPairs.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {tradedPairs.slice(0, 4).map((p) => (
            <span
              key={p}
              className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-white/70"
            >
              {p}
            </span>
          ))}
          {tradedPairs.length > 4 && (
            <span className="font-mono text-[9.5px] text-white/40">
              +{tradedPairs.length - 4}
            </span>
          )}
        </div>
      )}

      {isActive && live && <LiveRows live={live} />}

      {pnl && <PnlSparkline pnl={pnl} noFillsLabel={t("noFills")} />}

      <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-white/40">
        <span>
          {(record?.symbol ?? item.config?.exchange?.pair_whitelist?.[0])?.split("/")[0] ?? ""}
          {(record?.timeframe ?? item.config?.timeframe) ? ` · ${record?.timeframe ?? item.config?.timeframe}` : ""}
          {item.config?.stake_amount != null && (
            <>
              {" · "}
              <Masked
                value={
                  typeof item.config.stake_amount === "number"
                    ? `$${item.config.stake_amount}`
                    : String(item.config.stake_amount)
                }
              />
              {" stake"}
            </>
          )}
        </span>
        <span>
          {record?.createdAt
            ? new Date(record.createdAt).toLocaleDateString()
            : (item.createdAt ?? item.created_at)
              ? new Date((item.createdAt ?? item.created_at)!).toLocaleDateString()
              : ""}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {isRunning && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                // Stopping closes this strategy's open positions and realizes
                // the PnL — as irreversible as Exit, so it asks first, the
                // same way Exit and Delete already do.
                setConfirmAction("stop");
              }}
              disabled={busy !== null}
              className="rounded-full bg-white/10 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-white/70 transition-all hover:bg-white/20 disabled:opacity-40"
            >
              {busy === "stop" ? (
                <span className="animate-pulse">{t("stopping")}</span>
              ) : (
                t("stopBtn")
              )}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setConfirmAction("exit");
              }}
              disabled={busy !== null}
              className="rounded-full bg-red-400/15 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-red-300 transition-all hover:bg-red-400/25 disabled:opacity-40"
            >
              {busy === "exit" ? (
                <span className="animate-pulse">{t("exiting")}</span>
              ) : (
                t("exitBtn")
              )}
            </button>
          </>
        )}
        {!isRunning && (
          <>
            {/* Restart resumes the pod on its linked wallet; the API re-funds
                the account to the stake first (the auto-sweep may have
                returned its funds to main while it was stopped). */}
            {item.status === "stopped" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void control("start");
                }}
                disabled={busy !== null || !restartAffordable}
                title={!restartAffordable ? t("restartInsufficient") : undefined}
                className="rounded-full bg-[rgba(163,230,53,0.14)] px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-lime-300 transition-all hover:bg-lime-400/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "start" ? (
                  <span className="animate-pulse">{t("restarting")}</span>
                ) : (
                  t("restartBtn")
                )}
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setConfirmAction("delete");
              }}
              disabled={busy !== null}
              className="rounded-full bg-white/10 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-white/50 transition-all hover:bg-red-400/20 hover:text-red-300 disabled:opacity-40"
            >
              {busy === "delete" ? (
                <span className="animate-pulse">{t("deleting")}</span>
              ) : (
                t("deleteBtn")
              )}
            </button>
          </>
        )}
        {pnl && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowShareCard(true);
              track("share_card_opened");
            }}
            className="ml-auto rounded-full border border-lime-400/25 bg-lime-400/10 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-lime-300 transition-all hover:bg-lime-400/20"
          >
            {t("pnlCardBtn")}
          </button>
        )}
      </div>
      {ctrlError && (
        <div className="mt-1.5 text-[10.5px] leading-snug text-red-300/90">
          {ctrlError}
        </div>
      )}
      {confirmAction && (
        <Dialog
          title={t(CONFIRM_COPY[confirmAction].title)}
          size="md"
          onClose={() => setConfirmAction(null)}
        >
          <p className="text-[13px] leading-relaxed text-white/80">
            {t(CONFIRM_COPY[confirmAction].body)}
          </p>
          <div className="mt-7 flex justify-end gap-2">
            <button
              onClick={() => {
                const a = confirmAction;
                setConfirmAction(null);
                void control(a);
              }}
              className="rounded-full bg-red-400 px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-black transition-opacity hover:opacity-85"
            >
              {t(CONFIRM_COPY[confirmAction].cta)}
            </button>
            <button
              onClick={() => setConfirmAction(null)}
              className="rounded-full border border-white/15 bg-white/[0.06] px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-white/80 transition-colors hover:text-white"
            >
              {t("clearNo")}
            </button>
          </div>
        </Dialog>
      )}
      {showShareCard && pnl && (
        <PnlShareCard
          data={{
            strategyName: record?.plan.title ?? item.name ?? `#${item.id.slice(-6)}`,
            pair:
              record?.symbol ??
              item.config?.exchange?.pair_whitelist?.[0]?.split("/")[0] ??
              "—",
            direction: record?.plan.direction ?? null,
            leverage: live?.positions?.[0]?.leverage ?? null,
            stake:
              typeof item.config?.stake_amount === "number"
                ? item.config.stake_amount
                : null,
            totalPnl: pnl.totalPnl,
            unrealizedPnl:
              live?.positions?.reduce((s, p) => s + (p.unrealizedPnl || 0), 0) ?? 0,
            tradeCount: pnl.tradeCount,
            startedAt:
              record?.createdAt ??
              ((item.createdAt ?? item.created_at)
                ? Date.parse((item.createdAt ?? item.created_at)!)
                : null),
            points: pnl.points,
            trades: pnl.recentTrades ?? [],
          }}
          onClose={() => setShowShareCard(false)}
        />
      )}
    </div>
  );
}

interface HlFill {
  time?: number;
  oid?: number;
  closedPnl?: string | number;
  fee?: string | number;
  coin?: string;
  dir?: string;
  side?: string;
}

/** A bracket's realized-PnL equity curve, built client-side from HL userFills
 *  (a bracket has no per-order pnl feed like deployments do). Attribution is by
 *  the order's own ids: "one active execution per wallet" was assumed here, but
 *  nothing enforced it against brackets, so a strategy deployed onto the same
 *  wallet had its fills counted into the one-shot's curve. Same cumulative
 *  closedPnl−fee shape, so the card still reuses PnlSparkline and the share
 *  card unchanged. */
function computeBracketPnl(
  fills: HlFill[],
  sinceMs: number,
  wallet: string,
  oids?: number[],
): DepPnl {
  const n = (v: string | number | undefined) => {
    const x = typeof v === "string" ? parseFloat(v) : v;
    return Number.isFinite(x) ? (x as number) : 0;
  };
  // Prefer the order's own ids. Filtering on wallet + time alone swept in every
  // fill any strategy on the same wallet produced after the order was placed,
  // so a one-shot's PnL drifted with an unrelated bot's trades. Falls back to
  // the time window for orders placed before all three ids were captured.
  const own = new Set(oids ?? []);
  const sorted = fills
    .filter((f) =>
      own.size > 0
        ? own.has(f.oid as number)
        : Number.isFinite(f.time) && (f.time as number) >= sinceMs,
    )
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  const points: Array<{ t: number; v: number }> = [];
  let cum = 0;
  const coins = new Set<string>();
  for (const f of sorted) {
    cum += n(f.closedPnl) - n(f.fee);
    points.push({ t: f.time as number, v: Number(cum.toFixed(6)) });
    if (f.coin) coins.add(f.coin);
  }
  const recentTrades: NonNullable<DepPnl["recentTrades"]> = [];
  for (let i = sorted.length - 1; i >= 0 && recentTrades.length < 8; i--) {
    const f = sorted[i];
    const d = String(f.dir ?? "");
    const long = /long/i.test(d) ? true : /short/i.test(d) ? false : f.side === "B";
    if (/close/i.test(d)) {
      recentTrades.push({
        t: f.time as number,
        coin: f.coin ?? "?",
        dir: long ? "long" : "short",
        pnl: Number((n(f.closedPnl) - n(f.fee)).toFixed(4)),
        realized: true,
      });
    } else if (/open/i.test(d) && recentTrades.length === 0) {
      recentTrades.push({
        t: f.time as number,
        coin: f.coin ?? "?",
        dir: long ? "long" : "short",
        pnl: 0,
        realized: false,
      });
    }
  }
  return {
    points,
    totalPnl: points.length ? points[points.length - 1].v : 0,
    tradeCount: sorted.length,
    running: true,
    coins: [...coins],
    walletAddress: wallet,
    recentTrades,
  };
}

/** One native bracket order: entry/TP/SL resting directly on Hyperliquid
 *  (no Freqtrade pod). Cancel cancels the orders and closes any position. */
function BracketCard({
  b,
  live,
  pnl,
  record,
  onReload,
}: {
  b: BracketItem;
  /** Live positions/open orders on the bracket's wallet, once it fills. */
  live?: WalletLive;
  /** Realized-PnL equity series for this order (client-computed). */
  pnl?: DepPnl;
  /** The setup this order was placed from, stored at deploy — carries the
   *  thesis, per-level conditions and invalidation the prices alone cannot
   *  convey. Absent for orders placed before this was persisted. */
  record?: StoredRecord;
  onReload: () => void;
}) {
  const { t } = useLang();
  const { markedKey, toggleMarkLevels } = useSetups();
  const [busy, setBusy] = useState(false);
  const [showShareCard, setShowShareCard] = useState(false);
  const active = BRACKET_ACTIVE.includes(b.status);
  // A direct order carries the same entry/stop/target as a plan, so it gets
  // the same R:R badge deployment cards show.
  const rr =
    Math.abs(b.take_profit - b.entry) /
    Math.max(Math.abs(b.entry - b.stop_loss), 1e-9);
  // Selecting the card draws its entry/stop/target on the chart (and shows the
  // "Showing … setup" banner) — the same marking a recurring deployment card
  // uses. A bracket's fixed levels map straight onto the plan-levels shape.
  const markKey = `bracket:${b.id}`;
  const marked = markedKey === markKey;
  const markLevels = {
    title: b.name ?? `${b.pair.split("/")[0]} ${t("bracketOrder")}`,
    entry: b.entry,
    stop: b.stop_loss,
    target: b.take_profit,
    symbol: b.pair,
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await authFetch(`/api/bracket?id=${encodeURIComponent(b.id)}`, {
        method: "DELETE",
      });
      window.dispatchEvent(new Event("cg:refresh-balances"));
      onReload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="button"
      onClick={() => void toggleMarkLevels(markKey, markLevels)}
      className={`liquid-glass rounded-[1rem] p-3.5 transition-all cursor-pointer ${
        marked
          ? "outline outline-2 outline-lime-400/70"
          : "hover:outline hover:outline-1 hover:outline-white/20"
      }`}
      style={{ background: marked ? "rgba(163,230,53,0.10)" : "var(--glass-fill)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Status leads the name — a live dot while orders rest / a fill runs. */}
          <span
            className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-[9px] font-bold uppercase leading-none tracking-wide ${
              active
                ? "bg-[rgba(163,230,53,0.14)] text-lime-300"
                : "bg-white/[0.08] text-white/50"
            }`}
          >
            {active && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lime-400" />
            )}
            {b.status}
          </span>
          <span className="truncate text-[13px] font-semibold text-white">
            {b.name ?? `${b.pair} ${t("bracketOrder")}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* A direct order executes once — the same ⧗ one-shot badge a
              one_shot deployment carries. */}
          <span className="inline-flex h-5 items-center gap-0.5 rounded-md bg-amber-400/15 px-1.5 font-mono text-[10px] font-bold uppercase leading-none text-amber-300">
            ⧗ {t("oneShot")}
          </span>
          <DirectionBadge direction={b.side} />
          <span
            title={t("rrTip").replace("{rr}", rr.toFixed(1))}
            className="inline-flex h-5 cursor-help items-center rounded-md bg-white/10 px-1.5 font-mono text-[10px] font-bold leading-none text-white/80"
          >
            {t("rrBadge").replace("{rr}", rr.toFixed(1))}
          </span>
        </div>
      </div>

      {/* With the originating setup stored, show it in full — thesis, per-level
          conditions, invalidation — so a live one-shot reads like the draft it
          came from. Orders placed before that was persisted fall back to the
          bare prices the order itself carries. */}
      {record?.plan ? (
        <PlanDetail plan={record.plan} />
      ) : (
        <div className="mt-2.5 space-y-1.5 font-mono text-[11px]">
          <LevelRow label={t("entry")} price={fmt(b.entry)} tone="entry" />
          <LevelRow label={aliveWindow(b.alive_until) ? `${t("stop")} 1` : t("stop")} price={fmt(b.stop_loss)} tone="stop" />
          <AutoStopRow label={`${t("stop")} 2`} aliveUntil={b.alive_until} />
          <LevelRow label={t("target")} price={fmt(b.take_profit)} tone="target" />
        </div>
      )}

      {/* Once the entry fills, show the same live position/open-order rows a
          running deployment shows. */}
      {active && live && <LiveRows live={live} />}

      {/* Realized-PnL equity curve — same sparkline the deployment cards use. */}
      {pnl && <PnlSparkline pnl={pnl} noFillsLabel={t("noFills")} />}

      <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-white/40">
        <span>
          {b.pair.split("/")[0]} · {b.leverage}× · <Masked value={`$${b.size_usd}`} />
        </span>
        <span>{b.created_at ? new Date(b.created_at).toLocaleDateString() : ""}</span>
      </div>

      {(active || pnl) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {active && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void cancel();
              }}
              disabled={busy}
              className="rounded-full bg-red-400/15 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-red-300 transition-all hover:bg-red-400/25 disabled:opacity-40"
            >
              {busy ? <span className="animate-pulse">{t("deleting")}</span> : t("bracketCancel")}
            </button>
          )}
          {pnl && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowShareCard(true);
                track("share_card_opened");
              }}
              className="ml-auto rounded-full border border-lime-400/25 bg-lime-400/10 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-lime-300 transition-all hover:bg-lime-400/20"
            >
              {t("pnlCardBtn")}
            </button>
          )}
        </div>
      )}
      {showShareCard && pnl && (
        <PnlShareCard
          data={{
            strategyName: `${b.pair.split("/")[0]} ${t("bracketOrder")}`,
            pair: b.pair.split("/")[0],
            direction: b.side,
            leverage: live?.positions?.[0]?.leverage ?? b.leverage,
            stake: b.size_usd,
            totalPnl: pnl.totalPnl,
            unrealizedPnl:
              live?.positions?.reduce((s, p) => s + (p.unrealizedPnl || 0), 0) ?? 0,
            tradeCount: pnl.tradeCount,
            startedAt: b.created_at ? Date.parse(b.created_at) : null,
            points: pnl.points,
            trades: pnl.recentTrades ?? [],
          }}
          onClose={() => setShowShareCard(false)}
        />
      )}
    </div>
  );
}

function RunningTab({
  onActiveCount,
  onOccupiedWallets,
  onCommittedByWallet,
}: {
  onActiveCount?: (n: number) => void;
  /** Lowercased wallet addresses held by any current (non-deleted)
   *  deployment — the sizing slider excludes them from deployable funds. */
  onOccupiedWallets?: (wallets: Set<string>) => void;
  onCommittedByWallet?: (committed: CommittedByWallet) => void;
}) {
  const { t } = useLang();
  const { info } = useHyperliquid();
  // The tab is mounted from page load (for the preloaded badge/data), which
  // is BEFORE Privy hydrates the token — loading is gated on `authed` so the
  // first fetch never fires an unauthorized round-trip that used to stick as
  // a permanent "sign in" error.
  const { authed } = useAuthGate();
  // Chart top-bar strategy-overlay dropdown wiring: the chart's "Strategies"
  // menu is fed from here (this tab owns the deployment + live data), and its
  // toggles paint one strategy's overlay on the chart at a time.
  const { dispatchChartAction } = useChartBridge();
  const { pair, setPair } = usePair();
  const { hidden } = usePrivacy();
  const [items, setItems] = useState<ApiItem[] | null>(null);
  const [records, setRecords] = useState<Map<string, StoredRecord>>(new Map());
  const [pnl, setPnl] = useState<Record<string, DepPnl>>({});
  // Live-recompute each running plan's indicator levels (same computeLevel the
  // chart line uses, refreshed every few seconds) so the card's entry/stop/
  // target cells track their line instead of showing the frozen deploy-time
  // snapshot. Keyed by deployment id.
  const liveLevels = useLiveLevels(
    (items ?? []).flatMap((it) => {
      const rec = records.get(it.id);
      const pl = rec?.plan;
      if (!pl) return [];
      return [
        {
          key: it.id,
          symbol: pl.symbol ?? rec?.symbol ?? null,
          timeframe: rec?.timeframe ?? null,
          entrySource: pl.entrySource ?? null,
          stopSource: pl.stopSource ?? null,
          targetSource: pl.targetSource ?? null,
        },
      ];
    }),
  );
  const [live, setLive] = useState<Record<string, WalletLive>>({});
  // deploymentId of the strategy whose overlay is currently painted, or null.
  // Single-active: one chart shows one strategy's overlay — either its live
  // exchange marks (in a position) or its live-tracked intended levels (armed
  // but not yet filled). Session-only; defaults off so nothing paints unasked.
  const [overlayOn, setOverlayOn] = useState<string | null>(null);
  // True while WE own the tracked-setup group (armed-strategy intended
  // levels), so clearing it never wipes a detected-setup selection we didn't
  // draw (both share the chart's single tracked-plan layer).
  const weDrewTrackedRef = useRef(false);
  const [brackets, setBrackets] = useState<BracketItem[]>([]);
  const [bracketPnl, setBracketPnl] = useState<Record<string, DepPnl>>({});
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Ref (not closure state): whether a load has ever succeeded — transient
  // failures after that never replace live data with an error screen.
  const hasDataRef = useRef(false);

  // Live positions/open orders per deployment wallet (HL public data).
  // The arguments the last full reload used, so the fast tick below can
  // refresh live state without re-fetching deployments, records and brackets.
  const liveArgsRef = useRef<{
    pnlItems: Record<string, DepPnl>;
    extraWallets: string[];
  } | null>(null);

  const loadLive = async (
    pnlItems: Record<string, DepPnl>,
    extraWallets: string[] = [],
  ) => {
    liveArgsRef.current = { pnlItems, extraWallets };
    const wallets = [
      ...new Set([
        ...Object.values(pnlItems)
          .filter((p) => p.running && p.walletAddress)
          .map((p) => p.walletAddress as string),
        ...extraWallets,
      ]),
    ];
    const next: Record<string, WalletLive> = {};
    await Promise.all(
      wallets.map(async (w) => {
        try {
          const [state, orders] = await Promise.all([
            info.clearinghouseState({ user: w as `0x${string}` }),
            info.frontendOpenOrders({ user: w as `0x${string}` }),
          ]);
          next[w] = {
            positions: (state.assetPositions ?? [])
              .map((ap) => ap.position)
              .filter((p) => p && parseFloat(p.szi) !== 0)
              .map((p) => ({
                coin: p.coin,
                szi: parseFloat(p.szi),
                entryPx: parseFloat(p.entryPx ?? "0"),
                unrealizedPnl: parseFloat(p.unrealizedPnl ?? "0"),
                liquidationPx: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
                leverage: p.leverage?.value ?? null,
              })),
            orders: (orders ?? []).map((o) => ({
              coin: o.coin,
              side: o.side,
              limitPx: o.limitPx ? parseFloat(o.limitPx) : null,
              triggerPx:
                "triggerPx" in o && o.triggerPx ? parseFloat(String(o.triggerPx)) : null,
              sz: parseFloat(o.sz ?? "0"),
              isTrigger: Boolean("isTrigger" in o ? o.isTrigger : false),
              reduceOnly: Boolean("reduceOnly" in o ? o.reduceOnly : false),
            })),
          };
        } catch {
          /* wallet fetch is best-effort */
        }
      }),
    );
    setLive(next);
  };

  // Realized-PnL equity series per bracket, from HL userFills (one fetch per
  // unique wallet). Client-side — brackets have no server pnl feed. Computed
  // for ALL brackets, not just active, so a closed order keeps its final
  // equity curve + trade list under Previous.
  const loadBracketPnl = async (brs: BracketItem[]) => {
    const act = brs.filter((x) => x.wallet_address);
    const wallets = [...new Set(act.map((x) => x.wallet_address))];
    const fillsByWallet = new Map<string, HlFill[]>();
    await Promise.all(
      wallets.map(async (w) => {
        try {
          const f = await info.userFills({ user: w as `0x${string}` });
          fillsByWallet.set(w, (Array.isArray(f) ? f : []) as unknown as HlFill[]);
        } catch {
          fillsByWallet.set(w, []);
        }
      }),
    );
    const next: Record<string, DepPnl> = {};
    for (const bk of act) {
      const since = bk.created_at ? Date.parse(bk.created_at) : 0;
      next[bk.id] = computeBracketPnl(
        fillsByWallet.get(bk.wallet_address) ?? [],
        Number.isFinite(since) ? since : 0,
        bk.wallet_address,
        bk.oids,
      );
    }
    setBracketPnl(next);
  };

  useEffect(() => {
    // Not signed in (or Privy still hydrating): show the prompt via the
    // render guard below without firing doomed unauthorized fetches. The
    // effect re-runs the moment `authed` flips true.
    if (!authed) return;
    let cancelled = false;
    const load = async (fromInterval = false) => {
      // Interval refreshes pause while the tab is hidden; the first load
      // (fromInterval=false) always runs so the panel isn't empty on return.
      if (fromInterval && document.hidden) return;
      try {
        // Progressive hydration: the deployment LIST renders as soon as it
        // arrives — PnL (exchange fills) and plan records are slower and
        // fill in when ready. Blocking the whole tab on the slowest call
        // made it feel broken.
        const dP = authFetch("/api/deployments").then((r) => r.json());
        const sP = authFetch("/api/plan-store")
          .then((r) => r.json())
          .catch(() => ({ items: [] }));
        const pP = authFetch("/api/deployments/pnl")
          .then((r) => r.json())
          .catch(() => ({ items: {} }));
        // Native brackets live upstream, separate from deployments.
        const bP = authFetch("/api/bracket")
          .then((r) => r.json())
          .catch(() => ({ items: [] }));
        const d = await dP;
        if (cancelled) return;
        if (d.error === "unauthorized") {
          // Transient (token refresh mid-flight): keep whatever is shown and
          // let the next tick retry — never latch the sign-in message while
          // the user IS signed in.
          if (!hasDataRef.current) setError(t("apiKeyPrompt"));
          return;
        }
        hasDataRef.current = true;
        setError(null); // recovery clears any stale error
        setItems(d.items ?? []);
        // A setup that hit its time limit (aliveUntil / "stop 2") was auto-
        // stopped by the watcher → surface a one-time inbox notice. The inbox
        // dedups by id, so `expired-<id>` fires exactly once per deployment.
        for (const it of (d.items ?? []) as ApiItem[]) {
          if (it.stoppedReason === "expired") {
            pushInboxNotice({
              kind: "close",
              id: `expired-${it.id}`,
              title: t("inboxExpiredTitle"),
              body: t("inboxExpiredBody").replace("{name}", it.name ?? "Setup"),
            });
          }
        }
        const s = await sP;
        if (cancelled) return;
        setRecords(
          new Map(
            ((s.items ?? []) as StoredRecord[]).map((r) => [r.deploymentId, r]),
          ),
        );
        const p = await pP;
        if (cancelled) return;
        setPnl((p.items ?? {}) as Record<string, DepPnl>);
        const b = await bP;
        if (cancelled) return;
        const bracketItems = Array.isArray(b.items) ? (b.items as BracketItem[]) : [];
        setBrackets(bracketItems);
        // Live positions/orders for BOTH deployment wallets and active-bracket
        // wallets, so a filled direct order shows the same live rows.
        void loadLive(
          (p.items ?? {}) as Record<string, DepPnl>,
          bracketItems
            .filter((x) => BRACKET_ACTIVE.includes(x.status))
            .map((x) => x.wallet_address),
        );
        // Same equity-curve series the deployment cards get, for the bracket
        // sparkline + share card.
        void loadBracketPnl(bracketItems);
      } catch {
        if (!cancelled && !hasDataRef.current) setError("failed to load");
      }
    };
    load();
    const iv = setInterval(() => void load(true), 30_000);
    // Open PnL moves every tick, but it only reached the card on the 30s full
    // reload — so a running setup's number sat still for half a minute at a
    // time and read as frozen. The realized series and the deployment list do
    // not move nearly that fast, so only the live wallet state is refreshed
    // here; it is one clearinghouse read per wallet, not the full fan-out.
    const liveIv = setInterval(() => {
      if (document.hidden || !liveArgsRef.current) return;
      const { pnlItems, extraWallets } = liveArgsRef.current;
      void loadLive(pnlItems, extraWallets);
    }, 6_000);
    // Refresh on return to a backgrounded tab (interval no-ops while hidden).
    const onVisible = () => {
      if (!document.hidden) void load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(iv);
      clearInterval(liveIv);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, authed]);

  const reload = () => setReloadKey((k) => k + 1);

  // A fresh deploy hands us an optimistic plan record + a reload nudge
  // (setups-context dispatches this after the plan-store write persists). Merge
  // the record so the new card renders WITH its plan immediately — no "foreign"
  // flash — then reload to pull the deployment item + pnl/live.
  useEffect(() => {
    const onDeployed = (e: Event) => {
      const rec = (e as CustomEvent<StoredRecord>).detail;
      if (rec?.deploymentId) {
        setRecords((prev) => new Map(prev).set(rec.deploymentId, rec));
      }
      setReloadKey((k) => k + 1);
    };
    window.addEventListener("cg:deployed", onDeployed);
    return () => window.removeEventListener("cg:deployed", onDeployed);
  }, []);

  // Auth precedes everything: while logged out (or Privy still hydrating)
  // the tab just shows the sign-in prompt — no error state involved.
  const notAuthed = !authed;

  // Report the live count to the panel so the tab badge ("Running Setups (1)")
  // reflects the SAME data this tab renders — no separate poll to drift from.
  useEffect(() => {
    if (!items) return;
    onActiveCount?.(
      items.filter((i) => ["running", "deployed"].includes(i.status ?? "")).length +
        brackets.filter((b) => BRACKET_ACTIVE.includes(b.status)).length,
    );
  }, [items, brackets, onActiveCount]);

  // Wallets held by a CURRENT deployment (any status — a stopped deployment
  // holds its wallet until deleted). Derived from the live list, NOT from
  // `pnl`: pnl comes from /v2/deployment-history, which keeps sessions of
  // DELETED deployments forever — deriving occupancy from it permanently
  // locked a wallet (and its venue balance) out of the sizing slider after
  // delete (anza's $94.21 stuck-at-$0). pnl remains only a wallet-address
  // fallback for rows the list didn't populate. null until the list loads,
  // so computeDeployable stays conservative (no idle pool) while unknown.
  const occupiedWallets = useMemo(
    () =>
      items === null
        ? null
        : new Set(
            items
              .filter((it) => !it.deletedAt)
              .map((it) =>
                (it.walletAddress ?? pnl[it.id]?.walletAddress)?.toLowerCase(),
              )
              .filter(Boolean) as string[],
          ),
    [items, pnl],
  );
  useEffect(() => {
    if (occupiedWallets) onOccupiedWallets?.(occupiedWallets);
  }, [occupiedWallets, onOccupiedWallets]);

  // Capital spoken for by LIVE strategies, per wallet. Only live states count:
  // a stopped or deleted strategy commits nothing. A live row whose stake can't
  // be read poisons its wallet to null, so the slider treats that wallet as
  // fully committed instead of over-offering.
  const committedByWallet = useMemo<CommittedByWallet | null>(() => {
    if (items === null) return null;
    const map: CommittedByWallet = new Map();
    for (const it of items) {
      if (it.deletedAt) continue;
      if (!ACTIVE_STATES.includes(it.status ?? "")) continue;
      const wallet = (it.walletAddress ?? pnl[it.id]?.walletAddress)?.toLowerCase();
      if (!wallet) continue;
      const raw = it.config?.stake_amount;
      const stake = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
      const prev = map.get(wallet);
      if (prev === null) continue; // already poisoned
      if (!Number.isFinite(stake) || stake <= 0) {
        map.set(wallet, null);
        continue;
      }
      map.set(wallet, (prev ?? 0) + stake);
    }
    return map;
  }, [items, pnl]);
  useEffect(() => {
    if (committedByWallet) onCommittedByWallet?.(committedByWallet);
  }, [committedByWallet, onCommittedByWallet]);


  // ── Strategy-overlay data for the chart's top-bar dropdown ──────────
  // One entry per running deployment: its market, whether it currently holds
  // a position (→ paint exchange truth) or is armed with dynamic triggers
  // (→ paint live-tracked intended levels), and the marks to draw.
  const overlays = useMemo(() => {
    if (!items) return [] as Array<{
      id: string;
      title: string;
      coin: string;
      pair: string;
      live: boolean;
      count: number;
      dynamic: boolean;
      marks: PosMark[];
      plan?: StoredRecord["plan"];
    }>;
    const out = [];
    for (const it of items) {
      if (!["running", "deployed"].includes(it.status ?? "")) continue;
      const rec = records.get(it.id);
      const plan = rec?.plan;
      const wallet = pnl[it.id]?.walletAddress ?? null;
      const wl = wallet ? live[wallet] : undefined;
      // Coin: prefer the live position's coin, then the config whitelist, then
      // the plan's authored market, then any coin seen in fills.
      const cfgCoin = (it.config?.exchange?.pair_whitelist?.[0] ?? "").split("/")[0];
      const recCoin = rec?.symbol ? pairToCoin(rec.symbol).split("/")[0] : "";
      const posCoin = wl?.positions[0]?.coin ?? "";
      const coin = posCoin || cfgCoin || recCoin || (pnl[it.id]?.coins ?? [])[0] || "";
      if (!coin) continue;
      const pos = wl?.positions.find((p) => p.coin === coin) ?? null;
      const orders = (wl?.orders ?? []).filter((o) => o.coin === coin);
      const marks = wl ? buildStrategyMarks(pos, orders, coin, hidden) : [];
      const dynamic = Boolean(
        plan &&
          !pos &&
          [plan.entrySource, plan.stopSource, plan.targetSource].some(
            (s) => s && s !== "fixed",
          ),
      );
      out.push({
        id: it.id,
        title: plan?.title ?? it.name ?? coin,
        coin,
        pair: coinToPair(coin),
        live: Boolean(pos),
        count: marks.length,
        dynamic,
        marks,
        plan,
      });
    }
    return out;
  }, [items, records, pnl, live, hidden]);

  // Deployable funds available to re-fund a restart (venue main + idle
  // wallets, minus any wallet a current deployment holds, plus TA1's held
  // USDC — restart re-enters the allocate-on-deploy path). Same figure the
  // sizing slider caps at; used to disable Restart when it can't cover the
  // stake.
  // Same occupancy set as onOccupiedWallets (current list, deleted rows
  // excluded) — one derivation, two consumers.
  const deployableUsd = useDeployableUsd(authed, committedByWallet);

  // Feed the chart's "Strategies" dropdown (it lives inside the TV iframe and
  // requests a replay on boot). Send only display metadata, not the marks.
  useEffect(() => {
    const emit = () =>
      window.dispatchEvent(
        new CustomEvent("cg:strategy-overlays", {
          detail: {
            items: overlays.map((o) => ({
              id: o.id,
              title: o.title,
              coin: o.coin,
              live: o.live,
              count: o.count,
              dynamic: o.dynamic,
            })),
            activeId: overlayOn,
          },
        }),
      );
    emit();
    window.addEventListener("cg:request-strategy-overlays", emit);
    return () => window.removeEventListener("cg:request-strategy-overlays", emit);
  }, [overlays, overlayOn]);

  // Dropdown toggles arrive here (single-active: re-toggling the active one
  // turns the overlay off).
  useEffect(() => {
    const onToggle = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      setOverlayOn((cur) => (cur === id ? null : id));
    };
    window.addEventListener("cg:toggle-strategy-overlay", onToggle);
    return () => window.removeEventListener("cg:toggle-strategy-overlay", onToggle);
  }, []);

  // Paint / clear the active strategy's overlay. Re-runs on the 30s poll too,
  // so a live overlay keeps its uPnL/orders fresh.
  useEffect(() => {
    let cancelled = false;
    const clearExchange = () =>
      dispatchChartAction({ action: "draw_position_marks", marks: [] });
    const clearTracked = async () => {
      if (weDrewTrackedRef.current) {
        await dispatchChartAction({ action: "draw_tracked_setup", levels: [] });
        weDrewTrackedRef.current = false;
      }
    };
    const run = async () => {
      if (!overlayOn) {
        await clearExchange();
        await clearTracked();
        return;
      }
      const o = overlays.find((x) => x.id === overlayOn);
      if (!o) {
        // Strategy stopped/vanished — clear the chart. The selection id is
        // harmlessly stale (the dropdown no longer lists it); the next toggle
        // resets it.
        await clearExchange();
        await clearTracked();
        return;
      }
      // Bring the chart to the strategy's market first and WAIT for the symbol
      // swap so the marks attach to the right chart.
      const curCoin = pairToCoin(pair).split("/")[0];
      if (curCoin !== o.coin) {
        try {
          await dispatchChartAction({ action: "set_symbol", pair: o.pair });
        } catch {
          /* unresolved symbol: draw on the current chart anyway */
        }
        setPair(o.pair);
      }
      if (cancelled) return;
      if (o.live || o.count > 0) {
        // In a position (or resting orders exist) → exchange truth.
        await clearTracked();
        await dispatchChartAction({ action: "draw_position_marks", marks: o.marks });
      } else if (o.dynamic && o.plan) {
        // Armed, not yet filled → live-tracked INTENDED levels (entry/stop/
        // target recompute every few seconds against the chart's bars).
        await clearExchange();
        const p = o.plan;
        await dispatchChartAction({
          action: "draw_tracked_setup",
          levels: [
            { role: "entry", price: p.entry, label: `${t("entry")} · ${p.title}`, source: p.entrySource },
            { role: "stop", price: p.stop, label: t("stop"), source: p.stopSource },
            { role: "target", price: p.target, label: t("target"), source: p.targetSource },
          ],
        });
        weDrewTrackedRef.current = true;
      } else if (o.plan) {
        // Armed with only fixed levels → static intended lines.
        await clearTracked();
        const p = o.plan;
        const staticMarks: PosMark[] = (
          [
            { price: p.entry, label: t("entry"), kind: "entry" },
            { price: p.stop, label: t("stop"), kind: "sl" },
            { price: p.target, label: t("target"), kind: "tp" },
          ] as PosMark[]
        ).filter((m) => Number.isFinite(m.price) && m.price > 0);
        await dispatchChartAction({ action: "draw_position_marks", marks: staticMarks });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayOn, overlays, pair]);

  if (notAuthed)
    return <div className="p-3 font-mono text-[11px] text-white/40">{t("apiKeyPrompt")}</div>;
  if (error) return <div className="p-3 font-mono text-[11px] text-white/40">{error}</div>;
  if (!items) return <div className="p-3 font-mono text-[11px] text-white/40">{t("loading")}</div>;
  if (!items.length && !brackets.length) return <SetupsEmpty variant="running" />;

  const active = items.filter((i) => ACTIVE_STATES.includes(i.status ?? ""));
  const previous = items.filter((i) => !ACTIVE_STATES.includes(i.status ?? ""));
  const activeBrackets = brackets.filter((b) => BRACKET_ACTIVE.includes(b.status));
  // Closed / cancelled direct orders are history — they belong under Previous
  // alongside the finished deployments.
  const previousBrackets = brackets.filter((b) => !BRACKET_ACTIVE.includes(b.status));

  // Deployments and direct orders are one timeline, not two lists — see
  // lib/setup-order. created_at is the only timestamp both carry, so Previous
  // is ordered by when a setup STARTED, not when it finished: neither type
  // exposes an ended-at, and deriving one from status would be a guess.
  const rowsOf = (deps: ApiItem[], brks: BracketItem[]) =>
    orderSetupsNewestFirst(deps, brks);

  const sectionLabel = "px-1 font-mono text-[10px] uppercase tracking-widest text-white/40";
  const renderDep = (it: ApiItem) => (
    <DeploymentCard
      key={it.id}
      item={it}
      record={records.get(it.id)}
      pnl={pnl[it.id]}
      liveLevels={liveLevels.get(it.id)}
      live={
        pnl[it.id]?.walletAddress
          ? live[pnl[it.id].walletAddress as string]
          : undefined
      }
      deployableUsd={deployableUsd}
      onReload={reload}
    />
  );

  return (
    <div className="space-y-4 p-3">
      {(active.length > 0 || activeBrackets.length > 0) && (
        <div className="space-y-2.5">
          {/* A direct order is a running setup like any other — it lives under
              Active rather than in a section of its own. */}
          <div className={sectionLabel}>{t("sectionActive")}</div>
          {rowsOf(active, activeBrackets).map((row) =>
            row.kind === "dep" ? (
              renderDep(row.item)
            ) : (
              <BracketCard
                key={row.b.id}
                b={row.b}
                live={live[row.b.wallet_address]}
                pnl={bracketPnl[row.b.id]}
                record={records.get(row.b.id)}
                onReload={reload}
              />
            ),
          )}
        </div>
      )}
      {(previous.length > 0 || previousBrackets.length > 0) && (
        <div className="space-y-2.5">
          <div className={sectionLabel}>{t("sectionPrevious")}</div>
          {rowsOf(previous, previousBrackets).map((row) =>
            row.kind === "dep" ? (
              renderDep(row.item)
            ) : (
              <BracketCard
                key={row.b.id}
                b={row.b}
                pnl={bracketPnl[row.b.id]}
                record={records.get(row.b.id)}
                onReload={reload}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/* ── Detected chart setups ─────────────────────────────────────────── */

function fmt(p: number): string {
  return p >= 1000
    ? p.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : String(p);
}

/** Level price for display. `live` (from useLiveLevels — the same computeLevel
 *  the chart line uses, refreshed every few seconds) wins so an indicator-based
 *  cell tracks its line instead of showing the frozen plan-time snapshot.
 *  Falls back to the time-only trendline recompute (before candles load), then
 *  to the stored price for genuine fixed levels. */
// Live values shown to ~3 significant figures (324, 34.3, 1.32, 0.342) — enough
// that a real move surfaces in the digits without noisy long tails. Values ≥
// 1000 keep every integer digit (a price isn't rounded to 3 figures) and get a
// thousands separator, matching the fixed-price fmt().
function fmtLive(v: number): string {
  const a = Math.abs(v);
  const decimals = a > 0 ? Math.max(0, 2 - Math.floor(Math.log10(a))) : 2;
  return v >= 1000
    ? v.toLocaleString("en-US", { maximumFractionDigits: decimals })
    : v.toFixed(decimals);
}

function levelPrice(price: number, source?: string | null, live?: number): string {
  if (typeof live === "number" && Number.isFinite(live)) {
    return `≈${fmtLive(live)}`;
  }
  const src = parseLevelSource(source);
  if (src.kind === "trendline" && src.anchors) {
    const now = trendlineValueAt(src.anchors, Math.floor(Date.now() / 1000));
    return `≈${fmtLive(now)}`;
  }
  return fmt(price);
}

/** Price cell that pulses (cg-level-flash) whenever a LIVE (≈-prefixed) value
 *  changes — the changing React key remounts the span so the CSS animation
 *  replays each tick the number actually moves. Fixed prices never change, so
 *  they never flash. */
function LivePrice({ value, className }: { value: string; className: string }) {
  const live = value.startsWith("≈");
  return (
    <span key={value} className={live ? `${className} cg-level-flash` : className}>
      {value}
    </span>
  );
}

// Tier badge (S/A/B/C/D) shown before a setup's name; hover reveals the reason.
const TIER_STYLE: Record<string, string> = {
  S: "bg-gradient-to-br from-lime-300 to-emerald-400 text-black shadow-[0_0_12px_rgba(163,230,53,0.75)]",
  A: "bg-lime-400/90 text-black shadow-[0_0_10px_rgba(163,230,53,0.45)]",
  B: "bg-sky-400/85 text-black",
  C: "bg-amber-400/80 text-black",
  D: "bg-white/15 text-white/70",
};

function TierBadge({ tier, reason }: { tier: string; reason?: string | null }) {
  return (
    <span className="group/tier relative inline-flex shrink-0 items-center">
      <span
        className={`inline-flex h-5 cursor-help items-center justify-center rounded-md px-1.5 font-mono text-[10px] font-bold uppercase tracking-wide leading-none ${
          TIER_STYLE[tier] ?? TIER_STYLE.D
        }`}
      >
        {tier} Tier
      </span>
      {reason && (
        <span className="pointer-events-none absolute left-0 top-full z-20 mt-1.5 hidden w-56 rounded-lg border border-white/15 bg-black/90 p-2.5 text-left font-mono text-[10px] normal-case leading-relaxed text-white/80 shadow-xl backdrop-blur-md group-hover/tier:block">
          <span className="font-bold text-white">{tier} tier</span> — {reason}
        </span>
      )}
    </span>
  );
}

// One plan level: condition is the headline (these are Freqtrade conditional
// triggers), the price rides behind it, muted. Falls back to price-only.
/** The thesis / entry / stop 1 / stop 2 / target / invalidation block.
 *  Shared so a live one-shot order reads exactly like the draft it came from —
 *  a card that shows only prices leaves the user without the reasoning they
 *  approved. */
function PlanDetail({
  plan,
  liveLevels,
}: {
  plan: StoredRecord["plan"] | undefined;
  liveLevels?: LiveLevels;
}) {
  const { t, lang } = useLang();
  if (!plan) return null;
  return (
    <>
      {plan.thesis && (
        <p className="mt-2 text-[12px] leading-relaxed text-white/60">
          {planField(plan, "thesis", lang)}
        </p>
      )}
      <div className="mt-2.5 space-y-1.5 font-mono text-[11px]">
        <LevelRow label={t("entry")} condition={planField(plan, "entryCondition", lang)} price={levelPrice(plan.entry, (plan as { entrySource?: string | null }).entrySource, liveLevels?.entry)} tone="entry" />
        <LevelRow label={aliveWindow(plan.aliveUntil) ? `${t("stop")} 1` : t("stop")} condition={planField(plan, "stopCondition", lang)} price={levelPrice(plan.stop, (plan as { stopSource?: string | null }).stopSource, liveLevels?.stop)} tone="stop" />
        <AutoStopRow label={`${t("stop")} 2`} aliveUntil={plan.aliveUntil} reason={planField(plan, "aliveUntilReason", lang)} />
        <LevelRow label={t("target")} condition={planField(plan, "targetCondition", lang)} price={levelPrice(plan.target, (plan as { targetSource?: string | null }).targetSource, liveLevels?.target)} tone="target" />
      </div>
      {plan.invalidation && (
        <div className="mt-2 font-mono text-[10px] text-white/40">
          ✕ {planField(plan, "invalidation", lang)}
        </div>
      )}
    </>
  );
}

function LevelRow({
  label,
  condition,
  price,
  tone,
}: {
  label: string;
  condition?: string | null;
  price: string;
  tone: "entry" | "stop" | "target";
}) {
  const priceColor =
    tone === "stop" ? "text-red-300/80" : tone === "target" ? "text-lime-300/80" : "text-white/55";
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-12 shrink-0 text-[9px] uppercase tracking-wider text-white/40">
        {label}
      </span>
      {condition ? (
        <>
          <span className="min-w-0 flex-1 text-white/85">{condition}</span>
          <LivePrice value={price} className={`shrink-0 tabular-nums ${priceColor}`} />
        </>
      ) : (
        <LivePrice
          value={price}
          className={`flex-1 ${tone === "stop" ? "text-red-300" : tone === "target" ? "text-lime-300" : "text-white"}`}
        />
      )}
    </div>
  );
}

/** Localized plan field: plans carry English primaries + a zh block
 *  generated in the same pass — pick per active language, fall back to
 *  English (older stored plans have no zh). */
function planField<
  K extends
    | "title"
    | "thesis"
    | "invalidation"
    | "tierReason"
    | "entryCondition"
    | "stopCondition"
    | "targetCondition"
    | "aliveUntilReason",
>(
  plan: { zh?: DetectedPlan["zh"] } & Partial<Record<K, string | null>>,
  key: K,
  lang: string,
): string | null {
  const zh = lang === "zh" ? plan.zh?.[key] : null;
  return (zh ?? plan[key] ?? null) as string | null;
}

/** Direction badge: ▲ long (lime) / ▼ short (red) / ↔ neutral (glass) —
 *  neutral = range rotation trading both sides. Glyph at 0.7em. */
function DirectionBadge({ direction }: { direction: "long" | "short" | "neutral" }) {
  const { t } = useLang();
  const cls =
    direction === "long"
      ? "bg-lime-400 text-black"
      : direction === "short"
        ? "bg-red-400 text-black"
        : "bg-white/15 text-white/90";
  const glyph = direction === "long" ? "▲" : direction === "short" ? "▼" : "↔";
  return (
    <span
      className={`inline-flex h-5 items-center gap-[3px] rounded-md px-1.5 font-mono text-[10px] font-bold uppercase leading-none ${cls}`}
    >
      <span className="text-[0.7em] leading-none">{glyph}</span>
      {t(direction)}
    </span>
  );
}

/** Parse an ISO alive_until into a short relative window ("48h" / "2d"), or
 *  null if absent/unparseable — so a card NEVER renders "Invalid Date". */
function aliveWindow(aliveUntil?: string | null): string | null {
  if (!aliveUntil) return null;
  const ts = Date.parse(aliveUntil);
  if (Number.isNaN(ts)) return null;
  const ms = ts - Date.now();
  if (ms <= 0) return "expired";
  const h = ms / 3_600_000;
  return h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
}

/** Auto-stop as a level-style row (label · reason · window), amber-toned, so
 *  it lines up under Entry/Stop/Target. Renders nothing without a valid time. */
function AutoStopRow({
  label,
  aliveUntil,
  reason,
}: {
  label: string;
  aliveUntil?: string | null;
  reason?: string | null;
}) {
  const win = aliveWindow(aliveUntil);
  if (!win) return null;
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-12 shrink-0 text-[9px] uppercase tracking-wider text-white/40">
        {label}
      </span>
      {reason ? (
        <>
          <span className="min-w-0 flex-1 text-white/85">{reason}</span>
          <span className="shrink-0 tabular-nums text-amber-300/90">{win}</span>
        </>
      ) : (
        <span className="flex-1 text-amber-300/90">{win}</span>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  marked,
  onToggle,
  fresh = false,
  onShowRunning,
  liveLevels,
}: {
  plan: DetectedPlan;
  marked: boolean;
  onToggle: (plan: DetectedPlan) => void;
  /** Live-recomputed indicator level values, refreshed every few seconds. */
  liveLevels?: LiveLevels;
  /** Just published by the chat agent — pulse so the panel update is seen. */
  fresh?: boolean;
  /** Switch the panel to the Running tab (deployed-live CTA). */
  onShowRunning?: () => void;
}) {
  const { t, lang } = useLang();
  const { requireAuth } = useAuthGate();
  const {
    deployProgress,
    deployPlan,
    freeSlotAndRetry,
    deployBusy,
    funds,
    leverage,
    dismissPlan,
  } = useSetups();
  const { hidden } = usePrivacy();
  const { pair } = usePair();
  // Venue of what would deploy: the plan's own symbol, else the selected pair.
  // Both collapse to "hyperliquid" while the flag is off (no prefixed symbols
  // can exist then), keeping the default UI untouched.
  const venueUi = lighterUiEnabled();
  const planVenue: Venue = venueOfSymbol(plan.symbol ?? pair);
  // Honest gate: Lighter live deploys are in rollout — clicking Confirm on a
  // Lighter pair shows this inline notice instead of pretending to deploy.
  const [lighterNotice, setLighterNotice] = useState(false);
  const rr = Math.abs(plan.target - plan.entry) / Math.max(Math.abs(plan.entry - plan.stop), 1e-9);
  // Deploy state lives in setups-context: it survives tab switches.
  const progress = deployProgress?.planId === plan.id ? deployProgress : null;
  const deploying = Boolean(progress && !progress.done && !progress.error);
  // Soft capital-protection guard: a time-boxed setup whose window has passed
  // carries stale fixed levels, so deploying now can enter at a price the thesis
  // never intended (an instant loss). Warn before deploying an expired setup.
  const [confirmExpired, setConfirmExpired] = useState(false);
  const expired =
    plan.aliveUntil != null &&
    !Number.isNaN(Date.parse(plan.aliveUntil)) &&
    Date.parse(plan.aliveUntil) < Date.now();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onToggle(plan)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onToggle(plan);
      }}
      className={`liquid-glass cursor-pointer rounded-[1rem] p-3.5 transition-all ${
        marked
          ? "outline outline-2 outline-lime-400/70"
          : fresh
            ? "cg-slide-in outline outline-2 outline-lime-300/60"
            : "hover:outline hover:outline-1 hover:outline-white/20"
      }`}
      style={{
        background: marked
          ? "rgba(163,230,53,0.10)"
          : fresh
            ? "rgba(163,230,53,0.07)"
            : "var(--glass-fill)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {plan.tier && (
            <TierBadge tier={plan.tier} reason={planField(plan, "tierReason", lang)} />
          )}
          <span className="truncate text-[13px] font-semibold text-white">
            {planField(plan, "title", lang)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            title={t(plan.mode === "one_shot" ? "oneShotTip" : "recurringTip")}
            className={`inline-flex h-5 cursor-help items-center gap-0.5 rounded-md px-1.5 font-mono text-[10px] font-bold uppercase leading-none ${
              plan.mode === "one_shot"
                ? "bg-amber-400/15 text-amber-300"
                : "bg-white/10 text-white/70"
            }`}
          >
            {plan.mode === "one_shot" ? "⧗" : "↻"} {t(plan.mode === "one_shot" ? "oneShot" : "recurring")}
          </span>
          <DirectionBadge direction={plan.direction} />
          <span className="group relative inline-flex items-center">
            <span
              className={`inline-flex h-5 cursor-help items-center rounded-md px-1.5 font-mono text-[10px] font-bold leading-none ${
                rr >= 2
                  ? "bg-[rgba(163,230,53,0.18)] text-lime-300"
                  : rr >= 1.5
                    ? "bg-white/10 text-white/80"
                    : "bg-amber-400/15 text-amber-300"
              }`}
            >
              {t("rrBadge").replace("{rr}", rr.toFixed(1))}
            </span>
            <span className="pointer-events-none absolute right-0 top-full z-20 mt-1.5 hidden w-56 rounded-lg border border-white/15 bg-black/90 p-2.5 text-left font-mono text-[10px] normal-case leading-relaxed text-white/80 shadow-xl backdrop-blur-md group-hover:block">
              {t("rrTip").replace("{rr}", rr.toFixed(1))}
            </span>
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-white/60">
        {planField(plan, "thesis", lang)}
      </p>
      {/* Sizing the deploy will use = the panel sliders verbatim (exchange
          standard: stake = funds you set, leverage = leverage you set). The
          risk readout is what hitting the stop costs at that fixed size, not a
          driver of it. Privacy hides $. */}
      {(() => {
        const d = fixedSizing({ entry: plan.entry, stop: plan.stop, funds, leverage });
        const pair = plan.symbol ? `${plan.symbol} · ` : "";
        if (!d) return null;
        return (
          <div className="mt-2 font-mono text-[10.5px] tabular-nums text-white/45">
            {pair}
            {hidden ? "•••" : `$${d.stake.toLocaleString("en-US")}`} · {d.leverage}×
            {d.riskUsd > 0 && (
              <>
                {" "}
                · {t("riskLabel")}{" "}
                {hidden ? "•••" : `$${d.riskUsd.toLocaleString("en-US")}`}
              </>
            )}
          </div>
        );
      })()}
      <div className="mt-2.5 space-y-1.5 font-mono text-[11px]">
        <LevelRow label={t("entry")} condition={planField(plan, "entryCondition", lang)} price={levelPrice(plan.entry, (plan as { entrySource?: string | null }).entrySource, liveLevels?.entry)} tone="entry" />
        <LevelRow label={aliveWindow(plan.aliveUntil) ? `${t("stop")} 1` : t("stop")} condition={planField(plan, "stopCondition", lang)} price={levelPrice(plan.stop, (plan as { stopSource?: string | null }).stopSource, liveLevels?.stop)} tone="stop" />
        <AutoStopRow label={`${t("stop")} 2`} aliveUntil={plan.aliveUntil} reason={planField(plan, "aliveUntilReason", lang)} />
        <LevelRow label={t("target")} condition={planField(plan, "targetCondition", lang)} price={levelPrice(plan.target, (plan as { targetSource?: string | null }).targetSource, liveLevels?.target)} tone="target" />
      </div>
      <div className="mt-2 font-mono text-[10px] text-white/40">
        ✕ {planField(plan, "invalidation", lang)}
      </div>
      {confirmExpired && (
        <Dialog
          title={t("expiredWarnTitle")}
          size="md"
          onClose={() => setConfirmExpired(false)}
        >
          <div className="flex items-center gap-4">
            <WarnGlassIcon src="/warning/expired.webp" />
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-white/80">
              {t("expiredWarnBody")}
            </p>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button
              onClick={() => setConfirmExpired(false)}
              className="rounded-full border border-white/15 bg-white/[0.06] px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-white/80 transition-colors hover:text-white"
            >
              {t("clearNo")}
            </button>
            <button
              onClick={() => {
                setConfirmExpired(false);
                requireAuth(() => void deployPlan(plan));
              }}
              className="rounded-full bg-amber-400 px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-black transition-opacity hover:opacity-85"
            >
              {t("expiredWarnGo")}
            </button>
          </div>
        </Dialog>
      )}
      {progress ? (
        <DeployProgressBar
          progress={progress}
          onRetry={() => requireAuth(() => void deployPlan(plan))}
          onFreeSlot={
            progress.capCandidate
              ? () => requireAuth(() => void freeSlotAndRetry(plan))
              : undefined
          }
          onShowRunning={onShowRunning}
        />
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              // Lighter pairs never enter the Freqtrade compile/deploy path —
              // surface the rollout notice instead of a fake deploy.
              if (venueUi && planVenue === "lighter") {
                setLighterNotice(true);
                return;
              }
              if (expired) setConfirmExpired(true);
              else requireAuth(() => void deployPlan(plan));
            }}
            // Locked while ANY deploy is in flight, not just this card's. Two
            // deploys racing compete for the same trading accounts and the
            // same funding pool, and the second one reads a balance the first
            // is still moving.
            disabled={deploying || deployBusy}
            {...(deployBusy && !deploying
              ? { title: t("deployBusyElsewhere") }
              : venueUi
                ? {
                    title: VENUES[planVenue].label,
                    "aria-label": `${t("confirmDeploy")} · ${VENUES[planVenue].label}`,
                  }
                : {})}
            className="rounded-full bg-lime-400 px-3.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-black transition-all hover:opacity-85 disabled:opacity-40"
          >
            {venueUi && <VenueMark venue={planVenue} />}
            {t("confirmDeploy")}
          </button>
          {/* Skip: hide this draft card (persisted so it stays gone). */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              dismissPlan(plan.id);
            }}
            className="rounded-full border border-white/12 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-white/45 transition-colors hover:border-white/25 hover:text-white/70"
          >
            {t("skip")}
          </button>
          {lighterNotice && (
            <p
              onClick={(e) => e.stopPropagation()}
              className="w-full rounded-lg bg-amber-400/10 px-3 py-2 font-mono text-[10.5px] leading-relaxed text-amber-300"
            >
              {t("lighterDeployRollout")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Stepped deploy progress: compile → create → wallet → start. Human
 *  messages only — never raw step codes or JSON. */
function DeployProgressBar({
  progress,
  onRetry,
  onFreeSlot,
  onShowRunning,
}: {
  progress: NonNullable<ReturnType<typeof useSetups>["deployProgress"]>;
  onRetry: () => void;
  /** Offered only when the cap blocked the deploy AND a non-trading
   *  deployment exists to remove. */
  onFreeSlot?: () => void;
  onShowRunning?: () => void;
}) {
  const { t } = useLang();
  const { cancelDeploy } = useSetups();
  const STEPS = [
    t("deployStepCompile"),
    t("deployStepCreate"),
    t("deployStepWallet"),
    t("deployStepStart"),
  ];
  const failed = Boolean(progress.error);
  const stopped = Boolean(progress.canceled);
  // Stoppable until it is over, one way or another.
  const inFlight = !progress.done && !failed && !stopped;
  const pct = progress.done
    ? 100
    : ((progress.step + (failed ? 0 : 0.5)) / STEPS.length) * 100;
  return (
    <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between font-mono text-[9.5px] uppercase tracking-wider">
        <span
          className={
            failed
              ? "text-red-300"
              : stopped
                ? "text-white/55"
                : progress.done
                  ? "text-lime-300"
                  : "text-white/70"
          }
        >
          {failed || !progress.done
            ? stopped
              ? progress.canceled
              : STEPS[progress.step]
            : t("deployedLive")}
          {inFlight && <span className="animate-pulse">…</span>}
        </span>
        {inFlight ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              cancelDeploy();
            }}
            disabled={progress.canceling}
            className="rounded-full bg-white/10 px-2.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider text-white/75 transition-colors hover:bg-red-400/20 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-white/10 disabled:hover:text-white/75"
          >
            {progress.canceling ? t("deployStopping") : t("deployStop")}
          </button>
        ) : progress.done && !failed && onShowRunning ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onShowRunning();
            }}
            className="rounded-full bg-white/10 px-2.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider text-white/75 transition-colors hover:bg-white/20 hover:text-white"
          >
            {t("seeRunning")}
          </button>
        ) : (
          <span className="text-white/35">
            {Math.min(progress.step + (progress.done ? 1 : 0), STEPS.length)}/{STEPS.length}
          </span>
        )}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            failed ? "bg-red-400" : stopped ? "bg-white/30" : "bg-lime-400"
          }`}
          style={{ width: `${failed || stopped ? Math.max(pct, 8) : pct}%` }}
        />
      </div>
      {inFlight && progress.note && (
        <div className="mt-1 font-mono text-[9.5px] text-white/40">
          {progress.note}
        </div>
      )}
      {stopped && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          className="mt-2 rounded-full bg-white/10 px-3.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-white/80 transition-all hover:bg-white/20"
        >
          ↻ {t("retry")}
        </button>
      )}
      {failed && (
        <>
          <div className="mt-1.5 font-mono text-[10px] leading-relaxed text-red-300/90">
            {progress.error}
          </div>
          {progress.capCandidate && onFreeSlot ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFreeSlot();
              }}
              className="mt-2 rounded-full bg-lime-400 px-3.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-black transition-all hover:opacity-85"
            >
              {t("capFreeBtn")}
            </button>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
              className="mt-2 rounded-full bg-white/10 px-3.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-white/80 transition-all hover:bg-white/20"
            >
              ↻ {t("retry")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Funds + leverage sliders. Funds ranges over the DEPLOYABLE amount:
 *  venue deployable (main + idle withdrawable) + TA1's held on-chain USDC
 *  (see useDeployableUsd); leverage max follows the CURRENT pair's
 *  per-asset cap. */
function SizingControls({
  committedByWallet,
}: {
  committedByWallet: CommittedByWallet | null;
}) {
  const { t } = useLang();
  const { hidden } = usePrivacy();
  // Sizing is read at the top of a deploy and sent verbatim as the order.
  // Moving a slider mid-deploy cannot change the order already in flight, so
  // leaving them live would only make the panel disagree with what deployed.
  const { funds, setFunds, leverage, setLeverage, deployBusy } = useSetups();
  const { pair } = usePair();
  const { assetsByName } = useHyperliquid();
  const { authed } = useAuthGate();

  const asset = resolveAsset(assetsByName, pairToCoin(pair));
  const maxLev = asset?.maxLeverage ?? 1;
  const isSpot = asset?.marketType === "spot";

  // Deployable ceiling: venue deployable (main withdrawable + the SUM of
  // every idle trading account, since deploy-time funding pulls from both)
  // + the USDC held on-chain in TA1, which allocate-on-deploy bridges into
  // the venue. Without the held pot, a hold-model account (deposits parked
  // in TA1, venue $0) read as $0 and the slider collapsed to its $10 floor.
  const deployable = useDeployableUsd(authed, committedByWallet);

  // 95% of deployable — NOT the full balance. Freqtrade's
  // tradable_balance_ratio (0.99) reserves 1% of the wallet and
  // leverage-scaled taker fees come from the same balance, so a stake equal
  // to the wallet makes the bot silently never trade. While an authed
  // balance is still loading the slider is LOCKED (no guessing a $1,000 cap
  // the user may not have); logged out keeps a nominal $1,000 range.
  const balanceLoading = authed && deployable === null;
  const maxFunds = deployable !== null ? maxStakeFor(deployable) : 1000;
  const effFunds = Math.min(funds, maxFunds);
  const effLev = Math.min(leverage, maxLev);

  // Pair switches (incl. agent set_symbol) clamp the current value.
  useEffect(() => {
    if (leverage > maxLev) setLeverage(maxLev);
  }, [maxLev, leverage, setLeverage]);

  // Funds needs the same write-back, and did not have it. effFunds below is a
  // local Math.min for DISPLAY only, so the panel showed the capped figure
  // while the stored value stayed above it — and deployPlan reads the stored
  // value, not the displayed one. A profile whose balance had fallen (or which
  // never moved the slider off its $100 default) deployed a size the panel had
  // already told the user was too large, and the venue rejected it for
  // insufficient margin.
  //
  // Not while the balance is loading: maxFunds falls back to a nominal $1,000
  // then, and clamping against a placeholder would write a number the user
  // never chose.
  useEffect(() => {
    if (!balanceLoading && funds > maxFunds) setFunds(maxFunds);
  }, [balanceLoading, funds, maxFunds, setFunds]);

  const fill = (v: number, min: number, max: number) =>
    `${max <= min ? 0 : ((v - min) / (max - min)) * 100}%`;

  // Privacy mode: funds display switches to % of the tradable balance —
  // the underlying deployed amount stays the real $ figure internally.
  const fundsPct = Math.round((effFunds / maxFunds) * 100);

  return (
    <div className="space-y-3 px-1 pb-1 pt-3">
      <div className="space-y-2.5">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/50">
            {t("sizingFunds")}
          </span>
          <span className="font-mono text-[12px] font-bold tabular-nums text-white">
            {balanceLoading
              ? "…"
              : hidden
                ? `${fundsPct}%`
                : `$${effFunds.toLocaleString("en-US")}`}
            {!balanceLoading && (
              <span className="ml-1 text-white/35">
                {hidden ? "/ 100%" : `/ $${maxFunds.toLocaleString("en-US")}`}
              </span>
            )}
          </span>
        </div>
        <input
          type="range"
          min={10}
          max={maxFunds}
          step={maxFunds > 2000 ? 25 : 5}
          value={effFunds}
          onChange={(e) => setFunds(Number(e.target.value))}
          disabled={balanceLoading || deployBusy}
          title={
            deployBusy
              ? t("deployBusyElsewhere")
              : balanceLoading
                ? t("balanceLoading")
                : hidden
                  ? "tradable 100%"
                  : `tradable $${maxFunds}`
          }
          className="cg-range w-full"
          style={{ "--fill": fill(effFunds, 10, maxFunds) } as React.CSSProperties}
        />
      </div>
      <div className="space-y-2.5">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/50">
            {t("sizingLeverage")}
          </span>
          <span className="font-mono text-[12px] font-bold tabular-nums text-white">
            {isSpot ? "—" : `${effLev}×`}
            {!isSpot && maxLev > 1 && (
              <span className="ml-1 text-white/35">/ {maxLev}×</span>
            )}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={maxLev}
          step={1}
          value={effLev}
          onChange={(e) => setLeverage(Math.max(1, Number(e.target.value)))}
          disabled={isSpot || maxLev <= 1 || deployBusy}
          title={
            deployBusy
              ? t("deployBusyElsewhere")
              : isSpot
                ? "Spot market — no leverage"
                : `${pair} allows up to ${maxLev}×`
          }
          className="cg-range w-full"
          style={{ "--fill": fill(effLev, 0, maxLev) } as React.CSSProperties}
        />
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-t border-white/[0.06] pt-3 font-mono text-[10px] text-white/45">
        <span>
          {t("sizingPosition")} ≈{" "}
          <span className="text-white/70">
            {/* % of tradable balance × leverage — screen-share-safe scale. */}
            {hidden
              ? `${fundsPct * (isSpot ? 1 : effLev)}%`
              : `$${(effFunds * (isSpot ? 1 : effLev)).toLocaleString("en-US")}`}
          </span>{" "}
          · {t("sizingMax")} {maxLev}×
        </span>
        {/* Hidden mode: tradable would always read "100%" — drop the row. */}
        {deployable !== null && !hidden && (
          <span>
            {/* maxFunds, not raw deployable: the label must equal the slider's
                ceiling. Showing the un-hairclipped balance read as $10 more
                than the slider would ever let you stake. */}
            {t("sizingTradable")} ${maxFunds.toLocaleString("en-US")}
          </span>
        )}
      </div>
    </div>
  );
}

function DetectedTab({
  committedByWallet,
  onShowRunning,
}: {
  committedByWallet: CommittedByWallet | null;
  onShowRunning: () => void;
}) {
  const {
    plans,
    readout,
    detectMeta,
    detecting,
    error,
    detect,
    activePlan,
    toggleMark,
    freshPlanIds,
    deployBusy,
  } = useSetups();
  const { t } = useLang();
  const { requireAuth } = useAuthGate();
  const { getChartContext } = useChartBridge();
  // Draft cards live-track their indicator levels too (same as running cards).
  // Drafts are detected on the current chart, so its timeframe is the basis.
  const draftTf = getChartContext()?.timeframe ?? null;
  const liveLevels = useLiveLevels(
    plans.map((p) => ({
      key: p.id,
      symbol: p.symbol ?? null,
      timeframe: draftTf,
      entrySource: p.entrySource ?? null,
      stopSource: p.stopSource ?? null,
      targetSource: p.targetSource ?? null,
    })),
  );
  // Detection is one long model call — surface progress as elapsed-driven
  // steps (mirrors the deploy progress bar) so the wait reads as work, not
  // a hang. The bar approaches 95% asymptotically until the result lands.
  const [detectElapsed, setDetectElapsed] = useState(0);
  useEffect(() => {
    if (!detecting) {
      setDetectElapsed(0);
      return;
    }
    const t0 = Date.now();
    const iv = setInterval(() => setDetectElapsed((Date.now() - t0) / 1000), 250);
    return () => clearInterval(iv);
  }, [detecting]);
  const [confirmBare, setConfirmBare] = useState(false);

  // Bare chart (no user drawings, no indicators): confirm before running a
  // pure price/volume/derivatives read so the user knows what they'll get.
  const startDetect = () => {
    const ctx = getChartContext();
    const bare =
      !ctx?.drawings?.some((d) => d.origin === "user") &&
      !(ctx?.indicators?.length ?? 0);
    if (bare) setConfirmBare(true);
    else void detect();
  };

  return (
    <div className="space-y-2.5 p-3">
      <SizingControls committedByWallet={committedByWallet} />
      {confirmBare && (
        <Dialog title={t("bareDetectTitle")} size="md" onClose={() => setConfirmBare(false)}>
          <div className="flex items-center gap-4">
            <WarnGlassIcon src="/warning/bare-chart.webp" />
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-white/80">
              {t("bareDetectBody")}
            </p>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button
              onClick={() => setConfirmBare(false)}
              className="rounded-full border border-white/15 bg-white/[0.06] px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-white/80 transition-colors hover:text-white"
            >
              {t("clearNo")}
            </button>
            <button
              onClick={() => {
                setConfirmBare(false);
                void detect();
              }}
              className="rounded-full bg-lime-400 px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-black transition-opacity hover:opacity-85"
            >
              {t("bareDetectGo")}
            </button>
          </div>
        </Dialog>
      )}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => requireAuth(startDetect)}
          // Detection replaces the draft cards, including the one currently
          // deploying — its progress bar would vanish mid-deploy and take the
          // Stop button with it.
          disabled={detecting || deployBusy}
          {...(deployBusy && !detecting ? { title: t("deployBusyElsewhere") } : {})}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-lime-400 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-black transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          {/* Brand triangle (matches the chat input's AI mark), not the ✦ spark. */}
          {!detecting && (
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3 shrink-0">
              <path d="M12 3 21 19H3Z" />
            </svg>
          )}
          {/* While detecting the button stays COMPACT (spinner + elapsed) —
              the descriptive step progress lives in the glass loader card
              below, so the sidebar shows ONE loading message, not two. */}
          {detecting ? (
            <>
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-[2px] border-black/25 border-t-black" />
              {`${Math.floor(detectElapsed)}s`}
            </>
          ) : (
            t("detect")
          )}
        </button>
        <span className="group relative">
          <button
            className="cursor-not-allowed rounded-full border border-white/15 bg-white/[0.05] px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-white/45"
          >
            {t("advancedSettings")}
          </button>
          <span className="pointer-events-none absolute right-0 top-full z-20 mt-1.5 hidden whitespace-nowrap rounded-lg border border-white/15 bg-black/90 px-2.5 py-1.5 font-mono text-[10px] text-white/80 shadow-xl backdrop-blur-md group-hover:block">
            {t("comingSoon")}
          </span>
        </span>
      </div>
      {error && (
        <div className="font-mono text-[11px] text-red-300">
          {/unauthorized|invalid token/i.test(error) ? t("apiKeyPrompt") : error}
        </div>
      )}
      {detecting && (
        <div
          className="cg-slide-in liquid-glass rounded-[1rem] px-3.5 py-3"
          style={{ background: "var(--glass-fill)" }}
        >
          {/* Asymptotic fill: fast early, slows toward 95% until plans land. */}
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
            <div
              className="h-full rounded-full bg-lime-400 transition-[width] duration-300"
              style={{ width: `${Math.min(95, 100 * (1 - Math.exp(-detectElapsed / 12)))}%` }}
            />
          </div>
          <div className="mt-2 space-y-1 font-mono text-[10px] uppercase tracking-wider">
            {[
              { label: t("detectStepRead"), doneAt: 1 },
              { label: t("detectStepMarket"), doneAt: 3 },
              { label: t("detectStepPlans"), doneAt: Infinity },
            ].map((s) => {
              const done = detectElapsed >= s.doneAt;
              const active = !done && detectElapsed >= (s.doneAt === 1 ? 0 : s.doneAt === 3 ? 1 : 3);
              return (
                <div
                  key={s.label}
                  className={`flex items-center gap-2 ${done ? "text-lime-300/80" : active ? "text-white/80" : "text-white/30"}`}
                >
                  <span className="inline-block w-3 text-center">
                    {done ? "✓" : active ? <span className="animate-pulse">●</span> : "·"}
                  </span>
                  {s.label}
                  {active && s.doneAt === Infinity && (
                    <span className="ml-auto tabular-nums text-white/40">
                      {Math.floor(detectElapsed)}s
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {readout && (
        <p className="px-1 text-[11.5px] leading-relaxed text-white/50">{readout}</p>
      )}
      {/* Detection-transparency row: indicator subset disclosure + override.
          (Price-action-only state needs no badge — the readout's first
          sentence already says it.) */}
      {plans.length > 0 && detectMeta && (
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          {(detectMeta.indicatorsDropped?.length ?? 0) > 0 && (
            <>
              <span
                className="inline-flex h-5 cursor-help items-center rounded-md bg-white/[0.08] px-1.5 font-mono text-[9.5px] font-bold uppercase leading-none tracking-wide text-white/60"
                title={detectMeta
                  .indicatorsDropped!.map((d) => `${d.name}: ${d.reason}`)
                  .join("\n")}
              >
                {t("indUsedChip")
                  .replace("{used}", String(detectMeta.indicatorsUsed?.length ?? 0))
                  .replace("{total}", String(detectMeta.indicatorCount))}
              </span>
              <button
                onClick={() => requireAuth(() => void detect({ allIndicators: true }))}
                // Same reason as the main detect button: re-detecting swaps
                // out the card the deploy is reporting into.
                disabled={detecting || deployBusy}
                {...(deployBusy && !detecting
                  ? { title: t("deployBusyElsewhere") }
                  : {})}
                className="inline-flex h-5 items-center rounded-md border border-white/15 bg-white/[0.05] px-1.5 font-mono text-[9.5px] font-bold uppercase leading-none tracking-wide text-white/70 transition-colors hover:text-white disabled:opacity-40"
              >
                {t("rerunAll").replace("{total}", String(detectMeta.indicatorCount))}
              </button>
            </>
          )}
        </div>
      )}
      {plans.map((p) => (
        <PlanCard
          key={p.id}
          plan={p}
          marked={activePlan?.id === p.id}
          fresh={freshPlanIds.includes(p.id)}
          onToggle={(plan) => void toggleMark(plan)}
          onShowRunning={onShowRunning}
          liveLevels={liveLevels.get(p.id)}
        />
      ))}
      {/* No empty-state prompt on the Detected tab — a blank panel is fine;
          the chart + chat already tell the user what to do. */}
    </div>
  );
}

/* Designed empty state for the two setups tabs — an icon tile + title + hint
 * instead of a bare line of muted text, so a first-time user gets a clear
 * next action rather than a blank panel. */
function SetupsEmpty({ variant }: { variant: "draft" | "running" }) {
  const { t } = useLang();
  const draft = variant === "draft";
  return (
    <div className="flex flex-col items-center gap-2.5 px-4 py-9 text-center">
      {draft ? (
        <div className="grid h-11 w-11 place-items-center rounded-2xl border border-white/10 bg-white/[0.03] text-white/35">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
            aria-hidden
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
          </svg>
        </div>
      ) : (
        // Crystal-glass "empty tray" — nothing running yet. Transparent PNG,
        // floats on the panel (no black tile). Matches the deposit/error set.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/empty/nothing.webp"
          alt=""
          aria-hidden
          draggable={false}
          className="h-16 w-16 select-none object-contain opacity-90"
        />
      )}
      <div className="font-mono text-[12px] font-semibold text-white/70">
        {t(draft ? "draftEmptyTitle" : "runningEmptyTitle")}
      </div>
      <p className="max-w-[230px] text-[11px] leading-relaxed text-white/40">
        {t(draft ? "drawHint" : "runningEmptyBody")}
      </p>
    </div>
  );
}

/* ── Panel shell ───────────────────────────────────────────────────── */

export function DeploymentsPanel() {
  const [tab, setTab] = useState<"detected" | "running">("detected");
  const { t } = useLang();

  // Running-count badge on the tab. RunningTab stays MOUNTED (just hidden
  // when inactive) so its data is fresh the instant the tab is opened AND it
  // reports its live active count up here — one source, no drifting poll.
  const [runningCount, setRunningCount] = useState<number | null>(null);
  const reportCount = useCallback((n: number) => setRunningCount(n), []);
  // Wallets held by current deployments — SizingControls subtracts them
  // from the deployable-funds ceiling. null = not reported yet (unknown).
  const [occupiedWallets, setOccupiedWallets] = useState<Set<string> | null>(null);
  const reportOccupied = useCallback(
    (w: Set<string>) => setOccupiedWallets(w),
    [],
  );
  // Capital committed per wallet — SizingControls nets it off the balance so
  // the ceiling reflects what is genuinely free, not whether a wallet is in use.
  const [committedByWallet, setCommittedByWallet] =
    useState<CommittedByWallet | null>(null);
  const reportCommitted = useCallback(
    (m: CommittedByWallet) => setCommittedByWallet(m),
    [],
  );

  return (
    <aside className="flex h-full min-w-0 flex-1 flex-col border-l border-white/10 bg-black/40 backdrop-blur-md">
      <div className="flex items-center gap-1 border-b border-white/10 px-3 py-2">
        {(
          [
            ["detected", t("tabDetected"), null],
            ["running", t("tabRunning"), runningCount],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-full px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-widest transition-colors ${
              tab === key
                ? "bg-[rgba(163,230,53,0.14)] text-lime-300"
                : "text-white/50 hover:text-white/80"
            }`}
          >
            {label}
            {typeof count === "number" && count > 0 && (
              <span className="ml-1.5 text-lime-300/90">({count})</span>
            )}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {/* Both mounted; the inactive one is hidden (not unmounted) so the
            Running tab is already loaded — and its count already reported —
            before the user ever opens it. */}
        <div className={tab === "detected" ? undefined : "hidden"}>
          <DetectedTab
            committedByWallet={committedByWallet}
            onShowRunning={() => setTab("running")}
          />
        </div>
        <div className={tab === "running" ? undefined : "hidden"}>
          <RunningTab
            onActiveCount={reportCount}
            onOccupiedWallets={reportOccupied}
            onCommittedByWallet={reportCommitted}
          />
        </div>
      </div>
    </aside>
  );
}
