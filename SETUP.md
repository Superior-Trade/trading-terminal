# Agent setup guide

You are an AI agent setting up the Superior Trade terminal on this machine. Follow the
steps in order. Each step ends with a check — do not continue past a failed check;
report it instead.

This document is the contract: if a step here does not work as written, that is a bug
in this document, and saying so is a useful outcome.

## What you are building

A local web terminal on `http://localhost:3200` where a human draws on a chart and an
agent turns the drawing into a validated, deployable trading strategy. Everything runs
locally except the market data and models it talks to.

## Step 0 — prerequisites

```bash
node --version    # need >= 20.9
git --version     # any recent
```

If Node is missing or too old, stop and tell your human. Do not install Node yourself
unless they ask you to.

## Step 1 — clone and install

```bash
git clone https://github.com/Superior-Trade/trading-terminal.git
cd trading-terminal
npm install
```

**Check:** `npm install` exits 0. Warnings are fine; errors are not.

## Step 2 — keys

Two keys, nothing else:

| Key | Where it comes from | Without it |
|---|---|---|
| `SUPERIOR_TRADE_API_KEY` | [superior.trade](https://superior.trade) → Account → API keys | No market data, no deployments |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | The agent panel cannot think |

You cannot create these accounts yourself — **ask your human for both keys.** While you
wait, continue to Step 3; the app boots without them and tells you what is missing.

```bash
cp .env.example .env.local
# put the two keys in .env.local when you have them
```

While setting up, add these two lines to `.env.local` as well:

```
NEXT_PUBLIC_HL_NETWORK=testnet
FREEZE_ALL=1
```

`testnet` keeps every order off mainnet. `FREEZE_ALL=1` makes every money-moving route
return 503 — remove it only when your human says the setup is done and reviewed.

**Check:** `.env.local` exists and is listed in `.gitignore` (it already is — verify,
never commit it).

## Step 3 — run

```bash
npm run dev
```

**Check:** within ~30 seconds the terminal prints a local URL. Open
`http://localhost:3200` (curl is fine: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3200`
should return 200). First boot also creates `./.data/` — an embedded Postgres that
migrates itself; no database of your own to provision.

If port 3200 is taken: `npx next dev -p 3201` and adjust the checks.

You will see the **preview chart** (Lightweight Charts), not TradingView — that is
expected on a fresh clone. Drawing on the chart and indicator studies need TradingView
Advanced Charts, which a human must request (free) at
[tradingview.com/advanced-charts](https://www.tradingview.com/advanced-charts/), then
`npm run setup:charts`.

## Step 4 — verify what state you are in

With **no keys**: the app serves, the chart renders, and key-dependent panels say so.
That is a correct no-key state, not a failure.

With **both keys** in `.env.local` (restart `npm run dev` after adding them):

```bash
npm test              # unit tests — should pass
npm run check-types   # should pass
npm run test:e2e      # needs the dev server running; drives the real app.
                      # It never deploys and never withdraws by design.
```

**Check:** unit tests green. e2e green with keys present. With `FREEZE_ALL=1` any
money-route test is expected to see 503 — that is the freeze working.

## Step 5 — report

Tell your human, in this order:

1. Which steps passed their checks.
2. Which step failed first, the exact command, and the exact error.
3. What state the terminal is in (no-key boot / keyed, tests passing / etc).
4. Anything this document told you that turned out to be wrong.

## What you must not do

- Do not put real funds anywhere. Setup ends at "running on testnet, frozen".
- Do not remove `FREEZE_ALL=1`, change `NEXT_PUBLIC_HL_NETWORK`, or deploy a strategy —
  those are human decisions.
- Do not commit `.env.local` or paste key values into logs, issues, or chat.
- Do not expose the port publicly; there is no login (see [SECURITY.md](SECURITY.md)).
