// TradingView's Advanced Charts library is licensed, not redistributable, so
// it cannot be vendored into this repo. It has to come from TradingView, to
// you, under their terms — see docs/charting-library.md.
//
// Without it the build fails inside webpack with an unhelpful "Module not
// found: ../../public/static/charting_library". This turns that into an
// instruction.
import { existsSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "public", "static", "charting_library");
const entry = join(dir, "charting_library.js");

if (!existsSync(entry)) {
  console.error(
    [
      "",
      "  TradingView Advanced Charts is not installed.",
      "",
      "  The chart is the one part of this terminal we are not allowed to ship:",
      "  TradingView licenses it directly to you, free, and it takes a day or two",
      "  to be granted.",
      "",
      "    1. Request access:  https://www.tradingview.com/advanced-charts/",
      "    2. Once granted:    npm run setup:charts",
      "",
      "  Full instructions, including the manual route: docs/charting-library.md",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
