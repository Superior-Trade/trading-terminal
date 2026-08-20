/**
 * The largest stake the panel may offer for a given deployable balance.
 *
 * The terminal caps with a 0.95 haircut; the API refuses anything whose
 * margin × FUNDING_BUFFER (1.05) exceeds what it can reach. Those are two
 * different constants aimed at the same gap — venue fees on top of the bare
 * margin — and nothing tied them together. They happen to be compatible
 * (0.95·D ≤ D/1.05 ≈ 0.952·D), but only just, and neither file mentions the
 * other. sizing-ceiling.test.ts reads FUNDING_BUFFER out of the API source and
 * asserts the relationship still holds, so raising one without the other
 * fails a test instead of surfacing as a venue rejection.
 */
export const SIZING_HAIRCUT = 0.95;

export function maxStakeFor(deployableUsd: number): number {
  return Math.max(10, Math.floor(deployableUsd * SIZING_HAIRCUT));
}
