import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../lib/superior-key";
import { track } from "../../../lib/analytics";
import { fundsFrozen } from "../../../lib/kill-switch";

export const runtime = "nodejs";

const API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

// Native bracket orders (Superior /v2/bracket): one atomic Hyperliquid
// normalTpsl action — entry limit + reduce-only TP/SL — on a free trading
// account. The lightweight execution path for one-shot fixed-level plans
// (no Freqtrade pod, no compile).

export async function GET(req: Request) {
  try {
    const { key } = await resolveSuperiorAuth(req);
    const res = await fetch(`${API_BASE}/v2/bracket`, {
      headers: { "x-api-key": key },
    });
    const json = await res.json().catch(() => ({}));
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    if (e instanceof Response) return e;
    return NextResponse.json({ error: "bracket proxy error" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  // Freeze only opening new orders — GET (read) and DELETE (cancel) stay open
  // so a user can always reduce risk during a trading freeze.
  const frozen = fundsFrozen("trade");
  if (frozen) return frozen;
  try {
    const { key, user } = await resolveSuperiorAuth(req);
    const body = (await req.json()) as Record<string, unknown>;
    const res = await fetch(`${API_BASE}/v2/bracket`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    track(res.status === 201 ? "bracket_placed" : "bracket_failed", {
      user: user.did,
      props: {
        pair: String(body.pair ?? ""),
        side: String(body.side ?? ""),
        sizeUsd: typeof body.size_usd === "number" ? body.size_usd : undefined,
        leverage: typeof body.leverage === "number" ? body.leverage : undefined,
        ...(res.status === 201
          ? { wallet: String(json.wallet_address ?? "") }
          : { status: res.status, error: String(json.message ?? json.error ?? "").slice(0, 200) }),
      },
    });
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    if (e instanceof Response) return e;
    return NextResponse.json({ error: "bracket proxy error" }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { key, user } = await resolveSuperiorAuth(req);
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const res = await fetch(`${API_BASE}/v2/bracket/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "x-api-key": key },
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) track("bracket_cancelled", { user: user.did, props: { id } });
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    if (e instanceof Response) return e;
    return NextResponse.json({ error: "bracket proxy error" }, { status: 502 });
  }
}
