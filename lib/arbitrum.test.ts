import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  arbitrumBlockNumber,
  incomingUsdcTransferHashes,
  usdcBalanceAtoms,
} from "./arbitrum";

const WALLET = "0x11223344556677889900aabbccddeeff11223344";
const TX_OLD = `0x${"a".repeat(64)}`;
const TX_NEW = `0x${"b".repeat(64)}`;

describe("Arbitrum deposit helpers", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("reads USDC balances and the current block", async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => ({ result: "0x989680" }) })
      .mockResolvedValueOnce({ json: async () => ({ result: "0x1234" }) });

    await expect(usdcBalanceAtoms(WALLET)).resolves.toBe(10_000_000n);
    await expect(arbitrumBlockNumber()).resolves.toBe(0x1234n);
  });

  it("returns newest non-zero incoming transfer hashes", async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => ({ result: "0x15" }) })
      .mockResolvedValueOnce({
        json: async () => ({
          result: [
            {
              transactionHash: TX_OLD,
              blockNumber: "0x12",
              logIndex: "0x1",
              data: "0x1",
            },
            {
              transactionHash: TX_NEW,
              blockNumber: "0x14",
              logIndex: "0x0",
              data: "0x2",
            },
            {
              transactionHash: `0x${"c".repeat(64)}`,
              blockNumber: "0x15",
              logIndex: "0x0",
              data: "0x0",
            },
          ],
        }),
      });

    await expect(incomingUsdcTransferHashes(WALLET, 0x10n)).resolves.toEqual([
      TX_NEW,
      TX_OLD,
    ]);

    const getLogsBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(getLogsBody.method).toBe("eth_getLogs");
    expect(getLogsBody.params[0]).toMatchObject({
      fromBlock: "0x10",
      toBlock: "0x15",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        null,
        `0x${WALLET.slice(2).padStart(64, "0")}`,
      ],
    });
  });

  it("fails closed when a log chunk cannot be read", async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => ({ result: "0x15" }) })
      .mockResolvedValueOnce({
        json: async () => ({ error: { message: "range unavailable" } }),
      });

    await expect(incomingUsdcTransferHashes(WALLET, 0x10n)).resolves.toEqual(
      [],
    );
  });
});
