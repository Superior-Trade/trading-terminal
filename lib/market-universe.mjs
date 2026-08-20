// Pure market-universe builder — the single source of truth for "which
// pairs exist" across three consumers: the client HyperliquidProvider,
// the server screen_markets tool, and evals/markets.mjs (pair-coverage
// check). Plain .mjs so node eval scripts import it directly; types live
// in market-universe.d.ts.
//
// Inputs mirror the HL API shapes:
//   allPerps  — array of per-dex metas ({universe: [{name, szDecimals,
//               maxLeverage, isDelisted?}]}), aligned with dexNames.
//   spotResp  — [spotMeta, spotCtxs] from spotMetaAndAssetCtxs.
//   dexNames  — dex per allPerps entry ("" = main dex).

/** @returns {{ assets: import("./market-universe").AssetMeta[], universesByDex: Map<string, string[]> }} */
export function buildAssetList(allPerps, spotResp, dexNames) {
  const universesByDex = new Map();
  const perpAssets = [];
  const hip3Assets = [];

  for (let i = 0; i < dexNames.length; i++) {
    const dex = dexNames[i];
    const universe = allPerps[i]?.universe ?? [];
    universesByDex.set(
      dex,
      universe.map((a) => a.name),
    );

    if (dex === "") {
      // Main DEX perps
      let idx = 0;
      for (const a of universe) {
        if (a.isDelisted) continue;
        perpAssets.push({
          name: a.name,
          szDecimals: a.szDecimals,
          maxLeverage: a.maxLeverage,
          index: idx++,
          marketType: "perp",
        });
      }
    } else {
      // HIP-3 builder-dex perps. The dex label is derived from the asset
      // NAME's prefix ("xyz:SKHX" → "xyz"), NOT from the positional dexNames
      // zip — allPerpMetas and the dex-name sources (perpDexs /
      // allDexsAssetCtxs) don't guarantee identical ordering/filtering, and a
      // misalignment mislabels every asset (xyz tokens badged "abcd").
      for (const a of universe) {
        if (a.isDelisted) continue;
        const colon = a.name.indexOf(":");
        hip3Assets.push({
          name: a.name,
          szDecimals: a.szDecimals,
          maxLeverage: a.maxLeverage,
          index: hip3Assets.length,
          marketType: "hip3",
          dex: colon > 0 ? a.name.slice(0, colon) : dex,
        });
      }
    }
  }

  // Spot: canonical universes with an active mid price. spotCtxs is
  // aligned by array position with spotMeta.universe.
  const [spotMeta, spotCtxs] = spotResp;
  const tokenByIndex = new Map();
  for (const token of spotMeta.tokens) {
    tokenByIndex.set(token.index, {
      name: token.name,
      isCanonical: token.isCanonical,
      szDecimals: token.szDecimals,
    });
  }
  const spotAssets = [];
  const seenSpotNames = new Set();
  for (let i = 0; i < spotMeta.universe.length; i++) {
    const universe = spotMeta.universe[i];
    const ctx = spotCtxs[i];
    if (!ctx || ctx.midPx === null) continue;
    let assetName = ctx.coin;
    if (assetName.startsWith("@")) {
      const baseTokenIdx = universe.tokens?.[0];
      const baseToken =
        baseTokenIdx !== undefined ? tokenByIndex.get(baseTokenIdx) : undefined;
      if (!baseToken?.name || baseToken.name.startsWith("@")) continue;
      assetName = `${baseToken.name}/USDC`;
    }
    if (seenSpotNames.has(assetName)) continue;
    seenSpotNames.add(assetName);
    spotAssets.push({
      name: assetName,
      ...(ctx.coin !== assetName ? { apiCoin: ctx.coin } : {}),
      szDecimals: 0,
      maxLeverage: 1,
      index: i,
      marketType: "spot",
    });
  }

  return {
    assets: [...perpAssets, ...spotAssets, ...hip3Assets],
    universesByDex,
  };
}
