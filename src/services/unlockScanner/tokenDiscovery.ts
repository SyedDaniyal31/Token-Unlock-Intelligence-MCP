/**
 * Baseline token metadata: totalSupply, decimals, first mint block.
 * Uses chainClient for logs; RPC eth_call for supply/decimals when available.
 */

import { getCurrentBlock, getLogs, readErc20SupplyFromRpc, type UnlockScannerChain } from "./chainClient.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface TokenDiscoveryResult {
  totalSupply: number;
  decimals: number;
  firstMintBlock?: number;
}

export interface UnlockScannerOptions {
  signal?: AbortSignal;
  deadline?: number;
}

/**
 * Detect first mint block by scanning Transfer logs where topic1 (from) = zero address.
 * Scans backwards from current block in chunks; returns first (lowest) block found.
 */
async function detectFirstMintBlock(
  chain: UnlockScannerChain,
  address: string,
  toBlock: number,
  deadlineMs: number,
  options?: UnlockScannerOptions
): Promise<number | undefined> {
  const addr = address.startsWith("0x") ? address : "0x" + address;
  const chunk = 5000;
  let fromBlock = Math.max(0, toBlock - chunk * 10);
  let firstBlock: number | undefined;
  while (fromBlock <= toBlock && Date.now() < deadlineMs) {
    if (options?.signal?.aborted) throw new Error("Dynamic engine aborted");
    if (options?.deadline != null && Date.now() > options.deadline) throw new Error("Unlock scanner deadline exceeded");
    const logs = await getLogs(chain, {
      address: addr,
      fromBlock,
      toBlock: Math.min(fromBlock + chunk - 1, toBlock),
      topics: [TRANSFER_TOPIC],
      signal: options?.signal,
      deadline: options?.deadline,
    });
    for (const log of logs) {
      const fromTopic = log.topics[1];
      if (fromTopic === ZERO_TOPIC || (fromTopic && fromTopic.toLowerCase().endsWith("0".repeat(40)))) {
        firstBlock = firstBlock === undefined ? log.blockNumber : Math.min(firstBlock, log.blockNumber);
      }
    }
    if (firstBlock !== undefined && fromBlock >= firstBlock) break;
    fromBlock += chunk;
  }
  return firstBlock;
}

/**
 * Returns totalSupply, decimals, and optional firstMintBlock. Throws on abort/deadline when options provided.
 */
export async function discoverToken(
  chain: UnlockScannerChain,
  address: string,
  executionNowMs: number,
  deadlineMs: number,
  options?: UnlockScannerOptions
): Promise<TokenDiscoveryResult> {
  const addr = address.startsWith("0x") ? address : "0x" + address;
  let totalSupply = 0;
  let decimals = 18;
  try {
    const snapshot = await readErc20SupplyFromRpc(chain, addr);
    totalSupply = snapshot.totalSupply >= 0 ? snapshot.totalSupply : 0;
    decimals = snapshot.decimals >= 0 && snapshot.decimals <= 255 ? snapshot.decimals : 18;
  } catch {
    totalSupply = 0;
    decimals = 18;
  }

  let firstMintBlock: number | undefined;
  if (Date.now() < deadlineMs) {
    if (options?.signal?.aborted) throw new Error("Dynamic engine aborted");
    if (options?.deadline != null && Date.now() > options.deadline) throw new Error("Unlock scanner deadline exceeded");
    const currentBlock = await getCurrentBlock(chain);
    if (currentBlock > 0) {
      firstMintBlock = await detectFirstMintBlock(chain, addr, currentBlock, deadlineMs, options);
    }
  }

  return {
    totalSupply: Number.isFinite(totalSupply) ? totalSupply : 0,
    decimals,
    firstMintBlock,
  };
}
