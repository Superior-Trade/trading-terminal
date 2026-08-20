/* Minimal Arbitrum One helpers for the inline deposit flow — read-only
 * balance polling via public RPC, no wallet lib needed. */

export const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const RPC = "https://arb1.arbitrum.io/rpc";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const payload = (await response.json()) as {
      result?: T;
      error?: unknown;
    };
    return payload.error === undefined && payload.result !== undefined
      ? payload.result
      : null;
  } catch {
    return null;
  }
}

/** ERC-20 balanceOf via eth_call. Returns atoms (6 decimals for USDC) or
 *  null on any failure — callers treat null as "skip this poll". */
export async function usdcBalanceAtoms(wallet: string): Promise<bigint | null> {
  const data = `0x70a08231${wallet.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const result = await rpc<string>("eth_call", [
    { to: ARB_USDC, data },
    "latest",
  ]);
  if (!result?.startsWith("0x")) return null;
  try {
    return BigInt(result);
  } catch {
    return null;
  }
}

export async function arbitrumBlockNumber(): Promise<bigint | null> {
  const result = await rpc<string>("eth_blockNumber", []);
  if (!result?.startsWith("0x")) return null;
  try {
    return BigInt(result);
  } catch {
    return null;
  }
}

type TransferLog = {
  transactionHash?: string;
  blockNumber?: string;
  logIndex?: string;
  data?: string;
};

/**
 * Locate transfer hashes only. The backend remains authoritative: it replays
 * each receipt and verifies token, sender, recipient, amount, and finality.
 */
export async function incomingUsdcTransferHashes(
  wallet: string,
  fromBlock: bigint,
): Promise<string[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return [];
  const latestBlock = await arbitrumBlockNumber();
  if (latestBlock === null || fromBlock > latestBlock) return [];

  const recipientTopic = `0x${wallet
    .replace(/^0x/, "")
    .toLowerCase()
    .padStart(64, "0")}`;
  const logs: TransferLog[] = [];
  const chunkSize = 5_000n;
  // A stale modal should not trigger an unbounded public-RPC scan.
  let cursor =
    latestBlock - fromBlock > 100_000n ? latestBlock - 100_000n : fromBlock;

  while (cursor <= latestBlock) {
    const end =
      cursor + chunkSize - 1n < latestBlock
        ? cursor + chunkSize - 1n
        : latestBlock;
    const chunk = await rpc<TransferLog[]>("eth_getLogs", [
      {
        address: ARB_USDC,
        fromBlock: `0x${cursor.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
        topics: [TRANSFER_TOPIC, null, recipientTopic],
      },
    ]);
    if (chunk === null) return [];
    logs.push(...chunk);
    cursor = end + 1n;
  }

  const hashes = logs
    .filter(
      (log) =>
        /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash ?? "") &&
        /^0x[0-9a-fA-F]+$/.test(log.data ?? "") &&
        BigInt(log.data!) > 0n,
    )
    .sort((left, right) => {
      const blockDelta =
        BigInt(right.blockNumber ?? "0x0") - BigInt(left.blockNumber ?? "0x0");
      if (blockDelta !== 0n) return blockDelta > 0n ? 1 : -1;
      const logDelta =
        BigInt(right.logIndex ?? "0x0") - BigInt(left.logIndex ?? "0x0");
      return logDelta > 0n ? 1 : logDelta < 0n ? -1 : 0;
    })
    .map((log) => log.transactionHash!);

  return [...new Set(hashes)];
}

export function atomsToUsdc(atoms: bigint): number {
  return Number(atoms) / 1e6;
}
