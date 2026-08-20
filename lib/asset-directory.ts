// Human-readable names + descriptions for tradable assets, keyed by the
// canonical HL asset name (e.g. "xyz:SKHX", "BTC").
//
// WHY a curated map: Hyperliquid's public info API exposes no company/
// full-name or description field for HIP-3 equity assets — `meta` /
// `meta,dex:xyz` return only { name, szDecimals, maxLeverage, ... }. The
// coded tickers are also non-standard (SKHX = SK Hynix, not 000660.KS), so
// a generic finance API can't resolve them either. This map is therefore
// the source of truth for the "TICKER | Full Name" label and the business
// description shown under the selected pair. New/unknown assets fall back
// to their raw ticker with no description — safe and non-blocking.

export interface AssetInfo {
  /** Full company/asset name, e.g. "SK Hynix". */
  name: string;
  /** One–two sentence description of the underlying business/asset. */
  description?: string;
  /** Overrides the displayed ticker AND replaces the full-name label, so the
   *  row/pill show only this (e.g. XYZ100 → "NASDAQ-100", not
   *  "XYZ100 Nasdaq-100 Index"). Use when the code ticker is meaningless. */
  displayTicker?: string;
}

// Crypto/token entries live in their own generated modules (keyed by bare
// ticker) and are merged in below. Two files: the original >$1m set plus the
// >$100k extension.
import { CRYPTO_DIRECTORY } from "./asset-directory-crypto";
import { CRYPTO_DIRECTORY_2 } from "./asset-directory-crypto2";

// Source: Trade[XYZ] official specification index
// (https://docs.trade.xyz/consolidated-resources/specification-index) — the
// deployer of the `xyz` HIP-3 dex. Descriptions are the spec's own factual
// text (capitalized for standalone display); no wording is invented. Keyed
// by canonical asset name ("xyz:<TICKER>"); lookups are case-insensitive via
// assetInfo(). Standard instruments not individually described in the spec
// (commodities/indices/FX) use the spec's "Tracks the value of…" pattern.
const DIRECTORY: Record<string, AssetInfo> = {
  // ── Indices ─────────────────────────────────────────────────────────
  "xyz:SP500": { name: "S&P 500 Index", description: "The benchmark U.S. equity index tracking 500 of the largest publicly traded American companies, weighted by market cap. Widely used as a proxy for overall U.S. stock-market performance and broad risk appetite." },
  "xyz:XYZ100": { name: "Nasdaq-100 Index", displayTicker: "NASDAQ-100", description: "Tracks the Nasdaq-100, a market-cap-weighted index of the 100 largest non-financial companies listed on the Nasdaq. A tech-heavy large-cap benchmark capturing megacap growth and semiconductor momentum in a single instrument." },
  "xyz:JP225": { name: "Japan 225 Index", description: "A price-weighted index of 225 blue-chip companies on the Tokyo Stock Exchange (the Nikkei 225), Japan's headline equity benchmark. Sensitive to the yen, global exporters, and Bank of Japan policy." },
  "xyz:KR200": { name: "Korea 200 Index", description: "A capitalization-weighted index of 200 leading South Korean companies (the KOSPI 200), dominated by semiconductor, battery, and heavy-industry exporters. A key gauge of Korean equity risk." },
  "xyz:NIFTY": { name: "Nifty 50 Index", description: "India's benchmark equity index of 50 large-cap companies listed on the National Stock Exchange. Represents the core of the Indian market across financials, IT, and consumer sectors." },
  "xyz:IBOV": { name: "Ibovespa Index", description: "Brazil's benchmark stock index of the most liquid companies on the B3 exchange, heavily weighted toward commodities, mining, and banking. A leading proxy for Latin American emerging-market risk." },
  "xyz:VIX": { name: "CBOE Volatility Index", description: "The market's 'fear gauge,' measuring expected 30-day volatility of the S&P 500 implied by options prices. Spikes during sell-offs and falls in calm markets, making it a hedge and sentiment indicator." },
  "xyz:DXY": { name: "US Dollar Index", description: "Measures the value of the U.S. dollar against a basket of six major currencies (euro, yen, pound, and others). A rising DXY signals dollar strength and generally pressures risk assets and commodities." },

  // ── Commodities ─────────────────────────────────────────────────────
  "xyz:GOLD": { name: "Gold", description: "Tracks the spot price of one troy ounce of gold, the premier safe-haven and inflation hedge. Demand rises with monetary uncertainty, falling real yields, and central-bank buying." },
  "xyz:SILVER": { name: "Silver", description: "Tracks the spot price of one troy ounce of silver, a metal with both monetary-hedge and heavy industrial demand (solar panels, electronics). More volatile than gold and sensitive to the gold/silver ratio." },
  "xyz:PLATINUM": { name: "Platinum", description: "Tracks the spot price of one troy ounce of platinum, an industrial precious metal used in catalytic converters, hydrogen fuel cells, and jewelry. Tightly linked to auto production and supply from South Africa." },
  "xyz:PALLADIUM": { name: "Palladium", description: "Tracks the spot price of one troy ounce of palladium, used mainly in gasoline-engine catalytic converters. Prices are highly sensitive to auto demand and concentrated Russian and South African supply." },
  "xyz:COPPER": { name: "Copper", description: "Tracks the price of one pound of copper, the bellwether industrial metal known as 'Dr. Copper' for signaling global growth. Central to construction, power grids, EVs, and electrification demand." },
  "xyz:ALUMINIUM": { name: "Aluminium", description: "Tracks the price of aluminium, a lightweight industrial metal used in transport, packaging, and construction. Prices reflect global manufacturing demand and energy-intensive smelting costs." },
  "xyz:URANIUM": { name: "Uranium", description: "Tracks the price of uranium (U3O8), the fuel for nuclear power. Demand is driven by reactor build-outs, energy-security policy, and growing power needs from AI data centers." },
  "xyz:CORN": { name: "Corn", description: "Tracks the price of corn, one of the most heavily traded agricultural commodities, used for food, animal feed, and ethanol. Prices swing with weather, U.S. harvests, and export demand." },
  "xyz:WHEAT": { name: "Wheat", description: "Tracks the price of wheat, a global food-staple grain. Highly sensitive to weather, Black Sea supply disruptions, and geopolitical events affecting major exporters." },
  "xyz:BRENTOIL": { name: "Brent Crude Oil", description: "Tracks the price of one barrel of Brent crude, the international benchmark for seaborne oil. Driven by OPEC+ policy, global demand, and geopolitical supply risk." },
  "xyz:CL": { name: "WTI Crude Oil", description: "Tracks the price of one barrel of West Texas Intermediate, the U.S. crude-oil benchmark. Reflects North American supply-demand and typically trades at a spread to Brent." },
  "xyz:WTIOIL": { name: "WTI Crude Oil", description: "Tracks the price of one barrel of West Texas Intermediate, the U.S. crude-oil benchmark. Reflects North American supply-demand and typically trades at a spread to Brent." },
  "xyz:NATGAS": { name: "Henry Hub Natural Gas", description: "Tracks the U.S. Henry Hub natural-gas price per MMBtu, the North American benchmark for gas. Notoriously volatile, driven by weather, storage levels, and LNG export demand." },
  "xyz:TTF": { name: "Dutch TTF Natural Gas", description: "Tracks Dutch Title Transfer Facility gas, the European natural-gas benchmark. Highly sensitive to weather, storage, and supply security across the EU." },

  // ── FX ──────────────────────────────────────────────────────────────
  "xyz:JPY": { name: "Japanese Yen", description: "Tracks the USD/JPY exchange rate. The yen is a classic funding and safe-haven currency, strongly driven by the interest-rate gap between the Federal Reserve and the Bank of Japan." },
  "xyz:EUR": { name: "Euro", description: "Tracks the EUR/USD exchange rate, the world's most traded currency pair. Moves on the ECB–Fed policy divergence and broad dollar strength." },
  "xyz:GBP": { name: "British Pound", description: "Tracks the GBP/USD exchange rate ('cable'). Driven by Bank of England policy, UK inflation and growth data, and overall dollar direction." },
  "xyz:KRW": { name: "South Korean Won", description: "Tracks the USD/KRW exchange rate. The won is a liquid Asian EM currency sensitive to semiconductor exports, global risk appetite, and foreign equity flows." },

  // ── ETFs ────────────────────────────────────────────────────────────
  "xyz:URNM": { name: "Sprott Uranium Miners ETF", description: "An ETF holding uranium mining companies and physical uranium, offering leveraged exposure to the nuclear-fuel cycle. A common vehicle for the nuclear-energy and power-demand thesis." },
  "xyz:EWY": { name: "iShares MSCI Korea ETF", description: "Tracks a broad index of large- and mid-cap South Korean equities, heavily weighted toward Samsung, SK Hynix, and other tech exporters. A single-country proxy for Korean market and memory-chip exposure." },
  "xyz:EWJ": { name: "iShares MSCI Japan ETF", description: "Tracks large- and mid-cap Japanese equities, spanning automakers, industrials, and financials. A broad proxy for Japanese equity beta and yen sensitivity." },
  "xyz:EWT": { name: "iShares MSCI Taiwan ETF", description: "Tracks large- and mid-cap Taiwanese equities, dominated by TSMC and the semiconductor supply chain. A concentrated way to trade the global chip cycle." },
  "xyz:EWZ": { name: "iShares MSCI Brazil ETF", description: "Tracks large- and mid-cap Brazilian equities, heavily weighted to commodities and financials. A liquid proxy for Brazilian and Latin American EM risk." },
  "xyz:XLE": { name: "Energy Select Sector SPDR ETF", description: "Tracks the energy sector of the S&P 500, dominated by integrated oil majors like ExxonMobil and Chevron. Moves closely with crude-oil prices and energy-sector earnings." },
  "xyz:SMH": { name: "VanEck Semiconductor ETF", description: "Holds the largest global semiconductor companies (NVIDIA, TSMC, Broadcom, and peers). A core vehicle for trading the AI and chip-cycle theme." },
  "xyz:DRAM": { name: "Roundhill Memory ETF", description: "An ETF concentrated in memory-semiconductor makers such as Micron, SK Hynix, and Samsung. Targets the DRAM/NAND and high-bandwidth-memory upcycle driven by AI data centers." },

  // ── Equities ────────────────────────────────────────────────────────
  "xyz:TSLA": { name: "Tesla, Inc.", description: "The leading pure-play electric-vehicle maker, also selling battery energy storage and solar products. Increasingly valued on autonomy, robotics (Optimus), and its AI/FSD ambitions. One of the most heavily traded and volatile megacap stocks." },
  "xyz:NVDA": { name: "NVIDIA Corporation", description: "The dominant designer of GPUs and AI accelerators powering data-center training and inference, plus the CUDA software ecosystem. The central beneficiary of the AI build-out and a bellwether for the entire semiconductor and AI trade." },
  "xyz:GOOGL": { name: "Alphabet Inc.", description: "Parent of Google, running the world's largest search and digital-advertising business, YouTube, Android, and Google Cloud. A leading AI player through DeepMind and its Gemini models." },
  "xyz:INTC": { name: "Intel Corporation", description: "A legacy U.S. maker of CPUs and computing chips, now investing heavily to rebuild leading-edge manufacturing via its foundry strategy. A turnaround story central to U.S. chip re-shoring." },
  "xyz:MU": { name: "Micron Technology, Inc.", description: "A leading U.S. maker of DRAM and NAND flash memory and a key supplier of high-bandwidth memory (HBM) for AI accelerators. Highly cyclical, tracking the memory-pricing upcycle." },
  "xyz:PLTR": { name: "Palantir Technologies, Inc.", description: "Builds big-data analytics and AI software platforms (Gotham, Foundry, AIP) for government and enterprise customers. A high-multiple stock viewed as a pure-play on operational AI adoption." },
  "xyz:ORCL": { name: "Oracle Corporation", description: "An enterprise-software giant in databases and business applications, now a fast-growing cloud-infrastructure (OCI) provider. Increasingly a key landlord of AI compute capacity." },
  "xyz:MSTR": { name: "Strategy (MicroStrategy)", description: "An enterprise-software firm turned the largest corporate Bitcoin holder, funding BTC purchases through equity and convertible debt. Trades as a leveraged, high-beta proxy for Bitcoin." },
  "xyz:MSFT": { name: "Microsoft Corporation", description: "A megacap software leader across Windows, Office, and the Azure cloud, and the primary commercial partner of OpenAI. Its Copilot AI stack spans consumer and enterprise products." },
  "xyz:META": { name: "Meta Platforms, Inc.", description: "Operator of Facebook, Instagram, WhatsApp, and Threads, monetized through digital advertising. Investing heavily in AI (Llama models) and its Reality Labs metaverse bet." },
  "xyz:AMZN": { name: "Amazon.com, Inc.", description: "The dominant global e-commerce retailer and, through AWS, the largest cloud-computing provider. Profits are driven by AWS, advertising, and logistics scale." },
  "xyz:AMD": { name: "Advanced Micro Devices, Inc.", description: "Designs high-performance CPUs and GPUs, competing with Intel in processors and challenging NVIDIA in AI data-center accelerators. A key second source for AI compute." },
  "xyz:AAPL": { name: "Apple Inc.", description: "The world's largest consumer-electronics company, built around the iPhone plus a fast-growing high-margin services business. A megacap bellwether now rolling out Apple Intelligence AI features." },
  "xyz:COIN": { name: "Coinbase Global, Inc.", description: "The largest U.S.-listed cryptocurrency exchange, offering trading, custody, and stablecoin infrastructure (a USDC partner). Trades as a high-beta proxy for crypto-market activity and regulation." },
  "xyz:HOOD": { name: "Robinhood Markets, Inc.", description: "A retail brokerage pioneering commission-free trading of stocks, options, and crypto. Revenue is highly geared to retail trading activity and crypto volumes." },
  "xyz:NFLX": { name: "Netflix, Inc.", description: "The leading global subscription streaming service, now growing via an ad-supported tier and a live-events and gaming push. A megacap consumer-tech name driven by subscriber and margin trends." },
  "xyz:CRCL": { name: "Circle Internet Group, Inc.", description: "The issuer of USDC, the second-largest stablecoin, earning yield on its reserve assets. A public-market pure-play on stablecoin adoption and payments infrastructure." },
  "xyz:SNDK": { name: "SanDisk Corporation", description: "A maker of NAND flash memory and storage products, spun out of Western Digital. A cyclical play on flash-storage pricing and data-center and consumer demand." },
  "xyz:RIVN": { name: "Rivian Automotive, Inc.", description: "An American electric-vehicle maker of adventure SUVs/trucks and commercial delivery vans, backed by Amazon and Volkswagen. A pre-scale EV growth story burning cash toward profitability." },
  "xyz:USAR": { name: "USA Rare Earth, Inc.", description: "Developing a domestic U.S. rare-earth supply chain — mining, processing, and magnet production — for defense and clean-tech. A strategic-minerals and supply-security play." },
  "xyz:TSM": { name: "Taiwan Semiconductor (TSMC)", description: "The world's largest contract chip manufacturer, fabricating the most advanced chips for NVIDIA, Apple, AMD, and others. The linchpin of the entire global semiconductor supply chain." },
  "xyz:SKHX": { name: "SK Hynix Inc.", description: "The world's second-largest memory-chip maker, producing DRAM and NAND flash. The leading supplier of high-bandwidth memory (HBM) to NVIDIA, making it a core AI-memory beneficiary." },
  "xyz:SMSN": { name: "Samsung Electronics", description: "A South Korean conglomerate and the world's largest maker of memory chips, smartphones, and displays, with a growing foundry business. A bellwether for global tech hardware demand." },
  "xyz:HYUNDAI": { name: "Hyundai Motor Company", description: "A global top-tier automaker and a leader in EVs and hydrogen vehicles. Also holds a majority stake in robotics firm Boston Dynamics, adding a robotics angle." },
  "xyz:BABA": { name: "Alibaba Group Holding Ltd.", description: "China's e-commerce and cloud leader, operating Taobao/Tmall marketplaces and Alibaba Cloud. A bellwether for Chinese consumer demand and a major Chinese AI-model developer." },
  "xyz:CRWV": { name: "CoreWeave, Inc.", description: "A specialized 'neocloud' renting NVIDIA GPU capacity for AI training and inference. One of the purest listed plays on surging AI-compute demand, backed by large capacity contracts." },
  "xyz:DKNG": { name: "DraftKings Inc.", description: "A leading U.S. online sports-betting and iGaming operator. Growth is tied to state-by-state legalization of online gambling and bettor engagement." },
  "xyz:HIMS": { name: "Hims & Hers Health", description: "A direct-to-consumer telehealth platform selling treatments for weight loss, sexual health, dermatology, and more via subscriptions. A fast-growing consumer-health disruptor." },
  "xyz:COST": { name: "Costco Wholesale Corporation", description: "A global membership warehouse retailer known for bulk value and durable, high-renewal membership income. A defensive consumer-staples compounder." },
  "xyz:LLY": { name: "Eli Lilly and Company", description: "A leading pharmaceutical company and a dominant force in GLP-1 obesity and diabetes drugs (Mounjaro/Zepbound). Among the most valuable healthcare companies, driven by the weight-loss boom." },
  "xyz:BIRD": { name: "NewBird AI", description: "Formerly the sustainable-footwear brand Allbirds, repositioning toward an AI/GPU-as-a-service compute business. A speculative turnaround-and-pivot story." },
  "xyz:BX": { name: "Blackstone Inc.", description: "The world's largest alternative-asset manager, investing across private equity, real estate, credit, and infrastructure. Earnings track fundraising, asset values, and fee growth." },
  "xyz:LITE": { name: "Lumentum Holdings Inc.", description: "A maker of optical and photonic components for AI/cloud data-center networking and telecom. A pick-and-shovel beneficiary of AI-driven optical-interconnect demand." },
  "xyz:GME": { name: "GameStop Corp.", description: "A video-game and collectibles retailer, famous as the original 2021 meme stock. Now sits on a large cash and Bitcoin treasury, trading heavily on retail sentiment." },
  "xyz:RKLB": { name: "Rocket Lab Corporation", description: "An end-to-end space company providing small-satellite launch (Electron), the larger Neutron rocket in development, and spacecraft manufacturing. A leading pure-play on the commercial-space economy." },
  "xyz:MRVL": { name: "Marvell Technology, Inc.", description: "Designs data-infrastructure semiconductors including custom AI silicon (ASICs), optical DSPs, and networking chips. A key enabler of hyperscaler AI and data-center buildouts." },
  "xyz:ZM": { name: "Zoom Communications, Inc.", description: "Provider of the Zoom video-meetings platform, expanding into an AI-powered enterprise collaboration and contact-center suite. A post-pandemic name pivoting toward AI-driven productivity." },
  "xyz:EBAY": { name: "eBay Inc.", description: "Operator of a global online marketplace connecting buyers and sellers, with a focus on used, refurbished, and collectible goods. A mature, cash-generative e-commerce platform." },
  "xyz:CBRS": { name: "Cerebras Systems Inc.", description: "Builder of wafer-scale AI processors and supercomputers designed for very large-scale AI training and inference. A challenger to NVIDIA in high-end AI compute." },
  "xyz:PURRDAT": { name: "Hyperliquid Strategies Inc.", description: "A digital-asset treasury company built to hold and accumulate HYPE, Hyperliquid's native token. Effectively a public-equity proxy for HYPE exposure." },
  "xyz:ARM": { name: "Arm Holdings plc", description: "Licenses the CPU architecture and IP that powers nearly all smartphones and a growing share of AI, cloud, and automotive chips. Earns royalties across the semiconductor industry rather than making chips itself." },
  "xyz:BB": { name: "BlackBerry Limited", description: "A software company focused on cybersecurity and the QNX embedded operating system widely used in automotive and IoT. Long past its phone era, now an enterprise-software and automotive-software play." },
  "xyz:ASML": { name: "ASML Holding N.V.", description: "The Dutch monopoly supplier of extreme-ultraviolet (EUV) lithography machines required to make the most advanced chips. A critical chokepoint of the entire semiconductor supply chain." },
  "xyz:IBM": { name: "IBM", description: "A legacy enterprise-technology company centered on hybrid cloud (Red Hat), consulting, mainframes, and AI (watsonx). Also a leader in quantum-computing research." },
  "xyz:DELL": { name: "Dell Technologies Inc.", description: "A maker of PCs, servers, and storage, increasingly a supplier of AI-optimized servers to enterprises and cloud builders. Benefits from AI-infrastructure spending." },
  "xyz:AVGO": { name: "Broadcom Inc.", description: "A semiconductor and infrastructure-software giant supplying networking, custom AI accelerators (ASICs), and enterprise software (VMware). A top AI-infrastructure beneficiary alongside NVIDIA." },
  "xyz:QNT": { name: "Quantinuum", description: "A leading quantum-computing company (formed from Honeywell Quantum and Cambridge Quantum) building trapped-ion hardware and quantum software. A pure-play on commercial quantum computing." },
  "xyz:NOW": { name: "ServiceNow, Inc.", description: "A cloud platform automating enterprise IT, HR, and business workflows, now embedding generative-AI agents across its suite. A high-growth enterprise-software leader." },
  "xyz:WDC": { name: "Western Digital Corporation", description: "A maker of hard-disk drives and data-storage products for data centers and consumers. A cyclical storage play benefiting from AI-driven data growth." },
  "xyz:NBIS": { name: "Nebius Group N.V.", description: "An AI cloud-infrastructure provider (spun out of Yandex) renting GPU compute and full-stack AI services. A European neocloud play on AI-compute demand." },
  "xyz:SPCX": { name: "SpaceX", description: "The dominant private rocket-launch company, operating reusable Falcon rockets and the Starship program, plus the Starlink satellite-internet network. Also parent to xAI, and still a privately held, pre-IPO company." },
  "xyz:BE": { name: "Bloom Energy Corporation", description: "Maker of solid-oxide fuel cells that generate on-site electricity, increasingly used to power data centers. A clean-power play on distributed generation and AI energy demand." },
  "xyz:NOK": { name: "Nokia Corporation", description: "A Finnish supplier of telecom-network infrastructure and 5G equipment, competing with Ericsson and Huawei. Also monetizes a large patent portfolio." },
  "xyz:MINIMAX": { name: "MiniMax Group", description: "A Chinese AI company developing multimodal foundation models spanning text, audio, image, and video, plus consumer AI apps. A pure-play on Chinese frontier-AI development." },
  "xyz:ZHIPU": { name: "Zhipu AI", description: "A leading Chinese AI lab (Z.ai) building general-purpose large language models (the GLM series) for coding, vision, and agentic tasks. One of China's top frontier-model developers." },
  "xyz:QCOM": { name: "Qualcomm Incorporated", description: "A leader in smartphone system-on-chips and wireless (5G) technology, expanding into automotive, IoT, and on-device AI. Earns both chip sales and patent-licensing royalties." },
  "xyz:STRC": { name: "Strategy — Series A Preferred (STRC)", description: "A variable-rate perpetual preferred share issued by Strategy (MicroStrategy) to fund Bitcoin purchases. A yield-bearing instrument tied to the largest corporate BTC treasury." },
  "xyz:KIOXIA": { name: "Kioxia Holdings Corporation", description: "A Japanese memory-chip maker (formerly Toshiba Memory) and a top global producer of NAND flash and SSDs. A cyclical play on flash-storage demand." },
  "xyz:SOFTBANK": { name: "SoftBank Group Corp.", description: "A Japanese technology-investment holding company controlling Arm and running the Vision Fund. A leveraged proxy for AI and late-stage tech valuations." },
  "xyz:BOT": { name: "RoboStrategy, Inc.", description: "A closed-end investment company focused on robotics and embodied-AI companies. A thematic vehicle for the physical-AI and automation trend." },
  "xyz:AMAT": { name: "Applied Materials, Inc.", description: "The world's largest supplier of semiconductor and display manufacturing equipment, selling tools to every major chipmaker. A broad pick-and-shovel play on chip capital spending." },
  "xyz:SHAZ": { name: "SharonAI Holdings Inc.", description: "A 'neocloud' provider of GPU cloud computing and high-performance-computing infrastructure for AI workloads. A speculative small-cap play on AI-compute demand." },
  "xyz:IBIDEN": { name: "Ibiden Co., Ltd.", description: "A Japanese maker of advanced IC package substrates critical for high-end CPUs and AI accelerators, plus ceramics. A key, less-obvious supplier in the AI-chip packaging chain." },

  // ── Other HIP-3 dexes ───────────────────────────────────────────────
  "mkts:USTECH": { name: "US Tech 100", description: "Tracks a U.S. technology-heavy large-cap equity index (Nasdaq-100-style), dominated by megacap tech and semiconductor names. A proxy for high-growth U.S. equity risk." },
  "mkts:US500": { name: "US 500", description: "Tracks the S&P 500 benchmark of 500 large U.S. companies. A broad gauge of the U.S. stock market and overall risk appetite." },

  // AVGO is also listed on the MAIN dex (bare name) — same company.
  AVGO: { name: "Broadcom Inc.", description: "A semiconductor and infrastructure-software giant supplying networking, custom AI accelerators (ASICs), and enterprise software (VMware). A top AI-infrastructure beneficiary alongside NVIDIA." },

  // Main-dex crypto/token entries (BTC, ETH, SOL, …), keyed by bare ticker.
  ...CRYPTO_DIRECTORY,
  ...CRYPTO_DIRECTORY_2,
};

/** Base ticker without the HIP-3 dex prefix ("xyz:SKHX" → "SKHX"). */
function stripDex(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

/** Case-insensitive directory lookup by canonical asset name. Falls back to
 *  the dex-stripped base ticker so a crypto listed on a builder dex
 *  ("hyna:ETH") resolves to the base entry ("ETH") without a duplicate row —
 *  but only when the full prefixed name has no entry of its own, so equity
 *  listings like "xyz:QNT" keep their specific (non-crypto) description. */
export function assetInfo(name: string): AssetInfo | undefined {
  const direct = lookup(name);
  if (direct) return direct;
  const i = name.indexOf(":");
  if (i > 0) return lookup(name.slice(i + 1));
  return undefined;
}

function lookup(name: string): AssetInfo | undefined {
  const hit = DIRECTORY[name];
  if (hit) return hit;
  const lower = name.toLowerCase();
  for (const k in DIRECTORY) if (k.toLowerCase() === lower) return DIRECTORY[k];
  return undefined;
}

/** Full name for an asset, or undefined when not in the directory. */
export function assetFullName(name: string): string | undefined {
  return assetInfo(name)?.name;
}

/** Business/asset description, or undefined when not in the directory. */
export function assetDescription(name: string): string | undefined {
  return assetInfo(name)?.description;
}

/** Searchable text (code name + display ticker + full name) so the picker
 *  search box matches "bitcoin", "nasdaq", "tesla", not just the code. */
export function assetSearchText(name: string): string {
  const info = assetInfo(name);
  return [name, info?.displayTicker, info?.name].filter(Boolean).join(" ");
}

/** Displayed ticker: the directory's displayTicker override when set
 *  (e.g. "NASDAQ-100"), else the dex-stripped code ("SKHX", "BTC"). */
export function assetTicker(name: string): string {
  return assetInfo(name)?.displayTicker ?? stripDex(name);
}

/** Secondary muted full-name shown beside the ticker in a row, or undefined
 *  when there's no name or a displayTicker already stands in for it. */
export function assetRowName(name: string): string | undefined {
  const info = assetInfo(name);
  return info?.displayTicker ? undefined : info?.name;
}

/** Display label: the full name when one exists ("SK Hynix Inc."), the
 *  displayTicker when set ("NASDAQ-100"), else the bare ticker ("BTC").
 *  The dex prefix is always dropped — the dex shows as its own badge. */
export function assetLabel(name: string): string {
  const info = assetInfo(name);
  if (info?.displayTicker) return info.displayTicker;
  return info?.name ?? stripDex(name);
}
