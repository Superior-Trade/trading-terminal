# Security Policy

This project places real orders with real money. We take reports seriously and would
much rather hear about a problem from you than from an incident.

## Reporting a vulnerability

**Do not open a public issue.**

Email **security@superior.trade** with:

- what the issue is and roughly how bad you think it is
- the steps to reproduce it
- the version or commit you found it on

You will get an acknowledgement within 2 business days and an assessment within 5. We
will keep you updated while we work on a fix, and we will credit you when it ships
unless you would rather we did not.

Please give us a reasonable window to fix an issue before disclosing it publicly.

## What is in scope

The code in this repository:

- how the API key is stored and forwarded, and anything that could leak it to the
  browser or to a third party
- order construction, position sizing and the safety validation around it
- the strategy validator, and anything that lets generated code escape it
- injection through chat, chart drawings or generated strategy code

Out of scope: the Superior Trade API, Hyperliquid, OpenRouter and TradingView.
Report those to the people who run them.

This policy covers the code in this repository. The hosted terminal at
terminal.superior.trade runs the same code with authentication in front of it; report
issues with either to the address above.

## Running this yourself

A few things worth knowing if you host it:

- **Your keys are on your machine.** `.env.local` is gitignored. Keep it that way — a
  Superior Trade API key can move funds.
- **There is no login.** Anyone who can reach the port can trade with your key. That is
  the intended design for something running on your own machine, and it is exactly why
  you must not expose it on a public address without putting authentication in front of
  it — a reverse proxy, a VPN, or an SSH tunnel.
- **Read the strategies before you deploy them.** The agent writes code, and the
  validator catches the failures we know about — not the ones we do not.
- **`FREEZE_ALL=1`** rejects every money-moving route with a 503. It is there for the
  moment you need everything to stop while you work out what happened.

## Official channels

Everything official lives at exactly these addresses:

- [github.com/Superior-Trade](https://github.com/Superior-Trade) — the code
- [superior.trade](https://superior.trade) and
  [terminal.superior.trade](https://terminal.superior.trade) — the product
- [@SuperiorTrade_](https://x.com/SuperiorTrade_) on X
- [discord.gg/aVZR8cCxcR](https://discord.gg/aVZR8cCxcR)

Anything else claiming to be us is not us. We will never DM you first, and **there is
no Superior Trade token and there never will be** — anyone selling one is running a
scam. Report impersonation to **security@superior.trade**.
