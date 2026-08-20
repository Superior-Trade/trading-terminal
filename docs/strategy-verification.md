# Strategy generation: logging, verification, framework-agnosticism

Answers three internal questions: are we logging what we generate, can we
verify generated strategies actually WORK (not just compile), and is our
representation too fitted to Freqtrade to ever target another engine
(nautilus_trader etc.)?

## 1. What we log (strategy_log table)

Every generated artifact gets a row — this is the debugging + verification
corpus:

| kind | stage | payload highlights |
| --- | --- | --- |
| `detect` | plan generated (detector) | plan JSON, model, symbol |
| `suggest_plan` | plan generated (chat agent) | plan JSON |
| `compile_ok` / `compile_reject` | static | config+code, `codeHash`, guard errors, repair flag |
| `backtest_submit` | dynamic (run attempt) | backtestId, `codeHash`, timerange |
| `backtest_verify` | dynamic (verdict) | traded? trade count, profit, first 20 trades |
| `live_verify` | production (ground truth) | first real fill vs plan: direction ok, entry deviation %, or `traded:false` |

Joins: `codeHash` links a compile to the backtests that exercised the same
artifact; `deploymentId` links to live results. **Compiling is stage 2 of 4**
— a strategy that compiles can still never enter, enter the wrong side, or
have orders rejected. The dynamic stages exist precisely because of that.
First real corpus data confirmed it: 3 of 4 recent (short-lived test)
deployments ended `traded:false`.

## 2. The agnostic seam: plan JSON in, per-target compile out

The architecture is already the right shape:

```
plan JSON (framework-AGNOSTIC intermediate representation)
   └─ compile step (per-target backend: today Freqtrade only)
        └─ target artifact (Freqtrade config + IStrategy python)
             └─ target validator (freqtrade-guard) + backtest + live verify
```

**Agnostic today (safe):** `direction` (long/short/neutral), `mode`
(one_shot/recurring), numeric `entry/stop/target`, `alive_until` (time bound),
`invalidation`, tier, thesis, `symbol/timeframe`. These describe INTENT, not
engine mechanics.

**Leaky / at-risk parts:**

1. **Free-text conditions** (`entryCondition: "close ≤ lower BB & RSI<30"`).
   Human-readable, not machine-parseable — so every new target needs another
   LLM compile pass instead of a deterministic transpile. This is the #1 gap.
   Acceptable while LLM-compile is the strategy, but it makes cross-framework
   conformance probabilistic.
2. **Informal source tokens** (`"bb_lower"`, `"ema:50"`, `"vwap"`) — close to
   a grammar already; needs formalizing (canonical indicator ids + params).
3. **Freqtrade-isms quarantined in the compile step** (correct place): PnL-
   ratio stoploss, leverage-scaled `minimal_roi` table, `position_adjustment`
   DCA, `populate_*` vectorized signals, pairlist/stake config. None of these
   leak into the plan schema — keep it that way. Notably `minimal_roi` and
   PnL-ratio stops have NO direct equivalent in most other engines.
4. **One structural assumption**: signals evaluate on closed candles and fill
   next-open (Freqtrade semantics). Tick-level engines (nautilus) behave
   differently — conformance tests must compare with tolerance, not equality.

## 3. Candidate future targets (knowledge-based; verify before committing)

- **nautilus_trader** — the serious candidate. Event-driven Python/Rust,
  backtest-live parity, **native bracket/OCO order lists** (TP/SL attached to
  entry — maps beautifully to our `one_shot` mode, which Freqtrade can't
  express natively; that's why the one-shot cron sweep exists). Indicators are
  incremental, orders are first-class. No minimal_roi/ROI-table concept —
  targets are orders, which is cleaner. Actively developed. (Unverified
  details: current HL adapter status, exact order-list API names.)
- **jesse** — crypto-native backtest+live framework, indicator-driven; simpler
  than nautilus. (Unverified: HL/DEX support.)
- **Hummingbot** — market-making focus; has an HL connector; wrong shape for
  directional plan execution.
- **backtrader** — effectively unmaintained; not a target.
- **vectorbt / vectorbt-pro** — vectorized RESEARCH, not live execution; could
  serve as a fast conformance-check backtester, not a deploy target.
- **QuantConnect Lean** — heavyweight, no Hyperliquid; unlikely.

## 4. Recommendation

(a) **Keep plan JSON as the seam.** It is the product's IR; brackets/
    Freqtrade/nautilus are plumbing (matches the plan-taxonomy decision).

(b) **Stop the remaining leakage** by formalizing, not by adding fields:
    keep conditions' free text for humans but ADD a parallel typed condition
    AST when we're ready for a second target:

```json
{ "all": [
  { "cmp": "<=", "lhs": {"series":"close"}, "rhs": {"ind":"bb","field":"lower","len":20,"mult":2} },
  { "cmp": "<",  "lhs": {"ind":"rsi","len":14}, "rhs": {"const":30} }
] }
```

    ~10 node types cover ~90% of retail TA setups: ind ref, series ref,
    const, cmp, crossover, and/or/not, nth-timeframe close, time-window.
    The detector can emit BOTH (text for the card, AST for compile); a
    deterministic transpiler per target replaces LLM compile over time.

(c) **Verification pipeline stays framework-agnostic** because every stage
    judges against the PLAN, not the artifact: does it trade, is the first
    fill on the plan's side, is the entry near the plan's level. Adding a
    target later = same ladder, new compile backend + validator. The
    cross-framework conformance test (same plan → two targets → same candle
    window → compare trade sequences within tolerance) drops straight into
    the existing backtest_verify stage.

(d) **Near-term actions** (cheap, high value):
    1. Keep growing the corpus — it's on for every generation now.
    2. Add a weekly query/report over strategy_log: compile pass rate,
       backtest traded-rate, live direction-ok rate, median entry deviation.
    3. When bracket execution (#48) lands, compile `one_shot` plans to native
       brackets first — that's also the moment to trial nautilus, since
       brackets are its home turf.

*Written 2026-07-10. External-framework specifics are knowledge-based (agent
research was cut short by network failures) — re-verify nautilus adapter/API
details before an integration spike.*
