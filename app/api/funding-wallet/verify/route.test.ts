import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ bearerFrom: vi.fn() }));

vi.mock("../../../../lib/server-auth", () => ({
  bearerFrom: mocks.bearerFrom,
}));

import { POST } from "./route";

const TX = `0x${"a".repeat(64)}`;

function request(body: unknown) {
  return new Request("http://localhost/api/funding-wallet/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Terminal V2 funding-wallet verification proxy", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    // Verification only applies to a hosted install; without a verification
    // service the route reports "not applicable" and never calls out.
    vi.stubEnv("SUPERIOR_WEB_SERVER_URL", "http://localhost:4000");
    mocks.bearerFrom.mockReturnValue("privy-token");
  });

  it("requires a live Privy session and a valid transaction hash", async () => {
    mocks.bearerFrom.mockReturnValueOnce(null);
    expect((await POST(request({ transactionHash: TX }))).status).toBe(401);
    expect((await POST(request({ transactionHash: "bad" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the hash for authoritative on-chain verification", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ verified: true, transactionHash: TX }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await POST(request({ transactionHash: TX }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      applicable: true,
      verified: true,
      transactionHash: TX,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/onboarding/verify-funding-wallet",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer privy-token",
        }),
        body: JSON.stringify({ chainId: 42161, transactionHash: TX }),
      }),
    );
  });

  it("treats email-login funding proof as not applicable", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: "Funding-wallet verification applies to wallet login only",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await POST(request({ transactionHash: TX }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      applicable: false,
      verified: false,
    });
  });
});
