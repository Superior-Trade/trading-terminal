import { NextResponse } from "next/server";
import { bearerFrom } from "../../../../lib/server-auth";

export const runtime = "nodejs";

// Proving you control the wallet a deposit came FROM is a hosted-custody
// concern: it exists so a managed account can later pay a withdrawal back to
// an address you demonstrably own. A self-hosted install has no such custody
// — you already hold the keys — so with no verification service configured
// this route reports "not applicable" and the deposit flow carries on.
export async function POST(req: Request) {
  const WEB_SERVER_URL = (process.env.SUPERIOR_WEB_SERVER_URL ?? "").trim();
  if (!WEB_SERVER_URL) {
    return NextResponse.json({ applicable: false, verified: false });
  }

  const bearer = bearerFrom(req);
  if (!bearer) {
    return NextResponse.json(
      { error: "a live Privy session is required" },
      { status: 401 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    transactionHash?: unknown;
  };
  if (
    typeof body.transactionHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(body.transactionHash)
  ) {
    return NextResponse.json(
      { error: "a valid transactionHash is required" },
      { status: 400 },
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `${WEB_SERVER_URL}/onboarding/verify-funding-wallet`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chainId: 42161,
          transactionHash: body.transactionHash,
        }),
      },
    );
  } catch {
    return NextResponse.json(
      { error: "funding-wallet verification service is unavailable" },
      { status: 502 },
    );
  }

  const result = (await response.json().catch(() => ({}))) as {
    message?: string;
    [key: string]: unknown;
  };
  if (
    response.status === 409 &&
    result.message ===
      "Funding-wallet verification applies to wallet login only"
  ) {
    return NextResponse.json({ applicable: false, verified: false });
  }
  return NextResponse.json(
    { ...result, applicable: true },
    { status: response.status },
  );
}
