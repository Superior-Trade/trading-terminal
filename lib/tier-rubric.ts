// Shared grounding for scoring trade-setup quality, used by BOTH the setup
// detector (/api/detect) and the chat agent (/api/chat) so tier assignments
// are consistent. Synthesized from 2025-2026 quant/robustness work, regime-
// filter studies, order-flow references, and crypto-perp structure analysis
// (funding/OI/liquidation). Refreshed 2026-07 with perp + order-flow gates.

export const TIER_RUBRIC = `STRATEGY TIER RUBRIC (2026) — score a setup's QUALITY, honestly and discriminatingly. Reserve S/A; most setups are B/C.

CORE PRINCIPLE (multiplicative — a zero on any factor caps the tier):
score = independent-confluence × regime-fit × (R:R with a hard invalidation) × robustness.
- Independent confluence = signals from DIFFERENT classes (structure, order-flow/volume, volatility/regime, derivatives positioning). Three momentum oscillators are ONE signal, not three.
- Regime fit (2025-2026 refinement most edges depend on): classify trend vs mean-revert (Hurst H>0.55 trend / H<0.45 revert) and volatility regime (ATR percentile) BEFORE grading. A momentum setup in a ranging tape, or a fade in a strong trend, is auto-downgraded no matter how clean it looks.
- Robustness gates the ceiling: only reach S/A if the logic would survive out-of-sample / walk-forward with stable expectancy — not curve-fit params. Optimize for EXPECTANCY, not win-rate. A pre-defined structural invalidation is mandatory.

CRYPTO-PERP GATES (fold in — ignoring these caps a clean setup at B):
RAISE tier: trading direction aligns with a positioning flush (long a swept low while funding is negative/short-crowded; short into euphoric positive funding); an untapped liquidation cluster sits as a MAGNET in the trade's direction (real objective, better R:R); OI rising with price in continuation, or OI flushing at the reversal you're fading; supportive basis.
LOWER tier: entering the SAME direction as an extreme funding crowd (>~0.05-0.1%/8h sustained ⇒ over-leveraged, reversal-prone); chasing a move whose fuel was an already-spent liquidation cascade; rising OI on stalling price (fragile leveraged buildup); a stop parked just beyond a dense liquidation pocket it'll be dragged into.

OBSERVABILITY CONSTRAINT (grade ONLY on what this terminal can see): available inputs are OHLCV candles, chart indicators, price/volume structure, and funding/OI where provided. Tick-level ORDER-FLOW (CVD, delta, absorption, footprint, VPOC from tick data) is NOT observable here and NOT executable by the OHLCV-based Freqtrade strategies we deploy — NEVER cite its absence as a reason to cap a tier, and never demand it as confirmation. Candle-derived proxies count instead: volume expansion/climax at a level, high-volume rejection wicks, breakout candles with above-average volume vs. unsupported (low-volume) breaks.

TIERS (apply consistently, using OBSERVABLE factors only):
- S — multi-class independent confluence (HTF structure + volume/regime confirmation) ALIGNED with derivatives context (favorable funding/OI, liq-cluster target), R:R ≥ 3 with tight structural invalidation, robust out-of-sample. Rare.
- A — strong HTF-aligned structure + one independent OBSERVABLE confirmation (volume behavior, regime fit, or supportive funding/OI), R:R ≥ 2, clear invalidation. An A does NOT require order-flow data — multi-class candle/derivatives confluence suffices.
- B — valid clean setup but confluence is thin or partly correlated, OR derivatives context merely neutral/unchecked; regime acceptable; R:R ~1.5-2. Playable, not premium.
- C — marginal: single-class signal, weak/late confirmation, mediocre R:R (~1-1.5), regime ambiguous, or a minor funding/OI headwind. Size down or pass.
- D — reject: counter-HTF, wrong regime (fading a trend / chasing a range breakout into the range), no defined invalidation, into extreme adverse funding or a spent liquidation move, R:R < 1.

INDICATOR CREDIBILITY: edge-bearing when regime-gated — market structure (BOS/CHoCH) & swing liquidity; candle-volume behavior (expansion, climax, rejection wicks); ATR/realized-vol for regime & stops; VWAP (session/anchored); funding/OI/liquidation as a derivatives-native class. Weak-alone (context only, never a thesis) — a single oscillator cross (RSI/MACD/Stoch), a lone MA cross, round-number "psychology," classic pattern naming. Redundant (count ONCE) — RSI+MACD+Stoch (all momentum), multiple MAs, Bollinger+Keltner (both vol-bands). SMC/ICT (OB, FVG, sweep, killzone): useful STRUCTURE vocabulary and backtestable in strict rule-based form, but credit only mechanical, level-based versions, never as sole confluence.

TRAP PENALTIES (each drops ≥1 tier; multiple ⇒ D): hardcoded/curve-fit triggers (magic prices, over-tuned params); fake confluence from correlated indicators dressed as independent; counter-HTF knife-catching; no structural invalidation, or a stop inside an obvious liquidation pocket; ignoring funding/OI context when it IS provided; regime blindness; win-rate worship over expectancy. NEVER penalize a setup for lacking data this terminal cannot observe (order-flow, tick data, L2).`;
