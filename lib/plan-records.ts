import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";

/** Re-key a deployment's plan record when a recreate changes its id —
 *  update_deployment deletes + redeploys (upstream has no in-place edit),
 *  and without the migration the new deployment loses its plan metadata
 *  and renders as a plan-less "foreign" card. Fail-soft: a miss only
 *  degrades the card, it must never fail the update itself. */
export async function migrateDeploymentRecord(
  oldId: string,
  newId: string,
): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(schema.deployments)
      .set({ deploymentId: newId })
      .where(eq(schema.deployments.deploymentId, oldId));
  } catch (err) {
    console.warn(
      "[plan-records] record migration failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
