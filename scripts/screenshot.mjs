// Capture the documentation screenshots from a running terminal.
//
//   npm run dev          # in another terminal
//   npm run screenshot
//
// Why this exists: the images in docs/media were originally cut from a social
// video, which meant they carried its compression and its downscaling — text was
// already soft at 1:1 and no amount of cropping brought it back. Driving the
// real app at deviceScaleFactor 2 produces the actual pixels instead.
//
// Nothing here is private: privacy mode is switched on before the first paint,
// which masks every balance, and the self-hosted build shows no wallet address
// in the header at all. Do not extend this to open the accounts dialog without
// adding redaction first.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.SHOT_BASE ?? "http://localhost:3200";
const OUT = "docs/media";
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1600);
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 900);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  // 2 = retina. The PNG comes out at 3200x1800 and stays sharp when GitHub
  // displays it at ~900px.
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

await ctx.addInitScript(() => {
  // Mask every monetary amount before anything renders.
  window.localStorage.setItem("cg-privacy", "1");
});

// Next's dev overlay parks a build-status pill in the corner. It is invisible in
// a production build and meaningless to a reader, but it lands in every
// screenshot taken against `npm run dev`. Injected as an init script rather than
// addStyleTag so it survives the reload the hero shot depends on.
await ctx.addInitScript(() => {
  const hide = () => {
    const el = document.createElement("style");
    el.textContent =
      "nextjs-portal,[data-nextjs-toast],[data-nextjs-dev-tools-button],#__next-build-watcher{display:none!important}";
    document.head?.appendChild(el);
  };
  if (document.head) hide();
  else document.addEventListener("DOMContentLoaded", hide);
});

const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log(`  [page error] ${m.text().slice(0, 160)}`);
});

console.log(`\n  ${BASE} at ${WIDTH}x${HEIGHT} @2x\n`);
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });

// The chart is TradingView's widget in an iframe and takes a while to draw its
// first candles. Wait for the canvas to exist, then let it settle — a
// screenshot of a half-drawn chart is worse than no screenshot.
try {
  const frame = await page.waitForSelector("iframe", { timeout: 90_000 });
  const chart = await frame.contentFrame();
  if (chart) await chart.waitForSelector("canvas", { timeout: 90_000 });
  console.log("  chart canvas is up");
} catch {
  console.log("  ! chart did not report ready — capturing anyway");
}
await page.waitForTimeout(Number(process.env.SHOT_SETTLE ?? 12_000));

// The deployments side of the app: what you have deployed, its state, and the
// controls. A tab is a far more reliable click target than a setup card, and
// this is the half of the product a chart screenshot never shows.
try {
  await page.getByText("RUNNING SETUPS", { exact: false }).first().click();
  await page.waitForTimeout(7_000);
  await page.screenshot({ path: `${OUT}/deployments.png`, animations: "disabled" });
  console.log(`  wrote ${OUT}/deployments.png`);
  await page.getByText("DRAFT SETUPS", { exact: false }).first().click();
  await page.waitForTimeout(2_500);
} catch {
  console.log("  ! could not open the running-setups tab — skipping that shot");
}

// An empty right-hand panel shows the chrome and none of the point, so the hero
// shot needs real setups in it. This runs a genuine detect against the live
// model — it costs OpenRouter tokens and takes the better part of a minute.
// SHOT_DETECT=0 skips it.
{
  // Draft setups persist, so a detect is only needed when the panel is empty.
  // Re-running one on every capture would burn a minute and OpenRouter tokens
  // to arrive at the same screenshot. SHOT_DETECT=1 forces a fresh one.
  const existing = await page.locator("text=/ONE-SHOT|RECURRING/i").count();
  const needsDetect = existing === 0 || process.env.SHOT_DETECT === "1";
  try {
    if (needsDetect) {
      console.log("  panel is empty — running a detect (real model call, ~30-60s)…");
      await page.getByText("DETECT SETUPS", { exact: false }).first().click();
      // Cards carry a tier badge; wait for the first rather than a fixed sleep.
      // /api/detect declares maxDuration = 300 and a slow model genuinely uses
      // it — one observed run took 3.0 minutes. Wait to the route's own ceiling
      // rather than guessing lower and calling a slow success a failure.
      await page.waitForSelector("text=/ONE-SHOT|RECURRING/i", { timeout: 290_000 });
      await page.waitForTimeout(6_000); // let the rest of the cards land
    } else {
      console.log(`  ${existing} setup(s) already on the panel — no detect needed`);
    }

    // Reload before the hero shot. A detect leaves the agent's written answer
    // sitting over the candles, which is the busiest possible version of the
    // chart; the cards themselves persist, so a reload keeps the substance and
    // drops the overlay.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForTimeout(Number(process.env.SHOT_SETTLE ?? 12_000));
    await page.screenshot({ path: `${OUT}/terminal.png`, animations: "disabled" });
    console.log(`  wrote ${OUT}/terminal.png`);

    // Second shot: a plan projected onto the chart. Clicking a card's title
    // draws its entry, stop and target as lines, which is the thing that makes
    // a setup legible as a trade rather than as a paragraph.
    try {
      // Selecting a card marks its levels on the chart. Click the card's title
      // rather than the tier badge — the badge is its own element and clicking
      // it does not select the card. Offsetting from the badge's box finds the
      // title without depending on the setup's name.
      const badge = page.getByText(/TIER/).first();
      const box = await badge.boundingBox();
      if (!box) throw new Error("no setup card on screen");
      await page.mouse.click(box.x + 220, box.y + box.height / 2);
      await page.waitForSelector("text=/Showing .* setup/i", { timeout: 20_000 });
      await page.waitForTimeout(5_000);
      await page.screenshot({ path: `${OUT}/setup-on-chart.png`, animations: "disabled" });
      console.log(`  wrote ${OUT}/setup-on-chart.png`);
    } catch {
      console.log("  ! could not open a setup on the chart — skipping that shot");
    }
  } catch (err) {
    // Never overwrite a good hero with a failed run. A detect is a live model
    // call over the network and it will sometimes time out; losing the last
    // successful screenshot to that is a worse outcome than having no new one.
    console.log(`  ! detect did not complete: ${String(err).slice(0, 120)}`);
    console.log(`    left ${OUT}/terminal.png untouched`);
  }
}

await browser.close();
console.log(
  "\n  Check every image before committing: privacy mode hides amounts, it does\n" +
    "  not hide addresses, and it cannot hide whatever you left on screen.\n",
);
