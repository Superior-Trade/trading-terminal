// Per-indicator tier taxonomy — powers the tier-ranked indicator dropdown AND
// feeds the AI agent so its confluence reasoning matches what the user sees.
//
// Reconciled with lib/tier-rubric.ts (the setup-scoring rubric): same class
// vocabulary, same core idea — INDEPENDENT confluence across DIFFERENT classes
// is what carries edge; same-class tools are redundant and count once.
//
// Two tiers per indicator:
//   tier       — quality STANDALONE (how much edge it carries used alone).
//   pairedTier — realistic ceiling IN CONFLUENCE (weak-alone tools that become
//                valuable when combined with a different class). Omitted when
//                it equals `tier` (already-strong anchors don't "level up").
// The dropdown renders "C → A" when they differ, a single badge when they don't.
//
// Synthesized 2026-07 from quant robustness / walk-forward work, regime-filter
// studies, order-flow theory, and crypto-perp microstructure (funding/OI/liq).

export type Tier = "S" | "A" | "B" | "C" | "D";
export type IndicatorClass =
  | "structure"
  | "momentum"
  | "volatility/regime"
  | "volume/flow"
  | "trend"
  | "derivatives/positioning";

export interface IndicatorTier {
  /** Matches TradingView getStudiesList() display names where applicable. */
  name: string;
  tier: Tier;
  /** Ceiling in good confluence; omit when identical to `tier`. */
  pairedTier?: Tier;
  class: IndicatorClass;
  /** Superior-exclusive overlay we built (gets the ✦ star). */
  superior?: boolean;
  /** Materially weak/misleading alone; valuable only in confluence. */
  weakAlone: boolean;
  /** One line: why this STANDALONE tier. */
  why: string;
  /** zh translation of `why` (falls back to English when absent). */
  whyZh?: string;
  /** One line: how it earns its higher tier IN CONFLUENCE (undefined if not weakAlone). */
  combo?: string;
  /** zh translation of `combo`. */
  comboZh?: string;
  /** Names it combines best with (rendered as chips). */
  pairs: string[];
}

export const TIER_ORDER: Tier[] = ["S", "A", "B", "C", "D"];

export const CLASS_COLOR: Record<IndicatorClass, string> = {
  structure: "#7aa2f7",
  momentum: "#bb9af7",
  "volatility/regime": "#e0af68",
  "volume/flow": "#9ece6a",
  trend: "#2ac3de",
  "derivatives/positioning": "#f7768e",
};

// Ordered roughly best→worst within the source; the UI regroups by tier.
export const INDICATOR_TIERS: IndicatorTier[] = [
  // ── Superior-exclusive overlays (derivatives-native → can unlock S setups) ──
  {
    name: "Liquidation Heatmap",
    tier: "A",
    pairedTier: "S",
    class: "derivatives/positioning",
    superior: true,
    weakAlone: false,
    why: "Real Hyperliquid liquidation clusters are documented price magnets and stop-run targets — a forward-looking, hard-to-fake edge.",
    combo: "With structure + flow confirmation it completes the multi-class picture an S setup needs.",
    pairs: ["Order-flow Footprint", "Volume Weighted Average Price", "Open Interest"],
  },
  {
    name: "Order-flow Footprint",
    tier: "A",
    pairedTier: "S",
    class: "volume/flow",
    superior: true,
    weakAlone: false,
    why: "Aggressive buy/sell per price level exposes absorption, exhaustion and initiative that OHLCV hides.",
    combo: "Read against a level (VP/VWAP/liq cluster) it turns context into a timed, S-grade trigger.",
    pairs: ["Volume Profile", "Liquidation Heatmap", "Volume Weighted Average Price"],
  },
  {
    name: "Superior CVD",
    tier: "A",
    pairedTier: "S",
    class: "volume/flow",
    superior: true,
    weakAlone: false,
    why: "Cumulative aggressive buy-minus-sell volume from the live Hyperliquid tape, drawn as green/red delta candles (wicks = intrabar delta extremes, so absorption is visible) — CVD/price divergence exposes failed pushes OHLCV cannot show. (History accrues from when a coin's order-flow recording started.)",
    combo: "CVD divergence AT a structural level (VWAP/VP node/liq cluster) is a timed reversal trigger; CVD confirmation strengthens breakouts.",
    pairs: ["Volume Weighted Average Price", "Liquidation Heatmap", "Volume Profile Visible Range"],
  },
  {
    name: "Superior Volume Delta",
    tier: "B",
    pairedTier: "A",
    class: "volume/flow",
    superior: true,
    weakAlone: true,
    why: "Per-bar aggressive buy-minus-sell volume as a zero-anchored green/red histogram from the live tape — shows which side initiated each bar, but a single bar's delta is noise without context.",
    combo: "A delta flip or outsized delta bar AT a level (VWAP/VP node/liq cluster), or delta disagreeing with the candle's direction, times entries the way footprint traders read exhaustion.",
    pairs: ["Superior CVD", "Volume Weighted Average Price", "Liquidation Heatmap"],
  },

  // ── A — strong standalone anchors ──
  {
    name: "Volume Weighted Average Price",
    tier: "A",
    class: "volume/flow",
    weakAlone: false,
    why: "A session-anchored fair-value line institutions and algos actually reference — robust intraday mean-reversion and trend context.",
    pairs: ["Volume Profile", "Relative Strength Index", "Order-flow Footprint"],
  },
  {
    name: "Volume Profile Visible Range",
    tier: "A",
    class: "structure",
    weakAlone: false,
    why: "Maps accepted (VPOC/HVN) vs rejected (LVN) price — durable structural levels that survive walk-forward better than any oscillator.",
    pairs: ["Volume Weighted Average Price", "Order-flow Footprint", "Relative Strength Index"],
  },
  {
    name: "Volume Profile",
    tier: "A",
    class: "structure",
    weakAlone: false,
    why: "Session/fixed-range volume-by-price defines value areas and untested nodes; redundant with VPVR — count one.",
    pairs: ["Volume Weighted Average Price", "Pivot Points Standard"],
  },

  // ── B — context/filters: weak alone, lift a setup in confluence ──
  {
    name: "Open Interest",
    tier: "B",
    pairedTier: "A",
    class: "derivatives/positioning",
    weakAlone: true,
    why: "Native perp positioning that separates real conviction (OI+price up) from short-covering squeezes — but it is context, not a timed signal.",
    combo: "Rising OI into a liq cluster or extreme funding flags a crowded, flush-prone book.",
    pairs: ["Liquidation Heatmap", "Funding Rate", "Order-flow Footprint"],
  },
  {
    name: "Funding Rate",
    tier: "B",
    pairedTier: "A",
    class: "derivatives/positioning",
    weakAlone: true,
    why: "A direct crowd/carry gauge unique to perps; sustained extremes precede squeezes, but timing is loose and it whipsaws in trends.",
    combo: "Extreme funding + rising OI + a liq cluster identifies which side gets liquidated.",
    pairs: ["Open Interest", "Liquidation Heatmap"],
  },
  {
    name: "Average Directional Index",
    tier: "B",
    pairedTier: "A",
    class: "volatility/regime",
    weakAlone: true,
    why: "A genuine regime filter — quantifies trend strength — but lags and gives no direction alone.",
    combo: "Gate trend systems (Supertrend/MACD) to confirmed trends; suppress mean-reversion in strong trends.",
    pairs: ["Supertrend", "Bollinger Bands", "Moving Average Convergence Divergence"],
  },
  {
    name: "Choppiness Index",
    tier: "B",
    pairedTier: "A",
    class: "volatility/regime",
    weakAlone: true,
    why: "A dedicated trend-vs-range classifier; purely a filter with no standalone signal.",
    combo: "Only trust breakouts when it reads trending; only fade oscillators when it reads range.",
    pairs: ["Donchian Channels", "Relative Strength Index"],
  },
  {
    name: "Average True Range",
    tier: "B",
    pairedTier: "A",
    class: "volatility/regime",
    weakAlone: true,
    why: "Not directional, but the backbone of volatility-normalized stops and sizing — where most robust edge actually lives.",
    combo: "Sets structural stop distance and squeeze detection alongside any directional thesis.",
    pairs: ["Supertrend", "Keltner Channels", "Bollinger Bands"],
  },
  {
    name: "Bollinger Bands",
    tier: "B",
    pairedTier: "A",
    class: "volatility/regime",
    weakAlone: true,
    why: "Flags volatility squeezes and statistical extremes, but band tags are not reversals in trends and it repaints its mean.",
    combo: "Band extreme on an LVN, or a squeeze fired with regime + volume, becomes a real setup.",
    pairs: ["Relative Strength Index", "Average Directional Index", "Volume Profile"],
  },
  {
    name: "Keltner Channels",
    tier: "B",
    pairedTier: "A",
    class: "volatility/regime",
    weakAlone: true,
    why: "Smoother, less whippy than Bollinger for breakouts, but measures the same volatility-envelope concept — largely redundant.",
    combo: "BB-inside-Keltner is the classic squeeze; confirm channel breaks with trend strength.",
    pairs: ["Bollinger Bands", "Average Directional Index"],
  },
  {
    name: "Ichimoku Cloud",
    tier: "B",
    pairedTier: "A",
    class: "trend",
    weakAlone: true,
    why: "A self-contained trend/structure system with decent dynamic S/R, but its lagging lines fire late and chop in ranges.",
    combo: "A Kumo break confirmed by momentum + volume is a clean continuation trigger.",
    pairs: ["Relative Strength Index", "Volume"],
  },
  {
    name: "Supertrend",
    tier: "B",
    pairedTier: "A",
    class: "trend",
    weakAlone: true,
    why: "A clean ATR trailing regime line that keeps you on the right side of strong trends — but whipsaws relentlessly in ranges.",
    combo: "Take flips only in an ADX-confirmed trend, aligned with the VWAP side.",
    pairs: ["Average Directional Index", "Volume Weighted Average Price"],
  },
  {
    name: "Donchian Channels",
    tier: "B",
    pairedTier: "A",
    class: "structure",
    weakAlone: true,
    why: "The classic turtle breakout/structure tool; still shows edge in trending crypto but false-breaks in chop.",
    combo: "A break with a volume expansion in a trending regime is a high-quality breakout.",
    pairs: ["Choppiness Index", "Volume"],
  },
  {
    name: "Pivot Points Standard",
    tier: "B",
    pairedTier: "A",
    class: "structure",
    weakAlone: true,
    why: "Deterministic, non-repainting levels many intraday traders watch (mild self-fulfilling) — but arbitrary math with no flow behind them.",
    combo: "A pivot that lines up with VWAP/VPOC, read via footprint reaction, becomes tradable.",
    pairs: ["Volume Weighted Average Price", "Order-flow Footprint"],
  },
  {
    name: "Volume",
    tier: "B",
    pairedTier: "A",
    class: "volume/flow",
    weakAlone: true,
    why: "Essential participation context that validates or rejects a move — but directionless alone; it must confirm a price event.",
    combo: "A breakout or impulse on a volume expansion (vs an unsupported low-volume break) is the confirmation.",
    pairs: ["Donchian Channels", "Volume Profile", "Order-flow Footprint"],
  },

  // ── C — marginal alone; can reach B in confluence ──
  {
    name: "Relative Strength Index",
    tier: "C",
    pairedTier: "A",
    class: "momentum",
    weakAlone: true,
    why: "A lone RSI level or 50-cross is one of the most over-fit, regime-dependent signals in crypto — overbought stays overbought in trends.",
    combo: "Its one durable use is divergence AT a level — a VPOC, VWAP band, or liquidation cluster.",
    pairs: ["Volume Profile", "Volume Weighted Average Price", "Liquidation Heatmap"],
  },
  {
    name: "Moving Average Convergence Divergence",
    tier: "C",
    pairedTier: "A",
    class: "momentum",
    weakAlone: true,
    why: "A lagging double-smoothed oscillator whose bare crossovers are late and whipsaw-prone.",
    combo: "Histogram divergence, gated to a trending regime and confirmed by volume, carries value.",
    pairs: ["Average Directional Index", "Volume"],
  },
  {
    name: "Stochastic",
    tier: "C",
    pairedTier: "B",
    class: "momentum",
    weakAlone: true,
    why: "Pins to extremes and fires constant false crosses in trends.",
    combo: "Useful only for range mean-reversion with tight regime gating.",
    pairs: ["Choppiness Index", "Bollinger Bands"],
  },
  {
    name: "Commodity Channel Index",
    tier: "C",
    pairedTier: "B",
    class: "momentum",
    weakAlone: true,
    why: "An unbounded momentum oscillator much like RSI/Stochastic with high false-signal rates; redundant — count once.",
    combo: "A regime-gated extreme at a structural node can mark a turn.",
    pairs: ["Average Directional Index", "Volume Profile"],
  },
  {
    name: "Williams %R",
    tier: "C",
    pairedTier: "B",
    class: "momentum",
    weakAlone: true,
    why: "Essentially an inverted Stochastic with the same OB/OS behavior; fully redundant with Stochastic and CCI.",
    combo: "An extreme reading at a VWAP band, in a range regime, is a mean-reversion cue.",
    pairs: ["Volume Weighted Average Price", "Choppiness Index"],
  },
  {
    name: "Awesome Oscillator",
    tier: "C",
    pairedTier: "B",
    class: "momentum",
    weakAlone: true,
    why: "A median-price momentum histogram — a smoothed proxy for MACD; zero-cross/twin-peaks are late and redundant.",
    combo: "Confirm a momentum shift with volume, aligned to trend direction.",
    pairs: ["Volume", "Supertrend"],
  },
  {
    name: "Ultimate Oscillator",
    tier: "C",
    pairedTier: "B",
    class: "momentum",
    weakAlone: true,
    why: "Blends three timeframes to cut single-period noise — marginally better, but still a lagging momentum tool.",
    combo: "Divergence at a structural node, in a confirmed range, is its best use.",
    pairs: ["Volume Profile", "Choppiness Index"],
  },
  {
    name: "Elder-Ray Index",
    tier: "C",
    pairedTier: "B",
    class: "momentum",
    weakAlone: true,
    why: "Bull/Bear Power vs an EMA is a reasonable divergence tool, but momentum-class and weak without trend context.",
    combo: "Gauge buying/selling pressure inside a trend, confirmed by volume spikes.",
    pairs: ["Ichimoku Cloud", "Volume"],
  },
  {
    name: "Money Flow Index",
    tier: "C",
    pairedTier: "B",
    class: "volume/flow",
    weakAlone: true,
    why: "A volume-weighted RSI — slightly better than bare RSI, but shares its regime dependence and overbought-in-trend failure.",
    combo: "Divergence at a VP node or VWAP band adds a participation dimension.",
    pairs: ["Volume Profile", "Volume Weighted Average Price"],
  },
  {
    name: "On Balance Volume",
    tier: "C",
    pairedTier: "B",
    class: "volume/flow",
    weakAlone: true,
    why: "A cumulative volume-flow proxy whose divergences sometimes lead price, but it treats whole-bar volume as one-directional.",
    combo: "Validate its implied flow with true per-level delta (footprint) at a VPOC.",
    pairs: ["Volume Profile", "Order-flow Footprint"],
  },
  {
    name: "Chaikin Money Flow",
    tier: "C",
    pairedTier: "B",
    class: "volume/flow",
    weakAlone: true,
    why: "Estimates accumulation from close-location within the bar — easily distorted by wicks, redundant with A/D and OBV.",
    combo: "Flow bias at value-area edges, confirmed by real footprint delta.",
    pairs: ["Volume Profile", "Order-flow Footprint"],
  },
  {
    name: "Accumulation/Distribution",
    tier: "C",
    pairedTier: "B",
    class: "volume/flow",
    weakAlone: true,
    why: "A close-location cumulative flow line useful for divergence, but its intrabar assumption is crude; redundant with OBV/CMF.",
    combo: "A/D divergence at a VPOC, cross-confirmed by RSI, is its best use.",
    pairs: ["Volume Profile", "Relative Strength Index"],
  },
  {
    name: "Volume Weighted Moving Average",
    tier: "C",
    pairedTier: "B",
    class: "volume/flow",
    weakAlone: true,
    why: "A volume-weighted MA — marginally more meaningful than a plain MA, but still lagging and redundant with EMA/VWAP.",
    combo: "A rolling bias line beneath a session VWAP anchor, gated by regime.",
    pairs: ["Volume Weighted Average Price", "Average Directional Index"],
  },
  {
    name: "Simple Moving Average",
    tier: "C",
    pairedTier: "B",
    class: "trend",
    weakAlone: true,
    why: "A pure lagging trend line; a single SMA or crossover is heavily curve-fit and slow.",
    combo: "Usable only as a coarse trend filter alongside a regime gate + fair value.",
    pairs: ["Average Directional Index", "Volume Weighted Average Price"],
  },
  {
    name: "Exponential Moving Average",
    tier: "C",
    pairedTier: "B",
    class: "trend",
    weakAlone: true,
    why: "Faster than SMA but still a lagging follower whose crosses whipsaw; redundant with the MA family — count once.",
    combo: "A trend-bias filter whose breaks are confirmed by volume.",
    pairs: ["Average Directional Index", "Volume"],
  },
  {
    name: "Moving Average Ribbon",
    tier: "C",
    pairedTier: "B",
    class: "trend",
    weakAlone: true,
    why: "Stacked MAs visualize trend alignment/compression nicely but add no info beyond a couple of MAs and share their lag.",
    combo: "Ribbon expansion confirmed by ADX and directional bias reads as a real trend.",
    pairs: ["Average Directional Index", "Volume Weighted Average Price"],
  },
  {
    name: "Hull Moving Average",
    tier: "C",
    pairedTier: "B",
    class: "trend",
    weakAlone: true,
    why: "Reduces lag and turns faster than standard MAs, but that responsiveness increases false flips in choppy perps.",
    combo: "Suppress flips in ranges (Chop gate) and dual-confirm with Supertrend.",
    pairs: ["Choppiness Index", "Supertrend"],
  },
  {
    name: "Parabolic SAR",
    tier: "C",
    pairedTier: "B",
    class: "trend",
    weakAlone: true,
    why: "A trailing-stop dot system that works in clean trends but flips constantly and bleeds in sideways regimes.",
    combo: "Trade flips only when ADX/Supertrend agree a trend is underway.",
    pairs: ["Average Directional Index", "Supertrend"],
  },
  {
    name: "Aroon",
    tier: "C",
    pairedTier: "B",
    class: "trend",
    weakAlone: true,
    why: "Measures how recently highs/lows occurred to gauge trend onset — a decent early hint, but noisy and redundant with ADX.",
    combo: "Confirm new-high/low breakouts and combine trend onset with ADX strength.",
    pairs: ["Donchian Channels", "Average Directional Index"],
  },
  {
    name: "Vortex Indicator",
    tier: "C",
    pairedTier: "B",
    class: "trend",
    weakAlone: true,
    why: "VI+/VI- crossovers identify trend changes but lag and whipsaw much like DMI — little unique edge over ADX.",
    combo: "Use ADX as a strength filter for its crosses, confirmed by volume.",
    pairs: ["Average Directional Index", "Volume"],
  },
  {
    name: "Linear Regression Curve",
    tier: "C",
    pairedTier: "B",
    class: "trend",
    weakAlone: true,
    why: "A least-squares smoothed trendline that fits recent price well but is backward-looking and repaints its endpoint.",
    combo: "Regression-channel deviations, normalized by ATR for stops, frame reversion.",
    pairs: ["Bollinger Bands", "Average True Range"],
  },
  {
    name: "Historical Volatility",
    tier: "C",
    pairedTier: "B",
    class: "volatility/regime",
    weakAlone: true,
    why: "Backward-looking realized vol, useful for sizing and regime classification, but a slow context metric with no timing edge.",
    combo: "Corroborate volatility state (with ATR) for stops and squeeze/expansion context.",
    pairs: ["Average True Range", "Bollinger Bands"],
  },

  // ── D — reject standalone; marginal even in confluence ──
  {
    name: "Stochastic RSI",
    tier: "D",
    pairedTier: "C",
    class: "momentum",
    weakAlone: true,
    why: "A double-derivative oscillator (Stochastic of RSI) so noisy it produces near-constant whipsaw in volatile perps.",
    combo: "Only inside a tight, confirmed range at a VPOC — and even then, marginal.",
    pairs: ["Choppiness Index", "Volume Profile"],
  },
  {
    name: "Rate of Change",
    tier: "D",
    pairedTier: "C",
    class: "momentum",
    weakAlone: true,
    why: "Raw price momentum with no smoothing or normalization — extremely noise-sensitive and structureless.",
    combo: "Only as a cross-confirm of another momentum tool on an impulse leg.",
    pairs: ["Moving Average Convergence Divergence", "Volume"],
  },
  {
    name: "Momentum",
    tier: "D",
    pairedTier: "C",
    class: "momentum",
    weakAlone: true,
    why: "The simplest price-difference oscillator, a cruder Rate of Change; redundant with the whole momentum family.",
    combo: "At best a trend-gated thrust confirmation.",
    pairs: ["Average Directional Index", "Volume"],
  },
  {
    name: "TRIX",
    tier: "D",
    pairedTier: "C",
    class: "momentum",
    weakAlone: true,
    why: "A triple-smoothed ROC that trades responsiveness for extreme lag — fires very late in fast perp moves.",
    combo: "Only trend-gated and volume-confirmed, and never over MACD.",
    pairs: ["Average Directional Index", "Volume"],
  },
  {
    name: "Detrended Price Oscillator",
    tier: "D",
    pairedTier: "C",
    class: "momentum",
    weakAlone: true,
    why: "Removes trend to expose cycles but is shifted and non-real-time by construction — a poor live signal.",
    combo: "Cycle lows at structural nodes, cross-confirmed by RSI.",
    pairs: ["Volume Profile", "Relative Strength Index"],
  },
  {
    name: "Ease of Movement",
    tier: "D",
    pairedTier: "C",
    class: "volume/flow",
    weakAlone: true,
    why: "Relates price change to volume to spotlight frictionless moves, but it is jumpy and low-signal in perps.",
    combo: "A frictionless-breakout confirmation alongside effort-vs-result volume.",
    pairs: ["Volume", "Donchian Channels"],
  },
  {
    name: "ZigZag",
    tier: "D",
    class: "structure",
    weakAlone: true,
    why: "Purely retrospective — it repaints its last leg until confirmed — so it is a hindsight drawing aid, never a live signal.",
    combo: "Annotation only: label swings against accepted value / pivots.",
    pairs: ["Volume Profile", "Pivot Points Standard"],
  },
  {
    name: "Standard Deviation",
    tier: "D",
    pairedTier: "C",
    class: "volatility/regime",
    weakAlone: true,
    why: "A raw dispersion measure — an input to volatility tools, not a tradable signal; redundant with Bollinger/ATR.",
    combo: "Cross-check a volatility regime it already underlies (Bollinger).",
    pairs: ["Bollinger Bands", "Average True Range"],
  },
];

// zh translations for tooltip prose (why/combo). Indicator NAMES/acronyms stay
// English inside the text; merged onto the entries at module load.
const INDICATOR_ZH: Record<string, { whyZh: string; comboZh?: string }> = {
  "Liquidation Heatmap": {
    whyZh: "真實的 Hyperliquid 清算集群是有據可查的價格磁吸位與獵停目標——具備前瞻性、難以偽造的優勢。",
    comboZh: "配合結構與資金流確認，即可補全 S 級配置所需的多維度畫面。",
  },
  "Order-flow Footprint": {
    whyZh: "每個價位的主動買/賣揭示了 OHLCV 無法體現的吸籌、衰竭與主動性。",
    comboZh: "對照某個關鍵位（VP/VWAP/清算集群）解讀，即可把背景資訊轉化為有時機的 S 級觸發。",
  },
  "Volume Weighted Average Price": {
    whyZh: "錨定於交易時段的公允價值線，機構與演算法真正會參考——日內均值回歸與趨勢背景都很穩健。",
  },
  "Volume Profile Visible Range": {
    whyZh: "標出被接受（VPOC/HVN）與被拒絕（LVN）的價位——比任何震盪指標都更能經受 walk-forward 檢驗的結構位。",
  },
  "Volume Profile": {
    whyZh: "按價位統計成交量（時段/固定區間），界定價值區與未回補節點；與 VPVR 重複——只算一個。",
  },
  "Open Interest": {
    whyZh: "原生的永續倉位數據，能區分真實信念（OI 與價格同漲）和空頭回補擠壓——但它是背景，不是有時機的訊號。",
    comboZh: "OI 上升逼近清算集群、或資金費率極端，都預示倉位擁擠、易被清洗的盤口。",
  },
  "Funding Rate": {
    whyZh: "永續獨有的群體情緒/持有成本標尺；持續極端往往先於擠壓，但擇時較鬆、趨勢中會反覆。",
    comboZh: "極端資金費率 + OI 上升 + 清算集群，可鎖定哪一方會被清算。",
  },
  "Average Directional Index": {
    whyZh: "真正的市場狀態過濾器——量化趨勢強度——但滯後，且單獨無法給出方向。",
    comboZh: "用它把趨勢系統（Supertrend/MACD）限定在確認的趨勢中；強趨勢裡抑制均值回歸。",
  },
  "Choppiness Index": {
    whyZh: "專門用於區分趨勢與震盪的分類器；純過濾器，單獨無訊號。",
    comboZh: "只有讀數為趨勢時才相信突破；只有讀數為震盪時才逆勢做震盪指標。",
  },
  "Average True Range": {
    whyZh: "無方向性，卻是波動率歸一化止損與倉位管理的核心——大多數穩健優勢正源於此。",
    comboZh: "為任何方向性論點設定結構性止損距離並檢測擠壓。",
  },
  "Bollinger Bands": {
    whyZh: "標示波動率擠壓與統計極值，但趨勢中觸碰上下軌並非反轉，且中軌會重繪。",
    comboZh: "落在 LVN 的觸軌極值、或伴隨市場狀態+成交量的擠壓突破，才構成真正的配置。",
  },
  "Keltner Channels": {
    whyZh: "比 Bollinger 更平滑、更少假動作，但衡量的是同一波動率通道概念——大體重複。",
    comboZh: "BB 收在 Keltner 之內是經典擠壓；用趨勢強度確認通道突破。",
  },
  "Ichimoku Cloud": {
    whyZh: "自成體系的趨勢/結構系統，動態支撐阻力尚可，但滯後線觸發偏慢、震盪中反覆。",
    comboZh: "雲層（Kumo）突破經動量+成交量確認，是乾淨的續勢觸發。",
  },
  Supertrend: {
    whyZh: "乾淨的 ATR 跟蹤狀態線，能讓你站在強趨勢正確一側——但震盪中反覆不斷。",
    comboZh: "只在 ADX 確認的趨勢中、且與 VWAP 同側時才跟隨翻轉。",
  },
  "Donchian Channels": {
    whyZh: "經典的海龜突破/結構工具；在趨勢型加密行情中仍有優勢，但震盪中假突破頻繁。",
    comboZh: "趨勢環境下伴隨放量的突破才是高品質突破。",
  },
  "Pivot Points Standard": {
    whyZh: "確定性、不重繪的價位，許多日內交易者關注（帶輕微自我實現）——但純數學、背後無資金流。",
    comboZh: "與 VWAP/VPOC 重合、並透過 footprint 反應解讀的樞軸位才可交易。",
  },
  Volume: {
    whyZh: "驗證或否定行情的關鍵參與度背景——但單獨無方向；必須確認某個價格事件。",
    comboZh: "放量的突破或推動（相較於無量的疲弱突破）才是確認。",
  },
  "Relative Strength Index": {
    whyZh: "單一 RSI 數值或 50 中軸穿越，是加密市場中最易過擬合、最依賴市場狀態的訊號之一——趨勢中超買可以一直超買。",
    comboZh: "唯一持久的用法是在關鍵位（VPOC、VWAP 軌道或清算集群）出現背離。",
  },
  "Moving Average Convergence Divergence": {
    whyZh: "滯後的雙重平滑震盪指標，裸露的金叉死叉偏慢且易反覆。",
    comboZh: "柱狀圖背離、限定在趨勢環境並經成交量確認，才有價值。",
  },
  Stochastic: {
    whyZh: "容易釘在極值區，趨勢中不斷給出假穿越。",
    comboZh: "僅適用於嚴格限定市場狀態的震盪區間均值回歸。",
  },
  "Commodity Channel Index": {
    whyZh: "無界的動量震盪指標，與 RSI/Stochastic 相似、假訊號率高；重複——只算一次。",
    comboZh: "在結構節點、受市場狀態過濾的極值讀數可標示轉折。",
  },
  "Williams %R": {
    whyZh: "本質是反向的 Stochastic，超買超賣行為相同；與 Stochastic、CCI 完全重複。",
    comboZh: "震盪環境下在 VWAP 軌道出現的極值讀數是均值回歸線索。",
  },
  "Awesome Oscillator": {
    whyZh: "以中位價計算的動量柱狀圖——MACD 的平滑替代；零軸穿越/雙峰偏慢且重複。",
    comboZh: "用成交量確認動量轉變，並與趨勢方向一致。",
  },
  "Ultimate Oscillator": {
    whyZh: "融合三個週期以削減單週期雜訊——略好，但仍是滯後的動量工具。",
    comboZh: "在確認的震盪區間、於結構節點出現背離時最好用。",
  },
  "Elder-Ray Index": {
    whyZh: "多空力量相對 EMA 是尚可的背離工具，但屬動量類、缺乏趨勢背景時偏弱。",
    comboZh: "在趨勢內衡量買賣壓力，並以放量確認。",
  },
  "Money Flow Index": {
    whyZh: "成交量加權的 RSI——比裸 RSI 略好，但同樣依賴市場狀態、趨勢中超買失效。",
    comboZh: "在 VP 節點或 VWAP 軌道出現背離，可增添參與度維度。",
  },
  "On Balance Volume": {
    whyZh: "累積資金流的代理指標，背離有時領先價格，但它把整根 K 線成交量視為單向。",
    comboZh: "在 VPOC 用真實的每價位 delta（footprint）驗證其隱含資金流。",
  },
  "Chaikin Money Flow": {
    whyZh: "根據 K 線內收盤位置估算吸籌——易受影線扭曲，與 A/D、OBV 重複。",
    comboZh: "價值區邊緣的資金流偏向，經真實 footprint delta 確認。",
  },
  "Accumulation/Distribution": {
    whyZh: "基於收盤位置的累積資金流線，可用於背離，但其 K 線內假設較粗糙；與 OBV/CMF 重複。",
    comboZh: "在 VPOC 出現 A/D 背離並經 RSI 交叉確認時最好用。",
  },
  "Volume Weighted Moving Average": {
    whyZh: "成交量加權的均線——比普通均線略有意義，但仍是滯後趨勢線，且與 EMA/VWAP 大體重複。",
    comboZh: "作為時段 VWAP 錨點之下、受市場狀態過濾的滾動偏向線。",
  },
  "Simple Moving Average": {
    whyZh: "純滯後趨勢線；單一 SMA 或其交叉嚴重過擬合且遲緩。",
    comboZh: "僅能作為粗略趨勢過濾器，配合市場狀態門檻+公允價值使用。",
  },
  "Exponential Moving Average": {
    whyZh: "比 SMA 更快但仍是滯後跟隨者，交叉在震盪中反覆；與均線家族重複——只算一次。",
    comboZh: "作為趨勢偏向過濾器，其突破需經成交量確認。",
  },
  "Moving Average Ribbon": {
    whyZh: "堆疊均線能直觀呈現趨勢排列/收斂，但相較幾條均線並無額外資訊，且共享其滯後。",
    comboZh: "帶狀擴張經 ADX 及方向偏向確認時，才讀作真實趨勢。",
  },
  "Hull Moving Average": {
    whyZh: "比標準均線滯後更小、轉向更快，但這種靈敏在震盪的永續中增加假翻轉。",
    comboZh: "在震盪中抑制翻轉（Chop 門檻），並與 Supertrend 雙重確認。",
  },
  "Parabolic SAR": {
    whyZh: "跟蹤止損的圓點系統，乾淨趨勢中有效，但會不斷翻轉、橫盤中持續磨損。",
    comboZh: "只有 ADX/Supertrend 一致確認趨勢展開時才跟隨翻轉。",
  },
  Aroon: {
    whyZh: "衡量高低點出現的遠近以判斷趨勢起步——早期提示尚可，但雜訊大、與 ADX 重複。",
    comboZh: "確認創新高/新低的突破，並把趨勢起步與 ADX 強度結合。",
  },
  "Vortex Indicator": {
    whyZh: "VI+/VI- 交叉可識別趨勢轉變，但像 DMI 一樣滯後反覆——相較 ADX 獨特優勢有限。",
    comboZh: "用 ADX 作為其交叉的強度過濾器，並以成交量確認。",
  },
  "Linear Regression Curve": {
    whyZh: "最小二乘平滑趨勢線，對近期價格擬合良好，但向後看且端點會重繪。",
    comboZh: "回歸通道偏離、以 ATR 歸一化止損，可框定回歸。",
  },
  "Historical Volatility": {
    whyZh: "向後看的已實現波動率，可用於倉位管理與市場狀態分類，但屬遲緩的背景指標、無擇時優勢。",
    comboZh: "（配合 ATR）互證波動率狀態，用於止損與擠壓/擴張背景。",
  },
  "Stochastic RSI": {
    whyZh: "二階導震盪指標（RSI 的 Stochastic），雜訊極大，在波動的永續中近乎持續反覆。",
    comboZh: "僅在 VPOC 處嚴格、確認的震盪區間內——即便如此也很邊緣。",
  },
  "Rate of Change": {
    whyZh: "無平滑、無歸一化的原始價格動量——對雜訊極敏感、缺乏結構。",
    comboZh: "僅作為推動段上另一動量工具的交叉確認。",
  },
  Momentum: {
    whyZh: "最簡單的價格差震盪指標，是更粗糙的 ROC；與整個動量家族重複。",
    comboZh: "至多作為受趨勢門檻過濾的推動確認。",
  },
  TRIX: {
    whyZh: "三重平滑的 ROC，以極端滯後換取平滑——在快速的永續行情中觸發極晚。",
    comboZh: "只在受趨勢門檻過濾並經成交量確認時使用，且永不優先於 MACD。",
  },
  "Detrended Price Oscillator": {
    whyZh: "去趨勢以顯現週期，但按構造是位移且非實時的——作為實時訊號很差。",
    comboZh: "在結構節點處的週期低點，並經 RSI 交叉確認。",
  },
  "Ease of Movement": {
    whyZh: "將價格變動與成交量關聯以凸顯順暢移動，但跳動大、在永續中訊號弱。",
    comboZh: "作為順暢突破的確認，配合投入產出式成交量解讀。",
  },
  ZigZag: {
    whyZh: "純回溯性——在確認前會重繪最後一段——因此是事後的繪圖輔助，絕非實時訊號。",
    comboZh: "僅作標註：對照被接受的價值/樞軸位標記擺動。",
  },
  "Standard Deviation": {
    whyZh: "原始的離散度度量——是波動率工具的輸入，而非可交易訊號；與 Bollinger/ATR 重複。",
    comboZh: "互證它本已支撐的波動率狀態（Bollinger）。",
  },
};
for (const e of INDICATOR_TIERS) {
  const z = INDICATOR_ZH[e.name];
  if (z) {
    e.whyZh = z.whyZh;
    if (z.comboZh) e.comboZh = z.comboZh;
  }
}

// Normalized lookup so TV display-name variance ("Volume Profile (HD)", casing,
// "MACD") still resolves to a tier entry.
const norm = (s: string) =>
  s.toLowerCase().replace(/[()]/g, " ").replace(/\s+/g, " ").trim();

const BY_NAME = new Map<string, IndicatorTier>();
const ALIASES: Record<string, string> = {
  macd: "Moving Average Convergence Divergence",
  rsi: "Relative Strength Index",
  vwap: "Volume Weighted Average Price",
  "volume profile hd": "Volume Profile",
  "session volume profile": "Volume Profile",
  "session volume profile hd": "Volume Profile",
  "periodic volume profile": "Volume Profile",
  "fixed range volume profile": "Volume Profile",
  "volume profile fixed range": "Volume Profile",
  atr: "Average True Range",
  adx: "Average Directional Index",
  "directional movement index": "Average Directional Index",
  "moving average exponential": "Exponential Moving Average",
  "moving average simple": "Simple Moving Average",
  "moving average": "Simple Moving Average",
  "stochastic rsi": "Stochastic RSI",
  "williams percent range": "Williams %R",
  obv: "On Balance Volume",
};
for (const e of INDICATOR_TIERS) BY_NAME.set(norm(e.name), e);

// Well-known acronyms shown in front of long names: "MACD (Moving Average …)".
export const INDICATOR_SHORT: Record<string, string> = {
  "Moving Average Convergence Divergence": "MACD",
  "Relative Strength Index": "RSI",
  "Volume Weighted Average Price": "VWAP",
  "Average Directional Index": "ADX",
  "Average True Range": "ATR",
  "Commodity Channel Index": "CCI",
  "On Balance Volume": "OBV",
  "Money Flow Index": "MFI",
  "Chaikin Money Flow": "CMF",
  "Accumulation/Distribution": "A/D",
  "Exponential Moving Average": "EMA",
  "Simple Moving Average": "SMA",
  "Hull Moving Average": "HMA",
  "Volume Weighted Moving Average": "VWMA",
  "Detrended Price Oscillator": "DPO",
  "Rate of Change": "ROC",
  "Awesome Oscillator": "AO",
  "Ultimate Oscillator": "UO",
  "Bollinger Bands": "BB",
  "Parabolic SAR": "SAR",
  "Historical Volatility": "HV",
  "Volume Profile Visible Range": "VPVR",
};

// Display label for a row: prefix the acronym when the name is a long mouthful.
export function indicatorLabel(name: string): string {
  const s = INDICATOR_SHORT[name];
  return s ? `${s} (${name})` : name;
}

// Split form of the label so the UI can render the acronym in the mono
// "terminal" face (like a ticker) and the full name in the sans face — matching
// the pair picker's "BTC · full name" typography. `code` is null when the name
// has no acronym (short names render as the code themselves).
export function indicatorLabelParts(name: string): {
  code: string | null;
  full: string;
} {
  const s = INDICATOR_SHORT[name];
  return s ? { code: s, full: name } : { code: null, full: name };
}

// Compact label for a "works well with" chip: the acronym when the name has one
// (ADX, RSI, VWAP…), otherwise the name itself. Resolves display-name variants
// through tierMeta so aliases still shorten.
export function pairShort(name: string): string {
  if (INDICATOR_SHORT[name]) return INDICATOR_SHORT[name];
  const meta = tierMeta(name);
  if (meta && INDICATOR_SHORT[meta.name]) return INDICATOR_SHORT[meta.name];
  return name;
}

export function tierMeta(name: string): IndicatorTier | null {
  const n = norm(name);
  if (BY_NAME.has(n)) return BY_NAME.get(n)!;
  if (ALIASES[n]) return BY_NAME.get(norm(ALIASES[n])) ?? null;
  // Substring fallback: "Bollinger Bands %B" → Bollinger Bands, etc.
  for (const [key, val] of BY_NAME) {
    if (n.includes(key) || key.includes(n)) return val;
  }
  return null;
}

// Compact digest injected into the agent prompts (chat + detect) so the agent's
// confluence advice matches the dropdown the user sees. Kept terse on purpose.
export const INDICATOR_TIER_DIGEST = `INDICATOR TIER REFERENCE (per-indicator, complements the setup rubric). Each indicator has a STANDALONE tier and, when weak-alone, a higher CEILING it reaches only in cross-class confluence. Classes: structure, momentum, volatility/regime, volume/flow, trend, derivatives/positioning. Same-class tools are redundant (count once); real confluence needs DIFFERENT classes.
- A (strong anchors): VWAP, Volume Profile/VPVR; Superior exclusives — Order-flow Footprint (per-price aggressor sell×buy, POC, imbalances), Superior CVD, Superior Volume Delta (all volume/flow class), Liquidation Heatmap (derivatives-native → can unlock S with structure+volume). Flow tools read ACTUAL aggression: absorption at a level, delta divergence, stacked imbalance are top-grade confirmation for entries AT structure.
- B (context/filters, weak alone → A paired): Open Interest, Funding, ADX, Choppiness, ATR, Bollinger, Keltner, Ichimoku, Supertrend, Donchian, Pivots, Volume.
- C (marginal alone → B, RSI/MACD → A as divergence AT a level): RSI, MACD, Stochastic, CCI, Williams %R, AO, MFI, OBV, CMF, A/D, the MA family, PSAR.
- D (reject alone): StochRSI, ROC, Momentum, TRIX, DPO, Ease of Movement, ZigZag, StdDev.
When advising: never treat 3 momentum oscillators as 3 signals; push for a DIFFERENT class (structure/volume/derivatives). Weak-alone tools are only credible as confirmation AT a level, never as the thesis.
STRATEGY NOTE for flow signals: the deployed bot CANNOT stream per-trade order-flow on Hyperliquid (freqtrade's use_public_trades/orderflow API is unavailable there) — compiled strategies approximate flow with candle-derived proxies (delta proxy from close-in-range × volume, CVD = its cumsum, absorption = volume spike + wick rejection). When a plan leans on footprint/CVD/delta, say the live trigger is a proxy of what the chart shows.`;
