import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../lib/superior-key";

export const runtime = "nodejs";

// API-key management — thin proxy to apps/api's better-auth /auth/api-key
// endpoints. The user's resolved Superior key authenticates upstream (it maps
// to the same referenceId the keys are scoped by), so listing/creating here
// operates on the caller's own keys.
const API_BASE = process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

export async function GET(req: Request) {
  let key: string;
  try {
    ({ key } = await resolveSuperiorAuth(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const res = await fetch(`${API_BASE}/auth/api-key`, {
    headers: { "x-api-key": key },
  });
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
}

export async function POST(req: Request) {
  let key: string;
  try {
    ({ key } = await resolveSuperiorAuth(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const res = await fetch(`${API_BASE}/auth/api-key`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
}
