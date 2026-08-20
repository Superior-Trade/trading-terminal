"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ConversationList,
  fetchConversations,
  type ConversationRow,
} from "./conversation-list";
import {
  deriveConversationTitle,
  fallbackConversationTitle,
} from "../../lib/conversation-title";
import { AnimatePresence, motion } from "framer-motion";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Streamdown } from "streamdown";
import { useChartBridge, type ChartAction } from "../../lib/chart-bridge";
import { useLang } from "../../lib/i18n";
import { track } from "../../lib/track";
import { useSetups, type Tier, type DetectedPlan } from "../../lib/setups-context";
import { useAuthGate } from "../providers";
import { authFetch } from "../../lib/client-auth";
import { useHyperliquid, coinToPair, pairToCoin } from "../../lib/hyperliquid-provider";
import { snapshotChart, diffChart, type ChartSnapshot } from "../../lib/chart-delta";

const EASE = [0.65, 0, 0.35, 1] as const;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tool?: string;
  strategy?: { name?: string; config: unknown; code: string } | null;
  followUps?: string[];
}

// Context window of the agent model (Claude Sonnet 4.5 = 200k). Env-overridable
// so a 1M-context deployment can report against the right denominator.
const CONTEXT_WINDOW_TOKENS = Number(
  process.env.NEXT_PUBLIC_CONTEXT_WINDOW_TOKENS ?? 200_000,
);

const WELCOME: ChatMessage[] = [
  {
    id: "w1",
    role: "assistant",
    text: "I can see your chart — indicators, timeframe, and anything you draw. Ask me to read a setup, mark levels, or turn your drawings into a strategy you can deploy.",
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoosePart = Record<string, any>;

// Tools executed in the BROWSER (execClientTool switch) — a turn that ends on
// one of these needs the client to run it and send the result back. SERVER
// tools (compile_strategy, backtest_run, market_pulse, …) resolve in-stream and
// must NOT trigger an auto-resubmit, or a compile-repair loop that ends on a
// compile_strategy part resends forever and the spinner never clears.
const CLIENT_TOOL_NAMES = new Set([
  "draw_level",
  "draw_zone",
  "draw_trendline",
  "draw_fib",
  "draw_vertical",
  "draw_channel",
  "draw_fib_extension",
  "draw_text",
  "add_indicators",
  "remove_indicators",
  "clear_indicators",
  "clear_agent_drawings",
  "clear_all_drawings",
  "set_timeframe",
  "set_range",
  "set_symbol",
  "update_plan",
  "suggest_plan",
  "mark_setup",
]);

/** Auto-resubmit ONLY when the assistant's last step ends on client tool
 *  call(s) that have resolved — never for server tools (which finish in-stream).
 *  Replaces `lastAssistantMessageIsCompleteWithToolCalls`, which didn't make
 *  that distinction and looped on server-executed compile_strategy. */
function shouldAutoResubmit({ messages }: { messages: UIMessage[] }): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  const parts = last.parts as unknown as LoosePart[];
  const lastStepStart = parts.map((p) => p.type).lastIndexOf("step-start");
  const stepTools = parts
    .slice(lastStepStart + 1)
    .filter((p) => typeof p.type === "string" && (p.type as string).startsWith("tool-"));
  const clientTools = stepTools.filter((p) =>
    CLIENT_TOOL_NAMES.has((p.type as string).slice("tool-".length)),
  );
  return (
    clientTools.length > 0 &&
    clientTools.every(
      (p) => p.state === "output-available" || p.state === "output-error",
    )
  );
}

// Web Speech transcribes generic English — trading acronyms come back mangled
// ("RSI" → "our side", "MACD" → "mac d"). Post-correct the common ones so the
// agent gets clean jargon. Order matters: multi-word phrases first.
const SPEECH_FIXES: Array<[RegExp, string]> = [
  [/\b(our|are|r)\s?[- ]?\s?(s|es)\s?[- ]?\s?(i|eye)\b/gi, "RSI"],
  [/\br\.?\s?s\.?\s?i\.?\b/gi, "RSI"],
  [/\b(mac|mack)\s?[- ]?\s?(d|dee|d\.?)\b/gi, "MACD"],
  [/\bm\.?\s?a\.?\s?c\.?\s?d\.?\b/gi, "MACD"],
  [/\be\.?\s?m\.?\s?a\.?\b/gi, "EMA"],
  [/\bs\.?\s?m\.?\s?a\.?\b/gi, "SMA"],
  [/\bv\.?\s?wap\b/gi, "VWAP"],
  [/\bvee\s?wap\b/gi, "VWAP"],
  [/\ba\.?\s?t\.?\s?r\.?\b/gi, "ATR"],
  [/\ba\.?\s?d\.?\s?x\.?\b/gi, "ADX"],
  [/\bbollinger('?s)?\b/gi, "Bollinger"],
  [/\b(bol|ball)inger\b/gi, "Bollinger"],
  [/\bfibonacci\b/gi, "Fibonacci"],
  [/\bfib(s)?\b/gi, "fib"],
  [/\bstochastics?\b/gi, "Stochastic"],
  [/\b(take profit|takeprofit)\b/gi, "take-profit"],
  [/\b(stop loss|stoploss)\b/gi, "stop-loss"],
  [/\bbit ?coin\b/gi, "BTC"],
  [/\bether(eum)?\b/gi, "ETH"],
];

function fixSpeechTerms(text: string): string {
  let out = text;
  for (const [re, rep] of SPEECH_FIXES) out = out.replace(re, rep);
  return out;
}

/** Tool-chip label derived from an assistant message's tool parts. */
function summarizeToolParts(parts: LoosePart[]): string | undefined {
  const count = (name: string) =>
    parts.filter((p) => p.type === `tool-${name}`).length;
  const bits: string[] = [];
  const levels = count("draw_level");
  const zones = count("draw_zone");
  const lines = count("draw_trendline");
  const channels = count("draw_channel");
  const fibs = count("draw_fib") + count("draw_fib_extension");
  const notes = count("draw_text");
  const verticals = count("draw_vertical");
  if (levels) bits.push(`${levels} level${levels > 1 ? "s" : ""}`);
  if (zones) bits.push(`${zones} zone${zones > 1 ? "s" : ""}`);
  if (lines) bits.push(`${lines} trendline${lines > 1 ? "s" : ""}`);
  if (channels) bits.push(`${channels} channel${channels > 1 ? "s" : ""}`);
  if (fibs) bits.push(`${fibs} fib${fibs > 1 ? "s" : ""}`);
  if (verticals) bits.push(`${verticals} marker${verticals > 1 ? "s" : ""}`);
  if (notes) bits.push(`${notes} note${notes > 1 ? "s" : ""}`);
  if (count("add_indicators") + count("remove_indicators") + count("clear_indicators"))
    bits.push("indicators");
  for (const p of parts) {
    if (p.type === "tool-set_timeframe") bits.push(`tf → ${p.input?.resolution ?? ""}`);
    if (p.type === "tool-set_symbol") bits.push(`chart → ${p.input?.pair ?? ""}`);
    if (p.type === "tool-clear_agent_drawings") bits.push("cleared AI drawings");
    if (p.type === "tool-clear_all_drawings") bits.push("cleared chart");
  }
  if (bits.length) return `Chart · ${bits.join(" · ")}`;
  if (count("suggest_plan")) return "Detect";
  if (count("market_pulse")) return "Market pulse";
  if (count("update_plan")) return "Plan updated";
  if (count("backtest_run")) return "Backtest · Superior infra";
  if (count("deploy_strategy")) return "Deploy · Superior infra";
  if (count("screen_markets")) return "Market screener";
  if (count("pnl_check")) return "PnL check";
  return undefined;
}

/** UIMessage (streamed or restored) → the render view model. */
function toView(m: UIMessage): ChatMessage {
  const parts = m.parts as unknown as LoosePart[];
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
  let strategy: ChatMessage["strategy"] = null;
  // Only surface the "compiled" card for a SUCCESSFUL compile. During the
  // repair loop the tool output is { ok:false, issues } — showing a green
  // "ready to deploy" card then would be a lie (and coincides with the spinner).
  const comp = parts.find(
    (p) =>
      p.type === "tool-compile_strategy" &&
      p.input &&
      p.state === "output-available" &&
      (p.output as { ok?: boolean } | undefined)?.ok === true,
  );
  if (comp) {
    let config: unknown = {};
    try {
      config = JSON.parse(comp.input.configJson ?? "{}");
    } catch {
      /* fall back to the bare card */
    }
    // Deliberately DO NOT carry the raw strategy source into the view model —
    // it must never be rendered to the user (the card shows a summary only).
    strategy = { name: comp.input.name, config, code: "" };
  }
  const legacy = parts.find((p) => p.type === "data-strategy");
  if (!strategy && legacy?.data) strategy = legacy.data as ChatMessage["strategy"];
  const meta = (m.metadata ?? {}) as { tool?: string; followUps?: string[] };
  // Follow-ups ride the reply as a trailing `FOLLOWUPS: a | b | c` line —
  // parse them into tappable chips and strip the marker from the shown text.
  // (Matches even mid-stream so the raw marker never flashes as prose.)
  let displayText = text;
  let followUps = meta.followUps;
  const fu = text.match(/\n?\s*FOLLOWUPS:\s*([^\n]*)$/i);
  if (fu) {
    displayText = text.slice(0, fu.index).trimEnd();
    const parsed = fu[1]
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (parsed.length) followUps = parsed;
  }
  return {
    id: m.id,
    role: m.role as "user" | "assistant",
    text: displayText,
    tool: meta.tool ?? (m.role === "assistant" ? summarizeToolParts(parts) : undefined),
    strategy,
    followUps,
  };
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5 11.5a7 7 0 0 0 14 0" />
      <path d="M12 18.5v3" />
    </svg>
  );
}

function LineIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className}>
      <path d="M5 19 19 5" />
      <circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ChatsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M8 10h8M8 14h5" />
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5a8 8 0 0 1 8-8h2a8 8 0 0 1 8 2Z" />
    </svg>
  );
}

function NewChatIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H8l-5 3 1.5-4.5A8.5 8.5 0 1 1 21 11.5Z" />
      <path d="M12 8v7M8.5 11.5h7" />
    </svg>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

/** Brand triangle (the Superior Trade mark's apex) — used where the AI
 *  "presence" is decorated: agent message header + chat input. The detect
 *  features keep the ✦ spark (user preference). */
function TriangleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 3 21 19H3Z" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function HLineIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className}>
      <path d="M3 12h18" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className}>
      <path d="M6 18 20 4" />
      <circle cx="6" cy="18" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RectIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className={className}>
      <rect x="4" y="7" width="16" height="10" rx="1" />
    </svg>
  );
}

function FibIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className={className}>
      <path d="M4 5h16" />
      <path d="M4 10h16" opacity="0.75" />
      <path d="M4 14h16" opacity="0.55" />
      <path d="M4 19h16" opacity="0.4" />
    </svg>
  );
}

/** Drawing tools offered by the chat-bar split button. ids are TradingView
 *  selectLineTool() names (passed through select_tool verbatim). */
const DRAW_TOOLS = [
  { id: "brush", labelKey: "toolBrush", Icon: PencilIcon },
  { id: "trend_line", labelKey: "toolTrendline", Icon: LineIcon },
  { id: "horizontal_line", labelKey: "toolHLine", Icon: HLineIcon },
  { id: "ray", labelKey: "toolRay", Icon: RayIcon },
  { id: "rectangle", labelKey: "toolRect", Icon: RectIcon },
  { id: "fib_retracement", labelKey: "toolFib", Icon: FibIcon },
] as const;
type DrawTool = (typeof DRAW_TOOLS)[number]["id"];
const isDrawTool = (v: unknown): v is DrawTool =>
  DRAW_TOOLS.some((t) => t.id === v);

// Backtesting is deliberately NOT surfaced in the UI yet — the card shows
// the registered strategy only (the agent can still run backtests when the
// user explicitly asks in chat).
function StrategyCard({
  strategy,
}: {
  strategy: NonNullable<ChatMessage["strategy"]>;
  onAgentNote?: (text: string) => void;
}) {
  const { t } = useLang();
  // NEVER render the strategy source — it's Superior's IP and confusing to
  // users. Show a plain confirmation + a couple of non-code config facts.
  const cfg = (strategy.config ?? {}) as {
    timeframe?: string;
    stake_amount?: number | string;
    stake_currency?: string;
  };
  const facts: string[] = [];
  if (cfg.timeframe) facts.push(String(cfg.timeframe));
  if (cfg.stake_amount != null) {
    facts.push(`${cfg.stake_amount}${cfg.stake_currency ? ` ${cfg.stake_currency}` : ""}`);
  }
  return (
    <div className="mt-2 min-w-0 max-w-full rounded-xl border border-lime-400/20 bg-black/40 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-lime-300" aria-hidden>
          ✓
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-widest text-lime-300">
          {strategy.name ?? "Strategy"}
        </span>
      </div>
      <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-white/45">
        {t("strategyCompiled")}
        {facts.length ? ` · ${facts.join(" · ")}` : ""}
      </p>
    </div>
  );
}

function MessageRow({
  message,
  onFollowUp,
  onAgentNote,
}: {
  message: ChatMessage;
  onFollowUp?: (text: string) => void;
  onAgentNote?: (text: string) => void;
}) {
  const isUser = message.role === "user";
  // Streaming markdown via Streamdown (handles unterminated **bold**/lists
  // mid-stream). strong gets the brand lime accent; block elements are
  // mapped to the chat bubble's compact type scale.
  const rendered = isUser
    ? [message.text]
    : (() => {
        const out: React.ReactNode[] = [
          <Streamdown
            key="md"
            components={{
              strong: ({ children }) => (
                <strong className="font-semibold text-lime-300">{children}</strong>
              ),
              p: ({ children }) => <p className="my-0.5">{children}</p>,
              ul: ({ children }) => (
                <ul className="my-1.5 list-disc space-y-1 pl-5 marker:text-white/70">
                  {children}
                </ul>
              ),
              ol: ({ children }) => (
                <ol className="my-1.5 list-decimal space-y-1 pl-5 marker:text-white/70">
                  {children}
                </ol>
              ),
              h1: ({ children }) => <p className="my-1 font-semibold text-white">{children}</p>,
              h2: ({ children }) => <p className="my-1 font-semibold text-white">{children}</p>,
              h3: ({ children }) => <p className="my-1 font-semibold text-white">{children}</p>,
              h4: ({ children }) => <p className="my-1 font-semibold text-white">{children}</p>,
              code: ({ children }) => (
                <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11.5px] text-lime-200/90">
                  {children}
                </code>
              ),
              a: ({ children }) => <span className="underline">{children}</span>,
            }}
          >
            {message.text}
          </Streamdown>,
        ];
        return out;
      })();
  return (
    <div className={`flex min-w-0 ${isUser ? "justify-end" : "justify-start"}`}>
      {/* User bubble sits on the right, but its TEXT reads left — right-
          aligned ragged-left text is hard to scan once a message wraps. */}
      <div className="min-w-0 max-w-[88%] text-left">
        {message.tool && (
          <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-lime-300/90 backdrop-blur-sm">
            <span className="h-1 w-1 rounded-full bg-lime-400" />
            {message.tool}
          </div>
        )}
        <div
          className={
            isUser
              ? "inline-block rounded-2xl rounded-br-md bg-lime-950/85 px-4 py-2.5 text-[13.5px] leading-relaxed text-lime-50 backdrop-blur-sm"
              : "inline-block text-[13.5px] leading-relaxed text-white/95"
          }
        >
          {rendered}
          {message.strategy && (
            <StrategyCard strategy={message.strategy} onAgentNote={onAgentNote} />
          )}
        </div>
        {!isUser && !!message.followUps?.length && onFollowUp && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.followUps.map((f) => (
              <button
                key={f}
                onClick={() => onFollowUp(f)}
                title={f}
                className="max-w-full rounded-full border border-white/15 bg-white/[0.05] px-3 py-1 font-mono text-[10.5px] text-white/75 transition-colors hover:border-lime-400/40 hover:text-lime-300"
              >
                {/* Clamp to one line so an over-long suggestion can't blow out
                    the pill — full text stays on hover (title) and on click. */}
                <span className="block truncate">{f}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function FloatingChat() {
  const { dispatchChartAction, getChartContext, getChartScreenshot } = useChartBridge();
  const { lang, t } = useLang();
  const { requireAuth, authed } = useAuthGate();
  const {
    activePlan,
    applyEdit,
    detecting,
    plans,
    registerChatHistoryProvider,
    toggleMark,
    suggestPlans,
    funds,
    leverage,
  } = useSetups();
  const { assetsByName } = useHyperliquid();
  const [mode, setMode] = useState<"idle" | "peek" | "expanded">("idle");
  const [draft, setDraft] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [activeTool, setActiveTool] = useState<DrawTool | null>(null);
  // Ref mirror for keydown handlers registered before/without activeTool in
  // their deps (the chat-collapse ESC handler checks it to yield).
  const activeToolRef = useRef<DrawTool | null>(null);
  activeToolRef.current = activeTool;
  // The split-button remembers the last-picked drawing tool (brush by default);
  // the chevron dropdown swaps it.
  const [lastDrawTool, setLastDrawTool] = useState<DrawTool>("brush");
  // localStorage is read AFTER mount: reading it in the initializer renders a
  // different icon than the server did and trips hydration.
  useEffect(() => {
    const saved = localStorage.getItem("cg:last-draw-tool");
    if (isDrawTool(saved)) setLastDrawTool(saved);
  }, []);
  // Portal anchor for the tool picker (fixed coords so the menu escapes the
  // chat bar's rounded/clipping containers).
  const [toolMenuPos, setToolMenuPos] = useState<{ right: number; bottom: number } | null>(null);
  const toolMenuOpen = toolMenuPos !== null;
  const setToolMenuOpen = useCallback((open: boolean) => {
    if (!open) setToolMenuPos(null);
  }, []);
  const toolSplitRef = useRef<HTMLDivElement>(null);
  const toolMenuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const conversationIdRef = useRef<string>("");
  // useChat keys off this. The ref stays for the many non-reactive call sites;
  // this mirrors it so a switch actually re-instantiates the chat instead of
  // leaving the previous conversation's stream attached.
  const [activeConvId, setActiveConvId] = useState<string>("");
  if (!conversationIdRef.current && typeof window !== "undefined") {
    const saved = window.localStorage.getItem("cg-conversation");
    conversationIdRef.current = saved ?? `c${Date.now().toString(36)}`;
    window.localStorage.setItem("cg-conversation", conversationIdRef.current);
  }

  // ── Streaming agent (useChat + /api/chat tool loop) ──────────────────
  // The server owns history + persistence; each request carries only the
  // latest message plus live context. Dynamic values ride in refs because
  // the Chat instance captures its options once.
  /** Chart screenshot captured at submit; consumed by the turn's first
   *  request (read-and-clear in dynamicBodyRef). */
  const screenshotRef = useRef<string | null>(null);
  /** Byte length of the last captured screenshot (0 = none/failed capture).
   *  Reported with detect_failed so we can see whether failures correlate with
   *  a blank/degenerate capture (the vision model 400s "Could not process
   *  image" on a too-small image). */
  const lastShotBytesRef = useRef(0);
  /** True while a panel-triggered detect turn is streaming — resolved to a
   *  cg:detect-done event when the stream settles (or the submit fails). */
  const detectPendingRef = useRef(false);
  const dynamicBodyRef = useRef<() => Record<string, unknown>>(() => ({}));
  dynamicBodyRef.current = () => {
    const ctx = getChartContext();
    // Chart change-tracking: diff the chart against the snapshot the agent
    // LAST SAW (persisted per conversation, so it survives reloads) and send
    // the delta as plain sentences — without this the agent keeps reasoning
    // about drawings the user has since deleted or moved. The snapshot
    // advances at send time; tool-continuation requests in the same turn
    // then diff as "no changes", which is correct (the agent has seen it).
    let chartDelta: string[] = [];
    try {
      const key = `cg-chart-seen-${conversationIdRef.current}`;
      const snap = snapshotChart(ctx);
      const prevRaw = window.localStorage.getItem(key);
      const prev = prevRaw ? (JSON.parse(prevRaw) as ChartSnapshot) : null;
      chartDelta = diffChart(prev, snap);
      window.localStorage.setItem(key, JSON.stringify(snap));
    } catch {
      /* delta is best-effort — the live context is still authoritative */
    }
    // Vision parity with detect: the screenshot captured at submit time
    // rides the FIRST request of the turn only (read-and-clear) — tool
    // continuations in the same turn must not re-pay its tokens.
    const screenshot = screenshotRef.current;
    screenshotRef.current = null;
    return {
      conversationId: conversationIdRef.current,
      chartContext: ctx,
      chartDelta,
      screenshot,
      // Detect turns: the server pre-fetches the market pulse so the agent
      // skips a whole tool round-trip before publishing plans.
      detect: detectPendingRef.current,
      selectedPlan: activePlan,
      // The plans currently in the panel — so the agent can discuss/compare/
      // deploy them by reference ("deploy the S-tier one", "why is #2 B tier").
      detectedPlans: plans,
      funds,
      leverage,
      lang,
    };
  };

  // Client-executed tools: the model's call streams here, the browser runs
  // it against the chart bridge / setups panel, and the loop continues.
  const execClientToolRef = useRef<
    ((name: string, input: LoosePart) => Promise<unknown>) | null
  >(null);
  execClientToolRef.current = async (name, input) => {
    const dispatch = (a: ChartAction) => dispatchChartAction(a);
    switch (name) {
      case "draw_level":
        // Return the chart's REAL outcome (shape id or error), not a blind
        // {ok:true}. A swallowed TradingView failure used to be reported as
        // success, which let the model claim it drew something it didn't and
        // left the persisted tool-call log lying about what rendered.
        return await dispatch({
          action: "draw_level",
          price: input.price,
          label: input.label ?? undefined,
          side: input.side ?? undefined,
        });
      case "draw_zone":
      case "draw_trendline":
      case "draw_fib":
        return await dispatch({
          action: name,
          from: { time: input.fromTime, price: input.fromPrice },
          to: { time: input.toTime, price: input.toPrice },
          label: input.label ?? undefined,
        } as ChartAction);
      case "draw_vertical":
        return await dispatch({
          action: "draw_vertical",
          time: input.time,
          label: input.label ?? undefined,
        });
      case "draw_channel":
        return await dispatch({
          action: "draw_channel",
          from: { time: input.fromTime, price: input.fromPrice },
          to: { time: input.toTime, price: input.toPrice },
          offsetPrice: input.offsetPrice,
          label: input.label ?? undefined,
        });
      case "draw_fib_extension":
        return await dispatch({
          action: "draw_fib_extension",
          from: { time: input.fromTime, price: input.fromPrice },
          to: { time: input.toTime, price: input.toPrice },
          retrace: { time: input.retraceTime, price: input.retracePrice },
          label: input.label ?? undefined,
        });
      case "draw_text":
        return await dispatch({
          action: "draw_text",
          time: input.time,
          price: input.price,
          text: input.text,
        });
      case "add_indicators":
        await dispatch({
          action: "add_indicators",
          indicators: (input.indicators ?? []).map(
            (i: { name: string; inputsJson?: string | null; forceOverlay?: boolean | null }) => ({
              name: i.name,
              inputs: i.inputsJson ? JSON.parse(i.inputsJson) : undefined,
              forceOverlay: i.forceOverlay ?? undefined,
            }),
          ),
        });
        return { ok: true };
      case "remove_indicators":
        await dispatch({ action: "remove_indicators", names: input.names ?? [] });
        return { ok: true };
      case "clear_indicators":
      case "clear_agent_drawings":
      case "clear_all_drawings":
        await dispatch({ action: name });
        return { ok: true };
      case "set_timeframe":
        await dispatch({ action: "set_timeframe", resolution: input.resolution });
        return { ok: true };
      case "set_range":
        await dispatch({ action: "set_range", from: input.rangeFrom, to: input.rangeTo });
        return { ok: true };
      case "set_symbol": {
        const coin = pairToCoin(String(input.pair ?? "").trim());
        const asset =
          assetsByName.get(coin) ??
          [...assetsByName.values()].find(
            (a) => a.name.toLowerCase() === coin.toLowerCase(),
          );
        if (!asset) {
          return { error: `Unknown pair "${input.pair}" — use screen_markets to find the exact market name.` };
        }
        await dispatch({ action: "set_symbol", pair: coinToPair(asset.name) });
        return { ok: true, switchedTo: coinToPair(asset.name) };
      }
      case "update_plan":
        if (!activePlan) return { error: "No plan is selected/marked on the chart." };
        // Merge onto the ACTIVE plan: fields the tool doesn't carry (tier,
        // conditions, zh, aliveUntil) must survive the edit — a bare patch
        // used to silently strip them (and the level sources, killing
        // live-tracking). `mode` is now carried, because preserving it
        // unconditionally meant a mis-detected one_shot could never be
        // corrected; it still falls back to the plan's value when omitted.
        await applyEdit({
          ...activePlan,
          title: input.title,
          direction: input.direction,
          mode: (input.mode as DetectedPlan["mode"]) ?? activePlan.mode ?? null,
          entry: input.entry,
          stop: input.stop,
          target: input.target,
          thesis: input.thesis,
          invalidation: input.invalidation,
          entrySource: (input.entrySource as string | null) ?? activePlan.entrySource ?? null,
          stopSource: (input.stopSource as string | null) ?? activePlan.stopSource ?? null,
          targetSource: (input.targetSource as string | null) ?? activePlan.targetSource ?? null,
          sizing: (input.sizing as DetectedPlan["sizing"]) ?? activePlan.sizing ?? null,
        });
        return { ok: true };
      case "suggest_plan": {
        // Batched publishing: ALL of a scan's plans arrive in ONE call (each
        // extra tool round-trip costs a full model step). Tolerates the old
        // single-plan shape for restored histories.
        const items = (Array.isArray(input.plans) ? input.plans : [input]) as LoosePart[];
        // `mode` carries .catch("recurring") in the schema, so a missing or
        // misspelled value ("one-shot", "oneShot") is replaced silently and the
        // call still succeeds — the model then believes it published a one-shot
        // that will actually deploy as a recurring strategy. Report the
        // substitution back so it can correct itself instead of asserting
        // something untrue to the user.
        const coerced = items
          .filter((it) => {
            const raw = (it as Record<string, unknown>).mode;
            return raw !== undefined && raw !== "one_shot" && raw !== "recurring";
          })
          .map((it) => String((it as Record<string, unknown>).mode));
        const rejected: string[] = [];
        const patches: Array<Omit<DetectedPlan, "id">> = [];
        // Value of a level from its source, for the live-crossing check below.
        // A sloped trendline entry can drift to the wrong side of a FIXED stop
        // even when the snapshot numbers are ordered correctly — the drawn line
        // tracks the trendline's CURRENT value, so it renders crossed (the
        // SOL-long bug: entry 71.5 > stop 69 on paper, but the entry trendline
        // sits ~64 today). Only trendlines are evaluable client-side; indicator
        // sources need the candle series, so they fall back to the snapshot
        // (never a false reject).
        const liveLevel = (snapshot: number, source: string | null): number => {
          if (!source || source === "fixed") return snapshot;
          const m = /^trendline:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/.exec(source);
          if (!m) return snapshot;
          const [t1, p1, t2, p2] = m.slice(1).map(Number);
          if (![t1, p1, t2, p2].every(Number.isFinite) || t1 === t2) return snapshot;
          return p1 + ((p2 - p1) / (t2 - t1)) * (Date.now() / 1000 - t1);
        };
        for (let i = 0; i < items.length; i++) {
          const p = items[i];
          const dir = p.direction as "long" | "short" | "neutral";
          const { entry, stop, target } = p as { entry: number; stop: number; target: number };
          // Neutral carries the LONG leg's levels (lower range bound), so it
          // shares the long geometry.
          const badGeometry =
            dir === "short" ? !(target < entry && entry < stop) : !(stop < entry && entry < target);
          if (badGeometry) {
            rejected.push(
              `plan ${i + 1} "${p.title}": invalid geometry for a ${dir} — stop must be on the losing side of entry and target on the profit side${dir === "neutral" ? " (neutral plans carry the LONG leg's levels at the lower range bound)" : ""}`,
            );
            continue;
          }
          // Dynamic-source crossing: with the snapshot ordered correctly, a
          // trendline level's value at the CURRENT time can still sit on the
          // wrong side of a fixed level, so the drawn entry/stop/target lines
          // render crossed on the chart (entry below stop for a long, etc.).
          const liveEntry = liveLevel(entry, (p.entrySource as string | null) ?? null);
          const liveStop = liveLevel(stop, (p.stopSource as string | null) ?? null);
          const liveTarget = liveLevel(target, (p.targetSource as string | null) ?? null);
          const liveCross =
            dir === "short"
              ? !(liveTarget < liveEntry && liveEntry < liveStop)
              : !(liveStop < liveEntry && liveEntry < liveTarget);
          if (liveCross) {
            rejected.push(
              `plan ${i + 1} "${p.title}": a dynamic (trendline) level renders on the wrong side RIGHT NOW — tracked entry ≈ ${liveEntry.toFixed(4)}, stop ≈ ${liveStop.toFixed(4)}, target ≈ ${liveTarget.toFixed(4)}. For a ${dir} these must read ${dir === "short" ? "target < entry < stop" : "stop < entry < target"} at the CURRENT time, not only as snapshot prices. Re-anchor the trendline so its value now sits between the fixed levels, or give the stop/target the same trendline source.`,
            );
            continue;
          }
          if (p.aliveUntil) {
            const ts = Date.parse(String(p.aliveUntil));
            if (Number.isNaN(ts) || ts < Date.now() + 15 * 60_000) {
              rejected.push(
                `plan ${i + 1} "${p.title}": aliveUntil must be a valid ISO date-time ≥ 15 minutes in the future`,
              );
              continue;
            }
          }
          // Mode consistency guard (same rule the old detect route enforced):
          // an indicator-riding entry is BY DEFINITION a repeatable trigger.
          const entrySrc = (p.entrySource as string | null) ?? null;
          const forcedRecurring = entrySrc !== null && entrySrc !== "fixed";
          patches.push({
            title: String(p.title ?? "Suggested plan"),
            direction: dir,
            mode: p.mode === "one_shot" && !forcedRecurring ? "one_shot" : "recurring",
            symbol: (p.symbol as string | null) ?? null,
            thesis: String(p.thesis ?? ""),
            entry,
            stop,
            target,
            invalidation: String(p.invalidation ?? ""),
            tier: (p.tier ?? null) as Tier | null,
            tierReason: (p.tierReason as string | null) ?? null,
            entryCondition: (p.entryCondition as string | null) ?? null,
            stopCondition: (p.stopCondition as string | null) ?? null,
            targetCondition: (p.targetCondition as string | null) ?? null,
            entrySource: entrySrc,
            stopSource: (p.stopSource as string | null) ?? null,
            targetSource: (p.targetSource as string | null) ?? null,
            aliveUntil: (p.aliveUntil as string | null) ?? null,
            aliveUntilReason: (p.aliveUntilReason as string | null) ?? null,
            sizing: (p.sizing as DetectedPlan["sizing"]) ?? null,
            zh: (p.zh as DetectedPlan["zh"]) ?? null,
          });
          // Audit log (fire-and-forget) — server-side generations log
          // directly; this client-executed tool reports per plan.
          void authFetch("/api/strategy-log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ plan: p, symbol: p.symbol ?? null }),
          }).catch(() => {});
        }
        if (!patches.length)
          return { error: `No plan published. ${rejected.join(" | ")}. Fix the levels and call suggest_plan again.` };
        // Best tier first — one batched state update, one fresh-pulse group.
        const TIER_RANK: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };
        patches.sort(
          (a, b) => (TIER_RANK[a.tier ?? "C"] ?? 2) - (TIER_RANK[b.tier ?? "C"] ?? 2),
        );
        const created = suggestPlans(patches);
        return {
          ok: true,
          published: created.length,
          planIds: created.map((c) => c.id),
          ...(rejected.length ? { rejected } : {}),
          ...(coerced.length
            ? {
                modeCoerced: `Ignored an invalid mode (${coerced.join(", ")}) and published as "recurring". If you meant one_shot, call update_plan with mode:"one_shot" — do NOT tell the user it is a one-shot until you have.`,
              }
            : {}),
          note: "Plan cards published to the Draft Setups panel (right side) with a highlight — point the user there.",
        };
      }
      case "mark_setup": {
        if (!plans.length)
          return { error: "No detected setups yet — run a scan (market_pulse + suggest_plan set) first." };
        let plan = plans[0]; // list is sorted best-tier-first
        if (input.tier) {
          const want = String(input.tier).toUpperCase();
          const match = plans.find((p) => (p.tier ?? "").toUpperCase() === want);
          if (!match)
            return {
              error: `No ${want}-tier setup here. Tiers present: ${[...new Set(plans.map((p) => p.tier ?? "?"))].join(", ")}. Consider adding confluence indicators and re-detecting, or scanning another market.`,
            };
          plan = match;
        } else if (input.index != null) {
          const p = plans[input.index - 1];
          if (!p) return { error: `No setup #${input.index}; there are ${plans.length}.` };
          plan = p;
        }
        // toggleMark toggles; only fire when it isn't already the marked one.
        if (activePlan?.id !== plan.id) await toggleMark(plan);
        return {
          ok: true,
          marked: { title: plan.title, tier: plan.tier ?? null, symbol: plan.symbol ?? null },
        };
      }
      default:
        return { error: `Unknown client tool ${name}` };
    }
  };

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/chat",
        fetch: authFetch as unknown as typeof fetch,
        prepareSendMessagesRequest: ({ messages: msgs }) => ({
          body: {
            message: msgs[msgs.length - 1],
            ...dynamicBodyRef.current(),
          },
        }),
      }),
    [],
  );

  const {
    messages: uiMessages,
    setMessages: setUiMessages,
    sendMessage,
    addToolOutput,
    status,
  } = useChat<UIMessage>({
    id: activeConvId || conversationIdRef.current || "local",
    transport,
    sendAutomaticallyWhen: shouldAutoResubmit,
    onFinish: ({ message }) => {
      // Persist the finished assistant reply from the CLIENT. The server also
      // saves in its stream-onFinish, but on serverless that runs after the
      // response closes and the runtime can kill it first — which silently
      // dropped every streamed reply from history (user messages pre-save, so
      // refreshes showed questions with no answers). upsertMessages is keyed
      // by id, so double-saves are harmless.
      if (message.role !== "assistant" || !conversationIdRef.current) return;
      void authFetch("/api/chat-store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationIdRef.current,
          messages: [
            {
              id: message.id,
              role: message.role,
              parts: message.parts,
              metadata: message.metadata,
              createdAt: Date.now(),
            },
          ],
        }),
      }).catch(() => {});
    },
    onToolCall: async ({ toolCall }) => {
      try {
        const output = await execClientToolRef.current!(
          toolCall.toolName,
          (toolCall.input ?? {}) as LoosePart,
        );
        addToolOutput({
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          output,
        });
      } catch (err) {
        addToolOutput({
          state: "output-error",
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          errorText: err instanceof Error ? err.message : "tool failed",
        });
      }
    },
  });

  const isThinking = status === "submitted" || status === "streaming";
  // TV menus can't escape their iframe — the chat fades out while one is
  // open so the dropdown is effectively "on top".
  const [tvPopupOpen, setTvPopupOpen] = useState(false);
  useEffect(() => {
    const onPopup = (e: Event) =>
      setTvPopupOpen(Boolean((e as CustomEvent<{ open?: boolean }>).detail?.open));
    window.addEventListener("cg:tv-popup", onPopup);
    return () => window.removeEventListener("cg:tv-popup", onPopup);
  }, []);
  const messages: ChatMessage[] = useMemo(
    () => [...WELCOME, ...uiMessages.map(toView)],
    [uiMessages],
  );
  // Live snapshot of message count so the async history load never clobbers
  // messages the user has already sent (Privy auth registers a beat late, so
  // the load can resolve AFTER the first turn — without this guard those live
  // messages vanish and then pop back, which reads as "messages appearing").
  const uiCountRef = useRef(0);
  uiCountRef.current = uiMessages.length;

  // How full the model's context window is: the most recent assistant turn
  // reports the prompt-token count it was sent (contextTokens metadata).
  // Rolling-memory compaction keeps this low; the gauge shows it climbing.
  const contextPct = useMemo(() => {
    for (let i = uiMessages.length - 1; i >= 0; i--) {
      const md = uiMessages[i]?.metadata as { contextTokens?: number } | undefined;
      if (md?.contextTokens != null) {
        return Math.min(100, Math.round((md.contextTokens / CONTEXT_WINDOW_TOKENS) * 100));
      }
    }
    return null;
  }, [uiMessages]);

  /** Synthetic assistant note (detect reports, deploys, backtests, errors).
   *  Persisted to the chat store so the AGENT sees it in its history on the
   *  next turn — panel actions are no longer invisible to the model. */
  const appendNote = useCallback(
    (text: string, tool?: string) => {
      const note = {
        id: `n${Date.now()}`,
        role: "assistant",
        parts: [{ type: "text", text }],
        metadata: tool ? { tool } : undefined,
      };
      setUiMessages((prev) => [...prev, note as UIMessage]);
      void authFetch("/api/chat-store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationIdRef.current,
          messages: [{ ...note, createdAt: Date.now() }],
        }),
      }).catch(() => {});
    },
    [setUiMessages],
  );

  // Panel components (deploy flow, etc.) report through this event.
  useEffect(() => {
    const onNote = (e: Event) => {
      const d = (e as CustomEvent<{ text?: string; tool?: string }>).detail;
      if (d?.text) appendNote(d.text, d.tool);
    };
    window.addEventListener("cg:agent-note", onNote);
    return () => window.removeEventListener("cg:agent-note", onNote);
  }, [appendNote]);

  const expanded = mode === "expanded";
  const peeking = mode === "peek";
  const busyIndicator = isThinking || detecting;

  // Initial history load — stored rows ARE UIMessages (parts + metadata).
  // Gated on auth (Privy token registers after mount) and RETRIED on
  // failure: an early 401/blip must not latch the chat empty.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!authed || loadedRef.current) return;
    let cancelled = false;
    const load = async (attempt: number) => {
      try {
        const res = await authFetch(`/api/chat-store?c=${conversationIdRef.current}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (cancelled) return;
        loadedRef.current = true;
        // Only hydrate when the client has no live messages yet — never
        // overwrite a turn the user already started this session.
        if (Array.isArray(j.items) && j.items.length && uiCountRef.current === 0) {
          setUiMessages(j.items as UIMessage[]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Expose chat history to the setups detector so it honors stated
  // preferences ("keep risk under 2%", "longs only", ...).
  const historyRef = useRef<Array<{ role: string; text: string }>>([]);
  historyRef.current = messages.map((m) => ({ role: m.role, text: m.text }));
  useEffect(() => {
    registerChatHistoryProvider(() => historyRef.current);
    return () => registerChatHistoryProvider(null);
  }, [registerChatHistoryProvider]);

  // Detect results are NOT appended as a separate chat message. The agent's own
  // reply already announces the setups and the suggest_plan cards render in the
  // Draft Setups panel. The extra note read as a duplicate reply and — being
  // appended AFTER the main reply while follow-up chips render per-message —
  // buried those chips, which is what surfaced as "follow-ups not showing" and
  // "the agent replies a few times".

  useEffect(() => {
    if (!expanded) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [expanded, messages, isThinking]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        // An armed drawing tool wins the ESC: release it (handled by the
        // tool-deselect listener below) without also collapsing the chat.
        if (activeToolRef.current) return;
        setMode("idle");
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Type-to-chat: printable keystrokes anywhere land in this input — the
  // chart iframe reroutes via the cg:type-to-chat event (see trading-chart);
  // plain document-level typing is caught here directly. Known limitation:
  // an IME composition begun while the chart is focused loses its first
  // keystroke (focus moves on that keydown); composition then continues
  // normally inside the input.
  useEffect(() => {
    const focusAndSeed = (char: string) => {
      setMode("expanded");
      setDraft((d) => d + char);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    const onRouted = (e: Event) => {
      const char = (e as CustomEvent<{ char?: string }>).detail?.char;
      if (typeof char === "string") focusAndSeed(char);
    };
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      focusAndSeed(e.key);
    };
    window.addEventListener("cg:type-to-chat", onRouted);
    document.addEventListener("keydown", onDocKey, true);
    return () => {
      window.removeEventListener("cg:type-to-chat", onRouted);
      document.removeEventListener("keydown", onDocKey, true);
    };
  }, []);

  // Peek opens only after a DELIBERATE hover (450ms): a cursor merely
  // passing over the bar on its way across the chart must not flash the
  // history preview open. While a drawing tool is armed the peek stays
  // suppressed entirely — the user has committed to drawing and the history
  // flashing open under the cursor is pure distraction.
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleEnter = useCallback(() => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
    if (activeTool || toolMenuOpen) return;
    enterTimerRef.current = setTimeout(() => {
      setMode((m) => (m === "expanded" ? m : "peek"));
    }, 200);
  }, [activeTool, toolMenuOpen]);

  const handleLeave = useCallback(() => {
    if (enterTimerRef.current) {
      clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(() => {
      setMode((m) => (m === "peek" ? "idle" : m));
    }, 160);
  }, []);

  const toggleTool = useCallback(
    async (tool: DrawTool) => {
      const next = activeTool === tool ? null : tool;
      setActiveTool(next);
      if (next) {
        // Tool armed → close any open peek immediately and cancel a pending
        // hover-open so the preview doesn't pop under the user's cursor.
        if (enterTimerRef.current) {
          clearTimeout(enterTimerRef.current);
          enterTimerRef.current = null;
        }
        setMode((m) => (m === "peek" ? "idle" : m));
      }
      await dispatchChartAction({
        action: "select_tool",
        tool: next ?? "cursor",
      });
    },
    [activeTool, dispatchChartAction],
  );

  // ESC releases an armed drawing tool back to the cursor (the chat-collapse
  // ESC handler yields when a tool is armed, so one press = one action).
  // cg:escape is the same key forwarded from INSIDE the chart iframe, where
  // parent keydown listeners never fire — without it, ESC while drawing
  // cancelled TV's tool but left the toolbar button stuck active.
  useEffect(() => {
    if (!activeTool) return;
    const release = () => void toggleTool(activeTool);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") release();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("cg:escape", release);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("cg:escape", release);
    };
  }, [activeTool, toggleTool]);

  // Close the tool-picker dropdown on outside click / Escape. The panel is
  // portaled, so "outside" means outside BOTH the split button and the panel.
  useEffect(() => {
    if (!toolMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (toolSplitRef.current?.contains(t)) return;
      if (toolMenuRef.current?.contains(t)) return;
      setToolMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setToolMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [toolMenuOpen, setToolMenuOpen]);

  const pickDrawTool = useCallback(
    (tool: DrawTool) => {
      setLastDrawTool(tool);
      try {
        localStorage.setItem("cg:last-draw-tool", tool);
      } catch {
        /* private mode */
      }
      setToolMenuOpen(false);
      // Picking from the dropdown always ARMS the tool (never toggles off).
      if (activeTool !== tool) void toggleTool(tool);
    },
    [activeTool, toggleTool],
  );

  const submit = useCallback(
    async (text: string) => {
      if (!text || isThinking) return;
      try {
        // The chat agent SEES the chart like the detector does: capture at
        // submit so the image matches what the user is looking at as they
        // ask. Best-effort — a failed capture never blocks the message.
        const shot = await getChartScreenshot().catch(() => null);
        screenshotRef.current = shot;
        lastShotBytesRef.current = shot?.length ?? 0;
        await sendMessage({ text });
      } catch (err) {
        // A failed detect turn must release the panel's detecting state.
        if (detectPendingRef.current) {
          detectPendingRef.current = false;
          window.dispatchEvent(
            new CustomEvent("cg:detect-done", {
              detail: { error: err instanceof Error ? err.message : "detect failed" },
            }),
          );
          // Persist the failure (Vercel keeps no runtime-log history) with the
          // reason + whether a screenshot was attached and how big it was, so
          // "detect failed" is diagnosable and monitorable after the fact.
          track("detect_failed", {
            reason: (err instanceof Error ? err.message : String(err)).slice(0, 180),
            hadScreenshot: lastShotBytesRef.current > 0,
            screenshotBytes: lastShotBytesRef.current,
          });
        }
        appendNote(
          err instanceof Error && /unauthorized|invalid token/i.test(err.message)
            ? t("apiKeyPrompt")
            : `Agent unavailable (${err instanceof Error ? err.message : "error"}).`,
        );
      }
    },
    [isThinking, sendMessage, appendNote, t, getChartScreenshot],
  );

  // The panel's Detect button routes through the AGENT (one brain, one
  // context): setups-context dispatches cg:detect-request, we submit a
  // synthetic user turn (visible in chat — transparent about what ran), and
  // cg:detect-done fires when the stream settles. Plans arrive through the
  // agent's suggest_plan calls like any conversation-authored plan.
  useEffect(() => {
    const onDetect = (e: Event) => {
      if (status !== "ready") {
        // Chat is mid-turn — a detect can't queue behind a streaming turn.
        window.dispatchEvent(
          new CustomEvent("cg:detect-done", { detail: { error: t("detectErrGeneric") } }),
        );
        return;
      }
      const all = Boolean(
        (e as CustomEvent).detail &&
          (e as CustomEvent<{ allIndicators?: boolean }>).detail.allIndicators,
      );
      detectPendingRef.current = true;
      void submit(t(all ? "detectMsgAll" : "detectMsg"));
    };
    window.addEventListener("cg:detect-request", onDetect);
    return () => window.removeEventListener("cg:detect-request", onDetect);
  }, [submit, t, status]);
  useEffect(() => {
    if (!detectPendingRef.current) return;
    if (status === "ready" || status === "error") {
      detectPendingRef.current = false;
      window.dispatchEvent(
        new CustomEvent("cg:detect-done", {
          detail: status === "error" ? { error: t("detectErrGeneric") } : {},
        }),
      );
    }
  }, [status, t]);

  // Slash commands (/clear, /reset) wipe the whole conversation after an
  // in-chat yes/no confirm. pendingClear gates the confirmation banner.
  const [pendingClear, setPendingClear] = useState(false);
  // Conversation switching. The rows the list LAST rendered are kept so
  // /switch <n> resolves against the numbers the user actually saw — a fresh
  // fetch would have reordered the moment any chat received a message.
  const [convRows, setConvRows] = useState<ConversationRow[]>([]);
  const [convListOpen, setConvListOpen] = useState(false);
  const openConvList = useCallback(async () => {
    setMode("expanded");
    setConvRows(await fetchConversations());
    setConvListOpen(true);
  }, []);

  /** Point the chat at another conversation and hydrate its history. */
  const switchConversation = useCallback(
    async (row: ConversationRow) => {
      setConvListOpen(false);
      if (row.id === conversationIdRef.current) return;
      conversationIdRef.current = row.id;
      try {
        window.localStorage.setItem("cg-conversation", row.id);
      } catch {
        /* private mode — the switch still works for this session */
      }
      setActiveConvId(row.id);
      setUiMessages([]);
      const j = await authFetch(`/api/chat-store?c=${row.id}`)
        .then((r) => r.json())
        .catch(() => ({ items: [] }));
      if (Array.isArray(j.items)) setUiMessages(j.items as UIMessage[]);
    },
    [setUiMessages],
  );

  const clearChat = useCallback(() => {
    setPendingClear(false);
    // Local reset is INSTANT; the server-side wipe runs in the background
    // (awaiting it made /clear feel broken whenever the backend was slow).
    setUiMessages([]);
    void authFetch(`/api/chat-store?c=${conversationIdRef.current}`, {
      method: "DELETE",
    }).catch(() => {
      /* best-effort — local state is already clean */
    });
  }, [setUiMessages]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    // Detection in flight: the agent's chart context and the detector's are
    // racing — block sends until the detector reports (draft is kept).
    if (detecting) return;
    setDraft("");
    // While awaiting confirmation, a typed yes/no answers it (buttons too).
    if (pendingClear) {
      if (/^(y|yes|是|對|確認|clear|reset|清除)$/i.test(text)) void clearChat();
      else setPendingClear(false);
      return;
    }
    if (/^\/(clear|reset|清除|重置)/i.test(text)) {
      setMode("expanded");
      setPendingClear(true);
      return;
    }
    if (/^\/(list|ls|對話)\s*$/i.test(text)) {
      void openConvList();
      return;
    }
    const sw = text.match(/^\/(?:switch|go|切換)\s*(\d+)?/i);
    if (sw) {
      // Resolve against the numbers the last /list showed, not a fresh fetch.
      const rows = convRows;
      if (sw[1] === undefined) {
        appendNote(t("convSwitchUsage"), "Chat");
        return;
      }
      const n = Number(sw[1]);
      const row = rows[n];
      if (!row) {
        appendNote(t("convSwitchNoIndex").replace("{n}", String(n)), "Chat");
        return;
      }
      void switchConversation(row).then(() =>
        appendNote(
          t("convSwitched").replace(
            "{title}",
            row.title?.trim() || fallbackConversationTitle(row.createdAt ?? Date.now()),
          ),
          "Chat",
        ),
      );
      return;
    }
    // First message of this conversation names it. Derived from the prompt
    // rather than model-generated: the title is a lookup key in /list, so it
    // has to exist immediately and never change under the user later.
    if (uiCountRef.current === 0) {
      const title = deriveConversationTitle(text);
      if (title) {
        void authFetch("/api/chat-store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: conversationIdRef.current,
            title,
            messages: [],
          }),
        }).catch(() => {
          /* the chat still works untitled; /list falls back to a dated label */
        });
      }
    }
    void submit(text);
  }, [draft, submit, pendingClear, clearChat, detecting, convRows, openConvList, switchConversation, appendNote, t]);

  const followUp = useCallback(
    (text: string) => {
      if (detecting) return;
      setMode("expanded");
      void submit(text);
    },
    [submit, detecting],
  );

  const postAgentNote = useCallback(
    (text: string) => appendNote(text, "Backtest · Superior infra"),
    [appendNote],
  );

  // ── VOICE MODE ─────────────────────────────────────────────────────
  // A persistent listening SESSION (toggle on/off), not one-shot dictation
  // — the model every leading voice UI converged on. Web Speech continuous
  // recognition with guarded auto-restart (Chrome force-ends the session
  // after ~7s of silence; naive restart loops get server-throttled, so two
  // instant deaths in a row exit the mode instead of spinning), a live
  // interim transcript in the read-only input, silence endpointing (~1.6s
  // after a finalized chunk) that auto-sends the utterance and KEEPS
  // listening, and amplitude-reactive pulse rings driven off an
  // AnalyserNode via a CSS variable — zero React re-renders per frame.
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const wantVoiceRef = useRef(false); // user intent — survives auto-restarts
  const finalizedRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRecEndRef = useRef(0);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const levelRafRef = useRef(0);
  const voiceWrapRef = useRef<HTMLDivElement | null>(null);
  const pendingUtteranceRef = useRef<string | null>(null);
  const isThinkingRef = useRef(false);
  isThinkingRef.current = isThinking;

  const stopVoice = useCallback(() => {
    wantVoiceRef.current = false;
    try {
      recognitionRef.current?.stop();
    } catch {
      /* already dead */
    }
    recognitionRef.current = null;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    cancelAnimationFrame(levelRafRef.current);
    micStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    micStreamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    voiceWrapRef.current?.style.setProperty("--voice-level", "0");
    setIsRecording(false);
  }, []);

  // Ship the finalized utterance. If the agent is mid-turn, park it — the
  // effect below sends it the moment the stream settles (the user keeps
  // talking through 30s+ agent turns without losing anything).
  const sendUtterance = useCallback(() => {
    const raw = finalizedRef.current.trim();
    finalizedRef.current = "";
    setDraft("");
    if (!raw) return;
    const text = lang === "zh" ? raw : fixSpeechTerms(raw);
    if (isThinkingRef.current) pendingUtteranceRef.current = text;
    else void submit(text);
  }, [lang, submit]);
  useEffect(() => {
    if (!isThinking && pendingUtteranceRef.current) {
      const text = pendingUtteranceRef.current;
      pendingUtteranceRef.current = null;
      void submit(text);
    }
  }, [isThinking, submit]);

  const startVoice = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) {
      appendNote(t("voiceUnsupported"));
      return;
    }
    // Mic stream first: one permission prompt powers the amplitude analyser
    // and keeps the device warm across recognition restarts.
    try {
      micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      appendNote(t("voiceDenied"));
      return;
    }
    wantVoiceRef.current = true;
    finalizedRef.current = "";
    setIsRecording(true);
    setMode("expanded");
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(micStreamRef.current).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!wantVoiceRef.current) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const d = (buf[i] - 128) / 128;
          sum += d * d;
        }
        const rms = Math.sqrt(sum / buf.length);
        voiceWrapRef.current?.style.setProperty(
          "--voice-level",
          Math.min(1, rms * 6).toFixed(3),
        );
        levelRafRef.current = requestAnimationFrame(tick);
      };
      levelRafRef.current = requestAnimationFrame(tick);
    } catch {
      /* rings fall back to the constant ripple */
    }

    const run = () => {
      if (!wantVoiceRef.current) return;
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      // Follows the UI language toggle: Traditional Chinese speech when 繁中.
      rec.lang = lang === "zh" ? "zh-TW" : "en-US";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (e: any) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalizedRef.current += r[0].transcript;
          else interim += r[0].transcript;
        }
        const shown = (finalizedRef.current + interim).trim();
        // English speech recognition mangles trading acronyms — repair them.
        setDraft(lang === "zh" ? shown : fixSpeechTerms(shown));
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        if (finalizedRef.current.trim() && !interim) {
          silenceTimerRef.current = setTimeout(sendUtterance, 1600);
        }
      };
      rec.onend = () => {
        if (!wantVoiceRef.current) return;
        const now = Date.now();
        if (now - lastRecEndRef.current < 1000) {
          // Two instant deaths in a row = the service is refusing us
          // (throttle) — exit cleanly instead of spinning.
          stopVoice();
          appendNote(t("voiceEnded"));
          return;
        }
        lastRecEndRef.current = now;
        try {
          run();
        } catch {
          stopVoice();
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = (e: any) => {
        if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
          stopVoice();
          appendNote(t("voiceDenied"));
        }
        // "no-speech"/"aborted"/"network" fall through to onend → restart.
      };
      recognitionRef.current = rec;
      rec.start();
    };
    run();
  }, [lang, appendNote, t, sendUtterance, stopVoice]);

  const toggleVoice = useCallback(() => {
    if (isRecording) stopVoice();
    else void startVoice();
  }, [isRecording, startVoice, stopVoice]);
  // ESC exits voice mode (parent keydown + the iframe-forwarded cg:escape);
  // unmount tears the mic down so the tab never keeps recording.
  useEffect(() => {
    if (!isRecording) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") stopVoice();
    };
    const onEsc = () => stopVoice();
    window.addEventListener("keydown", onKey);
    window.addEventListener("cg:escape", onEsc);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("cg:escape", onEsc);
    };
  }, [isRecording, stopVoice]);
  useEffect(
    () => () => {
      if (wantVoiceRef.current) stopVoice();
    },
    [stopVoice],
  );

  // Live chart-state tags shown under the input ("RSI active", "3 lines drawn").
  const [chartTags, setChartTags] = useState<Array<{ label: string; ids: string[] }>>([]);
  useEffect(() => {
    const SHORT: Record<string, string> = {
      "Relative Strength Index": "RSI",
      "Moving Average Exponential": "EMA",
      "Moving Average": "MA",
      "Bollinger Bands": "BB",
      "Average Directional Index": "ADX",
      "Average True Range": "ATR",
      "Donchian Channels": "Donchian",
      "Liquidation Heatmap": "Liq. Heatmap",
      "Order-flow Footprint": "Footprint",
      MACD: "MACD",
      VWAP: "VWAP",
      Volume: "VOL",
    };
    const KIND: Record<string, string> = {
      horizontal_line: "line",
      trend_line: "line",
      ray: "line",
      extended_line: "line",
      rectangle: "zone",
      brush: "brush stroke",
      fib_retracement: "fib",
    };
    const tick = () => {
      const ctx = getChartContext();
      if (!ctx) return;
      const tags: Array<{ label: string; ids: string[] }> = [];
      const indGroups = new Map<string, string[]>();
      for (const ind of ctx.indicators) {
        const short = SHORT[ind.name] ?? ind.name.split(" ")[0];
        indGroups.set(short, [...(indGroups.get(short) ?? []), ind.id]);
      }
      for (const [name, ids] of indGroups)
        tags.push({ label: `${ids.length > 1 ? `${ids.length}× ` : ""}${name} active`, ids });
      const drawGroups = new Map<string, string[]>();
      for (const d of ctx.drawings) {
        const kind = KIND[d.kind] ?? "drawing";
        drawGroups.set(kind, [...(drawGroups.get(kind) ?? []), d.id]);
      }
      for (const [kind, ids] of drawGroups)
        tags.push({ label: `${ids.length} ${kind}${ids.length > 1 ? "s" : ""} drawn`, ids });
      setChartTags(tags);
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [getChartContext]);

  const removeTag = useCallback(
    (tag: { label: string; ids: string[] }) => {
      setChartTags((prev) => prev.filter((t) => t.label !== tag.label));
      void dispatchChartAction({ action: "remove_entities", ids: tag.ids });
    },
    [dispatchChartAction],
  );

  const clearAllTags = useCallback(() => {
    const ids = chartTags.flatMap((t) => t.ids);
    setChartTags([]);
    void dispatchChartAction({ action: "remove_entities", ids });
  }, [chartTags, dispatchChartAction]);

  // Focusing the chat means the user is done drawing — unequip the tool.
  const unequipDrawTool = useCallback(() => {
    if (activeTool) {
      setActiveTool(null);
      void dispatchChartAction({ action: "select_tool", tool: "cursor" });
    }
  }, [activeTool, dispatchChartAction]);

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      requireAuth(() => void send());
    }
  };

  const displayMessages = messages.map((m) =>
    m.id === "w1" ? { ...m, text: t("welcome") } : m,
  );
  const peekMessages = displayMessages.slice(-2);
  const earlierCount = displayMessages.length - peekMessages.length;

  return (
    <>
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="backdrop"
            className="absolute inset-0 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              // Kept light: it stacks under the glass panel — heavier values
              // multiply into a pitch-black chat area over a dark chart.
              background:
                "linear-gradient(to top, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.15) 40%, transparent 70%)",
            }}
            onClick={() => setMode("idle")}
          />
        )}
      </AnimatePresence>

      <div
        className={`absolute bottom-[4.25rem] left-1/2 z-50 w-[min(640px,calc(100%-3rem))] -translate-x-1/2 transition-opacity duration-150 ${
          tvPopupOpen ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <AnimatePresence>
          {(peeking || (busyIndicator && !expanded)) && (
            <motion.div
              key="peek"
              className="absolute bottom-full left-0 right-0 mb-3 cursor-pointer select-none"
              initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
              animate={{ opacity: busyIndicator ? 0.95 : 0.72, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: 8, filter: "blur(4px)" }}
              transition={{ duration: 0.18, ease: EASE }}
              style={{
                // Dark gradient backdrop (transparent up top → black at the
                // bottom) so the preview text reads over the chart; the mask
                // fades the whole thing out toward the top.
                background:
                  "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.35) 45%, rgba(0,0,0,0.78) 100%)",
                maskImage: "linear-gradient(to top, black 55%, transparent 100%)",
                WebkitMaskImage: "linear-gradient(to top, black 55%, transparent 100%)",
              }}
              onClick={() => {
                setMode("expanded");
                inputRef.current?.focus();
              }}
            >
              {/* Height-capped, bottom-anchored: long agent replies must not
                  fill the screen when the chat is just peeking. */}
              <div className="flex max-h-44 flex-col justify-end gap-3 overflow-hidden px-2 pb-2 pt-8">
                {earlierCount > 0 && (
                  <div className="self-center rounded-full bg-white/[0.08] px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-white/70">
                    {earlierCount} {t("earlier")}
                  </div>
                )}
                {peekMessages.map((m) => (
                  <MessageRow key={m.id} message={m} />
                ))}
                {busyIndicator && (
                  <div className="flex items-center gap-1.5 px-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-lime-400/80 [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-lime-400/80 [animation-delay:120ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-lime-400/80 [animation-delay:240ms]" />{detecting && (<span className="font-mono text-[10px] uppercase tracking-wider text-lime-300/80">{t("detectingLabel")}</span>)}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {expanded && (
            <motion.div
              key="panel"
              className="absolute bottom-full left-0 right-0 mb-3 rounded-2xl border border-white/10 p-3"
              style={{
                background: "var(--glass-fill)",
                backdropFilter: "blur(28px)",
                WebkitBackdropFilter: "blur(28px)",
              }}
              initial={{ opacity: 0, y: 12, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: 10, filter: "blur(4px)" }}
              transition={{ duration: 0.22, ease: EASE }}
            >
              <div className="flex items-center justify-between px-1 pb-2">
                <div className="flex items-center gap-2">
                  <TriangleIcon className="h-2.5 w-2.5 text-lime-400" />
                  <span className="font-mono text-[11px] uppercase tracking-widest text-white/80">
                    {t("superiorAI")}
                  </span>
                  <span className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-[rgba(163,230,53,0.10)] px-2 py-0.5 font-mono text-[10px] text-lime-300/90">
                    <span className="h-1 w-1 animate-pulse rounded-full bg-lime-400" />
                    {t("chatReading")}
                  </span>
                </div>
                <button
                  className="rounded-full p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                  onClick={() => setMode("idle")}
                  aria-label="Collapse chat"
                >
                  <ChevronDownIcon className="h-4 w-4" />
                </button>
              </div>

              <div ref={scrollRef} className="max-h-[52vh] overflow-y-auto px-1 pb-1">
                <div className="flex flex-col gap-3.5">
                  {displayMessages.map((m) => (
                    <motion.div
                      key={m.id}
                      initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      transition={{ duration: 0.2, ease: EASE }}
                    >
                      <MessageRow
                        message={m}
                        onFollowUp={
                          !isThinking &&
                          m.id === messages[messages.length - 1]?.id
                            ? followUp
                            : undefined
                        }
                        onAgentNote={postAgentNote}
                      />
                    </motion.div>
                  ))}
                  {busyIndicator && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center gap-1.5 px-1 text-white/50"
                    >
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-lime-400/80 [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-lime-400/80 [animation-delay:120ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-lime-400/80 [animation-delay:240ms]" />{detecting && (<span className="font-mono text-[10px] uppercase tracking-wider text-lime-300/80">{t("detectingLabel")}</span>)}
                    </motion.div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {pendingClear && (
          <div
            className="mb-2 rounded-2xl border border-red-400/25 p-3 backdrop-blur-md"
            style={{ background: "var(--glass-strong-fill)" }}
          >
            <p className="text-center text-[12.5px] leading-relaxed text-white/85">
              {t("clearConfirm")}
            </p>
            <div className="mt-2.5 flex justify-center gap-2">
              <button
                onClick={() => setPendingClear(false)}
                className="rounded-full bg-white/10 px-3.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-white/70 transition-colors hover:bg-white/15"
              >
                {t("clearNo")}
              </button>
              <button
                onClick={() => void clearChat()}
                className="rounded-full bg-red-400 px-3.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-black transition-opacity hover:opacity-85"
              >
                {t("clearYes")}
              </button>
            </div>
          </div>
        )}

        <div
          className={`liquid-glass-strong flex items-center gap-2 rounded-full py-2 pl-5 pr-2 transition-opacity duration-300 hover:opacity-100 focus-within:opacity-100 ${expanded ? "opacity-100" : "opacity-60"}`}
          style={{
            background: "var(--glass-strong-fill)",
            backdropFilter: "blur(28px)",
            WebkitBackdropFilter: "blur(28px)",
          }}
        >
          <TriangleIcon className="h-3 w-3 shrink-0 text-lime-400/90" />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onInputKeyDown}
            onFocus={() => {
              setMode("expanded");
              unequipDrawTool();
            }}
            // Detection and chat race for the same chart context, so send()
            // already refuses while a detect is running. The input stayed
            // enabled though, so it accepted typing and swallowed Enter — it
            // looked live and did nothing. Disable it to match the behaviour.
            disabled={detecting}
            // Voice mode owns the input: the live transcript renders here
            // and manual edits are off until the user exits (Enter still
            // force-sends the current utterance).
            readOnly={isRecording}
            placeholder={
              isRecording
                ? t("voiceListening")
                : detecting
                  ? t("detectBlocked")
                  : pendingClear
                    ? t("clearConfirm")
                    : t("placeholder")
            }
            // 16px on mobile stops iOS Safari from zooming the viewport on
            // focus (it zooms any input under 16px); desktop keeps 14px.
            className={`min-w-0 flex-1 bg-transparent py-1.5 text-[16px] text-white focus:outline-none sm:text-[14px] ${
              isRecording
                ? "caret-transparent placeholder:text-lime-300/60"
                : "placeholder:text-white/40"
            }`}
          />
          {/* Drawing tool split button: [icon of last-used tool | chevron].
              The chevron opens a portaled picker (escapes the bar's clipping
              containers); the main button toggles the remembered tool. */}
          <div ref={toolSplitRef} className="flex shrink-0 items-center">
            <button
              onClick={() => void toggleTool(lastDrawTool)}
              aria-label={activeTool === lastDrawTool ? "Exit draw mode" : "Draw on chart"}
              title={t(DRAW_TOOLS.find((d) => d.id === lastDrawTool)!.labelKey)}
              className={`grid h-9 w-9 place-items-center rounded-l-full p-1.5 transition-all duration-300 ${
                activeTool !== null && activeTool === lastDrawTool
                  ? "bg-lime-400 text-black"
                  : "bg-white/[0.07] text-white/70 hover:bg-white/[0.14] hover:text-white"
              }`}
            >
              {(() => {
                const Icon = DRAW_TOOLS.find((d) => d.id === lastDrawTool)!.Icon;
                return <Icon className="h-4 w-4" />;
              })()}
            </button>
            <button
              onClick={(e) => {
                if (toolMenuOpen) {
                  setToolMenuPos(null);
                  return;
                }
                // Opening the picker: same anti-distraction rule as arming a
                // tool — close any peek and cancel a pending hover-open.
                if (enterTimerRef.current) {
                  clearTimeout(enterTimerRef.current);
                  enterTimerRef.current = null;
                }
                setMode((m) => (m === "peek" ? "idle" : m));
                const r = e.currentTarget.getBoundingClientRect();
                setToolMenuPos({
                  right: Math.max(8, window.innerWidth - r.right),
                  bottom: window.innerHeight - r.top + 8,
                });
              }}
              aria-label={t("toolPick")}
              aria-expanded={toolMenuOpen}
              title={t("toolPick")}
              className={`grid h-9 w-5 place-items-center rounded-r-full border-l border-black/40 transition-all duration-300 ${
                toolMenuOpen
                  ? "bg-white/[0.18] text-white"
                  : "bg-white/[0.07] text-white/50 hover:bg-white/[0.14] hover:text-white"
              }`}
            >
              <ChevronDownIcon
                className={`h-3 w-3 transition-transform duration-200 ${toolMenuOpen ? "" : "rotate-180"}`}
              />
            </button>
          </div>
          {toolMenuPos &&
            typeof document !== "undefined" &&
            createPortal(
              <div
                ref={toolMenuRef}
                className="liquid-glass rounded-xl p-1 shadow-2xl"
                style={{
                  position: "fixed",
                  right: toolMenuPos.right,
                  bottom: toolMenuPos.bottom,
                  zIndex: 2147482500,
                  width: 176,
                  background: "var(--menu-fill)",
                  backdropFilter: "blur(28px)",
                  WebkitBackdropFilter: "blur(28px)",
                }}
              >
                {DRAW_TOOLS.map(({ id, labelKey, Icon }) => (
                  <button
                    key={id}
                    onClick={() => pickDrawTool(id)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[12.5px] text-white/85 transition-colors hover:bg-white/[0.08]"
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {t(labelKey)}
                    {activeTool === id && (
                      <span className="ml-auto text-lime-300">✓</span>
                    )}
                  </button>
                ))}
                {/* Chat actions. Same commands as /list and /clear — the menu
                    exists so they are discoverable without knowing to type a
                    slash. */}
                <div className="my-1 border-t border-white/10" />
                <button
                  onClick={() => {
                    setToolMenuPos(null);
                    void openConvList();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[12.5px] text-white/85 transition-colors hover:bg-white/[0.08]"
                >
                  <ChatsIcon className="h-4 w-4 shrink-0" />
                  {t("convListOpen")}
                </button>
                <button
                  onClick={() => {
                    setToolMenuPos(null);
                    setMode("expanded");
                    setPendingClear(true);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[12.5px] text-white/85 transition-colors hover:bg-white/[0.08]"
                >
                  <NewChatIcon className="h-4 w-4 shrink-0" />
                  {t("convNew")}
                </button>
              </div>,
              document.body,
            )}
          {convListOpen && (
            <ConversationList
              rows={convRows}
              currentId={conversationIdRef.current}
              onPick={(row) => void switchConversation(row)}
              onClose={() => setConvListOpen(false)}
            />
          )}
          {/* Voice mode toggle. While live: concentric ripple rings + the
              button breathes with mic amplitude (--voice-level, set from
              the analyser rAF — no re-renders). */}
          <div ref={voiceWrapRef} className="relative shrink-0">
            {isRecording && (
              <>
                <span className="cg-voice-ring" aria-hidden />
                <span className="cg-voice-ring cg-voice-ring--late" aria-hidden />
              </>
            )}
            <button
              onClick={toggleVoice}
              aria-label={isRecording ? "Exit voice mode" : "Start voice mode"}
              aria-pressed={isRecording}
              className={`relative grid h-9 w-9 place-items-center rounded-full p-1.5 transition-colors duration-300 ${
                isRecording
                  ? "cg-voice-live bg-lime-400 text-black"
                  : "bg-[rgba(163,230,53,0.14)] text-lime-300 hover:bg-[rgba(163,230,53,0.25)]"
              }`}
            >
              <MicIcon className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>

        {(chartTags.length > 0 || contextPct !== null) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {chartTags.map((t) => (
              <span
                key={t.label}
                className="group inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/60 px-2.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-white/55 backdrop-blur-sm"
              >
                {t.label}
                <button
                  onClick={() => removeTag(t)}
                  aria-label={`Remove ${t.label}`}
                  className="text-white/35 transition-colors hover:text-red-400"
                >
                  ×
                </button>
              </span>
            ))}
            {chartTags.length > 0 && (
              <button
                onClick={clearAllTags}
                className="rounded-full border border-red-400/25 bg-black/60 px-2.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-red-300/80 backdrop-blur-sm transition-colors hover:bg-red-400/15"
              >
                {t("clearAll")}
              </button>
            )}
            {contextPct !== null && (
              <span
                title={t("contextTip")}
                className={`ml-auto font-mono text-[9.5px] uppercase tracking-wider ${
                  contextPct >= 80 ? "text-amber-300/80" : "text-white/40"
                }`}
              >
                {contextPct}% {t("contextLabel")}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
