import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FUNDING_BUFFER,
  MIN_DEPLOYABLE_USD,
  MIN_STAKE_USD,
  SIZING_HAIRCUT,
  clampPersistedStake,
  deployableFundsUsd,
  maxStakeFor,
  neededForStakeUsd,
} from "./sizing-ceiling";

// The Superior Trade API tops a bracket's margin up by a small buffer before
// deciding an account can afford it. FUNDING_BUFFER mirrors it — and this
// reads the real value instead when the API source happens to sit next door
// (the monorepo layout), which is what turns a silent drift into a failing
// test.
const API_BRACKET_SOURCE = "../api/src/routes/bracket.ts";

function serverFundingBuffer(): number {
  let src: string;
  try {
    src = readFileSync(join(process.cwd(), API_BRACKET_SOURCE), "utf8");
  } catch {
    return FUNDING_BUFFER; // API source not checked out alongside
  }
  const m = src.match(/const FUNDING_BUFFER\s*=\s*([\d.]+)/);
  if (!m) throw new Error("FUNDING_BUFFER not found in the API bracket route");
  return Number(m[1]);
}

describe("sizing ceiling vs the API's funding buffer", () => {
  it("never offers a stake the API would refuse", () => {
    const buffer = serverFundingBuffer();
    // Across realistic balances, the panel's ceiling must survive the server's
    // margin × buffer test. phi's $100 is in here deliberately.
    for (const deployable of [25, 50, 100, 105, 250, 1000, 5000, 12345.67]) {
      const stake = maxStakeFor(deployable);
      expect(stake, `deployable $${deployable}`).not.toBeNull();
      const needed = Math.ceil((stake as number) * buffer * 100) / 100;
      expect(
        needed,
        `deployable $${deployable}: panel offers $${stake}, API needs $${needed}`,
      ).toBeLessThanOrEqual(deployable);
    }
  });

  it("catches the two constants drifting apart", () => {
    // If someone raises the API buffer without lowering the haircut, the
    // relationship breaks — that is the failure this file exists to cause.
    const wouldBreak = 1 / SIZING_HAIRCUT; // ≈1.0526
    expect(serverFundingBuffer()).toBeLessThan(wouldBreak);
    expect(FUNDING_BUFFER).toBeLessThan(wouldBreak);
  });

  it("reproduces phi's case: $100 deployable offers at most $95", () => {
    expect(maxStakeFor(100)).toBe(95);
  });

  it("no dead band: every slider-expressible stake passes the pre-flight", () => {
    // The $11.00–$12.15 band used to be undeployable: the slider offered
    // exactly $11 while the pre-flight demanded 11 × 1.05 = $11.55, so every
    // expressible value failed. Any deployable balance that yields a ceiling
    // must accept every whole-dollar stake up to that ceiling.
    for (const deployable of [
      MIN_DEPLOYABLE_USD, 11.6, 12, 12.15, 12.63, 13, 15, 20, 47.5, 100,
    ]) {
      const max = maxStakeFor(deployable);
      expect(max, `deployable $${deployable}`).not.toBeNull();
      for (let stake = MIN_STAKE_USD; stake <= (max as number); stake++) {
        expect(
          neededForStakeUsd(stake),
          `deployable $${deployable}: stake $${stake} needs $${neededForStakeUsd(stake)}`,
        ).toBeLessThanOrEqual(deployable);
      }
    }
  });

  it("refuses to offer a stake below the fundable minimum", () => {
    // stake × FUNDING_BUFFER pushes an $11 requirement past what these
    // balances reach — a slider would be doomed, so the panel must prompt
    // for a deposit instead.
    expect(maxStakeFor(0)).toBeNull();
    expect(maxStakeFor(5)).toBeNull();
    expect(maxStakeFor(10)).toBeNull();
    expect(maxStakeFor(11)).toBeNull();
    expect(maxStakeFor(MIN_DEPLOYABLE_USD - 0.01)).toBeNull();
    expect(maxStakeFor(MIN_DEPLOYABLE_USD)).toBe(MIN_STAKE_USD);
  });
});

describe("clampPersistedStake", () => {
  it("clamps an under-minimum cookie up to the floor instead of discarding it", () => {
    // A legacy cookie with funds 10 used to be rejected → the $100 default
    // → a 10x oversized deploy.
    expect(clampPersistedStake(10)).toBe(MIN_STAKE_USD);
    expect(clampPersistedStake(1)).toBe(MIN_STAKE_USD);
  });

  it("keeps valid values and rejects non-numbers", () => {
    expect(clampPersistedStake(50)).toBe(50);
    expect(clampPersistedStake(MIN_STAKE_USD)).toBe(MIN_STAKE_USD);
    expect(clampPersistedStake(NaN)).toBeNull();
    expect(clampPersistedStake("50")).toBeNull();
    expect(clampPersistedStake(undefined)).toBeNull();
  });
});

describe("deployableFundsUsd", () => {
  it("counts an occupied wallet's free margin, net of its committed stake", () => {
    // The normal stop→redeploy flow: a $200 wallet running a $12 strategy
    // still has $188 deployable — treating the whole wallet as unreachable
    // is what false-rejected redeploys.
    expect(
      deployableFundsUsd([
        { withdrawableUsd: 200, heldUsd: 0, isMain: true, committedUsd: 12 },
      ]),
    ).toBe(188);
  });

  it("adds main's held USDC and other wallets' free margin", () => {
    expect(
      deployableFundsUsd([
        { withdrawableUsd: 10, heldUsd: 40, isMain: true, committedUsd: 0 },
        { withdrawableUsd: 25, isMain: false, committedUsd: 20 },
        { withdrawableUsd: 30, isMain: false },
      ]),
    ).toBe(85);
  });

  it("treats an unreadable committed stake as the whole wallet spoken for", () => {
    expect(
      deployableFundsUsd([
        { withdrawableUsd: 100, heldUsd: 0, isMain: true, committedUsd: null },
      ]),
    ).toBe(0);
  });

  it("is null while the main balance is entirely unknown", () => {
    expect(
      deployableFundsUsd([{ withdrawableUsd: null, heldUsd: null, isMain: true }]),
    ).toBeNull();
    expect(deployableFundsUsd([])).toBeNull();
  });
});
