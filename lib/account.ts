import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";

/**
 * There is no login, and there is nobody to log in as.
 *
 * This terminal is yours: it runs on your machine, holds your Superior Trade
 * API key, and every request it serves is you. So "who is this?" has one
 * answer, and it is this constant. The key in the environment already proves
 * whose account it is — asking you to authenticate to your own computer first
 * would add a password without adding a guarantee.
 *
 * The id exists because rows have to belong to something: conversations, saved
 * plans and usage counters are all keyed by it. Keeping it as a real column
 * rather than assuming a single row means the schema does not have to change if
 * this ever grows a second account.
 */
export const ACCOUNT_ID = "local";

export interface Account {
  id: string;
}

const ACCOUNT: Account = { id: ACCOUNT_ID };

let ensured = false;

/** The account behind this request, with its row guaranteed to exist. */
export async function currentAccount(): Promise<Account> {
  if (!ensured) {
    try {
      const db = getDb();
      await db
        .insert(schema.users)
        .values({ id: ACCOUNT_ID, createdAt: Date.now() })
        .onConflictDoNothing();
      ensured = true;
    } catch {
      // Persistence is not required to use the terminal — the chart, market
      // data and the agent all work without it. Routes that genuinely need a
      // table will fail on their own with something more specific than this.
    }
  }
  return ACCOUNT;
}

/** The Superior Trade API key, or null when none is configured. */
export function superiorKey(): string | null {
  return process.env.SUPERIOR_TRADE_API_KEY?.trim() || null;
}

/**
 * Account + key for any route that calls the Superior Trade API.
 * Throws a Response (501) when no key is configured, which every caller
 * re-throws as-is.
 */
export async function requireSuperiorAuth(): Promise<{
  user: Account;
  key: string;
}> {
  const key = superiorKey();
  if (!key) {
    throw new Response(
      JSON.stringify({
        error:
          "No Superior Trade API key. Put SUPERIOR_TRADE_API_KEY in .env.local and restart — create one at https://superior.trade under Account → API keys.",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }
  return { user: await currentAccount(), key };
}
