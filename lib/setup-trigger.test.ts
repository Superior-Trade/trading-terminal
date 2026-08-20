import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupCouldFix, SETUP_CANNOT_FIX } from "./superior-api";

describe("setupCouldFix", () => {
  it("fires on the code the credentials route ACTUALLY returns", () => {
    // The regression: the trigger tested for agent_wallet_not_ready, which
    // that route never returns. A spare account with no agent wallet answers
    // no_agent_wallet, so auto-setup never ran and the account was reported
    // unusable to someone with no way to fix it from the UI.
    expect(setupCouldFix("no_agent_wallet")).toBe(true);
    expect(setupCouldFix("agent_not_exportable")).toBe(true);
    expect(setupCouldFix("wallet_not_exportable")).toBe(true);
    expect(setupCouldFix("account_not_funded_on_hyperliquid")).toBe(true);
  });

  it("does not attempt repair on failures repair cannot fix", () => {
    expect(setupCouldFix("wallet_occupied")).toBe(false);
    expect(setupCouldFix("duplicate_wallet_address")).toBe(false);
    expect(setupCouldFix("wallet_wrong_owner")).toBe(false);
    expect(setupCouldFix("account_state_unavailable")).toBe(false);
  });

  it("defaults an UNKNOWN code to attempting repair, not to giving up", () => {
    // The whole point of the inversion: a code added to the API tomorrow must
    // not silently disable auto-setup the way no_agent_wallet did.
    expect(setupCouldFix("some_code_added_next_quarter")).toBe(true);
  });

  it("treats a missing code as not actionable", () => {
    expect(setupCouldFix("")).toBe(false);
  });

  it("every code in the not-fixable set is a real credentials-route code", (ctx) => {
    // Guards the other direction: a typo here silently re-enables repair for a
    // case we deliberately excluded.
    // Credentials attach is reached through several files, and the codes are
    // raised across all of them — duplicate_wallet_address comes from the
    // occupancy service, not the route. Scan every source that can answer a
    // credentials attach rather than assuming one file owns them.
    //
    // Those sources belong to the Superior Trade API, which is a separate
    // service: this check can only run where its code is checked out beside
    // this repo. Everywhere else the set is verified by the tests above, which
    // pin the behaviour rather than the spelling.
    const sources = [
      "../api/src/routes/credentials-v2.ts",
      "../api/src/routes/deployment.ts",
      "../api/src/service/account-occupancy.ts",
      "../api/src/service/hyperliquid-onboarding.ts",
    ];
    const real = new Set<string>();
    for (const rel of sources) {
      let src: string;
      try {
        src = readFileSync(join(process.cwd(), rel), "utf8");
      } catch {
        ctx.skip();
        return;
      }
      for (const m of src.matchAll(/error:\s*'([a-z_]+)'/g)) real.add(m[1]);
    }
    const unknown = [...SETUP_CANNOT_FIX].filter((c) => !real.has(c));
    expect(unknown).toEqual([]);
  });
});
