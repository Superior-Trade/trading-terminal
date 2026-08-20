# Screenshots and video

## What is here

| File | Source | Used by |
|---|---|---|
| `wordmark.png` | cropped from the app header at 2x | README hero |
| `terminal.png` | live capture: chart + ranked setups | README hero |
| `deployments.png` | live capture: the running-setups panel | README |
| `demo.mp4` | the launch video, 1664x855 | **gitignored** — see below |

Cut from the launch video
([@SuperiorTrade_](https://x.com/SuperiorTrade_/status/2083623018425921633)), which frames
the app inside a marketing mockup on a gradient background.

### Cropping

The app window is at **`crop=1664:855:128:113`** on the 1920x1080 source. That was measured,
not guessed: build a per-column and per-row profile of "fraction of pixels that are dark"
and the window is the contiguous band where it stays above ~0.55. Do not try to find it by
scanning inward for the first dark run — the app's own header is dark too, so that finds
the content area and silently cuts the header and the toolbar off.

Verify a new crop by checking the four corners are app-dark rather than gradient-bright.

### Privacy

Two passes, both required:

1. **Balances** were already masked because privacy mode was on during the recording —
   the eye toggle in the header.
2. **The wallet address** is not covered by that, and is blurred at
   `crop=178:40:1492:4` within the cropped frame. Applied at full resolution before any
   scaling.

Re-check both if you re-cut from a different source.

### Why there is no GIF

There was one, and it was wrong. Dense UI text does not survive being scaled down, and a
GIF large enough to stay readable is not something to put in a repository:

| Width | Size for 5 seconds |
|---|---|
| 760 px | 1.5 MB — unreadable |
| 1200 px | 7.4 MB |
| 1360 px | 9.7 MB |
| 1664 px | 10.4 MB |

So the inline images are sharp PNGs at native resolution, and motion lives in the video
below. A still that you can read beats a loop that you cannot.

### The video

`demo.mp4` is 1664x855 with audio, cropped to the app, outro trimmed, 7.2 MB — under
GitHub's 10 MB attachment limit for free accounts on purpose.

It is **deliberately not committed**. Drag it into any GitHub issue, PR or release comment
(do not submit — the upload alone is enough) and you get a permanent CDN URL. Paste that
URL bare on its own line in the README and GitHub renders a real player:

```markdown
https://github.com/user-attachments/assets/....
```

Nothing enters the repository, so no clone ever pays for it. That is the whole reason to
prefer this over committing a file.

Renders on github.com only — npm, mirrors and local editors show a bare link, which is why
the sharp stills carry the README on their own.

---

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
<img src="docs/media/your-file.png" alt="What it shows" width="900">
```

Keep each under ~500 KB. PNG for UI, run it through an optimiser first.

---

## Social preview

Separate from all of the above: the image that appears when the repository is linked on
X, Slack or Discord. Set it at **Settings → General → Social preview**, 1280×640.

It is not part of the repository and not this file's problem, but an unset one renders as
a grey box with a filename in it, which is a bad first impression for a link somebody else
shared.
