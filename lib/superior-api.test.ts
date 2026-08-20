import { describe, expect, it } from "vitest";

import {
  deployableHyperliquidUsd,
  deploymentOccupiesExchange,
} from "./superior-api";

describe("deploymentOccupiesExchange", () => {
  it("does not occupy a Hyperliquid wallet for a running deployment on another exchange", () => {
    expect(
      deploymentOccupiesExchange(
        { status: "running", exchange: "lighter", deletedAt: null },
        "hyperliquid",
      ),
    ).toBe(false);
  });

  it("treats legacy deployments without an exchange as Hyperliquid", () => {
    expect(
      deploymentOccupiesExchange(
        { status: "running", exchange: null, deletedAt: null },
        "hyperliquid",
      ),
    ).toBe(true);
  });

  it("does not occupy a wallet for stopped deployments on the same exchange", () => {
    expect(
      deploymentOccupiesExchange(
        { status: "stopped", exchange: "hyperliquid", deletedAt: null },
        "hyperliquid",
      ),
    ).toBe(false);
  });
});

describe("deployableHyperliquidUsd", () => {
  it("counts held USDC only for the main account", () => {
    expect(deployableHyperliquidUsd(0, 100, true)).toBe(100);
    expect(deployableHyperliquidUsd(0, 100, false)).toBe(0);
  });

  it("returns unknown when both balance sources are unknown", () => {
    expect(deployableHyperliquidUsd(null, null, true)).toBeNull();
  });
});
