# Working in this repository

Notes for coding agents. Humans should read [CONTRIBUTING.md](CONTRIBUTING.md) first —
this file assumes it.

## What this is

A Next.js app that turns a chart read into a Freqtrade strategy and deploys it to
Hyperliquid through the hosted Superior Trade API. One process, no workers. Strategies do
not execute here — they are submitted to that API, which runs them.

## Commands

```bash
npm run dev           # :3200
npm test              # vitest
npm run check-types   # tsc --noEmit
npm run lint
npm run test:e2e      # 19 checks against a running server, nothing mocked
npm run preview       # render a markdown file the way GitHub will
```

`npm run check-types` reports errors in `components/chart/**` until TradingView's Advanced
Charts is installed (see [docs/charting-library.md](docs/charting-library.md)). Those are
expected. Everything outside that path must be clean.

## The rules that matter

**Never place an order to test something.** Deploying a strategy and withdrawing funds are
irreversible and use whatever account the configured key belongs to. `npm run test:e2e`
and `npm run record` are both written to stop short of `CONFIRM DEPLOY`; keep them that
way. Assert on the guards instead — the quote, the rejection, the 400.

**Never commit a key.** `.env.local` is ignored. Screenshots are captured with privacy
mode on, which masks amounts but not addresses — check images before adding them.

**Do not vendor TradingView's Advanced Charts.** `public/static/charting_library/` and
`public/static/datafeeds/` are gitignored because the licence forbids redistribution.

## Where the logic lives

| File | Why you would open it |
|---|---|
| `app/api/chat/route.ts` | The system prompt — the product's behaviour, in prose |
| `app/api/detect/route.ts` | Chart → structured setup plans |
| `app/api/compile/route.ts` | The validate-and-repair loop |
| `lib/freqtrade-guard.ts` | Every rule a generated strategy must survive |
| `lib/superior-api.ts` | All outbound calls to the Superior Trade API |
| `lib/account.ts` | Who a request is. There is one answer |
| `lib/db/index.ts` | Driver chosen from `DATABASE_URL`; unset means embedded |

## Things that have caught people out

**`/api/compile` repairs, it does not reject.** A 200 does not mean the model got it
right — it means whatever came back is now clean. Assert on the returned code, not on the
status.

**There is no authentication, by design.** `lib/account.ts` returns one fixed account.
Do not add a login to "fix" this; read [docs/architecture.md](docs/architecture.md) first.

**The database is embedded unless `DATABASE_URL` says otherwise.** PGlite under
`./.data/`, migrating itself at boot. Delete the directory to reset.

**Adding a rule to the validator?** Read the "pattern behind the rules" section of
[docs/strategy-pipeline.md](docs/strategy-pipeline.md). Most rules are members of an
unbounded class, and enumerating members is a losing game.

## Before you say you are done

Run `npm test`, `npm run check-types` and `npm run lint`. If you changed a prompt, run the
relevant suite in `evals/` before and after and report both numbers — prompt changes shift
behaviour for every user and cannot be reviewed by reading the diff.

State plainly what you did not verify.
