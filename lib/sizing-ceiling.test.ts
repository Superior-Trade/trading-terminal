import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { maxStakeFor, SIZING_HAIRCUT } from "./sizing-ceiling";

// The Superior Trade API tops a bracket's margin up by a small buffer before
// deciding an account can afford it. That constant lives in the API, not here,
// so this mirrors it — and reads the real value instead when the API source
// happens to sit next door (the monorepo layout), which is what turns a silent
// drift into a failing test.
const PUBLISHED_FUNDING_BUFFER = 1.05;
const API_BRACKET_SOURCE = "../api/src/routes/bracket.ts";

function serverFundingBuffer(): number {
  let src: string;
  try {
    src = readFileSync(join(process.cwd(), API_BRACKET_SOURCE), "utf8");
  } catch {
    return PUBLISHED_FUNDING_BUFFER; // API source not checked out alongside
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
    for (const deployable of [10, 25, 50, 100, 105, 250, 1000, 5000, 12345.67]) {
      const stake = maxStakeFor(deployable);
      if (stake === 11) continue; // floor case: the panel's own minimum
      const needed = Math.ceil(stake * buffer * 100) / 100;
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
  });

  it("reproduces phi's case: $100 deployable offers at most $95", () => {
    expect(maxStakeFor(100)).toBe(95);
  });

  it("keeps the $11 floor rather than offering an unplaceable stake", () => {
    expect(maxStakeFor(0)).toBe(11);
    expect(maxStakeFor(5)).toBe(11);
    // The old $10 floor passed the local gate but upstream rejected it:
    // stake × 1.05 pushes the requirement past $10 ("increase to at least $11").
    expect(maxStakeFor(10)).toBe(11);
  });
});
