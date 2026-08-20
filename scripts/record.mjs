// Record short clips of the real terminal, one per step of the README's loop.
//
//   npm run dev        # in another terminal
//   npm run record
//
// Each step gets its own browser context, so a step that fails costs only its
// own clip, and the timings do not have to be guessed from one long take.
// Output is <name>.webm plus a cropped, size-budgeted <name>.gif in docs/media.
//
// NOTHING HERE SPENDS MONEY. It draws, detects, selects and scrolls. It never
// clicks CONFIRM DEPLOY, and it must never be extended to — a deploy places real
// orders against whatever account the configured key belongs to.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.REC_BASE ?? "http://localhost:3200";
const OUT = "docs/media";
const TMP = ".rec";
const W = 1600;
const H = 900;
// Measured off the 1600x900 layout: the setups panel starts at x=1160, the
// header is 56 tall. Cropping tight is what keeps these GIFs small enough to
// commit while staying readable — scaling dense UI down does not work.
const CHART = "1120:800:30:64";
const PANEL = "436:790:1160:64";

mkdirSync(OUT, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const HIDE_DEV_OVERLAY = () => {
  const hide = () => {
    const el = document.createElement("style");
    el.textContent =
      "nextjs-portal,[data-nextjs-toast],[data-nextjs-dev-tools-button],#__next-build-watcher{display:none!important}";
    document.head?.appendChild(el);
  };
  if (document.head) hide();
  else document.addEventListener("DOMContentLoaded", hide);
};

/** Open a page that is recording, with the chart already drawn. */
async function session(browser) {
  const openedAt = Date.now();
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    colorScheme: "dark",
    recordVideo: { dir: TMP, size: { width: W, height: H } },
  });
  await ctx.addInitScript(() => window.localStorage.setItem("cg-privacy", "1"));
  await ctx.addInitScript(HIDE_DEV_OVERLAY);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });
  try {
    const frame = await page.waitForSelector("iframe", { timeout: 90_000 });
    const chart = await frame.contentFrame();
    if (chart) await chart.waitForSelector("canvas", { timeout: 90_000 });
  } catch {
    /* capture anyway */
  }
  await page.waitForTimeout(9_000);
  // Everything before this is the app booting and the chart drawing — dead
  // footage. Callers convert action timestamps into video time with `at()`.
  const at = (ms = Date.now()) => (ms - openedAt) / 1000;
  return { ctx, page, at };
}

/** The charting library's frame, found by content rather than by URL — the URL
 *  varies and matching it was the flakiest part of this script. */
async function chartFrame(page) {
  for (const f of page.frames()) {
    try {
      if ((await f.locator('[data-name="pane-widget-chart-gui-wrapper"]').count()) > 0) return f;
    } catch {
      /* frame detached */
    }
  }
  return null;
}

async function finish(ctx, page, name) {
  const video = page.video();
  await ctx.close(); // the file is only complete once the context closes
  if (!video) throw new Error("no video recorded");
  const src = await video.path();
  const dest = join(TMP, `${name}.webm`);
  renameSync(src, dest);
  return dest;
}

/**
 * Crop a region and encode a size-budgeted GIF. Dense UI does not survive being
 * scaled down, so these are cropped tight and kept near 1:1 instead.
 */
function gif(src, out, { crop, start, dur, width, fps = 8, colors = 48 }) {
  const chain = `crop=${crop},fps=${fps},scale=${width}:-1:flags=lanczos`;
  const pal = join(TMP, "pal.png");
  execFileSync("ffmpeg", ["-v", "error", "-ss", String(start), "-t", String(dur), "-i", src,
    "-vf", `${chain},palettegen=max_colors=${colors}:stats_mode=diff`, "-y", pal]);
  execFileSync("ffmpeg", ["-v", "error", "-ss", String(start), "-t", String(dur), "-i", src, "-i", pal,
    "-lavfi", `${chain} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-y", out]);
  const kb = Math.round(execFileSync("node", ["-e", `process.stdout.write(String(require('fs').statSync(${JSON.stringify(out)}).size))`]) / 1024);
  console.log(`    ${out}  ${kb} KB`);
  return kb;
}

const browser = await chromium.launch();
const made = [];

// ── 1. Drawing on the chart ────────────────────────────────────────────
try {
  console.log("  [1/4] drawing on the chart…");
  const { ctx, page, at } = await session(browser);
  const cf = await chartFrame(page);
  if (!cf) throw new Error("chart frame not found");
  // Pick the trend-line tool from the widget's own rail, then drag a line
  // across the candles the way a person would.
  const tool = cf.locator('[data-name="linetool-group-trend-line"], [data-name="trend-line"]').first();
  if ((await tool.count()) === 0) throw new Error("no trend-line tool on the rail");
  await page.waitForTimeout(1_200);
  const t1 = at();
  await tool.click();
  await page.waitForTimeout(900);
  await page.mouse.move(420, 700);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) {
    await page.mouse.move(420 + i * 32, 700 - i * 17);
    await page.waitForTimeout(28);
  }
  await page.mouse.up();
  await page.waitForTimeout(2_600);
  const v = await finish(ctx, page, "draw");
  gif(v, `${OUT}/loop-1-draw.gif`, { crop: CHART, start: t1 - 0.4, dur: 3.8, width: 700 });
  made.push("loop-1-draw.gif");
} catch (e) {
  console.log(`    ! skipped: ${String(e).slice(0, 110)}`);
}

// ── 2. Detect → plans come back ────────────────────────────────────────
try {
  console.log("  [2/4] detect → ranked setups…");
  const { ctx, page, at } = await session(browser);
  const t2 = at();
  await page.getByText("DETECT SETUPS", { exact: false }).first().click();
  await page.waitForSelector("text=/ONE-SHOT|RECURRING/i", { timeout: 290_000 });
  await page.waitForTimeout(4_500);
  const v = await finish(ctx, page, "detect");
  // The right-hand panel only: the progress steps and the cards landing.
  // The detect itself is a minute of a spinner. Show the request going out,
  // then jump to the cards landing.
  gif(v, `${OUT}/loop-2-detect.gif`, { crop: PANEL, start: at() - 5.0, dur: 4.4, width: 500 });
  made.push("loop-2-detect.gif");
} catch (e) {
  console.log(`    ! skipped: ${String(e).slice(0, 110)}`);
}

// ── 3. A plan drawn onto the chart ─────────────────────────────────────
try {
  console.log("  [3/4] a plan projected onto the chart…");
  const { ctx, page, at } = await session(browser);
  const badge = page.getByText(/TIER/).first();
  const box = await badge.boundingBox();
  if (!box) throw new Error("no setup card on the panel");
  await page.waitForTimeout(1_000);
  const t3 = at();
  await page.mouse.move(box.x + 220, box.y + box.height / 2, { steps: 18 });
  await page.mouse.click(box.x + 220, box.y + box.height / 2);
  await page.waitForSelector("text=/Showing .* setup/i", { timeout: 25_000 });
  await page.waitForTimeout(3_500);
  const v = await finish(ctx, page, "plan");
  gif(v, `${OUT}/loop-3-plan.gif`, { crop: CHART, start: t3 - 0.4, dur: 3.8, width: 700 });
  made.push("loop-3-plan.gif");
} catch (e) {
  console.log(`    ! skipped: ${String(e).slice(0, 110)}`);
}

// ── 4. What is deployed ────────────────────────────────────────────────
try {
  console.log("  [4/4] the running-setups panel…");
  const { ctx, page, at } = await session(browser);
  const t4 = at();
  await page.getByText("RUNNING SETUPS", { exact: false }).first().click();
  await page.waitForTimeout(2_500);
  await page.mouse.move(1300, 600);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(420);
  }
  await page.waitForTimeout(1_500);
  const v = await finish(ctx, page, "running");
  gif(v, `${OUT}/loop-4-running.gif`, { crop: PANEL, start: t4 - 0.3, dur: 3.8, width: 500 });
  made.push("loop-4-running.gif");
} catch (e) {
  console.log(`    ! skipped: ${String(e).slice(0, 110)}`);
}

await browser.close();
try {
  rmSync(TMP, { recursive: true, force: true });
} catch {
  // Windows holds the last video file briefly after the browser exits. The
  // directory is ignored, so leaving it is harmless.
}
console.log(`\n  ${made.length}/4 clips: ${made.join(", ") || "none"}\n`);
console.log("  Check each one before committing — privacy mode hides amounts, not addresses.\n");
