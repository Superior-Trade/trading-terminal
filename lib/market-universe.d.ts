// Types for market-universe.mjs (kept .mjs so node eval scripts share it).

export interface AssetMeta {
  name: string;
  /** Internal API coin id when it differs from name (spot "@N" pairs). */
  apiCoin?: string;
  szDecimals: number;
  maxLeverage: number;
  index: number;
  marketType: "perp" | "spot" | "hip3";
  dex?: string;
}

interface PerpUniverseEntry {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

interface PerpMetaLike {
  universe: PerpUniverseEntry[];
}

interface SpotMetaLike {
  tokens: Array<{ name: string; index: number; isCanonical: boolean; szDecimals: number }>;
  universe: Array<{ tokens?: number[] }>;
}

type SpotCtxLike = { coin: string; midPx: string | null } | null | undefined;

export function buildAssetList(
  allPerps: PerpMetaLike[],
  spotResp: [SpotMetaLike, SpotCtxLike[]],
  dexNames: string[],
): { assets: AssetMeta[]; universesByDex: Map<string, string[]> };
