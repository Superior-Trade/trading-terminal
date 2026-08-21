// Reports which chart this build will use.
//
// This used to abort the build. It no longer does: the terminal falls back to
// the Lightweight Charts preview, which ships in this repository under
// Apache-2.0, so a fresh clone runs without waiting on TradingView's approval.
// The message is still worth printing, because the preview gives up real
// capability and someone who does not know that will read it as broken.
import { existsSync } from "node:fs";
import { join } from "node:path";

const entry = join(process.cwd(), "public", "static", "charting_library", "charting_library.js");

if (existsSync(entry)) {
  console.log("  chart: TradingView Advanced Charts");
} else {
  console.log(
    [
      "",
      "  chart: Lightweight Charts (preview)",
      "",
      "  TradingView Advanced Charts is not installed, so the terminal will run",
      "  its preview chart. Everything works except drawing on the chart and",
      "  indicator studies.",
      "",
      "    Request access:  https://www.tradingview.com/advanced-charts/",
      "    Then install:    npm run setup:charts",
      "",
      "  docs/charting-library.md",
      "",
    ].join("\n"),
  );
}
