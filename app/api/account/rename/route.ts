import { NextResponse } from "next/server";
import { resolveSuperiorAuth } from "../../../../lib/superior-key";
import { renameAccount } from "../../../../lib/superior-api";
import { track } from "../../../../lib/analytics";

export const runtime = "nodejs";

// Rename — set the display label for one of the user's OWN accounts. Not a
// money movement, so no freeze guard; still auth-scoped.
//
// POST /api/account/rename  { wallet, name }

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export async function POST(req: Request) {
  let user, key;
  try {
    ({ user, key } = await resolveSuperiorAuth(req));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  let body: { wallet?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const wallet = String(body.wallet ?? "").trim();
  const name = String(body.name ?? "");
  if (!ADDR_RE.test(wallet)) {
    return NextResponse.json({ error: "invalid wallet address" }, { status: 400 });
  }

  const result = await renameAccount(key, wallet, name);
  track("account_renamed", {
    user: user.did,
    props: { wallet, ok: result.ok },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.detail }, { status: 400 });
  }
  return NextResponse.json({ ok: true, name: result.name });
}
