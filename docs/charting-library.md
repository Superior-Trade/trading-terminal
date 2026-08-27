# TradingView Advanced Charts

The chart is TradingView's [Advanced Charts](https://www.tradingview.com/advanced-charts/)
library. It is free, but TradingView licenses it to **you** and forbids redistribution,
so it cannot live in this repository. You have to fetch your own copy once.

**You do not need it to run the terminal.** Without it the app mounts a preview chart
built on [Lightweight Charts](https://github.com/tradingview/lightweight-charts) —
TradingView's open-source library, Apache-2.0, which ships in this repository. A fresh
clone builds and runs; the build prints which chart it selected.

## What the preview gives up

The preview renders the market and takes everything the agent draws, so detect, compile,
backtest and deploy all work end to end. What it cannot do:

| | Advanced Charts | Preview |
|---|---|---|
| **Drawing on the chart yourself** | trendlines, zones, brush, fib, text | **none** |
| Indicator studies | full library, configurable | none |
| Agent levels, zones, trendlines, channels, fibs | yes | yes |
| Entry/stop/target and position overlays | yes | yes |
| Order-flow footprint overlay | yes | no |
| Saved chart layouts | yes | no |
| Symbol and timeframe switching | yes | yes |
| Candles, crosshair, live updates | yes | yes |

The first row is the one that matters. "Draw where you think the market is going" is step
one of the product, and the preview has no drawing tools — so on a preview build you
describe your read in words instead, and the agent still answers with a plan drawn onto
the chart. The loop works; its opening move is narrower.

Actions the preview cannot perform return a truthful error rather than a silent success,
so the agent never claims to have plotted an indicator that is not there.

## 1. Get access

Apply at <https://www.tradingview.com/advanced-charts/>. You give them a GitHub
username; they grant that account access to a private repository. Approval typically
takes a day or two.

You are agreeing to TradingView's terms, not ours. Attribution requirements and usage
limits come from them — read what you sign.

## 2. Install it

Once you have the invitation:

```bash
npm run setup:charts
```

That clones the repository with your own git credentials and copies two directories into
place:

```
public/static/charting_library/   the library itself
public/static/datafeeds/          TradingView's UDF datafeed helpers
```

Both are listed in `.gitignore` and will never be committed.

### If the clone fails

`Repository not found` almost always means the GitHub account your git is authenticated
as is not the one TradingView granted. Check with `gh auth status` or
`git config user.name`, and confirm the invitation was accepted.

If TradingView has moved the repository, point the script at the right one:

```bash
CHARTING_LIBRARY_REPO=https://github.com/some-org/charting_library.git npm run setup:charts
```

## 3. Or install it by hand

Download the archive from TradingView and unpack it so that these two files exist:

```
public/static/charting_library/charting_library.js
public/static/datafeeds/udf/dist/bundle.js
```

`npm run dev` checks for the first of those and will tell you if it is missing.

## Version

Built and tested against **Charting Library v28.5.0**. Later versions are usually
drop-in; the integration lives in `components/chart/` and the typed surface it depends
on is `charting_library.d.ts`, which ships with the library.

If a newer version breaks the build, the errors will point at `components/chart/trading-chart.tsx`,
which is where the widget is constructed and configured.

## What we built on top

The library draws candles. Everything else is ours and is in this repository:

| File | What it does |
| --- | --- |
| `components/chart/trading-chart.tsx` | Widget lifecycle, drawing capture, plan overlays |
| `components/chart/hyperliquid-datafeed.ts` | Hyperliquid candles and live ticks |
| `components/chart/lighter-datafeed.ts` | The same for Lighter |
| `components/chart/venue-datafeed-router.ts` | Routes a symbol to the right venue |
| `components/chart/footprint-overlay.tsx` | Order-flow footprint drawn over the chart |
| `lib/chart-bridge.tsx` | Lets the agent read and draw on the chart |

## Testing the preview chart with Advanced Charts installed

Set `FORCE_PREVIEW_CHART=1` when starting the dev server to build against the
bundled Lightweight Charts preview even when `public/static/charting_library`
exists. This is how you test the fresh-clone experience without moving the
TradingView install.
