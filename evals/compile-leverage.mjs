// Leverage-scaling regression test for /api/compile: Freqtrade stoploss and
// minimal_roi are POSITION-PnL ratios (leverage included), so a plan's price
// distances must be multiplied by leverage. Usage: node evals/compile-leverage.mjs
import fs from "fs";

const BASE = "http://localhost:3200";
const SECRET = (fs.readFileSync(".env.local", "utf8").match(/^SERVER_SECRET=(.+)$/m) ?? [])[1];

const CASES = [
  {
    name: "long 10x (the live bug)",
    plan: {
      title: "Trendline support long",
      direction: "long",
      entry: 63142,
      stop: 60800, // -3.709% price
      target: 64764, // +2.569% price
      thesis: "Bounce off the rising trendline support",
      invalidation: "1h close below 60800",
    },
    funds: 100,
    leverage: 10,
    wantStop: -0.371, // price% × 10
    wantRoi: 0.257,
    tol: 0.06, // generous — model rounds
  },
  {
    name: "long 1x (no scaling)",
    plan: {
      title: "Support bounce",
      direction: "long",
      entry: 63142,
      stop: 60800,
      target: 64764,
      thesis: "Bounce",
      invalidation: "close below stop",
    },
    funds: 100,
    leverage: 1,
    wantStop: -0.0371,
    wantRoi: 0.0257,
    tol: 0.006,
  },
  {
    name: "short 5x",
    plan: {
      title: "Resistance fade short",
      direction: "short",
      entry: 63500,
      stop: 64770, // +2% price against a short
      target: 61595, // -3% price in favor
      thesis: "Fade the resistance",
      invalidation: "close above 64770",
    },
    funds: 100,
    leverage: 5,
    wantStop: -0.1, // 2% × 5
    wantRoi: 0.15, // 3% × 5
    tol: 0.03,
  },
];

const ctx = { symbol: "BTC/USD", timeframe: "1h", lastPrice: 63400, indicators: [], drawings: [], recentCandles: [] };

let pass = 0;
for (const c of CASES) {
  const res = await fetch(`${BASE}/api/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dev-secret": SECRET },
    body: JSON.stringify({ plan: c.plan, chartContext: ctx, funds: c.funds, leverage: c.leverage }),
  });
  const j = await res.json();
  const s = j.strategy ?? j;
  const cfg = typeof s.config === "string" ? JSON.parse(s.config) : s.config ?? {};
  const stop = cfg.stoploss;
  const roi = Math.max(...Object.values(cfg.minimal_roi ?? { 0: NaN }).map(Number));
  const stopOk = typeof stop === "number" && Math.abs(stop - c.wantStop) <= c.tol;
  const roiOk = Number.isFinite(roi) && Math.abs(roi - c.wantRoi) <= c.tol;
  const levOk = c.leverage === 1 || (s.code ?? "").includes(`return ${c.leverage}`);
  // End-to-end gate: the compiled artifact must also clear SUPERIOR'S OWN
  // validator (through our defaults pipeline) — compile-side checks alone
  // missed the market-orders/price_side conflict once.
  let upstreamOk = false;
  let upstreamErr = "";
  try {
    const bt = await fetch(`${BASE}/api/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-dev-secret": SECRET },
      body: JSON.stringify({
        name: `eval-${c.name.replace(/\W+/g, "-").slice(0, 24)}`,
        config: cfg,
        code: s.code,
        timerange: { start: "2026-06-25", end: "2026-07-02" },
      }),
    });
    upstreamOk = bt.status < 300;
    if (!upstreamOk) upstreamErr = JSON.stringify(await bt.json()).slice(0, 200);
  } catch (e) {
    upstreamErr = String(e).slice(0, 120);
  }
  const ok = stopOk && roiOk && levOk && upstreamOk;
  pass += ok ? 1 : 0;
  console.log(
    `${ok ? "✓" : "✗"} ${c.name}: stoploss=${stop} (want ~${c.wantStop}) roi=${roi} (want ~${c.wantRoi}) leverage()=${levOk} upstream=${upstreamOk}`,
  );
  if (!upstreamOk) console.log("   upstream:", upstreamErr);
  if (!ok && j.error) console.log("   error:", j.error);
}
console.log(`${pass}/${CASES.length} pass`);
process.exit(pass === CASES.length ? 0 : 1);
