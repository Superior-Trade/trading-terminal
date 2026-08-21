/**
 * Which chart this build is running.
 *
 * TradingView's Advanced Charts cannot be redistributed, so it is not in this
 * repository — see docs/charting-library.md. When it has not been installed the
 * terminal falls back to the Lightweight Charts preview, which ships here under
 * Apache-2.0 and works out of the box with less capability.
 *
 * The flag is resolved at BUILD time by next.config.ts, which is the only place
 * that can see whether the files exist. Reading the filesystem here would not
 * work: this value is needed in the browser.
 */
export const HAS_ADVANCED_CHARTS =
  process.env.NEXT_PUBLIC_HAS_ADVANCED_CHARTS === "1";
