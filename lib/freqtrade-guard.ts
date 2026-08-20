// Deterministic safety validator for generated Freqtrade strategies.
// Catches the pitfall classes that killed live bots (see the 2026-07 audit):
// leverage-scaled stop math, stops behind liquidation, NaN indicators from a
// missing startup_candle_count, lookahead bias, short-direction mistakes,
// and loss-exiting ROI tables. Runs on BOTH compile paths (/api/compile and
// the chat agent's compile_strategy tool) BEFORE anything reaches Superior.

export interface GuardInput {
  config: Record<string, unknown>;
  code: string;
  leverage?: number | null;
}

// Modules a strategy may legitimately import. Everything else (os, sys,
// subprocess, requests, urllib, socket, pathlib, importlib, …) is rejected:
// generated code runs on Superior's infra, and the plan text that shapes the
// generation is user-influenced (chart drawings/text ride into the compile
// prompt) — the import surface is where an injected instruction would try to
// reach the network or filesystem.
const ALLOWED_IMPORT_ROOTS = new Set([
  "freqtrade",
  "pandas",
  "numpy",
  "talib",
  "technical",
  "qtpylib",
  "datetime",
  "typing",
  "math",
  "functools",
  "scipy",
]);

/** Root module of every import statement in the code. */
function importRoots(code: string): string[] {
  const roots: string[] = [];
  for (const m of code.matchAll(
    /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.,\s]*?)(?:\s+as\s+\w+)?\s*$)/gm,
  )) {
    if (m[1]) roots.push(m[1].split(".")[0]);
    else if (m[2])
      for (const part of m[2].split(","))
        roots.push(part.trim().split(/\s+as\s+/)[0].split(".")[0]);
  }
  return roots;
}

/** TA-Lib params that hard-require Python floats — the #1 runtime killer in
 *  the 2026-07-10 generation audit: 7/12 sampled strategies (including a
 *  LIVE deployment) died on `nbdevup (expected float, got int)` because the
 *  model writes BBANDS(nbdevup=2). Deterministically rewrite integer
 *  literals to floats — models keep making this mistake no matter what the
 *  prompt says, so it's fixed in code, not in prose. */
const TALIB_FLOAT_PARAMS = "nbdevup|nbdevdn|nbdev|fastlimit|slowlimit|vfactor|penetration";

export function fixTaLibFloatParams(code: string): string {
  return code.replace(
    new RegExp(`\\b(${TALIB_FLOAT_PARAMS})(\\s*=\\s*)(\\d+)(?![.\\d])`, "g"),
    "$1$2$3.0",
  );
}

/** Multi-output TA-Lib functions, outputs in the order the tuple returns them.
 *
 *  Same failure shape as the float params above, and found the same way — from
 *  a live deployment. A funded HYPE bot ran for ten hours placing nothing while
 *  its entry condition fired seven times, because the model wrote:
 *
 *      bollinger = ta.BBANDS(dataframe['close'], timeperiod=20, ...)
 *      dataframe['bb_upper'] = bollinger['upperband']
 *
 *  ta.BBANDS returns a TUPLE, so the string subscript raises
 *  "TypeError: list indices must be integers or slices, not str" inside
 *  populate_indicators — on every candle, caught by freqtrade's strategy
 *  wrapper and logged as a warning. The deployment stays "running" and the
 *  wallet never trades.
 *
 *  The mistake is easy to make because qtpylib.bollinger_bands DOES return a
 *  dict-like. Prose won't fix that; the subscript is rewritten to its index. */
const TALIB_MULTI_OUTPUT: Record<string, string[]> = {
  BBANDS: ["upperband", "middleband", "lowerband"],
  MACD: ["macd", "macdsignal", "macdhist"],
  MACDEXT: ["macd", "macdsignal", "macdhist"],
  MACDFIX: ["macd", "macdsignal", "macdhist"],
  STOCH: ["slowk", "slowd"],
  STOCHF: ["fastk", "fastd"],
  STOCHRSI: ["fastk", "fastd"],
  AROON: ["aroondown", "aroonup"],
  MAMA: ["mama", "fama"],
  HT_PHASOR: ["inphase", "quadrature"],
  HT_SINE: ["sine", "leadsine"],
  MINMAX: ["min", "max"],
  MINMAXINDEX: ["minidx", "maxidx"],
};

export function fixTaLibTupleSubscripts(code: string): string {
  // Which local names hold the result of a multi-output TA-Lib call.
  const holders = new Map<string, string[]>();
  const assign = new RegExp(
    `(\\w+)\\s*=\\s*(?:ta|talib)\\.(${Object.keys(TALIB_MULTI_OUTPUT).join("|")})\\s*\\(`,
    "g",
  );
  for (const m of code.matchAll(assign)) {
    // Tuple-unpacking assignments never match (the LHS has a comma), which is
    // exactly right — those are already correct.
    holders.set(m[1], TALIB_MULTI_OUTPUT[m[2]]);
  }
  if (holders.size === 0) return code;

  let out = code;
  for (const [name, outputs] of holders) {
    for (const [i, key] of outputs.entries()) {
      out = out.replace(
        new RegExp(`\\b${name}\\s*\\[\\s*(['"])${key}\\1\\s*\\]`, "g"),
        `${name}[${i}]`,
      );
    }
  }
  return out;
}

export function validateStrategySafety({ config, code, leverage }: GuardInput): string[] {
  const errors: string[] = [];
  const lev = Number.isFinite(leverage) && (leverage as number) >= 1 ? (leverage as number) : 1;

  // Any string subscript still sitting on a multi-output TA-Lib result after
  // the rewrite means an output name we do not recognise — a typo, or a
  // qtpylib key on a talib call. It would raise on the first candle, so it is
  // a hard error and goes back through the repair pass rather than deploying.
  {
    const fnNames = Object.keys(TALIB_MULTI_OUTPUT).join("|");
    const holders = [
      ...code.matchAll(new RegExp(`(\\w+)\\s*=\\s*(?:ta|talib)\\.(?:${fnNames})\\s*\\(`, "g")),
    ].map((m) => m[1]);
    for (const name of new Set(holders)) {
      const leftover = code.match(new RegExp(`\\b${name}\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]`));
      if (leftover) {
        errors.push(
          `${name} holds a TA-Lib tuple, so ${name}['${leftover[1]}'] raises "list indices must be integers or slices, not str" on the first candle. Unpack it — e.g. upper, middle, lower = ta.BBANDS(...) — or index it positionally.`,
        );
      }
    }
  }

  // ── TA-Lib float params (backstop — callers should fixTaLibFloatParams first) ──
  const intParam = code.match(
    new RegExp(`\\b(${TALIB_FLOAT_PARAMS})\\s*=\\s*\\d+(?![.\\d])`),
  );
  if (intParam)
    errors.push(
      `TA-Lib parameter "${intParam[1]}" is an int — TA-Lib requires a float (e.g. nbdevup=2.0, not 2); the strategy crashes on every candle at runtime`,
    );

  // ── code scope: import whitelist + no dynamic execution ──
  for (const root of new Set(importRoots(code))) {
    if (!ALLOWED_IMPORT_ROOTS.has(root))
      errors.push(
        `forbidden import "${root}" — strategies may only import ${[...ALLOWED_IMPORT_ROOTS].join("/")}`,
      );
  }
  for (const call of ["exec", "eval", "__import__", "open", "compile", "breakpoint"]) {
    if (new RegExp(`(?<![\\w.])${call}\\s*\\(`).test(code))
      errors.push(`forbidden call ${call}( — strategies must not execute dynamic code or touch the filesystem`);
  }

  // ── stoploss: negative, leverage-scaled, inside liquidation ──
  const stop = typeof config.stoploss === "number" ? config.stoploss : NaN;
  if (!Number.isFinite(stop)) {
    errors.push("config.stoploss must be a number (negative fraction of POSITION PnL, leverage included)");
  } else {
    if (stop >= 0) errors.push(`config.stoploss must be negative (got ${stop}) — freqtrade stops are always negative, for shorts too`);
    if (stop < -0.95) errors.push(`config.stoploss ${stop} ≤ -0.95 wipes the margin — cap at -0.95`);
    // Stop must sit safely inside the liquidation distance. Price-stop% =
    // |stoploss|/leverage; liquidation ≈ 1/leverage. Require price-stop to be
    // under 75% of the liquidation distance (maintenance-margin headroom):
    // |stoploss|/lev < 0.75/lev  ⇔  |stoploss| < 0.75.
    if (lev > 1 && stop <= -0.75)
      errors.push(
        `config.stoploss ${stop} at ${lev}x puts the stop at/behind the liquidation price (liq ≈ ${(100 / lev).toFixed(2)}% price move) — the position would be liquidated before the stop fires. Use a tighter price stop or lower leverage.`,
      );
    // Suspiciously UNscaled: a plan-style price stop (-0.5%..-8%) written raw
    // at high leverage is the exact bug that churned the live bot.
    if (lev >= 5 && stop > -0.05)
      errors.push(
        `config.stoploss ${stop} at ${lev}x means a ${((Math.abs(stop) / lev) * 100).toFixed(2)}% PRICE move — looks like an unscaled price %. Multiply the plan's price-stop% by leverage (${lev}x).`,
      );
  }

  // ── minimal_roi: present, "0" key, non-negative values ──
  const roi = config.minimal_roi as Record<string, unknown> | undefined;
  if (!roi || typeof roi !== "object" || !Object.keys(roi).length) {
    errors.push('config.minimal_roi missing — emit {"0": <leveraged target %>} for the take-profit');
  } else {
    if (!("0" in roi)) errors.push('config.minimal_roi must include the "0" key (no take-profit before the first key\'s minute otherwise)');
    for (const [k, v] of Object.entries(roi)) {
      if (!/^\d+$/.test(k)) errors.push(`config.minimal_roi key "${k}" must be a string integer (minutes since open)`);
      if (typeof v !== "number" || v < 0)
        errors.push(`config.minimal_roi["${k}"] = ${v} — negative/invalid ROI exits at a LOSS; values must be ≥ 0`);
    }
  }

  // ── trailing stop: scaled + coherent ──
  if (config.trailing_stop === true) {
    const pos = Number(config.trailing_stop_positive);
    const off = Number(config.trailing_stop_positive_offset ?? 0);
    if (Number.isFinite(pos) && off <= pos)
      errors.push("trailing_stop_positive_offset must be GREATER than trailing_stop_positive");
    if (config.trailing_only_offset_is_reached !== true)
      errors.push("set trailing_only_offset_is_reached: true — otherwise the stop trails from entry at the tight distance and churns out instantly");
    if (lev >= 5 && Number.isFinite(pos) && pos < 0.02)
      errors.push(`trailing_stop_positive ${pos} at ${lev}x looks unscaled (it is leveraged PnL, like stoploss) — multiply the price % by leverage`);
  }

  // ── code: lookahead bias + direction + startup candles ──
  const populate = code.slice(code.indexOf("populate_indicators"));
  if (/shift\(\s*-\d/.test(populate))
    errors.push("code uses shift(-N) — that reads FUTURE candles (lookahead bias); backtests lie and live behaves differently");
  if (/\.iloc\[/.test(populate))
    errors.push("code uses .iloc[...] inside populate_* — per-row indexing behaves differently live vs backtest; use vectorized column operations only");
  if (/\bresample\(/.test(populate))
    errors.push("code uses resample() inside populate_* — lookahead risk; use merge_informative_pair() for higher timeframes");

  const isShortPlan = /enter_short/.test(code);
  if (isShortPlan && !/can_short\s*=\s*True/.test(code))
    errors.push("code populates enter_short but can_short=True is missing — short signals will be silently ignored");

  const startupMatch = code.match(/startup_candle_count\s*[:=]\s*(\d+)/);
  if (!startupMatch) {
    errors.push(
      "code must set startup_candle_count (≥ 3× the longest indicator lookback, e.g. 150 for EMA50) — without it, indicators are NaN live and the bot silently never trades",
    );
  } else if (Number(startupMatch[1]) < 30) {
    errors.push(`startup_candle_count ${startupMatch[1]} is too low — use ≥ 3× the longest indicator lookback (min 30)`);
  } else if (Number(startupMatch[1]) > 999) {
    errors.push(`startup_candle_count ${startupMatch[1]} exceeds the exchange candle limit headroom — keep ≤ 999`);
  }

  if (!/volume['"]\]\s*>\s*0/.test(code))
    errors.push("entry conditions must include the (dataframe['volume'] > 0) guard so signals never fire on dead candles");

  // ── freqtrade's native order-flow API is unavailable on Hyperliquid ──
  // (no public-trades pipeline: stock freqtrade hard-blocks --dl-trades for
  // HL and live trade streaming is unverified). A strategy using it passes
  // compile but KeyErrors on every candle at runtime — reject it here and
  // let the repair loop rewrite with candle-derived *_proxy columns.
  const cfg = config as Record<string, unknown>;
  const exchangeCfg = (cfg.exchange ?? {}) as Record<string, unknown>;
  if (exchangeCfg.use_public_trades === true || "orderflow" in cfg)
    errors.push(
      "use_public_trades / the orderflow config block are NOT supported on Hyperliquid — remove them and express flow logic with candle-derived proxy columns (delta_proxy from close-position-in-range × volume, cvd_proxy = its cumsum, volume-spike + wick-rejection for absorption)",
    );
  const flowCol = code.match(
    /dataframe\[\s*['"](delta|min_delta|max_delta|orderflow|imbalances|stacked_imbalances_bid|stacked_imbalances_ask|total_trades|trades|bid|ask)['"]\s*\]/,
  );
  if (flowCol && !new RegExp(`['"]${flowCol[1]}['"]\\s*\\]\\s*=`).test(code))
    errors.push(
      `dataframe['${flowCol[1]}'] is a freqtrade order-flow column that does not exist on Hyperliquid (never populated — KeyError on every candle). Compute a candle-derived proxy instead (e.g. delta_proxy = volume × (2×(close−low)/(high−low) − 1), cvd_proxy = delta_proxy.cumsum()) and gate signals on that`,
    );

  // ── hardcoded price window on an INDICATOR entry (the #1 never-trades bug) ──
  // A generated entry that gates a price column on an absolute literal
  // (e.g. `close <= 394.0`, `close >= 390`) freezes the signal to a price
  // snapshot: once price leaves that window the bot never fires again — even
  // though the indicator condition still triggers. The prompt forbids this but
  // the model keeps doing it (13/18 in the 2026-07-15 audit). Reject ONLY when
  // the entry also references an indicator/level series, so genuine fixed-level
  // strategies (a literal breakout price the user actually drew, with no
  // indicator) still pass.
  const entrySection = (() => {
    const i = code.search(/def\s+populate_entry(_trend)?\s*\(/);
    if (i < 0) return "";
    const rest = code.slice(i);
    const next = rest.slice(1).search(/\n\s*def\s+/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  })();
  // Frozen-snapshot signature: the SAME price column is bounded by BOTH a
  // hardcoded numeric literal AND a moving indicator/level series. That literal
  // is a snapshot of the indicator taken at generation time — once price leaves
  // it the bot never fires again, even though the indicator condition still
  // triggers (the #1 cause of live strategies that never trade). Requiring both
  // bounds on the same column avoids false-positiving genuine standalone fixed
  // levels (`close > 64500` alone) or a fixed level with a non-price confirm
  // (`close <= 64500 & rsi > 40`), both of which the prompt permits.
  const OHLCV = new Set(["open", "high", "low", "close", "volume"]);
  const frozenLevel = (["close", "high", "low", "open"] as const).some((col) => {
    const px = `dataframe\\[\\s*['"]${col}['"]\\s*\\](?:\\.shift\\(\\s*\\d+\\s*\\))?`;
    const vsLiteral = new RegExp(`${px}\\s*[<>]=?\\s*\\d+(?:\\.\\d+)?`).test(entrySection);
    if (!vsLiteral) return false;
    // Same column also compared to an indicator series (RHS dataframe['name']
    // where name is NOT a raw OHLCV column — `close > open` is a candle shape,
    // not a level).
    const rhs = new RegExp(`${px}\\s*[<>]=?\\s*dataframe\\[\\s*['"]([a-z0-9_]+)['"]`, "gi");
    for (let m = rhs.exec(entrySection); m; m = rhs.exec(entrySection))
      if (!OHLCV.has(m[1].toLowerCase())) return true;
    return false;
  });
  if (frozenLevel)
    errors.push(
      "populate_entry_trend bounds a price column on BOTH a hardcoded absolute price literal AND an indicator series — the literal is a frozen snapshot of that moving level, so the bot stops firing once price leaves the baked-in window (the #1 cause of live strategies that never trade). Drop the literal price bound and gate purely on the indicator series (e.g. `dataframe['close'] <= dataframe['bb_basis']`, `>= dataframe['trend_line']`). Use a literal ONLY for a genuine standalone fixed level with no indicator.",
    );

  // ── entry CONFIRMATION + no instant-entry (2026-07 generation audit) ──
  // 49/50 recent generated setups entered on a bare absolute price touch with
  // no indicator (e.g. `low <= 57.50`) — that cohort deployed at a 24.8% win
  // rate and net-negative PnL, and it fires on the FIRST candle when price is
  // already past the level (the instant-entry bug). Require every entry to gate
  // on at least ONE of: an indicator series, or a fresh cross (shift-based) of a
  // level. A bare price/volume-vs-literal touch with neither is rejected.
  if (entrySection) {
    const entryCols = new Set(
      [...entrySection.matchAll(/dataframe\[\s*['"]([a-z0-9_]+)['"]\s*\]/gi)].map((m) =>
        m[1].toLowerCase(),
      ),
    );
    // Columns that don't count as an indicator confirmation.
    const NON_INDICATOR = new Set([...OHLCV, "enter_long", "enter_short", "enter_tag", "date"]);
    const hasIndicator = [...entryCols].some((c) => !NON_INDICATOR.has(c));
    // A shift(N) reference is a candle-over-candle (cross/confirmation) check.
    const hasCross = /\.shift\(/.test(entrySection);
    if (!hasIndicator && !hasCross)
      errors.push(
        "populate_entry_trend is a bare price/level touch — no indicator confirmation and no fresh-cross gate. It has no confirmation and fires on the FIRST candle if price is already at/past the level (instant entry on deploy). Gate the entry on an indicator series (RSI/EMA/Bollinger/ATR/VWAP or a computed level column) AND/OR a confirmed cross, e.g. `(close > level) & (close.shift(1) <= level)`.",
      );
  }

  // NOTE: a hard "empty populate_exit_trend" reject was evaluated against 154
  // real strategies and dropped — the guard already requires minimal_roi + a
  // stoploss, so ROI/stop IS the exit; a signal-exit mandate either over-rejects
  // legitimate ROI/stop designs (incl. tight symmetric-ROI scalps — the top
  // winner among them) or, once tuned around them, never fires. Managed-exit
  // quality is steered by the system prompt instead; the entry-confirmation
  // check above is the deterministic, false-positive-free enforcement.

  return errors;
}
