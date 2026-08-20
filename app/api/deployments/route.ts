import { NextResponse } from "next/server";
import { requireSuperiorAuth } from "../../../lib/account";


export const runtime = "nodejs";

const API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

export async function GET(req: Request) {
  let apiKey: string;
  try {
    ({ key: apiKey } = await requireSuperiorAuth());
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  try {
    const res = await fetch(`${API_BASE}/v2/deployment`, {
      headers: { "x-api-key": apiKey },
    });
    const json = await res.json().catch(() => ({}));
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "proxy error" },
      { status: 502 },
    );
  }
}
