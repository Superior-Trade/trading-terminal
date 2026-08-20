import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "../../../lib/db";
import { requireUser } from "../../../lib/server-auth";

export const runtime = "nodejs";

// Deployment enrichment, now per-user in SQLite (was a JSON file):
// Superior's API knows a deployment's status; we know the plan it came from.

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.userId, user.did))
      .orderBy(desc(schema.deployments.createdAt));
    return NextResponse.json({
      items: rows.map((r) => ({
        deploymentId: r.deploymentId,
        plan: JSON.parse(r.planJson),
        mode: r.mode,
        symbol: r.symbol ?? undefined,
        timeframe: r.timeframe ?? undefined,
        origin: r.origin,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    if (err instanceof Response) return err;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "store error" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const record = (await req.json()) as {
      deploymentId: string;
      plan: unknown;
      mode?: "one_shot" | "recurring";
      symbol?: string;
      timeframe?: string;
      createdAt?: number;
    };
    const mode = record.mode === "one_shot" ? "one_shot" : "recurring";
    if (!record.deploymentId || !record.plan) {
      return NextResponse.json(
        { error: "deploymentId and plan required" },
        { status: 400 },
      );
    }
    const db = getDb();
    await db
      .insert(schema.deployments)
      .values({
        deploymentId: record.deploymentId,
        userId: user.did,
        planJson: JSON.stringify(record.plan),
        symbol: record.symbol ?? null,
        timeframe: record.timeframe ?? null,
        origin: "ours",
        mode,
        createdAt: record.createdAt ?? Date.now(),
      })
      .onConflictDoUpdate({
        target: schema.deployments.deploymentId,
        set: {
          planJson: JSON.stringify(record.plan),
          symbol: record.symbol ?? null,
          timeframe: record.timeframe ?? null,
          mode,
        },
      });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof Response) return err;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "store error" },
      { status: 500 },
    );
  }
}
