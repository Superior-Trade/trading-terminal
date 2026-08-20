<div align="center">

<img src="public/logo-dark.png" alt="Trading Terminal" width="320">

# Trading Terminal

**Draw on the chart. Describe the idea. Get a strategy you can actually run.**

An AI trading terminal you host yourself. It reads your chart, turns a plain-language
thesis into a real Freqtrade strategy, backtests it, and deploys it live on Hyperliquid.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.9-brightgreen.svg)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org)

</div>

---

## What it does

You mark up a chart the way you already do — a level, a zone, a trendline — and say what
you think. The agent takes it from there:

- **Reads the chart you are looking at.** Your drawings, the visible range, the
  indicators you have plotted, and a screenshot go to the model with your message.
- **Finds setups.** Scan the chart and get structured plans back: entry, stop,
  target, invalidation, and the reasoning that produced them.
- **Writes the strategy.** Plain language in, a real Freqtrade strategy out —
  validated, checked for lookahead bias, and smoke-run against candles before it is
  allowed anywhere near your money.
- **Backtests it.** On real historical data, before you risk anything.
- **Deploys it live** on Hyperliquid, with position sizing, leverage, bracket orders
  and time-boxed auto-stops.
- **Watches it.** Live PnL, order flow, liquidation heatmaps, and an inbox that tells
  you when something happened.
- **Moves the money.** Deposit USDC into trading, shuffle it between accounts, and
  withdraw it back out — see [docs/withdrawals.md](docs/withdrawals.md) for how far
  that last one goes.

Everything runs on your machine. The only things that leave it are the API calls you
configure.

## Quick start

You need **two keys** and nothing else:

| Key | What it is | Where |
| --- | --- | --- |
| `SUPERIOR_TRADE_API_KEY` | Runs backtests and live strategies | [superior.trade](https://superior.trade) → Account → API keys |
| `OPENROUTER_API_KEY` | Powers the agent | [openrouter.ai/keys](https://openrouter.ai/keys) |

```bash
git clone https://github.com/Superior-Trade/trading-terminal.git
cd trading-terminal
npm install

cp .env.example .env.local     # then fill in the two keys above

npm run setup:charts           # see "The chart library" below
npm run dev
```

Open <http://localhost:3200>.

There is no database to provision, no account to create and no login screen. The
terminal runs an embedded Postgres out of `./.data/` and treats you as the only user.

### The chart library

The chart is the one part of this terminal we are not allowed to ship. It is
TradingView's [Advanced Charts](https://www.tradingview.com/advanced-charts/), which
they license to you directly — free — but which nobody may redistribute.

Request access (it usually takes a day or two), and once your GitHub account is granted
the repository:

```bash
npm run setup:charts
```

That clones it into `public/static/`, where the build expects it. See
[docs/charting-library.md](docs/charting-library.md) for the manual route and for what
to do when the clone fails.

## How it fits together

```
   your browser
        │
        │  chart, drawings, chat
        ▼
   Next.js app  ──────────────►  OpenRouter        the agent
        │                        (your key)
        │
        ├──────────────────────►  Superior Trade API   backtests, live deployments,
        │                         (your key)           accounts, funding
        │
        ├──────────────────────►  Hyperliquid          prices, candles, positions
        │                         (public)
        │
        └──────────────────────►  embedded Postgres    conversations, plans, order flow
                                  (./.data)
```

The Next.js app in this repository is the whole of what you run. It holds your keys
server-side, talks to the three services above, and serves the terminal.

The Superior Trade API is a hosted service, not part of this repository and not
something you stand up yourself: strategies do not execute in this process, they are
deployed to that API, which runs them as live bots against your account. All you supply
is the key.

## Configuration

`.env.example` documents every variable. The ones worth knowing about:

| Variable | Default | Notes |
| --- | --- | --- |
| `SUPERIOR_TRADE_API_KEY` | — | Required. |
| `OPENROUTER_API_KEY` | — | Required. |
| `AGENT_MODEL`, `DETECT_MODEL` | compiled-in | Override to trade cost against quality. |
| `DATABASE_URL` | unset | Unset runs the embedded database. Any Postgres URL works; a `*.neon.tech` host uses Neon's HTTP driver. |
| `NEXT_PUBLIC_HL_NETWORK` | `mainnet` | `testnet` to trade paper. |
| `POSTHOG_KEY`, `SENTRY_DSN`, `NEXT_PUBLIC_GA_ID` | unset | All analytics and error reporting are off unless you switch them on. |

### There is no login

The terminal is single-operator by design. It holds your API key, and every request it
serves is you — asking you to authenticate to your own computer would add a password
without adding a guarantee.

The practical consequence: **anyone who can reach the port is you.** Keep it on
localhost or behind something that does authentication for you. Do not put it on a
public address as-is.

## Deploying

Any host that runs a Next.js app works — Vercel, Fly, Railway, a container, your own box:

```bash
npm run build
npm start
```

Three things to get right when it is not on your laptop:

- **Put authentication in front of it.** There is none built in, and the app can move
  funds. A reverse proxy with basic auth, a VPN, or an SSH tunnel — any of them, but not
  nothing.
- Set `DATABASE_URL`. The embedded database lives on local disk, which serverless
  platforms do not keep between deploys.
- Point a scheduler at `/api/cron/one-shot-sweep` every minute, with
  `Authorization: Bearer $CRON_SECRET`. It stops one-shot strategies once their trade
  has closed. Skipping it only affects one-shot plans.

## Development

```bash
npm run dev           # dev server on :3200
npm test              # vitest
npm run check-types   # tsc --noEmit
npm run lint          # eslint
npm run db:generate   # create a migration after editing lib/db/schema.ts
```

With the dev server running, `node evals/e2e.mjs` drives the whole app end to end —
boot, database, the Superior Trade API, market data and real model calls — against no
mocks at all. It never spends money: deploying and withdrawing are the two irreversible
actions and it stops short of both.

`evals/` also holds the agent evaluations — behaviour suites, tool-use cases and
full-flow runs. They are how changes to the prompts get judged.

Design notes for the trickier subsystems are in [`docs/`](docs).

## Money, and the honest part

This software places real orders with real money by design. Read the strategies it
writes before you deploy them. Start on `testnet`, or with an amount you would shrug at.

It is not investment advice, it makes no promise of profit, and neither the agent's
reasoning nor its backtests predict the future. You are responsible for what you run.

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) © Superior Trade.

TradingView's Advanced Charts is licensed separately by TradingView and is not covered
by this license or included in this repository. Third-party notices are in
[NOTICE](NOTICE).
