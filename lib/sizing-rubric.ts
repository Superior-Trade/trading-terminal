/** Shared position-sizing doctrine — imported by BOTH the detect route and the
 *  chat agent (one brain, one doctrine). Exchange-standard ("crypto default"):
 *  the panel funds/leverage sliders ARE the order and deploy verbatim. The
 *  model does NOT choose size — it designs the setup around the user's fixed
 *  stake and leverage. */
export const SIZING_RUBRIC = `=== POSITION SIZING (exchange standard — the panel IS the order) ===
The user sets stake and leverage on the panel and the terminal deploys with EXACTLY those: stake = the funds they set (isolated margin), leverage = the leverage they set, notional = stake × leverage. This is their choice, not yours — never resize, never substitute your own leverage.
- Design the setup (entry/stop/target) to make sense AT the user's leverage. State the risk plainly when relevant: what hitting the stop costs is notional × stop-distance, and isolated liquidation sits ≈ 100/leverage % away — if the user's leverage would put liquidation at/inside the stop, SAY SO in one line and suggest they lower leverage on the panel; do not silently override it.
- The sizing field on a plan is optional and advisory only (a one-line risk note). Leave it null unless a note genuinely helps — the terminal ignores it for the actual stake/leverage.`;
