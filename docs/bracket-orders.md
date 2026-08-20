# Bracket orders — lightweight one-shot execution (design + prod findings)

_2026-07-10. Status: pipeline verified on prod; sub-account path blocked by an
exchange gate; recommendation below._

## Goal

A `one_shot` plan with a **fixed entry price** doesn't need a Freqtrade pod.
Its whole lifecycle is expressible as native exchange orders — a **bracket**:

```
entry (limit, GTC)  +  take-profit (trigger, reduce-only)  +  stop-loss (trigger, reduce-only)
```

Hyperliquid supports this atomically: one `order` action with three orders and
`grouping: "normalTpsl"` — TP/SL park until the entry fills, then arm as an
OCO pair. No pod cost, instant placement, survives infra restarts. Conditional
(indicator-gated) entries stay on Freqtrade; this only replaces the
fixed-price subset — exactly the `entrySource: fixed ⇒ one_shot` class.

## What exists in the prod API today (verified live 2026-07-10)

`POST /v2/authorize-and-send/hyperliquid` (PR #591, deployed):

- Whitelisted actions: `createSubAccount`, `subAccountModify`,
  `subAccountTransfer`, `sendAsset`, `userSetAbstraction`, `order`, `cancel`.
- Signs with the authenticated user's **main wallet** key server-side.
- `order`/`cancel` REQUIRE `vaultAddress` = an owned **sub-account**;
  master-account orders are rejected by design.
- **Verified end-to-end**: an authenticated `createSubAccount` request flowed
  through auth → server-side signing → Hyperliquid and returned HL's own
  response. The pipeline works.

## The blocker: HL's sub-account volume gate

Hyperliquid refuses sub-account creation until the master account has
**$100,000 lifetime traded volume**:

```
"Cannot create sub-accounts until enough volume traded.
 Required: $100000. Traded: $8277.07."
```

Also verified: none of the existing trading wallets (Main Account 1,
Trading Account 2/3) are HL sub-accounts — they're independent wallets from
Superior's per-deployment provisioning, so they can't be `vaultAddress`
targets either.

**Product decision (2026-07-10):** sub-accounts are OFF the table entirely —
Superior's concurrency model is **multiple trading accounts** (Trading
Account 2/3 …), one active execution per wallet. That also sidesteps the
volume gate completely, but it means authorize-and-send's `order`/`cancel`
path (sub-account-only by design) is simply not the bracket vehicle.

## Recommendation: Superior-side bracket on TRADING ACCOUNTS

Superior provisions the trading-account wallets and signs for them (that's
how Freqtrade bots trade on them today). Brackets should be a first-class
upstream endpoint reusing that signing infra, targeting the same wallets:

```
POST /v2/bracket
{ pair, side, entry, take_profit, stop_loss, size_usd, leverage,
  alive_until?, account_address? }
→ picks (or takes account_address) a FREE trading account — one active
  execution per wallet, exactly the deployment rule — sets leverage,
  places the normalTpsl group with that wallet's key,
  returns { id, wallet_address, order_ids }

GET  /v2/bracket/:id      → status (resting | active | tp_filled | sl_filled | cancelled)
DELETE /v2/bracket/:id    → cancel group / close position, free the wallet
```

Notes for the API team:
- Trading accounts are masters trading for themselves — no HL volume gate.
- Leverage must be set before entry (`updateLeverage` with the wallet's own
  key — not exposed through authorize-and-send today, fine server-side).
- Wallet-busy semantics identical to deployments (a wallet running a bot or
  a bracket rejects a second execution; deleting frees it).
- `alive_until` semantics can mirror deployments (auto-cancel/close at T).

## terminal-v2 integration (once the endpoint exists)

- Deploy button auto-routes: `mode === "one_shot"` && fixed entry → bracket;
  everything else → Freqtrade. Copy on the confirm step says which engine.
- Running Setups renders brackets with the existing LiveRows
  (positions/open-orders per wallet) — no new visualization needed.
- One-active-per-wallet rule unchanged.
- Analytics: `bracket_placed` / `bracket_filled` / `bracket_cancelled` in
  the 4-trading funnel stage.

## Fallback if upstream says no

Gate the sub-account path client-side: offer brackets only when
`subAccounts` exist or volume ≥ $100k, with a clear explainer. Not
recommended as the primary path (excludes most users).
