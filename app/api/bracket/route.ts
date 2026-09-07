import { NextResponse } from "next/server";
import { requireSuperiorAuth } from "../../../lib/account";
import { track } from "../../../lib/analytics";
import { fundsFrozen } from "../../../lib/kill-switch";
import { withInsufficientBalanceGuidance } from "../../../lib/superior-api";

export const runtime = "nodejs";

const API_BASE =
  process.env.SUPERIOR_TRADE_API_URL ?? "https://api.superior.trade";

// Native bracket orders (Superior /v2/bracket): one atomic Hyperliquid
// normalTpsl action — entry limit + reduce-only TP/SL — on a free trading
// account. The lightweight execution path for one-shot fixed-level plans
// (no Freqtrade pod, no compile).

export async function GET(req: Request) {
  try {
    const { key } = await requireSuperiorAuth();
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
    const { key, user } = await requireSuperiorAuth();
    const body = (await req.json()) as Record<string, unknown>;
    const res = await fetch(`${API_BASE}/v2/bracket`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Funding failures get the plain deposit sentence (balance + requirement
    // + the Deposit button) in `message`, which is what the plan card shows
    // and what the chat relays; the raw upstream wording stays in
    // `upstream_message` (and below in analytics).
    const json = withInsufficientBalanceGuidance(
      (await res.json().catch(() => ({}))) as Record<string, unknown>,
      res.status === 201,
      "order",
    );
    track(res.status === 201 ? "bracket_placed" : "bracket_failed", {
      user: user.id,
      props: {
        pair: String(body.pair ?? ""),
        side: String(body.side ?? ""),
        sizeUsd: typeof body.size_usd === "number" ? body.size_usd : undefined,
        leverage: typeof body.leverage === "number" ? body.leverage : undefined,
        ...(res.status === 201
          ? { wallet: String(json.wallet_address ?? "") }
          : {
              status: res.status,
              // Analytics keeps the RAW upstream cause, not the softened copy.
              error: String(json.upstream_message ?? json.message ?? json.error ?? "").slice(0, 200),
            }),
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
    const { key, user } = await requireSuperiorAuth();
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const res = await fetch(`${API_BASE}/v2/bracket/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "x-api-key": key },
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) track("bracket_cancelled", { user: user.id, props: { id } });
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    if (e instanceof Response) return e;
    return NextResponse.json({ error: "bracket proxy error" }, { status: 502 });
  }
}
