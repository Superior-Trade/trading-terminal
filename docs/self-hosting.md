# Self-hosting

Configuration, storage, and what changes when it is not on your laptop.

None of this is required to use the terminal —
[terminal.superior.trade](https://terminal.superior.trade) is the same application,
hosted, with a login and nothing to install. This document is for running your own copy.

## Configuration

`.env.example` documents 38 variables. **Two have no default:**

| | |
|---|---|
| `SUPERIOR_TRADE_API_KEY` | [superior.trade](https://superior.trade) → Account → API keys |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |

Everything else works unset. The ones people actually change:

| Variable | Default | |
|---|---|---|
| `AGENT_MODEL` | a Claude Sonnet class model | Any OpenRouter model id |
| `DETECT_MODEL` | as above | The chart-scan model — this one benefits from vision |
| `FALLBACK_MODEL` | `anthropic/claude-sonnet-4.5` | Retried when the agent model errors or rate-limits |
| `NEXT_PUBLIC_CONTEXT_WINDOW_TOKENS` | suits ~200k models | Lower it for a smaller model |
| `NEXT_PUBLIC_HL_NETWORK` | `mainnet` | `testnet` to trade paper |
| `DATABASE_URL` | unset → embedded | See below |
| `NEXT_PUBLIC_FEATURE_LIGHTER_EXCHANGE` | `false` | Venue dropdown, Lighter markets and charts |
| `SUPERIOR_TRADE_API_URL` | `https://api.superior.trade` | A hosted service. Leave it alone |

Analytics (`POSTHOG_KEY`), error reporting (`SENTRY_DSN`) and Google Analytics
(`NEXT_PUBLIC_GA_ID`) are all off unless set. Unset means no network call is made — not
that data is collected and discarded.

## Storage

The driver is chosen from `DATABASE_URL` alone:

| `DATABASE_URL` | Driver | Notes |
|---|---|---|
| unset | **PGlite** — embedded Postgres in `./.data/pglite` | Nothing to install. Migrates itself at boot |
| `*.neon.tech` | Neon HTTP | Serverless-friendly, no pooling |
| anything else | node-postgres | Any ordinary Postgres |

Only the embedded database migrates itself, because nothing else could — the file comes
into existence the first time the app opens it. A `DATABASE_URL` you manage is yours to
migrate deliberately with `npm run db:migrate`. Set `DB_AUTO_MIGRATE=1` to opt in anyway.

`PGLITE_PATH` moves the embedded data directory. Delete `./.data/` to start clean; you
lose conversations, saved plans and recorded order flow, and nothing else.

Migrations use a direct connection where one exists — `DATABASE_URL_UNPOOLED` or
`POSTGRES_URL_NON_POOLING`, both of which Neon provides.

## Running it somewhere else

Any host that runs a Next.js app: Vercel, Fly, Railway, a container, your own box.

```bash
npm run build
npm start
```

Three things change once it is not local:

**1. Put authentication in front of it.** There is none built in. `lib/account.ts`
returns one account for every request, and that account can trade and move funds. A
reverse proxy with basic auth, a VPN, or an SSH tunnel — any of them, but not nothing.

**2. Set `DATABASE_URL`.** The embedded database is a directory on local disk. Serverless
platforms do not keep it between deploys, and two instances cannot share it.

**3. Schedule the sweep.** Point something at `/api/cron/one-shot-sweep` every minute:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/one-shot-sweep
```

It stops one-shot deployments once their trade has closed, so they cannot re-enter.
Skipping it affects one-shot plans only — everything else is unaffected. With
`CRON_SECRET` unset the route is open, which is fine locally and not fine in public.

## Emergency stop

Money-moving routes can be frozen with an environment variable, no code change:

| | |
|---|---|
| `FREEZE_ALL=1` | Every category at once |
| `FREEZE_WITHDRAWALS=1` | |
| `FREEZE_DEPOSITS=1` | |
| `FREEZE_TRADING=1` | |

A frozen route answers 503 with "your funds are safe, try again shortly". Use it the
moment a ledger or balance anomaly appears, then investigate. On a platform where env
changes need a redeploy, pair it with an instant rollback.

Note that this does **not** stop strategies already running — those live on the Superior
Trade API and are stopped from the deployments panel or the API.

## The chart library

`public/static/charting_library/` and `public/static/datafeeds/` are gitignored and must
be installed per machine, including on any build host. See
[charting-library.md](charting-library.md). A CI or deploy pipeline needs the same
TradingView access your laptop has.
