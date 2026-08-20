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

The Next.js app is the whole product. It holds your keys server-side, talks to the three
services above, and serves the terminal. Strategies do not execute in this process —
they are deployed to the Superior Trade API, which runs them as live bots.

## Configuration

`.env.example` documents every variable. The ones worth knowing about:

| Variable | Default | Notes |
| --- | --- | --- |
| `SUPERIOR_TRADE_API_KEY` | — | Required. |
| `OPENROUTER_API_KEY` | — | Required. |
| `AGENT_MODEL`, `DETECT_MODEL` | compiled-in | Override to trade cost against quality. |
| `DATABASE_URL` | unset | Unset runs the embedded database. Any Postgres URL works; a `*.neon.tech` host uses Neon's HTTP driver. |
| `AUTH_MODE` | `local` | See below. |
| `NEXT_PUBLIC_HL_NETWORK` | `mainnet` | `testnet` to trade paper. |
| `POSTHOG_KEY`, `SENTRY_DSN`, `NEXT_PUBLIC_GA_ID` | unset | All analytics and error reporting are off unless you switch them on. |

### Running it for other people

`AUTH_MODE=local` is the default and assumes one operator: no login, one account, your
key. If you want to host the terminal for others, set `AUTH_MODE=privy` and supply
`PRIVY_APP_ID` — every visitor then signs in, gets their own Superior key, and sees only
their own conversations, plans and deployments.

A production build refuses to start in local mode unless you set `AUTH_MODE=local`
explicitly. Forgetting to configure auth on a public deployment fails closed rather than
quietly serving one shared account to the internet.

## Deploying

Any host that runs a Next.js app works — Vercel, Fly, Railway, a container, your own box:

```bash
npm run build
npm start
```

Two things to get right when it is not on your laptop:

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

`evals/` holds the agent evaluations — behaviour suites, tool-use cases, and full-flow
runs against a live dev server. They are how changes to the prompts get judged.

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
