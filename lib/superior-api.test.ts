import { describe, expect, it } from "vitest";

import {
  deployableHyperliquidUsd,
  deploymentOccupiesExchange,
  insufficientBalanceMessage,
  isInsufficientBalanceError,
  withInsufficientBalanceGuidance,
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

// September's unfunded-account failures: what upstream actually returns for
// "no money" (verified against apps/api routes), and the one plain sentence
// it must become for the UI card AND the chat agent.
describe("isInsufficientBalanceError", () => {
  it("recognises every upstream deposit-fixable code", () => {
    for (const error of [
      "insufficient_funds", // bracket 409
      "wallet_unfunded", // bracket 409 (no HL balance yet)
      "insufficient_subaccount_balance", // credentials 400
      "account_not_funded_on_hyperliquid", // deploy start / onboarding 400
      "insufficient_for_lighter_minimum", // allocation 400
    ]) {
      expect(isInsufficientBalanceError({ error }), error).toBe(true);
    }
  });

  it("recognises code-less bodies by message text", () => {
    expect(
      isInsufficientBalanceError({
        message:
          "This account holds no balance on Hyperliquid yet. A deposit of at least $5 USDC must reach Hyperliquid before its agent wallet and builder fee can be set up.",
      }),
    ).toBe(true);
  });

  it("leaves venue margin rejections and unrelated errors alone", () => {
    // insufficient_margin = a FUNDED account whose order exceeds free margin;
    // lowering size/leverage fixes it too, so it keeps its own handling.
    expect(isInsufficientBalanceError({ error: "insufficient_margin" })).toBe(false);
    expect(isInsufficientBalanceError({ error: "wallet_occupied" })).toBe(false);
    expect(isInsufficientBalanceError({ error: "validation_failed" })).toBe(false);
    expect(isInsufficientBalanceError({})).toBe(false);
  });
});

describe("insufficientBalanceMessage", () => {
  it("names the balance, the requirement, and the Deposit button", () => {
    expect(
      insufficientBalanceMessage({ kind: "deployment", holdsUsd: 3.2, neededUsd: 105 }),
    ).toBe(
      "Your trading account holds $3.20 — this deployment needs at least $105.00. Add funds via the Deposit button (top right), then deploy again.",
    );
  });

  it("degrades cleanly when a figure is unknown", () => {
    expect(insufficientBalanceMessage({ kind: "order", neededUsd: 61.95 })).toBe(
      "Your trading account doesn't hold enough USDC — this order needs at least $61.95. Add funds via the Deposit button (top right), then try again.",
    );
    expect(insufficientBalanceMessage({ kind: "deployment" })).toBe(
      "Your trading account doesn't hold enough USDC — not enough for this deployment. Add funds via the Deposit button (top right), then deploy again.",
    );
  });
});

describe("withInsufficientBalanceGuidance", () => {
  it("rewrites the upstream bracket insufficient_funds body, keeping the original", () => {
    const upstream = {
      error: "insufficient_funds",
      message:
        "This bracket needs about $61.95 of margin. Main: $10.00 available · Trading Account 2: $2.50 available. Deposit more, free up a position, or lower the size or leverage.",
      needed_usd: 61.95,
      accounts: ["Main: $10.00 available", "Trading Account 2: $2.50 available"],
    };
    const mapped = withInsufficientBalanceGuidance(upstream, false, "order");
    expect(mapped.message).toBe(
      "Your trading account holds $12.50 — this order needs at least $61.95. Add funds via the Deposit button (top right), then try again.",
    );
    expect(mapped.upstream_message).toBe(upstream.message);
    expect(mapped.error).toBe("insufficient_funds");
  });

  it("passes successes and non-funding failures through untouched", () => {
    const ok = { id: "b1" };
    expect(withInsufficientBalanceGuidance(ok, true, "order")).toBe(ok);
    const busy = { error: "wallet_occupied", message: "This wallet already has an active deployment." };
    expect(withInsufficientBalanceGuidance(busy, false, "order")).toBe(busy);
  });
});
