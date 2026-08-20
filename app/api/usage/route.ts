import { NextResponse } from "next/server";
import { requireUser } from "../../../lib/server-auth";
import { getUsage } from "../../../lib/rate-limit";

export const runtime = "nodejs";

// Read-only usage snapshot for the near-cap banner. Never increments a
// counter. Auth failure → 401 (the banner only matters for a real user).
export async function GET(req: Request) {
  let did: string;
  try {
    const user = await requireUser(req);
    did = user.did;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const usage = await getUsage(did, Date.now());
  return NextResponse.json({ usage });
}
