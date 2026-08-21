/**
 * Stand-in for TradingView's Advanced Charts when it is not installed.
 *
 * next.config.ts aliases the real import path here so that trading-chart.tsx
 * still compiles and bundles. Nothing calls into it: the terminal checks
 * HAS_ADVANCED_CHARTS and mounts the preview chart instead. If something ever
 * does reach this, throwing is the correct outcome — silently rendering nothing
 * would look like a broken chart rather than a missing dependency.
 */
const MESSAGE =
  "TradingView Advanced Charts is not installed. Run `npm run setup:charts` " +
  "or see docs/charting-library.md.";

export function widget(): never {
  throw new Error(MESSAGE);
}

export type ChartingLibraryWidgetOptions = Record<string, unknown>;
export type LanguageCode = string;
export type ResolutionString = string;
export type IChartingLibraryWidget = Record<string, unknown>;
export type Bar = Record<string, unknown>;
export type LibrarySymbolInfo = Record<string, unknown>;
export type DatafeedConfiguration = Record<string, unknown>;
export type IBasicDataFeed = Record<string, unknown>;
export type SubscribeBarsCallback = (bar: Bar) => void;
export type ResolveCallback = (info: LibrarySymbolInfo) => void;
export type ErrorCallback = (reason: string) => void;
export type HistoryCallback = (bars: Bar[], meta: { noData: boolean }) => void;
export type SearchSymbolsCallback = (items: unknown[]) => void;
export type PeriodParams = { from: number; to: number; countBack: number; firstDataRequest: boolean };
