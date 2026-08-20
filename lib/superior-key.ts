import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import {
  encryptSecret,
  decryptSecret,
  privyConfigured,
  authMode,
  requireUser,
  bearerFrom,
  type AuthedUser,
} from "./server-auth";

const API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

// Stored keys can DIE upstream (rotated/revoked on Superior's side) while
// still decrypting fine here — trusting them unconditionally dead-ends the
// user with 401s on every proxy route. Validate a stored key against the
// API before using it (TTL-cached per warm instance so the extra round-trip
// is paid at most once per key per window); a rejected key is wiped so the
// mint/fallback path below takes over — self-healing instead of stuck.
const KEY_VALIDATION_TTL_MS = 10 * 60_000;
const validatedKeys = new Map<string, number>(); // key → validatedAt

async function storedKeyAlive(key: string): Promise<boolean> {
  const at = validatedKeys.get(key);
  if (at && Date.now() - at < KEY_VALIDATION_TTL_MS) return true;
  try {
    const res = await fetch(`${API_BASE}/v2/account`, {
      headers: { "x-api-key": key },
    });
    if (res.status === 401 || res.status === 403) return false;
    // Any other status (200, 5xx, network blips) counts as alive — only a
    // definitive auth rejection may discard a user's key.
    validatedKeys.set(key, Date.now());
    if (validatedKeys.size > 1000) validatedKeys.clear(); // unbounded-growth guard
    return true;
  } catch {
    return true; // upstream unreachable — don't punish the key
  }
}

// Superior key resolution.
//
// LOCAL MODE (the self-hosted default) has exactly one answer: the
// SUPERIOR_TRADE_API_KEY you put in .env.local. There is no per-user store to
// consult and nothing to mint — you are the only user, and the key is already
// yours. This is checked first so a local install needs no database at all.
//
// PRIVY MODE serves many users, so each gets their OWN key:
// 1. decrypt this user's stored key if one was minted before (and confirm the
//    API still accepts it — wipe + re-mint when it was revoked);
// 2. else mint one via POST /auth/api-key using the user's Privy Bearer and
//    store it encrypted.
export async function getSuperiorApiKey(
  user: AuthedUser,
  bearer: string | null,
): Promise<string | null> {
  if (authMode() === "local") {
    return process.env.SUPERIOR_TRADE_API_KEY?.trim() || null;
  }

  const db = process.env.DATABASE_URL ? getDb() : null;
  if (db) {
    const rows = await db
      .select({ enc: schema.users.stKeyEncrypted })
      .from(schema.users)
      .where(eq(schema.users.privyDid, user.did));
    if (rows[0]?.enc) {
      try {
        const stored = decryptSecret(rows[0].enc);
        if (await storedKeyAlive(stored)) return stored;
        console.warn(`[superior-key] stored key rejected upstream for ${user.did}; re-minting`);
        await db
          .update(schema.users)
          .set({ stKeyEncrypted: null })
          .where(eq(schema.users.privyDid, user.did));
      } catch {
        /* re-mint below */
      }
    }
  }

  if (bearer && privyConfigured() && db) {
    try {
      const res = await fetch(`${API_BASE}/auth/api-key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ name: "trading-terminal" }),
      });
      if (res.ok) {
        const j = (await res.json()) as { key?: string; apiKey?: string };
        const key = j.key ?? j.apiKey;
        if (key) {
          await db
            .update(schema.users)
            .set({ stKeyEncrypted: encryptSecret(key) })
            .where(eq(schema.users.privyDid, user.did));
          return key;
        }
      }
    } catch {
      /* fall through */
    }
  }

  // In Privy mode, per-user minting is the ONLY key path for real users. The
  // shared SUPERIOR_TRADE_API_KEY authorizes the HOST's own Hyperliquid
  // account, so a visitor reaching it could move the host's funds (a
  // withdrawal's destination is the caller's OWN wallet). Never fall back to
  // it here: if minting failed, fail closed (caller → 501). The fix is to make
  // minting work, not to paper over it with someone else's money.
  return null;
}

/** Auth + key resolution for Superior proxy routes. Throws Response. */
export async function resolveSuperiorAuth(
  req: Request,
): Promise<{ user: AuthedUser; key: string }> {
  const user = await requireUser(req);
  const key = await getSuperiorApiKey(user, bearerFrom(req));
  if (!key) {
    throw new Response(
      JSON.stringify({
        error:
          "no Superior Trade API key for this account — set SUPERIOR_TRADE_API_KEY in .env.local (get one at https://superior.trade)",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }
  return { user, key };
}
