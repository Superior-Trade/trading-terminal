import { describe, expect, it } from "vitest";
import { envFlagEnabled } from "./env-flags";

describe("envFlagEnabled", () => {
  it("enables only on 1/true, case-insensitive", () => {
    expect(envFlagEnabled("1")).toBe(true);
    expect(envFlagEnabled("true")).toBe(true);
    expect(envFlagEnabled("TRUE")).toBe(true);
    expect(envFlagEnabled(" true ")).toBe(true);
  });

  it("treats 0/false/other values as off", () => {
    // FORCE_PREVIEW_CHART=0 used to force the preview anyway (bare
    // truthiness), disabling an installed TradingView build.
    expect(envFlagEnabled("0")).toBe(false);
    expect(envFlagEnabled("false")).toBe(false);
    expect(envFlagEnabled("no")).toBe(false);
    expect(envFlagEnabled("")).toBe(false);
    expect(envFlagEnabled(undefined)).toBe(false);
  });
});
