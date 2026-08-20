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

- authentication and how requests are attributed to an account
- how API keys are stored, encrypted and forwarded
- order construction, position sizing and the safety validation around it
- the strategy validator, and anything that lets generated code escape it
- injection through chat, chart drawings or generated strategy code

Out of scope: the Superior Trade API, Hyperliquid, OpenRouter, Privy and TradingView.
Report those to the people who run them.

## Running this yourself

A few things worth knowing if you host it:

- **Your keys are on your machine.** `.env.local` is gitignored. Keep it that way — a
  Superior Trade API key can move funds.
- **`AUTH_MODE=local` means no login.** Anyone who can reach the port is you. Do not
  expose a local-mode instance to the internet; use `AUTH_MODE=privy` for that, which is
  why a production build refuses to start in local mode unless you ask for it by name.
- **Read the strategies before you deploy them.** The agent writes code, and the
  validator catches the failures we know about — not the ones we do not.
- **`FREEZE_ALL=1`** rejects every money-moving route with a 503. It is there for the
  moment you need everything to stop while you work out what happened.
