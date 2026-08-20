import { getDb, dbKind } from "./index";

/**
 * Apply pending migrations at server start.
 *
 * This runs automatically for the embedded database (PGlite), because there is
 * no provisioning step a self-hosted install could hang a migration off — the
 * database file comes into existence the first time the app opens it, so the
 * app is the only thing that can create the tables.
 *
 * A DATABASE_URL you supplied yourself is NOT migrated automatically: a shared
 * or production Postgres should have its schema changed deliberately, by you,
 * with `npm run db:migrate`. Set DB_AUTO_MIGRATE=1 to opt in anyway.
 *
 * Drizzle records what it has applied in its own table, so this is idempotent
 * and cheap on every start after the first.
 */
export async function migrateIfNeeded(): Promise<void> {
  const kind = dbKind();
  const auto = kind === "pglite" || process.env.DB_AUTO_MIGRATE === "1";
  if (!auto) return;

  const folder = "./drizzle";
  const db = getDb();
  try {
    if (kind === "pglite") {
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      await migrate(db as unknown as Parameters<typeof migrate>[0], {
        migrationsFolder: folder,
      });
    } else if (kind === "neon") {
      const { migrate } = await import("drizzle-orm/neon-http/migrator");
      await migrate(db as unknown as Parameters<typeof migrate>[0], {
        migrationsFolder: folder,
      });
    } else {
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(db as unknown as Parameters<typeof migrate>[0], {
        migrationsFolder: folder,
      });
    }
  } catch (err) {
    // A terminal that cannot migrate is still a terminal: the chart, the
    // market data and the agent all work without persistence. Log loudly and
    // let the individual routes fail on their own if they need a table.
    console.error(
      "[db] migrations failed — history and saved plans will not persist:",
      err instanceof Error ? err.message : err,
    );
  }
}
