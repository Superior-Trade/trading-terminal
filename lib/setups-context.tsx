"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useChartBridge } from "./chart-bridge";
import { useLang } from "./i18n";
import { authFetch } from "./client-auth";
import { track } from "./track";
import { useAuthGate } from "../components/providers";
import { type PlanSizingSuggestion } from "./plan-sizing";
import { venueOfSymbol } from "./venues";

export type Tier = "S" | "A" | "B" | "C" | "D";

export interface DetectedPlan {
  id: string;
  title: string;
  // "neutral" = range rotation trading both sides; levels carry the LONG leg
  // at the lower bound (short leg mirrored via conditions/thesis).
  direction: "long" | "short" | "neutral";
  // Execution mode. "one_shot" fires once (enter → TP or SL → done, then the
  // deployment auto-stops); "recurring" keeps re-entering whenever the entry
  // condition triggers again. Fixed price levels ⇒ one_shot; indicator
  // conditions ⇒ recurring. Absent ⇒ treated as "recurring" (prior behavior).
  mode?: "one_shot" | "recurring" | null;
  thesis: string;
  // Chart symbol this plan was detected on — marking it switches the chart
  // back to that asset first (a BTC plan opened while on ETH switches to BTC).
  symbol?: string | null;
  entry: number;
  stop: number;
  target: number;
  invalidation: string;
  // Quality tier + one-line justification (shown as a badge + tooltip).
  tier?: Tier | null;
  tierReason?: string | null;
  // Human-readable trigger per level (shown as primary text, price behind).
  entryCondition?: string | null;
  stopCondition?: string | null;
  targetCondition?: string | null;
  // Per-level indicator basis for LIVE-TRACKING the drawn lines.
  // e.g. "bb_lower", "ema:50", "vwap"; absent/"fixed" → static price line.
  entrySource?: string | null;
  stopSource?: string | null;
  targetSource?: string | null;
  // Time-boxed setups: ISO date-time (with timezone) at which the deployed
  // strategy auto-stops (Superior API alive_until) + the one-line reason
  // ("funding window closes", "setup stale after NY close", …).
  aliveUntil?: string | null;
  aliveUntilReason?: string | null;
  /** Risk-based sizing judgment from the model (riskPct + suggested
   *  leverage); lib/plan-sizing.ts derives the concrete stake from it. */
  sizing?: PlanSizingSuggestion | null;
  /** Traditional-Chinese renditions of the human-readable fields — primary
   *  fields are always English; the UI picks per active language. */
  zh?: {
    title?: string;
    thesis?: string;
    invalidation?: string;
    tierReason?: string | null;
    entryCondition?: string | null;
    stopCondition?: string | null;
    targetCondition?: string | null;
    aliveUntilReason?: string | null;
    sizingNote?: string | null;
  } | null;
}

export type PlanPatch = Omit<DetectedPlan, "id">;

/** How the last detection read the chart — drives the transparency UI
 *  ("price action only" badge, indicator-subset chip + re-run override). */
export interface DetectMeta {
  priceAction: boolean;
  indicatorCount: number;
  indicatorsUsed?: string[] | null;
  indicatorsDropped?: Array<{ name: string; reason: string }> | null;
}

interface SetupsContextType {
  plans: DetectedPlan[];
  readout: string | null;
  detectMeta: DetectMeta | null;
  detecting: boolean;
  error: string | null;
  detect: (opts?: { allIndicators?: boolean }) => Promise<void>;
  /** Chat-agent-authored plans: prepended to the Draft Setups list with a
   *  short-lived "fresh" highlight so the user notices the panel update. */
  suggestPlans: (patches: PlanPatch[]) => DetectedPlan[];
  /** Plan ids still inside their attention-animation window. */
  freshPlanIds: string[];
  /** Currently marked/selected plan (drawn on chart), if any. */
  activePlan: DetectedPlan | null;
  toggleMark: (plan: DetectedPlan) => Promise<void>;
  /** Generic exclusive marking (also used by deployment cards). */
  markedKey: string | null;
  /** Display title of the current mark — set for detected AND previous/deployed
   *  setups, so the chart banner can name whatever is currently drawn. */
  markedLabel: string | null;
  /** Clear the current mark (drawings + selection), whatever its source. */
  clearMark: () => Promise<void>;
  toggleMarkLevels: (
    key: string,
    levels: {
      title: string;
      entry: number;
      stop: number;
      target: number;
      symbol?: string | null;
      entrySource?: string | null;
      stopSource?: string | null;
      targetSource?: string | null;
    },
  ) => Promise<void>;
  /** A chat edit publishes a NEW "EDIT n - <name>" card at the top of the
   *  list (the original is left untouched) rather than mutating in place. */
  applyEdit: (patch: PlanPatch) => Promise<void>;
  /** Chat registers its history so detection can read the conversation. */
  registerChatHistoryProvider: (
    provider: (() => Array<{ role: string; text: string }>) | null,
  ) => void;
  /** Position sizing chosen in the panel; consumed by detect, deploy, chat. */
  funds: number;
  setFunds: (f: number) => void;
  leverage: number;
  setLeverage: (l: number) => void;
  /** Deploy orchestration — lives HERE so progress survives tab switches. */
  deployProgress: DeployProgress | null;
  deployPlan: (plan: DetectedPlan) => Promise<void>;
  /** Ask the running deploy to stop. Honored at the next safe point; if
   *  something was already placed, it is undone rather than abandoned. */
  cancelDeploy: () => void;
  /** Delete the offered spare deployment, then deploy this plan again. */
  freeSlotAndRetry: (plan: DetectedPlan) => Promise<void>;
  /** A deploy is in flight anywhere. Controls that would change what is being
   *  deployed, or start a second one, lock on this. */
  deployBusy: boolean;
  /** Skip/hide a draft setup — removes its card and persists the dismissal. */
  dismissPlan: (id: string) => void;
}

export interface DeployProgress {
  planId: string;
  /** 0 compile · 1 create · 2 wallet · 3 start */
  step: number;
  done: boolean;
  error: string | null;
  deploymentId: string | null;
  /** Sub-status shown under the bar (e.g. silent self-repair pass). */
  note: string | null;
  /** Stop requested; the step in flight is still settling. */
  canceling?: boolean;
  /** Stopped, and anything already placed was undone. Terminal, like error. */
  canceled?: string | null;
  /** Blocked by the 10-deployment cap, with the safest row to delete to free a
   *  slot. Absent when nothing safe exists — see freeSlotAndRetry. */
  capCandidate?: { id: string; name: string; why: string } | null;
}

/** Append the API's own reasons to a headline that has none of its own.
 *  Bounded: the first few lines are the actionable part, and a wall of text
 *  on a card reads as a crash rather than an explanation. */
export function withDetails(message: string, details: unknown): string {
  const list = Array.isArray(details)
    ? details.map((d) => String(d).trim()).filter(Boolean)
    : typeof details === "string" && details.trim()
      ? [details.trim()]
      : [];
  if (list.length === 0) return message;
  const shown = list.slice(0, 3).join(" · ");
  const rest = list.length - 3;
  return rest > 0 ? `${message} ${shown} (+${rest} more)` : `${message} ${shown}`;
}

/**
 * What actually failed, rather than a guess at what failed.
 *
 * The safety guard has ~28 rules — lookahead bias, forbidden imports, an
 * unscaled stop, a malformed minimal_roi, a TA-Lib tuple subscript, a missing
 * can_short — and every one of them arrives as "strategy failed safety
 * validation". The card answered all of them with "adjust the plan's stop or
 * leverage", which is the right advice for exactly two of those rules and
 * misleading for the rest: a user told to change their stop cannot fix
 * lookahead bias by changing their stop.
 *
 * The guard's own sentences are written to be read, so the first one is passed
 * through after the internal prefix is stripped. It is only reached after the
 * repair pass has already failed three times, so this is the end of the line —
 * the user needs the reason, not reassurance.
 */
export function safetyRejectMessage(
  rawError: string,
  t: (k: string) => string,
): string {
  const body = rawError.replace(/^[\s\S]*?failed safety validation:?\s*/i, "").trim();
  const reasons = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const first = reasons[0];
  if (!first) return t("deploySafetyReject");
  const more = reasons.length - 1;
  const lead = t("deploySafetyRejectLead");
  return more > 0
    ? `${lead} ${first} ${t("deploySafetyRejectMore").replace("{n}", String(more))}`
    : `${lead} ${first}`;
}

export function deployFailureMessage(
  rawError: string,
  t: (k: string) => string,
): string {
  // Two failure classes carry long, scary internal detail (deployment
  // IDs, wallet addresses, the fallback chain; or the stop/leverage math).
  // Show a short, calm line — the full text is already tracked in analytics
  // and logged server-side / fed to the compile repair loop.
  const walletBusy =
    /already running a live strategy|already linked to deployment|duplicate_wallet|live one-shot order|wallet_occupied/i.test(
      rawError,
    );
  // The server names the trading account and the strategy holding it, and
  // that sentence is the whole answer — pass it through rather than
  // replacing it with a generic line that omits both.
  const walletBusyNamed = /already running a live strategy \(/i.test(rawError);
  const safetyReject = /failed safety validation/i.test(rawError);
  return isFundingFailure(rawError)
    ? // The server-composed funding sentence carries the actual balance and
      // requirement ("Your trading account holds $3.20 — this deployment
      // needs at least $105.00 …") — pass it through verbatim; only cryptic
      // upstream/exchange strings get swapped for the generic prompt.
      isServerFundingGuidance(rawError)
      ? rawError
      : t("deployNeedsFunding")
    : walletBusy
      ? walletBusyNamed
        ? rawError
        : t("deployWalletBusy")
      : safetyReject
        ? safetyRejectMessage(rawError, t)
        : rawError;
}

/** The deposit sentence composed server-side (lib/superior-api's
 *  insufficientBalanceMessage) — already plain language WITH the amounts, so
 *  it must reach the user unedited. */
function isServerFundingGuidance(rawError: string): boolean {
  return /add funds via the deposit button/i.test(rawError);
}

export function isFundingFailure(rawError: string): boolean {
  // Match only what a DEPOSIT actually fixes. Margin rejections are different:
  // the wallet can be funded but the order can still exceed free margin after
  // fees, existing exposure, leverage rounding, or exchange-side requirements.
  // This used to test loose substrings — "does not exist", "does not have", a
  // bare "agent wallet" — which appear in errors that have nothing to do with
  // money ("Failed to export agent wallet key", "Hyperliquid approveAgent
  // failed: invalid agent wallet") and popped the deposit dialog at people
  // whose accounts were fully funded. "User or API Wallet 0x… does not exist"
  // is kept, matched on its own distinctive phrase — that one really does
  // mean an unfunded HL account.
  return (
    isServerFundingGuidance(rawError) ||
    /not (?:have )?enough|doesn't hold enough|below the \$?1[01]\b|minimum order|balance too low|raise the funding|no funds|not[ _]funded|no hyperliquid balance|deposit into it|user or api wallet/i.test(
      rawError,
    )
  );
}

// "EDIT 3 - Mean Reversion" → prefix strip + number capture for edit cards.
const EDIT_PREFIX_RE = /^EDIT\s+\d+\s+-\s+/i;
const EDIT_NUM_RE = /^EDIT\s+(\d+)\s+-\s+/i;

const SetupsContext = createContext<SetupsContextType | null>(null);

export function useSetups(): SetupsContextType {
  const ctx = useContext(SetupsContext);
  if (!ctx) throw new Error("useSetups must be used within SetupsProvider");
  return ctx;
}

export function SetupsProvider({ children }: { children: ReactNode }) {
  const { getChartContext, dispatchChartAction } = useChartBridge();
  const { t } = useLang();
  const [plans, setPlans] = useState<DetectedPlan[]>([]);
  const [readout, setReadout] = useState<string | null>(null);
  const [detectMeta, setDetectMeta] = useState<DetectMeta | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markedKey, setMarkedKey] = useState<string | null>(null);
  // Display title of the current mark. Tracked separately from `plans` so the
  // chart banner can name a marked PREVIOUS/deployed setup (marked via
  // toggleMarkLevels), which never lives in `plans` and so has no activePlan.
  const [markedLabel, setMarkedLabel] = useState<string | null>(null);
  const [freshPlanIds, setFreshPlanIds] = useState<string[]>([]);

  /** Chat-agent-authored plans → prepend to the list, persist alongside the
   *  detected ones, and pulse the new cards for a few seconds so the panel
   *  update is impossible to miss. */
  const suggestPlans = useCallback(
    (patches: PlanPatch[]): DetectedPlan[] => {
      const symbol = getChartContext()?.symbol ?? null;
      const withIds: DetectedPlan[] = patches.map((p, i) => ({
        ...p,
        id: `sg${Date.now()}-${i}`,
        symbol: p.symbol ?? symbol,
      }));
      let merged: DetectedPlan[] = [];
      setPlans((prev) => {
        merged = [...withIds, ...prev];
        return merged;
      });
      const ids = withIds.map((p) => p.id);
      setFreshPlanIds((prev) => [...prev, ...ids]);
      setTimeout(
        () => setFreshPlanIds((prev) => prev.filter((id) => !ids.includes(id))),
        6000,
      );
      // Same persistence home as detected plans (conversation stateJson).
      const convId =
        typeof window !== "undefined"
          ? window.localStorage.getItem("cg-conversation")
          : null;
      if (convId) {
        void authFetch("/api/chat-store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: convId,
            state: { plans: merged, readout, detectMeta },
          }),
        }).catch(() => {});
      }
      return withIds;
    },
    [getChartContext, readout, detectMeta],
  );

  // Sizing (funds $ + leverage ×) persists in its own cookie; consumers
  // clamp against the live pair's maxLeverage so stale values stay safe.
  const [funds, setFundsState] = useState(100);
  const [leverage, setLeverageState] = useState(3);
  useEffect(() => {
    try {
      const raw = document.cookie
        .split("; ")
        .find((c) => c.startsWith("cg-sizing="))
        ?.slice("cg-sizing=".length);
      if (!raw) return;
      const j = JSON.parse(decodeURIComponent(raw)) as {
        funds?: number;
        leverage?: number;
      };
      if (Number.isFinite(j.funds) && j.funds! >= 11) setFundsState(j.funds!);
      if (Number.isFinite(j.leverage) && j.leverage! >= 1)
        setLeverageState(j.leverage!);
    } catch {
      /* fresh visitor */
    }
  }, []);
  const persistSizing = (f: number, l: number) => {
    try {
      document.cookie = `cg-sizing=${encodeURIComponent(
        JSON.stringify({ funds: f, leverage: l }),
      )}; path=/; max-age=31536000; SameSite=Lax`;
    } catch {
      /* ignore */
    }
  };
  const setFunds = useCallback(
    (f: number) => {
      setFundsState(f);
      persistSizing(f, leverage);
    },
    [leverage],
  );
  const setLeverage = useCallback(
    (l: number) => {
      setLeverageState(l);
      persistSizing(funds, l);
    },
    [funds],
  );
  const historyProviderRef = useRef<
    (() => Array<{ role: string; text: string }>) | null
  >(null);

  const registerChatHistoryProvider = useCallback(
    (provider: (() => Array<{ role: string; text: string }>) | null) => {
      historyProviderRef.current = provider;
    },
    [],
  );

  const activePlan = plans.find((p) => p.id === markedKey) ?? null;

  // Switching the chart to a DIFFERENT market drops the sidebar selection —
  // a plan's entry/stop/target lines are only meaningful on their own asset,
  // so leaving the card highlighted (and its levels stranded) after a pair
  // switch is misleading. Marking a plan on another symbol switches the
  // chart TO that plan's symbol, so the guard (new pair ≠ active plan's
  // symbol) keeps that intentional switch selected. Ref-read to dodge the
  // stale closure between setMarkedKey and the symbol-change event.
  const activePlanRef = useRef(activePlan);
  activePlanRef.current = activePlan;
  useEffect(() => {
    const onPairChanged = (e: Event) => {
      const next = (e as CustomEvent<{ pair?: string }>).detail?.pair ?? null;
      const ap = activePlanRef.current;
      if (!ap) return;
      const planCoin = (ap.symbol ?? "").split(/[-/]/)[0].toUpperCase();
      const nextCoin = (next ?? "").split(/[-/]/)[0].toUpperCase();
      if (planCoin && nextCoin && planCoin !== nextCoin) {
        void dispatchChartAction({ action: "clear_agent_drawings" });
        setMarkedKey(null);
        setMarkedLabel(null);
      }
    };
    window.addEventListener("cg:pair-changed", onPairChanged);
    return () => window.removeEventListener("cg:pair-changed", onPairChanged);
  }, [dispatchChartAction]);

  // Restore detected plans from conversation state on load (auth-gated,
  // retried — same early-401 hazard as the chat history load).
  const { authed } = useAuthGate();
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!authed || restoredRef.current) return;
    const convId = window.localStorage.getItem("cg-conversation");
    if (!convId) {
      restoredRef.current = true;
      return;
    }
    let cancelled = false;
    const load = async (attempt: number) => {
      try {
        const res = await authFetch(`/api/chat-store?c=${convId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (cancelled) return;
        restoredRef.current = true;
        const s = j.state as {
          plans?: DetectedPlan[];
          readout?: string | null;
          detectMeta?: DetectMeta | null;
        } | null;
        if (s?.plans?.length) {
          setPlans((prev) => (prev.length ? prev : s.plans!));
          setReadout((prev) => prev ?? s.readout ?? null);
          setDetectMeta((prev) => prev ?? s.detectMeta ?? null);
        }
      } catch {
        if (!cancelled && attempt < 4) {
          setTimeout(() => void load(attempt + 1), 800 * (attempt + 1));
        }
      }
    };
    void load(0);
    return () => {
      cancelled = true;
    };
  }, [authed]);

  // ── Deploy orchestration ────────────────────────────────────────────
  // Lives in context (not PlanCard) so progress survives tab switches and
  // remounts. Emits cg:agent-note so the chat — and therefore the agent's
  // persisted history — knows what was deployed.
  const [deployProgress, setDeployProgress] = useState<DeployProgress | null>(
    null,
  );
  // Stop requested. A ref, not state: the deploy closure reads it between
  // steps and must see the CURRENT value, not the one captured when the run
  // started. A plain flag is enough because only one deploy runs at a time,
  // and each run clears it before its first checkpoint.
  const cancelRef = useRef(false);

  const deployBusy = Boolean(
    deployProgress &&
      !deployProgress.done &&
      !deployProgress.error &&
      !deployProgress.canceled,
  );

  const cancelDeploy = useCallback(() => {
    cancelRef.current = true;
    setDeployProgress((p) =>
      p && !p.done && !p.error && !p.canceled
        ? { ...p, canceling: true, note: t("deployStoppingNote") }
        : p,
    );
  }, [t]);

  /**
   * The safest deployment to delete to free a cap slot, or null if there is
   * none. Only ever a deployment that is NOT trading:
   *   pending — created but never started, so nothing was ever placed
   *   stopped — already torn down, positions closed when it stopped
   * A running deployment is never offered. Deleting one closes its positions,
   * and no wording on a button makes that a reasonable thing to suggest as a
   * way to get on with deploying something else.
   */
  const spareDeployment = useCallback(async (): Promise<
    { id: string; name: string; why: string } | null
  > => {
    const j = await authFetch("/api/deployments")
      .then((r) => r.json())
      .catch(() => ({ items: [] }));
    const items = (j.items ?? []) as Array<{
      id: string;
      name?: string | null;
      status?: string;
      created_at?: string;
    }>;
    const rank = (s?: string) => (s === "pending" ? 0 : s === "stopped" ? 1 : 99);
    const spare = items
      .filter((i) => rank(i.status) < 99)
      .sort(
        (a, b) =>
          rank(a.status) - rank(b.status) ||
          String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
      )[0];
    if (!spare) return null;
    return {
      id: spare.id,
      name: spare.name ?? `#${spare.id.slice(-6)}`,
      why: spare.status === "pending" ? t("capWhyNeverStarted") : t("capWhyStopped"),
    };
  }, [t]);

  const runDeployPlan = useCallback(
    async (plan: DetectedPlan) => {
      // ── Venue gate ────────────────────────────────────────────────────
      // Lighter symbols must NEVER enter the Freqtrade compile/deploy path
      // (wrong runtime, wrong venue). No runnable Lighter Nautilus strategy
      // template exists in this build — only placeholder stubs — so rather
      // than fabricate one, surface the rollout state honestly. The plan card
      // blocks this upstream; this is the backstop for any other caller.
      if (venueOfSymbol(plan.symbol ?? "") === "lighter") {
        track("deploy_blocked_venue", { venue: "lighter", planId: plan.id });
        setDeployProgress({
          planId: plan.id,
          step: 0,
          done: false,
          error: t("lighterDeployRollout"),
          deploymentId: null,
          note: null,
        });
        return;
      }
      const notifyChat = (text: string, tool: string) => {
        try {
          window.dispatchEvent(
            new CustomEvent("cg:agent-note", { detail: { text, tool } }),
          );
        } catch {
          /* non-fatal */
        }
      };
      const fail = (rawError: string, stage: string) => {
        // Track the FULL failure text + stage BEFORE any softening, so
        // analytics keeps the real cause even though the user sees calm copy.
        track("deploy_failed", {
          stage,
          error: String(rawError).slice(0, 300),
          planId: plan.id,
        });
        // Not-enough-money / not-yet-tradeable failures all resolve to the
        // same action: deposit. This covers empty-wallet + HL order-minimum
        // errors AND the raw exchange "User or API Wallet 0x… does not exist"
        // that a brand-new, unfunded/un-onboarded account returns (no HL
        // account + no approved agent wallet until it's funded). For those we
        // swap the cryptic exchange string for a plain deposit prompt and open
        // the deposit dialog — the fix is funding, not retrying.
        const error = deployFailureMessage(rawError, t);
        setDeployProgress((p) =>
          p && p.planId === plan.id ? { ...p, error } : p,
        );
        notifyChat(
          t("deployFailedNote").replace("{title}", plan.title).replace("{error}", error),
          "Deploy · Superior infra",
        );
        if (isFundingFailure(rawError)) {
          try {
            window.dispatchEvent(new Event("cg:open-deposit"));
          } catch {
            /* non-fatal */
          }
        }
      };
      // ── Stop support ──────────────────────────────────────────────────
      // A stop is a REQUEST, never an abort of the call in flight. /api/deploy
      // and /api/bracket each do their whole job server-side in one request —
      // dropping the connection would not stop the exchange order or the pod,
      // it would only stop us learning what happened. So the request settles,
      // and then anything it created is undone.
      const stopRequested = () => cancelRef.current;
      // Nothing was created yet: end quietly, no undo needed.
      const stopClean = () => {
        cancelRef.current = false;
        setDeployProgress((p) =>
          p && p.planId === plan.id
            ? { ...p, canceling: false, canceled: t("deployStopped"), note: null }
            : p,
        );
        track("deploy_stopped", { planId: plan.id, undo: "none" });
      };
      // Something IS live. Undo it, and only claim stopped if the undo worked.
      const stopAfterUndo = async (
        undo: () => Promise<boolean>,
        okMsg: string,
        failMsg: string,
        kind: string,
      ) => {
        cancelRef.current = false;
        const undone = await undo().catch(() => false);
        setDeployProgress((p) =>
          p && p.planId === plan.id
            ? undone
              ? { ...p, canceling: false, canceled: okMsg, note: null }
              : // Undo failed → this is a FAILURE, not a stop. Saying
                // "stopped" over a live order is the one outcome worth
                // avoiding at any cost.
                { ...p, canceling: false, canceled: null, error: failMsg, note: null }
            : p,
        );
        track("deploy_stopped", { planId: plan.id, undo: kind, undone });
      };

      cancelRef.current = false;
      setDeployProgress({
        planId: plan.id,
        step: 0,
        done: false,
        error: null,
        deploymentId: null,
        note: null,
      });
      // Exchange-standard sizing: the panel sliders ARE the order. Stake =
      // the funds the user set (isolated margin), leverage = the leverage they
      // set — deployed verbatim, matching what the card shows next to Confirm
      // Deploy. No stop-driven resizing; what you dial is what deploys.
      const effFunds = funds;
      const effLeverage = Math.max(1, Math.round(leverage));
      // ── Native BRACKET path ──────────────────────────────────────────
      // A one-shot directional plan with purely FIXED levels is exactly a
      // bracket order: one atomic entry+TP/SL on a free trading account —
      // no Freqtrade pod, no compile, fills/exits live on the exchange.
      // Indicator/trendline-sourced or neutral plans still need a bot.
      const allFixed = [plan.entrySource, plan.stopSource, plan.targetSource].every(
        (s) => !s || s === "fixed",
      );
      const coin = (plan.symbol ?? "").split("/")[0];
      if (
        plan.mode === "one_shot" &&
        (plan.direction === "long" || plan.direction === "short") &&
        allFixed &&
        coin &&
        !coin.includes(":")
      ) {
        try {
          // Last point before the order reaches the exchange.
          if (stopRequested()) return stopClean();
          setDeployProgress((p) => (p ? { ...p, step: 2, note: t("bracketPlacing") } : p));
          const res = await authFetch("/api/bracket", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pair: coin,
              // Carry the setup's own name so the card reads like the plan it
              // came from, matching how a recurring deployment is named.
              name: plan.title.slice(0, 120),
              side: plan.direction,
              entry: plan.entry,
              take_profit: plan.target,
              stop_loss: plan.stop,
              size_usd: effFunds * Math.max(1, effLeverage),
              leverage: Math.max(1, Math.round(effLeverage)),
              // The server asks before moving money between the user's own
              // trading accounts. Confirm Deploy IS that answer — it is the
              // same person, the same click, and the amount is bounded to this
              // order's margin. Without this the 409 rendered as a question
              // the terminal had no way to answer, so a deploy that only
              // needed a top-up simply failed.
              confirm_fund_transfer: true,
              ...(plan.aliveUntil ? { alive_until: plan.aliveUntil } : {}),
            }),
          });
          const bj = (await res.json().catch(() => ({}))) as {
            id?: string;
            account_label?: string | null;
            message?: string;
            error?: string;
          };
          if (res.status !== 201 || !bj.id) {
            fail(String(bj.message ?? bj.error ?? `bracket HTTP ${res.status}`), "bracket");
            return;
          }
          // The order is on the exchange now. A stop that arrived while it was
          // in flight has to cancel it — the request could not be un-sent.
          if (stopRequested()) {
            const id = bj.id;
            await stopAfterUndo(
              async () => {
                const del = await authFetch(
                  `/api/bracket?id=${encodeURIComponent(id)}`,
                  { method: "DELETE" },
                );
                return del.ok;
              },
              t("deployStoppedUndone"),
              t("deployStopFailedBracket"),
              "bracket",
            );
            window.dispatchEvent(new Event("cg:refresh-balances"));
            return;
          }
          setDeployProgress((p) =>
            p ? { ...p, step: 3, done: true, deploymentId: bj.id ?? null } : p,
          );
          // Persist the plan against the BRACKET id, exactly as the recurring
          // path does against the deployment id. Without this a live one-shot
          // card can only show prices — the thesis, the per-level conditions
          // and the invalidation that the user actually approved are lost the
          // moment it is placed.
          try {
            const bctx = getChartContext();
            await authFetch("/api/plan-store", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                deploymentId: bj.id,
                mode: "one_shot",
                plan: {
                  title: plan.title,
                  direction: plan.direction,
                  mode: "one_shot",
                  thesis: plan.thesis,
                  entry: plan.entry,
                  stop: plan.stop,
                  target: plan.target,
                  entryCondition: plan.entryCondition ?? null,
                  stopCondition: plan.stopCondition ?? null,
                  targetCondition: plan.targetCondition ?? null,
                  entrySource: plan.entrySource ?? null,
                  stopSource: plan.stopSource ?? null,
                  targetSource: plan.targetSource ?? null,
                  symbol: plan.symbol ?? bctx?.symbol ?? null,
                  invalidation: plan.invalidation,
                  aliveUntil: plan.aliveUntil ?? null,
                  aliveUntilReason: plan.aliveUntilReason ?? null,
                  tier: plan.tier ?? null,
                  tierReason: plan.tierReason ?? null,
                  sizing: plan.sizing ?? null,
                  zh: plan.zh ?? null,
                },
                symbol: bctx?.symbol,
                timeframe: bctx?.timeframe,
              }),
            });
          } catch {
            /* the order is placed; losing the detail must not fail the deploy */
          }
          window.dispatchEvent(new Event("cg:refresh-balances"));
          notifyChat(
            t("bracketPlacedNote")
              .replace("{title}", plan.title)
              .replace("{account}", bj.account_label ?? ""),
            "Deploy · Superior infra",
          );
        } catch (err) {
          fail(err instanceof Error ? err.message : "bracket error", "bracket");
        }
        return;
      }
      try {
        // Compile → create loop with SILENT self-repair: validator
        // rejections feed back into /api/compile (repair mode) instead of
        // surfacing as failures. Up to 2 repair passes.
        let strategy: { config: unknown; code: string } | null = null;
        let j: Record<string, unknown> & { id?: string } = {};
        let lastErrors: string | null = null;
        let created = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          // Compiling touches nothing outside this browser, so a stop here —
          // including between repair passes — costs nothing.
          if (stopRequested()) return stopClean();
          setDeployProgress((p) =>
            p
              ? {
                  ...p,
                  step: 0,
                  note: attempt > 0 ? "refining strategy code…" : null,
                }
              : p,
          );
          const compiled: {
            strategy?: { config: unknown; code: string };
            error?: string;
            validationErrors?: string[];
            rejected?: { configJson: string; code: string };
          } = await authFetch("/api/compile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              plan,
              chartContext: getChartContext(),
              funds: effFunds,
              leverage: effLeverage,
              ...(attempt > 0 && strategy && lastErrors
                ? {
                    repair: {
                      code: strategy.code,
                      configJson: JSON.stringify(strategy.config),
                      errors: lastErrors,
                    },
                  }
                : {}),
            }),
          }).then((r) => r.json());
          if (!compiled.strategy) {
            // Safety-guard rejection (422): route the rejected artifact +
            // errors back through the repair pass instead of failing.
            if (compiled.rejected && compiled.validationErrors?.length && attempt < 2) {
              strategy = {
                config: JSON.parse(compiled.rejected.configJson),
                code: compiled.rejected.code,
              };
              lastErrors = compiled.validationErrors.join("\n");
              continue;
            }
            fail(compiled.error ?? t("deployErrCompile"), "compile");
            return;
          }
          strategy = compiled.strategy ?? null;

          // This single call also FUNDS the trading account on-chain (allocate-
          // on-deploy): a sponsored USDC move into the venue that takes ~15-30s.
          // Surface a note so the wait reads as progress, not a frozen step.
          // Last free exit: past this call money has moved on-chain and a pod
          // may be running.
          if (stopRequested()) return stopClean();
          setDeployProgress((p) =>
            p ? { ...p, step: 1, note: t("deployFundingNote") } : p,
          );
          const dep = await authFetch("/api/deploy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: plan.title.slice(0, 40),
              config: strategy!.config,
              code: strategy!.code,
              // Time-boxed plan → the API auto-stops (closes positions,
              // tears down the bot) at this instant. Stored at create; the
              // start route inherits it.
              ...(plan.aliveUntil && !Number.isNaN(Date.parse(plan.aliveUntil))
                ? { alive_until: plan.aliveUntil }
                : {}),
            }),
          });
          j = await dep.json();
          if (dep.ok && j.id) {
            created = true;
            break;
          }
          // Validator rejection → repair pass; anything else is terminal.
          const detail = JSON.stringify(j.details ?? j.message ?? j.error ?? "");
          const isValidation =
            dep.status === 400 && /validation|invalid/i.test(detail + String(j.error ?? ""));
          // At the 10-deployment cap. Offer to free a slot — but only ever
          // with a deployment that is not trading. "Oldest" is the wrong rule:
          // on every capped account in production the oldest row is running,
          // so deleting it would close a live position to make room.
          if (String(j.error ?? "") === "limit_exceeded") {
            const cand = await spareDeployment();
            setDeployProgress((p) =>
              p && p.planId === plan.id
                ? {
                    ...p,
                    error: cand
                      ? t("capBlockedOffer").replace("{name}", cand.name).replace("{why}", cand.why)
                      : t("capBlockedNoSpare"),
                    capCandidate: cand,
                    note: null,
                  }
                : p,
            );
            track("deploy_failed", { stage: "create", error: "limit_exceeded", planId: plan.id });
            return;
          }
          if (!isValidation || attempt === 2) {
            // The API's `message` for a validation failure is the headline
            // "Config or code validation failed" and nothing else; the reasons
            // are in `details`, which only the repair loop above was reading.
            // So after three failed repairs the user was handed the headline
            // alone — a refusal with no stated cause, for a failure that had
            // already exhausted every automatic remedy.
            fail(
              withDetails(String(j.message ?? j.error ?? t("deployErrCreate")), j.details),
              "create",
            );
            return;
          }
          lastErrors = detail;
        }
        if (!created || !j.id) {
          fail(t("deployErrCreate"), "create");
          return;
        }
        // The deployment exists — /api/deploy funds the account, attaches the
        // wallet and starts the pod in this one call, so by now it may already
        // be trading. Delete rather than stop: delete also sweeps the funded
        // balance back to the main wallet, leaving the profile as it was.
        // Checked before the step verdicts below, because a stop should undo
        // the deployment whether or not every step succeeded.
        if (stopRequested()) {
          const id = j.id;
          await stopAfterUndo(
            async () => {
              const del = await authFetch("/api/deployments/control", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, action: "delete" }),
              });
              return del.ok;
            },
            t("deployStoppedRemoved"),
            t("deployStopFailedDeployment"),
            "deployment",
          );
          window.dispatchEvent(new Event("cg:refresh-balances"));
          return;
        }
        const stepErrors = (j.stepErrors ?? {}) as Record<string, string>;
        const steps = (j.steps ?? {}) as Record<string, number>;
        if (steps.credentials !== 200) {
          fail(stepErrors.credentials ?? t("deployErrWallet"), "assign-wallet");
          return;
        }
        // Walk completed sub-steps with a beat so progress reads as motion.
        await new Promise((r) => setTimeout(r, 350));
        setDeployProgress((p) => (p ? { ...p, step: 2 } : p));
        if (steps.start !== 200) {
          fail(stepErrors.start ?? t("deployErrPodStart"), "start");
          return;
        }
        await new Promise((r) => setTimeout(r, 350));
        setDeployProgress((p) =>
          p ? { ...p, step: 3, done: true, deploymentId: j.id ?? null } : p,
        );
        // Deploy may have auto-funded a trading account from main — refresh
        // balances + the sizing ceiling right away.
        window.dispatchEvent(new Event("cg:refresh-balances"));

        // Persist the plan for the Running tab visualization.
        const ctx = getChartContext();
        await authFetch("/api/plan-store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deploymentId: j.id,
            mode: plan.mode ?? "recurring",
            plan: {
              title: plan.title,
              direction: plan.direction,
              mode: plan.mode ?? "recurring",
              thesis: plan.thesis,
              entry: plan.entry,
              stop: plan.stop,
              target: plan.target,
              entryCondition: plan.entryCondition ?? null,
              stopCondition: plan.stopCondition ?? null,
              targetCondition: plan.targetCondition ?? null,
              // Machine-evaluable indicator basis per level — the same strings
              // that let a SELECTED setup live-track its lines (computeLevel).
              // Persisting them here is what lets a RUNNING deployment recompute
              // its intended entry/stop/target the same way; without them the
              // deployment collapses to the static deploy-time snapshot.
              entrySource: plan.entrySource ?? null,
              stopSource: plan.stopSource ?? null,
              targetSource: plan.targetSource ?? null,
              // The market the plan was authored on — needed to draw its levels
              // on the right chart later (the deployment may not be the pair
              // currently on screen).
              symbol: plan.symbol ?? ctx?.symbol ?? null,
              invalidation: plan.invalidation,
              aliveUntil: plan.aliveUntil ?? null,
              aliveUntilReason: plan.aliveUntilReason ?? null,
              sizing: plan.sizing ?? null,
              zh: plan.zh ?? null,
            },
            symbol: ctx?.symbol,
            timeframe: ctx?.timeframe,
            createdAt: Date.now(),
          }),
        }).catch(() => {});
        // Hand the Running panel an optimistic record + a reload nudge so the
        // fresh card renders WITH its plan instead of flashing "foreign" until
        // the next 30s poll. Awaiting the POST above guarantees the panel's
        // plan-store refetch also sees the deployment↔plan link (it used to be
        // fire-and-forget, which raced the Running-tab remount and lost).
        window.dispatchEvent(
          new CustomEvent("cg:deployed", {
            detail: {
              deploymentId: j.id,
              mode: plan.mode ?? "recurring",
              plan,
              symbol: plan.symbol ?? ctx?.symbol ?? undefined,
              timeframe: ctx?.timeframe,
              createdAt: Date.now(),
            },
          }),
        );
        notifyChat(
          t("deployedNote")
            .replace("{title}", plan.title)
            .replace("{funds}", String(effFunds))
            .replace("{lev}", String(effLeverage))
            .replace("{dir}", t(plan.direction))
            .replace("{entry}", String(plan.entry))
            .replace("{stop}", String(plan.stop))
            .replace("{target}", String(plan.target)),
          "Deploy · Superior infra",
        );
      } catch (err) {
        fail(err instanceof Error ? err.message : t("deployErrGeneric"), "unknown");
      }
    },
    [funds, leverage, getChartContext],
  );

  // One deploy at a time, enforced here rather than only by disabled buttons.
  // A disabled attribute lands on the next render, so a fast double-click on
  // Confirm can fire twice — and each fire places its own order and moves its
  // own money. The UI locks are the visible half of this rule; the ref is the
  // half that holds when a caller bypasses them.
  const deployInFlight = useRef(false);
  // freeSlotAndRetry re-deploys after clearing the slot, but deployPlan is
  // defined below it (it wraps runDeployPlan). A ref keeps the retry pointed
  // at the guarded entry point rather than duplicating the guard.
  const deployPlanRef = useRef<((plan: DetectedPlan) => Promise<void>) | null>(null);

  const freeSlotAndRetry = useCallback(
    async (plan: DetectedPlan) => {
      const cand = deployProgress?.capCandidate;
      if (!cand) return;
      const res = await authFetch("/api/deployments/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cand.id, action: "delete" }),
      }).catch(() => null);
      if (!res?.ok) {
        setDeployProgress((p) =>
          p && p.planId === plan.id
            ? { ...p, error: t("capFreeFailed"), capCandidate: null }
            : p,
        );
        return;
      }
      window.dispatchEvent(new Event("cg:refresh-balances"));
      await deployPlanRef.current?.(plan);
    },
    [deployProgress?.capCandidate, t],
  );

  const deployPlan = useCallback(
    async (plan: DetectedPlan) => {
      if (deployInFlight.current) return;
      deployInFlight.current = true;
      try {
        await runDeployPlan(plan);
      } finally {
        deployInFlight.current = false;
      }
    },
    [runDeployPlan],
  );
  deployPlanRef.current = deployPlan;

  const drawPlanMarks = useCallback(
    async (plan: {
      title: string;
      entry: number;
      stop: number;
      target: number;
      symbol?: string | null;
      entrySource?: string | null;
      stopSource?: string | null;
      targetSource?: string | null;
    }) => {
      // Switch the chart to the plan's asset first — a setup detected on
      // another market must be viewed there for the levels to mean anything.
      if (plan.symbol) {
        const cur = getChartContext()?.symbol ?? null;
        if (cur !== plan.symbol) {
          try {
            await dispatchChartAction({ action: "set_symbol", pair: plan.symbol });
          } catch {
            /* unresolved symbol: draw on the current chart anyway */
          }
        }
      }
      await dispatchChartAction({ action: "clear_agent_drawings" });
      // One replaceable group; indicator-based levels live-track their source.
      await dispatchChartAction({
        action: "draw_tracked_setup",
        levels: [
          { role: "entry", price: plan.entry, label: `${t("entry")} · ${plan.title}`, source: plan.entrySource },
          { role: "stop", price: plan.stop, label: t("stop"), source: plan.stopSource },
          { role: "target", price: plan.target, label: t("target"), source: plan.targetSource },
        ],
      });
    },
    [dispatchChartAction, getChartContext, t],
  );

  const toggleMarkLevels = useCallback(
    async (
      key: string,
      levels: {
        title: string;
        entry: number;
        stop: number;
        target: number;
        symbol?: string | null;
        entrySource?: string | null;
        stopSource?: string | null;
        targetSource?: string | null;
      },
    ) => {
      if (markedKey === key) {
        await dispatchChartAction({ action: "clear_agent_drawings" });
        setMarkedKey(null);
        setMarkedLabel(null);
        return;
      }
      await drawPlanMarks(levels);
      setMarkedKey(key);
      setMarkedLabel(levels.title);
    },
    [markedKey, dispatchChartAction, drawPlanMarks],
  );

  // Clear whatever is marked, regardless of whether it came from a detected
  // plan or a deployment/previous-setup card (toggleMarkLevels).
  const clearMark = useCallback(async () => {
    if (markedKey) await dispatchChartAction({ action: "clear_agent_drawings" });
    setMarkedKey(null);
    setMarkedLabel(null);
  }, [markedKey, dispatchChartAction]);

  // Detect runs THROUGH THE CHAT AGENT (one brain, one context): this
  // dispatches cg:detect-request, floating-chat submits a synthetic user
  // turn (with screenshot + chartDelta like any send), the agent calls
  // market_pulse and publishes plans via suggest_plan — which land here
  // through suggestPlans. cg:detect-done releases the detecting state.
  const detectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detect = useCallback(
    async (opts?: { allIndicators?: boolean }) => {
      if (detecting) return;
      setDetecting(true);
      setError(null);
      // A fresh detection replaces the previous set + selection + edits.
      if (markedKey) await dispatchChartAction({ action: "clear_agent_drawings" });
      setMarkedKey(null);
      setMarkedLabel(null);
      setPlans([]);
      setReadout(null);
      const ctx = getChartContext();
      setDetectMeta({
        // Price-action-only = the user has nothing of their own on the chart.
        priceAction: !ctx?.drawings?.some((d) => d.origin === "user"),
        indicatorCount: ctx?.indicators?.length ?? 0,
        indicatorsUsed: null,
        indicatorsDropped: null,
      });
      window.dispatchEvent(
        new CustomEvent("cg:detect-request", {
          detail: { allIndicators: opts?.allIndicators ?? false },
        }),
      );
      // Safety net: a lost done-event must not latch `detecting` forever
      // (the UI froze on a 9-minute hang once, pre-fold).
      if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
      detectTimeoutRef.current = setTimeout(() => setDetecting(false), 180_000);
    },
    [detecting, getChartContext, markedKey, dispatchChartAction],
  );
  useEffect(() => {
    const onDone = (e: Event) => {
      const err = (e as CustomEvent<{ error?: string }>).detail?.error;
      if (err) setError(err);
      if (detectTimeoutRef.current) {
        clearTimeout(detectTimeoutRef.current);
        detectTimeoutRef.current = null;
      }
      setDetecting(false);
    };
    window.addEventListener("cg:detect-done", onDone);
    return () => window.removeEventListener("cg:detect-done", onDone);
  }, []);

  const toggleMark = useCallback(
    async (plan: DetectedPlan) => toggleMarkLevels(plan.id, plan),
    [toggleMarkLevels],
  );

  // A chat edit no longer mutates the marked plan in place. Instead it
  // publishes a fresh "EDIT n - <base name>" card at the TOP of the list,
  // leaving the original untouched — so the edit history reads as a stack of
  // named variants rather than an in-place overwrite with a revert banner.
  const applyEdit = useCallback(
    async (patch: PlanPatch) => {
      const current = plans.find((p) => p.id === markedKey);
      // Strip any prior "EDIT n - " so a re-edit re-numbers off the base name
      // instead of nesting ("EDIT 2 - Mean Reversion", not "EDIT 1 - EDIT 1 …").
      const base = (current?.title ?? patch.title ?? "Strategy").replace(
        EDIT_PREFIX_RE,
        "",
      );
      // Next number = highest existing "EDIT n - <base>" for this base + 1.
      let maxN = 0;
      for (const p of plans) {
        if (p.title.replace(EDIT_PREFIX_RE, "") !== base) continue;
        const n = Number(p.title.match(EDIT_NUM_RE)?.[1] ?? 0);
        if (n > maxN) maxN = n;
      }
      const edited: DetectedPlan = {
        ...patch,
        id: `ed${Date.now()}`,
        title: `EDIT ${maxN + 1} - ${base}`,
      };
      let merged: DetectedPlan[] = [];
      setPlans((prev) => {
        merged = [edited, ...prev];
        return merged;
      });
      // Pulse the new card like a suggested plan, and select it so its levels
      // draw immediately.
      setFreshPlanIds((prev) => [...prev, edited.id]);
      setTimeout(
        () => setFreshPlanIds((prev) => prev.filter((id) => id !== edited.id)),
        6000,
      );
      setMarkedKey(edited.id);
      await drawPlanMarks(edited);
      // Persist alongside the rest (same home as suggested/detected plans).
      const convId =
        typeof window !== "undefined"
          ? window.localStorage.getItem("cg-conversation")
          : null;
      if (convId) {
        void authFetch("/api/chat-store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: convId,
            state: { plans: merged, readout, detectMeta },
          }),
        }).catch(() => {});
      }
    },
    [plans, markedKey, drawPlanMarks, readout, detectMeta],
  );

  // Skip a draft setup: drop its card, persist the trimmed list so it doesn't
  // reappear on reload, and clear its chart marks if it was the active one.
  const dismissPlan = useCallback(
    (id: string) => {
      setPlans((prev) => {
        const next = prev.filter((p) => p.id !== id);
        const convId =
          typeof window !== "undefined"
            ? window.localStorage.getItem("cg-conversation")
            : null;
        if (convId) {
          void authFetch("/api/chat-store", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId: convId,
              state: { plans: next, readout, detectMeta },
            }),
          }).catch(() => {});
        }
        return next;
      });
      if (markedKey === id) {
        void dispatchChartAction({ action: "clear_agent_drawings" });
        setMarkedKey(null);
        setMarkedLabel(null);
      }
    },
    [readout, detectMeta, markedKey, dispatchChartAction],
  );

  return (
    <SetupsContext.Provider
      value={{
        plans,
        readout,
        detectMeta,
        detecting,
        error,
        detect,
        suggestPlans,
        freshPlanIds,
        activePlan,
        toggleMark,
        markedKey,
        markedLabel,
        clearMark,
        toggleMarkLevels,
        applyEdit,
        registerChatHistoryProvider,
        funds,
        setFunds,
        leverage,
        setLeverage,
        deployProgress,
        deployPlan,
        cancelDeploy,
        freeSlotAndRetry,
        deployBusy,
        dismissPlan,
      }}
    >
      {children}
    </SetupsContext.Provider>
  );
}
