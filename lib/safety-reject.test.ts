import { describe, it, expect } from "vitest";
import { safetyRejectMessage } from "./setups-context";

// The dictionary is not loaded in a unit test; t() is identity-ish here, which
// is enough to assert WHICH text is chosen.
const t = (k: string) =>
  k === "deploySafetyRejectLead"
    ? "This setup didn't pass the safety checks:"
    : k === "deploySafetyRejectMore"
      ? "(+{n} more)"
      : k;

describe("safetyRejectMessage", () => {
  it("names the actual rule instead of blaming stop/leverage", () => {
    // Lookahead bias cannot be fixed by adjusting a stop, which is what the
    // old copy told every one of these users to do.
    const msg = safetyRejectMessage(
      "strategy failed safety validation:\ncode uses shift(-N) — that reads FUTURE candles (lookahead bias); backtests lie and live behaves differently",
      t,
    );
    expect(msg).toContain("lookahead bias");
    expect(msg).not.toMatch(/adjust the plan/i);
  });

  it("keeps the stop/leverage reason when that IS the reason", () => {
    const msg = safetyRejectMessage(
      "strategy failed safety validation:\nconfig.stoploss -0.8 at 5x puts the stop at/behind the liquidation price — use a tighter price stop or lower leverage.",
      t,
    );
    expect(msg).toContain("liquidation price");
  });

  it("counts the remaining reasons rather than hiding them", () => {
    const msg = safetyRejectMessage(
      "strategy failed safety validation:\nfirst reason here\nsecond reason\nthird reason",
      t,
    );
    expect(msg).toContain("first reason here");
    expect(msg).toContain("(+2 more)");
  });

  it("does not append a count when there is only one reason", () => {
    const msg = safetyRejectMessage(
      "strategy failed safety validation:\nonly reason",
      t,
    );
    expect(msg).not.toMatch(/more\)/);
  });

  it("falls back to the generic line when no reason survived", () => {
    expect(safetyRejectMessage("strategy failed safety validation:", t)).toBe(
      "deploySafetyReject",
    );
  });

  it("handles the prefix being absent or differently cased", () => {
    const msg = safetyRejectMessage("Strategy Failed Safety Validation\nsome rule", t);
    expect(msg).toContain("some rule");
  });
});

import { withDetails } from "./setups-context";

describe("withDetails", () => {
  it("appends the API's reasons to a headline that carries none", () => {
    // "Config or code validation failed" is all the API's `message` says; the
    // reasons live in `details`, which only the repair loop was reading.
    expect(
      withDetails("Config or code validation failed", [
        "config.stoploss must be negative (got 0.05)",
      ]),
    ).toBe(
      "Config or code validation failed config.stoploss must be negative (got 0.05)",
    );
  });

  it("caps the list so a card explains rather than crashes", () => {
    const msg = withDetails("failed", [
      "reason-one",
      "reason-two",
      "reason-three",
      "reason-four",
      "reason-five",
    ]);
    expect(msg).toContain("reason-one · reason-two · reason-three");
    expect(msg).toContain("(+2 more)");
    expect(msg).not.toContain("reason-four");
  });

  it("leaves the headline alone when there is nothing to add", () => {
    expect(withDetails("failed", undefined)).toBe("failed");
    expect(withDetails("failed", [])).toBe("failed");
    expect(withDetails("failed", ["  ", ""])).toBe("failed");
  });

  it("accepts a plain string as well as a list", () => {
    expect(withDetails("failed", "one reason")).toBe("failed one reason");
  });
});
