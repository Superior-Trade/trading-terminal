// Pair-coverage check: buildAssetList (the app's single source of truth
// for the market universe) must contain EVERY active market Hyperliquid
// serves — main perps, canonical spot pairs, all HIP-3 builder dexes.
// Ground truth comes straight from the HL REST API.
// Usage: node evals/markets.mjs

import { buildAssetList } from "../lib/market-universe.mjs";

const API = "https://api.hyperliquid.xyz/info";
async function info(body) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`info ${body.type}: HTTP ${res.status}`);
  return res.json();
}

// ── Ground truth ─────────────────────────────────────────────────────────
const dexs = await info({ type: "perpDexs" }); // [null, {name}, ...]
const dexNames = dexs.map((d) => (d === null ? "" : d.name));
const allPerps = await Promise.all(
  dexNames.map((d) => info(d === "" ? { type: "meta" } : { type: "meta", dex: d })),
);
const spotResp = await info({ type: "spotMetaAndAssetCtxs" });

// ── Build via the shared module ──────────────────────────────────────────
const { assets, universesByDex } = buildAssetList(allPerps, spotResp, dexNames);
const byName = new Map(assets.map((a) => [a.name, a]));

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};

// 1. Every active perp per dex is present with the right marketType/dex.
for (let i = 0; i < dexNames.length; i++) {
  const dex = dexNames[i];
  const active = allPerps[i].universe.filter((a) => !a.isDelisted);
  let present = 0;
  for (const a of active) {
    const hit = byName.get(a.name);
    if (!hit) fail(`missing ${dex || "main"} perp: ${a.name}`);
    else if (dex === "" && hit.marketType !== "perp") fail(`${a.name}: wrong type ${hit.marketType}`);
    else if (dex !== "" && (hit.marketType !== "hip3" || hit.dex !== dex)) fail(`${a.name}: wrong type/dex`);
    else present++;
  }
  console.log(`dex ${dex || "(main)"}: ${present}/${active.length} active perps present`);
}

// 2. Every canonical spot pair with a live mid is present.
const [spotMeta, spotCtxs] = spotResp;
const tokenByIdx = new Map(spotMeta.tokens.map((t) => [t.index, t]));
let spotExpected = 0;
const seen = new Set();
for (let i = 0; i < spotMeta.universe.length; i++) {
  const ctx = spotCtxs[i];
  if (!ctx || ctx.midPx === null) continue;
  let name = ctx.coin;
  if (name.startsWith("@")) {
    const base = tokenByIdx.get(spotMeta.universe[i].tokens?.[0]);
    if (!base?.name || base.name.startsWith("@")) continue;
    name = `${base.name}/USDC`;
  }
  if (seen.has(name)) continue;
  seen.add(name);
  spotExpected++;
  const hit = byName.get(name);
  if (!hit) fail(`missing spot pair: ${name}`);
  else if (hit.marketType !== "spot") fail(`${name}: wrong type ${hit.marketType}`);
}
console.log(`spot: ${spotExpected} live pairs expected, ${assets.filter((a) => a.marketType === "spot").length} built`);

// 3. No duplicate names.
if (byName.size !== assets.length) fail(`duplicates: ${assets.length - byName.size}`);

// 4. Spot checks.
for (const name of ["BTC", "ETH", "HYPE/USDC"]) {
  if (!byName.has(name)) fail(`spot-check missing: ${name}`);
}
const anyHip3 = assets.find((a) => a.marketType === "hip3");
if (!anyHip3) fail("no HIP-3 assets built at all");

// 5. Per-dex universes map covers every dex (even fully-delisted ones map to []-ish).
for (const d of dexNames) {
  if (!universesByDex.has(d)) fail(`universesByDex missing dex "${d}"`);
}

const counts = {
  perp: assets.filter((a) => a.marketType === "perp").length,
  spot: assets.filter((a) => a.marketType === "spot").length,
  hip3: assets.filter((a) => a.marketType === "hip3").length,
};
console.log(`totals: perp=${counts.perp} spot=${counts.spot} hip3=${counts.hip3} all=${assets.length}`);
console.log(failures === 0 ? "✓ PASS — full pair coverage" : `✗ FAIL — ${failures} problems`);
process.exit(failures === 0 ? 0 : 1);
