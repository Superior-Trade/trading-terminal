# Indicator Tier List + Confluence-Aware Dropdown — Plan

## Goal
Turn the chart's "Indicators" dropdown from Superior/TradingView **categories** into a
**tier-ranked** list (S→D), keep the ✦ Superior-exclusive star, add **real
React-component tooltips** that explain *why* each indicator earns its tier and — the
key idea — that many indicators are **weak alone but strong in confluence**. Feed the
same taxonomy to the AI agent, and add the missing high-value indicators we can build
on data we already stream.

## What we already have (don't rebuild)
- `lib/tier-rubric.ts` — the agent's *setup-scoring* rubric. It ALREADY encodes the
  weak-alone/confluence principle ("independent confluence across DIFFERENT classes;
  RSI+MACD+Stoch = one signal; count redundant tools once"). The new work is a
  *per-indicator* taxonomy + UI, reconciled with this rubric (same class language).
- Superior overlays: Liquidation Heatmap, Order-flow Footprint, positioning heatmap.
- Chart context provider already reports active studies (name + inputs) to the agent.

## 1. Data — `lib/indicator-tiers.ts` (new)
`INDICATOR_TIERS: { name, tier: 'S'|'A'|'B'|'C'|'D', class, whyTier, weakAlone,
bestPairedWith: {name, synergy}[], superior?: boolean }[]` — seeded from the research
(48 indicators) reconciled with `tier-rubric.ts`. Classes: structure, momentum,
volatility/regime, volume/flow, trend, derivatives/positioning.
Helpers: `tierMeta(name)` (normalized lookup), `TIER_ORDER`, `classColor()`.
`INDICATOR_TIER_DIGEST` — compact text for the agent prompt.

Highlights from the research (standalone tiers):
- **A:** VWAP, Volume Profile/VPVR, + our two Superior overlays (Liq Heatmap, Footprint).
- **B:** Open Interest, Funding, ADX, ATR, Bollinger/Keltner, Ichimoku, Supertrend,
  Donchian, Pivots, Volume. (Most are *weak-alone* = context/filters.)
- **C:** RSI, MACD, Stochastic, CCI, Williams %R, the MA family, PSAR, OBV, MFI, CMF, A/D.
- **D:** StochRSI, ROC, Momentum, TRIX, DPO, ZigZag, Ease of Movement, StdDev.

## 2. Dropdown reorg (Fork B — architecture)
Rows grouped by tier headers (S…D, color-coded), Superior items pinned within their
tier with ✦ + "Superior exclusive". Each row: `[✦?] name … [class dot] [tier badge]`
plus checkbox/spinner (toggleable overlays) or click-to-add (TV studies). One search
box across all tiers. Stays open on toggle (as today). Reconcile against
`getStudiesList()` at build so tier data maps to real study names (log unmatched).

**The architectural fork:** today the button + menu are hand-rolled DOM *inside the TV
iframe*, which is why the tooltip is a raw `title=""`. A real React tooltip needs the
panel in the parent document. Options in the question below.

## 3. Tooltip component (Fork A — presentation)
New `<IndicatorTooltip>` React component (hover/focus, positioned, theme-aware) replaces
`title`. Shows: tier badge + name, class, `whyTier`, the confluence framing, and
`bestPairedWith` chips. How we present "weak alone / strong in combo" is the question below.

## 4. Agent integration
- Enrich the chart context: tag each active indicator with tier + class; compute
  independent-class count and same-class redundancy.
- Inject `INDICATOR_TIER_DIGEST` into chat + detect prompts (beside `TIER_RUBRIC`) and
  pass active-indicator tiers/classes so the agent can say e.g. "you have 3 momentum
  oscillators = one real signal; add a volume/structure class for real confluence."
- Extend evals with a couple of confluence-reasoning cases.

## 5. Missing indicators (Fork C — what to build)
All of these run on data we already stream/store (no new vendor cost):
- **Liquidation-magnet lines** — top-N clusters from existing `liq_levels` as ranked
  lines w/ notional labels. (easy, reuse collector data) — Superior ✦
- **CVD (cumulative volume delta)** — true taker delta from the HL trades WS. (easy) — ✦
- **Open Interest overlay** — HL info API, sub-pane. (easy) — ✦
- **Funding-rate overlay/heatmap** — HL funding API, sub-pane. (easy) — ✦
- **Taker buy/sell ratio + tape speed** — HL WS rolling window. (easy) — ✦
- Built-in but worth surfacing: **Anchored VWAP** (verify in catalog), **Volume Profile**
  (verify Charting Library license tier — it's a separately-licensed add-on).
Each added indicator gets a tier entry (+✦ for Superior-built).
Out of scope now: cross-exchange aggregated CVD/OI (needs multi-venue feeds), L2
order-book/Bookmap heatmap (needs L2 ingest), auto delta-divergence/absorption (hard to tune).

## Sequencing
1. `indicator-tiers.ts` data + digest.
2. Lift dropdown to React (per Fork B) + tier grouping + `<IndicatorTooltip>` (per Fork A).
3. Agent context + prompt injection + evals.
4. Missing indicators (per Fork C), phased — liq-magnet + CVD first (reuse data).

## Verification
`getStudiesList()` reconciliation logged; typecheck; evals; manual dropdown + tooltip
a11y pass (keyboard focus, theme light/dark). No new HyperTracker calls (rate-safe).
