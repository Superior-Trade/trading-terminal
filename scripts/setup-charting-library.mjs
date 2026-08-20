// Copies TradingView's Advanced Charts into public/static/.
//
// TradingView distributes the library through a private GitHub repository they
// grant you access to after you apply. This script clones it with YOUR git
// credentials — nothing here bypasses their gate, it just saves you the file
// shuffling once you are through it.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO =
  process.env.CHARTING_LIBRARY_REPO ??
  "https://github.com/tradingview/charting_library.git";
const target = join(process.cwd(), "public", "static");

if (existsSync(join(target, "charting_library", "charting_library.js"))) {
  console.log("Advanced Charts already installed — nothing to do.");
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "charting-library-"));
try {
  console.log(`Cloning ${REPO} …`);
  execFileSync("git", ["clone", "--depth", "1", REPO, tmp], {
    stdio: "inherit",
  });
  for (const dir of ["charting_library", "datafeeds"]) {
    const from = join(tmp, dir);
    if (!existsSync(from)) {
      throw new Error(`the clone has no "${dir}" directory`);
    }
    cpSync(from, join(target, dir), { recursive: true });
    console.log(`Installed public/static/${dir}`);
  }
  console.log("\nDone. `npm run dev` will now build the chart.");
} catch (err) {
  console.error(
    [
      "",
      `  Could not install Advanced Charts: ${err?.message ?? err}`,
      "",
      "  A 'Repository not found' here almost always means the GitHub account",
      "  your git is authenticated as has not been granted access yet. Apply at",
      "  https://www.tradingview.com/advanced-charts/ and try again once you",
      "  have the invitation.",
      "",
      "  See docs/charting-library.md to install it by hand instead.",
      "",
    ].join("\n"),
  );
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
