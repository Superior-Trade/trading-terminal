# Contributing

Thanks for being here. Bug reports, strategy-generation improvements, new venues and
documentation fixes are all welcome.

## Getting set up

```bash
npm install
cp .env.example .env.local     # SUPERIOR_TRADE_API_KEY + OPENROUTER_API_KEY
npm run setup:charts           # docs/charting-library.md
npm run dev
```

The embedded database creates itself on first run, so there is nothing else to
provision. Delete `./.data/` to start from a blank one.

## Before you open a pull request

```bash
npm test
npm run check-types
npm run lint
```

All three should be clean. CI runs the same three on every pull request.

## What we look for

**Explain the why, not the what.** The comments in this codebase say why a thing is the
way it is — which bug it came from, what breaks without it. `// increment counter` above
`i++` is noise; `// Vercel freezes the lambda mid-send, so delivery rides after()` is
what a future reader needs. If a decision is not obvious in six months, write it down.

**Tests for anything that can silently be wrong.** Sizing, order construction, safety
validation and error classification all have tests because a quiet failure there costs
somebody money. Match that bar.

**Small and separate.** One change per pull request. A refactor bundled with a fix makes
both harder to review and impossible to revert cleanly.

**Say how you tested it.** "Ran a backtest on BTC 15m and the entries landed where the
plan said" tells us more than a green checkmark.

## Things that need extra care

Some code moves money. Changes to any of these get read closely, and should come with a
test that would have caught the bug:

- `lib/plan-sizing.ts`, `lib/sizing-ceiling.ts` — how much of your balance a trade uses
- `lib/superior-api.ts` — deployments, brackets, transfers
- `lib/freqtrade-guard.ts` — the validation that stops a broken strategy deploying
- `app/api/bracket/`, `app/api/deploy/` — order placement
- `lib/server-auth.ts` — who a request is

Changing a default that makes positions larger, leverage higher or a safety check looser
needs a reason in the pull request body, not just in the diff.

## Prompts and agent behaviour

The system prompts live in `app/api/chat/route.ts` and `app/api/detect/route.ts`. They
are load-bearing: small wording changes shift what the agent does across every user.

`evals/` exists for exactly this. Run the relevant suite against a dev server before and
after your change and put both numbers in the pull request:

```bash
node evals/behavior.mjs --suite=alignment --label=before
# make your change
node evals/behavior.mjs --suite=alignment --label=after
```

## Adding a venue

Hyperliquid and Lighter are both wired through the same seams, so a third venue means:

1. A datafeed in `components/chart/` (candles, live ticks, symbol search).
2. A branch in `components/chart/venue-datafeed-router.ts`.
3. Symbol handling in `lib/venues.ts` and `lib/pair-normalize.ts`.
4. Whatever the Superior Trade API needs to route deployments there.

Open an issue first — step 4 depends on API support that may not exist yet.

## Reporting a bug

Include what you expected, what happened, and the smallest way to reproduce it. For
anything involving a deployed strategy, the strategy code and the plan it came from are
worth more than a screenshot.

Do not open a public issue for a security problem — see [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under [Apache-2.0](LICENSE), the same licence as the project.
