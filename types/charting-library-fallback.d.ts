/**
 * Type fallback for TradingView's Advanced Charts.
 *
 * The library is not redistributable, so a fresh clone does not have it and
 * `tsc` cannot resolve the two paths components/chart imports from. Webpack is
 * already handled — next.config.ts aliases those specifiers to a stub — but the
 * type checker does not read webpack aliases, so the build compiled and then
 * failed at the type step.
 *
 * Every symbol is `any` on purpose. Reproducing the real signatures would be a
 * second, drifting copy of a large vendor API, and it would be type-checking
 * code this build never executes: without the library the terminal mounts the
 * Lightweight Charts preview instead.
 *
 * These are WILDCARD ambient declarations, which TypeScript consults only when
 * a specifier does not resolve to a real file — so installing Advanced Charts
 * restores its own .d.ts and full type safety over components/chart. A
 * shorthand `declare module "x";` does not work here: it makes the imports
 * values rather than types, and most of these are used as types.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "*/public/static/charting_library" {
  export const widget: any;
  export type ChartingLibraryWidgetOptions = any;
  export type IChartingLibraryWidget = any;
  export type LanguageCode = any;
  export type ResolutionString = any;
  export type EntityId = any;
  export type StudyInputValue = any;
}

declare module "*/public/static/charting_library/datafeed-api" {
  export type Bar = any;
  export type DatafeedConfiguration = any;
  export type GetMarksCallback<T = any> = any;
  export type HistoryCallback = any;
  export type LibrarySymbolInfo = any;
  export type Mark = any;
  export type PeriodParams = any;
  export type ResolutionString = any;
  export type SearchSymbolResultItem = any;
  export type SubscribeBarsCallback = any;
  export type TimescaleMark = any;
}
