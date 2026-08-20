<div align="center">

<img src="public/logo-dark.png" alt="Trading Terminal" width="300">

### Draw on the chart. Describe the idea. Get a bot that trades it.

A self-hosted AI trading terminal for Hyperliquid. You mark up a chart and say what you
think; it writes a real Freqtrade strategy, refuses to ship the unsafe ones, backtests
it, and runs it live.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.9-brightgreen.svg)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org)

<!-- SCREENSHOT GOES HERE — chart with a drawn setup, chat open, running setups in the
     sidebar. See docs/screenshots/README.md for what to capture and how. -->

</div>

---

## The loop

**1. You draw a level and ask.**

> *"HYPE keeps rejecting off this line. Is there a mean-reversion trade here on the 15m?"*

**2. The agent reads your actual chart** — your drawings, the visible range, the
indicators you have plotted, and a screenshot of it — and answers with a plan:

| | |
|---|---|
| Entry | 38.20 — close crossing back above the band |
| Stop | 36.90 *(−3.4%)* |
| Target | 41.05 *(+7.5%)* |
| Invalidation | 15m close below 36.50 |

**3. You say deploy.** It writes the strategy, and the validator reads it before
anything else does:

```python
def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
    dataframe.loc[
        (
            (dataframe['volume'] > 0) &                      # no signals on dead candles
            (dataframe['close'] < dataframe['bb_lower']) &
            (dataframe['rsi'] < 40) &
            (dataframe['close'] > dataframe['ema_50'])
        ),
        'enter_long'
    ] = 1
```

**4. It runs.** Live PnL, an auto-stop timer if the edge is time-boxed, and an inbox
that tells you when something happened.

## What actually stops you losing money

The interesting part of this repo is not that a model writes Python. It is what happens
between "the model wrote it" and "it is trading your funds".

Every generated strategy is parsed and checked before it can be submitted. A failure
does not surface as a stack trace — the complaints go back to the model, which rewrites
the strategy, and the loop repeats. A few of the rules, in the validator's own words:

- `code uses shift(-N) — that reads FUTURE candles (lookahead bias); backtests lie and live behaves differently`
- `config.stoploss must be negative — freqtrade stops are always negative, for shorts too`
- `trailing_stop_positive ... at 10x looks unscaled (it is leveraged PnL, like stoploss) — multiply the price % by leverage`
- `entry conditions must include the (dataframe['volume'] > 0) guard so signals never fire on dead candles`
- `startup_candle_count is too low — use ≥ 3× the longest indicator lookback`
- `code uses .iloc[...] inside populate_* — per-row indexing behaves differently live vs backtest`

Most of these came from strategies that reached production and cost real money. Each one
is a scar. [docs/strategy-pipeline.md](docs/strategy-pipeline.md) has the full set and
explains the repair loop.

## Features

| | |
|---|---|
| **Chart** | TradingView Advanced Charts, Hyperliquid + Lighter datafeeds, order-flow footprint, liquidation heatmap, tier-ranked indicators |
| **Agent** | Reads your drawings and a screenshot of the chart; draws back — levels, zones, trendlines, channels, fibs |
| **Setups** | Scan a chart for plans, or design one in conversation. Entry, stop, target, invalidation, confidence tier |
| **Strategies** | Freqtrade code generation, deterministic safety validation, automatic repair, historical backtests |
| **Execution** | Live deployments, bracket orders for one-shot plans, position sizing, leverage caps, time-boxed auto-stop |
| **Funds** | Deposit, transfer between accounts, consolidate idle wallets, withdraw ([one hop](docs/withdrawals.md)) |
| **Local** | Embedded Postgres, no login, no telemetry unless you turn it on |

## Setup

**Two keys.** Nothing else to sign up for.

```bash
git clone https://github.com/Superior-Trade/trading-terminal.git
cd trading-terminal
npm install
cp .env.example .env.local     # add the two keys below
npm run setup:charts           # TradingView — see the note
npm run dev                    # → http://localhost:3200
```

| | Where |
|---|---|
| `SUPERIOR_TRADE_API_KEY` | [superior.trade](https://superior.trade) → Account → API keys |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |

No database to provision, no account to create, no login screen. An embedded Postgres
writes to `./.data/` and migrates itself on first boot.

`.env.example` documents 38 variables. Those two are the only ones without a working
default.

> [!IMPORTANT]
> **The chart needs TradingView's approval, and that takes a day or two.**
> Advanced Charts is free but not redistributable, so we cannot ship it. Apply at
> [tradingview.com/advanced-charts](https://www.tradingview.com/advanced-charts/); once
> your GitHub account is granted the repository, `npm run setup:charts` pulls it in.
> Until then the build stops with instructions. See
> [docs/charting-library.md](docs/charting-library.md).

## Money

This places real orders with real funds by design.

- **Read the strategies before you deploy them.** The validator catches the mistakes we
  know about, not the ones we don't.
- **Start on testnet** (`NEXT_PUBLIC_HL_NETWORK=testnet`) or with an amount you would
  shrug at.
- **A backtest is not a prediction.** Neither is the agent's reasoning.
- **There is no login** — anyone who can reach the port can trade with your key. Fine on
  localhost, dangerous anywhere else. See [SECURITY.md](SECURITY.md).

Not investment advice. No promise of profit. You are responsible for what you run.

## Documentation

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How a sentence becomes a running bot |
| [docs/strategy-pipeline.md](docs/strategy-pipeline.md) | Generation, validation, repair, logging |
| [docs/charting-library.md](docs/charting-library.md) | Installing TradingView Advanced Charts |
| [docs/withdrawals.md](docs/withdrawals.md) | How money gets out, and how far this repo takes it |
| [docs/bracket-orders.md](docs/bracket-orders.md) | One-shot plans as native exchange orders |
| [docs/self-hosting.md](docs/self-hosting.md) | Configuration, databases, running it somewhere else |

## Development

```bash
npm run dev           # dev server on :3200
npm test              # unit tests
npm run test:e2e      # 19 checks against a running server, nothing mocked
npm run check-types
npm run lint
```

`npm run test:e2e` drives the whole app — boot, database, the Superior Trade API, market
data, real model calls. It never spends money: deploying and withdrawing are the two
irreversible actions and it stops short of both.

`evals/` holds the agent evaluations. Prompt changes get judged there, not by vibes —
see [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Issues and pull requests welcome — [CONTRIBUTING.md](CONTRIBUTING.md). The code that
moves money gets read closely; bring a test.

## License

[Apache-2.0](LICENSE) © Superior Trade.

The Superior Trade API is a hosted service and is not part of this repository.
TradingView's Advanced Charts is licensed separately by TradingView and is not included.
Third-party notices: [NOTICE](NOTICE).
