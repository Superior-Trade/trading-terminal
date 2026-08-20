import { defineConfig } from "drizzle-kit";

// Mirrors lib/db/index.ts: no DATABASE_URL means the embedded database, so
// `npm run db:generate` and `npm run db:migrate` work out of the box.
const url =
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL ||
  "";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  ...(url
    ? // A direct (unpooled) connection is preferred for DDL — Neon exposes
      // both, and the pooled DATABASE_URL is a fine fallback.
      { dbCredentials: { url } }
    : {
        driver: "pglite" as const,
        dbCredentials: { url: process.env.PGLITE_PATH || "./.data/pglite" },
      }),
});
