import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ensureOnboarded", () => {
  const originalEnv = process.env;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      SUPERIOR_TRADE_API_URL: "https://api.test",
      SUPERIOR_WEB_SERVER_URL: "https://web-server.test",
    };
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("bootstraps through the Superior Trade API instead of web-server", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          walletAddress: "0x1111111111111111111111111111111111111111",
          created: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { ensureOnboarded } = await import("./onboarding");
    const result = await ensureOnboarded("privy-token");

    expect(result).toEqual({
      ok: true,
      walletAddress: "0x1111111111111111111111111111111111111111",
      created: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v2/account/bootstrap",
      {
        method: "POST",
        headers: { Authorization: "Bearer privy-token" },
      },
    );
  });

  it("reports bootstrap failures without falling back to web-server", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "database_unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { ensureOnboarded } = await import("./onboarding");
    const result = await ensureOnboarded("privy-token");

    expect(result).toEqual({ ok: false, step: "bootstrap" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "https://api.test/v2/account/bootstrap",
    );
  });
});
