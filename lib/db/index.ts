import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/**
 * One Postgres, three ways to reach it — chosen from DATABASE_URL alone.
 *
 *   unset          → PGlite, an embedded Postgres that stores its data in a
 *                    local directory (PGLITE_PATH, default ./.data/pglite).
 *                    Nothing to install and nothing to sign up for: this is
 *                    what makes `npm install && npm run dev` enough to start.
 *   *.neon.tech    → Neon's HTTP driver (serverless-friendly, no pooling).
 *   anything else  → node-postgres, i.e. any ordinary Postgres, local or not.
 *
 * The queries are identical across all three — everything above this module is
 * plain Drizzle and never learns which one it got.
 */

// One concrete type rather than a union of the three: the union has no callable
// `.insert()` (TypeScript cannot resolve an overload across three unrelated
// signatures), and the three drivers expose an identical query surface anyway.
// The one place they differ is the raw `db.execute()` result, and every caller
// of that already narrows it by hand.
export type Db = ReturnType<typeof drizzlePg<typeof schema>>;

export type DbKind = "pglite" | "neon" | "postgres";

/** Which driver the current DATABASE_URL selects. Safe to call at any time. */
export function dbKind(): DbKind {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return "pglite";
  return /(^|[@.])neon\.tech([:/]|$)/i.test(url) ? "neon" : "postgres";
}

/** Filesystem directory backing the embedded database (pglite only). */
export function pgliteDir(): string {
  return process.env.PGLITE_PATH?.trim() || "./.data/pglite";
}

// Cached on globalThis, not in a module-level `let`: the dev server reloads
// modules on edit, and a second PGlite instance opening the same directory
// fails on the lock the first one still holds.
const CACHE = globalThis as typeof globalThis & { __terminalDb?: Db };

export function getDb(): Db {
  if (CACHE.__terminalDb) return CACHE.__terminalDb;
  const url = process.env.DATABASE_URL?.trim();
  const kind = dbKind();
  if (kind === "pglite") {
    // PGlite creates its data directory, but not the parents above it, so a
    // first run against the default ./.data/pglite fails on a missing ./.data.
    mkdirSync(pgliteDir(), { recursive: true });
  }
  const db =
    kind === "pglite"
      ? drizzlePglite(new PGlite(pgliteDir()), { schema })
      : kind === "neon"
        ? drizzleNeon(neon(url!), { schema })
        : drizzlePg(new Pool({ connectionString: url }), { schema });
  CACHE.__terminalDb = db as unknown as Db;
  return CACHE.__terminalDb;
}

export { schema };
