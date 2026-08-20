// Grounding so the agent draws what traders actually MEAN — accurate anchors,
// right primitive, candle-derived zone thickness, standard labels. Condensed
// from price-action, SMC/ICT, and volume-profile practitioner references.
// Used by /api/chat (drawing tools) and /api/detect.

export const DRAWING_REFERENCE = `CHART DRAWING REFERENCE — pick the right primitive, anchor it precisely, label it in trader shorthand.

REQUEST → PRIMITIVE:
- A single price that matters (support/resistance, PDH/PDL/PWH/PWL, round number, VWAP tap, POC/VAH/VAL, opening-range, liquidity/EQH/EQL, BOS/CHoCH level, entry/stop/target) → horizontal level (draw_level), extended right.
- A single sloped line (trendline, wedge, triangle, neckline) → trendline (draw_trendline).
- A channel / flag / trend envelope (two parallel rails) → channel (draw_channel) — one call, NOT two trendlines: anchor one rail on its touches, set offsetPrice to the opposite rail.
- An area of interest (supply/demand zone, order block, fair-value gap/imbalance, breaker, consolidation range, PRZ) → zone rectangle (draw_zone).
- A RETRACEMENT ratio (.382/.5/.618/.786 pullback within a leg) → fib (draw_fib), anchored on the exact swing.
- A PROJECTED target beyond the swing (extension 1.272/1.618/2.618, measured move) → trend-based fib extension (draw_fib_extension): move start → move end → retrace point.
- A moment in time (session open, kill-zone, funding, news/CPI) → vertical line (draw_vertical).
- A written thesis/event note pinned to a point → text note (draw_text) — don't overload a line's label with a paragraph.
- A trade with risk/reward → entry/stop/target levels (the plan tools).

ANCHOR PRECISELY (this is what makes a drawing right vs. misleading):
- Trendlines connect ACTUAL swing pivots — ≥2 touches, prefer 3. Default to wicks (true extremes); use bodies only if closes repeatedly violate the wick line, and never mix wicks and bodies on one line.
- Horizontal S/R sits at the price with the MOST touches (wick cluster if wicks reject there, body cluster if closes define it).
- A BOS/CHoCH or an S/R "break" requires a candle CLOSE beyond the level — a wick through it is a liquidity sweep, not a break.
- Fib: put 0 and 1 exactly on the swing low and swing high that bound the leg (low→high for an up-leg). Extensions anchor start→end→retrace.

ZONE THICKNESS — from real candles, never arbitrary:
- Demand zone: the last DOWN candle before an up-impulse — top at its open/high, bottom at its low. Supply: mirror with the last up candle before a drop.
- Order block: open→close of the origin candle (extend to wick only for a conservative fill); project the box right.
- FVG/imbalance: exactly the gap between candle-1 wick and candle-3 wick (3-candle pattern); nothing fatter or thinner.
- Range: box from range high to range low across the sideways period.

CONTEXT & LABELS:
- Draw structural levels from the higher timeframe the request implies ("4H demand"); anchor to price/time so they stay fixed as candles print.
- One concise standard label per object: PDH/PDL, "4H demand", OB, FVG, BOS, CHoCH, EQH/EQL, POC, VAH/VAL, E/SL/TP, 1R/2R, BSL/SSL — prefix the timeframe when it disambiguates.

AVOID: cherry-picking anchors to fit a bias; lines that touch no real pivot; zones too fat (whole impulse) or too thin (one tick); calling a wick-poke a break; over-drawing. If a request is vague ("mark the support"), default to the most-touched HTF level and the least ink.`;
