# Strategy pipeline

A language model writes Python that will trade your money. This document is about the
part between those two facts.

The premise: **the model is a fast, fluent, occasionally confident liar, and the code it
writes must survive a machine that assumes so.** Everything here is deterministic. No
model gets a vote on whether its own output is safe.

## The loop

```
   plan ──► model writes strategy
              │
              ▼
        deterministic fixes          talib int→float
              │
              ▼
          VALIDATOR ──── fails ──►  errors handed back to the model
              │                      with the previous attempt attached
              ▼ passes                        │
        submit to the API  ◄──────────────────┘  (bounded retries)
```

The repair leg matters more than it looks. A rejected strategy is not an error the user
sees — it is a prompt. `app/api/compile/route.ts` sends the previous attempt plus the
validator's exact complaints back to the model with "fix EXACTLY these issues, keep
everything else identical". Most violations are fixed on the first retry, invisibly.

That has a consequence worth stating plainly, because it surprises people reading the
tests: **`/api/compile` returning 200 does not mean the model got it right.** It means
whatever came back is now clean. The end-to-end suite asserts the stronger property —
feed it a deliberately lookahead-biased strategy and no `shift(-N)` may appear in the
response, whether that came from a rejection or a rewrite.

## What the validator checks

All of this lives in `lib/freqtrade-guard.ts`.

### Lookahead and backtest fidelity

The failure mode here is the worst one available: a strategy that backtests beautifully
and behaves differently live.

| Rule | Why |
|---|---|
| No `shift(-N)` in `populate_*` | Reads future candles. Backtests lie. |
| No `.iloc[...]` in `populate_*` | Per-row indexing behaves differently live vs backtest |
| No `resample()` in `populate_*` | Lookahead risk — use `merge_informative_pair()` |

### Stops, and the leverage trap

Freqtrade's `stoploss` measures **position PnL, leverage included**. A 3.7% price stop at
10× is `-0.37`, not `-0.037`. Get it wrong and the stop sits ten times tighter than
intended; the bot churns fees until the balance is gone. This happened.

| Rule | Why |
|---|---|
| `stoploss` must be negative | Freqtrade stops are always negative — for shorts too |
| `stoploss > -0.95` | Anything lower wipes the margin |
| `\|stoploss\| < 0.75` at leverage | Otherwise the stop sits at or behind the liquidation price and never fires |
| `stoploss > -0.05` at ≥5× is rejected | That is a plan's raw price-stop, unscaled |
| `minimal_roi` needs a `"0"` key, values ≥ 0 | A negative ROI exits at a loss |
| Trailing: offset > positive, `trailing_only_offset_is_reached: true` | Otherwise it trails from entry and churns out instantly |
| Trailing positive < 0.02 at ≥5× | Same unscaled-leverage bug as the stop |

### Signals that actually fire

A bot that never trades looks healthy. The pod is up, the deployment says *running*, and
nothing happens — the most expensive kind of silent failure, because you only notice when
you check.

| Rule | Why |
|---|---|
| `startup_candle_count` present, 30–999 | Too low and indicators are NaN live; the bot silently never trades |
| Entries must gate on `dataframe['volume'] > 0` | No signals on dead candles |
| No hardcoded absolute price window on an indicator entry | Freezes the signal to a price snapshot — once price leaves it, never fires again. 13 of 18 generated strategies did this in one audit |
| `enter_short` requires `can_short = True` | Short signals are otherwise silently ignored |

### Things that crash on candle one

| Rule | Why |
|---|---|
| TA-Lib float params must be floats | `nbdevup=2` instead of `2.0` crashes every candle |
| Multi-output `ta.` results subscript by NAME | `talib.abstract` returns a DataFrame with named columns, so `bollinger[0]` raises `KeyError: 0`; an unknown name (`bollinger['lower']`) raises its own KeyError. Plain `import talib` tuples are left alone — integer subscripts are correct there |
| No freqtrade order-flow columns | `dataframe['delta']` and friends are never populated on Hyperliquid — `KeyError` on every candle |
| `use_public_trades` / `orderflow` config rejected | Not supported on Hyperliquid |

The subscript rule is a validator hard error, not a silent rewrite, on purpose: a regex
rewrite cannot see scope, so it corrupts holders that are later reassigned and tuple code
under a plain `import talib`. The repair loop converges on the error instead — the model
re-emits the named form. The stakes are per-candle strategy errors: Freqtrade catches
them and logs a warning, so the pod stays healthy, the deployment stays *running*, and a
funded account places nothing while its entry condition is met.

### Sandboxing

Generated code may import only a whitelist, and `exec`, `eval`, `__import__`, `open`,
`compile` and `breakpoint` are refused outright. This is a seatbelt, not a sandbox — the
strategy runs on Superior's infrastructure, not yours, and that boundary is where real
isolation lives.

## The pattern behind the rules

Look at the list again and a shape appears. Almost every rule is a **member of an
unbounded class**: "code that parses but raises", "config that validates but never
trades". We have been catching that class one member at a time — first `nbdevup=2`, then
multi-output subscripts — and each rule is correct, and none of them generalise. The next
mistake will be a different member.

Enumerating members is a losing game. Two things actually close the class:

1. **Run the code.** The API smoke-runs a generated strategy's hooks against a seeded
   dataframe before it can deploy — that catches every "parses but raises" bug at once,
   including the ones nobody has thought of. It fails *open*: a broken runner blocks
   nothing, because a check that can break every deploy on the platform is a worse outage
   than the bug it prevents.
2. **Prove it trades.** A strategy that produces zero trades over its own thesis window
   is a thesis/code mismatch, not a valid strategy. This is not built yet.

When you add a rule, ask which class it belongs to and whether the class can be closed
instead. A rule that only catches the exact bug you just saw is worth having, but it is a
scar, not a cure.

## Logging

Every generated artifact is written to the `strategy_log` table (`lib/strategy-log.ts`):
the plan it came from, the code, the config, the validator verdict, and what happened
next. It is the corpus you audit when something goes wrong in production and the only
record of what the model actually emitted, as opposed to what it was asked for.

## Related

- `lib/freqtrade-guard.ts` — every rule above
- `app/api/compile/route.ts` — the repair loop
- `lib/sizing-ceiling.ts` — what stake the panel may offer
- [architecture.md](architecture.md) — where this sits in the whole
