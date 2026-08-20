import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../../lib/superior-key";

export const runtime = "nodejs";

// Rename / delete a single API key — proxies to apps/api /auth/api-key/:id.
const API_BASE = process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

async function keyOr(req: Request): Promise<{ key: string } | Response> {
  try {
    return await resolveSuperiorAuth(req);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await keyOr(req);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const res = await fetch(`${API_BASE}/auth/api-key/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "x-api-key": auth.key, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await keyOr(req);
  if (auth instanceof Response) return auth;
  const res = await fetch(`${API_BASE}/auth/api-key/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "x-api-key": auth.key },
  });
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
}
