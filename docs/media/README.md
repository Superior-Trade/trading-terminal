# Screenshots and video

## What is here

| File | Where it came from | Used by |
|---|---|---|
| `terminal-loop.gif` | 35.0–40.5s of the launch video, 10 fps, 760 px, 1.5 MB | README hero |
| `terminal.png` | 36s — plan drawn on the chart, two ranked setups | README, "the loop" |
| `setup-cards.png` | 26s — setup cards in detail | spare |
| `demo-github.mp4` | the full 46s video, 1280 px, 2.9 MB | **gitignored** — see below |

All of them are cut from the launch video
([@SuperiorTrade_](https://x.com/SuperiorTrade_/status/2083623018425921633)), which frames
the app inside a marketing mockup on a gradient background. They are cropped to
`1672×872+130+104`, which is the app and nothing else.

**Two privacy passes were applied:** account balances were already masked (privacy mode
was on during the recording), and the wallet-address pill in the header is blurred at
`170×34+1490+16`. Re-check both if you re-cut from a different source.

`demo-github.mp4` is deliberately not committed. It exists to be dragged into a GitHub
comment — see below — so the full video never costs anyone a clone.

## What is still missing

Nothing shows a **deployed strategy running**: the launch video stops at
`COMPILING STRATEGY`, so there is no live-PnL footage. That is the one shot worth
recording fresh. `running.png` is the file to add.

---

## Before you record anything

**Turn on privacy mode** — the eye toggle in the header. It masks every dollar amount in
the UI, which is exactly what a public screenshot needs.

Then check the frame for what privacy mode does **not** hide:

- wallet addresses (header, accounts dialog, deployment rows)
- the account dropdown
- browser chrome — tabs, bookmarks, notifications, anything outside the app

Dark theme, a real market with live candles. An empty chart sells nothing.

---

## Video

Three ways to put a video in a README. They are not equivalent.

### 1. GitHub-hosted upload — the good one

Drag an `.mp4` or `.mov` into any issue, PR, or release comment on GitHub. Do not submit
it — the upload alone gives you a permanent CDN URL. Paste that URL **bare on its own
line** in the README and GitHub renders a real player, with controls and audio.

```markdown
https://github.com/user-attachments/assets/....
```

- **Nothing enters the repository.** No clone pays for it, ever. This is the whole reason
  to prefer it.
- Limits: 10 MB on free accounts, 100 MB on Pro/Team/Enterprise. `.mp4` and `.mov`.
- Renders on github.com only — npm, mirrors and local editors show a bare link.

### 2. An animated GIF — the portable one

Works everywhere: github.com, npm, forks, offline editors, anything that renders
markdown. No controls, no audio, and the file is large for what it is.

Keep it to **8–12 seconds** of the single best moment — a level drawn, the plan appearing.
Not the whole flow. Target under 3 MB; `gifski` from an mp4 gets decent quality at that
size.

A GIF committed to the repo is permanent — git history keeps it even if you delete the
file later. Compress before the first commit, not after.

### 3. A thumbnail linking out — the fallback

```markdown
[![Watch the demo](docs/media/thumb.png)](https://youtu.be/...)
```

Universal and cheap, but it is a click away, and most people do not click.

### What to do here

**Both 1 and 2.** A short GIF inline at the top so the README works everywhere, and the
full walkthrough as a GitHub-hosted video underneath it. That is what the repositories
you admire are doing.

### What the video should show

The loop, in about 40 seconds, no narration needed:

1. A chart. Draw a level on it.
2. Ask the question in plain language.
3. The plan card appears — entry, stop, target, invalidation.
4. Deploy. The strategy compiles and the validator passes it.
5. It appears in running setups with live PnL.

Resist showing the settings menu, the theme picker, or anything that is not the loop.

---

## Screenshots

| File | Shot |
|---|---|
| `terminal.png` | The whole thing — chart with a drawn setup, chat open, running setups in the sidebar. The hero image |
| `setup-card.png` | One setup card: entry, stop, target, invalidation, tier |
| `chat.png` | The agent drawing on the chart and explaining why |
| `running.png` | Running setups with live PnL |

1600×1000 or thereabouts. Drop them here and replace the `<!-- SCREENSHOT GOES HERE -->`
comment in the README with:

```markdown
<img src="docs/media/terminal.png" alt="The terminal" width="900">
```

Keep each under ~500 KB. PNG for UI, run it through an optimiser first.

---

## Social preview

Separate from all of the above: the image that appears when the repository is linked on
X, Slack or Discord. Set it at **Settings → General → Social preview**, 1280×640.

It is not part of the repository and not this file's problem, but an unset one renders as
a grey box with a filename in it, which is a bad first impression for a link somebody else
shared.
