import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { METRICS_HONESTY } from "./metrics-honesty";

// Guards against the "50-60% win rate" incident: the agent invented a win
// rate for a strategy whose real backtest said 27.63%. The rule must forbid
// unmeasured figures, require sample size + period on measured ones, and
// stay wired into BOTH prompts that talk about setups.

describe("METRICS_HONESTY", () => {
  it("forbids performance figures without a computed backtest behind them", () => {
    expect(METRICS_HONESTY).toMatch(/NEVER state a win rate/);
    expect(METRICS_HONESTY).toMatch(/computed backtest result/);
    expect(METRICS_HONESTY).toMatch(/fabrication/);
  });

  it("requires sample size and period on any measured figure", () => {
    expect(METRICS_HONESTY).toMatch(/sample size and period/);
  });

  it("routes a data-less win-rate ask to measurement, not a guess", () => {
    expect(METRICS_HONESTY).toMatch(/hasn't been measured yet/);
    expect(METRICS_HONESTY).toMatch(/offer to run a backtest/);
  });

  // The rule only works if the prompts actually carry it. Route files can't
  // be imported in a unit test (they pull in server-only modules), so assert
  // the wiring at the source level.
  it("is embedded in the chat and detect system prompts", () => {
    for (const rel of ["app/api/chat/route.ts", "app/api/detect/route.ts"]) {
      const src = readFileSync(join(__dirname, "..", rel), "utf8");
      expect(src, `${rel} must interpolate METRICS_HONESTY into its system prompt`).toContain(
        "${METRICS_HONESTY}",
      );
    }
  });
});
