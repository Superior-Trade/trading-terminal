import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // Bring the embedded database up to date before the first request can
    // touch it. No-op for a DATABASE_URL you manage yourself.
    const { migrateIfNeeded } = await import("./lib/db/migrate");
    await migrateIfNeeded();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
