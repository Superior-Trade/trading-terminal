# Architecture

How a sentence becomes a running bot.

## The shape of it

One Next.js app. It serves the UI, holds your keys server-side, and brokers three
outside services. Nothing else runs on your machine.

```
  browser ── chart, drawings, chat
     │
     ▼
  Next.js  ──►  OpenRouter          the agent
     │          (your key)
     ├──────►  Superior Trade API   backtests, deployments, accounts, funding
     │          (your key)          — hosted; not in this repo
     ├──────►  Hyperliquid          candles, prices, positions, order flow
     │          (public)
     └──────►  embedded Postgres    conversations, plans, order-flow history
                (./.data)
```

Strategies do not execute in this process. They are submitted to the Superior Trade API,
which runs them as live Freqtrade bots against your account. That is why the terminal can
be closed while a strategy keeps trading — and why stopping one is an API call, not a
process kill.

## Where the code lives

| Path | What it is |
|---|---|
| `app/api/` | Server routes. Every one holds the key and proxies outward — the browser never sees a credential |
| `components/chart/` | TradingView widget lifecycle, per-venue datafeeds, footprint overlay |
| `components/chat/` | The agent panel, conversation list, tool chips |
| `components/terminal/` | Header, setups panel, dialogs (deposit, withdraw, accounts, keys) |
| `lib/` | Everything with logic in it — see below |
| `evals/` | Agent evaluations and the end-to-end suite |

The files worth reading first:

| File | Why |
|---|---|
| `app/api/chat/route.ts` | The system prompt. This is the product's behaviour, in prose |
| `app/api/detect/route.ts` | Chart → structured setup plans |
| `app/api/compile/route.ts` | The validate-and-repair loop |
| `lib/freqtrade-guard.ts` | The rules a strategy must survive |
| `lib/superior-api.ts` | Every outbound call to the Superior Trade API, in one file |
| `lib/setups-context.tsx` | Client-side state for plans and deployments |
| `lib/agent-tools.ts` | What the agent is allowed to do |
| `lib/account.ts` | Who a request is (one answer) |

## The path a trade takes

**1 — Context.** The chat route assembles what the model sees: your message, your chart
drawings and visible range, the indicators you have on, a screenshot, live market context
(`lib/market-context.ts`), and an order-flow digest if the footprint is on. Older turns
are compacted into a rolling summary rather than replayed (`lib/agent-memory.ts`), so a
long conversation stays affordable.

**2 — A plan.** Either from conversation, or from a scan of the chart (`/api/detect`),
which returns structured plans: entry, stop, target, invalidation, direction, a
confidence tier and the reasoning behind it. A plan is data, not prose — it renders as a
card and drives everything downstream.

**3 — Sizing.** `lib/plan-sizing.ts` and `lib/sizing-ceiling.ts` decide what the panel is
allowed to offer. The ceiling exists because the API tops margin up by a buffer before
accepting a bracket: offering a stake the server will refuse is a bug that reads as
"deploy failed" to the user.

**4 — Code.** `/api/compile` asks the model for a Freqtrade strategy, then refuses to
trust it. See [strategy-pipeline.md](strategy-pipeline.md) — this is the part that
matters.

**5 — Execution.** Two routes, by shape of plan:

- A **recurring** strategy deploys as a live Freqtrade bot (`/api/deploy`).
- A **one-shot** plan with a fixed entry needs no bot at all — it becomes native exchange
  orders — entry plus reduce-only take-profit and stop-loss, placed atomically as
  one Hyperliquid `order` action with `grouping: "normalTpsl"`. The TP and SL park
  until the entry fills, then arm as an OCO pair. No pod to run, and the exchange
  holds the orders, so it survives a restart.

  A bracket occupies a trading wallet exactly like a deployment does, which is why
  teardown is deployment-scoped rather than wallet-scoped — a wallet-wide "cancel
  everything" would kill an unrelated bracket sharing that wallet. Leverage is a
  separate exchange call made before the entry, not part of it.

**6 — Afterwards.** Live PnL polls every few seconds. A time-boxed plan carries an
`aliveUntil`, and `/api/cron/one-shot-sweep` stops one-shot deployments once their trade
has closed so they cannot re-enter.

## Two decisions worth knowing about

**The database is optional-feeling but not optional.** Conversations, saved plans, usage
counters and recorded order flow all live in Postgres. The embedded default (PGlite,
under `./.data/`) exists so that nothing has to be provisioned to get started, and it
migrates itself at boot because nothing else could. Point `DATABASE_URL` at a real
Postgres and it steps aside — see [self-hosting.md](self-hosting.md).

**There is no authentication.** `lib/account.ts` returns one fixed account for every
request. The API key already proves whose account it is, so a login would add a password
without adding a guarantee. The cost is that anyone who can reach the port is you, which
is why the deployment advice is to put something in front of it.

## Adding a venue

Hyperliquid and Lighter go through the same seams, so a third means:

1. A datafeed in `components/chart/` — candles, live ticks, symbol search.
2. A branch in `components/chart/venue-datafeed-router.ts`.
3. Symbol handling in `lib/venues.ts` and `lib/pair-normalize.ts`.
4. Whatever the Superior Trade API needs to route deployments there.

Step 4 depends on API support that may not exist yet, so open an issue first.
