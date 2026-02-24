/**
 * Mint-based emission detection: Transfer from zero address in last 90 days.
 * Computes totalMintAmount, mintEvents, emissionAcceleration, supplyInflationRate90d.
 */

import { getCurrentBlock, getLogs, type UnlockScannerChain } from "./chainClient.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";

const BLOCKS_PER_DAY_ETH = 7200;
const BLOCKS_PER_DAY_BSC = 28800;
const BLOCKS_PER_DAY_ARB = 21600;

function blocksIn90Days(chain: UnlockScannerChain): number {
  switch (chain) {
    case "ethereum":
      return 90 * BLOCKS_PER_DAY_ETH;
    case "bsc":
      return 90 * BLOCKS_PER_DAY_BSC;
    case "arbitrum":
      return 90 * BLOCKS_PER_DAY_ARB;
    default:
      return 90 * BLOCKS_PER_DAY_ETH;
  }
}

function parseValue(data: string): number {
  if (!data || data === "0x") return 0;
  try {
    const s = data.startsWith("0x") ? data.slice(2) : data;
    if (!/^[0-9a-fA-F]+$/.test(s)) return 0;
    return Number(BigInt("0x" + s));
  } catch {
    return 0;
  }
}

export interface MintEvent {
  timestamp: number;
  amount: number;
}

export interface MintScannerResult {
  mintEvents: MintEvent[];
  inflationRate30d: number;
  inflationRate90d: number;
  emissionAccelerationScore: number;
}

const MAX_BLOCK_RANGE = 500_000;

export interface UnlockScannerOptions {
  signal?: AbortSignal;
  deadline?: number;
}

/**
 * Scan Transfer logs (from = zero) in last 90 days. Build mint events with block timestamps.
 * Uses log.timestamp when present (explorer API); otherwise getBlockTimestamp for RPC path.
 * executionNowMs used for 30d/60d window boundaries (deterministic); omit to fall back to current time.
 * Throws on abort/deadline when options provided.
 */
export async function scanMints(
  chain: UnlockScannerChain,
  tokenAddress: string,
  decimals: number,
  totalSupply: number,
  getBlockTimestamp: (blockNumber: number) => Promise<number>,
  deadlineMs: number,
  executionNowMs?: number,
  options?: UnlockScannerOptions
): Promise<MintScannerResult> {
  const addr = tokenAddress.startsWith("0x") ? tokenAddress : "0x" + tokenAddress;
  if (options?.signal?.aborted) throw new Error("Dynamic engine aborted");
  if (options?.deadline != null && Date.now() > options.deadline) throw new Error("Unlock scanner deadline exceeded");
  const currentBlock = await getCurrentBlock(chain);
  if (currentBlock <= 0 || Date.now() >= deadlineMs) {
    return { mintEvents: [], inflationRate30d: 0, inflationRate90d: 0, emissionAccelerationScore: 0 };
  }

  const window = Math.min(blocksIn90Days(chain), MAX_BLOCK_RANGE);
  const startBlock = Math.max(0, currentBlock - window);
  const logs = await getLogs(chain, {
    address: addr,
    fromBlock: startBlock,
    toBlock: currentBlock,
    topics: [TRANSFER_TOPIC],
    signal: options?.signal,
    deadline: options?.deadline,
  });

  const divisor = 10 ** (decimals >= 0 && decimals <= 255 ? decimals : 18);
  const mintEvents: MintEvent[] = [];
  const blockTsCache = new Map<number, number>();
  for (const log of logs) {
    const fromTopic = log.topics[1];
    if (!fromTopic || fromTopic !== ZERO_TOPIC) continue;
    const raw = parseValue(log.data);
    const amount = divisor > 0 ? raw / divisor : 0;
    let ts = log.timestamp;
    if (ts === undefined || !Number.isFinite(ts)) {
      if (!blockTsCache.has(log.blockNumber)) {
        blockTsCache.set(log.blockNumber, await getBlockTimestamp(log.blockNumber));
      }
      ts = blockTsCache.get(log.blockNumber) ?? 0;
    }
    mintEvents.push({ timestamp: ts, amount });
  }
  mintEvents.sort((a, b) => a.timestamp - b.timestamp);

  const supplySafe = Math.max(1, totalSupply);
  const totalMint90d = mintEvents.reduce((s, e) => s + e.amount, 0);
  const estimatedSupplyAtStart90d = supplySafe - totalMint90d;
  const denominator90d = estimatedSupplyAtStart90d > 0 ? estimatedSupplyAtStart90d : supplySafe;
  const rawInflation90d = denominator90d > 0 ? (totalMint90d / denominator90d) * 100 : 0;
  const inflationRate90d = Number.isFinite(rawInflation90d) ? Math.max(0, rawInflation90d) : 0;

  const nowSec =
    typeof executionNowMs === "number" && Number.isFinite(executionNowMs)
      ? Math.floor(executionNowMs / 1000)
      : Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = nowSec - 30 * 86400;
  const sixtyDaysAgo = nowSec - 60 * 86400;
  const last30d = mintEvents.filter((e) => e.timestamp >= thirtyDaysAgo).reduce((s, e) => s + e.amount, 0);
  const prev30d = mintEvents.filter((e) => e.timestamp >= sixtyDaysAgo && e.timestamp < thirtyDaysAgo).reduce((s, e) => s + e.amount, 0);
  const estimatedSupplyAtStart30d = supplySafe - last30d;
  const denominator30d = estimatedSupplyAtStart30d > 0 ? estimatedSupplyAtStart30d : supplySafe;
  const rawInflation30d = denominator30d > 0 ? (last30d / denominator30d) * 100 : 0;
  const inflationRate30d = Number.isFinite(rawInflation30d) ? Math.max(0, rawInflation30d) : 0;

  let emissionAccelerationScore = 0;
  if (last30d >= 0 && prev30d >= 0) {
    const diff = last30d - prev30d;
    const base = Math.max(last30d, prev30d, 1);
    const ratio = diff / base;
    emissionAccelerationScore = Math.round(Math.max(0, Math.min(100, 50 + ratio * 50)));
  }

  return {
    mintEvents,
    inflationRate30d: Number(Number(inflationRate30d).toFixed(4)),
    inflationRate90d: Number(Number(inflationRate90d).toFixed(4)),
    emissionAccelerationScore,
  };
}
