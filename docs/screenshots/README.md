# Screenshots

The README needs images and does not have them. This is the single biggest gap in the
repository's presentation: a visual trading terminal that shows you nothing is asking to
be scrolled past.

Nobody has captured them yet because they have to come from a real terminal, and a real
terminal has somebody's real balances in it.

## What to capture

| File | Shot |
|---|---|
| `terminal.png` | The whole thing — chart with a drawn setup, chat panel open, running setups in the sidebar. This is the hero image |
| `setup-card.png` | One setup card: entry, stop, target, invalidation, tier |
| `chat.png` | A conversation where the agent draws on the chart and explains why |
| `running.png` | The running-setups panel with live PnL |

## Before you take them

**Turn on privacy mode** — the eye toggle in the header. It masks every dollar amount in
the UI, which is exactly what you want in a public screenshot.

Then check the frame for the things privacy mode does not hide:

- wallet addresses (header, accounts dialog, deployment rows)
- the account dropdown
- browser tabs, bookmarks, notifications, anything outside the app

Crop to the app. 1600×1000 or thereabouts, dark theme, on a real market with real candles
— an empty chart sells nothing.

## Adding them

Drop the files here and replace the `<!-- SCREENSHOT GOES HERE -->` comment in the README
with:

```markdown
<img src="docs/screenshots/terminal.png" alt="The terminal" width="900">
```

Keep them under ~500 KB each; PNG for UI, and run them through an optimiser. Nobody
should clone a repository and get megabytes of screenshots with it.
