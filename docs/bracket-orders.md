# Bracket orders

Not every plan needs a bot.

A `one_shot` plan with a **fixed entry price** has a lifecycle that native exchange orders
already express: enter, then take profit or stop out, then done. Running a Freqtrade pod
to wait for a limit fill is a container's worth of infrastructure doing a resting order's
job.

So the terminal routes those to a **bracket** instead: three orders placed atomically.

```
entry (limit, GTC)  +  take-profit (trigger, reduce-only)  +  stop-loss (trigger, reduce-only)
```

Hyperliquid places these as one `order` action with `grouping: "normalTpsl"`. The TP and
SL park until the entry fills, then arm as an OCO pair — whichever fires first cancels the
other. No pod to run, instant placement, and it survives infrastructure restarts because
the exchange is holding the orders, not us.

## Which plans route this way

| Plan | Engine | Why |
|---|---|---|
| `one_shot` with a fixed entry price | **Bracket** | The exchange can express it natively |
| `one_shot` gated on an indicator | Freqtrade | Something has to evaluate the condition each candle |
| `recurring` | Freqtrade | Re-enters whenever the condition triggers again |

The deploy button routes automatically — `lib/setups-context.tsx` checks `mode` and
whether the entry is a fixed price. The confirmation step names the engine, because the
two behave differently and you should know which one you are getting.

## The API

Brackets are placed through the Superior Trade API, which holds the trading wallet's key
and signs server-side — the same infrastructure that runs Freqtrade deployments.

| | |
|---|---|
| `POST /v2/bracket` | `{ pair, side, entry, take_profit, stop_loss, size_usd, leverage, alive_until?, name? }` |
| `GET /v2/bracket` | List, with status |
| `DELETE /v2/bracket/:id` | Cancel the group, close any position, free the wallet |

Wrapped in `lib/superior-api.ts` as `placeBracket`, `listBrackets`, `cancelBracket`; the
terminal's own proxy is `app/api/bracket/route.ts`.

## Rules that are easy to get wrong

**One execution per wallet.** A bracket occupies a trading wallet exactly like a
deployment does. A wallet running a bot rejects a bracket and vice versa; deleting frees
it. This is why the deploy path sweeps for a free account and why teardown is
deployment-scoped rather than wallet-scoped — a wallet-wide "cancel everything" would kill
an unrelated bracket sharing that wallet.

**Leverage is set before entry, not with it.** It is a separate exchange call against the
wallet's own key, done server-side.

**`alive_until` mirrors deployments.** A time-boxed plan auto-cancels at that instant, and
closes the position if the entry has already filled. Use it when the edge itself expires —
a funding window, a session, an event — and not for a swing thesis with no clock on it.

**Running setups render brackets alongside deployments.** They are the same thing to the
user: a plan that is live. The list is ordered by time, not by engine — see
`lib/setup-order.ts`, which exists because sorting by type first put a week-old bot above
a bracket placed a minute ago.

## Related

- `app/api/bracket/route.ts` — the proxy, with the funding checks
- `lib/setups-context.tsx` — routing, and the client-side plan store
- `lib/setup-order.ts` — merging both kinds into one timeline
- [architecture.md](architecture.md) — where execution sits in the whole
