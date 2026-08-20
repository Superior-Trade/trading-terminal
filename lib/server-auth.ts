import { createRemoteJWKSet, jwtVerify } from "jose";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { track } from "./analytics";

// ── Two auth modes ─────────────────────────────────────────────────────
//
// "local" (the default) is the self-hosted single-operator mode. There is no
// login: every request resolves to one fixed account that uses the
// SUPERIOR_TRADE_API_KEY from the environment. This is what you want when the
// terminal runs on your own machine — the browser tab and the API key belong
// to the same person, so a login step would only authenticate you to yourself.
//
// "privy" is the multi-tenant mode for hosting the terminal FOR OTHER PEOPLE.
// Each visitor signs in with Privy, and each gets their own Superior key,
// conversations and deployments. Verification uses Privy's public JWKS, so the
// app secret is never needed here (least privilege); a missing or invalid
// Bearer is a 401.

const LOCAL_DID = "local:self";

export interface AuthedUser {
  did: string;
  /** True in local mode: one shared account, no login. */
  isDev: boolean;
}

function privyAppId(): string | null {
  const id =
    process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
  return id.trim() || null; // empty env value = unconfigured, not configured
}

/** Raw AUTH_MODE, normalized. `dev`/`live` are the historical spellings. */
function configuredMode(): "local" | "privy" | null {
  const mode = (
    process.env.AUTH_MODE ||
    process.env.NEXT_PUBLIC_AUTH_MODE ||
    ""
  )
    .trim()
    .toLowerCase();
  if (mode === "local" || mode === "dev") return "local";
  if (mode === "privy" || mode === "live") return "privy";
  return null;
}

// Explicit mode wins; otherwise the presence of a Privy app ID decides.
export function authMode(): "local" | "privy" {
  return configuredMode() ?? (privyAppId() ? "privy" : "local");
}

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(appId: string) {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`),
    );
  }
  return _jwks;
}

export function privyConfigured(): boolean {
  return authMode() === "privy" && privyAppId() !== null;
}

async function ensureUserRow(did: string): Promise<void> {
  // Local dev without a DATABASE_URL: skip the row (nothing to persist).
  // Prod always has a DB, so this is a no-op there.
  if (!process.env.DATABASE_URL) return;
  const db = getDb();
  const existing = await db
    .select({ did: schema.users.privyDid })
    .from(schema.users)
    .where(eq(schema.users.privyDid, did));
  if (!existing.length) {
    const inserted = await db
      .insert(schema.users)
      .values({ privyDid: did, createdAt: Date.now() })
      .onConflictDoNothing()
      .returning({ did: schema.users.privyDid });
    // Registration = this DID's row was created by US, right now — the
    // .returning() guard means a concurrent-request race can't double-fire.
    if (inserted.length) track("user_registered", { user: did });
  }
}

/** Resolve the requesting user or throw a Response(401). */
export async function requireUser(req: Request): Promise<AuthedUser> {
  const appId = privyAppId();
  if (authMode() === "local" || !appId) {
    // Local mode collapses EVERY request onto one identity. That is the point
    // when you run the terminal for yourself, and a disaster if it happens by
    // accident on a public deployment — every visitor would share one
    // account's chat, plans and funds.
    //
    // So a production build must OPT IN: `AUTH_MODE=local` has to be set
    // explicitly. Merely forgetting PRIVY_APP_ID on a hosted build fails
    // closed instead of silently serving one shared account to the internet.
    if (process.env.NODE_ENV === "production" && configuredMode() !== "local") {
      throw new Response(
        JSON.stringify({
          error:
            "auth not configured: set AUTH_MODE=local for a single-operator install, or PRIVY_APP_ID to host this for multiple users",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    await ensureUserRow(LOCAL_DID);
    return { did: LOCAL_DID, isDev: true };
  }
  // Test bypass (never in production): eval runners authenticate with the
  // server secret instead of a Privy session.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.SERVER_SECRET &&
    req.headers.get("x-dev-secret") === process.env.SERVER_SECRET
  ) {
    await ensureUserRow(LOCAL_DID);
    return { did: LOCAL_DID, isDev: true };
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    throw new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const { payload } = await jwtVerify(token, getJwks(appId), {
      issuer: "privy.io",
      audience: appId,
    });
    const did = payload.sub;
    if (!did) throw new Error("no sub claim");
    await ensureUserRow(did);
    return { did, isDev: false };
  } catch {
    throw new Response(JSON.stringify({ error: "invalid token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/** Forwardable Bearer from the incoming request (for Superior v2 calls). */
export function bearerFrom(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

// ── AES-256-GCM for stored Superior keys (server-side only) ────────────

function encryptionKey(): Buffer {
  const secret = process.env.SERVER_SECRET ?? "dev-only-secret-change-me";
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64")).join(":");
}

export function decryptSecret(stored: string): string {
  const [iv, tag, enc] = stored.split(":").map((s) => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
