# Withdrawals

Getting money out is two hops, and this terminal does the first one.

```
  Hyperliquid trading wallets              ← your strategies trade here
        │
        │  ①  Withdraw  (this terminal, API key)
        ▼
  your Superior wallet on Arbitrum         ← still custodied by Superior
        │
        │  ②  Cash out   (superior.trade, signed-in session)
        ▼
  a wallet you hold the keys for
```

## Hop ① — what the Withdraw button does

`POST /v3/portfolio/hyperliquid/withdraw` on the Superior Trade API, authenticated with
your API key. It moves USDC off Hyperliquid and into your own Superior wallet on
Arbitrum One.

Before calling it, the route sweeps any idle trading wallets into your main wallet,
because that is the only wallet the venue withdrawal can draw from. Wallets that a
running strategy occupies are never touched — that is its budget.

Hyperliquid charges its own fee (about $1) and the transfer takes roughly five minutes
to land.

This is the deposit dialog run backwards, and it is genuinely useful on its own: it
takes your money out of trading risk without needing anyone's permission but your key's.

## Hop ② — why the terminal cannot do it

There is no destination field in the dialog because the API does not accept one. It
resolves the destination from your key and returns **403** for a client-supplied
external address.

That is deliberate on their side, and the reasoning is sound. The Superior wallet is
custodied — Superior holds its key. An API key is a bearer credential: it lives in a
`.env.local`, gets pasted into terminals, and is exactly the kind of thing that leaks.
If an API key alone could name an arbitrary destination and send funds there, a leaked
key would be a drained account. So the last hop requires a signed-in session plus either
an emailed one-time code or a funding wallet you have already proven you control, and
the destination is pinned to the wallet you logged in with.

Routing around that would mean reimplementing the check with weaker evidence, in
software you run yourself, to protect money you cannot get back. This repository does
not do that, and pull requests that add it will not be merged.

To complete hop ②, sign in at [superior.trade](https://superior.trade) and withdraw from
there.

## If you want the whole thing to be yours

Trade on Hyperliquid with a wallet you control and there is no hop ② at all — the funds
are already yours, and Hyperliquid's own withdrawal is the only step. The trade-off is
that you give up the managed-account features this terminal is built on: provisioned
sub-accounts per strategy, agent wallets, and deployments that run without your key
being present at execution time.

## Related code

| File | What it does |
| --- | --- |
| `app/api/withdraw/route.ts` | Quote, balance re-check, sweep, then the venue call |
| `lib/superior-api.ts` → `withdrawToSuperiorWallet` | The `/v3` call itself |
| `lib/superior-api.ts` → `prepareHyperliquidWithdrawal` | Sweeps idle wallets into main |
| `lib/superior-api.ts` → `withdrawQuote` | What is actually reachable right now |
| `components/terminal/withdraw-dialog.tsx` | The dialog |
| `lib/kill-switch.ts` | `FREEZE_WITHDRAWALS=1` / `FREEZE_ALL=1` rejects hop ① with a 503 |
