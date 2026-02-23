/**
 * Unlock scanner orchestrator: token discovery → mint → vesting → treasury → spike → classifier → aggregator.
 * Free executionNowMs at start; 90d window; timeout; fail gracefully (return null).
 */

import { getCurrentBlock, getLogs, getBlockTimestamp, type UnlockScannerChain, type NormalizedLog } from "./chainClient.js";
import { discoverToken } from "./tokenDiscovery.js";
import { scanMints } from "./mintScanner.js";
import {
  detectVesting,
  buildTransferList,
} from "./vestingDetector.js";
import { trackTreasury } from "./treasuryTracker.js";
import { analyzeTransferSpikes } from "./transferSpikeAnalyzer.js";
import { classifyUnlockEvents } from "./unlockClassifier.js";
import { aggregateUnlockMetrics, type UnlockAggregatorOutput } from "./unlockAggregator.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const BLOCKS_90D_ETH = 90 * 7200;
const BLOCKS_90D_BSC = 90 * 28800;
const BLOCKS_90D_ARB = 90 * 21600;

function blocks90d(chain: UnlockScannerChain): number {
  switch (chain) {
    case "ethereum": return BLOCKS_90D_ETH;
    case "bsc": return BLOCKS_90D_BSC;
    case "arbitrum": return BLOCKS_90D_ARB;
    default: return BLOCKS_90D_ETH;
  }
}

export interface UnlockScannerInput {
  chain: UnlockScannerChain;
  tokenAddress: string;
  circulatingSupply: number;
  volume30dUsd: number;
  /** If set, volume30dToken = volume30dUsd / price for pressure ratio. */
  price?: number;
  /** Frozen ms for deterministic behavior. */
  executionNowMs: number;
  /** Absolute deadline ms; abort if Date.now() >= deadlineMs. */
  deadlineMs: number;
}

export interface UnlockScannerOutput extends UnlockAggregatorOutput {
  inflationRate30d: number;
  inflationRate90d: number;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { result: UnlockScannerOutput; storedAt: number }>();

function cacheKey(chain: string, tokenAddress: string, executionNowMs: number): string {
  const bucket = Math.floor(executionNowMs / CACHE_TTL_MS);
  return `${chain}:${(tokenAddress || "").toLowerCase()}:${bucket}`;
}

export function getCachedUnlockResult(
  chain: string,
  tokenAddress: string,
  executionNowMs: number
): UnlockScannerOutput | null {
  const k = cacheKey(chain, tokenAddress, executionNowMs);
  const e = cache.get(k);
  if (!e || Date.now() - e.storedAt > CACHE_TTL_MS) return null;
  return e.result;
}

function setCachedUnlockResult(
  chain: string,
  tokenAddress: string,
  executionNowMs: number,
  result: UnlockScannerOutput
): void {
  const k = cacheKey(chain, tokenAddress, executionNowMs);
  if (cache.size >= 300) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(k, { result, storedAt: Date.now() });
}

/**
 * Run full unlock pipeline. Returns null on failure or timeout. Never throws.
 */
export async function runUnlockScanner(input: UnlockScannerInput): Promise<UnlockScannerOutput | null> {
  const { chain, tokenAddress, circulatingSupply, volume30dUsd, price, executionNowMs, deadlineMs } = input;
  const addr = tokenAddress.startsWith("0x") ? tokenAddress : "0x" + tokenAddress;

  const cached = getCachedUnlockResult(chain, addr, executionNowMs);
  if (cached) return cached;

  if (Date.now() >= deadlineMs) return null;

  let discovery;
  try {
    discovery = await discoverToken(chain, addr, executionNowMs, deadlineMs);
  } catch {
    return null;
  }
  if (Date.now() >= deadlineMs) return null;

  const getBlockTs = (blockNumber: number) => getBlockTimestamp(chain, blockNumber);
  let mintResult;
  try {
    mintResult = await scanMints(
      chain,
      addr,
      discovery.decimals,
      discovery.totalSupply,
      getBlockTs,
      deadlineMs,
      executionNowMs
    );
  } catch {
    mintResult = {
      mintEvents: [],
      inflationRate30d: 0,
      inflationRate90d: 0,
      emissionAccelerationScore: 0,
    };
  }
  if (Date.now() >= deadlineMs) return null;

  const currentBlock = await getCurrentBlock(chain);
  if (currentBlock <= 0) {
    const out: UnlockScannerOutput = {
      ...aggregateUnlockMetrics(
        mintResult,
        { vestingWallets: [], vestingEvents: [], patternType: "unknown", cliffDetected: false, vestingConfidenceScore: 0 },
        { treasuryEvents: [], treasuryRiskScore: 0, treasuryWallets: [] },
        { largestTransfer: 0, unlockPressureRatio: 0 }
      ),
      inflationRate30d: mintResult.inflationRate30d,
      inflationRate90d: mintResult.inflationRate90d,
    };
    setCachedUnlockResult(chain, addr, executionNowMs, out);
    return out;
  }

  const startBlock = Math.max(0, currentBlock - blocks90d(chain));
  let allLogs: NormalizedLog[];
  try {
    allLogs = await getLogs(chain, {
      address: addr,
      fromBlock: startBlock,
      toBlock: currentBlock,
      topics: [TRANSFER_TOPIC],
    });
  } catch {
    allLogs = [];
  }
  if (Date.now() >= deadlineMs) return null;

  const transferList = buildTransferList(allLogs, discovery.decimals);
  const vesting = detectVesting(transferList, discovery.totalSupply, discovery.decimals);

  const treasuryTransfers = transferList.map((t) => ({
    from: t.from,
    amount: t.amount,
    timestamp: t.timestamp,
  }));
  const treasury = trackTreasury(treasuryTransfers, circulatingSupply, discovery.totalSupply);

  const priceAtExecution = price != null && Number.isFinite(price) && price > 0 ? price : undefined;
  const transferAmounts = transferList.map((t) => t.amount);
  const spike = analyzeTransferSpikes(transferAmounts, volume30dUsd, priceAtExecution);

  const vestingSet = new Set(vesting.vestingWallets.map((w) => w.toLowerCase()));
  const treasurySet = new Set(treasury.treasuryWallets.map((w) => w.toLowerCase()));
  const circ = Math.max(1, circulatingSupply);
  const largeThreshold = circ * 0.02;
  classifyUnlockEvents(transferList, vestingSet, treasurySet, largeThreshold);

  const aggregated = aggregateUnlockMetrics(mintResult, vesting, treasury, spike);
  const out: UnlockScannerOutput = {
    ...aggregated,
    inflationRate30d: mintResult.inflationRate30d,
    inflationRate90d: mintResult.inflationRate90d,
  };
  setCachedUnlockResult(chain, addr, executionNowMs, out);
  return out;
}
